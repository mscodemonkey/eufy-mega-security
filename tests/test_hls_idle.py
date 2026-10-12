"""Exercise the opt-in HLS boundary without opening a camera.

Tests execute the camera hook against an owned provider factory. Home
Assistant owns viewer timers, checked separately against its actual source.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock


SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/camera.py"


class HlsIdleTest(unittest.IsolatedAsyncioTestCase):
    """Keep the opt-in confined to the selected camera's HLS defaults."""

    def setUp(self) -> None:
        """Load the real hook with a synthetic HA camera base."""
        tree = ast.parse(SOURCE.read_text())
        camera = next(n for n in tree.body if isinstance(n, ast.ClassDef)
                      and n.name == "EufyGatewayCamera")
        method = next(n for n in camera.body if isinstance(n, ast.AsyncFunctionDef)
                      and n.name == "async_create_stream")
        base = type("CameraBase", (), {"async_create_stream": AsyncMock()})
        cls = ast.ClassDef(name="TestCamera", bases=[ast.Name(id="CameraBase", ctx=ast.Load())],
                           keywords=[], body=[method], decorator_list=[])
        module = ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[]))
        namespace = {"CameraBase": base, "Stream": object, "StreamOutput": object}
        exec(compile(module, str(SOURCE), "exec"), namespace)
        self.base = base
        self.camera = namespace["TestCamera"]()
        self.camera._short_hls_idle = True
        self.camera._hls_idle_stream = None
        self.original = Mock(return_value=object())
        self.stream = SimpleNamespace(add_provider=self.original)
        base.async_create_stream.return_value = self.stream

    async def test_default_off_and_missing_stream_preserve_ha(self) -> None:
        """Do not intercept providers without an explicit opt-in."""
        self.camera._short_hls_idle = False
        self.assertIs(await self.camera.async_create_stream(), self.stream)
        self.assertIs(self.stream.add_provider, self.original)
        self.original.assert_not_called()
        self.camera._short_hls_idle = True
        self.base.async_create_stream.return_value = None
        self.assertIsNone(await self.camera.async_create_stream())

    async def test_only_requested_hls_default_changes(self) -> None:
        """Leave recordings and explicit timeouts with their original owner."""
        await self.camera.async_create_stream()
        self.original.assert_not_called()
        self.assertIs(self.stream.add_provider("hls"), self.original.return_value)
        self.original.assert_called_with("hls", timeout=60)
        self.stream.add_provider("recorder", 240)
        self.original.assert_called_with("recorder", timeout=240)
        self.stream.add_provider("recorder")
        self.original.assert_called_with("recorder", timeout=None)
        self.stream.add_provider("hls", 120)
        self.original.assert_called_with("hls", timeout=120)

    async def test_cached_and_replaced_streams_keep_one_wrapper(self) -> None:
        """Install once per stream, including a replacement from HA."""
        await self.camera.async_create_stream()
        wrapper = self.stream.add_provider
        await self.camera.async_create_stream()
        self.assertIs(self.stream.add_provider, wrapper)
        self.stream.add_provider("hls")
        self.original.assert_called_once_with("hls", timeout=60)
        replacement_factory = Mock()
        self.base.async_create_stream.return_value = SimpleNamespace(add_provider=replacement_factory)
        replacement = await self.camera.async_create_stream()
        replacement.add_provider("hls")
        replacement_factory.assert_called_once_with("hls", timeout=60)

    async def test_other_streams_and_failures_stay_with_ha(self) -> None:
        """Never globally replace the provider method or hide failures."""
        other = SimpleNamespace(add_provider=Mock())
        await self.camera.async_create_stream()
        other.add_provider("hls")
        other.add_provider.assert_called_once_with("hls")
        self.original.side_effect = RuntimeError("provider failed")
        with self.assertRaisesRegex(RuntimeError, "provider failed"):
            self.stream.add_provider("hls")


if __name__ == "__main__":
    unittest.main()
