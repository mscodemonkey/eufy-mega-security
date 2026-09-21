"""Explicit compatibility-report actions for unconfirmed Eufy cameras.

The gateway marks admitted catalogue entries that still need real-device
results. Home Assistant exposes one diagnostic button for those cameras.
Pressing it creates a local, reviewable GitHub handoff and never uploads data
or contacts the project in the background.
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
    """Create help-test actions for admitted cameras awaiting confirmation."""
    coordinator = entry.runtime_data.coordinator
    known: set[str] = set()

    def add_new() -> None:
        serials = {
            serial
            for serial, camera in coordinator.cameras.items()
            if camera.get("catalogueStatus") == "ready_to_test"
        } - known
        if serials:
            known.update(serials)
            async_add_entities(
                EufyCompatibilityReportButton(coordinator, serial)
                for serial in sorted(serials)
            )

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
