"""Camera and HomeBase selection controls for Eufy Mega Security.

The coordinator owns normalized device state, while these entities map Home
Assistant labels to gateway command values. Selection changes are published
from confirmed gateway responses and never represent optimistic local state.
"""

from __future__ import annotations

from typing import ClassVar

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .const import ALARM_TONES, GUARD_MODES, NIGHT_VISION_MODES
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity, EufyStationEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create reported night-vision and managed HomeBase selects."""
    coordinator = entry.runtime_data.coordinator
    known_stations: set[str] = set()
    known_night_vision: set[str] = set()

    def add_new() -> None:
        serials = {
            serial
            for serial, station in coordinator.stations.items()
            if station.get("controlsSupported") is True
        } - known_stations
        if serials:
            known_stations.update(serials)
            entities = []
            for serial in sorted(serials):
                entities.extend(
                    (
                        EufyGuardModeSelect(coordinator, serial),
                        EufyAlarmToneSelect(coordinator, serial),
                    )
                )
            async_add_entities(entities)
        camera_serials = {
            serial
            for serial, camera in coordinator.cameras.items()
            if camera.get("nightVisionControlSupported") is True
            and camera.get("nightVisionMode") in NIGHT_VISION_MODES
        } - known_night_vision
        if camera_serials:
            known_night_vision.update(camera_serials)
            async_add_entities(
                EufyNightVisionSelect(coordinator, serial)
                for serial in sorted(camera_serials)
            )

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyNightVisionSelect(EufyGatewayEntity, SelectEntity):
    """Expose night-vision modes reported by a HomeBase-attached camera."""

    _attr_translation_key = "camera_night_vision"
    _attr_options: ClassVar[list[str]] = list(NIGHT_VISION_MODES.values())

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the select to a camera with a confirmed control route."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SelectEntity.__init__(self)
        self._attr_unique_id = f"{serial}_night_vision"

    @property
    def current_option(self) -> str | None:
        """Return the camera-reported night-vision mode."""
        mode = self.camera.get("nightVisionMode")
        return NIGHT_VISION_MODES.get(mode) if isinstance(mode, int) else None

    async def async_select_option(self, option: str) -> None:
        """Set the mode and publish it only after cloud readback confirms it."""
        mode = next(
            (value for value, label in NIGHT_VISION_MODES.items() if label == option),
            None,
        )
        if mode is None:
            raise HomeAssistantError(f"Unsupported night-vision mode: {option}")
        try:
            camera = await self.coordinator.client.set_camera_night_vision(
                self.serial, mode
            )
            self.coordinator.async_set_camera(camera)
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change night-vision mode: {error}"
            ) from error


class EufyGuardModeSelect(EufyStationEntity, SelectEntity):
    """Expose the configured Eufy policy for one HomeBase.

    This entity intentionally reports the selected policy, including Schedule
    and Geofencing. The separate effective-mode sensor reports the mode that is
    active after those policies have been evaluated.
    """

    _attr_translation_key = "eufy_guard_mode_select"
    _attr_options: ClassVar[list[str]] = list(GUARD_MODES.values())

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create a configured guard-mode select for one HomeBase."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SelectEntity.__init__(self)
        self._attr_unique_id = f"{serial}_guard_mode"

    @property
    def current_option(self) -> str | None:
        """Return the configured policy, not the effective scheduled mode."""
        mode = self.station.get("guardMode")
        return GUARD_MODES.get(mode) if isinstance(mode, int) else None

    async def async_select_option(self, option: str) -> None:
        """Set a guard policy and publish it only after gateway confirmation."""
        mode = next(
            (value for value, label in GUARD_MODES.items() if label == option), None
        )
        if mode is None:
            raise HomeAssistantError(f"Unsupported HomeBase guard mode: {option}")
        try:
            self.set_confirmed_station(
                await self.coordinator.client.set_station_guard_mode(self.serial, mode)
            )
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change HomeBase guard mode: {error}"
            ) from error


class EufyAlarmToneSelect(EufyStationEntity, SelectEntity):
    """Expose and command the confirmed alarm sound for one HomeBase.

    The entity shares coordinator-owned station state with the other HomeBase
    controls and updates that state only from the gateway command response.
    """

    _attr_translation_key = "eufy_alarm_tone_select"
    _attr_options: ClassVar[list[str]] = list(ALARM_TONES.values())

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create an alarm-tone select for one HomeBase."""
        EufyStationEntity.__init__(self, coordinator, serial)
        SelectEntity.__init__(self)
        self._attr_unique_id = f"{serial}_alarm_tone"

    @property
    def current_option(self) -> str | None:
        """Return the confirmed alarm tone label."""
        tone = self.station.get("alarmTone")
        return ALARM_TONES.get(tone) if isinstance(tone, int) else None

    async def async_select_option(self, option: str) -> None:
        """Set the alarm tone and publish it only after gateway confirmation."""
        tone = next(
            (value for value, label in ALARM_TONES.items() if label == option), None
        )
        if tone is None:
            raise HomeAssistantError(f"Unsupported HomeBase alarm tone: {option}")
        try:
            self.set_confirmed_station(
                await self.coordinator.client.set_station_alarm_tone(self.serial, tone)
            )
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change HomeBase alarm tone: {error}"
            ) from error
