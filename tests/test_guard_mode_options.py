"""Verify private custom-mode labels without importing Home Assistant.

The integration owns the local option mapping. Synthetic station dictionaries
exercise that boundary without contacting the gateway, account, or hardware.
"""
from __future__ import annotations

import ast
from pathlib import Path
from typing import Any
import unittest


SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/select.py"


class GuardModeOptionsTest(unittest.TestCase):
    """Keep custom labels private, unique, and tied to numeric custom modes."""

    def setUp(self) -> None:
        """Load the pure option helper and stable mode constants."""
        tree = ast.parse(SOURCE.read_text())
        nodes = [
            node for node in tree.body
            if (
                isinstance(node, ast.FunctionDef)
                and node.name == "_guard_mode_options"
            )
        ]
        namespace: dict[str, Any] = {
            "Any": Any,
            "GUARD_MODES": {
                0: "away", 1: "home", 2: "schedule", 3: "custom_1",
                4: "custom_2", 5: "custom_3", 47: "geofencing", 63: "disarmed",
            },
        }
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), "exec"), namespace)
        self.options = namespace["_guard_mode_options"]

    def test_confirmed_custom_names_replace_only_their_modes(self) -> None:
        """Preserve built-in tokens while displaying reported custom names."""
        options = self.options({"guardModeNames": {"3": "Garden", "5": "Night"}})
        self.assertEqual(options[0], "away")
        self.assertEqual(options[3], "Garden")
        self.assertEqual(options[4], "custom_2")
        self.assertEqual(options[5], "Night")

    def test_ambiguous_and_malformed_names_keep_generic_tokens(self) -> None:
        """Avoid duplicate options and reject untrusted API values."""
        options = self.options({"guardModeNames": {
            "3": "home", "4": "Same", "5": "Same", "0": "Not custom",
        }})
        self.assertEqual(options[3], "custom_1")
        self.assertEqual(options[4], "custom_2")
        self.assertEqual(options[5], "custom_3")
        for names in [None, [], {"3": " bad "}, {"3": "line\nbreak"}, {"3": "x" * 65}]:
            with self.subTest(names=names):
                self.assertEqual(self.options({"guardModeNames": names})[3], "custom_1")


if __name__ == "__main__":
    unittest.main()
