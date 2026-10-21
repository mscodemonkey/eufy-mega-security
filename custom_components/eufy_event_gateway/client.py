"""Authenticated HTTP and SSE client for the local Eufy Mega Security gateway.

Home Assistant talks only to this client. It validates the gateway's JSON
shapes, translates HTTP and transport failures into integration exceptions,
keeps the bearer token in request headers, and parses the SSE stream into
normalized dictionaries. It does not know how Mega login, push notifications,
PPCS packets, or camera media work inside the gateway process.
"""

from __future__ import annotations

import calendar
import json
import re
from urllib.parse import quote, urlencode, urlsplit, unquote, parse_qsl
from collections.abc import AsyncIterator
from typing import Any

from aiohttp import ClientError, ClientResponseError, ClientSession, ClientTimeout


def _cloud_offset_valid(value: Any) -> bool:
    """Admit only whole-minute UTC offsets, including negative offsets."""
    return type(value) is int and abs(value) <= 50400 and value % 60 == 0


def _cloud_month_valid(value: Any) -> bool:
    """Reject coerced or non-ASCII calendar inputs before an HTTP request."""
    return (type(value) is str and re.fullmatch(r"[0-9]{4}-[0-9]{2}", value) is not None
            and 2000 <= int(value[:4]) <= 2100 and 1 <= int(value[5:]) <= 12)


