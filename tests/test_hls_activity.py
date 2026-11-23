"""Exercise output-local HLS quiet cleanup without HA or camera connections.

Synthetic public timers own their counters. The real observer must delegate
activity, cancel only its own deadline and ask HA to perform ordinary cleanup.
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/hls_activity.py"
SPEC = importlib.util.spec_from_file_location("hls_activity", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def output():
    """Model only HA's reviewed public output/timer contract."""
    timer = type("IdleTimer", (), {"__module__": "homeassistant.components.stream.core"})()
    timer.events = []
    timer.awake = lambda: timer.events.append("awake")
    timer.start = lambda: timer.events.append("start")
    timer.clear = lambda: timer.events.append("clear")
    timer.fire = lambda now: timer.events.append("fire")
    value = type("HlsStreamOutput", (), {"__module__": "homeassistant.components.stream.hls"})()
    value.idle_timer = timer
    value.target_duration = 2.0
    value.stream_settings = SimpleNamespace(hls_part_timeout=2.0)
    value.cleaned = 0
    value.cleanup = lambda: setattr(value, "cleaned", value.cleaned + 1)
    return value


class HlsActivityTest(unittest.IsolatedAsyncioTestCase):
    """Part requests postpone cleanup and unknown ownership keeps HA's timeout."""

    async def asyncSetUp(self):
        self.output = output()
        self.allowed = True
        self.observer = MODULE.HlsViewActivity.install(self.output, lambda: self.allowed)
        self.addCleanup(self.observer.close)

    async def test_creation_and_startup_do_not_invent_a_viewer_or_shorten_startup(self):
        self.output.idle_timer.start()
        await asyncio.sleep(0)
        self.assertIsNone(self.observer._timer)
        self.assertEqual(self.output.idle_timer.events, ["start"])
        self.assertEqual(self.observer._quiet_seconds, 4.0)
        self.output.idle_timer.awake()
        self.assertIsNotNone(self.observer._timer)
        self.assertEqual(self.output.idle_timer.events, ["start", "awake"])

    async def test_parts_keep_ha_alive_then_quiet_uses_its_cancelled_idle_callback(self):
        self.observer._quiet_seconds = 0.04
        for _ in range(3):
            self.output.idle_timer.awake()
            await asyncio.sleep(0.02)
        self.assertEqual(self.output.idle_timer.events, ["awake"] * 3)
        await asyncio.sleep(0.04)
        self.assertEqual(self.output.idle_timer.events, ["awake"] * 3 + ["clear", "fire"])
        self.assertTrue(self.observer.expiring)
        self.assertIsNone(self.observer._timer)

    async def test_no_early_idle_when_preload_recording_or_unknown_ownership_refuses_it(self):
        self.allowed = False
        self.observer._quiet_seconds = 0.01
        self.output.idle_timer.awake()
        await asyncio.sleep(0.02)
        self.assertEqual(self.output.idle_timer.events, ["awake"])
        self.assertFalse(self.observer.expiring)

    async def test_cleanup_restores_only_the_output_methods_and_cancels_the_quiet_timer(self):
        self.output.idle_timer.awake()
        self.output.cleanup()
        self.assertEqual(self.output.cleaned, 1)
        self.assertTrue(self.observer._closed)
        self.output.idle_timer.awake()
        self.assertEqual(self.output.idle_timer.events, ["awake", "awake"])
        self.assertIsNone(self.observer._timer)
        self.observer._quiet()
        self.assertNotIn("fire", self.output.idle_timer.events)

    async def test_unknown_ha_contracts_do_not_mutate_methods(self):
        for change in ("timer", "duration", "class", "part_timeout", "fire"):
            value = output()
            if change == "timer":
                value.idle_timer = SimpleNamespace(awake=lambda: None)
            elif change == "duration":
                value.target_duration = float("nan")
            elif change == "class":
                value.__class__.__module__ = "unsupported"
            elif change == "part_timeout":
                value.stream_settings.hls_part_timeout = None
            else:
                value.idle_timer.fire = None
            original = value.idle_timer.awake
            self.assertIsNone(MODULE.HlsViewActivity.install(value, lambda: True))
            self.assertIs(value.idle_timer.awake, original)

    async def test_expiry_failure_restores_the_original_ha_alarm(self):
        def fail(now):
            raise RuntimeError("unknown timer failure")
        self.output.idle_timer.fire = fail
        self.observer._quiet()
        self.assertEqual(self.output.idle_timer.events, ["clear", "awake"])
        self.assertFalse(self.observer.expiring)

    async def test_long_poll_and_ordinary_segments_get_a_sufficient_quiet_window(self):
        for duration, timeout, expected in [(6.0, 2.0, 12.0), (2.0, 20.0, 22.0)]:
            value = output()
            value.target_duration = duration
            value.stream_settings.hls_part_timeout = timeout
            observer = MODULE.HlsViewActivity.install(value, lambda: True)
            try:
                self.assertEqual(observer._quiet_seconds, expected)
            finally:
                observer.close()

    async def test_diagnostic_reports_only_this_outputs_activity_counts(self):
        self.output.idle_timer.awake()
        self.assertEqual(self.observer.diagnostic(), {
            "installed": True, "requests": 1, "quiet_seconds": 4.0, "expiring": False,
        })
        self.observer.close()
        self.assertFalse(self.observer.diagnostic()["installed"])

    async def test_cleanup_freezes_last_request_gap_without_retaining_wall_clock_time(self):
        """A later download must describe the cleanup gap, not time since cleanup."""
        self.output.idle_timer.awake()
        self.output.cleanup()
        first = self.observer.diagnostic()["cleanup"]
        await asyncio.sleep(0.02)
        self.assertEqual(self.observer.diagnostic()["cleanup"], first)
        self.assertEqual(first["request_gap_seconds"], 0)

    async def test_diagnostics_read_the_output_local_segment_settings(self):
        """Expose applied settings without changing the worker or shared defaults."""
        settings = self.output.stream_settings
        settings.min_segment_duration = 1.9
        settings.ll_hls = True
        result = self.observer.diagnostic()
        self.assertEqual(result["minimum_segment_seconds"], 1.9)
        self.assertEqual(result["target_segment_seconds"], 2.0)
        self.assertIs(result["ll_hls"], True)
        settings.min_segment_duration = float("nan")
        self.assertNotIn("minimum_segment_seconds", self.observer.diagnostic())
        self.assertEqual(self.output.cleaned, 0)
        self.assertEqual(self.output.idle_timer.events, [])

    async def test_one_output_cannot_change_another_outputs_alarm(self):
        other = output()
        original = other.idle_timer.awake
        self.output.idle_timer.awake()
        self.assertIs(other.idle_timer.awake, original)
        self.assertEqual(other.idle_timer.events, [])

    async def test_output_cleanup_retains_observed_timer_state_without_inventing_a_cause(self):
        """Separate an HA cleanup callback from our own quiet expiry."""
        self.output.idle_timer.idle = True
        self.output.idle_timer.awake()
        self.output.cleanup()
        result = self.observer.diagnostic()
        self.assertEqual(result["cleanup"], {"source": "ha_output", "idle": True, "request_gap_seconds": 0})
        self.assertEqual(result["requests"], 1)
        self.assertFalse(result["installed"])
        self.assertEqual(self.output.cleaned, 1)

    async def test_quiet_cleanup_and_observer_detachment_remain_distinct(self):
        """An explicit observer close is not evidence that HA removed an output."""
        self.observer.expiring = True
        self.output.cleanup()
        self.assertEqual(self.observer.diagnostic()["cleanup"], {"source": "quiet_timer", "idle": None, "request_gap_seconds": None})
        other = MODULE.HlsViewActivity.install(output(), lambda: True)
        other.close()
        self.assertNotIn("cleanup", other.diagnostic())

    async def test_segment_wait_observes_readiness_and_preserves_results_after_cleanup(self):
        """Retained timings separate waiting for segments from a later player delay."""
        value = output()
        value.sequences = []
        ready = asyncio.Event()

        async def recv():
            await ready.wait()
            return bool(value.sequences)

        value.recv = recv
        observer = MODULE.HlsViewActivity.install(value, lambda: False)
        self.addCleanup(observer.close)
        task = asyncio.create_task(value.recv())
        await asyncio.sleep(0.02)
        value.sequences = [0]
        ready.set()
        self.assertIs(await task, True)
        value.sequences = [0, 1]
        self.assertIs(await value.recv(), True)
        result = observer.diagnostic()["segment_wait"]
        self.assertEqual(result["calls"], 2)
        self.assertEqual(result["completed"], 2)
        self.assertGreaterEqual(result["max_seconds"], 0.01)
        self.assertGreaterEqual(result["two_ready_observed_seconds"], result["first_ready_observed_seconds"])
        value.cleanup()
        self.assertIs(value.recv, recv)
        self.assertEqual(observer.diagnostic()["segment_wait"], result)
        self.assertEqual(value.cleaned, 1)

    async def test_segment_wait_propagates_cancellation_and_failure_without_recording_errors(self):
        """HA retains cancellation and failure ownership, including exception privacy."""
        for failure in (asyncio.CancelledError(), RuntimeError("private source")):
            value = output()

            async def recv():
                raise failure

            value.recv = recv
            observer = MODULE.HlsViewActivity.install(value, lambda: False)
            try:
                with self.assertRaises(type(failure)) as caught:
                    await value.recv()
                self.assertIs(caught.exception, failure)
                result = observer.diagnostic()["segment_wait"]
                self.assertEqual(result["completed"], 0)
                self.assertEqual(result["cancelled"], int(isinstance(failure, asyncio.CancelledError)))
                self.assertEqual(result["failed"], int(isinstance(failure, RuntimeError)))
                self.assertIsNone(result["first_ready_observed_seconds"])
                self.assertNotIn("private source", str(observer.diagnostic()))
            finally:
                observer.close()

    async def test_empty_segment_wait_does_not_invent_readiness_or_touch_other_outputs(self):
        """A false result and another output cannot supply this output's readiness."""
        value = output()
        other = output()

        async def recv():
            return False

        value.recv = recv
        other.recv = recv
        observer = MODULE.HlsViewActivity.install(value, lambda: False)
        try:
            self.assertIs(await value.recv(), False)
            self.assertIs(other.recv, recv)
            result = observer.diagnostic()["segment_wait"]
            self.assertIsNone(result["first_ready_observed_seconds"])
            self.assertIsNone(result["two_ready_observed_seconds"])

            async def replacement():
                return True

            value.recv = replacement
            observer.close()
            self.assertIs(value.recv, replacement)
        finally:
            observer.close()


    async def test_wait_timeline_brackets_worker_errors_and_preserves_part_timeout(self):
        """A worker change belongs to this wait, without becoming its claimed cause."""
        value = output()
        counts = {"start_worker": 1, "worker_error": 0, "retry_timeout": 0, "source": "PRIVATE"}
        seen = []

        async def part_recv(timeout=None):
            seen.append(timeout)
            counts.update(start_worker=2, worker_error=1, retry_timeout=10)
            return False

        value.part_recv = part_recv
        observer = MODULE.HlsViewActivity.install(value, lambda: False, lambda: counts)
        try:
            self.assertIs(await value.part_recv(0.25), False)
            result = observer.diagnostic()["wait_timeline"]
            self.assertEqual(seen, [0.25])
            self.assertTrue(result["started_at"].endswith("+00:00"))
            row = result["observations"][0]
            self.assertEqual((row["kind"], row["outcome"]), ("part", "empty"))
            self.assertEqual((row["worker_errors_before"], row["worker_errors_after"]), (0, 1))
            self.assertEqual(row["retry_seconds_after"], 10)
            self.assertNotIn("PRIVATE", str(result))
            row["worker_errors_after"] = 999
            self.assertEqual(observer.diagnostic()["wait_timeline"]["observations"][0]["worker_errors_after"], 1)
        finally:
            observer.close()
        self.assertIs(value.part_recv, part_recv)

    async def test_wait_timeline_is_capped_and_keeps_original_failure_and_cancellation(self):
        """Only fixed observations survive, with the exact HA exceptions propagated."""
        value = output()
        failure = RuntimeError("PRIVATE")
        cancellation = asyncio.CancelledError("PRIVATE")
        calls = 0

        async def recv():
            nonlocal calls
            calls += 1
            if calls == 66:
                raise failure
            if calls == 67:
                raise cancellation
            return True

        value.recv = recv
        observer = MODULE.HlsViewActivity.install(value, lambda: False)
        try:
            for _ in range(65):
                self.assertIs(await value.recv(), True)
            for expected in (failure, cancellation):
                with self.assertRaises(type(expected)) as caught:
                    await value.recv()
                self.assertIs(caught.exception, expected)
            result = observer.diagnostic()["wait_timeline"]
            self.assertEqual(len(result["observations"]), 64)
            self.assertEqual(result["omitted"], 3)
            self.assertEqual([row["outcome"] for row in result["observations"][-2:]], ["failed", "cancelled"])
            self.assertNotIn("PRIVATE", str(result))
        finally:
            observer.close()

    async def test_retirement_freezes_wait_timeline_and_never_wraps_another_output(self):
        """An old completion cannot alter a retained or replacement output's record."""
        value, other = output(), output()
        waiting, finish = asyncio.Event(), asyncio.Event()

        async def recv():
            waiting.set()
            await finish.wait()
            return True

        value.recv = other.recv = recv

        def broken_reader():
            raise RuntimeError("PRIVATE")

        observer = MODULE.HlsViewActivity.install(value, lambda: False, broken_reader)
        task = asyncio.create_task(value.recv())
        await waiting.wait()
        observer.close()
        frozen = observer.diagnostic()["wait_timeline"]
        finish.set()
        self.assertIs(await task, True)
        self.assertIs(other.recv, recv)
        self.assertIs(value.recv, recv)
        self.assertEqual(observer.diagnostic()["wait_timeline"], frozen)
        self.assertNotIn("PRIVATE", str(observer.diagnostic()))


if __name__ == "__main__":
    unittest.main()
