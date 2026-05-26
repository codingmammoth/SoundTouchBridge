"use strict";

const Homey = require("homey");
const WebSocket = require("ws");
const {
  compactXml,
  extractConnectionState,
  extractNowPlayingStatus,
  extractPresetNumber,
  getNowPlaying,
  getPositionInfo,
  getTransportInfo,
  getVolume,
  playStream,
  selectLastSource,
  setVolume,
  standby,
  storeNativePreset,
  stopPlayback,
  validateStreamUrl,
} = require("../../lib/soundtouch-client");

const WEBSOCKET_PORT = 8080;
const WEBSOCKET_PROTOCOL = "gabbo";
const RECONNECT_DELAY_MS = 10000;
const PRESET_DEBOUNCE_MS = 1500;
const PLAYBACK_VERIFY_TIMEOUT_MS = 12000;
const PLAYBACK_VERIFY_INTERVAL_MS = 1500;
const PRE_PLAY_WAKE_DELAY_MS = 1200;
const RECOVERY_SETTLE_MS = 1500;
const SETTING_TEXT_MAX_LENGTH = 900;
const ORDERED_CAPABILITIES = [
  "preset_1",
  "preset_2",
  "preset_3",
  "preset_4",
  "preset_5",
  "preset_6",
  "stop_playback",
  "speaker_playing",
  "onoff",
  "volume_set",
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
  "connectivity_alarm",
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
    name: "Dance UK",
    url: "http://dancestream.danceradiouk.com/stream/1/stream.mp3",
  },
  {
    name: "KEXP",
    url: "http://kexp-mp3-128.streamguys1.com/kexp128.mp3",
  },
];
const PRESET_NAME_MAX_LENGTH = 24;

class SoundTouchDevice extends Homey.Device {
  async onInit() {
    this.ws = null;
    this.reconnectTimer = null;
    this.lastPresetAt = new Map();
    this.activePreset = this.getStoredActivePreset();
    this.connectionState = null;
    this.wifiSignal = null;
    this.currentSource = null;
    this.nowPlaying = null;
    this.playbackQueue = Promise.resolve();
    this.log("SoundTouch device initialized");

    await this.refreshAddressFromSettings();
    await this.ensureCapabilities();
    await this.ensureDefaultPresetSettings();
    await this.ensurePublishReadySettings();
    await this.syncPresetSettingsUi();
    await this.syncPresetButtonTitles();
    await this.syncNativePresetNames();
    await this.syncPresetCapabilitySelection();
    this.registerCapabilityListeners();
    await this.syncStatus();
    this.connectWebSocket();
  }

  async onDeleted() {
    this.clearReconnectTimer();
    this.closeWebSocket();
  }

  async onSettings({ newSettings, changedKeys }) {
    this.validatePresetUrlSettings(newSettings, changedKeys);

    const presetSettingsChanged = changedKeys.some((key) => /^preset[1-6]_(name|url)$/.test(key));
    if (presetSettingsChanged) {
      await this.syncPresetSettingsUi(newSettings);
      await this.syncPresetButtonTitles(newSettings);
      await this.syncNativePresetNames();
    }

    if (changedKeys.includes("ip_address")) {
      const nextAddress = String(newSettings.ip_address || "").trim();
      if (!nextAddress) {
        throw new Error("IP address is required.");
      }
      await this.recordAction(`IP address changed to ${nextAddress}`);
      this.address = nextAddress;
      this.closeWebSocket();
      this.connectWebSocket();
    }
  }

