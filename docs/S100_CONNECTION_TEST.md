# S100 connection check

This is an experimental prerequisite check for the exact standalone S100
(T84A1, type 151). It does not confirm that the siren works. It opens one PPCS
session, prepares its connection and closes it. No siren command is sent.

1. Enable **Experimental model controls** (`experimental_model_controls`) in
   the gateway app configuration. This option is off by default.
2. Stop live viewers, open gateway Diagnostics and select one S100.
3. Check available controls and choose **Check S100 connection (no sound)**.
4. Tick the connection-check consent and try once.
5. Share the displayed result or the complete `model_control_trial_failed`
   line. Do not repeat the check or run a sound test as part of this request.

Do not share tokens, serials, camera names or raw captures. A `prepared` result
means the negotiated key and counters were available. Physical sound and stop
behaviour remain unconfirmed.

| Failure stage | Meaning |
| --- | --- |
| `session_key` | The cloud-supplied device key was unavailable. |
| `session_connect` | The initial connection did not complete. |
| `session_prepare` | The session closed, was busy or its binding changed. |
| `session_identity` | The exact model or session route did not match. |
| `session_gateway` | No gateway key-negotiation frame arrived. |
| `session_cipher` | The negotiated key was missing or unusable. |
| `session_counter` | The session could not reserve safe command counters. |

These are gateway observations, not a diagnosis of the camera's physical state.
This check changes no encryption settings and adds no encryption fallback.
