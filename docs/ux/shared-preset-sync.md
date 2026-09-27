# Shared Preset Sync UX Proposal

Issue: codingmammoth/SoundTouchBridge#33

## Summary

Add an optional shared preset mode that lets users maintain one six-slot preset
configuration and apply it to any paired SoundTouch speaker. The recommended
model is a global shared preset library with per-speaker opt-in, plus explicit
sync status per speaker.

This keeps the existing per-speaker model intact for current users, avoids
silent overwrites, and makes the shared state visible before users edit or sync
anything.

## Current State

Preset management currently lives in App Settings. Users select a speaker from a
single dropdown, then edit that speaker's six preset slots. Saving a preset
writes directly to that device's Homey settings:

- `presetN_mode`
- `presetN_name`
- `presetN_url`
- `presetN_random_tag`
- `presetN_random_country_enabled`
- `presetN_random_countrycode`
- `presetN_random_match_count`

After saving, the app updates that device's read-only settings summary, Homey
dashboard preset button titles, and native SoundTouch preset labels through the
speaker's local API.

Device Settings are intentionally read-only for preset management. They point
users back to App Settings and show the current preset summary.

Homey App Settings are an appropriate place for this feature because Homey's
custom settings views are explicitly intended for global app configuration and
can use `Homey.api`, `Homey.alert`, and `Homey.confirm`.

Research inputs:

- Current App Settings implementation in `settings/index.html`.
- Current preset API and per-device settings storage in `app.js`.
- Current device summary, dashboard title sync, and native preset label sync in
  `drivers/soundtouch/device.js`.
- Homey App Settings documentation:
  `https://apps.developer.homey.app/advanced/custom-views/app-settings`.

## UX Goals

- Let multi-speaker users configure the six presets once.
- Preserve existing per-speaker preset behavior for users who need different
  presets per room.
- Make shared mode visible anywhere a preset can be changed or reviewed.
- Avoid accidental overwriting of speaker-specific presets.
- Give clear feedback when offline speakers cannot be synced immediately.
- Keep the settings UI compact enough for mobile Homey screens.

## Recommended Model

Use a shared preset library with per-speaker opt-in.

The App Settings page should have two levels:

1. A top-level mode selector:
   - `Shared presets`
   - `Per-speaker presets`
2. A speaker selector/status list that shows each paired speaker's sync mode and
   sync state.

Shared presets are stored once at app level. A speaker that uses shared presets
receives a copied materialized version in its existing device settings, so the
current playback path can keep using `device.getSettings()` without needing a
large runtime rewrite.

This means shared presets are the source of truth, while each opted-in speaker
still has local preset settings for playback, capability titles, device settings
summaries, and native SoundTouch preset label sync.

## Alternatives Considered

### Global toggle: all speakers always shared

This is simple, but too destructive. Turning it on would overwrite every
speaker's current presets, and turning it off would leave unclear ownership of
the copied settings. It also does not handle users who want one speaker to be
different.

### Explicit "copy to all speakers" action only

This avoids persistent shared state, but it is not really sync. Future edits
would not automatically apply, newly added speakers would not inherit anything,
and users would need to remember to repeat the copy action.

### Per-speaker opt-in to one shared library

This is the recommended approach. It makes the shared source explicit, preserves
per-speaker exceptions, and supports predictable behavior for newly added or
offline speakers.

## Proposed App Settings Structure

### Header

Title:

```text
Radio presets
```

Mode control:

```text
Preset setup
[ Shared presets ] [ Per-speaker presets ]
```

Helper copy when shared mode is selected:

```text
Shared presets apply to every speaker that uses shared mode. Speakers using
their own presets are not changed.
```

Helper copy when per-speaker mode is selected:

```text
Select a speaker to manage only that speaker's presets.
```

### Shared presets view

Show the six preset rows exactly once, using the current fixed/random preset
editing modal. Above the rows, show:

```text
Shared preset library
These six presets are copied to speakers that use shared presets.
```

Below or beside the preset list, show a compact speaker sync list:

```text
Speakers using shared presets

Office HQ          Synced
Kitchen            Offline, will sync when reachable
Living Room        Sync failed: no random station fallback yet
```

Actions:

- `Sync now`
- `Manage speakers`

### Per-speaker presets view

Keep the existing speaker dropdown and six preset rows, but add a clear mode
badge near the selected speaker:

```text
Office HQ
Uses own presets
```

If the selected speaker uses shared presets, show a locked/shared state instead
of normal edit buttons:

```text
Office HQ
Uses shared presets

These presets are managed in Shared presets. Switch this speaker to its own
presets if you want different stations for this speaker.

[Edit shared presets] [Use own presets]
```

