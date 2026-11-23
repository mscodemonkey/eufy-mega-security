# Experimental C220 reported state

Exact Smart Lock C220 T8506, type 184, has a read-only inventory profile for a
standalone route. Enable **Experimental model controls** in the gateway app
options to try it. It is off by default. Other model codes, types and attached
routes are not admitted by this profile.

Home Assistant can show a **Reported lock state** binary sensor and battery
sensor under the lock device. These use existing Eufy cloud inventory. A missing
state remains unknown, even when a battery reading is present. Inventory can lag
the physical lock, and its observation time is the gateway receipt time. Values
become unavailable after six minutes without a successful inventory update.

The initial report supplied a battery reading but no usable lock-state value.
Real C220 state and battery display through this profile remain unconfirmed.
If you choose to try it, compare with the lock's existing state and the Eufy
app without operating the lock. Whether the sensors appear and match is enough.
Do not send account details, identifiers or raw diagnostics.

This profile creates no lock entity and offers no lock, unlock, refresh,
settings, pairing, calibration or user-management action. It opens no local or
MQTT connection and does not poll the lock. Native status queries and remote
controls remain separate unfinished work.
