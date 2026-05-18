"use strict";

const Homey = require("homey");
const WebSocket = require("ws");
const {
  compactXml,
  extractConnectionState,
  extractNowPlayingStatus,
  extractPresetNumber,
  getNowPlaying,
  getVolume,
  playStream,
  selectLastSource,
  setVolume,
  standby,
  stopPlayback,
} = require("../../lib/soundtouch-client");

const WEBSOCKET_PORT = 8080;
const WEBSOCKET_PROTOCOL = "gabbo";
const RECONNECT_DELAY_MS = 10000;
const PRESET_DEBOUNCE_MS = 1500;
const ORDERED_CAPABILITIES = [
  "preset_1",
  "preset_2",
  "preset_3",
  "preset_4",
  "preset_5",
  "preset_6",
  "stop_playback",
  "onoff",
  "volume_set",
  "connectivity_alarm",
];
const DEPRECATED_CAPABILITIES = [
  "button.preset_1",
  "button.preset_2",
  "button.preset_3",
  "button.preset_4",
  "button.preset_5",
  "button.preset_6",
  "button.stop",
  "speaker_stop",
];
const DEFAULT_PRESETS = [
  {
    name: "One World Radio",
    url: "http://25503.live.streamtheworld.com/OWR_INTERNATIONAL.mp3",
  },
  {
    name: "BBC World Service",
    url: "http://stream.live.vc.bbcmedia.co.uk/bbc_world_service",
  },
  {
    name: "Radio Paradise",
    url: "http://stream-tx3.radioparadise.com/mp3-192",
  },
  {
    name: "FIP",
    url: "http://icecast.radiofrance.fr/fip-midfi.mp3",
  },
  {
    name: "Radio SRF 3",
    url: "http://stream.srg-ssr.ch/srgssr/srf3/mp3/128",
  },
  {
    name: "KEXP",
    url: "http://kexp-mp3-128.streamguys1.com/kexp128.mp3",
  },
];

class SoundTouchDevice extends Homey.Device {
  async onInit() {
    this.ws = null;
    this.reconnectTimer = null;
    this.lastPresetAt = new Map();
    this.log("SoundTouch device initialized");

    await this.refreshAddressFromSettings();
    await this.ensureCapabilities();
    await this.ensureDefaultPresetSettings();
    this.registerCapabilityListeners();
    await this.syncStatus();
    this.connectWebSocket();
  }

