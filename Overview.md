# SoundTouch Bridge Overview

SoundTouch Bridge is a Homey Pro app for locally controlling Bose SoundTouch speakers
with internet radio presets. It keeps the experience local: Homey discovers the
speaker on the LAN, listens for preset button events, and starts playback
directly on the speaker.

## Core Features

- Pair one or more Bose SoundTouch speakers on the local network.
- Discover speakers automatically through mDNS-SD (`_soundtouch._tcp`).
- Store the speaker IP address for local control.
- Keep a SoundTouch WebSocket connection open for speaker events.
- Detect physical preset button presses.
- Map preset slots 1 through 6 to configured radio streams.
- Start playback through UPnP AVTransport.
- Keep working without Home Assistant, a computer, or a phone online.

## Preset Management

Preset management lives in the SoundTouch Bridge app settings.

From App Settings users can:

- select a paired speaker
- see all six preset slots
- assign a radio station to an empty preset
- edit an existing preset
- search the public Radio Browser directory
- select a search result and save it
- manually enter a preset name and direct stream URL

Search results show a clear selected state with a checkmark. Selecting a station
prefills the editable name and stream URL fields. Editing those fields clears
the selected search result, making the manual override explicit.

Device Settings are intentionally lightweight. They show:

- a note pointing users to App Settings for preset management
- a read-only overview of preset names
- speaker IP address
- active preset
- compact speaker status
- diagnostics controls

## Radio Browser Integration

The app uses the public Radio Browser API. No API key is required.

Search supports station name, country code, and tag. Results are filtered for
SoundTouch compatibility:

- station must be marked as working
- HLS streams are excluded
- codec must be MP3, AAC, or AAC+
- candidate stream must be plain `http://`
- candidate stream must pass a short HTTP audio probe

The app counts successful station selections with Radio Browser's click API
when a station UUID is available.

## Stream Compatibility

The app only accepts direct `http://` audio streams.

Unsupported or unreliable formats include:

- `https://` streams
- HLS streams
- web player pages
- playlist URLs

This restriction is intentional. Older SoundTouch speakers are unreliable with
HTTPS and playlist playback through the tested UPnP path.

## Homey Device Controls

Each paired speaker exposes:

- preset 1 through 6 buttons
- stop button
- on/off toggle
- volume slider

Preset buttons are getable boolean controls. The currently active preset stays
selected in Homey, and selecting another preset clears the previous selection.

## Flow Support

The app provides:

- Trigger: a preset button was pressed
- Action: play a configured preset
- Action: play a direct stream URL

## Default Presets

New devices are seeded with direct plain-HTTP streams:

1. One World Radio
2. BBC World Service
3. Radio Paradise
4. FIP
5. Dance UK
6. KEXP

Users can replace any preset in App Settings.

## Speaker Status

The app tracks:

- active preset
- current source
- connection state
- Wi-Fi signal summary when available
- last raw WebSocket event when debug logging is enabled

## Pairing Icon

When a SoundTouch speaker is paired, the app assigns a simplified SoundTouch 10
icon. The app card background image is abstract-only, so the Homey card does
not show the same speaker artwork twice.

## Local Protocols

- SoundTouch Web API: `http://<speaker-ip>:8090`
- SoundTouch WebSocket: `ws://<speaker-ip>:8080`
- UPnP AVTransport: `http://<speaker-ip>:8091/AVTransport/Control`

## Non-Goals

- Replace the Bose cloud.
- Modify speaker firmware.
- Store UPnP streams as native Bose presets.
- Depend on Home Assistant.
- Require a desktop computer or phone to remain online.
