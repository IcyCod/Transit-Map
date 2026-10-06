/* Journey planner's schematic canvas: pan / zoom / fit, and clicking a station — nothing else. No drag, no tools, no
   station/line editing — TM.actions' mutating calls are never reached from here, unlike js/canvas.js (index.html). */
(function (TM) {
  const GRID = TM.GRID;
  const planCanvas = (TM.navCanvas = { view: { tx: 0, ty: 0, k: 1 }, model: null, picking: null });
  let svg, world, worldMap, worldOverlay, nodeGrid, pattern;
  let drag = null;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  planCanvas.toWorld = (cx, cy) => {
    const rect = svg.getBoundingClientRect();
    return { x: (cx - rect.left - planCanvas.view.tx) / planCanvas.view.k, y: (cy - rect.top - planCanvas.view.ty) / planCanvas.view.k };
  };

  function applyView() {
    const { tx: translateX, ty: translateY, k: zoom } = planCanvas.view;
    world.setAttribute('transform', `translate(${translateX} ${translateY}) scale(${zoom})`);
    pattern.setAttribute('patternTransform', `translate(${translateX} ${translateY}) scale(${zoom})`);
    nodeGrid.setAttribute('opacity', zoom < 0.3 ? 0 : zoom < 0.5 ? 0.55 : 1);
  }
  planCanvas.applyView = applyView;

  planCanvas.zoomAt = (cx, cy, factor) => {
    const rect = svg.getBoundingClientRect(), view = planCanvas.view, newZoom = clamp(view.k * factor, 0.04, 3.2), real = newZoom / view.k;
    const pointerX = cx - rect.left, pointerY = cy - rect.top;
    view.tx = pointerX - (pointerX - view.tx) * real; view.ty = pointerY - (pointerY - view.ty) * real; view.k = newZoom;
    applyView();
  };
  planCanvas.zoomCenter = (f) => { const rect = svg.getBoundingClientRect(); planCanvas.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, f); };

  planCanvas.fit = () => {
    if (!planCanvas.model) return;
    const bbox = planCanvas.model.bbox, rect = svg.getBoundingClientRect(), pad = 50;
    if (!rect.width) return;
    const zoom = clamp(Math.min((rect.width - pad * 2) / bbox.w, (rect.height - pad * 2) / bbox.h), 0.04, 1.3);
    planCanvas.view.k = zoom;
    planCanvas.view.tx = (rect.width - bbox.w * zoom) / 2 - bbox.x * zoom;
    planCanvas.view.ty = (rect.height - bbox.h * zoom) / 2 - bbox.y * zoom;
    applyView();
  };
  planCanvas.centerOn = (worldX, worldY, zoom) => {
    const rect = svg.getBoundingClientRect();
    planCanvas.view.k = zoom || Math.max(planCanvas.view.k, 0.7);
    planCanvas.view.tx = rect.width / 2 - worldX * planCanvas.view.k; planCanvas.view.ty = rect.height / 2 - worldY * planCanvas.view.k;
    applyView();
  };

  /* ---------- route highlight ---------- */
  /* result: one item from TM.route.find(...).results, or null to clear. The route itself needs no line of its own —
     the map already lights just the stretch it rides and dims the rest (TM.navUI.routeDimOpts) — so all that is
     added is a step marker for every place the traveller boards, alights or changes: the start, then 1, 2, … for
     each stop in between, and the last number at the destination. Each sits just past the far end of that station's
     label, away from the station — left of a w / nw / sw label, right of an e / ne / se one, above an n one and
     below an s one — or beside the symbol when the label is hidden. */
  planCanvas.showRoute = (result) => { planCanvas.route = result || null; if (svg) schedule(); };

  const MARK_R = 11;
  function routeOverlay() {
    if (!planCanvas.route || !planCanvas.model) return '';
    const model = planCanvas.model, palette = model.pal, store = TM.store;
    const used = new Map();   // two steps at one label (partners sharing a node) sit side by side, not on top of each other
    let markup = '';
    TM.navUI.routeSteps(planCanvas.route).forEach(({ id, n: number, first, last }) => {
      const key = model.pos.has(id) ? id : store.rep(id), point = model.pos.get(key);
      if (!point) return;
      const box = model.boxes.get(key), info = model.info.get(key), direction = (box && info && info.labelPos) || 'ne';
      const west = direction === 'w' || direction === 'nw' || direction === 'sw', east = direction === 'e' || direction === 'ne' || direction === 'se';
      const count = used.get(key) || 0; used.set(key, count + 1);
      const step = count * (MARK_R * 2 + 3), gap = MARK_R + 4;
      let x, y;
      if (!box) { x = point.x + 22 + gap + step; y = point.y - 22; }
      else if (west) { x = box.x - gap - step; y = box.y + box.h / 2; }
      else if (east) { x = box.x + box.w + gap + step; y = box.y + box.h / 2; }
      else if (direction === 'n') { x = box.x + box.w / 2 + step; y = box.y - gap; }
      else { x = box.x + box.w / 2 + step; y = box.y + box.h + gap; }
      const fill = last ? palette.fantasy : palette.ink, textColour = last ? '#fff' : palette.paper;
      const mark = first
        ? `<path d="M-3.5 -5.5 L6 0 L-3.5 5.5 Z" fill="${textColour}"/>`
        : `<text y="4.3" text-anchor="middle" font-size="12.5" font-weight="800" fill="${textColour}" font-family='${TM.symbols.FONT}'>${number}</text>`;
      markup += `<g transform="translate(${x} ${y})"><circle r="${MARK_R}" fill="${fill}" stroke="${palette.paper}" stroke-width="2.5"/>${mark}</g>`;
    });
    return `<g pointer-events="none">${markup}</g>`;
  }

  /* ---------- rendering ---------- */
  planCanvas.render = () => {
    if (!svg) return;
    const model = planCanvas.model = TM.render.build(TM.navUI.renderOpts());
    worldMap.innerHTML = model.svg;
    worldOverlay.innerHTML = routeOverlay();
    svg.classList.toggle('nav-picking', !!planCanvas.picking);
    TM.emit('nav-rendered', model);
  };
  let frameRequest = 0;
  const schedule = () => { if (!frameRequest) frameRequest = requestAnimationFrame(() => { frameRequest = 0; planCanvas.render(); }); };

  /* ---------- pointer: pan, zoom, click-to-pick ---------- */
  function onDown(e) {
    if (e.button === 2) return;
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    drag = { sx: e.clientX, sy: e.clientY, tx: planCanvas.view.tx, ty: planCanvas.view.ty, moved: false };
  }
  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    planCanvas.view.tx = drag.tx + dx; planCanvas.view.ty = drag.ty + dy;
    svg.classList.add('panning'); applyView();
  }
  function onUp(e) {
    if (!drag) return;
    const moved = drag.moved; drag = null;
    svg.classList.remove('panning');
    if (moved) return;
    /* the pointer was captured on press, so e.target is the whole canvas — ask what is really under it */
    const hit = document.elementFromPoint(e.clientX, e.clientY), element = hit && hit.closest ? hit.closest('[data-sid]') : null;
    if (element && planCanvas.picking) { planCanvas.picking(element.dataset.sid); return; }
    if (element) TM.navUI.showStation(element.dataset.sid);
  }

  planCanvas.init = () => {
    svg = document.getElementById('svg'); world = document.getElementById('world');
    worldMap = document.getElementById('worldMap'); worldOverlay = document.getElementById('worldOverlay');
    nodeGrid = document.getElementById('nodeGrid'); pattern = document.getElementById('nodePattern');
    pattern.setAttribute('width', GRID); pattern.setAttribute('height', GRID);

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!e.ctrlKey && (e.deltaX !== 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 40))) {
        planCanvas.view.tx -= e.deltaX; planCanvas.view.ty -= e.deltaY; applyView(); return;
      }
      planCanvas.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    }, { passive: false });
    svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const element = e.target.closest && e.target.closest('[data-sid]');
      if (element) TM.navUI.stationMenu(element.dataset.sid, e.clientX, e.clientY);
    });
    document.getElementById('zIn').onclick = () => planCanvas.zoomCenter(1.25);
    document.getElementById('zOut').onclick = () => planCanvas.zoomCenter(0.8);
    document.getElementById('zFit').innerHTML = TM.icon('fit');
    document.getElementById('zFit').onclick = planCanvas.fit;
    window.addEventListener('resize', applyView);

    ['change', 'display', 'lang', 'theme', 'nav-display'].forEach((ev) => TM.on(ev, schedule));
    planCanvas.render(); planCanvas.fit();
  };
})(window.TM);
