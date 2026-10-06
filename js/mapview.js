/* Real-map mode (Leaflet + OpenStreetMap tiles): shows visible lines by station coordinates. */
(function (TM) {
  const realMap = (TM.map = { map: null, layer: null, tile: null, fitted: false, _tileGen: 0, _moveTarget: null });
  /* how each drawn line style looks on the real map (Leaflet dash patterns are in screen pixels, line weight 6) */
  const DRAWN = {
    solid: { dashArray: null, lineCap: 'round' },
    dash: { dashArray: '10 8', lineCap: 'butt' },
    dashdot: { dashArray: '10 6 2 6', lineCap: 'butt' },
    hatch: { dashArray: '3 3', lineCap: 'butt' },
    dotted: { dashArray: '1 8', lineCap: 'round' },
  };
  const LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
  let loading = null;

  realMap.ensure = () => {
    if (window.L) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet'; stylesheet.href = LEAFLET + 'leaflet.css';
      document.head.appendChild(stylesheet);
      const script = document.createElement('script');
      script.src = LEAFLET + 'leaflet.js';
      script.onload = () => { TM.patchLeaflet(); resolve(); };
      script.onerror = () => { loading = null; reject(new Error('Leaflet failed to load')); };
      document.head.appendChild(script);
    });
    return loading;
  };

  /* MapLibre GL + its Leaflet bridge, loaded only when the vector (Shortbread) layer is actually picked. */
  const MAPLIBRE_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4/dist/maplibre-gl.css';
  const MAPLIBRE_JS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4/dist/maplibre-gl.js';
  const BRIDGE_JS = 'https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.0.20/leaflet-maplibre-gl.js';
  let mlLoading = null;
  function ensureMapLibre() {
    if (window.L && L.maplibreGL) return Promise.resolve();
    if (mlLoading) return mlLoading;
    mlLoading = new Promise((resolve, reject) => {
      const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = MAPLIBRE_CSS; document.head.appendChild(stylesheet);
      const vectorScript = document.createElement('script');
      vectorScript.src = MAPLIBRE_JS;
      vectorScript.onload = () => {
        const pluginScript = document.createElement('script');
        pluginScript.src = BRIDGE_JS;
        pluginScript.onload = resolve;
        pluginScript.onerror = () => { mlLoading = null; reject(new Error('maplibre-gl-leaflet failed to load')); };
        document.head.appendChild(pluginScript);
      };
      vectorScript.onerror = () => { mlLoading = null; reject(new Error('MapLibre GL failed to load')); };
      document.head.appendChild(vectorScript);
    });
    return mlLoading;
  }

  /* Map styles the real map can show underneath it — OSM Standard (the original default) plus a few other free,
     no-key sources people commonly want: raster XYZ tiles, and one true OSM Shortbread-schema vector style (served
     by OpenFreeMap, no key needed) rendered with MapLibre GL. Swapping never touches the map's own data — it is
     only ever which picture is drawn underneath it. */
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const TILE_LAYERS = {
    osm: { name: 'OpenStreetMap (default)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: OSM_ATTR, max: 19 },
    shortbread: { name: 'OSM Shortbread (vector)', vector: true, style: 'https://tiles.openfreemap.org/styles/liberty', attr: OSM_ATTR + ', tiles by <a href="https://openfreemap.org">OpenFreeMap</a>' },
    topo: { name: 'OpenTopoMap', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attr: OSM_ATTR + ', SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a>', max: 17 },
    satellite: { name: 'Satellite (Esri)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: '&copy; Esri', max: 19 },
  };
  const theme = () => document.documentElement.dataset.theme || 'light';
  realMap.tileLayers = TILE_LAYERS;
  realMap.tileKey = () => (TILE_LAYERS[TM.state.mapTileLayer] ? TM.state.mapTileLayer : 'osm');

  function setTiles(map, owner) {
    const key = realMap.tileKey(), layer = TILE_LAYERS[key], generation = ++owner._tileGen;   // a gen token so a slow vector load can't clobber a later switch back to raster
    if (owner.tile) { map.removeLayer(owner.tile); owner.tile = null; }
    if (layer.vector) {
      ensureMapLibre().then(() => {
        if (owner._tileGen !== generation) return;
        owner.tile = L.maplibreGL({ style: layer.style, attribution: layer.attr }).addTo(map);
      }).catch(() => { if (owner._tileGen === generation) { TM.toast('Could not load the vector map layer (offline?)', 'err'); realMap.setTileLayer('osm'); } });
    } else {
      owner.tile = L.tileLayer(layer.url, { attribution: layer.attr, maxZoom: layer.max }).addTo(map);
    }
    map.getContainer().classList.toggle('map-dark', theme() === 'dark' && key === 'osm');   // the dark CSS filter is tuned for OSM Standard only
  }
  realMap.setTileLayer = (key) => {
    TM.state.mapTileLayer = TILE_LAYERS[key] ? key : 'osm';
    if (realMap.map) setTiles(realMap.map, realMap);
    TM.emit('maptool');
  };

  const nameOf = (station) => {
    const out = [];
    TM.state.langs.forEach((lg) => { const name = (station.names[lg] || '').trim(); if (name && !out.includes(name)) out.push(name); });
    return out.length ? out.join(' · ') : TM.nameOf(station, 'en');
  };

  const stationStyle = (station, isBig, palette) => {
    const style = { radius: isBig ? 9 : 6, color: palette.ink, weight: isBig ? 4 : 3, fillColor: palette.paper, fillOpacity: 1 };
    if (station.status === 'fantasy') style.fillColor = palette.fantasy;
    else if (station.status === 'under_construction') { style.fillColor = palette.warn; style.dashArray = '3 3'; }
    else if (station.status === 'provisional') style.dashArray = '1 4';
    else if (station.status === 'planned') { style.color = palette.muted; style.dashArray = '4 3'; }
    else if (station.status === 'abandoned') { style.color = palette.muted; style.fillOpacity = 0.4; }
    else if (station.status === 'demolished') { style.color = palette.muted; style.fillOpacity = 0.2; style.opacity = 0.6; style.dashArray = '2 3'; }
    return style;
  };

  /* ---------- route bends (real map only) ---------- */
  const vertexIcon = () => L.divIcon({ className: 'bend-handle', html: '<span></span>', iconSize: [16, 16], iconAnchor: [8, 8] });
  const ghostIcon = () => L.divIcon({ className: 'bend-handle ghost', html: '<span></span>', iconSize: [14, 14], iconAnchor: [7, 7] });
  const toPair = (ll) => [ll.lat, ll.lng];
  const later = (fn) => setTimeout(fn, 0);
  const DBL_CLICK_MS = 320;
  let lineClickTimer = 0;                                     // a click on a line, waiting to be sure it is not a double-click                                   // how long a click waits to be sure it is not the first half of a double-click                    // never rebuild the layer from inside a Leaflet drag / click handler

  const commitBends = (ln, a, b, pts) => { later(() => { TM.actions.setBends(ln.id, a.id, b.id, pts); }); };

  /* where a bend clicked on the line goes: after the last existing bend that lies before the click along the segment */
  function insertAt(bends, stationA, stationB, latLng) {
    const chain = [[stationA.lat, stationA.lng], ...bends, [stationB.lat, stationB.lng]], point = realMap.map.latLngToLayerPoint(latLng);
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < chain.length - 1; i++) {
      const distance = L.LineUtil.pointToSegmentDistance(point, realMap.map.latLngToLayerPoint(chain[i]), realMap.map.latLngToLayerPoint(chain[i + 1]));
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    const out = bends.slice();
    out.splice(best, 0, toPair(latLng));
    return out;
  }

  /* handles on one segment of the line being shaped: ● existing bends (drag to move, double-click to remove), ○ midpoints (drag to add a bend) */
  function bendHandles(line, stationA, stationB, bends, poly) {
    const startPair = [stationA.lat, stationA.lng], endPair = [stationB.lat, stationB.lng], chain = [startPair, ...bends, endPair];
    bends.forEach((pair, i) => {
      const marker = L.marker(pair, { draggable: true, keyboard: false, icon: vertexIcon(), zIndexOffset: 800 }).addTo(realMap.layer);
      marker.bindTooltip(`${pair[2] ? TM.esc(TM.MARKS[pair[2].k].name) + ' · ' : ''}Drag to move · Click for a marker or route copy · Double-click to remove`, { direction: 'top', offset: [0, -8] });
      const withMark = (ll) => (pair[2] ? [...toPair(ll), pair[2]] : toPair(ll));   // a moved bend keeps its point marker
      marker.on('drag', () => { const newBends = bends.slice(); newBends[i] = toPair(marker.getLatLng()); poly.setLatLngs([startPair, ...newBends, endPair]); });
      marker.on('dragend', () => { const newBends = bends.slice(); newBends[i] = withMark(marker.getLatLng()); commitBends(line, stationA, stationB, newBends); });
      /* one click opens the marker popup — but only once a double-click (remove) can no longer follow it */
      let clickTimer = 0;
      marker.on('click', (e) => { L.DomEvent.stop(e); clearTimeout(clickTimer); clickTimer = setTimeout(() => markPopup(line, stationA, stationB, i, pair), DBL_CLICK_MS); });
      const drop = (e) => { L.DomEvent.stop(e); clearTimeout(clickTimer); commitBends(line, stationA, stationB, bends.filter((_, j) => j !== i)); };
      marker.on('dblclick', drop); marker.on('contextmenu', drop);
    });
    for (let i = 0; i < chain.length - 1; i++) {
      const pointA = realMap.map.latLngToContainerPoint(chain[i]), pointB = realMap.map.latLngToContainerPoint(chain[i + 1]);
      if (Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y) < 34) continue;                 // too short to grab a midpoint handle: zoom in
      const midMarker = L.marker([(chain[i][0] + chain[i + 1][0]) / 2, (chain[i][1] + chain[i + 1][1]) / 2], { draggable: true, keyboard: false, icon: ghostIcon(), zIndexOffset: 700 }).addTo(realMap.layer);
      midMarker.bindTooltip('Drag to bend the route', { direction: 'top', offset: [0, -8] });
      midMarker.on('drag', () => poly.setLatLngs([...chain.slice(0, i + 1), toPair(midMarker.getLatLng()), ...chain.slice(i + 1)]));
      midMarker.on('dragend', () => { const newBends = bends.slice(); newBends.splice(i, 0, toPair(midMarker.getLatLng())); commitBends(line, stationA, stationB, newBends); });
    }
  }

  /* ---------- point markers on route bends (TM.MARKS) — the real map's own, apart from the schematic's ---------- */
  /* a marker drawn on the map, turned the way the line runs there (screen angle from its neighbours) */
  function markIcon(mk, angle, palette) {
    const glyph = TM.symbols.mark(mk, 6, palette);
    return L.divIcon({ className: 'geo-mark', html: `<svg width="60" height="60" viewBox="-30 -30 60 60" style="transform:rotate(${angle}deg);overflow:visible">${glyph.under}${glyph.over}</svg>`, iconSize: [60, 60], iconAnchor: [30, 30] });
  }
  /* choose the marker of one route bend: a small popup on it */
  function markPopup(line, stationA, stationB, i, pair) {
    if (!TM.actions.ownsLine(line)) { TM.toast('Not your line to mark', 'err'); return; }
    const current = pair[2] || null, box = document.createElement('div'), color = TM.lineColor(TM.store.rootLine(line) || line);
    let picked = current ? current.k : '';
    box.className = 'mark-pop';
    const draw = () => {
      const range = picked && TM.MARKS[picked].range, side = current && current.k === picked ? current.s : 'a';
      box.innerHTML = `<div class="mark-pop-h">Point marker</div><div class="sym-grid mark-pop-grid">` +
        [['', 'None'], ...Object.entries(TM.MARKS).map(([k, m]) => [k, m.name])].map(([k, t]) => `<button type="button" data-mk="${k}" class="${picked === k ? 'on' : ''}">${TM.ui.markPreview(k, picked === k ? side : 'a', color)}${TM.esc(t)}</button>`).join('') + '</div>' +
        (range ? `<div class="row" style="justify-content:space-between;gap:8px;margin-top:8px"><span class="hint">The ${range === 'tunnel' ? 'tunnel' : 'viaduct'}</span><div class="seg"><button type="button" data-s="b" class="${side === 'b' ? 'on' : ''}">Ends here</button><button type="button" data-s="a" class="${side !== 'b' ? 'on' : ''}">Starts here</button></div></div>` +
          `<p class="hint" style="margin:6px 0 0">“Starts here” runs on towards ${TM.esc(TM.nameOf(stationB, TM.state.langs[0]) || stationB.id)}.</p>` : '') +
        `<div class="mark-pop-h" style="margin-top:12px">Copy route from another line</div><p class="hint" style="margin:0 0 6px">Pick two points (bends or stations) of another line — the route between them is added here.</p>` +
        `<div class="seg" style="width:100%"><button type="button" data-copy="before" style="flex:1">Insert before this bend</button><button type="button" data-copy="after" style="flex:1">Insert after</button></div>`;
    };
    draw();
    /* kept clear of the tools (left) and the banner (top) when it pans into view */
    const popup = L.popup({ closeButton: true, autoClose: true, className: 'tm-popup', maxWidth: 340, minWidth: 300, autoPanPaddingTopLeft: L.point(70, 190), autoPanPaddingBottomRight: L.point(60, 20) })
      .setLatLng([pair[0], pair[1]]).setContent(box).openOn(realMap.map);
    const commit = (s) => { popup.close(); later(() => TM.actions.setGeoMark(line.id, stationA.id, stationB.id, i, picked ? { k: picked, s } : null)); };
    box.addEventListener('click', (e) => {
      /* the redraw below takes the clicked button out of the page; Leaflet would then not see the click came from inside
         the popup and close it as a click on the map — so it never gets that far */
      L.DomEvent.stop(e);
      const kind = e.target.closest('[data-mk]'), side = e.target.closest('[data-s]'), copy = e.target.closest('[data-copy]');
      if (copy) { popup.close(); realMap._copy = { line: line.id, a: stationA.id, b: stationB.id, i, where: copy.dataset.copy, anchor: [pair[0], pair[1]], picks: [] }; later(() => { renderTools(); realMap.render(); }); return; }
      if (kind) { picked = kind.dataset.mk; if (picked && TM.MARKS[picked].range) { draw(); popup.update(); } else commit(); }   // a tunnel / viaduct still needs its side
      else if (side && picked) commit(side.dataset.s);
    });
  }

  /* ---------- copying a stretch of another line's route onto the line being shaped (Bend route → click a bend) ----------
     realMap._copy: { line, a, b, i (the bend), where: 'before' | 'after', anchor: [lat, lng], picks: [{ line, k }] } */
  /* a line's whole real-map route as points in its own order: stations and the bends between them */
  function routePoints(line) {
    const out = [];
    TM.store.geoPairs(line).forEach((pair, p) => {
      if (!p) out.push({ ll: [pair.a.lat, pair.a.lng], st: pair.a });
      TM.store.routeBends(line, pair.a.id, pair.b.id).forEach((b) => out.push({ ll: [b[0], b[1]] }));
      out.push({ ll: [pair.b.lat, pair.b.lng], st: pair.b });
    });
    return out;
  }
  function copyPick(line, k) {
    const job = realMap._copy;
    if (!job) return;
    if (job.picks.length && job.picks[0].line !== line.id) { TM.toast('Pick the second point on the same line as the first', 'err'); return; }
    if (job.picks.length && job.picks[0].k === k) return;
    job.picks.push({ line: line.id, k });
    if (job.picks.length < 2) { renderTools(); realMap.render(); return; }
    /* the stretch between the two picks, both ends included, turned so the end nearer the chosen bend joins it */
    const pts = routePoints(line), lo = Math.min(job.picks[0].k, job.picks[1].k), hi = Math.max(job.picks[0].k, job.picks[1].k);
    let seq = pts.slice(lo, hi + 1).map((q) => [q.ll[0], q.ll[1]]);
    const d = (q) => TM.haversine(q[0], q[1], job.anchor[0], job.anchor[1]);
    if (job.where === 'after' ? d(seq[0]) > d(seq[seq.length - 1]) : d(seq[seq.length - 1]) > d(seq[0])) seq = seq.reverse();
    const target = TM.store.line(job.line), bends = TM.store.routeBends(target, job.a, job.b).map((p) => p.slice());
    bends.splice(job.where === 'after' ? job.i + 1 : job.i, 0, ...seq);
    realMap._copy = null;
    later(() => { if (TM.actions.setBends(job.line, job.a, job.b, bends)) TM.toast(`${seq.length} point${seq.length === 1 ? '' : 's'} copied from ${line.code}`); renderTools(); realMap.render(); });
  }
  /* while copying: every point of the other lines can be clicked */
  function copyHandles(lines, palette) {
    const job = realMap._copy;
    lines.forEach((line) => {
      if (TM.store.rootId(line.id) === TM.store.rootId(job.line)) return;
      routePoints(line).forEach((q, k) => {
        const picked = job.picks.some((p) => p.line === line.id && p.k === k), off = job.picks.length && job.picks[0].line !== line.id;
        const dot = L.circleMarker(q.ll, { radius: picked ? 8 : q.st ? 6 : 5, color: picked ? palette.ink : TM.lineColor(line), weight: 2.5, fillColor: picked ? TM.lineColor(line) : palette.paper, fillOpacity: 1, opacity: off ? 0.35 : 1 }).addTo(realMap.layer);
        dot.bindTooltip(`${TM.esc(line.code)} · ${q.st ? TM.esc(nameOf(q.st)) : 'bend'}${picked ? ' · picked' : ''}`, { direction: 'top', offset: [0, -6] });
        dot.on('click', (e) => { L.DomEvent.stop(e); copyPick(line, k); });
      });
    });
  }

  /* toolbar + banner of the real map */
  const $ = (id) => document.getElementById(id);
  realMap.setTool = (tool) => {
    TM.state.mapTool = ['bend', 'movepoint', 'linestyle'].includes(tool) ? tool : 'select';
    if (TM.state.mapTool !== 'bend') realMap._copy = null;
    if (TM.state.mapTool !== 'movepoint') realMap._moveTarget = null;
    TM.emit('maptool');
  };
  let layerOpen = false;
  function renderTools() {
    const on = TM.state.mode === 'map', tool = TM.state.mapTool, activeLine = TM.actions.activeLine();
    $('mapTools').hidden = !on; $('mapBanner').hidden = !on || tool === 'select';
    if (!on) return;
    $('mapTools').innerHTML = [['select', 'cursor', 'Select stations', 'V'], ['bend', 'bend', 'Bend route between stations', 'B'], ['linestyle', 'linestyle', 'Change line style', 'D'], ['movepoint', 'pin', 'Move a station to a clicked point', 'P']]
      .map(([k, ic, tip, key]) => `<button class="tool ${tool === k ? 'on' : ''}" data-mtool="${k}" aria-label="${tip}">${TM.icon(ic)}<span class="tip">${tip} · ${key}</span></button>`).join('') +
      `<hr><div class="tools-anchor"><button class="tool ${layerOpen ? 'on' : ''}" id="mapLayerToggle" aria-label="Map layer">${TM.icon('map')}<span class="tip">Map layer: ${TM.esc(TILE_LAYERS[realMap.tileKey()].name)}</span></button>` +
      (layerOpen ? `<div class="tools-flyout">${Object.entries(TILE_LAYERS).map(([k, t]) => `<button class="tool ${k === realMap.tileKey() ? 'on' : ''}" data-tilekey="${k}" aria-label="${TM.esc(t.name)}">${TM.icon('map')}<span class="tip">${TM.esc(t.name)}</span></button>`).join('')}</div>` : '') +
      '</div>';
    if (tool === 'bend' && realMap._copy) {
      const job = realMap._copy, first = job.picks[0] && TM.store.line(job.picks[0].line);
      $('mapBanner').innerHTML = `<b>Copy route</b> · ${job.picks.length ? `Now click the <b>second point</b> on ${TM.esc(first ? first.code : 'that line')}` : 'Click the <b>first point</b> (a bend or a station) on another line'} — the route between the two goes ${job.where} the chosen bend.` +
        `<div class="row" style="justify-content:center;margin-top:6px"><button class="btn sm" data-mcopycancel>Cancel</button></div>`;
    } else if (tool === 'bend') {
      const count = activeLine ? TM.actions.bendTotal(activeLine) : 0;
      $('mapBanner').innerHTML = activeLine
        ? `<b>Bend route · ${TM.esc(activeLine.code)}</b> · Drag <span class="bend-key ghost"></span> to add a bend, <span class="bend-key"></span> to move it; click <span class="bend-key"></span> for a point marker (tunnel, viaduct, crossing…) or a route copy; double-click <span class="bend-key"></span> to remove. <span class="hint">Real map only — the schematic is not affected.</span>` +
          `<div class="row" style="justify-content:center;gap:8px;margin-top:6px"><button class="btn sm" data-mreset ${count ? '' : 'disabled'}>↺ Reset bends${count ? ' (' + count + ')' : ''}</button><button class="btn sm primary" data-mdone>Done</button></div>`
        : '<b>Bend route</b> · Pick a line in the list on the left (or click a line on the map) to shape its real route between stations.';
    } else if (tool === 'linestyle') {
      $('mapBanner').innerHTML = activeLine
        ? (TM.actions.canEdit(activeLine)
          ? `<b>Line style · ${TM.esc(activeLine.code)}</b> · Click a piece of the line — station to station, station to bend or bend to bend — to cycle automatic → dashed → dash-dot → stripes → solid. <span class="hint">Real map only — the schematic is not affected.</span><div class="row" style="justify-content:center;margin-top:6px"><button class="btn sm primary" data-mdone>Done</button></div>`
          : `<b>Line style</b> · ${TM.esc(activeLine.code)} is not your line — duplicate it to restyle it.`)
        : '<b>Line style</b> · Pick one of your lines in the list on the left (or click a line on the map) to restyle it.';
    } else if (tool === 'movepoint') {
      const target = realMap._moveTarget;
      $('mapBanner').innerHTML = target
        ? `<b>Move station to point</b> · Search your own station, pick it to move it to <b>${target.lat.toFixed(5)}, ${target.lng.toFixed(5)}</b><div id="moveSearch" style="max-width:340px;margin:6px auto 0"></div><div class="row" style="justify-content:center;margin-top:4px"><button class="btn sm" data-mpcancel>Cancel</button></div>`
        : '<b>Move station to point</b> · Click a point on the map, then pick one of your own stations to move there.';
      if (target) {
        const searchBox = $('moveSearch');
        if (searchBox) TM.ui.searchStations(searchBox, {
          placeholder: 'Search your own stations…',
          exclude: () => new Set([...TM.store.stations.values()].filter((s) => !TM.actions.ownsStation(s)).map((s) => s.id)),
          hint: 'Only stations you own can be moved.',
          onPick: (station) => {
            if (TM.actions.moveStationGeo(station.id, target.lat, target.lng)) TM.toast(`${station.id} moved to ${target.lat.toFixed(5)}, ${target.lng.toFixed(5)}`);
            realMap._moveTarget = null; renderTools(); realMap.render();
          },
        });
        setTimeout(() => { const input = searchBox.querySelector('input'); if (input) input.focus(); }, 0);   // type straight away
      }
    }
    host().classList.toggle('bend-on', tool === 'bend' && !!activeLine);
    if (realMap.map) { if (tool === 'bend' && activeLine) realMap.map.doubleClickZoom.disable(); else realMap.map.doubleClickZoom.enable(); }
  }
  const host = () => $('mapview');

  realMap.render = () => {
    if (!realMap.map || TM.state.mode !== 'map') return;
    const store = TM.store, palette = TM.symbols.palette(theme()), map = realMap.map;
    realMap.layer.clearLayers();
    const activeLine = TM.actions.activeLine();
    const bounds = [];
    const count = new Map();
    /* lines with their shown suggested stops in (store.effectiveLine) — proposed stretches are drawn dashed */
    const lines = store.trackLines([...store.visible].filter((id) => store.lineFilter.has(id))).map((l) => store.effectiveLine(l, TM.state.showSuggested));   // branches too
    const actE = activeLine && (lines.find((l) => l.id === activeLine.id) || activeLine);
    const actReps = new Set(actE ? actE.path.filter((it) => it.s).map((it) => store.rep(it.s)) : []);
    const sugReps = new Set();
    lines.forEach((ln) => ln.path.forEach((it) => { if (it.sug) sugReps.add(store.rep(it.s)); }));
    /* how many lines call at each station — a line and its branch are one line at their junction */
    const seenAt = new Set();
    lines.forEach((ln) => ln.path.forEach((it) => { if (it.s) { const leadId = store.rep(it.s), key = leadId + '|' + store.rootId(ln); if (seenAt.has(key)) return; seenAt.add(key); count.set(leadId, (count.get(leadId) || 0) + 1); } }));

    const bendMode = TM.state.mapTool === 'bend', styleMode = TM.state.mapTool === 'linestyle';
    lines.forEach((line) => {
      const dimmed = activeLine && activeLine.id !== line.id;
      const editing = bendMode && activeLine && activeLine.id === line.id, styling = styleMode && activeLine && activeLine.id === line.id && TM.actions.canEdit(line);
      const structs = store.geoStructures(line);
      store.geoPairs(line).forEach((pair, p) => {                      // station to station (and, on a loop, the last back to the first)
        const stationA = pair.a, stationB = pair.b, bends = store.routeBends(line, stationA.id, stationB.id), chain = [[stationA.lat, stationA.lng], ...bends, [stationB.lat, stationB.lng]];
        const styles = store.geoPieceStyles(line, pair, chain.length - 1);
        for (let j = 0; j < chain.length - 1; j++) {           // each piece between stations / bends is drawn (and styled) on its own
          const struct = structs[p] && structs[p][j];
          if (struct === 'elevated') {                         // rails along both sides: a grey band under a paper one, under the line
            L.polyline([chain[j], chain[j + 1]], { color: palette.muted, weight: 16, opacity: dimmed ? 0.25 : 0.9, lineCap: 'butt', interactive: false }).addTo(realMap.layer);
            L.polyline([chain[j], chain[j + 1]], { color: palette.paper, weight: 11, opacity: dimmed ? 0.25 : 1, lineCap: 'butt', interactive: false }).addTo(realMap.layer);
          }
          const look = DRAWN[struct === 'tunnel' && styles[j].raw === 'auto' && !styles[j].sug ? 'hatch' : styles[j].drawn] || DRAWN.solid;   // a tunnel is striped unless styled otherwise
          const piece = L.polyline([chain[j], chain[j + 1]], { color: TM.lineColor(line), weight: 6, opacity: dimmed ? 0.25 : 0.95, lineCap: look.lineCap, lineJoin: 'round', dashArray: look.dashArray }).addTo(realMap.layer);
          if (styling) piece.bindTooltip(`${TM.SEG_STYLES[styles[j].raw] || styles[j].raw} · Click to change`, { sticky: true });
          piece.on('click', (e) => {
            if (styling && styles[j].sug) { L.DomEvent.stopPropagation(e); TM.toast('A suggested stretch has no style of its own — it is always dashed'); return; }
            if (styling) { L.DomEvent.stopPropagation(e); later(() => TM.actions.setGeoSeg(line.id, stationA.id, stationB.id, j, TM.SEG_NEXT[styles[j].raw] || 'auto')); return; }
            if (!editing) {   // one click: just pick the line; a double-click (below) also fits the map to it
              L.DomEvent.stopPropagation(e); clearTimeout(lineClickTimer);
              lineClickTimer = setTimeout(() => { if (TM.state.activeLineId !== line.id) TM.actions.setActive(line.id); }, DBL_CLICK_MS);
              return;
            }
            L.DomEvent.stopPropagation(e);                     // clicking the line being shaped adds a bend there
            commitBends(line, stationA, stationB, insertAt(bends, stationA, stationB, e.latlng));
          });
          piece.on('dblclick', (e) => {
            if (editing || styling) return;
            L.DomEvent.stop(e); clearTimeout(lineClickTimer);   // not the map's own double-click zoom
            TM.emit('pick-line', line.id);
          });
        }
        bends.forEach((b, i) => {                              // point markers on this stretch's bends
          if (!b[2]) return;
          const prev = realMap.map.latLngToLayerPoint(chain[i]), next = realMap.map.latLngToLayerPoint(chain[i + 2]);
          const angle = Math.atan2(next.y - prev.y, next.x - prev.x) * 180 / Math.PI;
          L.marker([b[0], b[1]], { icon: markIcon(b[2], angle, palette), interactive: false, keyboard: false, opacity: dimmed ? 0.3 : 1, zIndexOffset: -100 }).addTo(realMap.layer);
        });
        if (editing) {                                          // a thin guide that follows a bend while it is dragged
          const guide = L.polyline(chain, { color: palette.ink, weight: 2, opacity: 0.55, dashArray: '2 5', interactive: false }).addTo(realMap.layer);
          bendHandles(line, stationA, stationB, bends, guide);
        }
      });
    });

    if (realMap._copy && bendMode) copyHandles(lines, palette);
    const drawn = new Set();
    /* a station of a status hidden in Display (planned, provisional…) is left off — the line still runs through it */
    const hidden = (st) => { const toggle = TM.STATUS_TOGGLES.find((t) => t.status === st.status); return !!toggle && TM.state[toggle.opt] === false; };
    lines.forEach((line) => line.path.forEach((item) => {
      if (!item.s) return;
      const leadId = store.rep(item.s);
      if (drawn.has(leadId)) return;
      drawn.add(leadId);
      const station = store.stations.get(leadId); if (!station || hidden(station)) return;
      bounds.push([station.lat, station.lng]);
      const isBig = count.get(leadId) > 1;
      const isDimmed = activeLine && !actReps.has(leadId);
      const marker = L.circleMarker([station.lat, station.lng], Object.assign(stationStyle(station, isBig, palette), isDimmed ? { opacity: 0.35, fillOpacity: 0.35 } : {})).addTo(realMap.layer);
      marker.bindTooltip(`<b>${TM.esc(nameOf(station))}</b>${TM.state.showCodes !== false ? ` <span style="opacity:.6">${TM.esc(store.members(leadId).join(' · '))}</span>` : ''}`, { permanent: true, direction: 'right', offset: [8, 0], className: 'map-label' });
      marker.on('click', () => TM.actions.select({ type: 'station', id: TM.actions.memberOnActive(leadId) }));
      if (sugReps.has(leadId)) L.circleMarker([station.lat, station.lng], { radius: isBig ? 14 : 12, color: palette.fantasy, weight: 2, dashArray: '4 3', fill: false, interactive: false, opacity: isDimmed ? 0.35 : 1 }).addTo(realMap.layer);   // a suggested stop on a line shown here
    }));

    const selection = TM.state.selected;
    if (selection && selection.type === 'station' && store.stations.get(selection.id)) {
      const station = store.stations.get(selection.id);
      L.circleMarker([station.lat, station.lng], { radius: 16, color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4f46e5', weight: 3, dashArray: '5 4', fill: false, interactive: false }).addTo(realMap.layer);
      if (drawn.has(store.rep(selection.id))) {                 // drag the selected station to change its coordinates
        const handle = L.marker([station.lat, station.lng], {
          draggable: true, keyboard: false, zIndexOffset: 1000,
          icon: L.divIcon({ className: 'geo-handle', html: '<span></span>', iconSize: [34, 34], iconAnchor: [17, 17] }),
        }).addTo(realMap.layer);
        handle.bindTooltip(`Drag to move ${TM.esc(station.id)}`, { direction: 'top', offset: [0, -16] });
        handle.on('dragend', () => {
          const latLng = handle.getLatLng();
          if (TM.actions.moveStationGeo(station.id, latLng.lat, latLng.lng)) TM.toast(`${station.id} moved to ${latLng.lat.toFixed(5)}, ${latLng.lng.toFixed(5)}`);
          else realMap.render();
        });
      }
    }

    if (TM.state.showHotspots) {
      store.clusters().forEach((cluster) => {
        L.circle([cluster.lat, cluster.lng], { radius: 300, color: palette.fantasy, weight: 2, dashArray: '6 5', fillColor: palette.fantasy, fillOpacity: 0.1, interactive: true })
          .addTo(realMap.layer)
          .bindTooltip(`${cluster.authors.length} people suggested a station here<br><span style="opacity:.7">${TM.esc(cluster.authors.join(', '))}</span>`, { sticky: true });
      });
    }
    if (!realMap.fitted && bounds.length) { map.fitBounds(bounds, { padding: [40, 40] }); realMap.fitted = true; }
  };

  realMap.show = async () => {
    try { await realMap.ensure(); } catch (e) { TM.toast('Could not load the map library (offline?)', 'err'); TM.state.mode = 'schematic'; TM.emit('mode'); return; }
    const host = document.getElementById('mapview');
    if (!realMap.map) {
      const currentMap = TM.maps.current, anchor = TM.store.anchor;
      realMap.map = L.map(host, { zoomControl: false, preferCanvas: false }).setView(currentMap.center || [anchor.lat, anchor.lng], currentMap.zoom || 12);
      L.control.zoom({ position: 'bottomright' }).addTo(realMap.map);
      realMap.layer = L.layerGroup().addTo(realMap.map);
      setTiles(realMap.map, realMap);
      realMap.map.on('zoomend', () => { host.classList.toggle('z-low', realMap.map.getZoom() < 13); if (TM.state.mapTool === 'bend') realMap.render(); });
      realMap.map.on('click', (e) => { if (TM.state.mapTool === 'movepoint' && !realMap._moveTarget) { realMap._moveTarget = e.latlng; renderTools(); } });
      const FitControl = L.Control.extend({ onAdd() {
        const button = L.DomUtil.create('button', 'btn icon-btn'); button.innerHTML = TM.icon('fit'); button.title = 'Fit lines';
        button.onclick = (ev) => { ev.stopPropagation(); realMap.fitted = false; realMap.render(); };
        return button;
      } });
      new FitControl({ position: 'bottomright' }).addTo(realMap.map);
    }
    setTimeout(() => { realMap.map.invalidateSize(); realMap.render(); }, 30);
  };

  /* Small location picker used by the station dialog. */
  realMap.picker = async (element, start, onPick) => {
    await realMap.ensure();
    const map = L.map(element, { zoomControl: true }).setView([start.lat, start.lng], 15);
    L.tileLayer(TILE_LAYERS.osm.url, { attribution: TILE_LAYERS.osm.attr, maxZoom: TILE_LAYERS.osm.max }).addTo(map);
    if (theme() === 'dark') element.classList.add('map-dark');
    const palette = TM.symbols.palette(theme());
    TM.store.stations.forEach((s) => L.circleMarker([s.lat, s.lng], { radius: 4, color: palette.ink, weight: 2, fillColor: palette.paper, fillOpacity: 1 }).addTo(map).bindTooltip(nameOf(s)));
    const marker = L.marker([start.lat, start.lng], { draggable: true }).addTo(map);
    const zone = L.circle([start.lat, start.lng], { radius: 300, color: palette.fantasy, weight: 1.5, dashArray: '5 4', fillOpacity: 0.06 }).addTo(map);
    const set = (ll, pan) => { marker.setLatLng(ll); zone.setLatLng(ll); if (pan) map.panTo(ll); onPick(ll.lat, ll.lng); };
    map.on('click', (e) => set(e.latlng));
    marker.on('dragend', () => set(marker.getLatLng()));
    setTimeout(() => map.invalidateSize(), 60);
    return { set: (lat, lng) => { marker.setLatLng([lat, lng]); zone.setLatLng([lat, lng]); map.panTo([lat, lng]); }, destroy: () => map.remove() };
  };

  ['change', 'display', 'visibility', 'selection', 'active', 'lang', 'line-filter', 'maptool'].forEach((ev) => TM.on(ev, realMap.render));
  ['active', 'change', 'maptool', 'mode'].forEach((ev) => TM.on(ev, renderTools));
  document.addEventListener('DOMContentLoaded', () => {
    $('mapTools').onclick = (e) => {
      const button = e.target.closest('[data-mtool]'); if (button) { realMap.setTool(button.dataset.mtool); return; }
      const layerButton = e.target.closest('[data-tilekey]'); if (layerButton) { realMap.setTileLayer(layerButton.dataset.tilekey); layerOpen = false; renderTools(); return; }
      if (e.target.closest('#mapLayerToggle')) { layerOpen = !layerOpen; renderTools(); }
    };
    $('mapBanner').onclick = (e) => {
      if (e.target.closest('[data-mdone]')) realMap.setTool('select');
      else if (e.target.closest('[data-mcopycancel]')) { realMap._copy = null; renderTools(); realMap.render(); }
      else if (e.target.closest('[data-mpcancel]')) { realMap._moveTarget = null; renderTools(); }
      else if (e.target.closest('[data-mreset]')) { const line = TM.actions.activeLine(); if (line && confirm(`Reset the drawn route of ${line.code} on the real map?` + (line.local ? ' All its bends are removed.' : ' Your bends are removed and the shipped route comes back.'))) TM.actions.resetBends(line.id); }
    };
  });
  document.addEventListener('keydown', (e) => {
    if (TM.state.mode !== 'map' || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable)) return;
    if (e.key === 'Escape' && realMap._copy) { realMap._copy = null; renderTools(); realMap.render(); return; }
    if (e.key === 'b' || e.key === 'B') realMap.setTool(TM.state.mapTool === 'bend' ? 'select' : 'bend');
    else if (e.key === 'd' || e.key === 'D') realMap.setTool(TM.state.mapTool === 'linestyle' ? 'select' : 'linestyle');
    else if (e.key === 'p' || e.key === 'P') realMap.setTool(TM.state.mapTool === 'movepoint' ? 'select' : 'movepoint');
    else if (e.key === 'v' || e.key === 'V' || (e.key === 'Escape' && TM.state.mapTool !== 'select')) realMap.setTool('select');
  });
  TM.on('theme', () => { if (realMap.map) { setTiles(realMap.map, realMap); realMap.render(); } });
  TM.on('mode', () => { if (TM.state.mode === 'map') realMap.show(); });
})(window.TM);
