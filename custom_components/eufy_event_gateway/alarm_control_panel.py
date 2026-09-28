"""HomeBase alarm entities for Eufy Mega Security.

The gateway owns guard-mode commands and returns only confirmed station state.
This platform maps that state to Home Assistant's alarm model while retaining
the richer Eufy mode selection in the companion select entity.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.alarm_control_panel import (
    AlarmControlPanelEntity,
    AlarmControlPanelEntityFeature,
    AlarmControlPanelState,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import EufyGatewayConfigEntry
from .client import GatewayClientError
from .const import (
    GUARD_MODE_AWAY,
    GUARD_MODE_CUSTOM_1,
    GUARD_MODE_CUSTOM_2,
    GUARD_MODE_CUSTOM_3,
    GUARD_MODE_DISARMED,
    GUARD_MODE_HOME,
)
from .coordinator import EufyGatewayCoordinator
from .entity import EufyStationEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyGatewayConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create one alarm panel for each HomeBase in the current inventory."""
    coordinator = entry.runtime_data.coordinator
    known: set[str] = set()

    def add_new() -> None:
        serials = {
            serial
            for serial, station in coordinator.stations.items()
            if station.get("guardModeControlSupported") is True
        } - known
        if serials:
            known.update(serials)
            async_add_entities(
                EufyHomeBaseAlarm(coordinator, serial) for serial in sorted(serials)
            )

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyHomeBaseAlarm(EufyStationEntity, AlarmControlPanelEntity):
    """Expose confirmed HomeBase guard state as a code-free alarm panel.

    One instance lives with each discovered station. It temporarily displays
    Home Assistant's arming or disarming state while a command is in flight,
    then replaces that state with the gateway's confirmed station response.
    The gateway, rather than this entity, owns alarm protocol and persistence.
    """

    _attr_translation_key = "eufy_home_base_alarm"
    _attr_code_format = None
    _attr_code_arm_required = False
    _attr_supported_features = (
        AlarmControlPanelEntityFeature.ARM_AWAY
        | AlarmControlPanelEntityFeature.ARM_HOME
        | AlarmControlPanelEntityFeature.ARM_NIGHT
        | AlarmControlPanelEntityFeature.ARM_VACATION
        | AlarmControlPanelEntityFeature.ARM_CUSTOM_BYPASS
    )

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Create the alarm panel for one HomeBase serial."""
        EufyStationEntity.__init__(self, coordinator, serial)
        AlarmControlPanelEntity.__init__(self)
        self._attr_unique_id = f"{serial}_alarm"
        self._pending_state: AlarmControlPanelState | None = None

    @property
    def alarm_state(self) -> AlarmControlPanelState | None:
        """Return a transient command state or the station's effective mode."""
        if self._pending_state is not None:
            return self._pending_state
        if self.station.get("alarmActive"):
            return AlarmControlPanelState.TRIGGERED
        mode = _mode_value(
            self.station.get("effectiveMode"), self.station.get("guardMode")
        )
        return {
            GUARD_MODE_AWAY: AlarmControlPanelState.ARMED_AWAY,
            GUARD_MODE_HOME: AlarmControlPanelState.ARMED_HOME,
            GUARD_MODE_DISARMED: AlarmControlPanelState.DISARMED,
            GUARD_MODE_CUSTOM_1: AlarmControlPanelState.ARMED_CUSTOM_BYPASS,
            GUARD_MODE_CUSTOM_2: AlarmControlPanelState.ARMED_NIGHT,
            GUARD_MODE_CUSTOM_3: AlarmControlPanelState.ARMED_VACATION,
        }.get(mode)

    async def async_alarm_arm_away(self, code: str | None = None) -> None:
        """Arm in Away mode, accepting Home Assistant's code-free argument."""
        await self._async_set_mode(GUARD_MODE_AWAY, AlarmControlPanelState.ARMING)

    async def async_alarm_arm_home(self, code: str | None = None) -> None:
        """Arm in Home mode, accepting Home Assistant's code-free argument."""
        await self._async_set_mode(GUARD_MODE_HOME, AlarmControlPanelState.ARMING)

    async def async_alarm_arm_night(self, code: str | None = None) -> None:
        """Arm in Eufy's second custom mode, accepting Home Assistant's code-free argument."""
        await self._async_set_mode(GUARD_MODE_CUSTOM_2, AlarmControlPanelState.ARMING)

    async def async_alarm_arm_vacation(self, code: str | None = None) -> None:
        """Arm in Eufy's third custom mode, accepting Home Assistant's code-free argument."""
        await self._async_set_mode(GUARD_MODE_CUSTOM_3, AlarmControlPanelState.ARMING)

    async def async_alarm_arm_custom_bypass(self, code: str | None = None) -> None:
        """Arm in Eufy's first custom mode, accepting Home Assistant's code-free argument."""
        await self._async_set_mode(GUARD_MODE_CUSTOM_1, AlarmControlPanelState.ARMING)

    async def async_alarm_disarm(self, code: str | None = None) -> None:
        """Disarm the HomeBase, accepting Home Assistant's code argument."""
        await self._async_set_mode(
            GUARD_MODE_DISARMED, AlarmControlPanelState.DISARMING
        )

    async def _async_set_mode(self, mode: int, pending: AlarmControlPanelState) -> None:
        """Publish command progress and replace it with gateway-confirmed state."""
        self._pending_state = pending
        self.async_write_ha_state()
        try:
            station = await self.coordinator.client.set_station_guard_mode(
                self.serial, mode
            )
            self.set_confirmed_station(station)
        except GatewayClientError as error:
            raise HomeAssistantError(
                f"Could not change HomeBase guard mode: {error}"
            ) from error
        finally:
            self._pending_state = None
            self.async_write_ha_state()


def _mode_value(effective: Any, configured: Any) -> int | None:
    """Read an integer mode while tolerating incomplete gateway state."""
    value = effective if isinstance(effective, int) else configured
    return value if isinstance(value, int) else None
