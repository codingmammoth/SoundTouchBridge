"use strict";

const Homey = require("homey");
const {
  extractDeviceId,
  extractName,
  getInfo,
} = require("../../lib/soundtouch-client");

const RADIO_DEVICE_ICON = "/icon.svg";
const INFO_PREVIEW_LENGTH = 180;
const STARTUP_DISCOVERY_LOG_DELAY_MS = 3000;
const PAIRING_DISCOVERY_TIMEOUT_MS = 12000;
const INFO_REQUEST_TIMEOUT_MS = 3000;

class SoundTouchDriver extends Homey.Driver {
  async onInit() {
    this.log("SoundTouch driver initialized");

    this.presetPressedTrigger = this.homey.flow.getDeviceTriggerCard("preset_pressed");

    this.homey.flow.getActionCard("play_preset_slot").registerRunListener(async ({ device, preset }) => {
      await device.playConfiguredPreset(preset && preset.id != null ? preset.id : preset);
    });

    this.homey.flow.getActionCard("play_stream").registerRunListener(async ({ device, url }) => {
      await device.playStream(url);
    });

    this.homey.setTimeout(() => {
      this.logDiscoverySnapshot("startup delayed check").catch((error) => {
        this.error(`Startup discovery snapshot failed: ${error.message}`);
      });
    }, STARTUP_DISCOVERY_LOG_DELAY_MS);
  }

  async onPair(session) {
    this.log("Pair session opened for SoundTouch driver");

    session.setHandler("showView", async (viewId) => {
      this.log(`Pair view shown: ${viewId}`);
    });

    session.setHandler("list_devices", async () => {
      this.log("Pair list_devices handler invoked");
      return this.listPairingDevices();
    });

    session.setHandler("pair_view_ready", async () => {
      this.log("Custom pair view reported ready");
      return true;
    });

    session.setHandler("pair_view_log", async (message) => {
      this.log(`Custom pair view: ${String(message || "")}`);
      return true;
    });

    session.setHandler("disconnect", async () => {
      this.log("Pair session closed for SoundTouch driver");
    });

    this.log("Showing custom list_devices pair view");
    await session.showView("list_devices");
  }

  async onPairListDevices() {
    this.log("onPairListDevices invoked");
    return this.listPairingDevices();
  }

  async listPairingDevices() {
    this.log("Pairing requested: listing SoundTouch speakers");

    try {
      const discovered = await this.withTimeout(
        this.getDiscoveredSpeakers(),
        PAIRING_DISCOVERY_TIMEOUT_MS,
        "Pairing discovery timed out",
      );
      this.log(`Pairing discovery completed: ${discovered.length} speaker(s) available`);
      if (discovered.length > 0) {
        return discovered;
      }

      this.log("No SoundTouch speakers found through Homey discovery yet.");
      return [];
    } catch (error) {
      this.error(`Pairing discovery failed: ${error.message}`);
      throw error;
    }
  }

  async withTimeout(promise, timeoutMs, timeoutMessage) {
    let timeout = null;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timeout = this.homey.setTimeout(() => {
            this.error(`${timeoutMessage} after ${timeoutMs}ms`);
            resolve([]);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        this.homey.clearTimeout(timeout);
      }
    }
  }

  async logDiscoverySnapshot(reason) {
    const strategy = this.getDiscoveryStrategy();
    const results = Object.values(strategy.getDiscoveryResults());
    this.log(`Discovery snapshot (${reason}): ${results.length} raw result(s)`);
    results.forEach((result) => {
      this.log(`Snapshot candidate: ${this.formatDiscoveryResult(result)}`);
    });
  }

  async getDiscoveredSpeakers() {
    const strategy = this.getDiscoveryStrategy();
    const results = Object.values(strategy.getDiscoveryResults());
    const speakers = [];

    this.log(`Homey mDNS discovery returned ${results.length} raw result(s)`);

    for (const result of results) {
      const address = result.address;
      this.log(`Discovery candidate: ${this.formatDiscoveryResult(result)}`);
      if (!address) {
        this.log("Skipping discovery candidate without address");
        continue;
      }

      try {
        this.log(`Checking SoundTouch /info at ${address}:8090`);
        const infoXml = await getInfo(address, INFO_REQUEST_TIMEOUT_MS);
        const id = extractDeviceId(infoXml) || result.id || address;
        const name = extractName(infoXml) || result.name || `SoundTouch ${address}`;
        this.log(`Accepted SoundTouch speaker: name="${name}" id="${id}" address="${address}" info="${this.previewXml(infoXml)}"`);

        speakers.push({
          name,
          data: { id },
          icon: RADIO_DEVICE_ICON,
          store: {
            address,
            discoveryId: result.id,
            icon: RADIO_DEVICE_ICON,
          },
          settings: {
            ip_address: address,
          },
        });
      } catch (error) {
        this.log(`Ignoring ${address}; /info failed: ${error.message}`);
      }
    }

    return speakers;
  }

  formatDiscoveryResult(result) {
    const parts = [
      `id="${result.id || ""}"`,
      `name="${result.name || ""}"`,
      `address="${result.address || ""}"`,
      `port="${result.port || ""}"`,
    ];

    if (result.txt) {
      parts.push(`txt=${JSON.stringify(result.txt)}`);
    }

    return parts.join(" ");
  }

  previewXml(xml) {
    return String(xml || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, INFO_PREVIEW_LENGTH);
  }

  async triggerPresetPressed(device, tokens) {
    await this.presetPressedTrigger.trigger(device, tokens, {});
  }

  getPresetSettings(device) {
    const settings = device.getSettings();
    const presets = [];
    for (let preset = 1; preset <= 6; preset += 1) {
      presets.push({
        preset,
        name: String(settings[`preset${preset}_name`] || `Preset ${preset}`),
        url: String(settings[`preset${preset}_url`] || ""),
      });
    }
    return { presets };
  }
}

module.exports = SoundTouchDriver;
