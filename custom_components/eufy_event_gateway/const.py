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
    GUARD_MODE_AWAY: "Away",
    GUARD_MODE_HOME: "Home",
    GUARD_MODE_SCHEDULE: "Schedule",
    GUARD_MODE_CUSTOM_1: "Custom 1",
    GUARD_MODE_CUSTOM_2: "Custom 2",
    GUARD_MODE_CUSTOM_3: "Custom 3",
    GUARD_MODE_GEOFENCING: "Geofencing",
    GUARD_MODE_DISARMED: "Disarmed",
}

ALARM_TONES = {
    1: "Alarm sound 1",
    2: "Alarm sound 2",
}

NIGHT_VISION_MODES = {
    0: "Off",
    1: "Infrared",
    2: "Full colour",
}
