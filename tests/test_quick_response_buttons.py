"""Exercise saved-reply button defaults and uncertain dispatch through inert HA bases.

The production entity owns slot selection and command handling. These fixtures
own coordinator state and substitute HA dependencies without hardware effects.
"""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from test_experimental_light_buttons import EntityBoundary, ButtonBoundary, GatewayFailure


def button_class():
    """Compile the shipped class while substituting only its external HA bases."""
    source = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/button.py"
    node = next(row for row in ast.parse(source.read_text()).body
                if isinstance(row, ast.ClassDef) and row.name == "EufyQuickResponseButton")
    namespace = {"EufyGatewayEntity": EntityBoundary, "ButtonEntity": ButtonBoundary,
                 "GatewayClientError": GatewayFailure, "HomeAssistantError": RuntimeError}
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), node], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(source), "exec"), namespace)
    return namespace["EufyQuickResponseButton"]


class QuickResponseButtonTests(unittest.IsolatedAsyncioTestCase):
    """Keep opt-in, slot identity and failures separate from physical audio claims."""

    async def test_disabled_trial_dispatches_the_custom_id_once_and_withdraws(self):
        """An uncertain response never retries, changes the slot or invents state."""
        client = SimpleNamespace(play_quick_response=AsyncMock())
        coordinator = SimpleNamespace(client=client, cameras={"camera": {"experimentalQuickResponseSupported": True}})
        entity = button_class()(coordinator, "camera", 100, "Synthetic reply")
        self.assertFalse(entity._attr_entity_registry_enabled_default)
        self.assertEqual(entity._attr_unique_id, "camera_quick_response_100")
        self.assertEqual(entity._attr_translation_key, "quick_response_experimental")
        self.assertEqual(entity._attr_translation_placeholders, {"reply": "Synthetic reply"})
        self.assertTrue(entity.available)
        await entity.async_press()
        client.play_quick_response.assert_awaited_once_with("camera", 100)
        client.play_quick_response.side_effect = GatewayFailure("Outcome unknown")
        with self.assertRaisesRegex(RuntimeError, "Outcome unknown"):
            await entity.async_press()
        self.assertEqual(client.play_quick_response.await_count, 2)
        coordinator.cameras["camera"] = {}
        self.assertFalse(entity.available)


class QuickResponseDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    """Exercise discovery scheduling through the shipped setup function.

    The fixture owns the clock, coordinator and tasks. No HA runtime, network
    connection, speaker or device state is accessed.
    """

    async def test_failed_list_waits_fifteen_minutes_before_retrying(self):
        """Refreshes neither multiply a pending read nor retry every minute after failure."""
        source = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/button.py"
        node = next(row for row in ast.parse(source.read_text()).body
                    if isinstance(row, ast.AsyncFunctionDef) and row.name == "async_setup_entry")
        now = [100.0]
        tasks = []
        listeners = []
        added = []
        client = SimpleNamespace(quick_responses=AsyncMock(side_effect=[GatewayFailure("Unavailable"),
            [{"id": 100, "name": "Synthetic reply"}]]))
        coordinator = SimpleNamespace(client=client, cameras={"camera": {"experimentalQuickResponseSupported": True}},
                                      async_add_listener=lambda callback: listeners.append(callback))
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator),
            async_create_background_task=lambda hass, coroutine, name: tasks.append(asyncio.create_task(coroutine)),
            async_on_unload=lambda callback: None)
        namespace = {"monotonic": lambda: now[0], "GatewayClientError": GatewayFailure,
                     "EufyQuickResponseButton": lambda *args: args,
                     "EufyCameraAiTrackingButton": object, "EufyCameraAutoCruiseButton": object}
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), node], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), str(source), "exec"), namespace)
        await namespace["async_setup_entry"](None, entry, added.extend)
        listeners[0]()
        self.assertEqual(len(tasks), 1)
        await asyncio.gather(*tasks)
        for _ in range(14):
            now[0] += 60
            listeners[0]()
        self.assertEqual(client.quick_responses.await_count, 1)
        self.assertEqual(added, [])
        now[0] += 60
        listeners[0]()
        await asyncio.gather(*tasks)
        self.assertEqual(client.quick_responses.await_count, 2)
        self.assertEqual(added[0][1:], ("camera", 100, "Synthetic reply"))
        now[0] += 900
        listeners[0]()
        self.assertEqual(len(tasks), 2)
