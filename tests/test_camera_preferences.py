"""Check HA preference admission without importing the Home Assistant runtime.

The tests execute the shipped pure selector with synthetic gateway dictionaries.
The gateway and hardware tests own actual command and readback verification.
"""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/preferences.py"
spec = importlib.util.spec_from_file_location("preferences", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CameraPreferencesTest(unittest.TestCase):
    """Keep missing admission and malformed preference data out of HA controls."""

    def test_admission_and_unknown_values(self):
        """A known raw value alone must not create a writable control."""
        camera = {"audioSettings": {"microphoneEnabled": False, "speakerVolume": 80}}
        self.assertIsNone(module.camera_preference_value(camera, "microphone"))
        camera["preferenceControls"] = ["microphone", "speakerVolume"]
        self.assertEqual(module.camera_preference_value(camera, "microphone"), 0)
        self.assertEqual(module.camera_preference_value(camera, "speakerVolume"), 80)
        for value in [True, 0, -1, 101, "80", 80.5, None]:
            camera["audioSettings"]["speakerVolume"] = value
            self.assertIsNone(module.camera_preference_value(camera, "speakerVolume"))
        camera["preferenceControls"] = "microphone"
        self.assertIsNone(module.camera_preference_value(camera, "microphone"))

    def test_reported_preferences(self):
        """Preserve false and zero while rejecting unknown overlay modes."""
        camera = {"preferenceControls": ["watermark", "preRecording"], "reportedSettings": {"watermarkMode": 0, "preRecordingEnabled": False}}
        self.assertEqual(module.camera_preference_value(camera, "watermark"), 0)
        self.assertEqual(module.camera_preference_value(camera, "preRecording"), 0)
        camera["reportedSettings"]["watermarkMode"] = 3
        self.assertIsNone(module.camera_preference_value(camera, "watermark"))

    def test_recording_quality_and_status_light(self):
        """Admit only native medium/high recording tiers and preserve LED off."""
        camera = {"preferenceControls": ["recordingQuality", "statusLed"], "reportedSettings": {"recordingQualityTier": 2, "statusLedEnabled": False}}
        self.assertEqual(module.camera_preference_value(camera, "recordingQuality"), 2)
        self.assertEqual(module.camera_preference_value(camera, "statusLed"), 0)
        for value in [0, 1, 4, True, None]:
            camera["reportedSettings"]["recordingQualityTier"] = value
            self.assertIsNone(module.camera_preference_value(camera, "recordingQuality"))

    def test_model_specific_sound_values(self):
        """Reject older SDK enums and malformed sound ranges on admitted controls."""
        camera = {"preferenceControls": ["soundType", "soundSensitivity", "soundRoundLook", "enhanceLighting"], "reportedSettings": {"soundDetectionType": 128, "soundDetectionSensitivity": 3, "soundRoundLookEnabled": False, "enhanceLightingEnabled": False}}
        self.assertEqual(module.camera_preference_value(camera, "soundType"), 128)
        self.assertEqual(module.camera_preference_value(camera, "soundSensitivity"), 3)
        self.assertEqual(module.camera_preference_value(camera, "soundRoundLook"), 0)
        self.assertEqual(module.camera_preference_value(camera, "enhanceLighting"), 0)
        for value in [1, 2, 129, 255, True, None]:
            camera["reportedSettings"]["soundDetectionType"] = value
            self.assertIsNone(module.camera_preference_value(camera, "soundType"))
        for value in [0, 6, True, "3", 3.5]:
            camera["reportedSettings"]["soundDetectionSensitivity"] = value
            self.assertIsNone(module.camera_preference_value(camera, "soundSensitivity"))

    def test_brightness_and_notification_spacing(self):
        """Preserve zero brightness and minutes without admitting raw seconds."""
        camera = {"preferenceControls": ["lightBrightness", "notificationInterval"], "reportedSettings": {"lightBrightness": 0, "notificationIntervalMinutes": 0}}
        self.assertEqual(module.camera_preference_value(camera, "lightBrightness"), 0)
        self.assertEqual(module.camera_preference_value(camera, "notificationInterval"), 0)
        camera["reportedSettings"]["notificationIntervalMinutes"] = 60
        self.assertIsNone(module.camera_preference_value(camera, "notificationInterval"))
