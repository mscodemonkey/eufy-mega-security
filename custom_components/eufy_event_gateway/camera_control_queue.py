"""Own accepted HA camera requests until gateway confirmation or a visible failure.

The coordinator owns this queue and publishes confirmed responses. Workers are
serial per physical peer, so accepting an HA service call never bypasses gateway
readback or allows simultaneous controls to compete for one HomeBase session.
"""
from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any


class CameraControlNotSentError(RuntimeError):
    """Reject queued work whose captured camera route is no longer eligible."""


@dataclass
class _Request:
    serial: str
    action: str
    operation: Callable[[], Coroutine[Any, Any, dict[str, Any]]]
    expires: float
    started: bool = False


class CameraControlQueue:
    """Retain finite requests for one config entry, with no retry after dispatch.

    HA owns worker tasks through the supplied factory. Closing cancels active
    HTTP waits and discards unsent work. A cancelled dispatched request remains
    ambiguous because the remote gateway may already have sent its command.
    """

    def __init__(
        self,
        create_task: Callable[[Coroutine[Any, Any, None]], asyncio.Task[None]],
        confirmed: Callable[[dict[str, Any]], None],
        failed: Callable[[str, str, str, bool], None],
        changed: Callable[[], None],
        *,
        capacity: int = 32,
        lifetime: float = 120,
    ) -> None:
        """Borrow callbacks and bound outstanding work, including active requests."""
        self._create_task = create_task
        self._confirmed = confirmed
        self._failed = failed
        self._changed = changed
        self._capacity = capacity
        self._lifetime = lifetime
        self._queues: dict[str, deque[_Request]] = {}
        self._workers: dict[str, asyncio.Task[None]] = {}
        self._closed = False

    def pending(self, serial: str, action: str) -> bool:
        """Report acceptance separately from the latest confirmed camera setting."""
        return any(r.serial == serial and r.action == action
                   for queue in self._queues.values() for r in queue)

    def submit(
        self, peer: str, serial: str, action: str,
        operation: Callable[[], Coroutine[Any, Any, dict[str, Any]]],
    ) -> None:
        """Accept without awaiting network I/O, or reject before creating any write."""
        if self._closed:
            raise RuntimeError("Camera controls are unloading. No request was accepted.")
        if sum(len(q) for q in self._queues.values()) >= self._capacity:
            raise RuntimeError("Too many camera settings are pending. No request was accepted.")
        queue = self._queues.setdefault(peer, deque())
        queue.append(_Request(serial, action, operation,
                              asyncio.get_running_loop().time() + self._lifetime))
        if peer not in self._workers:
            worker = self._run(peer)
            try:
                self._workers[peer] = self._create_task(worker)
            except Exception:
                worker.close()
                queue.pop()
                self._queues.pop(peer, None)
                raise
        self._changed()

    async def _run(self, peer: str) -> None:

        # HA can start tasks eagerly. Let submit retain the worker before it
        # can finish and release its peer, including an immediate rejection.
        await asyncio.sleep(0)
        queue = self._queues[peer]
        try:
            while queue and not self._closed:
                request = queue[0]
                remaining = request.expires - asyncio.get_running_loop().time()
                try:
                    if remaining <= 0:
                        self._failed(request.serial, request.action, "expired", False)
                    else:
                        request.started = True
                        value = await asyncio.wait_for(request.operation(), remaining)
                        if not isinstance(value, dict) or value.get("serial") != request.serial:
                            raise ValueError("Camera confirmation belongs to another device")
                        if self._closed:
                            self._failed(request.serial, request.action, "cancelled", True)
                        else:
                            self._confirmed(value)
                except asyncio.CancelledError:
                    self._failed(request.serial, request.action, "cancelled", request.started)
                    raise
                except CameraControlNotSentError:
                    self._failed(request.serial, request.action, "route_changed", False)
                except asyncio.TimeoutError:
                    self._failed(request.serial, request.action, "timeout", True)
                except Exception:
                    self._failed(request.serial, request.action, "failed", request.started)
                finally:
                    queue.popleft()
                    self._changed()
        finally:
            for request in queue:
                self._failed(request.serial, request.action, "cancelled", False)
            queue.clear()
            self._queues.pop(peer, None)
            self._workers.pop(peer, None)
            self._changed()

    async def close(self) -> None:
        """Retire workers without replaying uncertain writes or publishing late success."""
        self._closed = True
        workers = list(self._workers.values())
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)

        # A task cancelled before its first instruction cannot run its finally block.
        for queue in self._queues.values():
            for request in queue:
                self._failed(request.serial, request.action, "cancelled", request.started)
        self._queues.clear()
        self._workers.clear()
        self._changed()
