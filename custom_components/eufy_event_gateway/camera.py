"""Camera entities backed by retained images and gateway-owned live streams.

The card image is a cheap read of the gateway's last-good JPEG. A live stream
or fresh snapshot is an explicit operation, because waking a battery camera
for every dashboard refresh would waste power and make the UI unreliable. The
entity never contacts Eufy directly: it asks the gateway for retained bytes,
a signed stream path, or a bounded capture/recording action.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import voluptuous as vol
from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.const import ATTR_ENTITY_ID, CONF_FILENAME
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.entity_platform import (
    AddEntitiesCallback,
    async_get_current_platform,
)

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity

CONF_DURATION = "duration"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create cameras now and when a push-only camera first appears."""
    coordinator = entry.runtime_data.coordinator
    known: set[str] = set()

    def add_new() -> None:
        serials = set(coordinator.cameras) - known
        if serials:
            known.update(serials)
            async_add_entities(
                EufyGatewayCamera(coordinator, serial) for serial in sorted(serials)
            )

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))

    platform = async_get_current_platform()
    platform.async_register_entity_service(
        "capture_snapshot",
        {vol.Required(CONF_FILENAME): cv.string},
        "async_capture_snapshot",
    )
    platform.async_register_entity_service(
        "record_clip",
        {
            vol.Required(CONF_FILENAME): cv.string,
            vol.Optional(CONF_DURATION, default=15): vol.All(
                vol.Coerce(int), vol.Range(min=1, max=120)
            ),
        },
        "async_record_clip",
    )


class EufyGatewayCamera(EufyGatewayEntity, Camera):
    """Represent one camera with retained imagery and explicit media actions.

    The entity lives with a camera inventory record and reads shared stream
    state from the coordinator. The gateway owns camera wake-up, PPCS sessions,
    media retention, and signed stream access; Home Assistant owns destination
    path authorization and the final atomic recording write.
    """

    _attr_name = None
    _attr_content_type = "image/jpeg"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create the entity with a stable serial-derived unique ID."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        Camera.__init__(self)
        self._attr_unique_id = f"{serial}_camera"
        self._published_snapshot_revision = self._snapshot_revision

    @property
    def _snapshot_revision(self) -> int | None:
        """Return the gateway revision used to invalidate HA's image proxy."""
        revision = (self.camera.get("snapshot") or {}).get("revision")
        return revision if isinstance(revision, int) else None

    @callback
    def _handle_coordinator_update(self) -> None:
        """Publish a new image URL after a fresher retained still is committed.

        Snapshot revisions are atomic retained-media commits. Rotating the token
        for every revision keeps event-driven stills visible even when a stream
        is active, while the published revision prevents duplicate rotations.
        """
        revision = self._snapshot_revision
        if revision != self._published_snapshot_revision:
            self._published_snapshot_revision = revision
            self.async_update_token()
        super()._handle_coordinator_update()

    @property
    def supported_features(self) -> CameraEntityFeature:
        """Advertise streaming only when the gateway can control this camera."""
        if self.camera.get("streamSupported"):
            return CameraEntityFeature.STREAM
        return CameraEntityFeature(0)

    @property
    def is_streaming(self) -> bool:
        """Reflect the gateway's shared stream state in the HA UI."""
        return self.camera.get("stream", {}).get("state") == "streaming"

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        """Return the retained JPEG without starting a new camera session."""

        # Home Assistant calls this for the card image. It is intentionally a
        # cheap retained-image read and does not wake a sleeping camera.
        try:
            return await self.coordinator.client.snapshot(self.serial)
        except GatewayClientError:
            return None

    async def stream_source(self) -> str | None:
        """Return a short-lived gateway URL for HA's stream pipeline."""

        # The gateway returns a short-lived signed URL. Home Assistant's media
        # pipeline consumes it without receiving the gateway bearer token.
        if not self.camera.get("streamSupported"):
            return None
        return await self.coordinator.client.stream_url(self.serial)

    async def async_capture_snapshot(self, filename: str) -> None:
        """Wake the camera, wait for a fresh frame, and save it through HA."""
        if not self.camera.get("streamSupported"):
            raise HomeAssistantError(
                "Fresh snapshot capture is unavailable for this camera"
            )
        await self.coordinator.client.capture_snapshot(self.serial)
        await self.hass.services.async_call(
            "camera",
            "snapshot",
            {ATTR_ENTITY_ID: self.entity_id, CONF_FILENAME: filename},
            blocking=True,
        )

    async def async_record_clip(self, filename: str, duration: int) -> None:
        """Request a bounded MP4 and replace the destination only when complete."""
        if not self.camera.get("streamSupported"):
            raise HomeAssistantError("Clip recording is unavailable for this camera")
        if not self.hass.config.is_allowed_path(filename):
            raise HomeAssistantError(
                f"Cannot write recording to {filename}; no access to path"
            )
        try:
            data = await self.coordinator.client.record_clip(self.serial, duration)
            await self.hass.async_add_executor_job(_atomic_write, filename, data)
        except (GatewayClientError, OSError) as error:
            raise HomeAssistantError(f"Could not record clip: {error}") from error


def _atomic_write(filename: str, data: bytes) -> None:
    """Replace a recording only after the complete MP4 has been written."""
    target = Path(filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=target.parent,
        prefix=f".{target.name}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(descriptor, "wb") as temporary_file:
            temporary_file.write(data)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_name, target)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
