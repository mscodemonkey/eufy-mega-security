"""Confirmed camera switch controls for Eufy Mega Security.

The gateway owns protocol writes and cloud readback. This platform creates a
switch only when a camera reports the corresponding setting and has a complete
control route, then publishes state only from the confirmed gateway response.
"""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity
from .preferences import camera_preference_value


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create reported camera switches as supported devices enter inventory."""
    coordinator = entry.runtime_data.coordinator
    known_preferences: set[tuple[str, str]] = set()
    known_enabled: set[str] = set()
    known_motion: set[str] = set()
    known_audio_recording: set[str] = set()
    known_auto_night_vision: set[str] = set()

    def add_new() -> None:
        for serial, camera in coordinator.cameras.items():
            for name in ("microphone", "speaker", "imageFlipped", "preRecording", "soundDetection"):
                key = (serial, name)
                if key not in known_preferences and camera_preference_value(camera, name) is not None:
                    known_preferences.add(key)
                    async_add_entities([EufyCameraPreferenceSwitch(coordinator, serial, name)])
        serials = {
            serial
            for serial, camera in coordinator.cameras.items()
            if camera.get("enableControlSupported") is True
            and isinstance(camera.get("enabled"), bool)
        } - known_enabled
        if serials:
            known_enabled.update(serials)
            async_add_entities(
                EufyCameraEnabledSwitch(coordinator, serial)
                for serial in sorted(serials)
            )
        motion_serials = {
            serial
            for serial, camera in coordinator.cameras.items()
            if camera.get("motionDetectionControlSupported") is True
            and isinstance(camera.get("motionDetectionEnabled"), bool)
        } - known_motion
        if motion_serials:
            known_motion.update(motion_serials)
            async_add_entities(
                EufyCameraMotionSwitch(coordinator, serial)
                for serial in sorted(motion_serials)
            )
        audio_serials = {
            serial
            for serial, camera in coordinator.cameras.items()
            if camera.get("audioRecordingControlSupported") is True
            and isinstance(camera.get("audioSettings"), dict)
            and isinstance(camera["audioSettings"].get("recordingEnabled"), bool)
        } - known_audio_recording
        if audio_serials:
            known_audio_recording.update(audio_serials)
            async_add_entities(
                EufyAudioRecordingSwitch(coordinator, serial)
                for serial in sorted(audio_serials)
            )
        auto_night_vision_serials = {
            serial
            for serial, camera in coordinator.cameras.items()
            if camera.get("autoNightVisionControlSupported") is True
            and isinstance(camera.get("autoNightVisionEnabled"), bool)
        } - known_auto_night_vision
        if auto_night_vision_serials:
            known_auto_night_vision.update(auto_night_vision_serials)
            async_add_entities(
                EufyAutoNightVisionSwitch(coordinator, serial)
                for serial in sorted(auto_night_vision_serials)
            )

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyCameraEnabledSwitch(EufyGatewayEntity, SwitchEntity):
    """Expose one camera's reported and confirmed master enablement state."""

    _attr_translation_key = "camera_enabled"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the switch to a camera with a verified control route."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SwitchEntity.__init__(self)
        self._attr_unique_id = f"{serial}_camera_enabled"

    @property
    def is_on(self) -> bool | None:
        """Return the latest camera-reported enablement state."""
        value = self.camera.get("enabled")
        return value if isinstance(value, bool) else None

    async def async_turn_on(self, **kwargs: object) -> None:
        """Enable the camera and publish only confirmed state."""
        await self._async_set_enabled(True)

    async def async_turn_off(self, **kwargs: object) -> None:
        """Disable the camera and publish only confirmed state."""
        await self._async_set_enabled(False)

    async def _async_set_enabled(self, enabled: bool) -> None:
        try:
            camera = await self.coordinator.client.set_camera_enabled(
                self.serial, enabled
            )
            self.coordinator.async_set_camera(camera)
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change camera enablement: {error}"
            ) from error


