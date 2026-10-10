"""Camera and HomeBase selection controls for Eufy Mega Security.

The coordinator owns normalized device state, while these entities map Home
Assistant labels to gateway command values. Selection changes are published
from confirmed gateway responses and never represent optimistic local state.
"""

from __future__ import annotations

from typing import Any, ClassVar

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .const import ALARM_TONES, DOMAIN, GUARD_MODES
from .coordinator import EufyGatewayCoordinator
from .preferences import camera_preference_value
from .entity import EufyGatewayEntity, EufyStationEntity


NIGHT_VISION_MODE_KEYS = {
    "Off": "off",
    "Colour": "colour",
    "Infrared": "infrared",
    "Infrared on": "infrared_on",
    "Spotlight": "spotlight",
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create reported night-vision and managed HomeBase selects."""
    coordinator = entry.runtime_data.coordinator
    known_preferences: set[tuple[str, str]] = set()

    def add_preferences() -> None:
        for serial, camera in coordinator.cameras.items():
            for name in ("watermark", "recordingQuality"):
                key = (serial, name)
                if key not in known_preferences and camera_preference_value(camera, name) is not None:
                    known_preferences.add(key)
                    async_add_entities([EufyCameraPreferenceSelect(coordinator, serial, name)])

    add_preferences()
    entry.async_on_unload(coordinator.async_add_listener(add_preferences))
    registry = er.async_get(hass)
    known_stations: set[str] = set()
    known_night_vision: set[str] = set()
    known_streaming_quality: set[str] = set()

    def add_new() -> None:
        for serial, camera in coordinator.cameras.items():
            if camera.get("autoNightVisionControlSupported") is not True:
                continue
            obsolete_unique_id = f"{serial}_night_vision"
            for entity in er.async_entries_for_config_entry(registry, entry.entry_id):
                if (
                    entity.domain == "select"
                    and entity.platform == DOMAIN
                    and entity.unique_id == obsolete_unique_id
                ):
                    registry.async_remove(entity.entity_id)
        serials = {
            serial
            for serial, station in coordinator.stations.items()
            if station.get("guardModeControlSupported") is True
        } - known_stations
        if serials:
            known_stations.update(serials)
            entities = []
            for serial in sorted(serials):
                entities.append(EufyGuardModeSelect(coordinator, serial))
                if coordinator.stations[serial].get("controlsSupported") is True:
                    entities.append(EufyAlarmToneSelect(coordinator, serial))
            async_add_entities(entities)
        camera_serials = {
            serial
            for serial, camera in coordinator.cameras.items()
            if camera.get("nightVisionControlSupported") is True
            and camera.get("nightVisionMode") in _night_vision_modes(camera)
        } - known_night_vision
        if camera_serials:
            known_night_vision.update(camera_serials)
            async_add_entities(
                EufyNightVisionSelect(coordinator, serial)
                for serial in sorted(camera_serials)
            )

        quality_serials = {
            serial
            for serial, camera in coordinator.cameras.items()
            if camera.get("streamingQualityControlSupported") is True
            and isinstance(camera.get("reportedSettings"), dict)
            and type(camera["reportedSettings"].get("streamingQualityTier")) is int
            and camera["reportedSettings"].get("streamingQualityTier")
            in _streaming_quality_modes(camera)
        } - known_streaming_quality
        if quality_serials:
            known_streaming_quality.update(quality_serials)
            async_add_entities(
                EufyStreamingQualitySelect(coordinator, serial)
                for serial in sorted(quality_serials)
            )

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyNightVisionSelect(EufyGatewayEntity, SelectEntity):
    """Expose reported night-vision modes for provider-supported camera routes."""

    _attr_translation_key = "camera_night_vision"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the select to a camera with a confirmed control route."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SelectEntity.__init__(self)
        self._attr_unique_id = f"{serial}_night_vision"

    @property
    def current_option(self) -> str | None:
        """Return the camera-reported night-vision mode."""
        mode = self.camera.get("nightVisionMode")
        return _night_vision_modes(self.camera).get(mode) if isinstance(mode, int) else None

    @property
    def options(self) -> list[str]:
        """Return only the night modes this camera reports it can use."""
        return list(_night_vision_modes(self.camera).values())

    async def async_select_option(self, option: str) -> None:
        """Set the mode and publish it only after cloud readback confirms it."""
        mode = next(
            (value for value, label in _night_vision_modes(self.camera).items() if label == option),
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


def _night_vision_modes(camera: dict[str, Any]) -> dict[int, str]:
    """Return the camera-specific value and label pairs supplied by the gateway."""
    raw_modes = camera.get("nightVisionModes")
    if not isinstance(raw_modes, list):
        return {}
    modes: dict[int, str] = {}
    for raw_mode in raw_modes:
        if not isinstance(raw_mode, dict):
            continue
        value = raw_mode.get("value")
        name = raw_mode.get("name")
        if (
            isinstance(value, int)
            and not isinstance(value, bool)
            and isinstance(name, str)
            and name in NIGHT_VISION_MODE_KEYS
        ):
            modes[value] = NIGHT_VISION_MODE_KEYS[name]
    return modes


class EufyStreamingQualitySelect(EufyGatewayEntity, SelectEntity):
    """Expose an owned camera's live-quality preference using gateway-confirmed state.

    The coordinator owns state and discovery. This entity never changes recorded
    quality or assumes a resolution until a fresh gateway response confirms it.
    """

    _attr_translation_key = "camera_streaming_quality"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the select to one camera admitted by its provider."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SelectEntity.__init__(self)
        self._attr_unique_id = f"{serial}_streaming_quality"

    @property
    def current_option(self) -> str | None:
        """Return the fresh reported preference rather than an inferred video resolution."""
        settings = self.camera.get("reportedSettings")
        quality = settings.get("streamingQualityTier") if isinstance(settings, dict) else None
        if not isinstance(quality, int) or isinstance(quality, bool):
            return None
        return _streaming_quality_modes(self.camera).get(quality)

    @property
    def options(self) -> list[str]:
        """Return only the exact model's gateway-supplied native choices."""
        return list(_streaming_quality_modes(self.camera).values())

    async def async_select_option(self, option: str) -> None:
        """Publish the new preference only after the gateway confirms fresh readback."""
        quality = next(
            (value for value, label in _streaming_quality_modes(self.camera).items() if label == option),
            None,
        )
        if quality is None:
            raise HomeAssistantError(f"Unsupported streaming quality: {option}")
        try:
            camera = await self.coordinator.client.set_camera_streaming_quality(
                self.serial, quality
            )
            self.coordinator.async_set_camera(camera)
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change streaming quality: {error}"
            ) from error


