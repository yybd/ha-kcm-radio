"""Fixtures: a fake kcm-radio-browser server answering the endpoints the integration uses."""

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kcm_radio.const import CONF_URL, DOMAIN

URL = "https://kcm.example"


def _station(uuid, title, slug, cat_name, order=10):
    return {
        "stationuuid": uuid,
        "name": f"קול חי מיוזיק - {title}",
        "url_resolved": f"https://live.kcm.fm/{uuid}",
        "favicon": f"{URL}/images/{uuid}.jpg",
        "kcm": {"title": title, "order": order, "category": {"slug": slug, "name": cat_name}},
    }


STATIONS = [
    _station("s-ribo", "ישי ריבו", "artists", "אמנים"),
    _station("s-live", "שידור חי", "mood", "מצב רוח", order=3000),
    _station("s-chazanut", "חזנות", "styles", "סגנונות"),
    _station("s-osem", "פלייליסט אסם", "special", "מיוחדים", order=14),
]
CATEGORIES = [
    {"id": 0, "slug": "special", "name": "מיוחדים", "stationcount": 1},
    {"id": 5, "slug": "torah", "name": "שיעורי תורה", "stationcount": 0},
    {"id": 1, "slug": "styles", "name": "סגנונות", "stationcount": 1},
    {"id": 2, "slug": "mood", "name": "מצב רוח", "stationcount": 1},
    {"id": 3, "slug": "artists", "name": "אמנים", "stationcount": 1},
]


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture
def kcm_server(aioclient_mock):
    aioclient_mock.get(f"{URL}/json/stats", json={"supported_version": 1, "stations": 3})
    aioclient_mock.get(f"{URL}/json/kcm/stations", json=STATIONS)
    aioclient_mock.get(f"{URL}/json/kcm/categories", json=CATEGORIES)
    aioclient_mock.get(
        f"{URL}/json/url/s-ribo",
        json={"ok": True, "stationuuid": "s-ribo", "url": "https://live.kcm.fm/39"},
    )
    aioclient_mock.get(f"{URL}/json/url/missing", json={"ok": False, "message": "did not find station"})
    aioclient_mock.get(
        f"{URL}/json/kcm/nowplaying",
        json=[
            {"stationuuid": "s-ribo", "raw": "ישי ריבו - סיבת הסיבות", "artist": "ישי ריבו", "title": "סיבת הסיבות", "stale": False},
            {"stationuuid": "s-live", "raw": "old", "artist": "", "title": "old", "stale": True},
        ],
    )
    return aioclient_mock


@pytest.fixture
async def setup_entry(hass, kcm_server):
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: URL}, title="קול חי מיוזיק")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
