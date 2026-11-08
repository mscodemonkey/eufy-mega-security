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
