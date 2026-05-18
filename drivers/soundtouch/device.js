"use strict";

const Homey = require("homey");
const WebSocket = require("ws");
const {
  compactXml,
  extractPresetNumber,
  getNowPlaying,
  playStream,
} = require("../../lib/soundtouch-client");

const WEBSOCKET_PORT = 8080;
const WEBSOCKET_PROTOCOL = "gabbo";
const RECONNECT_DELAY_MS = 10000;
const PRESET_DEBOUNCE_MS = 1500;

class SoundTouchDevice extends Homey.Device {
  async onInit() {
    this.ws = null;
    this.reconnectTimer = null;
    this.lastPresetAt = new Map();
    this.log("SoundTouch device initialized");

    await this.refreshAddressFromSettings();
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
      await this.setAvailable();
    });

    this.ws.on("message", (message) => {
      this.handleWebSocketMessage(message).catch((error) => {
        this.error(`Failed to handle WebSocket message: ${error.message}`);
      });
    });

    this.ws.on("close", () => {
      this.log("Bose WebSocket closed");
      this.scheduleReconnect();
    });

    this.ws.on("error", (error) => {
      this.error(`Bose WebSocket error: ${error.message}`);
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

  async playStream(url, { volume } = {}) {
    if (!this.address) {
      throw new Error("No speaker IP address configured.");
    }

    this.log(`Playing stream on ${this.address}: ${url}`);
    await playStream(this.address, url, { volume });

    const nowPlaying = await getNowPlaying(this.address);
    this.log(`Now playing: ${compactXml(nowPlaying)}`);
    await this.setAvailable();
  }
}

module.exports = SoundTouchDevice;
