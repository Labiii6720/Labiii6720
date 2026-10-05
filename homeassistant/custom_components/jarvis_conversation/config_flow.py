"""Einrichtung: Adresse von Jarvis und das Ereignis-Token."""
from __future__ import annotations

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_BUDGET, CONF_TOKEN, CONF_URL, DEFAULT_BUDGET, DOMAIN

SCHEMA = vol.Schema(
    {
        vol.Required(CONF_URL, default="http://192.168.1.50:3000"): str,
        vol.Required(CONF_TOKEN): str,
        vol.Optional(CONF_BUDGET, default=DEFAULT_BUDGET): int,
    }
)


class JarvisConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].rstrip("/")
            session = async_get_clientsession(self.hass)
            try:
                async with session.get(f"{url}/health", timeout=8) as res:
                    if res.status != 200:
                        errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                errors["base"] = "cannot_connect"
            if not errors:
                return self.async_create_entry(title="Jarvis", data={**user_input, CONF_URL: url})
        return self.async_show_form(step_id="user", data_schema=SCHEMA, errors=errors)
