"""Protect the read-only T8520 entity boundary without contacting hardware.

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
        row = {"serial": "fixture", "name": "Fixture", "model": "T8520", "state": "locked", "available": True,
               "batteryPercent": 80, "stateObservedAt": None, "readOnly": True, "observationSource": "cloud_inventory",
               "settings": {"autoLock": True}, "private": "SENTINEL"}
        result = project(row)
        self.assertTrue(result["readOnly"])
        self.assertNotIn("settings", result)
        self.assertNotIn("private", result)
        for change in ({"readOnly": False}, {"observationSource": None}, {"model": "T8520P"}, {"model": "T85F1"}):
            with self.assertRaises(ValueError):
                project({**row, **change})

    async def test_client_rejects_read_only_observation_as_motor_confirmation(self) -> None:
        """Even an incorrectly successful gateway reply cannot confirm lock actuation."""

        command = method("client.py", "GatewayClient", "set_lock_state", {"GatewayClientError": ValueError, "quote": quote})
        client = SimpleNamespace(_json=AsyncMock(return_value={"lock": {}}), _lock_state=lambda value: {"readOnly": True})
        with self.assertRaises(ValueError):
            await command(client, "fixture", True)
