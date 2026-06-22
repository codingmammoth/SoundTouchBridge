"use strict";

const Homey = require("homey");
const WebSocket = require("ws");
const {
  countStationClick,
  searchRandomCompatibleStations,
} = require("../../lib/radio-browser-client");
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
const WEBSOCKET_CONNECT_TIMEOUT_MS = 15000;
const WEBSOCKET_WATCHDOG_INTERVAL_MS = 30000;
const PRESET_DEBOUNCE_MS = 1500;
const PLAYBACK_VERIFY_TIMEOUT_MS = 12000;
const PLAYBACK_VERIFY_INTERVAL_MS = 1500;
const PRE_PLAY_WAKE_DELAY_MS = 1200;
const RECOVERY_SETTLE_MS = 1500;
const SETTING_TEXT_MAX_LENGTH = 900;
const RANDOM_PLAYBACK_ATTEMPT_LIMIT = 4;
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

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeCountryCode(value) {
  return normalizeString(value).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
}

function isEnabled(value) {
  return value === true || value === "true";
}

function shuffle(items) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swapIndex];
    copy[swapIndex] = current;
  }
  return copy;
}

class SoundTouchDevice extends Homey.Device {
  async onInit() {
    this.ws = null;
    this.reconnectTimer = null;
    this.websocketConnectTimer = null;
    this.websocketWatchdogTimer = null;
    this.websocketAwaitingPong = false;
    this.isDeleted = false;
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
    this.isDeleted = true;
    this.clearReconnectTimer();
    this.closeWebSocket("Device deleted");
  }

  async onSettings({ newSettings, changedKeys }) {
    this.validatePresetUrlSettings(newSettings, changedKeys);

    const presetSettingsChanged = changedKeys.some((key) => /^preset[1-6]_(name|url|mode|random_)/.test(key));
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
      this.closeWebSocket("IP address changed");
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

    await this.setStoreValue("debug_enabled", false);
    await this.setDiagnostic("last_event", "Enable debug logging to capture raw events.");
    await this.setDiagnostic("websocket_status", "Unknown");
    await this.setDiagnostic("last_websocket_activity", "None");
    await this.setDiagnostic("last_action", "None");
    await this.setDiagnostic("last_playback_error", "None");
    await this.setDiagnostic("last_playback_source", "None");
    await this.setDiagnostic("last_playback_trace", "None");
    await this.setDiagnostic("last_playback_verification", "None");
    await this.setDiagnostic("last_preset_event", "None");
    await this.setDiagnostic("last_upnp_phase", "None");
    await this.setDiagnostic("last_now_playing", "None");
    await this.setDiagnostic("last_random_station", "None");
    await this.setDiagnostic("native_preset_sync", "Not synced yet");
    await this.setStoreValue("publish_ready_settings_applied", true);
  }

