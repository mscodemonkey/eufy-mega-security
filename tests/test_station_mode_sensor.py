"""Exercise configured-mode sensor semantics without Home Assistant imports.

The integration owns model-specific labels. Synthetic coordinator state drives
the actual sensor properties without an account, vendor transport or hardware.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import ClassVar
import unicodedata
import unittest


ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


class StationModeSensorTest(unittest.TestCase):
    """Protect the boundary between NVR policies and HomeBase custom slots."""

    def setUp(self) -> None:
        """Load the production sensor with inert entity base classes."""
        constants_tree = ast.parse((ROOT / "const.py").read_text())
        constants = {}
        mode_nodes = [node for node in constants_tree.body
                      if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id.startswith("GUARD_MODE")
                              for target in node.targets)]
        exec(compile(ast.Module(body=mode_nodes, type_ignores=[]), str(ROOT / "const.py"), "exec"), constants)
        tree = ast.parse((ROOT / "sensor.py").read_text())
        sensor = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                      and node.name == "EufyGuardModeSensor")
        helper_tree = ast.parse((ROOT / "guard_mode_options.py").read_text())
        helper_nodes = [
            node for node in helper_tree.body if isinstance(node, ast.FunctionDef)
        ]
        namespace = {
            "EufyStationEntity": type("StationEntity", (), {}),
            "SensorEntity": type("SensorEntity", (), {}),
            "SensorDeviceClass": type("DeviceClass", (), {"ENUM": "enum"}),
            "EufyGatewayCoordinator": object,
            "ClassVar": ClassVar,
            "GUARD_MODES": constants["GUARD_MODES"],
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
                ast.Module(body=[sensor], type_ignores=[]),
                str(ROOT / "sensor.py"),
                "exec",
            ),
            namespace,
        )
        sensor_class = namespace["EufyGuardModeSensor"]
        self.sensor = sensor_class.__new__(sensor_class)

    def test_nvr_custom_mode_and_geofencing_use_catalogue_numbers(self) -> None:
        """Decode confirmed custom mode three and catalogue Geofencing 47."""
        for model in ("T8N00", "T8N001"):
            with self.subTest(model=model):
                self.sensor.station = {
                    "model": model,
                    "guardMode": 3,
                    "guardModeNames": {"3": "Garden"},
                }
                self.assertEqual(self.sensor.native_value, "Garden")
                self.assertIn(self.sensor.native_value, self.sensor.options)
                for value, expected in (
                    (4, "custom_2"),
                    (5, "custom_3"),
                    (47, "geofencing"),
                ):
                    self.sensor.station["guardMode"] = value
                    self.assertEqual(self.sensor.native_value, expected)
                    self.assertIn(self.sensor.native_value, self.sensor.options)

    def test_homebase_and_unknown_models_keep_existing_mapping(self) -> None:
        """Avoid applying the NVR numbering to other station families."""
        for model in ("T8030", "T8010", "T8N01", None):
            with self.subTest(model=model):
                self.sensor.station = {
                    "model": model,
                    "guardMode": 3,
                    "guardModeNames": {"3": "Night"},
                }
                self.assertEqual(self.sensor.native_value, "Night")
                self.assertIn(self.sensor.native_value, self.sensor.options)
                self.sensor.station.pop("guardModeNames")
                self.assertEqual(self.sensor.native_value, "custom_1")

    def test_nvr_other_policies_and_unknown_values(self) -> None:
        """Reject malformed state and HomeBase-only policy values."""
        for value, expected in ((0, "away"), (1, "home"), (2, "schedule"),
                                (3, "custom_1"), (4, "custom_2"),
                                (5, "custom_3"), (47, "geofencing"),
                                (63, "disarmed"), (None, None),
                                ("3", None), (True, None)):
            with self.subTest(value=value):
                self.sensor.station = {"model": "T8N00", "guardMode": value}
                self.assertEqual(self.sensor.native_value, expected)


if __name__ == "__main__":
    unittest.main()
