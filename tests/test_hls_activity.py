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

    async def test_one_output_cannot_change_another_outputs_alarm(self):
        other = output()
        original = other.idle_timer.awake
        self.output.idle_timer.awake()
        self.assertIs(other.idle_timer.awake, original)
        self.assertEqual(other.idle_timer.events, [])


if __name__ == "__main__":
    unittest.main()
