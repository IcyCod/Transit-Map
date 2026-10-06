/* Data store: loads the open map's stations + lines (maps/<id>/…), keeps local (user) edits in localStorage.
   A map made in the browser has no files: everything in it is "local" and lives in its localStorage entry. */
(function (TM) {
  const lsKey = () => TM.maps.storageKey();
  const DEFAULT_ANCHOR = { lat: 3.1492, lng: 101.6964, step: 0.0035, x: 28, y: 28 }; // rough georeference: Masjid Jamek = node (28,28) — a map can set its own
  const LINK_RANK = { platform: 4, interchange: 3, link: 2, walkway: 1 };
  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const nameKey = (s) => TM.nameOf(s, 'en').trim().toLowerCase();

  const store = (TM.store = {
    stations: new Map(),
    lines: new Map(),
    visible: new Set(),
    lineFilter: new Set(),      // lines included in the current top-bar filter; separate from visible (canvas eye state)
    author: 'me',
    moves: {},          // shared station id -> [x, y] (positions changed by this user)
    geoMoves: {},       // shared station id -> [lat, lng] (coordinates changed by this user on the real map)
    blockEdits: {},     // rep station id -> block object (or null) this user set on a shared interchange group
    bendEdits: {},      // shared line id -> { "A>B": [[lat,lng],…] }: route bends this user drew on the real map (kept apart from the shipped line)
    anchor: Object.assign({}, DEFAULT_ANCHOR),
    userMap: false,     // the open map was made in this browser: everything in it is editable
    codeLabels: {},     // station (interchange group) id -> { show?: bool, text?: string }: how the small code label looks on this user's map
    labelPos: {},       // station (interchange group) id -> { pos?, dx?, dy?, hide?, size? }: where its name label sits, kept apart from any one line's item so every line agrees
    numMode: {},        // station (interchange group) id -> 'none'|'code'|'full'|'ordinal': this station's own "Inside symbol shows" choice, a view preference (see TM.state.numModeOverride)
    linkEdits: [],      // this user's link changes on stations they do not own: { a, b, type | null (= removed) }
    suggestEdits: [],   // this user's stop suggestions on stations whose record they cannot write: { station, line, after, author, note } | { station, line, off: true } (= dismissed)
    suggestView: {},    // line id -> 'show' | 'hide': this user's per-line choice whether that line draws its suggested stops (absent = follow Display → Suggested stops)
    drawing: { top: 'drawings', hidden: false, items: [] },   // background drawings (areas, lines) under the map — see store.normDrawing
    background: null,   // { file, dataUri, x, y, w, h, opacity, visible }: schematic background image, or none
    services: [],       // the trains that run on the track (maps/<id>/services.json — see store.normService / store.serviceRoute)
    _nodes: null,
    _groups: null,
    _conns: null,
    _complex: null,
  });

  /* ---------- normalisation ---------- */
  const blankNames = () => ({ en: '', ms: '', 'zh-Hant': '', ta: '' });

  const legacyStatus = (st) => (st === 'in_use' ? 'operational' : st);   // files / browser data saved before the rename

  const normBendPts = (bends) => (Array.isArray(bends) ? bends : []).filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))
    .map((p) => [TM.round2dp(+p[0]), TM.round2dp(+p[1])]);
  /* How the drawn link between two stations looks (schematic): style = a line style (TM.SEG_STYLES, not 'auto') or
     'split' (each half in the colours of the lines at its own end); color = the link's own #hex colour; border = 'none' or a
     #hex colour. Absent = default. */
  const normConnLook = (connection, out) => {
    if (connection && ((TM.SEG_STYLES[connection.style] && connection.style !== 'auto') || connection.style === 'split')) out.style = connection.style;
    if (connection && (connection.border === 'none' || /^#[0-9a-f]{6}$/i.test(connection.border || ''))) out.border = connection.border === 'none' ? 'none' : connection.border.toLowerCase();
    if (connection && /^#[0-9a-f]{6}$/i.test(connection.color || '')) out.color = connection.color.toLowerCase();
    return out;
  };
  /* the optional extras a link carries (anything but its ends and type), for writing it out again */
  const connExtras = (connection) => {
    const extras = {};
    if (connection.bends && connection.bends.length) extras.bends = connection.bends;
    if (connection.time) extras.time = connection.time;
    if (connection.timeBack) extras.timeBack = connection.timeBack;
    if (connection.style) extras.style = connection.style;
    if (connection.border) extras.border = connection.border;
    if (connection.color) extras.color = connection.color;
    return extras;
  };
  const minutes = (v) => (isFinite(v) && v > 0 ? Math.round(Math.min(999, v) * 10) / 10 : null);
  const normTimes = (e) => {
    const out = {}, time = minutes(e && e.time), back = minutes(e && e.timeBack);
    if (time) out.time = time;
    if (back && back !== time) out.timeBack = back;
    return out;
  };
  /* a link's travel times seen from station `from` (one of its ends a / b): { time: from → other, timeBack: other → from } */
  const timesFrom = (link, from) => (link.a === from ? { time: link.time || null, timeBack: link.timeBack || null } : { time: link.timeBack || link.time || null, timeBack: link.timeBack ? link.time || null : null });
  const normConns = (list) => (Array.isArray(list) ? list : [])
    .map((connection) => {
      const out = { to: String(connection && connection.to), type: connection && TM.LINK_TYPES[connection.type] ? connection.type : 'link' };
      const bends = normBendPts(connection && connection.bends);
      if (bends.length) out.bends = bends;
      /* average travel time, in minutes: time from this station to the other; timeBack the other way, when it differs
         (absent: the same as time) */
      Object.assign(out, normTimes(connection));
      return normConnLook(connection, out);
    })
    .filter((c) => c.to && c.to !== 'undefined');

  /* A station (or its whole interchange group) drawn as one mega-station "block": every member gets its own small dot,
     freely placed inside the shape; a connecting station can be merged in too. style: rapidkl (a filled bar) | shape
     (an outlined circle/square). members: raw station id -> {dx,dy} px offset from the block's centre. */
  const normT = (v) => { const number = +v; if (!isFinite(number)) return null; const fraction = number % 1; return fraction < 0 ? fraction + 1 : fraction; };
  function normBlock(block) {
    if (!block || typeof block !== 'object') return null;
    const members = {};
    if (block.members && typeof block.members === 'object') Object.entries(block.members).forEach(([memberId, value]) => {
      const fraction = normT(typeof value === 'object' && value ? value.t : value);
      if (fraction != null) members[String(memberId)] = fraction;
    });
    const edges = {};
    if (block.edges && typeof block.edges === 'object') Object.entries(block.edges).forEach(([key, value]) => {
      const fraction = normT(value);
      if (fraction != null && /^[^|]+\|[^|]+\|(in|out)$/.test(key)) edges[key] = fraction;
    });
    /* Grouping stations together inside the block is a view of this block only — it never touches whether they are a
       real interchange in the data. bundles: raw id -> a short group key (blank = its own, independent). bundleSymbol:
       group key -> the multi-station style to draw it with (blank = auto, same rule as a real interchange). */
    const bundles = {};
    if (block.bundles && typeof block.bundles === 'object') Object.entries(block.bundles).forEach(([key, value]) => {
      const groupKey = String(value == null ? '' : value).trim().slice(0, 24);
      if (groupKey) bundles[String(key)] = groupKey;
    });
    /* A slot's symbol / number-inside can be overridden for the block's own view only — never the real per-line choice
       (see actions.setBlockSymbol). symbol: slot key -> a TM.SYMBOLS kind (station/terminal/disc/interchange for a single
       station; capsule/stack/chain/interchange for a bundle). num: slot key -> true/false (blank = automatic). */
    const symbol = {};
    if (block.symbol && typeof block.symbol === 'object') Object.entries(block.symbol).forEach(([key, value]) => {
      if (TM.SYMBOLS[value] && value !== 'auto') symbol[String(key)] = value;
    });
    const numbers = {};
    if (block.num && typeof block.num === 'object') Object.entries(block.num).forEach(([key, value]) => {
      if (typeof value === 'boolean') numbers[String(key)] = value;
    });
    /* The block's own name label — position/offset/size/hide — belongs to the block, not to any one station's line item
       (which a block may not even have an editable one of). See actions.setBlockLabelPos. */
    const rawLp = block.labelPos && typeof block.labelPos === 'object' ? block.labelPos : {};
    const labelPos = {};
    if (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].includes(rawLp.pos)) labelPos.pos = rawLp.pos;
    if (isFinite(rawLp.dx) && Math.round(rawLp.dx)) labelPos.dx = Math.round(rawLp.dx);
    if (isFinite(rawLp.dy) && Math.round(rawLp.dy)) labelPos.dy = Math.round(rawLp.dy);
    if (rawLp.hide) labelPos.hide = true;
    if (isFinite(rawLp.size) && rawLp.size > 0) labelPos.size = Math.min(40, Math.max(6, Math.round(rawLp.size)));
    if (TM.normAngle(rawLp.rot)) labelPos.rot = TM.normAngle(rawLp.rot);
    return {
      style: block.style === 'shape' ? 'shape' : 'rapidkl',
      shape: block.shape === 'square' ? 'square' : 'circle',
      orientation: block.orientation === 'vertical' ? 'vertical' : 'horizontal',
      size: isFinite(block.size) && block.size > 0 ? Math.round(block.size) : null,
      label: typeof block.label === 'string' ? block.label.trim().slice(0, 60) : '',
      color: /^#[0-9a-f]{6}$/i.test(block.color || '') ? block.color.toLowerCase() : null,
      members, edges, bundles, symbol, num: numbers, labelPos,
      merged: Array.isArray(block.merged) ? [...new Set(block.merged.map(String))] : [],
    };
  }

  /* A station's own proposals to be a stop on lines it is not (yet) on: [{ line, after, author, note }]. after = the stop of
     that line it would follow (null = the very start). The station's own data — status included — is never touched. */
  const normSuggest = (suggestion) => ({
    line: String((suggestion && suggestion.line) || ''), after: suggestion && suggestion.after ? String(suggestion.after) : null,
    author: String((suggestion && suggestion.author) || '').slice(0, 24), note: String((suggestion && suggestion.note) || '').trim().slice(0, 200),
  });
  const normSuggests = (list) => {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).map(normSuggest).filter((c) => c.line && !seen.has(c.line) && seen.add(c.line));
  };

  function normStation(station, local) {
    const node = Array.isArray(station.node) ? { x: station.node[0], y: station.node[1] }
      : (station.node && typeof station.node.x === 'number' ? { x: station.node.x, y: station.node.y } : null);
    return {
      id: String(station.id),
      names: Object.assign(blankNames(), station.names),
      lat: Number(station.lat), lng: Number(station.lng),
      status: TM.STATUSES[legacyStatus(station.status)] ? legacyStatus(station.status) : 'operational',
      platform: store.normPlatforms(station.platform),
      structure: TM.STRUCTURES[station.structure] ? station.structure : 'unknown',
      opened: station.opened || null, closed: station.closed || null,
      node, author: station.status === 'planned' ? '' : station.author || '', note: station.note || '',
      linkedTo: station.linkedTo || [],
      connections: normConns(station.connections),
      block: normBlock(station.block),
      suggests: normSuggests(station.suggests),
      local: !!local || !!station.local, imported: !!station.imported,
    };
  }

  /* A station's platforms: [{ type, count }] (see TM.PLATFORMS) — a bus stop / terminal has no count. Older data held
     one type as a string: "side" was two side platforms, any other type one of it, "unknown" none known. */
  store.normPlatforms = (value) => {
    if (typeof value === 'string') return TM.PLATFORMS[value] ? [TM.PLATFORM_NO_COUNT.has(value) ? { type: value } : { type: value, count: value === 'side' ? 2 : 1 }] : [];
    const out = [];
    (Array.isArray(value) ? value : []).forEach((platform) => {
      const type = platform && (typeof platform === 'string' ? platform : platform.type);
      if (!TM.PLATFORMS[type] || out.some((o) => o.type === type)) return;
      if (TM.PLATFORM_NO_COUNT.has(type)) { out.push({ type }); return; }
      const count = Math.round(+(platform.count ?? 1));
      if (count >= 1 && count <= 99) out.push({ type, count: count });
    });
    return out;
  };
  /* the platform a line uses at a stop, towards its next / previous stop ("1", "2A", "B" …) — per line item, since one
     station can be on several lines with platforms of their own */
  const normItemPlatform = (platform) => {
    if (!platform || typeof platform !== 'object') return null;
    const result = {};
    ['next', 'prev'].forEach((k) => { const value = String(platform[k] ?? '').trim().slice(0, 12); if (value) result[k] = value; });
    return Object.keys(result).length ? result : null;
  };
  store.normItemPlatform = normItemPlatform;
  /* Which way a circle line runs when followed in its path's own order: its own "loopDir" if set, else worked out from
     its stations' real positions — the sign of the area they enclose (shoelace; east = x, north = y, so a positive
     area runs anticlockwise). null for a line that is not a loop, or too few stations to tell. */
  store.loopDir = (line) => {
    if (!line || !line.loop) return null;
    if (line.loopDir) return line.loopDir;
    const points = line.path.map((it) => it.s && store.stations.get(it.s)).filter((st) => st && isFinite(st.lat) && isFinite(st.lng));
    if (points.length < 3) return null;
    let area = 0;
    points.forEach((p, i) => { const next = points[(i + 1) % points.length]; area += p.lng * next.lat - next.lng * p.lat; });
    return Math.abs(area) < 1e-12 ? null : area > 0 ? 'anticlockwise' : 'clockwise';
  };

  function normItem(item) {
    if (typeof item === 'string') return { s: item };
    if (Array.isArray(item)) return { x: item[0], y: item[1] };
    const out = item.s != null ? { s: item.s } : { x: item.x, y: item.y };
    if (typeof item.symAt === 'number') out.symAt = item.symAt;                 // when the user last chose the symbol (newest edit wins)
    if (item.symbol && (item.symbol !== 'auto' || out.symAt)) out.symbol = item.symbol;
    if ((out.symbol === 'link' || out.symbol === 'connect') && !(item.links && item.links.length)) delete out.symbol; // old per-item link symbols: now station connections
    if (item.label) out.label = typeof item.label === 'string' ? { pos: item.label } : Object.assign({}, item.label);
    if (TM.SEG_STYLES[item.seg] && item.seg !== 'auto') out.seg = item.seg;   // style of the segment to the next item
    if (item.arc && isFinite(item.arc.b) && Math.abs(item.arc.b) >= 1e-3 && item.arc.g) out.arc = { b: Math.round(Math.max(-3, Math.min(3, +item.arc.b)) * 1e4) / 1e4, g: String(item.arc.g).slice(0, 12) };   // the leg to the next item is part of an arc section (TM.geo.arcSections)
    /* minutes from this stop to the NEXT STOP of this line (bends in between carry none), and back again (timeBack;
       absent = the same as time). A station on several lines keeps its own times on each. */
    if (isFinite(item.time) && item.time > 0) out.time = Math.round(item.time * 10) / 10;
    if (item.s != null && isFinite(item.timeBack) && item.timeBack > 0) out.timeBack = Math.round(item.timeBack * 10) / 10;
    if (typeof item.num === 'boolean') out.num = item.num;                       // number inside the symbol
    if (TM.normMark(item.mk)) out.mk = TM.normMark(item.mk);                     // a point marker here (TM.MARKS): tunnel portal, viaduct end, level crossing…
    if (item.s != null && normItemPlatform(item.platform)) out.platform = normItemPlatform(item.platform);   // { next, prev }: the platform towards the next / previous stop
    if (item.links && item.links.length) out.links = item.links.slice();           // legacy: stations joined by a link / walkway
    return out;
  }

  const normBadges = (badges) => {
    const out = {};
    ['s', 'e'].forEach((k) => { if (badges && badges[k] && (badges[k].dx || badges[k].dy)) out[k] = { dx: Math.round(badges[k].dx || 0), dy: Math.round(badges[k].dy || 0) }; });
    return out;
  };

  /* Marks either end of a line as continuing past the edge of the map (not a real terminus) — a short label, e.g. "to
     Singapore" (may be blank, just showing the "beyond" mark). Real line content, so it travels with the line itself. */
  const normBeyond = (beyond) => {
    const out = {};
    ['s', 'e'].forEach((k) => { if (beyond && typeof beyond[k] === 'string') out[k] = beyond[k].trim().slice(0, 60); else if (beyond && beyond[k]) out[k] = ''; });
    return out;
  };

  const normBends = (bends) => {
    const out = {};
    if (bends && typeof bends === 'object') Object.entries(bends).forEach(([stretchKey, points]) => {
      if (!/^[^>]+>[^>]+$/.test(stretchKey) || !Array.isArray(points)) return;
      const clean = points.filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)
        .map((p) => { const q = [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6], mk = TM.normMark(p[2]); if (mk) q.push(mk); return q; });   // a bend may carry a point marker (TM.MARKS), relative to the key's own direction
      if (clean.length) out[stretchKey] = clean;
    });
    return out;
  };

  /* Real-map line styles: { "A>B": [style | null, …] } — one entry per piece of the drawn route between stations A and B
     (A → bend → … → B, so bends + 1 pieces). null = follow the schematic's style of that stretch. */
  const normGeoSeg = (geoSegments) => {
    const out = {};
    if (geoSegments && typeof geoSegments === 'object') Object.entries(geoSegments).forEach(([stretchKey, styles]) => {
      if (!/^[^>]+>[^>]+$/.test(stretchKey) || !Array.isArray(styles)) return;
      const clean = styles.slice(0, 500).map((v) => (TM.SEG_STYLES[v] ? v : null));
      while (clean.length && clean[clean.length - 1] == null) clean.pop();
      if (clean.length) out[stretchKey] = clean;
    });
    return out;
  };

  const normCircle = (line) => {
    const circle = line.circle;
    if (!line.loop || !circle || !isFinite(circle.x) || !isFinite(circle.y) || !(circle.r > 0)) return null;
    return { x: TM.round2dp(+circle.x), y: TM.round2dp(+circle.y), r: TM.round2dp(+circle.r) };
  };
  store.normCircle = normCircle;
  store.LINE_IMAGE_MAX = 700000;   // characters of an uploaded picture's data URI (~500 KB file)
  store.normLineImage = (image) => {
    if (typeof image !== 'string' || !image) return null;
    if (/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(image)) return image.length <= store.LINE_IMAGE_MAX ? image : null;
    return TM.safeImagePath(image) ? image : null;
  };
  function normLine(line, local) {
    return {
      id: String(line.id), code: line.code || line.id,
      names: Object.assign(blankNames(), line.names),
      color: line.color || '#7c3aed', mode: line.mode || 'other', status: legacyStatus(line.status) || 'fantasy',
      author: line.author || '', style: line.style === 'orthogonal' ? 'orthogonal' : 'octilinear',
      loop: !!line.loop, default: !!line.default, created: line.created || null,
      inOut: !!line.inOut,                                                       // a traveller may enter and leave at the same station of this line (journey planner)
      circle: normCircle(line),                                                  // a loop drawn as one circle: { x, y, r } in grid units (TM.geo.circleOf)
      loopDir: line.loopDir === 'clockwise' || line.loopDir === 'anticlockwise' ? line.loopDir : null,
      loopNames: line.loopNames === 'loop' || line.loopNames === 'circle' ? line.loopNames : null,   // circle line: the planner names its ways inner / outer loop or circle (TM.loopWay); null = clockwise / anticlockwise
      traffic: line.traffic === 'right' ? 'right' : null,                       // the side its trains keep to (null = left) — which way is the outer one   // circle line: which way its path runs (null = worked out from the map, store.loopDir)
      badgeStyle: ['flag', 'picture', 'hidden'].includes(line.badgeStyle) ? line.badgeStyle : 'pill',
      image: store.normLineImage(line.image),                                    // the line's own picture: a file of the map's images/, or an uploaded data: URI (TM.lineImage)                   // line-name badge look: 'pill' (code pill past the end) | 'flag' (the line runs on a little and ends in a code box)
      badges: normBadges(line.badges),                                           // dragged line-name badges at the two ends { s: {dx,dy}, e: {dx,dy} }
      beyond: normBeyond(line.beyond),                                           // marks an end as continuing past the map's edge: { s: "label", e: "label" }
      geoBends: normBends(line.geoBends),                                        // real-map route between stations: { "A>B": [[lat, lng], …] } (never used by the schematic)
      geoSeg: normGeoSeg(line.geoSeg),                                           // real-map line style of each piece of that route (see normGeoSeg)
      path: (line.path || []).map(normItem),
      branches: normBranches(line.branches),
      lookFor: TM.LOOK_FOR[line.lookFor] && line.lookFor !== 'towards' ? line.lookFor : null,   // how the journey planner names its trains (TM.LOOK_FOR); null = towards the terminus
      schedules: TM.sched.norm(line.schedules),                                 // when its own all-stops trains run (js/schedule.js), or null
      servicesOnly: !!line.servicesOnly,                                         // run by its services only (services.json), not one all-stops service each way                                     // track leaving the main path at a junction: [{ id, path }] (see store.branchLine)
      local: !!local || !!line.local, imported: !!line.imported,
    };
  }

  /* ---------- branches ----------
     A line's track can fork: a branch is stored inside the line — { id, path: [junction, …] } — its path starting at
     the junction, a station already on the line's main path (or on one of its other branches). Everything that draws,
     routes or edits works on "track lines": the line itself and, for each branch, an in-memory line (store.branchLine)
     sharing the branch's own path array, so adding, moving or timing a branch's stops is the very same code as for any
     line. Such a branch line reads everything else (name, colour, type, status…) from its line, live. */
  const BRANCH_ID = /^[a-z0-9][a-z0-9_-]{0,15}$/;
  function normBranches(list) {
    const out = [], seen = new Set();
    (Array.isArray(list) ? list : []).forEach((branch, i) => {
      if (!branch || !Array.isArray(branch.path)) return;
      const path = branch.path.map(normItem);
      if (!path.length || path[0].s == null) return;   // a branch starts at its junction station
      let id = BRANCH_ID.test(String(branch.id)) ? String(branch.id) : 'b' + (i + 1);
      while (seen.has(id)) id += '-2';
      seen.add(id);
      out.push({ id, path, badges: normBadges(branch.badges), beyond: normBeyond(branch.beyond) });
    });
    return out;
  }
  const BRANCH_OWN = new Set(['id', 'path', 'loop', 'loopDir', 'circle', 'branches', 'badges', 'beyond', 'rootId', 'branchId']);
  const branchCache = new WeakMap();   // a branch's own data → its track line
  store.branchLine = (parent, branch) => {
    const hit = branchCache.get(branch);
    if (hit && hit.parent === parent) return hit;
    const branchLine = {};
    Object.keys(parent).forEach((key) => {
      if (!BRANCH_OWN.has(key)) Object.defineProperty(branchLine, key, { get: () => parent[key], set: (v) => { parent[key] = v; }, enumerable: true, configurable: true });
    });
    Object.defineProperties(branchLine, {
      id: { value: parent.id + '~' + branch.id, enumerable: true },
      rootId: { value: parent.id, enumerable: true },     // enumerable, so a copy of it (e.g. store.effectiveLine) still knows its line
      branchId: { value: branch.id, enumerable: true },
      parent: { value: parent }, branch: { value: branch },
      loop: { value: false, enumerable: true }, loopDir: { value: null, enumerable: true }, circle: { value: null, enumerable: true },
      branches: { value: [] },
      path: { get: () => branch.path, set: (v) => { branch.path = v; }, enumerable: true },
      badges: { get: () => branch.badges, set: (v) => { branch.badges = v; }, enumerable: true },
      beyond: { get: () => branch.beyond, set: (v) => { branch.beyond = v; }, enumerable: true },
    });
    branchCache.set(branch, branchLine);
    return branchLine;
  };
  store.branchesOf = (line) => (line && !line.rootId ? (line.branches || []).map((b) => store.branchLine(line, b)) : []);
  /* a line or a branch of one ("CCL~db"), by id */
  store.line = (id) => {
    if (id == null) return null;
    const line = store.lines.get(id);
    if (line) return line;
    const i = String(id).indexOf('~'), parent = i > 0 ? store.lines.get(String(id).slice(0, i)) : null;
    const branch = parent && (parent.branches || []).find((x) => x.id === String(id).slice(i + 1));
    return branch ? store.branchLine(parent, branch) : null;
  };
  store.rootId = (l) => (typeof l === 'string' ? l.split('~')[0] : l ? l.rootId || l.id : null);
  store.rootLine = (l) => store.lines.get(store.rootId(l)) || null;
  /* every track line — each line followed by its branches — of the given line ids (default: all lines) */
  store.trackLines = (ids) => (ids ? ids.map((id) => store.lines.get(id)) : [...store.lines.values()]).filter(Boolean).flatMap((l) => [l, ...store.branchesOf(l)]);

  const compactItem = (item) => {
    const extra = Object.keys(item).some((k) => !['s', 'x', 'y'].includes(k));
    if (extra) return item;
    return item.s != null ? item.s : [item.x, item.y];
  };

  /* ---------- loading ---------- */
  store.load = async function () {
    const meta = TM.maps.current;
    store.anchor = Object.assign({}, DEFAULT_ANCHOR, meta && meta.anchor);
    store.userMap = TM.maps.isUser(meta);
    store.stations.clear(); store.lines.clear();
    let base_services = null;
    if (!store.userMap) {
      const base = await TM.maps.readFiles(meta);
      base_services = base.services;
      base.stations.forEach((s) => store.stations.set(String(s.id), normStation(s)));
      base.lines.forEach((l) => store.lines.set(String(l.id), normLine(l)));
    }
    store.services = store.normServices(store.userMap ? null : base_services);

    let saved = {};
    saved = TM.storage.getJSON(lsKey(), {});
    (saved.stations || []).forEach((s) => store.stations.set(String(s.id), normStation(s, true)));
    (saved.lines || []).forEach((l) => store.lines.set(String(l.id), normLine(l, true)));
    if (store.userMap) store.services = store.normServices(saved.services);   // a map made in this browser keeps its services with it
    store.author = saved.author || 'me';
    store.suggestEdits = (Array.isArray(saved.suggest) ? saved.suggest : []).filter((e) => e && e.station && e.line).map((e) => (e.off
      ? { station: String(e.station), line: String(e.line), off: true }
      : Object.assign({ station: String(e.station) }, normSuggest(e))));
    store.suggestView = {};
    if (saved.suggestView && typeof saved.suggestView === 'object') Object.entries(saved.suggestView).forEach(([id, v]) => { if (store.lines.has(id) && (v === 'show' || v === 'hide')) store.suggestView[id] = v; });
    store.linkEdits = (saved.links || []).filter((e) => e && e.a && e.b).map((e) => {
      const out = { a: String(e.a), b: String(e.b), type: TM.LINK_TYPES[e.type] ? e.type : null };
      const bends = normBendPts(e.bends);
      if (bends.length) out.bends = bends;
      Object.assign(out, normTimes(e));
      return normConnLook(e, out);
    });
    store.codeLabels = Object.assign({}, meta && meta.codes, saved.codes && typeof saved.codes === 'object' ? saved.codes : {});
    store.labelPos = {};
    /* where station names sit: the map's own baseline (map.json → labelPos, parallel to codes) plus this browser's overlay */
    const lpAll = Object.assign({}, meta && meta.labelPos, saved.labelPos && typeof saved.labelPos === 'object' ? saved.labelPos : {});
    Object.entries(lpAll).forEach(([id, value]) => {
      if (!value || typeof value !== 'object') return;
      const clean = {};
      if (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].includes(value.pos)) clean.pos = value.pos;
      if (isFinite(value.dx) && Math.round(value.dx)) clean.dx = Math.round(value.dx);
      if (isFinite(value.dy) && Math.round(value.dy)) clean.dy = Math.round(value.dy);
      if (value.hide) clean.hide = true;
      if (isFinite(value.size) && value.size > 0) clean.size = Math.min(40, Math.max(6, Math.round(value.size)));
      if (TM.normAngle(value.rot)) clean.rot = TM.normAngle(value.rot);
      if (Object.keys(clean).length) store.labelPos[id] = clean;
    });
    /* a shipped map's own baseline annotations (map.json → annotations, parallel to codes) plus this browser's overlay */
    store.annotations = {};
    Object.entries(Object.assign({}, meta && meta.annotations, saved.annotations)).forEach(([id, a]) => { const annotation = normAnnotation(a); if (annotation) store.annotations[id] = annotation; });
    store.drawing = store.normDrawingLayer(saved.drawing !== undefined ? saved.drawing : meta && meta.drawing);
    store.calendar = TM.sched.normCalendar(saved.calendar !== undefined ? saved.calendar : meta && meta.calendar);   // public holidays + default time zone for schedules
    store.legend = store.normLegend(saved.legend !== undefined ? saved.legend : meta && meta.legend);
    store.geoMoves = {};
    Object.entries(saved.geo || {}).forEach(([id, node]) => {
      const station = store.stations.get(id);
      if (station && !station.local && Array.isArray(node) && isFinite(node[0]) && isFinite(node[1])) { station.origGeo = { lat: station.lat, lng: station.lng }; station.lat = +node[0]; station.lng = +node[1]; store.geoMoves[id] = [+node[0], +node[1]]; }
    });
    store.bendEdits = {};
    Object.entries(saved.bends || {}).forEach(([id, bends]) => {
      const line = store.lines.get(id);
      if (line && !line.local) { line.origBends = line.geoBends; line.geoBends = normBends(bends); store.bendEdits[id] = line.geoBends; }
    });
    store.blockEdits = {};
    Object.entries(saved.blocks || {}).forEach(([id, block]) => {
      const station = store.stations.get(id);
      if (station && !station.local) { station.origBlock = station.block; station.block = normBlock(block); store.blockEdits[id] = station.block; }
    });
    store.moves = {};
    Object.entries(saved.moves || {}).forEach(([id, node]) => {
      const station = store.stations.get(id);
      if (station && !station.local && Array.isArray(node)) { station.origNode = station.node ? { x: station.node.x, y: station.node.y } : null; station.node = { x: node[0], y: node[1] }; store.moves[id] = node; }
    });
    store.numMode = {};
    if (saved.numMode && typeof saved.numMode === 'object') Object.entries(saved.numMode).forEach(([id, v]) => { if (['none', 'code', 'full', 'ordinal'].includes(v)) store.numMode[id] = v; });
    store.background = null;
    if (saved.background && typeof saved.background === 'object' && typeof saved.background.dataUri === 'string') {
      const background = saved.background;
      store.background = {
        file: String(background.file || 'background.png'), dataUri: background.dataUri,
        x: isFinite(background.x) ? background.x : -400, y: isFinite(background.y) ? background.y : -300,
        w: isFinite(background.w) && background.w > 10 ? background.w : 800, h: isFinite(background.h) && background.h > 10 ? background.h : 600,
        opacity: isFinite(background.opacity) ? Math.min(1, Math.max(0.05, background.opacity)) : 1, visible: background.visible !== false,
      };
    }
    const visible = saved.visible ? saved.visible.filter((id) => store.lines.has(id))
      : (store.lines.size && ![...store.lines.values()].some((l) => l.default) ? [...store.lines.keys()] : [...store.lines.values()].filter((l) => l.default).map((l) => l.id));   // no line flagged default: show them all
    store.visible = new Set(visible);
    /* The top-bar line filter is independent of the eye state. Existing saves predate this filter, so they start with
       every current line selected; an explicit saved [] remains a deliberate "show none" choice. */
    const filtered = Array.isArray(saved.lineFilter) ? saved.lineFilter.filter((id) => store.lines.has(id)) : [...store.lines.keys()];
    store.lineFilter = new Set(filtered);
    TM.state.activeLineId = store.line(saved.active) && store.lineFilter.has(store.rootId(saved.active)) ? saved.active : null;   // a branch too
    store._invalidate();
    if (TM.history) TM.history.reset();
  };

  store._invalidate = () => { store._nodes = null; store._groups = null; store._conns = null; store._complex = null; store._sugg = null; store._track = null; store._svcRoutes = null; };

  store.save = function (silent) {
    store._invalidate();
    try {
      TM.storage.set(lsKey(), JSON.stringify({
        author: store.author,
        visible: [...store.visible],
        lineFilter: [...store.lineFilter],
        active: TM.state.activeLineId,
        moves: store.moves,
        geo: store.geoMoves,
        bends: store.bendEdits,
        blocks: store.blockEdits,
        links: store.linkEdits,
        suggest: store.suggestEdits,
        suggestView: store.suggestView,
        codes: store.codeLabels,
        labelPos: store.labelPos,
        numMode: store.numMode,
        annotations: store.annotations,
        legend: store.legend,
        calendar: store.calendar,
        drawing: store.drawing,
        background: store.background,
        stations: [...store.stations.values()].filter((s) => s.local).map(store.stationOut),
        lines: [...store.lines.values()].filter((l) => l.local).map(store.lineOut),
        services: store.userMap ? store.servicesOut() : undefined,
      }));
    } catch (e) {
      if (!store._warned) { store._warned = true; TM.toast('This browser could not store your changes (storage full or blocked). Export the map as a zip so nothing is lost.', 'err'); }
    }
    if (TM.history) TM.history.touch();
    if (!silent) TM.emit('change');
  };

  /* ---------- undo / redo snapshots ----------
     Everything the map's data is made of (stations and lines as held in memory — shipped ones with this user's changes
     applied — plus every overlay of edits and view preferences that belong to the map), but not the view state (which lines
     are shown / filtered, the line being edited, the author name). The background image's data URI is kept aside as a
     plain reference so a hundred snapshots do not hold a hundred copies of the picture. */
  store.snapshot = () => {
    const background = store.background;
    return {
      json: JSON.stringify({
        stations: [...store.stations.values()], lines: [...store.lines.values()], services: store.services,
        moves: store.moves, geoMoves: store.geoMoves, blockEdits: store.blockEdits, bendEdits: store.bendEdits, linkEdits: store.linkEdits, suggestEdits: store.suggestEdits,
        codeLabels: store.codeLabels, labelPos: store.labelPos, numMode: store.numMode, annotations: store.annotations, legend: store.legend, drawing: store.drawing, calendar: store.calendar,
        background: background ? Object.assign({}, background, { dataUri: undefined }) : null,
      }),
      bgUri: background ? background.dataUri : null,
    };
  };
  store.sameSnapshot = (a, b) => !!a && !!b && a.bgUri === b.bgUri && a.json === b.json;
  store.restore = (snap) => {
    const data = JSON.parse(snap.json), hadLine = new Set(store.lines.keys());
    store.stations.clear(); data.stations.forEach((s) => store.stations.set(s.id, s));
    store.lines.clear(); data.lines.forEach((l) => store.lines.set(l.id, l));
    store.services = data.services || [];
    ['moves', 'geoMoves', 'blockEdits', 'bendEdits', 'linkEdits', 'suggestEdits', 'codeLabels', 'labelPos', 'numMode', 'annotations', 'legend', 'drawing', 'calendar'].forEach((k) => { store[k] = data[k]; });
    /* an overlay entry and the record it was applied to are one object in memory (see load) — keep them so */
    Object.keys(store.blockEdits).forEach((id) => { const station = store.stations.get(id); if (station) store.blockEdits[id] = station.block; });
    Object.keys(store.bendEdits).forEach((id) => { const line = store.lines.get(id); if (line) store.bendEdits[id] = line.geoBends; });
    store.background = data.background ? Object.assign(data.background, { dataUri: snap.bgUri }) : null;
    /* a line brought back (e.g. undoing its deletion) is shown again; the line being edited / the selection must still exist */
    store.lines.forEach((l, id) => { if (!hadLine.has(id)) { store.visible.add(id); store.lineFilter.add(id); } });
    if (!store.line(TM.state.activeLineId)) TM.state.activeLineId = null;
    const selection = TM.state.selected, activeLine = store.line(TM.state.activeLineId);
    const still = !selection || (selection.type === 'station' && store.stations.has(selection.id)) || (selection.type === 'ann' && store.annotations[selection.id])
      || (selection.type === 'badge' && store.line(selection.line)) || (selection.type === 'draw' && store.drawingById(selection.id)) || (selection.type === 'conn' && store.stations.has(selection.a) && store.stations.has(selection.b)) || (selection.type === 'wp' && activeLine && activeLine.path[selection.index] && !activeLine.path[selection.index].s);
    if (!still) { TM.state.selected = null; TM.state.moving = false; }
    store.save();
    TM.emit('selection');
  };

  /* ---------- serialisation ---------- */
  store.stationOut = (station) => {
    const result = {
      id: station.id,
      names: station.names, lat: +station.lat.toFixed(6), lng: +station.lng.toFixed(6), status: station.status, platform: station.platform, structure: station.structure,
      opened: station.opened, closed: station.closed, node: station.node ? [station.node.x, station.node.y] : null,
    };
    if (station.author && station.status !== 'planned') result.author = station.author;   // a planned station is nobody's suggestion
    if (station.note) result.note = station.note;
    if (station.linkedTo.length) result.linkedTo = station.linkedTo;
    if (station.connections.length) result.connections = station.connections.map((c) => Object.assign({ to: c.to, type: c.type }, connExtras(c)));
    if (station.block) result.block = station.block;
    if (station.suggests && station.suggests.length) result.suggests = station.suggests.map((c) => { const copy = { line: c.line, after: c.after }; if (c.author) copy.author = c.author; if (c.note) copy.note = c.note; return copy; });
    if (station.imported) result.imported = true;
    return result;
  };

  store.lineOut = (line) => {
    const result = {
      id: line.id, code: line.code, mode: line.mode, status: line.status, author: line.author, names: line.names,
      color: line.color, style: line.style,
    };
    if (line.loop) result.loop = true;
    if (line.inOut) result.inOut = true;
    if (line.loop && line.loopDir) result.loopDir = line.loopDir;
    if (line.loop && line.loopNames) result.loopNames = line.loopNames;
    if (line.loop && line.traffic) result.traffic = line.traffic;
    if (line.loop && line.circle) result.circle = normCircle(line);
    if (line.servicesOnly) result.servicesOnly = true;
    if (line.schedules) result.schedules = line.schedules;
    if (line.lookFor) result.lookFor = line.lookFor;
    if (line.default) result.default = true;
    if (line.created) result.created = line.created;
    if (line.badgeStyle && line.badgeStyle !== 'pill') result.badgeStyle = line.badgeStyle;
    if (store.normLineImage(line.image)) result.image = line.image;
    const badges = normBadges(line.badges);
    if (Object.keys(badges).length) result.badges = badges;
    const beyond = normBeyond(line.beyond);
    if (Object.keys(beyond).length) result.beyond = beyond;
    if (line.geoBends && Object.keys(line.geoBends).length) result.geoBends = line.geoBends;
    const geoSegments = normGeoSeg(line.geoSeg);
    if (Object.keys(geoSegments).length) result.geoSeg = geoSegments;
    result.path = line.path.map(compactItem);
    if (line.branches && line.branches.length) result.branches = line.branches.map((branch) => {
      const x = { id: branch.id, path: branch.path.map(compactItem) };
      const branchBadges = normBadges(branch.badges), branchBeyond = normBeyond(branch.beyond);
      if (Object.keys(branchBadges).length) x.badges = branchBadges;
      if (Object.keys(branchBeyond).length) x.beyond = branchBeyond;
      return x;
    });
    if (line.imported) result.imported = true;
    return result;
  };

  /* Shared (non-local) stations this user moved, or whose links they changed, as full records. */
  store.movedStations = () => [...new Set([...Object.keys(store.moves), ...Object.keys(store.geoMoves)])].map((id) => store.stations.get(id)).filter(Boolean);
  store.linkTouched = () => {
    const ids = new Set();
    store.linkEdits.forEach((e) => { ids.add(e.a); ids.add(e.b); });
    return [...ids].map((id) => store.stations.get(id)).filter((s) => s && !s.local);
  };
  store.exportStations = () => {
    const seen = new Set(), out = [];
    store.exportNewStations().forEach((o) => { seen.add(o.id); out.push(o); });
    store.movedStations().concat(store.linkTouched(), store.suggestTouched()).forEach((station) => {
      if (seen.has(station.id)) return;
      seen.add(station.id);
      const result = store.stationOut(station); delete result.imported;
      const suggestions = store.suggestionsOfStation(station.id).map((c) => { const copy = { line: c.line, after: c.after }; if (c.author) copy.author = c.author; if (c.note) copy.note = c.note; return copy; });
      if (suggestions.length) result.suggests = suggestions; else delete result.suggests;
      const conns = store.connectionsOf(station.id).map((c) => Object.assign({ to: c.other, type: c.type }, connExtras(c)));
      if (conns.length) result.connections = conns; else delete result.connections;
      out.push(result);
    });
    return out;
  };
  store.resetMove = (id) => {
    let changed = false;
    store.members(id).forEach((memberId) => {
      const station = store.stations.get(memberId);
      if (station && store.moves[memberId]) { station.node = station.origNode; delete store.moves[memberId]; changed = true; }
      if (station && store.geoMoves[memberId] && station.origGeo) { station.lat = station.origGeo.lat; station.lng = station.origGeo.lng; delete store.geoMoves[memberId]; changed = true; }
    });
    if (changed) store.save();
  };
  store.isMoved = (id) => store.members(id).some((mid) => !!store.moves[mid] || !!store.geoMoves[mid]);

  /* Block (mega-station) config lives on the group's representative station; reset brings the shipped one back. */
  store.resetBlock = (repId) => {
    const station = store.stations.get(repId);
    if (!station || !Object.prototype.hasOwnProperty.call(store.blockEdits, repId)) return false;
    station.block = station.origBlock || null; delete station.origBlock; delete store.blockEdits[repId];
    store.save();
    return true;
  };
  store.isBlockEdited = (id) => Object.prototype.hasOwnProperty.call(store.blockEdits, store.rep(id));
  /* The station that actually holds a .block for id's complex: normally id's own rep, but a station split-interchanged
     with a different name (sharing the drawn symbol, never merged into one rep by store.rep) can hold it instead — so a block
     configured on either partner must still be found when the other one is selected / iterated. null when neither has one. */
  store.blockOwnerOf = (id) => {
    const leadId = store.rep(id);
    if (store.stations.get(leadId) && store.stations.get(leadId).block) return leadId;
    const complex = store.complexOf(leadId), reps = (store._complex && store._complex.members.get(complex)) || [leadId];
    for (const r of reps) { const station = store.stations.get(r); if (station && station.block) return r; }
    /* not part of the owner's own interchange complex — maybe merged into someone else's block as a connecting station
       (a merge is a view-only relationship, not a real interchange, so store.complexOf above never sees it) */
    const set = new Set(store.members(id));
    for (const [sid, st] of store.stations) {
      if (st.block && (st.block.merged || []).some((mid) => set.has(mid))) return sid;
    }
    return null;
  };
  /* Partition a block's member ids into ring "slots": stations sharing the same bundles[] group key are one slot (one
     shared symbol), everyone else is their own slot. Order follows memberIds (first appearance of each group wins). */
  store.blockGroups = (memberIds, bundles) => {
    const byGroup = new Map(), order = [];
    memberIds.forEach((id) => {
      const groupKey = (bundles && bundles[id]) || '_' + id;
      if (!byGroup.has(groupKey)) { byGroup.set(groupKey, []); order.push(groupKey); }
      byGroup.get(groupKey).push(id);
    });
    return order.map((g) => ({ key: g, ids: byGroup.get(g) }));
  };
  /* Which block (if any) a raw station id is shown in, and its ring slot: { owner, key, ids }. ids.length > 1 means id is
     bundled with others under one shared symbol. null when id is not inside any block. */
  store.blockSlotOf = (id) => {
    const owner = store.blockOwnerOf(id);
    if (!owner) return null;
    const block = store.stations.get(owner).block;
    const memberIds = [...store.complexMembers(owner), ...(block.merged || []).filter((m) => store.stations.has(m))];
    if (!memberIds.includes(id)) return null;
    const group = store.blockGroups(memberIds, block.bundles).find((g) => g.ids.includes(id));
    return group ? { owner, key: group.key, ids: group.ids } : null;
  };

  store.exportLine = (id) => store.lineOut(store.lines.get(id));

  /* The whole open map as plain records (your changes included): used to copy it into a new map or export it as a zip.
     Effective links are written on the first station of each pair. */
  store.canonStation = (s) => store.stationOut(normStation(s));
  store.canonLine = (l) => store.lineOut(normLine(l));
  store.snapshotData = () => {
    const own = new Map();
    store.connections().forEach((c) => (own.get(c.a) || own.set(c.a, []).get(c.a)).push(Object.assign({ to: c.b, type: c.type }, connExtras(c))));
    const stations = [...store.stations.values()].map((station) => {
      const result = store.stationOut(station); delete result.imported;
      if (own.has(station.id)) result.connections = own.get(station.id); else delete result.connections;
      const suggestions = store.suggestionsOfStation(station.id).map((c) => { const copy = { line: c.line, after: c.after }; if (c.author) copy.author = c.author; if (c.note) copy.note = c.note; return copy; });   // your overlay ones too
      if (suggestions.length) result.suggests = suggestions; else delete result.suggests;
      return result;
    });
    const lines = [...store.lines.values()].map((l) => { const result = store.lineOut(l); delete result.imported; return result; });
    return { stations, lines, services: store.servicesOut(), codes: JSON.parse(JSON.stringify(store.codeLabels)), labelPos: JSON.parse(JSON.stringify(store.labelPos)), annotations: JSON.parse(JSON.stringify(store.annotations)), legend: store.legend ? JSON.parse(JSON.stringify(store.legend)) : null, drawing: JSON.parse(JSON.stringify(store.drawing)), calendar: JSON.parse(JSON.stringify(store.calendar)) };
  };

  /* Real-map bends of the segment a → b of a line (a and b are the ids on its path): [[lat, lng], …] in that direction. */
  store.routeBends = (line, stationA, stationB) => {
    const geoBends = line && line.geoBends;
    if (!geoBends) return [];
    if (geoBends[stationA + '>' + stationB]) return geoBends[stationA + '>' + stationB];
    return geoBends[stationB + '>' + stationA] ? geoBends[stationB + '>' + stationA].slice().reverse().map((p) => (p[2] ? [p[0], p[1], TM.flipMark(p[2])] : p)) : [];   // read the other way: a marker's side turns round too
  };
  /* ---------- real-map route: station pairs, the style of each piece, lengths ---------- */
  /* Consecutive stations of a line on the real map (bends of the schematic have no coordinates and are skipped), with the
     schematic style of the stretch between them; a loop line also joins its last station back to its first. */
  store.geoPairs = (line) => {
    const out = [], path = line.path;
    let prev = null, prevIdx = -1;
    path.forEach((item, i) => {
      const station = item.s && store.stations.get(item.s);
      if (!station) return;
      if (prev) out.push({ a: prev, b: station, seg: path[prevIdx].seg || 'auto', sug: !!(path[prevIdx].sug || item.sug) });   // sug: a stretch touching a suggested stop
      prev = station; prevIdx = i;
    });
    const first = path.find((it) => it.s && store.stations.get(it.s));
    if (line.loop && out.length >= 2 && prev && first && first.s !== prev.id) out.push({ a: prev, b: store.stations.get(first.s), seg: path[prevIdx].seg || 'auto', closing: true, sug: !!(path[prevIdx].sug || first.sug) });
    return out;
  };
  /* the stored per-piece styles of the stretch a → b, in that direction ([] when none) */
  store.geoSegOf = (line, stationA, stationB) => {
    const geoSegments = line && line.geoSeg;
    if (!geoSegments) return [];
    if (geoSegments[stationA + '>' + stationB]) return geoSegments[stationA + '>' + stationB].slice();
    return geoSegments[stationB + '>' + stationA] ? geoSegments[stationB + '>' + stationA].slice().reverse() : [];
  };
  const GEO_NOT_SOLID = new Set(['under_construction', 'provisional', 'planned']);
  /* What each piece of a stretch is drawn as: its own real-map choice, else the schematic's; 'auto' then follows the two
     stations' status — dotted between two abandoned / demolished stations, dashed next to one not yet open. */
  store.geoPieceStyles = (line, pair, count) => {
    if (pair.sug) return Array.from({ length: count }, () => ({ raw: 'auto', drawn: 'dash', sug: true }));   // proposed track: always dashed, apart from the line's real styles
    const own = store.geoSegOf(line, pair.a.id, pair.b.id), gone = (s) => s.status === 'abandoned' || s.status === 'demolished';
    const auto = gone(pair.a) && gone(pair.b) ? 'dotted' : GEO_NOT_SOLID.has(pair.a.status) || GEO_NOT_SOLID.has(pair.b.status) ? 'dash' : 'solid';
    return Array.from({ length: count }, (_, j) => {
      const raw = own[j] || pair.seg || 'auto';
      return { raw, drawn: raw === 'auto' ? auto : raw };
    });
  };
  /* Length of a line on the real map, in metres: in total and by the style each piece is drawn in. */
  store.geoLengths = (line) => {
    const byStyle = {}, byStruct = {};
    let total = 0;
    const structs = store.geoStructures(line);
    store.geoPairs(line).forEach((pair, p) => {
      const chain = [[pair.a.lat, pair.a.lng], ...store.routeBends(line, pair.a.id, pair.b.id), [pair.b.lat, pair.b.lng]];
      const styles = store.geoPieceStyles(line, pair, chain.length - 1);
      for (let j = 0; j < chain.length - 1; j++) {
        const distance = TM.haversine(chain[j][0], chain[j][1], chain[j + 1][0], chain[j + 1][1]);
        if (!isFinite(distance)) continue;
        const key = styles[j].sug ? 'suggested' : styles[j].drawn, st = structs[p][j] || 'grade';
        byStyle[key] = (byStyle[key] || 0) + distance; byStruct[st] = (byStruct[st] || 0) + distance; total += distance;
      }
    });
    return { total, by: byStyle, struct: byStruct };
  };
  /* Structure of every piece of a line on the real map, from the markers on its route bends: [pair][piece] →
     'tunnel' | 'elevated' | null, pairs as store.geoPairs gives them. */
  store.geoStructures = (line) => {
    const pairs = store.geoPairs(line), marks = [], where = [];
    pairs.forEach((pair, p) => {
      const bends = store.routeBends(line, pair.a.id, pair.b.id);
      if (!p) marks.push(null);
      bends.forEach((b) => marks.push(b[2] || null));
      marks.push(null);
      for (let j = 0; j <= bends.length; j++) where.push([p, j]);
    });
    const legs = TM.structureLegs(marks), out = pairs.map(() => []);
    where.forEach(([p, j], n) => { out[p][j] = legs[n]; });
    return out;
  };

  store.exportNewStations = () => [...store.stations.values()].filter((station) => station.local && !station.imported).map((station) => {
    const result = store.stationOut(station); delete result.imported; return result;
  });

  /* ---------- ids ---------- */
  /* A short hash of "when + what" is appended so a few people creating stations/lines locally, then exporting under the
     same running number, do not clash when their work is later combined. */
  const idHash = (name, code) => TM.shortHash(`${Date.now()}|${name || ''}|${code || ''}`);
  store.nextFantasyCode = (name, code) => {
    let max = 0;
    store.stations.forEach((s, id) => { const match = /^FTSY(\d+)/.exec(id); if (match) max = Math.max(max, +match[1]); });
    return `FTSY${max + 1}-${idHash(name, code)}`;
  };
  store.nextLineId = (name, code) => {
    let number = 1;
    while (store.lines.has('FL' + number) || [...store.lines.keys()].some((id) => id.startsWith('FL' + number + '-'))) number++;
    return `FL${number}-${idHash(name, code)}`;
  };

  /* ---------- mutations ---------- */
  store.addStation = (s) => { const station = normStation(s, true); store.stations.set(station.id, station); store.save(); return station; };
  store.updateStation = (id, patch) => {
    if ('platform' in patch) patch = Object.assign({}, patch, { platform: store.normPlatforms(patch.platform) });
    Object.assign(store.stations.get(id), patch); store.save();
  };
  store.addLine = (l) => { const line = normLine(l, true); store.lines.set(line.id, line); store.visible.add(line.id); store.lineFilter.add(line.id); store.save(); return line; };
  store.removeLine = (id) => {
    store.lines.delete(id); store.visible.delete(id); store.lineFilter.delete(id);
    if (TM.state.activeLineId === id) TM.state.activeLineId = null;
    store.save();
  };
  store.removeStation = (id) => {
    store.stations.delete(id);
    store.lines.forEach((line) => {
      line.path = line.path.filter((it) => it.s !== id);
      /* a branch loses the stop too — and the whole branch if it was its junction */
      if (line.branches) line.branches = line.branches.filter((b) => b.path[0].s !== id).map((b) => Object.assign(b, { path: b.path.filter((it) => it.s !== id) }));
    });
    store.stations.forEach((s) => { s.connections = s.connections.filter((c) => c.to !== id); });
    store.linkEdits = store.linkEdits.filter((e) => e.a !== id && e.b !== id);
    store.suggestEdits = store.suggestEdits.filter((e) => e.station !== id);
    store.save();
  };
  /* ---------- suggested stops ----------
     A suggestion says "this station could be a stop on that line, after that stop" without touching the station or the line.
     It is written on the station's record when this user may write it (their own station — see actions.recordEditable), otherwise
     kept as a local overlay in suggestEdits, exactly like a link on a station they do not own. Both are merged here. */
  store.suggestions = () => {
    if (store._sugg) return store._sugg;
    const map = new Map();
    store.stations.forEach((st) => (st.suggests || []).forEach((sg) => map.set(st.id + '|' + sg.line, Object.assign({ station: st.id, src: 'record' }, sg))));
    store.suggestEdits.forEach((e) => {
      const key = e.station + '|' + e.line;
      if (e.off) map.delete(key); else map.set(key, { station: e.station, line: e.line, after: e.after || null, author: e.author || '', note: e.note || '', src: 'local' });
    });
    /* one that no longer applies (its station or line is gone, or the line now calls there anyway) is not listed */
    return (store._sugg = [...map.values()].filter((suggestion) => {
      const line = store.lines.get(suggestion.line);
      if (!line || !store.stations.has(suggestion.station)) return false;
      const set = new Set(store.members(suggestion.station));
      return !line.path.some((it) => it.s && set.has(it.s));
    }));
  };
  store.suggestionsFor = (lineId) => store.suggestions().filter((sg) => sg.line === lineId);
  store.suggestionsOfStation = (id) => store.suggestions().filter((sg) => sg.station === id);
  /* Whether a line draws its suggested stops: its own Show / Hide choice, else the canvas-wide setting (globalOn). */
  store.suggestShown = (lineId, globalOn) => (store.suggestView[lineId] === 'show' ? true : store.suggestView[lineId] === 'hide' ? false : globalOn !== false);
  store.setSuggestView = (lineId, v) => { if (v === 'show' || v === 'hide') store.suggestView[lineId] = v; else delete store.suggestView[lineId]; store.save(true); };

  /* The line's path with its suggested stops put in: [{ it, orig }] (orig = index in the real path, -1 for a suggested
     stop, which also carries { sug, station }). A suggestion goes right after the stop it names — after any other
     suggestion already there — or at the start; one whose stop is not on the line (any more) goes at the end. */
  store.pathWithSuggestions = (line) => {
    const list = store.suggestionsFor(line.id);
    if (!list.length) return null;
    const path = line.path.map((it, i) => ({ it, orig: i }));
    let pending = list.slice(), progressed = true;
    const insert = (sg, at, lost) => { path.splice(at, 0, { it: null, orig: -1, sug: true, station: sg.station, after: sg.after, lost: !!lost }); };
    while (pending.length && progressed) {
      progressed = false;
      pending = pending.filter((suggestion) => {
        let at = 0;
        if (suggestion.after) {
          const index = path.findIndex((p) => (p.sug ? p.station : p.it.s) === suggestion.after);
          if (index < 0) return true;
          at = index + 1;
          while (path[at] && path[at].sug && path[at].after === suggestion.after) at++;
        }
        insert(suggestion, at); progressed = true; return false;
      });
    }
    pending.forEach((sg) => insert(sg, path.length, true));
    return path;
  };
  /* The line as drawn: a copy whose path has its shown suggested stops in — { s, sug: true } items, segments to and from
     them dashed — and origIdx (effective index -> real index, -1 for a suggested one). The line itself when nothing shows. */
  store.effectiveLine = (line, globalOn) => {
    if (!store.suggestShown(line.id, globalOn)) return line;
    const withSuggestions = store.pathWithSuggestions(line);
    if (!withSuggestions) return line;
    const path = withSuggestions.map((p, i) => (p.sug ? { s: p.station, sug: true, seg: 'dash' } : withSuggestions[i + 1] && withSuggestions[i + 1].sug ? Object.assign({}, p.it, { seg: 'dash' }) : p.it));
    return Object.assign({}, line, { path, origIdx: withSuggestions.map((p) => p.orig), suggested: true });
  };

  store.addSuggestion = (suggestion) => {
    const station = store.stations.get(suggestion.station), clean = normSuggest(suggestion);
    if (!station || !clean.line || !store.lines.has(clean.line)) return false;
    store.suggestEdits = store.suggestEdits.filter((e) => !(e.station === suggestion.station && e.line === clean.line));
    if (TM.actions.recordEditable(station)) station.suggests = normSuggests([...(station.suggests || []).filter((x) => x.line !== clean.line), clean]);
    else store.suggestEdits.push(Object.assign({ station: suggestion.station }, clean));
    store.save();
    return true;
  };
  store.removeSuggestion = (station, line) => {
    const record = store.stations.get(station);
    store.suggestEdits = store.suggestEdits.filter((e) => !(e.station === station && e.line === line));
    if (record && (record.suggests || []).some((x) => x.line === line)) {
      if (TM.actions.recordEditable(record)) record.suggests = record.suggests.filter((x) => x.line !== line);
      else store.suggestEdits.push({ station, line, off: true });
    }
    store.save();
  };
  /* Suggestions that arrived with imported station records for stations we already have: kept as this user's local
     overlay (the shipped record is never modified). Returns how many were new. */
  store.mergeSuggests = (station, list) => {
    let count = 0;
    normSuggests(list).forEach((suggestion) => {
      if (store.suggestions().some((x) => x.station === station && x.line === suggestion.line && x.after === suggestion.after)) return;
      store.suggestEdits = store.suggestEdits.filter((e) => !(e.station === station && e.line === suggestion.line));
      store.suggestEdits.push(Object.assign({ station }, suggestion)); store._invalidate(); count++;
    });
    return count;
  };
  /* stations whose suggestions live in this user's overlay, as full records with the effective suggestions (for export) */
  store.suggestTouched = () => [...new Set(store.suggestEdits.map((e) => e.station))].map((id) => store.stations.get(id)).filter((s) => s && !s.local);

  /* the lines calling at a station — a branch counts as its own line (each line listed once) */
  const rootsOf = (tracks) => [...new Set(tracks.map((l) => store.rootLine(l)).filter(Boolean))];
  store.usedBy = (id) => rootsOf(store.trackLines().filter((l) => l.path.some((it) => it.s === id)));
  /* Every line item (path entry) at this station or at any station it is an interchange with: [{ line, item }]. */
  store.itemsOf = (id) => {
    const set = new Set(store.members(id)), out = [];
    let rank = 0;
    store.trackLines().forEach((l) => { l.path.forEach((it) => { if (it.s && set.has(it.s)) out.push({ line: l, item: it, rank }); }); rank++; });
    return out;
  };
  /* Every raw station id drawn with the SAME one symbol as id: its same-name group plus interchange partners (an
     "interchange" link, or a same-platform link between different names) standing on the very same node — render.js
     merges those into one shared symbol, so the symbol choice belongs to all of them together. */
  store.shareMembers = (id) => {
    const nodeKey = (r) => { const node = store.nodeOf(r); return node ? node.x + ',' + node.y : ''; };
    const start = store.rep(id), seen = new Set([start]), queue = [start], links = store.splitLinks();
    while (queue.length) {
      const current = queue.shift();
      links.forEach((connection) => {
        const leadA = store.rep(connection.a), leadB = store.rep(connection.b), other = leadA === current ? leadB : leadB === current ? leadA : null;
        if (other && !seen.has(other) && nodeKey(other) && nodeKey(other) === nodeKey(current)) { seen.add(other); queue.push(other); }
      });
    }
    return [...seen].flatMap((r) => store.members(r));
  };
  /* Every line item whose symbol choice decides how id's (possibly shared) symbol is drawn: [{ line, item, rank }]. */
  store.symbolItemsOf = (id) => {
    const set = new Set(store.shareMembers(id)), out = [];
    let rank = 0;
    store.trackLines().forEach((l) => { l.path.forEach((it) => { if (it.s && set.has(it.s)) out.push({ line: l, item: it, rank }); }); rank++; });
    return out;
  };
  /* Same, but only this exact raw station id — not its whole same-name interchange group. A block gives each of its
     members (even ones that would otherwise share one interchange symbol) an independent one, so its Symbol picker needs
     this instead of store.itemsOf. */
  store.itemsOfExact = (id) => {
    const out = [];
    let rank = 0;
    store.trackLines().forEach((l) => { l.path.forEach((it) => { if (it.s === id) out.push({ line: l, item: it, rank }); }); rank++; });
    return out;
  };
  /* Which symbol a station is drawn with: the newest choice (symAt) among all its items wins; without timestamps the
     line highest in the list decides. items: [{ item, rank }] (rank = position of the line in the list). null = none chosen. */
  store.pickSymbol = (items) => {
    let pick = null;
    items.forEach(({ item, rank }) => {
      if (!item.symbol || !TM.SYMBOLS[item.symbol]) return;
      const at = item.symAt || 0;
      if (!pick || at > pick.at || (at === pick.at && rank < pick.rank)) pick = { sym: item.symbol, at, rank };
    });
    return pick;
  };
  /* Lines that call at this station or at any station it is an interchange with. */
  store.usedByGroup = (id) => {
    const set = new Set(store.members(id));
    return rootsOf(store.trackLines().filter((l) => l.path.some((it) => it.s && set.has(it.s))));
  };

  /* How the small code label of a station is shown on this user's map (kept apart from the station data). */
  store.codeLabel = (id) => store.codeLabels[store.rep(id)] || {};
  store.setCodeLabel = (id, patch) => {
    const leadId = store.rep(id), current = Object.assign({}, store.codeLabels[leadId], patch);
    if (current.show !== true && current.show !== false) delete current.show;
    current.text = (current.text || '').trim();
    if (!current.text) delete current.text;
    if (Object.keys(current).length) store.codeLabels[leadId] = current; else delete store.codeLabels[leadId];
    store.save();
  };

  /* Where a station's own name label sits — kept apart from any one line's item (an interchange has several, one per
     line, and only one may be a line you can edit) so dragging it once settles it for every line consistently. */
  store.setLabelPos = (id, patch) => {   // patch: { pos?, dx?, dy?, hide?, size?, rot? (degrees, clockwise) } plus reset / resetSize
    const leadId = store.rep(id), merged = Object.assign({}, store.labelPos[leadId], patch);
    if (patch.reset) { merged.dx = 0; merged.dy = 0; }
    if (patch.resetSize) delete merged.size;
    const clean = {};
    if (merged.pos) clean.pos = merged.pos;
    if (merged.dx) clean.dx = Math.round(merged.dx);
    if (merged.dy) clean.dy = Math.round(merged.dy);
    if (merged.hide) clean.hide = true;
    if (merged.size) clean.size = Math.min(40, Math.max(6, Math.round(merged.size)));
    if (TM.normAngle(merged.rot)) clean.rot = TM.normAngle(merged.rot);
    if (Object.keys(clean).length) store.labelPos[leadId] = clean; else delete store.labelPos[leadId];
    store.save();
  };

  /* This station's own "Inside symbol shows" choice — a view preference like store.labelPos, never touching the line/
     station data. null/'' clears it back to the map-wide default (TM.state.numberMode). Only takes effect on canvas
     when TM.state.numModeOverride is on (see the checkbox in the left panel). */
  store.setNumMode = (id, mode) => {
    const leadId = store.rep(id);
    if (['none', 'code', 'full', 'ordinal'].includes(mode)) store.numMode[leadId] = mode; else delete store.numMode[leadId];
    store.save();
  };

  /* ---------- background drawings: shapes drawn under the schematic map (areas, lines), in world px ----------
     item: { id, kind: 'area' | 'line', pts: [[x, y], …], width (a line's), color, opacity, smooth (curved through its
     points), outline (an area's border colour, or none) }. A drawing saved as a 'river' (an earlier kind) is read as a line
     as wide as the river was on average.
     The layer as a whole: { top: 'drawings' | 'image' (which of it and the background image is drawn above), hidden }. */
  store.DRAW_KINDS = { area: 'Area', line: 'Line' };
  const hexOr = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v.toLowerCase() : d);
  store.normDrawing = (d) => {
    if (!d || typeof d !== 'object') return null;
    const rawPts = (Array.isArray(d.pts) ? d.pts : []).filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])).slice(0, 2000);
    let kind = d.kind, width = d.width;
    if (kind === 'river') { kind = 'line'; width = rawPts.length ? rawPts.reduce((t, p) => t + (+p[2] || 18), 0) / rawPts.length : 18; }
    if (!store.DRAW_KINDS[kind] || !rawPts.length) return null;
    const out = { id: String(d.id || 'd' + Math.random().toString(36).slice(2, 8)).slice(0, 24), kind, pts: rawPts.map((p) => [TM.round2dp(+p[0]), TM.round2dp(+p[1])]),
      color: hexOr(d.color, kind === 'area' ? '#cfe6c4' : '#9cc6ea'), opacity: isFinite(d.opacity) ? Math.min(1, Math.max(0.05, +d.opacity)) : 1, smooth: d.smooth !== false };
    if (kind === 'line') out.width = Math.min(200, Math.max(1, Math.round(+width || 6)));
    if (kind === 'area' && /^#[0-9a-f]{6}$/i.test(d.outline || '')) out.outline = d.outline.toLowerCase();
    return out;
  };
  store.normDrawingLayer = (layer) => {
    const out = { top: 'drawings', hidden: false, items: [] };
    if (!layer || typeof layer !== 'object') return out;
    if (layer.top === 'image') out.top = 'image';
    out.hidden = !!layer.hidden;
    const seen = new Set();
    out.items = (Array.isArray(layer.items) ? layer.items : []).map(store.normDrawing).filter((d) => d && !seen.has(d.id) && seen.add(d.id)).slice(0, 500);
    return out;
  };
  store.drawingById = (id) => store.drawing.items.find((d) => d.id === id) || null;

  /* ---------- the map's own legend: null = automatic (symbols.defaultLegend), else its items in order ----------
     item: { kind: 'line', line } | { kind: 'symbol', symbol } | { kind: 'style', style } | { kind: 'image', file }, each with
     an optional label (blank = its default name) and colour. A view-local overlay, like annotations. */
  store.normLegend = (list) => {
    if (!Array.isArray(list)) return null;
    return list.slice(0, 80).map((it) => {
      if (!it || typeof it !== 'object') return null;
      const out = { kind: it.kind };
      if (it.kind === 'line' && it.line) out.line = String(it.line);
      else if (it.kind === 'symbol' && TM.symbols.LEGEND_SYMBOLS[it.symbol]) out.symbol = it.symbol;
      else if (it.kind === 'style' && TM.symbols.LEGEND_STYLES[it.style]) out.style = it.style;
      else if (it.kind === 'image' && it.file) out.file = String(it.file);
      else return null;
      if (it.label) out.label = String(it.label).trim().slice(0, 60);
      if (/^#[0-9a-f]{6}$/i.test(it.color || '')) out.color = it.color.toLowerCase();
      return out;
    }).filter(Boolean);
  };
  store.setCalendar = (cal) => { store.calendar = TM.sched.normCalendar(cal); store.save(); };
  store.setLegend = (list) => { store.legend = store.normLegend(list); store.save(); };

  /* ---------- free-floating annotations (custom text / an image from images/, placed anywhere on the canvas) ---------- */
  function normAnnotation(annotation) {
    if (!annotation || typeof annotation !== 'object' || !isFinite(annotation.x) || !isFinite(annotation.y)) return null;
    const out = { kind: annotation.kind === 'image' ? 'image' : 'text', x: +annotation.x, y: +annotation.y };
    if (out.kind === 'image') {
      const iconFile = TM.iconPath && TM.iconPath(annotation.file);
      if (!iconFile) return null;
      out.file = iconFile;
      out.w = isFinite(annotation.w) && annotation.w > 0 ? Math.min(2000, Math.max(10, Math.round(annotation.w))) : 64;
    } else {
      out.text = String(annotation.text || '').trim().slice(0, 200);
      if (!out.text) return null;
      out.size = isFinite(annotation.size) && annotation.size > 0 ? Math.min(96, Math.max(8, Math.round(annotation.size))) : 16;
      if (annotation.color && /^#[0-9a-f]{3,8}$/i.test(annotation.color)) out.color = annotation.color;
      if (annotation.bold) out.bold = true;
      /* optional frame: a shape behind the text, filled with a background colour and / or outlined with a border */
      if (TM.ANN_SHAPES[annotation.shape] && annotation.shape !== 'none') out.shape = annotation.shape;
      if (annotation.bg && /^#[0-9a-f]{3,8}$/i.test(annotation.bg)) out.bg = annotation.bg;
      if (TM.ANN_BORDERS[annotation.border] && annotation.border !== 'none') out.border = annotation.border;
      if (annotation.borderColor && /^#[0-9a-f]{3,8}$/i.test(annotation.borderColor)) out.borderColor = annotation.borderColor;
    }
    if (TM.normAngle(annotation.rot)) out.rot = TM.normAngle(annotation.rot);
    return out;
  }
  store.addAnnotation = (object) => {
    const annotation = normAnnotation(object);
    if (!annotation) return null;
    const id = 'ann_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    store.annotations[id] = annotation;
    store.save();
    return id;
  };
  store.setAnnotation = (id, patch) => {
    if (!store.annotations[id]) return;
    const annotation = normAnnotation(Object.assign({}, store.annotations[id], patch));
    if (annotation) store.annotations[id] = annotation; else delete store.annotations[id];
    store.save();
  };
  store.removeAnnotation = (id) => { delete store.annotations[id]; store.save(); };

  /* ---------- station links ---------- */
  store.sameName = (a, b) => { const x = store.stations.get(a), y = store.stations.get(b); return !!x && !!y && nameKey(x) === nameKey(y); };

  /* Effective links: those written on station records plus this user's local edits. */
  store.connections = () => {
    if (store._conns) return store._conns;
    const map = new Map();
    store.stations.forEach((station) => station.connections.forEach((connection) => {
      if (connection.to === station.id || !store.stations.has(connection.to)) return;
      const key = pairKey(station.id, connection.to), current = map.get(key);
      if (!current || LINK_RANK[connection.type] > LINK_RANK[current.type]) map.set(key, { a: station.id, b: connection.to, type: connection.type, bends: connection.bends || null, time: connection.time || null, timeBack: connection.timeBack || null, style: connection.style || null, border: connection.border || null, color: connection.color || null });
    }));
    store.linkEdits.forEach((e) => {
      if (!store.stations.has(e.a) || !store.stations.has(e.b)) return;
      if (e.type) map.set(pairKey(e.a, e.b), { a: e.a, b: e.b, type: e.type, bends: e.bends || null, time: e.time || null, timeBack: e.timeBack || null, style: e.style || null, border: e.border || null, color: e.color || null }); else map.delete(pairKey(e.a, e.b));
    });
    /* a same-platform interchange between stations of the SAME name is one physical station (one symbol, one node);
       between DIFFERENT names the stations stay separate — each keeps its own name and node — and are drawn as linked
       interchange symbols. A plain interchange uses that same "stay separate, linked symbols" drawing unconditionally
       — even same-named stations are never forced onto one shared node; put them on the same node yourself and they
       still share one symbol (an interchange may be a level or a walk apart, so it is never assumed to be one spot). */
    map.forEach((c) => { c.split = c.type === 'interchange' || (c.type === 'platform' && !store.sameName(c.a, c.b)); });
    return (store._conns = [...map.values()]);
  };
  /* Links of one station, seen from it: [{ other, type, bends? }] (bends run in the FROM-id → other direction). */
  store.connectionsOf = (id) => store.connections().filter((connection) => connection.a === id || connection.b === id).map((connection) => {
    const other = connection.a === id ? connection.b : connection.a, out = { other, type: connection.type };
    if (connection.bends && connection.bends.length) out.bends = connection.a === id ? connection.bends : connection.bends.slice().reverse();
    const times = timesFrom(connection, id);                  // time: id → other, timeReturn: other → id
    if (times.time) out.time = times.time;
    const back = times.timeBack || times.time;
    if (back) out.timeReturn = back;
    if (connection.style) out.style = connection.style;
    if (connection.border) out.border = connection.border;
    if (connection.color) out.color = connection.color;
    return out;
  });
  /* The link between a and b as drawn (either order), or null. */
  store.connOf = (a, b) => store.connections().find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a)) || null;
  /* Change how the link between a and b looks: patch { style?, border?, color? } (null / '' = back to the default). Written on a
     station either side owns; otherwise kept as this user's local edit, with everything else the link already had. */
  store.setConnLook = (stationA, stationB, patch) => {
    const before = store.connOf(stationA, stationB);
    if (!before || stationA === stationB) return false;
    const apply = (e) => {
      ['style', 'border', 'color'].forEach((k) => { if (k in patch) { if (patch[k]) e[k] = patch[k]; else delete e[k]; } });
      const clean = normConnLook(e, {});
      delete e.style; delete e.border; delete e.color; Object.assign(e, clean);
    };
    const setOn = (st, other) => { const e = st.connections.find((c) => c.to === other); if (!e) return false; apply(e); return true; };
    if (!(TM.actions.ownsStation(store.stations.get(stationA)) && setOn(store.stations.get(stationA), stationB)) && !(TM.actions.ownsStation(store.stations.get(stationB)) && setOn(store.stations.get(stationB), stationA))) {
      const low = stationA < stationB ? stationA : stationB, high = stationA < stationB ? stationB : stationA;
      let e = store.linkEdits.find((x) => (x.a === low && x.b === high) || (x.a === high && x.b === low));
      if (!e) {
        e = { a: before.a, b: before.b, type: before.type };
        if (before.bends && before.bends.length) e.bends = before.bends;
        Object.assign(e, normTimes(before));
        if (before.style) e.style = before.style;
        if (before.border) e.border = before.border;
        if (before.color) e.color = before.color;
        store.linkEdits.push(e);
      }
      apply(e);
    }
    store.save();
    return true;
  };
  /* Manual bend points of the connecting/unofficial line between a and b (schematic only), a → b: [[x,y], …] in grid units. */
  store.connBends = (a, b) => { const connection = store.connectionsOf(a).find((x) => x.other === b); return (connection && connection.bends) || []; };
  /* Average travel time between two connected stations (interchange / same-platform / connecting / unofficial), in
     minutes, from a to b — it may differ the other way (a long escalator one way, say). */
  store.connTime = (a, b) => { const connection = store.connectionsOf(a).find((x) => x.other === b); return (connection && connection.time) || null; };
  /* Set the time from `from` to `to` (null clears it). A record keeps time (its own station → the other) and timeBack
     (the other → its own station, when different); the other direction keeps whatever it was. Written on a station
     either side owns; otherwise kept as this user's local edit. */
  store.setConnTime = (from, to, value) => {
    const before = store.connOf(from, to);
    if (!before || from === to) return false;
    const time = minutes(value);
    const setDirection = (record, ownerId) => {
      const cur = { time: record.time || null, timeBack: record.timeBack || record.time || null };   // owner → other, other → owner
      if (ownerId === from) cur.time = time; else cur.timeBack = time;
      delete record.time; delete record.timeBack;
      if (cur.time) record.time = cur.time;
      if (cur.timeBack && cur.timeBack !== cur.time) record.timeBack = cur.timeBack;
    };
    const setOn = (stationId, otherId) => {
      const station = store.stations.get(stationId), record = station && station.connections.find((c) => c.to === otherId);
      if (!record || !TM.actions.ownsStation(station)) return false;
      setDirection(record, stationId); return true;
    };
    if (!setOn(from, to) && !setOn(to, from)) {
      let record = store.linkEdits.find((e) => (e.a === before.a && e.b === before.b) || (e.a === before.b && e.b === before.a));
      if (!record) { record = Object.assign({ a: before.a, b: before.b, type: before.type }, normTimes(before)); store.linkEdits.push(record); }
      setDirection(record, record.a);
    }
    store.save();
    return true;
  };
  /* Set them (or clear with an empty array). Written on a station either side owns; otherwise kept as a local edit. */
  store.setConnBends = (stationA, stationB, points) => {
    const before = store.connections().find((c) => (c.a === stationA && c.b === stationB) || (c.a === stationB && c.b === stationA));
    if (!before || stationA === stationB) return false;
    const low = stationA < stationB ? stationA : stationB, high = stationA < stationB ? stationB : stationA, dirPts = stationA === low ? points : points.slice().reverse();
    const bends = normBendPts(dirPts);
    const setOn = (st, other) => { const e = st.connections.find((c) => c.to === other); if (!e) return false; if (bends.length) e.bends = bends; else delete e.bends; return true; };
    const stationLow = store.stations.get(low), stationHigh = store.stations.get(high);
    let done = false;
    if (TM.actions.ownsStation(stationLow) && setOn(stationLow, high)) done = true;
    else if (TM.actions.ownsStation(stationHigh) && setOn(stationHigh, low)) done = true;
    if (!done) {
      store.linkEdits = store.linkEdits.filter((e) => !(e.a === low && e.b === high) && !(e.a === high && e.b === low));
      const e = { a: low, b: high, type: before.type };
      if (bends.length) e.bends = bends;
      Object.assign(e, normTimes(timesFrom(before, low)));
      if (before.style) e.style = before.style;
      if (before.border) e.border = before.border;
      if (before.color) e.color = before.color;
      store.linkEdits.push(e);
    }
    store.save();
    return true;
  };

  /* Interchange groups: stations joined by a same-name "platform" link are one physical station (one symbol, one node). */
  store.groups = () => {
    if (store._groups) return store._groups;
    const parent = new Map();
    store.stations.forEach((s, id) => parent.set(id, id));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    store.connections().forEach((c) => { if (c.type === 'platform' && !c.split) { const rootA = find(c.a), rootB = find(c.b); if (rootA !== rootB) parent.set(rootB, rootA); } });
    const order = new Map([...store.stations.keys()].map((id, i) => [id, i]));
    const byRoot = new Map();
    store.stations.forEach((s, id) => { const root = find(id); (byRoot.get(root) || byRoot.set(root, []).get(root)).push(id); });
    const repOf = new Map(), members = new Map();
    byRoot.forEach((ids) => {
      ids.sort((x, y) => order.get(x) - order.get(y));
      const leadId = ids[0];
      members.set(leadId, ids);
      ids.forEach((id) => repOf.set(id, leadId));
    });
    return (store._groups = { repOf, members });
  };
  /* Interchanges drawn as two separate, linked symbols rather than one merged node: differently-named "interchange"
     links, and every "platform" (same-platform interchange) link regardless of name. */
  store.splitLinks = () => store.connections().filter((c) => c.split && (c.type === 'interchange' || c.type === 'platform'));
  store.isSplitPartner = (a, b) => { const leadA = store.rep(a), leadB = store.rep(b); return store.splitLinks().some((c) => (store.rep(c.a) === leadA && store.rep(c.b) === leadB) || (store.rep(c.a) === leadB && store.rep(c.b) === leadA)); };

  /* The whole interchange complex an id belongs to: its same-name group, plus any other groups joined to it by a (possibly
     several-hops-away) different-name interchange link. Two stations connecting to two different members of the same
     complex are really connecting to the same physical place, so drawing collapses them (see render.js). */
  store.complexOf = (id) => {
    if (!store._complex) {
      const parent = new Map();
      store.groups().members.forEach((ids, rep) => parent.set(rep, rep));
      const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      store.splitLinks().forEach((connection) => {
        const leadA = store.rep(connection.a), leadB = store.rep(connection.b);
        if (parent.has(leadA) && parent.has(leadB)) { const rootA = find(leadA), rootB = find(leadB); if (rootA !== rootB) parent.set(rootB, rootA); }
      });
      const order = new Map([...store.stations.keys()].map((k, i) => [k, i]));
      const byRoot = new Map();
      parent.forEach((_, rep) => { const root = find(rep); (byRoot.get(root) || byRoot.set(root, []).get(root)).push(rep); });
      const canon = new Map(), members = new Map();
      byRoot.forEach((reps) => {
        reps.sort((x, y) => order.get(x) - order.get(y));
        members.set(reps[0], reps);
        reps.forEach((r) => canon.set(r, reps[0]));
      });
      store._complex = { canon, members };
    }
    return store._complex.canon.get(store.rep(id)) || store.rep(id);
  };
  /* Every REP id (not every raw id — see store.complexMembers for that) in id's whole interchange complex: same
     platform, or joined by an interchange link. Used by the journey planner to stop a route passing back through a
     station (any of its platforms) it has already called at — see js/route.js. */
  store.complexReps = (id) => {
    const complex = store.complexOf(id);
    return (store._complex && store._complex.members.get(complex)) || [store.rep(id)];
  };

  /* Every raw station id (one per line record) across the whole complex. */
  store.complexMembers = (id) => {
    const complex = store.complexOf(id), reps = store._complex.members.get(complex) || [store.rep(id)];
    const out = [];
    reps.forEach((r) => out.push(...store.members(r)));
    return out;
  };
  store.rep = (id) => store.groups().repOf.get(id) || id;
  store.members = (id) => store.groups().members.get(store.rep(id)) || [id];
  store.sameGroup = (a, b) => store.rep(a) === store.rep(b);

  /* Add / change / remove the link between two stations. type = null removes it. Links are written on a station
     record the user owns; otherwise they are kept as a local edit (so shipped data is never modified in the browser). */
  store.setLink = (stationA, stationB, type) => {
    const actions = TM.actions, recordA = store.stations.get(stationA), recordB = store.stations.get(stationB);
    if (!recordA || !recordB || stationA === stationB) return false;
    [recordA, recordB].forEach((s) => { if (actions.ownsStation(s)) s.connections = s.connections.filter((c) => c.to !== (s === recordA ? stationB : stationA)); });
    store.linkEdits = store.linkEdits.filter((e) => pairKey(e.a, e.b) !== pairKey(stationA, stationB));
    store._invalidate();
    const held = store.connections().find((c) => pairKey(c.a, c.b) === pairKey(stationA, stationB));   // still written on a record we may not edit
    if (type) {
      const owner = actions.ownsStation(recordA) ? recordA : actions.ownsStation(recordB) ? recordB : null;
      if (owner) owner.connections.push({ to: owner === recordA ? stationB : stationA, type });
      if (held ? held.type !== type : !owner) store.linkEdits.push({ a: stationA, b: stationB, type });   // a locked record says otherwise, or nowhere to write it
    } else if (held) store.linkEdits.push({ a: stationA, b: stationB, type: null });
    store.save();
    return true;
  };

  /* ---------- spatial helpers ---------- */
  store.nodeMap = () => {
    if (!store._nodes) {
      store._nodes = new Map();
      store.groups().members.forEach((ids, rep) => { const station = store.stations.get(rep); if (station && station.node) store._nodes.set(station.node.x + ',' + station.node.y, rep); });
    }
    return store._nodes;
  };
  store.stationAt = (x, y) => store.nodeMap().get(x + ',' + y) || null;
  /* Where a line's path item sits, in grid units: its station's node, or the bend's own point (null: unknown station) */
  store.itemPos = (item) => {
    if (!item) return null;
    if (item.s == null) return { x: item.x, y: item.y };
    const node = store.stations.get(item.s) && store.nodeOf(item.s);
    return node ? { x: node.x, y: node.y } : null;
  };
  /* Node of a station's group (the first member decides; the others follow it). */
  store.nodeOf = (id) => {
    const lead = store.stations.get(store.rep(id));
    if (!lead) return null;
    if (!lead.node) { lead.node = store.autoNode(lead.lat, lead.lng); store._nodes = null; }
    return lead.node;
  };

  store.nodeToLatLng = (x, y) => { const anchor = store.anchor; return { lat: anchor.lat - (y - anchor.y) * anchor.step, lng: anchor.lng + (x - anchor.x) * anchor.step }; };
  store.autoNode = (lat, lng) => {
    const anchor = store.anchor, startX = Math.round((lng - anchor.lng) / anchor.step) + anchor.x, startY = Math.round(-(lat - anchor.lat) / anchor.step) + anchor.y;
    return store.freeNodeNear(startX, startY);
  };
  store.freeNodeNear = (startX, startY) => {
    for (let r = 0; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!store.stationAt(startX + dx, startY + dy)) return { x: startX + dx, y: startY + dy };
      }
    }
    return { x: startX, y: startY };
  };

  /* Stations within `meters` of a point, nearest first. */
  store.nearby = (lat, lng, meters, excludeId) => {
    const out = [];
    store.stations.forEach((station) => {
      if (station.id === excludeId) return;
      const distance = TM.haversine(lat, lng, station.lat, station.lng);
      if (distance <= meters) out.push({ station: station, dist: distance });
    });
    return out.sort((a, b) => a.dist - b.dist);
  };

  /* Suggestion hotspots: fantasy-ish stations within 300 m (or explicitly linked) share a cluster. */
  store.clusters = () => {
    const pool = [...store.stations.values()].filter((s) => s.status === 'fantasy' || (s.author && s.author !== 'system'));
    const parent = new Map(pool.map((s) => [s.id, s.id]));
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const union = (a, b) => { if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b)); };
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (TM.haversine(pool[i].lat, pool[i].lng, pool[j].lat, pool[j].lng) <= 300) union(pool[i].id, pool[j].id);
      }
      pool[i].linkedTo.forEach((o) => union(pool[i].id, o));
    }
    const groups = new Map();
    pool.forEach((s) => { const root = find(s.id); (groups.get(root) || groups.set(root, []).get(root)).push(s); });
    return [...groups.values()].map((members) => {
      const authors = [...new Set(members.map((m) => m.author || 'anonymous'))];
      return {
        members, authors,
        lat: members.reduce((a, m) => a + m.lat, 0) / members.length,
        lng: members.reduce((a, m) => a + m.lng, 0) / members.length,
      };
    }).filter((c) => c.authors.length > 1).sort((a, b) => b.authors.length - a.authors.length);
  };
  store.clusterOf = (id) => store.clusters().find((c) => c.members.some((m) => m.id === id)) || null;

  /* ---------- import ---------- */
  store.importData = (objs) => {
    const remap = new Map(), added = [];
    let stationCount = 0, lineCount = 0, suggestionCount = 0;
    const flag = !store.userMap;                       // in a map of your own, imported records are yours to edit; elsewhere they stay read-only
    const stationLists = objs.filter(Array.isArray).flat();
    stationLists.forEach((raw) => {
      const existing = store.stations.get(String(raw.id));
      if (existing && Math.abs(existing.lat - raw.lat) < 1e-6 && Math.abs(existing.lng - raw.lng) < 1e-6) { if (raw.suggests) suggestionCount += store.mergeSuggests(existing.id, raw.suggests); return; }   // same station — but its stop suggestions still count
      const station = normStation(raw, true);
      station.imported = flag;
      if (existing) { const newId = store.nextFantasyCode(TM.nameOf(station, 'en')); remap.set(station.id, newId); station.id = newId; }
      if (station.node && store.stationAt(station.node.x, station.node.y)) station.node = store.autoNode(station.lat, station.lng);
      store.stations.set(station.id, station); added.push(station); stationCount++;
    });
    added.forEach((st) => st.connections.forEach((c) => { if (remap.has(c.to)) c.to = remap.get(c.to); }));
    added.forEach((st) => st.suggests.forEach((c) => { if (c.after && remap.has(c.after)) c.after = remap.get(c.after); }));
    objs.filter((o) => !Array.isArray(o) && o.path).forEach((raw) => {
      const line = normLine(raw, true);
      line.imported = flag;
      if (store.lines.has(line.id)) line.id = store.nextLineId(TM.nameOf(line, 'en'), line.code);
      line.path.forEach((it) => { if (it.s && remap.has(it.s)) it.s = remap.get(it.s); });
      const geoBends = {};
      Object.entries(line.geoBends).forEach(([k, v]) => { const [stationA, stationB] = k.split('>'); geoBends[(remap.get(stationA) || stationA) + '>' + (remap.get(stationB) || stationB)] = v; });
      line.geoBends = geoBends;
      const geoSegments = {};
      Object.entries(line.geoSeg).forEach(([k, v]) => { const [stationA, stationB] = k.split('>'); geoSegments[(remap.get(stationA) || stationA) + '>' + (remap.get(stationB) || stationB)] = v; });
      line.geoSeg = geoSegments;
      store.lines.set(line.id, line); store.visible.add(line.id); store.lineFilter.add(line.id); lineCount++;
    });
    store.save();
    return { stations: stationCount, lines: lineCount, remapped: remap.size, suggestions: suggestionCount };
  };

  /* ---------- services ----------
     Where trains run, on top of the track (lines and their branches): maps/<id>/services.json → { "services": [ … ] },
     each { id, name, type?, via: [station ids], loop?, both?, hidden?, stops? | skip?, return?: { stops? | skip? } }.
       via     anchor stations the route passes, in order; the track between two anchors is filled in (store.serviceRoute) —
               the only way there without going back over a station or a stretch already run; where two ways are
               equally short (round a loop), add an anchor in between to say which
       loop    runs round and round: via ends where it starts (["CC4", "CC5", "CC4"])
       both    also runs the other way (default); false = one way only
       stops / skip   stops only at these / everywhere but these (whichever list is shorter); the termini always stop
       return  a different stopping pattern for the way back ({} = it stops everywhere that way)
       hidden  not offered by default (a journey planner can still switch it on)
     A service may run from one line's track onto another's where two stations are the same place (a same-platform or
     interchange link, or one station on both) — a train running through without anyone changing car. Services run on
     top of every line's own all-stops train, except on a line marked "servicesOnly", which only its services run on. */
  const SVC_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;
  const idList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x).map(String))] : []);
  const svcPattern = (x) => {
    const result = {}, stops = idList(x && x.stops), skip = idList(x && x.skip);
    if (stops.length) result.stops = stops; else if (skip.length) result.skip = skip;
    return result;
  };
  store.normService = (value, i) => {
    if (!value || typeof value !== 'object') return null;
    const via = (Array.isArray(value.via) ? value.via : []).filter((x) => typeof x === 'string' && x).map(String);
    if (via.length < 2) return null;
    const result = { id: SVC_ID.test(String(value.id)) ? String(value.id) : 'svc' + ((i || 0) + 1), name: String(value.name || '').trim().slice(0, 60) || 'Service', via };
    if (typeof value.type === 'string' && value.type.trim()) result.type = value.type.trim().slice(0, 30);
    if (TM.LOOK_FOR[value.lookFor]) result.lookFor = value.lookFor;
    if (value.loop && TM.LOOP_NAMES[value.loopNames]) result.loopNames = value.loopNames;   // its own naming of the ways round (absent = as its line)
    if (value.loop && TM.TRAFFIC[value.traffic]) result.traffic = value.traffic;   // how the journey planner names its trains; absent = as its line says
    if (value.loop) result.loop = true;
    if (value.both === false) result.both = false;
    if (value.hidden) result.hidden = true;
    const schedules = TM.sched.norm(value.schedules);   // when its trains run (js/schedule.js)
    if (schedules) result.schedules = schedules;
    Object.assign(result, svcPattern(value));
    if (value.return && typeof value.return === 'object') result.return = svcPattern(value.return);   // {} = stops everywhere the other way
    return result;
  };
  store.normServices = (raw) => {
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.services) ? raw.services : [];
    const out = [], seen = new Set();
    list.forEach((v, i) => { const service = store.normService(v, i); if (!service) return; while (seen.has(service.id)) service.id += '-2'; seen.add(service.id); out.push(service); });
    return out;
  };
  store.servicesOut = () => JSON.parse(JSON.stringify(store.services));
  store.setServices = (list) => { store.services = store.normServices(list); store.save(); };

  /* The track as a graph of stations: each track line's consecutive real stops (a loop closed back to its start), and
     "joins" between two codes of one place on different lines, which only a service can run across. */
  store.trackGraph = () => {
    if (store._track) return store._track;
    const adjacency = new Map(), lineOf = new Map(), joins = new Map();
    const push = (a, e) => (adjacency.get(a) || adjacency.set(a, []).get(a)).push(e);
    store.trackLines().forEach((line) => {
      const stops = [];
      line.path.forEach((it, i) => { const x = it.s && store.stations.get(it.s); if (x && x.status !== 'fantasy') stops.push({ id: it.s, i }); });
      stops.forEach((x) => (lineOf.get(x.id) || lineOf.set(x.id, new Set()).get(x.id)).add(line.id));
      const edge = (a, b, wrap) => { push(a.id, { to: b.id, line: line, ia: a.i, ib: b.i, fwd: true, wrap }); push(b.id, { to: a.id, line: line, ia: b.i, ib: a.i, fwd: false, wrap }); };
      for (let k = 0; k + 1 < stops.length; k++) if (stops[k].id !== stops[k + 1].id) edge(stops[k], stops[k + 1], false);
      if (line.loop && stops.length > 2 && stops[stops.length - 1].id !== stops[0].id) edge(stops[stops.length - 1], stops[0], true);   // a loop's closing stretch
    });
    const join = (stationA, stationB) => {
      if (stationA === stationB || !lineOf.has(stationA) || !lineOf.has(stationB)) return;
      (joins.get(stationA) || joins.set(stationA, new Set()).get(stationA)).add(stationB); (joins.get(stationB) || joins.set(stationB, new Set()).get(stationB)).add(stationA);
    };
    store.connections().forEach((c) => { if (c.type === 'platform' || c.type === 'interchange') join(c.a, c.b); });
    store.groups().members.forEach((ids) => ids.forEach((a) => ids.forEach((b) => join(a, b))));
    return (store._track = { adj: adjacency, lineOf, joins });
  };

  /* A service's whole route: { ok, warn: [text], loop, nodes: [{ id }], hops: [{ line, ia, ib, fwd } | { join: true }],
     places: [{ ids, k0, k1 }] } — nodes are the stations passed, hops what joins each to the next (a stretch of one track
     line, as path indices, or a join between two codes of one place), places the nodes with each join folded into one
     place (the stops a traveller sees; a loop's closing node, its start again, is left out). */
  store.serviceRoute = (service) => {
    const cache = store._svcRoutes || (store._svcRoutes = new Map()), key = JSON.stringify([service.via, !!service.loop]);
    if (cache.has(key)) return cache.get(key);
    const graph = store.trackGraph(), via = service.via, result = { ok: false, warn: [], loop: !!service.loop, nodes: [], hops: [], places: [] };
    const name = (id) => { const station = store.stations.get(id); return station ? `${TM.nameOf(station, 'en')} (${id})` : id; };
    /* a line's own track: the line and all of its branches */
    const familyOf = (lid) => { const root = store.rootLine(lid); return root ? [root, ...store.branchesOf(root)].map((x) => x.id) : [lid]; };
    const family = (id) => new Set([...(graph.lineOf.get(id) || new Set())].flatMap(familyOf));
    /* the track two anchors are joined by: one line's own (with its branches) when it reaches both — so a service on a
       line never wanders onto another line's track just because the two share stations — else both lines' together,
       for a train running through from one onto the other */
    const trackFor = (stationA, stationB) => {
      const familyA = family(stationA), familyB = family(stationB);
      const both = [...new Set([...(graph.lineOf.get(stationA) || [])].map((lid) => store.rootId(lid)))].find((root) => familyOf(root).some((x) => familyB.has(x)));
      return both ? new Set(familyOf(both)) : new Set([...familyA, ...familyB]);
    };
    const ekey = (a, b, lid) => (a < b ? a + '|' + b : b + '|' + a) + '|' + lid;
    const usedSt = new Set([via[0]]), usedEdge = new Set();
    result.nodes.push({ id: via[0] });
    let fatal = false;
    for (let v = 0; v + 1 < via.length && !fatal; v++) {
      const hopFrom = via[v], hopTo = via[v + 1];
      if (!graph.lineOf.has(hopFrom) || !graph.lineOf.has(hopTo)) { result.warn.push(`${name(graph.lineOf.has(hopFrom) ? hopTo : hopFrom)} is not a stop on any line`); fatal = true; break; }
      const found = trackFor(hopFrom, hopTo);
      const prev = new Map([[hopFrom, null]]), dist = new Map([[hopFrom, 0]]), ways = new Map([[hopFrom, 1]]), queue = [hopFrom], counted = new Set();
      while (queue.length) {
        const current = queue.shift();
        if (current === hopTo) break;
        const steps = (graph.adj.get(current) || []).filter((e) => found.has(e.line.id)).map((e) => ({ to: e.to, e, k: ekey(current, e.to, e.line.id) }))
          .concat([...(graph.joins.get(current) || [])].filter((t) => [...(graph.lineOf.get(t) || [])].some((l) => found.has(l))).map((t) => ({ to: t, e: { join: true }, k: 'J' + ekey(current, t, '') })));
        for (const { to, e, k } of steps) {
          if (usedEdge.has(k) || (usedSt.has(to) && to !== hopTo)) continue;
          /* ways: how many different station sequences lead here — two lines' parallel track between the same two
             stations is still one way */
          if (counted.has(current + '>' + to)) continue;
          counted.add(current + '>' + to);
          if (!dist.has(to)) { dist.set(to, dist.get(current) + 1); ways.set(to, ways.get(current)); prev.set(to, { u: current, e, k }); queue.push(to); }
          else if (dist.get(to) === dist.get(current) + 1) ways.set(to, Math.min(9, ways.get(to) + ways.get(current)));
        }
      }
      if (!prev.has(hopTo)) { result.warn.push(`No track from ${name(hopFrom)} to ${name(hopTo)} that does not go back over the route`); fatal = true; break; }
      if (ways.get(hopTo) > 1) result.warn.push(`${name(hopFrom)} → ${name(hopTo)} can go more than one way — add a station in between to say which`);
      const steps = [];
      for (let x = hopTo; x !== hopFrom; x = prev.get(x).u) steps.unshift(Object.assign({ to: x }, prev.get(x)));
      steps.forEach(({ to, e, k: index }) => {
        result.hops.push(e.join ? { join: true } : { line: e.line, ia: e.ia, ib: e.ib, fwd: e.fwd, wrap: e.wrap });
        result.nodes.push({ id: to });
        usedSt.add(to); usedEdge.add(index);
      });
    }
    if (!fatal && service.loop && via[via.length - 1] !== via[0]) result.warn.push('A loop service has to end where it starts (the last station of its route is its first)');
    if (!fatal && !service.loop && via[via.length - 1] === via[0]) result.warn.push('This route ends where it starts — tick “Loop” if it runs round and round');
    /* places: a join folds its two codes into one place; a loop's final node is its first place again */
    const count = result.nodes.length - (service.loop && result.nodes.length > 1 && result.nodes[result.nodes.length - 1].id === result.nodes[0].id ? 1 : 0);
    for (let k = 0; k < count; k++) {
      if (k > 0 && result.hops[k - 1] && result.hops[k - 1].join) { const lastPlace = result.places[result.places.length - 1]; lastPlace.ids.push(result.nodes[k].id); lastPlace.k1 = k; }
      else result.places.push({ ids: [result.nodes[k].id], k0: k, k1: k });
    }
    result.ok = !fatal && result.places.length >= 2;
    cache.set(key, result);
    return result;
  };
  /* Which of a route's places a service stops at, one way (back = the other way): a Set of place indices (in the
     route's own order). The first and last place of a service that is not a loop always stop. */
  store.serviceStopsAt = (service, route, back) => {
    const pattern = back && service.return ? service.return : service, out = new Set(), last = route.places.length - 1;
    const stops = pattern.stops ? new Set(pattern.stops) : null, skip = new Set(pattern.skip || []);
    route.places.forEach((place, i) => {
      const end = !route.loop && (i === 0 || i === last);
      if (end || (stops ? place.ids.some((id) => stops.has(id)) : !place.ids.some((id) => skip.has(id)))) out.add(i);
    });
    return out;
  };
  /* The shorter way to write a stopping pattern: the stops, or the skips (route = the service's place ids in order). */
  store.compactPattern = (placeIds, stopSet) => {
    const stops = placeIds.filter((ids, i) => stopSet.has(i)).map((ids) => ids[0]), skip = placeIds.filter((ids, i) => !stopSet.has(i)).map((ids) => ids[0]);
    return !skip.length ? {} : stops.length < skip.length ? { stops } : { skip };
  };
  /* services running on a track line (any stretch of it) */
  store.servicesOn = (lineId) => store.services.filter((sv) => store.serviceRoute(sv).hops.some((h) => h.line && store.rootId(h.line) === store.rootId(lineId)));
})(window.TM);
