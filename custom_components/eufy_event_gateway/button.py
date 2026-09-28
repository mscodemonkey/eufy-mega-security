"""Stateless camera actions for Eufy Mega Security.

The gateway advertises which cameras accept each verified action. Home
Assistant owns only the button entities, while the gateway validates dynamic
preset occupancy and owns protocol routing. No entity in this platform
pretends that a write-only camera action provides durable state.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urlencode

from homeassistant.components import persistent_notification
from homeassistant.components.button import ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .const import DOMAIN
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity

_ISSUE_URL = "https://github.com/mscodemonkey/eufy-mega-security/issues/new"
_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create capability-backed camera actions as devices are discovered."""
    coordinator = entry.runtime_data.coordinator
    known: set[tuple[str, str]] = set()
    preset_discovered: set[str] = set()
    preset_pending: set[str] = set()

    async def discover_presets(serial: str) -> None:
        """Create buttons only for slots the camera currently marks enabled."""
        try:
            positions = await coordinator.client.camera_preset_positions(serial)
        except GatewayClientError as error:
            _LOGGER.debug("Could not discover camera preset positions: %s", error)
            return
        finally:
            preset_pending.discard(serial)
        preset_discovered.add(serial)
        entities = [
            EufyCameraPresetButton(
                coordinator,
                serial,
                position["index"],
                position["isDefault"],
            )
            for position in positions
            if position["enabled"] is True
        ]
        if entities:
            async_add_entities(entities)

    def add_new() -> None:
        entities: list[ButtonEntity] = []
        for serial, camera in sorted(coordinator.cameras.items()):
            report_key = (serial, "compatibility_report")
            if (
                camera.get("catalogueStatus") == "ready_to_test"
                and report_key not in known
            ):
                known.add(report_key)
                entities.append(EufyCompatibilityReportButton(coordinator, serial))
            if camera.get("timedLightControlSupported") is True:
                for enabled in (True, False):
                    action = "light_on" if enabled else "light_off"
                    light_key = (serial, action)
                    if light_key in known:
                        continue
                    known.add(light_key)
                    entities.append(EufyCameraLightButton(coordinator, serial, enabled))
            for capability, entity_type in (
                ("aiTrackingControlSupported", EufyCameraAiTrackingButton),
                ("autoCruiseControlSupported", EufyCameraAutoCruiseButton),
            ):
                if camera.get(capability) is not True:
                    continue
                for enabled in (True, False):
                    action_key = (serial, f"{capability}_{enabled}")
                    if action_key in known:
                        continue
                    known.add(action_key)
                    entities.append(entity_type(coordinator, serial, enabled))
            if (
                camera.get("presetPositionControlSupported") is True
                and serial not in preset_discovered
                and serial not in preset_pending
            ):
                preset_pending.add(serial)
                entry.async_create_background_task(
                    hass,
                    discover_presets(serial),
                    "Discover Eufy camera presets",
                )
        if entities:
            async_add_entities(entities)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyCompatibilityReportButton(EufyGatewayEntity, ButtonEntity):
    """Prepare a user-reviewed compatibility report for one unconfirmed model."""

    _attr_translation_key = "compatibility_report"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:flask-outline"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind the action to a ready-to-test camera without retaining evidence."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        ButtonEntity.__init__(self)
        self._attr_unique_id = f"{serial}_compatibility_report"

    async def async_press(self) -> None:
        """Create a local notification containing the reviewable GitHub handoff."""
        model = self.camera.get("model")
        safe_model = (
            model.upper()
            if isinstance(model, str) and re.fullmatch(r"T[A-Z0-9-]{3,12}", model.upper())
            else "Unknown model"
        )
        issue_body = f"""## Device

Model: {safe_model}
Connection: <!-- Direct, HomeBase model, or NVR model -->

## Results

- [ ] The device and its entities appeared
- [ ] Motion or detection events updated
- [ ] A fresh snapshot worked
- [ ] Live view worked

Please describe anything that did not work and attach the Eufy Mega Security diagnostics download. Review the file before posting it publicly.
"""
        report_url = f"{_ISSUE_URL}?{urlencode({'title': f'Compatibility report: {safe_model}', 'body': issue_body})}"
        persistent_notification.async_create(
            self.hass,
            (
                f"Thanks for helping test **{safe_model}**. Nothing has been sent. "
                "Please try the device entities, one detection event, a fresh snapshot, and live view. "
                f"Then [download the integration diagnostics](/config/integrations/integration/{DOMAIN}) "
                f"and [review the prefilled GitHub report]({report_url}) before submitting it."
            ),
            title="Help test this Eufy device",
            notification_id=f"{DOMAIN}_compatibility_report",
        )


