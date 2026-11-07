"""Serve the live view card with the integration.

HACS users get the card with the integration and add nothing by hand: Home
Assistant loads it on every dashboard once this module registers it. The card
is one plain JavaScript file with no build step. Its URL carries a hash of the
file, so browsers fetch a fresh copy after each update.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

CARD_FILE = Path(__file__).parent / "frontend" / "eufy-live-card.js"
CARD_URL = f"/{DOMAIN}/eufy-live-card.js"
_REGISTERED = f"{DOMAIN}_live_card_registered"


async def async_register_live_card(hass: HomeAssistant) -> None:
    """Serve and load the card once per Home Assistant run.

    Home Assistant cannot remove a static route, so later entries and reloads
    reuse the first registration. A failure here only loses the card, never
    the integration's entities.
    """
    if hass.data.get(_REGISTERED):
        return
    hass.data[_REGISTERED] = True
    try:
        digest = await hass.async_add_executor_job(_card_digest)
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, str(CARD_FILE), True)]
        )
    except (OSError, RuntimeError) as error:
        _LOGGER.warning("Could not serve the Eufy live view card: %s", error)
        return
    add_extra_js_url(hass, f"{CARD_URL}?v={digest}")


def _card_digest() -> str:
    """Return a short content hash used to refresh browser caches."""
    return hashlib.sha256(CARD_FILE.read_bytes()).hexdigest()[:12]
