"""HomeBase alarm and prompt volume controls for Eufy Mega Security.

The coordinator owns each HomeBase's normalized state, while these entities
translate Home Assistant number writes into explicit gateway commands. Values
are published only from the gateway's confirmed command response; the platform
does not optimistically mutate station state or contact Eufy directly.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from homeassistant.components.number import NumberEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .coordinator import EufyGatewayCoordinator
from .entity import EufyStationEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create alarm and prompt volume controls for every HomeBase."""
    coordinator = entry.runtime_data.coordinator
    known: set[str] = set()

    def add_new() -> None:
        serials = {
            serial
            for serial, station in coordinator.stations.items()
            if station.get("controlsSupported") is True
        } - known
        if serials:
            known.update(serials)
            entities = []
            for serial in sorted(serials):
                entities.extend(
                    (
                        EufyStationVolume(coordinator, serial, "alarm"),
                        EufyStationVolume(coordinator, serial, "prompt"),
                    )
                )
            async_add_entities(entities)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyStationVolume(EufyStationEntity, NumberEntity):
    """Expose one confirmed HomeBase volume property for a station lifetime.

    Each instance selects either the alarm or prompt command at construction.
    It shares station state with sibling entities and publishes a new value only
    after the gateway confirms that the command succeeded.
    """

    _attr_native_min_value = 1
    _attr_native_max_value = 26
    _attr_native_step = 1

    def __init__(
        self, coordinator: EufyGatewayCoordinator, serial: str, kind: str
    ) -> None:
        """Create either the alarm or prompt volume control."""
        EufyStationEntity.__init__(self, coordinator, serial)
        NumberEntity.__init__(self)
        self.kind = kind
        self._attr_translation_key = f"eufy_station_{kind}_volume"
        self._attr_unique_id = f"{serial}_{kind}_volume"
        self._setter: Callable[[str, int], Awaitable[dict[str, Any]]] = (
            coordinator.client.set_station_alarm_volume
            if kind == "alarm"
            else coordinator.client.set_station_prompt_volume
        )
    @property
    def native_value(self) -> float | None:
        """Return the confirmed raw Eufy volume level."""
        value = self.station.get(f"{self.kind}Volume")
        return float(value) if isinstance(value, (int, float)) else None

    async def async_set_native_value(self, value: float) -> None:
        """Set volume and publish it only after gateway confirmation."""
        try:
            station = await self._setter(self.serial, int(value))
            self.set_confirmed_station(station)
        except (GatewayClientError, ValueError) as error:
            raise HomeAssistantError(
                f"Could not change HomeBase {self.kind} volume: {error}"
            ) from error
