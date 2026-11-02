"""Exercise accepted camera work without Home Assistant or household commands.

The production queue owns scheduling and retirement. Tests own controlled waits
and callbacks, including ambiguous completion, ordering and queue expiry.
"""
from __future__ import annotations
import asyncio
import importlib.util
from pathlib import Path
import sys
import unittest

PATH = Path(__file__).parents[1] / 'custom_components/eufy_event_gateway/camera_control_queue.py'
SPEC = importlib.util.spec_from_file_location('tested_camera_queue', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CameraQueueTests(unittest.IsolatedAsyncioTestCase):
    """Check actual production workers with explicitly controlled device completion."""

    async def test_six_calls_return_without_waiting_for_confirmation(self):
        """A six-action HA script can enqueue while the first gateway call is held."""
        gate = asyncio.Event()
        calls, results, failures = [], [], []
        queue = MODULE.CameraControlQueue(asyncio.create_task, results.append,
                                          lambda *v: failures.append(v), lambda: None)
        async def operation(index):
            calls.append(index)
            await gate.wait()
            return {'serial': str(index)}
        for index in range(6):
            queue.submit('base', str(index), 'motion', lambda i=index: operation(i))
        self.assertEqual(results, [])
        self.assertTrue(queue.pending('5', 'motion'))
        for _ in range(4):
            await asyncio.sleep(0)
        self.assertEqual(calls, [0])
        gate.set()
        for _ in range(30):
            await asyncio.sleep(0)
        self.assertEqual(calls, list(range(6)))
        self.assertEqual(len(results), 6)
        self.assertEqual(failures, [])
        await queue.close()

    async def test_opposite_settings_and_different_controls_keep_peer_order(self):
        """Enablement and motion share one physical peer worker without reordering."""
        calls = []
        queue = MODULE.CameraControlQueue(asyncio.create_task, lambda v: None,
                                          lambda *v: None, lambda: None)
        async def operation(value):
            calls.append(value)
            return {'serial': 'camera'}
        for action,value in [('motion', False), ('enabled', False), ('motion', True)]:
            queue.submit('base','camera',action,lambda v=value: operation(v))
        for _ in range(20):
            await asyncio.sleep(0)
        self.assertEqual(calls, [False, False, True])
        await queue.close()

    async def test_rejection_does_not_retry_or_poison_next_request(self):
        """A failed write is surfaced once and leaves following work executable."""
        failures, results = [], []
        queue = MODULE.CameraControlQueue(asyncio.create_task, results.append,
                                          lambda *v: failures.append(v), lambda: None)
        async def reject():
            raise RuntimeError('private upstream data')
        async def succeed():
            return {'serial':'camera'}
        queue.submit('base','camera','motion',reject)
        queue.submit('base','camera','motion',succeed)
        for _ in range(20):
            await asyncio.sleep(0)
        self.assertEqual(failures, [('camera','motion','failed',True)])
        self.assertEqual(len(results),1)
        await queue.close()

    async def test_capacity_and_unload_before_dispatch(self):
        """Overflow and pre-start unload never call the gateway."""
        failures = []
        queue = MODULE.CameraControlQueue(asyncio.create_task, lambda v: None,
                                          lambda *v: failures.append(v), lambda: None, capacity=1)
        async def forbidden():
            self.fail('unsent request dispatched')
        queue.submit('base','camera','motion',forbidden)
        with self.assertRaises(RuntimeError):
            queue.submit('other','other','motion',forbidden)
        await queue.close()
        self.assertEqual(failures,[('camera','motion','cancelled',False)])
        with self.assertRaises(RuntimeError):
            queue.submit('base','camera','motion',forbidden)

    async def test_active_unload_retains_unknown_outcome(self):
        """Cancelling an HTTP wait cannot claim the remote write was not sent."""
        gate = asyncio.Event()
        failures, results = [], []
        queue = MODULE.CameraControlQueue(asyncio.create_task, results.append,
                                          lambda *v: failures.append(v), lambda: None)
        async def active():
            gate.set()
            await asyncio.Event().wait()
        queue.submit('base','camera','motion',active)
        await gate.wait()
        await queue.close()
        self.assertEqual(results, [])
        self.assertEqual(failures,[('camera','motion','cancelled',True)])

    async def test_expired_work_is_never_dispatched(self):
        """A stale queued request fails as unsent rather than changing a setting later."""
        failures = []
        queue = MODULE.CameraControlQueue(asyncio.create_task, lambda v: None,
                                          lambda *v: failures.append(v), lambda: None, lifetime=-1)
        async def forbidden():
            self.fail('expired request dispatched')
        queue.submit('base','camera','motion',forbidden)
        for _ in range(3):
            await asyncio.sleep(0)
        self.assertEqual(failures,[('camera','motion','expired',False)])
        await queue.close()

    async def test_six_shipped_switch_calls_use_the_coordinator_queue(self):
        """Exercise actual switch and coordinator methods with delayed HTTP responses."""
        import ast
        from types import SimpleNamespace
        root = PATH.parent
        namespace = {'HomeAssistantError': RuntimeError, 'CameraControlNotSentError': MODULE.CameraControlNotSentError, 'Any': object}
        for file, names in [('coordinator.py', {'submit_camera_control'}),
                            ('switch.py', {'_async_set_enabled', '_async_set_motion'})]:
            tree = ast.parse((root / file).read_text())
            nodes = [n for cls in tree.body if isinstance(cls, ast.ClassDef)
                     for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                     and n.name in names]
            module = ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[]))
            exec(compile(module, file, 'exec'), namespace)
        gate = asyncio.Event()
        results, calls, failures = [], [], []
        async def operation(serial, enabled):
            calls.append((serial, enabled))
            await gate.wait()
            return {'serial':serial,'enabled':enabled}
        queue = MODULE.CameraControlQueue(asyncio.create_task, results.append,
                                          lambda *v: failures.append(v), lambda: None)
        coordinator = SimpleNamespace(cameras={str(i):{'stationSerial':'base','enableControlSupported':True,'motionDetectionControlSupported':True} for i in range(6)},
                                      client=SimpleNamespace(set_camera_enabled=operation,
                                          set_camera_motion_detection=operation), camera_controls=queue)
        coordinator.submit_camera_control = lambda *args: namespace['submit_camera_control'](coordinator,*args)
        start = asyncio.get_running_loop().time()
        for i in range(6):
            switch = SimpleNamespace(serial=str(i),coordinator=coordinator)
            await namespace['_async_set_motion' if i<5 else '_async_set_enabled'](switch,True)
        self.assertLess(asyncio.get_running_loop().time()-start,0.2)
        self.assertEqual(results,[])
        gate.set()
        for _ in range(40):
            await asyncio.sleep(0)
        self.assertEqual(calls,[(str(i),True) for i in range(6)])
        self.assertEqual(len(results),6)
        self.assertEqual(failures,[])
        await namespace['_async_set_motion'](switch,False)
        coordinator.cameras['5']['stationSerial'] = 'new-base'
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(len(calls),6)
        self.assertEqual(failures,[('5','motion','route_changed',False)])
        await queue.close()

    async def test_wrong_camera_confirmation_is_not_published(self):
        """A malformed response cannot update a different camera's state."""
        results, failures = [], []
        queue = MODULE.CameraControlQueue(asyncio.create_task, results.append,
                                          lambda *v: failures.append(v), lambda: None)
        async def wrong():
            return {'serial':'other'}
        queue.submit('base','camera','enabled',wrong)
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(results,[])
        self.assertEqual(failures,[('camera','enabled','failed',True)])
        await queue.close()

    async def test_separate_peers_do_not_wait_for_a_slow_homebase(self):
        """An unrelated camera can finish while one HomeBase is still confirming."""
        gate, results = asyncio.Event(), []
        queue = MODULE.CameraControlQueue(asyncio.create_task, results.append,
                                          lambda *v: None, lambda: None)
        async def slow():
            await gate.wait()
            return {'serial':'slow'}
        async def fast():
            return {'serial':'fast'}
        queue.submit('base','slow','motion',slow)
        queue.submit('standalone','fast','enabled',fast)
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(results,[{'serial':'fast'}])
        gate.set()
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(results[-1],{'serial':'slow'})
        await queue.close()

    async def test_timeout_never_reports_a_confirmed_change(self):
        """A timed-out HTTP call remains uncertain and is not replayed."""
        calls, results, failures = [], [], []
        queue = MODULE.CameraControlQueue(asyncio.create_task, results.append,
                                          lambda *v: failures.append(v), lambda: None, lifetime=0.01)
        async def slow():
            calls.append(True)
            await asyncio.Event().wait()
        queue.submit('base','camera','motion',slow)
        await asyncio.sleep(0.04)
        self.assertEqual(results,[])
        self.assertEqual(calls,[True])
        self.assertEqual(failures,[('camera','motion','timeout',True)])
        await queue.close()

    async def test_task_creation_failure_leaves_no_accepted_request(self):
        """An entry already unloading cannot retain an unstarted coroutine or request."""
        def reject_task(operation):
            raise RuntimeError('entry unloading')
        queue = MODULE.CameraControlQueue(reject_task, lambda v: None,
                                          lambda *v: None, lambda: None)
        async def forbidden():
            self.fail('unaccepted request dispatched')
        with self.assertRaises(RuntimeError):
            queue.submit('base','camera','motion',forbidden)
        self.assertFalse(queue.pending('camera','motion'))
        await queue.close()

    async def test_late_response_after_unload_is_not_published(self):
        """Even a transport that completes during cancellation cannot revive old state."""
        started, results, failures = asyncio.Event(), [], []
        queue = MODULE.CameraControlQueue(asyncio.create_task, results.append,
                                          lambda *v: failures.append(v), lambda: None)
        async def late():
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return {'serial':'camera'}
        queue.submit('base','camera','motion',late)
        await started.wait()
        await queue.close()
        self.assertEqual(results,[])
        self.assertEqual(failures,[('camera','motion','cancelled',True)])

    async def test_route_retirement_rejects_a_provably_unsent_request(self):
        """A changed admission guard must not be reported as an uncertain device write."""
        results, failures = [], []
        queue = MODULE.CameraControlQueue(asyncio.create_task, results.append,
                                          lambda *v: failures.append(v), lambda: None)
        async def changed():
            raise MODULE.CameraControlNotSentError('route retired')
        queue.submit('base','camera','enabled',changed)
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(results,[])
        self.assertEqual(failures,[('camera','enabled','route_changed',False)])
        await queue.close()

    async def test_eager_ha_worker_start_cannot_strand_the_next_request(self):
        """HA may enter a worker before its task factory returns to submit."""
        failures = []
        def eager(operation):
            try:
                operation.send(None)
            except StopIteration:
                done = asyncio.get_running_loop().create_future()
                done.set_result(None)
                return done
            return asyncio.create_task(operation)
        queue = MODULE.CameraControlQueue(eager, lambda v: None,
                                          lambda *v: failures.append(v), lambda: None, lifetime=-1)
        async def forbidden():
            self.fail('expired request dispatched')
        for _ in range(2):
            queue.submit('base','camera','motion',forbidden)
            for _ in range(5):
                await asyncio.sleep(0)
            self.assertFalse(queue.pending('camera','motion'))
        self.assertEqual(failures,[('camera','motion','expired',False)]*2)
        await queue.close()
