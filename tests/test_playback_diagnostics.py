"""Check playback evidence privacy and ownership without loading Home Assistant.

Synthetic streams own all state and fake clients detect accidental media calls.
The diagnostics boundary consumes these observations without opening playback.
"""

from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock


ROOT = Path(__file__).parents[1]
SOURCE = ROOT / "custom_components/eufy_event_gateway"
SPEC = importlib.util.spec_from_file_location("playback_diagnostics", SOURCE / "playback_diagnostics.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def load_method(filename: str, name: str, namespace: dict):
    """Compile the actual integration boundary with explicit synthetic dependencies."""
    node = next(node for node in ast.walk(ast.parse((SOURCE / filename).read_text()))
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE / filename), "exec"), namespace)
    return namespace[name]


def stream_fixture(outputs=None, **values):
    """Supply private canaries alongside ordinary public stream observations."""
    return SimpleNamespace(
        available=True,
        dynamic_stream_settings=SimpleNamespace(preload_stream=False),
        outputs=Mock(return_value=outputs if outputs is not None else {}),
        get_diagnostics=Mock(return_value={
            "start_worker": 3, "worker_error": 2, "retry_timeout": 20,
            "source": "private-source-canary", "access_token": "redacted-token-canary",
            "entity_id": "private-entity-canary", "error": "private-error-canary", **values,
        }),
        source="private-source-canary",
        start=Mock(), stop=Mock(), add_provider=Mock(), update_source=Mock(),
    )


class PlaybackSerializerTest(unittest.TestCase):
    """Exercise only existing stream observations and fail-closed serialization."""

    def test_no_stream_and_exact_private_allowlist(self):
        """A missing stream stays missing and raw diagnostics never reach JSON."""
        self.assertEqual(MODULE.serialize_stream(None), {"created": False})
        stream = stream_fixture({"unlisted-private-provider": object()})
        result = MODULE.serialize_stream(stream)
        self.assertEqual(result, {
            "created": True, "available": True, "preload": False,
            "hls_output": False, "recorder_output": False, "hls_idle": None,
            "start_worker": 3, "worker_error": 2, "retry_timeout": 20,
        })
        encoded = json.dumps(result, allow_nan=False)
        self.assertEqual(json.loads(encoded), result)
        self.assertNotIn("private", encoded)
        for name in ("start", "stop", "add_provider", "update_source"):
            getattr(stream, name).assert_not_called()

    def test_hls_recorder_and_preload_remain_independent(self):
        """Observing a recorder or preload must not create an HLS consumer."""
        for idle in (True, False):
            stream = stream_fixture({"hls": SimpleNamespace(idle=idle)})
            self.assertIs(MODULE.serialize_stream(stream)["hls_idle"], idle)
        stream = stream_fixture({"recorder": object()})
        stream.dynamic_stream_settings.preload_stream = True
        result = MODULE.serialize_stream(stream)
        self.assertTrue(result["recorder_output"])
        self.assertTrue(result["preload"])
        self.assertFalse(result["hls_output"])
        stream.add_provider.assert_not_called()

    def test_malformed_counts_and_nonfinite_delays_are_omitted(self):
        """Accept bounded integer counters and finite delays, rejecting bool coercion."""
        for value in (True, False, -1, 1.5, float("nan"), float("inf"), 2**31, "3", None):
            with self.subTest(counter=value):
                result = MODULE.serialize_stream(stream_fixture(start_worker=value, worker_error=value))
                self.assertNotIn("start_worker", result)
                self.assertNotIn("worker_error", result)
        for value in (True, -1, float("nan"), float("inf"), 86401, 10**1000, "20", None):
            with self.subTest(delay=type(value).__name__):
                self.assertNotIn("retry_timeout", MODULE.serialize_stream(stream_fixture(retry_timeout=value)))
        for value in (0, 86400, 0.5):
            self.assertEqual(MODULE.serialize_stream(stream_fixture(retry_timeout=value))["retry_timeout"], value)
        self.assertEqual(MODULE.serialize_stream(stream_fixture(start_worker=2**31 - 1))["start_worker"], 2**31 - 1)

    def test_bad_members_and_failed_reads_are_isolated(self):
        """Accessor failures cannot leak error text or suppress other observations."""
        stream = stream_fixture()
        stream.available = "true"
        stream.dynamic_stream_settings.preload_stream = 1
        stream.outputs.side_effect = RuntimeError("private-error-canary")
        result = MODULE.serialize_stream(stream)
        self.assertIsNone(result["available"])
        self.assertIsNone(result["preload"])
        self.assertIsNone(result["hls_output"])
        self.assertEqual(result["start_worker"], 3)
        stream.outputs.side_effect = None
        stream.outputs.return_value = []
        stream.get_diagnostics.side_effect = RuntimeError("private-error-canary")
        self.assertNotIn("start_worker", MODULE.serialize_stream(stream))
        stream.get_diagnostics.side_effect = None
        stream.get_diagnostics.return_value = []
        self.assertNotIn("worker_error", MODULE.serialize_stream(stream))
        stream.outputs.return_value = {"hls": SimpleNamespace(idle="private-error-canary")}
        self.assertIsNone(MODULE.serialize_stream(stream)["hls_idle"])

        class BrokenObservation:
            """Simulate a retired HA object with failing public properties."""

            @property
            def available(self):
                """Fail without disclosing the exception through the boundary."""
                raise RuntimeError("private-error-canary")

            @property
            def dynamic_stream_settings(self):
                """Make preload unavailable independently of the other reads."""
                raise RuntimeError("private-error-canary")

        result = MODULE.serialize_stream(BrokenObservation())
        self.assertIsNone(result["available"])
        self.assertNotIn("private", json.dumps(result))


