"""Exercise the C35 switch against the actual accepted-control queue.

The coordinator owns requests and confirmed state. This offline harness owns
delayed success and failure, without importing HA or operating household devices.
"""
from __future__ import annotations

import ast
import asyncio
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"
SPEC = importlib.util.spec_from_file_location("c35_pending_queue", ROOT / "camera_control_queue.py")
QUEUE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = QUEUE
SPEC.loader.exec_module(QUEUE)


class CameraBase:
    """Borrow synthetic coordinator state for the production entity lifetime."""

    def __init__(self, coordinator, serial):
        """Bind one fixture identity without transport side effects."""
        self.coordinator, self.serial = coordinator, serial

    @property
    def camera(self):
        """Read the current confirmed fixture state."""
        return self.coordinator.cameras[self.serial]

    @property
    def available(self):
        """Supply the independent coordinator availability boundary."""
        return self.coordinator.online


class SwitchBase:
    """Supply inert component initialization for the production switch."""


def switch_class():
    """Load the complete production switch with only HA component bases replaced."""
    tree = ast.parse((ROOT / "switch.py").read_text())
    node = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                and node.name == "EufyCameraEnabledSwitch")
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), node], type_ignores=[])
    namespace = {"EufyGatewayEntity": CameraBase, "SwitchEntity": SwitchBase,
                 "HomeAssistantError": RuntimeError}
    exec(compile(ast.fix_missing_locations(module), str(ROOT / "switch.py"), "exec"), namespace)
    return namespace["EufyCameraEnabledSwitch"]


class C35PendingTests(unittest.IsolatedAsyncioTestCase):
    """Keep one accepted C35 write distinct from its delayed confirmation."""

    async def test_success_and_failure_release_pending_without_duplicate_requests(self):
        """A second on or off call cannot queue behind an ambiguous first write."""
        for fail in (False, True):
            with self.subTest(fail=fail):
                gate, entered = asyncio.Event(), asyncio.Event()
                tasks, dispatched, failures = [], [], []
                camera = {"model": "T8110", "deviceType": 10035,
                          "enabled": True, "enableControlSupported": True}
                coordinator = SimpleNamespace(cameras={"camera": camera}, online=True)

                def create_task(coroutine):
                    task = asyncio.create_task(coroutine)
                    tasks.append(task)
                    return task

                def confirmed(value):
                    coordinator.cameras["camera"] = value

                queue = QUEUE.CameraControlQueue(create_task, confirmed,
                                                lambda *args: failures.append(args), lambda: None)
                coordinator.camera_controls = queue

                async def operation(value):
                    dispatched.append(value)
                    entered.set()
                    await gate.wait()
                    if fail:
                        raise RuntimeError("unconfirmed")
                    return {**camera, "serial": "camera", "enabled": value}

                coordinator.submit_camera_control = lambda serial, action, value: queue.submit(
                    "peer", serial, action, lambda: operation(value))
                entity = switch_class()(coordinator, "camera")
                self.assertTrue(entity.available)
                await entity.async_turn_off()
                self.assertFalse(entity.available)
                self.assertTrue(entity.is_on)
                self.assertTrue(entity.extra_state_attributes["setting_update_pending"])
                for method in (entity.async_turn_off, entity.async_turn_on):
                    with self.assertRaisesRegex(RuntimeError, "No additional request"):
                        await method()
                await entered.wait()
                self.assertEqual(dispatched, [False])
                gate.set()
                await asyncio.gather(*tasks)
                self.assertTrue(entity.available)
                self.assertFalse(entity.extra_state_attributes["setting_update_pending"])
                self.assertEqual(entity.is_on, fail)
                self.assertEqual(len(failures), int(fail))
                coordinator.online = False
                self.assertFalse(entity.available)
                await queue.close()

    async def test_pending_other_actions_and_nearby_models_keep_existing_availability(self):
        """Do not withdraw another camera or reinterpret a different control's queue."""
        cls = switch_class()
        for model, device_type, pending in (("T8110", 10035, False),
                                             ("T8110", 10036, True),
                                             ("T817L", 10031, True)):
            with self.subTest(model=model, device_type=device_type, pending=pending):
                coordinator = SimpleNamespace(online=True, cameras={"camera": {
                    "model": model, "deviceType": device_type, "enabled": False,
                    "enableControlSupported": True}}, camera_controls=SimpleNamespace(
                        pending=lambda serial, action: pending if action == "enabled" else True))
                self.assertTrue(cls(coordinator, "camera").available)


if __name__ == "__main__":
    unittest.main()
