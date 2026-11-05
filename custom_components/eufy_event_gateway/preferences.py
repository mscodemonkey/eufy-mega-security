"""Normalize confirmed camera preferences for Home Assistant entities.

The gateway owns model admission, protocol writes and fresh readback. These
pure helpers select reported values without guessing missing device settings.
"""
from __future__ import annotations

from typing import Any


def camera_preference_value(camera: dict[str, Any], name: str) -> int | None:
    """Read one admitted preference, retaining unknown and malformed values."""
    if camera.get("careMonitor") is True:
        controls = camera.get("preferenceControls")
        values = camera.get("carePreferences")
        ranges = camera.get("preferenceRanges")
        if not isinstance(controls, list) or name not in controls or not isinstance(values, dict) or not isinstance(ranges, dict):
            return None
        value = values.get(name)
        limits = ranges.get(name)
        if type(value) is not int or not isinstance(limits, dict):
            return None
        minimum, maximum = limits.get("minimum"), limits.get("maximum")
        if type(minimum) is not int or type(maximum) is not int or not minimum <= value <= maximum:
            return None
        return value if name != "soundType" or value in (128, 256) else None
    fields = {"microphone": ("audioSettings", "microphoneEnabled"), "speaker": ("audioSettings", "speakerEnabled"), "speakerVolume": ("audioSettings", "speakerVolume"), "imageFlipped": ("reportedSettings", "imageFlipped"), "watermark": ("reportedSettings", "watermarkMode"), "preRecording": ("reportedSettings", "preRecordingEnabled"), "soundDetection": ("reportedSettings", "soundDetectionEnabled"), "statusLed": ("reportedSettings", "statusLedEnabled"), "recordingQuality": ("reportedSettings", "recordingQualityTier"), "soundSensitivity": ("reportedSettings", "soundDetectionSensitivity"), "soundType": ("reportedSettings", "soundDetectionType"), "soundRoundLook": ("reportedSettings", "soundRoundLookEnabled"), "enhanceLighting": ("reportedSettings", "enhanceLightingEnabled"), "lightBrightness": ("reportedSettings", "lightBrightness"), "notificationInterval": ("reportedSettings", "notificationIntervalMinutes"), "continuousRecording": ("reportedSettings", "continuousRecordingEnabled"), "rtspPublication": ("reportedSettings", "rtspPublicationEnabled")}
    controls = camera.get("preferenceControls")
    if name not in fields or not isinstance(controls, list) or name not in controls:
        return None
    group, field = fields[name]
    settings = camera.get(group)
    value = settings.get(field) if isinstance(settings, dict) else None
    maximum = 100 if name in ("speakerVolume", "lightBrightness") else 2 if name == "watermark" else 3 if name == "recordingQuality" else 5 if name in ("soundSensitivity", "notificationInterval") else 256 if name == "soundType" else 1
    if isinstance(value, bool) and name not in ("speakerVolume", "watermark", "recordingQuality", "soundSensitivity", "soundType", "lightBrightness", "notificationInterval"):
        return int(value)
    if name == "soundType":
        return value if type(value) is int and value in (128, 256) else None
    return value if type(value) is int and (1 if name in ("speakerVolume", "soundSensitivity") else 2 if name == "recordingQuality" else 0) <= value <= maximum else None
