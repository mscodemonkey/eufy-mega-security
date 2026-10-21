"""Home Assistant config flow for Eufy Mega Security.

The flow validates the local gateway before saving an entry. Supervisor
discovery supplies private app connection details without making the user copy
an internal hostname or token, while manual setup accepts a deliberately
exposed gateway URL and optional API token. The flow never asks for Eufy
credentials because those belong to the gateway app.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.config_entries import ConfigFlowResult
from homeassistant.const import CONF_URL
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .client import GatewayAuthenticationError, GatewayClient, GatewayClientError
from .const import CONF_API_TOKEN, CONF_SHORT_HLS_IDLE, CONF_NATIVE_VIDEO, DOMAIN


class EufyGatewayConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Own setup and reconfiguration for one local gateway connection.

    The flow performs a read-only inventory request before persisting details,
    deduplicates manual entries by URL, and lets Supervisor discovery update the
    existing entry. Saved credentials authenticate only to the local gateway.
    """

    VERSION = 1
    _discovered_data: dict[str, Any] | None = None

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> EufyGatewayOptionsFlow:
        """Create entry options without copying private connection settings."""
        return EufyGatewayOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Validate manual URL/token input and save a config entry."""
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].rstrip("/")
            client = GatewayClient(
                async_get_clientsession(self.hass),
                url,
                user_input.get(CONF_API_TOKEN, ""),
            )
            try:
                await client.cameras()
            except GatewayAuthenticationError:
                errors["base"] = "invalid_auth"
            except GatewayClientError:
                errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(url.lower())
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title="Eufy Mega Security", data={**user_input, CONF_URL: url}
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_schema(user_input),
            errors=errors,
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Validate new connection details and reload the existing entry."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].rstrip("/")
            client = GatewayClient(
                async_get_clientsession(self.hass),
                url,
                user_input.get(CONF_API_TOKEN, ""),
            )
            try:
                await client.cameras()
            except GatewayAuthenticationError:
                errors["base"] = "invalid_auth"
            except GatewayClientError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(
                    entry,
                    data_updates={**user_input, CONF_URL: url},
                )

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_schema(user_input or dict(entry.data)),
            errors=errors,
        )

    async def async_step_hassio(
        self, discovery_info: HassioServiceInfo
    ) -> ConfigFlowResult:
        """Accept add-on discovery data and validate it before linking the entry."""
        config = discovery_info.config
        host = config.get("host")
        port = config.get("port")
        api_token = config.get(CONF_API_TOKEN)
        if (
            not isinstance(host, str)
            or not isinstance(port, int)
            or not isinstance(api_token, str)
        ):
            return self.async_abort(reason="invalid_discovery")

        data = {CONF_URL: f"http://{host}:{port}", CONF_API_TOKEN: api_token}
        client = GatewayClient(
            async_get_clientsession(self.hass), data[CONF_URL], api_token
        )
        try:
            await client.cameras()
        except GatewayClientError:
            return self.async_abort(reason="cannot_connect")

        entries = self._async_current_entries(include_ignore=False)
        if entries:
            entry = entries[0]
            self.hass.config_entries.async_update_entry(entry, unique_id=DOMAIN)
            return self.async_update_reload_and_abort(
                entry,
                data_updates=data,
                reason="hassio_connected",
            )

        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured(updates=data)
        self._discovered_data = data
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask the user to confirm a newly discovered gateway connection."""
        if user_input is not None:
            assert self._discovered_data is not None
            return self.async_create_entry(
                title="Eufy Mega Security", data=self._discovered_data
            )
        return self.async_show_form(step_id="hassio_confirm")


def _schema(defaults: dict[str, Any] | None) -> vol.Schema:
    """Build the connection form with current values when available."""
    values = defaults or {}
    return vol.Schema(
        {
            vol.Required(
                CONF_URL, default=values.get(CONF_URL, "http://127.0.0.1:3218")
            ): str,
            vol.Optional(
                CONF_API_TOKEN, default=values.get(CONF_API_TOKEN, "")
            ): TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD)),
        }
    )


class EufyGatewayOptionsFlow(config_entries.OptionsFlowWithReload):
    """Own opt-in playback options and reload cameras when they change.

    Home Assistant supplies the entry and persists options separately from
    private connection data. Reloading releases the old camera streams.
    """

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Offer reversible playback trials and reload the selected camera profiles."""
        if user_input is not None:
            return self.async_create_entry(
                title="", data={**self.config_entry.options, **user_input}
            )
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Optional(
                    CONF_NATIVE_VIDEO,
                    default=self.config_entry.options.get(CONF_NATIVE_VIDEO, False),
                ): bool,
                vol.Optional(
                    CONF_SHORT_HLS_IDLE,
                    default=self.config_entry.options.get(CONF_SHORT_HLS_IDLE, False),
                ): bool,
            }),
        )
