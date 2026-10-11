"""Exercise guard-mode select mapping without importing Home Assistant.

Synthetic coordinator state drives the production select class and shared
label helper. The test owns no account, registry, transport or hardware state.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar
import unicodedata
import unittest


ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


class HomeAssistantError(Exception):
    """Stand in for Home Assistant's user-visible service error."""


class GatewayClientError(Exception):
    """Stand in for a validated gateway client failure."""


class StationEntity:
    """Provide the coordinator state boundary used by the production select."""

    def __init__(self, coordinator: Any, serial: str) -> None:
        """Retain the synthetic coordinator and station identity."""
        self.coordinator = coordinator
        self.serial = serial

    @property
    def station(self) -> dict[str, Any]:
        """Return the current synthetic station state."""
        return self.coordinator.stations[self.serial]

    def set_confirmed_station(self, station: dict[str, Any]) -> None:
        """Publish the synthetic gateway-confirmed station state."""
        self.coordinator.stations[self.serial] = station


class SelectEntity:
    """Provide the inert Home Assistant entity lifecycle needed by the class."""

    def __init__(self) -> None:
        """Create an entity without registry side effects."""


class GuardModeSelectTest(unittest.IsolatedAsyncioTestCase):
    """Protect label display and reverse mapping for security modes."""

    def setUp(self) -> None:
        """Load the production helper and select class with inert boundaries."""
        constants_tree = ast.parse((ROOT / "const.py").read_text())
        constants = {}
        mode_nodes = [
            node
            for node in constants_tree.body
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id.startswith("GUARD_MODE")
                for target in node.targets
            )
        ]
        exec(
            compile(
                ast.Module(body=mode_nodes, type_ignores=[]),
                str(ROOT / "const.py"),
                "exec",
            ),
            constants,
        )
        helper_tree = ast.parse((ROOT / "guard_mode_options.py").read_text())
        helper_nodes = [
            node for node in helper_tree.body if isinstance(node, ast.FunctionDef)
        ]
        select_tree = ast.parse((ROOT / "select.py").read_text())
        select_class = next(
            node
            for node in select_tree.body
            if isinstance(node, ast.ClassDef) and node.name == "EufyGuardModeSelect"
        )
        namespace = {
            "Any": Any,
            "ClassVar": ClassVar,
            "EufyGatewayCoordinator": object,
            "EufyStationEntity": StationEntity,
            "GatewayClientError": GatewayClientError,
            "GUARD_MODES": constants["GUARD_MODES"],
            "HomeAssistantError": HomeAssistantError,
            "SelectEntity": SelectEntity,
            "unicodedata": unicodedata,
        }
        exec(
            compile(
                ast.Module(body=helper_nodes, type_ignores=[]),
                str(ROOT / "guard_mode_options.py"),
                "exec",
            ),
            namespace,
        )
        exec(
            compile(
                ast.Module(body=[select_class], type_ignores=[]),
                str(ROOT / "select.py"),
                "exec",
            ),
            namespace,
        )
        self.client = SimpleNamespace()
        self.sent_modes: list[int] = []

        async def set_station_guard_mode(serial: str, mode: int) -> dict[str, Any]:
            self.sent_modes.append(mode)
            return {"serial": serial, "guardMode": mode}

        self.client.set_station_guard_mode = set_station_guard_mode
        coordinator = SimpleNamespace(
            client=self.client,
            stations={
                "station": {
                    "serial": "station",
                    "guardMode": 3,
                    "guardModeNames": {"3": "Garden"},
                }
            },
        )
        self.select = namespace["EufyGuardModeSelect"](coordinator, "station")

    async def test_options_current_state_and_commands_share_one_mapping(self) -> None:
        """Send the numeric mode represented by each displayed option."""
        self.assertIn("Garden", self.select.options)
        self.assertEqual(self.select.current_option, "Garden")
        await self.select.async_select_option("Garden")
        await self.select.async_select_option("geofencing")
        self.assertEqual(self.sent_modes, [3, 47])

    async def test_unknown_option_and_gateway_failure_remain_visible(self) -> None:
        """Reject unknown labels and wrap validated client failures."""
        with self.assertRaises(HomeAssistantError):
            await self.select.async_select_option("Not a mode")

        async def fail(_serial: str, _mode: int) -> dict[str, Any]:
            raise GatewayClientError("offline")

        self.client.set_station_guard_mode = fail
        with self.assertRaisesRegex(HomeAssistantError, "Could not change"):
            await self.select.async_select_option("home")

    def test_boolean_state_is_not_decoded_as_home(self) -> None:
        """Keep booleans outside the numeric security-mode contract."""
        self.select.coordinator.stations["station"]["guardMode"] = True
        self.assertIsNone(self.select.current_option)

    def test_helper_has_no_logging_side_effects(self) -> None:
        """Keep private labels out of this boundary's logs."""
        source = (ROOT / "guard_mode_options.py").read_text()
        self.assertNotIn("logger", source.casefold())
        self.assertNotIn("logging", source.casefold())


if __name__ == "__main__":
    unittest.main()
