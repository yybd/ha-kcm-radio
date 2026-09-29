"""Config flow: one entry, asking only for the server address."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import KcmApi, KcmApiError
from .const import CONF_URL, DEFAULT_URL, DOMAIN


class KcmRadioConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            if not url.startswith(("http://", "https://")):
                url = f"https://{url}"
            try:
                await KcmApi(async_get_clientsession(self.hass), url).async_stats()
            except KcmApiError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(title="קול חי מיוזיק", data={CONF_URL: url})

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {vol.Required(CONF_URL, default=(user_input or {}).get(CONF_URL, DEFAULT_URL)): str}
            ),
            errors=errors,
        )
