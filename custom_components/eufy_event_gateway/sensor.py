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
    SIGNAL_STRENGTH_DECIBELS_MILLIWATT,
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
from .lock import EufyLockBattery
from .guard_mode_options import guard_mode_label, guard_mode_options


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create supported measurement and diagnostic entities from inventory."""
    coordinator = entry.runtime_data.coordinator
    known_cameras: set[str] = set()
    known_camera_signal: set[str] = set()
    known_backup_batteries: set[str] = set()
    known_mode_stations: set[str] = set()
    known_storage_stations: set[str] = set()
    known_sensors: set[str] = set()
    known_locks: set[str] = set()
    registry = er.async_get(hass)
    _migrate_storage_display_units(hass, coordinator)

    def add_new() -> None:
        lock_serials = set(coordinator.locks) - known_locks
        if lock_serials:
            known_locks.update(lock_serials)
            async_add_entities([EufyLockBattery(coordinator, serial) for serial in sorted(lock_serials)])

        signal_serials = {
            serial for serial, camera in coordinator.cameras.items()
            if camera.get("rssi") is not None
        } - known_camera_signal
        if signal_serials:
            known_camera_signal.update(signal_serials)
            async_add_entities([
                EufyCameraSignalStrength(coordinator, serial)
                for serial in sorted(signal_serials)
            ])

        backup_serials = {
            serial for serial, camera in coordinator.cameras.items()
            if "backupLevel" in (camera.get("battery") or {}).get("supported", [])
        } - known_backup_batteries
        if backup_serials:
            known_backup_batteries.update(backup_serials)
            async_add_entities([
                EufyCameraBatterySensor(coordinator, serial, "backupLevel")
                for serial in sorted(backup_serials)
            ])

        for serial, station in coordinator.stations.items():
            if station.get("guardModeControlSupported") is not True:
                continue
            entity_id = registry.async_get_entity_id(
                "sensor", DOMAIN, f"{serial}_guard_mode_read_only"
            )
            if entity_id is not None:
                registry.async_remove(entity_id)

        serials = set(coordinator.cameras) - known_cameras
        if serials:
            known_cameras.update(serials)
            entities = []
            for serial in sorted(serials):
                if coordinator.cameras[serial].get("careMonitor") is not True:
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
                if coordinator.stations[serial].get("guardModeControlSupported") is not True:
                    entities.append(EufyGuardModeSensor(coordinator, serial))
                entities.append(EufyEffectiveModeSensor(coordinator, serial))
            async_add_entities(entities)

        storage_station_serials = {
            serial
            for serial, station in coordinator.stations.items()
            if station.get("storageSupported")
        } - known_storage_stations
        if storage_station_serials:
            known_storage_stations.update(storage_station_serials)
            entities = []
            for serial in sorted(storage_station_serials):
                for medium in coordinator.stations[serial].get(
                    "storageSupported", []
                ):
                    if medium not in ("sd", "emmc", "hdd"):
                        continue
                    entities.extend(
                        (
                            EufyStorageSensor(
                                coordinator, serial, medium, "totalBytes"
                            ),
                            EufyStorageSensor(
                                coordinator, serial, medium, "freeBytes"
                            ),
                            EufyStorageStatusSensor(
                                coordinator, serial, medium
                            ),
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
                if "rssi" in capabilities:
                    entities.append(EufySensorSignalStrength(coordinator, serial))
                if "careDiagnostics" in capabilities:
                    for field in ("roomTemperatureCelsius", "highTemperatureCelsius", "lowTemperatureCelsius", "whiteNoiseVolume", "whiteNoiseTimerRaw", "temperatureMonitoringEnabled", "rtspPublicationEnabled"):
                        entities.append(EufyCareSettingSensor(coordinator, serial, field))
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

    _attr_translation_key = "last_recognized_person"
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


class EufyCameraSignalStrength(EufyGatewayEntity, SensorEntity):
    """Expose inventory-reported camera signal strength as a diagnostic.

    The coordinator owns updates. This entity is created when a validated value
    first arrives, including after discovery, and never estimates signal from
    stream health or copies the parent station's value.
    """

    _attr_translation_key = "signal_strength"
    _attr_device_class = SensorDeviceClass.SIGNAL_STRENGTH
    _attr_native_unit_of_measurement = SIGNAL_STRENGTH_DECIBELS_MILLIWATT
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create one stable, read-only diagnostic entity."""
        super().__init__(coordinator, serial)
        self._attr_unique_id = f"{serial}_rssi"

    @property
    def native_value(self) -> float | None:
        """Return a numeric signal value or unknown when no longer reported."""
        value = self.camera.get("rssi")
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


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
        self._attr_translation_key = {
            "level": "battery",
            "backupLevel": "backup_battery",
            "health": "battery_health",
            "temperature": "battery_temperature",
            "lastChargingDays": "days_since_last_charging",
        }[field]
        if field in ("level", "backupLevel"):
            self._attr_device_class = SensorDeviceClass.BATTERY
            self._attr_native_unit_of_measurement = PERCENTAGE
        elif field == "health":
            self._attr_native_unit_of_measurement = PERCENTAGE
            self._attr_icon = "mdi:battery-heart"
            self._attr_entity_category = EntityCategory.DIAGNOSTIC
        elif field == "temperature":
            self._attr_device_class = SensorDeviceClass.TEMPERATURE
            self._attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
            self._attr_entity_category = EntityCategory.DIAGNOSTIC
        else:
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

    _attr_translation_key = "battery"
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

    _attr_translation_key = "last_seen"
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


