"""Exercise shipped metadata actions without HA or a vendor network.

The harness AST-loads camera helpers and methods and imports the real client
with explicit aiohttp type stubs. Synthetic responses own HTTP effects. Zone
fixtures use the host tzdata and fail with a named skip only when it is absent.
"""
from __future__ import annotations

import ast
import asyncio
import calendar
from datetime import date, datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from typing import Any
import unittest
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ROOT = Path(__file__).parents[1]
CAMERA = ROOT / "custom_components/eufy_event_gateway/camera.py"
CLIENT = ROOT / "custom_components/eufy_event_gateway/client.py"


class SyntheticClientError(Exception):
    """Stand in for aiohttp transport errors without an HTTP implementation."""


class SyntheticResponseError(SyntheticClientError):
    """Carry only a synthetic HTTP status through the real client's mapping."""

    def __init__(self, status):
        """Create a status-bearing stand-in for aiohttp's response failure."""
        self.status = status


def load_client():
    """Import production client methods with inert aiohttp boundary types."""
    spec = importlib.util.spec_from_file_location("cloud_metadata_client_fixture", CLIENT)
    module = importlib.util.module_from_spec(spec)
    stub = SimpleNamespace(ClientError=SyntheticClientError, ClientResponseError=SyntheticResponseError,
                           ClientSession=object, ClientTimeout=lambda total: SimpleNamespace(total=total))
    with patch.dict(sys.modules, {"aiohttp": stub}):
        spec.loader.exec_module(module)
    return module


