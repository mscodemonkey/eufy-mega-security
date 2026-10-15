# NVR S4 mode readings

For the exact T8N00/type 300 NVR S4, the configured mode and effective mode are
separate readings. Schedule can remain configured while the effective mode
changes to Away, Home or a custom mode. The read-only effective-mode sensor
uses a fresh mode-change notification from Eufy.

The sensor starts unknown until a recognized notification arrives. Its
`state_source` and `last_reported` attributes identify the push observation.
It depends on Eufy sending mode-change notifications, so use the report time
to judge freshness. It becomes unknown if the receiver loses its connection,
if a newer notification has an unsupported shape, or if a different configured
policy arrives before a new effective-mode report. Stale, replayed and
out-of-order notifications cannot overwrite a newer reading.

Custom titles come from the current station inventory. If no usable title is
reported, the sensor uses `custom_1`, `custom_2` or `custom_3`. NVR mode writes
and camera-power writes remain disabled. The gateway does not change Eufy's
notification settings.

After updating the app and integration, restart Home Assistant and observe a
usual schedule transition. Check whether the effective-mode sensor follows the
change while the configured-mode sensor stays on Schedule. If the effective
reading stays unknown, share only the complete `push_received` line containing
`effective_mode_field=`. No schedule export or private account data is needed.