class EufySensorSignalStrength(EufySecuritySensorEntity, SensorEntity):
    """Expose the accessory-reported link strength without inventing bars.

    Parameter 1141 is shared by supported contact sensors, motion sensors, and
    keypads. The gateway validates its numeric range and this entity presents
    the retained dBm reading as a diagnostic measurement.
    """

    _attr_translation_key = "signal_strength"
    _attr_device_class = SensorDeviceClass.SIGNAL_STRENGTH
    _attr_native_unit_of_measurement = SIGNAL_STRENGTH_DECIBELS_MILLIWATT
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create a stable signal-strength entity for one accessory."""
        EufySecuritySensorEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_rssi"

    @property
    def native_value(self) -> float | None:
        """Return the latest validated raw dBm value."""
        value = self.sensor.get("rssi")
        return value if isinstance(value, (int, float)) else None


class EufyGuardModeSensor(EufyStationEntity, SensorEntity):
    """Expose inventory-owned mode state without sending security commands.

    The coordinator owns updates for the entity's lifetime. Account-defined
    custom titles use the same validated mapping as writable HomeBase selects.
    """

    _attr_translation_key = "eufy_guard_mode_sensor"
    _attr_icon = "mdi:shield-home"
    _attr_device_class = SensorDeviceClass.ENUM

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create the configured-mode sensor for one read-only station."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_guard_mode_read_only"

    @property
    def options(self) -> list[str]:
        """Return the configured-mode vocabulary for the current station."""
        return list(guard_mode_options(self.station).values())

    @property
    def native_value(self) -> str | None:
        """Return the configured Eufy mode reported by the station."""
        value = self.station.get("guardMode")
        return guard_mode_label(self.station, value)


class EufyEffectiveModeSensor(EufyStationEntity, SensorEntity):
    """Expose the latest reported station mode independently of configured policy.

    The coordinator owns state for this read-only entity. Schedule and geofencing
    can produce a different effective mode. Push-owned NVR observations include
    their report time and become unknown when the receiver loses its connection.
    """

    _attr_translation_key = "eufy_effective_mode_sensor"
    _attr_icon = "mdi:shield-check"
    _attr_device_class = SensorDeviceClass.ENUM

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the entity to one station without owning its transport or controls."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_effective_mode"

    @property
    def native_value(self) -> str | None:
        """Return the Eufy label for the active effective mode."""
        value = self.station.get("effectiveMode")
        return guard_mode_label(self.station, value)

    @property
    def options(self) -> list[str]:
        """Use the station's validated custom names for effective mode too."""
        return list(guard_mode_options(self.station).values())

    @property
    def extra_state_attributes(self) -> dict[str, str] | None:
        """Identify the last device push observation without inferring a live query."""
        reported = self.station.get("effectiveModeReportedAt")
        if isinstance(reported, str):
            return {"state_source": "eufy_push", "last_reported": reported}
        return None


