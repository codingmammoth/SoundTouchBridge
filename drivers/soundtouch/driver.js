"use strict";

const Homey = require("homey");
const {
  extractDeviceId,
  extractName,
  getInfo,
} = require("../../lib/soundtouch-client");

const RADIO_DEVICE_ICONS = [
  "/icons/radio-dial.svg",
  "/icons/radio-wave.svg",
  "/icons/radio-boombox.svg",
  "/icons/radio-tower.svg",
];

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
    const discovered = await this.getDiscoveredSpeakers();
    if (discovered.length > 0) {
      return discovered;
    }

    this.log("No SoundTouch speakers found through Homey discovery yet.");
    return [];
  }

  async getDiscoveredSpeakers() {
    const strategy = this.getDiscoveryStrategy();
    const results = Object.values(strategy.getDiscoveryResults());
    const speakers = [];

    for (const result of results) {
      const address = result.address;
      if (!address) {
        continue;
      }

      try {
        const infoXml = await getInfo(address);
        const id = extractDeviceId(infoXml) || result.id || address;
        const name = extractName(infoXml) || result.name || `SoundTouch ${address}`;
        const icon = this.getRadioDeviceIcon(id);

        speakers.push({
          name,
          data: { id },
          icon,
          store: {
            address,
            discoveryId: result.id,
            icon,
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

  getRadioDeviceIcon(id) {
    const text = String(id || "");
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
    }
    return RADIO_DEVICE_ICONS[hash % RADIO_DEVICE_ICONS.length];
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
