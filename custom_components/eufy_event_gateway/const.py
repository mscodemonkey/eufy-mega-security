"""Stable Home Assistant identifiers for Eufy Mega Security.

The domain remains `eufy_event_gateway` for installed-entry compatibility even
though the user-facing project and integration name is Eufy Mega Security.
These constants are the shared keys used by the config flow, coordinator, and
platform setup; changing them can orphan existing Home Assistant entries.
"""

from homeassistant.const import Platform

DOMAIN = "eufy_event_gateway"
CONF_API_TOKEN = "api_token"
PLATFORMS = [
    Platform.BUTTON,
    Platform.CAMERA,
    Platform.BINARY_SENSOR,
    Platform.SENSOR,
    Platform.ALARM_CONTROL_PANEL,
    Platform.SELECT,
    Platform.NUMBER,
    Platform.SWITCH,
    Platform.SIREN,
]

GUARD_MODE_AWAY = 0
GUARD_MODE_HOME = 1
GUARD_MODE_SCHEDULE = 2
GUARD_MODE_CUSTOM_1 = 3
GUARD_MODE_CUSTOM_2 = 4
GUARD_MODE_CUSTOM_3 = 5
GUARD_MODE_GEOFENCING = 47
GUARD_MODE_DISARMED = 63

GUARD_MODES = {
    GUARD_MODE_AWAY: "away",
    GUARD_MODE_HOME: "home",
    GUARD_MODE_SCHEDULE: "schedule",
    GUARD_MODE_CUSTOM_1: "custom_1",
    GUARD_MODE_CUSTOM_2: "custom_2",
    GUARD_MODE_CUSTOM_3: "custom_3",
    GUARD_MODE_GEOFENCING: "geofencing",
    GUARD_MODE_DISARMED: "disarmed",
}

ALARM_TONES = {
    1: "alarm_sound_1",
    2: "alarm_sound_2",
}
