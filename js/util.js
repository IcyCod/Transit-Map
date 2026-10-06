/* Shared helpers + tiny pub/sub. Everything hangs off window.TM. */
window.TM = window.TM || {};

(function (TM) {
  TM.GRID = 90; // px per node in world space
  TM.BASE_LANGS = [
    { key: 'en', short: 'EN', label: 'English' },
    { key: 'ms', short: 'BM', label: 'Bahasa Melayu' },
    { key: 'zh-Hant', short: '中', label: '正體中文' },
    { key: 'ta', short: 'த', label: 'தமிழ்' },
  ];
  /* The languages of the open map: the four every map has, then any the map adds of its own (map.json → languages,
     e.g. [{ key: "ja", short: "日", label: "日本語" }]). TM.maps sets it whenever the open map changes. */
  TM.LANGS = TM.BASE_LANGS.slice();
  TM.applyMapLanguages = () => {
    const currentMap = TM.maps && TM.maps.current;
    TM.LANGS = TM.BASE_LANGS.concat((currentMap && currentMap.languages) || []);
  };
  /* The open map's own default for "Inside symbol shows" and "Allow a station to override this" (map.json →
     numberMode / numModeOverride): every viewer starts from it when the map opens, and may still change it. */
  TM.NUMBER_MODES = ['none', 'code', 'full', 'ordinal'];
  TM.applyMapDisplay = () => {
    const m = TM.maps && TM.maps.current;
    if (!m || !TM.state) return;
    if (m.numberMode) TM.state.numberMode = m.numberMode;
    if (typeof m.numModeOverride === 'boolean') TM.state.numModeOverride = m.numModeOverride;
  };
  TM.LANG_KEY = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
  /* a map's own extra languages, cleaned: valid unique keys not among the four, a short label (≤4) and a name */
  TM.normLanguages = (list) => {
    const out = [], seen = new Set(TM.BASE_LANGS.map((l) => l.key));
    (Array.isArray(list) ? list : []).forEach((language) => {
      const key = language && String(language.key || '').trim();
      if (!key || !TM.LANG_KEY.test(key) || seen.has(key) || out.length >= 12) return;
      seen.add(key);
      const label = String(language.label || key).trim().slice(0, 40) || key;
      out.push({ key, short: String(language.short || key).trim().slice(0, 4) || key.slice(0, 4).toUpperCase(), label });
    });
    return out;
  };
  TM.STATUSES = {
    operational: 'Operational',
    under_construction: 'Under construction',
    provisional: 'Provisional',
    planned: 'Planned',
    abandoned: 'Abandoned',
    demolished: 'Demolished',
    terminated: 'Terminated',
    fantasy: 'Fantasy',
  };
  /* Statuses whose stations the Display section (and the journey planner) can hide, in the order the checkboxes show:
     the station status, the TM.state / render option that shows it, and the checkbox text. The one list every screen,
     the renderer and the router read, so a new status is added here only. */
  TM.STATUS_TOGGLES = [
    { status: 'under_construction', opt: 'showUnderConstruction', label: 'Under-construction stations' },
    { status: 'provisional', opt: 'showProvisional', label: 'Provisional stations' },
    { status: 'planned', opt: 'showPlanned', label: 'Planned stations' },
    { status: 'terminated', opt: 'showTerminated', label: 'Terminated stations' },
    { status: 'abandoned', opt: 'showAbandoned', label: 'Abandoned stations' },
    { status: 'demolished', opt: 'showDemolished', label: 'Demolished stations' },
  ];
  /* { showPlanned: v, … } for every toggle above, each set to valueOf(toggle) */
  TM.statusFlagsFrom = (valueOf) => Object.fromEntries(TM.STATUS_TOGGLES.map((t) => [t.opt, valueOf(t)]));
  /* A station's platforms are a list of { type, count } — e.g. Tanjung Malim: 1 island + 2 side. A bus stop or bus
     terminal is just what the station is, with no count; an empty list is "unknown". */
  TM.PLATFORMS = {
    island: 'Island', side: 'Side', single: 'Single', stacked: 'Stacked',
    bay: 'Bay', split: 'Split', bus_stop: 'Bus stop', bus_terminal: 'Bus terminal',
  };
  TM.PLATFORM_NO_COUNT = new Set(['bus_stop', 'bus_terminal']);
  TM.platformText = (list) => (list && list.length
    ? list.map((p) => (TM.PLATFORM_NO_COUNT.has(p.type) ? TM.PLATFORMS[p.type] : `${p.count} ${TM.PLATFORMS[p.type].toLowerCase()}`)).join(' + ')
    : 'Unknown');
  TM.MODES = { brt: 'BRT', lrt: 'LRT', mrt: 'MRT', monorail: 'Monorail', commuter: 'Commuter', intercity:'Intercity', arl:'Airport rail link', hsr: 'HSR', tram: 'Tram', funicular: 'Funicular', cablecar: 'Cable car', bus: 'Bus', other: 'Other' };
  /* a short id made from a name ("Circle Line (loop)" → "circle-line-loop") */
  TM.slugId = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
  /* what a traveller looks out for on a line of this type */
  TM.vehicleOf = (mode) => (mode === 'brt' || mode === 'bus' ? 'bus' : mode === 'tram' ? 'tram' : mode === 'cablecar' ? 'cable car' : 'train');
  TM.STRUCTURES = { unknown: 'Unknown', underground: 'Underground', elevated: 'Elevated', at_grade: 'At-grade', sub_surface: 'Sub-surface' };
  /* Symbol kinds (per line item). short = button label, tip = long description. */
  TM.SYMBOLS = {
    auto: { short: 'Auto', tip: 'Auto: interchange ring where lines meet, terminal bar at line ends' },
    station: { short: 'Station', tip: 'Plain station' },
    tick: { short: 'Tick', tip: 'A small tab in the line\'s colour sticking out of the line on the label side' },
    disc: { short: 'Larger circle', tip: 'A circle filled with the line colour, a little larger than the ring' },
    terminal: { short: 'Terminus', tip: 'A bar indicating terminus.' },
    interchange: { short: 'Ring', tip: 'A ring bigger than Station' },
    capsule: { short: 'Capsule', tip: 'Interchange: one circle per line inside a capsule (Plaza Rakyat / Merdeka style)' },
    stack: { short: 'Stacked', tip: 'Interchange: coloured dots stacked in a rounded box (Flamingo style)' },
    chain: { short: 'Linked', tip: 'One numbered disc in each line\'s colour, joined by a narrow neck.' },
    dash: { short: 'Dash', tip: 'A short dash-like tick pointing out from the line, in the same direction as the station\'s own label' },
    pill: { short: 'Pill', tip: 'A rounded pill in the line\'s colour sitting across it.' },
  };
  /* Style of a line segment (Line style tool / Inspector → Line segment). auto = follows the stations' status. */
  TM.SEG_STYLES = { auto: 'Auto', dash: 'Dashed', dashdot: 'Dash-dot', hatch: 'Stripes', solid: 'Solid' };
  /* A small picture of a line style (a TM.SEG_STYLES key, or 'split'), for the style pickers */
  TM.segSwatch = (style) => {
    const line = (extra) => `<line x1="3" y1="8" x2="37" y2="8" stroke="currentColor" stroke-width="4"${extra}/>`;
    const body = { dash: line(' stroke-dasharray="8 4"'), dashdot: line(' stroke-dasharray="8 3 2 3"'), hatch: line(' stroke-dasharray="2.5 2.5"'), solid: line(''),
      auto: line(' stroke-dasharray="8 4" opacity=".45"') + '<text x="20" y="11.5" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">A</text>',
      split: '<line x1="3" y1="6" x2="37" y2="6" stroke="#e0474c" stroke-width="3.5"/><line x1="3" y1="10" x2="37" y2="10" stroke="#2f7de1" stroke-width="3.5"/>' }[style] || line('');
    return `<svg class="seg-sw" width="40" height="16" viewBox="0 0 40 16" aria-hidden="true">${body}</svg>`;
  };
  /* Point markers on a line: a bend of the route (schematic: a path item; real map: a route bend) can carry one. Two
     kinds start or end a stretch of the line — side 'a': the stretch runs on after the marker (along the line's own
     order), 'b': it ran up to it. Between a tunnel's two portals the line is drawn striped (unless it has a style of its
     own); between two viaduct ends, with grey rails along both sides. The others mark one place. */
  TM.MARKS = {
    tunnel: { name: 'Tunnel portal', range: 'tunnel' },
    viaduct: { name: 'Viaduct / elevated', range: 'elevated' },
    grade: { name: 'At grade (level crossing)' },
    overbridge: { name: 'Overbridge' },
    underbridge: { name: 'Underbridge' },
    water: { name: 'Across water' },
    border: { name: 'Border or fare zone' },
    customs: { name: 'Border with customs' },
  };
  TM.STRUCTURES_LEN = { tunnel: 'Tunnel', elevated: 'Elevated', grade: 'At grade' };
  TM.normMark = (m) => {
    if (!m) return null;
    const k = typeof m === 'string' ? m : m.k;
    if (!TM.MARKS[k]) return null;
    return TM.MARKS[k].range ? { k, s: m.s === 'b' ? 'b' : 'a' } : { k };
  };
  TM.flipMark = (m) => (m && m.s ? { k: m.k, s: m.s === 'a' ? 'b' : 'a' } : m);
  /* the structure of each leg between consecutive nodes, from the markers on the nodes (in order): 'tunnel',
     'elevated' or null (at grade). A stretch's end marker with no start before it reaches back to the previous marker
     (or the start of the line). */
  TM.structureLegs = (marks) => {
    const legs = new Array(Math.max(0, marks.length - 1)).fill(null);
    let state = null, from = 0;
    marks.forEach((m, i) => {
      const range = m && TM.MARKS[m.k] && TM.MARKS[m.k].range;
      if (!range) { if (i < legs.length) legs[i] = state; return; }
      if (m.s === 'b') { if (state !== range) for (let j = from; j < i; j++) legs[j] = range; state = null; }
      else state = range;
      from = i;
      if (i < legs.length) legs[i] = state;
    });
    return legs;
  };
  /* How the journey planner tells a traveller which train to board (a line's / service's own choice):
     towards = "Look for train towards Gombak"; via = "… via KL Sentral" (the next interchange it reaches);
     viaTowards = "… via KL Sentral towards Gombak". */
  TM.LOOK_FOR = { towards: 'Towards the terminus', via: 'Via the next interchange', viaTowards: 'Via the next interchange, towards the terminus' };
  /* A circle line's two ways round, as the journey planner names them: clockwise / anticlockwise, or the inner and outer
     loop (or circle) — which of those is clockwise follows the side trains keep to: on the left, the outer track runs
     clockwise (as on the Yamanote Line); on the right, anticlockwise. */
  TM.LOOP_NAMES = { cw: 'Clockwise / anticlockwise', loop: 'Inner / outer loop', circle: 'Inner / outer circle' };
  TM.TRAFFIC = { left: 'Left-hand running', right: 'Right-hand running' };
  TM.loopWay = (way, names, traffic) => {
    if (!names || names === 'cw' || !way) return way;
    const outer = traffic === 'right' ? 'anticlockwise' : 'clockwise';
    return (way === outer ? 'Outer ' : 'Inner ') + (names === 'loop' ? 'Loop' : 'Circle');
  };
  TM.SEG_NEXT = { auto: 'dash', dash: 'dashdot', dashdot: 'hatch', hatch: 'solid', solid: 'auto' };
  /* Background shape and border type of a free-floating text label (the frame drawn behind its text). */
  TM.ANN_SHAPES = { none: 'None', rect: 'Rectangle', round: 'Rounded', pill: 'Pill', ellipse: 'Ellipse', circle: 'Circle' };
  TM.ANN_BORDERS = { none: 'None', solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted', double: 'Double' };
  /* How two stations can be linked (Inspector → Connections). */
  TM.LINK_TYPES = {
    platform: { short: 'Same platform', tip: 'Same-platform interchange.' },
    interchange: { short: 'Interchange', tip: 'Different platform interchange.' },
    link: { short: 'Connecting', tip: 'Connecting stations that requires tap out.' },
    walkway: { short: 'Unofficial', tip: 'Connection suggested by community that does not exist in official map.' },
  };

  /* ---- events ---- */
  const handlers = {};
  TM.on = (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); };
  TM.emit = (evt, data) => { (handlers[evt] || []).slice().forEach((fn) => fn(data)); };

  /* ---- misc ---- */
  TM.esc = (text) => String(text == null ? '' : text).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  /* Small deterministic hash (djb2-xor, base36, ~5 chars) — used to tag newly-generated ids with a short fingerprint of
     when/what they were, so a few people creating stations or lines locally at once don't collide when merged. Not for
     anything security-sensitive: just enough spread to make an accidental clash very unlikely. */
  TM.shortHash = (text) => {
    let hash = 5381 >>> 0;
    for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    return hash.toString(36).slice(0, 5);
  };

  TM.debounce = (func, delay) => {
    let timer;
    return (...a) => { clearTimeout(timer); timer = setTimeout(() => func(...a), delay); };
  };

  TM.haversine = (lat1, lng1, lat2, lng2) => {
    const earthRadius = 6371008.8, toRadians = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRadians, dLng = (lng2 - lng1) * toRadians;
    const haversineA = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRadians) * Math.cos(lat2 * toRadians) * Math.sin(dLng / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.sqrt(haversineA));
  };

  TM.today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  /* An angle in degrees brought into 0 – 359.99 (e.g. 370 -> 10, -90 -> 270), kept to two decimals; 0 for anything not a number. */
  TM.normAngle = (value) => {
    const number = +value;
    if (value === '' || value == null || !isFinite(number)) return 0;
    const normalized = TM.round2dp(((number % 360) + 360) % 360);
    return normalized >= 360 ? 0 : normalized;
  };

  /* n rounded to 2 decimals (1/100 of a grid node is ~1px at 100%) */
  TM.round2dp = (n) => Math.round(n * 100) / 100;

  /* A JSON file from this site, always revalidated; throws with the URL and status when it is missing. */
  TM.getJSON = async (url) => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(url + ' → ' + response.status);
    return response.json();
  };

  /* Browser storage. Reads never throw (private mode, blocked storage → null / the fallback). set throws when the
     browser refuses (storage full), so a caller saving real data can tell; setQuiet / setJSON are for view preferences
     and ignore that. */
  TM.storage = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { localStorage.setItem(key, value); },
    del(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } },
    getJSON(key, fallback = null) { try { const value = JSON.parse(localStorage.getItem(key)); return value == null ? fallback : value; } catch (e) { return fallback; } },
    setQuiet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } },
    setJSON(key, value) { TM.storage.setQuiet(key, JSON.stringify(value)); },
  };

  TM.fmtDist = (m) => (m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km');

  /* Language priority: a map may declare its own hierarchy (map.json → langOrder); otherwise the catalog order (en, ms,
     zh-Hant, ta) is used. Anything not read as a valid TM.LANGS key is dropped, and any key the map's list left out is
     appended at the end, so every language still has a fallback. */
  TM.langOrder = () => {
    const allKeys = TM.LANGS.map((l) => l.key);
    const currentMap = TM.maps && TM.maps.current, custom = currentMap && Array.isArray(currentMap.langOrder) && currentMap.langOrder.length ? currentMap.langOrder.filter((k) => allKeys.includes(k)) : null;
    return custom ? [...custom, ...allKeys.filter((k) => !custom.includes(k))] : allKeys;
  };

  /* Name helpers: lang -> name with graceful fallback, following the map's language hierarchy. */
  TM.nameOf = (object, lang) => {
    const names = (object && object.names) || {};
    if (lang && names[lang]) return names[lang];
    for (const k of TM.langOrder()) { if (names[k]) return names[k]; }
    return (object && object.id) || '';
  };
  TM.displayName = (obj) => TM.nameOf(obj, TM.state.langs[0] || 'en');

  /* Lenient date check: YYYY, YYYY-MM or YYYY-MM-DD (or empty). */
  TM.validDate = (s) => !s || /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(s);

  TM.download = (filename, content, type) => {
    const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 500);
  };

  TM.toast = (message, kind) => {
    const host = document.getElementById('toasts');
    if (!host) return;
    const toast = document.createElement('div');
    toast.className = 'toast' + (kind ? ' ' + kind : '');
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => toast.classList.add('out'), 3200);
    setTimeout(() => toast.remove(), 3700);
  };

  /* Storage key for the browser-local data; an alternative front-end (e.g. the Deno dev editor) may point it elsewhere. */
  TM.config = { storageKey: 'tm.v1' };

  /* the colour a line is drawn in: its own, or its type's when Display → Colour by line type is on (a view preference, line data untouched) */
  TM.lineColor = (line) => (TM.state.colorByType && line && TM.state.typeColors[line.mode || 'other']) || (line && line.color);
  /* a stand-in for a line that reads everything from it but its colour (TM.lineColor); same line → same stand-in within one cache */
  TM.recolor = (line, cache) => {
    if (!line || !TM.state.colorByType) return line;
    if (!cache.has(line)) { const c = Object.assign({}, line); c.color = TM.lineColor(line); cache.set(line, c); }
    return cache.get(line);
  };

  /* The legend's open / close button: a second toggle straight after the first (a double-click, or the extra click a
     touch screen can send) is ignored, so one press never opens and shuts it again. */
  let lastLegendToggle = 0;
  TM.legendToggleOk = () => { const now = Date.now(); if (now - lastLegendToggle < 350) return false; lastLegendToggle = now; return true; };

  /* Leaflet 1.9.4, once loaded: on every map click it copies the whole browser event into a "preclick" one
     (extend({}, e)), and copying reads Firefox's deprecated MouseEvent.mozPressure / mozInputSource — a console warning
     each click. The same function with the preclick built from only what its handlers use. */
  TM.patchLeaflet = () => {
    const L = window.L;
    if (!L || !L.Map || L.Map.prototype._tmPatched) return;
    const keys = ['target', 'srcElement', 'currentTarget', 'clientX', 'clientY', 'screenX', 'screenY', 'pageX', 'pageY', 'button', 'buttons', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'pointerType', 'timeStamp'];
    L.Map.include({
      _tmPatched: true,
      _fireDOMEvent: function (e, type, canvasTargets) {
        if (e.type === 'click') {
          const synth = { type: 'preclick', preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() };
          keys.forEach((k) => { if (k in e) synth[k] = e[k]; });
          this._fireDOMEvent(synth, synth.type, canvasTargets);
        }
        let targets = this._findEventTargets(e, type);
        if (canvasTargets) targets = canvasTargets.filter((t) => t.listens(type, true)).concat(targets);
        if (!targets.length) return;
        if (type === 'contextmenu') L.DomEvent.preventDefault(e);
        const target = targets[0], data = { originalEvent: e };
        if (e.type !== 'keypress' && e.type !== 'keydown' && e.type !== 'keyup') {
          const isMarker = target.getLatLng && (!target._radius || target._radius <= 10);
          data.containerPoint = isMarker ? this.latLngToContainerPoint(target.getLatLng()) : this.mouseEventToContainerPoint(e);
          data.layerPoint = this.containerPointToLayerPoint(data.containerPoint);
          data.latlng = isMarker ? target.getLatLng() : this.layerPointToLatLng(data.layerPoint);
        }
        for (let i = 0; i < targets.length; i++) {
          targets[i].fire(type, data, true);
          if (data.originalEvent._stopped || (targets[i].options.bubblingMouseEvents === false && this._mouseEvents.indexOf(type) !== -1)) return;
        }
      },
    });
  };

  /* Global UI state shared by every module. */
  TM.state = {
    mode: 'schematic',      // 'schematic' | 'map'
    langs: ['en'],          // label languages, ordered
    showNodes: true,
    showLegend: true,
    showHotspots: true,
    ...TM.statusFlagsFrom(() => true),   // showPlanned, showAbandoned, …: stations of each hideable status shown (TM.STATUS_TOGGLES)
    trimHidden: false,      // stop a line at its outermost shown station when its end stations are hidden by status
    showSuggested: true,    // stops suggested for a line (a line's own Show / Hide, store.suggestView, wins over this)
    tool: 'select',         // select | pan | station | route | linestyle | erase | label
    mapTool: 'select',      // real map: select | bend | linestyle | movepoint (route bends between stations — the schematic never sees them)
    mapTileLayer: 'osm',    // real map: which tile style is drawn underneath (TM.map.tileLayers) — OpenStreetMap Standard by default
    insertMode: 'after',    // where the Station / Route tool inserts relative to the selected item: after | before
    moving: false,          // click-to-move mode for the selected station / bend
    bgMode: false,          // schematic background image: relocate/resize subtool active
    numberMode: 'none',      // "Inside symbol shows": 'none' (off), 'code' (digits of the station's own code), 'full' (the whole code), 'ordinal' (position counted from the line's first stop)
    numModeOverride: false, // let a station's own "Inside symbol shows" choice (store.numMode) win over the map-wide setting above
    labelSize: 13,          // default label font size (px)
    lineWidth: 8,           // line thickness (px); side-by-side lanes sit one thickness + 1 apart
    symbolScale: 100,       // station symbol size, % of normal (blocks keep their own size)
    connWidth: 7,
    colorByType: false,     // Display → draw every line in the colour picked for its type (TM.state.typeColors) instead of its own
    typeColors: { brt: '#7ab800', lrt: '#0072bc', mrt: '#00a650', monorail: '#8dc63f', commuter: '#c8102e', intercity: '#6d2077', arl: '#7a1fa2', hsr: '#e05206', tram: '#2a9d8f', funicular: '#a0522d', cablecar: '#c2185b', bus: '#f7a600', other: '#8a8f98' },           // thickness of the links between stations (connecting / unofficial / interchange), px of a connecting line's core
    drawKind: 'area',        // Draw tool: what a new drawing is (store.DRAW_KINDS)
    drawSnap: false,        // Draw tool: keep each new point on a 45° step from the one before (Shift does the opposite)
    drawId: null,           // Draw tool: the drawing being drawn now (clicks add points to it), or none
    drawColors: { area: '#cfe6c4', line: '#9cc6ea' },   // colour a new drawing of each kind starts with
    selected: null,         // { type:'station'|'wp', id|index }
    activeLineId: null,     // line being edited
  };
})(window.TM);
