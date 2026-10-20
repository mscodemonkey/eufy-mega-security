# T8417 privacy observations

The gateway now logs `camera_t8417_read_shape_observed` for exact T8417 inventory. It reports only whether four raw fields contain zero, one, a missing value, a duplicate or an invalid value. Other valid connection-class values are grouped as unknown. No device identity or raw value is included.

These are declared inventory observations. They do not prove physical privacy or authorize a control. The tracker excludes duplicate device rows, flags duplicate parameters and accepts both the number 105 and the string "105" for the device type. This is independent of normal camera admission and state decoding. An attached label means a parent was declared, without proving that parent exists or its connection works.

Existing Home Assistant state is unchanged. For T8417 type 105, the existing enabled decoder prefers field 2001 over 1035. The retained native handler's command map ignores 2001. That discrepancy still needs physical correlation and is not resolved by a default value or a command acknowledgement.

Please report the privacy state the Eufy app currently shows alongside the matching `camera_t8417_read_shape_observed` line. The gateway sends no privacy write, and this check does not require changing an account, router or security setting. Any change you choose to make yourself is optional. Restore its original state afterward.

A line appears at startup, when its group changes, or after fifteen minutes without a new line. Identical observations are grouped and the devices field is that group's count. A group that loses a member is reported again if members remain. An empty refresh preserves its previous observation. Hardware behaviour remains unconfirmed.
