from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType

from custom_components.kcm_radio.const import CONF_URL, DOMAIN

from .conftest import URL


async def test_user_flow_creates_entry(hass, kcm_server):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_URL: URL + "/"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_URL: URL}


async def test_bare_host_gets_https(hass, kcm_server):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_URL: "kcm.example"})
    assert result["data"] == {CONF_URL: URL}


async def test_unreachable_server_shows_error(hass, aioclient_mock):
    aioclient_mock.get("https://down.example/json/stats", status=502)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_URL: "https://down.example"})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}
