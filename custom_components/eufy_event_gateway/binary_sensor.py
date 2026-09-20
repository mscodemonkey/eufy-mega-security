"""Event, charging, connectivity, and contact sensors for Eufy Mega Security.

The gateway holds transient detection state long enough for an SSE update to
reach Home Assistant. These entities mirror the normalized detection fields and
capability-backed device state; they do not poll Eufy, decode push payloads, or
infer events locally. The coordinator owns updates, while device identity and
availability come from ``entity.py``.
"""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import EufyGatewayConfigEntry
from .const import DOMAIN
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity, EufySecuritySensorEntity, EufyStationEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create capability-backed binary entities as devices enter inventory."""
    coordinator = entry.runtime_data.coordinator
    registry = er.async_get(hass)
    known_cameras: set[str] = set()
    known_stations: set[str] = set()
    known_sensors: set[str] = set()

    def add_new() -> None:
        serials = set(coordinator.cameras) - known_cameras
        if serials:
            known_cameras.update(serials)
            entities = []
            for serial in sorted(serials):
                if not coordinator.cameras[serial].get("doorbellSupported"):
                    stale_entity_id = registry.async_get_entity_id(
                        "binary_sensor", DOMAIN, f"{serial}_doorbell"
                    )
                    if stale_entity_id:
                        registry.async_remove(stale_entity_id)
                entities.extend(
                    [
                        EufyDetectionSensor(coordinator, serial, "motion"),
                        EufyDetectionSensor(coordinator, serial, "person"),
                        EufyDetectionSensor(coordinator, serial, "stranger"),
                        EufyDetectionSensor(coordinator, serial, "pet"),
                        EufyDetectionSensor(coordinator, serial, "vehicle"),
                        EufyDetectionSensor(coordinator, serial, "dog"),
                        EufyDetectionSensor(coordinator, serial, "crying"),
                        EufyDetectionSensor(coordinator, serial, "sound"),
                        EufyDetectionSensor(coordinator, serial, "packageStranded"),
                    ]
                )
                if coordinator.cameras[serial].get("doorbellSupported"):
                    entities.append(
                        EufyDetectionSensor(coordinator, serial, "doorbell")
                    )
                battery = coordinator.cameras[serial].get("battery") or {}
                if "charging" in battery.get("supported", []):
                    entities.append(EufyCameraChargingSensor(coordinator, serial))
            async_add_entities(entities)

        station_serials = set(coordinator.stations) - known_stations
        if station_serials:
            known_stations.update(station_serials)
            entities = []
            for serial in sorted(station_serials):
                station = coordinator.stations[serial]
                if station.get("controlsSupported") is True:
                    entities.append(EufyStationConnectionSensor(coordinator, serial))
                else:
                    entities.append(EufyStationCameraRouteSensor(coordinator, serial))
            async_add_entities(entities)

        sensor_serials = set(coordinator.sensors) - known_sensors
        if sensor_serials:
            known_sensors.update(sensor_serials)
            entities = []
            for serial in sorted(sensor_serials):
                capabilities = coordinator.sensors[serial].get("capabilities", [])
                if "contact" in capabilities:
                    entities.append(
                        EufyStandaloneBinarySensor(coordinator, serial, "contact")
                    )
                if "motion" in capabilities:
                    entities.append(
                        EufyStandaloneBinarySensor(coordinator, serial, "motion")
                    )
            async_add_entities(entities)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyDetectionSensor(EufyGatewayEntity, BinarySensorEntity):
    """Expose one transient gateway detection flag for a camera lifetime.

    The gateway owns event expiry and sends the resulting state over SSE. This
    entity only selects one normalized transient field and never starts
    a camera session to determine whether an event occurred.
    """

    def __init__(
        self, coordinator: EufyGatewayCoordinator, serial: str, kind: str
    ) -> None:
        """Bind the sensor to a camera serial and detection kind."""
        super().__init__(coordinator, serial)
        self.kind = kind
        self._attr_unique_id = f"{serial}_{kind}"
        self._attr_name = {
            "motion": "Motion",
            "person": "Person",
            "doorbell": "Doorbell",
            "stranger": "Stranger",
            "pet": "Pet",
            "vehicle": "Vehicle",
            "dog": "Dog",
            "crying": "Crying",
            "sound": "Sound",
            "packageStranded": "Package stranded",
        }[kind]
        self._attr_device_class = {
            "motion": BinarySensorDeviceClass.MOTION,
            "person": BinarySensorDeviceClass.OCCUPANCY,
            "doorbell": None,
            "stranger": BinarySensorDeviceClass.OCCUPANCY,
            "pet": BinarySensorDeviceClass.OCCUPANCY,
            "vehicle": BinarySensorDeviceClass.OCCUPANCY,
            "dog": BinarySensorDeviceClass.OCCUPANCY,
            "crying": BinarySensorDeviceClass.SOUND,
            "sound": BinarySensorDeviceClass.SOUND,
            "packageStranded": BinarySensorDeviceClass.PROBLEM,
        }[kind]
        if kind == "doorbell":
            self._attr_icon = "mdi:doorbell"

    @property
    def is_on(self) -> bool:
        """Return the current normalized detection flag from coordinator data."""
        field = "doorbellPressed" if self.kind == "doorbell" else f"{self.kind}Detected"
        return bool(self.camera.get(field))


class EufyCameraChargingSensor(EufyGatewayEntity, BinarySensorEntity):
    """Expose gateway-decoded charging state for a camera or doorbell.

    The entity is created only when inventory advertises charging support and
    preserves an unknown state until the gateway has decoded a valid value.
    """

    _attr_name = "Battery charging"
    _attr_device_class = BinarySensorDeviceClass.BATTERY_CHARGING
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create a stable charging entity for one camera."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        BinarySensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_battery_charging"

    @property
    def is_on(self) -> bool | None:
        """Return charging state, preserving unknown when no valid value arrived."""
        value = (self.camera.get("battery") or {}).get("charging")
        return value if isinstance(value, bool) else None


class EufyStandaloneBinarySensor(EufySecuritySensorEntity, BinarySensorEntity):
    """Expose one capability-backed state for a standalone security sensor.

    Contact state remains active until the next settled open/closed event;
    motion state is transient and expires in the gateway. Separate instances
    are created only for capabilities advertised by that sensor.
    """

    def __init__(
        self, coordinator: EufyGatewayCoordinator, serial: str, kind: str
    ) -> None:
        """Bind a capability-backed binary state to one standalone sensor."""
        EufySecuritySensorEntity.__init__(self, coordinator, serial)
        BinarySensorEntity.__init__(self)
        self.kind = kind
        self._attr_unique_id = f"{serial}_{kind}"
        self._attr_name = "Contact" if kind == "contact" else "Motion"
        self._attr_device_class = (
            BinarySensorDeviceClass.OPENING
            if kind == "contact"
            else BinarySensorDeviceClass.MOTION
        )

    @property
    def is_on(self) -> bool | None:
        """Return normalized open or motion state without inventing unknown values."""
        field = "contactOpen" if self.kind == "contact" else "motionDetected"
        value = self.sensor.get(field)
        return value if isinstance(value, bool) else None


class EufyStationConnectionSensor(EufyStationEntity, BinarySensorEntity):
    """Expose HomeBase PPCS reachability independently from inventory presence.

    A station may remain known and therefore have available entities while its
    command channel is disconnected. This diagnostic keeps those two concepts
    separate for dashboards and automations.
    """

    _attr_translation_key = "eufy_station_connection"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create a connectivity diagnostic for one HomeBase."""
        EufyStationEntity.__init__(self, coordinator, serial)
        BinarySensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_connection"

    @property
    def is_on(self) -> bool:
        """Return whether the gateway reports the station command channel connected."""
        return bool(self.station.get("connected"))


class EufyStationCameraRouteSensor(EufyStationEntity, BinarySensorEntity):
    """Expose whether an unverified HomeBase can route child-camera media.

    This diagnostic is intentionally narrower than station connectivity. It
    reports inventory, PPCS, and DSK prerequisites only and does not imply that
    HomeBase state reads or commands are supported.
    """

    _attr_translation_key = "eufy_station_camera_route"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create a child-camera route diagnostic for one discovered HomeBase."""
        EufyStationEntity.__init__(self, coordinator, serial)
        BinarySensorEntity.__init__(self)
        self._attr_unique_id = f"{serial}_camera_route"

    @property
    def is_on(self) -> bool:
        """Return whether child-camera transport prerequisites are ready."""
        return bool(self.station.get("cameraRouteReady"))
