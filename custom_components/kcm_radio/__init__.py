"""Kol Chai Music Radio — browse and play the kcm.fm "Music Volume" channels on any media player.

- media_source.py: Media → קול חי מיוזיק → category → station
- frontend/kcm-radio-card.js: a dashboard card (registered as a Lovelace resource automatically) that plays
  stations on one or more players
- websocket commands kcm_radio/stations and kcm_radio/nowplaying feed that card through HA itself
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.components.lovelace.resources import ResourceStorageCollection
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.loader import async_get_integration

from .api import KcmApi, KcmApiError
from .const import CONF_URL, DOMAIN

_LOGGER = logging.getLogger(__name__)

type KcmConfigEntry = ConfigEntry[KcmApi]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
CARD_URL = f"/{DOMAIN}/kcm-radio-card.js"
CARD_FILE = Path(__file__).parent / "frontend" / "kcm-radio-card.js"


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Register the dashboard card and its websocket API once, independent of config entries."""
    version = (await async_get_integration(hass, DOMAIN)).version
    await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL, str(CARD_FILE), cache_headers=False)])
    # ?v= busts the browser cache on every update
    await _async_ensure_card_resource(hass, f"{CARD_URL}?v={version}")
    websocket_api.async_register_command(hass, ws_stations)
    websocket_api.async_register_command(hass, ws_nowplaying)
    return True


async def _async_ensure_card_resource(hass: HomeAssistant, url: str) -> None:
    """Register the card as a Lovelace module resource (or bump its version).

    Not add_extra_js_url: extra modules run before the frontend swaps in its own customElements registry
    (HA 2026.8+), so a card defined there is invisible to dashboards and they hang on a spinner.
    Resources load after that, like every HACS card.
    """
    data = hass.data.get(LOVELACE_DATA)
    resources = data.resources if data else None
    if not isinstance(resources, ResourceStorageCollection):
        _LOGGER.warning("Dashboard resources are in YAML mode: add %s as a module resource by hand", CARD_URL)
        return
    await resources.async_get_info()  # loads the collection from storage
    for item in resources.async_items():
        if item["url"].split("?")[0] == CARD_URL:
            if item["url"] != url:
                await resources.async_update_item(item["id"], {"res_type": "module", "url": url})
            return
    await resources.async_create_item({"res_type": "module", "url": url})


async def async_remove_entry(hass: HomeAssistant, entry: KcmConfigEntry) -> None:
    """Removing the integration also removes the card resource it added."""
    data = hass.data.get(LOVELACE_DATA)
    resources = data.resources if data else None
    if not isinstance(resources, ResourceStorageCollection):
        return
    await resources.async_get_info()
    for item in list(resources.async_items()):
        if item["url"].split("?")[0] == CARD_URL:
            await resources.async_delete_item(item["id"])


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
