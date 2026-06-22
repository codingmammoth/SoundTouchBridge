# SoundTouch Bridge

SoundTouch Bridge is a Homey Pro app that revives useful physical preset
buttons on Bose SoundTouch speakers after Bose's SoundTouch cloud shutdown.

The app is available for free in the Homey App Store:
https://homey.app/a/com.codingmammoth.soundtouchbridge/

The intended approach is local-only:

1. Discover Bose SoundTouch speakers on the LAN.
2. Keep a WebSocket connection to each paired speaker.
3. Detect physical preset button presses.
4. Map preset slots to user-configured fixed streams or random radio rules.
5. Start playback with UPnP AVTransport.

The app should not require Home Assistant, a computer, or a phone to stay
online. Homey Pro acts as the always-on local bridge.

## Current Status

Published as a free Homey app:
https://homey.app/a/com.codingmammoth.soundtouchbridge/

For normal use, install it from the Homey App Store, add a SoundTouch Bridge
device, and select a discovered Bose SoundTouch speaker. The developer flow
below is only needed when testing local changes from this repository.

Validated manually against a Bose SoundTouch 20:

- SoundTouch Web API is reachable on port `8090`.
- SoundTouch advertises `_soundtouch._tcp` over Bonjour/mDNS.
- UPnP MediaRenderer is reachable on port `8091`.
- UPnP `SetAVTransportURI` + `Play` can start a remote MP3 stream.
- Storing a `source="UPNP"` item as a native Bose preset is unsafe: recalling
  that preset can wedge the speaker's UPnP service until reboot.
- Native SoundTouch preset labels can be synced safely through
  `POST /storePreset` using `LOCAL_INTERNET_RADIO` descriptor URLs, so the
  speaker display shows the configured Homey preset name immediately when a
  physical preset button is pressed.

## Architecture

```text
Bose physical preset button
        |
        v
Bose WebSocket event on ws://<speaker-ip>:8080
        |
        v
SoundTouch Bridge app on Homey Pro
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

## Current Features

- one or more paired Bose SoundTouch speakers
- automatic discovery during pairing
- six configurable preset slots per speaker
- fixed radio presets using direct stream URLs
- random radio presets using a required tag/genre and optional country filter
- test-before-save random preset matching
- direct `http://` stream URL validation for presets and Flow playback
- WebSocket event handling for physical preset button presses
- heartbeat-based WebSocket reconnect handling after speaker reboot or network
  changes
- playback via UPnP AVTransport
- native SoundTouch preset label sync for the six configured slots
- Homey device controls for power, stop, volume, and preset buttons
- useful App Settings diagnostics for WebSocket, preset, playback, UPnP, and
  now-playing state
- clear warning/unavailable state when the speaker, WebSocket, or UPnP playback
  path is unreachable

Manual IP fallback and repair/remap flows are planned follow-ups for networks
where multicast discovery is blocked or speaker IPs change.

Preset URLs should be direct `http://` MP3 or AAC streams. HTTPS, web player,
and playlist URLs are not supported reliably by older SoundTouch playback, so
the app rejects non-HTTP stream URLs when saving preset settings or running the
generic stream Flow action.

To verify protocol support on a real speaker, run:

```bash
npm run test:stream-protocol -- --host 192.168.2.129 --yes
```

This starts playback on the speaker and compares an HTTP MP3, an HTTPS MP3, and
an HTTPS HLS URL through the same UPnP path used by the app. The HTTP/HTTPS MP3
comparison uses the same One World Radio stream host and path:
`25503.live.streamtheworld.com/OWR_INTERNATIONAL.mp3`.

Default preset slots are seeded with direct plain-HTTP streams:

1. One World Radio
2. BBC World Service
3. Radio Paradise
4. FIP
5. Dance UK
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

Install on a Homey Pro without keeping the debugger attached:

```bash
npx homey app install
```

