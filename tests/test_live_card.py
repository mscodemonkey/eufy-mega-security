"""Keep the bundled live view card wired to the integration it drives.

The card finds controls by entity translation key and reads failure codes
from the client's error wording. These tests fail when either side changes
without the other, and check that the card is served once with a cache-busting
URL. The card's own request flow is tested in Node by eufy_live_card.test.mjs.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from types import ModuleType, SimpleNamespace
import unittest

ROOT = Path(__file__).parents[1]
INTEGRATION = ROOT / "custom_components/eufy_event_gateway"
CARD = INTEGRATION / "frontend/eufy-live-card.js"


def _card_keys() -> dict[str, set[str]]:
    """Read the translation keys per platform from the card's CONTROL_KEYS table."""
    table = re.search(r"export const CONTROL_KEYS = Object\.freeze\(\{(.*?)\n\}\);", CARD.read_text(), re.S)
    assert table is not None
    keys: dict[str, set[str]] = {}
    for platform, body in re.findall(r"(\w+): Object\.freeze\(\{(.*?)\}\)", table.group(1), re.S):
        keys[platform] = set(re.findall(r"(\w+): \"", body))
    return keys


class LiveCardContractTest(unittest.TestCase):
    """Check the card against the entities and errors it depends on."""

    def test_card_logic_in_node(self) -> None:
        """Run the card's request-flow tests where Node.js is available, as in CI."""
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is not installed")
        result = subprocess.run(
            [node, "--test", str(ROOT / "tests/eufy_live_card.test.mjs")],
            capture_output=True, text=True, timeout=120, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_card_keys_name_real_entities(self) -> None:
        """Every key the card looks for is one the integration creates."""
        keys = _card_keys()
        self.assertEqual(set(keys), {"button", "select", "switch", "siren"})
        entity_strings = json.loads((INTEGRATION / "strings.json").read_text())["entity"]
        for platform in ("button", "select", "siren"):
            missing = keys[platform] - set(entity_strings[platform])
            self.assertEqual(missing, set(), f"{platform} keys without an entity translation")
        switch_source = (INTEGRATION / "switch.py").read_text()
        self.assertIn('self._attr_translation_key = f"camera_{translation_name}"', switch_source)
        for key in keys["switch"]:
            self.assertIn(f'"{key.removeprefix("camera_")}"', switch_source)

    def test_card_reads_the_client_failure_codes(self) -> None:
        """The card's code list and pattern match what the client raises."""
        client = (INTEGRATION / "client.py").read_text()
        self.assertIn('f"NVR control {code}"', client)
        self.assertIn('code in ("unavailable", "busy", "rate_limited", "outcome_unknown", "disabled")', client)
        self.assertIn("Request outcome is unknown. Check Eufy before trying again.", client)
        source = CARD.read_text()
        codes = re.search(r"FAILURE_CODES = Object\.freeze\(\[(.*?)\]\)", source)
        assert codes is not None
        self.assertEqual(set(re.findall(r'"(\w+)"', codes.group(1))), {"unavailable", "busy", "rate_limited", "outcome_unknown", "disabled"})
        self.assertIn("/NVR control (busy|unavailable|rate_limited|disabled|outcome_unknown)\\b/", source)

    def test_card_defines_itself_in_home_assistants_registry(self) -> None:
        """Defining before HA's scoped registry exists hides the card from the loader."""
        source = CARD.read_text()
        self.assertIn('customElements.whenDefined("home-assistant").then(defineCard)', source)
        self.assertEqual(source.count("registry.define(CARD_TYPE, EufyLiveCard)"), 1)
        self.assertNotIn("customElements.define(CARD_TYPE", source)

    def test_manifest_declares_frontend(self) -> None:
        """Hassfest requires the frontend dependency for add_extra_js_url."""
        manifest = json.loads((INTEGRATION / "manifest.json").read_text())
        self.assertIn("frontend", manifest["dependencies"])
        self.assertIn("http", manifest["dependencies"])

    def test_card_is_served_once_with_a_content_hash(self) -> None:
        """Two entries or a reload reuse the first route and script URL."""
        module, registered, scripts = _load_live_card()
        hass = SimpleNamespace(data={}, http=SimpleNamespace(async_register_static_paths=None))
        routes: list[list[object]] = []

        async def register(paths: list[object]) -> None:
            routes.append(paths)

        async def executor(function, *args):
            return function(*args)

        hass.http.async_register_static_paths = register
        hass.async_add_executor_job = executor
        asyncio.run(module.async_register_live_card(hass))
        asyncio.run(module.async_register_live_card(hass))
        digest = hashlib.sha256(CARD.read_bytes()).hexdigest()[:12]
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0][0].args, ("/eufy_event_gateway/eufy-live-card.js", str(CARD), True))
        self.assertEqual(scripts, [(hass, f"/eufy_event_gateway/eufy-live-card.js?v={digest}")])
        self.assertIs(registered, module.StaticPathConfig)

    def test_card_failure_does_not_block_setup(self) -> None:
        """A route that cannot be added loses the card and nothing else."""
        module, _registered, scripts = _load_live_card()

        async def register(_paths: list[object]) -> None:
            raise RuntimeError("route exists")

        async def executor(function, *args):
            return function(*args)

        hass = SimpleNamespace(data={}, http=SimpleNamespace(async_register_static_paths=register), async_add_executor_job=executor)
        with self.assertLogs(module._LOGGER, "WARNING"):
            asyncio.run(module.async_register_live_card(hass))
        self.assertEqual(scripts, [])

    def test_setup_registers_the_card(self) -> None:
        """The entry setup serves the card before it waits for the gateway."""
        source = (INTEGRATION / "__init__.py").read_text()
        self.assertIn("from .live_card import async_register_live_card", source)
        setup = source.split("async def async_setup_entry", 1)[1]
        self.assertLess(setup.index("await async_register_live_card(hass)"), setup.index("async_config_entry_first_refresh"))


def _load_live_card() -> tuple[ModuleType, type, list[tuple[object, str]]]:
    """Load live_card.py against small stand-ins for the Home Assistant modules it imports."""
    scripts: list[tuple[object, str]] = []

    class StaticPathConfig:
        """Record the arguments Home Assistant would receive."""

        def __init__(self, *args: object) -> None:
            self.args = args

    frontend = ModuleType("homeassistant.components.frontend")
    frontend.add_extra_js_url = lambda hass, url: scripts.append((hass, url))
    http = ModuleType("homeassistant.components.http")
    http.StaticPathConfig = StaticPathConfig
    core = ModuleType("homeassistant.core")
    core.HomeAssistant = object
    package = ModuleType("custom_components.eufy_event_gateway")
    package.__path__ = []
    const = ModuleType("custom_components.eufy_event_gateway.const")
    const.DOMAIN = "eufy_event_gateway"
    modules = {
        "homeassistant": ModuleType("homeassistant"),
        "homeassistant.components": ModuleType("homeassistant.components"),
        "homeassistant.components.frontend": frontend,
        "homeassistant.components.http": http,
        "homeassistant.core": core,
        "custom_components": ModuleType("custom_components"),
        "custom_components.eufy_event_gateway": package,
        "custom_components.eufy_event_gateway.const": const,
    }
    previous = {name: sys.modules.get(name) for name in modules}
    sys.modules.update(modules)
    try:
        spec = importlib.util.spec_from_file_location("custom_components.eufy_event_gateway.live_card", INTEGRATION / "live_card.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value
    return module, StaticPathConfig, scripts


if __name__ == "__main__":
    unittest.main()
