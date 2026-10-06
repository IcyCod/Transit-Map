/* Journey planning: builds a graph of rides (any two real stops of one line — or of one service, see store.normService —
   reachable without changing trains, a through service's on more than one line) and
   walks (connecting / unofficial / split-interchange links between different nodes), then ranks several distinct
   ways between two stations, fastest or cheapest first, with Yen's k-shortest-paths algorithm over it.
   Fantasy stations are never part of the graph. Planned / provisional / under-construction / abandoned / demolished stations
   are left out only while their Display toggle is off — a hidden one is skipped exactly like a fantasy stop for
   board/alight purposes, but a line still runs "through" it, so ride time still adds up as if it were really there. */
(function (TM) {
  const router = (TM.route = {});
  const MODE_SPEED = { brt: 25, lrt: 35, mrt: 40, monorail: 30, commuter: 45, intercity: 60, arl: 60, hsr: 160, bus: 22, other: 28 };   // km/h, used only when a line has no travel time of its own
  const WALK_SPEED = 4.5;    // km/h
  const DWELL = 0.5;         // minutes floor added per hop, so two very close stops are never ~0 min apart
  const WALK_OVERHEAD = 2;   // minutes added to a walked link, for leaving/entering a station
  const ROUTES_WANTED = 6;                // how many distinct ways to look for
  const GUARD = 300;          // Yen's outer-loop safety cap

  const fallbackRide = (a, b, mode) => Math.max(DWELL, TM.haversine(a.lat, a.lng, b.lat, b.lng) / 1000 / (MODE_SPEED[mode] || MODE_SPEED.other) * 60 + DWELL);
  const fallbackWalk = (a, b) => Math.max(1, TM.haversine(a.lat, a.lng, b.lat, b.lng) / 1000 / WALK_SPEED * 60 + WALK_OVERHEAD);

  /* flags: { showPlanned, showAbandoned, … } (TM.STATUS_TOGGLES) — a station of a hideable status is usable only when
     its flag is not false; fantasy is always excluded */
  router.allowed = (station, flags) => {
    if (!station || station.status === 'fantasy') return false;
    const toggle = TM.STATUS_TOGGLES.find((x) => x.status === station.status);
    return !toggle || flags[toggle.opt] !== false;
  };

  /* ---------- graph ---------- */
  /* Travel time between two consecutive real stops of a track line (path indices ia → ib, either way): the sum of every
     stored per-item "time to next item" along the path between them — through any waypoint or removed fantasy stop in
     between — when every one of those items has a time; otherwise a distance-based guess. A loop's own closing hop (its
     last stop back to its first) has no stored time to read, so it always falls back. */
  function hopTime(store, line, indexA, indexB, wrap) {
    const low = Math.min(indexA, indexB), high = Math.max(indexA, indexB);
    const total = wrap ? 0 : storedTime(line, low, high, indexA > indexB);
    return total > 0 ? total : fallbackRide(store.stations.get(line.path[indexA].s), store.stations.get(line.path[indexB].s), line.mode);
  }
  /* Stored minutes between path items low < high of a line, forward or back: every stop in between (fantasy ones the
     planner skips included) must carry its "time to the next stop" (back: its timeBack, else time); older data may
     also hold times on bends, which are added in too. 0 when any stop lacks one. */
  function storedTime(line, low, high, back) {
    let total = 0;
    for (let i = low; i < high; i++) {
      const item = line.path[i], time = back && item.timeBack > 0 ? item.timeBack : item.time;
      if (isFinite(time) && time > 0) total += time;
      else if (item.s != null) return 0;
    }
    return total;
  }

  /* One "ride" edge covers a whole trip from one real stop to another, in one direction, without changing trains —
     never just one hop — so a transfer only ever happens between two edges, never inside one. Its parts say which
     stretch of which track line it runs: [{ line, spans: [{ a, b, fwd }], board, alight }] — one part for a ride on a
     single line; a through service running onto another line's track has one part per line. */
  const onePart = (line, board, alight, span) => [{ line, spans: [span], board, alight }];
  function lineEdges(store, line, flags, addEdge) {
    if (router.avoided(line, flags)) return;   // this type of transport, or this very line, is avoided
    const raw = [];
    line.path.forEach((it, i) => { if (it.s && store.stations.has(it.s)) raw.push({ id: it.s, st: store.stations.get(it.s), time: it.time, i }); });
    const stops = raw.filter((r) => r.st.status !== 'fantasy');   // fantasy stops are removed from the line entirely
    const count = stops.length;
    if (count < 2) return;
    const closesLoop = line.loop && count > 2 && store.rep(stops[count - 1].id) !== store.rep(stops[0].id);
    const hopN = closesLoop ? count : count - 1;
    /* hop k = time from stops[k] to stops[(k+1)%n]: the sum of every stored per-item "time to next item" along the
       line's own path between the two — through any waypoint or removed fantasy stop in between — when every one
       of those items has a time; otherwise a distance-based guess for the whole hop. A loop's own closing hop (last
       stop back to the first) has no stored time to read, so it always falls back. */
    /* each hop's time going forward along the path, and going back (a stop's timeBack, when it has one) */
    const hopsOf = (back) => Array.from({ length: hopN }, (_, index) => {
      const stopA = stops[index], stopB = stops[(index + 1) % count], wrap = closesLoop && index === hopN - 1;
      const total = wrap ? 0 : storedTime(line, stopA.i, stopB.i, back);
      return total > 0 ? total : fallbackRide(stopA.st, stopB.st, line.mode);
    });
    const prefixOf = (hops) => { const out = [0]; (closesLoop ? hops.concat(hops) : hops).forEach((h) => out.push(out[out.length - 1] + h)); return out; };
    const prefixF = prefixOf(hopsOf(false)), prefixB = prefixOf(hopsOf(true));
    const distOf = (prefix) => (i, j) => {   // cumulative time over the hops from stop i forward to stop j (wraps for a loop)
      if (!closesLoop) return prefix[j] - prefix[i];
      const steps = ((j - i) % count + count) % count;
      return prefix[i + steps] - prefix[i];
    };
    const dist = distOf(prefixF), distBack = distOf(prefixB);
    /* for the line's timetable (js/schedule.js): minutes from the first stop of each direction to every stop */
    const schedules = line.schedules, timed = schedules ? { fwd: new Map(), back: new Map() } : null;
    if (timed) {
      const lastB = prefixB[count - 1];
      stops.forEach((s, k) => { if (!timed.fwd.has(s.id)) timed.fwd.set(s.id, prefixF[k]); });
      for (let k = count - 1; k >= 0; k--) if (!timed.back.has(stops[k].id)) timed.back.set(stops[k].id, lastB - prefixB[k]);
    }
    const schedOf = (fwd) => (timed ? { s: schedules, dir: fwd ? 'fwd' : 'back', off: fwd ? timed.fwd : timed.back } : null);
    /* every real stop actually passed between stop `from` and stop `to` (exclusive of both), in the order travelled —
       what a rider could ask "what does this ride call at on the way?" and expect back */
    const via = (from, to) => {
      const out = [];
      if (!closesLoop) { if (from < to) for (let k = from + 1; k < to; k++) out.push(stops[k].id); else for (let k = from - 1; k > to; k--) out.push(stops[k].id); }
      else { const steps = ((to - from) % count + count) % count; for (let s = 1; s < steps; s++) out.push(stops[(from + s) % count].id); }
      return out;
    };
    const visible = stops.map((s) => router.allowed(s.st, flags));
    for (let i = 0; i < count; i++) {
      if (!visible[i]) continue;
      for (let j = 0; j < count; j++) {
        if (i === j || !visible[j]) continue;
        const leadA = store.rep(stops[i].id), leadB = store.rep(stops[j].id);
        if (leadA === leadB) continue;
        if (!closesLoop && j < i) continue;   // a straight line only ever goes the two ways already covered by (i,j) and (j,i)
        /* span: the stretch of the line's own path ridden, as raw path indices — forward (i ≤ j, or round a loop) or
           backward — so a map can light exactly that stretch */
        const ride = (from, to, board, alight, time, v, span) => addEdge({ kind: 'ride', line, from, to, board, alight, time, via: v, span, parts: onePart(line, board, alight, span), sched: schedOf(span.fwd) });
        ride(leadA, leadB, stops[i].id, stops[j].id, dist(i, j), via(i, j), { a: stops[i].i, b: stops[j].i, fwd: true });
        /* the same stretch the other way. A loop runs both ways too: i → j against its path order is the stretch j → i
           ridden backwards (the same track and time, its stops in reverse) */
        if (!closesLoop) ride(leadB, leadA, stops[j].id, stops[i].id, distBack(i, j), via(j, i), { a: stops[j].i, b: stops[i].i, fwd: false });
        else ride(leadA, leadB, stops[i].id, stops[j].id, distBack(j, i), via(j, i).reverse(), { a: stops[i].i, b: stops[j].i, fwd: false });
      }
    }
  }

  /* A service's rides (see store.serviceRoute): between every two places it stops at, each way it runs — its whole route in
     between as parts, every station passed as via (those it runs through without stopping listed in skipped too), and
     where it is heading (terminus, for "Look for … towards …"). flags.services: { id: true | false } — this viewer's
     own choice of which services run (default: every one not marked hidden). */
  /* flags.modes: the types of transport allowed (null = every one); flags.avoidLines: ids of lines not to ride (a
     branch goes with its line) */
  router.avoided = (line, flags) => !!flags && ((flags.modes && !flags.modes.has(line.mode)) || (flags.avoidLines && flags.avoidLines.has(TM.store.rootId(line.id))));
  router.serviceOn = (sv, flags) => (flags && flags.services && sv.id in flags.services ? !!flags.services[sv.id] : !sv.hidden);
  function serviceEdges(store, service, flags, addEdge) {
    const serviceRoute = store.serviceRoute(service);
    if (!serviceRoute.ok || !router.serviceOn(service, flags)) return;
    [false, true].forEach((back) => {
      if (back && service.both === false) return;
      let nodes = serviceRoute.nodes.map((x) => x.id), hops = serviceRoute.hops.slice();
      if (back) { nodes = nodes.reverse(); hops = hops.reverse().map((h) => (h.join ? h : { line: h.line, ia: h.ib, ib: h.ia, fwd: !h.fwd, wrap: h.wrap })); }
      /* places in travel order (a join folds two codes of one place), and which the service stops at */
      const loop = serviceRoute.loop, count = loop ? nodes.length - 1 : nodes.length, places = [];
      for (let k = 0; k < count; k++) {
        if (k > 0 && hops[k - 1].join) { const lastPlace = places[places.length - 1]; lastPlace.ids.push(nodes[k]); lastPlace.k1 = k; } else places.push({ ids: [nodes[k]], k0: k, k1: k });
      }
      const pattern = back && service.return ? service.return : service, only = pattern.stops ? new Set(pattern.stops) : null, skip = new Set(pattern.skip || []);
      places.forEach((place, i) => {
        const end = !loop && (i === 0 || i === places.length - 1);
        place.stop = (end || (only ? place.ids.some((id) => only.has(id)) : !place.ids.some((id) => skip.has(id)))) && place.ids.some((id) => router.allowed(store.stations.get(id), flags));
      });
      /* a loop is followed round twice over, so a ride can run past its starting point */
      const span = loop ? count * 2 : count, node = (k) => nodes[k % count], hopAt = (k) => (loop ? hops[k % count] : hops[k]);
      const cumulative = [0];
      for (let k = 0; k < span - 1; k++) { const hop = hopAt(k); cumulative.push(cumulative[k] + (hop.join ? 0 : hopTime(store, hop.line, hop.ia, hop.ib, hop.wrap))); }
      const placeAt = new Map();
      places.forEach((pl, i) => { for (let k = pl.k0; k <= pl.k1; k++) placeAt.set(k, i); });
      const terminus = loop ? null : places[places.length - 1].ids[0];
      /* for the service's timetable: minutes from its first stop (this way round) to each place */
      const timed = service.schedules ? new Map() : null;
      if (timed) for (let k = 0; k < count; k++) if (!timed.has(node(k))) timed.set(node(k), cumulative[k]);
      const stopIdx = places.map((pl, i) => (pl.stop ? i : -1)).filter((i) => i >= 0);
      stopIdx.forEach((fromStop) => stopIdx.forEach((toStop) => {
        if (fromStop === toStop || (!loop && toStop < fromStop)) return;
        const startHop = places[fromStop].k1, endHop = places[toStop].k0 + (loop && toStop < fromStop ? count : 0);
        const board = node(startHop), alight = node(endHop), from = store.rep(board), to = store.rep(alight);
        if (from === to || endHop <= startHop) return;
        const parts = [], via = [], skipped = [];
        for (let k = startHop; k < endHop; k++) {
          const hop = hopAt(k);
          if (k > startHop && !hopAt(k - 1).join) {
            via.push(node(k));
            if (!places[placeAt.get(k % count)].stop) skipped.push(node(k));
          }
          if (hop.join) { parts.push(null); continue; }
          const last = parts[parts.length - 1];
          if (last && last.line === hop.line) { last.spans[last.spans.length - 1].b = hop.ib; last.alight = node(k + 1); }
          else parts.push({ line: hop.line, spans: [{ a: hop.ia, b: hop.ib, fwd: hop.fwd }], board: node(k), alight: node(k + 1) });
        }
        const clean = parts.filter(Boolean);
        if (clean.some((pt) => router.avoided(pt.line, flags))) return;   // runs on a type of transport, or a line, being avoided
        addEdge({ kind: 'ride', line: clean[0].line, service: service, back, terminus, from, to, board, alight, time: cumulative[endHop] - cumulative[startHop], via, skipped, span: clean[0].spans[0], parts: clean, sched: timed ? { s: service.schedules, dir: back ? 'back' : 'fwd', off: timed } : null });
      }));
    });
  }

  /* Fare of one ride, for the fare types picked: each stretch on one network (fares networks) is priced from where it
     boards to where it leaves that network — a through train onto another operator's line pays each operator — falling
     back to adding up its lines' own stretches when that pair has no fare. null when any part is unpriced. */
  function priceRide(store, e) {
    let cost = 0, run = null;
    const runs = [];
    e.parts.forEach((part) => {
      part.net = TM.fares.networkOf(store.rootId(part.line)).id;
      if (run && run.net === part.net) { run.alight = part.alight; run.parts.push(part); } else runs.push(run = { net: part.net, board: part.board, alight: part.alight, parts: [part] });
    });
    e.net = runs[0].net;   // the network boarded (its transfer fee)
    for (const r of runs) {
      let fare = TM.fares.get(store.rep(r.board), store.rep(r.alight), r.net);
      if (fare == null && r.parts.length > 1) fare = r.parts.reduce((x, pt) => (x == null ? null : ((v) => (v == null ? null : x + v))(TM.fares.get(store.rep(pt.board), store.rep(pt.alight), r.net))), 0);
      if (fare == null) return null;
      cost += fare;
    }
    return TM.round2dp(cost);
  }
  router.priceRide = (e) => priceRide(TM.store, e);

  router.build = (flags) => {
    const store = TM.store, adjacency = new Map(), edges = [];
    const addEdge = (e) => {
      e.idx = edges.length; edges.push(e);
      (adjacency.get(e.from) || adjacency.set(e.from, []).get(e.from)).push(e);
    };
    /* every line runs one all-stops service each way — every pair of its stops — unless it is run by its services only
       ("servicesOnly", e.g. a line whose trains never run the whole way); services run on top of that */
    store.trackLines().forEach((l) => { if (!l.servicesOnly) lineEdges(store, l, flags, addEdge); });
    store.services.forEach((sv) => serviceEdges(store, sv, flags, addEdge));
    /* walks: any link between two DIFFERENT nodes — connecting, unofficial, or a split interchange — is free (no
       fare) and takes real time, either its own or a distance-based guess. Same-node interchanges need no edge at
       all: two lines sharing one rep already let the search change trains there, at the fixed transfer cost below. */
    /* one walk per pair of nodes: the same two stations can be linked more than once (e.g. through different members
       of an interchange), and twin edges would let Yen's search slip past a blocked one onto its copy — finding the
       same route again instead of a real alternative. The quickest wins; on a tie, one that stays in the paid area. */
    const walks = new Map();
    store.connections().forEach((connection) => {
      const stationA = store.stations.get(connection.a), stationB = store.stations.get(connection.b);
      if (!router.allowed(stationA, flags) || !router.allowed(stationB, flags)) return;
      const leadA = store.rep(connection.a), leadB = store.rep(connection.b);
      if (leadA === leadB) return;
      const estimate = fallbackWalk(stationA, stationB);
      const timeAB = connection.time || estimate, timeBA = connection.timeBack || connection.time || estimate;   // it may take longer one way
      /* a connecting / unofficial walkway leaves the paid area (tap out, then in again); a split same-platform or
         interchange link stays inside it — see describe's paid segments */
      const tapOut = !(connection.type === 'interchange' || connection.type === 'platform');
      [[leadA, leadB, timeAB], [leadB, leadA, timeBA]].forEach(([from, to, time]) => {   // one walk each way
        const key = from + '>' + to, current = walks.get(key);
        if (!current || time < current.time - 1e-9 || (Math.abs(time - current.time) < 1e-9 && current.tapOut && !tapOut)) walks.set(key, { from, to, time, tapOut });
      });
    });
    walks.forEach(({ from, to, time, tapOut }) => addEdge({ kind: 'walk', from, to, time, cost: 0, tapOut }));
    /* priced for the fare type picked for the line's own network (TM.fares.networkOf) */
    edges.forEach((e) => { if (e.kind === 'ride') e.cost = priceRide(store, e); });
    return { adj: adjacency, edges };
  };

  /* ---------- search ---------- */
  const TRANSFER_MIN = () => (TM.fares.data ? TM.fares.data.transferMinutes : 0) || 3;
  const TRANSFER_FEE = (net) => (TM.fares.data ? TM.fares.transferFee(net) : 0) || 0;   // for boarding a ride of network `net`, with the type picked there

  /* Every ride edge's own weight is boosted by a flat per-boarding constant before the search, so summing edge
     weights along a path with n rides over-counts the constant by exactly one — the first boarding — which is not a
     transfer. That charges the constant once per transfer, without the search needing to track which line you are
     currently on (see the write-up in README → Journey planner). Walks never carry it: ride → walk → ride is one
     transfer, charged once, by the second ride. A 'free' edge (only ever the very first or very last of a path — see
     router.find's super-group start/end) is choosing which exact platform to begin or end at, so it costs nothing.
     'transfers' makes each boarding outweigh any possible difference in time, so the search minimises the number of
     rides first and total time (transfer minutes included) only among equals. */
  const RIDE_WEIGHT = 1e6;
  /* The wait before a ride — at the start of the trip and at every change. With a departure time set (ctx.when, ms)
     and a timetable for the train (e.sched, js/schedule.js): until the next train from that stop at the moment you
     get there (clock: minutes into the trip), or its average wait for a frequency; null when nothing runs. With no time
     set: the train's average wait; a train with no timetable: the map's transfer minutes (fares.json). */
  const ctx = { when: null };
  const avgCache = new WeakMap();
  const waitOf = (e, clock) => {
    const timed = e.sched;
    if (timed && ctx.when != null) return TM.sched.next(timed.s, timed.dir, timed.off, e.board, ctx.when + clock * 60000);
    if (timed) {
      const key = timed.s, cached = avgCache.get(key) || avgCache.set(key, {}).get(key);
      if (!(timed.dir in cached)) cached[timed.dir] = TM.sched.averageWait(timed.s, timed.dir);
      if (cached[timed.dir] != null) return { wait: cached[timed.dir], exact: false };
    }
    return { wait: TRANSFER_MIN(), exact: false, guess: true };
  };
  /* clock: minutes since the start of the trip when the edge is taken (a 'transfers' search counts boardings in
     whole RIDE_WEIGHTs on top, so the minutes are what is left over) */
  const weightOf = (e, criterion, clock) => {
    if (e.kind === 'free') return 0;
    const ride = e.kind === 'ride';
    if (criterion === 'cost') return e.cost == null ? null : e.cost + (ride ? TRANSFER_FEE(e.net) : 0);
    let time = e.time;
    if (ride) { const w = waitOf(e, clock || 0); if (!w) return null; time += w.wait; }
    return criterion === 'transfers' && ride ? RIDE_WEIGHT + time : time;
  };
  const clockOf = (distance, criterion) => (criterion === 'transfers' ? distance % RIDE_WEIGHT : criterion === 'cost' ? 0 : distance);
  /* a path's total weight, taken edge by edge so every wait is worked out at the time it happens */
  const pathCost = (edges, criterion, start) => edges.reduce((d, e) => { const w = weightOf(e, criterion, clockOf(d, criterion)); return w == null ? Infinity : d + w; }, start || 0);

  /* every station (store.complexOf) an edge newly arrives at, in order — each stop a ride passes, then its end — leaving
     out the station it starts from, so a walk between two platforms of one interchange arrives nowhere new */
  const groupsOf = (e) => {
    if (e.groups) return e.groups;
    const out = [], firstGroup = TM.store.complexOf(e.from);
    (e.kind === 'ride' ? e.via.concat([e.to]) : [e.to]).forEach((node) => {
      const group = TM.store.complexOf(node);
      if (group !== (out.length ? out[out.length - 1] : firstGroup)) out.push(group);
    });
    return (e.groups = out);
  };

  /* a plain binary min-heap of [key, value] — the search runs hundreds of times per query, so no re-sorting */
  class Heap {
    constructor() { this.h = []; }
    get size() { return this.h.length; }
    push(key, value) {
      const heap = this.h; let i = heap.length; heap.push([key, value]);
      while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent][0] <= heap[i][0]) break; [heap[parent], heap[i]] = [heap[i], heap[parent]]; i = parent; }
    }
    pop() {
      const heap = this.h, top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last; let i = 0;
        for (;;) {
          const left = 2 * i + 1, right = left + 1; let smallest = i;
          if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
          if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
          if (smallest === i) break;
          [heap[smallest], heap[i]] = [heap[i], heap[smallest]]; i = smallest;
        }
      }
      return top;
    }
  }

  /* bannedGroups: stations (store.complexOf) no edge may newly call at or ride past */
  /* Staying on: two rides in a row on the same line the same way (not services — each is its own train) are one ride
     cut in two — never a different way to go, and with a timetable it would wait twice for the train already ridden. */
  const sameTrain = (a, b) => a && b && a.kind === 'ride' && b.kind === 'ride' && !a.service && !b.service && a.line === b.line && a.span.fwd === b.span.fwd;
  /* entry: the edge the search arrives at source by (a spur's root), so it cannot carry straight on along the same train */
  function dijkstra(graph, source, target, criterion, blockedEdges, bannedGroups, start, entry) {
    const dist = new Map([[source, start || 0]]), prev = new Map(), done = new Set(), heap = new Heap();
    heap.push(start || 0, source);
    while (heap.size) {
      const [distance, node] = heap.pop();
      if (done.has(node)) continue;
      done.add(node);
      if (node === target) break;
      const into = node === source ? entry : prev.get(node) && prev.get(node).e;
      (graph.adj.get(node) || []).forEach((e) => {
        if (blockedEdges.has(e) || sameTrain(into, e) || (bannedGroups.size && groupsOf(e).some((g) => bannedGroups.has(g)))) return;
        const weight = weightOf(e, criterion, clockOf(distance, criterion));
        if (weight == null) return;
        const newDistance = distance + weight;
        if (!dist.has(e.to) || newDistance < dist.get(e.to) - 1e-9) { dist.set(e.to, newDistance); prev.set(e.to, { u: node, e }); heap.push(newDistance, e.to); }
      });
    }
    if (!dist.has(target)) return null;
    const edges = [];
    let current = target;
    while (current !== source) { const previous = prev.get(current); if (!previous) return null; edges.unshift(previous.e); current = previous.u; }
    return { edges, raw: dist.get(target) };
  }

  /* Every station (store.complexOf) a path calls at, in order — a ride edge can itself pass several real stops (see
     lineEdges' via), and those count exactly as much as a board or alight point: two edges of the same line can
     otherwise chain past each other's stops without ever repeating a board/alight node (one running, say, from a stop
     back to the line's own start, the next from there on to the real destination) while still doubling back through
     the same platforms in between. Same platform or an interchange count as one station even on different graph
     nodes, and staying there — walking from one of its platforms to another to change lines — is still one call, not
     two. SRC/DST (a super-group's own choice of which platform to start or end at — see router.find) are not real
     stations and are left out. */
  function stationSeq(source, edges, isVirtual) {
    const sequence = [];
    const at = (n) => { if (isVirtual(n)) return; const group = TM.store.complexOf(n); if (sequence[sequence.length - 1] !== group) sequence.push(group); };
    at(source);
    edges.forEach((e) => { if (e.kind === 'ride') e.via.forEach(at); at(e.to); });
    return sequence;
  }
  /* The station a path calls at twice, if any. */
  function firstRevisit(sequence) {
    const seen = new Set();
    for (const g of sequence) { if (seen.has(g)) return g; seen.add(g); }
    return null;
  }
  /* Where a path walks twice in a row, if anywhere — the index of the first of the two walks. One connecting /
     unofficial link is walked at most once between two rides: a second straight after it only reroutes the same
     change of trains (connecting stations are all linked to each other anyway), or wanders around one station. */
  function doubleWalk(edges) {
    const real = edges.filter((e) => e.kind !== 'free');
    for (let j = 0; j < real.length - 1; j++) if (real[j].kind === 'walk' && real[j + 1].kind === 'walk') return [real[j], real[j + 1]];
    return null;
  }
  /* The shortest path that never calls at any station (including a different platform of it, or merely riding past
     it between two other stops) twice, and never walks twice in a row. Best-first branch and bound: when the
     cheapest path found calls at station g more than once, a valid route either never calls at g (one branch bans g
     outright) or calls there on exactly one of this path's edges that touch g (one branch per such edge, banning the
     others); when it walks twice in a row, a valid route skips one walk or the other (one branch bans each — both at
     once would meet at the same node, so be back to back again). Nothing valid is lost to any branch, unlike simply
     banning g, and since a branch can only cost more than its parent, the first valid path popped is the cheapest
     valid one. Should that take more than VALID_GUARD searches, it settles for the greedy answer instead — keep
     banning whichever station was revisited, or the second walk — which is quick but may miss a better route. */
  const VALID_GUARD = 60;
  function validDijkstra(graph, source, target, criterion, blockedEdges, bannedGroups, isVirtual, start, entry) {
    /* the journey's own origin and destination stations (and the spur's start) can never be banned outright */
    const store = TM.store, keep = new Set(graph.ends);
    if (!isVirtual(source)) keep.add(store.complexOf(source));
    const revisit = (p) => firstRevisit(stationSeq(source, p.edges, isVirtual));
    const queue = [], seen = new Set();
    const push = (edgesBan, groupsBan) => {
      const key = [...edgesBan].map((e) => e.idx).sort((a, b) => a - b).join(',') + '|' + [...groupsBan].sort().join(',');
      if (seen.has(key)) return;
      seen.add(key);
      const path = dijkstra(graph, source, target, criterion, new Set([...blockedEdges, ...edgesBan]), new Set([...bannedGroups, ...groupsBan]), start, entry);
      if (path) queue.push({ p: path, edgesBan, groupsBan });
    };
    push(new Set(), new Set());
    let guard = 0;
    while (queue.length && guard++ < VALID_GUARD) {
      queue.sort((a, b) => a.p.raw - b.p.raw);
      const { p: path, edgesBan, groupsBan } = queue.shift();
      const group = revisit(path);
      if (!group) {
        const walk = doubleWalk(path.edges);
        if (!walk) return path;
        walk.forEach((e) => push(new Set(edgesBan).add(e), groupsBan));
        continue;
      }
      const touching = path.edges.filter((e) => groupsOf(e).includes(group));
      if (!keep.has(group)) push(edgesBan, new Set(groupsBan).add(group));
      touching.forEach((k) => push(new Set([...edgesBan, ...touching.filter((e) => e !== k)]), groupsBan));
    }
    if (!queue.length) return null;
    const groups = new Set(bannedGroups), edges = new Set(blockedEdges);
    for (let i = 0; i < 25; i++) {
      const path = dijkstra(graph, source, target, criterion, edges, groups, start, entry);
      if (!path) return null;
      const group = revisit(path);
      if (!group) { const walk = doubleWalk(path.edges); if (!walk) return path; edges.add(walk[1]); continue; }
      if (!keep.has(group)) groups.add(group);
      else path.edges.filter((e) => groupsOf(e).includes(group)).slice(1).forEach((e) => edges.add(e));   // keep only the first call there
    }
    return null;
  }

  const sameEdges = (a, b) => a.length === b.length && a.every((e, i) => e === b[i]);
  /* what a traveller would see of a path — its legs, with back-to-back rides on one line joined into one (as
     describe does) and the choice of exact start / end platform left out — so two paths that differ only there
     are listed once */
  const legSig = (edges) => {
    const out = [];
    edges.forEach((e) => {
      if (e.kind === 'free') return;
      const last = out[out.length - 1];
      if (e.kind === 'ride' && !e.service && last && !last.svc && last.line === e.line && last.b === e.board) { last.b = e.alight; return; }
      out.push(e.kind === 'ride' ? { line: e.line, a: e.board, b: e.alight, fwd: e.span.fwd, svc: e.service ? e.service.id : '' } : { a: e.from, b: e.to });
    });
    /* a circle line can ride between the same two stops either way round — two different routes; so can two services */
    return out.map((l) => (l.line ? l.line.id + (l.fwd ? '' : '<') + (l.svc ? '@' + l.svc : '') : '~') + ':' + l.a + '>' + l.b).join(' ');
  };

  function yen(graph, source, target, criterion) {
    const isVirtual = (n) => n === source || n === target;   // src/dst here are router.find's own SRC/DST the whole way down
    const first = validDijkstra(graph, source, target, criterion, new Set(), new Set(), isVirtual);
    if (!first) return [];
    first.sig = legSig(first.edges);
    const found = [first], candidates = [];
    let guard = 0;
    while (found.length < ROUTES_WANTED && guard++ < GUARD) {
      const prevEdges = found[found.length - 1].edges;
      for (let i = 0; i < prevEdges.length; i++) {
        const rootEdges = prevEdges.slice(0, i);
        const spurNode = i === 0 ? source : prevEdges[i - 1].to;
        const blockedEdges = new Set();
        found.forEach((p) => { if (p.edges.length > i && sameEdges(p.edges.slice(0, i), rootEdges)) blockedEdges.add(p.edges[i]); });
        /* ban every station the root already called at or rode past (any of its platforms), so the spur can never
           come back through it */
        const bannedGroups = new Set(stationSeq(source, rootEdges, isVirtual));
        /* a root that ends on a walk: the spur must board something next, never walk on again */
        if (i > 0 && rootEdges[i - 1].kind === 'walk') (graph.adj.get(spurNode) || []).forEach((e) => { if (e.kind === 'walk') blockedEdges.add(e); });
        const rootCost = pathCost(rootEdges, criterion);   // the spur starts where (and, with times, when) the root ends
        if (!isFinite(rootCost)) continue;
        const spur = validDijkstra(graph, spurNode, target, criterion, blockedEdges, bannedGroups, isVirtual, rootCost, rootEdges[i - 1]);
        if (!spur) continue;
        const edges = rootEdges.concat(spur.edges);
        if (firstRevisit(stationSeq(source, edges, isVirtual)) || doubleWalk(edges)) continue;   // belt and braces: the whole candidate
        const raw = spur.raw, signature = legSig(edges);
        if (!candidates.some((b) => b.sig === signature) && !found.some((a) => a.sig === signature)) candidates.push({ edges, raw, sig: signature });
      }
      if (!candidates.length) break;
      candidates.sort((a, b) => a.raw - b.raw);
      found.push(candidates.shift());
    }
    return found;
  }

  /* ---------- results ---------- */
  /* Every segment of a line's own path a ride leg covers, as the index k of the segment from path[k] to path[k + 1]
     (a loop's closing segment, last item back to the first, is k = path.length - 1). */
  router.legSegments = (leg) => {
    const count = leg.line.path.length, out = [];
    leg.spans.forEach(({ a: start, b: end, fwd: forward }) => {
      const low = forward ? start : end, high = forward ? end : start;
      for (let k = low; k !== high; k = (k + 1) % count) out.push(k);
    });
    return out;
  };
  /* the same for every track line a ride leg runs on (a through service runs on several): [{ line, segs: [k…] }] */
  router.legLineSegments = (leg) => (leg.parts || [{ line: leg.line, spans: leg.spans }]).map((pt) => ({ line: pt.line, segs: router.legSegments({ line: pt.line, spans: pt.spans }) }));

  /* Time and cost are always both worked out the same way from the legs actually used — regardless of which one the
     search was optimising for — with the transfer minutes / fee charged once per reported transfer. */
  function describe(edges) {
    const legs = [];
    let clock = 0;   // minutes into the trip
    edges.forEach((e) => {
      if (e.kind === 'free') return;   // choosing a platform within a same-station group — not a leg a traveller sees
      if (e.kind === 'ride') {
        const last = legs[legs.length - 1];
        /* two back-to-back rides on one line (never a service's — each is its own train) are one ride */
        if (last && last.kind === 'ride' && !last.service && !e.service && last.line === e.line && last.alight === e.board) {
          last.via = last.via.concat([last.alight], e.via); last.alight = e.alight; last.time += e.time; last.spans.push(e.span);
          last.parts[0].spans.push(e.span); last.parts[0].alight = e.alight;
          if (last.cost != null && e.cost != null) last.cost += e.cost; else last.cost = null;
          clock += e.time;   // the same train: no wait
          return;
        }
        /* waiting for the train: exact (a timetabled one, or the first of the day) or an average; departAt with a time set */
        const w = waitOf(e, clock) || { wait: 0, exact: false, none: true };
        clock += w.wait + e.time;
        legs.push({
          kind: 'ride', line: e.line, net: e.net, board: e.board, alight: e.alight, time: e.time, cost: e.cost, via: e.via.slice(), spans: [e.span],
          parts: e.parts.map((pt) => ({ line: pt.line, net: pt.net, board: pt.board, alight: pt.alight, spans: pt.spans.slice() })),
          service: e.service || null, back: !!e.back, terminus: e.terminus || null, skipped: (e.skipped || []).slice(),
          wait: w.wait, waitExact: !!w.exact, waitGuess: !!w.guess, noService: !!w.none, departAt: ctx.when != null && w.at ? w.at : null,
        });
      } else {
        legs.push({ kind: 'walk', from: e.from, to: e.to, time: e.time, tapOut: e.tapOut });
        clock += e.time;
      }
    });
    const transfers = Math.max(0, legs.filter((l) => l.kind === 'ride').length - 1);
    const time = clock;   // rides, walks and every wait (at the start and at each change)
    /* Paid segments: you tap in at the first ride and out only at the destination, or where you walk a connecting /
       unofficial link (and tap in again after it) — changing lines at a same-platform or interchange station stays
       inside the paid area. A segment costs one fare, from where you tapped in to where you tap out (the pair of
       those two stations), falling back to adding up its rides when that through fare isn't recorded. Changing to a
       line of another network (TM.fares networks — another operator) always starts a new segment. The fare is
       shown on the segment's first ride (leg.fare), and the rest of it carry none. */
    /* Worked out on pieces — each ride leg's stretch on one network (a through train onto another operator's line has
       one per operator: it pays each, though nobody taps out). A fare is shown on the ride its segment starts on. */
    const store = TM.store, segs = [];
    let current = null;
    legs.forEach((leg) => {
      if (leg.kind === 'walk') { if (leg.tapOut) current = null; return; }
      leg.fare = undefined;
      leg.parts.forEach((part) => {
        if (current && current.net === part.net) { current.alight = part.alight; current.pieces.push(part); return; }
        segs.push(current = { net: part.net, leg: leg, board: part.board, alight: part.alight, pieces: [part] });
      });
    });
    let cost = 0;
    segs.forEach((segment) => {
      let fare = TM.fares.get(store.rep(segment.board), store.rep(segment.alight), segment.net);
      if (fare == null) fare = segment.pieces.reduce((x, pt) => { const partFare = TM.fares.get(store.rep(pt.board), store.rep(pt.alight), segment.net); return x == null || partFare == null ? null : x + partFare; }, 0);
      if (fare != null) fare = TM.round2dp(fare);
      segment.leg.fare = segment.leg.fare === undefined ? fare : segment.leg.fare == null || fare == null ? null : TM.round2dp(segment.leg.fare + fare);
      cost = cost == null || fare == null ? null : cost + fare;
    });
    /* each change of train pays the transfer fee of the network boarded */
    if (cost != null) legs.filter((l) => l.kind === 'ride').slice(1).forEach((l) => { cost += TRANSFER_FEE(l.net); });
    return { time: Math.round(time * 10) / 10, cost: cost != null ? TM.round2dp(cost) : null, transfers, legs };
  }

  /* Entering and leaving at one station without riding anywhere (a line's own "inOut" setting): offered when From and
     To are the same station and a line calling there — one not avoided, at a station not hidden — allows it. Priced
     as the station's own pair with itself ("A|A" in fares.json). */
  function inOut(id, opts) {
    const store = TM.store, flags = opts.flags || {}, reps = store.complexReps(id);
    for (const line of store.trackLines()) {
      if (!line.inOut || router.avoided(line, flags)) continue;
      const item = line.path.find((p) => p.s && store.stations.has(p.s) && reps.includes(store.rep(p.s)) && router.allowed(store.stations.get(p.s), flags));
      if (!item) continue;
      const leadId = store.rep(item.s), cost = TM.fares.get(leadId, leadId, TM.fares.networkOf(line.id).id);
      if (opts.by === 'cost' && cost == null) return [];
      return [{ time: 0, cost, transfers: 0, legs: [{ kind: 'inout', line, from: item.s, to: item.s, time: 0, cost }] }];
    }
    return [];
  }

  /* fromId / toId: any station id — same-platform partners, an interchange, and a block's own members are all one
     "station" here (store.complexMembers): the search may start or end at whichever of them gives the best result, at no
     extra cost, though a real transfer BETWEEN two of them mid-journey still costs what it always does.
     opts: { by: 'time' | 'cost' | 'transfers', dir: 'asc' | 'desc', flags }.
     Returns { same: true, results } when both ends are (wholly or partly) the same station — results holding the one
     same-station in-out option when a line there allows it (see inOut), else empty — or { results: [...] } — each
     { time, cost, transfers, legs }: the best few by the chosen measure, listed best-first ('asc') or worst-first
     ('desc') among themselves, ties broken by time, fastest first;
     when by is 'cost', only fully-priced options are returned. */
  /* Searched routes, kept for the last few searches: the k-shortest-paths search is the slow part (up to ~1 s on a
     long trip), and most changes that follow it do not need it again. A fare type change only re-prices the same
     paths — unless the ranking is by cost, where the fares decide which paths are found, so that search is kept per
     fare selection too — and turning the order round (dir) only re-sorts them. Keyed by the two stations, the ranking,
     the Display / transport filters and the map's own data, so anything that could change a path starts afresh. */
  const MEMO_MAX = 12;
  const memo = new Map();
  const flagsKey = (f) => JSON.stringify(Object.keys(f).sort().map((k) => [k, f[k] instanceof Set ? [...f[k]].sort() : f[k]]));
  function searched(fromId, toId, opts) {
    const store = TM.store, flags = opts.flags || {}, criterion = opts.by === 'cost' || opts.by === 'transfers' ? opts.by : 'time';
    ctx.when = opts.when != null ? opts.when : null;   // the departure time the waits are worked out from (none: averages)
    const key = [fromId, toId, criterion, flagsKey(flags), criterion === 'cost' ? JSON.stringify(TM.fares.sel) : '', ctx.when != null ? Math.floor(ctx.when / 60000) : ''].join('\u0001');
    const hit = memo.get(key);
    if (hit && hit.store === store && hit.fares === TM.fares.data) { memo.delete(key); memo.set(key, hit); return hit; }   // most recently used last
    const graph = router.build(flags);
    graph.ends = [store.complexOf(fromId), store.complexOf(toId)];
    /* a walk between two platforms of the origin or destination station itself is never needed — the route may
       already start or end at whichever of them it likes, for free */
    graph.adj.forEach((list, node) => {
      const group = store.complexOf(node);
      if (graph.ends.includes(group)) graph.adj.set(node, list.filter((e) => e.kind !== 'walk' || store.complexOf(e.to) !== group));
    });
    const SRC = '\0from', DST = '\0to';
    const addFree = (a, b) => { const e = { kind: 'free', from: a, to: b, time: 0, cost: 0, idx: graph.edges.length }; graph.edges.push(e); (graph.adj.get(a) || graph.adj.set(a, []).get(a)).push(e); };
    store.complexReps(fromId).forEach((r) => addFree(SRC, r));
    store.complexReps(toId).forEach((r) => addFree(r, DST));
    const out = { store: store, fares: TM.fares.data, found: yen(graph, SRC, DST, criterion) };
    memo.set(key, out);
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    return out;
  }

  router.find = (fromId, toId, opts) => {
    const store = TM.store;
    if (!store.stations.has(fromId) || !store.stations.has(toId)) return { results: [] };
    const fromMembers = store.complexReps(fromId), toMembers = store.complexReps(toId);
    if (fromMembers.some((r) => toMembers.includes(r))) return { same: true, results: inOut(fromId, opts) };
    const { found } = searched(fromId, toId, opts);
    /* priced now, with the fare types picked now — the paths may come from an earlier search */
    const seen = new Set();
    found.forEach((p) => p.edges.forEach((e) => { if (e.kind === 'ride' && !seen.has(e)) { seen.add(e); e.cost = priceRide(store, e); } }));
    ctx.when = opts.when != null ? opts.when : null;
    const results = found.map((p) => describe(p.edges.filter((e) => e.kind !== 'free'))).filter((r) => opts.by !== 'cost' || r.cost != null);
    if (ctx.when != null) results.forEach((r) => { r.leaveAt = ctx.when; r.arriveAt = ctx.when + r.time * 60000; });
    const direction = opts.dir === 'desc' ? -1 : 1;
    const key = (r) => (opts.by === 'cost' ? r.cost : opts.by === 'transfers' ? r.transfers : r.time);
    results.sort((a, b) => direction * (key(a) - key(b)) || a.time - b.time);
    return { results };
  };
})(window.TM);