  validatePresetUrlSettings(settings, changedKeys) {
    changedKeys
      .filter((key) => /^preset[1-6]_url$/.test(key))
      .forEach((key) => {
        const url = String(settings[key] || "").trim();
        if (!url) {
          return;
        }

        try {
          validateStreamUrl(url);
        } catch (error) {
          const preset = key.match(/^preset([1-6])_url$/)[1];
          throw new Error(`Preset ${preset}: ${error.message}`);
        }
      });
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

  async ensurePublishReadySettings() {
    const store = this.getStore();
    if (store.publish_ready_settings_applied || typeof this.setStoreValue !== "function") {
      return;
    }

    const settings = this.getSettings();
    const updates = {
      last_event: "Enable debug logging to capture raw events.",
      websocket_status: "Unknown",
      last_websocket_activity: "None",
      last_action: "None",
      last_playback_error: "None",
      native_preset_sync: "Not synced yet",
    };
    if (settings.debug_enabled === true) {
      updates.debug_enabled = false;
    }
    await this.setSettings(updates);
    await this.setStoreValue("publish_ready_settings_applied", true);
  }

  async syncPresetSettingsUi(settings = this.getSettings()) {
    const updates = {};
    for (let preset = 1; preset <= 6; preset += 1) {
      const name = String(settings[`preset${preset}_name`] || "").trim();
      const url = String(settings[`preset${preset}_url`] || "").trim();
      const summary = name || (url ? `Preset ${preset}` : "Not assigned");

      if (settings[`preset${preset}_summary`] !== summary) {
        updates[`preset${preset}_summary`] = summary;
      }
      if (settings[`preset${preset}_action`] && settings[`preset${preset}_action`] !== "keep") {
        updates[`preset${preset}_action`] = "keep";
      }
    }

    if (Object.keys(updates).length > 0) {
      await this.setSettings(updates);
    }
  }

  getStoredActivePreset() {
    const activePreset = Number(this.getStore().active_preset);
    return Number.isInteger(activePreset) && activePreset >= 1 && activePreset <= 6
      ? activePreset
      : null;
  }

  getPresetButtonTitle(preset, settings = this.getSettings(), activePreset = this.activePreset) {
    const configuredName = String(settings[`preset${preset}_name`] || "").trim();
    const title = configuredName || `Preset ${preset}`;

    if (title.length <= PRESET_NAME_MAX_LENGTH) {
      return title;
    }

    return `${title.slice(0, PRESET_NAME_MAX_LENGTH - 3).trim()}...`;
  }

  async syncPresetButtonTitles(settings = this.getSettings()) {
    if (typeof this.setCapabilityOptions !== "function") {
      this.log("Preset button title sync is not supported by this Homey runtime.");
      return;
    }

    const store = this.getStore();
    const nextTitles = {};
    for (let preset = 1; preset <= 6; preset += 1) {
      nextTitles[`preset_${preset}`] = this.getPresetButtonTitle(preset, settings, this.activePreset);
    }

    if (store.preset_button_titles === JSON.stringify(nextTitles)) {
      return;
    }

    try {
      for (const [capability, title] of Object.entries(nextTitles)) {
        await this.setCapabilityOptions(capability, {
          title: {
            en: title,
          },
        });
      }
    } catch (error) {
      this.log(`Could not sync preset button titles: ${error.message}`);
      return;
    }

    if (typeof this.setStoreValue === "function") {
      await this.setStoreValue("preset_button_titles", JSON.stringify(nextTitles));
    }
  }

  async syncNativePresetNames() {
    if (!this.address) {
      return;
    }

    const settings = this.getSettings();
    const results = [];
    for (let preset = 1; preset <= 6; preset += 1) {
      const name = this.getPresetName(preset, settings);
      const streamUrl = String(settings[`preset${preset}_url`] || "").trim();
      if (!streamUrl) {
        results.push(`${preset}: skipped, no URL`);
        continue;
      }

      try {
        await storeNativePreset(this.address, preset, {
          name,
          streamUrl,
        });
        results.push(`${preset}: synced ${name}`);
      } catch (error) {
        results.push(`${preset}: failed (${error.message})`);
      }
    }

    await this.setDiagnosticSetting("native_preset_sync", results.join(" | "));
  }

  getPresetLabel(preset, settings = this.getSettings()) {
    if (!preset) {
      return "None";
    }

    const configuredName = String(settings[`preset${preset}_name`] || "").trim();
    return configuredName ? `${preset}. ${configuredName}` : `Preset ${preset}`;
  }

  getPresetName(preset, settings = this.getSettings()) {
    return String(settings[`preset${preset}_name`] || "").trim() || `Preset ${preset}`;
  }

  async setActivePreset(preset, settings = this.getSettings()) {
    const nextPreset = Number.isInteger(preset) && preset >= 1 && preset <= 6 ? preset : null;
    if (this.activePreset === nextPreset) {
      await this.syncActivePresetSetting(settings);
      await this.syncPresetCapabilitySelection();
      return;
    }

    this.activePreset = nextPreset;
    if (typeof this.setStoreValue === "function") {
      await this.setStoreValue("active_preset", nextPreset || 0);
    }
    await this.syncActivePresetSetting(settings);
    await this.syncPresetButtonTitles(settings);
    await this.syncPresetCapabilitySelection();
  }

  async syncActivePresetSetting(settings = this.getSettings()) {
    await this.setSettings({
      active_preset: this.getPresetLabel(this.activePreset, settings),
    });
  }

  findPresetByUrl(url, settings = this.getSettings()) {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) {
      return null;
    }

    for (let preset = 1; preset <= 6; preset += 1) {
      if (String(settings[`preset${preset}_url`] || "").trim() === normalizedUrl) {
        return preset;
      }
    }

    return null;
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

    this.registerCapabilityListener("speaker_playing", async (value) => {
      if (value) {
        await this.turnOn();
      } else {
        await this.stop();
      }
    });

    for (let preset = 1; preset <= 6; preset += 1) {
      this.registerCapabilityListener(`preset_${preset}`, async () => {
        await this.playConfiguredPreset(preset, { source: "Homey device control" });
      });
    }
  }

