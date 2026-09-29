"""Kol Chai Music Radio — browse and play the kcm.fm "Music Volume" channels on any media player."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import KcmApi, KcmApiError
from .const import CONF_URL

type KcmConfigEntry = ConfigEntry[KcmApi]


async def async_setup_entry(hass: HomeAssistant, entry: KcmConfigEntry) -> bool:
    """Set up the integration. Everything user-facing lives in media_source.py."""
    api = KcmApi(async_get_clientsession(hass), entry.data[CONF_URL])
    try:
        await api.async_stats()
    except KcmApiError as err:
        raise ConfigEntryNotReady(str(err)) from err
    entry.runtime_data = api
    return True


async def async_unload_entry(hass: HomeAssistant, entry: KcmConfigEntry) -> bool:
    return True
