# Cloud calendar hints

The default-off cloud recording diagnostic includes a **Load month** button.
Select a camera and a date, then choose **Load month** in gateway Diagnostics.
The API token and `experimental_cloud_recordings` option are required. This
metadata check does not download footage or change any recording settings.

The dates are availability hints. They do not prove that a particular recording
belongs to the selected camera, that its thumbnail can be downloaded, or that
its video can be played. The endpoint and its per-camera filtering remain
unconfirmed on real accounts. Recording selection and playback perform their
own ownership checks. The existing day list and preview are described in
[the recording trial guide](CLOUD_RECORDING_TRIAL.md).

The calendar uses a fixed timezone offset for the month, taken from the browser's
first day of that month. Positive offsets mean seconds east of UTC. That sign
convention is inferred from the existing client. Month bounds are exclusive at
the next month's midnight, which is our convention rather than verified vendor
behaviour. In a month with a daylight saving change, calendar hints can differ
from the day list by up to an hour near a date boundary.

Only plain MP4 and the already supported v8 recording path have a preview.
Legacy v1 and v5 formats remain unsupported. They need a complete file traversal
and key contract plus a sanitized valid encrypted fixture before safe playback
can be implemented. A calendar marker does not change that limitation.

If you already have cloud recordings and choose to test this, compare the dates
with the Eufy app. Report whether the hints match, without sharing camera names,
recording identifiers, picture links or footage. A successful automated test is
not real-account confirmation.

## Explicit Home Assistant metadata actions

The camera entity offers two response-only actions. Select exactly one main
camera entity, rather than a hidden legacy event-image entity. Neither action
returns video, playable links, recording identifiers or recognized names.
Nothing in these responses can be played. There is no dashboard playback or
background loading.

```yaml
action: eufy_event_gateway.get_cloud_recording_dates
target:
  entity_id: camera.example
data:
  month: "2026-10"
response_variable: recording_dates
```

The response contains `month`, `time_zone`, `utc_offset_seconds`, `days` and
`hint_only: true`. Days are unconfirmed hints, not proof of playable footage.

```yaml
action: eufy_event_gateway.list_cloud_recordings
target:
  entity_id: camera.example
data:
  day: "2026-10-18"
response_variable: recording_metadata
```

The response contains `day`, `time_zone`, `utc_offset_seconds`, `window_start`,
`window_end`, `recordings`, `truncated` and `metadata_only: true`. Each recording
contains only `start_time`, `end_time` and `has_cloud_media`. Times are Unix
seconds. `has_cloud_media` describes metadata, not successful playback.
`truncated: true` means the 1000-row limit was reached and more records may exist.
A day without recordings returns an empty list.

Both actions use Home Assistant's configured timezone and actual local
midnights, preserving daylight-saving day lengths. The vendor offset is fixed
at the start of the requested day or month, in seconds east of UTC. This sign
matches the gateway's own callers. Real-account filtering, including how the
history service consumes this offset, remains unconfirmed. For ordinary
one-hour DST changes, calendar hints can differ by an hour. Records are selected
by overlap, so a record ending exactly at midnight also appears in the next day.

The history route is present in gateway v0.1.168. Earlier releases were not
checked for this guide. Calendar needs a build containing PR #427. It requires
`experimental_cloud_recordings` and a gateway API token. The history provider
and route do not require the experimental flag. On a gateway configured without
an API token, history is unauthenticated.

Each action makes a live vendor-cloud request. Do not poll or target many
cameras at once. A camera entity allows one metadata request at a time. The
gateway allows two concurrent calendar jobs, shared with Diagnostics, so a
third request returns a try-again-later error. An older gateway or a disabled
calendar affects only the requested action.

Responses contain activity times and may appear in automation traces or logs.
Do not share them. These actions do not change encryption, download a recording,
wake a camera or support legacy v1/v5 media. Synthetic tests establish the local
contracts only, not real-account history or calendar behaviour.
