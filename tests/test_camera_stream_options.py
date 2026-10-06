"""Protect the Home Assistant stream options required by raw gateway video.

The test reads the integration source without importing Home Assistant. CI owns
its execution, and the camera entity consumes the checked option at runtime.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock


CAMERA_SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/camera.py"


class CameraStreamOptionsTest(unittest.TestCase):
    """Verify the entity supplies the timing metadata Home Assistant needs."""

    def test_live_stream_uses_wallclock_timestamps(self) -> None:
        """Keep Home Assistant from rejecting raw packets that have no DTS."""
        tree = ast.parse(CAMERA_SOURCE.read_text())
        assignments = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Subscript)
                and isinstance(target.value, ast.Attribute)
                and isinstance(target.value.value, ast.Name)
                and target.value.value.id == "self"
                and target.value.attr == "stream_options"
                and isinstance(target.slice, ast.Name)
                and target.slice.id == "CONF_USE_WALLCLOCK_AS_TIMESTAMPS"
                for target in node.targets
            )
        ]

        self.assertEqual(len(assignments), 1)
        self.assertIsInstance(assignments[0].value, ast.Constant)
        self.assertIs(assignments[0].value.value, True)

    def test_stream_url_action_requires_a_response(self) -> None:
        """Keep the temporary URL out of state attributes and event data."""
        tree = ast.parse(CAMERA_SOURCE.read_text())
        setup = next(
            node
            for node in tree.body
            if isinstance(node, ast.AsyncFunctionDef)
            and node.name == "async_setup_entry"
        )
        registrations = [
            node
            for node in ast.walk(setup)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "async_register_entity_service"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value == "get_stream_url"
        ]

        self.assertEqual(len(registrations), 1)
        response = next(
            keyword.value
            for keyword in registrations[0].keywords
            if keyword.arg == "supports_response"
        )
        self.assertIsInstance(response, ast.Attribute)
        self.assertEqual(response.attr, "ONLY")

    def test_live_stream_refreshes_its_signed_source_before_expiry(self) -> None:
        """Refresh active viewers without restarting an idle camera stream."""
        tree = ast.parse(CAMERA_SOURCE.read_text())
        camera_class = next(
            node
            for node in tree.body
            if isinstance(node, ast.ClassDef) and node.name == "EufyGatewayCamera"
        )
        methods = {
            node.name: node
            for node in camera_class.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }

        added_calls = [
            node
            for node in ast.walk(methods["async_added_to_hass"])
            if isinstance(node, ast.Call)
        ]
        self.assertTrue(
            any(
                isinstance(call.func, ast.Name)
                and call.func.id == "async_track_time_interval"
                for call in added_calls
            )
        )

        refresh_calls = [
            node
            for node in ast.walk(methods["_async_refresh_stream_source"])
            if isinstance(node, ast.Call)
        ]
        self.assertTrue(
            any(
                isinstance(call.func, ast.Attribute)
                and call.func.attr == "stream_url"
                for call in refresh_calls
            )
        )

        # update_source() restarts Home Assistant's worker and a new camera
        # session, so the refresh only stores the URL for the next reconnect.
        self.assertFalse(
            any(
                isinstance(call.func, ast.Attribute)
                and call.func.attr == "update_source"
                for call in refresh_calls
            )
        )


class CameraStreamRefreshTest(unittest.IsolatedAsyncioTestCase):
    """Exercise URL renewal with synthetic clients and no Home Assistant runtime."""

    async def test_renewal_preserves_the_running_worker(self) -> None:
        """Store credentials for reconnect without requesting a worker restart."""
        tree = ast.parse(CAMERA_SOURCE.read_text())
        method = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.AsyncFunctionDef)
            and node.name == "_async_refresh_stream_source"
        )
        module = ast.Module(body=[method], type_ignores=[])
        namespace = {"GatewayClientError": RuntimeError, "_LOGGER": Mock()}
        exec(compile(module, str(CAMERA_SOURCE), "exec"), namespace)
        refresh = namespace["_async_refresh_stream_source"]
        stream = SimpleNamespace(
            source="old-url", outputs=Mock(return_value={"hls": object()}),
            update_source=Mock(),
        )
        client = SimpleNamespace(stream_url=AsyncMock(return_value="renewed-url"))
        camera = SimpleNamespace(
            stream=stream, serial="synthetic-camera",
            coordinator=SimpleNamespace(client=client),
        )
        await refresh(camera, None)
        self.assertEqual(stream.source, "renewed-url")
        stream.update_source.assert_not_called()
        client.stream_url.assert_awaited_once_with("synthetic-camera")

        client.stream_url.reset_mock()
        stream.outputs.return_value = {}
        await refresh(camera, None)
        client.stream_url.assert_awaited_once_with("synthetic-camera")

        stream.outputs.return_value = {"hls": object()}
        client.stream_url.side_effect = RuntimeError("renewal failed")
        await refresh(camera, None)
        self.assertEqual(stream.source, "renewed-url")
        stream.update_source.assert_not_called()


class CameraStreamUrlActionTest(unittest.IsolatedAsyncioTestCase):
    """Exercise the HLS handoff without importing Home Assistant."""

    @staticmethod
    def _method():
        """Compile the entity method with synthetic Home Assistant helpers."""
        tree = ast.parse(CAMERA_SOURCE.read_text())
        method = next(
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.AsyncFunctionDef)
            and node.name == "async_get_stream_url"
        )
        module = ast.Module(body=[method], type_ignores=[])
        namespace = {
            "HomeAssistantError": RuntimeError,
            "async_request_stream": AsyncMock(
                return_value="/api/hls/synthetic/master_playlist.m3u8"
            ),
            "get_url": Mock(return_value="http://ha.test:8123"),
        }
        exec(compile(module, str(CAMERA_SOURCE), "exec"), namespace)
        return namespace["async_get_stream_url"], namespace

    async def test_returns_home_assistant_hls_url(self) -> None:
        """Return Home Assistant's endpoint without exposing the gateway URL."""
        method, namespace = self._method()
        camera = SimpleNamespace(
            camera={"streamSupported": True},
            hass=object(),
            entity_id="camera.test",
        )

        response = await method(camera)

        self.assertEqual(
            response,
            {
                "url": "http://ha.test:8123/api/hls/synthetic/master_playlist.m3u8",
                "content_type": "application/vnd.apple.mpegurl",
            },
        )
        namespace["async_request_stream"].assert_awaited_once_with(
            camera.hass, camera.entity_id, "hls"
        )

    async def test_rejects_camera_without_live_route(self) -> None:
        """Do not create a provider when the gateway lacks a media route."""
        method, namespace = self._method()
        camera = SimpleNamespace(
            camera={"streamSupported": False}, hass=object(), entity_id="camera.test"
        )

        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            await method(camera)

        namespace["async_request_stream"].assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
