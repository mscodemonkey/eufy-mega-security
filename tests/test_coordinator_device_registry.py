"""Exercise coordinator device-name synchronization across registry API versions.

The tests own synthetic Home Assistant modules and registry entries. The
coordinator consumes those stubs without opening a gateway or mutating a real
Home Assistant device registry.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


def _load_coordinator(registry: object) -> type:
    """Load actual metadata methods without importing unrelated HA components."""
    import ast
    from typing import Any

    path = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/coordinator.py"
    tree = ast.parse(path.read_text())
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EufyGatewayCoordinator")
    methods = [node for node in owner.body if isinstance(node, ast.FunctionDef) and node.name in {"_sync_device_names", "_sync_device_name"}]
    namespace = {"Any": Any, "dr": SimpleNamespace(async_get=lambda hass: registry), "DOMAIN": "eufy_event_gateway"}
    exec(compile(ast.Module(body=methods, type_ignores=[]), str(path), "exec"), namespace)
    return type("MetadataCoordinator", (), {node.name: namespace[node.name] for node in methods})


def _coordinator(coordinator_type: type) -> object:
    """Build only the state used by the synchronous name update boundary."""
    coordinator = coordinator_type.__new__(coordinator_type)
    coordinator.hass = object()
    coordinator.config_entry = SimpleNamespace(entry_id="owned-entry")
    return coordinator


def test_device_name_sync_uses_scoped_lookup_when_available() -> None:
    """Prefer the current config-entry-scoped registry lookup."""
    device = SimpleNamespace(id="device", name="Old")
    registry = SimpleNamespace(
        async_get_device_by_identifier=Mock(return_value=device),
        async_get_device=Mock(),
        async_update_device=Mock(),
    )
    coordinator_type = _load_coordinator(registry)

    coordinator_type._sync_device_name(_coordinator(coordinator_type), "serial", "New")

    registry.async_get_device_by_identifier.assert_called_once_with(
        ("eufy_event_gateway", "serial"), "owned-entry"
    )
    registry.async_get_device.assert_not_called()
    registry.async_update_device.assert_called_once_with("device", name="New")


def test_device_name_sync_falls_back_without_cross_entry_update() -> None:
    """Use the legacy lookup but refuse a device owned by another config entry."""
    foreign = SimpleNamespace(
        id="foreign", name="Old", config_entry_id="foreign-entry"
    )
    registry = SimpleNamespace(
        async_get_device=Mock(return_value=foreign), async_update_device=Mock()
    )
    coordinator_type = _load_coordinator(registry)

    coordinator_type._sync_device_name(_coordinator(coordinator_type), "serial", "New")

    registry.async_get_device.assert_called_once_with(
        identifiers={("eufy_event_gateway", "serial")}
    )
    registry.async_update_device.assert_not_called()


def test_child_parent_sync_is_scoped_and_retries_after_parent_registration() -> None:
    """Late HomeBase registration links the sensor without overwriting user choices."""
    child = SimpleNamespace(id="child", name="Sensor", via_device_id=None, name_by_user="My choice")
    parent = SimpleNamespace(id="base", via_device_id=None)
    entries = {"sensor": child}
    registry = SimpleNamespace(
        async_get_device_by_identifier=Mock(side_effect=lambda key, entry: entries.get(key[1])),
        async_update_device=Mock(),
    )
    owner = _coordinator(_load_coordinator(registry))
    data = {"stations": {"station": {"name": None}},
            "sensors": {"sensor": {"name": "Sensor", "stationSerial": "station"}}}
    owner._sync_device_names(data)
    registry.async_update_device.assert_not_called()
    entries["station"] = parent
    owner._sync_device_names(data)
    registry.async_update_device.assert_called_once_with("child", via_device_id="base")
    assert child.name_by_user == "My choice"
    assert all(call.args[1] == "owned-entry" for call in registry.async_get_device_by_identifier.call_args_list)


def test_parent_sync_rejects_foreign_missing_self_and_nested_parent() -> None:
    """Legacy lookups never attach another entry or form a parent cycle."""
    child = SimpleNamespace(id="child", name="Sensor", config_entry_id="owned-entry", via_device_id="existing")
    parent = SimpleNamespace(id="base", config_entry_id="other-entry", via_device_id=None)
    registry = SimpleNamespace(
        async_get_device=Mock(side_effect=lambda identifiers: child if ("eufy_event_gateway", "sensor") in identifiers else parent),
        async_update_device=Mock(),
    )
    owner = _coordinator(_load_coordinator(registry))
    for identifier in (None, "", "sensor", "x" * 129, "station"):
        owner._sync_device_name("sensor", "Sensor", parent_serial=identifier)
    registry.async_update_device.assert_not_called()
    parent.config_entry_id = "owned-entry"
    parent.via_device_id = "child"
    owner._sync_device_name("sensor", "Sensor", parent_serial="station")
    registry.async_update_device.assert_not_called()
    parent.via_device_id = None
    owner._sync_device_name("sensor", "Sensor", parent_serial="station")
    registry.async_update_device.assert_called_once_with("child", via_device_id="base")


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: str | None) -> unittest.TestSuite:
    """Include function regressions in the repository's unittest discovery gate."""
    tests.addTests(unittest.FunctionTestCase(value) for name, value in globals().items() if name.startswith("test_") and callable(value))
    return tests