  async setCapabilityValueIfAvailable(capability, value) {
    if (this.hasCapability(capability)) {
      await this.setCapabilityValue(capability, value);
    }
  }

  formatDiagnostic(message) {
    const timestamp = new Date().toISOString();
    return `${timestamp} - ${String(message || "").slice(0, SETTING_TEXT_MAX_LENGTH - timestamp.length - 3)}`;
  }

  async setDiagnosticSetting(key, message) {
    try {
      await this.setSettings({
        [key]: this.formatDiagnostic(message),
      });
    } catch (error) {
      this.log(`Could not update diagnostic setting ${key}: ${error.message}`);
    }
  }

  async recordAction(message) {
    this.log(message);
    await this.setDiagnosticSetting("last_action", message);
  }

  async recordPlaybackError(message, { warning = true } = {}) {
    const text = String(message || "Unknown playback error");
    this.error(text);
    await this.setDiagnosticSetting("last_playback_error", text);
    if (warning && typeof this.setWarning === "function") {
      try {
        await this.setWarning(text.slice(0, 250));
      } catch (error) {
        this.log(`Could not set warning: ${error.message}`);
      }
    }
  }

  async clearPlaybackError() {
    await this.setSettings({ last_playback_error: "None" });
    if (typeof this.unsetWarning === "function") {
      try {
        await this.unsetWarning();
      } catch (error) {
        this.log(`Could not clear warning: ${error.message}`);
      }
    }
  }

  async updateWebSocketStatus(message) {
    await this.setDiagnosticSetting("websocket_status", message);
  }

  async recordWebSocketActivity(message) {
    await this.setDiagnosticSetting("last_websocket_activity", String(message || "").slice(0, 420));
  }

  delay(ms) {
    return new Promise((resolve) => {
      this.homey.setTimeout(resolve, ms);
    });
  }

  async syncPresetCapabilitySelection() {
    for (let preset = 1; preset <= 6; preset += 1) {
      await this.setCapabilityValueIfAvailable(`preset_${preset}`, preset === this.activePreset);
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
      await this.updateActivePresetFromStatus(status);
      await this.setCapabilityValueIfAvailable("onoff", !status.isStandby);
      await this.setCapabilityValueIfAvailable("speaker_playing", status.isPlaying);
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
      await this.updateWebSocketStatus(`Connected to ${this.address}:${WEBSOCKET_PORT}`);
      await this.setAvailable();
    });

    this.ws.on("message", (message) => {
      this.handleWebSocketMessage(message).catch((error) => {
        this.error(`Failed to handle WebSocket message: ${error.message}`);
      });
    });

    this.ws.on("close", () => {
      this.log("Bose WebSocket closed");
      this.updateWebSocketStatus("Closed; reconnecting").catch((error) => {
        this.error(`Failed to update WebSocket status: ${error.message}`);
      });
      this.setUnavailable("Speaker connection lost. Reconnecting...").catch((error) => {
        this.error(`Failed to mark speaker unavailable: ${error.message}`);
      });
      this.scheduleReconnect();
    });

    this.ws.on("error", (error) => {
      this.error(`Bose WebSocket error: ${error.message}`);
      this.updateWebSocketStatus(`Error: ${error.message}`).catch((statusError) => {
        this.error(`Failed to update WebSocket status: ${statusError.message}`);
      });
      this.setUnavailable(`Speaker connection error: ${error.message}`).catch((availabilityError) => {
        this.error(`Failed to mark speaker unavailable: ${availabilityError.message}`);
      });
      if (this.ws) {
        try {
          this.ws.terminate();
        } catch (terminateError) {
          this.error(`Failed to terminate Bose WebSocket: ${terminateError.message}`);
        }
      }
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
    await this.recordWebSocketActivity(rawEvent.slice(0, 180));
    const settings = this.getSettings();
    if (settings.debug_enabled) {
      this.log(`Bose WebSocket event: ${rawEvent}`);
      await this.setSettings({ last_event: rawEvent.slice(0, 500) });
    }
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
    await this.recordAction(`Physical preset ${preset} pressed`);
    await this.driver.triggerPresetPressed(this, { preset, raw_event: rawEvent });
    await this.playConfiguredPreset(preset, { source: "physical preset" });
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
      await this.updateActivePresetFromStatus(nowPlayingStatus);
      await this.setCapabilityValueIfAvailable("onoff", !nowPlayingStatus.isStandby);
      await this.setCapabilityValueIfAvailable("speaker_playing", nowPlayingStatus.isPlaying);
    }
  }

