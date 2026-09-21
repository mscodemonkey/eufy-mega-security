"""Measurement, diagnostic, and remembered-state sensors for Eufy Mega Security.

The gateway owns normalized camera, HomeBase, and standalone-sensor state. This
platform creates only the entities supported by each inventory record and does
not decode vendor properties or contact Eufy directly. Remembered person state
reports a name only when Eufy marked the detection as recognized, deliberately
leaving generic labels such as ``Someone`` unknown.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, ClassVar

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.const import (
    PERCENTAGE,
    UnitOfInformation,
    UnitOfTemperature,
    UnitOfTime,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from . import EufyGatewayConfigEntry
from .const import DOMAIN, GUARD_MODES
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity, EufySecuritySensorEntity, EufyStationEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create supported measurement and diagnostic entities from inventory."""
    coordinator = entry.runtime_data.coordinator
    known_cameras: set[str] = set()
    known_mode_stations: set[str] = set()
    known_storage_stations: set[str] = set()
    known_sensors: set[str] = set()
    _migrate_storage_display_units(hass, coordinator)

    def add_new() -> None:
        serials = set(coordinator.cameras) - known_cameras
        if serials:
            known_cameras.update(serials)
            entities = []
            for serial in sorted(serials):
                entities.append(EufyRecognizedPersonSensor(coordinator, serial))
                battery = coordinator.cameras[serial].get("battery") or {}
                for field in battery.get("supported", []):
                    if field in ("level", "health", "temperature", "lastChargingDays"):
                        entities.append(
                            EufyCameraBatterySensor(coordinator, serial, field)
                        )
            async_add_entities(entities)

        mode_station_serials = {
            serial
            for serial, station in coordinator.stations.items()
            if station.get("stateReadSupported") is True
        } - known_mode_stations
        if mode_station_serials:
            known_mode_stations.update(mode_station_serials)
            entities = []
            for serial in sorted(mode_station_serials):
                if coordinator.stations[serial].get("controlsSupported") is not True:
                    entities.append(EufyGuardModeSensor(coordinator, serial))
                entities.append(EufyEffectiveModeSensor(coordinator, serial))
            async_add_entities(entities)

        storage_station_serials = {
            serial
            for serial, station in coordinator.stations.items()
            if station.get("controlsSupported") is True
        } - known_storage_stations
        if storage_station_serials:
            known_storage_stations.update(storage_station_serials)
            entities = []
            for serial in sorted(storage_station_serials):
                entities.extend(
                    (
                        EufyStorageSensor(coordinator, serial, "emmc", "totalBytes"),
                        EufyStorageSensor(coordinator, serial, "emmc", "freeBytes"),
                        EufyStorageStatusSensor(coordinator, serial, "emmc"),
                        EufyStorageSensor(coordinator, serial, "hdd", "totalBytes"),
                        EufyStorageSensor(coordinator, serial, "hdd", "freeBytes"),
                        EufyStorageStatusSensor(coordinator, serial, "hdd"),
                    )
                )
            async_add_entities(entities)

        sensor_serials = set(coordinator.sensors) - known_sensors
        if sensor_serials:
            known_sensors.update(sensor_serials)
            entities = []
            for serial in sorted(sensor_serials):
                capabilities = coordinator.sensors[serial].get("capabilities", [])
                if "battery" in capabilities:
                    entities.append(EufyStandaloneBatterySensor(coordinator, serial))
                if "lastSeen" in capabilities:
                    entities.append(EufySensorLastSeen(coordinator, serial))
            async_add_entities(entities)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


def _migrate_storage_display_units(
    hass: HomeAssistant, coordinator: EufyGatewayCoordinator
) -> None:
    """Replace the earlier byte suggestion while preserving user unit choices."""
    registry = er.async_get(hass)
    for serial in coordinator.stations:
        for medium in ("emmc", "hdd"):
            for property_name in ("totalBytes", "freeBytes"):
                unique_id = f"{serial}_{medium}_{property_name}"
                entity_id = registry.async_get_entity_id("sensor", DOMAIN, unique_id)
                if entity_id is None:
                    continue
                registry_entry = registry.async_get(entity_id)
                private_options = (
                    registry_entry.options.get("sensor.private", {})
                    if registry_entry is not None
                    else {}
                )
                if (
                    private_options.get("suggested_unit_of_measurement")
                    != UnitOfInformation.BYTES
                ):
                    continue
                registry.async_update_entity_options(
                    entity_id,
                    "sensor.private",
                    {"suggested_unit_of_measurement": UnitOfInformation.GIGABYTES},
                )


