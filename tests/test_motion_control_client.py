"""Exercise shipped motion HTTP methods with a test-owned request boundary.

The integration owns response validation and error mapping. These tests replace
aiohttp effects without importing Home Assistant or contacting a gateway.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from urllib.parse import quote

SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/client.py"


class MotionClientTest(unittest.IsolatedAsyncioTestCase):
    """Keep the motion deadline aligned while preserving adjacent HTTP contracts."""

    def setUp(self):
        """Load production methods and supply only their HTTP transport effects."""
        tree = ast.parse(SOURCE.read_text())
        client = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "GatewayClient")
        methods = {"__init__", "_url", "_raise_for_status", "_json", "set_camera_enabled",
                   "set_camera_motion_detection", "set_camera_night_vision", "set_camera_audio_recording",
                   "set_camera_streaming_quality", "set_camera_setting"}
        client.body = [n for n in client.body if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) or n.name in methods]
        errors = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name in {"GatewayClientError", "GatewayAuthenticationError"}]
        future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
        module = ast.fix_missing_locations(ast.Module(body=[future, *errors, client], type_ignores=[]))
        namespace = {"ClientError": ConnectionError, "ClientResponseError": ConnectionError,
                     "ClientTimeout": lambda total: SimpleNamespace(total=total), "quote": quote}
        exec(compile(module, str(SOURCE), "exec"), namespace)
        self.error = namespace["GatewayClientError"]
        self.requests = []
        self.status = 200
        self.timeout = False
        self.payload = {"serial": "synthetic", "reportedSettings": {"motionSensitivityStep": 3}}
        owner = self

        class Response:
            """Represent one test-owned response and optional transport timeout."""

            def __init__(self):
                self.status = owner.status

            async def __aenter__(self):
                if owner.timeout:
                    raise TimeoutError()
                return self

            async def __aexit__(self, *_args):
                return False

            async def json(self):
                """Return only the synthetic response chosen by the test."""
                return owner.payload

            def raise_for_status(self):
                """Leave typed HTTP errors to the shipped response mapping."""
                return None

        def request(_method, _url, **kwargs):
            self.requests.append(kwargs)
            return Response()

        self.client = namespace["GatewayClient"](SimpleNamespace(request=request), "http://synthetic")

    async def test_motion_uses_confirmation_margin_and_other_deadlines_stay_unchanged(self):
        """Only motion gets 120 seconds above the gateway's 90-second scope."""
        for method, args, kwargs, expected in (
            ("set_camera_motion_detection", (False,), {}, 120),
            ("set_camera_enabled", (False,), {}, 60),
            ("set_camera_night_vision", (1,), {}, 60),
            ("set_camera_night_vision", (1,), {"nvr": True}, 120),
            ("set_camera_audio_recording", (True,), {}, 60),
            ("set_camera_streaming_quality", (1,), {}, 60),
            ("set_camera_setting", ("motionSensitivity", 3), {}, 140),
        ):
            with self.subTest(method=method, kwargs=kwargs):
                await getattr(self.client, method)("synthetic", *args, **kwargs)
                self.assertEqual(self.requests[-1]["timeout"].total, expected)

    async def test_unknown_outcome_reaches_the_entity_with_fixed_detail(self):
        """Preserve the gateway's explicit ambiguity instead of a blank timeout."""
        self.status = 503
        self.payload = {"code": "outcome_unknown", "error": "Motion control outcome is unknown. Check the camera state before retrying."}
        with self.assertRaises(self.error) as caught:
            await self.client.set_camera_motion_detection("synthetic", False)
        self.assertEqual(caught.exception.code, "outcome_unknown")
        self.assertEqual(caught.exception.status, 503)
        self.assertIn("Check the camera state", str(caught.exception))

    async def test_transport_timeout_remains_an_integration_error(self):
        """Transport failure retains the existing exception type and request budget."""
        self.timeout = True
        with self.assertRaises(self.error):
            await self.client.set_camera_motion_detection("synthetic", False)
        self.assertEqual(self.requests[-1]["timeout"].total, 120)