  async updateActivePresetFromStatus(status) {
    if (status.isStandby) {
      await this.setActivePreset(null);
      return;
    }

    const matchedPreset = this.findPresetByUrl(status.summary);
    if (matchedPreset) {
      await this.setActivePreset(matchedPreset);
    }
  }

  async updateConnectionState(connectionState) {
    this.connectionState = connectionState.state || null;
    this.wifiSignal = connectionState.signal || null;
    await this.setSettings({
      speaker_status: this.formatSpeakerStatus(),
    });

    if (connectionState.up) {
      await this.setAvailable();
    } else {
      await this.setUnavailable(connectionState.state || "Speaker is offline.");
    }
  }

  async updateNowPlayingStatus(status) {
    this.currentSource = status.source || null;
    this.nowPlaying = status.summary || null;
    await this.setSettings({
      speaker_status: this.formatSpeakerStatus(),
    });
  }

  formatSpeakerStatus() {
    const parts = [];
    if (this.connectionState) {
      parts.push(this.wifiSignal ? `${this.connectionState} (${this.wifiSignal})` : this.connectionState);
    }
    if (this.currentSource) {
      parts.push(`Source: ${this.currentSource}`);
    }
    return parts.length ? parts.join(" | ") : "Unknown";
  }

  async playConfiguredPreset(preset, { source = "Homey" } = {}) {
    const presetNumber = Number(preset && preset.id != null ? preset.id : preset);
    if (!Number.isInteger(presetNumber) || presetNumber < 1 || presetNumber > 6) {
      throw new Error(`Preset ${preset} is not valid.`);
    }

    const settings = this.getSettings();
    const url = String(settings[`preset${presetNumber}_url`] || "").trim();
    if (!url) {
      await this.recordPlaybackError(`Preset ${presetNumber} has no stream URL configured.`, { warning: false });
      return;
    }

    await this.recordAction(`Playing preset ${presetNumber} from ${source}: ${url}`);
    await this.playStream(url, {
      presetNumber,
      source,
      title: this.getPresetName(presetNumber, settings),
    });
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
    await this.setCapabilityValueIfAvailable("speaker_playing", false);
    await this.setActivePreset(null);
  }

  async stop() {
    if (!this.address) {
      throw new Error("No speaker IP address configured.");
    }

    this.log(`Stopping playback on ${this.address}`);
    await stopPlayback(this.address);
    await this.setCapabilityValueIfAvailable("speaker_playing", false);
    await this.setActivePreset(null);
  }

  async setSpeakerVolume(value) {
    if (!this.address) {
      throw new Error("No speaker IP address configured.");
    }

    await setVolume(this.address, value);
    await this.setCapabilityValueIfAvailable("volume_set", value);
  }

  async playStream(url, {
    volume,
    presetNumber = null,
    source = "Homey",
    title = "Internet Radio",
    albumArtUrl = "",
  } = {}) {
    if (!this.address) {
      throw new Error("No speaker IP address configured.");
    }

    const playback = this.playbackQueue
      .catch(() => null)
      .then(() => this.playStreamExclusive(url, {
        volume,
        presetNumber,
        source,
        title,
        albumArtUrl,
      }));
    this.playbackQueue = playback;
    return playback;
  }

  async playStreamExclusive(url, {
    volume,
    presetNumber = null,
    source = "Homey",
    title = "Internet Radio",
    albumArtUrl = "",
  } = {}) {
    try {
      await this.clearPlaybackError();
      await this.recordAction(`Starting stream from ${source} on ${this.address}: ${url}`);
      await this.prepareSpeakerForPlayback();
      const status = await this.playStreamWithFallback(url, {
        volume,
        title,
        albumArtUrl,
        presetNumber,
      });
      await this.setCapabilityValueIfAvailable("speaker_playing", status.isPlaying);
      await this.recordAction(`Playback verified: ${status.source || "unknown source"} / ${status.rawPlayStatus || "unknown state"}`);
      await this.setAvailable();
    } catch (error) {
      await this.setCapabilityValueIfAvailable("speaker_playing", false);
      const detailedMessage = error.details || error.message;
      await this.recordPlaybackError(`Could not play stream: ${detailedMessage}`);
      throw new Error("Bose did not start playback. If this repeats, reboot the speaker and check Last playback error.");
    }
  }

