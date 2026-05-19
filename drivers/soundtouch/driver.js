"use strict";

const Homey = require("homey");
const {
  extractDeviceId,
  extractName,
  getInfo,
} = require("../../lib/soundtouch-client");

const RADIO_DEVICE_ICON = "/icon.svg";
const INFO_PREVIEW_LENGTH = 180;

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
  }

  async onPairListDevices() {
    this.log("Pairing requested: listing SoundTouch speakers");

    try {
      const discovered = await this.getDiscoveredSpeakers();
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
        const infoXml = await getInfo(address);
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
