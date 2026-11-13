# Experimental C35 camera enablement

This trial covers only eufyCam C35 T8110, type 10035, using its own standalone channel-zero route. It does not cover a C35 attached to a HomeBase. Camera power, monitoring and restoration on real hardware remain unconfirmed. Spotlight control is separate.

The configured EMS account must own the camera, gateway API authentication must be enabled and the camera must provide a recognised current setting. Enable Experimental model controls in the EMS app configuration. On the normal HA device page, show disabled entities and enable Camera enabled (experimental). The entity starts disabled and remains unavailable without its account, route and state requirements.

Do not use this trial on a camera needed for current household security. Wait for all views and recordings to finish, note the camera's original state in the Eufy app and use one watched change to the opposite state. The gateway requires a fresh baseline, sends once and confirms its result using a fresh native state response. A missing or ambiguous confirmation leaves the outcome unknown and is never automatically retried. Confirm the camera's actual behaviour in the Eufy app, then restore its original state once. Do not retry an uncertain operation. Check the app first.

Report whether the camera changed and returned to its original state. If the control is absent or reports an unknown outcome, stop without changing accounts or trying the spotlight. Keep credentials, identifiers and private footage out of the reply. Automated confirmation validates the reported setting, not physical security coverage.
