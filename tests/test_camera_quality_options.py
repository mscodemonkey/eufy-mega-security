"""Validate native quality choices without importing Home Assistant.

The integration owns entity state and discovery. CI executes the extracted pure
mapping boundary with malformed gateway responses and exact native choices.
"""
from __future__ import annotations

import ast
from pathlib import Path
from typing import Any
import unittest

SOURCE = Path(__file__).parents[1] / 'custom_components/eufy_event_gateway/select.py'


class StreamingQualityOptionsTest(unittest.TestCase):
    """Keep invalid or unknown gateway options out of Home Assistant selectors."""

    def setUp(self) -> None:
        """Load only the pure mapping function, leaving HA lifecycle code untouched."""
        tree = ast.parse(SOURCE.read_text())
        function = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == '_streaming_quality_modes'
        )
        namespace: dict[str, Any] = {'Any': Any}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(SOURCE), 'exec'), namespace)
        self.map_modes = namespace['_streaming_quality_modes']

    def test_native_choices_have_distinct_translation_keys(self) -> None:
        """Preserve Auto and all three app-confirmed resolution choices."""
        modes = [{'value': index, 'name': name} for index, name in enumerate(['Auto', 'HD (720P)', 'Full HD (1080P)', '2K'])]
        self.assertEqual(self.map_modes({'streamingQualityModes': modes}), {0: 'auto', 1: 'hd', 2: 'full_hd', 3: '2k'})

    def test_c31_native_choices_preserve_distinct_labels(self) -> None:
        """C31 quality values differ from the SoloCam resolution names."""
        modes = [{'value': 0, 'name': 'Auto'}, {'value': 2, 'name': 'Medium'}, {'value': 3, 'name': 'High'}]
        self.assertEqual(self.map_modes({'streamingQualityModes': modes}), {0: 'auto', 2: 'medium', 3: 'high'})

    def test_s340_3k_is_limited_to_the_exact_model(self) -> None:
        """A S340 quality choice must not rename another camera's native tier."""
        modes=[{'value':3,'name':'3K'}]
        self.assertEqual(self.map_modes({'model':'T8170','streamingQualityModes':modes}),{3:'3k'})
        for model in ('T8170E','T8171','T8134'):
            self.assertEqual(self.map_modes({'model':model,'streamingQualityModes':modes}),{})

    def test_s340_quality_entity_requires_explicit_enablement(self) -> None:
        """An advertised trial creates a disabled entity and keeps other models unchanged."""
        tree=ast.parse(SOURCE.read_text())
        cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='EufyStreamingQualitySelect')
        constructor=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='__init__')

        class Entity:
            """Supply only the coordinator-owned camera dictionary."""

            def __init__(self,coordinator,serial):
                self.camera=coordinator

        class Select:
            """Keep the fixture independent of HA's runtime lifecycle."""

            def __init__(self):
                pass

        namespace={'EufyGatewayEntity':Entity,'SelectEntity':Select,'EufyGatewayCoordinator':dict}
        exec(compile(ast.Module(body=[constructor],type_ignores=[]),str(SOURCE),'exec'),namespace)
        entity=Entity({'model':'T8170'},'fixture')
        namespace['__init__'](entity,{'model':'T8170'},'fixture')
        self.assertIs(entity._attr_entity_registry_enabled_default,False)
        self.assertEqual(entity._attr_translation_key,'camera_streaming_quality_experimental')
        other=Entity({'model':'T8134'},'other')
        namespace['__init__'](other,{'model':'T8134'},'other')
        self.assertFalse(hasattr(other,'_attr_entity_registry_enabled_default'))

    def test_malformed_values_and_labels_are_rejected(self) -> None:
        """Reject booleans, arbitrary strings and unhashable labels safely."""
        for modes in [None, 'Auto', {}, [None], [{'value': 4, 'name': 'Auto'}], [{'value': True, 'name': 'Auto'}], [{'value': '0', 'name': 'Auto'}], [{'value': 0, 'name': []}], [{'value': 0, 'name': 'Unknown'}]]:
            with self.subTest(modes=modes):
                self.assertEqual(self.map_modes({'streamingQualityModes': modes}), {})


class NvrQualityOptionsTest(StreamingQualityOptionsTest):
    """Keep the unconfirmed Highest tier limited to the advertised NVR profile."""

    def test_highest_requires_exact_profile(self) -> None:
        """Reject tier four unless T8416 carries the explicit NVR controls marker."""
        for name, key in (("Highest", "highest"), ("Ultra 4K", "ultra_4k")):
            mode = [{"value": 4, "name": name}]
            for camera in ({}, {"model": "T8171"}, {"model": "T8416"}, {"model": "T8416", "nvrViewOptions": ["Wide", "Telephoto"]},
                           {"model": "T8416", "nvrLiveControlsSupported": "true"}, {"model": "T8171", "nvrLiveControlsSupported": True}):
                self.assertEqual(self.map_modes({**camera, "streamingQualityModes": mode}), {})
            self.assertEqual(self.map_modes({"model": "T8416", "nvrLiveControlsSupported": True, "streamingQualityModes": mode}), {4: key})

    def test_s350_names_follow_the_app(self) -> None:
        """The relabelled T8416 tiers map to existing translated states."""
        modes = [{"value": 0, "name": "Auto"}, {"value": 1, "name": "HD (720P)"}, {"value": 2, "name": "Full HD (1080P)"},
                 {"value": 3, "name": "2K"}, {"value": 4, "name": "Ultra 4K"}]
        self.assertEqual(self.map_modes({"model": "T8416", "nvrLiveControlsSupported": True, "streamingQualityModes": modes}),
                         {0: "auto", 1: "hd", 2: "full_hd", 3: "2k", 4: "ultra_4k"})


if __name__ == '__main__':
    unittest.main()
