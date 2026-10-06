/* Infinite schematic canvas: pan / zoom, node grid, tools (select, station, route, erase). */
(function (TM) {
  const GRID = TM.GRID;
  const canvas = (TM.canvas = { view: { tx: 0, ty: 0, k: 1 }, model: null });
  let svg, world, worldMap, worldOverlay, hoverEl, nodeGrid, pattern;
  const pointers = new Map();
  let drag = null, pinch = null, frameRequest = 0;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  canvas.toWorld = (cx, cy) => {
    const rect = svg.getBoundingClientRect();
    return { x: (cx - rect.left - canvas.view.tx) / canvas.view.k, y: (cy - rect.top - canvas.view.ty) / canvas.view.k };
  };
  /* The grid node under a point — snapped to the nearest whole node normally, but freely (to 1/100 of a node, ~1px at
     100%) whenever the node grid is hidden, so a station or bend can then be placed or bent anywhere, not only on a
     node. Every move/place/click path (station drag, waypoint drag, click-to-move, new station/bend placement, hover)
     goes through this one function, so hiding the grid is enough to free all of them at once. */
  canvas.nodeAt = (cx, cy) => {
    const worldPoint = canvas.toWorld(cx, cy), gridX = worldPoint.x / GRID, gridY = worldPoint.y / GRID;
    if (TM.state.showNodes) return { x: Math.round(gridX), y: Math.round(gridY) };
    return { x: TM.round2dp(gridX), y: TM.round2dp(gridY) };
  };

  function applyView() {
    const { tx: translateX, ty: translateY, k: zoom } = canvas.view;
    world.setAttribute('transform', `translate(${translateX} ${translateY}) scale(${zoom})`);
    pattern.setAttribute('patternTransform', `translate(${translateX} ${translateY}) scale(${zoom})`);
    nodeGrid.style.display = TM.state.showNodes ? '' : 'none';
    nodeGrid.setAttribute('opacity', zoom < 0.3 ? 0 : zoom < 0.5 ? 0.55 : 1);
    /* drawing handles keep one size on screen (see drawHandles) */
    const handleScale = `scale(${1 / Math.max(0.05, zoom)})`;
    worldOverlay.querySelectorAll('[data-dpt],[data-dmid]').forEach((h) => h.setAttribute('transform', h.getAttribute('transform').replace(/scale\([^)]*\)/, handleScale)));
  }

  canvas.applyView = applyView;
  canvas.zoomAt = (cx, cy, factor) => {
    const rect = svg.getBoundingClientRect(), view = canvas.view, newZoom = clamp(view.k * factor, 0.04, 3.2), real = newZoom / view.k;
    const pointerX = cx - rect.left, pointerY = cy - rect.top;
    view.tx = pointerX - (pointerX - view.tx) * real; view.ty = pointerY - (pointerY - view.ty) * real; view.k = newZoom;
    canvas.moved = true; applyView();
  };
  canvas.zoomCenter = (f) => { const rect = svg.getBoundingClientRect(); canvas.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, f); };

  canvas.fit = () => {
    if (!canvas.model) return;
    const bbox = canvas.model.bbox, rect = svg.getBoundingClientRect(), pad = 50;
    if (!rect.width) return;
    const zoom = clamp(Math.min((rect.width - pad * 2) / bbox.w, (rect.height - pad * 2) / bbox.h), 0.04, 1.3);
    canvas.view.k = zoom;
    canvas.view.tx = (rect.width - bbox.w * zoom) / 2 - bbox.x * zoom;
    canvas.view.ty = (rect.height - bbox.h * zoom) / 2 - bbox.y * zoom;
    applyView();
  };

  canvas.centerOn = (worldX, worldY, zoom) => {
    const rect = svg.getBoundingClientRect();
    canvas.view.k = zoom || Math.max(canvas.view.k, 0.7);
    canvas.view.tx = rect.width / 2 - worldX * canvas.view.k; canvas.view.ty = rect.height / 2 - worldY * canvas.view.k;
    canvas.moved = true; applyView();
  };

  /* ---------- rendering ---------- */
  const ring = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-dasharray="6 4" pointer-events="none"/>`;
  const bendPt = (kind, key, x, y, r) => `<g data-${kind}="${key}" transform="translate(${x} ${y})"><circle r="${r}" fill="${kind === 'bend' ? 'var(--accent)' : 'var(--panel)'}" stroke="${kind === 'bend' ? 'var(--panel)' : 'var(--accent)'}" stroke-width="2.5"${kind === 'bendmid' ? ' stroke-dasharray="3 3"' : ''} style="cursor:${kind === 'bend' ? 'grab' : 'copy'}"/></g>`;
  /* Bend / add-bend handles for the selected connecting line — a small, self-contained overlay independent of render.js. */
  function connHandles(selection, model) {
    const store = TM.store, leadA = store.rep(selection.a), leadB = store.rep(selection.b), pointA = model.pos.get(leadA), pointB = model.pos.get(leadB);
    if (!pointA || !pointB) return '';
    const bends = store.connBends(selection.a, selection.b).map((p) => ({ x: p[0] * GRID, y: p[1] * GRID }));
    const chain = [pointA, ...bends, pointB];
    let markup = '';
    for (let i = 0; i < chain.length - 1; i++) {
      if (Math.hypot(chain[i + 1].x - chain[i].x, chain[i + 1].y - chain[i].y) < 34) continue;   // too short to grab a midpoint
      markup += bendPt('bendmid', `${selection.a}|${selection.b}|${i}`, (chain[i].x + chain[i + 1].x) / 2, (chain[i].y + chain[i + 1].y) / 2, 7);
    }
    bends.forEach((p, i) => { markup += bendPt('bend', `${selection.a}|${selection.b}|${i}`, p.x, p.y, 8); });
    return markup;
  }
  /* Arc tool: a handle at the middle of each arc section (drag: how far it bulges, either side; double-click: straighten)
     with its circle as a faint guide, or — on a circle line — the circle's centre (drag: move it) and a handle on its rim
     (drag: resize). The first stop picked for a new section is ringed. */
  canvas.arcPick = null;
  const guide = (cx, cy, radius) => `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-opacity=".45" stroke-dasharray="5 6" pointer-events="none"/>` +
    `<path d="M${cx - 7} ${cy}h14M${cx} ${cy - 7}v14" stroke="var(--accent)" stroke-width="2" pointer-events="none"/>`;
  const knob = (attr, x, y, cur) => `<g data-${attr} transform="translate(${x} ${y})" style="cursor:${cur}"><circle r="15" fill="transparent"/><circle r="8" fill="var(--accent)" stroke="var(--panel)" stroke-width="2.5"/></g>`;
  function arcHandles(line) {
    const geo = TM.geo, actions = TM.actions;
    let markup = '';
    if (line.circle) {
      const circle = line.circle;
      return guide(circle.x * GRID, circle.y * GRID, circle.r * GRID).replace('stroke-opacity=".45"', 'stroke-opacity=".25"') +
        knob('circ="c"', circle.x * GRID, circle.y * GRID, 'move') + knob('circ="r"', (circle.x + circle.r) * GRID, circle.y * GRID, 'ew-resize');
    }
    geo.arcSections(line).forEach((section) => {
      if (!section.arc) return;
      const arc = section.arc;
      if (arc.r < 200) markup += guide(arc.cx * GRID, arc.cy * GRID, arc.r * GRID);
      markup += knob(`arch="${section.i0}"`, arc.apex.x * GRID, arc.apex.y * GRID, 'grab');
    });
    if (canvas.arcPick != null && line.path[canvas.arcPick]) { const point = TM.store.itemPos(line.path[canvas.arcPick]); if (point) markup += ring(point.x * GRID, point.y * GRID, 20); }
    return markup;
  }
  /* where a dragged stop / bend of the line being edited may go when it sits on an arc: along it (null = anywhere) */
  function arcConstrain(dragState, node) {
    const actions = TM.actions, line = actions.activeLine();
    if (!line) return null;
    const i = dragState.kind === 'wp' ? +dragState.t.wp : dragState.kind === 'station' ? actions.indexOfStation(dragState.t.sid) : -1;
    return i >= 0 ? actions.constrainToArc(line, i, node) : null;
  }
  /* ---------- background drawings (Draw tool · P) ---------- */
  /* point handles of the selected drawing / the one being drawn (drag: move · double-click: remove · click: pick it to
     set its width), and a half-way handle on each piece (drag: insert a point) */
  function drawHandles() {
    const selection = TM.state.selected, id = TM.state.drawId || (selection && selection.type === 'draw' ? selection.id : null), d = id && TM.store.drawingById(id);
    if (!d || !TM.actions.ownsMap()) return '';
    const pts = d.pts, pickPt = selection && selection.type === 'draw' && selection.id === id ? selection.pt : null;
    const u = 1 / Math.max(0.05, canvas.view.k);   // handles keep one size on screen, whatever the zoom
    let markup = '';
    const pieces = d.kind === 'area' && pts.length > 2 && !TM.state.drawId ? pts.length : pts.length - 1;
    for (let i = 0; i < pieces; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 30 * u) continue;
      markup += `<g data-dmid="${TM.esc(id)}|${i + 1}" transform="translate(${(a[0] + b[0]) / 2} ${(a[1] + b[1]) / 2}) scale(${u})" style="cursor:copy"><circle r="9" fill="transparent"/><circle r="5" fill="var(--panel)" stroke="var(--accent)" stroke-width="2" stroke-dasharray="3 2"/></g>`;
    }
    pts.forEach((p, i) => {
      const on = pickPt === i, closer = TM.state.drawId && d.kind === 'area' && i === 0 && pts.length > 2;
      markup += `<g data-dpt="${TM.esc(id)}|${i}" transform="translate(${p[0]} ${p[1]}) scale(${u})" style="cursor:${closer ? 'pointer' : 'grab'}"><circle r="12" fill="transparent"/>` +
        `<circle r="${on || closer ? 8 : 6}" fill="${on ? 'var(--accent)' : 'var(--panel)'}" stroke="var(--accent)" stroke-width="2.5"/></g>`;
    });
    return markup;
  }
  /* a new point of a drawing: kept on a 45° step from the one before when snapping is on (Shift: the other way round) */
  function drawPoint(e, prev) {
    const w = canvas.toWorld(e.clientX, e.clientY);
    if (!prev || TM.state.drawSnap === !!e.shiftKey) return { x: TM.round2dp(w.x), y: TM.round2dp(w.y) };
    const dx = w.x - prev[0], dy = w.y - prev[1], step = Math.PI / 4, angle = Math.round(Math.atan2(dy, dx) / step) * step, len = dx * Math.cos(angle) + dy * Math.sin(angle);
    return { x: TM.round2dp(prev[0] + Math.cos(angle) * len), y: TM.round2dp(prev[1] + Math.sin(angle) * len) };
  }
  /* finish the drawing being drawn: drop a doubled last point (from a double-click), and the whole drawing when too short */
  canvas.finishDrawing = () => {
    const id = TM.state.drawId, store = TM.store, d = id && store.drawingById(id);
    TM.state.drawId = null;
    if (d) {
      while (d.pts.length > 1 && Math.hypot(d.pts[d.pts.length - 1][0] - d.pts[d.pts.length - 2][0], d.pts[d.pts.length - 1][1] - d.pts[d.pts.length - 2][1]) < 3) d.pts.pop();
      if (d.pts.length < (d.kind === 'area' ? 3 : 2)) { TM.actions.removeDrawing(id); TM.actions.select(null); TM.emit('tool'); return; }
      store.save();
      TM.actions.select({ type: 'draw', id });
    }
    TM.emit('tool');
  };
  /* live look of a drawing while one of its points is dragged */
  function previewDrawing(id, mutate) {
    const d = TM.store.drawingById(id), el = d && worldMap.querySelector(`[data-draw="${CSS.escape(id)}"]`);
    if (!d || !el) return;
    const copy = JSON.parse(JSON.stringify(d));
    mutate(copy);
    el.outerHTML = TM.symbols.drawing(copy, ` data-draw="${TM.esc(id)}" style="cursor:pointer"`);
  }

  canvas.render = () => {
    if (!svg) return;
    const model = canvas.model = TM.render.build(TM.render.currentOpts({ dimOthers: true }));
    worldMap.innerHTML = model.svg;
    let overlay = model.overlay;
    const selection = TM.state.selected, line = TM.actions.activeLine();
    if (selection && selection.type === 'station' && model.pos.get(selection.id)) { const point = model.pos.get(selection.id); overlay += ring(point.x, point.y, 22); }
    if (selection && selection.type === 'wp' && line && line.path[selection.index]) overlay += ring(line.path[selection.index].x * GRID, line.path[selection.index].y * GRID, 16);
    if (selection && selection.type === 'conn') overlay += connHandles(selection, model);
    if (TM.state.tool === 'arc' && line) overlay += arcHandles(line);
    if (selection && selection.type === 'ann' && TM.store.annotations[selection.id]) { const annotation = TM.store.annotations[selection.id]; overlay += ring(annotation.x, annotation.y, 26); }
    overlay += drawHandles();
    if (TM.state.bgMode && TM.store.background) {
      const background = TM.store.background;
      overlay += `<g data-bgresize="1" transform="translate(${background.x + background.w} ${background.y + background.h})" style="cursor:nwse-resize"><circle r="9" fill="var(--accent)" stroke="var(--panel)" stroke-width="2.5"/></g>`;
    }
    worldOverlay.innerHTML = overlay;
    svg.className.baseVal = 'tool-' + TM.state.tool;
    TM.emit('rendered', model);
  };
  const schedule = () => { if (!frameRequest) frameRequest = requestAnimationFrame(() => { frameRequest = 0; canvas.render(); }); };

  function setHover(node) {
    if (!node) { hoverEl.setAttribute('visibility', 'hidden'); return; }
    hoverEl.setAttribute('cx', node.x * GRID); hoverEl.setAttribute('cy', node.y * GRID);
    hoverEl.setAttribute('visibility', 'visible');
  }

  /* ---------- pointer handling ---------- */
  function draggable(target) {
    const actions = TM.actions;
    if (target.arch !== undefined || target.circ) return TM.state.tool === 'arc' && actions.editable();
    if (TM.state.tool !== 'select' || TM.state.moving) return false;
    if (target.bend !== undefined || target.bendmid !== undefined) return true;                 // bend point on a connecting/unofficial line
    if (target.blk) return true;                                                            // a station's own dot inside a block
    if (target.lbl) return true;   // a station's name label is a view preference (store.labelPos / block.labelPos) — never tied to one line's item
    if (target.ann) return true;   // a free-floating annotation — always a view-local object, never tied to a line
    if (target.bg) return !!TM.state.bgMode && actions.ownsMap();
    if (target.bgresize) return !!TM.state.bgMode && actions.ownsMap();
    if (target.dpt || target.dmid) return TM.actions.ownsMap();
    if (target.badge) { const l = TM.store.line(target.line); return actions.canEdit(l) && l.badgeStyle !== 'flag' && l.badgeStyle !== 'hidden'; }   // a flag is fixed to the line's end                        // line-name badge at a terminus of an editable line
    const line = actions.activeLine(), canEdit = actions.canEdit(line), selection = TM.state.selected;
    if (target.sid) {
      const station = TM.store.stations.get(actions.memberOnActive(target.sid));
      if (selection && selection.type === 'station' && TM.store.sameGroup(selection.id, target.sid)) return true;   // selected station: drag anywhere
      return !!(station && actions.ownsStation(station) && canEdit && actions.indexOfStation(target.sid) >= 0);             // own station on the line being edited
    }
    if (!canEdit) return false;
    return target.wp !== undefined;
  }

  function onDown(e) {
    if (e.button === 2) return;
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      pinch = { d: Math.hypot(first.x - second.x, first.y - second.y), k: canvas.view.k };
      drag = null; return;
    }
    const element = e.target.closest ? e.target.closest('[data-sid],[data-lbl],[data-wp],[data-seg],[data-badge],[data-line],[data-conn],[data-bend],[data-bendmid],[data-blk],[data-ann],[data-bg],[data-bgresize],[data-arch],[data-circ],[data-dpt],[data-dmid],[data-draw]') : null;
    const target = element ? { sid: element.dataset.sid, lbl: element.dataset.lbl, wp: element.dataset.wp, seg: element.dataset.seg, badge: element.dataset.badge, line: element.dataset.line, conn: element.dataset.conn, bend: element.dataset.bend, bendmid: element.dataset.bendmid, blk: element.dataset.blk, ann: element.dataset.ann, bg: element.dataset.bg, bgresize: element.dataset.bgresize, arch: element.dataset.arch, circ: element.dataset.circ, dpt: element.dataset.dpt, dmid: element.dataset.dmid, draw: element.dataset.draw } : {};
    drag = { sx: e.clientX, sy: e.clientY, tx: canvas.view.tx, ty: canvas.view.ty, moved: false, t: target, kind: 'pan' };
    if (e.button === 0 && (target.dpt || target.dmid) && draggable(target)) { drag.kind = target.dpt ? 'dpt' : 'dmid'; return; }
    if (e.button === 0 && (target.sid || target.lbl || target.badge || target.wp !== undefined || target.bend !== undefined || target.bendmid !== undefined || target.blk || target.ann || target.bg || target.bgresize || target.arch !== undefined || target.circ) && draggable(target)) {
      drag.kind = target.arch !== undefined ? 'arch' : target.circ ? 'circ' : target.bend !== undefined ? 'bend' : target.bendmid !== undefined ? 'bendmid' : target.blk ? 'blk' : target.sid ? 'station' : target.lbl ? 'label' : target.bgresize ? 'bgresize' : target.bg ? 'bg' : target.ann ? 'ann' : target.badge ? 'badge' : 'wp';
    }
  }

  function onMove(e) {
    const pointer = pointers.get(e.pointerId);
    if (pointer) { pointer.x = e.clientX; pointer.y = e.clientY; }
    if (pinch && pointers.size === 2) {
      const [first, second] = [...pointers.values()], distance = Math.hypot(first.x - second.x, first.y - second.y);
      canvas.zoomAt((first.x + second.x) / 2, (first.y + second.y) / 2, (pinch.k * distance / pinch.d) / canvas.view.k);
      return;
    }
    if (!drag && TM.state.tool === 'draw') {
      const d = TM.state.drawId && TM.store.drawingById(TM.state.drawId);
      let band = worldOverlay.querySelector('.draw-band');
      if (!d) { if (band) band.remove(); return; }
      const last = d.pts[d.pts.length - 1], p = drawPoint(e, last);
      if (!band) { band = document.createElementNS('http://www.w3.org/2000/svg', 'path'); band.setAttribute('class', 'draw-band'); band.setAttribute('pointer-events', 'none'); band.setAttribute('fill', 'none'); band.setAttribute('stroke', 'var(--accent)'); band.setAttribute('stroke-width', '2'); band.setAttribute('stroke-dasharray', '6 4'); worldOverlay.appendChild(band); }
      band.setAttribute('d', `M${last[0]} ${last[1]}L${p.x} ${p.y}` + (d.kind === 'area' && d.pts.length > 1 ? `L${d.pts[0][0]} ${d.pts[0][1]}` : ''));
      return;
    }
    if (!drag) {
      const tool = TM.state.tool;
      if (TM.state.moving || ((tool === 'station' || tool === 'route') && TM.actions.editable())) setHover(canvas.nodeAt(e.clientX, e.clientY)); else setHover(null);
      return;
    }
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.kind === 'pan') {
      canvas.view.tx = drag.tx + dx; canvas.view.ty = drag.ty + dy;
      canvas.moved = true; svg.classList.add('panning'); applyView(); return;
    }
    const zoom = canvas.view.k;
    if (drag.kind === 'label' || drag.kind === 'badge') {
      const element = drag.kind === 'label' ? svg.querySelector(`[data-lbl="${CSS.escape(drag.t.lbl)}"]`)
        : svg.querySelector(`.layer-badges [data-line="${CSS.escape(drag.t.line)}"][data-badge="${drag.t.badge}"]`);
      if (element) element.setAttribute('transform', `translate(${dx / zoom} ${dy / zoom})`);
      return;
    }
    if (drag.kind === 'dpt' || drag.kind === 'dmid') {
      const [id, iStr] = (drag.t.dpt || drag.t.dmid).split('|'), i = +iStr, d = TM.store.drawingById(id);
      if (!d) return;
      const prev = drag.kind === 'dpt' ? d.pts[i - 1] || d.pts[i + 1] : d.pts[i - 1];
      const p = drawPoint(e, prev);
      drag.point = p;
      previewDrawing(id, (copy) => { if (drag.kind === 'dpt') { copy.pts[i][0] = p.x; copy.pts[i][1] = p.y; } else copy.pts.splice(i, 0, [p.x, p.y]); });
      const handle = worldOverlay.querySelector(`[data-${drag.kind}="${CSS.escape(drag.t.dpt || drag.t.dmid)}"]`);
      if (handle) handle.setAttribute('transform', `translate(${p.x} ${p.y}) scale(${1 / Math.max(0.05, canvas.view.k)})`);
      return;
    }
    if (drag.kind === 'ann') {
      const annotation = TM.store.annotations[drag.t.ann], element = svg.querySelector(`[data-ann="${CSS.escape(drag.t.ann)}"]`);
      if (annotation && element) element.setAttribute('transform', `translate(${annotation.x + dx / zoom} ${annotation.y + dy / zoom})${annotation.rot ? ` rotate(${annotation.rot})` : ''}`);
      return;
    }
    if (drag.kind === 'bg') {
      const element = svg.querySelector('[data-bg]');
      if (element) element.setAttribute('transform', `translate(${dx / zoom} ${dy / zoom})`);
      return;
    }
    if (drag.kind === 'bgresize') {
      const background = TM.store.background;
      if (!background) return;
      const worldPoint = canvas.toWorld(e.clientX, e.clientY);
      let newWidth = Math.max(20, worldPoint.x - background.x), newHeight = Math.max(20, worldPoint.y - background.y);
      if (e.metaKey || e.ctrlKey) {                         // ⌘ / Ctrl: keep the picture's proportions — the larger pull wins
        const ratio = background.w / background.h;
        if (newWidth / newHeight > ratio) newHeight = newWidth / ratio; else newWidth = newHeight * ratio;
      }
      drag.bgSize = { w: newWidth, h: newHeight };
      const image = worldMap.querySelector('.layer-bg image');
      if (image) { image.setAttribute('width', newWidth); image.setAttribute('height', newHeight); }
      const handle = worldOverlay.querySelector('[data-bgresize]');
      if (handle) handle.setAttribute('transform', `translate(${background.x + newWidth} ${background.y + newHeight})`);
      return;
    }
    if (drag.kind === 'blk') {
      const owner = drag.t.blk.split('|')[0];
      const station = TM.store.stations.get(owner), block = station && station.block, centre = canvas.model.pos.get(owner);
      /* blockMembers/blockOwnerId live on the shared symbol object (I.share) when this station's node is a
         different-name interchange shared with another station — not on the station's own info entry directly. */
      const ownerInfo = canvas.model.info.get(owner), symbolInfo = ownerInfo && (ownerInfo.share || ownerInfo);
      const blockMembers = symbolInfo && symbolInfo.blockMembers;
      if (!block || !centre || !blockMembers) return;
      const size = block.size || Math.max(34, 15 * blockMembers.length);
      const worldPoint = canvas.toWorld(e.clientX, e.clientY), local = { x: worldPoint.x - centre.x, y: worldPoint.y - centre.y };
      const fraction = TM.geo.blockNearestT(block.style, block.shape, block.orientation, size, local), point = TM.geo.blockPoint(block.style, block.shape, block.orientation, size, fraction);
      drag.blockT = fraction;
      const element = worldMap.querySelector(`[data-blk="${CSS.escape(drag.t.blk)}"]`);
      if (element) element.setAttribute('transform', `translate(${point.x} ${point.y})`);
      return;
    }
    if (drag.kind === 'bend' || drag.kind === 'bendmid') {
      const worldPoint = canvas.toWorld(e.clientX, e.clientY);
      drag.gx = worldPoint.x / GRID; drag.gy = worldPoint.y / GRID;
      const key = drag.kind === 'bend' ? drag.t.bend : drag.t.bendmid;
      const handle = worldOverlay.querySelector(`[data-${drag.kind}="${CSS.escape(key)}"]`);
      if (handle) handle.setAttribute('transform', `translate(${worldPoint.x} ${worldPoint.y})`);
      return;
    }
    if (drag.kind === 'arch' || drag.kind === 'circ') { arcDrag(drag, canvas.toWorld(e.clientX, e.clientY)); return; }
    drag.node = canvas.nodeAt(e.clientX, e.clientY);
    if (e.shiftKey && !TM.state.showNodes) drag.node = straightFrom(drag) || drag.node;
    drag.node = arcConstrain(drag, drag.node) || drag.node;
    setHover(drag.node);
    const id = drag.t.sid, symbolEl = id && svg.querySelector(`[data-sid="${CSS.escape(id)}"]`);
    const target = drag.kind === 'station' ? { x: drag.node.x * GRID, y: drag.node.y * GRID } : null;
    if (symbolEl && target) { const before = canvas.model.pos.get(id); symbolEl.setAttribute('transform', `translate(${target.x - before.x} ${target.y - before.y})`); }
    if (drag.kind === 'wp') {
      const handle = worldOverlay.querySelector(`[data-wp="${drag.t.wp}"]`);
      if (handle) handle.setAttribute('transform', `translate(${drag.node.x * GRID} ${drag.node.y * GRID}) rotate(45)`);
    }
  }

  /* Dragging an arc handle: preview the new curve / circle in the overlay; the line changes on release (finishDrag). */
  function arcDrag(dragState, worldPoint) {
    const actions = TM.actions, line = actions.activeLine(), geo = TM.geo;
    if (!line) return;
    let prev = '';
    if (dragState.kind === 'arch') {
      const section = geo.arcSections(line).find((x) => x.i0 === +dragState.t.arch);
      if (!section) return;
      const start = TM.store.itemPos(line.path[section.i0]), end = TM.store.itemPos(line.path[section.i1 % line.path.length]);
      const chordLength = Math.hypot(end.x - start.x, end.y - start.y), normal = { x: (end.y - start.y) / chordLength, y: -(end.x - start.x) / chordLength };
      dragState.bulge = Math.max(-3, Math.min(3, ((worldPoint.x / GRID - (start.x + end.x) / 2) * normal.x + (worldPoint.y / GRID - (start.y + end.y) / 2) * normal.y) / chordLength));
      const arc = geo.arcFrom(start, end, dragState.bulge), toPixels = (v) => TM.round2dp(v * GRID);
      prev = arc ? `<path d="M${toPixels(start.x)} ${toPixels(start.y)} A${toPixels(arc.r)} ${toPixels(arc.r)} 0 ${arc.large ? 1 : 0} ${arc.sw} ${toPixels(end.x)} ${toPixels(end.y)}" fill="none" stroke="var(--accent)" stroke-width="4" stroke-dasharray="8 6"/>` + knob('x', arc.apex.x * GRID, arc.apex.y * GRID, 'grabbing')
        : `<path d="M${toPixels(start.x)} ${toPixels(start.y)} L${toPixels(end.x)} ${toPixels(end.y)}" fill="none" stroke="var(--accent)" stroke-width="4" stroke-dasharray="8 6"/>`;
    } else {
      const circle = line.circle;
      if (!circle) return;
      dragState.circle = dragState.t.circ === 'c' ? { x: worldPoint.x / GRID, y: worldPoint.y / GRID, r: circle.r } : { x: circle.x, y: circle.y, r: Math.max(0.5, Math.hypot(worldPoint.x / GRID - circle.x, worldPoint.y / GRID - circle.y)) };
      if (TM.state.showNodes && dragState.t.circ === 'c') { dragState.circle.x = Math.round(dragState.circle.x * 2) / 2; dragState.circle.y = Math.round(dragState.circle.y * 2) / 2; }
      const newCircle = dragState.circle;
      prev = `<circle cx="${newCircle.x * GRID}" cy="${newCircle.y * GRID}" r="${newCircle.r * GRID}" fill="none" stroke="var(--accent)" stroke-width="4" stroke-dasharray="8 6"/>` + knob('x', (dragState.t.circ === 'c' ? newCircle.x : newCircle.x + newCircle.r) * GRID, newCircle.y * GRID, 'grabbing');
    }
    let preview = worldOverlay.querySelector('.arc-preview');
    if (!preview) { preview = document.createElementNS('http://www.w3.org/2000/svg', 'g'); preview.setAttribute('class', 'arc-preview'); preview.setAttribute('pointer-events', 'none'); worldOverlay.appendChild(preview); }
    preview.innerHTML = prev;
  }

  /* Shift while dragging a station / bend with the node grid hidden: stay on a straight run from the previous stop or
     bend of the line (the next one when it is the first) — 90° steps on an orthogonal line, 45° on an octilinear one. */
  function straightFrom(dragState) {
    const actions = TM.actions, store = TM.store;
    let line = null, i = -1;
    if (dragState.kind === 'wp') { line = actions.activeLine(); i = +dragState.t.wp; }
    else if (dragState.kind === 'station') {
      const set = new Set(store.members(dragState.t.sid)), on = (l) => l.path.findIndex((it) => it.s && set.has(it.s));
      line = actions.activeLine();
      if (!line || on(line) < 0) line = store.usedByGroup(dragState.t.sid).find((l) => store.visible.has(l.id)) || store.usedByGroup(dragState.t.sid)[0];
      i = line ? on(line) : -1;
    }
    if (!line || i < 0) return null;
    const neighbour = line.path[i - 1] || line.path[i + 1];
    const from = neighbour && store.itemPos(neighbour);
    if (!from) return null;
    const vectorX = dragState.node.x - from.x, vectorY = dragState.node.y - from.y;
    if (!vectorX && !vectorY) return null;
    const steps = line.style === 'orthogonal' ? 4 : 8;
    const angle = Math.round(Math.atan2(vectorY, vectorX) / (Math.PI * 2 / steps)) * (Math.PI * 2 / steps);
    const unitX = Math.round(Math.cos(angle)), unitY = Math.round(Math.sin(angle));        // -1 / 0 / 1 per axis
    const along = (vectorX * unitX + vectorY * unitY) / (unitX * unitX + unitY * unitY);                         // how far along that direction, in nodes per axis step
    const stepCount = TM.round2dp(Math.max(0, along));
    return { x: TM.round2dp(from.x + unitX * stepCount), y: TM.round2dp(from.y + unitY * stepCount) };
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; drag = null; return; }
    if (!drag) return;
    const finished = drag; drag = null;
    svg.classList.remove('panning'); setHover(null);
    if (finished.moved) finishDrag(finished, e); else clickAt(finished, e);
  }

  function finishDrag(dragState) {
    const actions = TM.actions;
    if (dragState.kind === 'arch' && dragState.bulge != null) actions.setArcBulge(actions.activeLine(), +dragState.t.arch, dragState.bulge);
    else if (dragState.kind === 'circ' && dragState.circle) actions.setCircle(actions.activeLine(), dragState.circle);
    else if (dragState.kind === 'station' && dragState.node) actions.moveStation(dragState.t.sid, dragState.node);
    else if (dragState.kind === 'wp' && dragState.node) actions.moveItem(+dragState.t.wp, dragState.node);
    else if ((dragState.kind === 'dpt' || dragState.kind === 'dmid') && dragState.point) {
      const [id, iStr] = (dragState.t.dpt || dragState.t.dmid).split('|');
      if (dragState.kind === 'dpt') actions.moveDrawPoint(id, +iStr, dragState.point);
      else { actions.addDrawPoint(id, dragState.point, +iStr); if (!TM.state.drawId) actions.select({ type: 'draw', id, pt: +iStr }); }
    }
    else if (dragState.kind === 'badge') {
      const line = TM.store.line(dragState.t.line), current = (line && line.badges && line.badges[dragState.t.badge]) || { dx: 0, dy: 0 }, zoom = canvas.view.k;
      actions.setBadge(dragState.t.line, dragState.t.badge, current.dx + (dragState.lastDx || 0) / zoom, current.dy + (dragState.lastDy || 0) / zoom);
    } else if (dragState.kind === 'label') {
      const stationInfo = canvas.model.info.get(dragState.t.lbl), zoom = canvas.view.k, ownerSt = TM.store.stations.get(dragState.t.lbl);
      if (ownerSt && ownerSt.block) {                                    // a block's own name label — belongs to the block, not a line item
        const current = ownerSt.block.labelPos || {};
        actions.setBlockLabelPos(dragState.t.lbl, { pos: current.pos || (stationInfo && stationInfo.labelPos), dx: (current.dx || 0) + (dragState.lastDx || 0) / zoom, dy: (current.dy || 0) + (dragState.lastDy || 0) / zoom });
      } else {                                                           // any other station's label — a view preference, not tied to one line's item
        const current = TM.store.labelPos[TM.store.rep(dragState.t.lbl)] || {};
        actions.setLabelPos(dragState.t.lbl, { pos: current.pos || (stationInfo && stationInfo.labelPos), dx: (current.dx || 0) + (dragState.lastDx || 0) / zoom, dy: (current.dy || 0) + (dragState.lastDy || 0) / zoom });
      }
    } else if (dragState.kind === 'ann') {
      const zoom = canvas.view.k;
      actions.moveAnnotation(dragState.t.ann, (dragState.lastDx || 0) / zoom, (dragState.lastDy || 0) / zoom);
    } else if (dragState.kind === 'bg') {
      const background = TM.store.background, zoom = canvas.view.k;
      if (background) actions.setBackgroundRect({ x: background.x + (dragState.lastDx || 0) / zoom, y: background.y + (dragState.lastDy || 0) / zoom });
    } else if (dragState.kind === 'bgresize') {
      if (dragState.bgSize) actions.setBackgroundRect(dragState.bgSize);
    } else if (dragState.kind === 'bend' || dragState.kind === 'bendmid') {
      const key = dragState.kind === 'bend' ? dragState.t.bend : dragState.t.bendmid, [stationA, stationB, iStr] = key.split('|'), i = +iStr;
      const bends = TM.store.connBends(stationA, stationB).slice(), gridPoint = [TM.round2dp(dragState.gx), TM.round2dp(dragState.gy)];
      if (dragState.kind === 'bendmid') bends.splice(i, 0, gridPoint); else bends[i] = gridPoint;
      actions.setConnBends(stationA, stationB, bends);
    } else if (dragState.kind === 'blk' && dragState.blockT != null) {
      const [owner, memberId] = dragState.t.blk.split('|');
      actions.moveBlockMember(owner, memberId, dragState.blockT);
    }
    canvas.render();
  }

  function clickAt(dragState, e) {
    const actions = TM.actions, tool = TM.state.tool, target = dragState.t, node = canvas.nodeAt(e.clientX, e.clientY);
    if (TM.state.moving) {                                   // click-to-move: drop the selected station / bend on the clicked node
      const selection = TM.state.selected;
      const on = selection && (selection.type === 'station' ? arcConstrain({ kind: 'station', t: { sid: selection.id } }, node) : selection.type === 'wp' ? arcConstrain({ kind: 'wp', t: { wp: selection.index } }, node) : null);
      if (selection && selection.type === 'station') actions.moveStation(selection.id, on || node);
      else if (selection && selection.type === 'wp' && actions.editable() && !TM.store.stationAt(node.x, node.y)) actions.moveItem(selection.index, on || node);
      canvas.setMoving(false);
      return;
    }
    const stationId = target.sid || target.lbl || (tool === 'station' || tool === 'route' ? TM.store.stationAt(node.x, node.y) : null);
    if (tool === 'linestyle') {
      if (!actions.editable()) return;
      if (target.seg !== undefined) actions.toggleSeg(+target.seg, e.shiftKey);
      return;
    }
    if (tool === 'arc') {
      const line = actions.activeLine();
      if (!actions.editable() || !line || line.circle) return;
      const i = stationId ? actions.indexOfStation(stationId) : target.wp !== undefined ? +target.wp : -1;
      if (i < 0) { canvas.arcPick = null; TM.emit('tool'); return; }
      if (canvas.arcPick == null || canvas.arcPick === i) { canvas.arcPick = canvas.arcPick === i ? null : i; TM.emit('tool'); return; }
      const first = canvas.arcPick;
      canvas.arcPick = null;
      if (actions.addArc(line, first, i)) TM.toast('Arc added — drag its handle to change the curve');
      TM.emit('tool');
      return;
    }
    if (tool === 'erase') {
      if (stationId) { const i = actions.indexOfStation(stationId); if (i >= 0) actions.removeItem(i); }
      else if (target.wp !== undefined) actions.removeItem(+target.wp);
      else if (target.ann) actions.removeAnnotation(target.ann);
      return;
    }
    if (tool === 'draw') {
      if (!actions.ownsMap()) return;
      const store = TM.store, current = TM.state.drawId && store.drawingById(TM.state.drawId);
      if (target.dpt) {
        const [id, iStr] = target.dpt.split('|'), i = +iStr;
        if (current && id === current.id && (i === current.pts.length - 1 || (i === 0 && current.kind === 'area'))) { canvas.finishDrawing(); return; }
        if (!current) { actions.select({ type: 'draw', id, pt: i }); return; }
      }
      if (current) {
        /* a click close to the last point (or an area's first) finishes it, even when not right on its handle */
        const w = canvas.toWorld(e.clientX, e.clientY), near = (p) => Math.hypot(p[0] - w.x, p[1] - w.y) * canvas.view.k < 10;
        if (current.pts.length > 1 && (near(current.pts[current.pts.length - 1]) || (current.kind === 'area' && current.pts.length > 2 && near(current.pts[0])))) { canvas.finishDrawing(); return; }
        actions.addDrawPoint(current.id, drawPoint(e, current.pts[current.pts.length - 1]));
        return;
      }
      if (target.draw) { actions.select({ type: 'draw', id: target.draw }); return; }
      const d = actions.addDrawing(TM.state.drawKind, drawPoint(e, null));
      if (d) { TM.state.drawId = d.id; actions.select({ type: 'draw', id: d.id }); TM.emit('tool'); }
      return;
    }
    if (tool === 'label') {                                    // free-floating text / image annotations
      if (target.ann) { actions.select({ type: 'ann', id: target.ann }); return; }
      const worldPoint = canvas.toWorld(e.clientX, e.clientY);
      TM.ui.openAnnotationDialog({ x: worldPoint.x, y: worldPoint.y });
      return;
    }
    if (tool === 'station' || tool === 'route') {
      if (!actions.editable()) return;
      if (stationId) {
        if (actions.indexOfStation(stationId) >= 0) actions.select({ type: 'station', id: actions.memberOnActive(stationId) });
        else actions.addStationToLine(stationId);
      } else if (target.wp !== undefined) actions.select({ type: 'wp', index: +target.wp });
      else if (tool === 'station') TM.ui.openStationDialog({ node });
      else actions.addWaypoint(node.x, node.y);
      return;
    }
    if (target.dpt) { const [id, iStr] = target.dpt.split('|'); actions.select({ type: 'draw', id, pt: +iStr }); return; }
    if (stationId) actions.select({ type: 'station', id: actions.memberOnActive(stationId) });
    else if (target.wp !== undefined) actions.select({ type: 'wp', index: +target.wp });
    else if (target.draw && !target.line && !target.conn) actions.select({ type: 'draw', id: target.draw });
    else if (target.ann) actions.select({ type: 'ann', id: target.ann });
    else if (target.badge) actions.select({ type: 'badge', line: target.line, end: target.badge });
    else if (target.line) TM.emit('pick-line', target.line);
    else if (target.conn) { const [stationA, stationB] = target.conn.split('|'); actions.select({ type: 'conn', a: stationA, b: stationB }); }
    else actions.select(null);
  }

  function onKey(e) {
    if (TM.state.mode !== 'schematic' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || document.querySelector('.modal-back')) return;
    const actions = TM.actions, key = e.key.toLowerCase();
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (arrows[key] && TM.state.selected && (TM.state.tool === 'select' || (TM.state.tool === 'draw' && TM.state.selected.type === 'draw' && !TM.state.drawId))) {
      e.preventDefault();
      const step = e.shiftKey ? 3 : 1;
      if (actions.nudgeSelected(arrows[key][0] * step, arrows[key][1] * step)) canvas.render();
      return;
    }
    if (TM.state.tool === 'draw' && TM.state.drawId && (key === 'enter' || key === 'escape')) { canvas.finishDrawing(); return; }
    if (key === 'p') { if (actions.ownsMap()) canvas.setTool('draw'); else TM.toast('Only the map\'s own author can draw on it', 'err'); return; }
    if (key === 'm' && TM.state.selected) { canvas.setMoving(!TM.state.moving); return; }
    if (key === 'i' && actions.editable()) { actions.setInsertMode(TM.state.insertMode === 'before' ? 'after' : 'before'); return; }
    if (key === 'escape' && TM.state.moving) { canvas.setMoving(false); return; }
    /* V toggles Select <-> pan only (from Select, incl. while moving); from any other tool it picks Select */
    if (key === 'v') { if (TM.state.tool === 'select' || TM.state.tool === 'pan') canvas.toggleSelectTool(); else canvas.setTool('select'); return; }
    if (key === 'escape' && TM.state.tool === 'arc' && canvas.arcPick != null) { canvas.arcPick = null; TM.emit('tool'); return; }
    const tools = { s: 'station', b: 'route', d: 'linestyle', e: 'erase', l: 'label', a: 'arc' };
    if (tools[key]) {
      if (tools[key] === 'label' || actions.editable()) canvas.setTool(tools[key]);
      else TM.toast(actions.activeLine() ? `${actions.activeLine().code} is not yours to edit — pick one of your own lines` : 'Pick a line in the left panel first — the tools edit that line', 'err');   // say why, rather than silently ignoring the key
    }
    else if (key === 'g') { TM.state.showNodes = !TM.state.showNodes; applyView(); TM.emit('tool'); }
    else if (key === 'f') canvas.fit();
    else if (key === 'escape') { actions.select(null); canvas.setTool('select'); }
    else if (key === 'delete' || key === 'backspace') {
      const selection = TM.state.selected;
      if (selection && selection.type === 'ann') actions.removeAnnotation(selection.id);
      else if (selection && selection.type === 'draw') {
        const d = TM.store.drawingById(selection.id);
        if (d && selection.pt != null && d.pts.length > (d.kind === 'area' ? 3 : 2)) { actions.removeDrawPoint(d.id, selection.pt); actions.select({ type: 'draw', id: d.id }); }
        else if (d && confirm('Delete this drawing?')) { actions.removeDrawing(d.id); actions.select(null); }
      }
      else if (actions.editable()) {
        if (selection && selection.type === 'station') actions.removeItem(actions.indexOfStation(selection.id));
        else if (selection && selection.type === 'wp') actions.removeItem(selection.index);
      }
    }
  }

  canvas.setTool = (t) => { if (TM.state.drawId && t !== 'draw') canvas.finishDrawing(); TM.state.tool = t; TM.state.moving = false; canvas.arcPick = null; TM.emit('tool'); };
  /* Clicking (or pressing V on) the Select tool while it's already active closes it: 'pan' behaves exactly like
     'select' for clicking/inspecting, but draggable() below only allows drag-to-move under 'select', so a drag in
     'pan' always pans the canvas and never moves a station, label or bend. Clicking it again reopens 'select'. */
  canvas.toggleSelectTool = () => { TM.state.tool = TM.state.tool === 'select' ? 'pan' : 'select'; TM.state.moving = false; TM.emit('tool'); };
  canvas.setMoving = (v) => { TM.state.moving = !!v && !!TM.state.selected; if (TM.state.moving) TM.state.tool = 'select'; TM.emit('tool'); };

  canvas.init = () => {
    svg = document.getElementById('svg'); world = document.getElementById('world');
    worldMap = document.getElementById('worldMap'); worldOverlay = document.getElementById('worldOverlay');
    nodeGrid = document.getElementById('nodeGrid'); pattern = document.getElementById('nodePattern');
    pattern.setAttribute('width', GRID); pattern.setAttribute('height', GRID);
    hoverEl = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hoverEl.setAttribute('r', 13); hoverEl.setAttribute('fill', 'var(--accent)'); hoverEl.setAttribute('fill-opacity', '.22');
    hoverEl.setAttribute('stroke', 'var(--accent)'); hoverEl.setAttribute('stroke-width', '2'); hoverEl.setAttribute('pointer-events', 'none');
    hoverEl.setAttribute('visibility', 'hidden');
    world.appendChild(hoverEl);

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', (e) => { if (drag) { drag.lastDx = e.clientX - drag.sx; drag.lastDy = e.clientY - drag.sy; } onMove(e); });
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('pointerleave', () => { if (!drag) setHover(null); });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!e.ctrlKey && (e.deltaX !== 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 40))) {
        canvas.view.tx -= e.deltaX; canvas.view.ty -= e.deltaY; canvas.moved = true; applyView(); return;
      }
      canvas.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    }, { passive: false });
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('dblclick', (e) => {
      const pointHandle = e.target.closest('[data-dpt]');
      if (TM.state.tool === 'draw' && TM.state.drawId) { e.preventDefault(); canvas.finishDrawing(); return; }
      if (pointHandle && TM.actions.ownsMap()) {
        e.preventDefault();
        const [id, iStr] = pointHandle.dataset.dpt.split('|'), d = TM.store.drawingById(id);
        if (d && d.pts.length > (d.kind === 'area' ? 3 : 2)) { TM.actions.removeDrawPoint(id, +iStr); TM.actions.select({ type: 'draw', id }); }
        else TM.toast('A drawing needs at least ' + (d && d.kind === 'area' ? 3 : 2) + ' points — delete the drawing instead', 'err');
        return;
      }
      const arcHandle = e.target.closest('[data-arch]');
      if (arcHandle && TM.state.tool === 'arc') { e.preventDefault(); TM.actions.removeArc(TM.actions.activeLine(), +arcHandle.dataset.arch); return; }
      const element = e.target.closest('[data-bend]');
      if (!element) return;
      e.preventDefault();
      const [stationA, stationB, iStr] = element.dataset.bend.split('|'), i = +iStr, bends = TM.store.connBends(stationA, stationB).slice();
      bends.splice(i, 1);
      TM.actions.setConnBends(stationA, stationB, bends);
    });
    document.addEventListener('keydown', onKey);
    document.getElementById('zIn').onclick = () => canvas.zoomCenter(1.25);
    document.getElementById('zOut').onclick = () => canvas.zoomCenter(0.8);
    document.getElementById('zFit').onclick = canvas.fit;
    window.addEventListener('resize', applyView);

    ['active', 'change', 'display', 'lang', 'line-filter', 'theme', 'selection', 'tool', 'visibility'].forEach((ev) => TM.on(ev, schedule));
    TM.on('mode', () => { if (TM.state.mode === 'schematic') { canvas.render(); applyView(); } });
    canvas.render(); canvas.fit();
    /* The stage can still be settling its layout when this runs (side panels, fonts), which left the first fit at the
       smallest zoom and off to one side — nothing to see or click. Fit again once it has settled, and on any change
       of the stage's size until the view is moved by hand. */
    requestAnimationFrame(() => { if (!canvas.moved) canvas.fit(); });
    if (window.ResizeObserver) new ResizeObserver(() => { if (!canvas.moved) canvas.fit(); }).observe(svg);
  };
})(window.TM);
