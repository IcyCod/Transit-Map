/* KML: export chosen lines (their real-map route and stations) as a .kml file, and import chosen folders / placemarks of a
   .kml or .kmz file — each path (LineString) becomes a new line, each point a station; points lying along an imported path
   become its stops in order, and the path's shape between them its real-map route bends (line.geoBends). */
(function (TM) {
  const kml = (TM.kml = {});
  const slug = (s) => String(s || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
  const xml = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const STOP_NEAR = 150;   // m: a point this close to a path is one of its stops
  const SAME_STATION = 60; // m: an existing station this close to an imported point is used instead of a new one

  /* #rrggbb ↔ KML's aabbggrr */
  const toKmlColor = (hex) => { const h = (hex || '#888888').replace('#', ''); return 'ff' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2); };
  const fromKmlColor = (abgr) => { const h = String(abgr || '').trim().replace('#', ''); return /^[0-9a-f]{8}$/i.test(h) ? ('#' + h.slice(6, 8) + h.slice(4, 6) + h.slice(2, 4)).toLowerCase() : null; };

  /* ---------- export ---------- */
  kml.build = (lineIds) => {
    const store = TM.store, done = new Set();
    let body = '';
    lineIds.forEach((id) => {
      const root = store.lines.get(store.rootId(id));
      if (!root) return;
      const color = TM.lineColor(root), name = TM.nameOf(root, 'en') || root.code;
      body += `<Folder><name>${xml(root.code + ' ' + name)}</name><Style id="l-${xml(slug(root.id))}"><LineStyle><color>${toKmlColor(color)}</color><width>4</width></LineStyle></Style>`;
      [root, ...store.branchesOf(root)].forEach((line) => {
        const coords = [];
        store.geoPairs(line).forEach((pair, i) => {
          const chain = [[pair.a.lat, pair.a.lng], ...store.routeBends(line, pair.a.id, pair.b.id), [pair.b.lat, pair.b.lng]];
          chain.slice(i ? 1 : 0).forEach((p) => coords.push(`${+(+p[1]).toFixed(6)},${+(+p[0]).toFixed(6)},0`));
        });
        if (coords.length > 1) body += `<Placemark><name>${xml(line.rootId ? name + ' (branch ' + line.branchId + ')' : name)}</name><styleUrl>#l-${xml(slug(root.id))}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coords.join(' ')}</coordinates></LineString></Placemark>`;
      });
      body += '<Folder><name>Stations</name>';
      [root, ...store.branchesOf(root)].forEach((line) => line.path.forEach((it) => {
        const st = it.s && store.stations.get(it.s);
        if (!st || done.has(root.id + '|' + st.id) || !isFinite(st.lat) || !isFinite(st.lng)) return;
        done.add(root.id + '|' + st.id);
        body += `<Placemark><name>${xml(TM.nameOf(st, 'en') || st.id)}</name><description>${xml(st.id + ' · ' + st.status)}</description><Point><coordinates>${+st.lng.toFixed(6)},${+st.lat.toFixed(6)},0</coordinates></Point></Placemark>`;
      }));
      body += '</Folder></Folder>';
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(TM.maps.name(TM.maps.current))}</name>${body}</Document></kml>\n`;
  };

  kml.openExport = (preselect) => {
    const store = TM.store, roots = [...store.lines.values()];
    if (!roots.length) { TM.toast('This map has no lines yet', 'err'); return; }
    const pre = new Set((preselect ? [store.rootId(preselect)] : [...store.visible]).filter(Boolean));
    TM.ui.modal({
      title: 'Export lines as KML',
      body: `<p class="hint" style="margin-top:0">Each line is written with its branches, its real-map route and its stations. Open it in Google Earth, Google My Maps or any GIS app.</p>
        <div class="row" style="gap:6px;margin-bottom:8px"><button type="button" class="btn sm ghost" data-all="1">Select all</button><button type="button" class="btn sm ghost" data-all="0">None</button></div>
        <div style="display:grid;gap:6px;max-height:50vh;overflow:auto">${roots.map((l) => `<label class="check"><input type="checkbox" data-kl="${TM.esc(l.id)}" ${pre.has(l.id) ? 'checked' : ''}><span class="dot" style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${TM.lineColor(l)}"></span> <b>${TM.esc(l.code)}</b> ${TM.esc(TM.displayName(l))}</label>`).join('')}</div>`,
      buttons: [{ label: 'Cancel', cls: 'ghost' }, { label: 'Export KML', cls: 'primary', onClick: (d) => {
        const ids = [...d.body.querySelectorAll('[data-kl]:checked')].map((x) => x.dataset.kl);
        if (!ids.length) { TM.toast('Pick at least one line', 'err'); return false; }
        TM.download(`${ids.length === 1 ? 'line-' + slug(store.lines.get(ids[0]).code) : slug(TM.maps.name(TM.maps.current)) + '-lines'}.kml`, kml.build(ids), 'application/vnd.google-earth.kml+xml');
        TM.toast(`${ids.length} line(s) exported as KML`);
      } }],
    }).body.addEventListener('click', (e) => { const b = e.target.closest('[data-all]'); if (b) b.closest('.modal-b').querySelectorAll('[data-kl]').forEach((x) => { x.checked = b.dataset.all === '1'; }); });
  };

  /* ---------- import ---------- */
  const kids = (el, tag) => [...el.children].filter((c) => c.localName === tag);
  const text = (el, tag) => { const c = el && kids(el, tag)[0]; return c ? c.textContent.trim() : ''; };
  const parseCoords = (s) => s.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((p) => p.length >= 2 && isFinite(p[0]) && isFinite(p[1])).map((p) => [p[1], p[0]]);   // → [lat, lng]

  /* the file's folder tree: { name, children[], placemark? { kind: 'path'|'point', name, coords, color } } */
  function parseTree(doc) {
    const styles = {};
    doc.querySelectorAll('Style[id]').forEach((s) => { const c = s.querySelector('LineStyle > color'); if (c) styles['#' + s.getAttribute('id')] = fromKmlColor(c.textContent); });
    doc.querySelectorAll('StyleMap[id]').forEach((m) => { const p = [...m.querySelectorAll('Pair')].find((x) => text(x, 'key') === 'normal'); if (p && styles[text(p, 'styleUrl')]) styles['#' + m.getAttribute('id')] = styles[text(p, 'styleUrl')]; });
    let n = 0;
    const walk = (el) => {
      const node = { id: n++, name: text(el, 'name'), children: [] };
      [...el.children].forEach((c) => {
        if (c.localName === 'Folder' || c.localName === 'Document') { const sub = walk(c); if (sub.children.length) node.children.push(sub); }
        else if (c.localName === 'Placemark') {
          const name = text(c, 'name'), own = c.querySelector('LineStyle > color'), color = (own && fromKmlColor(own.textContent)) || styles[text(c, 'styleUrl')] || null;
          const lines = [...c.getElementsByTagNameNS('*', 'LineString')].map((g) => parseCoords(text(g, 'coordinates'))).filter((p) => p.length > 1);
          if (lines.length) node.children.push({ id: n++, name, children: [], placemark: { kind: 'path', name, coords: [].concat(...lines.map((p, i) => (i ? p.slice(1) : p))), color } });
          [...c.getElementsByTagNameNS('*', 'Point')].forEach((g) => { const p = parseCoords(text(g, 'coordinates'))[0]; if (p) node.children.push({ id: n++, name, children: [], placemark: { kind: 'point', name, coords: [p] } }); });
        }
      });
      return node;
    };
    const root = doc.documentElement.localName === 'kml' ? (kids(doc.documentElement, 'Document')[0] || doc.documentElement) : doc.documentElement;
    return walk(root);
  }

  async function readFile(file) {
    let source;
    if (/\.kmz$/i.test(file.name)) {
      const entries = await TM.zip.read(await file.arrayBuffer()), entry = entries.find((e) => /(^|\/)doc\.kml$/i.test(e.path)) || entries.find((e) => /\.kml$/i.test(e.path));
      if (!entry) throw new Error('No KML inside this KMZ');
      source = TM.zip.text(entry.data);
    } else source = await file.text();
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This is not a valid KML file');
    return parseTree(doc);
  }

  /* where p falls along a path: { d: distance to it (m), t: distance along it (m) }, in a local flat projection */
  function project(path, p) {
    const k = Math.cos(p[0] * Math.PI / 180) * 111320, m = 110540, xy = (q) => [q[1] * k, q[0] * m], P = xy(p);
    let best = { d: Infinity, t: 0 }, along = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const A = xy(path[i]), B = xy(path[i + 1]), dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy);
      const u = len ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / (len * len))) : 0;
      const d = Math.hypot(A[0] + u * dx - P[0], A[1] + u * dy - P[1]);
      if (d < best.d) best = { d, t: along + u * len };
      along += len;
    }
    return best;
  }
  const alongOf = (path) => { const k = Math.cos(path[0][0] * Math.PI / 180) * 111320, out = [0]; for (let i = 1; i < path.length; i++) out.push(out[i - 1] + Math.hypot((path[i][1] - path[i - 1][1]) * k, (path[i][0] - path[i - 1][0]) * 110540)); return out; };

  /* several paths into one: start from the longest, keep adding the path whose end lies nearest either end (reversed when needed) */
  function chainPaths(paths) {
    const left = paths.map((p) => p.coords.slice()).sort((a, b) => b.length - a.length);
    let chain = left.shift();
    const d = (p, q) => TM.haversine(p[0], p[1], q[0], q[1]);
    while (left.length) {
      let best = null;
      left.forEach((c, i) => {
        const head = chain[0], tail = chain[chain.length - 1];
        [[d(tail, c[0]), i, 'tail', false], [d(tail, c[c.length - 1]), i, 'tail', true], [d(head, c[c.length - 1]), i, 'head', false], [d(head, c[0]), i, 'head', true]]
          .forEach((o) => { if (!best || o[0] < best[0]) best = o; });
      });
      let next = left.splice(best[1], 1)[0];
      if (best[3]) next = next.reverse();
      chain = best[2] === 'tail' ? chain.concat(next) : next.concat(chain);
    }
    return chain;
  }

  /* groups: [{ name, color, mode, paths: [placemark], points: [placemark] }] — each becomes one new line; autoPaths each a line
     of their own; autoPoints join any new line they lie within STOP_NEAR of; standalone points become stations only. */
  function importChosen({ groups, autoPaths, autoPoints, standalone, mode }) {
    const store = TM.store;
    const SW = ['#8b5cf6', '#0ea5e9', '#ec4899', '#14b8a6', '#f97316', '#ef4444', '#22c55e', '#eab308', '#6366f1', '#64748b'];
    const made = new Map();   // point → station (one station per point, shared by every line it is a stop of)
    let newStations = 0, reused = 0, lineCount = 0;
    const stationFor = (pt, code) => {
      if (made.has(pt)) return made.get(pt);
      const [lat, lng] = pt.coords[0];
      let near = null, nearD = SAME_STATION;
      store.stations.forEach((s) => { const d = TM.haversine(lat, lng, s.lat, s.lng); if (d < nearD) { nearD = d; near = s; } });
      if (near) { reused++; made.set(pt, near); return near; }
      const name = pt.name || `Station ${newStations + 1}`;
      store._nodes = null;
      const st = store.addStation({ id: store.nextFantasyCode(name, code), names: { en: name }, lat: +lat.toFixed(6), lng: +lng.toFixed(6), status: 'fantasy', author: store.author, node: store.autoNode(lat, lng) });
      newStations++; made.set(pt, st);
      return st;
    };
    const addLine = (name, color, lineMode, coords, own) => {
      const id = store.nextLineId(name, ''), code = id.split('-')[0];
      let stops, along = null;
      if (coords) {
        along = alongOf(coords);
        const near = autoPoints.map((pt) => ({ pt, ...project(coords, pt.coords[0]) })).filter((x) => x.d <= STOP_NEAR);
        stops = [...own.map((pt) => ({ pt, ...project(coords, pt.coords[0]) })), ...near].sort((a, b) => a.t - b.t);
        const ends = [], length = along[along.length - 1];
        if (!stops.length || stops[0].t > STOP_NEAR) ends.push({ pt: { name: name + ' (start)', coords: [coords[0]] }, t: 0 });
        if (!stops.length || stops[stops.length - 1].t < length - STOP_NEAR) ends.push({ pt: { name: name + ' (end)', coords: [coords[coords.length - 1]] }, t: length });
        stops = [...ends, ...stops].sort((a, b) => a.t - b.t);
      } else stops = own.map((pt) => ({ pt }));   // no path: the stops in the order they are listed
      const stations = stops.map((x) => stationFor(x.pt, code)), geoBends = {};
      if (coords) for (let j = 0; j < stops.length - 1; j++) {
        const bends = coords.filter((_, v) => along[v] > stops[j].t + 1 && along[v] < stops[j + 1].t - 1).map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]);
        if (bends.length && stations[j].id !== stations[j + 1].id) geoBends[stations[j].id + '>' + stations[j + 1].id] = bends;
      }
      store.addLine({ id, code, names: { en: name }, color: color || SW[(store.lines.size + lineCount) % SW.length], mode: lineMode || mode, status: 'fantasy', author: store.author, style: 'octilinear', created: TM.today(),
        path: stations.filter((st, j) => !j || st.id !== stations[j - 1].id).map((st) => ({ s: st.id })), geoBends });
      lineCount++;
    };
    groups.forEach((g, i) => {
      if (!g.paths.length && g.points.length < 2) { g.points.forEach((pt) => stationFor(pt, '')); return; }
      addLine(g.name || `Imported line ${i + 1}`, g.color || (g.paths.find((p) => p.color) || {}).color, g.mode, g.paths.length ? chainPaths(g.paths) : null, g.points);
    });
    autoPaths.forEach((pm, i) => addLine(pm.name || `Imported line ${groups.length + i + 1}`, pm.color, mode, pm.coords, []));
    [...autoPoints, ...standalone].filter((pt) => !made.has(pt)).forEach((pt) => stationFor(pt, ''));
    store.save();
    TM.emit('visibility'); TM.emit('change');
    TM.toast(`Imported ${lineCount} line(s), ${newStations} new station(s)${reused ? `, ${reused} matched to existing stations` : ''}`);
  }

  kml.openImport = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      let tree;
      try { tree = await readFile(file); } catch (err) { TM.toast(err.message || 'Could not read the file', 'err'); return; }
      const all = [], folders = [], flat = (node, folder) => { if (node.placemark) { node.folder = folder; all.push(node); } else if (node !== tree || !node.placemark) { if (node.children.some((c) => c.placemark)) folders.push(node); } node.children.forEach((c) => flat(c, node.placemark ? folder : node)); };
      flat(tree, tree);
      if (!all.length) { TM.toast('No paths or points found in this file', 'err'); return; }
      /* which new line each placemark goes to: '' auto · a group number · 'st' station only (points) */
      const assign = new Map(all.map((n) => [n.id, '']));
      const groupMeta = new Map();   // group number → { name, color, mode }
      const byId = new Map(all.map((n) => [n.id, n]));
      const nGroups = () => Math.max(all.filter((n) => n.placemark.kind === 'path').length, folders.length, 1) + 2;
      const groupSel = (attr, value, points) => `<select class="input" ${attr} style="height:26px;width:auto;padding:0 6px;font-size:12px"><option value="">${points ? 'Auto (nearest path)' : 'Own line'}</option>${Array.from({ length: nGroups() }, (_, i) => `<option value="${i + 1}" ${String(value) === String(i + 1) ? 'selected' : ''}>→ Line ${i + 1}</option>`).join('')}${points ? `<option value="st" ${value === 'st' ? 'selected' : ''}>Station only</option>` : ''}</select>`;
      const count = (node) => { let p = 0, s = 0; const go = (x) => { if (x.placemark) x.placemark.kind === 'path' ? p++ : s++; x.children.forEach(go); }; go(node); return `${p ? p + ' path' + (p > 1 ? 's' : '') : ''}${p && s ? ', ' : ''}${s ? s + ' point' + (s > 1 ? 's' : '') : ''}`; };
      const row = (node, depth) => node.placemark
        ? `<div class="row" style="padding-left:${depth * 18}px;gap:8px;justify-content:space-between"><label class="check" style="min-width:0"><input type="checkbox" data-pm="${node.id}" checked> ${node.placemark.kind === 'path' ? `<span style="display:inline-block;width:14px;height:4px;border-radius:2px;background:${node.placemark.color || 'var(--muted)'}"></span>` : '•'} ${TM.esc(node.name || (node.placemark.kind === 'path' ? 'Unnamed path' : 'Unnamed point'))}</label>${groupSel(`data-grp="${node.id}"`, assign.get(node.id), node.placemark.kind === 'point')}</div>`
        : `<details open style="padding-left:${depth * 18}px"><summary class="row" style="gap:8px;justify-content:space-between"><span class="check"><input type="checkbox" data-folder checked> <b>${TM.esc(node.name || 'Folder')}</b> <span class="hint">${count(node)}</span></span>${groupSel(`data-fgrp="${node.id}"`, '', true).replace('Auto (nearest path)', 'Set all…')}</summary><div style="display:grid;gap:4px;margin-top:4px">${node.children.map((c) => row(c, 1)).join('')}</div></details>`;
      const dialog = TM.ui.modal({
        title: 'Import from KML', wide: true,
        body: `<p class="hint" style="margin-top:0">Tick what to bring in, and choose which <b>new line</b> each path or point belongs to. Paths of one line are joined into its route; its points become its stops in order along it (with no path, in the order listed). Left on <b>Own line</b>, a path is a line of its own; <b>Auto</b> points join any new line within ${STOP_NEAR} m. A point within ${SAME_STATION} m of an existing station uses that station.</p>
          <div class="row wrap" style="gap:8px;margin-bottom:8px"><div class="field" style="margin:0"><label>Type of the new lines</label><select class="input" id="kml-mode">${Object.entries(TM.MODES).map(([k, t]) => `<option value="${k}" ${k === 'mrt' ? 'selected' : ''}>${TM.esc(t)}</option>`).join('')}</select></div>
          ${folders.length > 1 ? '<button type="button" class="btn sm" id="kml-perfolder" style="align-self:end">One line per folder</button>' : ''}<button type="button" class="btn sm ghost" id="kml-reset" style="align-self:end">↺ All auto</button></div>
          <div id="kml-groups" style="display:grid;gap:6px;margin-bottom:8px"></div>
          <div id="kml-tree" style="display:grid;gap:4px;max-height:44vh;overflow:auto">${(tree.placemark ? [tree] : tree.children).map((c) => row(c, 0)).join('')}</div>`,
        buttons: [{ label: 'Cancel', cls: 'ghost' }, { label: 'Import', cls: 'primary', onClick: (d) => {
          const ids = new Set([...d.body.querySelectorAll('[data-pm]:checked')].map((x) => +x.dataset.pm));
          const chosen = all.filter((n) => ids.has(n.id));
          if (!chosen.length) { TM.toast('Pick something to import', 'err'); return false; }
          const mode = d.body.querySelector('#kml-mode').value, groups = new Map(), autoPaths = [], autoPoints = [], standalone = [];
          chosen.forEach((n) => {
            const g = assign.get(n.id), pm = n.placemark;
            if (g === 'st') standalone.push(pm);
            else if (!g) (pm.kind === 'path' ? autoPaths : autoPoints).push(pm);
            else { if (!groups.has(g)) groups.set(g, Object.assign({ paths: [], points: [] }, groupMeta.get(g) || {})); groups.get(g)[pm.kind === 'path' ? 'paths' : 'points'].push(pm); }
          });
          importChosen({ groups: [...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k)), autoPaths, autoPoints, standalone, mode });
        } }],
      });
      const body = dialog.body;
      /* the new lines in use: a name, type and colour each */
      const drawGroups = () => {
        const used = [...new Set([...assign.entries()].filter(([id, g]) => g && g !== 'st' && body.querySelector(`[data-pm="${id}"]`).checked).map(([, g]) => g))].sort((a, b) => a - b);
        body.querySelector('#kml-groups').innerHTML = used.map((g) => {
          const members = all.filter((n) => assign.get(n.id) === g), firstPath = members.find((n) => n.placemark.kind === 'path');
          const folder = members[0] && members[0].folder, oneFolder = folder && folder !== tree && folder.name && members.every((n) => n.folder === folder);
          if (!groupMeta.has(g)) groupMeta.set(g, { name: (oneFolder && folder.name) || (firstPath && firstPath.name) || `Line ${g}`, color: (firstPath && firstPath.placemark.color) || '', mode: '' });
          const meta = groupMeta.get(g), paths = members.filter((n) => n.placemark.kind === 'path').length;
          return `<div class="row wrap" style="gap:6px;align-items:center;padding:6px 8px;border:1px solid var(--line);border-radius:10px"><b style="width:52px">Line ${g}</b>
            <input class="input" data-gname="${g}" value="${TM.esc(meta.name)}" style="height:28px;flex:1;min-width:120px" aria-label="Name of line ${g}">
            <select class="input" data-gmode="${g}" style="height:28px;width:auto"><option value="">Type: as above</option>${Object.entries(TM.MODES).map(([k, t]) => `<option value="${k}" ${meta.mode === k ? 'selected' : ''}>${TM.esc(t)}</option>`).join('')}</select>
            <input type="color" data-gcolor="${g}" value="${meta.color || '#8b5cf6'}" style="width:32px;height:26px;padding:0;border-radius:6px" aria-label="Colour of line ${g}">
            <span class="hint">${paths} path${paths === 1 ? '' : 's'} · ${members.length - paths} point${members.length - paths === 1 ? '' : 's'}</span></div>`;
        }).join('');
      };
      const setAssign = (id, g) => { assign.set(id, g); const sel = body.querySelector(`[data-grp="${id}"]`); if (sel) sel.value = g; };
      const descendants = (node) => { const out = []; const go = (x) => { if (x.placemark) out.push(x); x.children.forEach(go); }; go(node); return out; };
      const findNode = (id) => { let hit = null; const go = (x) => { if (x.id === id) hit = x; x.children.forEach(go); }; go(tree); return hit; };
      drawGroups();
      body.addEventListener('click', (e) => {
        if (e.target.closest('#kml-perfolder')) { folders.forEach((f, i) => descendants(f).filter((n) => n.folder === f).forEach((n) => setAssign(n.id, String(i + 1)))); drawGroups(); }
        else if (e.target.closest('#kml-reset')) { all.forEach((n) => setAssign(n.id, '')); drawGroups(); }
        else if (e.target.closest('summary select')) e.preventDefault();   // a folder's line picker must not fold the folder
      });
      /* a folder's box ticks / unticks everything in it; it shows part-ticked when only some are */
      const sync = () => [...body.querySelectorAll('details')].reverse().forEach((det) => {
        const boxes = [...det.querySelectorAll('[data-pm]')], on = boxes.filter((b) => b.checked).length, f = det.querySelector('[data-folder]');
        f.checked = on === boxes.length; f.indeterminate = on > 0 && on < boxes.length;
      });
      body.addEventListener('change', (e) => {
        const t = e.target;
        if (t.matches('[data-folder]')) t.closest('details').querySelectorAll('[data-pm], [data-folder]').forEach((b) => { b.checked = t.checked; });
        if (t.dataset.grp != null) assign.set(+t.dataset.grp, t.value);
        if (t.dataset.fgrp != null) { descendants(findNode(+t.dataset.fgrp)).forEach((n) => setAssign(n.id, n.placemark.kind === 'path' && t.value === 'st' ? '' : t.value)); t.value = ''; }
        if (t.dataset.gmode != null) groupMeta.get(t.dataset.gmode).mode = t.value;
        if (t.dataset.gcolor != null) groupMeta.get(t.dataset.gcolor).color = t.value;
        if (t.dataset.gname == null && t.dataset.gmode == null && t.dataset.gcolor == null) { sync(); drawGroups(); }
      });
      body.addEventListener('input', (e) => { if (e.target.dataset.gname != null) groupMeta.get(e.target.dataset.gname).name = e.target.value.trim(); });
    };
    input.click();
  };
})(window.TM);
