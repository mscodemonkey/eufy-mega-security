"""Protect complete Home Assistant translation coverage.

The integration owns its English source and packaged fallback files. These
tests keep both copies aligned and stop platform entities from bypassing that
boundary with hard-coded names.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]
INTEGRATION = ROOT / "custom_components/eufy_event_gateway"
PLATFORM_FILES = (
    "alarm_control_panel.py",
    "binary_sensor.py",
    "button.py",
    "camera.py",
    "number.py",
    "select.py",
    "sensor.py",
    "siren.py",
    "switch.py",
)


class TranslationContractTest(unittest.TestCase):
    """Verify packaged translations cover every integration-owned entity name."""

    def test_english_translation_matches_source_strings(self) -> None:
        """Keep the custom-integration fallback complete and reviewable."""
        source = json.loads((INTEGRATION / "strings.json").read_text())
        english = json.loads(
            (INTEGRATION / "translations/en.json").read_text()
        )

        self.assertEqual(english, source)

    def test_platform_entities_do_not_hard_code_names(self) -> None:
        """Require integration-owned entity labels to use translation keys."""
        hard_coded: list[str] = []
        for filename in PLATFORM_FILES:
            tree = ast.parse((INTEGRATION / filename).read_text())
            for node in ast.walk(tree):
                if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                    continue
                targets = (
                    node.targets if isinstance(node, ast.Assign) else [node.target]
                )
                value = node.value
                if value is None or not isinstance(value, (ast.Constant, ast.JoinedStr)):
                    continue
                if isinstance(value, ast.Constant) and value.value is None:
                    continue
                for target in targets:
                    name = (
                        target.attr
                        if isinstance(target, ast.Attribute)
                        else target.id if isinstance(target, ast.Name) else None
                    )
                    if name == "_attr_name":
                        hard_coded.append(f"{filename}:{node.lineno}")

        self.assertEqual(hard_coded, [])


if __name__ == "__main__":
    unittest.main()
