"""Observe one HA HLS output and retire its unused worker through HA's timer.

HA owns HTTP handlers, worker shutdown and recording/preload decisions. This
observer owns a stream-local quiet timer and content-free segment-wait counters.
The gateway protects the upstream HTTP response until HA actually closes it,
including during cleanup. Diagnostics consume retained cleanup and wait timings.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timezone
import inspect
import math
from typing import Any


class HlsViewActivity:
    """Observe a reviewed HLS output until cleanup or entity removal.

    Segment and part requests reset HA's public idle timer. The local wrapper
    also schedules an earlier quiet check, allowing HA to close its retained
    worker after the person stops watching. Unsupported contracts keep HA's
    original timeout. Public segment waits retain their original outcomes and
    cancellation while the observer records aggregate timings. Global handlers
    and gateway admission remain owned by HA and the gateway respectively.
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
        self._last_request: float | None = None
        self._cleanup_observation: dict[str, Any] | None = None
        self._awake = output.idle_timer.awake
        self._cleanup = output.cleanup
        self._wrapped_awake: Callable[[], None] | None = None
        self._wrapped_cleanup: Callable[[], None] | None = None
        self._recv = None
        self._wrapped_recv = None
        self._created_at = self._loop.time()
        self._segment_waits = 0
        self._segment_waits_completed = 0
        self._segment_waits_cancelled = 0
        self._segment_waits_failed = 0
        self._segment_wait_max = 0.0
        self._first_segment_ready: float | None = None
        self._two_segments_ready: float | None = None

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
            """Retain only observed cleanup state before HA removes its output."""
            try:
                idle = getattr(output.idle_timer, "idle", None)
            except Exception:
                idle = None
            observer._cleanup_observation = {
                "source": "quiet_timer" if observer.expiring else "ha_output",
                "idle": idle if type(idle) is bool else None,
                "request_gap_seconds": (
                    min(86400, max(0, int(observer._loop.time() - observer._last_request)))
                    if observer._last_request is not None else None
                ),
            }
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

        # Segment waits belong to this output. Never wrap HA's global HTTP
        # handlers or retain a request, URL, segment, or exception text.
        try:
            recv = getattr(output, "recv", None)
        except Exception:
            recv = None
        if inspect.iscoroutinefunction(recv):
            async def receive() -> bool:
                """Measure HA's existing segment wait without changing its outcome."""
                started = observer._loop.time()
                observer._segment_waits = min(2**31 - 1, observer._segment_waits + 1)
                try:
                    result = await recv()
                except asyncio.CancelledError:
                    observer._segment_waits_cancelled = min(2**31 - 1, observer._segment_waits_cancelled + 1)
                    raise
                except Exception:
                    observer._segment_waits_failed = min(2**31 - 1, observer._segment_waits_failed + 1)
                    raise
                else:
                    observer._segment_waits_completed = min(2**31 - 1, observer._segment_waits_completed + 1)
                    if result:
                        elapsed = observer._loop.time() - observer._created_at
                        if observer._first_segment_ready is None:
                            observer._first_segment_ready = elapsed
                        try:
                            if len(output.sequences) >= 2 and observer._two_segments_ready is None:
                                observer._two_segments_ready = elapsed
                        except Exception:
                            pass
                    return result
                finally:
                    observer._segment_wait_max = max(observer._segment_wait_max, observer._loop.time() - started)

            try:
                output.recv = receive
                observer._recv = recv
                observer._wrapped_recv = receive
            except (AttributeError, TypeError):
                pass
        return observer

    def _request(self) -> None:
        if self._closed or self.expiring:
            return
        self._requests = min(2**31 - 1, self._requests + 1)
        self._last_request = self._loop.time()
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
        """Retain content-free cleanup and public segment-wait observations.

        Ready times start at observer installation and are sampled when a wait
        returns. They do not measure HTTP response completion or displayed video,
        and may follow the actual arrival of an already buffered segment.
        """
        result = {"installed": not self._closed, "requests": self._requests,
                  "quiet_seconds": self._quiet_seconds, "expiring": self.expiring}
        try:
            settings = self.output.stream_settings
            for key, value in (
                ("minimum_segment_seconds", settings.min_segment_duration),
                ("target_segment_seconds", self.output.target_duration),
            ):
                if type(value) in (int, float) and math.isfinite(value) and 0 < value <= 30:
                    result[key] = value
            if type(settings.ll_hls) is bool:
                result["ll_hls"] = settings.ll_hls
        except Exception:
            pass
        if self._cleanup_observation is not None:
            result["cleanup"] = dict(self._cleanup_observation)
        if self._recv is not None:
            result["segment_wait"] = {
                "calls": self._segment_waits,
                "completed": self._segment_waits_completed,
                "cancelled": self._segment_waits_cancelled,
                "failed": self._segment_waits_failed,
                "max_seconds": round(min(86400, max(0, self._segment_wait_max)), 3),
                "first_ready_observed_seconds": (
                    round(min(86400, max(0, self._first_segment_ready)), 3)
                    if self._first_segment_ready is not None else None
                ),
                "two_ready_observed_seconds": (
                    round(min(86400, max(0, self._two_segments_ready)), 3)
                    if self._two_segments_ready is not None else None
                ),
            }
        return result

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
            if self._wrapped_recv is not None and self.output.recv is self._wrapped_recv:
                self.output.recv = self._recv
        except (AttributeError, TypeError):
            pass
