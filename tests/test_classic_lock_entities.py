"""Protect read-only inventory lock entities without contacting hardware.

Tests compile production callbacks with inert Home Assistant neighbours. They
own only synthetic coordinator state and verify that inventory observations
cannot produce lock-service entities or optimistic bolt state.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest
from unittest.mock import AsyncMock
from urllib.parse import quote

from tests.test_e30_locks import method

ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


def load_class(file: str, owner: str, namespace: dict[str, Any]) -> type:
    """Compile the production entity class against test-owned framework boundaries."""

    tree = ast.parse((ROOT / file).read_text())
    node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == owner)
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, node], type_ignores=[])), file, "exec"), namespace)
    return namespace[owner]


class ClassicLockEntitiesTests(unittest.IsolatedAsyncioTestCase):
    """Keep read-only inventory separate from motor entities through profile changes."""

    def test_reported_state_names_only_settled_values_and_retires_profile_changes(self) -> None:
        """A missing state never becomes unlocked and a retired profile becomes unavailable."""

        class Base:
            """Own a synthetic cached lock record without transport or services."""

            available = True

            def __init__(self, coordinator, serial):
                self.coordinator = coordinator
                self.serial = serial

            @property
            def lock_state(self):
                return self.coordinator.locks[self.serial]

        class Binary:
            """Provide only the framework base needed for the production sensor."""

        cls = load_class("binary_sensor.py", "EufyReportedLockState", {
            "EufyLockEntity": Base, "BinarySensorEntity": Binary,
            "BinarySensorDeviceClass": SimpleNamespace(LOCK="lock"),
        })
        state = {"readOnly": True, "state": "locked"}
        entity = cls(SimpleNamespace(locks={"fixture": state}), "fixture")
        for raw, expected in (("locked", False), ("unlocked", True), ("unknown", None), (None, None), ("4", None)):
            state["state"] = raw
            self.assertIs(entity.is_on, expected)
        self.assertTrue(entity.available)
        state["readOnly"] = False
        self.assertFalse(entity.available)
        self.assertFalse(hasattr(entity, "async_lock"))
        self.assertFalse(hasattr(entity, "async_unlock"))

    async def test_read_only_inventory_never_creates_a_motor_entity(self) -> None:
        """The real platform setup filters read-only rows before constructing lock entities."""

        tree = ast.parse((ROOT / "lock.py").read_text())
        node = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "async_setup_entry")
        constructed = []
        namespace = {"EufySmartLock": lambda coordinator, serial: constructed.append(serial) or serial}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "lock.py", "exec"), namespace)
        callbacks = []
        coordinator = SimpleNamespace(locks={"classic": {"readOnly": True}, "e30": {}}, async_add_listener=lambda cb: callbacks.append(cb) or (lambda: None))
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator), async_on_unload=lambda cb: None)
        await namespace["async_setup_entry"](None, entry, lambda entities: None)
        self.assertEqual(constructed, ["e30"])
        callbacks[0]()
        self.assertEqual(constructed, ["e30"])

    def test_preexisting_motor_entity_is_unavailable_when_profile_becomes_read_only(self) -> None:
        """A later profile change cannot leave a former lock service entity enabled."""

        class Base:
            """Supply cached state without permitting any command in this test."""

            available = True
            lock_state = {"readOnly": True}

        class Motor:
            """Stand in for the framework's motor entity base."""

        cls = load_class("lock.py", "EufySmartLock", {"EufyLockEntity": Base, "LockEntity": Motor})
        entity = object.__new__(cls)
        self.assertFalse(entity.available)
        Base.lock_state = {}
        self.assertTrue(entity.available)

    def test_client_requires_explicit_read_only_profile_and_drops_settings(self) -> None:
        """A classic row cannot masquerade as an actuating E30 or expose settings."""

        project = method("client.py", "GatewayClient", "_lock_state", {"GatewayClientError": ValueError})
        for model in ("T8520", "T8506"):
            with self.subTest(model=model):
                row = {"serial": "fixture", "name": "Fixture", "model": model, "state": "locked", "available": True,
                       "batteryPercent": 80, "stateObservedAt": None, "readOnly": True, "observationSource": "cloud_inventory",
                       "settings": {"autoLock": True}, "private": "SENTINEL"}
                result = project(row)
                self.assertTrue(result["readOnly"])
                self.assertNotIn("settings", result)
                self.assertNotIn("private", result)
                for change in ({"readOnly": False}, {"observationSource": None}, {"observationSource": "device_query"},
                               {"model": "T8520P"}, {"model": "T8506111"}, {"model": "T85F1"}):
                    with self.assertRaises(ValueError):
                        project({**row, **change})

    def test_client_admits_c33_only_as_a_status_only_device_query(self) -> None:
        """The C33 reads state from the lock itself but never becomes a motor profile."""

        project = method("client.py", "GatewayClient", "_lock_state", {"GatewayClientError": ValueError})
        row = {"serial": "fixture", "name": "Front Door", "model": "T85L0", "state": "unlocked", "available": True,
               "batteryPercent": 31, "stateObservedAt": None, "readOnly": True, "observationSource": "device_query"}
        result = project(row)
        self.assertTrue(result["readOnly"])
        self.assertEqual(result["observationSource"], "device_query")
        for change in ({"readOnly": None}, {"observationSource": "device"}, {"observationSource": None},
                       {"observationSource": "cloud_inventory"}, {"model": "T8520"}):
            with self.assertRaises(ValueError):
                project({**row, **change})

    def test_c33_keeps_event_context_and_lockout_time_but_classic_rows_do_not(self) -> None:
        """Only the notification-backed C33 profile carries access context and lockout receipt."""

        from datetime import datetime
        project = method("client.py", "GatewayClient", "_lock_state",
                         {"GatewayClientError": ValueError, "datetime": datetime})
        event = {"action": "unlocked", "method": "app", "userName": "Casey", "receivedAt": "2026-11-21T03:40:08Z"}
        row = {"serial": "fixture", "name": "Front Door", "model": "T85L0", "state": "unlocked", "available": True,
               "batteryPercent": 31, "stateObservedAt": None, "readOnly": True, "observationSource": "device_query",
               "lastEvent": event, "keypadLockoutAt": "2026-11-21T03:39:01Z"}
        result = project(row)
        self.assertEqual(result["lastEvent"], event)
        self.assertEqual(result["keypadLockoutAt"], "2026-11-21T03:39:01Z")
        for stamp in ("not-a-date", "2026-11-21T03:39:01", 5, None):
            self.assertIsNone(project({**row, "keypadLockoutAt": stamp})["keypadLockoutAt"])
        self.assertNotIn("keypadLockoutAt", project({k: v for k, v in row.items() if k != "keypadLockoutAt"}))
        classic = project({**row, "model": "T8520", "observationSource": "cloud_inventory"})
        self.assertNotIn("lastEvent", classic)
        self.assertNotIn("keypadLockoutAt", classic)

    def test_reported_state_exposes_event_context_when_present(self) -> None:
        """The read-only binary sensor adds last-event attributes only when the client kept one."""

        class Base:
            """Supply the shared observation attribute only."""

            available = True

            def __init__(self, coordinator, serial):
                self.coordinator = coordinator
                self.serial = serial

            @property
            def lock_state(self):
                return self.coordinator.locks[self.serial]

            @property
            def extra_state_attributes(self):
                return {"state_observed_at": None}

        cls = load_class("binary_sensor.py", "EufyReportedLockState", {
            "EufyLockEntity": Base, "BinarySensorEntity": object,
            "BinarySensorDeviceClass": SimpleNamespace(LOCK="lock"),
        })
        event = {"action": "locked", "method": "automatic", "userName": None, "receivedAt": "2026-11-21T03:41:13Z"}
        state = {"readOnly": True, "observationSource": "device_query", "lastEvent": event}
        entity = cls(SimpleNamespace(locks={"fixture": state}), "fixture")
        self.assertEqual(entity.extra_state_attributes, {
            "state_observed_at": None, "last_event_action": "locked", "last_event_method": "automatic",
            "last_event_user": None, "last_event_received_at": event["receivedAt"]})
        del state["lastEvent"]
        self.assertEqual(entity.extra_state_attributes, {"state_observed_at": None})

    def test_keypad_lockout_sensor_reports_receipt_time_only(self) -> None:
        """A missing or malformed receipt is unknown, never a current lockout claim."""

        from datetime import datetime, timezone
        cls = load_class("lock.py", "EufyLockKeypadLockout", {
            "EufyLockEntity": type("Base", (), {}), "SensorEntity": type("Sensor", (), {}), "datetime": datetime,
            "SensorDeviceClass": SimpleNamespace(TIMESTAMP="timestamp"),
        })
        entity = object.__new__(cls)
        for raw, expected in (("2026-11-21T03:39:01Z", datetime(2026, 11, 21, 3, 39, 1, tzinfo=timezone.utc)),
                              (None, None), ("bad", None)):
            type(entity).lock_state = property(lambda self, raw=raw: {} if raw is None else {"keypadLockoutAt": raw})
            self.assertEqual(entity.native_value, expected)

    async def test_client_rejects_read_only_observation_as_motor_confirmation(self) -> None:
        """Even an incorrectly successful gateway reply cannot confirm lock actuation."""

        command = method("client.py", "GatewayClient", "set_lock_state", {"GatewayClientError": ValueError, "quote": quote})
        client = SimpleNamespace(_json=AsyncMock(return_value={"lock": {}}), _lock_state=lambda value: {"readOnly": True})
        with self.assertRaises(ValueError):
            await command(client, "fixture", True)
