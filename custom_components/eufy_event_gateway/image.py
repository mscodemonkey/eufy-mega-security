"""Serve retained event pictures as HA images rather than extra cameras.

Each config entry owns the entities through its coordinator. The gateway and
coordinator cache own retained bytes, while HA owns authenticated image delivery.
These entities never start streams or wake cameras and are not camera tiles on
HA's automatically generated Security page.
"""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.image import ImageEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from . import EufyGatewayConfigEntry
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Attach a still-image entity to each current or later-discovered camera."""
    coordinator = entry.runtime_data.coordinator
    known: set[str] = set()

    @callback
    def add_new() -> None:
        serials = set(coordinator.cameras) - known
        if not serials:
            return
        known.update(serials)
        async_add_entities([EufyGatewayRetainedImage(hass, coordinator, serial) for serial in sorted(serials)])

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyGatewayRetainedImage(EufyGatewayEntity, ImageEntity):
    """Expose one camera's last event picture for the config entry lifetime.

    Reported capture times identify pictures, including an ordinary snapshot
    fallback before the first event. Coordinator revisions refresh the image
    without inventing a new capture time or starting a live session.
    """

    _attr_translation_key = "event_image"
    _attr_icon = "mdi:image"
    _attr_content_type = "image/jpeg"

    def __init__(self, hass: HomeAssistant, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind shared state and HA's image delivery without creating vendor IO."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        ImageEntity.__init__(self, hass)
        self._attr_unique_id = f"{serial}_event_image"
        self._revision = self._image_revision()

    @property
    def available(self) -> bool:
        """Retain image access through temporary gateway outages."""
        return bool(self.camera)

    @property
    def image_last_updated(self) -> datetime | None:
        """Use the retained picture's capture time, not the time it was viewed."""
        info = self.camera.get("eventImage") or self.camera.get("snapshot") or {}
        captured = info.get("capturedAt")
        return dt_util.parse_datetime(captured) if isinstance(captured, str) else None

    def _image_revision(self) -> tuple[str, int] | None:
        for field in ("eventImage", "snapshot"):
            revision = (self.camera.get(field) or {}).get("revision")
            if isinstance(revision, int):
                return field, revision
        return None

    @callback
    def _handle_coordinator_update(self) -> None:
        """Refresh HA's image URL when repaired or newly retained bytes arrive."""
        revision = self._image_revision()
        if revision != self._revision:
            self._revision = revision
            self.async_update_token()
        super()._handle_coordinator_update()

    async def async_image(self) -> bytes:
        """Read the event picture with durable same-camera fallback protection."""
        return await self.coordinator.image_cache.async_image(
            self.serial, "event-image",
            lambda: self.coordinator.client.event_image(self.serial),
        )
