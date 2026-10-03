"""Shared entity support for Eufy Mega Security.

All platforms use the same serial-based device identity and coordinator lookup.
Keeping this mapping here prevents camera, binary-sensor, and person entities
from inventing different names or availability rules for the same physical
camera. The serial is the gateway's stable key, not an entity ID selected by
Home Assistant's UI.
"""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import EufyGatewayCoordinator


class EufyGatewayEntity(CoordinatorEntity[EufyGatewayCoordinator]):
    """Bind camera entities to shared state and one HA device identity.

    Subclasses live for the config entry's platform lifetime and read normalized
    state from the coordinator. This base owns no polling or vendor connection;
    absence from current inventory controls availability.
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the entity to a stable camera serial from gateway state."""
        super().__init__(coordinator)
        self.serial = serial

    @property
    def camera(self) -> dict[str, Any]:
        """Return the latest camera dictionary, or an empty value while absent."""
        return self.coordinator.cameras.get(self.serial, {})

    @property
    def available(self) -> bool:
        """Stay unavailable until the coordinator has data for this camera."""
        return super().available and bool(self.camera)

    @property
    def device_info(self) -> DeviceInfo:
        """Use the camera serial as the stable Home Assistant device identifier."""
        return DeviceInfo(
            identifiers={(DOMAIN, self.serial)},
            name=self.camera.get("name") or f"Eufy camera {self.serial[-4:]}",
            manufacturer="Eufy",
            model=self.camera.get("model"),
            sw_version=self.camera.get("firmware"),
            hw_version=self.camera.get("hardwareVersion"),
        )


class EufyStationEntity(CoordinatorEntity[EufyGatewayCoordinator]):
    """Bind HomeBase entities to shared state and one HA device identity.

    The coordinator owns station lifecycle and transport. Command entities use
    ``set_confirmed_station`` only after the gateway returns read-back state, so
    sibling entities observe one confirmed value rather than optimistic state.
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the entity to a stable HomeBase serial."""
        super().__init__(coordinator)
        self.serial = serial

    @property
    def station(self) -> dict[str, Any]:
        """Return the latest HomeBase dictionary, or an empty value while absent."""
        return self.coordinator.stations.get(self.serial, {})

    @property
    def available(self) -> bool:
        """Remain available while the HomeBase is present in current inventory."""
        return (
            super().available
            and bool(self.station)
            and self.station.get("available", True) is not False
        )

    @property
    def device_info(self) -> DeviceInfo:
        """Use the station serial as the stable Home Assistant device identifier."""
        return DeviceInfo(
            identifiers={(DOMAIN, self.serial)},
            name=self.station.get("name") or f"Eufy HomeBase {self.serial[-4:]}",
            manufacturer="Eufy",
            model=self.station.get("model"),
            sw_version=self.station.get("firmware"),
        )

    def set_confirmed_station(self, station: dict[str, Any]) -> None:
        """Publish the gateway's confirmed command response to all entities."""
        self.coordinator.async_set_station(station)


class EufySecuritySensorEntity(CoordinatorEntity[EufyGatewayCoordinator]):
    """Bind standalone-sensor entities to capability-backed gateway state.

    Instances are created only for capabilities advertised in inventory and
    remain grouped by the physical sensor serial. The coordinator owns refresh
    and event delivery; subclasses only expose already-normalized values.
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the entity to a stable standalone sensor serial."""
        super().__init__(coordinator)
        self.serial = serial

    @property
    def sensor(self) -> dict[str, Any]:
        """Return current normalized sensor state, or an empty value while absent."""
        return self.coordinator.sensors.get(self.serial, {})

    @property
    def available(self) -> bool:
        """Remain available while the sensor exists in current inventory."""
        return (
            super().available
            and bool(self.sensor)
            and self.sensor.get("available", True) is not False
        )

    @property
    def device_info(self) -> DeviceInfo:
        """Register all entities for this physical standalone sensor together."""
        return DeviceInfo(
            identifiers={(DOMAIN, self.serial)},
            name=self.sensor.get("name") or f"Eufy sensor {self.serial[-4:]}",
            manufacturer="Eufy",
            model=self.sensor.get("model"),
        )
