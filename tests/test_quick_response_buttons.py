"""Exercise saved-reply button defaults and uncertain dispatch through inert HA bases.

The production entity owns slot selection and command handling. These fixtures
own coordinator state and substitute HA dependencies without hardware effects.
"""
import ast
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
