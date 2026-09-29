from homeassistant.setup import async_setup_component

from custom_components.kcm_radio import CARD_URL


async def test_stations_ws(hass, hass_ws_client, setup_entry):
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "kcm_radio/stations"})
    msg = await client.receive_json()
    assert msg["success"]
    result = msg["result"]
    assert [c["slug"] for c in result["categories"]] == ["styles", "mood", "artists", "special"]
    ribo = next(s for s in result["stations"] if s["uuid"] == "s-ribo")
    assert ribo == {
        "uuid": "s-ribo",
        "title": "ישי ריבו",
        "category": "artists",
        "image": "https://kcm.example/images/s-ribo.jpg",
        "description": "",
        "nowplaying": "",
    }


async def test_nowplaying_ws_formats_and_drops_stale(hass, hass_ws_client, setup_entry):
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "kcm_radio/nowplaying"})
    msg = await client.receive_json()
    assert msg["result"] == {"s-ribo": "ישי ריבו – סיבת הסיבות", "s-live": ""}


async def test_ws_without_entry_errors(hass, hass_ws_client):
    assert await async_setup_component(hass, "kcm_radio", {})
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "kcm_radio/stations"})
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_set_up"


async def test_card_is_served(hass, hass_client, setup_entry):
    client = await hass_client()
    resp = await client.get(CARD_URL)
    assert resp.status == 200
    assert "customElements.define('kcm-radio-card'" in await resp.text()


async def test_brand_icon_is_served_locally(hass, hass_client, setup_entry):
    assert await async_setup_component(hass, "brands", {})
    client = await hass_client()
    for image in ("icon.png", "icon@2x.png", "logo.png", "dark_icon.png"):  # the last two fall back to icon.png
        resp = await client.get(f"/api/brands/integration/kcm_radio/{image}")
        assert resp.status == 200, image
        assert (await resp.read())[:8] == b"\x89PNG\r\n\x1a\n"


async def test_card_is_registered_as_a_lovelace_resource(hass, hass_ws_client, setup_entry):
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "lovelace/resources"})
    resources = (await client.receive_json())["result"]
    ours = [r for r in resources if r["url"].startswith(CARD_URL)]
    assert len(ours) == 1
    assert ours[0]["type"] == "module"
    assert ours[0]["url"].endswith("?v=0.3.1")


async def test_resource_version_is_bumped_not_duplicated(hass, hass_ws_client, kcm_server):
    from homeassistant.components.lovelace.const import LOVELACE_DATA

    assert await async_setup_component(hass, "lovelace", {})
    resources = hass.data[LOVELACE_DATA].resources
    await resources.async_get_info()
    await resources.async_create_item({"res_type": "module", "url": f"{CARD_URL}?v=0.0.1"})
    assert await async_setup_component(hass, "kcm_radio", {})
    urls = [r["url"] for r in resources.async_items() if r["url"].startswith(CARD_URL)]
    assert urls == [f"{CARD_URL}?v=0.3.1"]


async def test_removing_the_integration_removes_the_resource(hass, setup_entry):
    from homeassistant.components.lovelace.const import LOVELACE_DATA

    await hass.config_entries.async_remove(setup_entry.entry_id)
    await hass.async_block_till_done()
    resources = hass.data[LOVELACE_DATA].resources
    assert not [r for r in resources.async_items() if r["url"].startswith(CARD_URL)]
