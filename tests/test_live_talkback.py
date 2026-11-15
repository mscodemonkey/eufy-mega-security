"""Test production HA talkback signalling with fixture-owned gateway effects.

The tests execute shipped entity code without an HA installation. They own peer
IDs, synthetic SDP and candidates, and never open media or an account session.
"""
from __future__ import annotations

import ast
import asyncio
from dataclasses import dataclass, field, is_dataclass
import logging
import re
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
from urllib.parse import quote

SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/camera.py"


@dataclass
class Answer:
    """Represent the current HA answer callback shape."""

    answer: str


@dataclass
class Error:
    """Represent a fixed public error, separate from gateway content."""

    code: str
    message: str


@dataclass
class NativeCandidate:
    """Match webrtc-models 0.3.0's Python-side candidate field names."""

    candidate: str
    sdp_mid: str | None = None
    sdp_m_line_index: int | None = None
    user_fragment: str | None = None


@dataclass
class Capabilities:
    """Stand in for the newer Core's optional capability declaration."""

    two_way_audio: bool = False


class BaseCamera:
    """Bind test-owned coordinator state without loading an HA camera platform."""

    def __init__(self, coordinator, serial, **options):
        """Retain only the dependencies consumed by the shipped subclass."""
        self.coordinator, self.serial, self.hass = coordinator, serial, coordinator.hass

    @property
    def camera(self):
        """Follow fresh fixture state instead of copying an optimistic setting."""
        return self.coordinator.cameras[self.serial]

    def _handle_coordinator_update(self):
        """Leave base state publication to HA's separate integration tests."""

    async def async_will_remove_from_hass(self):
        """Represent a completed base entity removal."""


def load_scope():
    """Execute the exact subclass, pending record and mode selector with test effects."""
    tree = ast.parse(SOURCE.read_text())
    names = {"_live_talkback_camera", "_LiveTalkbackSession", "EufyGatewayLiveTalkbackCamera"}
    nodes = [n for n in tree.body if getattr(n, "name", None) in names]
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    scope = {"__name__": __name__, "asyncio": asyncio, "dataclass": dataclass,
             "field": field, "is_dataclass": is_dataclass, "callback": lambda fn: fn,
             "EufyGatewayCamera": BaseCamera, "WebRTCAnswer": Answer, "WebRTCError": Error,
             "CameraEntityCapabilities": Capabilities, "GatewayClientError": ConnectionError,
             "_LOGGER": logging.getLogger(__name__)}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[])), str(SOURCE), "exec"), scope)
    return scope


