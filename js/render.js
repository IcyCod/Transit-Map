/* Renders the schematic transit map (lines, stations, labels) to SVG strings. */
(function (TM) {
  const renderer = (TM.render = {});
  const CORNER_R = 26;
  let LANE = 9, LINE_W = 8, CASE_W = 13;   // set from opts.lineWidth at the start of every build (lanes sit one line width + 1 apart)
  const CAND = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: -135, n: -90, ne: -45 };
  const TIE = [['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'], ['e', 'ne', 'n', 'nw', 'w', 'sw', 's', 'se']];
  const OPP = { e: 'w', w: 'e', n: 's', s: 'n', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw' };
  const NOT_SOLID = new Set(['under_construction', 'provisional', 'planned']);

  const angDist = (a, b) => { let difference = Math.abs(a - b) % 360; return difference > 180 ? 360 - difference : difference; };

  function autoLabelPos(dirs, order) {
    if (!dirs.length) return 'e';
    let best = null, bestScore = -1;
    TIE[order & 1].forEach((candidate) => {
      const score = Math.min(...dirs.map((d) => angDist(CAND[candidate], d)));
      if (score > bestScore + 0.01) { best = candidate; bestScore = score; }
    });
    return best;
  }

  function labelRows(station, langs, showCodes, size, codeText) {
    const names = [];
    langs.forEach((lg) => { const name = (station.names[lg] || '').trim(); if (name && !names.includes(name)) names.push(name); });
    if (!names.length) names.push(TM.nameOf(station, 'en') || station.id);
    const rows = names.map((t, i) => ({ text: t, fs: i === 0 ? size : Math.round(size * 0.85 * 10) / 10, bold: i === 0, muted: i > 0 }));
    if (showCodes && codeText) rows.push({ text: codeText, fs: Math.max(7, Math.round(size * 0.73 * 10) / 10), muted: true });
    return rows;
  }

  /* Lane layout. Lines that share a track run side by side; this decides each line's offset on every grid edge.
     - Along a straight chain of edges the busiest edge is centred (lines in list order). Moving away from it, every line that
       carries on keeps its lane — so when lines combine or separate the track stays straight and only a line that turns moves
       back towards the centre, at the turn. A line that joins takes the free lane nearest its own.
     - Lines that turn together keep their order relative to their direction of travel: the line on the inside of the bend
       stays on the inside and the one on the outside stays outside (chains are laid out from the busiest one, and a
       neighbouring chain copies that order through the bend). */
  function layoutLanes(models) {
    const geo = TM.geo, edges = new Map();
    models.forEach((model) => {
      for (let k = 0; k < model.seq.length - 1; k++) {
        const nodeA = model.seq[k], nodeB = model.seq[k + 1], key = geo.edgeKey(nodeA, nodeB);
        let e = edges.get(key);
        if (!e) {
          const swap = nodeA.x > nodeB.x || (nodeA.x === nodeB.x && nodeA.y > nodeB.y), start = swap ? nodeB : nodeA, end = swap ? nodeA : nodeB;
          e = { key, p: start, q: end, d: { x: end.x - start.x, y: end.y - start.y }, users: [], lane: new Map(), turns: [], chain: null };
          edges.set(key, e);
        }
        if (!e.users.includes(model.line.id)) e.users.push(model.line.id);
      }
    });
    /* turns: a line going from one edge onto a differently pointing one. sign = +1 when both edges are travelled the same
       way round as their stored direction (or both against it), -1 when only one is */
    models.forEach((model) => {
      for (let k = 0; k + 2 < model.seq.length; k++) {
        const nodeA = model.seq[k], nodeB = model.seq[k + 1], nodeC = model.seq[k + 2];
        if (Math.sign(nodeB.x - nodeA.x) === Math.sign(nodeC.x - nodeB.x) && Math.sign(nodeB.y - nodeA.y) === Math.sign(nodeC.y - nodeB.y)) continue;
        const edgeIn = edges.get(geo.edgeKey(nodeA, nodeB)), edgeOut = edges.get(geo.edgeKey(nodeB, nodeC));
        if (edgeIn === edgeOut) continue;
        const signIn = nodeA.x === edgeIn.p.x && nodeA.y === edgeIn.p.y ? 1 : -1, signOut = nodeB.x === edgeOut.p.x && nodeB.y === edgeOut.p.y ? 1 : -1;
        edgeIn.turns.push({ line: model.line.id, other: edgeOut, sign: signIn * signOut });
        edgeOut.turns.push({ line: model.line.id, other: edgeIn, sign: signIn * signOut });
      }
    });
    const next = (e) => edges.get(geo.edgeKey(e.q, { x: e.q.x + e.d.x, y: e.q.y + e.d.y }));
    const prev = (e) => edges.get(geo.edgeKey({ x: e.p.x - e.d.x, y: e.p.y - e.d.y }, e.p));
    const chains = [];
    edges.forEach((edge) => {
      if (edge.chain) return;
      let first = edge;
      for (let guard = 0; prev(first) && guard < 10000; guard++) first = prev(first);
      const edgesOf = [];
      for (let e = first; e && !e.chain; e = next(e)) { edgesOf.push(e); }
      const chain = { edges: edgesOf, done: false, at: 0 };
      edgesOf.forEach((e, i) => { e.chain = chain; if (e.users.length > edgesOf[chain.at].users.length) chain.at = i; });
      chains.push(chain);
    });

    const natural = (order, id) => (order.indexOf(id) - (order.length - 1) / 2) * LANE;
    const carryOn = (e, from) => {
      const taken = [];
      e.users.forEach((id) => { if (from.lane.has(id)) { e.lane.set(id, from.lane.get(id)); taken.push(from.lane.get(id)); } });
      e.users.forEach((id) => {
        if (e.lane.has(id)) return;
        const want = natural(e.users, id);
        let best = want;
        if (taken.some((t) => Math.abs(t - want) < LANE - 0.01)) {
          best = taken.flatMap((t) => [t - LANE, t + LANE]).filter((c) => taken.every((t) => Math.abs(t - c) >= LANE - 0.01))
            .sort((x, y) => Math.abs(x - want) - Math.abs(y - want) || y - x)[0];
        }
        e.lane.set(id, best); taken.push(best);
      });
    };
    const layout = (chain) => {
      const anchor = chain.edges[chain.at];
      let order = anchor.users.slice();
      /* lines that arrive from an already laid-out chain through a bend keep their order (left / right of travel) */
      const want = new Map();
      [chain.edges[0], chain.edges[chain.edges.length - 1]].concat(chain.edges.slice(1, -1)).forEach((end) => end.turns.forEach((turn) => {
        if (turn.other.chain !== chain && turn.other.chain.done && order.includes(turn.line) && !want.has(turn.line) && turn.other.lane.has(turn.line)) want.set(turn.line, turn.sign * turn.other.lane.get(turn.line));
      }));
      if (want.size > 1) {
        const slots = order.map((id, i) => (want.has(id) ? i : -1)).filter((i) => i >= 0);
        const sorted = [...want.keys()].sort((x, y) => want.get(x) - want.get(y));
        slots.forEach((slot, i) => { order[slot] = sorted[i]; });
      }
      anchor.users.forEach((id) => anchor.lane.set(id, natural(order, id)));
      for (let i = chain.at + 1; i < chain.edges.length; i++) carryOn(chain.edges[i], chain.edges[i - 1]);
      for (let i = chain.at - 1; i >= 0; i--) carryOn(chain.edges[i], chain.edges[i + 1]);
      chain.done = true;
    };
    /* busiest chain first; then always a chain that touches one already done (so it can copy the order through the bend) */
    const size = (ch) => ch.edges[ch.at].users.length;
    for (let left = chains.length; left > 0; left--) {
      let pick = null, pickTouch = false;
      chains.forEach((chain) => {
        if (chain.done) return;
        const touch = chain.edges.some((e) => e.turns.some((t) => t.other.chain !== chain && t.other.chain.done));
        if (!pick || (touch && !pickTouch) || (touch === pickTouch && size(chain) > size(pick))) { pick = chain; pickTouch = touch; }
      });
      layout(pick);
    }
    const out = new Map();
    edges.forEach((e, key) => out.set(key, e.lane));
    return out;
  }

  /* Linked discs of lines that cross at one point (no lane apart, e.g. two lines crossing at right angles). Spreading them
     along an axis leaves a long neck between discs that should touch; instead each disc goes on its OWN line, just off
     the crossing, on the side that keeps it next to the others (for two lines at 90° the discs sit on the two arms of one
     corner), and just far out that neighbouring discs meet — so the neck is only as long as the discs are wide.
     Returns [{x,y}] per item, or null when that cannot work (two of the lines run the same way through the point). */
  const chainTouch = (items, showNum) => (showNum && items.some((it) => it.num) ? 10 : 6.1) * 2 * 0.95;   // centre distance of two touching rings
  function chainAtCrossing(items, showNum) {
    if (items.some((it) => !it.dir)) return null;
    const unit = [];
    items.forEach((entry, i) => {
      if (!i) { unit.push({ x: entry.dir.x, y: entry.dir.y }); return; }
      const cand = [{ x: entry.dir.x, y: entry.dir.y }, { x: -entry.dir.x, y: -entry.dir.y }];
      const cost = (c) => unit.reduce((s2, u) => s2 + Math.hypot(c.x - u.x, c.y - u.y), 0);
      unit.push(cost(cand[1]) < cost(cand[0]) - 1e-9 ? cand[1] : cand[0]);
    });
    let dmin = Infinity;
    unit.forEach((a, i) => unit.forEach((b, j) => { if (j > i) dmin = Math.min(dmin, Math.hypot(a.x - b.x, a.y - b.y)); }));
    if (!(dmin > 0.2)) return null;
    const ratio = chainTouch(items, showNum) / dmin;
    return unit.map((u) => ({ x: u.x * ratio, y: u.y * ratio }));
  }

  /* The drawing's shared inputs: options, each drawn line's node sequence and geometry (lanes laid out), numbering
     helpers and every path item by interchange group — plus the bounding box every later step grows. */
  function prepare(opts) {
    const store = TM.store, geo = TM.geo, symbols = TM.symbols, GRID = TM.GRID;
    LINE_W = Math.min(24, Math.max(2, +opts.lineWidth || 8)); CASE_W = LINE_W + 5; LANE = LINE_W + 1;
    const symK = Math.min(3, Math.max(0.3, +opts.symbolScale || 1));            // relative size of station symbols (blocks keep their own size)
    const linkK = Math.min(3, Math.max(0.2, (+opts.connWidth || 7) / 7));       // thickness of links between stations, relative to the default
    const palette = symbols.palette(opts.theme);
    /* Lines are always taken in list order, so lane order, symbol ties and code order do not depend on toggling. */
    const order = new Map([...store.lines.keys()].map((id, i) => [id, i]));
    /* a branch (store.branchesOf) is drawn as a track line of its own, ranked right after its line */
    store.lines.forEach((l, id) => store.branchesOf(l).forEach((b, j) => order.set(b.id, order.get(id) + (j + 1) / 100)));
    /* a line is drawn with its suggested stops in when it shows them (store.effectiveLine): they behave like any other stop —
       numbering, interchange, lanes — just dashed and marked; when hidden the line is exactly as if none were suggested */
    const HIDEABLE = Object.assign(Object.fromEntries(TM.STATUS_TOGGLES.map((t) => [t.status, t.opt])), { fantasy: 'showFantasy' });
    const hiddenStatus = (t) => !!t && !!HIDEABLE[t.status] && !opts[HIDEABLE[t.status]];
    /* "Hide line ends past hidden stations": a line (not a loop) whose first / last stops are all hidden by their Display
       toggle stops at its outermost stop still shown, instead of running on to nothing. A branch keeps its junction. */
    const trimHiddenEnds = (line) => {
      if (line.loop) return line;
      const shown = (it) => it.s && store.stations.has(it.s) && !hiddenStatus(store.stations.get(it.s));
      let first = line.rootId ? 0 : line.path.findIndex(shown), last = line.path.length - 1;
      while (last >= 0 && !shown(line.path[last])) last--;
      if (first < 0 || last <= first) return Object.assign({}, line, { path: [], origIdx: [] });
      if (first === 0 && last === line.path.length - 1) return line;
      const orig = line.origIdx || line.path.map((_, i) => i);
      return Object.assign({}, line, { path: line.path.slice(first, last + 1), origIdx: orig.slice(first, last + 1) });
    };
    const lines = store.trackLines(opts.lineIds.filter((id) => store.lines.has(id))).sort((a, b) => order.get(a.id) - order.get(b.id))
      .map((l) => store.effectiveLine(l, opts.showSuggested)).map((l) => (opts.trimHidden ? trimHiddenEnds(l) : l));
    const recolored = new Map(), rc = (l) => TM.recolor(l, recolored);   // Display → Colour by line type
    /* root: the line itself — a branch and its line are one line at a station they share (its junction), not an interchange */
    const models = lines.map((l) => ({ line: rc(l), root: rc(store.rootLine(l) || l), seq: geo.nodeSeq(l), rank: order.get(l.id) }));
    /* Statuses the Display section can hide (a station in one of them is then left off the map, as if not there). */
    /* A station's 1-based position among the REAL, shown stations of one line's own sequence — 'ordinal' number mode.
       A station hidden by its Display toggle is not counted, so the numbers run on without a gap. */
    const ordinalOf = (seq, k) => { let count = 0; for (let i = 0; i <= k; i++) if (seq[i].s && !hiddenStatus(store.stations.get(seq[i].s))) count++; return count; };
    const numberFor = (station, sequence, index) => {
      const own = opts.numModeOverride && store.numMode[store.rep(station.id)];
      const mode = (own && own !== 'none') ? own : (opts.numberMode !== 'none' ? opts.numberMode : 'code');
      return symbols.numberFor(station, mode, ordinalOf(sequence, index));
    };
    /* Whether a number is shown at all: a station's own override (Inspector, when the left panel's "Allow a station
       to override" is on) always wins; otherwise an explicit per-line Show/Hide (numFlags) wins; otherwise the
       map-wide "Inside symbol shows" setting (off when it is 'none'). */
    const numShow = (id, flags) => {
      const own = opts.numModeOverride && store.numMode[store.rep(id)];
      if (own === 'none') return false;
      if (own) return true;
      return flags.includes(true) ? true : flags.includes(false) ? false : opts.numberMode !== 'none';
    };

    const lanes = layoutLanes(models);
    models.forEach((model) => {
      const laneVec = (start, end) => {
        const normal = geo.edgeNormal(start, end), off = lanes.get(geo.edgeKey(start, end)).get(model.line.id);
        return { x: normal.x * off, y: normal.y * off };
      };
      model.geo = model.seq.length > 1 ? geo.build(model.seq, laneVec, CORNER_R) : { runs: [], pos: model.seq.map((q) => ({ x: q.x * GRID, y: q.y * GRID })), seq: model.seq };
    });

    /* every path item of every line, by interchange group (symbols are a property of the whole station) */
    const itemsByRep = new Map();
    store.trackLines().forEach((line) => line.path.forEach((item) => {
      if (!item.s || !store.stations.has(item.s)) return;
      const leadId = store.rep(item.s);
      (itemsByRep.get(leadId) || itemsByRep.set(leadId, []).get(leadId)).push({ item: item, rank: order.get(line.id) });
    }));
    const bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = (x, y, pad) => {
      bbox.x0 = Math.min(bbox.x0, x - (pad || 0)); bbox.y0 = Math.min(bbox.y0, y - (pad || 0));
      bbox.x1 = Math.max(bbox.x1, x + (pad || 0)); bbox.y1 = Math.max(bbox.y1, y + (pad || 0));
    };
    return { opts, store, geo, symbols, GRID, symK, linkK, palette, order, lines, models, hiddenStatus, numberFor, numShow, itemsByRep, bbox, grow };
  }

  /* Per station group (keyed by its lead id): where the lines run through it, its line entries, terminus, label settings… */
  function collectStations(scene) {
    const { store, lines, models, numberFor } = scene;
    const info = new Map();
    models.forEach((model) => {
      let stopOrder = 0;
      model.seq.forEach((node, index) => {
        if (!node.s) return;
        const station = store.stations.get(node.s);
        if (!station) return;
        const item = model.line.path[node.i], leadId = store.rep(node.s);
        const stationInfo = info.get(leadId) || info.set(leadId, { st: store.stations.get(leadId), px: 0, py: 0, n: 0, lines: [], dirs: [], term: null, label: null, hide: false, ord: stopOrder, lp: [], links: [], numFlags: [], icons: null, size: null, codes: [] }).get(leadId);
        const point = model.geo.pos[index];
        if (!stationInfo.codes.includes(node.s)) stationInfo.codes.push(node.s);
        stationInfo.px += point.x; stationInfo.py += point.y; stationInfo.n++;
        if (!stationInfo.lines.includes(model.root)) stationInfo.lines.push(model.root);
        [model.seq[index - 1], model.seq[index + 1]].forEach((neighbour) => {
          if (neighbour) stationInfo.dirs.push(Math.atan2(neighbour.y - node.y, neighbour.x - node.x) * 180 / Math.PI);
        });
        const last = model.seq.length - 1;
        /* a branch's first stop is its junction, never a terminus */
        if (!model.line.loop && (index === last || (index === 0 && !model.line.rootId))) { stationInfo.term = stationInfo.term || (index === 0 ? model.geo.startDir : model.geo.endDir); stationInfo.termLine = stationInfo.termLine || model.root; }
        if (!stationInfo.lp.some((q) => q.line === model.root)) {
          const prevNode = model.seq[index - 1] || node, nextNode = model.seq[index + 1] || node, length = Math.hypot(nextNode.x - prevNode.x, nextNode.y - prevNode.y);   // which way this line runs through the station
          stationInfo.lp.push({ line: model.root, num: numberFor(station, model.seq, index), p: point, rank: model.rank, dir: length ? { x: (nextNode.x - prevNode.x) / length, y: (nextNode.y - prevNode.y) / length } : null });
        }
        if (item && typeof item.num === 'boolean') stationInfo.numFlags.push(item.num);
        if (item && item.links) item.links.forEach((to) => stationInfo.links.push({ to: store.rep(to), kind: item.symbol === 'connect' ? 'connect' : 'link' }));  // legacy per-item links
        if (item && item.label && item.label.icons && !stationInfo.icons) stationInfo.icons = item.label.icons;
        if (item && item.label && item.label.size && !stationInfo.size) stationInfo.size = item.label.size;
        if (item && item.label && !stationInfo.label) stationInfo.label = item.label;
        if (item && item.label && item.label.hide) stationInfo.hide = true;
        if (item && item.sug) stationInfo.sug = true;                                          // a suggested stop of this line is drawn here
        stationInfo.items = (stationInfo.items || []).concat([{ lineId: model.line.id, index: node.i }]);
        stopOrder++;
      });
    });
    return info;
  }

  /* Which lines and stations stay lit (the rest dims), and the suggestion clusters by station. */
  function activeState(scene) {
    const { opts, store, models } = scene;
    const activeLine = opts.activeLineId && store.line(opts.activeLineId);
    /* dimming: opts.activeLineId (index.html — the one line being edited) or opts.activeLineIds (navigator — every
       line a shown route rides), either way everything else fades. opts.activeExtra adds specific stations that
       count as "on the route" even off those lines — a journey planner's walk-leg endpoints, say — so a connector
       between two dimmed stations still dims (dim(ra) && dim(rb), below), but never one the route actually uses.
       opts.activeSegs (navigator: Map lineId → Set of path segment indices k, path[k] → path[k + 1]) narrows an active
       line down to just the stretch ridden — the rest of it dims like any other line, and only activeExtra's stations
       stay lit. */
    const actLines = new Set(opts.activeLineIds ? [...opts.activeLineIds] : (activeLine ? [activeLine.id] : []));
    const hasActive = actLines.size > 0;
    const activeSet = new Set(opts.activeExtra || []);
    if (!opts.activeSegs) actLines.forEach((lineId) => {
      const model = models.find((mm) => mm.line.id === lineId), line = model ? model.line : store.line(lineId);
      if (line) line.path.forEach((it) => { if (it.s) activeSet.add(store.rep(it.s)); });
    });
    const isDimmed = (id) => hasActive && opts.dimOthers !== false && !activeSet.has(id);
    const clusters = opts.hotspots ? store.clusters() : [];
    const clusterOf = new Map();
    clusters.forEach((c) => c.members.forEach((m) => clusterOf.set(m.id, c)));
    return { activeLine, actLines, hasActive, activeSet, isDimmed, clusterOf };
  }

  /* The lines themselves: casing + paint per run, dimmed where off the active route, with hit targets for restyling. */
  function drawLines(scene) {
    const { opts, store, GRID, palette, models, hiddenStatus, grow, activeLine, actLines, hasActive, symbols } = scene;
    let svg = '', markSvg = '';
    /* A station hidden by the Display toggle (hiddenStatus) is skipped when deciding a segment's default
       style, exactly as if it weren't on the line at all — the style then follows the next real, visible station. */
    const stAt = (path, i, direction) => {
      for (let j = i; j >= 0 && j < path.length; j += direction) {
        const station = path[j].s && store.stations.get(path[j].s);
        if (station && !hiddenStatus(station)) return station;
      }
      return null;
    };
    models.forEach((model) => {
      const isAct = !!activeLine && model.line.id === activeLine.id, dimmed = hasActive && opts.dimOthers !== false && !actLines.has(model.line.id);
      const segs = !dimmed && opts.activeSegs ? opts.activeSegs.get(model.line.id) || new Set() : null;
      /* a run starts at path item r.i0; with suggested stops shown, that is mapped back to the line's own item first */
      const ownIdx = (i) => { const origIndex = model.line.origIdx; if (!origIndex) return i; while (i > 0 && origIndex[i] < 0) i--; return origIndex[i]; };
      let casing = '', paint = '', hit = '', dimCasing = '', dimPaint = '';
      /* tunnels and elevated stretches between the line's point markers (TM.MARKS) */
      const structure = TM.structureLegs(model.line.path.map((it) => it.mk || null)), rails = symbols.railWidth(LINE_W);
      model.geo.runs.forEach((run) => {
        const off = segs && !segs.has(ownIdx(run.i0));
        const path = model.line.path, legStruct = structure[run.i0];
        const segmentStyle = (path[run.i0] && path[run.i0].seg) || (legStruct === 'tunnel' ? 'hatch' : undefined);   // a tunnel is striped unless styled otherwise
        const ends = [stAt(path, run.i0, -1), stAt(path, run.i1, 1)].filter(Boolean);
        const gone = ends.length && ends.every((t) => t.status === 'abandoned' || t.status === 'demolished');
        const auto = ends.some((t) => NOT_SOLID.has(t.status));
        /* hatched: short, wide-set blocks across the line (butt ends), like a line drawn in ticks */
        const dash = segmentStyle === 'dash' ? ' stroke-dasharray="14 8"' : segmentStyle === 'dashdot' ? ' stroke-dasharray="14 6 2 6"' : segmentStyle === 'hatch' ? ` stroke-dasharray="${Math.round(LINE_W * 0.45 * 10) / 10} ${Math.round(LINE_W * 0.4 * 10) / 10}" stroke-linecap="butt"` : segmentStyle === 'solid' ? '' : gone ? ' stroke-dasharray="1 7" stroke-linecap="round"' : auto ? ' stroke-dasharray="14 8"' : '';
        const casingPath = (legStruct === 'elevated' ? `<path d="${run.d}" stroke="${palette.muted}" stroke-width="${rails.outer}" stroke-linecap="butt"/><path d="${run.d}" stroke="${palette.paper}" stroke-width="${rails.inner}" stroke-linecap="butt"/>` : '') + `<path d="${run.d}" stroke="${palette.paper}" stroke-width="${CASE_W}"/>`;
        const paintPath = `<path d="${run.d}" stroke="${model.line.color}" stroke-width="${LINE_W}"${dash}${gone && !segmentStyle ? ' opacity=".6"' : ''} data-line="${TM.esc(model.line.id)}"/>`;
        if (off) { dimCasing += casingPath; dimPaint += paintPath; } else { casing += casingPath; paint += paintPath; }
        /* only a stretch between two of the line's own items can be restyled (suggested stops have no style of their own) */
        const origIndex = model.line.origIdx, own = !origIndex || (origIndex[run.i0] >= 0 && origIndex[run.i1] === origIndex[run.i0] + 1);
        if (opts.interactive && isAct && own) hit += `<path d="${run.d}" stroke="transparent" stroke-width="20" data-seg="${origIndex ? origIndex[run.i0] : run.i0}" data-line="${TM.esc(model.line.id)}"/>`;
      });
      /* point markers at the line's own bends / stops, turned to the way the line runs there */
      let marksOver = '';
      model.seq.forEach((node, k) => {
        const item = node.i >= 0 && model.line.path[node.i], mk = item && item.mk;
        if (!mk || !model.geo.pos[k]) return;
        const p = model.geo.pos[k], a = model.geo.pos[k - 1] || p, b = model.geo.pos[k + 1] || p;
        const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, glyph = symbols.mark(mk, LINE_W, palette);
        const at = `transform="translate(${TM.round2dp(p.x)} ${TM.round2dp(p.y)}) rotate(${TM.round2dp(angle)})"`;
        if (glyph.under) casing += `<g ${at}>${glyph.under}</g>`;
        marksOver += `<g ${at}>${glyph.over}</g>`;
      });
      if (dimCasing) svg += `<g fill="none" stroke-linejoin="round" opacity="0.22" class="line" data-line="${TM.esc(model.line.id)}">${dimCasing}${dimPaint}</g>`;
      svg += `<g fill="none" stroke-linejoin="round" opacity="${dimmed ? 0.22 : 1}" class="line" data-line="${TM.esc(model.line.id)}">${casing}${paint}${hit}</g>`;
      if (marksOver) markSvg += `<g opacity="${dimmed ? 0.22 : 1}" pointer-events="none">${marksOver}</g>`;
      model.seq.forEach((n) => grow(n.x * GRID, n.y * GRID, 24));
    });
    return svg + markSvg;   // markers on top of every line
  }

  /* Interchange partners on one node: one shared symbol (and one label when they also share a name). */
  function shareSymbols(scene) {
    const { store, order, lines, itemsByRep, info, positions } = scene;
    const splitReps = new Set();
    store.splitLinks().forEach((c) => { splitReps.add(store.rep(c.a)); splitReps.add(store.rep(c.b)); });

    /* Interchange partners with different names that sit on the same node share ONE symbol; each keeps its own name label. */
    const parent = new Map([...info.keys()].map((k) => [k, k]));
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    const nodeKey = (r) => { const node = store.nodeOf(r); return node ? node.x + ',' + node.y : ''; };
    store.splitLinks().forEach((connection) => {
      const leadA = store.rep(connection.a), leadB = store.rep(connection.b);
      if (leadA !== leadB && info.has(leadA) && info.has(leadB) && nodeKey(leadA) && nodeKey(leadA) === nodeKey(leadB)) parent.set(find(leadA), find(leadB));
    });
    const stOrder = new Map([...store.stations.keys()].map((k, i) => [k, i]));
    const shares = new Map();
    info.forEach((I, id) => { const root = find(id); (shares.get(root) || shares.set(root, []).get(root)).push(id); });
    shares.forEach((ids) => {
      if (ids.length < 2) return;
      ids.sort((a, b) => stOrder.get(a) - stOrder.get(b));
      const shared = { reps: ids, leader: ids[0], lp: [], lines: [], dirs: [], numFlags: [], term: null, termLine: null, pick: [], px: 0, py: 0, n: 0 };
      ids.forEach((leadId) => {
        const stationInfo = info.get(leadId);
        stationInfo.lp.forEach((q) => { if (!shared.lp.some((z) => z.line === q.line)) shared.lp.push(q); });
        stationInfo.lines.forEach((l) => { if (!shared.lines.includes(l)) shared.lines.push(l); });
        shared.dirs.push(...stationInfo.dirs); shared.numFlags.push(...stationInfo.numFlags);
        shared.term = shared.term || stationInfo.term; shared.termLine = shared.termLine || stationInfo.termLine;
        shared.pick.push(...(itemsByRep.get(leadId) || []));
        shared.px += stationInfo.px; shared.py += stationInfo.py; shared.n += stationInfo.n;
      });
      shared.lp.sort((a, b) => a.rank - b.rank); shared.lines.sort((a, b) => order.get(a.id) - order.get(b.id));
      const centre = { x: shared.px / shared.n, y: shared.py / shared.n }, L0 = info.get(ids[0]);
      ids.forEach((k) => { info.get(k).share = shared; positions.set(k, centre); });
      shared.leaderPos = (L0.label && L0.label.pos) || autoLabelPos(shared.dirs, L0.ord);
    });

    /* Interchange partners that share a node AND a name are the same physical station under two records (e.g. two
       "interchange"-type links kept apart on purpose) — one label is enough. The first (by station order) draws it;
       the rest are skipped, and their own code lists are folded into the one label's code line. */
    const labelSkip = new Set(), mergedCodes = new Map();
    shares.forEach((ids) => {
      if (ids.length < 2) return;
      const clusters = [];
      ids.forEach((id) => {
        const cluster = clusters.find((c) => store.sameName(c[0], id));
        if (cluster) cluster.push(id); else clusters.push([id]);
      });
      clusters.forEach((cluster) => {
        if (cluster.length < 2 || cluster.some((id) => store.stations.get(id).block)) return;
        cluster.sort((a, b) => stOrder.get(a) - stOrder.get(b));
        const [leader, ...rest] = cluster;
        rest.forEach((id) => labelSkip.add(id));
        const allCodes = [];
        cluster.forEach((id) => {
          const memberInfo = info.get(id), own = memberInfo.codes.concat(store.members(id).filter((c2) => !memberInfo.codes.includes(c2)));
          own.forEach((c2) => { if (!allCodes.includes(c2)) allCodes.push(c2); });
        });
        mergedCodes.set(leader, allCodes);
      });
    });
    return { splitReps, labelSkip, mergedCodes };
  }

  /* Blocks: an interchange complex (or a connecting station merged in) drawn together as one shape. */
  function blockIndex(scene) {
    const { store, info } = scene;
    const blockReps = new Map();   // rep id -> block config
    info.forEach((I, rep) => { const station = store.stations.get(rep); if (station && station.block) blockReps.set(rep, station.block); });
    const absorbedReps = new Map();   // rep id of a merged connecting station -> the block's owner rep id
    blockReps.forEach((block, owner) => (block.merged || []).forEach((memberId) => {
      if (!store.stations.has(memberId)) return;
      const leadId = store.rep(memberId);
      if (leadId !== owner) absorbedReps.set(leadId, owner);
    }));
    /* Every rep that is part of a block (its own interchange complex, or merged in) maps to the block's owner — so a
       connecting station linking to any of them is really linking to the block, and is drawn as one line to its centre. */
    const blockOfMember = new Map();
    blockReps.forEach((block, owner) => {
      store.complexMembers(owner).forEach((mid) => blockOfMember.set(store.rep(mid), owner));
      (block.merged || []).forEach((mid) => { if (store.stations.has(mid)) blockOfMember.set(store.rep(mid), owner); });
    });
    return { absorbedReps, blockOfMember };
  }

  /* A member's own small symbol, exactly as it would be drawn outside a block (station / terminal / interchange / capsule /
     stack / chain — whichever the lines calling at that one raw id pick), for symbols.block to place on the ring. */
  /* ringP/cx/cy/ringAxis (only passed from inside a block): the ring position this one station sits at and the
     block's own tangent-axis function, so a single station showing its OWN several lines as a capsule/stack/chain
     (not a bundle of several stations) still turns to face the block's centre as it is dragged, exactly like a
     bundled slot does — and its dots still order themselves by which real line is nearest on that side. */
  function memberSymbol(scene, memberId, overrideKind, overrideNum, ringP, cx, cy, ringAxis) {
    const { store, symbols, palette, order, lines, models, numberFor, numShow } = scene;
    const aggregate = { lines: [], term: null, termLine: null, numFlags: [], lp: [] }, dirs = [], pickItems = [];
    const lineVec = new Map();   // line id -> {sx,sy,n}: summed direction from the block's centre to where that line runs
    models.forEach((model) => model.seq.forEach((node, index) => {
      if (node.s !== memberId) return;
      const item = model.line.path[node.i], last = model.seq.length - 1;
      if (!aggregate.lines.includes(model.root)) aggregate.lines.push(model.root);
      if (!model.line.loop && (index === last || (index === 0 && !model.line.rootId))) { aggregate.term = aggregate.term || (index === 0 ? model.geo.startDir : model.geo.endDir); aggregate.termLine = aggregate.termLine || model.root; }
      if (!aggregate.lp.some((q) => q.line === model.root)) aggregate.lp.push({ line: model.root, num: numberFor(store.stations.get(memberId), model.seq, index), rank: order.get(model.line.id) });
      if (item && typeof item.num === 'boolean') aggregate.numFlags.push(item.num);
      pickItems.push({ item: item, rank: order.get(model.line.id) });
      [model.seq[index - 1], model.seq[index + 1]].forEach((nb) => { if (nb) dirs.push(Math.atan2(nb.y - node.y, nb.x - node.x) * 180 / Math.PI); });
      if (ringP && cx != null) {
        const vector = lineVec.get(model.line.id) || { sx: 0, sy: 0, n: 0 };
        [model.seq[index - 1], model.seq[index + 1]].forEach((nb, j) => { const neighbourPoint = model.geo.pos[index + (j === 0 ? -1 : 1)]; if (nb && neighbourPoint) { vector.sx += neighbourPoint.x - cx; vector.sy += neighbourPoint.y - cy; vector.n++; } });
        lineVec.set(model.line.id, vector);
      }
    }));
    if (!aggregate.lines.length) return null;
    aggregate.lp.sort((a2, b2) => a2.rank - b2.rank);
    const memberStation = store.stations.get(memberId), pick = store.pickSymbol(pickItems);
    const kind = overrideKind || (pick && pick.sym !== 'auto' ? pick.sym : aggregate.lp.length > 1 ? 'interchange' : aggregate.term ? 'terminal' : 'station');
    const showNum = overrideNum != null ? overrideNum : numShow(memberId, aggregate.numFlags);
    if (kind === 'capsule' || kind === 'stack' || kind === 'chain') {
      let axis, items;
      if (ringP && ringAxis) {
        axis = ringAxis(ringP);
        items = aggregate.lp.map((entry) => {
          const vector = lineVec.get(entry.line.id), length = vector && vector.n ? Math.hypot(vector.sx, vector.sy) || 1 : 1;
          return { line: entry.line, num: entry.num, rank: entry.rank, dx: vector && vector.n ? vector.sx / length : 0, dy: vector && vector.n ? vector.sy / length : 0 };
        }).sort((a2, b2) => (a2.dx * axis.x + a2.dy * axis.y) - (b2.dx * axis.x + b2.dy * axis.y));
      } else {
        const angle = (dirs.length ? dirs[0] : 0) * Math.PI / 180;
        axis = { x: -Math.sin(angle), y: Math.cos(angle) };
        if (axis.y < -1e-6 || (Math.abs(axis.y) < 1e-6 && axis.x < 0)) axis = { x: -axis.x, y: -axis.y };
        items = aggregate.lp;
      }
      return symbols.multi(0, 0, { pal: palette, style: kind, items: items.map((q) => ({ color: q.line.color, num: q.num, rank: q.rank })), showNum, axis, status: memberStation.status }).svg;
    }
    const first = aggregate.lp[0], numbered = showNum && kind !== 'interchange' && first && first.num;
    const terminusLine = kind === 'disc' && aggregate.termLine ? aggregate.termLine : first && first.line;
    const numLine = kind === 'disc' && terminusLine ? (aggregate.lp.find((q) => q.line === terminusLine) || first) : first;
    return symbols.station(0, 0, { pal: palette, kind: kind === 'interchange' ? 'interchange' : kind === 'terminal' ? 'terminal' : kind === 'disc' ? 'disc' : 'station', status: memberStation.status, dir: aggregate.term, num: numbered && numLine ? numLine.num : '', fill: terminusLine ? terminusLine.color : palette.paper });
  }

  /* Links between stations: interchange necks, connecting / unofficial walkways (one per pair of complexes), legacy item links. */
  function drawLinks(scene) {
    const { store, geo, symbols, linkK, palette, info, isDimmed, positions, blockOfMember } = scene;
    let svg = '';
    const linkDone = new Set();
    const drawLink = (leadA, leadB, kind, rawA, rawB) => {
      const stationInfo = info.get(leadA), other = info.get(leadB), key = leadA < leadB ? leadA + '|' + leadB : leadB + '|' + leadA;
      if (!stationInfo || !other || leadA === leadB || linkDone.has(key) || (stationInfo.share && stationInfo.share === other.share)) return;
      linkDone.add(key);
      const pointA = positions.get(leadA), pointB = positions.get(leadB), nodeA = store.nodeOf(leadA), nodeB = store.nodeOf(leadB);
      const bends = rawA && rawB ? store.connBends(rawA, rawB) : [];
      const route = geo.linkRoute(pointA, pointB, nodeA, nodeB, undefined, bends);                  // from circle centre to circle centre, bent to the grid
      (stationInfo.share || stationInfo).dirs.push(route.a); (other.share || other).dirs.push(route.b);   // keep labels clear of the link
      const connAttr = rawA && rawB ? ` data-conn="${TM.esc(rawA)}|${TM.esc(rawB)}"` : '';
      const look = (rawA && rawB && store.connOf(rawA, rawB)) || {};
      let svgLink;
      if (look.style === 'split') {
        /* each half in the colours of the lines at its own end, bands ordered the way those lines run across that end */
        const [halfA, halfB] = geo.splitHalf(route.pts);
        const bandsAt = (endInfo, at, endPoint, nextPoint) => {
          const length = Math.hypot(nextPoint.x - endPoint.x, nextPoint.y - endPoint.y) || 1, normal = { x: -(nextPoint.y - endPoint.y) / length, y: (nextPoint.x - endPoint.x) / length };
          return (endInfo.share || endInfo).lp.slice().sort((q1, q2) => ((q1.p.x - at.x) * normal.x + (q1.p.y - at.y) * normal.y) - ((q2.p.x - at.x) * normal.x + (q2.p.y - at.y) * normal.y) || q1.rank - q2.rank)
            .map((q) => q.line.color).filter((c2, i2, arr) => arr.indexOf(c2) === i2);
        };
        const points = route.pts;
        svgLink = symbols.splitConnector([{ pts: halfA, colors: bandsAt(stationInfo, pointA, points[0], points[1]) }, { pts: halfB, colors: bandsAt(other, pointB, points[points.length - 2], points[points.length - 1]) }], palette, { k: linkK, border: look.border });
      } else svgLink = symbols.connector(pointA, pointB, kind, palette, route.d, { k: linkK, style: look.style, border: look.border, color: look.color });
      svg += `<g opacity="${isDimmed(leadA) && isDimmed(leadB) ? 0.3 : 1}"${connAttr}>${svgLink}</g>`;
    };
    store.splitLinks().forEach((c) => drawLink(store.rep(c.a), store.rep(c.b), 'neck', c.a, c.b));   // any plain interchange, or a same-platform interchange between different names: linked symbols — bendable and styled like a connecting line   // any plain interchange, or a same-platform interchange between different names: linked symbols

    /* Connecting / unofficial links: a connection recorded on any member of an interchange complex (same-name merged, or
       joined by a different-name interchange) belongs to the whole complex, and one joined to any station now inside a
       block belongs to the whole block. Several such connections targeting the same complex / block are the same physical
       walkway, so only one is drawn — the nearest pair for a plain complex, or straight to a block's own centre. */
    const groupOf = (rep) => blockOfMember.get(rep) || store.complexOf(rep);
    const compKey = (ra, rb) => { const groupA = groupOf(ra), groupB = groupOf(rb); return groupA < groupB ? groupA + '|' + groupB : groupB + '|' + groupA; };
    const best = new Map();
    store.connections().filter((connection) => connection.type !== 'interchange' && connection.type !== 'platform').forEach((connection) => {
      const rawRa = store.rep(connection.a), rawRb = store.rep(connection.b);
      const leadA = blockOfMember.get(rawRa) || rawRa, leadB = blockOfMember.get(rawRb) || rawRb;
      if (leadA === leadB || !positions.has(leadA) || !positions.has(leadB)) return;
      const key = compKey(rawRa, rawRb), pointA = positions.get(leadA), pointB = positions.get(leadB), distance = Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y), kind = connection.type === 'walkway' ? 'connect' : 'link';
      const current = best.get(key);
      if (!current || distance < current.d - 0.01 || (Math.abs(distance - current.d) <= 0.01 && kind === 'link' && current.kind !== 'link')) best.set(key, { ra: leadA, rb: leadB, kind, d: distance, a: connection.a, b: connection.b });
    });
    best.forEach((cnd) => drawLink(cnd.ra, cnd.rb, cnd.kind, cnd.a, cnd.b));
    info.forEach((I, id) => I.links.forEach((l) => drawLink(id, l.to, l.kind)));
    return svg;
  }

  /* A station configured as a block: its members laid out round the ring / bar, one small symbol per slot (null: not a block). */
  function blockSymbol(scene, stationInfo, symbolInfo, id, x, y) {
    const { opts, store, geo, symbols, palette, models, numberFor, numShow } = scene;
    /* A block can be configured on either partner of a shared (different-name, same-node) symbol — whichever member of
       the share group actually has one, not just this particular iteration's own station. */
    const blockOwnerId = (stationInfo.share ? stationInfo.share.reps : [id]).find((r) => { const memberStation = store.stations.get(r); return memberStation && memberStation.block; });
    if (!blockOwnerId) return null;
    const blockStation = store.stations.get(blockOwnerId), block = blockStation.block, mergedIds = (block.merged || []).filter((mid) => store.stations.has(mid) && mid !== blockOwnerId);
    const memberIds = [...new Set([...store.complexMembers(blockOwnerId), ...mergedIds])];
    const groups = store.blockGroups(memberIds, block.bundles);
    const nSlots = groups.length || 1;
    const size = block.size || Math.max(34, 15 * nSlots);
    const pointAt = (t) => geo.blockPoint(block.style, block.shape, block.orientation, size, t);

    /* Each of a bundled slot's own stations, and the direction (from the block's centre, unit vector) its own line(s)
       actually approach from — used both to orient the bundle (long side toward the centre) and to order its dots
       (the one whose line comes from further "outward" along that axis sits at that end). */
    function bundleDirs(ids, forcedShow) {
      return ids.map((memberId) => {
        let sumX = 0, sumY = 0, count = 0, color = null, number = '', flags = [];
        models.forEach((model) => model.seq.forEach((node, index) => {
          if (node.s !== memberId) return;
          const item = model.line.path[node.i];
          if (!color) { color = model.line.color; number = numberFor(store.stations.get(memberId), model.seq, index); }
          if (item && typeof item.num === 'boolean') flags.push(item.num);
          const position = model.geo.pos[index]; sumX += position.x - x; sumY += position.y - y; count++;
        }));
        const show = forcedShow != null ? forcedShow : numShow(memberId, flags);
        const length = Math.hypot(sumX, sumY) || 1;
        return { id: memberId, color: color || palette.muted, num: show ? number : '', dx: count ? sumX / length : 0, dy: count ? sumY / length : 0 };
      });
    }
    /* A capsule / stack's long edge always faces the block's centre — so its long axis runs tangential to the
       ring or perimeter (crosswise to the radius, like a chord) here, exactly as a rapidkl bar's bundles sit
       alongside the bar rather than end-on into it. Which of the two tangent directions counts as "positive"
       does not actually matter: bundleDirs/lineDirs below always sort each dot by its own real line's position
       projected onto this axis, so the arrangement lands the same physical dot next to its own real line
       regardless of that sign — a consistent, ring-position-aware answer to "which side (±90°) it faces". */
    function bundleAxis(point) {
      if (block.style !== 'shape') return block.orientation === 'vertical' ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const length = Math.hypot(point.x, point.y) || 1;
      return length > 0.01 ? { x: -point.y / length, y: point.x / length } : { x: 1, y: 0 };
    }
    function bundleSymbol(group, point) {
      const kind = block.symbol[group.key] || 'capsule';
      if (kind === 'interchange') return symbols.station(0, 0, { pal: palette, kind: 'interchange', status: 'operational' });
      const axis = bundleAxis(point);
      const forcedShow = block.num[group.key];
      const items = bundleDirs(group.ids, forcedShow).sort((a2, b2) => (a2.dx * axis.x + a2.dy * axis.y) - (b2.dx * axis.x + b2.dy * axis.y));
      const showNum = forcedShow != null ? forcedShow : items.some((it) => !!it.num);
      return symbols.multi(0, 0, { pal: palette, style: kind, items: items.map((it) => ({ color: it.color, num: it.num })), showNum, axis, status: 'operational' }).svg;
    }

    const laidOut = groups.map((group, i) => {
      const fraction = block.members[group.key] != null ? block.members[group.key] : (nSlots > 1 ? i / nSlots : 0);
      const point = pointAt(fraction);
      const slotSymbol = group.ids.length > 1 ? bundleSymbol(group, point) : (memberSymbol(scene, group.ids[0], block.symbol[group.key], block.num[group.key], point, x, y, bundleAxis) || `<circle r="7" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="2.6"/>`);
      return { key: group.key, ids: group.ids, id: group.ids[0], t: fraction, dx: point.x, dy: point.y, sym: slotSymbol };
    });
    symbolInfo.blockMembers = laidOut;
    symbolInfo.blockOwnerId = blockOwnerId;

    const blockSvg = symbols.block(x, y, { pal: palette, style: block.style, shape: block.shape, orientation: block.orientation, size, color: block.color, members: laidOut, repId: blockOwnerId, interactive: opts.interactive });
    symbolInfo.sym = { kind: 'block', showNum: false, g: blockSvg.svg, extra: blockSvg.extent, big: true, picked: 'block' };
    return symbolInfo.sym;
  }

  /* Any other station's symbol: station / terminal / interchange / capsule / stack / chain / disc / dash / pill. */
  function plainSymbol(scene, stationInfo, symbolInfo, id, x, y, station, leader) {
    const { store, symbols, palette, numShow, itemsByRep, clusterOf, splitReps } = scene;
    /* Symbol: the user's newest choice for this station wins; without timestamps, the line highest in the list decides. */
    const pick = store.pickSymbol(stationInfo.share ? stationInfo.share.pick : (itemsByRep.get(id) || []));
    const linked = stationInfo.share ? stationInfo.share.reps.some((r) => splitReps.has(r)) : splitReps.has(id);
    /* Auto: interchange partners standing on one node share one symbol, which is a ring like any other interchange;
       linked discs are for partners on nodes of their own, joined by a neck */
    const kind = pick && pick.sym !== 'auto' ? pick.sym : linked && !stationInfo.share ? 'chain' : symbolInfo.lines.length > 1 ? 'interchange' : symbolInfo.term ? 'terminal' : 'station';
    const showNum = numShow(id, symbolInfo.numFlags);
    let markup, extra = 0, big = kind === 'interchange';
    if (kind === 'capsule' || kind === 'stack' || kind === 'chain') {
      const angle = (symbolInfo.dirs.length ? symbolInfo.dirs[0] : 0) * Math.PI / 180;
      let axis = { x: -Math.sin(angle), y: Math.cos(angle) };
      if (axis.y < -1e-6 || (Math.abs(axis.y) < 1e-6 && axis.x < 0)) axis = { x: -axis.x, y: -axis.y };
      /* one dot per line, placed in the order the lines' tracks really run across the symbol so each dot sits on its own line's colour */
      const items = symbolInfo.lp.map((q) => ({ color: q.line.color, num: q.num, rank: q.rank, t: (q.p.x - x) * axis.x + (q.p.y - y) * axis.y, dx: q.p.x - x, dy: q.p.y - y, dir: q.dir }))
        .sort((a, b) => (Math.abs(a.t - b.t) > 0.5 ? a.t - b.t : a.rank - b.rank));
      let chainGap;
      if (kind === 'chain' && items.length > 1 && Math.max(...items.map((a) => Math.max(...items.map((b) => Math.hypot(a.dx - b.dx, a.dy - b.dy))))) < 6) {
        const chainLayout = chainAtCrossing(items, showNum);
        if (chainLayout) items.forEach((it, i) => { it.dx = chainLayout[i].x; it.dy = chainLayout[i].y; });
        else { items.forEach((it) => { it.dx = null; }); chainGap = chainTouch(items, showNum); }
      }
      if (kind !== 'chain') items.forEach((it) => { it.dx = null; });
      const multiSymbol = symbols.multi(x, y, { pal: palette, style: kind, items, showNum, axis, status: station.status, gap: chainGap });
      markup = multiSymbol.svg; extra = Math.max(0, multiSymbol.extent - 10); big = true;
    } else {
      const first = symbolInfo.lp[0], numbered = showNum && kind !== 'interchange' && first && first.num;
      const terminusLine = kind === 'disc' && symbolInfo.termLine ? symbolInfo.termLine : first && first.line;      // a terminus disc takes the colour of the line that ends here
      const numLine = kind === 'disc' && terminusLine ? (symbolInfo.lp.find((q) => q.line === terminusLine) || first) : first;
      const passKind = ['interchange', 'terminal', 'disc', 'dash', 'tick', 'pill'].includes(kind) ? kind : 'station';
      let symDir = symbolInfo.term;
      if (passKind === 'dash' || passKind === 'tick') {
        /* Same direction the station's own label would sit in — computed the same way the label section below
           works it out (explicit override, else auto-picked away from the lines that call here). */
        const override2 = station.block ? station.block.labelPos : store.labelPos[id];
        const lbl2 = override2 || stationInfo.label || {};
        const sharedLabelPos = lbl2.pos || (stationInfo.share && !leader ? OPP[stationInfo.share.leaderPos] : autoLabelPos(symbolInfo.dirs, stationInfo.ord));
        const degrees = CAND[sharedLabelPos];
        symDir = { x: Math.cos(degrees * Math.PI / 180), y: Math.sin(degrees * Math.PI / 180) };
      }
      /* An interchange sharing this one dash / pill: one dash or pill per line, ordered left-to-right by real
         drawn x position (the block's own bundled dots use the same ordering) — so it still reads correctly
         when the lines run through the node vertically, not only when the symbol's own horizontal layout
         happens to match the lines' own direction. Up to 7 side by side for a pill. */
      let codes = null, lineColors = null;
      if ((passKind === 'pill' || passKind === 'dash' || passKind === 'tick') && symbolInfo.lp.length > 1) {
        const ordered = symbolInfo.lp.slice().sort((a2, b2) => (a2.p.x - x) - (b2.p.x - x));
        const seen = new Set(), lineEntries = [];
        ordered.forEach((q) => { if (seen.has(q.line.id)) return; seen.add(q.line.id); lineEntries.push(q); });
        if (passKind === 'pill') codes = lineEntries.slice(0, 7).map((q) => ({ text: showNum ? q.num || '' : '', color: q.line.color }));
        else lineColors = lineEntries.map((q) => q.line.color);
      }
      markup = symbols.station(x, y, { pal: palette, kind: passKind, status: station.status, dir: symDir, codes, lineColors, terminus: !!symbolInfo.term, back: symbolInfo.term ? LINE_W / 2 / scene.symK : 0, lineW: LINE_W / scene.symK,
        num: passKind === 'pill' ? (showNum ? (numLine ? numLine.num : (first && first.num) || '') : '') : numbered && numLine ? numLine.num : '', fill: terminusLine ? terminusLine.color : palette.paper });
      big = big || !!numbered || kind === 'disc' || kind === 'pill';
    }
    const cluster = clusterOf.get(id);
    if (cluster && station.status === 'fantasy') {
      markup += `<g transform="translate(${x + 12} ${y - 14})"><rect x="-11" y="-8" width="22" height="16" rx="8" fill="${palette.fantasy}" stroke="${palette.paper}" stroke-width="1.5"/><text y="4" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family='${symbols.FONT}'>×${cluster.authors.length}</text></g>`;
    }
    symbolInfo.sym = { kind, showNum, g: markup, extra, big, picked: pick ? pick.sym : 'auto' };
    return symbolInfo.sym;
  }

  /* A station's name label (with its codes and icons); '' when hidden or drawn by an interchange partner. */
  function stationLabel(scene, stationInfo, symbolInfo, id, x, y, station, leader, symbol, symbolScale) {
    const { opts, store, symbols, palette, grow, isDimmed, boxes, labelSkip, mergedCodes } = scene;
    /* A block's own name label belongs to the block (block.labelPos); an interchange's label belongs to the whole
       group (store.labelPos, set once you drag it) — neither depends on any one station's line item, which may not even
       be one you can edit, or may disagree with a different line's own item for the same shared station. */
    const override = station.block ? station.block.labelPos : store.labelPos[id];
    const label = override || stationInfo.label || {};
    const usingOverride = !!override;
    stationInfo.labelSize = (usingOverride ? label.size : stationInfo.size) || opts.labelSize || 13;
    const hideLabel = usingOverride ? !!label.hide : stationInfo.hide;
    if (!hideLabel && !labelSkip.has(id)) {
      const labelPosition = label.pos || (stationInfo.share && !leader ? OPP[stationInfo.share.leaderPos] : autoLabelPos(symbolInfo.dirs, stationInfo.ord));   // a partner on the same node goes on the opposite side
      stationInfo.labelPos = labelPosition;
      const icons = (stationInfo.icons || []).map((fl) => TM.images && TM.images.get(fl)).filter(Boolean);
      const codes = station.block ? [...store.complexMembers(id), ...(station.block.merged || []).filter((mid) => store.stations.has(mid))]
        : mergedCodes.get(id) || stationInfo.codes.concat(store.members(id).filter((c) => !stationInfo.codes.includes(c)));
      const codeOverride = store.codeLabels[id] || {}, codeDefault = (codes.length ? codes : [station.id]).join(' · ');   // this user's view settings, not station data
      stationInfo.codeInfo = { def: codeDefault, show: codeOverride.show, text: codeOverride.text || '', shown: codeOverride.show === true ? true : codeOverride.show === false ? false : !!opts.showCodes };
      const dimmedLabel = isDimmed(id);
      const rows = station.block && station.block.label ? [{ text: station.block.label, fs: stationInfo.labelSize, bold: true }].concat(stationInfo.codeInfo.shown ? [{ text: codeOverride.text || codeDefault, fs: Math.max(7, Math.round(stationInfo.labelSize * 0.73 * 10) / 10), muted: true }] : [])
        : labelRows(station, opts.langs, stationInfo.codeInfo.shown, stationInfo.labelSize, codeOverride.text || codeDefault);
      /* a scaled symbol pushes its label out by as much as it grew (its own clearance + extent, both scaled) */
      const placed = symbols.label(x, y, { pal: palette, rows, pos: labelPosition, dx: label.dx, dy: label.dy, big: symbol.big, gap: symbol.extra * symbolScale + (symbol.big ? 15 : 12) * (symbolScale - 1), icons, rot: label.rot });
      stationInfo.labelRot = label.rot || 0;
      boxes.set(id, placed.hull);
      const inner = `${opts.interactive ? `<rect x="${placed.box.x}" y="${placed.box.y}" width="${placed.box.w}" height="${placed.box.h}" fill="transparent"/>` : ''}${placed.svg}`;
      const labelSvg = `<g class="lbl" data-lbl="${TM.esc(id)}" opacity="${dimmedLabel ? 0.3 : 1}">${placed.transform ? `<g${placed.transform}>${inner}</g>` : inner}</g>`;
      grow(placed.hull.x, placed.hull.y); grow(placed.hull.x + placed.hull.w, placed.hull.y + placed.hull.h);
      return labelSvg;
    }
    return '';
  }

  /* Every station's symbol and name label. */
  function drawStations(scene) {
    const { opts, store, symK, palette, hiddenStatus, grow, info, isDimmed, positions, absorbedReps } = scene;
    let svgStations = '', svgLabels = '';
    info.forEach((stationInfo, id) => {
      if (absorbedReps.has(id)) return;   // merged into another station's block; drawn as a dot inside it instead
      const symbolInfo = stationInfo.share || stationInfo;                                                   // what the symbol is made of (shared by interchange partners on one node)
      const { x, y } = positions.get(id), station = stationInfo.st, leader = !stationInfo.share || stationInfo.share.leader === id;
      /* Hide stations whose Display toggle is off (under construction / provisional / abandoned / demolished) — but only when
         EVERY station sharing this node/complex is in a hidden status; if even one member is shown, the shared symbol still needs to be drawn. */
      const hideStatus = (raw) => hiddenStatus(store.stations.get(raw));
      if ((stationInfo.share ? stationInfo.share.reps : [id]).every(hideStatus)) return;
      let symbol = symbolInfo.sym;
      if (!symbol) symbol = blockSymbol(scene, stationInfo, symbolInfo, id, x, y);
      if (!symbol) symbol = plainSymbol(scene, stationInfo, symbolInfo, id, x, y, station, leader);
      const dimmed = stationInfo.share ? stationInfo.share.reps.every(isDimmed) : isDimmed(id);
      /* a dashed halo marks a stop that is only suggested on a line drawn here */
      const isSug = symbol.kind !== 'block' && (stationInfo.share ? stationInfo.share.reps : [id]).some((r) => info.get(r) && info.get(r).sug);
      const halo = isSug ? `<circle cx="${x}" cy="${y}" r="${16 + symbol.extra}" fill="none" stroke="${palette.fantasy}" stroke-width="2" stroke-dasharray="4 3" pointer-events="none"/>` : '';
      const symbolScale = symbol.kind === 'block' ? 1 : symK, symInner = `${opts.interactive ? `<circle cx="${x}" cy="${y}" r="${17 + symbol.extra}" fill="transparent"/>` : ''}${halo}${symbol.g}`;
      if (leader) svgStations += `<g class="stn" data-sid="${TM.esc(id)}" opacity="${dimmed ? 0.3 : 1}">${symbolScale === 1 ? symInner : `<g transform="translate(${x} ${y}) scale(${symbolScale}) translate(${-x} ${-y})">${symInner}</g>`}</g>`;
      grow(x, y, (30 + symbol.extra) * symbolScale);
      stationInfo.kind = symbol.kind; stationInfo.showNum = symbol.showNum; stationInfo.picked = symbol.picked;
      svgLabels += stationLabel(scene, stationInfo, symbolInfo, id, x, y, station, leader, symbol, symbolScale);
    });
    return { svgStations, svgLabels };
  }

  /* Line-name badges at both ends of each (non-loop) line. */
  /* Line-name badges at both ends of each (non-loop) line. Badges of lines that end at the same station heading the
     same way sit side by side, back to back across the lines, instead of on top of one another. */
  function drawBadges(scene) {
    const { opts, symbols, palette, models, grow, actLines, hasActive, store } = scene;
    let svg = '';
    if (opts.badges === false) return svg;
    const groups = new Map();
    models.forEach((model) => {
      if (model.line.loop || model.seq.length < 2) return;
      [['s', 0, model.geo.startDir], ['e', model.seq.length - 1, model.geo.endDir]].forEach(([end, index, direction]) => {
        if (end === 's' && model.line.rootId) return;   // a branch starts at its junction, in the middle of its line
        const point = model.geo.pos[index], item = model.seq[index], line = model.line;
        const uri = line.badgeStyle === 'picture' ? TM.lineImage(line) : null;
        let style = line.badgeStyle === 'picture' && !uri ? 'pill' : line.badgeStyle || 'pill';   // no picture to show: a pill
        /* hidden: not drawn — except as a faint outline on the line being edited, so it can still be picked to bring back */
        if (style === 'hidden') { if (!opts.interactive || !actLines.has(line.id)) return; style = 'ghost'; }
        const tw = symbols.textWidth(line.code, 12);
        const size = style === 'flag' ? { w: Math.max(22, tw + 10), h: 22 } : style === 'picture' ? symbols.pictureSize(uri) : { w: Math.max(28, tw + 14), h: 22 };
        const key = (item && item.s ? store.rep(item.s) : Math.round(point.x) + ',' + Math.round(point.y)) + '|' + Math.round(direction.x * 4) + ',' + Math.round(direction.y * 4);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ model, line, end, point, direction, uri, style, size });
      });
    });
    groups.forEach((entries) => {
      const direction = entries[0].direction, perp = { x: -direction.y, y: direction.x }, gap = 3;
      const along = (e) => Math.abs(direction.x) * e.size.w / 2 + Math.abs(direction.y) * e.size.h / 2;
      const across = (e) => Math.abs(perp.x) * e.size.w + Math.abs(perp.y) * e.size.h;
      entries.sort((p, q) => (p.point.x - q.point.x) * perp.x + (p.point.y - q.point.y) * perp.y);
      const centre = { x: entries.reduce((t, e) => t + e.point.x, 0) / entries.length, y: entries.reduce((t, e) => t + e.point.y, 0) / entries.length };
      const flagDepth = 22 + Math.max(0, ...entries.filter((e) => e.style === 'flag').map(along));
      const total = entries.reduce((t, e) => t + across(e), 0) + gap * (entries.length - 1);
      let run = -total / 2;
      entries.forEach((e) => {
        const shift = entries.length > 1 ? run + across(e) / 2 : 0, base = entries.length > 1 ? centre : e.point;
        run += across(e) + gap;
        const { model, line, end, point, uri, style, size } = e;
        const dimmed = hasActive && opts.dimOthers !== false && !actLines.has(line.id);
        const off = (line.badges && line.badges[end]) || { dx: 0, dy: 0 };
        const sel = opts.interactive && TM.state.selected && TM.state.selected.type === 'badge' && TM.state.selected.line === line.id && TM.state.selected.end === end;
        let badgeX, badgeY, inner;
        if (style === 'flag') {   // fixed to the line's end: the line itself runs on into it
          badgeX = base.x + perp.x * shift + direction.x * flagDepth; badgeY = base.y + perp.y * shift + direction.y * flagDepth;
          inner = symbols.flag(point.x, point.y, direction, line.code, line.color, palette, LINE_W, { cx: badgeX, cy: badgeY }).svg;
        } else {
          badgeX = base.x + perp.x * shift + direction.x * 40 + off.dx; badgeY = base.y + perp.y * shift + direction.y * 40 + off.dy;
          inner = style === 'picture' ? symbols.picture(badgeX, badgeY, uri, size)
            : style === 'ghost' ? `<g transform="translate(${TM.round2dp(badgeX)} ${TM.round2dp(badgeY)})" opacity=".55"><rect x="${-size.w / 2}" y="-11" width="${size.w}" height="22" rx="7" fill="${palette.paper}" stroke="${palette.muted}" stroke-width="1.5" stroke-dasharray="4 3"/><text y="4.3" text-anchor="middle" font-size="12" font-weight="800" fill="${palette.muted}" font-family='${symbols.FONT}'>${TM.esc(line.code)}</text></g>`
            : symbols.badge(badgeX, badgeY, line.code, line.color, palette);
        }
        const ring = sel ? `<rect x="${badgeX - size.w / 2 - 5}" y="${badgeY - size.h / 2 - 5}" width="${size.w + 10}" height="${size.h + 10}" rx="9" fill="none" stroke="${palette.ink}" stroke-width="1.5" stroke-dasharray="4 3" pointer-events="none"/>` : '';
        svg += `<g opacity="${dimmed ? 0.3 : 1}" data-line="${TM.esc(model.line.id)}" data-badge="${end}">${inner}${ring}</g>`;
        grow(badgeX, badgeY, Math.max(26, size.w / 2 + 4));
      });
    });
    return svg;
  }

  function drawBeyond(scene) {
    const { opts, symbols, palette, models, grow, actLines, hasActive } = scene;
    /* "Beyond the map" mark: this end is not really a terminus — the line (and its stations) simply run past this map's
       scope. A short dashed stub fading into three dots, drawn past the real last station, never a real station itself. */
    let gBeyond = '';
    models.forEach((model) => {
      if (model.line.loop || model.seq.length < 2 || !model.line.beyond) return;
      const dimmed = hasActive && opts.dimOthers !== false && !actLines.has(model.line.id);
      [['s', 0, model.geo.startDir], ['e', model.seq.length - 1, model.geo.endDir]].forEach(([end, index, direction]) => {
        const label = model.line.beyond[end];
        if (label == null || (end === 's' && model.line.rootId)) return;
        const point = model.geo.pos[index];
        const stub = `<path d="M${point.x + direction.x * 20} ${point.y + direction.y * 20} L${point.x + direction.x * 62} ${point.y + direction.y * 62}" fill="none" stroke="${model.line.color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="0.1 9"/>`;
        const dots = [72, 80, 88].map((d) => `<circle cx="${point.x + direction.x * d}" cy="${point.y + direction.y * d}" r="2.4" fill="${palette.muted}"/>`).join('');
        const textX = point.x + direction.x * 98, textY = point.y + direction.y * 98;
        const text = label ? `<text x="${textX}" y="${textY + 4}" text-anchor="${direction.x > 0.3 ? 'start' : direction.x < -0.3 ? 'end' : 'middle'}" font-size="12" font-weight="600" fill="${palette.muted}" font-family='${symbols.FONT}'>${TM.esc(label)}</text>` : '';
        gBeyond += `<g opacity="${dimmed ? 0.3 : 1}" data-line="${TM.esc(model.line.id)}" data-beyond="${end}">${stub}${dots}${text}</g>`;
        grow(point.x + direction.x * 100, point.y + direction.y * 100, label ? 40 : 10);
      });
    });
    return gBeyond;
  }

  /* Bend handles of the line being edited. */
  function editOverlay(scene) {
    const { opts, GRID, palette, models, activeLine } = scene;
    let overlay = '';
    if (opts.interactive && activeLine) {
      const model = models.find((mm) => mm.line.id === activeLine.id);
      if (model) {
        model.seq.forEach((node) => {
          if (node.i >= 0 && !node.s) {
            overlay += `<g class="wp" data-wp="${model.line.origIdx ? model.line.origIdx[node.i] : node.i}" transform="translate(${node.x * GRID} ${node.y * GRID}) rotate(45)"><rect x="-7" y="-7" width="14" height="14" rx="2.5" fill="${palette.paper}" stroke="${activeLine.color}" stroke-width="3"/></g>`;
          }
        });
      }
    }
    return overlay;
  }

  /* Free-floating annotations: custom text or an image from the map's images/, placed anywhere, independent of any station or line. */
  function drawAnnotations(scene) {
    const { opts, store, symbols, palette, grow } = scene;
    let gAnn = '';
    Object.entries(store.annotations).forEach(([id, annotation]) => {
      const x = annotation.x, y = annotation.y, rotation = annotation.rot ? ` rotate(${annotation.rot})` : '';
      let inner, width, height;
      if (annotation.kind === 'image') {
        const imageUri = TM.images.get(annotation.file);
        width = annotation.w; height = annotation.w;
        inner = imageUri ? `<image href="${TM.esc(imageUri)}" x="${-width / 2}" y="${-width / 2}" width="${width}" height="${width}" preserveAspectRatio="xMidYMid meet"/>`
          : `<rect x="${-width / 2}" y="${-width / 2}" width="${width}" height="${width}" fill="none" stroke="${palette.muted}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
      } else {
        const fontSize = annotation.size || 16;
        width = symbols.textWidth(annotation.text, fontSize) + 6; height = fontSize * 1.3;
        const frame = symbols.annFrame(annotation, width, height, fontSize, palette);
        width = frame.w; height = frame.h;
        inner = `${frame.svg}<text x="0" y="${fontSize * 0.36}" text-anchor="middle" font-size="${fontSize}" font-weight="${annotation.bold ? 800 : 500}" fill="${annotation.color || palette.ink}" font-family='${symbols.FONT}'>${TM.esc(annotation.text)}</text>`;
      }
      gAnn += `<g class="ann" data-ann="${TM.esc(id)}" transform="translate(${x} ${y})${rotation}">${opts.interactive ? `<rect x="${-width / 2 - 5}" y="${-height / 2 - 5}" width="${width + 10}" height="${height + 10}" fill="transparent"/>` : ''}${inner}</g>`;
      grow(x - width / 2, y - height / 2); grow(x + width / 2, y + height / 2);
    });
    return gAnn;
  }

  /* Behind everything (never affecting the auto-fit bbox): the background image and the background drawings, in the
     order the map sets (store.drawing.top). Drawings can be picked on the canvas by whoever may edit the map. */
  function drawBackground(scene) {
    const { opts, store, symbols } = scene;
    let svgImage = '', svgDrawings = '';
    const background = store.background, layer = store.drawing;
    if (background && background.visible !== false && background.dataUri) {
      const inter = opts.interactive && TM.state.bgMode;
      svgImage = `<image href="${TM.esc(background.dataUri)}" x="${background.x}" y="${background.y}" width="${background.w}" height="${background.h}" opacity="${isFinite(background.opacity) ? background.opacity : 1}" preserveAspectRatio="none"${inter ? ' data-bg="1" style="cursor:move"' : ' pointer-events="none"'}/>`;
    }
    if (layer && !layer.hidden) {
      const pick = opts.interactive && !TM.state.bgMode && TM.actions.ownsMap() && ['select', 'draw'].includes(TM.state.tool);
      svgDrawings = layer.items.map((d) => symbols.drawing(d, pick ? ` data-draw="${TM.esc(d.id)}" style="cursor:pointer"` : ' pointer-events="none"')).join('');
    }
    return layer && layer.top === 'image' ? svgDrawings + svgImage : svgImage + svgDrawings;
  }

  /* opts: theme, langs, lineIds[], interactive, activeLineId, showCodes, hotspots, badges */
  renderer.build = function (opts) {
    const scene = prepare(opts), { store } = scene;
    const info = scene.info = collectStations(scene);
    Object.assign(scene, activeState(scene));
    const svgLines = drawLines(scene);
    const positions = scene.positions = new Map(), boxes = scene.boxes = new Map();
    info.forEach((stationInfo, id) => positions.set(id, { x: stationInfo.px / stationInfo.n, y: stationInfo.py / stationInfo.n }));
    Object.assign(scene, shareSymbols(scene));
    Object.assign(scene, blockIndex(scene));
    const svgLinks = drawLinks(scene);   // before the stations: a link pushes its direction into the labels' placement
    const { svgStations, svgLabels } = drawStations(scene);
    const svgBadges = drawBadges(scene), svgBeyond = drawBeyond(scene), overlay = editOverlay(scene), svgAnnotations = drawAnnotations(scene);
    const bbox = isFinite(scene.bbox.x0) ? scene.bbox : { x0: -200, y0: -150, x1: 200, y1: 150 };
    [...info.keys()].forEach((leadId) => store.members(leadId).forEach((memberId) => {   // look-ups by any station of an interchange
      if (memberId === leadId) return;
      positions.set(memberId, positions.get(leadId)); info.set(memberId, info.get(leadId)); if (boxes.has(leadId)) boxes.set(memberId, boxes.get(leadId));
    }));
    const svgBackground = drawBackground(scene);

    return {
      svg: `<g class="layer-bg">${svgBackground}</g><g class="layer-lines">${svgLines}</g><g class="layer-badges">${svgBadges}</g><g class="layer-beyond">${svgBeyond}</g><g class="layer-links">${svgLinks}</g><g class="layer-stations">${svgStations}</g><g class="layer-labels">${svgLabels}</g><g class="layer-ann">${svgAnnotations}</g>`,
      overlay, pos: positions, info, boxes, pal: scene.palette,
      bbox: { x: bbox.x0, y: bbox.y0, w: bbox.x1 - bbox.x0, h: bbox.y1 - bbox.y0 },
      lines: scene.lines,
    };
  };

  renderer.currentOpts = (extra) => Object.assign({
    theme: document.documentElement.dataset.theme || 'light',
    langs: TM.state.langs.length ? TM.state.langs : ['en'],
    lineIds: [...TM.store.visible].filter((id) => TM.store.lineFilter.has(id)),
    activeLineId: TM.state.activeLineId,
    showCodes: TM.state.showCodes !== false,
    numberMode: ['none', 'code', 'full', 'ordinal'].includes(TM.state.numberMode) ? TM.state.numberMode : 'none',
    numModeOverride: !!TM.state.numModeOverride,
    labelSize: TM.state.labelSize || 13,
    lineWidth: TM.state.lineWidth || 8,
    symbolScale: (TM.state.symbolScale || 100) / 100,
    connWidth: TM.state.connWidth || 7,
    hotspots: TM.state.showHotspots,
    ...TM.statusFlagsFrom((t) => TM.state[t.opt] !== false),
    showSuggested: TM.state.showSuggested !== false,
    trimHidden: !!TM.state.trimHidden,
    showFantasy: true,
    interactive: true,
  }, TM.state.svcHi || {}, extra);   // a service being shown (TM.ui.showService): only its route stays lit
})(window.TM);
