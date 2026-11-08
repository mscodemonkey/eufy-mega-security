"""Check that existing installations keep their video choice when the option changes."""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


ROOT = Path(__file__).parents[1] / "custom_components" / "eufy_event_gateway"


def _migrate():
    """Load the shipped migration without a Home Assistant runtime."""
    tree = ast.parse((ROOT / "__init__.py").read_text())
    function = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "async_migrate_entry")
    namespace = {"CONF_H264_COMPATIBILITY": "h264_compatibility", "CONF_LEGACY_NATIVE_VIDEO": "experimental_native_video"}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(ROOT / "__init__.py"), "exec"), namespace)
    return namespace["async_migrate_entry"]


class VideoChoiceMigrationTest(unittest.IsolatedAsyncioTestCase):
    """Native video stays opt-in for installations that predate the change."""

    def setUp(self) -> None:
        self.migrate = _migrate()
        self.update = Mock()
        self.hass = SimpleNamespace(config_entries=SimpleNamespace(async_update_entry=self.update))

    async def _run(self, options: dict, minor: int = 1, version: int = 1) -> bool:
        entry = SimpleNamespace(version=version, minor_version=minor, options=options)
        return await self.migrate(self.hass, entry)

    async def test_an_installation_on_converted_video_keeps_it(self) -> None:
        for options in ({}, {"experimental_native_video": False}):
            self.update.reset_mock()
            self.assertIs(await self._run({**options, "experimental_short_hls_idle": True}), True)
            self.assertEqual(self.update.call_args.kwargs, {"options": {"experimental_short_hls_idle": True, "h264_compatibility": True}, "minor_version": 2})

    async def test_an_installation_that_opted_into_native_video_keeps_it(self) -> None:
        self.assertIs(await self._run({"experimental_native_video": True, "experimental_fast_native_hls": True}), True)
        self.assertEqual(self.update.call_args.kwargs, {"options": {"experimental_fast_native_hls": True, "h264_compatibility": False}, "minor_version": 2})

    async def test_a_migrated_entry_is_left_alone(self) -> None:
        self.assertIs(await self._run({"h264_compatibility": False}, minor=2), True)
        self.update.assert_not_called()

    async def test_an_unknown_major_version_is_refused(self) -> None:
        self.assertIs(await self._run({}, version=2), False)
        self.update.assert_not_called()

    def test_new_entries_are_created_at_the_migrated_version(self) -> None:
        tree = ast.parse((ROOT / "config_flow.py").read_text())
        flow = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "EufyGatewayConfigFlow")
        values = {node.targets[0].id: ast.literal_eval(node.value) for node in flow.body
                  if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                  and node.targets[0].id in {"VERSION", "MINOR_VERSION"}}
        self.assertEqual(values, {"VERSION": 1, "MINOR_VERSION": 2})


if __name__ == "__main__":
    unittest.main()