class EufyRecognizedPersonSensor(EufyGatewayEntity, SensorEntity):
    """Expose the last recognized person while retaining event metadata.

    The gateway retains the last detection after its transient binary state
    expires. This entity reads that remembered record and does no recognition
    or fallback naming of its own.
    """

    _attr_name = "Last recognized person"
    _attr_icon = "mdi:face-recognition"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create a stable person sensor for one camera."""
        super().__init__(coordinator, serial)
        self._attr_unique_id = f"{serial}_last_recognized_person"

    @property
    def native_value(self) -> str | None:
        """Return the recognized name, or None for motion/unknown detections."""
        detection = self.camera.get("lastDetection") or {}
        return detection.get("personName") if detection.get("recognized") else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose the normalized event kind, time, and recognition flag."""
        detection = self.camera.get("lastDetection") or {}
        return {
            "detection_kind": detection.get("kind"),
            "detected_at": detection.get("occurredAt"),
            "recognized": bool(detection.get("recognized")),
        }


class EufyCameraBatterySensor(EufyGatewayEntity, SensorEntity):
    """Expose one supported battery measurement for a camera or doorbell.

    A separate entity is created for each reported battery measurement only when
    the gateway advertises that field. Values are already validated and
    normalized before they enter coordinator state.
    """

    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(
        self, coordinator: EufyGatewayCoordinator, serial: str, field: str
    ) -> None:
        """Create one inventory-backed battery measurement."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self.field = field
        self._attr_unique_id = (
            f"{serial}_last_charging_days"
            if field == "lastChargingDays"
            else f"{serial}_battery_{field}"
        )
        if field == "level":
            self._attr_name = "Battery"
            self._attr_device_class = SensorDeviceClass.BATTERY
            self._attr_native_unit_of_measurement = PERCENTAGE
        elif field == "health":
            self._attr_name = "Battery health"
            self._attr_native_unit_of_measurement = PERCENTAGE
            self._attr_icon = "mdi:battery-heart"
            self._attr_entity_category = EntityCategory.DIAGNOSTIC
        elif field == "temperature":
            self._attr_name = "Battery temperature"
            self._attr_device_class = SensorDeviceClass.TEMPERATURE
            self._attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
            self._attr_entity_category = EntityCategory.DIAGNOSTIC
        else:
            self._attr_name = "Days since last charging"
            self._attr_native_unit_of_measurement = UnitOfTime.DAYS
            self._attr_icon = "mdi:battery-clock"
            self._attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def native_value(self) -> float | None:
        """Return the latest validated gateway measurement."""
        value = (self.camera.get("battery") or {}).get(self.field)
        return value if isinstance(value, (int, float)) else None


class EufyStandaloneBatterySensor(EufySecuritySensorEntity, SensorEntity):
    """Expose inventory-backed battery percentage for a standalone sensor.

    The entity exists only when the sensor advertises battery support and reads
    refreshed coordinator state without polling the physical device itself.
    """

    _attr_name = "Battery"
    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create the stable battery entity for one standalone sensor."""
        EufySecuritySensorEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_battery"

    @property
    def native_value(self) -> float | None:
        """Return the latest validated inventory percentage."""
        value = self.sensor.get("batteryLevel")
        return value if isinstance(value, (int, float)) else None


