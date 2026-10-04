"""Camera entities backed by retained images and gateway-owned live streams.

The card image is a cheap read of the gateway's last-good JPEG. A live stream
or fresh snapshot is an explicit operation, because waking a battery camera
for every dashboard refresh would waste power and make the UI unreliable. The
entity never contacts Eufy directly: it asks the gateway for retained bytes,
a signed stream path, or a bounded capture/recording action.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

import voluptuous as vol
from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.components.stream.const import CONF_USE_WALLCLOCK_AS_TIMESTAMPS
from homeassistant.const import ATTR_ENTITY_ID, CONF_FILENAME
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.entity_platform import (
    AddEntitiesCallback,
    async_get_current_platform,
)
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers import entity_registry as er

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

CONF_DURATION = "duration"
STREAM_SOURCE_REFRESH_INTERVAL = timedelta(minutes=5)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create cameras now and when a push-only camera first appears."""
    coordinator = entry.runtime_data.coordinator
    known: set[str] = set()
    registry = er.async_get(hass)

    def add_new() -> None:
        serials = set(coordinator.cameras) - known
        if serials:
            known.update(serials)
            entities = [EufyGatewayCamera(coordinator, serial) for serial in sorted(serials)]
            for serial in sorted(serials):
                legacy_id = registry.async_get_entity_id("camera", DOMAIN, f"{serial}_event_image")
                if legacy_id is None:
                    continue

                # Only upgrades retain these hidden compatibility cameras.
                # Entry setup migrates their visibility before platform loading.
                entities.append(EufyGatewayEventImage(coordinator, serial))
            async_add_entities(entities)

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

        # The gateway serves live Annex-B video without container timestamps.
        # Home Assistant needs arrival times so its stream worker can build HLS.
        self.stream_options[CONF_USE_WALLCLOCK_AS_TIMESTAMPS] = True

    async def async_added_to_hass(self) -> None:
        """Start updates and refresh credentials on Home Assistant's cached stream."""
        await super().async_added_to_hass()
        self.async_on_remove(
            async_track_time_interval(
                self.hass,
                self._async_refresh_stream_source,
                STREAM_SOURCE_REFRESH_INTERVAL,
            )
        )

    async def _async_refresh_stream_source(self, now: datetime) -> None:
        """Replace a cached stream URL before its credential expires.

        The gateway checks the signed URL only when a connection opens, so a
        running session does not need it. The new URL is stored for Home
        Assistant's next reconnect instead of passed to ``update_source``,
        which restarts the worker at once and would drop a healthy live view
        and wake the camera again every refresh interval.
        """
        del now
        stream = self.stream
        if stream is None:
            return
        try:
            stream.source = await self.coordinator.client.stream_url(self.serial)
        except GatewayClientError:
            _LOGGER.debug("Stream URL renewal failed, keeping the previous URL")

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
    def available(self) -> bool:
        """Keep retained pictures readable while the gateway is temporarily offline."""
        return bool(self.camera)

    @property
    def supported_features(self) -> CameraEntityFeature:
        """Advertise streaming only when the gateway can control this camera."""
        if self.coordinator.last_update_success and self.camera.get("streamSupported"):
            return CameraEntityFeature.STREAM
        return CameraEntityFeature(0)

    @property
    def is_streaming(self) -> bool:
        """Reflect the gateway's shared stream state in the HA UI."""
        return self.camera.get("stream", {}).get("state") == "streaming"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose reported audio and camera settings without claiming physical behaviour.

        These are cloud configuration values, not live microphone activity or
        proof that a recording contains audio. Missing values remain absent.
        """
        settings = self.camera.get("audioSettings") or {}
        fields = {
            "microphoneEnabled": "reported_microphone_enabled",
            "speakerEnabled": "reported_speaker_enabled",
            "recordingEnabled": "reported_audio_recording_enabled",
            "speakerVolume": "reported_speaker_volume",
        }
        attributes = {
            attribute: settings[field]
            for field, attribute in fields.items()
            if settings.get(field) is not None
        }
        reported = self.camera.get("reportedSettings") or {}
        for field, attribute in (
            ("imageFlipped", "reported_image_flipped"),
            ("statusLedEnabled", "reported_status_indicator_enabled"),
            ("soundDetectionEnabled", "reported_sound_detection_enabled"),
            ("homebaseChimeEnabled", "reported_homebase_chime_enabled"),
            ("mechanicalChimeEnabled", "reported_mechanical_chime_enabled"),
            ("wideDynamicRangeEnabled", "reported_wide_dynamic_range_enabled"),
            ("highCompressionEncoding", "reported_high_compression_encoding"),
            ("recordingAutoStop", "reported_recording_auto_stop"),
            ("solarConnected24h", "reported_solar_connected_24h"),
            ("antiTheftDetectionEnabled", "reported_anti_theft_detection_enabled"),
            ("spotlightEnabled", "reported_spotlight_enabled"),
        ):
            if isinstance(reported.get(field), bool):
                attributes[attribute] = reported[field]
        for field, attribute, maximum in (
            ("chimeVolume", "reported_chime_volume", 100),
            ("doorbellVideoQuality", "reported_doorbell_video_quality", 3),
            ("recordingDurationSeconds", "reported_recording_duration_seconds", 0xFFFFFFFF),
            ("recordingIntervalSeconds", "reported_recording_interval_seconds", 0xFFFFFFFF),
        ):
            value = reported.get(field)
            if type(value) is int and 0 <= value <= maximum:
                attributes[attribute] = value
        mode = reported.get("workingMode")
        if mode in ("Optimal Battery Life", "Optimal Surveillance", "Customize Recording"):
            attributes["reported_working_mode"] = mode
        for field, attribute, allowed in (
            ("soundDetectionSensitivity", "reported_sound_detection_sensitivity", (1, 3, 5)),
            ("soundDetectionType", "reported_sound_detection_type", (1, 2)),
            ("streamingQualityTier", "reported_streaming_quality_tier", (0, 1, 2, 3)),
            ("recordingQualityTier", "reported_recording_quality_tier", (1, 2, 3)),
            ("notificationStyle", "reported_notification_style", (1, 2, 3)),
            ("watermarkMode", "reported_watermark_mode", (0, 1, 2)),
            ("motionSensitivityRaw", "reported_motion_sensitivity_raw", (1, 2, 3, 4, 5, 6, 7)),
        ):
            value = reported.get(field)
            if type(value) is int and value in allowed:
                attributes[attribute] = value
        ringtone = reported.get("ringtoneVolume")
        if type(ringtone) is int and 0 <= ringtone <= 100:
            attributes["reported_ringtone_volume"] = ringtone
        solar = reported.get("solarIntensity")
        if type(solar) in (int, float) and 0 <= solar <= 9007199254740991:
            attributes["reported_solar_intensity"] = solar
        update = self.camera.get("firmwareUpdateAvailable")
        if isinstance(update, bool):
            attributes["reported_firmware_update_available"] = update
        secondary = self.camera.get("firmwareSubVersion")
        if isinstance(secondary, str) and 0 < len(secondary) <= 100:
            attributes["reported_secondary_firmware"] = secondary
        return attributes

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes:
        """Return the retained JPEG without starting a new camera session."""

        # Home Assistant calls this for the card image. It is intentionally a
        # cheap retained-image read and does not wake a sleeping camera.
        return await self.coordinator.image_cache.async_image(
            self.serial, "snapshot",
            lambda: self.coordinator.client.snapshot(self.serial),
        )

    async def stream_source(self) -> str | None:
        """Return a short-lived gateway URL for HA's stream pipeline."""

        # The gateway returns a short-lived signed URL. Home Assistant's media
        # pipeline consumes it without receiving the gateway bearer token.
        if not self.camera.get("streamSupported"):
            return None
        return await self.coordinator.client.stream_url(self.serial)

    async def async_capture_snapshot(self, filename: str) -> None:
        """Wake the camera and save a fresh frame to an allowlisted HA path."""
        if not self.camera.get("streamSupported"):
            raise HomeAssistantError(
                "Fresh snapshot capture is unavailable for this camera"
            )
        if not self.hass.config.is_allowed_path(filename):
            raise HomeAssistantError(
                f"Cannot write snapshot to {filename}. Use a Home Assistant "
                "allowlisted path ending in .jpg"
            )
        try:
            await self.coordinator.client.capture_snapshot(self.serial)
        except GatewayClientError as error:
            raise HomeAssistantError(f"Could not capture snapshot: {error}") from error
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