This prevents users from thinking an edit applies only to one speaker when it
would actually affect the shared library.

### Device Settings read-only summary

Device Settings should remain read-only for preset management, but the preset
group should show whether the selected speaker uses shared presets:

```text
Preset mode
Shared presets

Preset sync
Synced with shared presets
```

For own presets:

```text
Preset mode
Own presets
```

If the speaker is stale or failed:

```text
Preset sync
Pending sync, speaker offline
```

The existing `Manage presets` hint should change when shared mode is enabled:

```text
This speaker uses shared presets. Manage the shared preset library in
SoundTouch Bridge app settings.
```

## Speaker Enrollment Flow

### Existing speaker: switch from own presets to shared presets

Use an explicit confirmation before overwriting:

```text
Use shared presets for Office HQ?

This will replace Office HQ's six preset settings with the shared preset
library. The speaker's current own presets will be kept as a backup so you can
switch back later.

[Cancel] [Use shared presets]
```

After confirmation:

1. Store a backup of the speaker's current per-speaker preset settings.
2. Mark the speaker as using shared presets.
3. Copy shared presets into the speaker's device settings.
4. Sync device settings summary and dashboard preset titles.
5. Attempt native SoundTouch preset label sync.
6. Show per-speaker sync result.

### Existing speaker: switch from shared presets to own presets

Use a choice instead of silently deciding:

```text
Use own presets for Office HQ

Choose how Office HQ should start its own preset list.

[Keep current shared presets as a copy]
[Restore presets from before shared mode]
[Cancel]
```

Recommended default: `Keep current shared presets as a copy`. This is safer if
the user has been using shared presets for a while and expects the current
configuration to continue working.

### New speaker while shared presets exist

Do not automatically overwrite without telling the user. After pairing, the
first App Settings load should show a non-blocking callout:

```text
New speaker added: Kitchen

Use the shared preset library on this speaker?

[Use shared presets] [Keep own presets]
```

Recommended default: `Use shared presets` if at least one existing speaker
already uses shared presets; otherwise `Keep own presets`.

If the user does not visit App Settings after pairing, the device should keep
the current seeded default presets until they choose otherwise.

### New speaker while shared presets are not configured

Keep today's behavior: seed default per-speaker presets. The UI can still show:

```text
This speaker uses its own presets.
```

## Sync Timing

Shared preset edits should save to the shared library first, then fan out to
all opted-in speakers.

Sync steps per opted-in speaker:

1. Copy shared preset settings into device settings.
2. Clear random last-station fallback only for random rules whose rule changed.
3. Update read-only device settings summaries.
4. Update Homey dashboard preset button titles.
5. Attempt native SoundTouch preset label sync.
6. Record sync result.

The UI should show the save as successful if the shared library saved, even if
one speaker failed to sync. Failed speakers should be marked clearly and retried
later.

## Offline And Failure Behavior

Offline speakers should remain enrolled in shared mode. They should be marked:

```text
Pending sync, speaker offline
```

When a speaker reconnects, the app should compare the speaker's last applied
shared preset revision with the current shared revision. If it is stale, it
should sync automatically.

Failure states should be per speaker:

- `Synced`
- `Pending sync`
- `Offline, will sync when reachable`
- `Out of sync`
- `Preset labels failed`
- `Sync failed`

Native SoundTouch preset label sync failures should not block Homey playback,
because Homey playback uses copied device settings. The UI should distinguish
between preset configuration sync and native label sync:

```text
Playback presets synced. Speaker display labels failed to update.
```

If a speaker's applied revision is older than the shared library revision but
the speaker is reachable, show `Out of sync` and expose `Sync now`. If the
speaker is not reachable, show `Offline, will sync when reachable`. Avoid
showing raw revision numbers to normal users; keep them for diagnostics.

## Random Preset Behavior

Shared random rules should be shared, but last selected random stations should
remain per speaker.

Reasoning:

- The rule is user configuration and belongs in the shared library.
- The last successful station is runtime fallback state, not configuration.
- Keeping fallback state per speaker avoids one speaker's random station
  changing another speaker's fallback.

When a shared random rule changes, clear the last random station fallback on
each opted-in speaker for that preset slot. If only the display label changes
and the tag/country rule stays the same, keep the fallback.

Native SoundTouch labels for random presets should use the shared label. Native
fallback URL sync can only happen after each speaker has successfully played or
selected a random station for that slot.

## Data Model Proposal

Use Homey app-level settings for shared configuration:

