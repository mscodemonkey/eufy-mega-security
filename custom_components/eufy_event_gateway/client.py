"""Authenticated HTTP and SSE client for the local Eufy Mega Security gateway.

Home Assistant talks only to this client. It validates the gateway's JSON
shapes, translates HTTP and transport failures into integration exceptions,
keeps the bearer token in request headers, and parses the SSE stream into
normalized dictionaries. It does not know how Mega login, push notifications,
PPCS packets, or camera media work inside the gateway process.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from aiohttp import ClientError, ClientResponseError, ClientSession, ClientTimeout


class GatewayClientError(Exception):
    """Report a validated gateway, HTTP, or transport failure to callers."""


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
            if str(error) == "Gateway returned HTTP 404":
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

    async def stream_url(self, serial: str) -> str:
        """Create a short-lived H.264 URL that does not expose the bearer token."""
        payload = await self._json(f"/api/cameras/{serial}/stream-token", method="POST")
        path = payload.get("path")
        if not isinstance(path, str) or not path.startswith("/"):
            raise GatewayClientError("Gateway returned an invalid stream path")
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
        """Set camera motion detection and return confirmed gateway state."""
        camera = await self._json(
            f"/api/cameras/{serial}/motion-detection",
            method="POST",
            payload={"enabled": enabled},
        )
        if not isinstance(camera.get("serial"), str):
            raise GatewayClientError("Gateway returned an invalid camera response")
        return camera

    async def set_camera_siren(self, serial: str, duration: int) -> None:
        """Trigger or stop a camera siren using a device-side duration."""
        await self._json(
            f"/api/cameras/{serial}/siren",
            method="POST",
            payload={"duration": duration},
        )

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
        self, path: str, method: str = "GET", payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Send a JSON request and require an object-shaped response body."""
        try:
            request_kwargs: dict[str, Any] = {"headers": self._headers}
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
                    detail = (
                        error_payload.get("error")
                        if isinstance(error_payload, dict)
                        else None
                    )
                    if isinstance(detail, str) and detail and len(detail) <= 300:
                        raise GatewayClientError(
                            f"Gateway returned HTTP {response.status}: {detail}"
                        )
                self._raise_for_status(response)
                payload = await response.json()
                if not isinstance(payload, dict):
                    raise GatewayClientError("Gateway returned an invalid response")
                return payload
        except (ClientError, TimeoutError) as error:
            if isinstance(error, GatewayClientError):
                raise
            raise GatewayClientError(str(error)) from error

    def _url(self, path: str) -> str:
        """Resolve a gateway-owned absolute API path against the configured URL."""
        return f"{self.base_url}{path}"

    @staticmethod
    def _raise_for_status(response: Any) -> None:
        """Translate HTTP failures into stable integration exception types."""
        if response.status == 401:
            raise GatewayAuthenticationError("Gateway rejected the API token")
        try:
            response.raise_for_status()
        except ClientResponseError as error:
            raise GatewayClientError(f"Gateway returned HTTP {error.status}") from error
