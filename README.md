<p align="center">
  <img src="https://raw.githubusercontent.com/yybd/ha-kcm-radio/main/custom_components/kcm_radio/brand/icon@2x.png" width="120" alt="">
</p>

<h1 align="center">Kol Chai Music Radio for Home Assistant</h1>

<p align="center">
  All the <b>"Music Volume"</b> (מיוזיק ווליום) channels of <b>Kol Chai Music</b> (קול חי מיוזיק) inside Home Assistant.<br>
  Pick a channel and play it on any speaker in the house, or on several at once.
</p>

<p align="center">
  <a href="https://github.com/hacs/integration"><img src="https://img.shields.io/badge/HACS-Custom-41BDF5.svg" alt="HACS"></a>
  <a href="https://github.com/yybd/ha-kcm-radio/releases"><img src="https://img.shields.io/github/v/release/yybd/ha-kcm-radio" alt="Release"></a>
  <a href="https://github.com/yybd/ha-kcm-radio/actions/workflows/validate.yml"><img src="https://github.com/yybd/ha-kcm-radio/actions/workflows/validate.yml/badge.svg" alt="Validate"></a>
</p>

<p align="center"><img src="https://raw.githubusercontent.com/yybd/ha-kcm-radio/main/docs/card.jpg" width="720" alt="The Kol Chai Music card on a Home Assistant dashboard"></p>

## Features

- **Dashboard card.** Every channel, with its artwork and the song playing now (updated every 20 seconds).
  Category tabs (Styles, Mood, Artists, Special) and search by channel or song name.
- **Play on one or more players.** Pick speakers from the list (Google Cast, Sonos, Alexa Media, smart speakers and
  more). One tap starts the channel on all of them, with stop and volume controls for the selected players.
- **Media library.** Media (the side menu) → Kol Chai Music → category → channel.
- **Automations.** Start a channel in the morning, at candle lighting, when someone comes home, and so on.

About 85 channels, 128 kbps MP3 streams, so it works on almost any player.

## Installation

### 1. Install via HACS (recommended)

Click the button to add the repository to HACS:

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=yybd&repository=ha-kcm-radio&category=integration)

Or by hand: HACS → ⋮ (top right) → **Custom repositories** → paste
`https://github.com/yybd/ha-kcm-radio`, choose **Integration** → **Add**.

Then search for **Kol Chai Music Radio** in HACS → **Download** → **restart Home Assistant**.

<details>
<summary>Manual installation without HACS</summary>

Copy the `custom_components/kcm_radio` folder into the `config/custom_components/` folder of your Home Assistant
(using the Samba, SSH or Studio Code Server add-on), then restart Home Assistant.
</details>

### 2. Add the integration

[![Open your Home Assistant instance and start setting up a new integration.](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=kcm_radio)

Or: **Settings** → **Devices & services** → **Add integration** → search for **Kol Chai Music Radio**.

The only field is the server address. The default, `https://kcm.bd-tech.net`, is correct: just click **Submit**.

### 3. Add the card to a dashboard

Edit a dashboard → **Add card** → search for **קול חי מיוזיק**. Or in YAML:

```yaml
type: custom:kcm-radio-card
```

Tip: the card looks best in a view of type **Panel** (a single card across the whole width).

The card is loaded automatically by the integration. You don't need to add a resource.

## Card options

| Option | Default | Description |
|---|---|---|
| `title` | `קול חי מיוזיק` | Card title |
| `entities` | all available players | Limit the player list to these players |

```yaml
type: custom:kcm-radio-card
title: מוזיקה בבית
entities:
  - media_player.living_room
  - media_player.kitchen
```

The players you selected are remembered per device (browser/phone).

## Playing from an automation

Every channel has a fixed ID. The easiest way to get the full address is from **Media** → pick the channel → in the
automation editor, choose the action **Media player: Play media** and pick the channel from the list. Or write it
by hand:

```yaml
action: media_player.play_media
target:
  entity_id:
    - media_player.living_room
    - media_player.kitchen
data:
  media_content_id: media-source://kcm_radio/station/<stationuuid>
  media_content_type: music
```

The full list of channels with their IDs:
[kcm.bd-tech.net/json/stations](https://kcm.bd-tech.net/json/stations) (the `stationuuid` field).

## FAQ

**The card doesn't show up in the card list.** Refresh the browser (Ctrl+Shift+R) after installing and restarting.
In the mobile app: Settings → Companion app → Debugging → Reset frontend cache.

**A particular player won't play.** Check that it supports streaming radio from a URL (most do). Players that are
`unavailable` don't show in the list.

**Where does the data come from?** From the [kcm-radio-browser](https://github.com/yybd/kcm-radio-browser) server,
which mirrors the Kol Chai Music channels in the format of radio-browser.info and updates every 15 seconds. The
audio comes directly from Kol Chai Music.

## Development

```bash
uv venv -p 3.14 .venv
uv pip install -p .venv/bin/python pytest-homeassistant-custom-component home-assistant-frontend
.venv/bin/pytest -q
```

To look at the card without Home Assistant: `python3 -m http.server 8765` and open
`http://localhost:8765/dev/card-preview.html` (it uses a mock HA with fake players; service calls are only printed).

---

This is not an official Kol Chai Music product. The broadcasts and all rights belong to Kol Chai Music.
