"""Verify durable camera fallbacks using private temporary storage.

Tests load the shipped cache with a synthetic client exception boundary. No
HA runtime, vendor connection, real device identifier or private image is used.
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest


ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"
CLIENT = ModuleType("image_cache_test.client")
CLIENT.GatewayClientError = type("GatewayClientError", (Exception,), {})
sys.modules["image_cache_test.client"] = CLIENT
SPEC = importlib.util.spec_from_file_location("image_cache_test.image_cache", ROOT / "image_cache.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ImageCacheTest(unittest.IsolatedAsyncioTestCase):
    """Keep last-good images through missing responses and process restarts."""

    async def test_real_image_survives_restart_and_placeholder_response(self) -> None:
        """Do not replace a durable picture with a temporary waiting image."""
        placeholder = (ROOT / "waiting-image.jpg").read_bytes()
        good = placeholder[:2] + b"\xff\xfe\x00\x06test" + placeholder[2:]
        with tempfile.TemporaryDirectory() as directory:
            cache = MODULE.CameraImageCache(Path(directory), asyncio.to_thread)

            async def current() -> bytes:
                return good

            self.assertEqual(await cache.async_image("synthetic", "snapshot", current), good)
            filenames = list(Path(directory).iterdir())
            self.assertEqual(len(filenames), 1)
            self.assertNotIn("synthetic", filenames[0].name)
            self.assertEqual(filenames[0].stat().st_mode & 0o777, 0o600)
            restarted = MODULE.CameraImageCache(Path(directory), asyncio.to_thread)

            async def waiting() -> bytes:
                return placeholder

            self.assertEqual(await restarted.async_image("synthetic", "snapshot", waiting), good)
            self.assertEqual(await restarted.async_image("synthetic", "event-image", waiting), good)

    async def test_empty_failed_and_truncated_responses_never_return_nothing(self) -> None:
        """Supply a labelled picture even before the first successful capture."""
        with tempfile.TemporaryDirectory() as directory:
            cache = MODULE.CameraImageCache(Path(directory), asyncio.to_thread)
            placeholder = (ROOT / "waiting-image.jpg").read_bytes()

            async def failed() -> bytes:
                raise CLIENT.GatewayClientError("Unavailable")

            self.assertEqual(await cache.async_image("synthetic", "snapshot", failed), placeholder)
            for data in (None, b"", b"\xff\xd8truncated", b"not a picture"):
                async def invalid() -> bytes | None:
                    return data

                self.assertEqual(await cache.async_image("synthetic", "snapshot", invalid), placeholder)
            self.assertEqual(list(Path(directory).iterdir()), [])
