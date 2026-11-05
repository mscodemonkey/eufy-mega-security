"""Exercise speaker-file admission without importing Home Assistant.

Tests execute the shipped entity method with HA effects replaced by mocks.
The gateway tests and hardware run own AAC validation and physical playback.
"""
from __future__ import annotations

import ast
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/camera.py"


class CameraSpeakerAudioTest(unittest.IsolatedAsyncioTestCase):
    """Reject unsafe file access before borrowing executor or gateway effects."""

    def setUp(self):
        """Load only the production file reader and speaker action."""
        tree = ast.parse(SOURCE.read_text())
        reader = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_read_speaker_audio")
        camera = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "EufyGatewayCamera")
        method = next(n for n in camera.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "async_play_audio")
        namespace = {"HomeAssistantError": RuntimeError, "GatewayClientError": ConnectionError}
        exec(compile(ast.Module(body=[reader, method], type_ignores=[]), str(SOURCE), "exec"), namespace)
        self.read = namespace["_read_speaker_audio"]
        self.play = namespace["async_play_audio"]

    async def test_unadmitted_camera_and_path_do_not_open_files(self):
        """Check capability and HA's allowlist before requesting file bytes."""
        executor = AsyncMock()
        client = SimpleNamespace(play_audio=AsyncMock())
        entity = SimpleNamespace(camera={}, serial="synthetic", coordinator=SimpleNamespace(client=client),
                                 hass=SimpleNamespace(config=SimpleNamespace(is_allowed_path=Mock(return_value=False)), async_add_executor_job=executor))
        with self.assertRaises(RuntimeError):
            await self.play(entity, "/private/outside.aac")
        entity.camera = {"talkbackSupported": True}
        with self.assertRaises(RuntimeError):
            await self.play(entity, "/private/outside.aac")
        executor.assert_not_awaited()
        client.play_audio.assert_not_awaited()

    def test_bounded_reader_preserves_caller_file(self):
        """Reject empty and oversized data without modifying caller-owned files."""
        with TemporaryDirectory() as directory:
            path = Path(directory) / "speaker.aac"
            for data in [b"", b"x" * 320_001]:
                path.write_bytes(data)
                with self.assertRaises(ValueError):
                    self.read(str(path))
                self.assertEqual(path.read_bytes(), data)
            path.write_bytes(b"synthetic audio")
            self.assertEqual(self.read(str(path)), b"synthetic audio")

    async def test_audio_bytes_cross_gateway_boundary_without_local_path(self):
        """Keep HA filenames local and pass only bounded data to the gateway."""
        client = SimpleNamespace(play_audio=AsyncMock())
        entity = SimpleNamespace(camera={"talkbackSupported": True}, serial="synthetic", coordinator=SimpleNamespace(client=client),
                                 hass=SimpleNamespace(config=SimpleNamespace(is_allowed_path=Mock(return_value=True)), async_add_executor_job=AsyncMock(return_value=b"synthetic audio")))
        await self.play(entity, "/media/speaker.aac")
        client.play_audio.assert_awaited_once_with("synthetic", b"synthetic audio")
