"""Media source: Media → קול חי מיוזיק → category → station, playable on any media player.

Identifiers:
    ""                 root (categories + "all stations")
    "cat/<slug>"       stations of one category ("all" = every station)
    "station/<uuid>"   a playable station
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.media_player import MediaClass, MediaType
from homeassistant.components.media_source import (
    BrowseMediaSource,
    MediaSource,
    MediaSourceItem,
    PlayMedia,
    Unresolvable,
)
from homeassistant.core import HomeAssistant

from .api import KcmApi, KcmApiError
from .const import DOMAIN

ROOT_TITLE = "קול חי מיוזיק"
ALL_SLUG = "all"
ALL_TITLE = "כל התחנות"


async def async_get_media_source(hass: HomeAssistant) -> KcmMediaSource:
    return KcmMediaSource(hass)


class KcmMediaSource(MediaSource):
    name = ROOT_TITLE

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(DOMAIN)
        self.hass = hass

    def _api(self) -> KcmApi:
        entries = self.hass.config_entries.async_loaded_entries(DOMAIN)
        if not entries:
            raise Unresolvable("Kol Chai Music Radio is not set up")
        return entries[0].runtime_data

    # ------------------------------------------------------------------ play

    async def async_resolve_media(self, item: MediaSourceItem) -> PlayMedia:
        kind, _, uuid = (item.identifier or "").partition("/")
        if kind != "station" or not uuid:
            raise Unresolvable(f"Not a station: {item.identifier}")
        try:
            data = await self._api().async_resolve(uuid)
        except KcmApiError as err:
            raise Unresolvable(str(err)) from err
        # url is the direct MP3 stream (url_resolved) — plays on Cast, Sonos, VLC, etc.
        return PlayMedia(data["url"], "audio/mpeg")

    # ------------------------------------------------------------------ browse

    async def async_browse_media(self, item: MediaSourceItem) -> BrowseMediaSource:
        api = self._api()
        kind, _, arg = (item.identifier or "").partition("/")
        try:
            if not item.identifier:
                return await self._root(api)
            if kind == "cat":
                return await self._category(api, arg)
        except KcmApiError as err:
            raise Unresolvable(str(err)) from err
        raise Unresolvable(f"Unknown item: {item.identifier}")

    async def _root(self, api: KcmApi) -> BrowseMediaSource:
        stations = await api.async_stations()
        folders = [
            self._folder(c["slug"], c["name"], self._first_image(stations, c["slug"]))
            for c in await api.async_categories()
        ]
        folders.append(self._folder(ALL_SLUG, ALL_TITLE, None))
        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=None,
            media_class=MediaClass.DIRECTORY,
            media_content_type=MediaType.MUSIC,
            title=ROOT_TITLE,
            can_play=False,
            can_expand=True,
            children=folders,
            children_media_class=MediaClass.DIRECTORY,
        )

    async def _category(self, api: KcmApi, slug: str) -> BrowseMediaSource:
        stations = await api.async_stations()
        if slug == ALL_SLUG:
            title = ALL_TITLE
        else:
            cats = {c["slug"]: c["name"] for c in await api.async_categories()}
            if slug not in cats:
                raise Unresolvable(f"Unknown category: {slug}")
            title = cats[slug]
            stations = [s for s in stations if s["kcm"]["category"]["slug"] == slug]
        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=f"cat/{slug}",
            media_class=MediaClass.DIRECTORY,
            media_content_type=MediaType.MUSIC,
            title=title,
            can_play=False,
            can_expand=True,
            children=[self._station(s) for s in stations],
            children_media_class=MediaClass.CHANNEL,
        )

    @staticmethod
    def _first_image(stations: list[dict[str, Any]], slug: str) -> str | None:
        return next((s["favicon"] for s in stations if s["kcm"]["category"]["slug"] == slug and s["favicon"]), None)

    @staticmethod
    def _folder(slug: str, title: str, thumbnail: str | None) -> BrowseMediaSource:
        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=f"cat/{slug}",
            media_class=MediaClass.DIRECTORY,
            media_content_type=MediaType.MUSIC,
            title=title,
            can_play=False,
            can_expand=True,
            thumbnail=thumbnail,
        )

    @staticmethod
    def _station(station: dict[str, Any]) -> BrowseMediaSource:
        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=f"station/{station['stationuuid']}",
            media_class=MediaClass.CHANNEL,
            media_content_type=MediaType.MUSIC,
            title=station["kcm"]["title"] or station["name"],
            can_play=True,
            can_expand=False,
            thumbnail=station["favicon"] or None,
        )
