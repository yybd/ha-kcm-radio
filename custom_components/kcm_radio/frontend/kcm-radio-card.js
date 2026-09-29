/*
 * קול חי מיוזיק — dashboard card.
 * Pick one or more media players, tap a station, it plays on all of them.
 *
 *   type: custom:kcm-radio-card
 *   title: קול חי מיוזיק        # optional
 *   height: 560px                # optional; panel views fill the screen by default
 *   entities:                    # optional: show only these players
 *     - media_player.living_room
 *   hide_entities: [...]         # optional: hide these players
 *   categories: [styles, mood]   # optional: show only these categories (slug or Hebrew name)
 *   hide_categories: [special]   # optional
 *   stations: [...]              # optional: show only these stations (stationuuid or title)
 *   hide_stations: [...]         # optional
 *
 * All of these can also be set in the card's visual editor.
 *
 * The header (search, players, controls, tabs) stays put; only the station grid scrolls.
 * Data comes from the kcm_radio integration over HA's own websocket (kcm_radio/stations,
 * kcm_radio/nowplaying), so it works wherever the dashboard works, including remote access.
 */

const STORAGE_KEY = 'kcm-radio-card.players';
const LAST_STATION_KEY = 'kcm-radio-card.last-station';
const NOWPLAYING_EVERY_MS = 20000;
const DEFAULT_HEIGHT = '560px';
const HIDDEN_STATES = new Set(['unavailable', 'unknown']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const load = (key, def) => { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } };
const save = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ } };

const norm = (v) => String(v ?? '').trim().toLowerCase();
const listOf = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(norm);
const matchesStation = (list, s) => list.includes(norm(s.uuid)) || list.includes(norm(s.title));
const matchesCategory = (list, c) => list.includes(norm(c.slug)) || list.includes(norm(c.name));

// The config filters, applied to stations / categories / players. Shared by the card and its editor preview.
function filterStations(config, stations, categories) {
  const onlyCats = listOf(config.categories);
  const hideCats = listOf(config.hide_categories);
  const catOk = (slug) => {
    const c = categories.find((x) => x.slug === slug) || { slug, name: slug };
    return (!onlyCats.length || matchesCategory(onlyCats, c)) && !matchesCategory(hideCats, c);
  };
  const only = listOf(config.stations);
  const hide = listOf(config.hide_stations);
  return stations.filter((s) => catOk(s.category) && (!only.length || matchesStation(only, s)) && !matchesStation(hide, s));
}

class KcmRadioCard extends HTMLElement {
  static getStubConfig() {
    return {};
  }

  static getConfigElement() {
    return document.createElement('kcm-radio-card-editor');
  }

  constructor() {
    super();
    this._tab = 'all';
    this._query = '';
    this._playing = new Map(); // entity_id -> station uuid (what this card last started there)
    this._stations = null;
    this._lastStation = load(LAST_STATION_KEY, null);
    this._onOutside = (e) => {
      if (this._menuOpen && !e.composedPath().includes(this._root.querySelector('.picker'))) this._toggleMenu(false);
    };
  }

  // HA calls setConfig more than once (card creation, editor, config changes): keep the DOM and state,
  // only apply the new options.
  setConfig(config) {
    this._config = { title: 'קול חי מיוזיק', ...config };
    if (!this._selected) this._selected = new Set(load(STORAGE_KEY, config.entities?.slice(0, 1) || []));
    if (!this._root) this._build();
    this._root.querySelector('h2').textContent = this._config.title;
    if (this._allStations) {
      this._applyFilters();
      this._renderTabs();
      this._renderGrid();
    }
    this._applyHeight();
    this._playersKey = this._controlsKey = null; // `entities` may have changed
    if (this._hass) this._renderPlayersAndControls();
  }

