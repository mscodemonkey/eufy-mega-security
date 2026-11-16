"""Verify independent HA station-volume admission using production callbacks.

Inert coordinator and entity boundaries own test state. Production number setup,
availability and setters run without a Home Assistant server or physical device.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import unittest


class StationBase:
    """Supply shared station state while the tested class owns volume behaviour."""

    def __init__(self, coordinator, serial):
        """Bind one inert coordinator and station key."""
        self.coordinator, self.serial = coordinator, serial

    @property
    def station(self):
        """Return the current mutable fixture reading."""
        return self.coordinator.stations[self.serial]

    @property
    def available(self):
        """Model ordinary coordinator availability independently of trial flags."""
        return True

    def set_confirmed_station(self, station):
        """Publish only the gateway result passed by the production setter."""
        self.coordinator.stations[self.serial] = station


class NumberBase:
    """Provide an inert second base for the production number class."""


def production():
    """Compile production setup and the complete volume class with inert HA bases."""
    path = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/number.py"
    tree = ast.parse(path.read_text())
    nodes = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.AsyncFunctionDef))
             and node.name in ("EufyStationVolume", "async_setup_entry")]
    namespace = {"EufyStationEntity": StationBase, "NumberEntity": NumberBase,
                 "GatewayClientError": ValueError, "HomeAssistantError": RuntimeError}
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    return namespace


class HomeBaseVolumeTrialsTest(unittest.IsolatedAsyncioTestCase):
    """Protect per-kind birth, revocation, stable identity and non-optimistic writes."""

    async def test_prompt_admission_does_not_enable_unknown_alarm_volume(self):
        """Add each trial once and withdraw it independently when its flag clears."""
        namespace = production()
        station = {"controlsSupported": False, "promptVolumeControlSupported": True,
                   "alarmVolumeControlSupported": False, "volumeControlsExperimental": True,
                   "promptVolume": 16, "alarmVolume": None}
        callbacks, entities = [], []
        client = SimpleNamespace(set_station_prompt_volume=AsyncMock(), set_station_alarm_volume=AsyncMock())
        coordinator = SimpleNamespace(cameras={}, stations={"fixture": station}, client=client,
                                      async_add_listener=lambda callback: callbacks.append(callback))
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda _: None)
        await namespace["async_setup_entry"](None, entry, entities.extend)
        self.assertEqual([entity.kind for entity in entities], ["prompt"])
        prompt = entities[0]
        self.assertEqual(prompt._attr_unique_id, "fixture_prompt_volume")
        self.assertEqual(prompt._attr_translation_key, "eufy_station_prompt_volume_experimental")
        self.assertFalse(prompt._attr_entity_registry_enabled_default)
        self.assertEqual(prompt.native_value, 16)
        self.assertTrue(prompt.available)
        callbacks[0]()
        self.assertEqual(len(entities), 1)
        station["promptVolumeControlSupported"] = False
        self.assertFalse(prompt.available)
        station["alarmVolumeControlSupported"] = True
        station["alarmVolume"] = 18
        callbacks[0]()
        self.assertEqual([entity.kind for entity in entities], ["prompt", "alarm"])
        self.assertFalse(entities[1]._attr_entity_registry_enabled_default)

    async def test_legacy_managed_stations_keep_both_numbers(self):
        """Retain existing HB3 identities without requiring new trial metadata."""
        namespace = production()
        client = SimpleNamespace(set_station_prompt_volume=AsyncMock(), set_station_alarm_volume=AsyncMock())
        coordinator = SimpleNamespace(cameras={}, stations={"fixture": {"controlsSupported": True}}, client=client,
                                      async_add_listener=lambda _: None)
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda _: None)
        entities = []
        await namespace["async_setup_entry"](None, entry, entities.extend)
        self.assertEqual({entity._attr_unique_id for entity in entities}, {"fixture_alarm_volume", "fixture_prompt_volume"})
        self.assertTrue(all(entity.available for entity in entities))
        self.assertTrue(all(getattr(entity, "_attr_entity_registry_enabled_default", True) for entity in entities))

    async def test_volume_requires_a_whole_value_and_gateway_confirmation(self):
        """Reject malformed values before dispatch and preserve state on failure."""
        volume = production()["EufyStationVolume"]
        original = {"promptVolume": 16, "promptVolumeControlSupported": True}
        setter = AsyncMock(return_value={"promptVolume": 17, "promptVolumeControlSupported": True})
        coordinator = SimpleNamespace(stations={"fixture": original},
                                      client=SimpleNamespace(set_station_prompt_volume=setter, set_station_alarm_volume=AsyncMock()))
        entity = volume(coordinator, "fixture", "prompt")
        for value in (True, "17", 0, 27, 16.5, float("nan"), float("inf")):
            with self.assertRaises(RuntimeError):
                await entity.async_set_native_value(value)
        setter.assert_not_awaited()
        await entity.async_set_native_value(17.0)
        setter.assert_awaited_once_with("fixture", 17)
        self.assertEqual(entity.native_value, 17)
        setter.side_effect = ValueError("unconfirmed")
        with self.assertRaises(RuntimeError):
            await entity.async_set_native_value(18)
        self.assertEqual(entity.native_value, 17)


if __name__ == "__main__":
    unittest.main()
