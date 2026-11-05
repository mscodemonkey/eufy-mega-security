"""Verify E30 HA state isolation and command outcomes without hardware access.

Production callbacks are compiled with inert HA boundaries. The tests own only
synthetic dictionaries and mocked gateway responses, never account sessions.
"""
from __future__ import annotations

import ast
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest
from unittest.mock import AsyncMock

ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


def method(file: str, owner: str, name: str, namespace: dict):
    """Load the actual callback while postponing optional HA annotations."""
    tree = ast.parse((ROOT / file).read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == owner)
    node = next(node for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name)
    node.decorator_list = []
    exec(compile(ast.Module(body=[tree.body[1], node], type_ignores=[]), file, "exec"), namespace)
    return namespace[name]


class E30LockTest(unittest.IsolatedAsyncioTestCase):
    """Protect physical state semantics and four-family event preservation."""

    async def test_all_event_families_preserve_siblings_and_empty_locks_replace(self):
        """Full and single updates must never erase an unrelated inventory."""
        namespace = {"GatewayClientError": ValueError}
        callbacks = {name: method("coordinator.py", "EufyGatewayCoordinator", name, namespace)
                     for name in ("_apply_event", "async_set_camera", "async_set_station", "async_set_lock")}

        class State:
            """Provide the coordinator's in-memory update boundary."""

            def __init__(self):
                """Start with one record in every family."""
                self.data = {family: {family: {"serial": family}} for family in ("cameras", "stations", "sensors", "locks")}
                self.client = SimpleNamespace(_lock_state=lambda value: value)

            def __getattr__(self, name):
                """Read dynamic inventories after each production update."""
                return self.data[name]

            def async_set_updated_data(self, value):
                """Store the production callback's replacement snapshot."""
                self.data = value

            def _sync_device_name(self, *args):
                """Ignore registry work in this synthetic test."""

            def _sync_device_names(self, *args):
                """Ignore registry work in this synthetic test."""

        for name, callback in callbacks.items():
            setattr(State, name, callback)
        for family, singular in (("cameras", "camera"), ("stations", "station"), ("sensors", "sensor"), ("locks", "lock")):
            for event in ({family: [{"serial": "new"}]}, {singular: {"serial": "new"}}):
                state = State()
                state._apply_event(event)
                for sibling in set(state.data) - {family}:
                    self.assertIn(sibling, state.data[sibling])
                self.assertIn("new", state.data[family])
        state = State()
        state._apply_event({"locks": []})
        self.assertEqual(state.data["locks"], {})
        self.assertIn("cameras", state.data["cameras"])

    async def test_commands_publish_only_confirmed_state_and_invalidate_failures(self):
        """Never show an optimistic lock after a gateway error or unknown outcome."""
        class ClientError(Exception):
            """Stand in for the production client exception."""

        command = method("lock.py", "EufySmartLock", "_set_locked", {"GatewayClientError": ClientError, "HomeAssistantError": RuntimeError})
        confirmed = {"serial": "synthetic", "state": "unlocked", "available": True}
        published = []
        client = SimpleNamespace(set_lock_state=AsyncMock(return_value=confirmed))
        entity = SimpleNamespace(serial="synthetic", lock_state={"state": "locked"},
                                 coordinator=SimpleNamespace(client=client, async_set_lock=published.append))
        await command(entity, False)
        self.assertEqual(published, [confirmed])
        client.set_lock_state.side_effect = ClientError("Unknown outcome")
        with self.assertRaises(RuntimeError):
            await command(entity, True)
        self.assertEqual(published[-1]["state"], "unknown")
        self.assertFalse(published[-1]["available"])

    async def test_unknown_state_and_battery_do_not_become_unlocked_or_zero(self):
        """Only exact confirmed enums and real percentages produce values."""
        locked = method("lock.py", "EufySmartLock", "is_locked", {})
        battery = method("lock.py", "EufyLockBattery", "native_value", {})
        for value, expected in (("locked", True), ("unlocked", False), ("unknown", None), (None, None)):
            self.assertIs(locked(SimpleNamespace(lock_state={"state": value})), expected)
        for value, expected in ((0, 0), (100, 100), (None, None), (True, None), (-1, None), (101, None)):
            self.assertEqual(battery(SimpleNamespace(lock_state={"batteryPercent": value})), expected)

    async def test_locks_404_uses_status_and_other_errors_propagate(self):
        """An older gateway cannot break startup, while authentication still fails."""
        class ClientError(Exception):
            """Supply structured status for the production callback."""

            def __init__(self, status):
                """Keep prose deliberately unrelated to HTTP status."""
                super().__init__("unrelated wording")
                self.status = status

        locks = method("client.py", "GatewayClient", "locks", {"GatewayClientError": ClientError})
        client = SimpleNamespace(_json=AsyncMock(side_effect=ClientError(404)))
        self.assertEqual(await locks(client), [])
        client._json.side_effect = ClientError(401)
        with self.assertRaises(ClientError):
            await locks(client)

    async def test_stale_and_missing_observations_are_unavailable(self):
        """Cached locked state must not remain available after its observation expires."""
        tree = ast.parse((ROOT / "lock.py").read_text())
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EufyLockEntity")

        class Base:
            """Supply HA's coordinator availability without a live HA runtime."""

            @classmethod
            def __class_getitem__(cls, key):
                """Ignore the production coordinator generic in this test."""
                return cls

            def __init__(self, coordinator):
                """Retain synthetic lock inventory."""
                self.coordinator = coordinator

            available = True

        namespace = {"CoordinatorEntity": Base, "EufyGatewayCoordinator": object,
                     "Any": Any, "datetime": datetime, "timezone": timezone}
        exec(compile(ast.Module(body=[tree.body[1], cls], type_ignores=[]), "lock.py", "exec"), namespace)
        state = {"available": True, "stateObservedAt": datetime.now(timezone.utc).isoformat()}
        coordinator = SimpleNamespace(locks={"synthetic": state})
        entity = namespace["EufyLockEntity"](coordinator, "synthetic")
        self.assertTrue(entity.available)
        state["stateObservedAt"] = (datetime.now(timezone.utc) - timedelta(seconds=361)).isoformat()
        self.assertFalse(entity.available)
        for value in (None, "invalid", "2026-01-01T00:00:00"):
            state["stateObservedAt"] = value
            self.assertFalse(entity.available)
        coordinator.locks = {}
        self.assertFalse(entity.available)

    async def test_startup_poll_keeps_all_four_families(self):
        """An empty lock inventory must preserve camera, station and sensor discovery."""
        import asyncio
        update = method("coordinator.py", "EufyGatewayCoordinator", "_async_update_data", {"asyncio": asyncio, "GatewayClientError": ValueError, "UpdateFailed": RuntimeError})
        client = SimpleNamespace(**{family: AsyncMock(return_value=[{"serial": family}])
                                    for family in ("cameras", "stations", "sensors", "locks")})
        coordinator = SimpleNamespace(client=client, _sync_device_names=lambda value: None)
        result = await update(coordinator)
        self.assertEqual(set(result), {"cameras", "stations", "sensors", "locks"})
        client.locks.return_value = []
        result = await update(coordinator)
        self.assertEqual(result["locks"], {})
        self.assertIn("cameras", result["cameras"])

    async def test_lock_and_battery_discover_late_once(self):
        """A lock arriving over SSE creates both entities without duplicate listeners."""
        for filename, factory in (("lock.py", "EufySmartLock"), ("sensor.py", "EufyLockBattery")):
            tree = ast.parse((ROOT / filename).read_text())
            setup = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "async_setup_entry")
            listeners, added = [], []
            coordinator = SimpleNamespace(cameras={}, stations={}, sensors={}, locks={},
                                          async_add_listener=listeners.append)
            namespace = {factory: lambda coordinator, serial: serial, "DOMAIN": "eufy_event_gateway",
                         "er": SimpleNamespace(async_get=lambda hass: None),
                         "_migrate_storage_display_units": lambda *args: None}
            exec(compile(ast.Module(body=[tree.body[1], setup], type_ignores=[]), filename, "exec"), namespace)
            entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda value: None)
            await namespace["async_setup_entry"](None, entry, added.extend)
            self.assertEqual(added, [])
            coordinator.locks["synthetic"] = {"model": "T85F1"}
            listeners[0]()
            listeners[0]()
            self.assertEqual(added, ["synthetic"])

    async def test_settings_projection_and_command_validation(self):
        """Bad optional settings cannot erase a valid lock, but command results fail closed."""
        from urllib.parse import quote
        projection = method("client.py", "GatewayClient", "_lock_state", {"GatewayClientError": ValueError})
        state = {"serial": "synthetic", "model": "T85F1", "state": "locked", "available": True}
        settings = {"volume": 2, "autoLock": False, "notifications": True, "lockedNotifications": False,
                    "unlockedNotifications": True, "observedAt": "2026-10-13T00:00:00Z", "notificationsObservedAt": None}
        self.assertEqual(projection({**state, "settings": settings})["settings"], settings)
        for bad in ({}, [], {**settings, "volume": True}, {**settings, "autoLock": 1}, {**settings, "observedAt": 1}):
            result = projection({**state, "settings": bad})
            self.assertEqual(result["state"], "locked")
            self.assertNotIn("settings", result)
        command = method("client.py", "GatewayClient", "set_lock_setting", {"GatewayClientError": ValueError, "quote": quote})
        client = SimpleNamespace(_json=AsyncMock(return_value={"lock": {**state, "settings": settings}}), _lock_state=projection)
        await command(client, "synthetic", "autoLock", True)
        self.assertEqual(client._json.call_args.kwargs["timeout"], 100)
        client._json.return_value = {"lock": {**state, "settings": {}}}
        with self.assertRaises(ValueError):
            await command(client, "synthetic", "autoLock", True)

    async def test_delay_projection_is_optional_and_confirmations_must_match(self):
        """Version skew and malformed timers leave existing controls intact."""
        from urllib.parse import quote
        projection = method("client.py", "GatewayClient", "_lock_state", {"GatewayClientError": ValueError})
        settings = {"volume": 2, "autoLock": False, "notifications": True, "lockedNotifications": False,
                    "unlockedNotifications": True, "observedAt": None, "notificationsObservedAt": None}
        state = {"serial": "synthetic", "model": "T85F1", "state": "locked", "available": True, "settings": settings}
        self.assertNotIn("autoLockDelaySeconds", projection(state)["settings"])
        for value in (None, True, 0, 3601, "60", 60.0, 1, 60, 3600):
            result = projection({**state, "settings": {**settings, "autoLockDelaySeconds": value}})
            self.assertEqual(result["settings"]["autoLockDelaySeconds"], value if type(value) is int and 1 <= value <= 3600 else None)
            self.assertEqual(result["settings"]["volume"], 2)
        command = method("client.py", "GatewayClient", "set_lock_setting", {"GatewayClientError": ValueError, "quote": quote})
        client = SimpleNamespace(_json=AsyncMock(return_value={"lock": {**state, "settings": {**settings, "autoLockDelaySeconds": 60}}}), _lock_state=projection)
        await command(client, "synthetic", "autoLockDelaySeconds", 60)
        with self.assertRaises(ValueError):
            await command(client, "synthetic", "autoLockDelaySeconds", 90)

    async def test_delay_select_maps_exact_choices_without_rounding(self):
        """Only reviewed options dispatch, and unknown native values stay unavailable."""
        current = method("select.py", "EufyLockAutoLockDelaySelect", "current_option", {})
        select = method("select.py", "EufyLockAutoLockDelaySelect", "async_select_option", {"HomeAssistantError": RuntimeError})
        entity = SimpleNamespace(_attr_options=["30", "60", "90", "120", "150", "180", "300"], setting_value=None, async_set_setting=AsyncMock())
        for value in (None, True, "60", 60.0, 10, 3600, 30, 300):
            entity.setting_value = value
            self.assertEqual(current(entity), str(value) if type(value) is int and str(value) in entity._attr_options else None)
        for option in ("0", "31", "60.0", "600", "unknown"):
            with self.assertRaises(RuntimeError):
                await select(entity, option)
        entity.async_set_setting.assert_not_called()
        await select(entity, "60")
        entity.async_set_setting.assert_awaited_once_with(60)

    async def test_settings_failure_never_hides_physical_lock(self):
        """Busy leaves the cache alone and ambiguous outcomes clear only settings."""
        class ClientError(Exception):
            """Carry the production error code in a synthetic exception."""

            def __init__(self, code):
                """Retain only the fixed error category."""
                super().__init__("synthetic error")
                self.code = code

        callback = method("lock.py", "EufyLockSettingEntity", "async_set_setting",
                          {"GatewayClientError": ClientError, "HomeAssistantError": RuntimeError})
        original = {"serial": "synthetic", "state": "locked", "available": True, "settings": {"autoLock": False}}
        published = []
        client = SimpleNamespace(set_lock_setting=AsyncMock())
        entity = SimpleNamespace(serial="synthetic", setting="autoLock", lock_state=original,
                                 coordinator=SimpleNamespace(client=client, async_set_lock=published.append))
        for code in ("busy", "rate_limited", "unavailable", "disabled"):
            client.set_lock_setting.side_effect = ClientError(code)
            with self.assertRaises(RuntimeError):
                await callback(entity, True)
            self.assertEqual(published, [])
        for code in (None, "outcome_unknown"):
            client.set_lock_setting.side_effect = ClientError(code)
            with self.assertRaises(RuntimeError):
                await callback(entity, True)
            self.assertEqual(published[-1]["state"], "locked")
            self.assertTrue(published[-1]["available"])
            self.assertNotIn("settings", published[-1])
        client.set_lock_setting.side_effect = None
        confirmed = {**original, "settings": {"autoLock": True}}
        client.set_lock_setting.return_value = confirmed
        await callback(entity, True)
        self.assertEqual(published[-1], confirmed)
        self.assertFalse(original["settings"]["autoLock"])

    async def test_setting_timestamps_expire_independently(self):
        """A current lock observation cannot keep old notification settings available."""
        tree = ast.parse((ROOT / "lock.py").read_text())
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EufyLockSettingEntity")

        class Base:
            """Supply only a physical lock's availability and cached state."""

            available = True

            def __init__(self, coordinator, serial):
                """Bind a synthetic coordinator without Home Assistant."""
                self.coordinator = coordinator
                self.serial = serial

            @property
            def lock_state(self):
                """Read the current mutable test observation."""
                return self.coordinator.locks[self.serial]

        namespace = {"EufyLockEntity": Base, "EufyGatewayCoordinator": object, "EntityCategory": SimpleNamespace(CONFIG="config"),
                     "datetime": datetime, "timezone": timezone}
        exec(compile(ast.Module(body=[tree.body[1], cls], type_ignores=[]), "lock.py", "exec"), namespace)
        now = datetime.now(timezone.utc).isoformat()
        settings = {"autoLock": False, "notifications": True, "observedAt": now, "notificationsObservedAt": now}
        coordinator = SimpleNamespace(locks={"synthetic": {"settings": settings}})
        auto = namespace[cls.name](coordinator, "synthetic", "autoLock")
        notification = namespace[cls.name](coordinator, "synthetic", "notifications")
        self.assertTrue(auto.available)
        self.assertTrue(notification.available)
        self.assertEqual(auto._attr_unique_id, "synthetic_lock_autoLock")
        for stamp in (None, "invalid", "2026-01-01T00:00:00", (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                      (datetime.now(timezone.utc) - timedelta(seconds=361)).isoformat()):
            settings["notificationsObservedAt"] = stamp
            self.assertFalse(notification.available)
            self.assertTrue(auto.available)
        settings["autoLock"] = None
        self.assertFalse(auto.available)

    async def test_lock_controls_discover_once_including_native_volume_off(self):
        """Optional settings create their controls dynamically with no duplicates."""
        for filename, factory in (("switch.py", "EufyLockSettingSwitch"), ("select.py", "EufyLockVolumeSelect")):
            tree = ast.parse((ROOT / filename).read_text())
            setup = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "async_setup_entry")
            added, listeners = [], []
            coordinator = SimpleNamespace(cameras={}, stations={}, sensors={}, locks={}, async_add_listener=listeners.append)
            namespace = {factory: lambda *args: args[1:], "EufyLockAutoLockDelaySelect": lambda *args: (args[1], "delay"), "er": SimpleNamespace(async_get=lambda hass: None)}
            exec(compile(ast.Module(body=[tree.body[1], setup], type_ignores=[]), filename, "exec"), namespace)
            entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda callback: None)
            await namespace["async_setup_entry"](None, entry, added.extend)
            self.assertEqual(added, [])
            coordinator.locks["synthetic"] = {"settings": {"volume": 0, "autoLock": False, "notifications": True,
                                                           "lockedNotifications": False, "unlockedNotifications": True, "autoLockDelaySeconds": 60}}
            for listener in listeners:
                listener()
                listener()
            self.assertEqual(len(added), 4 if filename == "switch.py" else 2)
            self.assertEqual(len(set(added)), len(added))

    async def test_volume_keys_reject_off_and_unknown_without_sending(self):
        """Mute and malformed values never become an audible level or trigger a write."""
        current = method("select.py", "EufyLockVolumeSelect", "current_option", {})
        select = method("select.py", "EufyLockVolumeSelect", "async_select_option", {"HomeAssistantError": RuntimeError})
        entity = SimpleNamespace(_attr_options=["low", "medium", "high"], setting_value=0, async_set_setting=AsyncMock())
        for value, expected in ((0, None), (None, None), (True, None), (4, None), ("2", None), (1, "low"), (2, "medium"), (3, "high")):
            entity.setting_value = value
            self.assertEqual(current(entity), expected)
        for option in ("off", "mute", "Low", "unknown"):
            with self.assertRaises(RuntimeError):
                await select(entity, option)
        entity.async_set_setting.assert_not_awaited()
        for index, option in enumerate(entity._attr_options, 1):
            await select(entity, option)
            entity.async_set_setting.assert_awaited_with(index)

    async def test_motor_rejections_preserve_cache_and_ambiguous_failures_invalidate(self):
        """A rejected preflight must not turn every lock control unavailable."""
        class ClientError(Exception):
            """Supply the gateway's fixed command outcome category."""

            def __init__(self, code):
                """Keep a synthetic code without any account or protocol data."""
                super().__init__("synthetic")
                self.code = code

        callback = method("lock.py", "EufySmartLock", "_set_locked", {"GatewayClientError": ClientError, "HomeAssistantError": RuntimeError})
        original = {"serial": "synthetic", "state": "locked", "available": True,
                    "stateObservedAt": "2026-10-14T00:00:00Z", "settings": {"autoLock": False}}
        published = []
        client = SimpleNamespace(set_lock_state=AsyncMock())
        entity = SimpleNamespace(serial="synthetic", lock_state=original,
                                 coordinator=SimpleNamespace(client=client, async_set_lock=published.append))
        for code in ("unavailable", "busy", "rate_limited", "disabled"):
            client.set_lock_state.side_effect = ClientError(code)
            with self.assertRaises(RuntimeError):
                await callback(entity, False)
            self.assertEqual(published, [])
            self.assertEqual(entity.lock_state, original)
        for code in (None, "outcome_unknown", "unexpected"):
            client.set_lock_state.side_effect = ClientError(code)
            with self.assertRaises(RuntimeError):
                await callback(entity, False)
            self.assertEqual(published[-1]["state"], "unknown")
            self.assertFalse(published[-1]["available"])
        confirmed = {**original, "state": "unlocked"}
        client.set_lock_state.side_effect = None
        client.set_lock_state.return_value = confirmed
        await callback(entity, False)
        self.assertEqual(published[-1], confirmed)
        self.assertEqual(original["state"], "locked")
