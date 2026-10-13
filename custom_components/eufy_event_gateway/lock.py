"""Expose opt-in E30 state and absolute lock actions through the gateway.

The coordinator owns cached inventory and SSE updates. These entities own no
vendor connection, never infer motor completion from an accepted request, and
publish command results only after the gateway's independent device readback.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from homeassistant.components.lock import LockEntity
from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import PERCENTAGE
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .client import GatewayClientError
from .const import DOMAIN
from .coordinator import EufyGatewayCoordinator


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    """Discover lock entities once per stable identity, including late inventory."""
    coordinator = entry.runtime_data.coordinator
    known: set[str] = set()

    def add_new() -> None:
        serials = set(coordinator.locks) - known
        known.update(serials)
        async_add_entities([EufySmartLock(coordinator, serial) for serial in sorted(serials)])

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class EufyLockEntity(CoordinatorEntity[EufyGatewayCoordinator]):
    """Borrow cached lock facts for one entity's config-entry lifetime.

    The coordinator owns updates and transport. Absence, failed queries and
    expired facts make the entity unavailable, including after gateway loss.
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Bind to the gateway's stable inventory identity."""
        super().__init__(coordinator)
        self.serial = serial

    @property
    def lock_state(self) -> dict[str, Any]:
        """Return the current cached record without waking the lock."""
        return self.coordinator.locks.get(self.serial, {})

    @property
    def available(self) -> bool:
        """Reject missing, explicitly unavailable or older-than-six-minute facts."""
        state = self.lock_state
        try:
            observed = datetime.fromisoformat(state["stateObservedAt"].replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - observed).total_seconds()
        except (KeyError, TypeError, ValueError, AttributeError):
            return False
        return super().available and state.get("available") is True and 0 <= age <= 360

    @property
    def device_info(self) -> DeviceInfo:
        """Group lock and battery under the same physical device."""
        return DeviceInfo(identifiers={(DOMAIN, self.serial)},
                          name=self.lock_state.get("name") or "Smart Lock E30",
                          manufacturer="Eufy", model=self.lock_state.get("model"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose the observation time, never protocol or account fields."""
        return {"state_observed_at": self.lock_state.get("stateObservedAt")}


class EufySmartLock(EufyLockEntity, LockEntity):
    """Expose lock and unlock, with all authority and readback owned by EMS.

    No optimistic transition or latch-opening action is offered. Failed or
    unknown outcomes invalidate cached availability until a fresh observation.
    """

    _attr_name = None

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Assign a stable lock entity identifier."""
        super().__init__(coordinator, serial)
        self._attr_unique_id = f"{serial}_lock"

    @property
    def is_locked(self) -> bool | None:
        """Map only known confirmed values, leaving all other states unknown."""
        state = self.lock_state.get("state")
        return True if state == "locked" else False if state == "unlocked" else None

    async def async_lock(self, **kwargs: Any) -> None:
        """Request an absolute lock and publish its confirmed device state."""
        await self._set_locked(True)

    async def async_unlock(self, **kwargs: Any) -> None:
        """Request an absolute unlock and publish its confirmed device state."""
        await self._set_locked(False)

    async def _set_locked(self, locked: bool) -> None:
        try:
            state = await self.coordinator.client.set_lock_state(self.serial, locked)
        except GatewayClientError as error:
            self.coordinator.async_set_lock({**self.lock_state, "serial": self.serial,
                                             "state": "unknown", "available": False})
            raise HomeAssistantError(str(error)) from error
        self.coordinator.async_set_lock(state)


class EufyLockBattery(EufyLockEntity, SensorEntity):
    """Expose only device-reported battery data from the shared lock query.

    The sensor does not initiate reads or own polling. It shares the lock's
    availability and expires along with the same confirmed observation.
    """

    _attr_translation_key = "battery"
    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str) -> None:
        """Assign a stable battery entity identifier."""
        super().__init__(coordinator, serial)
        self._attr_unique_id = f"{serial}_lock_battery"

    @property
    def native_value(self) -> int | None:
        """Preserve zero and reject malformed or absent battery values."""
        value = self.lock_state.get("batteryPercent")
        return value if type(value) is int and 0 <= value <= 100 else None


class EufyLockSettingEntity(EufyLockEntity):
    """Borrow one setting's independent observation for a config-entry lifetime.

    The gateway owns writes and confirmation. This entity never re-ages cached
    facts or invalidates physical lock state after a settings failure.
    """

    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: EufyGatewayCoordinator, serial: str, setting: str) -> None:
        """Bind a stable setting identity under the lock's physical device."""
        super().__init__(coordinator, serial)
        self.setting = setting
        self._attr_unique_id = f"{serial}_lock_{setting}"

    @property
    def setting_value(self) -> bool | int | None:
        """Return only the coordinator's last reported value."""
        return self.lock_state.get("settings", {}).get(self.setting)

    @property
    def available(self) -> bool:
        """Expire device settings independently from cloud notification settings."""
        key = "observedAt" if self.setting in ("volume", "autoLock") else "notificationsObservedAt"
        try:
            stamp = self.lock_state["settings"][key]
            observed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - observed).total_seconds()
        except (KeyError, TypeError, ValueError, AttributeError):
            return False
        return super().available and self.setting_value is not None and 0 <= age <= 360

    async def async_set_setting(self, value: bool | int) -> None:
        """Publish confirmed facts; ambiguous failures clear settings alone."""
        try:
            state = await self.coordinator.client.set_lock_setting(self.serial, self.setting, value)
        except GatewayClientError as error:
            if error.code in (None, "outcome_unknown"):
                state = {**self.lock_state, "serial": self.serial}
                state.pop("settings", None)
                self.coordinator.async_set_lock(state)
            raise HomeAssistantError(str(error)) from error
        self.coordinator.async_set_lock(state)