class CloudMetadataTest(unittest.IsolatedAsyncioTestCase):
    """Validate privacy, local dates and concurrent explicit requests offline."""

    def setUp(self):
        """Bind the actual production methods to synthetic dependencies."""
        self.client_module = load_client()
        self.client = self.client_module.GatewayClient(SimpleNamespace(), "http://synthetic", "fixture-header")
        self.tree = ast.parse(CAMERA.read_text())
        camera = next(n for n in self.tree.body if isinstance(n, ast.ClassDef) and n.name == "EufyGatewayCamera")
        nodes = [n for n in self.tree.body if isinstance(n, ast.FunctionDef) and n.name.startswith("_cloud_")]
        nodes += [n for n in camera.body if isinstance(n, ast.AsyncFunctionDef) and n.name in ("async_list_cloud_recordings", "async_get_cloud_recording_dates")]
        self.zone = timezone.utc
        self.namespace = {"date": date, "datetime": datetime, "timedelta": timedelta, "re": re, "Any": Any,
                          "HomeAssistantError": RuntimeError, "GatewayClientError": self.client_module.GatewayClientError,
                          "dt_util": SimpleNamespace(get_default_time_zone=lambda: self.zone)}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(CAMERA), "exec"), self.namespace)
        self.day = self.namespace["_cloud_day_window"]
        self.month = self.namespace["_cloud_month_offset"]

    def zoneinfo(self, name):
        """Name the missing tzdata rather than silently omitting DST coverage."""
        try:
            return ZoneInfo(name)
        except ZoneInfoNotFoundError:
            self.skipTest(f"tzdata missing for {name}")

    def entity(self):
        """Create only the state used by the two real entity methods."""
        return SimpleNamespace(_cloud_metadata_busy=False, serial="fixture", coordinator=SimpleNamespace(client=self.client),
                               hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")))

    def test_real_dates_offsets_and_dst(self):
        """Use independent UTC bounds for gaps, folds and non-hour changes."""
        expected = [
            ("Australia/Brisbane", "2026-10-04", 24, 36000),
            ("Australia/Sydney", "2026-10-04", 23, 36000),
            ("Australia/Sydney", "2026-04-05", 25, 39600),
            ("Australia/Lord_Howe", "2026-10-04", 23.5, 37800),
            ("Australia/Lord_Howe", "2026-04-05", 24.5, 39600),
            ("Antarctica/Troll", "2026-10-25", 26, 7200),
            ("America/Sao_Paulo", "2018-11-04", 23, -7200),
            ("America/Havana", "2022-11-06", 25, -14400),
        ]
        for zone, day, hours, offset in expected:
            with self.subTest(zone=zone, day=day):
                start, end, actual = self.day(day, self.zoneinfo(zone))
                self.assertEqual(end - start, hours * 3600)
                self.assertEqual(actual, offset)
        self.assertEqual(self.day("2000-02-29", timezone.utc), (951782400, 951868800, 0))
        self.assertEqual(self.day("2018-11-04", self.zoneinfo("America/Sao_Paulo"))[0], 1541300400)
        self.assertEqual(self.day("2022-11-06", self.zoneinfo("America/Havana"))[0], 1667707200)
        self.assertEqual(self.month("2026-10", self.zoneinfo("Australia/Sydney")), 36000)
        with self.assertRaises(RuntimeError):
            self.day("2011-12-30", self.zoneinfo("Pacific/Apia"))

    def test_invalid_date_inputs(self):
        """Reject invalid strings before the gateway can observe a request."""
        for day in ["٢٠٢٦-10-18", "2026-10-18\n", "2001-02-29", "2100-02-29", "1999-01-01", "2101-01-01", "2026-13-01", date(2026, 1, 1), None]:
            with self.subTest(day=day), self.assertRaises(RuntimeError):
                self.day(day, timezone.utc)
        for month in ["2026-00", "2026-13", "1999-01", "2026-01\n", None]:
            with self.assertRaises(RuntimeError):
                self.month(month, timezone.utc)
        self.assertEqual(self.day(str(date(2026, 1, 1)), timezone.utc)[2], 0)

    async def test_client_paths_headers_and_projection(self):
        """Run the real JSON method and remove all private recording fields."""
        payload = {"records": [self.row("z", 90, 100), self.row("a", 150, 160), self.row("outside", 200, 210)], "mediaPlaybackAvailable": False}
        calls = []

        class Response:
            """Supply a synthetic context-managed HTTP response."""
            status = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def json(self):
                return payload

            def raise_for_status(self):
                return None

        def request(method, url, **kwargs):
            calls.append((method, url, kwargs))
            return Response()

        self.client._session = SimpleNamespace(request=request)
        result = await self.client.cloud_recordings("camera /?", 100, 200, 36000)
        self.assertEqual(calls[0][0:2], ("GET", "http://synthetic/api/cameras/camera%20%2F%3F/cloud-history?start=100&end=200&timezone_offset=36000&count=1000"))
        self.assertEqual(calls[0][2]["headers"], {"Authorization": "Bearer fixture-header"})
        self.assertEqual(calls[0][2]["timeout"].total, 45)
        self.assertEqual(result, {"records": [{"start_time": 90, "end_time": 100, "has_cloud_media": True}, {"start_time": 150, "end_time": 160, "has_cloud_media": True}], "truncated": False})
        self.assertNotRegex(json.dumps(result), r"private|owner|identity|url")
        payload = {"month": "2000-02", "days": [1, 29]}
        self.assertEqual(await self.client.cloud_recording_dates("camera /?", "2000-02", -18000), payload)
        self.assertTrue(calls[-1][1].endswith("/camera%20%2F%3F/cloud-calendar?month=2000-02&offset=-18000"))

    @staticmethod
    def row(identity="one", start=100, end=110):
        """Include private sentinels to detect accidental broad projection."""
        return {"id": identity, "startTime": start, "endTime": end, "hasCloudMedia": True,
                "ownerId": "private-owner", "url": "private-url", "title": "private-title"}

    async def test_client_refuses_bad_inputs_before_http(self):
        """Keep malformed requests outside the authenticated transport."""
        self.client._json = AsyncMock()
        for args in [("", 100, 200, 0), ("x", True, 200, 0), ("x", 100, 200, True), ("x", 100, 100, 0), ("x", 0, 93601, 0), ("x", 1, 2, 1), ("x", 1, 2, 50460)]:
            with self.assertRaises(self.client_module.GatewayClientError):
                await self.client.cloud_recordings(*args)
        for month in ["2100-13", "1999-12", "2026-10\n", 202610]:
            with self.assertRaises(self.client_module.GatewayClientError):
                await self.client.cloud_recording_dates("x", month, 0)
        self.client._json.assert_not_awaited()

    async def test_history_rejects_malformed_rows_and_envelopes(self):
        """Never turn malformed or duplicated activity data into empty success."""
        good = self.row()
        bad = [None, {**good, "id": ""}, {**good, "id": "x" * 129}, {**good, "startTime": True}, {**good, "endTime": 99}, {**good, "hasCloudMedia": 1}, {**good, "endTime": 2**53}]
        for row in bad:
            self.client._json = AsyncMock(return_value={"records": [row], "mediaPlaybackAvailable": False})
            with self.assertRaisesRegex(self.client_module.GatewayClientError, "invalid cloud metadata"):
                await self.client.cloud_recordings("x", 100, 200, 0)
        for payload in [None, [], {"records": [good, good], "mediaPlaybackAvailable": False}, {"records": [], "mediaPlaybackAvailable": True}, {"records": [], "mediaPlaybackAvailable": False, "extra": "private"}, {"records": [good] * 1001, "mediaPlaybackAvailable": False}]:
            self.client._json = AsyncMock(return_value=payload)
            with self.assertRaises(self.client_module.GatewayClientError):
                await self.client.cloud_recordings("x", 100, 200, 0)
        self.client._json = AsyncMock(return_value={"records": [self.row(str(i)) for i in range(1000)], "mediaPlaybackAvailable": False})
        self.assertTrue((await self.client.cloud_recordings("x", 100, 200, 0))["truncated"])

    async def test_calendar_rejects_wrong_days_months_and_extra_fields(self):
        """Calendar hints must match the exact month and an ascending valid set."""
        for payload in [{"month": "2100-02", "days": [29]}, {"month": "2000-02", "days": [1]}, {"month": "2100-02", "days": [2, 1]}, {"month": "2100-02", "days": [1, 1]}, {"month": "2100-02", "days": [True]}, {"month": "2100-02", "days": [], "extra": 0}]:
            self.client._json = AsyncMock(return_value=payload)
            with self.assertRaises(self.client_module.GatewayClientError):
                await self.client.cloud_recording_dates("x", "2100-02", 0)
        self.client._json = AsyncMock(return_value={"month": "2100-02", "days": []})
        self.assertEqual(await self.client.cloud_recording_dates("x", "2100-02", 0), {"month": "2100-02", "days": []})

    async def test_transport_errors_are_private_and_authentication_survives(self):
        """Map fixed errors without retaining raw details or swallowing cancellation."""
        for status in [401, 404, 409, 501, 502, 500]:
            error = self.client_module.GatewayClientError("private-host private-serial private-detail", status=status)
            for method, args in [(self.client.cloud_recordings, ("x", 100, 200, 0)), (self.client.cloud_recording_dates, ("x", "2026-10", 0))]:
                self.client._json = AsyncMock(side_effect=error)
                with self.assertRaises(self.client_module.GatewayClientError) as caught:
                    await method(*args)
                self.assertNotIn("private", str(caught.exception))
                self.assertIsNone(caught.exception.__cause__)
                self.assertTrue(caught.exception.__suppress_context__)
                if status == 401:
                    self.assertIsInstance(caught.exception, self.client_module.GatewayAuthenticationError)
                if status == 502:
                    self.assertIn("try again later", str(caught.exception))
        for error in [ValueError("private-json"), UnicodeDecodeError("utf8", b"\xff", 0, 1, "private"), SyntheticClientError("private-host"), TimeoutError("private-host")]:
            self.client._json = AsyncMock(side_effect=error)
            with self.assertRaisesRegex(self.client_module.GatewayClientError, "^Cloud metadata request failed$"):
                await self.client.cloud_recording_dates("x", "2026-10", 0)
        self.client._json = AsyncMock(side_effect=asyncio.CancelledError())
        with self.assertRaises(asyncio.CancelledError):
            await self.client.cloud_recording_dates("x", "2026-10", 0)

    async def test_entity_guard_responses_and_cancellation(self):
        """Reserve before awaiting and release after success, error or cancellation."""
        entity = self.entity()
        gate = asyncio.Event()

        async def delayed(*_args):
            await gate.wait()
            return {"records": [], "truncated": False}

        self.client.cloud_recordings = AsyncMock(side_effect=delayed)
        task = asyncio.create_task(self.namespace["async_list_cloud_recordings"](entity, "2026-10-18"))
        await asyncio.sleep(0)
        self.assertTrue(entity._cloud_metadata_busy)
        with self.assertRaisesRegex(RuntimeError, "already in progress"):
            await self.namespace["async_get_cloud_recording_dates"](entity, "2026-10")
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(entity._cloud_metadata_busy)
        gate.set()
        result = await self.namespace["async_list_cloud_recordings"](entity, "2026-10-18")
        self.assertEqual(result["utc_offset_seconds"], 0)
        self.assertTrue(result["metadata_only"])
        json.dumps(result)
        self.client.cloud_recording_dates = AsyncMock(side_effect=self.client_module.GatewayClientError("fixed failure"))
        with self.assertRaisesRegex(RuntimeError, "fixed failure"):
            await self.namespace["async_get_cloud_recording_dates"](entity, "2026-10")
        self.assertFalse(entity._cloud_metadata_busy)
        self.client.cloud_recording_dates = AsyncMock(return_value={"month": "2026-10", "days": [1]})
        result = await self.namespace["async_get_cloud_recording_dates"](entity, "2026-10")
        self.assertTrue(result["hint_only"])
        json.dumps(result)

    def test_registration_schema_and_no_media_effects(self):
        """Pin response-only action names and exclude media and refresh calls."""
        setup = next(n for n in self.tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "async_setup_entry")
        services = [n for n in ast.walk(setup) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "async_register_entity_service"]
        self.assertEqual([n.args[0].value for n in services], ["capture_snapshot", "play_audio", "record_clip", "get_stream_url", "list_cloud_recordings", "get_cloud_recording_dates"])
        yaml = (ROOT / "custom_components/eufy_event_gateway/services.yaml").read_text()
        for service, field in [(services[-2], "day"), (services[-1], "month")]:
            self.assertEqual(service.keywords[0].arg, "supports_response")
            self.assertEqual(ast.unparse(service.keywords[0].value), "SupportsResponse.ONLY")
            self.assertEqual(ast.unparse(service.args[1]), "{vol.Required('" + field + "'): cv.string}")
            self.assertIn(service.args[0].value + ":", yaml)
            self.assertIn("    " + field + ":", yaml)
        forbidden = {"capture_snapshot", "record_clip", "stream_url", "async_request_stream", "async_add_executor_job", "open", "async_call", "async_request_refresh"}
        for node in self.tree.body:
            if isinstance(node, ast.ClassDef):
                methods = [n for n in node.body if isinstance(n, ast.AsyncFunctionDef) and n.name in ("async_list_cloud_recordings", "async_get_cloud_recording_dates")]
                if node.name != "EufyGatewayCamera":
                    self.assertEqual(methods, [])
                for method in methods:
                    names = {n.attr for n in ast.walk(method) if isinstance(n, ast.Attribute)} | {n.id for n in ast.walk(method) if isinstance(n, ast.Name)}
                    self.assertFalse(names & forbidden)