class CameraPlaybackDiagnosticTest(unittest.TestCase):
    """Verify the camera adapter exposes metadata without touching playback."""

    def test_valid_and_invalid_metadata_never_issues_a_url(self):
        """Keep malformed inventory private and preserve the cached stream identity."""
        import re

        method = load_method("camera.py", "playback_diagnostic", {"serialize_stream": MODULE.serialize_stream, "re": re})
        client = SimpleNamespace(stream_url=AsyncMock(), capture_snapshot=AsyncMock())
        for model, number, expected_model, expected_number in [
            ("T8214", 94, "T8214", 94),
            ("private-name-canary", True, None, None),
            ("T8", -1, None, None),
            (None, 65536, None, None),
            ("T" + "A" * 16, "94", None, None),
        ]:
            camera = SimpleNamespace(camera={"model": model, "deviceType": number}, stream=None,
                                     _native_video=False, _short_hls_idle=True,
                                     _hls_idle_stream=object(), coordinator=SimpleNamespace(client=client))
            owned = camera._hls_idle_stream
            result = method(camera)
            self.assertEqual(result["model"], expected_model)
            self.assertEqual(result["device_type"], expected_number)
            self.assertFalse(result["created"])
            self.assertIs(camera._hls_idle_stream, owned)
            self.assertIsNone(camera.stream)
        client.stream_url.assert_not_called()
        client.capture_snapshot.assert_not_called()
        self.assertEqual(method(SimpleNamespace(camera=None)), {"unavailable": True})


class EntryPlaybackDiagnosticTest(unittest.IsolatedAsyncioTestCase):
    """Check entry ownership and gateway-outage behaviour without a HA runtime."""

    async def test_entry_filter_order_outage_and_repeated_downloads(self):
        """Downloads keep local evidence available and cannot create camera sessions."""

        class Camera:
            """Represent an already-created integration camera owned by this test."""

            def __init__(self, serial, coordinator, row):
                """Bind synthetic ownership and an immutable observed row."""
                self.serial, self.coordinator, self.row = serial, coordinator, row
                self.stream = None
                self.async_create_stream = AsyncMock()

            def playback_diagnostic(self):
                """Return the supplied observation or simulate one retired row."""
                if isinstance(self.row, Exception):
                    raise self.row
                return self.row

        client = SimpleNamespace(catalogue_evidence=AsyncMock(return_value={"available": True}),
                                 event_delivery_diagnostic=AsyncMock(return_value={}),
                                 diagnostic_summary=AsyncMock(return_value={}), stream_url=AsyncMock())
        coordinator = SimpleNamespace(client=client)
        entry = SimpleNamespace(runtime_data=SimpleNamespace(coordinator=coordinator))
        a, b = Camera("a", coordinator, {"model": "T8214"}), Camera("b", coordinator, {"model": "T8410"})
        failed = Camera("c", coordinator, RuntimeError("private-error-canary"))
        other = Camera("d", object(), {"private": "wrong-entry-canary"})
        legacy = SimpleNamespace(serial="e", coordinator=coordinator, row={"private": "legacy-canary"})
        component = SimpleNamespace(entities=[other, b, legacy, failed, a, object()])
        hass = SimpleNamespace(data={"camera-component": component})
        data = hass.data.copy()
        method = load_method("diagnostics.py", "async_get_config_entry_diagnostics", {
            "DATA_COMPONENT": "camera-component", "EufyGatewayCamera": Camera, "GatewayClientError": RuntimeError,
        })
        expected = [{"model": "T8214"}, {"model": "T8410"}, {"unavailable": True}]
        for _ in range(2):
            result = await method(hass, entry)
            self.assertEqual(result["playback"], expected)
            self.assertNotIn("canary", json.dumps(result))
        client.catalogue_evidence.side_effect = RuntimeError("private-error-canary")
        result = await method(hass, entry)
        self.assertEqual(result["playback"], expected)
        self.assertEqual(result["catalogue_evidence"]["reason"], "gateway_unavailable")
        self.assertEqual(hass.data, data)
        client.stream_url.assert_not_called()
        for camera in (a, b, failed, other):
            camera.async_create_stream.assert_not_called()
            self.assertIsNone(camera.stream)
        result = await method(SimpleNamespace(data={}), entry)
        self.assertEqual(result["playback"], [])


if __name__ == "__main__":
    unittest.main()
