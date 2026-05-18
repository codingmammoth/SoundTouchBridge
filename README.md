# HomeyBose

HomeyBose is planned as a Homey Pro app that revives useful physical preset
buttons on Bose SoundTouch speakers after Bose's SoundTouch cloud shutdown.

The intended approach is local-only:

1. Discover Bose SoundTouch speakers on the LAN.
2. Keep a WebSocket connection to each paired speaker.
3. Detect physical preset button presses.
4. Map preset slots to user-configured stream URLs.
5. Start playback with UPnP AVTransport.

The app should not require Home Assistant, a computer, or a phone to stay
online. Homey Pro acts as the always-on local bridge.

## Current Status

Planning and first implementation.

Validated manually against a Bose SoundTouch 20:

- SoundTouch Web API is reachable on port `8090`.
- SoundTouch advertises `_soundtouch._tcp` over Bonjour/mDNS.
- UPnP MediaRenderer is reachable on port `8091`.
- UPnP `SetAVTransportURI` + `Play` can start a remote MP3 stream.
- Storing a `source="UPNP"` item as a native Bose preset is unsafe: recalling
  that preset can wedge the speaker's UPnP service until reboot.

## Architecture

```text
Bose physical preset button
        |
        v
Bose WebSocket event on ws://<speaker-ip>:8080
        |
        v
HomeyBose app on Homey Pro
        |
        v
UPnP SetAVTransportURI + Play on http://<speaker-ip>:8091/AVTransport/Control
        |
        v
Bose speaker fetches the stream directly
```

Homey must stay online. The computer or phone that configured the app does not.

## Discovery

The preferred pairing flow is automatic discovery. Homey Apps SDK supports LAN
discovery on local Homey / Homey Pro apps using mDNS-SD and SSDP. SoundTouch
speakers have been observed advertising:

```text
_soundtouch._tcp
```

Manual IP entry should be kept as a fallback for networks where multicast
discovery is blocked.

## Initial Scope

Version 0.1 should support:

- one or more paired Bose SoundTouch speakers
- automatic discovery during pairing
- manual IP fallback
- six configured preset URLs per speaker
- WebSocket logging of preset button events
- playback via UPnP AVTransport
- Homey device controls for power, stop, volume, and preset buttons
- useful speaker metadata in device settings: active preset and compact status
- reconnect logic for WebSocket disconnects
- clear unavailable state when the speaker or UPnP service is unreachable

The current implementation already exposes six preset slots in device settings.
The remaining validation step is to capture the exact WebSocket payload emitted
by each physical preset button on real speakers.

Default preset slots are seeded with direct plain-HTTP streams:

1. One World Radio
2. BBC World Service
3. Radio Paradise
4. FIP
5. Radio SRF 3
6. KEXP

## Developer Test Flow

Install dependencies:

```bash
npm install
```

Log in to Homey CLI if needed:

```bash
npx homey login
```

Validate locally:

```bash
npm test
npx homey app validate
```

Run on a Homey Pro in developer mode:

```bash
npx homey app run
```

Then:

1. Open the Homey app.
2. Add a new device from "SoundTouch Bridge".
3. Select a discovered SoundTouch speaker.
4. Keep the Homey CLI logs open.
5. Press physical preset buttons on the speaker.
6. Enable debug logging and check "Last WebSocket event" only when
   troubleshooting event payloads.
7. Configure stream URLs for preset slots 1 through 6 in device settings.
8. Create a Flow action for the paired speaker: "Play stream" or
   "Play configured preset".

The first development goal is to capture the exact WebSocket payload emitted by
the speaker when each physical preset button is pressed.

## Current Prototype Behavior

The current app prototype:

- discovers speakers with Homey's mDNS-SD discovery strategy for
  `_soundtouch._tcp`
- verifies each discovered IP with `/info` on port `8090`
- pairs the selected speaker as a Homey device
- connects to `ws://<speaker-ip>:8080` using subprotocol `gabbo`
- logs and stores raw WebSocket events only while debug logging is enabled
- stores active preset and compact connection/source metadata in device settings
- triggers a Homey Flow card when a preset event is detected
- maps physical preset 1 through 6 to configured stream URLs
- updates dashboard preset button titles from the configured preset names and
  marks the active preset as playing
- provides a Flow action to play a configured preset slot
- provides a Flow action to play any stream URL through UPnP
- exposes Homey device controls:
  - preset 1 through 6 buttons with preset icons
  - stop button with a stop icon
  - on/off toggle
  - volume slider

The preset parser is intentionally broad until we capture real events from more
speakers. It looks for common forms such as `PRESET_1`, `preset1`, and
`<preset id="1">`.

## Non-Goals For The First Version

- replacing the Bose cloud
- editing firmware or SSH configuration on speakers
- storing `source="UPNP"` as native Bose presets
- depending on Home Assistant
- depending on a desktop computer

## Legal / Publishing Notes

This app should avoid Bose trademarks in the app name unless required for
compatibility description. Use wording such as "for Bose SoundTouch" where
allowed, and make clear that the project is unofficial and not affiliated with
Bose.
