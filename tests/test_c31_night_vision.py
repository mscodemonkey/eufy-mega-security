"""Check C31 discovery and failure handling at the HA adapter boundary.

Fixtures own the coordinator and registry. Extracted production definitions are
executed without importing HA or contacting a gateway.
"""
from __future__ import annotations

import ast
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest


class C31NightVisionTest(unittest.IsolatedAsyncioTestCase):
    """Preserve entity identity and expose confirmed gateway state only."""

    async def test_discovery_registry_withdrawal_and_failed_write(self) -> None:
        """Retain the existing select ID and surface gateway write failures."""
        source = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/select.py"
        tree = ast.parse(source.read_text())
        names = {"async_setup_entry", "_night_vision_modes", "EufyNightVisionSelect"}
        nodes = [ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)]
        nodes += [node for node in tree.body if getattr(node, "name", None) in names or (
            isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "NIGHT_VISION_MODE_KEYS" for target in node.targets)
        )]

        class Entity:
            """Hold the fixture coordinator and its current camera view."""

            available = True

            def __init__(self, coordinator, serial):
                self.coordinator, self.serial = coordinator, serial

            @property
            def camera(self):
                """Read the latest fixture state, as the real base entity does."""
                return self.coordinator.cameras[self.serial]

        class GatewayError(Exception):
            """Represent an unconfirmed write returned by the gateway."""

        class HaError(Exception):
            """Represent the user-visible service failure."""

        async def fail(*args, **kwargs):
            raise GatewayError("not confirmed")

        camera = {"nightVisionControlSupported": True, "autoNightVisionControlSupported": False,
                  "nightVisionMode": 1, "nightVisionModes": [{"value": 0, "name": "Off"}, {"value": 1, "name": "Auto night vision"}]}
        removed, entities = [], []
        registry = SimpleNamespace(async_remove=removed.append)
        coordinator = SimpleNamespace(cameras={"camera": camera}, stations={}, locks={},
                                      async_add_listener=lambda callback: lambda: None,
                                      client=SimpleNamespace(set_camera_night_vision=fail))
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), entry_id="entry", async_on_unload=lambda callback: None)
        er = SimpleNamespace(async_get=lambda hass: registry, async_entries_for_config_entry=lambda *args: [
            SimpleNamespace(domain="select", platform="eufy_event_gateway", unique_id="camera_night_vision", entity_id="select.existing")])
        namespace: dict[str, Any] = {"Any": Any, "EufyGatewayEntity": Entity, "SelectEntity": type("Select", (), {}),
                                     "er": er, "DOMAIN": "eufy_event_gateway", "camera_preference_value": lambda *args: None,
                                     "GatewayClientError": GatewayError, "HomeAssistantError": HaError}
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(source), "exec"), namespace)
        await namespace["async_setup_entry"](None, entry, lambda values: entities.extend(values))
        self.assertEqual(removed, [])
        self.assertEqual(len(entities), 1)
        entity = entities[0]
        self.assertEqual(entity._attr_unique_id, "camera_night_vision")
        self.assertEqual(entity.options, ["off", "auto_night_vision"])
        self.assertEqual(entity.current_option, "auto_night_vision")
        calls, published = [], []

        async def succeed(*args, **kwargs):
            calls.append((args, kwargs))
            return camera

        coordinator.client.set_camera_night_vision = succeed
        coordinator.async_set_camera = published.append
        await entity.async_select_option("auto_night_vision")
        self.assertEqual(calls, [(("camera", 1), {})])
        self.assertEqual(published, [camera])
        coordinator.client.set_camera_night_vision = fail
        for option in ("off", "auto_night_vision"):
            with self.assertRaisesRegex(HaError, "not confirmed"):
                await entity.async_select_option(option)
        for filename in ("translations/en.json", "strings.json"):
            translated = json.loads((source.parent / filename).read_text())
            self.assertEqual(translated["entity"]["select"]["camera_night_vision"]["state"]["auto_night_vision"], "Auto night vision")

        # Older gateways keep their existing option key during staggered updates.
        camera["nightVisionModes"][1]["name"] = "Infrared"
        self.assertEqual(entity.options, ["off", "infrared"])
        self.assertEqual(entity.current_option, "infrared")
        coordinator.client.set_camera_night_vision = succeed
        calls.clear()
        await entity.async_select_option("infrared")
        self.assertEqual(calls, [(("camera", 1), {})])
        coordinator.client.set_camera_night_vision = fail
        with self.assertRaisesRegex(HaError, "not confirmed"):
            await entity.async_select_option("infrared")
        camera["nightVisionControlSupported"] = False
        self.assertFalse(entity.available)