class EufyStorageSensor(EufyStationEntity, SensorEntity):
    """Expose total or free capacity for one HomeBase storage medium.

    The gateway reports bytes, while this entity presents decimal gigabytes to
    Home Assistant. Missing SD, HDD, or eMMC records remain unknown rather than
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
        """Create a storage capacity sensor for one supported medium."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self.medium = medium
        self.property_name = property_name
        medium_label = {"sd": "SD card", "emmc": "eMMC", "hdd": "HDD"}[medium]
        self._attr_translation_key = (
            "storage_total" if property_name == "totalBytes" else "storage_free"
        )
        self._attr_translation_placeholders = {"medium": medium_label}
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
    selected SD, HDD, or eMMC record is absent; it does not infer health from free
    capacity or connection state.
    """

    _attr_icon = "mdi:harddisk"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(
        self, coordinator: EufyGatewayCoordinator, serial: str, medium: str
    ) -> None:
        """Create a storage status sensor for one supported medium."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self.medium = medium
        medium_label = {"sd": "SD card", "emmc": "eMMC", "hdd": "HDD"}[medium]
        self._attr_translation_key = "storage_status"
        self._attr_translation_placeholders = {"medium": medium_label}
        self._attr_unique_id = f"{serial}_{medium}_status"

    @property
    def native_value(self) -> str | None:
        """Return the reported storage status, or unknown when absent."""
        storage = self.station.get("storage") or {}
        medium = storage.get(self.medium) or {}
        value = medium.get("status")
        return value if isinstance(value, str) else None


class EufyCareSettingSensor(EufySecuritySensorEntity, SensorEntity):
    """Expose normalized E21 readings without opening media or inferring room state.

    The gateway owns reported units and freshness. Instances retain their entity
    identity across unit changes and become unavailable when the reading disappears.
    The timer remains a disabled diagnostic because its native units are unproven.
    """

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str, field: str) -> None:
        """Bind one reported setting to the same physical device as the camera."""
        EufySecuritySensorEntity.__init__(self, coordinator, serial)
        SensorEntity.__init__(self)
        self.field = field
        self._attr_unique_id = f"{serial}_care_{field}"
        self._attr_translation_key = {
            "roomTemperatureCelsius": "care_room_temperature", "highTemperatureCelsius": "care_high_temperature",
            "lowTemperatureCelsius": "care_low_temperature", "whiteNoiseVolume": "care_white_noise_volume",
            "whiteNoiseTimerRaw": "care_white_noise_timer_raw", "temperatureMonitoringEnabled": "care_temperature_monitoring",
            "rtspPublicationEnabled": "care_rtsp_publication",
        }[field]
        if field.endswith("Celsius"):
            self._attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
            self._attr_device_class = SensorDeviceClass.TEMPERATURE
        if field != "roomTemperatureCelsius":
            self._attr_entity_category = EntityCategory.DIAGNOSTIC
        if field == "whiteNoiseTimerRaw":
            self._attr_entity_registry_enabled_default = False

    @property
    def available(self) -> bool:
        """Withdraw stale readings when inventory or the care capability disappears."""
        return super().available and "careDiagnostics" in self.sensor.get("capabilities", []) and self.native_value is not None

    @property
    def native_value(self) -> int | float | str | None:
        """Return normalized values without assigning units to the raw native timer."""
        settings = self.sensor.get("careSettings")
        value = settings.get(self.field) if isinstance(settings, dict) else None
        if self.field.endswith("Enabled"):
            return ("on" if value else "off") if type(value) is bool else None
        return value if type(value) in (int, float) else None
