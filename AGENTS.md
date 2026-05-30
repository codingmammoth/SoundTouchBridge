# SoundTouch Bridge Agent Notes

## Project Summary

SoundTouch Bridge is a local-only Homey Pro app for Bose SoundTouch speakers. It lets
Homey act as the always-on bridge between physical SoundTouch preset button
presses and user-managed internet radio streams.

The app does not try to replace the Bose cloud. It listens for local SoundTouch
events, syncs native preset labels for display, and starts playback through the
speaker's UPnP AVTransport endpoint.

## Coding Workflow

- Work ticket-first. Do not make code changes unless there is a GitHub issue or
  another explicit ticket that defines the work.
- Create a new branch for each ticket before changing files. Use a descriptive
  branch name that includes the ticket number, for example
  `codex/13-random-radio-presets`.
- Keep each branch scoped to one ticket. If new work appears while implementing,
  file or request a follow-up ticket instead of expanding the branch silently.
- When the ticket implementation is done, commit the work and open a pull
  request that references the ticket.
- Test every pull request before merge. Prefer automated checks such as
  `npm test` and `npx homey app validate`; add manual Homey/speaker testing notes
  when hardware behavior cannot be fully automated.
- Do not consider work complete until the pull request has test evidence and is
  ready to merge.
- Close tickets only after the related pull request is closed or merged. If a PR
  is abandoned, leave the ticket open or update it with the remaining work.

## Architecture

- Homey SDK: SDK v3, CommonJS modules.
- Runtime target: older local Homey Pro compatibility matters. The manifest
  intentionally omits `runtime: "nodejs"`.
- Discovery: Homey mDNS-SD discovery strategy for `_soundtouch._tcp`.
- SoundTouch Web API: port `8090`.
- SoundTouch WebSocket: `ws://<speaker-ip>:8080`, subprotocol `gabbo`.
- UPnP AVTransport: port `8091`, path `/AVTransport/Control`.
- Radio directory: public Radio Browser API, no API key.

## Important Files

- `app.js`: app-level API helpers for settings UI, Radio Browser search, and
  preset save/update.
- `api.js`: Homey Web API route exports for app settings.
- `settings/index.html`: custom App Settings UI for managing radio presets.
- `lib/radio-browser-client.js`: Radio Browser search, filtering, stream
  probing, and click counting.
- `lib/soundtouch-client.js`: SoundTouch HTTP API, UPnP playback, XML helpers,
  preset-event parsing, and stream URL validation.
- `drivers/soundtouch/driver.js`: discovery, pairing, SoundTouch 10 icon
  assignment, Flow action/trigger registration.
- `drivers/soundtouch/device.js`: device lifecycle, capabilities, WebSocket
  handling, active preset state, playback controls, settings sync.
- `drivers/soundtouch/driver.settings.compose.json`: read-only device settings
  overview and diagnostics.
- `.homeycompose/capabilities/preset_*.json`: preset dashboard button
  capabilities. These are getable booleans so Homey can show the active preset.

## UX Model

- App Settings are the primary preset management surface.
- Device Settings are intentionally simple: read-only preset overview,
  connection settings, active preset, status, and diagnostics.
- Device Repair was removed. Do not reintroduce it for preset management unless
  there is a strong Homey-specific reason.
- The App Settings modal supports two paths:
  - search Radio Browser and select a compatible station
  - manually enter a preset name and direct stream URL

## Stream Rules

Only direct `http://` streams are supported. HTTPS, HLS, web players, and
playlist URLs are rejected or filtered because older SoundTouch playback does
not handle them reliably through the tested UPnP path.

Keep `validateStreamUrl()` as the final guard for any user- or API-provided
stream URL.

Radio Browser search should continue to filter for:

- currently working stations
- non-HLS streams
- MP3/AAC/AAC+ codecs
- plain HTTP candidate URLs
- streams that pass a quick HTTP audio probe

## Active Preset State

The six preset capabilities are boolean button capabilities with `getable:
true`. `SoundTouchDevice.syncPresetCapabilitySelection()` keeps exactly one
preset selected when active and clears all others on stop, standby, or unknown
status.

Do not bring back the old `Playing: ...` label prefix. The selected button
state is the active indicator.

## Development Commands

```bash
npm install
npm test
npx homey app validate
npx homey app build
npx homey app run
npx homey app install
```

`npm test` is syntax-only and checks app runtime files plus the stream protocol
test helper.

To test stream protocol behavior against a real speaker:

```bash
npm run test:stream-protocol -- --host <speaker-ip> --yes
```

## Compatibility Notes

- Avoid optional chaining and nullish coalescing in app runtime files unless the
  Homey target is deliberately raised.
- Keep app code CommonJS.
- The `homey` package is a dev dependency only; do not bundle it as a runtime
  dependency.
- If editing compose files, run `npx homey app build` so generated `app.json`
  stays in sync.

## Legal/Branding Notes

The app should remain clearly unofficial and not affiliated with Bose. Prefer
compatibility wording such as "for Bose SoundTouch" where needed.
