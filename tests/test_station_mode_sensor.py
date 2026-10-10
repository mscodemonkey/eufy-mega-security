"""Exercise configured-mode sensor semantics without Home Assistant imports.

The integration owns model-specific labels. Synthetic coordinator state drives
the actual sensor properties without an account, vendor transport or hardware.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import ClassVar
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
        namespace = {
            "EufyStationEntity": type("StationEntity", (), {}),
            "SensorEntity": type("SensorEntity", (), {}),
            "SensorDeviceClass": type("DeviceClass", (), {"ENUM": "enum"}),
            "EufyGatewayCoordinator": object,
            "ClassVar": ClassVar,
            "GUARD_MODES": constants["GUARD_MODES"],
        }
        exec(compile(ast.Module(body=[sensor], type_ignores=[]), str(ROOT / "sensor.py"), "exec"), namespace)
        self.sensor = namespace["EufyGuardModeSensor"].__new__(namespace["EufyGuardModeSensor"])

    def test_nvr_geofencing_is_a_valid_sensor_option(self) -> None:
        """Decode NVR policy three rather than displaying a HomeBase slot."""
        for model in ("T8N00", "T8N001"):
            with self.subTest(model=model):
                self.sensor.station = {"model": model, "guardMode": 3}
                self.assertEqual(self.sensor.native_value, "geofencing")
                self.assertIn(self.sensor.native_value, self.sensor.options)
                self.assertNotIn("custom_1", self.sensor.options)

    def test_homebase_and_unknown_models_keep_existing_mapping(self) -> None:
        """Avoid applying the NVR numbering to other station families."""
        for model in ("T8030", "T8010", "T8N01", None):
            with self.subTest(model=model):
                self.sensor.station = {"model": model, "guardMode": 3}
                self.assertEqual(self.sensor.native_value, "custom_1")
                self.assertIn(self.sensor.native_value, self.sensor.options)

    def test_nvr_other_policies_and_unknown_values(self) -> None:
        """Reject malformed state and HomeBase-only policy values."""
        for value, expected in ((0, "away"), (1, "home"), (2, "schedule"),
                                (63, "disarmed"), (4, None), (47, None),
                                (None, None), ("3", None), (True, None)):
            with self.subTest(value=value):
                self.sensor.station = {"model": "T8N00", "guardMode": value}
                self.assertEqual(self.sensor.native_value, expected)


if __name__ == "__main__":
    unittest.main()
