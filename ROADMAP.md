# Roadmap

## Goal

Build a publishable Homey Pro app that bridges Bose SoundTouch physical preset
button presses to user-configured webstream URLs, using local network APIs only.

## Milestone 1: Proof Of Integration

- Scaffold a Homey SDK v3 app.
- Add one SoundTouch speaker driver.
- Pair speakers via mDNS-SD discovery, with manual IP fallback.
- Connect to the speaker WebSocket at `ws://<ip>:8080` using subprotocol
  `gabbo`.
- Log all incoming WebSocket events.
- Capture event payloads for preset buttons 1 through 6.
- Add a developer setting or log output that makes event debugging practical.

Exit criteria:

- Homey can pair `Office HQ`.
- The app logs a distinct event when a physical preset button is pressed.
- The app reconnects after speaker reboot or app restart.

## Milestone 2: One Preset Playback

- Add a per-device setting for preset 1 URL and display name.
- Parse the preset 1 WebSocket event.
- Send UPnP `SetAVTransportURI` and `Play` to port `8091`.
- Poll `/now_playing` on port `8090` until `PLAY_STATE` or timeout.
- Surface device unavailable state if UPnP times out.

Exit criteria:

- Pressing physical preset 1 starts the configured stream.
- Homey remains the only always-on bridge.
- The Bose speaker fetches the stream directly.

## Milestone 3: Six Preset Slots

- Add settings for preset slots 1 through 6.
- Add optional names for each slot.
- Add debounce so one physical press does not trigger repeated playback starts.
- Add a flow trigger: preset button pressed.
- Add a flow action: play configured preset slot.
- Add a flow action: play custom URL.

Exit criteria:

- All six physical preset buttons can be mapped.
- Users can also trigger those mapped presets from Homey flows.

## Milestone 4: Robustness

- Handle speaker IP changes through Homey discovery callbacks.
- Detect and report wedged UPnP service separately from offline speaker.
- Avoid using native Bose `source="UPNP"` presets.
- Add diagnostics for WebSocket reconnects and UPnP failures.
- Add a documented recovery path for users who already stored broken UPNP
  presets.

Exit criteria:

- Speaker reboot and Homey app restart recover automatically.
- Failure messages are actionable.

## Milestone 5: Store Readiness

- Add app icons and driver assets.
- Add translations for app and settings copy.
- Add privacy policy text: local-only, no cloud account, no telemetry unless
  explicitly added later.
- Review naming and trademark wording.
- Prepare Homey App Store checklist.

Exit criteria:

- App can be submitted or shared as a beta with clear limitations.

## Open Questions

- Exact WebSocket payloads for all physical preset buttons.
- Whether Homey Pro can keep the Bose WebSocket stable long-term.
- Whether preset button events fire when the native preset slot is empty,
  broken, or removed.
- Whether a safe native placeholder preset is needed for buttons to emit events.
- Whether Homey App Store review accepts this category and naming.

## Information Needed

- Homey Pro model/software version.
- Confirmation that developer app installation works on the office Homey.
- WebSocket event payloads from pressing each preset button.
- First speaker list and desired preset mapping.
- Decision: private/internal beta first, or publishable structure from day one.
