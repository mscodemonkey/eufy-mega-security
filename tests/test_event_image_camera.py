"""Protect the separate Home Assistant event-image entity contract.

The integration source is inspected without importing Home Assistant. CI owns
execution, while the camera platform consumes the checked unique ID, gateway
method, revision field, and entity factory at runtime.
"""

from __future__ import annotations

import ast
from pathlib import Path
import unittest


CAMERA_SOURCE = Path(__file__).parents[1] / "custom_components/eufy_event_gateway/camera.py"


class EventImageCameraContractTest(unittest.TestCase):
    """Verify event pictures remain separate from the main camera entity."""

    def setUp(self) -> None:
        """Parse the camera platform once for each focused contract check."""
        self.tree = ast.parse(CAMERA_SOURCE.read_text())
        self.event_image_class = next(
            node
            for node in self.tree.body
            if isinstance(node, ast.ClassDef)
            and node.name == "EufyGatewayEventImage"
        )

    def test_setup_creates_an_event_image_for_each_camera(self) -> None:
        """Keep the new entity attached to every discovered camera lifecycle."""
        calls = [
            node
            for node in ast.walk(self.tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "EufyGatewayEventImage"
        ]

        self.assertEqual(len(calls), 1)

    def test_entity_uses_separate_identity_revision_and_client_path(self) -> None:
        """Prevent the event entity from reading or invalidating the main still."""
        source = ast.unparse(self.event_image_class)

        self.assertIn("f'{serial}_event_image'", source)
        self.assertIn("('eventImage', 'snapshot')", source)
        self.assertIn("self.coordinator.client.event_image(self.serial)", source)
        self.assertNotIn("self.coordinator.client.snapshot(self.serial)", source)


if __name__ == "__main__":
    unittest.main()
