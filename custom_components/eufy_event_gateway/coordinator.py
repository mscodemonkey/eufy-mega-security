"""Push-first state coordinator for Eufy Mega Security.

The gateway sends state changes over one long-lived SSE connection. This
coordinator applies those changes immediately and keeps a sixty-second poll as
recovery for a dropped stream or a gateway restart. It owns reconnect/backoff
and the first inventory fetch; entity code only reads the coordinator's
normalized camera dictionary and never makes a protocol request of its own.
Camera, station, and standalone-sensor inventories are replaced independently
so a partial event cannot erase state owned by another device family.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .client import GatewayClient, GatewayClientError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


class EufyGatewayCoordinator(
    DataUpdateCoordinator[dict[str, dict[str, dict[str, Any]]]]
):
    """Own normalized config-entry state and its single SSE listener.

    The coordinator is created once per config entry, performs the initial and
    recovery inventory polls, merges gateway events by device family, and
    notifies every entity from one shared state snapshot. Entities may issue
    explicit commands through its client but never own transport lifecycle.
    """

    def __init__(self, hass: HomeAssistant, client: GatewayClient) -> None:
        """Create the coordinator with the gateway client and recovery interval."""
        super().__init__(
            hass,
            logger=_LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=60),
            always_update=False,
        )
        self.client = client
        self._event_task: asyncio.Task[None] | None = None

    async def _async_update_data(self) -> dict[str, dict[str, dict[str, Any]]]:
        """Fetch all inventories concurrently for startup and poll recovery."""

        # Polling is recovery only. Normal updates arrive through the long-lived
        # SSE connection started after the first successful refresh.
        try:
            cameras, stations, sensors = await asyncio.gather(
                self.client.cameras(), self.client.stations(), self.client.sensors()
            )
        except GatewayClientError as error:
            raise UpdateFailed(str(error)) from error
        updated = {
            "cameras": {camera["serial"]: camera for camera in cameras},
            "stations": {station["serial"]: station for station in stations},
            "sensors": {sensor["serial"]: sensor for sensor in sensors},
        }
        self._sync_device_names(updated)
        return updated

    @property
    def cameras(self) -> dict[str, dict[str, Any]]:
        """Return the latest camera state indexed by serial."""
        return (self.data or {}).get("cameras", {})

    @property
    def stations(self) -> dict[str, dict[str, Any]]:
        """Return the latest HomeBase state indexed by serial."""
        return (self.data or {}).get("stations", {})

    @property
    def sensors(self) -> dict[str, dict[str, Any]]:
        """Return the latest standalone sensor state indexed by serial."""
        return (self.data or {}).get("sensors", {})

    def async_set_station(self, station: dict[str, Any]) -> None:
        """Merge confirmed command state and notify all station entities."""
        serial = station.get("serial")
        if not isinstance(serial, str):
            return
        updated = {
            "cameras": dict(self.cameras),
            "stations": dict(self.stations),
            "sensors": dict(self.sensors),
        }
        updated["stations"][serial] = station
        self._sync_device_name(serial, station.get("name"))
        self.async_set_updated_data(updated)

    def async_set_camera(self, camera: dict[str, Any]) -> None:
        """Merge confirmed command state and notify all camera entities."""
        serial = camera.get("serial")
        if not isinstance(serial, str):
            return
        updated = {
            "cameras": dict(self.cameras),
            "stations": dict(self.stations),
            "sensors": dict(self.sensors),
        }
        updated["cameras"][serial] = camera
        self._sync_device_name(serial, camera.get("name"))
        self.async_set_updated_data(updated)

    def start_event_listener(self) -> None:
        """Start one reconnecting SSE task after the first poll succeeds."""
        if self._event_task is None:
            self._event_task = self.config_entry.async_create_background_task(
                self.hass, self._listen_forever(), "Eufy gateway events"
            )

    async def async_shutdown(self) -> None:
        """Cancel the SSE task so unloading never leaves a background request."""
        if self._event_task is not None:
            self._event_task.cancel()
            await asyncio.gather(self._event_task, return_exceptions=True)
            self._event_task = None

    async def _listen_forever(self) -> None:
        """Reconnect with capped exponential backoff until Home Assistant cancels us."""
        delay = 1
        while True:
            try:
                async for event in self.client.events():
                    delay = 1
                    self._apply_event(event)
                raise GatewayClientError("Gateway event stream ended")
            except asyncio.CancelledError:
                raise
            except GatewayClientError as error:
                self.logger.debug("Gateway event stream reconnecting: %s", error)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60)
            else:
                delay = 1

    def _apply_event(self, event: dict[str, Any]) -> None:
        """Merge full inventories or individual devices without losing siblings."""
        cameras = event.get("cameras")
        if isinstance(cameras, list):
            normalized = {
                camera["serial"]: camera
                for camera in cameras
                if isinstance(camera, dict) and isinstance(camera.get("serial"), str)
            }
            updated = {
                "cameras": normalized,
                "stations": dict(self.stations),
                "sensors": dict(self.sensors),
            }
            self._sync_device_names(updated)
            self.async_set_updated_data(updated)

        stations = event.get("stations")
        if isinstance(stations, list):
            normalized = {
                station["serial"]: station
                for station in stations
                if isinstance(station, dict) and isinstance(station.get("serial"), str)
            }
            updated = {
                "cameras": dict(self.cameras),
                "stations": normalized,
                "sensors": dict(self.sensors),
            }
            self._sync_device_names(updated)
            self.async_set_updated_data(updated)

        camera = event.get("camera")
        if isinstance(camera, dict) and isinstance(camera.get("serial"), str):
            self.async_set_camera(camera)

        station = event.get("station")
        if isinstance(station, dict) and isinstance(station.get("serial"), str):
            self.async_set_station(station)

        sensors = event.get("sensors")
        if isinstance(sensors, list):
            normalized = {
                sensor["serial"]: sensor
                for sensor in sensors
                if isinstance(sensor, dict) and isinstance(sensor.get("serial"), str)
            }
            updated = {
                "cameras": dict(self.cameras),
                "stations": dict(self.stations),
                "sensors": normalized,
            }
            self.async_set_updated_data(updated)

        sensor = event.get("sensor")
        if isinstance(sensor, dict) and isinstance(sensor.get("serial"), str):
            updated = {
                "cameras": dict(self.cameras),
                "stations": dict(self.stations),
                "sensors": dict(self.sensors),
            }
            updated["sensors"][sensor["serial"]] = sensor
            self._sync_device_name(sensor["serial"], sensor.get("name"))
            self.async_set_updated_data(updated)

    def _sync_device_names(
        self, data: dict[str, dict[str, dict[str, Any]]]
    ) -> None:
        """Refresh vendor names without changing Home Assistant user overrides."""
        for family in ("cameras", "stations", "sensors"):
            for serial, device in data.get(family, {}).items():
                self._sync_device_name(serial, device.get("name"))

    def _sync_device_name(self, serial: str, name: object) -> None:
        """Update an existing registry device when Eufy reports a new name."""
        if not isinstance(name, str) or not name.strip():
            return
        registry = dr.async_get(self.hass)
        device = registry.async_get_device(identifiers={(DOMAIN, serial)})
        if device is not None and device.name != name:
            registry.async_update_device(device.id, name=name)
