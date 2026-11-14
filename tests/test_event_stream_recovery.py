"""Exercise event-client idle recovery without vendor or household operations.

Mandatory tests own synthetic HTTP responses and coordinator timing. Optional
loopback tests use installed aiohttp to verify actual socket-idle behaviour.
"""
from __future__ import annotations

import ast
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

try:
    import aiohttp
    from aiohttp import web
except ImportError:
    aiohttp = None
    web = None


ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


def _client(timeout, client_error=ConnectionError, response_error=ConnectionError):
    """Load production stream methods against caller-owned HTTP dependencies."""
    tree = ast.parse((ROOT / "client.py").read_text())
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "GatewayClient")
    methods = {"__init__", "events", "_url", "_raise_for_status"}
    owner.body = [node for node in owner.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in methods]
    errors = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in {"GatewayClientError", "GatewayAuthenticationError"}]
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    namespace = {"ClientTimeout": timeout, "ClientError": client_error,
                 "ClientResponseError": response_error, "json": json}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *errors, owner], type_ignores=[])), str(ROOT / "client.py"), "exec"), namespace)
    return namespace


class StreamContractTests(unittest.IsolatedAsyncioTestCase):
    """Keep stream lifetime, timeout translation and cancellation independent."""

    def fixture(self, failure=None):
        """Own one finite response and retain the request's timeout policy."""
        namespace = _client(lambda **kwargs: SimpleNamespace(**kwargs))
        requests = []
        closed = []

        class Response:
            """Yield invented SSE lines without an HTTP session."""

            status = 200

            def __init__(self):
                self.content = self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                closed.append(True)

            def raise_for_status(self):
                return None

            async def __aiter__(self):
                yield b': heartbeat\n'
                yield b'\n'
                yield b'data: {"sensor":\n'
                yield b'data: {"contactOpen":true}}\n'
                yield b'\n'
                if failure:
                    raise failure()

        def get(_url, **kwargs):
            requests.append(kwargs)
            return Response()

        client = namespace['GatewayClient'](SimpleNamespace(get=get), 'http://invented', 'fixture-token')
        return namespace, client, requests, closed

    async def test_stream_has_no_total_limit_and_a_finite_heartbeat_idle_limit(self):
        """Idle HA keeps listening while missing heartbeats can trigger recovery."""
        _, client, requests, closed = self.fixture()
        self.assertEqual([row async for row in client.events()], [{"sensor": {"contactOpen": True}}])
        timeout = requests[0]['timeout']
        self.assertIsNone(timeout.total)
        self.assertGreater(timeout.sock_read, 15)
        self.assertLess(timeout.sock_read, 60)
        self.assertEqual(requests[0]['headers'], {'Authorization': 'Bearer fixture-token'})
        self.assertEqual(closed, [True])

    async def test_transport_idle_failure_is_a_reconnectable_client_error(self):
        """The coordinator receives its existing failure type after a read stall."""
        namespace, client, _, closed = self.fixture(TimeoutError)
        iterator = client.events()
        await iterator.__anext__()
        with self.assertRaises(namespace['GatewayClientError']):
            await iterator.__anext__()
        self.assertEqual(closed, [True])

    async def test_cancellation_is_not_rewritten_as_a_connection_failure(self):
        """Unloading closes the request and does not enter another retry."""
        _, client, _, closed = self.fixture(asyncio.CancelledError)
        iterator = client.events()
        await iterator.__anext__()
        with self.assertRaises(asyncio.CancelledError):
            await iterator.__anext__()
        self.assertEqual(closed, [True])

    async def test_coordinator_reconnects_and_applies_the_next_stream_event(self):
        """A client failure reuses existing backoff and then resumes state delivery."""
        error = type('FixtureClientError', (Exception,), {})
        sleeps = []
        applied = asyncio.Event()
        calls = []

        async def sleep(delay):
            sleeps.append(delay)

        async def events():
            calls.append(True)
            if len(calls) == 1:
                raise error('fixture idle timeout')
            yield {'sensor': {'serial': 'invented', 'contactOpen': True}}
            await asyncio.Event().wait()

        tree = ast.parse((ROOT / 'coordinator.py').read_text())
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'EufyGatewayCoordinator')
        method = next(node for node in cls.body if isinstance(node, ast.AsyncFunctionDef) and node.name == '_listen_forever')
        namespace = {'asyncio': SimpleNamespace(sleep=sleep, CancelledError=asyncio.CancelledError), 'GatewayClientError': error}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(ROOT / 'coordinator.py'), 'exec'), namespace)
        received = []

        def apply(event):
            received.append(event)
            applied.set()

        owner = SimpleNamespace(client=SimpleNamespace(events=events), _apply_event=apply,
                                logger=SimpleNamespace(debug=lambda *args: None))
        task = asyncio.create_task(namespace['_listen_forever'](owner))
        try:
            await asyncio.wait_for(applied.wait(), .5)
            self.assertEqual(sleeps, [1])
            self.assertEqual(len(calls), 2)
            self.assertTrue(received[0]['sensor']['contactOpen'])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@unittest.skipUnless(aiohttp is not None, 'aiohttp is optional in the standalone test environment')
class StreamSocketTests(unittest.IsolatedAsyncioTestCase):
    """Verify the real HTTP client's silence and heartbeat behaviour on loopback."""

    async def asyncSetUp(self):
        """Start a local peer and scale idle intervals without changing their ratio."""
        self.mode = 'silent'
        self.release = asyncio.Event()

        async def handler(request):
            response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
            await response.prepare(request)
            await response.write(b'data: {"ready":true}\n\n')
            if self.mode == 'heartbeat':
                for _ in range(15):
                    await asyncio.sleep(.01)
                    await response.write(b': heartbeat\n\n')
                await response.write(b'data: {"arrived":true}\n\n')
            await self.release.wait()
            return response

        app = web.Application()
        app.router.add_get('/api/events', handler)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.session = aiohttp.ClientSession()

        def timeout(**kwargs):
            if kwargs.get('sock_read') is not None:
                kwargs['sock_read'] /= 1000
            return aiohttp.ClientTimeout(**kwargs)

        self.namespace = _client(timeout, aiohttp.ClientError, aiohttp.ClientResponseError)
        self.client = self.namespace['GatewayClient'](self.session, f'http://127.0.0.1:{port}')

    async def asyncTearDown(self):
        """Release all test-owned sockets even when an assertion fails."""
        self.release.set()
        await self.session.close()
        await self.runner.cleanup()

    async def test_a_silent_open_socket_fails_before_the_outer_test_guard(self):
        """A peer need not close its socket for the client to request reconnection."""
        iterator = self.client.events()
        self.assertEqual(await iterator.__anext__(), {'ready': True})
        with self.assertRaises(self.namespace['GatewayClientError']):
            await asyncio.wait_for(iterator.__anext__(), .3)
        await iterator.aclose()

    async def test_heartbeats_keep_an_eventless_connection_alive(self):
        """A normal idle connection outlives several read-idle intervals."""
        self.mode = 'heartbeat'
        iterator = self.client.events()
        self.assertEqual(await iterator.__anext__(), {'ready': True})
        self.assertEqual(await asyncio.wait_for(iterator.__anext__(), .6), {'arrived': True})
        await iterator.aclose()
