"""Expose opt-in, confirmed manual camera lights in Home Assistant.

The coordinator owns admission and reported settings. This platform submits
absolute commands through the gateway and publishes independent readback only.
The manual override is separate from motion-driven or physical illumination.
"""
from __future__ import annotations

from typing import Any

from homeassistant.components.light import ColorMode, LightEntity
from homeassistant.exceptions import HomeAssistantError

from .client import GatewayClientError
from .entity import EufyGatewayEntity
from .coordinator import EufyGatewayCoordinator


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    """Add lights only when the gateway admits their exact route and baseline."""
    coordinator = entry.runtime_data.coordinator
    known: set[str] = set()
    known_spotlights: set[str] = set()

    def add_new() -> None:
        spotlights = {serial for serial, camera in coordinator.cameras.items()
                      if camera.get("model") == "T8110"
                      and camera.get("cameraLightControlSupported") is True} - known_spotlights
        known_spotlights.update(spotlights)
        if spotlights:
            async_add_entities([EufySpotlight(coordinator, serial) for serial in sorted(spotlights)])
        serials = {serial for serial, camera in coordinator.cameras.items()
                   if camera.get("manualFloodlightControlSupported") is True} - known
        known.update(serials)
        if serials:
            async_add_entities([EufyManualFloodlight(coordinator, serial) for serial in sorted(serials)])

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyManualFloodlight(EufyGatewayEntity, LightEntity):
    """Control a reported manual override for the owning coordinator's lifetime.

    The gateway owns account checks, exclusive camera access and readback. This
    entity has no motion, brightness, timeout or optimistic-state authority.
    """

    _attr_translation_key = "manual_floodlight"
    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_color_modes = {ColorMode.ONOFF}

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Keep the manual override identity distinct from automatic-light settings."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        LightEntity.__init__(self)
        self._attr_unique_id = f"{serial}_manual_floodlight"

    @property
    def is_on(self) -> bool | None:
        """Return the reported manual override without guessing from motion or defaults."""
        settings = self.camera.get("reportedSettings")
        value = settings.get("manualFloodlightEnabled") if isinstance(settings, dict) else None
        return value if type(value) is bool else None

    @property
    def available(self) -> bool:
        """Require current gateway admission and a readable manual override."""
        return super().available and self.camera.get("manualFloodlightControlSupported") is True and self.is_on is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Describe this setting without claiming a physical lamp-state observation."""
        return {"eufy_control": "manual_floodlight_override"}

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable only the manual override, leaving motion settings unchanged."""
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable only the manual override without promising automatic-light suppression."""
        await self._async_set(False)

    async def _async_set(self, enabled: bool) -> None:
        """Publish only a confirmed value and invalidate an uncertain write."""
        try:
            camera = await self.coordinator.client.set_camera_setting(self.serial, "manualFloodlight", enabled)
            self.coordinator.async_set_camera(camera)
        except GatewayClientError as error:
            if error.code == "outcome_unknown":
                camera = {**self.camera, "reportedSettings": {**(self.camera.get("reportedSettings") or {}), "manualFloodlightEnabled": None}}
                self.coordinator.async_set_camera(camera)
            raise HomeAssistantError(str(error)) from error


class EufySpotlight(EufyGatewayEntity, LightEntity):
    """Expose the C35 manual light using provider-owned confirmation and lifetime.

    The opt-in gateway profile owns account checks and the exclusive session.
    This entity never infers illumination from a command being accepted.
    """

    _attr_translation_key = "spotlight"
    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_color_modes = {ColorMode.ONOFF}

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind a distinct manual-light entity to its camera and coordinator."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        LightEntity.__init__(self)
        self._attr_unique_id = f"{serial}_spotlight"

    @property
    def is_on(self) -> bool | None:
        """Use the reported manual switch, leaving absent or ambiguous values unknown."""
        settings = self.camera.get("reportedSettings")
        value = settings.get("spotlightEnabled") if isinstance(settings, dict) else None
        return value if type(value) is bool else None

    @property
    def available(self) -> bool:
        """Withdraw control when gateway admission or its readable state disappears."""
        return (super().available and self.camera.get("model") == "T8110"
                and self.camera.get("cameraLightControlSupported") is True and self.is_on is not None)

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable the manual spotlight and wait for fresh gateway confirmation."""
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable the manual spotlight without changing motion-light settings."""
        await self._async_set(False)

    async def _async_set(self, enabled: bool) -> None:
        """Keep a failed write unknown until a subsequent report confirms its state."""
        try:
            await self.coordinator.client.set_camera_light(self.serial, enabled)
        except GatewayClientError as error:
            camera = {**self.camera, "reportedSettings": {
                **(self.camera.get("reportedSettings") or {}), "spotlightEnabled": None}}
            self.coordinator.async_set_camera(camera)
            raise HomeAssistantError(str(error)) from error
        await self.coordinator.async_request_refresh()
