"""Exercise HA's closed NVR UI mapping without importing Home Assistant.

Extracted entity classes own only fixture state. The gateway remains responsible
for admission, request settlement and physical confirmation.
"""
from __future__ import annotations

import ast
from pathlib import Path
import unittest
from typing import Any

ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


class NvrUiTest(unittest.TestCase):
    """Keep view choices and withdrawn capabilities consistent after discovery."""

    def load_class(self, filename: str, name: str) -> type:
        """Execute one UI class against minimal state-only HA boundary stubs."""
        tree = ast.parse((ROOT / filename).read_text())
        node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)

        class Base:
            """Provide the availability fact normally owned by the coordinator."""

            available = True

        namespace: dict[str, Any] = {"EufyGatewayEntity": Base, "SelectEntity": type("Select", (), {}), "ButtonEntity": type("Button", (), {})}
        exec(compile(ast.Module(body=[node], type_ignores=[]), filename, "exec"), namespace)
        return namespace[name]

    def test_view_choices_are_closed_and_not_physical_state(self) -> None:
        """Only the two source-defined pairs form a selectable next-start choice."""
        cls = self.load_class("select.py", "EufyNvrViewSelect")
        entity = object.__new__(cls)
        for raw, options in ((["Wide", "Telephoto"], ["wide", "telephoto"]), (["Fixed", "Movable"], ["fixed", "movable"]), (["arbitrary"], []), (None, [])):
            entity.camera = {"nvrViewOptions": raw, "nvrSelectedView": 1}
            self.assertEqual(entity.options, options)
            self.assertEqual(entity.available, bool(options))
            self.assertEqual(entity.current_option, options[1] if options else None)

    def test_existing_selects_withdraw_when_admission_changes(self) -> None:
        """A once-discovered entity becomes unavailable when its flag is removed."""
        for name, capability in (("EufyNightVisionSelect", "nightVisionControlSupported"), ("EufyStreamingQualitySelect", "streamingQualityControlSupported")):
            entity = object.__new__(self.load_class("select.py", name))
            entity.camera = {capability: True}
            self.assertTrue(entity.available)
            entity.camera[capability] = False
            self.assertFalse(entity.available)

    def test_fixed_movement_buttons_withdraw_on_view_change(self) -> None:
        """Movable-only zoom availability cannot survive a Fixed-view update."""
        entity = object.__new__(self.load_class("button.py", "EufyNvrControlButton"))
        entity._action = "zoom_2"
        entity.camera = {"nvrOpticalZoomControlSupported": True}
        self.assertTrue(entity.available)
        entity.camera["nvrOpticalZoomControlSupported"] = False
        self.assertFalse(entity.available)


class NvrClientTest(unittest.IsolatedAsyncioTestCase):
    """Validate NVR-only client timeout, payload and uncertainty semantics."""

    def load_client(self) -> tuple[type, type]:
        """Execute only the dependency-free HTTP methods against fixture sessions."""
        tree = ast.parse((ROOT / "client.py").read_text())
        classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in ("GatewayClientError", "GatewayAuthenticationError", "GatewayClient")]
        client = classes[-1]
        keep = {"_json", "_raise_for_status", "set_camera_night_vision", "set_camera_streaming_quality", "perform_nvr_live_control", "set_nvr_view"}
        client.body = [node for node in client.body if isinstance(node, ast.AsyncFunctionDef) and node.name in keep]

        class TransportError(Exception):
            """Represent an aiohttp transport failure without a network."""

        namespace: dict[str, Any] = {"Any": Any, "ClientError": TransportError, "ClientTimeout": lambda **values: values}
        exec(compile(ast.Module(body=classes, type_ignores=[]), "client.py", "exec"), namespace)
        return namespace["GatewayClient"], namespace["GatewayClientError"]

    async def test_nvr_payloads_and_legacy_timeouts_are_distinct(self) -> None:
        """Only explicit NVR actions select the extended uncertainty contract."""
        cls, error = self.load_client()
        instance = cls()
        calls = []

        async def request(path, **kwargs):
            calls.append((path, kwargs))
            return {"serial": "synthetic", "outcome": "request_accepted", "physicalConfirmationRequired": True}

        instance._json = request
        await instance.set_camera_night_vision("synthetic", 1)
        self.assertEqual(calls[-1][1]["timeout"], 60)
        await instance.set_camera_streaming_quality("synthetic", 4, nvr=True)
        self.assertEqual(calls[-1][1]["timeout"], 120)
        self.assertTrue(calls[-1][1]["nvr"])
        await instance.perform_nvr_live_control("synthetic", direction="left")
        self.assertEqual(calls[-1][1]["payload"], {"kind": "pan", "direction": "left"})
        await instance.perform_nvr_live_control("synthetic", level=2)
        self.assertEqual(calls[-1][1]["payload"], {"kind": "zoom", "level": 2})
        with self.assertRaises(error):
            await instance.perform_nvr_live_control("synthetic", direction="held")

    async def test_invalid_nvr_bodies_are_fixed_uncertainty(self) -> None:
        """A bad response never turns a possible device write into a safe retry."""
        cls, error = self.load_client()

        class Response:
            """Return a fixture body after an otherwise successful HTTP response."""

            status = 200

            async def json(self):
                """Return an invalid object shape."""
                return []

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

        class Session:
            """Own the synthetic request context only."""

            def request(self, *_args, **_kwargs):
                """Create one response without transport side effects."""
                return Response()

        instance = cls()
        instance._session, instance._headers = Session(), {}
        instance._url = lambda path: path
        instance._raise_for_status = lambda _response: None
        with self.assertRaises(error) as caught:
            await instance._json("/synthetic", method="POST", nvr=True)
        self.assertEqual(caught.exception.code, "outcome_unknown")
        with self.assertRaises(error) as caught:
            await instance._json("/synthetic", method="POST")
        self.assertIsNone(caught.exception.code)
        self.assertEqual(str(caught.exception), "Gateway returned an invalid response")

    async def test_transport_and_json_failures_keep_nvr_canaries_private(self) -> None:
        """NVR transport and decode failures lose vendor text, legacy errors do not."""
        cls, error = self.load_client()
        for failure in (TimeoutError("private-canary"), ValueError("private-canary")):
            class Session:
                """Fail before delivering a parseable fixture response."""

                def request(self, *_args, **_kwargs):
                    """Raise the selected synthetic failure."""
                    raise failure

            instance = cls()
            instance._session, instance._headers = Session(), {}
            instance._url = lambda path: path
            with self.assertRaises(error) as caught:
                await instance._json("/synthetic", method="POST", nvr=True)
            self.assertEqual(caught.exception.code, "outcome_unknown")
            self.assertNotIn("private-canary", str(caught.exception))
        instance._session = Session()
        with self.assertRaises(ValueError):
            await instance._json("/synthetic", method="POST")
