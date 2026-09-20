"""Confirmed camera enablement controls for Eufy Mega Security.

The gateway owns protocol writes and cloud readback. This platform creates a
switch only when a camera reports an enablement value and has a complete
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


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create enablement switches as supported cameras enter inventory."""
    coordinator = entry.runtime_data.coordinator
    known_enabled: set[str] = set()
    known_motion: set[str] = set()

    def add_new() -> None:
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