  async syncPresetSettingsUi(settings = this.getSettings()) {
    const updates = {};
    for (let preset = 1; preset <= 6; preset += 1) {
      const mode = this.getPresetMode(preset, settings);
      const name = this.getPresetName(preset, settings);
      const url = normalizeString(settings[`preset${preset}_url`]);
      const summary = mode === "random"
        ? name
        : (name !== `Preset ${preset}` || url ? name : "Not assigned");

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
    const title = this.getPresetName(preset, settings);

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
    const store = this.getStore();
    const results = [];
    for (let preset = 1; preset <= 6; preset += 1) {
      const name = this.getPresetName(preset, settings);
      const mode = this.getPresetMode(preset, settings);
      const streamUrl = mode === "random"
        ? normalizeString(store[`preset${preset}_last_station_url`])
        : normalizeString(settings[`preset${preset}_url`]);
      if (!streamUrl) {
        results.push(mode === "random" ? `${preset}: skipped, no random station yet` : `${preset}: skipped, no URL`);
        continue;
      }

      try {
        await storeNativePreset(this.address, preset, {
          name,
          streamUrl,
        });
        results.push(mode === "random" ? `${preset}: synced ${name} fallback` : `${preset}: synced ${name}`);
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

    return `${preset}. ${this.getPresetName(preset, settings)}`;
  }

  getPresetName(preset, settings = this.getSettings()) {
    const configuredName = normalizeString(settings[`preset${preset}_name`]);
    if (configuredName) {
      return configuredName;
    }
    if (this.getPresetMode(preset, settings) === "random") {
      return this.getRandomPresetLabel(preset, settings);
    }
    return `Preset ${preset}`;
  }

  getPresetMode(preset, settings = this.getSettings()) {
    return normalizeString(settings[`preset${preset}_mode`]) === "random" ? "random" : "fixed";
  }

  getRandomPresetLabel(preset, settings = this.getSettings()) {
    const tag = normalizeString(settings[`preset${preset}_random_tag`]);
    const countryEnabled = isEnabled(settings[`preset${preset}_random_country_enabled`]);
    const countrycode = normalizeCountryCode(settings[`preset${preset}_random_countrycode`]);
    const labelTag = tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : "Radio";
    return countryEnabled && countrycode ? `Random ${labelTag} (${countrycode})` : `Random ${labelTag}`;
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
    await this.setDiagnostic("active_preset", this.getPresetLabel(this.activePreset, settings));
  }

  findPresetByUrl(url, settings = this.getSettings()) {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) {
      return null;
    }

    const store = this.getStore();
    for (let preset = 1; preset <= 6; preset += 1) {
      const configuredUrl = this.getPresetMode(preset, settings) === "random"
        ? normalizeString(store[`preset${preset}_last_station_url`])
        : normalizeString(settings[`preset${preset}_url`]);
      if (configuredUrl === normalizedUrl) {
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

  isDebugEnabled() {
    if (typeof this.getStoreValue === "function") {
      return this.getStoreValue("debug_enabled") === true;
    }
    return this.getStore().debug_enabled === true;
  }

  async setDiagnostic(key, value) {
    if (typeof this.setStoreValue !== "function") {
      return;
    }
    try {
      await this.setStoreValue(`diag_${key}`, value);
    } catch (error) {
      this.log(`Could not update diagnostic ${key}: ${error.message}`);
    }
  }

  async setDiagnosticSetting(key, message) {
    await this.setDiagnostic(key, this.formatDiagnostic(message));
  }

  async recordAction(message) {
    this.log(message);
    await this.setDiagnosticSetting("last_action", message);
  }

  async recordPresetEvent(preset, source) {
    await this.setDiagnosticSetting("last_preset_event", `${source}: preset ${preset}`);
  }

  async recordPlaybackSource({ source, presetNumber, mode, title, url }) {
    const parts = [`Source: ${source || "Homey"}`];
    if (presetNumber) {
      parts.push(`Preset: ${presetNumber}`);
    }
    if (mode) {
      parts.push(`Mode: ${mode}`);
    }
    if (title) {
      parts.push(`Title: ${title}`);
    }
    if (url) {
      parts.push(`URL: ${url}`);
    }
    await this.setDiagnosticSetting("last_playback_source", parts.join(" | "));
  }

  async recordPlaybackTrace(message) {
    await this.setDiagnosticSetting("last_playback_trace", message);
  }

  async recordPlaybackVerification(message) {
    await this.setDiagnosticSetting("last_playback_verification", message);
  }

  async recordUpnpPhase(phase, detail) {
    const message = detail ? `${phase}: ${detail}` : phase;
    await this.setDiagnosticSetting("last_upnp_phase", message);
  }

  async recordNowPlayingDiagnostic(message) {
    await this.setDiagnosticSetting("last_now_playing", String(message || "None").slice(0, 500));
  }

  async recordPlaybackError(message, { warning = true } = {}) {
    const text = String(message || "Unknown playback error");
    this.error(text);
    await this.setDiagnosticSetting("last_playback_error", text);
    await this.recordPlaybackTrace(`Failed: ${text}`);
    if (warning && typeof this.setWarning === "function") {
      try {
        await this.setWarning(text.slice(0, 250));
      } catch (error) {
        this.log(`Could not set warning: ${error.message}`);
      }
    }
  }

  async clearPlaybackError() {
    await this.setDiagnostic("last_playback_error", "None");
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
    if (!this.address || this.isDeleted) {
      return;
    }

    this.clearReconnectTimer();
    this.closeWebSocket("Opening new connection");

    const url = `ws://${this.address}:${WEBSOCKET_PORT}`;
    this.log(`Connecting Bose WebSocket ${url}`);
    this.updateWebSocketStatus(`Connecting to ${this.address}:${WEBSOCKET_PORT}`).catch((error) => {
      this.error(`Failed to update WebSocket status: ${error.message}`);
    });

    const ws = new WebSocket(url, WEBSOCKET_PROTOCOL);
    this.ws = ws;
    this.websocketAwaitingPong = false;
    this.startWebSocketConnectTimer(ws);

    ws.on("open", async () => {
      if (this.ws !== ws) {
        return;
      }

      this.clearWebSocketConnectTimer();
      this.log("Bose WebSocket connected");
      await this.updateWebSocketStatus(`Connected to ${this.address}:${WEBSOCKET_PORT}`);
      await this.recordWebSocketActivity("WebSocket opened");
      await this.setAvailable();
      await this.syncStatus();
      this.scheduleWebSocketWatchdog(ws);
    });

    ws.on("message", (message) => {
      if (this.ws !== ws) {
        return;
      }

      this.websocketAwaitingPong = false;
      this.handleWebSocketMessage(message).catch((error) => {
        this.error(`Failed to handle WebSocket message: ${error.message}`);
      });
    });

    ws.on("pong", () => {
      if (this.ws !== ws) {
        return;
      }

      this.websocketAwaitingPong = false;
      this.recordWebSocketActivity("WebSocket heartbeat pong").catch((error) => {
        this.error(`Failed to record WebSocket heartbeat: ${error.message}`);
      });
    });

    ws.on("close", (code, reasonBuffer) => {
      if (this.ws !== ws) {
        return;
      }

      this.ws = null;
      this.clearWebSocketConnectTimer();
      this.clearWebSocketWatchdogTimer();
      this.websocketAwaitingPong = false;
      const closeReason = this.formatWebSocketCloseReason(code, reasonBuffer);
      this.log(`Bose WebSocket closed: ${closeReason}`);
      this.updateWebSocketStatus(`Closed; reconnecting (${closeReason})`).catch((error) => {
        this.error(`Failed to update WebSocket status: ${error.message}`);
      });
      this.setUnavailable("Speaker connection lost. Reconnecting...").catch((error) => {
        this.error(`Failed to mark speaker unavailable: ${error.message}`);
      });
      this.scheduleReconnect(`closed: ${closeReason}`);
    });

    ws.on("error", (error) => {
      if (this.ws !== ws) {
        return;
      }

      this.error(`Bose WebSocket error: ${error.message}`);
      this.updateWebSocketStatus(`Error: ${error.message}`).catch((statusError) => {
        this.error(`Failed to update WebSocket status: ${statusError.message}`);
      });
      this.setUnavailable(`Speaker connection error: ${error.message}`).catch((availabilityError) => {
        this.error(`Failed to mark speaker unavailable: ${availabilityError.message}`);
      });
      this.forceWebSocketReconnect(`error: ${error.message}`);
    });
  }

  closeWebSocket(reason) {
    if (!this.ws) {
      return;
    }

    const ws = this.ws;
    this.ws = null;
    this.websocketAwaitingPong = false;
    this.clearWebSocketConnectTimer();
    this.clearWebSocketWatchdogTimer();
    ws.removeAllListeners();
    try {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.once("error", () => {});
        ws.once("close", () => {});
        ws.terminate();
      } else if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      } else if (typeof ws.terminate === "function" && ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
    } catch (error) {
      this.error(`Failed to close WebSocket${reason ? ` (${reason})` : ""}: ${error.message}`);
    }
  }

  forceWebSocketReconnect(reason) {
    if (this.isDeleted) {
      return;
    }

    this.closeWebSocket(reason);
    this.scheduleReconnect(reason);
  }

  scheduleReconnect(reason) {
    if (this.reconnectTimer || !this.address || this.isDeleted) {
      return;
    }

    const message = reason
      ? `Reconnecting in ${RECONNECT_DELAY_MS / 1000}s (${reason})`
      : `Reconnecting in ${RECONNECT_DELAY_MS / 1000}s`;
    this.log(`Bose WebSocket ${message}`);
    this.updateWebSocketStatus(message).catch((error) => {
      this.error(`Failed to update WebSocket status: ${error.message}`);
    });

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

  startWebSocketConnectTimer(ws) {
    this.clearWebSocketConnectTimer();
    this.websocketConnectTimer = this.homey.setTimeout(() => {
      this.websocketConnectTimer = null;
      if (this.ws !== ws || this.isDeleted) {
        return;
      }
      if (ws.readyState === WebSocket.CONNECTING) {
        this.forceWebSocketReconnect("connect timeout");
      }
    }, WEBSOCKET_CONNECT_TIMEOUT_MS);
  }

  clearWebSocketConnectTimer() {
    if (this.websocketConnectTimer) {
      this.homey.clearTimeout(this.websocketConnectTimer);
      this.websocketConnectTimer = null;
    }
  }

  scheduleWebSocketWatchdog(ws) {
    this.clearWebSocketWatchdogTimer();
    if (this.ws !== ws || this.isDeleted) {
      return;
    }

    this.websocketWatchdogTimer = this.homey.setTimeout(() => {
      this.websocketWatchdogTimer = null;
      this.checkWebSocketHealth(ws);
    }, WEBSOCKET_WATCHDOG_INTERVAL_MS);
  }

  clearWebSocketWatchdogTimer() {
    if (this.websocketWatchdogTimer) {
      this.homey.clearTimeout(this.websocketWatchdogTimer);
      this.websocketWatchdogTimer = null;
    }
  }

  checkWebSocketHealth(ws) {
    if (this.ws !== ws || this.isDeleted) {
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      this.forceWebSocketReconnect(`watchdog saw ${this.formatWebSocketReadyState(ws.readyState)}`);
      return;
    }

    if (this.websocketAwaitingPong) {
      this.forceWebSocketReconnect("watchdog missed heartbeat pong");
      return;
    }

    try {
      this.websocketAwaitingPong = true;
      ws.ping();
      this.updateWebSocketStatus(`Connected to ${this.address}:${WEBSOCKET_PORT}; heartbeat sent`).catch((error) => {
        this.error(`Failed to update WebSocket status: ${error.message}`);
      });
      this.scheduleWebSocketWatchdog(ws);
    } catch (error) {
      this.forceWebSocketReconnect(`heartbeat failed: ${error.message}`);
    }
  }

  formatWebSocketReadyState(readyState) {
    if (readyState === WebSocket.CONNECTING) {
      return "CONNECTING";
    }
    if (readyState === WebSocket.OPEN) {
      return "OPEN";
    }
    if (readyState === WebSocket.CLOSING) {
      return "CLOSING";
    }
    if (readyState === WebSocket.CLOSED) {
      return "CLOSED";
    }
    return `readyState ${readyState}`;
  }

  formatWebSocketCloseReason(code, reasonBuffer) {
    const reason = reasonBuffer && reasonBuffer.length
      ? reasonBuffer.toString()
      : "";
    return reason ? `${code} ${reason}` : String(code);
  }

  async handleWebSocketMessage(message) {
    const rawEvent = compactXml(message.toString());
    await this.recordWebSocketActivity(rawEvent.slice(0, 180));
    if (this.isDebugEnabled()) {
      this.log(`Bose WebSocket event: ${rawEvent}`);
      await this.setDiagnostic("last_event", rawEvent.slice(0, 500));
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
    await this.recordPresetEvent(preset, "Physical WebSocket event");
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
    await this.setDiagnostic("speaker_status", this.formatSpeakerStatus());

    if (connectionState.up) {
      await this.setAvailable();
    } else {
      await this.setUnavailable(connectionState.state || "Speaker is offline.");
    }
  }

  async updateNowPlayingStatus(status) {
    this.currentSource = status.source || null;
    this.nowPlaying = status.summary || null;
    await this.setDiagnostic("speaker_status", this.formatSpeakerStatus());
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
    const mode = this.getPresetMode(presetNumber, settings);
    await this.recordPlaybackSource({
      source,
      presetNumber,
      mode,
      title: this.getPresetName(presetNumber, settings),
    });

    if (mode === "random") {
      await this.playRandomPreset(presetNumber, { source, settings });
      return;
    }

    const url = normalizeString(settings[`preset${presetNumber}_url`]);
    if (!url) {
      await this.recordPlaybackTrace(`Preset ${presetNumber} from ${source} has no stream URL configured`);
      await this.recordPlaybackError(`Preset ${presetNumber} has no stream URL configured.`, { warning: false });
      return;
    }

    await this.recordPlaybackSource({
      source,
      presetNumber,
      mode,
      title: this.getPresetName(presetNumber, settings),
      url,
    });
    await this.recordAction(`Playing preset ${presetNumber} from ${source}: ${url}`);
    await this.playStream(url, {
      presetNumber,
      source,
      title: this.getPresetName(presetNumber, settings),
    });
  }

  getRandomPresetRule(preset, settings = this.getSettings()) {
    const tag = normalizeString(settings[`preset${preset}_random_tag`]);
    const countryEnabled = isEnabled(settings[`preset${preset}_random_country_enabled`]);
    const countrycode = normalizeCountryCode(settings[`preset${preset}_random_countrycode`]);
    return {
      tag,
      countryEnabled,
      countrycode: countryEnabled ? countrycode : "",
    };
  }

  getLastRandomStation(preset) {
    const store = this.getStore();
    const name = normalizeString(store[`preset${preset}_last_station_name`]);
    const url = normalizeString(store[`preset${preset}_last_station_url`]);
    const stationuuid = normalizeString(store[`preset${preset}_last_station_uuid`]);
    if (!url) {
      return null;
    }
    return {
      name,
      streamUrl: url,
      stationuuid,
    };
  }

  getRandomPlaybackCandidates(stations, lastStation) {
    const seen = {};
    const deduped = stations.filter((station) => {
      const stationUuid = normalizeString(station.stationuuid).toLowerCase();
      const streamUrl = normalizeString(station.streamUrl).toLowerCase();
      const key = stationUuid || streamUrl;
      if (!key || seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    });

    if (deduped.length <= 1 || !lastStation) {
      return shuffle(deduped);
    }

    const lastUuid = normalizeString(lastStation.stationuuid).toLowerCase();
    const lastUrl = normalizeString(lastStation.streamUrl).toLowerCase();
    const withoutLast = deduped.filter((station) => {
      const stationUuid = normalizeString(station.stationuuid).toLowerCase();
      const streamUrl = normalizeString(station.streamUrl).toLowerCase();
      return !(lastUuid && stationUuid === lastUuid) && !(lastUrl && streamUrl === lastUrl);
    });

    return shuffle(withoutLast.length > 0 ? withoutLast : deduped);
  }

  async rememberRandomStation(preset, station, label) {
    if (typeof this.setStoreValue === "function") {
      await this.setStoreValue(`preset${preset}_last_station_name`, normalizeString(station.name));
      await this.setStoreValue(`preset${preset}_last_station_url`, normalizeString(station.streamUrl));
      await this.setStoreValue(`preset${preset}_last_station_uuid`, normalizeString(station.stationuuid));
    }
    await this.setDiagnostic("last_random_station", `${label}: ${normalizeString(station.name) || station.streamUrl}`);
  }

  async playRandomPreset(preset, { source = "Homey", settings = this.getSettings() } = {}) {
    const label = this.getPresetName(preset, settings);
    const rule = this.getRandomPresetRule(preset, settings);
    if (!rule.tag) {
      await this.recordPlaybackError(`Random preset ${preset} has no tag configured.`, { warning: false });
      return;
    }

    await this.recordPlaybackTrace(`Random preset ${preset} from ${source}: tag ${rule.tag}${rule.countrycode ? ` (${rule.countrycode})` : ""}`);
    const lastStation = this.getLastRandomStation(preset);
    let searchResults = [];
    let searchError = null;
    try {
      const response = await searchRandomCompatibleStations({
        tag: rule.tag,
        countrycode: rule.countryEnabled ? rule.countrycode : "",
      });
      searchResults = response.results || [];
      await this.recordPlaybackTrace(`Random preset ${preset} matched ${searchResults.length} station(s) from ${response.source}`);
      await this.recordAction(`Random preset ${preset} matched ${searchResults.length} station(s) from ${response.source}`);
    } catch (error) {
      searchError = error;
      await this.recordPlaybackTrace(`Random preset ${preset} search failed: ${error.message}`);
      await this.recordAction(`Random preset ${preset} search failed: ${error.message}`);
    }

    const candidates = this.getRandomPlaybackCandidates(searchResults, lastStation)
      .slice(0, RANDOM_PLAYBACK_ATTEMPT_LIMIT);
    const errors = [];

    for (const station of candidates) {
      try {
        await this.recordPlaybackSource({
          source: `${source} random preset`,
          presetNumber: preset,
          mode: "random",
          title: station.name || label,
          url: station.streamUrl,
        });
        await this.recordPlaybackTrace(`Random preset ${preset} selected ${station.name || station.streamUrl}`);
        await this.recordAction(`Random preset ${preset} selected ${station.name || station.streamUrl}`);
        await this.playStream(station.streamUrl, {
          presetNumber: preset,
          source: `${source} random preset`,
          title: station.name || label,
          albumArtUrl: station.favicon || "",
        });
        await this.rememberRandomStation(preset, station, label);
        await this.syncNativePresetNames();
        countStationClick(station.stationuuid).catch((error) => {
          this.log(`Could not count Radio Browser station click: ${error.message}`);
        });
        return;
      } catch (error) {
        const message = error.details || error.message;
        errors.push(`${station.name || station.streamUrl}: ${message}`);
        await this.recordAction(`Random preset ${preset} failed ${station.name || station.streamUrl}: ${message}`);
      }
    }

    if (lastStation) {
      try {
        await this.recordPlaybackSource({
          source: `${source} random preset fallback`,
          presetNumber: preset,
          mode: "random fallback",
          title: lastStation.name || label,
          url: lastStation.streamUrl,
        });
        await this.recordPlaybackTrace(`Random preset ${preset} falling back to ${lastStation.name || lastStation.streamUrl}`);
        await this.recordAction(`Random preset ${preset} falling back to last station ${lastStation.name || lastStation.streamUrl}`);
        await this.playStream(lastStation.streamUrl, {
          presetNumber: preset,
          source: `${source} random preset fallback`,
          title: lastStation.name || label,
        });
        await this.setDiagnostic("last_random_station", `${label}: ${lastStation.name || lastStation.streamUrl}`);
        return;
      } catch (error) {
        errors.push(`last station fallback: ${error.details || error.message}`);
      }
    }

    const reason = searchError && searchResults.length === 0
      ? searchError.message
      : (errors.join(" | ") || "No compatible stations matched this random preset rule.");
    await this.recordPlaybackError(`Random preset ${preset} could not start: ${reason}`);
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
      await this.recordPlaybackSource({
        source,
        presetNumber,
        mode: presetNumber ? this.getPresetMode(presetNumber) : "direct stream",
        title,
        url,
      });
      await this.recordPlaybackTrace(`Queued stream from ${source}: ${url}`);
      await this.recordAction(`Starting stream from ${source} on ${this.address}: ${url}`);
      await this.prepareSpeakerForPlayback();
      const status = await this.playStreamWithFallback(url, {
        volume,
        title,
        albumArtUrl,
        presetNumber,
      });
      await this.setCapabilityValueIfAvailable("speaker_playing", status.isPlaying);
      await this.recordPlaybackVerification(`Verified: ${status.source || "unknown source"} / ${status.rawPlayStatus || "unknown state"}`);
      await this.recordPlaybackTrace(`Playback verified for ${url}`);
      await this.recordAction(`Playback verified: ${status.source || "unknown source"} / ${status.rawPlayStatus || "unknown state"}`);
      await this.setAvailable();
    } catch (error) {
      await this.setCapabilityValueIfAvailable("speaker_playing", false);
      const detailedMessage = error.details || error.message;
      await this.recordPlaybackVerification(`Failed: ${detailedMessage}`);
      await this.recordPlaybackError(`Could not play stream: ${detailedMessage}`);
      throw new Error("Bose did not start playback. If this repeats, reboot the speaker and check Last playback error.");
    }
  }

  async prepareSpeakerForPlayback() {
    try {
      await this.recordUpnpPhase("prepare", "select last source");
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
        await this.recordPlaybackTrace(`Trying playback ${attempt.label}: ${url}`);
        await this.recordAction(`Trying playback ${attempt.label}: ${url}`);
        await playStream(this.address, url, {
          volume,
          title,
          albumArtUrl,
          metadataMode: attempt.metadataMode,
          onStep: async (step) => {
            await this.recordUpnpPhase(`Playback ${attempt.label}`, `${step} for ${url}`);
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
        await this.recordUpnpPhase(`Playback ${attempt.label} failed`, detailedMessage);
        await this.recordPlaybackTrace(`Playback ${attempt.label} failed: ${detailedMessage}`);
        await this.recordAction(`Playback ${attempt.label} failed: ${detailedMessage}`);
      }
    }

    const error = new Error("Bose UPnP renderer appears stuck.");
    error.details = errors.join(" | ");
    throw error;
  }

  async recoverUpnpRenderer() {
    await this.recordUpnpPhase("recovery", "starting renderer recovery");
    await this.recordAction("Recovering Bose UPnP renderer");
    try {
      await this.recordUpnpPhase("recovery", "stop playback");
      await stopPlayback(this.address);
    } catch (error) {
      await this.recordAction(`Recovery stop ignored: ${error.message}`);
    }
    await this.delay(RECOVERY_SETTLE_MS);

    try {
      await this.recordUpnpPhase("recovery", "standby");
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
      await this.recordNowPlayingDiagnostic(lastNowPlaying || "None");
      await this.recordPlaybackVerification(`Checking: ${status.source || "unknown source"} / ${status.rawPlayStatus || "unknown state"} / requested URI ${sawRequestedUri ? "seen" : "not seen"}`);
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
    await this.recordNowPlayingDiagnostic(lastNowPlaying || "None");
    await this.recordPlaybackVerification(error.details);
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
