"""Test HA settings callbacks with inert coordinator and HTTP boundaries.

The tests compile production methods without importing Home Assistant. Synthetic
responses own all state, so no real entity or device is contacted.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import unittest
from urllib.parse import quote

from test_e30_locks import method


class ClientFailure(Exception):
    """Supply the structured gateway failure facts used by production entities."""

    def __init__(self, message=None, status=None, *, code=None):
        """Keep test errors independent of their human-readable message."""
        super().__init__("synthetic")
        self.code = code if code is not None else message if message in ("busy", "unavailable", "outcome_unknown") else None
        self.status = status


class CameraSettingsTest(unittest.IsolatedAsyncioTestCase):
    """Protect integer validation, confirmation and targeted failure semantics."""

    async def test_number_rejects_non_integral_values_and_preserves_clean_rejections(self):
        """Only supported whole-number steps dispatch, and only uncertain writes invalidate."""
        callback = method("number.py", "EufyMotionSensitivityNumber", "async_set_native_value",
                          {"GatewayClientError": ClientFailure, "HomeAssistantError": RuntimeError})
        camera = {"serial": "fixture", "reportedSettings": {"motionSensitivityStep": 3, "statusLedEnabled": True}}
        client = SimpleNamespace(set_camera_setting=AsyncMock(return_value=camera))
        published = []
        entity = SimpleNamespace(serial="fixture", camera=camera, native_max_value=3,
                                 coordinator=SimpleNamespace(client=client, async_set_camera=published.append))
        for invalid in (True, "2", 0, 4, 2.5, float("nan"), float("inf")):
            with self.assertRaises(RuntimeError):
                await callback(entity, invalid)
        client.set_camera_setting.assert_not_called()
        await callback(entity, 2.0)
        client.set_camera_setting.assert_awaited_once_with("fixture", "motionSensitivity", 2)
        self.assertEqual(published, [camera])
        for code in ("busy", "unavailable"):
            client.set_camera_setting.side_effect = ClientFailure(code, 409)
            with self.assertRaises(RuntimeError):
                await callback(entity, 2)
            self.assertEqual(len(published), 1)
        client.set_camera_setting.side_effect = ClientFailure("outcome_unknown", 503)
        with self.assertRaises(RuntimeError):
            await callback(entity, 2)
        self.assertIsNone(published[-1]["reportedSettings"]["motionSensitivityStep"])
        self.assertTrue(published[-1]["reportedSettings"]["statusLedEnabled"])
        self.assertEqual(camera["reportedSettings"]["motionSensitivityStep"], 3)

    async def test_client_rejects_mismatched_confirmation_and_marks_transport_loss_unknown(self):
        """HTTP success alone cannot publish a different camera or requested setting."""
        callback = method("client.py", "GatewayClient", "set_camera_setting", {"GatewayClientError": ClientFailure, "quote": quote})
        camera = {"serial": "fixture", "reportedSettings": {"motionSensitivityStep": 2}}
        client = SimpleNamespace(_json=AsyncMock(return_value=camera))
        self.assertEqual(await callback(client, "fixture", "motionSensitivity", 2), camera)
        self.assertEqual(client._json.call_args.kwargs["timeout"], 140)
        with self.assertRaises(ClientFailure):
            await callback(client, "fixture", "motionSensitivity", 3)
        client._json.side_effect = ClientFailure()
        with self.assertRaises(ClientFailure) as failure:
            await callback(client, "fixture", "motionSensitivity", 2)
        self.assertEqual(failure.exception.code, "outcome_unknown")
        client._json.side_effect = ClientFailure("busy", 409)
        with self.assertRaises(ClientFailure) as failure:
            await callback(client, "fixture", "motionSensitivity", 2)
        self.assertEqual(failure.exception.code, "busy")

    async def test_chime_failure_does_not_change_detection_or_other_camera_settings(self):
        """Unknown chime outcome clears only its own value and identifies the safe blueprint target."""
        callback = method("switch.py", "EufyDoorbellChimeSwitch", "_async_set", {"GatewayClientError": ClientFailure, "HomeAssistantError": RuntimeError})
        attributes = method("switch.py", "EufyDoorbellChimeSwitch", "extra_state_attributes", {})
        self.assertEqual(attributes(None), {"eufy_control": "homebase_doorbell_chime"})
        camera = {"serial": "fixture", "motionDetectionEnabled": True, "reportedSettings": {"homebaseChimeEnabled": True, "recordingDurationSeconds": 30}}
        published = []
        entity = SimpleNamespace(serial="fixture", camera=camera, coordinator=SimpleNamespace(
            client=SimpleNamespace(set_camera_setting=AsyncMock(side_effect=ClientFailure("outcome_unknown", 503))), async_set_camera=published.append))
        with self.assertRaises(RuntimeError):
            await callback(entity, False)
        self.assertTrue(published[-1]["motionDetectionEnabled"])
        self.assertEqual(published[-1]["reportedSettings"]["recordingDurationSeconds"], 30)
        self.assertIsNone(published[-1]["reportedSettings"]["homebaseChimeEnabled"])

    async def test_optional_controls_discover_once_after_late_capability_updates(self):
        """Older gateways create nothing and later admitted controls appear once."""
        root = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"
        for filename in ("number.py", "switch.py"):
            tree = ast.parse((root / filename).read_text())
            setup = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "async_setup_entry")
            added, listeners = [], []
            coordinator = SimpleNamespace(cameras={"fixture": {}}, stations={}, locks={}, async_add_listener=listeners.append)
            namespace = {"camera_preference_value": lambda *args: None,
                         "EufyMotionSensitivityNumber": lambda *args: ("motion", args[1]),
                         "EufyDoorbellChimeSwitch": lambda *args: ("chime", args[1])}
            exec(compile(ast.Module(body=[tree.body[1], setup], type_ignores=[]), filename, "exec"), namespace)
            entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda callback: None)
            await namespace["async_setup_entry"](None, entry, added.extend)
            self.assertEqual(added, [])
            coordinator.cameras["fixture"] = {"motionSensitivityControlSupported": True, "motionSensitivitySteps": 3,
                                             "homebaseChimeControlSupported": True, "reportedSettings": {"motionSensitivityStep": 2, "homebaseChimeEnabled": True}}
            for listener in listeners:
                listener()
                listener()
            self.assertEqual(len(added), 1)

    async def test_sensitivity_maximum_follows_current_admission(self):
        """A rediscovered route cannot retain a stale maximum from construction."""
        callback = method("number.py", "EufyMotionSensitivityNumber", "native_max_value", {})
        entity = SimpleNamespace(camera={})
        for value, expected in ((3, 3), (5, 5), (7, 7), (None, 1), (True, 1), ("7", 1), (8, 1)):
            entity.camera["motionSensitivitySteps"] = value
            self.assertEqual(callback(entity), expected)
