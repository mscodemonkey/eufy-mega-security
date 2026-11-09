"""Exercise normal HA light buttons with inert entity and gateway boundaries.

The production entity owns its identity and defaults. These fixtures supply
coordinator updates and command outcomes without Home Assistant or hardware.
"""

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from test_camera_inventory_entities import load_function


class GatewayFailure(Exception):
    """Represent an uncertain gateway command result without an HA dependency."""


class EntityBoundary:
    """Supply only the coordinator-owned identity used by the production button."""

    def __init__(self, coordinator, serial):
        """Bind synthetic inventory, retaining updates through the coordinator."""
        self.coordinator = coordinator
        self.serial = serial

    @property
    def camera(self):
        """Read the latest synthetic inventory rather than a construction-time copy."""
        return self.coordinator.cameras[self.serial]

    @property
    def available(self):
        """Leave capability withdrawal to the production entity."""
        return True


class ButtonBoundary:
    """Stand in for HA's button base while exercising the actual subclass."""

    def __init__(self):
        """Avoid creating any HA runtime state."""


def button_class():
    """Compile the shipped class with only its external HA bases substituted."""
    source = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/button.py"
    tree = ast.parse(source.read_text())
    node = next(value for value in tree.body if isinstance(value, ast.ClassDef)
                and value.name == "EufyCameraLightButton")
    namespace = {
        "EufyGatewayEntity": EntityBoundary,
        "ButtonEntity": ButtonBoundary,
        "GatewayClientError": GatewayFailure,
        "HomeAssistantError": RuntimeError,
    }
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), node], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(source), "exec"), namespace)
    return namespace["EufyCameraLightButton"]


class ExperimentalLightButtonTests(unittest.IsolatedAsyncioTestCase):
    """Keep trial labels and defaults separate from command and lamp-state claims."""

    def test_trial_buttons_are_labelled_disabled_and_withdraw_with_their_route(self):
        """Experimental actions retain stable IDs and become unavailable on withdrawal."""
        entity_type = button_class()
        for enabled in (True, False):
            coordinator = SimpleNamespace(cameras={"camera": {"experimentalLightControlSupported": True}})
            entity = entity_type(coordinator, "camera", enabled)
            action = "on" if enabled else "off"
            self.assertEqual(entity._attr_unique_id, f"camera_camera_light_{action}")
            self.assertEqual(entity._attr_translation_key, f"camera_light_{action}_experimental")
            self.assertFalse(entity._attr_entity_registry_enabled_default)
            self.assertTrue(entity.available)
            coordinator.cameras["camera"] = {}
            self.assertFalse(entity.available)

    def test_confirmed_buttons_keep_their_existing_names_and_defaults(self):
        """An experimental addition does not rename or disable an ordinary action."""
        coordinator = SimpleNamespace(cameras={"camera": {"cameraLightControlSupported": True}})
        entity = button_class()(coordinator, "camera", True)
        self.assertEqual(entity._attr_translation_key, "camera_light_on")
        self.assertTrue(entity._attr_entity_registry_enabled_default)

    async def test_late_discovery_adds_trial_buttons_once_on_the_normal_device(self):
        """A new capability creates two ordinary entities without another setup area."""
        listeners, added = [], []
        coordinator = SimpleNamespace(cameras={"camera": {}})
        coordinator.async_add_listener = lambda callback: listeners.append(callback)
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda value: None)
        namespace = {"EufyCameraLightButton": button_class(), "EufyCameraAiTrackingButton": object,
                     "EufyCameraAutoCruiseButton": object}
        setup = load_function("button.py", "async_setup_entry", namespace)
        await setup(None, entry, added.extend)
        self.assertEqual(added, [])
        coordinator.cameras["camera"] = {"experimentalLightControlSupported": True}
        listeners[0]()
        listeners[0]()
        self.assertEqual(len(added), 2)
        self.assertTrue(all(entity.serial == "camera" for entity in added))
        self.assertTrue(all(not entity._attr_entity_registry_enabled_default for entity in added))

    async def test_one_press_sends_once_without_publishing_state_or_retrying_failure(self):
        """Accepted and uncertain results never turn a button into guessed light state."""
        camera = {"experimentalLightControlSupported": True}
        client = SimpleNamespace(set_camera_light=AsyncMock())
        coordinator = SimpleNamespace(cameras={"camera": camera}, client=client)
        entity = button_class()(coordinator, "camera", True)
        await entity.async_press()
        client.set_camera_light.assert_awaited_once_with("camera", True)
        client.set_camera_light.side_effect = GatewayFailure("Light state unknown")
        with self.assertRaisesRegex(RuntimeError, "Light state unknown"):
            await entity.async_press()
        self.assertEqual(client.set_camera_light.await_count, 2)
        self.assertEqual(camera, {"experimentalLightControlSupported": True})
