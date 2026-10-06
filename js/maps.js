/* Maps: the list of maps (maps/index.json + the ones made in this browser), which one is open, and copy / import / export.
   A published map is a folder maps/<id>/ (map.json, stations/, lines/, images/, a logo). A map made in the browser lives
   entirely in localStorage; exporting it gives the same folder as a zip. Nothing here needs a server. */
(function (TM) {
  const maps = (TM.maps = { shipped: [], user: [], current: null, defaultId: 'klang-valley', missing: null });
  const REG = 'tm.maps', LAST = 'tm.map', FALLBACK = 'klang-valley';
  const ID_OK = /^[a-z0-9][a-z0-9_-]{0,47}$/;
  const storage = TM.storage, getJSON = TM.getJSON;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isPt = (a) => Array.isArray(a) && a.length === 2 && isFinite(a[0]) && isFinite(a[1]);

  maps.slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  maps.normMeta = (raw, id, kind) => {
    raw = raw || {};
    const anchor = raw.anchor;
    return {
      id, kind,
      names: Object.assign({ en: '', ms: '', 'zh-Hant': '', ta: '' }, raw.names || (raw.name ? { en: String(raw.name) } : {})),
      subtitle: String(raw.subtitle || ''), description: String(raw.description || ''),
      country: String(raw.country || '').trim().slice(0, 60), area: String(raw.area || '').trim().slice(0, 80),   // where the map is, e.g. "Malaysia" · "Klang Valley"
      logo: raw.logo ? String(raw.logo) : null, author: String(raw.author || ''), created: raw.created || null,
      center: isPt(raw.center) ? [+raw.center[0], +raw.center[1]] : null,
      zoom: isFinite(raw.zoom) && raw.zoom !== null ? +raw.zoom : null,
      anchor: anchor && isFinite(anchor.lat) && isFinite(anchor.lng)
        ? { lat: +anchor.lat, lng: +anchor.lng, step: +anchor.step > 0 ? +anchor.step : 0.0035, x: isFinite(anchor.x) ? +anchor.x : 28, y: isFinite(anchor.y) ? +anchor.y : 28 } : null,
      codes: raw.codes && typeof raw.codes === 'object' ? raw.codes : null,   // small code labels the map ships with (station id -> { show, text })
      labelPos: raw.labelPos && typeof raw.labelPos === 'object' ? raw.labelPos : null,   // where station names sit, as the map ships them (station id -> { pos, dx, dy, hide, size, rot })
      drawing: raw.drawing && typeof raw.drawing === 'object' ? raw.drawing : null,   // background drawings the map ships with (areas, lines)
      calendar: raw.calendar && typeof raw.calendar === 'object' ? raw.calendar : null,   // public holidays and the default time zone of its timetables
      legend: Array.isArray(raw.legend) ? raw.legend : null,   // the map's own legend items (null: automatic)
      annotations: raw.annotations && typeof raw.annotations === 'object' ? raw.annotations : null,   // free-floating text / image labels the map ships with (id -> annotation)
      langOrder: Array.isArray(raw.langOrder) ? raw.langOrder.map(String) : null,
      languages: TM.normLanguages(raw.languages),
      numberMode: TM.NUMBER_MODES.includes(raw.numberMode) ? raw.numberMode : null,          // default "Inside symbol shows" (null: the app's own)
      numModeOverride: typeof raw.numModeOverride === 'boolean' ? raw.numModeOverride : null,   // default "Allow a station to override this"   // label languages this map adds to the four every map has (TM.LANGS)   // this map's preferred label-language hierarchy, e.g. ["ms","en","zh-Hant","ta"]
      /* keeps what a visitor changed under the key older versions used — only the map that really is that map: a folder
         copied to make another map carries its map.json along, flag and id included, and must not share it */
      legacyStorage: !!raw.legacyStorage && (raw.id == null || String(raw.id) === id),
      /* offered in the journey planner (navigator.html)? A published map has to say so ("navigator": true in its
         map.json); one made in this browser is, unless its details say otherwise */
      navigator: typeof raw.navigator === 'boolean' ? raw.navigator : kind === 'user',
      from: raw.from ? String(raw.from) : null,
    };
  };

  /* ---------- the list ---------- */
  const readReg = () => {
    try { const list = JSON.parse(storage.get(REG) || '[]'); return (Array.isArray(list) ? list : []).filter((m) => m && ID_OK.test(m.id)).map((m) => maps.normMeta(m, m.id, 'user')); } catch (e) { return []; }
  };
  const writeReg = () => storage.set(REG, JSON.stringify(maps.user.map((m) => { const copy = clone(m); delete copy.kind; return copy; })));
  maps.all = () => [...maps.shipped, ...maps.user];
  maps.find = (id) => maps.all().find((m) => m.id === id) || null;
  maps.isUser = (m) => !!m && m.kind === 'user';
  maps.uniqueId = (base) => {
    const root = maps.slug(base) || 'map';
    let id = root, suffix = 2;
    while (maps.find(id) || !ID_OK.test(id)) id = root + '-' + suffix++;
    return id;
  };

  maps.init = async () => {
    let index = { default: FALLBACK, maps: [FALLBACK] };
    try { index = await getJSON('maps/index.json'); } catch (e) { /* no index: the default map only */ }
    const ids = [...new Set((index.maps || []).map((x) => (typeof x === 'string' ? x : x && (x.id || x.dir))).filter((x) => typeof x === 'string' && ID_OK.test(x)))];
    if (!ids.length) ids.push(FALLBACK);
    maps.defaultId = ids.includes(index.default) ? index.default : ids[0];
    maps.shipped = (await Promise.all(ids.map(async (id) => { try { return maps.normMeta(await getJSON(`maps/${id}/map.json`), id, 'files'); } catch (e) { return null; } }))).filter(Boolean);
    /* one browser key per map: should two maps still claim the old shared key, only the first listed keeps it */
    let legacyTaken = false;
    maps.shipped.forEach((m) => { if (m.legacyStorage) { if (legacyTaken) m.legacyStorage = false; legacyTaken = true; } });
    if (!maps.shipped.length) maps.shipped = [maps.normMeta({ names: { en: 'Fantasy Transit' } }, maps.defaultId, 'files')];
    maps.user = readReg();
    /* a map made in this browser whose id was later taken by a published map keeps its data under a new id */
    let moved = false;
    maps.user.forEach((meta) => {
      if (!maps.shipped.some((x) => x.id === meta.id)) return;
      const oldId = meta.id, id = maps.uniqueId(oldId + '-mine');
      ['', '.img'].forEach((suf) => { const value = storage.get(maps.userKey(oldId) + suf); if (value != null) { try { storage.set(maps.userKey(id) + suf, value); } catch (e) { return; } storage.del(maps.userKey(oldId) + suf); } });
      meta.id = id; moved = true;
    });
    if (moved) { try { writeReg(); } catch (e) { /* ignore */ } }
    let requested = null;
    try { requested = new URLSearchParams(location.search).get('map'); } catch (e) { /* ignore */ }
    maps.missing = requested && !maps.find(requested) ? requested : null;
    maps.current = maps.find(requested) || maps.find(storage.get(LAST)) || maps.find(maps.defaultId) || maps.all()[0];
    try { storage.set(LAST, maps.current.id); } catch (e) { /* ignore */ }
    if (maps.missing) { try { history.replaceState(null, '', location.pathname + '?map=' + encodeURIComponent(maps.current.id)); } catch (e) { /* ignore */ } }   // a reload should not warn again
    maps.applyTitle(); TM.applyMapLanguages(); TM.applyMapDisplay();
  };

  /* the maps the journey planner offers, and the one it opens: the one asked for when it is offered, else the first */
  maps.navigable = () => maps.all().filter((m) => m.navigator);
  maps.useNavigable = () => {
    if (maps.current && maps.current.navigator) return maps.current;
    const meta = maps.navigable()[0] || null;
    if (meta) { maps.current = meta; try { history.replaceState(null, '', location.pathname + '?map=' + encodeURIComponent(meta.id)); } catch (e) { /* ignore */ } maps.applyTitle(); TM.applyMapLanguages(); TM.applyMapDisplay(); }
    return meta;
  };
  maps.name = (m, lang) => TM.nameOf(m || maps.current, lang || (TM.state && TM.state.langs[0]) || 'en');
  maps.applyTitle = () => { const meta = maps.current; if (meta) document.title = maps.name(meta, 'en') + (meta.subtitle ? ' — ' + meta.subtitle : ''); };
  maps.title = (m) => maps.name(m || maps.current, 'en') || 'Transit map';

  maps.dir = (m) => `maps/${(m || maps.current).id}/`;
  maps.logoSrc = (meta) => {
    if (!meta || !meta.logo) return null;
    return /^(data:|https?:)/i.test(meta.logo) ? meta.logo : (meta.kind === 'files' && !/\.\./.test(meta.logo) ? maps.dir(meta) + meta.logo.replace(/^\/+/, '') : null);
  };
  maps.switchTo = (id) => {
    if (!maps.find(id)) return;
    try { storage.set(LAST, id); } catch (e) { /* ignore */ }
    if (maps.current && maps.current.id === id && !/[?&]map=/.test(location.search)) return;
    location.href = location.pathname + '?map=' + encodeURIComponent(id);
  };
  maps.forgetLast = () => storage.del(LAST);

  /* Where this map keeps what the visitor changed in this browser. A map made here keeps everything under its own key
     (independent of the dev editor's key); the published default map keeps the key older versions used. */
  maps.userKey = (id) => 'tm.umap.' + id;
  maps.storageKey = (meta) => {
    meta = meta || maps.current;
    if (maps.isUser(meta)) return maps.userKey(meta.id);
    const base = (TM.config && TM.config.storageKey) || 'tm.v1';
    return meta.legacyStorage ? base : base + '.' + meta.id;
  };
  maps.readState = (m) => { try { return JSON.parse(storage.get(maps.storageKey(m)) || '{}') || {}; } catch (e) { return {}; } };
  maps.readImages = (meta) => {
    try { const stored = JSON.parse(storage.get(maps.userKey(meta.id) + '.img') || '{}') || {}; return { files: stored.files && typeof stored.files === 'object' ? stored.files : {}, list: Array.isArray(stored.list) ? stored.list : [] }; } catch (e) { return { files: {}, list: [] }; }
  };

  /* Stations and lines of a published map, straight from its files. */
  maps.readFiles = async (meta) => {
    const folder = maps.dir(meta);
    const [stationIndex, lineIndex] = await Promise.all([getJSON(folder + 'stations/index.json'), getJSON(folder + 'lines/index.json')]);
    const [stationFiles, lineFiles] = await Promise.all([Promise.all(stationIndex.files.map((f) => getJSON(folder + 'stations/' + f))), Promise.all(lineIndex.files.map((f) => getJSON(folder + 'lines/' + f)))]);
    /* services.json is optional — a map without it has one all-stops service per line (see js/route.js) */
    let services = [];
    try { services = await getJSON(folder + 'services.json'); } catch (e) { /* none */ }
    return { stations: stationFiles.flat(), lines: lineFiles, services };
  };

  /* ---------- a whole map as data ("package"): { meta, stations, lines, codes, labelPos, annotations, images: Map(file -> data URI), imageList, logo } ---------- */
  maps.snapshot = async (id) => {
    const meta = maps.find(id);
    if (!meta) throw new Error('Map not found');
    const store = TM.store;
    let mapPackage;
    if (maps.current && meta.id === maps.current.id) {          // the open map: what you see now, with your changes
      const data = store.snapshotData();
      mapPackage = { stations: data.stations, lines: data.lines, services: data.services, codes: data.codes, labelPos: data.labelPos, annotations: data.annotations, legend: data.legend, drawing: data.drawing, calendar: data.calendar, images: new Map(TM.images), imageList: TM.imageList.slice() };
      if (store.background && store.background.dataUri) mapPackage.images.set('background/' + store.background.file, store.background.dataUri);
    } else if (maps.isUser(meta)) {
      const state = maps.readState(meta), images = maps.readImages(meta);
      mapPackage = { stations: state.stations || [], lines: state.lines || [], services: store.normServices(state.services), codes: state.codes || {}, labelPos: state.labelPos || {}, annotations: state.annotations || {}, legend: state.legend || null, drawing: state.drawing || null, calendar: state.calendar || null, images: new Map(Object.entries(images.files)), imageList: images.list };
      if (state.background && state.background.dataUri) mapPackage.images.set('background/' + (state.background.file || 'background.png'), state.background.dataUri);
    } else {
      const files = await maps.readFiles(meta), imageLib = await TM.readImageLib(maps.dir(meta) + 'images/', files.lines);
      mapPackage = { stations: files.stations.map(store.canonStation), lines: files.lines.map(store.canonLine), services: store.normServices(files.services), codes: clone(meta.codes || {}), labelPos: clone(meta.labelPos || {}), annotations: clone(meta.annotations || {}), legend: meta.legend ? clone(meta.legend) : null, drawing: meta.drawing ? clone(meta.drawing) : null, calendar: meta.calendar ? clone(meta.calendar) : null, images: imageLib.images, imageList: imageLib.list };
    }
    mapPackage.meta = clone(meta);
    mapPackage.logo = await maps.logoData(meta);
    return mapPackage;
  };

  maps.logoData = async (meta) => {
    if (!meta || !meta.logo) return null;
    if (/^data:/i.test(meta.logo)) return meta.logo;
    const logoSrc = maps.logoSrc(meta);
    if (!logoSrc) return null;
    try { return await TM.toDataURI(logoSrc, meta.logo); } catch (e) { return null; }
  };

  /* ---------- new / copy / import ---------- */
  const persist = (meta, mapPackage) => {
    const key = maps.userKey(meta.id);
    try {
      storage.set(key, JSON.stringify({ author: TM.store.author, stations: mapPackage.stations, lines: mapPackage.lines, services: mapPackage.services || [], codes: mapPackage.codes || {}, labelPos: mapPackage.labelPos || {}, annotations: mapPackage.annotations || {}, legend: mapPackage.legend || null, drawing: mapPackage.drawing || null, calendar: mapPackage.calendar || null, links: [], moves: {}, geo: {}, bends: {} }));
      storage.set(key + '.img', JSON.stringify({ files: Object.fromEntries(mapPackage.images), list: mapPackage.imageList }));
      maps.user.push(meta); writeReg();
    } catch (e) {
      maps.user = maps.user.filter((m) => m.id !== meta.id); storage.del(key); storage.del(key + '.img');
      throw new Error('Not enough browser storage for this map — delete a map you no longer need, or export it as a zip first.');
    }
  };

  /* o: { names, subtitle, description, country, area, logo (data URI | null | undefined = keep the source's), center, zoom, anchor, navigator, from (map id | null = empty map) } */
  maps.create = async (options) => {
    const source = options.from ? await maps.snapshot(options.from) : { meta: {}, stations: [], lines: [], codes: {}, labelPos: {}, annotations: {}, images: new Map(), imageList: [], logo: null };
    return maps.createFromPackage(source, options);
  };
  maps.createFromPackage = (mapPackage, options) => {
    options = options || {};
    const sourceMeta = mapPackage.meta || {}, names = options.names || sourceMeta.names || {};
    const id = maps.uniqueId(names.en || TM.nameOf({ names }, 'en') || 'my-map');
    const meta = maps.normMeta({
      names, subtitle: options.subtitle != null ? options.subtitle : sourceMeta.subtitle, description: options.description != null ? options.description : sourceMeta.description,
      country: options.country != null ? options.country : sourceMeta.country, area: options.area != null ? options.area : sourceMeta.area,
      logo: options.logo !== undefined ? options.logo : mapPackage.logo, author: TM.store.author, created: TM.today(),
      center: options.center || sourceMeta.center, zoom: options.zoom != null ? options.zoom : sourceMeta.zoom, anchor: options.anchor || sourceMeta.anchor, from: options.from || null,
      langOrder: options.langOrder !== undefined ? options.langOrder : sourceMeta.langOrder,
      languages: options.languages !== undefined ? options.languages : sourceMeta.languages,
      navigator: options.navigator !== undefined ? options.navigator : sourceMeta.navigator,
    }, id, 'user');
    persist(meta, mapPackage);
    return meta;
  };

  maps.update = (id, patch) => {
    const meta = maps.user.find((x) => x.id === id);
    if (!meta) return false;
    Object.assign(meta, maps.normMeta(Object.assign({}, meta, patch), meta.id, 'user'));
    try { writeReg(); } catch (e) { throw new Error('Could not save in this browser (storage full?)'); }
    if (maps.current && maps.current.id === id) { maps.applyTitle(); TM.applyMapLanguages(); TM.applyMapDisplay(); }
    TM.emit('map');
    return true;
  };

  maps.remove = (id) => {
    if (!maps.user.some((m) => m.id === id)) return false;
    maps.user = maps.user.filter((m) => m.id !== id);
    storage.del(maps.userKey(id)); storage.del(maps.userKey(id) + '.img');
    writeReg();
    if (maps.current && maps.current.id === id) { maps.forgetLast(); location.href = location.pathname; }
    else TM.emit('map');
    return true;
  };

  /* ---------- zip: package <-> folder of files ---------- */
  const MIME = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const extOf = (p) => (/\.([a-z0-9]+)$/i.exec(p) || [])[1] ? /\.([a-z0-9]+)$/i.exec(p)[1].toLowerCase() : '';
  const toBase64 = (u8) => { let binary = ''; for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(binary); };
  const toURI = (bytes, path) => {
    const extension = extOf(path);
    return extension === 'svg' ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(TM.zip.text(bytes)) : `data:${MIME[extension]};base64,${toBase64(bytes)}`;
  };
  const fromURI = (dataUri) => {
    const match = /^data:([^;,]+)((?:;[^;,]+)*),(.*)$/s.exec(dataUri || '');
    if (!match) return null;
    const extension = Object.keys(MIME).find((k) => MIME[k] === match[1] && k !== 'jpeg');
    if (!extension) return null;
    let data;
    if (/;base64/.test(match[2])) { const binary = atob(match[3]); data = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i); } else data = new TextEncoder().encode(decodeURIComponent(match[3]));
    return { data, ext: extension };
  };

  const fmtStations = (recs) => '[\n' + recs.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n';
  const fmtLine = (line) => {
    const { path, geoBends, geoSeg, branches, ...head } = line;
    /* stretches in the line's own order (its path, then its branches): "A1>A2" before "A2>A3", whenever they were drawn */
    const at = new Map();
    [path || [], ...(branches || []).map((b) => b.path || [])].forEach((list) => list.forEach((p) => { const id = typeof p === 'string' ? p : p && p.s; if (id != null && !at.has(id)) at.set(id, at.size); }));
    const rank = (k) => k.split('>').map((id) => (at.has(id) ? at.get(id) : Infinity));
    const ordered = (entries) => Object.entries(entries).sort(([a], [b]) => { const ra = rank(a), rb = rank(b); return (ra[0] - rb[0]) || (ra[1] - rb[1]) || a.localeCompare(b, undefined, { numeric: true }); });
    const block = (key, entries) => (entries && Object.keys(entries).length   // real-map bends / line styles: one "A>B" stretch per line
      ? `  "${key}": {\n` + ordered(entries).map(([k, v]) => '    ' + JSON.stringify(k) + ': ' + JSON.stringify(v)).join(',\n') + '\n  },\n' : '');
    /* branches after the main path, each branch's own path one item per line too */
    const branchesText = branches && branches.length ? ',\n  "branches": [\n' + branches.map((branch) => {
      const { path: branchPath, ...branchHead } = branch, headText = JSON.stringify(branchHead).slice(1, -1);
      return '    {' + headText + ', "path": [\n' + (branchPath || []).map((p) => '      ' + JSON.stringify(p)).join(',\n') + '\n    ]}';
    }).join(',\n') + '\n  ]' : '';
    return JSON.stringify(head, null, 2).slice(0, -2) + ',\n' + block('geoBends', geoBends) + block('geoSeg', geoSeg) + '  "path": [\n' + (path || []).map((p) => '    ' + JSON.stringify(p)).join(',\n') + '\n  ]' + branchesText + '\n}\n';
  };
  maps.fmtLine = fmtLine;
  /* services.json: one service per line, like the stations' files */
  maps.fmtServices = (list) => '{\n  "services": [\n' + (list || []).map((sv) => '    ' + JSON.stringify(sv)).join(',\n') + ((list || []).length ? '\n' : '') + '  ]\n}\n';
  const fname = (base, used) => { let name = base || 'x', number = 2; while (used.has(name)) name = (base || 'x') + '-' + number++; used.add(name); return name; };

  /* [{ path, data }] for a package, without a root folder. Station order and line order (which decides precedence) are kept. */
  maps.toFiles = (mapPackage) => {
    const files = [], sourceMeta = mapPackage.meta || {};
    const logo = fromURI(mapPackage.logo);
    const names = {};
    Object.entries(sourceMeta.names || {}).forEach(([k, v]) => { if (v && String(v).trim()) names[k] = v; });
    const meta = { id: sourceMeta.id, names, subtitle: sourceMeta.subtitle || '', description: sourceMeta.description || '' };
    if (sourceMeta.country) meta.country = sourceMeta.country;
    if (sourceMeta.area) meta.area = sourceMeta.area;
    if (logo) meta.logo = 'logo.' + logo.ext;
    if (sourceMeta.author) meta.author = sourceMeta.author;
    if (sourceMeta.created) meta.created = sourceMeta.created;
    if (sourceMeta.center) meta.center = sourceMeta.center;
    if (sourceMeta.zoom != null) meta.zoom = sourceMeta.zoom;
    if (sourceMeta.anchor) meta.anchor = sourceMeta.anchor;
    if (sourceMeta.langOrder && sourceMeta.langOrder.length) meta.langOrder = sourceMeta.langOrder;
    if (sourceMeta.languages && sourceMeta.languages.length) meta.languages = sourceMeta.languages;
    meta.navigator = sourceMeta.navigator !== false;
    if (mapPackage.codes && Object.keys(mapPackage.codes).length) meta.codes = mapPackage.codes;
    if (mapPackage.labelPos && Object.keys(mapPackage.labelPos).length) meta.labelPos = mapPackage.labelPos;
    if (mapPackage.annotations && Object.keys(mapPackage.annotations).length) meta.annotations = mapPackage.annotations;
    if (Array.isArray(mapPackage.legend)) meta.legend = mapPackage.legend;
    if (mapPackage.drawing && mapPackage.drawing.items && mapPackage.drawing.items.length) meta.drawing = mapPackage.drawing;
    if (mapPackage.calendar && (mapPackage.calendar.tz || (mapPackage.calendar.holidays || []).length)) meta.calendar = mapPackage.calendar;
    files.push({ path: 'map.json', data: JSON.stringify(meta, null, 2) + '\n' });
    if (logo) files.push({ path: meta.logo, data: logo.data });

    const runs = [], prefix = (id) => ((/^[A-Za-z]+/.exec(id) || ['other'])[0]).toLowerCase();
    mapPackage.stations.forEach((s) => { const pathPrefix = prefix(String(s.id)), last = runs[runs.length - 1]; if (last && last.p === pathPrefix) last.list.push(s); else runs.push({ p: pathPrefix, list: [s] }); });
    const usedStationNames = new Set(['index']), sNames = [];
    runs.forEach((r) => { const fileName = fname(r.p, usedStationNames) + '.json'; sNames.push(fileName); files.push({ path: 'stations/' + fileName, data: fmtStations(r.list) }); });
    files.push({ path: 'stations/index.json', data: JSON.stringify({ files: sNames }, null, 2) + '\n' });

    const usedLineNames = new Set(['index']), lNames = [];
    mapPackage.lines.forEach((l) => { const fileName = fname(String(l.id).toLowerCase().replace(/[^a-z0-9_-]/g, '-'), usedLineNames) + '.json'; lNames.push(fileName); files.push({ path: 'lines/' + fileName, data: fmtLine(l) }); });
    files.push({ path: 'lines/index.json', data: JSON.stringify({ files: lNames }, null, 2) + '\n' });
    files.push({ path: 'services.json', data: maps.fmtServices(mapPackage.services || []) });   // always, even empty: nothing to fail to find

    const listed = (mapPackage.imageList || []).map(({ file, name }) => ({ file, name }));
    mapPackage.images.forEach((uri, file) => { const image = TM.safeImagePath(file) && fromURI(uri); if (image) files.push({ path: 'images/' + file, data: image.data }); });
    if (listed.length) files.push({ path: 'images/index.json', data: JSON.stringify({ files: listed }, null, 2) + '\n' });
    return files;
  };

  const README = (id) => `Fantasy Transit Map — map "${id}"\n\n` +
    `Use it in the browser:  open the site, then  Maps ▾ → Import map (.zip)  and choose this file.\n\n` +
    `Publish it on your own copy of the site (GitHub Pages):\n` +
    `  1. Unzip and put the folder "${id}" inside the project's maps/ folder.\n` +
    `  2. Add "${id}" to the "maps" list in maps/index.json.\n` +
    `  3. Commit and push. It then appears in the map list for every visitor.\n`;

  maps.exportZip = async (id) => {
    const mapPackage = await maps.snapshot(id), meta = mapPackage.meta, root = meta.id;
    mapPackage.meta.id = root;
    const files = maps.toFiles(mapPackage).map((f) => ({ path: root + '/' + f.path, data: f.data }));
    files.push({ path: root + '/README.txt', data: README(root) });
    const blob = await TM.zip.build(files);
    TM.download(root + '.zip', blob, 'application/zip');
    return { files: files.length, stations: mapPackage.stations.length, lines: mapPackage.lines.length };
  };

  /* zip file contents -> package (throws a readable message when it is not a map) */
  maps.fromFiles = (files) => {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const mapJson = files.filter((f) => /(^|\/)map\.json$/.test(f.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
    let root = '';
    if (mapJson) root = mapJson.path.slice(0, -'map.json'.length);
    else {
      const anyData = files.find((f) => /(^|\/)(stations|lines)\/[^/]+\.json$/.test(f.path));
      if (!anyData) throw new Error('This zip does not contain a map (no map.json, stations/ or lines/)');
      root = anyData.path.replace(/(stations|lines)\/[^/]+\.json$/, '');
    }
    const fileAt = (p) => byPath.get(root + p) || null;
    const json = (f) => JSON.parse(TM.zip.text(f.data));
    const list = (folder) => {
      const index = fileAt(folder + '/index.json');
      let names = null;
      if (index) { try { names = (json(index).files || []).map(String); } catch (e) { /* fall back to a scan */ } }
      if (!names) names = files.filter((f) => f.path.startsWith(root + folder + '/') && /^[^/]+\.json$/.test(f.path.slice((root + folder + '/').length)) && !/\/index\.json$/.test(f.path)).map((f) => f.path.slice((root + folder + '/').length)).sort();
      return names.map((n) => fileAt(folder + '/' + n)).filter(Boolean).map(json);
    };
    const stations = list('stations').flat().filter((s) => s && s.id != null), lines = list('lines').filter((l) => l && l.id != null && Array.isArray(l.path));
    if (!stations.length && !lines.length) throw new Error('This map has no stations or lines');
    let raw = {};
    if (mapJson) { try { raw = json(mapJson); } catch (e) { throw new Error('map.json is not valid JSON'); } }
    const store = TM.store, images = new Map();
    files.forEach((file) => {
      if (!file.path.startsWith(root + 'images/')) return;
      const relative = file.path.slice((root + 'images/').length);
      if (TM.safeImagePath(relative)) images.set(relative, toURI(file.data, relative));
    });
    let imageList = [];
    const imageIndex = fileAt('images/index.json');
    if (imageIndex) { try { imageList = (json(imageIndex).files || []).map((it) => (typeof it === 'string' ? { file: it, name: it.replace(/\.[^.]+$/, '') } : { file: String(it.file), name: String(it.name || it.file) })).filter((e) => images.has(e.file)); } catch (e) { /* no list */ } }
    let logo = null;
    if (raw.logo && !/\.\./.test(raw.logo)) { const logoFile = fileAt(String(raw.logo).replace(/^\/+/, '')); if (logoFile && MIME[extOf(logoFile.path)]) logo = toURI(logoFile.data, logoFile.path); }
    let services = [];
    const servicesJson = fileAt('services.json');
    if (servicesJson) { try { services = store.normServices(json(servicesJson)); } catch (e) { /* not valid: a map without services */ } }
    return {
      meta: maps.normMeta(Object.assign({}, raw, { logo: null }), maps.slug(raw.id) || 'imported', 'user'), services,
      stations: stations.map(store.canonStation), lines: lines.map(store.canonLine), codes: raw.codes && typeof raw.codes === 'object' ? raw.codes : {},
      labelPos: raw.labelPos && typeof raw.labelPos === 'object' ? raw.labelPos : {},
      annotations: raw.annotations && typeof raw.annotations === 'object' ? raw.annotations : {},
      legend: Array.isArray(raw.legend) ? raw.legend : null,
      drawing: raw.drawing && typeof raw.drawing === 'object' ? raw.drawing : null,
      calendar: raw.calendar && typeof raw.calendar === 'object' ? raw.calendar : null,
      images, imageList, logo,
    };
  };

  maps.importZip = async (file) => {
    const mapPackage = maps.fromFiles(await TM.zip.read(await file.arrayBuffer()));
    if (!TM.nameOf({ names: mapPackage.meta.names }, 'en')) mapPackage.meta.names = Object.assign({}, mapPackage.meta.names, { en: file.name.replace(/\.zip$/i, '') });
    return maps.createFromPackage(mapPackage, { from: null });
  };
})(window.TM);
