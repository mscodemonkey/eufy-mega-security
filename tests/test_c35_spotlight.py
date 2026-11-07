"""Exercise C35 light state and failures using test-owned HA callbacks.

Production callbacks run without importing HA or contacting hardware. The
coordinator owns reported state and these tests forbid optimistic updates.
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock
import unittest
from test_e30_locks import method
from test_camera_settings import ClientFailure


class C35SpotlightTests(unittest.IsolatedAsyncioTestCase):
    """Keep confirmed manual state separate from accepted writes and automatic light."""

    def test_unknown_state_never_becomes_off(self):
        """Missing and false-like values remain unknown rather than becoming off."""
        state = method('light.py', 'EufySpotlight', 'is_on', {})
        for value in (None, 0, 1, '0', '1', {}):
            self.assertIsNone(state(SimpleNamespace(camera={'reportedSettings': {'spotlightEnabled': value}})))
        self.assertIs(state(SimpleNamespace(camera={'reportedSettings': {'spotlightEnabled': False}})), False)

    async def test_success_refreshes_and_failure_invalidates_without_retry(self):
        """A failed write clears only the manual state and does not repeat dispatch."""
        callback = method('light.py', 'EufySpotlight', '_async_set',
                          {'GatewayClientError': ClientFailure, 'HomeAssistantError': RuntimeError})
        published = []
        camera = {'reportedSettings': {'spotlightEnabled': False, 'lightBrightness': 80}}
        client = SimpleNamespace(set_camera_light=AsyncMock())
        coordinator = SimpleNamespace(client=client, async_set_camera=published.append, async_request_refresh=AsyncMock())
        entity = SimpleNamespace(serial='test', camera=camera, coordinator=coordinator)
        await callback(entity, True)
        coordinator.async_request_refresh.assert_awaited_once()
        self.assertFalse(camera['reportedSettings']['spotlightEnabled'])
        client.set_camera_light.side_effect = ClientFailure('outcome_unknown', 503)
        with self.assertRaises(RuntimeError):
            await callback(entity, False)
        self.assertIsNone(published[-1]['reportedSettings']['spotlightEnabled'])
        self.assertEqual(published[-1]['reportedSettings']['lightBrightness'], 80)
        self.assertEqual(client.set_camera_light.await_count, 2)
