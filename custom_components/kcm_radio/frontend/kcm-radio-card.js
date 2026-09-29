/*
 * קול חי מיוזיק — dashboard card.
 * Pick one or more media players, tap a station, it plays on all of them.
 *
 *   type: custom:kcm-radio-card
 *   title: קול חי מיוזיק        # optional
 *   entities:                    # optional: limit the player list
 *     - media_player.living_room
 *
 * Data comes from the kcm_radio integration over HA's own websocket (kcm_radio/stations,
 * kcm_radio/nowplaying), so it works wherever the dashboard works, including remote access.
 */

const STORAGE_KEY = 'kcm-radio-card.players';
const NOWPLAYING_EVERY_MS = 20000;
const HIDDEN_STATES = new Set(['unavailable', 'unknown']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const load = (key, def) => { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } };
const save = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ } };

class KcmRadioCard extends HTMLElement {
  static getStubConfig() {
    return {};
  }

  constructor() {
    super();
    this._tab = 'all';
    this._query = '';
    this._playing = new Map(); // entity_id -> station uuid (what this card last started there)
    this._stations = null;
  }

  // HA calls setConfig more than once (card creation, editor, config changes): keep the DOM and state,
  // only apply the new options.
  setConfig(config) {
    this._config = { title: 'קול חי מיוזיק', ...config };
    if (!this._selected) this._selected = new Set(load(STORAGE_KEY, config.entities?.slice(0, 1) || []));
    if (!this._root) this._build();
    this._root.querySelector('h2').textContent = this._config.title;
    this._playersKey = this._controlsKey = null; // `entities` may have changed
    if (this._hass) {
      this._renderPlayers();
      this._renderControls();
    }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._root) return; // setConfig always comes first; nothing to draw into yet
    if (first) this._loadStations();
    this._renderPlayers();
    this._renderControls();
  }

  getCardSize() {
    return 12;
  }

  connectedCallback() {
    this._timer = setInterval(() => this._refreshNowPlaying(), NOWPLAYING_EVERY_MS);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  // ------------------------------------------------------------------ data

  async _loadStations() {
    try {
      const data = await this._hass.callWS({ type: 'kcm_radio/stations' });
      this._stations = data.stations;
      this._categories = data.categories;
      this._error = null;
    } catch (err) {
      this._error = err.message || String(err);
    }
    this._renderTabs();
    this._renderGrid();
  }

  async _refreshNowPlaying() {
    if (!this._hass || !this._stations || document.hidden) return;
    try {
      const np = await this._hass.callWS({ type: 'kcm_radio/nowplaying' });
      for (const s of this._stations) {
        if (!(s.uuid in np) || np[s.uuid] === s.nowplaying) continue;
        s.nowplaying = np[s.uuid];
        const el = this._root.querySelector(`.tile[data-uuid="${s.uuid}"] .np`);
        if (el) el.textContent = s.nowplaying || s.description;
      }
    } catch {
      /* next round */
    }
  }

  _players() {
    const allowed = this._config.entities;
    return Object.values(this._hass.states)
      .filter((st) => st.entity_id.startsWith('media_player.') && !HIDDEN_STATES.has(st.state))
      .filter((st) => !allowed || allowed.includes(st.entity_id))
      .sort((a, b) => (a.attributes.friendly_name || a.entity_id).localeCompare(b.attributes.friendly_name || b.entity_id, 'he'));
  }

  // ------------------------------------------------------------------ actions

  async _play(uuid) {
    const targets = [...this._selected].filter((id) => this._hass.states[id]);
    if (!targets.length) {
      this._toast('בחרו קודם נגן אחד או יותר');
      this._root.querySelector('.players').classList.add('attention');
      setTimeout(() => this._root.querySelector('.players').classList.remove('attention'), 1200);
      return;
    }
    const station = this._stations.find((s) => s.uuid === uuid);
    try {
      await this._hass.callService('media_player', 'play_media', {
        entity_id: targets,
        media_content_id: `media-source://kcm_radio/station/${uuid}`,
        media_content_type: 'music',
      });
      targets.forEach((id) => this._playing.set(id, uuid));
      this._toast(`${station.title} ← ${targets.map((id) => this._name(id)).join(', ')}`);
    } catch (err) {
      this._toast(`שגיאה: ${err.message || err}`);
    }
    this._renderGrid();
  }

  async _stop() {
    const targets = [...this._selected].filter((id) => this._hass.states[id]);
    if (!targets.length) return;
    await this._hass.callService('media_player', 'media_stop', { entity_id: targets }).catch(() => {});
    targets.forEach((id) => this._playing.delete(id));
    this._renderGrid();
  }

  _setVolume(value) {
    const targets = [...this._selected].filter((id) => this._hass.states[id]?.attributes.volume_level !== undefined);
    if (targets.length) this._hass.callService('media_player', 'volume_set', { entity_id: targets, volume_level: value });
  }

  _name(id) {
    return this._hass.states[id]?.attributes.friendly_name || id;
  }

  _toast(text) {
    const el = this._root.querySelector('.toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ------------------------------------------------------------------ rendering

  _build() {
    this._root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    this._root.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="wrap" dir="rtl">
          <div class="head">
            <div class="brand"><span class="mark">${EQ_ICON}</span><h2></h2></div>
            <input class="search" type="search" placeholder="חיפוש ערוץ או שיר…">
          </div>
          <div class="section-label">לנגן ב:</div>
          <div class="players"></div>
          <div class="controls"></div>
          <div class="tabs"></div>
          <div class="grid"><div class="empty">טוען ערוצים…</div></div>
          <div class="toast" role="status"></div>
        </div>
      </ha-card>`;

    this._root.querySelector('.search').addEventListener('input', (e) => {
      this._query = e.target.value.trim().toLowerCase();
      this._renderGrid();
    });
    this._root.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      this._tab = b.dataset.tab;
      this._renderTabs();
      this._renderGrid();
    });
    this._root.querySelector('.players').addEventListener('click', (e) => {
      const b = e.target.closest('[data-entity]');
      if (!b) return;
      const id = b.dataset.entity;
      this._selected.has(id) ? this._selected.delete(id) : this._selected.add(id);
      save(STORAGE_KEY, [...this._selected]);
      this._renderPlayers();
      this._renderControls();
    });
    this._root.querySelector('.grid').addEventListener('click', (e) => {
      const t = e.target.closest('.tile');
      if (t) this._play(t.dataset.uuid);
    });
    this._root.querySelector('.controls').addEventListener('click', (e) => {
      if (e.target.closest('.stop')) this._stop();
    });
    this._root.querySelector('.controls').addEventListener('change', (e) => {
      if (e.target.classList.contains('volume')) this._setVolume(Number(e.target.value));
    });
  }

  _renderPlayers() {
    const players = this._players();
    const key = players.map((p) => `${p.entity_id}:${p.state}:${this._selected.has(p.entity_id)}`).join('|');
    if (key === this._playersKey) return; // hass updates constantly; only touch the DOM on real changes
    this._playersKey = key;
    const box = this._root.querySelector('.players');
    box.innerHTML = players.length
      ? players
          .map((p) => {
            const on = this._selected.has(p.entity_id);
            const busy = p.state === 'playing';
            return `<button class="chip${on ? ' on' : ''}" data-entity="${esc(p.entity_id)}" title="${esc(p.entity_id)}">
              ${on ? CHECK_ICON : SPEAKER_ICON}<span>${esc(p.attributes.friendly_name || p.entity_id)}</span>${busy ? '<i class="dot"></i>' : ''}
            </button>`;
          })
          .join('')
      : '<span class="muted">לא נמצאו נגנים זמינים ב-Home Assistant</span>';
  }

  _renderControls() {
    const targets = [...this._selected].map((id) => this._hass.states[id]).filter(Boolean);
    const vols = targets.map((t) => t.attributes.volume_level).filter((v) => typeof v === 'number');
    const key = `${targets.map((t) => t.entity_id).join()}|${vols.join()}`;
    if (key === this._controlsKey) return;
    const box = this._root.querySelector('.controls');
    const slider = box.querySelector('.volume');
    if (slider && slider === this._root.activeElement) return; // don't yank the slider while the user drags it
    this._controlsKey = key;
    if (!targets.length) {
      box.innerHTML = '';
      return;
    }
    const avg = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
    box.innerHTML = `
      <button class="stop" title="עצירה">${STOP_ICON}<span>עצירה</span></button>
      ${avg === null ? '' : `<label class="vol">${VOLUME_ICON}<input class="volume" type="range" min="0" max="1" step="0.02" value="${avg}" aria-label="עוצמה"></label>`}
      <span class="muted">${targets.length === 1 ? esc(this._name(targets[0].entity_id)) : `${targets.length} נגנים`}</span>`;
  }

  _renderTabs() {
    const cats = this._categories || [];
    const tabs = [{ slug: 'all', name: 'הכל' }, ...cats];
    this._root.querySelector('.tabs').innerHTML = tabs
      .map((c) => `<button class="tab${c.slug === this._tab ? ' on' : ''}" data-tab="${esc(c.slug)}">${esc(c.name)}</button>`)
      .join('');
  }

  _renderGrid() {
    const grid = this._root.querySelector('.grid');
    if (this._error) {
      grid.innerHTML = `<div class="empty">שגיאה בטעינת הערוצים: ${esc(this._error)}</div>`;
      return;
    }
    if (!this._stations) return;
    const q = this._query;
    const list = this._stations.filter(
      (s) =>
        (this._tab === 'all' || s.category === this._tab) &&
        (!q || `${s.title} ${s.nowplaying} ${s.description}`.toLowerCase().includes(q)),
    );
    const playingOn = new Map();
    for (const [id, uuid] of this._playing) {
      if (this._hass.states[id]?.state !== 'playing') continue;
      playingOn.set(uuid, [...(playingOn.get(uuid) || []), this._name(id)]);
    }
    grid.innerHTML = list.length
      ? list
          .map((s) => {
            const on = playingOn.get(s.uuid);
            return `<button class="tile${on ? ' active' : ''}" data-uuid="${s.uuid}">
              <img src="${esc(s.image)}" alt="" loading="lazy">
              ${on ? `<span class="badge">${EQ_ICON}${esc(on.join(', '))}</span>` : ''}
              <span class="title">${esc(s.title)}</span>
              <span class="np">${esc(s.nowplaying || s.description)}</span>
            </button>`;
          })
          .join('')
      : '<div class="empty">לא נמצאו ערוצים</div>';
  }
}

const EQ_ICON = '<svg viewBox="0 0 24 24"><path d="M4 14v-4M8 17V7M12 20V4M16 17V7M20 14v-4"/></svg>';
const SPEAKER_ICON = '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="14" r="3"/><path d="M12 7h.01"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const VOLUME_ICON = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>';

const STYLE = `
  :host { --kcm-accent: #fec409; --kcm-accent-ink: #1a1400; }
  .wrap { padding: 16px; position: relative; }
  svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  button { font: inherit; color: inherit; cursor: pointer; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .mark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--kcm-accent); color: var(--kcm-accent-ink); }
  h2 { margin: 0; font-size: 20px; font-weight: 700; }
  .search { flex: 1 1 200px; max-width: 320px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--divider-color);
    background: var(--secondary-background-color); color: var(--primary-text-color); font: inherit; outline: none; }
  .search:focus { border-color: var(--kcm-accent); }
  .section-label { font-size: 13px; color: var(--secondary-text-color); margin-bottom: 6px; }
  .players { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; padding: 2px; border-radius: 12px; transition: box-shadow .2s; }
  .players.attention { box-shadow: 0 0 0 2px var(--kcm-accent); }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; font-size: 14px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color); }
  .chip.on { background: var(--kcm-accent); border-color: var(--kcm-accent); color: var(--kcm-accent-ink); font-weight: 600; }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success-color, #43a047); }
  .controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .controls:empty { display: none; }
  .stop { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--divider-color); background: none; }
  .vol { display: inline-flex; align-items: center; gap: 6px; color: var(--secondary-text-color); }
  .volume { width: 140px; accent-color: var(--kcm-accent); }
  .muted { color: var(--secondary-text-color); font-size: 13px; }
  .tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin-bottom: 12px; }
  .tab { flex: none; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--divider-color); background: none; font-size: 14px; color: var(--secondary-text-color); }
  .tab.on { background: var(--primary-text-color); color: var(--card-background-color, #fff); border-color: transparent; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; }
  .tile { position: relative; display: flex; flex-direction: column; text-align: start; padding: 0; border: 2px solid transparent;
    border-radius: 12px; overflow: hidden; background: var(--secondary-background-color); transition: transform .12s; }
  .tile:hover { transform: translateY(-2px); }
  .tile.active { border-color: var(--kcm-accent); }
  .tile img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--divider-color); }
  .title { font-weight: 700; font-size: 14px; padding: 8px 10px 2px; }
  .np { font-size: 12px; color: var(--secondary-text-color); padding: 0 10px 10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .badge { position: absolute; top: 6px; inset-inline-start: 6px; display: inline-flex; align-items: center; gap: 4px; max-width: calc(100% - 12px);
    padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--kcm-accent); color: var(--kcm-accent-ink);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge svg { width: 12px; height: 12px; }
  .empty { grid-column: 1 / -1; text-align: center; color: var(--secondary-text-color); padding: 30px 0; }
  .toast { position: absolute; bottom: 12px; left: 50%; transform: translate(-50%, 10px); opacity: 0; pointer-events: none;
    background: var(--primary-text-color); color: var(--card-background-color, #fff); padding: 8px 16px; border-radius: 999px;
    font-size: 14px; transition: opacity .2s, transform .2s; max-width: calc(100% - 32px); text-align: center; }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
`;

if (!customElements.get('kcm-radio-card')) {
  customElements.define('kcm-radio-card', KcmRadioCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'kcm-radio-card',
    // both languages, so the card picker finds it by "קול חי", "kol chai" or "kcm"
    name: 'קול חי מיוזיק – Kol Chai Music',
    description: 'כל ערוצי מיוזיק ווליום — בחירת נגנים והפעלה בלחיצה. KCM radio: play any station on one or more players.',
    preview: false,
  });
}
