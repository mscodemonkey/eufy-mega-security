"""Camera entities backed by retained images and gateway-owned live streams.

The card image is a cheap read of the gateway's last-good JPEG. A live stream
or fresh snapshot is an explicit operation, because waking a battery camera
for every dashboard refresh would waste power and make the UI unreliable. The
entity never contacts Eufy directly: it asks the gateway for retained bytes,
a signed stream path, or a bounded capture/recording action.
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import voluptuous as vol
from homeassistant.components.camera import (
    Camera,
    CAMERA_STREAM_SOURCE_TIMEOUT,
    CameraEntityFeature,
    async_request_stream,
)
from homeassistant.components.stream.const import CONF_USE_WALLCLOCK_AS_TIMESTAMPS
from homeassistant.const import ATTR_ENTITY_ID, CONF_FILENAME
from homeassistant.core import HomeAssistant, SupportsResponse, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.entity_platform import (
    AddEntitiesCallback,
    async_get_current_platform,
)
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.network import get_url
from homeassistant.util import dt as dt_util

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .coordinator import EufyGatewayCoordinator
from .entity import EufyGatewayEntity
from .const import CONF_SHORT_HLS_IDLE, CONF_NATIVE_VIDEO, DOMAIN
from .playback_diagnostics import serialize_stream

if TYPE_CHECKING:
    from homeassistant.components.stream import Stream
    from homeassistant.components.stream.core import StreamOutput

_LOGGER = logging.getLogger(__name__)

CONF_DURATION = "duration"
STREAM_SOURCE_REFRESH_INTERVAL = timedelta(minutes=5)


def _cloud_day_window(day: str, zone: Any) -> tuple[int, int, int]:
    """Use true local midnights, resolving a gap's offset at its converted instant."""
    try:
        if type(day) is not str or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", day) is None or zone is None:
            raise ValueError
        selected = date.fromisoformat(day)
        if not 2000 <= selected.year <= 2100:
            raise ValueError
        following = selected + timedelta(days=1)
        start = int(datetime(selected.year, selected.month, selected.day, tzinfo=zone, fold=0).timestamp())
        end = int(datetime(following.year, following.month, following.day, tzinfo=zone, fold=0).timestamp())
        if not 0 <= start < end <= 2**53 - 1 or end - start > 26 * 3600:
            raise ValueError
        offset = _cloud_local_offset(start, zone)
    except (ValueError, TypeError, OverflowError):
        raise HomeAssistantError("Invalid cloud metadata date or time zone") from None
    return start, end, offset


def _cloud_month_offset(month: str, zone: Any) -> int:
    """Keep the month hint offset fixed at its first local midnight."""
    if type(month) is not str or re.fullmatch(r"[0-9]{4}-[0-9]{2}", month) is None:
        raise HomeAssistantError("Invalid cloud metadata month")
    return _cloud_day_window(month + "-01", zone)[2]