class EufyGatewayEventImage(EufyGatewayEntity, Camera):
    """Expose the latest event picture without replacing the main camera still.

    One entity lives beside each discovered camera for the config entry
    lifetime. The gateway owns validation and durable retention, while this
    entity performs only authenticated reads and cache-token rotation.
    """

    _attr_translation_key = "event_image"
    _attr_content_type = "image/jpeg"

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create an event-image entity with its own stable unique ID."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        Camera.__init__(self)
        self._attr_unique_id = f"{serial}_event_image"
        self._published_event_image_revision = self._event_image_revision

    @property
    def available(self) -> bool:
        """Keep cached event or fallback pictures readable through gateway outages."""
        return bool(self.camera)

    @property
    def _event_image_revision(self) -> str | None:
        """Invalidate either the event image or its still fallback without mixing revisions."""
        for field in ("eventImage", "snapshot"):
            revision = (self.camera.get(field) or {}).get("revision")
            if isinstance(revision, int):
                return f"{field}:{revision}"
        return None

    @callback
    def _handle_coordinator_update(self) -> None:
        """Rotate the image token after the gateway commits a newer event picture."""
        revision = self._event_image_revision
        if revision != self._published_event_image_revision:
            self._published_event_image_revision = revision
            self.async_update_token()
        super()._handle_coordinator_update()

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes:
        """Return an event picture, retained still fallback, or explicit waiting image."""
        return await self.coordinator.image_cache.async_image(
            self.serial, "event-image",
            lambda: self.coordinator.client.event_image(self.serial),
        )


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