  // HA sets isPanel on cards in a panel view: fill the screen there instead of a fixed height.
  set isPanel(value) {
    this._isPanel = value;
    this._applyHeight();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._root) return; // setConfig always comes first; nothing to draw into yet
    if (first) this._loadStations();
    this._renderPlayersAndControls();
  }

  getCardSize() {
    return 10;
  }

  // Sections view: full width by default, height is the card's own
  getGridOptions() {
    return { columns: 'full', min_columns: 6 };
  }

  connectedCallback() {
    this._timer = setInterval(() => this._refreshNowPlaying(), NOWPLAYING_EVERY_MS);
    document.addEventListener('click', this._onOutside, true);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    document.removeEventListener('click', this._onOutside, true);
  }

  _applyHeight() {
    if (!this._root || !this._config) return;
    const height = this._config.height || (this._isPanel ? 'calc(100vh - var(--header-height, 56px) - 16px)' : DEFAULT_HEIGHT);
    this._root.querySelector('.wrap').style.height = height;
  }

  // ------------------------------------------------------------------ data

  async _loadStations() {
    if (this._loading) return;
    this._loading = true;
    try {
      // a call made while HA restarts can hang forever; give up after 15s and retry on the next tick
      const data = await Promise.race([
        this._hass.callWS({ type: 'kcm_radio/stations' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
      ]);
      this._allStations = data.stations;
      this._allCategories = data.categories;
      this._applyFilters();
      this._error = null;
    } catch (err) {
      // keep "loading…" for transient failures; _refreshNowPlaying retries every 20s
      if (err?.code === 'not_set_up') this._error = 'התוסף Kol Chai Music Radio עדיין לא הוגדר';
    } finally {
      this._loading = false;
    }
    this._renderTabs();
    this._renderGrid();
    this._renderControls(true);
  }

  async _refreshNowPlaying() {
    if (!this._hass || document.hidden) return;
    if (!this._stations) return this._loadStations();
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

  _applyFilters() {
    this._stations = filterStations(this._config, this._allStations, this._allCategories);
    // only categories that still have stations after filtering get a tab
    const used = new Set(this._stations.map((s) => s.category));
    this._categories = this._allCategories.filter((c) => used.has(c.slug));
    if (this._tab !== 'all' && !used.has(this._tab)) this._tab = 'all';
  }

  _players() {
    const allowed = this._config.entities;
    const hidden = this._config.hide_entities || [];
    return Object.values(this._hass.states)
      .filter((st) => st.entity_id.startsWith('media_player.') && !HIDDEN_STATES.has(st.state))
      .filter((st) => (!allowed || allowed.includes(st.entity_id)) && !hidden.includes(st.entity_id))
      .sort((a, b) => this._name(a.entity_id).localeCompare(this._name(b.entity_id), 'he'));
  }

  _targets() {
    const visible = new Set(this._players().map((p) => p.entity_id));
    return [...this._selected].filter((id) => visible.has(id));
  }

  // ------------------------------------------------------------------ actions

  async _play(uuid) {
    const targets = this._targets();
    if (!targets.length) {
      this._toast('בחרו קודם נגן');
      this._toggleMenu(true);
      return;
    }
    const station = this._stations?.find((s) => s.uuid === uuid);
    try {
      await this._hass.callService('media_player', 'play_media', {
        entity_id: targets,
        media_content_id: `media-source://kcm_radio/station/${uuid}`,
        media_content_type: 'music',
      });
      targets.forEach((id) => this._playing.set(id, uuid));
      this._lastStation = uuid;
      save(LAST_STATION_KEY, uuid);
      if (station) this._toast(`${station.title} · ${targets.map((id) => this._name(id)).join(', ')}`);
    } catch (err) {
      this._toast(`שגיאה: ${err.message || err}`);
    }
    this._renderGrid();
    this._renderControls(true);
  }

  async _stop() {
    const targets = this._targets();
    if (!targets.length) return;
    await this._hass.callService('media_player', 'media_stop', { entity_id: targets }).catch(() => {});
    targets.forEach((id) => this._playing.delete(id));
    this._renderGrid();
  }

  // One button: stop when a selected player is playing, otherwise play the last station again.
  _playStop() {
    const targets = this._targets();
    if (targets.some((id) => this._hass.states[id].state === 'playing')) this._stop();
    else if (this._lastStation) this._play(this._lastStation);
    else this._toast('בחרו תחנה מהרשימה');
  }

  _setVolume(value) {
    const targets = this._targets().filter((id) => this._hass.states[id].attributes.volume_level !== undefined);
    if (targets.length) this._hass.callService('media_player', 'volume_set', { entity_id: targets, volume_level: value });
  }

  _name(id) {
    return this._hass.states[id]?.attributes.friendly_name || id;
  }

  _toggleMenu(open = !this._menuOpen) {
    this._menuOpen = open;
    this._root.querySelector('.picker').classList.toggle('open', open);
    this._root.querySelector('.picker-btn').setAttribute('aria-expanded', String(open));
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
          <header>
            <div class="row">
              <div class="brand"><span class="mark">${EQ_ICON}</span><h2></h2></div>
              <label class="search">${SEARCH_ICON}<input type="search" placeholder="חיפוש ערוץ או שיר…"></label>
            </div>
            <div class="row bar">
              <div class="picker">
                <button class="picker-btn" aria-haspopup="true" aria-expanded="false"></button>
                <div class="menu" role="menu"></div>
              </div>
              <div class="controls">
                <button class="icon-btn playstop" aria-label="הפעלה / עצירה"></button>
                <label class="vol" title="עוצמה">${VOLUME_ICON}<input class="volume" type="range" min="0" max="1" step="0.02" aria-label="עוצמה"></label>
              </div>
            </div>
            <nav class="tabs"></nav>
          </header>
          <div class="grid"><div class="empty">טוען ערוצים…</div></div>
          <div class="toast" role="status"></div>
        </div>
      </ha-card>`;

    const $ = (sel) => this._root.querySelector(sel);
    $('.search input').addEventListener('input', (e) => {
      this._query = e.target.value.trim().toLowerCase();
      this._renderGrid();
    });
    $('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      this._tab = b.dataset.tab;
      this._renderTabs();
      this._renderGrid();
      $('.grid').scrollTop = 0;
    });
    $('.picker-btn').addEventListener('click', () => this._toggleMenu());
    $('.menu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-entity]');
      if (!b) return;
      const id = b.dataset.entity;
      this._selected.has(id) ? this._selected.delete(id) : this._selected.add(id);
      save(STORAGE_KEY, [...this._selected]);
      this._renderPlayersAndControls();
    });
    $('.grid').addEventListener('click', (e) => {
      const t = e.target.closest('.tile');
      if (t) this._play(t.dataset.uuid);
    });
    $('.playstop').addEventListener('click', () => this._playStop());
    $('.volume').addEventListener('change', (e) => this._setVolume(Number(e.target.value)));
  }

  _renderPlayersAndControls() {
    this._renderPlayers();
    this._renderControls();
  }

  _renderPlayers() {
    const players = this._players();
    const key = players.map((p) => `${p.entity_id}:${p.state}:${this._selected.has(p.entity_id)}`).join('|');
    if (key === this._playersKey) return; // hass updates constantly; only touch the DOM on real changes
    this._playersKey = key;

    const selected = players.filter((p) => this._selected.has(p.entity_id));
    const label = !selected.length
      ? '<span class="muted">בחירת נגן</span>'
      : selected.length === 1
        ? esc(this._name(selected[0].entity_id))
        : `${esc(this._name(selected[0].entity_id))} <span class="more">+${selected.length - 1}</span>`;
    this._root.querySelector('.picker-btn').innerHTML = `${SPEAKER_ICON}<span class="label">${label}</span>${CHEVRON_ICON}`;
    this._root.querySelector('.picker-btn').classList.toggle('unselected', !selected.length);

    this._root.querySelector('.menu').innerHTML = players.length
      ? players
          .map((p) => {
            const on = this._selected.has(p.entity_id);
            return `<button class="item${on ? ' on' : ''}" role="menuitemcheckbox" aria-checked="${on}" data-entity="${esc(p.entity_id)}">
              <span class="check">${on ? CHECK_ICON : ''}</span>
              <span class="name">${esc(this._name(p.entity_id))}</span>
              <span class="state ${p.state}">${p.state === 'playing' ? 'מנגן' : p.state === 'off' ? 'כבוי' : ''}</span>
            </button>`;
          })
          .join('')
      : '<div class="muted pad">לא נמצאו נגנים זמינים</div>';
  }

  _renderControls(force = false) {
    const targets = this._targets().map((id) => this._hass.states[id]);
    const vols = targets.map((t) => t.attributes.volume_level).filter((v) => typeof v === 'number');
    const anyPlaying = targets.some((t) => t.state === 'playing');
    const key = `${targets.map((t) => t.entity_id + t.state).join()}|${vols.join()}|${this._lastStation}`;
    if (!force && key === this._controlsKey) return;
    this._controlsKey = key;

    const btn = this._root.querySelector('.playstop');
    btn.innerHTML = anyPlaying ? STOP_ICON : PLAY_ICON;
    btn.classList.toggle('playing', anyPlaying);
    btn.title = anyPlaying ? 'עצירה' : 'הפעלת התחנה האחרונה';
    btn.disabled = !targets.length || (!anyPlaying && !this._lastStation);

    const vol = this._root.querySelector('.vol');
    vol.hidden = !vols.length;
    const slider = vol.querySelector('input');
    if (vols.length && slider !== this._root.activeElement) slider.value = vols.reduce((a, b) => a + b, 0) / vols.length;
  }

  _renderTabs() {
    const cats = this._categories || [];
    // a single category needs no tabs at all
    const tabs = cats.length > 1 ? [{ slug: 'all', name: 'הכל' }, ...cats] : [];
    this._root.querySelector('.tabs').hidden = !tabs.length;
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
            return `<button class="tile${on ? ' active' : ''}" data-uuid="${s.uuid}" title="${esc(s.title)}">
              <span class="art"><img src="${esc(s.image)}" alt="" loading="lazy">
                ${on ? `<span class="badge">${EQ_ICON}<span>${esc(on.join(', '))}</span></span>` : `<span class="hover">${PLAY_ICON}</span>`}
              </span>
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
const CHEVRON_ICON = '<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';
const PLAY_ICON = '<svg class="fill" viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const STOP_ICON = '<svg class="fill" viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>';
const VOLUME_ICON = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>';
const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

const STYLE = `
  :host { --kcm-accent: #fec409; --kcm-accent-ink: #1a1400; --kcm-radius: 12px; display: block; }
  ha-card { overflow: hidden; }
  .wrap { display: flex; flex-direction: column; height: ${DEFAULT_HEIGHT}; position: relative; }
  svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  svg.fill { fill: currentColor; stroke: none; }
  button { font: inherit; color: inherit; cursor: pointer; background: none; border: 0; padding: 0; }
  .muted { color: var(--secondary-text-color); }

  /* header — fixed, does not scroll */
  header { flex: none; padding: 14px 16px 0; display: flex; flex-direction: column; gap: 10px;
    border-bottom: 1px solid var(--divider-color); }
  .row { display: flex; align-items: center; gap: 10px; }
  .brand { display: flex; align-items: center; gap: 10px; flex: none; }
  .mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--kcm-accent); color: var(--kcm-accent-ink); }
  h2 { margin: 0; font-size: 18px; font-weight: 700; white-space: nowrap; }
  .search { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; margin-inline-start: auto; max-width: 280px;
    padding: 0 12px; height: 36px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .search:focus-within { box-shadow: 0 0 0 2px var(--kcm-accent); }
  .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: var(--primary-text-color); font: inherit; }

  /* player picker — one compact button + dropdown */
  .bar { justify-content: space-between; }
  .picker { position: relative; min-width: 0; }
  .picker-btn { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; height: 36px; padding: 0 12px 0 10px;
    border-radius: 999px; background: var(--secondary-background-color); font-size: 14px; font-weight: 500; }
  .picker-btn:hover { box-shadow: inset 0 0 0 1px var(--divider-color); }
  .picker-btn .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .picker-btn .more { color: var(--secondary-text-color); font-weight: 400; }
  .picker-btn .chev { width: 16px; height: 16px; transition: transform .15s; opacity: .7; }
  .picker.open .chev { transform: rotate(180deg); }
  .menu { display: none; position: absolute; top: calc(100% + 6px); inset-inline-start: 0; z-index: 10; min-width: 240px; max-height: 300px;
    overflow-y: auto; padding: 6px; border-radius: var(--kcm-radius); background: var(--card-background-color, #fff);
    box-shadow: 0 8px 28px rgba(0,0,0,.28); border: 1px solid var(--divider-color); }
  .picker.open .menu { display: block; }
  .item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border-radius: 8px; text-align: start; font-size: 14px; }
  .item:hover { background: var(--secondary-background-color); }
  .item .check { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; flex: none;
    box-shadow: inset 0 0 0 1.5px var(--divider-color); }
  .item.on .check { background: var(--kcm-accent); color: var(--kcm-accent-ink); box-shadow: none; }
  .item .check svg { width: 14px; height: 14px; stroke-width: 3; }
  .item .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item .state { font-size: 12px; color: var(--secondary-text-color); }
  .item .state.playing { color: var(--success-color, #43a047); }
  .pad { padding: 10px; font-size: 14px; }

  /* play/stop + volume — icons only */
  .controls { display: flex; align-items: center; gap: 10px; flex: none; }
  .icon-btn { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--kcm-accent); color: var(--kcm-accent-ink); }
  .icon-btn svg { width: 20px; height: 20px; }
  .icon-btn:disabled { background: var(--secondary-background-color); color: var(--disabled-text-color, #999); cursor: default; }
  .vol { display: flex; align-items: center; gap: 6px; color: var(--secondary-text-color); }
  .vol[hidden] { display: none; }
  .volume { width: 110px; accent-color: var(--kcm-accent); }

  /* category tabs — underline style, no extra height */
  .tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; margin: 0 -4px; }
  .tabs::-webkit-scrollbar { display: none; }
  .tabs[hidden] { display: none; }
  header:has(.tabs[hidden]) { padding-bottom: 12px; }
  .tab { flex: none; padding: 8px 10px 10px; font-size: 14px; color: var(--secondary-text-color); border-bottom: 2px solid transparent; }
  .tab.on { color: var(--primary-text-color); font-weight: 600; border-bottom-color: var(--kcm-accent); }

  /* station grid — the only part that scrolls */
  .grid { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 16px; display: grid; align-content: start;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 12px; overscroll-behavior: contain; }
  .tile { display: flex; flex-direction: column; text-align: start; min-width: 0; border-radius: var(--kcm-radius); }
  .art { position: relative; display: block; aspect-ratio: 1; border-radius: var(--kcm-radius); overflow: hidden;
    background: var(--secondary-background-color); outline: 2px solid transparent; outline-offset: 2px; transition: outline-color .15s; }
  .art img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s; }
  .tile:hover .art img { transform: scale(1.04); }
  .tile.active .art { outline-color: var(--kcm-accent); }
  .hover { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.28); opacity: 0; transition: opacity .15s; }
  .hover svg { width: 40px; height: 40px; padding: 10px; border-radius: 50%; background: var(--kcm-accent); color: var(--kcm-accent-ink); box-sizing: border-box; }
  .tile:hover .hover { opacity: 1; }
  .badge { position: absolute; inset-inline: 6px; bottom: 6px; display: flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 600; background: var(--kcm-accent); color: var(--kcm-accent-ink); }
  .badge span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge svg { width: 12px; height: 12px; }
  .title { font-weight: 600; font-size: 13px; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .np { font-size: 12px; color: var(--secondary-text-color); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }
  .empty { grid-column: 1 / -1; text-align: center; color: var(--secondary-text-color); padding: 40px 0; }

  .toast { position: absolute; bottom: 14px; left: 50%; transform: translate(-50%, 10px); opacity: 0; pointer-events: none; z-index: 20;
    background: var(--primary-text-color); color: var(--card-background-color, #fff); padding: 8px 16px; border-radius: 999px;
    font-size: 13px; transition: opacity .2s, transform .2s; max-width: calc(100% - 32px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }

  @media (max-width: 480px) {
    .row:first-child { flex-wrap: wrap; }
    .search { max-width: none; flex-basis: 100%; }
    .volume { width: 80px; }
  }
`;

// ---------------------------------------------------------------------------- visual editor

class KcmRadioCardEditor extends HTMLElement {
  setConfig(config) {
    // HA echoes our own config-changed back through setConfig; re-rendering then would steal focus from inputs
    if (this._emitted && JSON.stringify(config) === this._emitted) return;
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      hass
        .callWS({ type: 'kcm_radio/stations' })
        .then((data) => { this._data = data; this._render(); })
        .catch((err) => { this._error = err.message || String(err); this._render(); });
      this._render();
    }
  }

  _emit(config) {
    for (const key of ['entities', 'hide_entities', 'categories', 'hide_categories', 'stations', 'hide_stations', 'title', 'height']) {
      if (config[key] === '' || (Array.isArray(config[key]) && !config[key].length)) delete config[key];
    }
    this._config = config;
    this._emitted = JSON.stringify(config);
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
    this._renderSummaries();
  }

  _players() {
    return Object.values(this._hass?.states || {})
      .filter((st) => st.entity_id.startsWith('media_player.'))
      .filter((st) => !HIDDEN_STATES.has(st.state) || (this._config.hide_entities || []).includes(st.entity_id) || (this._config.entities || []).includes(st.entity_id))
      .sort((a, b) => (a.attributes.friendly_name || a.entity_id).localeCompare(b.attributes.friendly_name || b.entity_id, 'he'));
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const c = this._config;
    const players = this._players();
    const whitelistPlayers = Array.isArray(c.entities);
    const playerShown = (id) => (whitelistPlayers ? c.entities.includes(id) : !(c.hide_entities || []).includes(id));
    const cats = this._data?.categories || [];
    const stations = this._data?.stations || [];
    const onlyMode = Array.isArray(c.stations) && c.stations.length > 0;
    const catShown = (cat) => {
      const only = listOf(c.categories);
      return (!only.length || matchesCategory(only, cat)) && !matchesCategory(listOf(c.hide_categories), cat);
    };
    const stationChecked = (st) => (onlyMode ? matchesStation(listOf(c.stations), st) : !matchesStation(listOf(c.hide_stations), st));

    this.shadowRoot.innerHTML = `
      <style>${EDITOR_STYLE}</style>
      <div class="ed" dir="rtl">
        <section>
          <h3>כללי</h3>
          <label class="field"><span>כותרת</span><input data-key="title" value="${esc(c.title || '')}" placeholder="קול חי מיוזיק"></label>
          <label class="field"><span>גובה</span><input data-key="height" value="${esc(c.height || '')}" placeholder="אוטומטי (560px, ובתצוגת פאנל – מסך מלא)"></label>
        </section>

        <section>
          <h3>נגנים <small class="sum" data-sum="players"></small></h3>
          <p class="hint">סמנו את הנגנים שיופיעו בבחירת הנגן בכרטיס.</p>
          <div class="actions"><button data-all="players">הכל</button><button data-none="players">כלום</button></div>
          <div class="list" data-list="players">
            ${players.length ? players.map((p) => `
              <label class="chk"><input type="checkbox" data-player="${esc(p.entity_id)}" ${playerShown(p.entity_id) ? 'checked' : ''}>
                <span>${esc(p.attributes.friendly_name || p.entity_id)}</span><small>${esc(p.entity_id)}</small></label>`).join('')
              : '<div class="hint">לא נמצאו נגנים</div>'}
          </div>
        </section>

        <section>
          <h3>קטגוריות <small class="sum" data-sum="categories"></small></h3>
          <div class="chips">
            ${this._data ? cats.map((cat) => `
              <label class="chip"><input type="checkbox" data-category="${esc(cat.slug)}" ${catShown(cat) ? 'checked' : ''}><span>${esc(cat.name)}</span></label>`).join('')
              : `<div class="hint">${this._error ? esc(this._error) : 'טוען…'}</div>`}
          </div>
        </section>

        <section>
          <h3>תחנות <small class="sum" data-sum="stations"></small></h3>
          <div class="modes">
            <label><input type="radio" name="mode" value="all" ${onlyMode ? '' : 'checked'}> כל התחנות — בטלו סימון כדי להסתיר</label>
            <label><input type="radio" name="mode" value="only" ${onlyMode ? 'checked' : ''}> רק התחנות שאסמן</label>
          </div>
          <input class="filter" type="search" placeholder="סינון תחנות…">
          <div class="actions"><button data-all="stations">סמן הכל</button><button data-none="stations">בטל הכל</button></div>
          <div class="list tall" data-list="stations">
            ${this._data ? stations.map((st) => `
              <label class="chk" data-title="${esc(st.title.toLowerCase())}"><input type="checkbox" data-station="${esc(st.uuid)}" ${stationChecked(st) ? 'checked' : ''}>
                <img src="${esc(st.image)}" alt="" loading="lazy"><span>${esc(st.title)}</span>
                <small>${esc((cats.find((x) => x.slug === st.category) || {}).name || '')}</small></label>`).join('')
              : `<div class="hint">${this._error ? esc(this._error) : 'טוען…'}</div>`}
          </div>
        </section>
      </div>`;

    const root = this.shadowRoot;
    root.querySelectorAll('input[data-key]').forEach((input) =>
      input.addEventListener('change', () => this._emit({ ...this._config, [input.dataset.key]: input.value.trim() })));
    root.querySelector('[data-list="players"]').addEventListener('change', () => this._savePlayers());
    root.querySelector('.chips').addEventListener('change', () => this._saveCategories());
    root.querySelector('[data-list="stations"]').addEventListener('change', () => this._saveStations());
    root.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => this._saveStations()));
    root.querySelector('.filter').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      root.querySelectorAll('[data-list="stations"] .chk').forEach((row) => { row.hidden = q && !row.dataset.title.includes(q); });
    });
    root.querySelectorAll('[data-all],[data-none]').forEach((b) =>
      b.addEventListener('click', () => {
        const list = b.dataset.all || b.dataset.none;
        root.querySelectorAll(`[data-list="${list}"] .chk:not([hidden]) input`).forEach((i) => { i.checked = !!b.dataset.all; });
        list === 'players' ? this._savePlayers() : this._saveStations();
      }));
    this._renderSummaries();
  }

  _savePlayers() {
    const boxes = [...this.shadowRoot.querySelectorAll('[data-player]')];
    const config = { ...this._config };
    if (Array.isArray(config.entities)) config.entities = boxes.filter((b) => b.checked).map((b) => b.dataset.player);
    else config.hide_entities = boxes.filter((b) => !b.checked).map((b) => b.dataset.player);
    this._emit(config);
  }

  _saveCategories() {
    const config = { ...this._config };
    delete config.categories; // the editor always works with a hide-list
    config.hide_categories = [...this.shadowRoot.querySelectorAll('[data-category]')].filter((b) => !b.checked).map((b) => b.dataset.category);
    this._emit(config);
  }

  _saveStations() {
    const root = this.shadowRoot;
    const only = root.querySelector('input[name="mode"]:checked')?.value === 'only';
    const boxes = [...root.querySelectorAll('[data-station]')];
    const config = { ...this._config };
    if (only) {
      delete config.hide_stations;
      config.stations = boxes.filter((b) => b.checked).map((b) => b.dataset.station);
      // switching to "only" with nothing ticked would show an empty card — start from what is visible now
      if (!config.stations.length && !Array.isArray(this._config.stations)) {
        config.stations = boxes.filter((b) => b.checked || !this._config.hide_stations?.includes(b.dataset.station)).map((b) => b.dataset.station);
      }
    } else {
      delete config.stations;
      config.hide_stations = boxes.filter((b) => !b.checked).map((b) => b.dataset.station);
    }
    this._emit(config);
  }

  _renderSummaries() {
    const root = this.shadowRoot;
    if (!root) return;
    const count = (sel) => {
      const all = root.querySelectorAll(sel);
      return `${[...all].filter((b) => b.checked).length}/${all.length}`;
    };
    const set = (key, text) => { const el = root.querySelector(`[data-sum="${key}"]`); if (el) el.textContent = text; };
    set('players', count('[data-player]'));
    set('categories', count('[data-category]'));
    if (this._data) {
      const shown = filterStations(this._config, this._data.stations, this._data.categories).length;
      set('stations', `${shown} מוצגות`);
    }
  }
}

