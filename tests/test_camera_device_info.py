"""Exercise the shared camera device metadata without importing Home Assistant.

The integration owns its device identity. These tests compile its actual
property against a minimal dictionary boundary and verify optional discovery
metadata never inherits station values or breaks older gateway responses.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


class CameraDeviceInfoTest(unittest.TestCase):
    """Protect optional camera metadata across mixed gateway versions."""

    def test_device_versions_are_optional_and_camera_owned(self) -> None:
        """Publish reported versions while retaining the existing stable identity."""
        source = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/entity.py"
        tree = ast.parse(source.read_text())
        entity = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EufyGatewayEntity")
        getter = next(node for node in entity.body if isinstance(node, ast.FunctionDef) and node.name == "device_info")
        getter.decorator_list = []
        namespace = {"DeviceInfo": dict, "DOMAIN": "eufy_event_gateway"}
        exec(compile(ast.Module(body=[tree.body[1], getter], type_ignores=[]), str(source), "exec"), namespace)
        camera = {"model": "T8142", "firmware": "4.1.0", "hardwareVersion": "P1"}
        info = namespace["device_info"](SimpleNamespace(serial="synthetic", camera=camera))
        self.assertEqual(info["sw_version"], "4.1.0")
        self.assertEqual(info["hw_version"], "P1")
        legacy = namespace["device_info"](SimpleNamespace(serial="synthetic", camera={}))
        self.assertIsNone(legacy["sw_version"])
        self.assertIsNone(legacy["hw_version"])
