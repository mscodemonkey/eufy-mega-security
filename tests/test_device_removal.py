"""Execute the device-removal callback against synthetic coordinator state.

Home Assistant imports are excluded from this focused test. The actual callback
is compiled from the integration module and consumes a fake refresh boundary,
so registry-removal decisions can run without a Home Assistant installation.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock


SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/__init__.py"


class DeviceRemovalTest(unittest.IsolatedAsyncioTestCase):
    """Protect live inventory and failed-refresh boundaries during user deletion."""

    def setUp(self) -> None:
        """Load the shipped callback with postponed annotations and a synthetic domain."""
        tree = ast.parse(SOURCE.read_text())
        callback = next(
            node for node in tree.body
            if isinstance(node, ast.AsyncFunctionDef)
            and node.name == "async_remove_config_entry_device"
        )
        module = ast.Module(body=[tree.body[1], callback], type_ignores=[])
        namespace = {"DOMAIN": "eufy_event_gateway"}
        exec(compile(module, str(SOURCE), "exec"), namespace)
        self.callback = namespace["async_remove_config_entry_device"]

    async def test_absent_device_requires_fresh_successful_inventory(self) -> None:
        """Approve an absent station only after the refresh has completed successfully."""
        coordinator = self.coordinator()
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator))
        device = SimpleNamespace(identifiers={("eufy_event_gateway", "removed")})
        self.assertTrue(await self.callback(None, entry, device))
        coordinator.async_refresh.assert_awaited_once()

    async def test_every_live_device_family_prevents_removal(self) -> None:
        """Retain cameras, stations, and sensors, including mixed identifier devices."""
        for family in ("cameras", "stations", "sensors"):
            coordinator = self.coordinator()
            setattr(coordinator, family, {"live": {}})
            entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator))
            device = SimpleNamespace(identifiers={
                ("eufy_event_gateway", "removed"), ("eufy_event_gateway", "live")
            })
            self.assertFalse(await self.callback(None, entry, device))

    async def test_failed_refresh_and_unloaded_entries_prevent_removal(self) -> None:
        """Never interpret an unavailable gateway or unloaded entry as an empty account."""
        device = SimpleNamespace(identifiers={("eufy_event_gateway", "removed")})
        self.assertFalse(await self.callback(None, SimpleNamespace(), device))
        for data, success in (({}, False), (None, True)):
            coordinator = self.coordinator()
            coordinator.data = data
            coordinator.last_update_success = success
            entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator))
            self.assertFalse(await self.callback(None, entry, device))

    async def test_refresh_can_restore_a_previously_absent_device(self) -> None:
        """Use the new inventory rather than the state from before the refresh."""
        coordinator = self.coordinator()

        async def refresh() -> None:
            coordinator.stations = {"returned": {}}

        coordinator.async_refresh = AsyncMock(side_effect=refresh)
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator))
        device = SimpleNamespace(identifiers={("eufy_event_gateway", "returned")})
        self.assertFalse(await self.callback(None, entry, device))

    async def test_foreign_identifiers_do_not_authorize_removal(self) -> None:
        """Require a registry identity owned by this integration."""
        coordinator = self.coordinator()
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator))
        device = SimpleNamespace(identifiers={("another_integration", "removed")})
        self.assertFalse(await self.callback(None, entry, device))
        coordinator.async_refresh.assert_not_awaited()

    def coordinator(self) -> SimpleNamespace:
        """Build an available coordinator whose complete inventory is initially empty."""
        return SimpleNamespace(
            cameras={}, stations={}, sensors={}, data={},
            last_update_success=True, async_refresh=AsyncMock(),
        )


if __name__ == "__main__":
    unittest.main()
