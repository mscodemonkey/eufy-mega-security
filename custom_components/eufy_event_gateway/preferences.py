"""Normalize confirmed camera preferences for Home Assistant entities.

The gateway owns model admission, protocol writes and fresh readback. These
pure helpers select reported values without guessing missing device settings.
"""
from __future__ import annotations

from typing import Any


def camera_preference_value(camera: dict[str, Any], name: str) -> int | None:
    """Read one admitted preference, retaining unknown and malformed values."""
    fields = {"microphone": ("audioSettings", "microphoneEnabled"), "speaker": ("audioSettings", "speakerEnabled"), "speakerVolume": ("audioSettings", "speakerVolume"), "imageFlipped": ("reportedSettings", "imageFlipped"), "watermark": ("reportedSettings", "watermarkMode"), "preRecording": ("reportedSettings", "preRecordingEnabled"), "soundDetection": ("reportedSettings", "soundDetectionEnabled"), "statusLed": ("reportedSettings", "statusLedEnabled"), "recordingQuality": ("reportedSettings", "recordingQualityTier")}
    controls = camera.get("preferenceControls")
    if name not in fields or not isinstance(controls, list) or name not in controls:
        return None
    group, field = fields[name]
    settings = camera.get(group)
    value = settings.get(field) if isinstance(settings, dict) else None
    maximum = 100 if name == "speakerVolume" else 2 if name == "watermark" else 3 if name == "recordingQuality" else 1
    if isinstance(value, bool) and name not in ("speakerVolume", "watermark", "recordingQuality"):
        return int(value)
    return value if type(value) is int and (1 if name == "speakerVolume" else 2 if name == "recordingQuality" else 0) <= value <= maximum else None
