"""Exercise direct HA movement without Home Assistant or camera connections.

The extracted production client and entity own only synthetic callback state.
These checks cover single requests, uncertain results and capability withdrawal.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from typing import Any

ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


def load_boundary():
    """Load the real small methods with state-only substitutes for HA base classes."""
    namespace = {"Any": Any, "HomeAssistantError": RuntimeError}
    for filename, names in [("client.py", {"GatewayClientError", "GatewayAuthenticationError", "GatewayClient"}),
                            ("button.py", {"EufyCameraPanButton"})]:
        tree = ast.parse((ROOT / filename).read_text())
        nodes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name in names]
        for node in nodes:
            if node.name == "GatewayClient":
                node.body = [n for n in node.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "pan_camera"]
        namespace.update(EufyGatewayEntity=type("Base", (), {"available": True}), ButtonEntity=type("Button", (), {}))
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), filename, "exec"), namespace)
    return namespace


class CameraPanTest(unittest.IsolatedAsyncioTestCase):
    """Keep direct movement separate from NVR actions and durable position state."""

    async def test_each_direction_is_one_request_and_errors_are_not_retried(self):
        """Uncertain or malformed replies cannot masquerade as completed movement."""
        boundary = load_boundary()
        client = boundary["GatewayClient"]()
        calls = []
        result = {"outcome": "acknowledged", "physicalConfirmationRequired": True}

        async def request(path, **kwargs):
            calls.append((path, kwargs))
            if isinstance(result, Exception):
                raise result
            return result

        client._json = request
        for direction in ("left", "right", "up", "down"):
            await client.pan_camera("synthetic", direction)
            self.assertEqual(calls[-1], ("/api/cameras/synthetic/pan", {
                "method": "POST", "payload": {"direction": direction}, "timeout": 60}))
        with self.assertRaises(boundary["GatewayClientError"]):
            await client.pan_camera("synthetic", "held")
        self.assertEqual(len(calls), 4)
        for result in ({}, {"outcome": "acknowledged"}, boundary["GatewayClientError"]("private error"), ValueError("private parse")):
            before = len(calls)
            with self.assertRaisesRegex(boundary["GatewayClientError"], "outcome is unknown") as caught:
                await client.pan_camera("synthetic", "left")
            self.assertNotIn("private", str(caught.exception))
            self.assertEqual(len(calls), before + 1)
        result = boundary["GatewayAuthenticationError"]("unauthenticated")
        with self.assertRaises(boundary["GatewayAuthenticationError"]):
            await client.pan_camera("synthetic", "left")

    async def test_button_withdraws_and_calls_the_direct_client_once(self):
        """Existing entities lose availability when the provider retires admission."""
        boundary = load_boundary()
        entity = object.__new__(boundary["EufyCameraPanButton"])
        entity.serial, entity._direction = "synthetic", "up"
        calls = []

        async def pan(serial, direction):
            calls.append((serial, direction))

        entity.coordinator = SimpleNamespace(client=SimpleNamespace(pan_camera=pan))
        entity.camera = {"directionalPanControlSupported": True, "nvrPanControlSupported": False}
        self.assertTrue(entity.available)
        await entity.async_press()
        self.assertEqual(calls, [("synthetic", "up")])
        entity.camera["directionalPanControlSupported"] = False
        self.assertFalse(entity.available)

    async def test_late_discovery_adds_four_direct_buttons_once(self):
        """Create direct actions independently from NVR and preset discovery."""
        tree = ast.parse((ROOT / "button.py").read_text())
        setup = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "async_setup_entry")
        namespace = {}
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                namespace[node.name] = lambda *args, name=node.name: (name, args[1:])
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), setup], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), "button.py", "exec"), namespace)
        listeners, added = [], []
        coordinator = SimpleNamespace(cameras={"synthetic": {}}, async_add_listener=lambda callback: listeners.append(callback))
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda value: None)
        await namespace["async_setup_entry"](None, entry, added.extend)
        self.assertEqual(added, [])
        coordinator.cameras["synthetic"]["directionalPanControlSupported"] = True
        listeners[0]()
        listeners[0]()
        self.assertEqual(added, [("EufyCameraPanButton", ("synthetic", direction)) for direction in ("left", "right", "up", "down")])


if __name__ == "__main__":
    unittest.main()
