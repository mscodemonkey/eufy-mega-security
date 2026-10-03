"""Retain last-good camera images independently of gateway availability.

Each coordinator owns one cache. HA's executor owns disk IO under the private
configuration storage directory, while camera entities request images through
this boundary. Hashed filenames contain no device identifiers. Placeholder
bytes are never retained as real camera images or allowed to replace them.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from hashlib import sha256
import logging
import os
from pathlib import Path
import tempfile
from typing import Any

from .client import GatewayClientError


_LOGGER = logging.getLogger(__name__)


class CameraImageCache:
    """Own memory and durable fallback images for one coordinator's lifetime.

    Reads never wake a device. Real images survive gateway and HA restarts.
    Missing event images may fall back to a retained ordinary snapshot, but
    ordinary snapshots never borrow an event image from another camera.
    """

    def __init__(self, directory: Path, executor: Callable[..., Awaitable[Any]]) -> None:
        """Bind private storage and HA's non-blocking executor without touching disk."""
        self._directory = directory
        self._executor = executor
        self._images: dict[tuple[str, str], bytes | None] = {}
        self._placeholder: bytes | None = None
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def async_image(self, serial: str, kind: str, fetch: Callable[[], Awaitable[bytes | None]]) -> bytes:
        """Return a current image, a last-good image, or the explicit waiting picture."""
        if kind not in ("snapshot", "event-image"):
            raise ValueError("Unsupported image kind")
        key = (serial, kind)
        async with self._locks.setdefault(key, asyncio.Lock()):
            if self._placeholder is None:
                self._placeholder = await self._executor(Path(__file__).with_name("waiting-image.jpg").read_bytes)
            previous = await self._load(key)
            try:
                data = await asyncio.wait_for(fetch(), timeout=3)
            except (GatewayClientError, TimeoutError):
                data = b""
            if usable_image(data) and data != self._placeholder:
                if data != previous:
                    self._images[key] = data
                    try:
                        await self._executor(self._write, key, data)
                    except OSError:
                        _LOGGER.warning("Could not persist a camera fallback image")
                return data
            if previous:
                return previous
            alternate = "snapshot" if kind == "event-image" else "event-image"
            retained = await self._load((serial, alternate))
            return retained or self._placeholder

    async def _load(self, key: tuple[str, str]) -> bytes | None:
        if key not in self._images:
            try:
                data = await self._executor(self._read, key)
            except OSError:
                data = b""
            self._images[key] = data if usable_image(data) else None
        return self._images[key]

    def _path(self, key: tuple[str, str]) -> Path:
        digest = sha256((key[0] + ":" + key[1]).encode()).hexdigest()
        return self._directory / (digest + ".jpg")

    def _read(self, key: tuple[str, str]) -> bytes:
        with self._path(key).open("rb") as stream:
            return stream.read(4 * 1024 * 1024 + 1)

    def _write(self, key: tuple[str, str], data: bytes) -> None:
        self._directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=self._directory, suffix=".tmp")
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
            os.replace(temporary, self._path(key))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def usable_image(data: bytes | None) -> bool:
    """Reject empty, oversized and visibly incomplete JPEG responses at the cache boundary."""
    return isinstance(data, bytes) and 4 <= len(data) <= 4 * 1024 * 1024 and data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9"
