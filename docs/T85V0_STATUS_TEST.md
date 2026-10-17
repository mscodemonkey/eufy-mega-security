# FamiLock S3 / S3 Max status check

This experimental check is for the exact T85V0 (device type 203) connected to a
HomeBase 3 T8030 (type 18). Other lock models and connections are excluded.
It asks for the reported lock state and battery once. It does not lock, unlock,
change settings or add a Home Assistant lock control.

The request and reply format come from the official Android implementation.
The gateway has not yet completed this check on physical T85V0 hardware.
A timeout is inconclusive, and a displayed state still needs comparison.

1. Update the app and integration to the release containing this check.
2. Enable **Experimental model controls** in the app options.
3. Close live viewers for devices sharing the HomeBase.
4. Open **Diagnostics**, load devices and select the T85V0.
5. Open **Experimental FamiLock status check**, confirm the read-only consent
   and choose **Check FamiLock status once**.
6. Compare the displayed answer with the lock's existing physical state and
   the Eufy app. Do not operate the lock just for this check.

Share only the displayed summary and whether it matches. If it fails, share
only the complete `lock_status_trial_failed` log line. Keep account details,
device identifiers and diagnostic bundles private.

**Cancel status check**, selecting another device or leaving the page cancels
this operation. Consent resets after each attempt or device change. The
connection may briefly compete with viewing in the Eufy app. A completed
connection attempt has a ten-second cooldown. No reply or an unknown state
does not establish that the lock is unsupported.

The check accepts only the authenticated owner account and a unique current
child channel. Shared accounts, changed bindings and a busy HomeBase are
refused. It checks cloud inventory around the request and may contact Eufy to
find the HomeBase. The reply must match the encrypted connection, selected
channel and this query. There is no command replay or alternative write path.
