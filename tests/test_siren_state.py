"""Exercise production siren state properties without hardware or HA imports.

The gateway owns observed alarm state. These checks keep the HA adapter from
inventing an off state when the device has supplied no readable value.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/siren.py"


def siren_state(class_name: str, station: dict) -> bool | None:
    """Evaluate the real property body against inert coordinator state."""
    tree = ast.parse(SOURCE.read_text())
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                 and node.name == class_name)
    method = next(node for node in owner.body if isinstance(node, ast.FunctionDef)
                  and node.name == "is_on")
    method.decorator_list = []
    namespace = {}
    exec(compile(ast.Module(body=[method], type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace["is_on"](SimpleNamespace(station=station))


class SirenStateTest(unittest.TestCase):
    """Distinguish explicit off from unavailable device feedback."""

    def test_homebase_preserves_explicit_state(self) -> None:
        """Accept both real boolean values without coercing malformed feedback."""
        for value in (True, False):
            self.assertIs(siren_state("EufyHomeBaseSiren", {"alarmActive": value}), value)
        for value in (None, 0, 1, "false", "true", {}, []):
            with self.subTest(value=value):
                self.assertIsNone(siren_state("EufyHomeBaseSiren", {"alarmActive": value}))
        self.assertIsNone(siren_state("EufyHomeBaseSiren", {}))

    def test_camera_without_readback_stays_unknown(self) -> None:
        """Command-only camera support cannot report physical siren state."""
        self.assertIsNone(siren_state("EufyCameraSiren", {}))


if __name__ == "__main__":
    unittest.main()