  async onDeleted() {
    this.clearReconnectTimer();
    this.closeWebSocket();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes("ip_address")) {
      const nextAddress = String(newSettings.ip_address || "").trim();
      if (!nextAddress) {
        throw new Error("IP address is required.");
      }
      this.address = nextAddress;
      this.closeWebSocket();
      this.connectWebSocket();
    }
  }

  async refreshAddressFromSettings() {
    const settings = this.getSettings();
    const store = this.getStore();
    this.address = String(settings.ip_address || store.address || "").trim();

    if (!this.address) {
      await this.setUnavailable("No IP address configured.");
      return;
    }

    await this.setAvailable();
  }

  async ensureCapabilities() {
    if (this.shouldReorderCapabilities()) {
      await this.reorderCapabilities();
      return;
    }

    for (const capability of ORDERED_CAPABILITIES) {
      await this.addCapabilityIfMissing(capability);
    }
  }

  shouldReorderCapabilities() {
    const currentCapabilities = this.getCapabilities();
    if (currentCapabilities.some((capability) => DEPRECATED_CAPABILITIES.includes(capability))) {
      return true;
    }

    const managedCapabilities = currentCapabilities.filter((capability) => (
      ORDERED_CAPABILITIES.includes(capability)
    ));
    return managedCapabilities.join("|") !== ORDERED_CAPABILITIES.join("|");
  }

  async reorderCapabilities() {
    this.log("Reordering dashboard controls");

    for (const capability of DEPRECATED_CAPABILITIES) {
      if (this.hasCapability(capability)) {
        await this.removeCapability(capability);
      }
    }

    for (const capability of ORDERED_CAPABILITIES) {
      if (this.hasCapability(capability)) {
        await this.removeCapability(capability);
      }
    }

    for (const capability of ORDERED_CAPABILITIES) {
      await this.addCapabilityIfMissing(capability);
    }
  }

  async addCapabilityIfMissing(capability) {
    if (!this.hasCapability(capability)) {
      this.log(`Adding missing capability ${capability}`);
      await this.addCapability(capability);
    }
  }

  async ensureDefaultPresetSettings() {
    const store = this.getStore();
    if (store.default_presets_seeded || typeof this.setStoreValue !== "function") {
      return;
    }

    const settings = this.getSettings();
    const updates = {};
    DEFAULT_PRESETS.forEach(({ name, url }, index) => {
      const preset = index + 1;
      const nameKey = `preset${preset}_name`;
      const urlKey = `preset${preset}_url`;
      if (!String(settings[nameKey] || "").trim()) {
        updates[nameKey] = name;
      }
      if (!String(settings[urlKey] || "").trim()) {
        updates[urlKey] = url;
      }
    });

    if (Object.keys(updates).length > 0) {
      await this.setSettings(updates);
    }
    await this.setStoreValue("default_presets_seeded", true);
  }

  registerCapabilityListeners() {
    this.registerCapabilityListener("onoff", async (value) => {
      if (value) {
        await this.turnOn();
      } else {
        await this.turnOff();
      }
    });

    this.registerCapabilityListener("volume_set", async (value) => {
      await this.setSpeakerVolume(value);
    });

    this.registerCapabilityListener("stop_playback", async () => {
      await this.stop();
    });

    for (let preset = 1; preset <= 6; preset += 1) {
      this.registerCapabilityListener(`preset_${preset}`, async () => {
        await this.playConfiguredPreset(preset);
      });
    }
  }

  async setCapabilityValueIfAvailable(capability, value) {
    if (this.hasCapability(capability)) {
      await this.setCapabilityValue(capability, value);
    }
  }

  async syncStatus() {
    if (!this.address) {
      return;
    }

    try {
      const [nowPlaying, volume] = await Promise.all([
        getNowPlaying(this.address),
        getVolume(this.address),
      ]);
      const status = extractNowPlayingStatus(nowPlaying);
      await this.updateNowPlayingStatus(status);
      await this.setCapabilityValueIfAvailable("onoff", !status.isStandby);
      await this.setCapabilityValueIfAvailable("connectivity_alarm", false);
      if (volume !== null) {
        await this.setCapabilityValueIfAvailable("volume_set", volume / 100);
      }
    } catch (error) {
      this.log(`Could not sync speaker status: ${error.message}`);
    }
  }

  connectWebSocket() {
    if (!this.address) {
      return;
    }

    this.clearReconnectTimer();
    this.closeWebSocket();

    const url = `ws://${this.address}:${WEBSOCKET_PORT}`;
    this.log(`Connecting Bose WebSocket ${url}`);
    this.ws = new WebSocket(url, WEBSOCKET_PROTOCOL);

    this.ws.on("open", async () => {
      this.log("Bose WebSocket connected");
      await this.setCapabilityValueIfAvailable("connectivity_alarm", false);
      await this.setAvailable();
    });

    this.ws.on("message", (message) => {
      this.handleWebSocketMessage(message).catch((error) => {
        this.error(`Failed to handle WebSocket message: ${error.message}`);
      });
    });

    this.ws.on("close", () => {
      this.log("Bose WebSocket closed");
      this.setCapabilityValueIfAvailable("connectivity_alarm", true).catch((error) => {
        this.error(`Failed to set connectivity alarm: ${error.message}`);
      });
      this.scheduleReconnect();
    });

    this.ws.on("error", (error) => {
      this.error(`Bose WebSocket error: ${error.message}`);
      this.setCapabilityValueIfAvailable("connectivity_alarm", true).catch((capabilityError) => {
        this.error(`Failed to set connectivity alarm: ${capabilityError.message}`);
      });
    });
  }

  closeWebSocket() {
    if (!this.ws) {
      return;
    }

    const ws = this.ws;
    this.ws = null;
    ws.removeAllListeners();
    try {
      ws.close();
    } catch (error) {
      this.error(`Failed to close WebSocket: ${error.message}`);
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.address) {
      return;
    }

    this.reconnectTimer = this.homey.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, RECONNECT_DELAY_MS);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      this.homey.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async handleWebSocketMessage(message) {
    const rawEvent = compactXml(message.toString());
    const settings = this.getSettings();
    if (settings.debug_enabled) {
      this.log(`Bose WebSocket event: ${rawEvent}`);
    }
    await this.setSettings({ last_event: rawEvent.slice(0, 500) });
    await this.updateTelemetryFromEvent(rawEvent);

    const preset = extractPresetNumber(rawEvent);
    if (!preset) {
      return;
    }

    if (this.isDebounced(preset)) {
      this.log(`Ignoring debounced preset ${preset}`);
      return;
    }

    this.log(`Detected preset ${preset}`);
    await this.driver.triggerPresetPressed(this, { preset, raw_event: rawEvent });
    await this.playConfiguredPreset(preset);
  }

  isDebounced(preset) {
    const now = Date.now();
    const lastAt = this.lastPresetAt.get(preset) || 0;
    this.lastPresetAt.set(preset, now);
    return now - lastAt < PRESET_DEBOUNCE_MS;
  }

  async updateTelemetryFromEvent(rawEvent) {
    const connectionState = extractConnectionState(rawEvent);
    if (connectionState) {
      await this.updateConnectionState(connectionState);
    }

    const nowPlayingStatus = extractNowPlayingStatus(rawEvent);
    if (nowPlayingStatus.rawSource) {
      await this.updateNowPlayingStatus(nowPlayingStatus);
      await this.setCapabilityValueIfAvailable("onoff", !nowPlayingStatus.isStandby);
    }
  }

  async updateConnectionState(connectionState) {
    const settings = {
      connection_state: connectionState.state || "Unknown",
      wifi_signal: connectionState.signal || "Unknown",
    };
    await this.setSettings(settings);
    await this.setCapabilityValueIfAvailable("connectivity_alarm", !connectionState.up);
  }

  async updateNowPlayingStatus(status) {
    await this.setSettings({
      current_source: status.source || "Unknown",
      now_playing_summary: status.summary || "Unknown",
    });
  }

  async playConfiguredPreset(preset) {
    const presetNumber = Number(preset?.id ?? preset);
    if (!Number.isInteger(presetNumber) || presetNumber < 1 || presetNumber > 6) {
      throw new Error(`Preset ${preset} is not valid.`);
    }

    const settings = this.getSettings();
    const url = String(settings[`preset${presetNumber}_url`] || "").trim();
    if (!url) {
      this.log(`Preset ${presetNumber} has no stream URL configured.`);
      return;
    }

    await this.playStream(url);
  }

  async turnOn() {
    if (!this.address) {
      throw new Error("No speaker IP address configured.");
    }

    this.log(`Turning on ${this.address}`);
    await selectLastSource(this.address);
    await this.setCapabilityValueIfAvailable("onoff", true);
  }

  async turnOff() {
    if (!this.address) {
      throw new Error("No speaker IP address configured.");
    }

    this.log(`Putting ${this.address} in standby`);
    await standby(this.address);
    await this.setCapabilityValueIfAvailable("onoff", false);
  }

  async stop() {
    if (!this.address) {
      throw new Error("No speaker IP address configured.");
    }

    this.log(`Stopping playback on ${this.address}`);
    await stopPlayback(this.address);
  }

  async setSpeakerVolume(value) {
    if (!this.address) {
      throw new Error("No speaker IP address configured.");
    }

    await setVolume(this.address, value);
    await this.setCapabilityValueIfAvailable("volume_set", value);
  }

  async playStream(url, { volume } = {}) {
    if (!this.address) {
      throw new Error("No speaker IP address configured.");
    }

    this.log(`Playing stream on ${this.address}: ${url}`);
    await playStream(this.address, url, { volume });
    await this.setCapabilityValueIfAvailable("onoff", true);

    try {
      const nowPlaying = await getNowPlaying(this.address);
      const status = extractNowPlayingStatus(nowPlaying);
      await this.updateNowPlayingStatus(status);
      this.log(`Now playing: ${compactXml(nowPlaying)}`);
    } catch (error) {
      this.log(`Could not verify now playing after starting stream: ${error.message}`);
    }
    await this.setAvailable();
  }
}

module.exports = SoundTouchDevice;