The manifest intentionally omits an explicit `runtime: "nodejs"` field so older
Homey Pro firmware can treat the app as a regular SDK v3 JavaScript app. Some
older local Homey runtimes reject newer runtime declarations with
`incompatible_app_runtime_nodejs`.

Then:

1. Open the Homey app.
2. Add a new device from "SoundTouch Bridge".
3. Select a discovered SoundTouch speaker.
4. Keep the Homey CLI logs open.
5. Press physical preset buttons on the speaker.
6. Open SoundTouch Bridge app settings and use the debug modal to inspect
   WebSocket, preset, playback, UPnP, verification, and now-playing diagnostics.
7. Enable debug logging and check "Last WebSocket event" only when
   troubleshooting raw event payloads.
8. Open SoundTouch Bridge app settings to assign, edit, reassign, or remove
   fixed radio presets or random radio presets for each preset slot. Speaker
   settings show a read-only preset overview for the selected device.
9. Create a Flow action for the paired speaker: "Play stream" or
   "Play configured preset".

Radio station search uses the public Radio Browser API. No API key is needed.
The app filters search results to currently working, non-HLS MP3/AAC stations
and saves only direct plain-HTTP stream URLs that pass a quick compatibility
probe. Manual URL settings remain available for advanced use.

Random radio presets use a required tag/genre and optional country filter. The
rule must be tested before saving, and every preset press searches for a
compatible station, avoids immediate repeats where possible, and falls back to
the last successful station only when needed.

## Publishing a Homey Release

Use the normal ticket/branch/PR workflow for release preparation too. Code,
asset, documentation, and publishing fixes should be traceable to a GitHub
issue and reviewed through a pull request before the final publish.

Before publishing:

1. Start from a clean, up-to-date `main`.

   ```bash
   git switch main
   git pull --ff-only
   ```

2. If the release needs code, asset, or documentation changes, create an issue
   branch, make the changes, run checks, and merge the pull request first.

   ```bash
   git switch -c codex/<issue-number>-short-description
   ```

3. Run the local checks from the release branch or final `main`.

   ```bash
   npm test
   npx homey app validate
   ```

4. After the PR is merged and `main` is clean, publish from `main`.

   ```bash
   git switch main
   git pull --ff-only
   npx homey app publish
   ```

   The Homey CLI asks whether to update the app version, lets you choose the
   next patch/minor/major version, asks for the release note/changelog when it
   is missing, validates the app, uploads a build, and prints the Homey
   Developer Tools URL for that build.

5. If the CLI changed the version or changelog and asks to commit those files,
   commit them and push the release commit and tag so GitHub matches the
   submitted build.

   ```bash
   git push
   git push --tags
   ```

6. In Homey Developer Tools, open the uploaded build, publish it as a Test
   version, install and verify the Test version, then submit it for
   certification when it is ready.

7. Keep the related GitHub issue updated. Only close the release issue after
   the submission is accepted or the remaining follow-up is tracked elsewhere.

## Current Runtime Behavior

The current app:

- discovers speakers with Homey's mDNS-SD discovery strategy for
  `_soundtouch._tcp`
- verifies each discovered IP with `/info` on port `8090`
- pairs the selected speaker as a Homey device
- connects to `ws://<speaker-ip>:8080` using subprotocol `gabbo`
- monitors the WebSocket with a heartbeat watchdog and reconnects after stale
  or failed connections
- logs and stores raw WebSocket events only while debug logging is enabled
- stores active preset and compact connection/source metadata
- stores structured App Settings diagnostics for the last preset event, playback
  source, playback trace, UPnP phase, verification result, now-playing payload,
  and playback error
- syncs native SoundTouch preset names through `/storePreset` so the speaker
  display matches the configured Homey preset name
- triggers a Homey Flow card when a preset event is detected
- maps physical preset 1 through 6 to configured fixed streams or random radio
  rules
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

## Non-Goals

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