class LiveTalkbackTests(unittest.IsolatedAsyncioTestCase):
    """Keep pending offers, cancellation and peer ownership distinct."""

    def setUp(self):
        """Create one synthetic C31 and isolated async gateway methods."""
        self.scope = load_scope()
        self.tasks = []
        self.client = SimpleNamespace(live_talkback_offer=AsyncMock(return_value={"sessionId": "a" * 32, "sdp": "v=0\r\n"}),
                                      live_talkback_candidate=AsyncMock(), close_live_talkback=AsyncMock())
        self.camera = {"model": "T817L", "deviceType": 10031, "liveTalkbackEnabled": True, "liveTalkbackSupported": True}
        def schedule(coroutine):
            task = asyncio.create_task(coroutine)
            self.tasks.append(task)
            return task
        self.coordinator = SimpleNamespace(client=self.client, cameras={"camera": self.camera},
                                           hass=SimpleNamespace(async_create_task=schedule))
        self.entity = self.scope["EufyGatewayLiveTalkbackCamera"](self.coordinator, "camera")

    async def asyncTearDown(self):
        """Drain every test-owned cleanup task before leaving its event loop."""
        if self.tasks:
            await asyncio.gather(*self.tasks)

    def test_only_the_opted_in_exact_camera_gets_the_native_class(self):
        """An enabled trial stays distinct from temporary speaker readiness."""
        admitted = self.scope["_live_talkback_camera"]
        self.assertTrue(admitted(self.camera))
        for changes in ({"model": "T817LX"}, {"deviceType": 10}, {"liveTalkbackEnabled": False}, {"liveTalkbackEnabled": None}):
            self.assertFalse(admitted({**self.camera, **changes}))
        self.camera["liveTalkbackSupported"] = False
        self.assertTrue(admitted(self.camera))
        self.entity._handle_coordinator_update()
        self.assertFalse(self.entity._attr_camera_entity_capabilities.two_way_audio)

    async def test_early_candidates_and_end_marker_bind_to_the_returned_peer(self):
        """Candidates arriving before the HTTP answer cannot reach a different owner."""
        reply = asyncio.get_running_loop().create_future()
        entered = asyncio.Event()
        async def offer(*args):
            entered.set()
            return await reply
        self.client.live_talkback_offer.side_effect = offer
        messages = []
        task = asyncio.create_task(self.entity.async_handle_async_webrtc_offer("offer", "view", messages.append))
        await entered.wait()
        candidate = {"candidate": "candidate:synthetic", "sdpMid": "0", "sdpMLineIndex": 0}
        await self.entity.async_on_webrtc_candidate("view", candidate)
        await self.entity.async_on_webrtc_candidate("view", None)
        self.client.live_talkback_candidate.assert_not_awaited()
        reply.set_result({"sessionId": "a" * 32, "sdp": "v=0\r\n"})
        await task
        self.assertEqual(messages, [Answer("v=0\r\n")])
        self.assertEqual(self.client.live_talkback_candidate.await_args_list[0].args, ("camera", "a" * 32, candidate))
        self.assertEqual(self.client.live_talkback_candidate.await_args_list[1].args, ("camera", "a" * 32, None))
        self.entity.close_webrtc_session("view")
        await asyncio.gather(*self.tasks)
        self.client.close_live_talkback.assert_awaited_once_with("camera", "a" * 32)

    async def test_native_ha_candidate_keeps_browser_wire_names(self):
        """HA's Python names and userFragment alias are not the gateway wire format."""
        await self.entity.async_handle_async_webrtc_offer("offer", "view", lambda value: None)
        candidate = NativeCandidate("candidate:synthetic", "1", 1, "synthetic")
        await self.entity.async_on_webrtc_candidate("view", candidate)
        self.client.live_talkback_candidate.assert_awaited_once_with(
            "camera", "a" * 32,
            {"candidate": "candidate:synthetic", "sdpMid": "1", "sdpMLineIndex": 1, "usernameFragment": "synthetic"},
        )

    async def test_closed_pending_view_retires_its_late_answer_without_publishing(self):
        """An in-flight offer is owned until its returned ID can be closed."""
        reply = asyncio.get_running_loop().create_future()
        entered = asyncio.Event()
        async def offer(*args):
            entered.set()
            return await reply
        self.client.live_talkback_offer.side_effect = offer
        messages = []
        task = asyncio.create_task(self.entity.async_handle_async_webrtc_offer("offer", "view", messages.append))
        await entered.wait()
        self.entity.close_webrtc_session("view")
        reply.set_result({"sessionId": "a" * 32, "sdp": "v=0\r\n"})
        await task
        self.assertEqual(messages, [])
        self.assertEqual(self.entity._talkback_sessions, {})
        self.client.close_live_talkback.assert_awaited_once_with("camera", "a" * 32)

    async def test_cancelled_pending_offer_propagates_cancellation(self):
        """A cancelled HA task emits no failure callback or guessed close ID."""
        entered = asyncio.Event()
        async def offer(*args):
            entered.set()
            await asyncio.Future()
        self.client.live_talkback_offer.side_effect = offer
        messages = []
        task = asyncio.create_task(self.entity.async_handle_async_webrtc_offer("offer", "view", messages.append))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(messages, [])
        self.assertEqual(self.entity._talkback_sessions, {})
        self.client.close_live_talkback.assert_not_awaited()

    async def test_failed_candidate_retires_only_its_exact_active_peer(self):
        """A transport failure never falls back to another camera or uploads audio."""
        messages = []
        await self.entity.async_handle_async_webrtc_offer("offer", "view", messages.append)
        self.client.live_talkback_candidate.side_effect = ConnectionError("private candidate details")
        await self.entity.async_on_webrtc_candidate("view", {"candidate": "candidate:synthetic"})
        await asyncio.gather(*self.tasks)
        self.client.close_live_talkback.assert_awaited_once_with("camera", "a" * 32)
        self.assertEqual(messages, [Answer("v=0\r\n")])

    async def test_gateway_failures_do_not_expose_negotiation_content(self):
        """The frontend receives a fixed useful error rather than an SDP exception."""
        self.client.live_talkback_offer.side_effect = ConnectionError("private negotiation details")
        messages = []
        await self.entity.async_handle_async_webrtc_offer("offer", "view", messages.append)
        self.assertEqual(len(messages), 1)
        self.assertIsInstance(messages[0], Error)
        self.assertNotIn("private", messages[0].message)

    async def test_only_a_mode_change_requests_one_standard_entry_reload(self):
        """Temporary readiness cannot switch classes or cause repeated reloads."""
        tree = ast.parse(SOURCE.read_text())
        setup = next(n for n in tree.body if getattr(n, "name", None) == "async_setup_entry")
        listeners, added = [], []
        class Schema:
            """Ignore unrelated service registration schemas for this lifecycle test."""

            def __getattr__(self, name):
                return lambda *args, **kwargs: name
        reload_entry = AsyncMock()
        hass = SimpleNamespace(async_create_task=self.coordinator.hass.async_create_task,
                               config_entries=SimpleNamespace(async_reload=reload_entry))
        coordinator = SimpleNamespace(cameras={"camera": self.camera}, hass=hass,
                                      async_add_listener=lambda fn: listeners.append(fn))
        entry = SimpleNamespace(entry_id="fixture", runtime_data=SimpleNamespace(coordinator=coordinator),
                                options={}, async_on_unload=lambda fn: None)
        env = self.scope
        env.update(er=SimpleNamespace(async_get=lambda value: SimpleNamespace(async_get_entity_id=lambda *args: None)),
                   DOMAIN="fixture", CONF_SHORT_HLS_IDLE="short", CONF_FAST_NATIVE_HLS="fast", CONF_H264_COMPATIBILITY="compat",
                   async_get_current_platform=lambda: SimpleNamespace(async_register_entity_service=lambda *args, **kwargs: None),
                   vol=Schema(), cv=Schema(), CONF_FILENAME="filename", CONF_DURATION="duration",
                   SupportsResponse=SimpleNamespace(ONLY="only"), _shared_lens_profile=lambda value: False)
        future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[future, setup], type_ignores=[])), str(SOURCE), "exec"), env)
        await env["async_setup_entry"](hass, entry, added.extend)
        self.assertEqual(len(added), 1)
        self.camera["liveTalkbackSupported"] = False
        listeners[0]()
        reload_entry.assert_not_called()
        self.camera["liveTalkbackEnabled"] = False
        listeners[0]()
        listeners[0]()
        await asyncio.gather(*self.tasks)
        reload_entry.assert_awaited_once_with("fixture")


