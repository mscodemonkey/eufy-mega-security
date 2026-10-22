"""Expose privacy-safe catalogue and event-delivery evidence through diagnostics.

Home Assistant owns the download action and config-entry lifecycle. The local
gateway owns evidence collection and removes device labels, serial numbers,
payloads, exact event times, and account data before this module returns the
result to the user.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.camera import DATA_COMPONENT
from homeassistant.core import HomeAssistant

from . import EufyGatewayConfigEntry
from .camera import EufyGatewayCamera
from .client import GatewayClientError


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: EufyGatewayConfigEntry
) -> dict[str, Any]:
    """Return gateway evidence and existing HA consumers without opening playback."""
    playback: list[dict[str, Any]] = []
    component = hass.data.get(DATA_COMPONENT)
    if component is not None:
        cameras = sorted(
            (
                entity for entity in component.entities
                if isinstance(entity, EufyGatewayCamera)
                and entity.coordinator is entry.runtime_data.coordinator
            ),
            key=lambda entity: entity.serial,
        )
        for camera in cameras:
            try:
                playback.append(camera.playback_diagnostic())
            except Exception:
                playback.append({"unavailable": True})
    try:
        evidence = await entry.runtime_data.coordinator.client.catalogue_evidence()
    except GatewayClientError:
        return {
            "playback": playback,
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
    try:
        summary = await entry.runtime_data.coordinator.client.diagnostic_summary()
    except GatewayClientError:
        summary = {"available": False, "reason": "gateway_endpoint_unavailable"}
    return {
        "playback": playback,
        "catalogue_evidence": evidence,
        "event_delivery": event_delivery,
        "gateway_summary": summary,
    }
