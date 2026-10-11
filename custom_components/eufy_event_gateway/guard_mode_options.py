"""Build guard-mode labels shared by writable and read-only entities.

The coordinator owns station state and account-defined custom titles. This
module validates those titles without Home Assistant side effects so entity
platforms can expose one unambiguous numeric-to-label mapping.
"""

from __future__ import annotations

import unicodedata
from typing import Any

from .const import GUARD_MODES


def guard_mode_options(station: dict[str, Any]) -> dict[int, str]:
    """Return stable built-in labels plus safe account-defined custom titles.

    Custom titles are accepted only for modes 3 to 5. Ambiguous, malformed or
    Home Assistant special-state labels retain their generic custom tokens.
    """
    options = dict(GUARD_MODES)
    names = station.get("guardModeNames")
    if not isinstance(names, dict):
        return options
    candidates: dict[int, str] = {}
    for mode in range(3, 6):
        name = names.get(str(mode), names.get(mode))
        if (
            isinstance(name, str)
            and 0 < len(name) <= 64
            and name == name.strip()
            and name.casefold() not in {"unknown", "unavailable"}
            and not any(
                unicodedata.category(character).startswith("C")
                or unicodedata.category(character) in {"Zl", "Zp"}
                for character in name
            )
        ):
            candidates[mode] = name
    for mode, name in candidates.items():
        built_in_collisions = {
            label.casefold()
            for other_mode, label in GUARD_MODES.items()
            if other_mode != mode
        }
        candidate_collisions = {
            label.casefold()
            for other_mode, label in candidates.items()
            if other_mode != mode
        }
        if (
            name.casefold() not in built_in_collisions
            and name.casefold() not in candidate_collisions
        ):
            options[mode] = name
    return options


def guard_mode_label(station: dict[str, Any], mode: object) -> str | None:
    """Decode one reported mode while rejecting booleans and non-integers."""
    if type(mode) is not int:
        return None
    return guard_mode_options(station).get(mode)