class LiveTalkbackClientTests(unittest.IsolatedAsyncioTestCase):
    """Check response ownership before an answer reaches HA's viewer."""

    def setUp(self):
        """Load shipped client methods with a fixture-owned HTTP boundary."""
        source = SOURCE.with_name("client.py")
        tree = ast.parse(source.read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "GatewayClient")
        names = {"live_talkback_offer", "live_talkback_candidate", "close_live_talkback"}
        nodes = [n for n in cls.body if getattr(n, "name", None) in names]
        future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
        scope = {"GatewayClientError": ConnectionError, "re": re, "quote": quote}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[])), str(source), "exec"), scope)
        self.scope = scope
        self.http = AsyncMock(return_value={"sessionId": "a" * 32, "sdp": "v=0\r\n"})
        self.client = SimpleNamespace(_json=self.http, close_live_talkback=AsyncMock())

    async def test_offer_validation_retires_only_a_valid_returned_owner(self):
        """Malformed answers cannot leave an identified peer alive or invent an ID."""
        offer = self.scope["live_talkback_offer"]
        self.assertEqual(await offer(self.client, "camera/one", "offer"), self.http.return_value)
        self.assertEqual(self.http.call_args.args[0], "/api/cameras/camera%2Fone/live-talkback")
        for answer in (None, "private", "v=0" + "x" * 65536):
            self.http.return_value = {"sessionId": "a" * 32, "sdp": answer}
            with self.assertRaises(ConnectionError):
                await offer(self.client, "camera", "offer")
        self.assertEqual(self.client.close_live_talkback.await_count, 3)
        self.client.close_live_talkback.reset_mock()
        self.http.return_value = {"sessionId": "invalid", "sdp": "v=0"}
        with self.assertRaises(ConnectionError):
            await offer(self.client, "camera", "offer")
        self.client.close_live_talkback.assert_not_awaited()

    async def test_candidates_and_close_reject_unknown_ids_before_http(self):
        """Cleanup and candidate forwarding use the returned random peer ID only."""
        for method in ("live_talkback_candidate", "close_live_talkback"):
            for session in (None, "wrong", "a" * 31, "a" * 33):
                args = (None,) if method == "live_talkback_candidate" else ()
                with self.assertRaises(ConnectionError):
                    await self.scope[method](self.client, "camera", session, *args)
        self.http.assert_not_awaited()
        await self.scope["live_talkback_candidate"](self.client, "camera", "a" * 32, None)
        self.assertEqual(self.http.call_args.kwargs["payload"], {"candidate": None})
