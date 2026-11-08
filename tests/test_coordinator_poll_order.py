"""Exercise recovery-poll ordering against confirmed updates without HA I/O.

Tests execute the production coordinator methods with controlled HTTP waits.
The fixture owns all rows and callbacks. No device commands or network run.
"""
from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest


_SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/coordinator.py"
_TREE = ast.parse(_SOURCE.read_text())
_CLASS = next(node for node in _TREE.body if isinstance(node, ast.ClassDef)
              and node.name == "EufyGatewayCoordinator")
_METHODS = ast.Module(body=[node for node in _CLASS.body
                           if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                           and node.name in {"_async_update_data", "async_set_camera", "_apply_event"}],
                      type_ignores=[])
_NAMESPACE = {"asyncio": asyncio, "Any": Any, "GatewayClientError": RuntimeError,
              "UpdateFailed": RuntimeError}
exec(compile(ast.fix_missing_locations(_METHODS), str(_SOURCE), "exec"), _NAMESPACE)


class PollOrderTests(unittest.IsolatedAsyncioTestCase):
    """Keep later gateway observations while allowing subsequent poll recovery."""

    def fixture(self):
        """Hold one poll until the test publishes an intervening observation."""
        gate = asyncio.Event()
        entered = asyncio.Event()
        old = {"serial": "camera", "motionDetectionEnabled": False}
        sibling = {"serial": "sibling", "battery": 10}
        data = {"cameras": {"camera": old, "sibling": sibling},
                "stations": {}, "sensors": {}, "locks": {}}
        fetched = {"cameras": [old, {"serial": "sibling", "battery": 20}],
                   "stations": [{"serial": "base"}], "sensors": [], "locks": []}
        owner = SimpleNamespace(data=data)

        async def read(family):
            entered.set()
            await gate.wait()
            return fetched[family]

        owner.client = SimpleNamespace(**{family: lambda f=family: read(f)
                                          for family in fetched})
        owner._sync_device_names = lambda value: None
        owner._sync_device_name = lambda *args: None

        def publish(value):
            owner.data = value
            for family, rows in value.items():
                setattr(owner, family, rows)

        publish(data)
        owner.async_set_updated_data = publish
        owner.async_set_camera = lambda row: _NAMESPACE["async_set_camera"](owner, row)
        return owner, gate, entered, fetched

    async def test_confirmation_wins_over_inflight_poll(self):
        """An old response cannot undo confirmed motion, but siblings recover."""
        owner, gate, entered, fetched = self.fixture()
        task = asyncio.create_task(_NAMESPACE["_async_update_data"](owner))
        await entered.wait()
        confirmed = {"serial": "camera", "motionDetectionEnabled": True}
        owner.async_set_camera(confirmed)
        gate.set()
        result = await task
        self.assertIs(result["cameras"]["camera"], confirmed)
        self.assertEqual(result["cameras"]["sibling"]["battery"], 20)
        self.assertIn("base", result["stations"])
        owner.async_set_updated_data(result)
        fetched["cameras"] = [{"serial": "camera", "motionDetectionEnabled": False}]
        later = await _NAMESPACE["_async_update_data"](owner)
        self.assertFalse(later["cameras"]["camera"]["motionDetectionEnabled"])
        self.assertNotIn("sibling", later["cameras"])

    async def test_inventory_event_additions_and_removals_win(self):
        """A stale poll cannot resurrect a device removed by a newer inventory."""
        owner, gate, entered, _ = self.fixture()
        task = asyncio.create_task(_NAMESPACE["_async_update_data"](owner))
        await entered.wait()
        replacement = {"serial": "new", "motionDetectionEnabled": True}
        _NAMESPACE["_apply_event"](owner, {"cameras": [replacement]})
        gate.set()
        result = await task
        self.assertEqual(result["cameras"], {"new": replacement})
        self.assertIs(result["cameras"]["new"], replacement)

    async def test_all_families_keep_intervening_updates(self):
        """The same ordering rule protects station, lock and sensor state."""
        owner, gate, entered, _ = self.fixture()
        task = asyncio.create_task(_NAMESPACE["_async_update_data"](owner))
        await entered.wait()
        for family in ("stations", "sensors", "locks"):
            owner.data = {**owner.data, family: {"fresh": {"serial": "fresh", "value": 1}}}
        gate.set()
        result = await task
        for family in ("stations", "sensors", "locks"):
            self.assertEqual(result[family]["fresh"]["value"], 1)

    async def test_initial_poll_and_failures_keep_existing_contract(self):
        """Startup has no prior rows and failed fetches do not publish partial data."""
        owner, gate, _, _ = self.fixture()
        owner.data = None
        gate.set()
        result = await _NAMESPACE["_async_update_data"](owner)
        self.assertEqual(result["cameras"]["sibling"]["battery"], 20)
        owner.data = result

        async def fail():
            raise RuntimeError("synthetic gateway failure")

        owner.client.cameras = fail
        with self.assertRaisesRegex(RuntimeError, "synthetic gateway failure"):
            await _NAMESPACE["_async_update_data"](owner)
        self.assertIs(owner.data, result)
