# T8910 cached motion-time investigation

This manual, default-off check investigates whether the per-device cloud
parameter API returns a T8910 motion time that the bulk inventory omitted.
It does not enable a new polling receiver or establish phone-independent motion.
The existing local test and bulk-inventory fallback failed in the reported cases.
Repeating the local test is not part of this check.

Use a release containing this probe. Keep the gateway account, sensor, phone
notification preferences and security mode unchanged. Enable **Experimental
model controls** in the gateway options, open Diagnostics, select the exact
T8910 attached to HomeBase 2 or 3, and expand **Read-only state check**. Confirm
consent and choose **Run once**. This reads cached cloud candidates only. It
sends no device-setting command and does not enter sensor test mode.

The cloud authorizes the gateway's current token. If the answer says an owner
account is required, stop and report that result. Do not replace a working shared
account to force the check through.

Only a fixed classification for field 1605 is returned:

- `missing` or `unset`: this response provides no cached motion instant.
- `recent`: a plausible seconds or milliseconds value is within one minute of
  the gateway's receipt clock, allowing two seconds of clock skew.
- `older` or `future`: the cached candidate falls outside that window. This does
  not establish why, and a clock difference remains possible.
- `invalid` or `conflicting`: the response cannot be interpreted safely.

No raw event timestamp, account data or device identifier is included in this
result. Share only the complete `reported_parameter_check` line for `model=T8910`.
If an ordinary detection has already occurred, note whether this read reports a
recent candidate. Do not change the alarm mode or manufacture a trigger to obtain
one. Restore the gateway's experimental option to its original value afterwards.

A recent candidate alone does not establish that it advances for each detection
with phone alerts disabled. That hardware result is required before switching a
polling receiver to this source or treating it as a reliable automation input.
Normal motion, push handling and the existing polling clock remain unchanged.

For Home Assistant app installs without a visible gateway token, the updated
saved-connection utility also accepts the T8910 profile. Use the helper revision
linked in the test request, select the sensor's current index from `list`, then run:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py state-check --target-index 1 --consent-read
```

Share only the displayed T8910 summary. The utility accepts only the closed age
categories, never raw event timestamps. Keep the existing account and settings.

## Shared-account device-list comparison

The separate **T8910 device-list comparison** source reads the cloud list that
shared accounts already use for discovery. It does not call the owner-only
parameter endpoint or borrow an owner identity. Exact T8910/type 10 through
HomeBase 2/type 0 or HomeBase 3/type 18 is required. Device, parent, unique
channel and current-account bindings must remain unchanged across both lists.

Select that source in **Read-only state check**, consent and choose **Run once**.
The check takes two fresh inventory snapshots ten seconds apart, then discards
them. Cancelling, changing source/device or leaving the page cancels the check.
The existing separate parameter-API source remains available and keeps its
original admission checks.

The terminal helper selects the new source explicitly:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py state-check --target-index 1 --consent-read --device-list
```

The summary adds `source=device_list` and one change classification:

- `advanced`: both values were interpretable, and the later instant increased.
- `unchanged`: both values represented the same instant.
- `regressed`: the later instant was earlier. Do not treat it as new motion.
- `unavailable`: either value was absent, unset, future, invalid or conflicting.

It also reports the second value's existing coarse age category. Neither raw
instant is returned or logged. A short unchanged or missing window does not
prove the backend never updates that field. An advance does not establish that
every detection is represented, how quickly it arrives or whether it works with
different phone-alert settings. Keep the current account, notifications and
security mode. Use ordinary activity only, without manufacturing a trigger.

This diagnostic does not ingest either snapshot into normal state, change the
existing inventory polling clock, publish a motion event or send a peer command.
Real shared-account availability and motion coverage remain unconfirmed.
