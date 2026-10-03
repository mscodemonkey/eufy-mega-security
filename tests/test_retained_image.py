"""Check the HA still-image boundary without importing a full HA runtime.

The tests own source inspection. Runtime delivery belongs to the image platform
and shared cache, and upgrade compatibility belongs to the camera registry.
"""

import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1] / "custom_components/eufy_event_gateway"


class RetainedImageContractTest(unittest.TestCase):
    """Protect image semantics and non-destructive camera compatibility."""

    def test_retained_picture_is_an_image_without_stream_actions(self) -> None:
        """Keep automatic Security camera discovery separate from event pictures."""
        tree = ast.parse((ROOT / "image.py").read_text())
        entity = next(node for node in tree.body if isinstance(node, ast.ClassDef))
        source = ast.unparse(entity)
        self.assertIn("ImageEntity", [ast.unparse(base) for base in entity.bases])
        self.assertIn("async def async_image", source)
        self.assertIn("image_last_updated", source)
        self.assertIn("image_cache.async_image", source)
        self.assertNotIn("stream_source", source)
        self.assertIn("Platform.IMAGE", (ROOT / "const.py").read_text())

    def test_upgrade_hides_only_existing_compatibility_cameras(self) -> None:
        """Preserve old entity references without creating more camera tiles."""
        source = (ROOT / "camera.py").read_text()
        self.assertIn('if legacy_id is None:', source)
        setup = (ROOT / "__init__.py").read_text()
        self.assertIn('and image_id is None', setup)
        self.assertIn('RegistryEntryHider.INTEGRATION', setup)
        self.assertNotIn('async_remove(', source)
