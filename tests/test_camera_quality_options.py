"""Validate native quality choices without importing Home Assistant.

The integration owns entity state and discovery. CI executes the extracted pure
mapping boundary with malformed gateway responses and exact native choices.
"""
from __future__ import annotations

import ast
from pathlib import Path
from typing import Any
import unittest

SOURCE = Path(__file__).parents[1] / 'custom_components/eufy_event_gateway/select.py'


class StreamingQualityOptionsTest(unittest.TestCase):
    """Keep invalid or unknown gateway options out of Home Assistant selectors."""

    def setUp(self) -> None:
        """Load only the pure mapping function, leaving HA lifecycle code untouched."""
        tree = ast.parse(SOURCE.read_text())
        function = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == '_streaming_quality_modes'
        )
        namespace: dict[str, Any] = {'Any': Any}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(SOURCE), 'exec'), namespace)
        self.map_modes = namespace['_streaming_quality_modes']

    def test_native_choices_have_distinct_translation_keys(self) -> None:
        """Preserve Auto and all three app-confirmed resolution choices."""
        modes = [{'value': index, 'name': name} for index, name in enumerate(['Auto', 'HD (720P)', 'Full HD (1080P)', '2K'])]
        self.assertEqual(self.map_modes({'streamingQualityModes': modes}), {0: 'auto', 1: 'hd', 2: 'full_hd', 3: '2k'})

    def test_malformed_values_and_labels_are_rejected(self) -> None:
        """Reject booleans, arbitrary strings and unhashable labels safely."""
        for modes in [None, 'Auto', {}, [None], [{'value': 4, 'name': 'Auto'}], [{'value': True, 'name': 'Auto'}], [{'value': '0', 'name': 'Auto'}], [{'value': 0, 'name': []}], [{'value': 0, 'name': 'Unknown'}]]:
            with self.subTest(modes=modes):
                self.assertEqual(self.map_modes({'streamingQualityModes': modes}), {})


if __name__ == '__main__':
    unittest.main()
