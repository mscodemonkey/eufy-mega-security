"""Verify the T8426 light presentation without importing or operating hardware.

Production callbacks run against test-owned coordinator and HTTP boundaries.
The gateway owns native routing and readback, while these tests ensure HA never
turns unknown manual state into motion state or optimistic success.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
import unittest
from urllib.parse import quote

from test_e30_locks import method
from test_camera_settings import ClientFailure


class ManualFloodlightTests(unittest.IsolatedAsyncioTestCase):
    """Keep manual override, motion lighting and unrelated settings separate."""

    def test_only_boolean_manual_state_is_readable(self):
        """Missing or ambiguous reports stay unknown, including false-like values."""
        state = method("light.py", "EufyManualFloodlight", "is_on", {})
        for raw in (None, "0", "1", 0, 1, {}, []):
            entity = SimpleNamespace(camera={"reportedSettings": {"manualFloodlightEnabled": raw}})
            self.assertIsNone(state(entity))
        for raw in (False, True):
            entity = SimpleNamespace(camera={"reportedSettings": {"manualFloodlightEnabled": raw}})
            self.assertIs(state(entity), raw)

    async def test_confirmed_write_and_unknown_outcome_touch_only_manual_state(self):
        """A clean rejection preserves state and an uncertain write clears only the manual override."""
        callback = method("light.py", "EufyManualFloodlight", "_async_set",
                          {"GatewayClientError": ClientFailure, "HomeAssistantError": RuntimeError})
        camera = {"serial": "fixture", "motionDetectionEnabled": True,
                  "reportedSettings": {"manualFloodlightEnabled": False, "lightBrightness": 80}}
        client = SimpleNamespace(set_camera_setting=AsyncMock(return_value=camera))
        published = []
        entity = SimpleNamespace(serial="fixture", camera=camera,
                                 coordinator=SimpleNamespace(client=client, async_set_camera=published.append))
        await callback(entity, True)
        client.set_camera_setting.assert_awaited_once_with("fixture", "manualFloodlight", True)
        client.set_camera_setting.side_effect = ClientFailure("unavailable", 409)
        with self.assertRaises(RuntimeError):
            await callback(entity, False)
        self.assertEqual(len(published), 1)
        client.set_camera_setting.side_effect = ClientFailure("outcome_unknown", 503)
        with self.assertRaises(RuntimeError):
            await callback(entity, False)
        self.assertIsNone(published[-1]["reportedSettings"]["manualFloodlightEnabled"])
        self.assertEqual(published[-1]["reportedSettings"]["lightBrightness"], 80)
        self.assertTrue(published[-1]["motionDetectionEnabled"])
        self.assertIs(camera["reportedSettings"]["manualFloodlightEnabled"], False)

    async def test_client_requires_matching_typed_manual_confirmation(self):
        """A brightness, motion or integer response cannot confirm the manual override."""
        callback = method("client.py", "GatewayClient", "set_camera_setting", {"GatewayClientError": ClientFailure, "quote": quote})
        camera = {"serial": "fixture", "reportedSettings": {"manualFloodlightEnabled": True}}
        client = SimpleNamespace(_json=AsyncMock(return_value=camera))
        self.assertEqual(await callback(client, "fixture", "manualFloodlight", True), camera)
        for settings in ({"manualFloodlightEnabled": 1}, {"lightBrightness": 1}, {"motionDetectionEnabled": True}, {}):
            client._json.return_value = {"serial": "fixture", "reportedSettings": settings}
            with self.assertRaises(ClientFailure):
                await callback(client, "fixture", "manualFloodlight", True)
