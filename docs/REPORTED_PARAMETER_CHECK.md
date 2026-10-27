# Read-only state check

This experimental diagnostic investigates missing power/privacy candidates on
T8410 and T8417 cameras, and the missing alarm-volume candidate on HomeBase 3
(T8030). It has not been confirmed on those reporter devices. It does not enable
controls, change settings, start live view or update Home Assistant state.

In the local diagnostics page, load devices, select one supported device and
open **Read-only state check**. Experimental model controls and a configured
gateway API token are required. Tick its separate consent box, then choose
**Run once**. This asks Eufy to authorise one cloud parameter read using your existing account, between two
inventory checks. Nothing runs automatically. **Cancel state check**, changing
the selected device or leaving the page retires the request and its result.

The read uses your current session, without signing in again or borrowing an
owner identity. Eufy decides whether that session may read the selected device.
Keep your current account. If the check says an owner account is required, do not
switch accounts to force it. Share that fixed refusal only. No account details,
credentials, diagnostics bundle or capture is needed.

A successful summary contains only the model, fixed profile and candidate field
classifications. `missing` is unknown, never off. `zero` and `one` describe cached
binary candidates, not physical state. `valid` for alarm volume means only that
the value fits the known range. It does not reveal the volume. `invalid` and
`conflicting` must not be used as readback. In particular, earlier physical
T8417 testing disproved 6250 alone as a lens-position readback.

Cloud values may lag, even when returned by this separate endpoint. The safe
copyable summary can be shared if requested. Logs deliberately replace binary
candidates with `valid` so they cannot disclose a possible privacy setting.
Neither result is proof of physical state, freshness or permission to use a
control. This check does not resolve manual siren-state feedback.

The endpoint is `POST /api/diagnostics/parameter-check`, with bearer
authentication even on loopback, JSON content type and exactly a selected serial
plus `consent: true`. The body limit is 1 KiB. Only one provider flight runs at a
time, with a 30-second deadline and no automatic replay. Unknown parameters,
raw values, timestamps and identifiers never appear in its response.
