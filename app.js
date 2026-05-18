"use strict";

const Homey = require("homey");
const {
  countStationClick,
  searchCompatibleStations,
} = require("./lib/radio-browser-client");
const {
  validateStreamUrl,
} = require("./lib/soundtouch-client");

class SoundTouchBridgeApp extends Homey.App {
  async onInit() {
    this.log("SoundTouch Bridge initialized");
  }

  async getSoundTouchDriver() {
    return this.homey.drivers.getDriver("soundtouch");
  }

  async getPresetDevices() {
    const driver = await this.getSoundTouchDriver();
    const devices = await driver.getDevices();
    return devices.map((device) => ({
      id: String(device.getData().id || ""),
      name: device.getName(),
      presets: this.getDevicePresetSettings(device),
    }));
  }

  getDevicePresetSettings(device) {
    const settings = device.getSettings();
    const presets = [];
    for (let preset = 1; preset <= 6; preset += 1) {
      presets.push({
        preset,
        name: String(settings[`preset${preset}_name`] || `Preset ${preset}`),
        url: String(settings[`preset${preset}_url`] || ""),
      });
    }
    return presets;
  }

  async searchStations(criteria) {
    return searchCompatibleStations(criteria || {});
  }

  async savePreset({ deviceId, preset, station }) {
    const presetNumber = Number(preset);
    if (!Number.isInteger(presetNumber) || presetNumber < 1 || presetNumber > 6) {
      throw new Error("Choose a preset from 1 to 6.");
    }

    const device = await this.getPresetDevice(deviceId);

    const name = String(station && station.name || "").trim();
    const streamUrl = String(station && station.streamUrl || "").trim();
    if (!name || !streamUrl) {
      throw new Error("Choose a radio station.");
    }
    validateStreamUrl(streamUrl);

    await device.setSettings({
      [`preset${presetNumber}_name`]: name,
      [`preset${presetNumber}_url`]: streamUrl,
    });

    if (typeof device.setStoreValue === "function") {
      await device.setStoreValue(`preset${presetNumber}_station_uuid`, station.stationuuid || "");
    }
    await this.syncPresetDeviceUi(device);

    countStationClick(station.stationuuid).catch((error) => {
      this.log(`Could not count Radio Browser station click: ${error.message}`);
    });

    return {
      deviceId: String(device.getData().id || ""),
      presets: this.getDevicePresetSettings(device),
    };
  }

  async updatePreset({ deviceId, preset, name, streamUrl }) {
    const presetNumber = Number(preset);
    if (!Number.isInteger(presetNumber) || presetNumber < 1 || presetNumber > 6) {
      throw new Error("Choose a preset from 1 to 6.");
    }

    const device = await this.getPresetDevice(deviceId);
    const nextName = String(name || "").trim();
    const nextUrl = String(streamUrl || "").trim();
    if (!nextName) {
      throw new Error("Enter a preset name.");
    }
    validateStreamUrl(nextUrl);

    await device.setSettings({
      [`preset${presetNumber}_name`]: nextName,
      [`preset${presetNumber}_url`]: nextUrl,
    });
    await this.syncPresetDeviceUi(device);

    return {
      deviceId: String(device.getData().id || ""),
      presets: this.getDevicePresetSettings(device),
    };
  }

  async getPresetDevice(deviceId) {
    const driver = await this.getSoundTouchDriver();
    const devices = await driver.getDevices();
    const device = devices.find((candidate) => (
      String(candidate.getData().id || "") === String(deviceId || "")
    ));
    if (!device) {
      throw new Error("Choose a SoundTouch speaker.");
    }
    return device;
  }

  async syncPresetDeviceUi(device) {
    if (typeof device.syncPresetSettingsUi === "function") {
      await device.syncPresetSettingsUi();
    }
    if (typeof device.syncPresetButtonTitles === "function") {
      await device.syncPresetButtonTitles();
    }
  }
}

module.exports = SoundTouchBridgeApp;