class EufyCameraLightButton(EufyGatewayEntity, ButtonEntity):
    """Send one timed light action without presenting a persistent switch state.

    One on and one off button live for the config entry's platform lifetime.
    The camera decides when an activated light times out, so this entity never
    guesses whether the physical light is still illuminated.
    """

    def __init__(
        self,
        coordinator: EufyGatewayCoordinator,
        serial: str,
        enabled: bool,
    ) -> None:
        """Bind a stable on or off action to one capability-backed camera."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        ButtonEntity.__init__(self)
        self._enabled = enabled
        action = "on" if enabled else "off"
        self._attr_unique_id = f"{serial}_camera_light_{action}"
        self._attr_translation_key = f"camera_light_{action}"
        self._attr_icon = (
            "mdi:lightbulb-on-outline" if enabled else "mdi:lightbulb-off-outline"
        )

    async def async_press(self) -> None:
        """Ask the gateway to send the verified momentary light command."""
        await self.coordinator.client.set_camera_light(self.serial, self._enabled)


class EufyCameraPresetButton(EufyGatewayEntity, ButtonEntity):
    """Move once to an enabled preset discovered directly from the camera."""

    def __init__(
        self,
        coordinator: EufyGatewayCoordinator,
        serial: str,
        index: int,
        is_default: bool,
    ) -> None:
        """Bind one button to a validated slot without retaining scene data."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        ButtonEntity.__init__(self)
        self._index = index
        self._attr_unique_id = f"{serial}_camera_preset_{index}"
        self._attr_translation_key = (
            "camera_preset_default" if is_default else "camera_preset"
        )
        if not is_default:
            self._attr_translation_placeholders = {"number": str(index)}
        self._attr_icon = (
            "mdi:home-map-marker" if is_default else "mdi:camera-marker-outline"
        )

    async def async_press(self) -> None:
        """Send one movement action and never retry an ambiguous acknowledgement."""
        try:
            await self.coordinator.client.select_camera_preset_position(
                self.serial, self._index
            )
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not move to camera preset: {error}"
            ) from error


class EufyCameraAiTrackingButton(EufyGatewayEntity, ButtonEntity):
    """Expose physically verified AI-tracking actions without claiming state."""

    def __init__(
        self,
        coordinator: EufyGatewayCoordinator,
        serial: str,
        enabled: bool,
    ) -> None:
        """Bind one enable or disable action to a verified T817L route."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        ButtonEntity.__init__(self)
        self._enabled = enabled
        action = "on" if enabled else "off"
        self._attr_unique_id = f"{serial}_camera_ai_tracking_{action}"
        self._attr_translation_key = f"camera_ai_tracking_{action}"
        self._attr_icon = "mdi:target-account" if enabled else "mdi:target"

    async def async_press(self) -> None:
        """Send one physically verified AI-tracking action through the gateway."""
        try:
            await self.coordinator.client.set_camera_ai_tracking(
                self.serial, self._enabled
            )
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change AI tracking: {error}"
            ) from error


class EufyCameraAutoCruiseButton(EufyGatewayEntity, ButtonEntity):
    """Expose physically verified cruise actions without claiming state."""

    def __init__(
        self,
        coordinator: EufyGatewayCoordinator,
        serial: str,
        enabled: bool,
    ) -> None:
        """Bind one enable or disable action to a verified T817L route."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        ButtonEntity.__init__(self)
        self._enabled = enabled
        action = "on" if enabled else "off"
        self._attr_unique_id = f"{serial}_camera_auto_cruise_{action}"
        self._attr_translation_key = f"camera_auto_cruise_{action}"
        self._attr_icon = (
            "mdi:camera-control" if enabled else "mdi:camera-off-outline"
        )

    async def async_press(self) -> None:
        """Send one physically verified automatic-cruise action."""
        try:
            await self.coordinator.client.set_camera_auto_cruise(
                self.serial, self._enabled
            )
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change automatic cruise: {error}"
            ) from error
