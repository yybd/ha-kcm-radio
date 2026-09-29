import pytest
from homeassistant.components import media_source
from homeassistant.components.media_source import Unresolvable
from homeassistant.setup import async_setup_component

from custom_components.kcm_radio.const import DOMAIN

BASE = f"media-source://{DOMAIN}"


@pytest.fixture
async def ms(hass, setup_entry):
    assert await async_setup_component(hass, "media_source", {})
    await hass.async_block_till_done()


async def test_root_lists_nonempty_categories_and_all(hass, ms):
    root = await media_source.async_browse_media(hass, BASE)
    assert root.title == "קול חי מיוזיק"
    titles = [c.title for c in root.children]
    # empty categories hidden, "מיוחדים" (id 0) after the real ones, "all" last
    assert titles == ["סגנונות", "מצב רוח", "אמנים", "מיוחדים", "כל התחנות"]
    assert root.children[2].thumbnail == "https://kcm.example/images/s-ribo.jpg"


async def test_category_lists_its_stations(hass, ms):
    artists = await media_source.async_browse_media(hass, f"{BASE}/cat/artists")
    assert [c.title for c in artists.children] == ["ישי ריבו"]
    assert artists.children[0].can_play
    assert artists.children[0].media_content_id == f"{BASE}/station/s-ribo"


async def test_all_is_ordered_like_the_site(hass, ms):
    everything = await media_source.async_browse_media(hass, f"{BASE}/cat/all")
    assert [c.title for c in everything.children] == ["שידור חי", "פלייליסט אסם", "חזנות", "ישי ריבו"]  # kcm.fm order, then alphabetical


async def test_resolve_returns_the_direct_stream(hass, ms, kcm_server):
    played = await media_source.async_resolve_media(hass, f"{BASE}/station/s-ribo", None)
    assert played.url == "https://live.kcm.fm/39"
    assert played.mime_type == "audio/mpeg"
    assert any(str(call[1]).endswith("/json/url/s-ribo") for call in kcm_server.mock_calls)


async def test_unknown_station_and_category_are_unresolvable(hass, ms):
    with pytest.raises(Unresolvable):
        await media_source.async_resolve_media(hass, f"{BASE}/station/missing", None)
    with pytest.raises(Unresolvable):
        await media_source.async_browse_media(hass, f"{BASE}/cat/nope")
