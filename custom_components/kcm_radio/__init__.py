"""Kol Chai Music Radio — browse and play the kcm.fm "Music Volume" channels on any media player.

- media_source.py: Media → קול חי מיוזיק → category → station
- frontend/kcm-radio-card.js: a dashboard card (loaded automatically) that plays stations on one or more players
- websocket commands kcm_radio/stations and kcm_radio/nowplaying feed that card through HA itself
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.loader import async_get_integration

from .api import KcmApi, KcmApiError
from .const import CONF_URL, DOMAIN

type KcmConfigEntry = ConfigEntry[KcmApi]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
CARD_URL = f"/{DOMAIN}/kcm-radio-card.js"
CARD_FILE = Path(__file__).parent / "frontend" / "kcm-radio-card.js"


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Register the dashboard card and its websocket API once, independent of config entries."""
    version = (await async_get_integration(hass, DOMAIN)).version
    await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL, str(CARD_FILE), cache_headers=False)])
    # ?v= busts the browser cache on every update
    add_extra_js_url(hass, f"{CARD_URL}?v={version}")
    websocket_api.async_register_command(hass, ws_stations)
    websocket_api.async_register_command(hass, ws_nowplaying)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: KcmConfigEntry) -> bool:
    api = KcmApi(async_get_clientsession(hass), entry.data[CONF_URL])
    try:
        await api.async_stats()
    except KcmApiError as err:
        raise ConfigEntryNotReady(str(err)) from err
    entry.runtime_data = api
    return True


async def async_unload_entry(hass: HomeAssistant, entry: KcmConfigEntry) -> bool:
    return True


@callback
def _api(hass: HomeAssistant) -> KcmApi | None:
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    return entries[0].runtime_data if entries else None


@websocket_api.websocket_command({vol.Required("type"): "kcm_radio/stations"})
@websocket_api.async_response
async def ws_stations(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Stations + categories for the card, trimmed to what it displays."""
    api = _api(hass)
    if api is None:
        connection.send_error(msg["id"], "not_set_up", "Kol Chai Music Radio is not set up")
        return
    try:
        stations = await api.async_stations()
        categories = await api.async_categories()
    except KcmApiError as err:
        connection.send_error(msg["id"], "unavailable", str(err))
        return
    connection.send_result(
        msg["id"],
        {
            "categories": [{"slug": c["slug"], "name": c["name"]} for c in categories],
            "stations": [
                {
                    "uuid": s["stationuuid"],
                    "title": s["kcm"]["title"] or s["name"],
                    "category": s["kcm"]["category"]["slug"],
                    "image": s["favicon"],
                    "description": s["kcm"].get("description") or "",
                    "nowplaying": _song(s["kcm"].get("nowplaying")),
                }
                for s in stations
            ],
        },
    )


@websocket_api.websocket_command({vol.Required("type"): "kcm_radio/nowplaying"})
@websocket_api.async_response
async def ws_nowplaying(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """{stationuuid: "artist – title"} for every station, refreshed by the card every ~20s."""
    api = _api(hass)
    if api is None:
        connection.send_error(msg["id"], "not_set_up", "Kol Chai Music Radio is not set up")
        return
    try:
        items = await api.async_nowplaying()
    except KcmApiError as err:
        connection.send_error(msg["id"], "unavailable", str(err))
        return
    connection.send_result(msg["id"], {n["stationuuid"]: _song(n) for n in items})


def _song(np: dict[str, Any] | None) -> str:
    if not np or np.get("stale") or not np.get("raw"):
        return ""
    if np.get("artist") and np.get("title"):
        return f"{np['artist']} – {np['title']}"
    return np["raw"]
