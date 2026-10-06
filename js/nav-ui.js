/* Journey planner UI: map picker, From / To search, Display filters, and the ranked list of ways to travel.
   Boots the page itself (like js/app.js does for index.html) — there is no separate app.js here. */
(function (TM) {
  const planUI = (TM.navUI = {});
  const store = TM.store;
  const $ = (id) => document.getElementById(id);

  /* stations hidden by default here — a journey planner is for real trips, not for suggestions still being worked out */
  planUI.disp = { ...TM.statusFlagsFrom(() => false), modes: null, avoidLines: new Set(), services: {} };   // services: this viewer's own on / off per service (TM.route.serviceOn)
  planUI.flags = () => planUI.disp;
  /* when to leave: 'any' (no time — average waits, like a map with no timetables), 'now', or 'at' a chosen moment (ms) */
  planUI.when = { mode: 'any', at: null };
  planUI.whenMs = () => (planUI.when.mode === 'now' ? Math.floor(Date.now() / 60000) * 60000 : planUI.when.mode === 'at' && planUI.when.at ? planUI.when.at : null);
  planUI.state = { from: null, to: null, by: 'time', dir: 'asc', results: [], open: -1, openVia: new Set(), picking: null };

  /* Same platform or an interchange are one pick here — same station, same fare, same everything — even though
     the underlying network still treats a real transfer between them as the real thing it is. */
  planUI.groupOpts = () => ({ groupBy: (s) => store.complexOf(s.id), groupMembers: (s) => store.complexMembers(s.id) });

  /* Every line a currently-open result actually rides, just the stretch of each it rides (every other part of
     those lines dims like any other line), and every station the route calls at or passes — walk-leg endpoints
     included, so the connector it uses is never dimmed — see render.js's opts.activeLineIds / activeSegs /
     activeExtra. Nothing open means "dim nothing", same as index.html shows a map with no active line. */
  planUI.routeDimOpts = () => {
    const result = planUI.state.open >= 0 ? planUI.state.results[planUI.state.open] : null;
    if (!result) return {};
    const lineIds = new Set(), segs = new Map(), extra = new Set();
    result.legs.forEach((leg) => {
      if (leg.kind === 'ride') {
        /* every track line the ride runs on — a through train runs on more than one */
        TM.route.legLineSegments(leg).forEach(({ line, segs: segments }) => {
          lineIds.add(line.id);
          const set = segs.get(line.id) || segs.set(line.id, new Set()).get(line.id);
          segments.forEach((k) => set.add(k));
        });
        [leg.board, ...leg.via, leg.alight].forEach((id) => extra.add(store.rep(id)));
      } else { extra.add(store.rep(leg.from)); extra.add(store.rep(leg.to)); }
    });
    return { activeLineIds: lineIds, activeSegs: segs, activeExtra: extra };
  };

  /* Every place a route boards, alights or changes, in order: the start (step 0), then 1, 2, … for each stop in
     between, and the last number at the destination — the step markers both the schematic and the real map show. */
  planUI.routeSteps = (result) => {
    if (!result) return [];
    const ids = [];
    result.legs.forEach((leg, i) => {
      if (i === 0) ids.push(leg.kind === 'ride' ? leg.board : leg.from);
      ids.push(leg.kind === 'ride' ? leg.alight : leg.to);
    });
    return ids.map((id, n) => ({ id, n, first: n === 0, last: n === ids.length - 1 }));
  };

  planUI.renderOpts = () => Object.assign({
    theme: document.documentElement.dataset.theme || 'light',
    langs: TM.state.langs.length ? TM.state.langs : ['en'],
    lineIds: [...store.lines.keys()],
    activeLineId: null,
    showCodes: true,
    numberMode: (TM.maps.current && TM.maps.current.numberMode) || 'code',          // the map's own default, else codes
    numModeOverride: !!(TM.maps.current && TM.maps.current.numModeOverride),
    labelSize: 13, lineWidth: 8, symbolScale: 1, connWidth: 7,
    hotspots: false, showSuggested: false, showFantasy: false,
    ...TM.statusFlagsFrom((t) => planUI.disp[t.opt]),
    interactive: true,   // only so data-sid attributes are emitted for click-to-pick; nothing is draggable here
  }, planUI.routeDimOpts());

  const stnName = (id) => { const station = store.stations.get(id); return station ? TM.nameOf(station, TM.state.langs[0]) : id; };
  const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);
  const codeChip = (l) => `<span class="code line-pill" style="background:${l.color};color:${TM.symbols.contrast(l.color)}">${TM.esc(l.code)}</span>`;

  /* ---------- picking a station (search box or a canvas / map click) ---------- */
  function setPicking(which) {
    planUI.state.picking = which;
    const onPick = which ? (id) => { setField(which, id); setPicking(null); } : null;
    TM.navCanvas.picking = onPick; TM.navMap.picking = onPick;
    renderRight();
  }
  function setField(which, id) {
    if (!store.stations.has(id) || store.stations.get(id).status === 'fantasy') return;
    planUI.state[which] = store.rep(id);   // departure = destination is allowed: a line there may offer a same-station in-out
    if (planUI.state.picking === which) { planUI.state.picking = null; TM.navCanvas.picking = null; TM.navMap.picking = null; }
    runSearch();
    if (planUI.state.from && planUI.state.to) focusDeparture();   // the other end was already there: show where the trip starts
  }
  /* bring the departure station into view on whichever map is showing, zoomed in close enough to read it — the same
     focus as the map editor's (js/ui-panels.js focusStation): at least 0.7 on the schematic, 15 on the real map */
  function focusDeparture() {
    const id = planUI.state.from;
    if (TM.state.mode === 'map') { const station = store.stations.get(id); if (TM.navMap.map && station) TM.navMap.map.flyTo([station.lat, station.lng], Math.max(TM.navMap.map.getZoom(), 15)); return; }
    const model = TM.navCanvas.model, point = model && (model.pos.get(id) || model.pos.get(store.rep(id)));
    if (point) TM.navCanvas.centerOn(point.x, point.y);
  }
  planUI.showStation = (id) => {
    if (!store.stations.has(id) || store.stations.get(id).status === 'fantasy') return;
    if (!planUI.state.from) setField('from', id);
    else if (!planUI.state.to) setField('to', id);
    else TM.toast('Both stations are set — right-click a station to change the departure or destination station');
  };

  /* Right-click any station, at any time, on either map: set it as the departure or the destination station. */
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
  planUI.stationMenu = (id, x, y) => {
    closeMenu();
    const station = store.stations.get(id);
    if (!station || station.status === 'fantasy') return;
    menu = document.createElement('div');
    menu.className = 'ctx-menu'; menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div class="ctx-head">${TM.esc(stnName(id))} <span class="hint">${TM.esc(store.complexMembers(id).join(' · '))}</span></div>` +
      `<button role="menuitem" data-set="from">${TM.icon('pin')} Set as departure station</button><button role="menuitem" data-set="to">${TM.icon('pin')} Set as destination station</button>`;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + 'px';
    menu.onclick = (e) => { const button = e.target.closest('[data-set]'); if (button) { closeMenu(); setField(button.dataset.set, id); } };
  };
  document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('wheel', closeMenu, { passive: true });

  /* ---------- left panel: map picker note aside, From / To, Display ---------- */
  const bannedSet = () => new Set([...store.stations.values()].filter((s) => !TM.route.allowed(s, planUI.flags())).map((s) => s.id));

  /* From / To (with swap and pick-on-map), at the top of the right panel above the results */
  function routeFieldsHtml() {
    const from = planUI.state.from, to = planUI.state.to;
    const field = (which, label, id) => `<div class="field"><label>${label}</label><div class="row" style="gap:6px">` +
      `<div id="nav-${which}" style="flex:1"></div>` +
      /* the pin only while the field is empty — a set station is changed by clearing it, or by right-clicking a station */
      (id ? '' : `<button class="btn icon-btn ${planUI.state.picking === which ? 'primary' : 'ghost'}" data-pick="${which}" title="Pick the ${which === 'from' ? 'departure' : 'destination'} station on the map">${TM.icon('pin')}</button>`) +
      (id ? `<button class="btn icon-btn ghost" data-clr="${which}" title="Clear">${TM.icon('x')}</button>` : '') + '</div></div>';
    return `<div class="sec">` +
      field('from', 'From', from) + field('to', 'To', to) +
      `<button class="btn sm ghost" id="navSwap" style="margin-top:2px" ${from || to ? '' : 'disabled'}>${TM.icon('swap')} Swap</button>` +
      (planUI.state.picking ? `<p class="hint" style="margin:8px 0 0">Click a station on the map to set your ${planUI.state.picking === 'from' ? '<b>departure station</b>' : '<b>destination station</b>'} — click the pin again to cancel.</p>` : '') +
      whenHtml() + `</div>`;
  }
  /* Leave: any time / now / a date and time — in the traveller's own time zone; timetables are read in their own */
  const pad = (n) => String(n).padStart(2, '0');
  const localInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function whenHtml() {
    const w = planUI.when;
    return `<div class="field" style="margin:12px 0 0"><label>Leave</label><div class="seg" style="width:100%">` +
      [['any', 'Any time'], ['now', 'Now'], ['at', 'Set time']].map(([k, t]) => `<button type="button" data-when="${k}" class="${w.mode === k ? 'on' : ''}" style="flex:1">${t}</button>`).join('') + `</div>` +
      (w.mode === 'at' ? `<input class="input" type="datetime-local" id="whenAt" value="${localInput(w.at || Date.now())}" style="margin-top:6px">` : '') +
      `<p class="hint" style="margin:6px 0 0">${w.mode === 'any' ? 'Times include an average wait for each train.' : `Waits follow the timetables${w.mode === 'now' ? ' from now' : ''} · your time zone ${TM.esc(TM.sched.userTz())}.`}</p></div>`;
  }
  function mountRouteFields() {
    const from = planUI.state.from, to = planUI.state.to;
    TM.ui.searchStations($(`nav-from`), Object.assign({ placeholder: 'Station or code…', exclude: bannedSet, onPick: (s) => setField('from', s.id) }, planUI.groupOpts()));
    TM.ui.searchStations($(`nav-to`), Object.assign({ placeholder: 'Station or code…', exclude: bannedSet, onPick: (s) => setField('to', s.id) }, planUI.groupOpts()));
    if (from) $('nav-from').querySelector('input').value = `${from} ${stnName(from)}`;
    if (to) $('nav-to').querySelector('input').value = `${to} ${stnName(to)}`;
  }

  function renderLeft() {
    const panel = $('left'), scrollTop = panel.scrollTop;
    let html = '';
    html += `<div class="sec"><div class="sec-h"><h3>Display</h3></div><div style="display:grid;gap:9px">` +
      TM.STATUS_TOGGLES.map((t) => [t.opt, t.label])
        .map(([k, t]) => `<label class="check"><input type="checkbox" data-opt="${k}" ${planUI.disp[k] ? 'checked' : ''}> ${t}</label>`).join('') +
      `</div><p class="hint" style="margin:8px 0 0">Fantasy stations are never shown or usable here — this planner is for real, on-the-map trips.</p></div>`;
    const modes = planUI.disp.modes || new Set(Object.keys(TM.MODES));
    html += `<div class="sec"><div class="sec-h"><h3>Transportation</h3></div><p class="hint" style="margin-top:0">Untick a type to avoid it, or leave just the ones you want.</p><div style="display:grid;gap:9px">` +
      Object.entries(TM.MODES).map(([k, t]) => `<label class="check"><input type="checkbox" data-mode="${k}" ${modes.has(k) ? 'checked' : ''}> ${t}</label>`).join('') +
      `</div></div>`;
    /* single lines to avoid, on top of the types above (a line of an avoided type is off either way) */
    const avoid = planUI.disp.avoidLines;
    html += `<div class="sec"><div class="sec-h"><h3>Lines</h3>${avoid.size ? '<button class="btn sm ghost" id="avoidReset">Use all</button>' : ''}</div><p class="hint" style="margin-top:0">Untick a line to plan without it.</p><div style="display:grid;gap:9px">` +
      [...store.lines.values()].map((l) => `<label class="check" ${modes.has(l.mode) ? '' : 'style="opacity:.5" title="Its type is avoided above"'}><input type="checkbox" data-avoid="${TM.esc(l.id)}" ${avoid.has(l.id) ? '' : 'checked'}> ${codeChip(l)} ${TM.esc(TM.displayName(l))}</label>`).join('') +
      `</div></div>`;
    /* the map's services (maps/<id>/services.json), by line: switch any on or off — one marked hidden starts off */
    const svcs = store.services;
    if (svcs.length) {
      const byLine = new Map();
      svcs.forEach((service) => {
        const serviceRoute = store.serviceRoute(service), firstHop = serviceRoute.hops.find((x) => x.line), root = firstHop ? store.rootLine(firstHop.line) : null, rootId = root ? root.id : '';
        (byLine.get(rootId) || byLine.set(rootId, { root, list: [] }).get(rootId)).list.push({ sv: service, rt: serviceRoute });
      });
      const ends = ({ sv, rt }) => (rt.ok ? (rt.loop ? `loop from ${stnName(rt.places[0].ids[0])}` : `${stnName(rt.places[0].ids[0])} ↔ ${stnName(rt.places[rt.places.length - 1].ids[0])}`) + (sv.both === false ? ' (one way)' : '') : 'route not found');
      html += `<div class="sec"><div class="sec-h"><h3>Services</h3></div><p class="hint" style="margin-top:0">Trains that run on the lines — untick one to plan without it.</p><div style="display:grid;gap:9px">` +
        [...byLine.values()].map(({ root, list }) => (root ? `<div class="lbl" style="margin:4px 0 -3px">${codeChip(root)} ${TM.esc(TM.displayName(root))}</div>` : '') +
          list.map((x) => `<label class="check"><input type="checkbox" data-svc="${TM.esc(x.sv.id)}" ${TM.route.serviceOn(x.sv, planUI.flags()) ? 'checked' : ''}> <span><b>${TM.esc(x.sv.type ? x.sv.type + ' · ' + x.sv.name : x.sv.name)}</b><br><span class="hint">${TM.esc(ends(x))}</span></span></label>`).join('')).join('') +
        `</div></div>`;
    }
    panel.innerHTML = html; panel.scrollTop = scrollTop;
  }

  function wireLeft() {
    const panel = $('left');
    panel.addEventListener('click', (e) => { if (e.target.closest('#avoidReset')) { planUI.disp.avoidLines = new Set(); renderLeft(); runSearch(); TM.emit('nav-display'); } });
    panel.addEventListener('change', (e) => {
      if (e.target.dataset.svc) {
        planUI.disp.services = Object.assign({}, planUI.disp.services, { [e.target.dataset.svc]: e.target.checked });
        TM.storage.setJSON('tm.navServices.' + TM.maps.current.id, planUI.disp.services);
        runSearch(); TM.emit('nav-display');
        return;
      }
      if (e.target.dataset.avoid) {
        const avoid = new Set(planUI.disp.avoidLines);
        if (e.target.checked) avoid.delete(e.target.dataset.avoid); else avoid.add(e.target.dataset.avoid);
        planUI.disp.avoidLines = avoid;
        renderLeft(); runSearch(); TM.emit('nav-display');
        return;
      }
      if (e.target.dataset.mode) {
        const modes = new Set(planUI.disp.modes || Object.keys(TM.MODES));
        if (e.target.checked) modes.add(e.target.dataset.mode); else modes.delete(e.target.dataset.mode);
        planUI.disp.modes = modes;
        renderLeft(); runSearch(); TM.emit('nav-display');
        return;
      }
      if (!e.target.dataset.opt) return;
      planUI.disp[e.target.dataset.opt] = e.target.checked;
      renderLeft(); runSearch(); TM.emit('nav-display');
    });
  }

  /* ---------- right panel: sort + results ---------- */
  /* "Look for train towards Gombak · platform 2": which way to board — the line's last stop in the direction ridden
     (the last one showing with the Display filters, so an unopened extension is not named); a circle line has no
     terminus, so "running clockwise / anticlockwise" instead (store.loopDir: the line's own, or worked out from the map),
     or its next stop if even that is unknown — and the platform this line uses there in that direction, when recorded. */
  /* the lines a ride runs on, in order — a through train runs on more than one — each once */
  const rideLines = (leg) => [...new Set((leg.parts || [{ line: leg.line }]).map((pt) => store.rootLine(pt.line) || pt.line))];
  /* a service's own name, where it tells trains apart: its type ("Express"), else its name when its line runs more
     than one service here or it runs through onto another line */
  const serviceLabel = (leg) => {
    const service = leg.service;
    if (!service) return '';
    if (service.type) return service.type;
    const running = store.servicesOn(store.rootId(leg.line)).filter((x) => TM.route.serviceOn(x, planUI.flags()));
    return rideLines(leg).length > 1 || running.length > 1 ? service.name : '';
  };
  /* the next station along the train's way, after the one boarded at, where another line can be changed to (any of its
     platforms or linked stations — store.complexMembers); a service follows its own route, onto another line too */
  function nextInterchange(leg) {
    const board = leg.board, lineAt = (id) => new Set(store.complexMembers(id).flatMap((m) => store.usedByGroup(m).map((l) => store.rootId(l.id))));
    const own = new Set(rideLines(leg).map((l) => store.rootId(l.id))), boardHere = store.complexOf(board);
    const isInterchange = (id) => { const st = store.stations.get(id); return st && TM.route.allowed(st, planUI.flags()) && store.complexOf(id) !== boardHere && [...lineAt(id)].some((l) => !own.has(l)); };
    let order = [];
    if (leg.service) {
      const rt = store.serviceRoute(leg.service);
      let ids = rt.ok ? rt.places.map((p) => p.ids[0]) : [];
      if (leg.back) ids = rt.loop ? [ids[0], ...ids.slice(1).reverse()] : ids.reverse();
      const at = ids.findIndex((id) => store.complexOf(id) === boardHere);
      order = at < 0 ? [] : rt.loop ? ids.slice(at + 1).concat(ids.slice(0, at)) : ids.slice(at + 1);
    } else {
      const path = leg.line.path, span = leg.spans[0], step = span.fwd ? 1 : -1, n = path.length;
      for (let k = 1; k < n; k++) {
        const i = leg.line.loop ? ((span.a + step * k) % n + n) % n : span.a + step * k;
        if (i < 0 || i >= n) break;
        if (path[i].s) order.push(path[i].s);
      }
    }
    return order.find(isInterchange) || null;
  }
  function boarding(leg) {
    const line = leg.line, path = line.path, span = leg.spans[0], count = path.length, step = span.fwd ? 1 : -1;
    const usable = (i) => { const station = path[i] && path[i].s && store.stations.get(path[i].s); return station && TM.route.allowed(station, planUI.flags()) ? station : null; };
    const platform = path[span.a] && path[span.a].platform && path[span.a].platform[span.fwd ? 'next' : 'prev'];
    const label = serviceLabel(leg);
    const at = platform ? ` · platform <b>${TM.esc(platform)}</b>` : '', what = (label ? `<b>${TM.esc(label)}</b> ` : '') + TM.vehicleOf(line.mode);
    /* the line's (or the service's own) way of naming the train: towards its terminus, via its next interchange, or both */
    const root = store.rootLine(line) || line, mode = (leg.service && leg.service.lookFor) || root.lookFor || 'towards';
    const via = mode === 'towards' ? null : nextInterchange(leg);
    const viaText = via ? ` via <b>${TM.esc(stnName(via))}</b>` : '';
    /* a service is headed for its own terminus — which may be on another line, for a train running through */
    let ending;
    if (leg.service && leg.terminus) ending = `towards <b>${TM.esc(stnName(leg.terminus))}</b>`;
    else {
      const turn = store.loopDir(line);
      if (turn) {
        const way = span.fwd ? turn : turn === 'clockwise' ? 'anticlockwise' : 'clockwise';
        const names = (leg.service && leg.service.loopNames) || root.loopNames || 'cw', traffic = (leg.service && leg.service.traffic) || root.traffic || 'left';
        ending = names === 'cw' ? `running <b>${way}</b>` : `on the <b>${TM.loopWay(way, names, traffic)}</b>`;
      }
      else {
        let towards = null;
        if (line.loop) { for (let k = 1; k < count && !towards; k++) towards = usable(((span.a + step * k) % count + count) % count); }
        else for (let i = span.fwd ? count - 1 : 0; i !== span.a && !towards; i -= step) towards = usable(i);
        ending = `towards <b>${TM.esc(towards ? TM.nameOf(towards, TM.state.langs[0]) : '—')}</b>`;
      }
    }
    if (via && mode === 'via') return `Look for ${what}${viaText}${at}`;
    return `Look for ${what}${viaText} ${ending}${at}`;   // "towards" — or "via" with no interchange ahead to name
  }

  /* the wait for a ride's train, at the start of the trip or at a change: the next train's time when it is known
     (a timetable, or the first train of the day), otherwise the average wait for how often trains run */
  const clockText = (ms) => { const d = new Date(ms), today = new Date(); const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return d.toDateString() === today.toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`; };
  function waitLine(leg, first) {
    if (leg.wait == null) return '';
    const what = leg.waitExact && leg.departAt ? `Next train <b>${clockText(leg.departAt)}</b>` : leg.waitGuess ? 'Wait for the train' : 'Average wait';
    return `<div class="route-leg walk">${TM.icon('clock')} <span>${what}${first ? '' : ' after changing'}${leg.waitGuess ? ' <span class="hint">(no timetable — a usual wait)</span>' : ''}</span><span class="hint">${leg.waitExact ? '' : '~'}${fmtMin(leg.wait)}</span></div>`;
  }
  /* legs: the whole route, so a walk knows whether anything was ridden before it (nothing to tap out of otherwise) */
  function legLine(leg, i, legs) {
    if (leg.kind === 'stay') return '';   // said on the card itself: "Just do not enter the station paid area."
    if (leg.kind === 'inout') return `<div class="route-leg">${codeChip(leg.line)} <span>Enter and exit at <b>${TM.esc(stnName(leg.from))}</b></span><span class="hint">${leg.cost != null ? TM.fares.fmt(leg.cost) : ''}</span></div>`;
    if (leg.kind === 'walk') {
      /* a connecting / unofficial link leaves the paid area — but only once you are in it; an interchange walk stays inside */
      const ridden = legs.slice(0, i).some((l) => l.kind === 'ride');
      const words = !leg.tapOut ? ['Walk to', ' without tapping out'] : ridden ? ['Tap out, walk to', ''] : ['Walk to', ''];
      return `<div class="route-leg walk">${TM.icon('walk')} <span>${words[0]} <b>${TM.esc(stnName(leg.to))}</b>${words[1]}</span><span class="hint">${fmtMin(leg.time)}</span></div>`;
    }
    /* three rows: where you board (with the ride's time and cost), the stops passed on the way (a toggle), and where
       you get off — joined down the left by a rail in the line's colour */
    /* stations passed: those it stops at, and those a service runs through without stopping */
    const skipped = new Set(leg.skipped || []), stopsN = leg.via.filter((id) => !skipped.has(id)).length, passN = leg.via.length - stopsN;
    const count = leg.via.length, viaOpen = planUI.state.openVia.has(i);
    const toggleText = [stopsN ? `${stopsN} stop${stopsN === 1 ? '' : 's'} between` : '', passN ? `passes ${passN}` : ''].filter(Boolean).join(' · ');
    const toggle = count ? `<div class="rl-sub"><button class="btn sm ghost" data-viatoggle="${i}" style="height:22px;padding:0 8px;font-size:11px;gap:4px">${toggleText} ${TM.icon('chevron', '').replace('<svg', `<svg style="width:12px;height:12px;transform:rotate(${viaOpen ? 180 : 0}deg)"`)}</button></div>` : '';
    const via = viaOpen ? `<div class="rl-sub route-via">${leg.via.map((id) => `<div class="hint${skipped.has(id) ? ' passes' : ''}">${TM.esc(stnName(id))}${skipped.has(id) ? ' · passes without stopping' : ''}</div>`).join('')}</div>` : '';
    /* a train running through onto another line: "Stay on — becomes the Tōyoko Line at Shibuya" */
    const becomes = (leg.parts || []).map((part, index, parts) => {
      if (!index) return '';
      const lineA = store.rootLine(parts[index - 1].line), lineB = store.rootLine(part.line);
      return lineA && lineB && lineA !== lineB ? `<div class="rl-sub rl-look">Stay on — becomes ${codeChip(lineB)} <b>${TM.esc(TM.displayName(lineB))}</b> at <b>${TM.esc(stnName(part.board))}</b></div>` : '';
    }).filter(Boolean);
    const rows = 3 + becomes.length + (count ? 1 : 0) + (viaOpen ? 1 : 0);
    return waitLine(leg, i === 0 || !legs.slice(0, i).some((l) => l.kind === 'ride')) + `<div class="route-leg ride">${codeChip(leg.line)}<b class="rl-stn">${TM.esc(stnName(leg.board))}</b><span class="hint">${fmtMin(leg.time)}${leg.fare != null ? ` · ${TM.fares.fmt(leg.fare)}` : ''}</span>` +
      `<i class="rl-rail" style="background:${leg.line.color};grid-row:2 / span ${rows - 1}"></i><div class="rl-sub rl-look">${boarding(leg)}</div>${becomes.join('')}${toggle}${via}<div class="rl-sub"><b class="rl-stn">${TM.esc(stnName(leg.alight))}</b></div></div>`;
  }
  function card(result, i) {
    const open = planUI.state.open === i;
    const chips = result.legs.filter((l) => l.kind !== 'walk' && l.kind !== 'stay').flatMap((l) => (l.kind === 'ride' ? rideLines(l) : [l.line])).map(codeChip).join(' ');
    return `<div class="route-card ${open ? 'open' : ''}" data-idx="${i}">` +
      `<div class="route-card-head"><div><b>${fmtMin(result.time)}</b><span class="hint"> · ${result.transfers} transfer${result.transfers === 1 ? '' : 's'}${result.arriveAt ? ` · ${clockText(result.leaveAt)} → ${clockText(result.arriveAt)}` : ''}</span></div><div class="route-cost">${TM.fares.fmt(result.cost)}</div></div>` +
      `<div class="route-chips">${chips || (result.legs[0] && result.legs[0].kind === 'stay' ? '<span class="hint">Just do not enter the station paid area.</span>' : '')}</div>` +
      (open ? `<div class="route-detail">${result.legs.map((leg, li) => legLine(leg, li, result.legs)).join('')}</div>` : '') + '</div>';
  }
  /* each ranking can be read either way round — the search still looks for the best few, then lists them in this order */
  const DIR_LABELS = { time: ['Fastest first', 'Slowest first'], cost: ['Cheapest first', 'Most expensive first'], transfers: ['Fewest first', 'Most first'] };
  function renderRight() {
    const panel = $('right'), from = planUI.state.from, to = planUI.state.to, scrollTop = panel.scrollTop;
    let html = routeFieldsHtml() + `<div class="sec"><div class="sec-h"><h3>Ways to go</h3></div>`;
    if (!from || !to) html += `<div class="empty">${TM.icon('route').replace('<svg', '<svg style="width:28px;height:28px;opacity:.5"')}<p>Pick a departure station and a destination station to see ways to travel.</p><p class="hint">Tip: right-click any station on the map to set it as either.</p></div>`;
    else if (planUI.state.same && !planUI.state.results.length) html += `<p class="hint" style="margin-top:0">That is the same station${planUI.state.by === 'cost' ? ', with no in-out fare recorded' : ' — no line here allows entering and leaving without a ride'}.</p>`;
    else {
      html += `<div class="seg seg-stack" style="width:100%;margin-bottom:10px">` +
        [['time', 'clock', 'Time'], ['cost', 'ticket', 'Cost'], ['transfers', 'swap', 'Transfers']]
          .map(([v, ic, t]) => `<button data-by="${v}" class="${planUI.state.by === v ? 'on' : ''}">${TM.icon(ic)}<span>${t}</span></button>`).join('') + '</div>';
      /* which kind of ticket to price each network's rides with — one picker per network (operator) selling more than
         one type (fares.json "networks" / "types"); a ride is priced with its own line's network's pick */
      const nets = TM.fares.pickable();
      /* the same dropdown as the map picker (.dd / .dd-btn / .dd-pop), one per network */
      if (nets.length) html += `<div class="fare-types">${nets.map((network) => {
        const current = TM.fares.typeOf(network.id, TM.fares.selected(network.id)), open = fareOpen === network.id;
        return `<div class="fare-type"><span class="lbl">${TM.esc(nets.length > 1 || network.id ? network.name : 'Fare type')}</span>` +
          `<div class="dd fare-dd ${open ? 'open' : ''}"><button type="button" class="dd-btn" data-fare-dd="${TM.esc(network.id)}" aria-haspopup="listbox" aria-expanded="${open}" aria-label="Fare type for ${TM.esc(network.name)}: ${TM.esc(current.name)}">${TM.icon('ticket')}<span class="nm">${TM.esc(current.name)}</span>${TM.icon('chevron', 'chev')}</button>` +
          (open ? `<div class="dd-pop"><div class="dd-list" role="listbox">${network.types.map((t) => `<div class="dd-item ${t.id === current.id ? 'cur' : ''}" role="option" aria-selected="${t.id === current.id}" data-fare-net="${TM.esc(network.id)}" data-fare-type="${TM.esc(t.id)}"><span class="nm"><b>${TM.esc(t.name)}</b>${t.note ? `<span>${TM.esc(t.note)}</span>` : ''}</span>${t.id === current.id ? TM.icon('check') : ''}</div>`).join('')}</div></div>` : '') +
          `</div></div>`;
      }).join('')}</div>`;
      const [directionLabels, desc] = DIR_LABELS[planUI.state.by];
      html += `<div class="seg" style="width:100%;margin-bottom:10px"><button data-dir="asc" class="${planUI.state.dir === 'asc' ? 'on' : ''}" style="flex:1">${directionLabels}</button><button data-dir="desc" class="${planUI.state.dir === 'desc' ? 'on' : ''}" style="flex:1">${desc}</button></div>`;
      if (!planUI.state.results.length) html += planUI.state.by === 'cost' && !TM.fares.hasAny() ? `<p class="hint" style="margin-top:0">${TM.fares.pickable().length ? 'No fares for these fare types yet.' : 'This map has no fare data yet.'}</p>` : '<p class="hint" style="margin-top:0">No way found between these two stations.</p>';
      else html += planUI.state.results.map(card).join('');
    }
    html += '</div>';
    panel.innerHTML = html; panel.scrollTop = scrollTop;
    mountRouteFields();
  }
  const FARE_KEY = () => 'tm.fareType.' + TM.maps.current.id;
  let fareOpen = null;   // the network whose fare-type dropdown is open
  const closeFare = () => { if (fareOpen !== null) { fareOpen = null; renderRight(); } };
  document.addEventListener('pointerdown', (e) => { if (fareOpen !== null && !e.target.closest('.fare-dd')) closeFare(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFare(); });
  function wireRight() {
    const panel = $('right');
    panel.addEventListener('change', (e) => { if (e.target.id === 'whenAt' && e.target.value) { planUI.when = { mode: 'at', at: new Date(e.target.value).getTime() }; runSearch(); } });
    panel.addEventListener('click', (e) => {
      let button;
      if ((button = e.target.closest('[data-pick]'))) { setPicking(planUI.state.picking === button.dataset.pick ? null : button.dataset.pick); return; }
      if ((button = e.target.closest('[data-clr]'))) { planUI.state[button.dataset.clr] = null; runSearch(); return; }
      if ((button = e.target.closest('[data-when]'))) { planUI.when = { mode: button.dataset.when, at: button.dataset.when === 'at' ? planUI.when.at || Math.floor(Date.now() / 60000) * 60000 : null }; runSearch(); return; }
      if (e.target.closest('#navSwap')) { const target = planUI.state.from; planUI.state.from = planUI.state.to; planUI.state.to = target; runSearch(); return; }
    });
    panel.addEventListener('click', (e) => {
      let fareButton;
      if ((fareButton = e.target.closest('[data-fare-dd]'))) { fareOpen = fareOpen === fareButton.dataset.fareDd ? null : fareButton.dataset.fareDd; renderRight(); return; }
      if ((fareButton = e.target.closest('[data-fare-type]'))) {
        TM.fares.setType(fareButton.dataset.fareNet, fareButton.dataset.fareType);
        TM.storage.setJSON(FARE_KEY(), TM.fares.sel);
        fareOpen = null; runSearch(true);
        return;
      }
    });
    panel.addEventListener('click', (e) => {
      let button;
      if ((button = e.target.closest('[data-by]'))) { planUI.state.by = button.dataset.by; runSearch(); return; }
      if ((button = e.target.closest('[data-dir]'))) { planUI.state.dir = button.dataset.dir; runSearch(); return; }
      if ((button = e.target.closest('[data-viatoggle]'))) {
        const i = +button.dataset.viatoggle;
        if (planUI.state.openVia.has(i)) planUI.state.openVia.delete(i); else planUI.state.openVia.add(i);
        renderRight();
        return;
      }
      if ((button = e.target.closest('.route-card'))) {
        const i = +button.dataset.idx;
        planUI.state.open = planUI.state.open === i ? -1 : i;
        planUI.state.openVia = new Set();
        renderRight();
        TM.navCanvas.showRoute(planUI.state.open >= 0 ? planUI.state.results[planUI.state.open] : null);
        TM.navMap.showRoute(planUI.state.open >= 0 ? planUI.state.results[planUI.state.open] : null);
      }
    });
  }

  /* what a route is, whatever it costs: its legs */
  const routeSig = (r) => r.legs.map((l) => (l.kind === 'ride' ? `${l.line.id}${l.service ? '@' + l.service.id : ''}:${l.board}>${l.alight}` : `${l.kind}:${l.from}>${l.to}`)).join(' ');
  /* keep: only the fare types changed — the same routes come back re-priced (see TM.route's memo), so the card that
     was open stays open, with its stops list, instead of jumping back to the first one */
  function runSearch(keep) {
    const previous = keep && planUI.state.open >= 0 ? planUI.state.results[planUI.state.open] : null, wasVia = planUI.state.openVia;
    planUI.state.results = []; planUI.state.open = -1; planUI.state.same = false; planUI.state.openVia = new Set();
    if (planUI.state.from && planUI.state.to) {
      const found = TM.route.find(planUI.state.from, planUI.state.to, { by: planUI.state.by, dir: planUI.state.dir, flags: planUI.flags(), when: planUI.whenMs() });
      planUI.state.same = !!found.same;
      planUI.state.results = found.results;
      /* departure = destination: the plain answer first (last when listing the other way round) — no ride at all */
      if (found.same) {
        const stay = { time: 0, cost: 0, transfers: 0, legs: [{ kind: 'stay', from: planUI.state.from, to: planUI.state.to, time: 0 }] };
        if (planUI.state.dir === 'desc') planUI.state.results.push(stay); else planUI.state.results.unshift(stay);
      }
      if (planUI.state.results.length) {
        const i = previous ? planUI.state.results.findIndex((x) => routeSig(x) === routeSig(previous)) : -1;
        planUI.state.open = i >= 0 ? i : 0;
        if (i >= 0) planUI.state.openVia = wasVia;
      }
    }
    const shown = planUI.state.open >= 0 ? planUI.state.results[planUI.state.open] : null;
    TM.navCanvas.showRoute(shown); TM.navMap.showRoute(shown);
    renderRight();
  }

  /* ---------- top bar: map picker, mode, language, theme ---------- */
  function renderMapPicker() {
    const host = $('mapPicker'), maps = TM.maps;
    host.innerHTML = `<div class="dd"><button class="brand-btn" aria-haspopup="listbox" title="Switch map"></button><div class="dd-pop map-pop" hidden></div></div>`;
    const root = host.firstElementChild, button = root.querySelector('.brand-btn'), popup = root.querySelector('.map-pop');
    let open = false;
    const logo = (m) => { const logoSrc = maps.logoSrc(m); return logoSrc ? `<img class="logo" alt="" src="${TM.esc(logoSrc)}">` : `<span class="logo" style="display:grid;place-items:center;background:var(--accent-2);font-weight:800;color:var(--accent)">${TM.esc((maps.name(m) || '?')[0])}</span>`; };
    const label = () => { const currentMap = maps.current; button.innerHTML = `${logo(currentMap)}<span class="bt"><span class="t">${TM.esc(maps.name(currentMap))}</span><small>${TM.esc([currentMap.area, currentMap.country].filter(Boolean).join(', ') || 'Journey planner')}</small></span>${TM.icon('chevron', 'chev')}`; button.setAttribute('aria-label', `Map: ${maps.name(currentMap)}. Switch map`); };
    const build = () => {
      const groups = [['Published maps', maps.shipped], ['My maps', maps.user]].map(([t, l]) => [t, l.filter((m) => m.navigator)]).filter(([, l]) => l.length);   // only maps offered here (map.json "navigator")
      popup.innerHTML = `<div class="dd-list" role="listbox">${groups.map(([t, l]) => `<div class="dd-group">${t}</div>` + l.map((m) => `<div class="dd-item map-item ${m.id === maps.current.id ? 'cur' : ''}" data-id="${TM.esc(m.id)}">${logo(m)}<div class="nm"><b>${TM.esc(maps.name(m))}</b><span>${TM.esc([m.area, m.country].filter(Boolean).join(', ') || (maps.isUser(m) ? 'my map' : ''))}</span></div>${m.id === maps.current.id ? '<span class="pill ok">Open</span>' : ''}</div>`).join('')).join('')}</div>`;
    };
    const setOpen = (v) => { open = v; root.classList.toggle('open', v); popup.hidden = !v; if (v) build(); };
    button.onclick = () => setOpen(!open);
    popup.onclick = (e) => { const item = e.target.closest('[data-id]'); if (item) { setOpen(false); maps.switchTo(item.dataset.id); } };
    document.addEventListener('pointerdown', (e) => { if (open && !root.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') setOpen(false); });
    label();
  }

  let languageBar = null;
  function renderLang() {
    TM.ui.loadLanguages();
    if (!languageBar) languageBar = TM.ui.languageBar($('langSeg'), () => { renderLeft(); renderRight(); TM.emit('lang'); });
    else languageBar.refresh();
  }

  let legendOpen = false;
  function renderLegend() {
    const legend = $('legend');
    legend.hidden = TM.state.mode !== 'schematic';
    if (legend.hidden) return;
    /* the button stays the same element across redraws (a redraw between press and release would swallow the click) */
    if (!$('legBtn')) legend.innerHTML = `<button class="btn sm ghost" id="legBtn" style="width:100%;justify-content:space-between;gap:14px">Legend ${TM.icon('chevron', '')}</button><div id="legBody"></div>`;
    const chevron = $('legBtn').querySelector('svg');
    if (chevron) chevron.style.transform = `rotate(${legendOpen ? 0 : 180}deg)`;
    let html = '';
    if (legendOpen) {
      const legendSvg = TM.symbols.legend(TM.symbols.palette(document.documentElement.dataset.theme), [...store.lines.values()], TM.state.langs[0], store.legend);
      html = `<svg width="${legendSvg.w}" height="${legendSvg.h}" viewBox="0 0 ${legendSvg.w} ${legendSvg.h}">${legendSvg.svg}</svg>`;
    }
    $('legBody').innerHTML = html;
    legend.classList.toggle('open', legendOpen);
  }

  function initChrome() {
    TM.topbar.init(() => TM.navMap.map);
    $('editLink').innerHTML = TM.icon('mapedit');
    if (TM.maps.current) $('editLink').href = 'index.html?map=' + encodeURIComponent(TM.maps.current.id);
    document.querySelectorAll('#modeSeg button').forEach((button) => button.onclick = () => {
      TM.state.mode = button.dataset.mode;
      document.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('on', x === button));
      $('schematic').hidden = TM.state.mode !== 'schematic'; $('mapview').hidden = TM.state.mode !== 'map';
      $('legend').hidden = TM.state.mode !== 'schematic';
      if (TM.state.mode === 'map') TM.navMap.show(); else { TM.navCanvas.render(); TM.navCanvas.applyView(); }
      renderLegend();
    });
    $('legend').onclick = (e) => { if (e.target.closest('#legBtn') && TM.legendToggleOk()) { legendOpen = !legendOpen; renderLegend(); if (legendOpen) $('legend').scrollTop = 0; } };
  }

  async function start() {
    try {
      await TM.maps.init();
      if (!TM.maps.useNavigable()) {
        document.getElementById('stage').innerHTML = `<div class="empty" style="padding:60px 24px"><h2>No map to plan on yet</h2><p>No map is set to show in the journey planner. Set <code>"navigator": true</code> in a map's <code>map.json</code>, or tick <b>Show in the journey planner</b> in its Map details in the <a href="index.html">map editor</a>.</p></div>`;
        return;
      }
      await TM.store.load();
      await TM.fares.load(TM.maps.current);
      /* the fare type last picked for each network on this map */
      const fareSel = TM.storage.getJSON(FARE_KEY());
      if (fareSel && typeof fareSel === 'object') Object.entries(fareSel).forEach(([n, t]) => TM.fares.setType(n, t));
      /* and which services this viewer switched on or off */
      const services = TM.storage.getJSON('tm.navServices.' + TM.maps.current.id);
      if (services && typeof services === 'object') planUI.disp.services = services;
    } catch (e) {
      document.getElementById('stage').innerHTML = `<div class="empty" style="padding:60px 24px"><h2>Could not load the map</h2><p>${TM.esc(e.message)}</p><p>This is a static front-end project: serve the folder over HTTP, e.g. <code>python3 -m http.server 8000</code>, then open <code>http://localhost:8000/navigator.html</code>.</p></div>`;
      return;
    }
    await TM.loadImages();
    initChrome();
    renderMapPicker();
    renderLang();
    renderLeft(); wireLeft();
    renderRight(); wireRight();
    TM.navCanvas.init();
    requestAnimationFrame(() => TM.navCanvas.fit());   // the stage's own layout can still settle a frame after init()
    renderLegend();
    TM.on('nav-display', () => renderRight());
    TM.on('theme', renderLegend); TM.on('lang', renderLegend);
    document.title = `Journey Planner — ${TM.nameOf(TM.maps.current, 'en')}`;
    TM.toast(`${TM.nameOf(TM.maps.current, 'en')}: ${store.stations.size} stations · ${store.lines.size} lines`);
    TM.emit('nav-ready');   // only the local dev server's injected fare editor listens for this
  }
  window.addEventListener('DOMContentLoaded', start);
})(window.TM);