class GatewayClientError(Exception):
    """Report a gateway failure with optional HTTP status and fixed command code."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        """Retain structured failure facts without requiring callers to parse prose."""
        super().__init__(message)
        self.status = status
        self.code = code


class GatewayAuthenticationError(GatewayClientError):
    """Distinguish a rejected gateway token from general connectivity failures."""


class GatewayClient:
    """Provide the integration's sole HTTP and SSE boundary to the gateway.

    One instance is owned by a config entry's coordinator and uses Home
    Assistant's shared HTTP session for its entire lifetime. It validates the
    portions of gateway responses consumed by entities and never handles Eufy
    account credentials or vendor protocol payloads.
    """

    def __init__(
        self, session: ClientSession, base_url: str, api_token: str = ""
    ) -> None:
        """Create a client from HA's shared HTTP session and gateway settings."""
        self._session = session
        self.base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_token}"} if api_token else {}

    async def cloud_recordings(self, serial: str, start: int, end: int, offset: int) -> dict[str, Any]:
        """Read one local day's metadata, dropping vendor identities and media references."""
        if (type(serial) is not str or not serial or type(start) is not int
                or type(end) is not int or not 0 <= start < end <= 2**53 - 1
                or end - start > 26 * 3600 or not _cloud_offset_valid(offset)):
            raise GatewayClientError("Invalid cloud metadata request")
        query = urlencode({"start": start, "end": end, "timezone_offset": offset, "count": 1000})
        payload = await self._cloud_metadata_request(f"/api/cameras/{quote(serial, safe='')}/cloud-history?{query}")
        if (not isinstance(payload, dict) or set(payload) != {"records", "mediaPlaybackAvailable"}
                or payload["mediaPlaybackAvailable"] is not False or not isinstance(payload["records"], list)
                or len(payload["records"]) > 1000):
            raise GatewayClientError("Gateway returned invalid cloud metadata")
        seen: set[str] = set()
        rows: list[tuple[int, int, str, bool]] = []
        for row in payload["records"]:
            if (not isinstance(row, dict) or type(row.get("id")) is not str
                    or not 1 <= len(row["id"]) <= 128 or row["id"] in seen
                    or type(row.get("startTime")) is not int or type(row.get("endTime")) is not int
                    or not 0 <= row["startTime"] <= row["endTime"] <= 2**53 - 1
                    or type(row.get("hasCloudMedia")) is not bool):
                raise GatewayClientError("Gateway returned invalid cloud metadata")
            seen.add(row["id"])
            if row["startTime"] < end and row["endTime"] >= start:
                rows.append((row["startTime"], row["endTime"], row["id"], row["hasCloudMedia"]))
        return {"records": [{"start_time": begin, "end_time": finish, "has_cloud_media": media}
                            for begin, finish, _identity, media in sorted(rows)],
                "truncated": len(payload["records"]) == 1000}

    async def cloud_recording_dates(self, serial: str, month: str, offset: int) -> dict[str, Any]:
        """Read unconfirmed calendar hints without returning recording references."""
        if type(serial) is not str or not serial or not _cloud_month_valid(month) or not _cloud_offset_valid(offset):
            raise GatewayClientError("Invalid cloud metadata request")
        query = urlencode({"month": month, "offset": offset})
        payload = await self._cloud_metadata_request(f"/api/cameras/{quote(serial, safe='')}/cloud-calendar?{query}")
        if (not isinstance(payload, dict) or set(payload) != {"month", "days"}
                or payload["month"] != month or not isinstance(payload["days"], list)):
            raise GatewayClientError("Gateway returned invalid cloud metadata")
        maximum = calendar.monthrange(int(month[:4]), int(month[5:]))[1]
        previous = 0
        for day in payload["days"]:
            if type(day) is not int or not previous < day <= maximum:
                raise GatewayClientError("Gateway returned invalid cloud metadata")
            previous = day
        return {"month": month, "days": list(payload["days"])}

    async def _cloud_metadata_request(self, path: str) -> dict[str, Any]:
        """Keep transport details private while preserving gateway authentication failures."""
        try:
            return await self._json(path, timeout=45)
        except (GatewayClientError, ClientError, TimeoutError, ValueError) as error:
            status = getattr(error, "status", None)
            status = status if type(status) is int and 100 <= status <= 599 else None
            code = getattr(error, "code", None)
            code = code if code in ("unavailable", "busy", "rate_limited", "outcome_unknown", "disabled") else None
            if status == 401:
                raise GatewayAuthenticationError("Gateway rejected the API token", status=401) from None
            if status in (404, 501) or code == "disabled":
                message = "Cloud metadata is unavailable on this gateway"
            elif status in (409, 502) or code in ("busy", "rate_limited"):
                message = "Cloud metadata is not available now, try again later"
            else:
                message = "Cloud metadata request failed"
            raise GatewayClientError(message, status=status, code=code) from None

    async def cameras(self) -> list[dict[str, Any]]:
        """Fetch every normalized camera state used to create or update entities."""
        payload = await self._json("/api/cameras")
        cameras = payload.get("cameras")
        if not isinstance(cameras, list):
            raise GatewayClientError("Gateway returned an invalid camera list")
        return [
            camera
            for camera in cameras
            if isinstance(camera, dict) and isinstance(camera.get("serial"), str)
        ]

    async def stations(self) -> list[dict[str, Any]]:
        """Fetch the HomeBase stations known to the gateway."""
        payload = await self._json("/api/stations")
        stations = payload.get("stations")
        if not isinstance(stations, list):
            raise GatewayClientError("Gateway returned an invalid station list")
        return [
            station
            for station in stations
            if isinstance(station, dict) and isinstance(station.get("serial"), str)
        ]

    async def sensors(self) -> list[dict[str, Any]]:
        """Fetch standalone sensors, tolerating an older gateway during upgrades.

        A missing endpoint is treated as an empty inventory so Home Assistant
        can update before the add-on without making the existing entry fail.
        Other gateway errors remain visible to the coordinator.
        """
        try:
            payload = await self._json("/api/sensors")
        except GatewayClientError as error:
            if error.status == 404:
                return []
            raise
        sensors = payload.get("sensors")
        if not isinstance(sensors, list):
            raise GatewayClientError("Gateway returned an invalid sensor list")
        return [
            sensor
            for sensor in sensors
            if isinstance(sensor, dict) and isinstance(sensor.get("serial"), str)
        ]

    async def locks(self) -> list[dict[str, Any]]:
        """Read cached opt-in locks, tolerating older gateways without this endpoint."""
        try:
            payload = await self._json("/api/locks")
        except GatewayClientError as error:
            if error.status == 404:
                return []
            raise
        locks = payload.get("locks")
        if not isinstance(locks, list):
            raise GatewayClientError("Gateway returned an invalid lock list")
        return [self._lock_state(lock) for lock in locks]

    async def set_lock_state(self, serial: str, locked: bool) -> dict[str, Any]:
        """Request one absolute action and return only device-confirmed state."""
        payload = await self._json(
            f"/api/locks/{quote(serial, safe='')}/state", method="POST",
            payload={"locked": locked}, timeout=60,
        )
        return self._lock_state(payload.get("lock"))

    async def set_lock_setting(self, serial: str, setting: str, value: bool | int) -> dict[str, Any]:
        """Wait for the gateway's independent setting readback, without optimistic state."""
        payload = await self._json(
            f"/api/locks/{quote(serial, safe='')}/settings", method="POST",
            payload={"setting": setting, "value": value}, timeout=100,
        )
        state = self._lock_state(payload.get("lock"))
        raw = payload.get("lock")
        if not isinstance(raw, dict) or not isinstance(raw.get("settings"), dict) or "settings" not in state:
            raise GatewayClientError("Gateway returned invalid lock settings")
        if setting == "autoLockDelaySeconds" and state["settings"].get(setting) != value:
            raise GatewayClientError("Gateway did not confirm the auto-lock delay")
        return state

    async def refresh_lock(self, serial: str) -> dict[str, Any]:
        """Request a throttled read-only lock query rather than using cached state."""
        payload = await self._json(
            f"/api/locks/{quote(serial, safe='')}/refresh", method="POST", payload={}, timeout=60,
        )
        return self._lock_state(payload.get("lock"))

    @staticmethod
    def _lock_state(value: Any) -> dict[str, Any]:
        """Project only normalized public facts, rejecting ambiguous command results."""
        if (not isinstance(value, dict) or not isinstance(value.get("serial"), str)
                or value.get("model") != "T85F1"
                or value.get("state") not in ("locked", "unlocked", "unknown")
                or not isinstance(value.get("available"), bool)):
            raise GatewayClientError("Gateway returned invalid lock state")
        state = {key: value.get(key) for key in (
            "serial", "name", "model", "state", "available", "batteryPercent", "stateObservedAt"
        )}
        settings = value.get("settings")
        if isinstance(settings, dict):
            booleans = ("autoLock", "notifications", "lockedNotifications", "unlockedNotifications")
            volume = settings.get("volume")
            valid = all(key in settings for key in ("volume", *booleans, "observedAt", "notificationsObservedAt"))
            valid = valid and (volume is None or (type(volume) is int and 0 <= volume <= 3))
            valid = valid and all(settings.get(key) is None or type(settings[key]) is bool for key in booleans)
            valid = valid and all(settings.get(key) is None or isinstance(settings[key], str) for key in ("observedAt", "notificationsObservedAt"))
            if valid:
                state["settings"] = {key: settings.get(key) for key in ("volume", *booleans, "observedAt", "notificationsObservedAt")}
                if "autoLockDelaySeconds" in settings:
                    delay = settings["autoLockDelaySeconds"]
                    state["settings"]["autoLockDelaySeconds"] = delay if type(delay) is int and 1 <= delay <= 3600 else None
        return state

    async def stored_recordings(self, serial: str, date: str) -> list[dict[str, Any]]:
        """List a day of camera-owned event clips using opaque gateway references."""
        payload = await self._json(
            f"/api/cameras/{quote(serial, safe='')}/recordings?date={quote(date, safe='')}",
            timeout=60,
        )
        records = payload.get("records")
        if not isinstance(records, list) or any(
            not isinstance(record, dict)
            or not isinstance(record.get("id"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", record["id"])
            or not isinstance(record.get("startTime"), str)
            for record in records
        ):
            raise GatewayClientError("Gateway returned invalid recordings")
        return records

    async def prepare_recording(self, serial: str, record_id: str) -> None:
        """Wait for a bounded camera download and full media verification."""
        result = await self._json(
            f"/api/cameras/{quote(serial, safe='')}/recordings/{record_id}/prepare",
            method="POST", timeout=120,
        )
        if result.get("ready") is not True:
            raise GatewayClientError("Recording was not prepared")

    async def recording_media(
        self, serial: str, record_id: str, byte_range: str | None = None,
        *, head: bool = False,
    ) -> tuple[int, bytes, dict[str, str]]:
        """Read only prepared MP4 bytes, retaining authentication inside HA.

        A single browser range is forwarded for seeking. The gateway owns the
        expiring cache and the client limits each response to 32 MiB.
        """
        headers = dict(self._headers)
        if byte_range is not None:
            if len(byte_range) > 64 or not re.fullmatch(r"bytes=\d*-\d*", byte_range):
                raise GatewayClientError("Invalid recording byte range")
            headers["Range"] = byte_range
        path = f"/api/cameras/{quote(serial, safe='')}/recordings/{record_id}/video"
        try:
            async with self._session.request(
                "HEAD" if head else "GET", self._url(path), headers=headers,
                timeout=ClientTimeout(total=60),
            ) as response:
                if response.status not in (200, 206, 416, 404):
                    self._raise_for_status(response)
                    raise GatewayClientError("Unexpected recording response")
                forwarded = {
                    key: response.headers[key]
                    for key in ("Content-Type", "Content-Range", "Content-Length", "Accept-Ranges")
                    if key in response.headers
                }
                forwarded["Cache-Control"] = "no-store"
                if response.status in (404, 416) or head:
                    return response.status, b"", forwarded
                if response.headers.get("Content-Type", "").split(";")[0] != "video/mp4":
                    raise GatewayClientError("Gateway returned invalid recording media")
                chunks = []
                length = 0
                async for chunk in response.content.iter_chunked(65536):
                    length += len(chunk)
                    if length > 32 * 1024 * 1024:
                        raise GatewayClientError("Recording response exceeded its limit")
                    chunks.append(chunk)
                return response.status, b"".join(chunks), forwarded
        except (ClientError, TimeoutError) as error:
            raise GatewayClientError("Recording gateway request failed") from error

    async def diagnostic_summary(self) -> dict[str, Any]:
        """Fetch the gateway's projected cross-device metadata without private media."""
        return await self._json("/api/diagnostics/summary")

    async def catalogue_evidence(self) -> dict[str, Any]:
        """Fetch the gateway's privacy-safe device catalogue evidence."""
        return await self._json("/api/diagnostics/catalogue-evidence")

    async def event_delivery_diagnostic(self) -> dict[str, Any]:
        """Fetch process-lifetime push transport counters without payload data."""

        return await self._json("/api/diagnostics/event-delivery")

    async def station(self, serial: str) -> dict[str, Any]:
        """Fetch one HomeBase state by serial for an explicit readback."""
        payload = await self._json(f"/api/stations/{serial}")
        station = payload.get("station", payload)
        if not isinstance(station, dict) or not isinstance(station.get("serial"), str):
            raise GatewayClientError("Gateway returned an invalid station response")
        return station

    async def set_station_guard_mode(self, serial: str, mode: int) -> dict[str, Any]:
        """Set a station's configured guard mode and return confirmed state."""
        return await self._station_command(
            f"/api/stations/{serial}/guard-mode", {"mode": mode}
        )

    async def set_station_alarm_volume(self, serial: str, value: int) -> dict[str, Any]:
        """Set a station's alarm volume and return confirmed state."""
        return await self._station_command(
            f"/api/stations/{serial}/alarm-volume", {"value": value}
        )

    async def set_station_prompt_volume(
        self, serial: str, value: int
    ) -> dict[str, Any]:
        """Set a station's prompt volume and return confirmed state."""
        return await self._station_command(
            f"/api/stations/{serial}/prompt-volume", {"value": value}
        )

    async def set_station_alarm_tone(self, serial: str, value: int) -> dict[str, Any]:
        """Set a station's alarm tone and return confirmed state."""
        return await self._station_command(
            f"/api/stations/{serial}/alarm-tone", {"value": value}
        )

    async def set_station_siren(self, serial: str, duration: int) -> dict[str, Any]:
        """Trigger or stop a HomeBase siren for the requested duration."""
        return await self._station_command(
            f"/api/stations/{serial}/siren", {"duration": duration}
        )

    async def snapshot(self, serial: str) -> bytes | None:
        """Read the last retained still, returning None when no image exists."""
        try:
            async with self._session.get(
                self._url(f"/api/cameras/{serial}/snapshot"), headers=self._headers
            ) as response:
                if response.status == 404:
                    return None
                self._raise_for_status(response)
                return await response.read()
        except (ClientError, TimeoutError) as error:
            raise GatewayClientError(str(error)) from error

    async def event_image(self, serial: str) -> bytes | None:
        """Read the latest event picture, returning None before one arrives."""
        try:
            async with self._session.get(
                self._url(f"/api/cameras/{serial}/event-image"),
                headers=self._headers,
            ) as response:
                if response.status == 404:
                    return None
                self._raise_for_status(response)
                return await response.read()
        except (ClientError, TimeoutError) as error:
            raise GatewayClientError(str(error)) from error

    async def stream_url(self, serial: str, *, native: bool = False) -> str:
        """Create a signed viewer URL, validating the opt-in native boundary.

        Compatible calls preserve the existing request and response behavior.
        Native responses fail closed when an older gateway ignores the profile.
        """
        if not native:
            payload = await self._json(f"/api/cameras/{serial}/stream-token", method="POST")
            path = payload.get("path")
            if not isinstance(path, str) or not path.startswith("/"):
                raise GatewayClientError("Gateway returned an invalid stream path")
            return self._url(path)
        try:
            payload = await self._json(
                f"/api/cameras/{quote(serial, safe='')}/stream-token", method="POST",
                payload={"profile": "native"},
            )
            if not isinstance(payload, dict) or payload.get("profile") != "native":
                raise ValueError
            path = payload.get("path")
            if not isinstance(path, str) or "\\" in path or "//" in path or ".." in path:
                raise ValueError
            parts = urlsplit(path)
            if parts.scheme or parts.netloc or parts.fragment or re.search(r"%(?![0-9a-fA-F]{2})", parts.path):
                raise ValueError
            segments = [unquote(segment, errors="strict") for segment in parts.path.split("/")]
            if segments != ["", "api", "cameras", serial, "live-native.annexb"]:
                raise ValueError
            query = parse_qsl(parts.query, keep_blank_values=True, strict_parsing=True) if parts.query else []
            if len(query) > 1 or any(key != "access_token" for key, _ in query):
                raise ValueError
            if self._headers and not query:
                raise ValueError
            if query and re.fullmatch(r"native\.(0|[1-9][0-9]{0,15})\.[A-Za-z0-9_-]{43}", query[0][1]) is None:
                raise ValueError
        except (ValueError, TypeError, AttributeError, GatewayClientError):
            raise GatewayClientError("Gateway returned an invalid native stream response") from None
        return self._url(path)

    async def capture_snapshot(self, serial: str) -> None:
        """Ask the gateway to wake a supported camera and retain a new JPEG."""
        await self._json(f"/api/cameras/{serial}/capture-snapshot", method="POST")

    async def set_camera_enabled(
        self, serial: str, enabled: bool
    ) -> dict[str, Any]:
        """Set camera enablement and return the gateway's confirmed state."""
        camera = await self._json(
            f"/api/cameras/{serial}/enabled",
            method="POST",
            payload={"enabled": enabled},
        )
        if not isinstance(camera.get("serial"), str):
            raise GatewayClientError("Gateway returned an invalid camera response")
        return camera

    async def set_camera_motion_detection(
        self, serial: str, enabled: bool
    ) -> dict[str, Any]:
        """Allow the gateway's 90-second motion confirmation scope to finish."""
        camera = await self._json(
            f"/api/cameras/{serial}/motion-detection",
            method="POST",
            payload={"enabled": enabled},
            timeout=120,
        )
        if not isinstance(camera.get("serial"), str):
            raise GatewayClientError("Gateway returned an invalid camera response")
        return camera

    async def set_camera_setting(self, serial: str, setting: str, value: bool | int) -> dict[str, Any]:
        """Await an independently confirmed setting within the gateway's 90-second deadline."""
        try:
            camera = await self._json(
                f"/api/cameras/{quote(serial, safe='')}/settings", method="POST",
                payload={"setting": setting, "value": value}, timeout=140,
            )
        except GatewayClientError as error:
            if error.status is None and error.code is None:
                raise GatewayClientError("Camera setting outcome is unknown", code="outcome_unknown") from error
            raise
        field = "motionSensitivityStep" if setting == "motionSensitivity" else "homebaseChimeEnabled"
        observed = camera.get("reportedSettings", {}).get(field) if isinstance(camera, dict) and isinstance(camera.get("reportedSettings"), dict) else None
        if not isinstance(camera, dict) or camera.get("serial") != serial or type(observed) is not type(value) or observed != value:
            raise GatewayClientError("Gateway did not confirm the camera setting", code="outcome_unknown")
        return camera

    async def set_camera_preference(self, serial: str, name: str, value: int) -> dict[str, Any]:
        """Write an admitted preference and return the gateway's fresh confirmed state."""
        camera = await self._json(f"/api/cameras/{serial}/preferences", method="POST", payload={"preference": name, "value": value}, timeout=120)
        if not isinstance(camera.get("serial"), str):
            raise GatewayClientError("Gateway returned an invalid camera response")
        return camera

    async def set_camera_audio_recording(
        self, serial: str, enabled: bool
    ) -> dict[str, Any]:
        """Set recorded audio independently of the microphone and return confirmed gateway state."""
        camera = await self._json(
            f"/api/cameras/{serial}/audio-recording",
            method="POST",
            payload={"enabled": enabled},
        )
        if not isinstance(camera.get("serial"), str):
            raise GatewayClientError("Gateway returned an invalid camera response")
        return camera

    async def set_camera_streaming_quality(
        self, serial: str, quality: int, *, nvr: bool = False
    ) -> dict[str, Any]:
        """Set live quality independently of recorded-video quality, returning confirmed state."""
        camera = await self._json(
            f"/api/cameras/{serial}/streaming-quality",
            method="POST",
            payload={"quality": quality}, timeout=120 if nvr else 60, nvr=nvr,
        )
        if not isinstance(camera.get("serial"), str) or nvr and camera.get("serial") != serial:
            raise GatewayClientError("Request outcome is unknown. Check Eufy before trying again." if nvr else "Gateway returned an invalid camera response", code="outcome_unknown" if nvr else None)
        return camera

    async def set_camera_guard_mode(self, serial: str, mode: int) -> dict[str, Any]:
        """Set a standalone camera guard mode and return confirmed state."""
        camera = await self._json(
            f"/api/cameras/{serial}/guard-mode",
            method="POST",
            payload={"mode": mode},
        )
        if not isinstance(camera.get("serial"), str):
            raise GatewayClientError("Gateway returned an invalid camera response")
        return camera

    async def refresh_camera_capabilities(self, serial: str) -> dict[str, Any]:
        """Refresh one eligible direct camera's safe on-device capability reads."""
        camera = await self._json(
            f"/api/cameras/{serial}/refresh-capabilities", method="POST"
        )
        if not isinstance(camera.get("serial"), str):
            raise GatewayClientError("Gateway returned an invalid camera response")
        return camera

    async def set_camera_night_vision(
        self, serial: str, mode: int, *, nvr: bool = False
    ) -> dict[str, Any]:
        """Set a camera's night-vision mode and return confirmed gateway state."""
        camera = await self._json(
            f"/api/cameras/{serial}/night-vision",
            method="POST",
            payload={"mode": mode}, timeout=120 if nvr else 60, nvr=nvr,
        )
        if not isinstance(camera.get("serial"), str) or nvr and camera.get("serial") != serial:
            raise GatewayClientError("Request outcome is unknown. Check Eufy before trying again." if nvr else "Gateway returned an invalid camera response", code="outcome_unknown" if nvr else None)
        return camera

    async def perform_nvr_live_control(self, serial: str, direction: str | None = None, level: int | None = None) -> dict[str, Any]:
        """Build one finite request, with no retry after an uncertain response."""
        if direction in ("left", "right", "up", "down") and level is None:
            payload = {"kind": "pan", "direction": direction}
        elif direction is None and type(level) is int and level in (1, 2, 3):
            payload = {"kind": "zoom", "level": level}
        else:
            raise GatewayClientError("Unavailable NVR action", code="unavailable")
        result = await self._json(f"/api/cameras/{serial}/nvr-live-control", method="POST", payload=payload, timeout=120, nvr=True)
        if result.get("outcome") != "request_accepted" or result.get("physicalConfirmationRequired") is not True:
            raise GatewayClientError("Request outcome is unknown. Check Eufy before trying again.", code="outcome_unknown")
        return {"outcome": "request_accepted", "physicalConfirmationRequired": True}

    async def set_nvr_view(self, serial: str, view: int) -> dict[str, Any]:
        """Change the idle camera's next-stream preference, owned by the gateway."""
        if type(view) is not int or view not in (0, 1):
            raise GatewayClientError("Unavailable NVR view", code="unavailable")
        camera = await self._json(f"/api/cameras/{serial}/nvr-view", method="POST", payload={"view": view}, timeout=120, nvr=True)
        if camera.get("serial") != serial:
            raise GatewayClientError("Request outcome is unknown. Check Eufy before trying again.", code="outcome_unknown")
        return camera

    async def set_camera_siren(self, serial: str, duration: int) -> None:
        """Trigger or stop a camera siren using a device-side duration."""
        await self._json(
            f"/api/cameras/{serial}/siren",
            method="POST",
            payload={"duration": duration},
        )

    async def set_camera_light(self, serial: str, enabled: bool) -> None:
        """Send a momentary manual-light action without inventing persistent state."""
        await self._json(
            f"/api/cameras/{serial}/light",
            method="POST",
            payload={"enabled": enabled},
        )

    async def camera_preset_positions(self, serial: str) -> list[dict[str, Any]]:
        """Return enabled-slot metadata without retaining names or thumbnails."""
        payload = await self._json(f"/api/cameras/{serial}/preset-positions")
        positions = payload.get("positions")
        if not isinstance(positions, list):
            raise GatewayClientError("Gateway returned invalid preset positions")
        return [
            position
            for position in positions
            if isinstance(position, dict)
            and isinstance(position.get("index"), int)
            and not isinstance(position.get("index"), bool)
            and isinstance(position.get("enabled"), bool)
            and isinstance(position.get("isDefault"), bool)
        ]

    async def select_camera_preset_position(self, serial: str, index: int) -> None:
        """Move once to a gateway-validated stored camera position."""
        await self._json(
            f"/api/cameras/{serial}/preset-position",
            method="POST",
            payload={"index": index},
        )

    async def set_camera_ai_tracking(self, serial: str, enabled: bool) -> None:
        """Send the physically verified AI-tracking action without local state."""
        await self._json(
            f"/api/cameras/{serial}/ai-tracking",
            method="POST",
            payload={"enabled": enabled},
        )

    async def set_camera_auto_cruise(self, serial: str, enabled: bool) -> None:
        """Send the physically verified automatic-cruise action without state."""
        await self._json(
            f"/api/cameras/{serial}/auto-cruise",
            method="POST",
            payload={"enabled": enabled},
        )

    async def play_audio(self, serial: str, data: bytes) -> None:
        """Submit a bounded AAC clip without sending local filenames to the gateway."""
        if not data or len(data) > 320_000:
            raise GatewayClientError("Speaker audio exceeds its size limit")
        try:
            async with self._session.post(
                self._url(f"/api/cameras/{serial}/speaker-audio"),
                headers={**self._headers, "Content-Type": "audio/aac"},
                data=data,
                timeout=ClientTimeout(total=70),
            ) as response:
                self._raise_for_status(response)
                result = await response.json(content_type=None)
                if not isinstance(result, dict) or result.get("ok") is not True:
                    raise GatewayClientError("Gateway did not complete speaker playback")
        except (ClientError, TimeoutError, ValueError) as error:
            raise GatewayClientError("Speaker playback failed") from error

    async def record_clip(self, serial: str, duration: int) -> bytes:
        """Request a bounded MP4 and reject a response that is not an MP4 file."""
        try:
            async with self._session.post(
                self._url(f"/api/cameras/{serial}/record.mp4"),
                headers=self._headers,
                json={"duration": duration},
                timeout=ClientTimeout(total=duration + 50),
            ) as response:
                self._raise_for_status(response)
                data = await response.read()
                if len(data) < 12 or data[4:8] != b"ftyp":
                    raise GatewayClientError(
                        "Gateway returned an invalid MP4 recording"
                    )
                return data
        except (ClientError, TimeoutError) as error:
            if isinstance(error, GatewayClientError):
                raise
            raise GatewayClientError(str(error)) from error

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        """Yield normalized SSE events until the connection closes or fails."""
        try:
            async with self._session.get(
                self._url("/api/events"), headers=self._headers, timeout=None
            ) as response:
                self._raise_for_status(response)
                data_lines: list[str] = []
                async for raw_line in response.content:
                    line = raw_line.decode("utf-8").rstrip("\r\n")
                    if line == "":
                        if data_lines:
                            try:
                                value = json.loads("\n".join(data_lines))
                            except json.JSONDecodeError:
                                value = None
                            if isinstance(value, dict):
                                yield value
                        data_lines.clear()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
        except (ClientError, TimeoutError) as error:
            if isinstance(error, GatewayClientError):
                raise
            raise GatewayClientError(str(error)) from error

    async def _station_command(
        self, path: str, payload: dict[str, int]
    ) -> dict[str, Any]:
        """Send a station command and extract its confirmed station state."""
        response = await self._json(path, method="POST", payload=payload)
        station = response.get("station", response)
        if not isinstance(station, dict) or not isinstance(station.get("serial"), str):
            raise GatewayClientError("Gateway returned an invalid station response")
        return station

    async def _json(
        self, path: str, method: str = "GET", payload: dict[str, Any] | None = None,
        *, timeout: int = 60, nvr: bool = False,
    ) -> dict[str, Any]:
        """Send a JSON request and require an object-shaped response body."""
        try:
            request_kwargs: dict[str, Any] = {"headers": self._headers, "timeout": ClientTimeout(total=timeout)}
            if payload is not None:
                request_kwargs["json"] = payload
            async with self._session.request(
                method, self._url(path), **request_kwargs
            ) as response:
                if response.status >= 400 and response.status != 401:
                    try:
                        error_payload = await response.json()
                    except (ClientError, ValueError):
                        error_payload = None
                    if nvr:
                        code = error_payload.get("code") if isinstance(error_payload, dict) else None
                        code = code if code in ("unavailable", "busy", "rate_limited", "outcome_unknown", "disabled") else "outcome_unknown"
                        raise GatewayClientError(f"NVR control {code}", status=response.status, code=code) from None
                    detail = (
                        error_payload.get("error")
                        if isinstance(error_payload, dict)
                        else None
                    )
                    if isinstance(detail, str) and detail and len(detail) <= 300:
                        raise GatewayClientError(
                            f"Gateway returned HTTP {response.status}: {detail}",
                            status=response.status, code=error_payload.get("code") if error_payload.get("code") in ("unavailable", "busy", "rate_limited", "outcome_unknown", "disabled") else None
                        )
                self._raise_for_status(response)
                payload = await response.json()
                if not isinstance(payload, dict):
                    raise GatewayClientError("Request outcome is unknown. Check Eufy before trying again." if nvr else "Gateway returned an invalid response", code="outcome_unknown" if nvr else None)
                return payload
        except (ClientError, TimeoutError) as error:
            if isinstance(error, GatewayClientError):
                raise
            if nvr:
                raise GatewayClientError("Request outcome is unknown. Check Eufy before trying again.", code="outcome_unknown") from None
            raise GatewayClientError(str(error)) from error

        except ValueError:
            if nvr:
                raise GatewayClientError("Request outcome is unknown. Check Eufy before trying again.", code="outcome_unknown") from None
            raise

    def _url(self, path: str) -> str:
        """Resolve a gateway-owned absolute API path against the configured URL."""
        return f"{self.base_url}{path}"

    @staticmethod
    def _raise_for_status(response: Any) -> None:
        """Translate HTTP failures into stable integration exception types."""
        if response.status == 401:
            raise GatewayAuthenticationError("Gateway rejected the API token", status=401)
        try:
            response.raise_for_status()
        except ClientResponseError as error:
            raise GatewayClientError(f"Gateway returned HTTP {error.status}", status=error.status) from error