class EufySensorLastSeen(EufySecuritySensorEntity, SensorEntity):
    """Expose the gateway's last verified contact time for a standalone sensor.

    The source remains a serialized timestamp in coordinator state; this entity
    performs only the final conversion required by Home Assistant's timestamp
    device class and leaves malformed or absent values unknown.
    """

    _attr_name = "Last seen"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create a timestamp entity for one standalone sensor."""
        EufySecuritySensorEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_last_seen"

    @property
    def native_value(self) -> datetime | None:
        """Return an aware datetime, or unknown when the gateway has no valid value."""
        value = self.sensor.get("lastSeen")
        return dt_util.parse_datetime(value) if isinstance(value, str) else None


class EufyGuardModeSensor(EufyStationEntity, SensorEntity):
    """Expose a read-only configured mode for a station without proven writes."""

    _attr_translation_key = "eufy_guard_mode_sensor"
    _attr_icon = "mdi:shield-home"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options: ClassVar[list[str]] = list(GUARD_MODES.values())

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create the configured-mode sensor for one read-only HomeBase."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_guard_mode_read_only"

    @property
    def native_value(self) -> str | None:
        """Return the configured Eufy mode reported by the station."""
        value = self.station.get("guardMode")
        return GUARD_MODES.get(value) if isinstance(value, int) else None


class EufyEffectiveModeSensor(EufyStationEntity, SensorEntity):
    """Expose the active HomeBase mode independently of configured policy.

    Schedule and geofencing policies can produce an effective mode different
    from the configured selection. This read-only entity represents the active
    result while the select entity retains the configured policy.
    """

    _attr_translation_key = "eufy_effective_mode_sensor"
    _attr_icon = "mdi:shield-check"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options: ClassVar[list[str]] = list(GUARD_MODES.values())

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create the effective-mode sensor for one HomeBase."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_effective_mode"

    @property
    def native_value(self) -> str | None:
        """Return the Eufy label for the active effective mode."""
        value = self.station.get("effectiveMode")
        return GUARD_MODES.get(value) if isinstance(value, int) else None


class EufyStorageSensor(EufyStationEntity, SensorEntity):
    """Expose total or free capacity for one HomeBase storage medium.

    The gateway reports bytes, while this entity presents decimal gigabytes to
    Home Assistant. Missing HDD or eMMC records remain unknown rather than
    appearing as zero-capacity media.
    """

    _attr_device_class = SensorDeviceClass.DATA_SIZE
    _attr_native_unit_of_measurement = UnitOfInformation.GIGABYTES
    _attr_suggested_display_precision = 2
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(
        self,
        coordinator: EufyGatewayCoordinator,
        serial: str,
        medium: str,
        property_name: str,
    ) -> None:
        """Create a storage capacity sensor for eMMC or HDD."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self.medium = medium
        self.property_name = property_name
        label = "Total" if property_name == "totalBytes" else "Free"
        medium_label = "eMMC" if medium == "emmc" else "HDD"
        self._attr_name = f"{medium_label} {label}"
        self._attr_unique_id = f"{serial}_{medium}_{property_name}"

    @property
    def native_value(self) -> float | None:
        """Return capacity in gigabytes, or unknown when the medium is absent."""
        storage = self.station.get("storage") or {}
        medium = storage.get(self.medium) or {}
        value = medium.get(self.property_name)
        return value / 1_000_000_000 if isinstance(value, (int, float)) else None


class EufyStorageStatusSensor(EufyStationEntity, SensorEntity):
    """Expose the gateway-reported health label for one storage medium.

    This diagnostic shares the station's lifecycle and returns unknown when the
    selected HDD or eMMC record is absent; it does not infer health from free
    capacity or connection state.
    """

    _attr_icon = "mdi:harddisk"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(
        self, coordinator: EufyGatewayCoordinator, serial: str, medium: str
    ) -> None:
        """Create a storage status sensor for eMMC or HDD."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self.medium = medium
        medium_label = "eMMC" if medium == "emmc" else "HDD"
        self._attr_name = f"{medium_label} status"
        self._attr_unique_id = f"{serial}_{medium}_status"

    @property
    def native_value(self) -> str | None:
        """Return the reported storage status, or unknown when absent."""
        storage = self.station.get("storage") or {}
        medium = storage.get(self.medium) or {}
        value = medium.get("status")
        return value if isinstance(value, str) else None
