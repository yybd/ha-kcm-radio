# Kol Chai Music Radio for Home Assistant

A Home Assistant integration that lists all the **"מיוזיק ווליום"** (Music Volume) channels of Kol Chai Music under
**Media**, and plays them on any available media player: Google Cast, Sonos, smart speakers, VLC and others.

The data comes from the [kcm-radio-browser](https://github.com/yybd/kcm-radio-browser) server (default:
`https://kcm.bd-tech.net`).

## What it shows

**Media → קול חי מיוזיק**:
- **סגנונות** (styles), **מצב רוח** (mood), **אמנים** (artists), **מיוחדים** (special): each category with its channels and artwork
- **כל התחנות** (all stations)

Pick a channel and a player, and it plays. Streams are direct MP3 (128 kbps), so every player supports them. Every play
is counted as a listen on the server (radio-browser `clickcount`).

You can also play from an automation:

```yaml
action: media_player.play_media
target:
  entity_id: media_player.living_room
data:
  media_content_id: media-source://kcm_radio/station/<stationuuid>
  media_content_type: music
```

(The `stationuuid` is visible in `https://kcm.bd-tech.net/json/stations`.)

## Installation

**Manual:** copy `custom_components/kcm_radio` into `config/custom_components/` on your HA (via Samba, SSH or
Studio Code Server), restart HA, then go to Settings → Devices & Services → Add Integration →
**Kol Chai Music Radio**.

**HACS** (Custom repository, type Integration): only works while the repo is public.

## Development

```bash
uv venv -p 3.14 .venv && uv pip install -p .venv/bin/python pytest-homeassistant-custom-component
.venv/bin/pytest -q
```
