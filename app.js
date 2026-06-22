"use strict";

const Homey = require("homey");
const {
  countStationClick,
  searchCompatibleStations,
  searchRandomCompatibleStations,
} = require("./lib/radio-browser-client");
const {
  validateStreamUrl,
} = require("./lib/soundtouch-client");

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeCountryCode(value) {
  return normalizeString(value).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
}

function getRandomPresetLabel({ tag, countrycode, name }) {
  const configuredName = normalizeString(name);
  if (configuredName) {
    return configuredName;
  }

  const normalizedTag = normalizeString(tag);
  const normalizedCountry = normalizeCountryCode(countrycode);
  const labelTag = normalizedTag
    ? normalizedTag.charAt(0).toUpperCase() + normalizedTag.slice(1)
    : "Radio";
  return normalizedCountry ? `Random ${labelTag} (${normalizedCountry})` : `Random ${labelTag}`;
}

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
    const store = typeof device.getStore === "function" ? device.getStore() || {} : {};
    const presets = [];
    for (let preset = 1; preset <= 6; preset += 1) {
      const mode = normalizeString(settings[`preset${preset}_mode`]) === "random" ? "random" : "fixed";
      const name = normalizeString(settings[`preset${preset}_name`]) || `Preset ${preset}`;
      const randomCountryEnabled = settings[`preset${preset}_random_country_enabled`] === true
        || settings[`preset${preset}_random_country_enabled`] === "true";
      presets.push({
        preset,
        mode,
        name,
        label: mode === "random" ? getRandomPresetLabel({
          tag: settings[`preset${preset}_random_tag`],
          countrycode: randomCountryEnabled ? settings[`preset${preset}_random_countrycode`] : "",
          name,
        }) : name,
        url: normalizeString(settings[`preset${preset}_url`]),
        random: {
          tag: normalizeString(settings[`preset${preset}_random_tag`]),
          countryEnabled: randomCountryEnabled,
          countrycode: normalizeCountryCode(settings[`preset${preset}_random_countrycode`]),
          matchCount: Number(settings[`preset${preset}_random_match_count`]) || 0,
        },
        lastStation: {
          name: normalizeString(store[`preset${preset}_last_station_name`]),
          url: normalizeString(store[`preset${preset}_last_station_url`]),
          stationuuid: normalizeString(store[`preset${preset}_last_station_uuid`]),
        },
      });
    }
    return presets;
  }

  async searchStations(criteria) {
    return searchCompatibleStations(criteria || {});
  }

  async testRandomPreset(criteria) {
    const rule = this.normalizeRandomRule(criteria || {});
    const response = await searchRandomCompatibleStations(rule);
    return {
      source: response.source,
      matchCount: response.results.length,
      results: response.results.slice(0, 5),
    };
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
      [`preset${presetNumber}_mode`]: "fixed",
      [`preset${presetNumber}_name`]: name,
      [`preset${presetNumber}_url`]: streamUrl,
      [`preset${presetNumber}_random_tag`]: "",
      [`preset${presetNumber}_random_country_enabled`]: false,
      [`preset${presetNumber}_random_countrycode`]: "",
      [`preset${presetNumber}_random_match_count`]: 0,
    });

    if (typeof device.setStoreValue === "function") {
      await device.setStoreValue(`preset${presetNumber}_station_uuid`, station.stationuuid || "");
    }
    await this.clearRandomPresetStore(device, presetNumber);
    await this.syncPresetDeviceUi(device);

    countStationClick(station.stationuuid).catch((error) => {
      this.log(`Could not count Radio Browser station click: ${error.message}`);
    });

    return {
      deviceId: String(device.getData().id || ""),
      presets: this.getDevicePresetSettings(device),
    };
  }

  async updatePreset(payload) {
    const { deviceId, preset, name, streamUrl } = payload || {};
    const presetNumber = Number(preset);
    if (!Number.isInteger(presetNumber) || presetNumber < 1 || presetNumber > 6) {
      throw new Error("Choose a preset from 1 to 6.");
    }

    const device = await this.getPresetDevice(deviceId);
    const mode = normalizeString(payload && payload.mode) === "random" ? "random" : "fixed";
    const nextName = normalizeString(name);
    const nextUrl = normalizeString(streamUrl);
    const currentSettings = device.getSettings();
    if (!nextName) {
      throw new Error("Enter a preset name.");
    }

    if (mode === "random") {
      const rule = this.normalizeRandomRule(payload || {});
      const randomRuleChanged = normalizeString(currentSettings[`preset${presetNumber}_mode`]) !== "random"
        || normalizeString(currentSettings[`preset${presetNumber}_random_tag`]) !== rule.tag
        || (currentSettings[`preset${presetNumber}_random_country_enabled`] === true
          || currentSettings[`preset${presetNumber}_random_country_enabled`] === "true") !== rule.countryEnabled
        || normalizeCountryCode(currentSettings[`preset${presetNumber}_random_countrycode`]) !== rule.countrycode;
      const test = await this.testRandomPreset(rule);
      if (test.matchCount < 1) {
        throw new Error("No compatible stations match this random preset rule.");
      }

      await device.setSettings({
        [`preset${presetNumber}_mode`]: "random",
        [`preset${presetNumber}_name`]: getRandomPresetLabel({ ...rule, name: nextName }),
        [`preset${presetNumber}_url`]: "",
        [`preset${presetNumber}_random_tag`]: rule.tag,
        [`preset${presetNumber}_random_country_enabled`]: rule.countryEnabled,
        [`preset${presetNumber}_random_countrycode`]: rule.countryEnabled ? rule.countrycode : "",
        [`preset${presetNumber}_random_match_count`]: test.matchCount,
      });
      if (randomRuleChanged) {
        await this.clearRandomPresetStore(device, presetNumber);
      }
    } else {
      validateStreamUrl(nextUrl);

      await device.setSettings({
        [`preset${presetNumber}_mode`]: "fixed",
        [`preset${presetNumber}_name`]: nextName,
        [`preset${presetNumber}_url`]: nextUrl,
        [`preset${presetNumber}_random_tag`]: "",
        [`preset${presetNumber}_random_country_enabled`]: false,
        [`preset${presetNumber}_random_countrycode`]: "",
        [`preset${presetNumber}_random_match_count`]: 0,
      });
      await this.clearRandomPresetStore(device, presetNumber);
    }
    await this.syncPresetDeviceUi(device);

    return {
      deviceId: String(device.getData().id || ""),
      presets: this.getDevicePresetSettings(device),
    };
  }

  async clearRandomPresetStore(device, presetNumber) {
    if (typeof device.setStoreValue !== "function") {
      return;
    }
    await device.setStoreValue(`preset${presetNumber}_last_station_name`, "");
    await device.setStoreValue(`preset${presetNumber}_last_station_url`, "");
    await device.setStoreValue(`preset${presetNumber}_last_station_uuid`, "");
  }

  normalizeRandomRule(criteria) {
    const tag = normalizeString(criteria.tag);
    const countryEnabled = criteria.countryEnabled === true || criteria.country_enabled === true
      || criteria.countryEnabled === "true" || criteria.country_enabled === "true";
    const countrycode = normalizeCountryCode(criteria.countrycode);
    if (!tag) {
      throw new Error("Enter a tag or genre for the random preset.");
    }
    if (countryEnabled && countrycode.length !== 2) {
      throw new Error("Enter a two-letter country code, or turn off country filtering.");
    }
    return {
      tag,
      countryEnabled,
      countrycode: countryEnabled ? countrycode : "",
    };
  }

  async getDeviceDiagnostics({ deviceId }) {
    const device = await this.getPresetDevice(deviceId);
    const settings = device.getSettings();
    const store = typeof device.getStore === "function" ? device.getStore() || {} : {};

    function readSetting(key, fallback) {
      const value = settings[key];
      const text = String(value == null ? "" : value).trim();
      return text || fallback;
    }

    function readDiagnostic(key, fallback) {
      const value = store[`diag_${key}`];
      const text = String(value == null ? "" : value).trim();
      return text || fallback;
    }

    return {
      deviceId: String(device.getData().id || ""),
      name: device.getName(),
      debugEnabled: store.debug_enabled === true,
      fields: [
        { label: "Status", value: readDiagnostic("speaker_status", "Unknown") },
        { label: "Active preset", value: readDiagnostic("active_preset", "None") },
        { label: "IP address", value: readSetting("ip_address", "Unknown") },
        { label: "WebSocket", value: readDiagnostic("websocket_status", "Unknown") },
        { label: "Last WebSocket activity", value: readDiagnostic("last_websocket_activity", "None") },
        { label: "Last preset event", value: readDiagnostic("last_preset_event", "None") },
        { label: "Last playback source", value: readDiagnostic("last_playback_source", "None") },
        { label: "Last playback trace", value: readDiagnostic("last_playback_trace", "None") },
        { label: "Last UPnP phase", value: readDiagnostic("last_upnp_phase", "None") },
        { label: "Last playback verification", value: readDiagnostic("last_playback_verification", "None") },
        { label: "Last now playing", value: readDiagnostic("last_now_playing", "None") },
        { label: "Native preset sync", value: readDiagnostic("native_preset_sync", "Not synced yet") },
        { label: "Last random station", value: readDiagnostic("last_random_station", "None") },
        { label: "Last action", value: readDiagnostic("last_action", "None") },
        { label: "Last playback error", value: readDiagnostic("last_playback_error", "None") },
        { label: "Last WebSocket event", value: readDiagnostic("last_event", "None") },
      ],
    };
  }

  async setDebugLogging({ deviceId, enabled }) {
    const device = await this.getPresetDevice(deviceId);
    const value = enabled === true;
    if (typeof device.setStoreValue === "function") {
      await device.setStoreValue("debug_enabled", value);
    }
    return {
      deviceId: String(device.getData().id || ""),
      debugEnabled: value,
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
    if (typeof device.syncNativePresetNames === "function") {
      await device.syncNativePresetNames();
    }
  }
}

module.exports = SoundTouchBridgeApp;
