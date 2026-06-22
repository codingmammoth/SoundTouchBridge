# SoundTouch Bridge

SoundTouch Bridge is a Homey Pro app that revives useful physical preset
buttons on Bose SoundTouch speakers after Bose's SoundTouch cloud shutdown.

The app is available for free in the Homey App Store:
https://homey.app/a/com.codingmammoth.soundtouchbridge/

The intended approach is local-only:

1. Discover Bose SoundTouch speakers on the LAN.
2. Keep a WebSocket connection to each paired speaker.
3. Detect physical preset button presses.
4. Map preset slots to user-configured stream URLs.
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

## Initial Scope

Version 0.1 supports:

- one or more paired Bose SoundTouch speakers
- automatic discovery during pairing
- six configured preset URLs per speaker
- direct `http://` stream URL validation for presets and Flow playback
- WebSocket logging of preset button events
- playback via UPnP AVTransport
- native SoundTouch preset label sync for the six configured slots
- Homey device controls for power, stop, volume, and preset buttons
- useful speaker metadata in device settings: active preset and compact status
- reconnect logic for WebSocket disconnects
- clear unavailable state when the speaker or UPnP service is unreachable

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
6. Enable debug logging and check "Last WebSocket event" only when
   troubleshooting event payloads.
7. Open the SoundTouch Bridge app settings to assign, edit, reassign, or remove
   radio stations for each preset slot. Speaker settings show a read-only preset
   overview for the selected device.
8. Create a Flow action for the paired speaker: "Play stream" or
   "Play configured preset".

Radio station search uses the public Radio Browser API. No API key is needed.
The app filters search results to currently working, non-HLS MP3/AAC stations
and saves only direct plain-HTTP stream URLs that pass a quick compatibility
probe. Manual URL settings remain available for advanced use.

## Publishing a Homey Release

Use the normal ticket/branch/PR workflow for release preparation too. Version
bumps, release notes, and publishing fixes should be traceable to a GitHub
issue and reviewed through a pull request before the final publish.

Before publishing:

1. Start from a clean, up-to-date `main`.

   ```bash
   git switch main
   git pull --ff-only
   ```

2. Create an issue branch for the release work.

   ```bash
   git switch -c codex/<issue-number>-release-<version>
   ```

3. Update the Homey app version. Use a semver value such as `1.0.0`, or
   `patch`, `minor`, or `major`.

   ```bash
   npx homey app version 1.0.0
   ```

   Do not use `--commit` during the normal PR workflow; keep the generated
   changes visible in the pull request. The command updates the Homey app
   metadata and version files that Homey expects for publishing.

4. Add App Store release notes. The Homey CLI supports localized changelog
   text when bumping the version:

   ```bash
   npx homey app version 1.0.0 --changelog.en "Improve SoundTouch reconnect reliability and diagnostics."
   ```

   If you already bumped the version without release notes, add the changelog in
   Homey Developer Tools during submission or rerun the version step only when
   it is safe to update the same release metadata.

5. Run the local checks.

   ```bash
   npm test
   npx homey app validate
   ```

6. Build the app package that will be submitted to Homey.

   ```bash
   npx homey app build
   ```

   This also refreshes generated Homey output. If you edited compose files,
   make sure the generated `app.json` stays in sync and include it in the PR.

7. Open a pull request against `main` with:

   - the version bump
   - release notes/changelog text
   - validation output
   - any manual Homey/speaker test notes

8. After the PR is merged and `main` is clean, publish from `main`.

   ```bash
   git switch main
   git pull --ff-only
   npx homey app validate
   npx homey app build
   npx homey app publish
   ```

9. After publishing, confirm the submitted version in Homey Developer Tools and
   keep the related GitHub issue updated. Only close the release issue after the
   submission is accepted or the remaining follow-up is tracked elsewhere.

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
- syncs native SoundTouch preset names through `/storePreset` so the speaker
  display matches the configured Homey preset name
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