```json
{
  "sharedPresets": {
    "enabled": true,
    "revision": 7,
    "presets": [
      {
        "preset": 1,
        "mode": "fixed",
        "name": "Radio Paradise",
        "url": "http://example.com/stream.mp3"
      },
      {
        "preset": 2,
        "mode": "random",
        "name": "Random Dance",
        "random": {
          "tag": "dance",
          "countryEnabled": true,
          "countrycode": "BE",
          "matchCount": 42
        }
      }
    ]
  }
}
```

Use per-device store values for enrollment and sync bookkeeping:

```json
{
  "preset_sync_mode": "shared",
  "shared_preset_revision_applied": 7,
  "shared_preset_last_sync_status": "synced",
  "shared_preset_last_sync_at": "2026-07-03T10:15:00.000Z",
  "shared_preset_last_sync_error": "",
  "own_preset_backup": { "presets": [] }
}
```

Keep the materialized existing device settings for playback:

- `presetN_mode`
- `presetN_name`
- `presetN_url`
- `presetN_random_tag`
- `presetN_random_country_enabled`
- `presetN_random_countrycode`
- `presetN_random_match_count`

This avoids making all playback, Flow, capability, and diagnostics code aware of
shared app-level settings at once.

## API Proposal

Add App API endpoints:

- `GET /preset-config`
  - returns shared preset library, paired speakers, speaker sync modes, sync
    statuses, and materialized presets
- `PUT /shared-presets`
  - saves shared library and triggers fan-out sync
- `POST /shared-presets/sync`
  - manually retries sync for all or selected speakers
- `POST /speakers/:id/preset-mode`
  - switches one speaker between `own` and `shared`
- `POST /speakers/:id/shared-preset-backup/restore`
  - restores the backed-up own presets when leaving shared mode

The existing `/preset-devices` and `/presets` endpoints can remain for backward
compatibility during implementation, but the settings UI should move to the
new aggregate endpoint to avoid repeated per-speaker calls.

## Migration

Existing users should not be migrated into shared mode automatically.

On first launch after the feature ships:

- Keep all speakers in `own` mode.
- If multiple speakers are paired, show a small suggestion in App Settings:

```text
Manage presets once for multiple speakers

You can create shared presets and apply them to selected speakers. Existing
speaker presets will not change until you choose to use shared presets.

[Set up shared presets]
```

When the user starts shared setup for the first time, offer to initialize the
shared library from an existing speaker:

```text
Start shared presets from:

[Office HQ] [Kitchen] [Default presets]
```

This gives users a predictable starting point and avoids requiring manual
re-entry of all six presets.

## UI Copy Reference

Mode labels:

- `Shared presets`
- `Per-speaker presets`
- `Uses shared presets`
- `Uses own presets`

Status labels:

- `Synced`
- `Pending sync`
- `Offline, will sync when reachable`
- `Playback presets synced; speaker labels failed`
- `Sync failed`

Confirmation copy:

```text
This will replace this speaker's six preset settings with the shared preset
library. Its current presets will be kept as a backup.
```

Shared edit reminder:

```text
You are editing shared presets. Changes apply to every speaker using shared
presets.
```

Per-speaker edit reminder:

```text
You are editing only this speaker.
```

## Implementation Breakdown

Split implementation into focused tickets:

1. Add shared preset data model and app APIs.
2. Add sync service that materializes shared presets to opted-in devices and
   records per-speaker status.
3. Update App Settings UI with shared/per-speaker modes, speaker enrollment,
   status list, confirmations, and shared edit warnings.
4. Add reconnect/startup retry for stale shared preset revisions.
5. Update diagnostics/read-only device settings summaries to indicate shared
   mode and sync status.
6. Add tests for migration, enrollment, random rule sync, offline retry, and
   native label failure reporting.

## Risks And Open Questions

- Homey device settings are not a perfect fit for large backup objects. If
  `own_preset_backup` becomes too large or unreliable, store only the six known
  preset keys or use app settings keyed by device id.
- The UI needs careful wording around random preset fallback behavior because
  shared random rules are global but last selected stations stay per speaker.
- Native SoundTouch label sync is best-effort and can fail independently per
  speaker. The UI must not imply that a label sync failure means playback is
  broken.
- If a speaker is deleted while enrolled in shared presets, cleanup should
  remove only that speaker's sync bookkeeping, not the shared library.
- Manual IP repair and shared presets can interact later. Repair should trigger
  a sync retry if the speaker is in shared mode and stale.

## Recommendation

Proceed with the per-speaker opt-in shared library model. It is the clearest
choice for users, preserves existing behavior, handles newly added speakers
without surprise overwrites, and aligns with the current architecture by
materializing shared presets into the existing per-device settings used by
playback and diagnostics.
