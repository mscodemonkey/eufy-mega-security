"""Camera siren entities for Eufy Mega Security.

The gateway owns the PPCS command and passes the requested duration to the
camera. Home Assistant only exposes cameras whose device family has been
proven to accept that command.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.siren import SirenEntity, SirenEntityFeature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity, EufyStationEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create camera and HomeBase sirens when their routes are available."""
    coordinator = entry.runtime_data.coordinator
    known_cameras: set[str] = set()
    known_stations: set[str] = set()

    def add_new() -> None:
        camera_serials = {
            serial
            for serial, camera in coordinator.cameras.items()
            if camera.get("cameraSirenControlSupported") is True
        } - known_cameras
        station_serials = {
            serial
            for serial, station in coordinator.stations.items()
            if station.get("homeBaseSirenControlSupported") is True
        } - known_stations
        entities: list[SirenEntity] = []
        if camera_serials:
            known_cameras.update(camera_serials)
            entities.extend(EufyCameraSiren(coordinator, serial) for serial in sorted(camera_serials))
        if station_serials:
            known_stations.update(station_serials)
            entities.extend(EufyHomeBaseSiren(coordinator, serial) for serial in sorted(station_serials))
        if entities:
            async_add_entities(entities)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyCameraSiren(EufyGatewayEntity, SirenEntity):
    """Expose bounded trigger and explicit stop controls for one camera."""

    _attr_translation_key = "camera_siren"
    _attr_supported_features = SirenEntityFeature.TURN_ON | SirenEntityFeature.TURN_OFF

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the entity to a camera with a proven siren command."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SirenEntity.__init__(self)
        self._attr_unique_id = f"{serial}_siren"

    @property
    def is_on(self) -> bool:
        """Return false because the camera does not expose readable siren state."""
        return False

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Trigger the camera siren for the requested or default five seconds."""
        duration = kwargs.get("duration", 5)
        if not isinstance(duration, int) or isinstance(duration, bool) or duration < 1 or duration > 900:
            raise HomeAssistantError("Camera siren duration must be a whole number from 1 to 900 seconds")
        try:
            await self.coordinator.client.set_camera_siren(self.serial, duration)
        except GatewayClientError as error:
            raise HomeAssistantError(f"Could not trigger camera siren: {error}") from error

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Send the device-side zero-duration stop command."""
        try:
            await self.coordinator.client.set_camera_siren(self.serial, 0)
        except GatewayClientError as error:
            raise HomeAssistantError(f"Could not stop camera siren: {error}") from error


class EufyHomeBaseSiren(EufyStationEntity, SirenEntity):
    """Expose bounded trigger and explicit stop controls for one HomeBase."""

    _attr_translation_key = "homebase_siren"
    _attr_supported_features = SirenEntityFeature.TURN_ON | SirenEntityFeature.TURN_OFF

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the entity to a HomeBase station serial."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SirenEntity.__init__(self)
        self._attr_unique_id = f"{serial}_siren"

    @property
    def is_on(self) -> bool:
        """Return the latest station-reported alarm state when available."""
        return self.station.get("alarmActive") is True

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Trigger the HomeBase siren for the requested or default five seconds."""
        duration = kwargs.get("duration", 5)
        if not isinstance(duration, int) or isinstance(duration, bool) or duration < 1 or duration > 900:
            raise HomeAssistantError("HomeBase siren duration must be a whole number from 1 to 900 seconds")
        try:
            station = await self.coordinator.client.set_station_siren(self.serial, duration)
            self.set_confirmed_station(station)
        except GatewayClientError as error:
            raise HomeAssistantError(f"Could not trigger HomeBase siren: {error}") from error

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Send the station-side zero-duration stop command."""
        try:
            station = await self.coordinator.client.set_station_siren(self.serial, 0)
            self.set_confirmed_station(station)
        except GatewayClientError as error:
            raise HomeAssistantError(f"Could not stop HomeBase siren: {error}") from error
