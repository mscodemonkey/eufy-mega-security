"""Observe one HA HLS output and retire its unused worker through HA's timer.

HA owns HTTP handlers, worker shutdown and recording/preload decisions. This
observer owns only a stream-local quiet timer. The gateway keeps protecting the
upstream HTTP response until HA actually closes it, including during cleanup.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timezone
import math
from typing import Any


class HlsViewActivity:
    """Observe a reviewed HLS output until cleanup or entity removal.

    Segment and part requests reset HA's public idle timer. The local wrapper
    also schedules an earlier quiet check, allowing HA to close its retained
    worker after the person stops watching. Unsupported contracts keep HA's
    original timeout. No global handler or gateway admission flag is modified.
    """

    def __init__(self, output: Any, allowed: Callable[[], bool], quiet_seconds: float) -> None:
        """Own the output's wrapper and quiet deadline, leaving HA state with HA."""
        self.output = output
        self.expiring = False
        self._allowed = allowed
        self._quiet_seconds = quiet_seconds
        self._loop = asyncio.get_running_loop()
        self._timer: asyncio.TimerHandle | None = None
        self._closed = False
        self._requests = 0
        self._awake = output.idle_timer.awake
        self._cleanup = output.cleanup
        self._wrapped_awake: Callable[[], None] | None = None
        self._wrapped_cleanup: Callable[[], None] | None = None

    @classmethod
    def install(cls, output: Any, allowed: Callable[[], bool]) -> HlsViewActivity | None:
        """Attach only to the reviewed HA public output and timer contract.

        The quiet deadline exceeds both normal segment cadence and a pending
        part's timeout. Failure leaves the ordinary HA timeout and the protected
        gateway response in place.
        """
        try:
            timer = getattr(output, "idle_timer", None)
            duration = getattr(output, "target_duration", None)
            part_timeout = getattr(getattr(output, "stream_settings", None), "hls_part_timeout", None)
            if (type(output).__module__ != "homeassistant.components.stream.hls"
                    or type(output).__name__ != "HlsStreamOutput"
                    or type(timer).__module__ != "homeassistant.components.stream.core"
                    or type(timer).__name__ != "IdleTimer"
                    or type(duration) not in (int, float) or not math.isfinite(duration)
                    or not 0.1 <= duration <= 30
                    or type(part_timeout) not in (int, float) or not math.isfinite(part_timeout)
                    or not 0 < part_timeout <= 30
                    or any(not callable(getattr(timer, name, None)) for name in ("awake", "clear", "fire"))
                    or not callable(getattr(output, "cleanup", None))):
                return None
        except Exception:
            return None
        observer = cls(output, allowed, max(4.0, 2 * duration, part_timeout + 2))

        def awake() -> None:
            """Keep HA's ordinary timer and observe a real part or segment request."""
            observer._awake()
            observer._request()

        def cleanup() -> None:
            """Retire only observer state before HA cleans up its output."""
            observer.close()
            observer._cleanup()

        observer._wrapped_awake = awake
        observer._wrapped_cleanup = cleanup
        try:
            timer.awake = awake
            output.cleanup = cleanup
        except (AttributeError, TypeError):
            observer.close()
            return None
        return observer

    def _request(self) -> None:
        if self._closed or self.expiring:
            return
        self._requests = min(2**31 - 1, self._requests + 1)
        if self._timer is not None:
            self._timer.cancel()
        self._timer = self._loop.call_later(self._quiet_seconds, self._quiet)

    def _quiet(self) -> None:
        self._timer = None
        if self._closed:
            return
        try:
            if not self._allowed():
                return
            self.expiring = True

            # Cancel HA's original alarm before firing it. A second late alarm
            # could otherwise remove a replacement HLS output on the same stream.
            self.output.idle_timer.clear()
            self.output.idle_timer.fire(datetime.now(timezone.utc))
        except Exception:
            self.expiring = False
            self._awake()

    def diagnostic(self) -> dict[str, Any]:
        """Return counters for this output, without tokens or viewer identities."""
        return {"installed": not self._closed, "requests": self._requests,
                "quiet_seconds": self._quiet_seconds, "expiring": self.expiring}

    def close(self) -> None:
        """Cancel the local quiet timer and restore this output's methods."""
        if self._closed:
            return
        self._closed = True
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        try:
            if self.output.idle_timer.awake is self._wrapped_awake:
                self.output.idle_timer.awake = self._awake
            if self.output.cleanup is self._wrapped_cleanup:
                self.output.cleanup = self._cleanup
        except (AttributeError, TypeError):
            pass
