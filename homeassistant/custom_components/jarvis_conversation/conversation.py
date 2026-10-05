"""Gesprächs-Agent: reicht den erkannten Satz an Jarvis (/events, frage_sync) weiter und spricht die Antwort."""
from __future__ import annotations

import logging

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_BUDGET, CONF_TOKEN, CONF_URL, DEFAULT_BUDGET

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([JarvisAgent(entry)])


class JarvisAgent(conversation.ConversationEntity):
    _attr_has_entity_name = True
    _attr_name = "Jarvis"
    _attr_supported_languages = MATCH_ALL

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = entry.entry_id

    async def async_process(self, user_input: conversation.ConversationInput) -> conversation.ConversationResult:
        url = self._entry.data[CONF_URL]
        token = self._entry.data[CONF_TOKEN]
        budget = int(self._entry.data.get(CONF_BUDGET, DEFAULT_BUDGET))
        session = async_get_clientsession(self.hass)
        response = intent.IntentResponse(language=user_input.language)
        try:
            async with session.post(
                f"{url}/events",
                json={"event": "frage_sync", "text": user_input.text, "kanal": "stimme", "budget": budget},
                headers={"Authorization": f"Bearer {token}"},
                timeout=budget / 1000 + 10,
            ) as res:
                data = await res.json()
            if res.status != 200 or not data.get("ok"):
                raise RuntimeError(data.get("error", f"HTTP {res.status}"))
            response.async_set_speech(str(data.get("reply", "")))
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Jarvis nicht erreichbar: %s", err)
            response.async_set_error(intent.IntentResponseErrorCode.UNKNOWN, "Jarvis ist gerade nicht erreichbar.")
        return conversation.ConversationResult(response=response, conversation_id=user_input.conversation_id)
