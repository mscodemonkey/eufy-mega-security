"""Expose privacy-safe catalogue and event-delivery evidence through diagnostics.

Home Assistant owns the download action and config-entry lifecycle. The local
gateway owns evidence collection and removes device labels, serial numbers,
payloads, exact event times, and account data before this module returns the
result to the user.
"""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant

from . import EufyGatewayConfigEntry
from .client import GatewayClientError


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: EufyGatewayConfigEntry
) -> dict[str, Any]:
    """Return evidence suitable for a public device support report."""
    try:
        evidence = await entry.runtime_data.coordinator.client.catalogue_evidence()
    except GatewayClientError:
        return {
            "catalogue_evidence": {
                "available": False,
                "reason": "gateway_unavailable",
            },
        }
    try:
        event_delivery = (
            await entry.runtime_data.coordinator.client.event_delivery_diagnostic()
        )
    except GatewayClientError:
        event_delivery = {
            "available": False,
            "reason": "gateway_endpoint_unavailable",
        }
    return {"catalogue_evidence": evidence, "event_delivery": event_delivery}
