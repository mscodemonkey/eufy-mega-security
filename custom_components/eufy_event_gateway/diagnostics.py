"""Expose privacy-safe catalogue evidence through Home Assistant diagnostics.

Home Assistant owns the download action and config-entry lifecycle. The local
gateway owns evidence collection and removes device labels, serial numbers,
payloads, and account data before this module returns the result to the user.
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
            }
        }
    return {"catalogue_evidence": evidence}
