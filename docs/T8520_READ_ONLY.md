# Experimental T8520 reported state

The T8520, T8520J11 and T8520S models have a read-only candidate profile for a
direct device reporting type 51. Enable **Experimental model controls** in the
gateway app options to try it. Other types and attached routes are not admitted.
The profile is off by default and has not been confirmed on the reporting hardware.

The integration creates a **Reported lock state** binary sensor and battery
sensor under the lock's device. Home Assistant displays its lock binary sensor
as unlocked when on and locked when off. Other reported values stay unknown.

These are the values returned in Eufy's cloud inventory, which can lag the
physical lock. The observation time records when the gateway received that
inventory. It is not a fresh query of the bolt. Cached observations become
unavailable after six minutes without a successful update.

This profile does not create a lock entity or offer lock, unlock, settings,
user management, pairing or calibration actions. It does not open a local or
MQTT connection. Experimental E30 lock controls remain a separate profile.

To check the result, compare the displayed state and battery with the lock's
existing state and the Eufy app. Do not operate or change the lock for this
check. If nothing appears, report that result first. No credentials, identifiers
or raw diagnostics are needed to confirm whether the entities appeared.
