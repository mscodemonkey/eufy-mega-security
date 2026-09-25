"""Stateless actions for Eufy compatibility reports and timed camera lights.

The gateway advertises which cameras need compatibility evidence and which
wall-light families accept the verified momentary light command. Home
Assistant owns only the button entities. The gateway owns command routing and
the camera firmware owns its automatic light timeout.
"""

from __future__ import annotations

import re
from urllib.parse import urlencode

from homeassistant.components import persistent_notification
from homeassistant.components.button import ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import EufyGatewayConfigEntry
from .const import DOMAIN
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity

_ISSUE_URL = "https://github.com/mscodemonkey/eufy-mega-security/issues/new"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create capability-backed report and timed-light actions."""
    coordinator = entry.runtime_data.coordinator
    known: set[tuple[str, str]] = set()

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
            if camera.get("timedLightControlSupported") is not True:
                continue
            for enabled in (True, False):
                action = "light_on" if enabled else "light_off"
                light_key = (serial, action)
                if light_key in known:
                    continue
                known.add(light_key)
                entities.append(EufyCameraLightButton(coordinator, serial, enabled))
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
