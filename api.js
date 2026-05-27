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

async function getDiagnostics({ homey, body }) {
  return homey.app.getDeviceDiagnostics(body || {});
}

async function setDebugLogging({ homey, body }) {
  return homey.app.setDebugLogging(body || {});
}

module.exports = {
  getPresetDevices,
  searchStations,
  savePreset,
  updatePreset,
  getDiagnostics,
  setDebugLogging,
};
