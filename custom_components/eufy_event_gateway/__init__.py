"""Home Assistant entry point for Eufy Mega Security.

This package keeps Home Assistant deliberately thin. The add-on gateway owns
Eufy authentication, event decoding, snapshot persistence, and media sessions.
The integration creates one authenticated HTTP/SSE client and one coordinator,
forwards the camera, detection, HomeBase security, settings, and diagnostic
platforms, and listens for normalized gateway updates. It never stores the
Eufy account password or reimplements a Mega endpoint.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import GatewayClient, GatewayClientError
from .const import CONF_API_TOKEN, DOMAIN, PLATFORMS
from .coordinator import EufyGatewayCoordinator

_LOGGER = logging.getLogger(__name__)
_CAPABILITY_REFRESH_TIMEOUT_SECONDS = 45


@dataclass
class GatewayRuntimeData:
    """Own the coordinator shared by every platform for one config entry.

    Home Assistant creates this container after the first successful gateway
    refresh and releases it when the entry unloads. Platform entities borrow
    the coordinator; they do not create clients or background listeners.
    """

    coordinator: EufyGatewayCoordinator


EufyGatewayConfigEntry = ConfigEntry[GatewayRuntimeData]


async def async_setup_entry(hass: HomeAssistant, entry: EufyGatewayConfigEntry) -> bool:
    """Connect once, publish runtime data, and start the entry's platforms.

    The initial refresh is deliberately completed before platform forwarding so
    entity factories can make capability decisions from a complete inventory.
    The long-lived event listener starts only after those platforms subscribe.
    """
    client = GatewayClient(
        async_get_clientsession(hass),
        entry.data["url"],
        entry.data.get(CONF_API_TOKEN, ""),
    )
    coordinator = EufyGatewayCoordinator(hass, client)
    await coordinator.async_config_entry_first_refresh()
    await _refresh_standalone_alarm_capabilities(coordinator)
    _remove_t817l_battery_entities(hass, coordinator)
    _hide_legacy_event_cameras(hass, coordinator)
    entry.runtime_data = GatewayRuntimeData(coordinator)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    coordinator.start_event_listener()
    return True


async def _refresh_standalone_alarm_capabilities(
    coordinator: EufyGatewayCoordinator,
) -> None:
    """Refresh eligible standalone alarm reads without blocking entry setup.

    The gateway owns route and model eligibility. Home Assistant waits only for
    these bounded reads before platform creation so a reported guard mode can
    create its alarm entity on the same startup. A camera timeout or rejected
    refresh leaves the original cloud inventory intact and setup continues.
    """
    serials = [
        serial
        for serial, camera in coordinator.cameras.items()
        if camera.get("guardModeRefreshSupported") is True
    ]

    async def refresh(serial: str) -> None:
        try:
            async with asyncio.timeout(_CAPABILITY_REFRESH_TIMEOUT_SECONDS):
                camera = await coordinator.client.refresh_camera_capabilities(serial)
        except (GatewayClientError, TimeoutError) as error:
            _LOGGER.warning(
                "Standalone alarm capability refresh failed during setup: %s", error
            )
            return
        coordinator.async_set_camera(camera)

    await asyncio.gather(*(refresh(serial) for serial in serials))


def _hide_legacy_event_cameras(hass: HomeAssistant, coordinator: EufyGatewayCoordinator) -> None:
    """Hide old event-camera tiles once while preserving their stable references.

    Run before concurrent platform setup can register the replacement images.
    Once an image exists, later user visibility choices are left untouched.
    No registry entries, custom names, or automation references are removed.
    """
    registry = er.async_get(hass)
    for serial in coordinator.cameras:
        legacy_id = registry.async_get_entity_id("camera", DOMAIN, f"{serial}_event_image")
        image_id = registry.async_get_entity_id("image", DOMAIN, f"{serial}_event_image")
        if legacy_id is not None and image_id is None:
            legacy = registry.async_get(legacy_id)
            if legacy is not None and legacy.hidden_by is None:
                registry.async_update_entity(legacy_id, hidden_by=er.RegistryEntryHider.INTEGRATION)


def _remove_t817l_battery_entities(
    hass: HomeAssistant, coordinator: EufyGatewayCoordinator
) -> None:
    """Remove entities created from T817L's non-battery compatibility fields.

    Version 0.1.28 treated three fields reported by this USB-C-powered model as
    battery capabilities. Removing only its known unique IDs repairs upgraded
    installations without touching genuine battery cameras or standalone
    sensors.
    """
    registry = er.async_get(hass)
    for serial, camera in coordinator.cameras.items():
        model = camera.get("model")
        if not isinstance(model, str) or not model.upper().startswith("T817L"):
            continue
        for platform, suffix in (
            ("sensor", "battery_level"),
            ("sensor", "battery_health"),
            ("sensor", "battery_temperature"),
            ("binary_sensor", "battery_charging"),
        ):
            entity_id = registry.async_get_entity_id(
                platform, DOMAIN, f"{serial}_{suffix}"
            )
            if entity_id is not None:
                registry.async_remove(entity_id)


async def async_unload_entry(
    hass: HomeAssistant, entry: EufyGatewayConfigEntry
) -> bool:
    """Cancel entry-owned background work and unload all entity platforms."""
    await entry.runtime_data.coordinator.async_shutdown()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_config_entry_device(
    hass: HomeAssistant,
    config_entry: EufyGatewayConfigEntry,
    device_entry: dr.DeviceEntry,
) -> bool:
    """Allow user removal only after a successful refresh proves the device absent.

    The gateway owns account inventory. Home Assistant owns the registry and
    performs the requested deletion after this callback approves it. A failed
    inventory refresh, an unloaded entry, or any matching camera, station, or
    sensor keeps the registry association intact.
    """
    runtime_data = getattr(config_entry, "runtime_data", None)
    if runtime_data is None:
        return False
    identifiers = {
        identifier
        for domain, identifier in device_entry.identifiers
        if domain == DOMAIN
    }
    if not identifiers:
        return False
    coordinator = runtime_data.coordinator
    await coordinator.async_refresh()
    if not coordinator.last_update_success or coordinator.data is None:
        return False
    current_devices = set(coordinator.cameras) | set(coordinator.stations) | set(
        coordinator.sensors
    )
    return identifiers.isdisjoint(current_devices)
