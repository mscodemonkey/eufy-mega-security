"""Exercise detection registry migration using production setup and sync code.

Fixtures own registry entries and coordinator updates. Extracted definitions run
with inert HA boundary objects, without a gateway, global stubs or real registry.
"""

from __future__ import annotations

import ast
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest


class Disabler(str, Enum):
    """Mirror the verified HA RegistryEntryDisabler values used at this boundary."""

    INTEGRATION = "integration"
    USER = "user"
    CONFIG_ENTRY = "config_entry"
    DEVICE = "device"


class Registry:
    """Retain customized fixture records and collect only requested field updates."""

    def __init__(self) -> None:
        """Create isolated registry ownership and update history for one test."""
        self.entries = {}
        self.updates = []

    def add(self, kind: str, disabled_by=None, entry_id="entry") -> None:
        """Create an existing sensor whose UI identity must survive migration."""
        self.entries[f"cam_{kind}"] = SimpleNamespace(
            entity_id=f"binary_sensor.custom_{kind}", config_entry_id=entry_id,
            disabled_by=disabled_by, name="Custom name", options={"custom": True},
        )

    def async_get_entity_id(self, domain, platform, unique_id):
        """Resolve only the intended binary sensor integration namespace."""
        assert domain == "binary_sensor" and platform == "eufy_event_gateway"
        entry = self.entries.get(unique_id)
        return entry.entity_id if entry else None

    def async_get(self, entity_id):
        """Return the same stored record to make destructive changes observable."""
        return next((entry for entry in self.entries.values() if entry.entity_id == entity_id), None)

    def async_update_entity(self, entity_id, **changes):
        """Reject mutations to names, IDs or options at the registry boundary."""
        assert set(changes) == {"disabled_by"}
        self.updates.append((entity_id, changes["disabled_by"]))
        self.async_get(entity_id).disabled_by = changes["disabled_by"]


class DetectionRegistryTest(unittest.IsolatedAsyncioTestCase):
    """Protect ownership, user choices and late capability publication."""

    def setUp(self) -> None:
        """Load real functions with test-local, non-imported HA boundaries."""
        source = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/binary_sensor.py"
        tree = ast.parse(source.read_text())
        names = {"sync_detection_registry", "async_setup_entry"}
        nodes = [ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)]
        nodes.extend(node for node in tree.body if getattr(node, "name", None) in names or (
            isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "DETECTION_KINDS" for target in node.targets)
        ))
        self.registry = Registry()
        self.namespace: dict[str, Any] = {
            "er": SimpleNamespace(async_get=lambda hass: self.registry, RegistryEntryDisabler=Disabler),
            "DOMAIN": "eufy_event_gateway",
            "EufyDetectionSensor": lambda coordinator, serial, kind: SimpleNamespace(kind=kind),
        }
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(source), "exec"), self.namespace)
        self.sync = self.namespace["sync_detection_registry"]

    async def test_preserves_ownership_customization_and_user_choices(self) -> None:
        """Disable only unsupported active entries in the current config entry."""
        for kind, disabler, owner in (
            ("motion", None, "entry"), ("person", None, "entry"),
            ("pet", Disabler.USER, "entry"), ("vehicle", Disabler.CONFIG_ENTRY, "entry"),
            ("sound", Disabler.DEVICE, "entry"), ("stranger", None, "foreign"),
            ("doorbell", None, "entry"),
        ):
            self.registry.add(kind, disabler, owner)
        before = {key: (entry.entity_id, entry.name, entry.options.copy()) for key, entry in self.registry.entries.items()}
        self.sync(self.registry, "entry", "cam", ["motion"])
        self.assertEqual(self.registry.updates, [("binary_sensor.custom_person", Disabler.INTEGRATION)])
        self.sync(self.registry, "entry", "cam", ["motion"])
        self.assertEqual(len(self.registry.updates), 1)
        self.assertEqual(before, {key: (entry.entity_id, entry.name, entry.options) for key, entry in self.registry.entries.items()})

    async def test_restores_integration_disables_and_honours_empty_lists(self) -> None:
        """An explicit empty care profile withdraws detection sensors only."""
        self.registry.add("motion", Disabler.INTEGRATION)
        self.registry.add("person", Disabler.USER)
        self.registry.add("doorbell")
        self.sync(self.registry, "entry", "cam", ["motion", "person"])
        self.assertEqual(self.registry.entries["cam_motion"].disabled_by, None)
        self.assertEqual(self.registry.entries["cam_person"].disabled_by, Disabler.USER)
        self.sync(self.registry, "entry", "cam", [])
        self.assertEqual(self.registry.entries["cam_motion"].disabled_by, Disabler.INTEGRATION)
        self.assertEqual(self.registry.entries["cam_doorbell"].disabled_by, None)

    async def test_legacy_missing_or_malformed_lists_leave_registry_alone(self) -> None:
        """Older gateways keep their existing event entity behaviour."""
        self.registry.add("person")
        for supported in (None, "motion", {"motion": True}, ("motion",)):
            self.sync(self.registry, "entry", "cam", supported)
        self.assertEqual(self.registry.updates, [])

    async def test_late_profile_is_applied_after_first_inventory_publication(self) -> None:
        """A route resolving later cannot leave stale default sensors enabled."""
        self.registry.add("person")
        listeners, entities = [], []
        coordinator = SimpleNamespace(cameras={"cam": {}}, stations={}, sensors={},
                                      async_add_listener=lambda callback: listeners.append(callback) or (lambda: None))
        entry = SimpleNamespace(entry_id="entry", runtime_data=SimpleNamespace(coordinator=coordinator),
                                async_on_unload=lambda callback: None)
        await self.namespace["async_setup_entry"](None, entry, entities.extend)
        self.assertEqual(len(entities), 11)
        self.assertEqual(self.registry.updates, [])
        coordinator.cameras["cam"]["supportedDetections"] = ["motion"]
        listeners[0]()
        self.assertEqual(self.registry.updates, [("binary_sensor.custom_person", Disabler.INTEGRATION)])
        listeners[0]()
        self.assertEqual(len(self.registry.updates), 1)
        coordinator.cameras["cam"]["supportedDetections"] = ["motion", "person"]
        listeners[0]()
        self.assertEqual(self.registry.updates[-1], ("binary_sensor.custom_person", None))
        listeners[0]()
        self.assertEqual(len(self.registry.updates), 2)


if __name__ == "__main__":
    unittest.main()