  async prepareSpeakerForPlayback() {
    try {
      await this.recordAction("Preparing speaker for UPnP playback");
      await selectLastSource(this.address);
      await this.delay(PRE_PLAY_WAKE_DELAY_MS);
    } catch (error) {
      await this.recordAction(`Preparing speaker ignored: ${error.message}`);
    }
  }

  async playStreamWithFallback(url, { volume, title, albumArtUrl, presetNumber }) {
    const attempts = [
      { metadataMode: "didl", label: "with metadata", recovery: false },
      { metadataMode: "empty", label: "without metadata", recovery: false },
      { metadataMode: "empty", label: "after soft recovery", recovery: true },
    ];
    const errors = [];

    for (const attempt of attempts) {
      try {
        if (attempt.recovery) {
          await this.recoverUpnpRenderer();
        }
        await this.recordAction(`Trying playback ${attempt.label}: ${url}`);
        await playStream(this.address, url, {
          volume,
          title,
          albumArtUrl,
          metadataMode: attempt.metadataMode,
          onStep: async (step) => {
            await this.recordAction(`Playback ${attempt.label} step ${step} for ${url}`);
          },
        });

        await this.setCapabilityValueIfAvailable("onoff", true);
        const activePreset = presetNumber || this.findPresetByUrl(url);
        await this.setActivePreset(activePreset);
        return await this.verifyPlaybackStarted(url);
      } catch (error) {
        const detailedMessage = error.details || error.message;
        errors.push(`${attempt.label}: ${detailedMessage}`);
        await this.recordAction(`Playback ${attempt.label} failed; ${attempt.metadataMode === "didl" ? "retrying without metadata" : "no fallback left"}`);
      }
    }

    const error = new Error("Bose UPnP renderer appears stuck.");
    error.details = errors.join(" | ");
    throw error;
  }

  async recoverUpnpRenderer() {
    await this.recordAction("Recovering Bose UPnP renderer");
    try {
      await stopPlayback(this.address);
    } catch (error) {
      await this.recordAction(`Recovery stop ignored: ${error.message}`);
    }
    await this.delay(RECOVERY_SETTLE_MS);

    try {
      await standby(this.address);
      await this.delay(RECOVERY_SETTLE_MS);
    } catch (error) {
      await this.recordAction(`Recovery standby ignored: ${error.message}`);
    }

    await this.prepareSpeakerForPlayback();
  }

  async verifyPlaybackStarted(expectedUrl) {
    const startedAt = Date.now();
    let lastNowPlaying = "";
    let lastStatus = null;
    let sawRequestedUri = false;

    while (Date.now() - startedAt < PLAYBACK_VERIFY_TIMEOUT_MS) {
      await this.delay(PLAYBACK_VERIFY_INTERVAL_MS);
      const nowPlaying = await getNowPlaying(this.address);
      const status = extractNowPlayingStatus(nowPlaying);
      lastNowPlaying = compactXml(nowPlaying);
      lastStatus = status;
      sawRequestedUri = sawRequestedUri || lastNowPlaying.includes(expectedUrl);
      await this.updateNowPlayingStatus(status);
      await this.updateActivePresetFromStatus(status);
      await this.recordAction(`Playback verify: ${status.source || "unknown source"} / ${status.rawPlayStatus || "unknown state"}`);
      this.log(`Now playing after playback request: ${lastNowPlaying}`);

      if (status.isPlaying) {
        return status;
      }
    }

    const error = new Error("Bose UPnP renderer appears stuck.");
    const transportDetails = await this.getTransportDiagnostics();
    error.details = [
      `Bose did not enter PLAY_STATE after starting ${expectedUrl}.`,
      `Saw requested URI: ${sawRequestedUri ? "yes" : "no"}.`,
      `Last source: ${(lastStatus && lastStatus.source) || "unknown"}.`,
      `Last play status: ${(lastStatus && lastStatus.rawPlayStatus) || "unknown"}.`,
      transportDetails,
      `Last now playing: ${lastNowPlaying || "none"}`,
    ].join(" ");
    throw error;
  }

  async getTransportDiagnostics() {
    try {
      const [transportInfo, positionInfo] = await Promise.all([
        getTransportInfo(this.address),
        getPositionInfo(this.address),
      ]);
      return `UPnP transport: ${compactXml(transportInfo)} Position: ${compactXml(positionInfo)}.`;
    } catch (error) {
      return `UPnP diagnostics failed: ${error.message}.`;
    }
  }
}

module.exports = SoundTouchDevice;
