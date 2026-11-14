"""Exercise accessory health entities and late capability discovery without HA I/O.

The tests execute production entity and setup code with inert coordinator and
registry boundaries. They never query a device or change a Home Assistant registry.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest


ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


class _SensorEntity:
    """Bind fixture state using the production entity's borrowed ownership model."""

    def __init__(self, coordinator, serial):
        self.coordinator = coordinator
        self.serial = serial

    @property
    def sensor(self):
        return self.coordinator.sensors.get(self.serial, {})

    @property
    def available(self):
        return bool(self.sensor) and self.sensor.get("available", True) is not False


def _load():
    """Compile only the actual setup and health entity with inert HA imports."""
    tree = ast.parse((ROOT / "binary_sensor.py").read_text())
    nodes = [node for node in tree.body
             if isinstance(node, ast.ClassDef) and node.name == "EufySensorHealth"
             or isinstance(node, ast.AsyncFunctionDef) and node.name == "async_setup_entry"]
    namespace = {
        "Any": Any, "HomeAssistant": object, "EufyGatewayConfigEntry": object,
        "AddEntitiesCallback": object, "EufyGatewayCoordinator": object,
        "EufySecuritySensorEntity": _SensorEntity, "BinarySensorEntity": type("Binary", (), {}),
        "EntityCategory": SimpleNamespace(DIAGNOSTIC="diagnostic"),
        "BinarySensorDeviceClass": SimpleNamespace(CONNECTIVITY="connectivity", BATTERY="battery"),
        "er": SimpleNamespace(async_get=lambda _: None),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ROOT / "binary_sensor.py"), "exec"), namespace)
    return namespace


class SensorHealthTests(unittest.IsolatedAsyncioTestCase):
    """Keep explicit health separate from absent state and settled contact data."""

    async def test_late_health_capability_adds_one_entity_and_preserves_unknown(self):
        """A later battery report gets an entity even after the sensor was discovered."""
        namespace = _load()
        row = {"capabilities": ["connected"], "connected": True, "available": True}
        coordinator = SimpleNamespace(sensors={"fixture": row}, cameras={}, stations={}, locks={})
        listeners = []
        coordinator.async_add_listener = lambda callback: listeners.append(callback)
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator),
                                async_on_unload=lambda _: None)
        entities = []
        await namespace["async_setup_entry"](object(), entry, entities.extend)
        self.assertEqual(len(entities), 1)
        connection = entities[0]
        self.assertTrue(connection.is_on)
        self.assertEqual(connection._attr_device_class, "connectivity")
        row.update(capabilities=["connected", "batteryLow"], batteryLow=None)
        listeners[0]()
        listeners[0]()
        self.assertEqual(len(entities), 2)
        battery = entities[1]
        self.assertEqual(battery._attr_unique_id, "fixture_batteryLow")
        self.assertIsNone(battery.is_on)
        self.assertEqual(battery._attr_device_class, "battery")
        for value in (0, 1, "false", "true", [], {}):
            row["batteryLow"] = value
            self.assertIsNone(battery.is_on)
        row["batteryLow"] = False
        self.assertFalse(battery.is_on)
        row["batteryLow"] = True
        self.assertTrue(battery.is_on)
        row["connected"] = False
        self.assertFalse(connection.is_on)
        self.assertTrue(connection.available)
        row["capabilities"] = []
        self.assertFalse(connection.available)
        self.assertFalse(battery.available)

    async def test_device_info_uses_only_the_accessory_firmware(self):
        """Firmware never comes from a station or a made-up default."""
        tree = ast.parse((ROOT / "entity.py").read_text())
        owner = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                     and node.name == "EufySecuritySensorEntity")
        method = next(node for node in owner.body if isinstance(node, ast.FunctionDef)
                      and node.name == "device_info")
        method.decorator_list = []
        namespace = {"DeviceInfo": dict, "DOMAIN": "fixture_domain"}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(ROOT / "entity.py"), "exec"), namespace)
        fixture = SimpleNamespace(serial="invented", sensor={"firmware": "1.2.3", "model": "T8900"})
        self.assertEqual(namespace["device_info"](fixture)["sw_version"], "1.2.3")
        fixture.sensor.pop("firmware")
        self.assertIsNone(namespace["device_info"](fixture)["sw_version"])
