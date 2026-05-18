"use strict";

const Homey = require("homey");

class SoundTouchBridgeApp extends Homey.App {
  async onInit() {
    this.log("SoundTouch Bridge initialized");
  }
}

module.exports = SoundTouchBridgeApp;
