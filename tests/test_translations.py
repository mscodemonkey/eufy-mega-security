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
    "lock.py",
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


    def test_lock_keys_and_select_options_have_names_in_both_locales(self) -> None:
        """Keep stable E30 options and dynamic switch labels complete in both locales."""
        keys = {"lock_auto_lock", "lock_notifications", "lock_locked_notifications", "lock_unlocked_notifications"}
        switch_tree = ast.parse((INTEGRATION / "switch.py").read_text())
        switch_class = next(node for node in switch_tree.body if isinstance(node, ast.ClassDef) and node.name == "EufyLockSettingSwitch")
        mapping = next(node for node in ast.walk(switch_class) if isinstance(node, ast.Dict))
        self.assertEqual(set(ast.literal_eval(mapping).values()), keys)
        select_tree = ast.parse((INTEGRATION / "select.py").read_text())
        select_class = next(node for node in select_tree.body if isinstance(node, ast.ClassDef) and node.name == "EufyLockVolumeSelect")
        options = next(node.value for node in select_class.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "_attr_options" for t in node.targets))
        self.assertEqual(ast.literal_eval(options), ["low", "medium", "high"])
        for locale in ("en", "da"):
            strings = json.loads((INTEGRATION / "translations" / f"{locale}.json").read_text())["entity"]
            for key in keys:
                self.assertTrue(strings["switch"][key]["name"])
            self.assertTrue(strings["select"]["lock_volume"]["name"])
            self.assertEqual(set(strings["select"]["lock_volume"]["state"]), {"low", "medium", "high"})
            for filename in PLATFORM_FILES:
                for node in ast.walk(ast.parse((INTEGRATION / filename).read_text())):
                    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                        if any(isinstance(target, (ast.Name, ast.Attribute)) and getattr(target, "id", getattr(target, "attr", None)) == "_attr_translation_key" for target in node.targets):
                            domain = "sensor" if filename == "lock.py" else filename.removesuffix(".py")
                            self.assertTrue(strings[domain][node.value.value]["name"])


if __name__ == "__main__":
    unittest.main()
