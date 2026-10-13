"""Exercise coordinator device-name synchronization across registry API versions.

The tests own synthetic Home Assistant modules and registry entries. The
coordinator consumes those stubs without opening a gateway or mutating a real
Home Assistant device registry.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock


class _DataUpdateCoordinator:
    """Provide the generic base needed to load the production coordinator."""

    @classmethod
    def __class_getitem__(cls, _item: object) -> type[_DataUpdateCoordinator]:
        """Return the stub class for the coordinator's generic base expression."""
        return cls


def _load_coordinator(registry: object) -> type:
    """Load the production coordinator against one synthetic registry."""
    homeassistant = ModuleType("homeassistant")
    core = ModuleType("homeassistant.core")
    core.HomeAssistant = object
    helpers = ModuleType("homeassistant.helpers")
    device_registry = ModuleType("homeassistant.helpers.device_registry")
    device_registry.async_get = lambda _hass: registry
    update_coordinator = ModuleType("homeassistant.helpers.update_coordinator")
    update_coordinator.DataUpdateCoordinator = _DataUpdateCoordinator
    update_coordinator.UpdateFailed = RuntimeError
    package = ModuleType("custom_components.eufy_event_gateway")
    package.__path__ = []
    client = ModuleType("custom_components.eufy_event_gateway.client")
    client.GatewayClient = object
    client.GatewayClientError = RuntimeError
    const = ModuleType("custom_components.eufy_event_gateway.const")
    const.DOMAIN = "eufy_event_gateway"
    image_cache = ModuleType("custom_components.eufy_event_gateway.image_cache")
    image_cache.CameraImageCache = object
    modules = {
        "homeassistant": homeassistant,
        "homeassistant.core": core,
        "homeassistant.helpers": helpers,
        "homeassistant.helpers.device_registry": device_registry,
        "homeassistant.helpers.update_coordinator": update_coordinator,
        "custom_components.eufy_event_gateway": package,
        "custom_components.eufy_event_gateway.client": client,
        "custom_components.eufy_event_gateway.const": const,
        "custom_components.eufy_event_gateway.image_cache": image_cache,
    }
    previous = {name: sys.modules.get(name) for name in modules}
    sys.modules.update(modules)
    try:
        path = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/coordinator.py"
        spec = importlib.util.spec_from_file_location(
            "custom_components.eufy_event_gateway.coordinator_registry_test", path
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.EufyGatewayCoordinator
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


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
