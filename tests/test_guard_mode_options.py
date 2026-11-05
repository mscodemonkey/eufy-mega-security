"""Verify private custom-mode labels without importing Home Assistant.

The integration owns the local option mapping. Synthetic station dictionaries
exercise that boundary without contacting the gateway, account, or hardware.
"""
from __future__ import annotations

import ast
from pathlib import Path
from typing import Any
import unicodedata
import unittest


ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


class GuardModeOptionsTest(unittest.TestCase):
    """Keep custom labels private, unique, and tied to numeric custom modes."""

    def setUp(self) -> None:
        """Load the pure option helper and stable mode constants."""
        tree = ast.parse((ROOT / "guard_mode_options.py").read_text())
        nodes = [
            node for node in tree.body
            if (
                isinstance(node, ast.FunctionDef)
                and node.name in {"guard_mode_options", "guard_mode_label"}
            )
        ]
        namespace: dict[str, Any] = {
            "Any": Any,
            "GUARD_MODES": {
                0: "away", 1: "home", 2: "schedule", 3: "custom_1",
                4: "custom_2", 5: "custom_3", 47: "geofencing", 63: "disarmed",
            },
            "unicodedata": unicodedata,
        }
        source = ROOT / "guard_mode_options.py"
        exec(
            compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"),
            namespace,
        )
        self.options = namespace["guard_mode_options"]
        self.label = namespace["guard_mode_label"]

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

    def test_collisions_and_special_states_are_order_independent(self) -> None:
        """Reject misleading generic tokens, duplicates and special states."""
        for names in (
            {"3": "Garden", "4": "custom_1"},
            {"4": "custom_1", "3": "Garden"},
        ):
            with self.subTest(names=names):
                options = self.options({"guardModeNames": names})
                self.assertEqual(options[3], "Garden")
                self.assertEqual(options[4], "custom_2")
        for name in ("unknown", "Unavailable", "UNAVAILABLE", "Home"):
            with self.subTest(name=name):
                self.assertEqual(
                    self.options({"guardModeNames": {"3": name}})[3], "custom_1"
                )

    def test_unicode_controls_and_separators_are_rejected(self) -> None:
        """Keep invisible formatting characters out of entity state labels."""
        for character in ("\u2028", "\u200e", "\u202e", "\u0085"):
            with self.subTest(character=repr(character)):
                self.assertEqual(
                    self.options({"guardModeNames": {"3": f"A{character}B"}})[3],
                    "custom_1",
                )

    def test_own_token_strict_modes_and_order_remain_stable(self) -> None:
        """Allow a slot's own token while keeping strict state decoding."""
        station = {"guardModeNames": {"3": "custom_1", True: "Ignored"}}
        options = self.options(station)
        self.assertEqual(options[3], "custom_1")
        self.assertEqual(list(options), [0, 1, 2, 3, 4, 5, 47, 63])
        self.assertEqual(self.label(station, 3), "custom_1")
        for value in (True, "3", None):
            with self.subTest(value=value):
                self.assertIsNone(self.label(station, value))


if __name__ == "__main__":
    unittest.main()
