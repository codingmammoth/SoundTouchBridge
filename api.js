"use strict";

async function getPresetDevices({ homey }) {
  return homey.app.getPresetDevices();
}

async function searchStations({ homey, body }) {
  return homey.app.searchStations(body || {});
}

async function savePreset({ homey, body }) {
  return homey.app.savePreset(body || {});
}

async function updatePreset({ homey, body }) {
  return homey.app.updatePreset(body || {});
}

module.exports = {
  getPresetDevices,
  searchStations,
  savePreset,
  updatePreset,
};