const EDITOR_STYLE = `
  .ed { display: flex; flex-direction: column; gap: 18px; color: var(--primary-text-color); font-size: 14px; }
  section { display: flex; flex-direction: column; gap: 8px; }
  h3 { margin: 0; font-size: 15px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
  h3 small, .hint, .chk small { color: var(--secondary-text-color); font-weight: 400; font-size: 12px; }
  .hint { margin: 0; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field span { font-size: 12px; color: var(--secondary-text-color); }
  input[type=search], .field input { font: inherit; color: inherit; padding: 9px 12px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--card-background-color, transparent); }
  .list { display: flex; flex-direction: column; max-height: 220px; overflow-y: auto; border: 1px solid var(--divider-color); border-radius: 10px; }
  .list.tall { max-height: 320px; }
  .chk { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-bottom: 1px solid var(--divider-color); cursor: pointer; }
  .chk:last-child { border-bottom: 0; }
  .chk[hidden] { display: none; }
  .chk span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chk img { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; flex: none; }
  input[type=checkbox], input[type=radio] { accent-color: #fec409; width: 16px; height: 16px; flex: none; margin: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--divider-color); cursor: pointer; }
  .modes { display: flex; flex-direction: column; gap: 6px; }
  .modes label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .actions { display: flex; gap: 12px; }
  .actions button { font: inherit; font-size: 12px; color: var(--primary-color); background: none; border: 0; padding: 0; cursor: pointer; }
`;

if (!customElements.get('kcm-radio-card')) {
  customElements.define('kcm-radio-card', KcmRadioCard);
  customElements.define('kcm-radio-card-editor', KcmRadioCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'kcm-radio-card',
    // both languages, so the card picker finds it by "קול חי", "kol chai" or "kcm"
    name: 'קול חי מיוזיק – Kol Chai Music',
    description: 'כל ערוצי מיוזיק ווליום — בחירת נגנים והפעלה בלחיצה. KCM radio: play any station on one or more players.',
    preview: false,
  });
}
