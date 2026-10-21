"""Validate the shipped native-source client using a test-owned HTTP boundary.

The gateway owns profile tokens. These tests execute the integration's actual
client and camera helper without importing Home Assistant or exposing secrets.
"""
from __future__ import annotations

import ast
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
from urllib.parse import quote, urlsplit, unquote, parse_qsl

ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


class NativeStreamTest(unittest.IsolatedAsyncioTestCase):
    """Exercise profile selection, fail-closed URL validation and fixed errors."""

    def setUp(self):
        """Load real client methods while supplying a synthetic request function."""
        tree = ast.parse((ROOT / "client.py").read_text())
        client = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "GatewayClient")
        client.body = [n for n in client.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                       and n.name in {"__init__", "stream_url", "_url"}]
        error = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "GatewayClientError")
        future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
        namespace = dict(re=re, quote=quote, urlsplit=urlsplit, unquote=unquote, parse_qsl=parse_qsl)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[future, error, client], type_ignores=[])), "client.py", "exec"), namespace)
        self.error = namespace["GatewayClientError"]
        self.client = namespace["GatewayClient"](None, "http://fixture", "fixture-only")
        self.native = "native.1600." + "a" * 43
        self.client._json = AsyncMock()

    async def test_compatible_request_stays_unchanged(self):
        """Default callers retain the existing empty POST and signed path."""
        self.client._json.return_value = {"path": "/api/cameras/fixture/live.h264?access_token=fixture"}
        self.assertEqual(await self.client.stream_url("fixture"), "http://fixture/api/cameras/fixture/live.h264?access_token=fixture")
        self.client._json.assert_awaited_once_with("/api/cameras/fixture/stream-token", method="POST")

    async def test_native_camera_keys_are_checked_by_decoded_segment(self):
        """Encoded slashes and punctuation identify exactly the requested camera."""
        for key in ("fixture", "a/b", "%", "!'()*", '\",['):
            with self.subTest(key=key):
                path = f"/api/cameras/{quote(key, safe='')}/live-native.annexb?access_token={self.native}"
                self.client._json.return_value = {"profile": "native", "path": path}
                self.assertEqual(await self.client.stream_url(key, native=True), "http://fixture" + path)
                self.client._json.assert_awaited_with(f"/api/cameras/{quote(key, safe='')}/stream-token", method="POST", payload={"profile": "native"})

    async def test_untrusted_paths_and_old_gateway_responses_fail_closed(self):
        """Reject profile confusion, external paths, malformed queries and bad JSON."""
        root = "/api/cameras/fixture/live-native.annexb"
        for path in (root, root + "?access_token=bad", root + f"?access_token={self.native}&access_token={self.native}",
                     root + f"?access_token={self.native}&extra=x", root + f"?access_token={self.native}#fragment",
                     "http://external" + root, "//external" + root, root.replace("fixture", "other"),
                     root.replace("fixture", ".."), root.replace("fixture", "%xx"), root.replace("live-native.annexb", "live.h264")):
            self.client._json.return_value = {"profile": "native", "path": path}
            with self.subTest(path=path), self.assertRaises(self.error) as raised:
                await self.client.stream_url("fixture", native=True)
            self.assertEqual(str(raised.exception), "Gateway returned an invalid native stream response")
        for payload in ([], None, {"path": root}, {"profile": "compatible", "path": root}):
            self.client._json.return_value = payload
            with self.assertRaises(self.error):
                await self.client.stream_url("fixture", native=True)
        self.client._json.side_effect = ValueError("sensitive response must not escape")
        with self.assertRaisesRegex(self.error, "invalid native stream response"):
            await self.client.stream_url("fixture", native=True)

    async def test_unsigned_source_requires_no_gateway_token(self):
        """Only a gateway configured without authentication may omit a signature."""
        self.client._headers = {}
        self.client._json.return_value = {"profile": "native", "path": "/api/cameras/fixture/live-native.annexb"}
        self.assertEqual(await self.client.stream_url("fixture", native=True), "http://fixture/api/cameras/fixture/live-native.annexb")

    async def test_one_camera_helper_selects_native_and_compatible_requests(self):
        """Initial open and both renewals use the same entity-owned selection."""
        tree = ast.parse((ROOT / "camera.py").read_text())
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "_async_stream_url")
        namespace = {}
        exec(compile(ast.Module(body=[method], type_ignores=[]), "camera.py", "exec"), namespace)
        request = AsyncMock(return_value="source")
        camera = SimpleNamespace(serial="fixture", _native_video=True, coordinator=SimpleNamespace(client=SimpleNamespace(stream_url=request)))
        self.assertEqual(await namespace["_async_stream_url"](camera), "source")
        request.assert_awaited_with("fixture", native=True)
        camera._native_video = False
        await namespace["_async_stream_url"](camera)
        request.assert_awaited_with("fixture")