def _cloud_local_offset(timestamp: int, zone: Any) -> int:
    """Return seconds east of UTC without loading a zone in the event loop."""
    delta = datetime.fromtimestamp(timestamp, zone).utcoffset()
    if delta is None:
        raise ValueError
    offset = int(delta.total_seconds())
    if abs(offset) > 50400 or offset % 60:
        raise ValueError
    return offset


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
            entities = [
                EufyGatewayCamera(
                    coordinator, serial,
                    short_hls_idle=entry.options.get(CONF_SHORT_HLS_IDLE) is True,
                    native_video=entry.options.get(CONF_NATIVE_VIDEO) is True,
                )
                for serial in sorted(serials)
            ]
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
        "play_audio",
        {vol.Required(CONF_FILENAME): cv.string},
        "async_play_audio",
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
    platform.async_register_entity_service(
        "get_stream_url",
        None,
        "async_get_stream_url",
        supports_response=SupportsResponse.ONLY,
    )

    platform.async_register_entity_service(
        "list_cloud_recordings",
        {vol.Required("day"): cv.string},
        "async_list_cloud_recordings",
        supports_response=SupportsResponse.ONLY,
    )
    platform.async_register_entity_service(
        "get_cloud_recording_dates",
        {vol.Required("month"): cv.string},
        "async_get_cloud_recording_dates",
        supports_response=SupportsResponse.ONLY,
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

    def __init__(
        self, coordinator: EufyGatewayCoordinator, serial: str,
        *, short_hls_idle: bool = False, native_video: bool = False,
    ) -> None:
        """Bind playback options for this entity until the next entry reload."""
        EufyGatewayEntity.__init__(self, coordinator, serial)
        Camera.__init__(self)
        self._attr_unique_id = f"{serial}_camera"
        self._published_snapshot_revision = self._snapshot_revision
        self._short_hls_idle = short_hls_idle
        self._native_video = native_video
        self._hls_idle_stream: Stream | None = None
        self._stream_source_refreshing = False
        self._cloud_metadata_busy = False

        # Raw Annex-B needs arrival timestamps. MPEG-TS already supplies a
        # shared video/audio clock, which must survive Home Assistant's remux.
        self.stream_options[CONF_USE_WALLCLOCK_AS_TIMESTAMPS] = (
            self._native_video or self.camera.get("liveAudioSupported") is not True
        )

    def playback_diagnostic(self) -> dict[str, Any]:
        """Describe cached HA playback without requesting a URL or waking a camera.

        Only model/type and allowlisted observations leave this boundary. A
        failed observation must not prevent the rest of a diagnostics download.
        """
        try:
            model = self.camera.get("model")
            device_type = self.camera.get("deviceType")
            return {
                **serialize_stream(self.stream),
                "model": model if isinstance(model, str) and re.fullmatch(r"T[0-9A-Z]{3,15}", model) else None,
                "device_type": device_type if type(device_type) is int and 0 <= device_type <= 65535 else None,
                "native_video": bool(self._native_video),
                "short_hls_idle": bool(self._short_hls_idle),
            }
        except Exception:
            return {"unavailable": True}

    async def async_list_cloud_recordings(self, day: str) -> dict[str, Any]:
        """Return activity times only, leaving media access to explicit Diagnostics."""
        if self._cloud_metadata_busy:
            raise HomeAssistantError("Cloud metadata request already in progress")
        self._cloud_metadata_busy = True
        try:
            start, end, offset = _cloud_day_window(day, dt_util.get_default_time_zone())
            try:
                result = await self.coordinator.client.cloud_recordings(self.serial, start, end, offset)
            except GatewayClientError as error:
                raise HomeAssistantError(str(error)) from None
            return {"day": day, "time_zone": self.hass.config.time_zone, "utc_offset_seconds": offset,
                    "window_start": start, "window_end": end, "recordings": result["records"],
                    "truncated": result["truncated"], "metadata_only": True}
        finally:
            self._cloud_metadata_busy = False

    async def async_get_cloud_recording_dates(self, month: str) -> dict[str, Any]:
        """Return unconfirmed day hints without starting media or refreshing inventory."""
        if self._cloud_metadata_busy:
            raise HomeAssistantError("Cloud metadata request already in progress")
        self._cloud_metadata_busy = True
        try:
            offset = _cloud_month_offset(month, dt_util.get_default_time_zone())
            try:
                result = await self.coordinator.client.cloud_recording_dates(self.serial, month, offset)
            except GatewayClientError as error:
                raise HomeAssistantError(str(error)) from None
            return {"month": month, "time_zone": self.hass.config.time_zone, "utc_offset_seconds": offset,
                    "days": result["days"], "hint_only": True}
        finally:
            self._cloud_metadata_busy = False

    async def async_create_stream(self) -> Stream | None:
        """Start the HLS startup deadline, with an optional shorter idle timeout.

        HA owns the stream, viewer traffic, timers and output cleanup. Wrapping
        this instance's public provider factory avoids creating an unwanted HLS
        output for a recording. Start HA's HLS timer before any segment arrives
        even when the optional timeout is off, so a failed startup cannot leave
        retries running indefinitely.
        Recorders, explicit timeouts and preload keep HA's own behaviour. The
        entry reload replaces this camera on opt-out.
        """
        cached = self.stream
        stream = await super().async_create_stream()
        if stream is None:
            return stream
        if stream is cached and not stream.outputs() and not stream.dynamic_stream_settings.preload_stream and not self._stream_source_refreshing:
            self._stream_source_refreshing = True
            try:
                source = await asyncio.wait_for(
                    self._async_stream_url(),
                    timeout=CAMERA_STREAM_SOURCE_TIMEOUT,
                )
                if self.hass is not None and self.stream is stream:
                    stream.source = source
            except (GatewayClientError, asyncio.TimeoutError):
                _LOGGER.debug("Stream URL renewal failed, keeping the previous URL")
            finally:
                self._stream_source_refreshing = False
        if stream is self._hls_idle_stream:
            return stream
        add_provider = stream.add_provider

        def add_output(fmt: str, timeout: int | None = None) -> StreamOutput:
            """Arm the startup deadline when a consumer requests ordinary HLS."""
            provider = add_provider(
                fmt,
                timeout=(
                    60
                    if self._short_hls_idle and fmt == "hls" and timeout is None
                    else timeout
                ),
            )
            if fmt == "hls" and timeout is None:
                provider.idle_timer.start()
            return provider

        stream.add_provider = add_output
        self._hls_idle_stream = stream
        return stream

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
        """Renew reconnect credentials only while a stream has a consumer.

        The gateway checks the signed URL only when a connection opens, so a
        running session does not need it. The new URL is stored for Home
        Assistant's next reconnect instead of passed to ``update_source``,
        which restarts the worker at once and would drop a healthy live view
        and wake the camera again every refresh interval.
        """
        del now
        stream = self.stream
        if self.hass is None or stream is None or self._stream_source_refreshing:
            return
        if not stream.outputs() and not stream.dynamic_stream_settings.preload_stream:
            return
        self._stream_source_refreshing = True
        try:
            source = await self._async_stream_url()
            if self.hass is not None and self.stream is stream and (
                stream.outputs() or stream.dynamic_stream_settings.preload_stream
            ):
                stream.source = source
        except GatewayClientError:
            _LOGGER.debug("Stream URL renewal failed, keeping the previous URL")
        finally:
            self._stream_source_refreshing = False

    @property
    def _snapshot_revision(self) -> int | None:
        """Return the gateway revision used to invalidate HA's image proxy."""
        revision = (self.camera.get("snapshot") or {}).get("revision")
        return revision if isinstance(revision, int) else None

    @callback
    def _handle_coordinator_update(self) -> None:
        """Publish fresher retained-image state without invalidating stream workers.

        Snapshot revisions are atomic retained-media commits. The camera entity's
        access token also authenticates Home Assistant's stream endpoint, so it
        must remain stable while an idle worker can retain and retry that URL.
        Coordinator updates still publish the new revision and retained bytes.
        """
        revision = self._snapshot_revision
        if revision != self._published_snapshot_revision:
            self._published_snapshot_revision = revision
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
            ("streamingQualityTier", "reported_streaming_quality_tier", (0, 1, 2, 3, 4) if self.camera.get("model") == "T8416" and self.camera.get("nvrViewOptions") else (0, 1, 2, 3)),
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

        # Inventory can admit AAC after entity construction. Home Assistant
        # reads these options after obtaining this source, so choose its clock
        # from the same current capability that selects the gateway transport.
        self.stream_options[CONF_USE_WALLCLOCK_AS_TIMESTAMPS] = (
            self._native_video or self.camera.get("liveAudioSupported") is not True
        )
        return await self._async_stream_url()

    async def _async_stream_url(self) -> str:
        """Select the same source profile for initial open and both renewals."""
        if self._native_video:
            return await self.coordinator.client.stream_url(self.serial, native=True)
        return await self.coordinator.client.stream_url(self.serial)

    async def async_get_stream_url(self) -> dict[str, str]:
        """Start Home Assistant's HLS provider and return its temporary URL.

        Home Assistant owns the external access token and clears it after the
        stream provider becomes idle. The gateway's private hostname and bearer
        token stay behind the existing camera stream boundary.
        """
        if not self.camera.get("streamSupported"):
            raise HomeAssistantError(
                "Live stream URL generation is unavailable for this camera"
            )
        path = await async_request_stream(self.hass, self.entity_id, "hls")
        return {
            "url": f"{get_url(self.hass)}{path}",
            "content_type": "application/vnd.apple.mpegurl",
        }

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

    async def async_play_audio(self, filename: str) -> None:
        """Play a short native AAC file from a Home Assistant allowlisted path."""
        if self.camera.get("talkbackSupported") is not True:
            raise HomeAssistantError("Speaker playback is unavailable for this camera")
        if not self.hass.config.is_allowed_path(filename):
            raise HomeAssistantError("Speaker audio must use a Home Assistant allowlisted path")
        try:
            data = await self.hass.async_add_executor_job(_read_speaker_audio, filename)
            await self.coordinator.client.play_audio(self.serial, data)
        except (GatewayClientError, OSError, ValueError) as error:
            raise HomeAssistantError(f"Could not play speaker audio: {error}") from error

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


def _read_speaker_audio(filename: str) -> bytes:
    """Read at most one bounded clip, leaving all caller-owned files untouched."""
    with open(filename, "rb") as source:
        data = source.read(320_001)
    if not data or len(data) > 320_000:
        raise ValueError("Speaker audio exceeds its size limit")
    return data
