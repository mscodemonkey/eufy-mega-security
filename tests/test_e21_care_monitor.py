"""Protect the E21 sensor-only Home Assistant presentation boundary.

The tests compile shipped callbacks without Home Assistant imports. Synthetic
coordinator dictionaries own all state, and no gateway, account, media, or
hardware operation is available to the fixture.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


SOURCE = (
    Path(__file__).parents[1]
    / "custom_components/eufy_event_gateway/binary_sensor.py"
)


def load_function(name: str, namespace: dict, class_name: str | None = None):
    """Compile one production callback with postponed annotations retained."""
    tree = ast.parse(SOURCE.read_text())
    nodes = tree.body
    if class_name:
        nodes = next(
            node.body
            for node in nodes
            if isinstance(node, ast.ClassDef) and node.name == class_name
        )
    function = next(
        node
        for node in nodes
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == name
    )
    function.decorator_list = []
    exec(
        compile(ast.Module(body=[tree.body[1], function], type_ignores=[]), SOURCE, "exec"),
        namespace,
    )
    return namespace[name]


class E21CareMonitorTest(unittest.IsolatedAsyncioTestCase):
    """Keep care entities limited to the two advertised transient flags."""

    async def test_setup_creates_only_crying_and_sound_entities(self) -> None:
        """Create two sensor entities without admitting a camera entity."""
        added: list[tuple[str, str]] = []
        listeners: list[object] = []
        coordinator = SimpleNamespace(
            cameras={},
            stations={},
            sensors={
                "e21": {
                    "serial": "e21",
                    "capabilities": ["crying", "sound"],
                }
            },
        )
        coordinator.async_add_listener = lambda callback: listeners.append(callback)
        entry = SimpleNamespace(
            runtime_data=SimpleNamespace(coordinator=coordinator),
            async_on_unload=lambda _value: None,
        )
        namespace = {
            "er": SimpleNamespace(async_get=lambda _hass: SimpleNamespace()),
            "EufyStandaloneBinarySensor": lambda _coordinator, serial, kind: (
                serial,
                kind,
            ),
        }
        setup = load_function("async_setup_entry", namespace)
        await setup(None, entry, added.extend)
        self.assertEqual(added, [("e21", "crying"), ("e21", "sound")])
        self.assertEqual(len(listeners), 1)

    async def test_states_preserve_unknown_and_use_independent_fields(self) -> None:
        """Avoid turning a missing notification flag into a false claim."""
        getter = load_function("is_on", {}, "EufyStandaloneBinarySensor")
        entity = SimpleNamespace(kind="crying", sensor={"cryingDetected": True})
        self.assertIs(getter(entity), True)
        entity.kind = "sound"
        entity.sensor = {"soundDetected": False}
        self.assertIs(getter(entity), False)
        entity.sensor = {}
        self.assertIsNone(getter(entity))

    async def test_care_availability_checks_the_live_capability(self) -> None:
        """Require the care capability in addition to base inventory presence."""
        source = SOURCE.read_text()
        self.assertIn('if self.kind in ("crying", "sound"):', source)
        self.assertIn('self.kind in self.sensor.get(', source)
        self.assertIn('"capabilities", []', source)


if __name__ == "__main__":
    unittest.main()