def _streaming_quality_modes(camera: dict[str, Any]) -> dict[int, str]:
    """Validate exact native names before translating model-specific choices."""
    names = {
        "Auto": "auto", "HD (720P)": "hd",
        "Full HD (1080P)": "full_hd", "2K": "2k",
        "Medium": "medium", "High": "high",
    }
    raw_modes = camera.get("streamingQualityModes")
    if not isinstance(raw_modes, list):
        return {}
    modes: dict[int, str] = {}
    for mode in raw_modes:
        if not isinstance(mode, dict):
            continue
        value, name = mode.get("value"), mode.get("name")
        if (
            isinstance(value, int)
            and not isinstance(value, bool)
            and 0 <= value <= 3
            and isinstance(name, str)
            and name in names
        ):
            modes[value] = names[name]
    return modes


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


class EufyCameraPreferenceSelect(EufyGatewayEntity, SelectEntity):
    """Expose admitted native choices with confirmed state owned by the gateway."""

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str, name: str) -> None:
        """Bind a reviewed enum to one camera, preserving its native numeric values."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SelectEntity.__init__(self)
        self.preference = name
        self._attr_unique_id = f"{serial}_preference_{name}"
        self._values = [0, 1, 2] if name == "watermark" else [2, 3]
        self._attr_options = ["off", "timestamp", "timestamp_logo"] if name == "watermark" else ["medium", "high"]
        self._attr_translation_key = "camera_watermark" if name == "watermark" else "camera_recording_quality"

    @property
    def available(self) -> bool:
        """Require a current gateway preference route and readable state."""
        return super().available and self.current_option is not None

    @property
    def current_option(self) -> str | None:
        """Map only a known native value to its corresponding choice."""
        value = camera_preference_value(self.camera, self.preference)
        return self._attr_options[self._values.index(value)] if value in self._values else None

    async def async_select_option(self, option: str) -> None:
        """Publish a choice only after the gateway confirms it on the camera."""
        if option not in self._attr_options:
            raise HomeAssistantError("Unknown camera preference option")
        try:
            camera = await self.coordinator.client.set_camera_preference(self.serial, self.preference, self._values[self._attr_options.index(option)])
            self.coordinator.async_set_camera(camera)
        except GatewayClientError as error:
            raise HomeAssistantError(f"Could not change camera preference: {error}") from error
