"""Client for the kcm-radio-browser server (radio-browser compatible API + KCM extensions)."""

from __future__ import annotations

import time
from typing import Any

import aiohttp

from .const import STATIONS_CACHE_SECONDS

TIMEOUT = aiohttp.ClientTimeout(total=15)


class KcmApiError(Exception):
    """The server could not be reached or answered with an error."""


class KcmApi:
    """Thin async client. Station list and categories are cached for a few minutes."""

    def __init__(self, session: aiohttp.ClientSession, base_url: str) -> None:
        self._session = session
        self.base_url = base_url.rstrip("/")
        self._stations: list[dict[str, Any]] | None = None
        self._categories: list[dict[str, Any]] | None = None
        self._fetched_at = 0.0

    async def _get(self, path: str) -> Any:
        try:
            async with self._session.get(f"{self.base_url}{path}", timeout=TIMEOUT) as resp:
                resp.raise_for_status()
                return await resp.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise KcmApiError(f"{path}: {err}") from err

    async def async_stats(self) -> dict[str, Any]:
        """Server statistics — also used to validate the URL in the config flow."""
        stats = await self._get("/json/stats")
        if not isinstance(stats, dict) or "stations" not in stats:
            raise KcmApiError("not a kcm-radio-browser server")
        return stats

    async def _refresh(self) -> None:
        if self._stations is not None and time.monotonic() - self._fetched_at < STATIONS_CACHE_SECONDS:
            return
        stations = await self._get("/json/kcm/stations")
        categories = await self._get("/json/kcm/categories")
        # Same order as the web player: kcm.fm's own order, then Hebrew name
        stations.sort(key=lambda s: (-(s["kcm"].get("order") or 0), s["kcm"]["title"]))
        self._stations = stations
        # styles, mood, artists … and the catch-all "special" (id 0) last
        self._categories = sorted(
            (c for c in categories if c.get("stationcount")), key=lambda c: (c.get("id") == 0, c.get("id"))
        )
        self._fetched_at = time.monotonic()

    async def async_stations(self) -> list[dict[str, Any]]:
        await self._refresh()
        return self._stations or []

    async def async_categories(self) -> list[dict[str, Any]]:
        await self._refresh()
        return self._categories or []

    async def async_station(self, uuid: str) -> dict[str, Any] | None:
        return next((s for s in await self.async_stations() if s["stationuuid"] == uuid), None)

    async def async_resolve(self, uuid: str) -> dict[str, Any]:
        """radio-browser /json/url/{uuid}: counts a listen and returns the stream URL."""
        data = await self._get(f"/json/url/{uuid}")
        if not data.get("ok") or not data.get("url"):
            raise KcmApiError(data.get("message") or "station not found")
        return data
