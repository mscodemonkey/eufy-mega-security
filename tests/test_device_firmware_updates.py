"""Exercise firmware arriving after HA device registration for each device family.

Tests run the production event and registry callbacks against owned synthetic
entries. They open no network and change no physical device or real HA registry.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import MethodType, SimpleNamespace
import unittest
from unittest.mock import Mock


_SOURCE = Path(__file__).parents[1] / 'custom_components/eufy_event_gateway/coordinator.py'
_TREE = ast.parse(_SOURCE.read_text())
_CLASS = next(n for n in _TREE.body if isinstance(n, ast.ClassDef) and n.name == 'EufyGatewayCoordinator')
_METHODS = {'_apply_event', 'async_set_camera', 'async_set_station', '_sync_device_names', '_sync_device_name'}


class _Owner:
    """Hold synthetic family state while production callbacks own its updates."""

    def __getattr__(self, name):
        if name in ('cameras', 'stations', 'sensors', 'locks'):
            return self.data[name]
        raise AttributeError(name)

    def async_set_updated_data(self, data):
        """Apply a production snapshot without creating any HA objects."""
        self.data = data


def _fixture(version=None):
    """Bind actual production methods to one already-registered owned device."""
    device = SimpleNamespace(id='registered', name='Fixture', name_by_user='User choice', sw_version=version)
    registry = SimpleNamespace(async_get_device_by_identifier=Mock(return_value=device), async_update_device=Mock())
    namespace = {'dr': SimpleNamespace(async_get=lambda hass: registry), 'DOMAIN': 'eufy_event_gateway'}
    nodes = [n for n in _CLASS.body if isinstance(n, ast.FunctionDef) and n.name in _METHODS]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(_SOURCE), 'exec'), namespace)
    owner = _Owner()
    owner.data = {name: {} for name in ('cameras', 'stations', 'sensors', 'locks')}
    owner.hass = object()
    owner.config_entry = SimpleNamespace(entry_id='owned-entry')
    for name in _METHODS:
        setattr(owner, name, MethodType(namespace[name], owner))
    return owner, device, registry


class DeviceFirmwareUpdates(unittest.TestCase):
    """Cover real bulk and individual event paths rather than just the metadata helper."""

    def test_late_firmware_updates_all_newly_covered_event_paths(self):
        """An existing HA device receives metadata from individual or bulk SSE events."""
        for family, singular in (('cameras', 'camera'), ('stations', 'station'), ('sensors', 'sensor')):
            for bulk in (False, True):
                with self.subTest(family=family, bulk=bulk):
                    owner, device, registry = _fixture()
                    row = {'serial': 'fixture', 'name': 'Fixture', 'firmware': ' 1.2.3 '}
                    owner._apply_event({family: [row]} if bulk else {singular: row})
                    registry.async_update_device.assert_called_once_with('registered', sw_version='1.2.3')
                    registry.async_get_device_by_identifier.assert_called_with(('eufy_event_gateway', 'fixture'), 'owned-entry')
                    self.assertEqual(device.name_by_user, 'User choice')
                    self.assertIs(owner.data[family]['fixture'], row)

    def test_repeated_or_absent_versions_preserve_existing_registry_metadata(self):
        """Recovery updates cannot erase a known version or rewrite equal metadata."""
        for family in ('cameras', 'stations', 'sensors'):
            for version in (None, False, 42, '', ' ', 'x' * 101, '1.2.3'):
                with self.subTest(family=family, version=version):
                    owner, device, registry = _fixture('1.2.3')
                    owner._apply_event({family: [{'serial': 'fixture', 'name': 'Fixture', 'firmware': version}]})
                    registry.async_update_device.assert_not_called()
                    self.assertEqual(device.sw_version, '1.2.3')
