"""Verify model-specific night vision values at the Home Assistant boundary.

Tests compile the shipped mode parser without Home Assistant imports. Fixtures
own their state, and no camera, gateway or account is contacted.
"""
from __future__ import annotations

import ast
from pathlib import Path
import unittest


class NightVisionModesTest(unittest.TestCase):
    """Protect forced infrared options from being dropped by the adapter allowlist."""

    def test_solocam_modes_keep_their_wire_values(self) -> None:
        """Retain value three and its translated option key alongside older labels."""
        source = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/select.py"
        tree = ast.parse(source.read_text())
        nodes = [ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)]
        nodes += [node for node in tree.body if (
            isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "NIGHT_VISION_MODE_KEYS" for target in node.targets)
        ) or (isinstance(node, ast.FunctionDef) and node.name == "_night_vision_modes")]
        namespace = {}
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(source), "exec"), namespace)
        parse = namespace["_night_vision_modes"]
        self.assertEqual(parse({"nightVisionModes": [
            {"value": 3, "name": "Infrared on"},
            {"value": 1, "name": "Infrared"},
            {"value": 0, "name": "Off"},
        ]}), {3: "infrared_on", 1: "infrared", 0: "off"})
        self.assertEqual(parse({"nightVisionModes": [
            {"value": 0, "name": "Colour"},
            {"value": 2, "name": "Spotlight"},
        ]}), {0: "colour", 2: "spotlight"})


if __name__ == "__main__":
    unittest.main()
