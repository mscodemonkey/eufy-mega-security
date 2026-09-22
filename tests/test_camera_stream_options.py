"""Protect the Home Assistant stream options required by raw gateway video.

The test reads the integration source without importing Home Assistant. CI owns
its execution, and the camera entity consumes the checked option at runtime.
"""

from __future__ import annotations

import ast
from pathlib import Path
import unittest


CAMERA_SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/camera.py"


class CameraStreamOptionsTest(unittest.TestCase):
    """Verify the entity supplies timing metadata at the Home Assistant boundary."""

    def test_live_stream_uses_wallclock_timestamps(self) -> None:
        """Keep Home Assistant from rejecting raw packets that have no DTS."""
        tree = ast.parse(CAMERA_SOURCE.read_text())
        assignments = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Subscript)
                and isinstance(target.value, ast.Attribute)
                and isinstance(target.value.value, ast.Name)
                and target.value.value.id == "self"
                and target.value.attr == "stream_options"
                and isinstance(target.slice, ast.Name)
                and target.slice.id == "CONF_USE_WALLCLOCK_AS_TIMESTAMPS"
                for target in node.targets
            )
        ]

        self.assertEqual(len(assignments), 1)
        self.assertIsInstance(assignments[0].value, ast.Constant)
        self.assertIs(assignments[0].value.value, True)


if __name__ == "__main__":
    unittest.main()