class EufyCameraMotionSwitch(EufyGatewayEntity, SwitchEntity):
    """Expose the persistent camera motion-detection setting."""

    _attr_translation_key = "camera_motion_detection"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the switch to a camera with verified motion control."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SwitchEntity.__init__(self)
        self._attr_unique_id = f"{serial}_camera_motion_detection"

    @property
    def is_on(self) -> bool | None:
        """Return the latest camera-reported motion setting."""
        value = self.camera.get("motionDetectionEnabled")
        return value if isinstance(value, bool) else None

    async def async_turn_on(self, **kwargs: object) -> None:
        """Enable camera motion detection and publish confirmed state."""
        await self._async_set_motion(True)

    async def async_turn_off(self, **kwargs: object) -> None:
        """Disable camera motion detection and publish confirmed state."""
        await self._async_set_motion(False)

    async def _async_set_motion(self, enabled: bool) -> None:
        try:
            camera = await self.coordinator.client.set_camera_motion_detection(
                self.serial, enabled
            )
            self.coordinator.async_set_camera(camera)
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change camera motion detection: {error}"
            ) from error


class EufyAudioRecordingSwitch(EufyGatewayEntity, SwitchEntity):
    """Expose the recorded-audio setting, with confirmed state owned by the gateway."""

    _attr_translation_key = "camera_audio_recording"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the switch to a camera with verified recorded-audio control."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SwitchEntity.__init__(self)
        self._attr_unique_id = f"{serial}_camera_audio_recording"

    @property
    def is_on(self) -> bool | None:
        """Return the latest camera-reported recorded-audio setting."""
        settings = self.camera.get("audioSettings")
        value = settings.get("recordingEnabled") if isinstance(settings, dict) else None
        return value if isinstance(value, bool) else None

    async def async_turn_on(self, **kwargs: object) -> None:
        """Enable audio recording and publish confirmed state."""
        await self._async_set_audio_recording(True)

    async def async_turn_off(self, **kwargs: object) -> None:
        """Disable audio recording and publish confirmed state."""
        await self._async_set_audio_recording(False)

    async def _async_set_audio_recording(self, enabled: bool) -> None:
        try:
            camera = await self.coordinator.client.set_camera_audio_recording(
                self.serial, enabled
            )
            self.coordinator.async_set_camera(camera)
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change audio recording: {error}"
            ) from error


class EufyAutoNightVisionSwitch(EufyGatewayEntity, SwitchEntity):
    """Expose a doorbell's reported Auto night vision setting."""

    _attr_translation_key = "auto_night_vision"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the switch to a doorbell with a confirmed control route."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SwitchEntity.__init__(self)
        self._attr_unique_id = f"{serial}_auto_night_vision"

    @property
    def is_on(self) -> bool | None:
        """Return the latest doorbell-reported Auto night vision state."""
        value = self.camera.get("autoNightVisionEnabled")
        return value if isinstance(value, bool) else None

    async def async_turn_on(self, **kwargs: object) -> None:
        """Enable Auto night vision and publish only confirmed state."""
        await self._async_set_auto_night_vision(True)

    async def async_turn_off(self, **kwargs: object) -> None:
        """Disable Auto night vision and publish only confirmed state."""
        await self._async_set_auto_night_vision(False)

    async def _async_set_auto_night_vision(self, enabled: bool) -> None:
        try:
            camera = await self.coordinator.client.set_camera_night_vision(
                self.serial, 1 if enabled else 0
            )
            self.coordinator.async_set_camera(camera)
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change Auto night vision: {error}"
            ) from error


class EufyCameraPreferenceSwitch(EufyGatewayEntity, SwitchEntity):
    """Expose one admitted preference for this camera's coordinator lifetime.

    The gateway owns validation and state confirmation. Instances keep only the
    selected preference name and never publish optimistic state.
    """

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str, name: str) -> None:
        """Bind one supported preference to its camera."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        SwitchEntity.__init__(self)
        self.preference = name
        self._attr_unique_id = f"{serial}_preference_{name}"
        self._attr_translation_key = f"camera_{name}"

    @property
    def available(self) -> bool:
        """Hide stale control admission when topology or reported state changes."""
        return super().available and camera_preference_value(self.camera, self.preference) is not None

    @property
    def is_on(self) -> bool | None:
        """Return confirmed state, preserving unknown values."""
        value = camera_preference_value(self.camera, self.preference)
        return bool(value) if value is not None else None

    async def async_turn_on(self, **kwargs: object) -> None:
        """Enable the admitted preference and publish confirmed state."""
        await self._async_set(1)

    async def async_turn_off(self, **kwargs: object) -> None:
        """Disable the admitted preference and publish confirmed state."""
        await self._async_set(0)

    async def _async_set(self, value: int) -> None:
        try:
            camera = await self.coordinator.client.set_camera_preference(self.serial, self.preference, value)
            self.coordinator.async_set_camera(camera)
        except GatewayClientError as error:
            raise HomeAssistantError(f"Could not change camera preference: {error}") from error
