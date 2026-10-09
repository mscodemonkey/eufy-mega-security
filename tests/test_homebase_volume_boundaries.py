"""Protect HomeBase volume limits shared by Home Assistant and the gateway.

The product repository owns both adapters. These source-level checks prevent
their user-visible ranges from drifting while TypeScript tests cover command
validation and state confirmation in the gateway boundary.
"""

from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_homebase_volume_entities_start_at_one() -> None:
    """Keep the Home Assistant controls within the hardware-confirmed range."""
    source = (ROOT / "custom_components/eufy_event_gateway/number.py").read_text()

    assert "_attr_native_min_value = 1" in source
    assert "_attr_native_max_value = 26" in source


def test_gateway_rejects_zero_prompt_volume() -> None:
    """Reject a value that T8030 hardware leaves unchanged."""
    source = (ROOT / "eufy_event_gateway/src/provider/eufy-provider.ts").read_text()

    assert "value < 1 || value > 26" in source
    assert "HomeBase prompt volume must be from 1 to 26" in source
