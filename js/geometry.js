/* Line geometry: route a path through grid nodes, offset parallel lanes, round the corners. */
(function (TM) {
  const geo = (TM.geo = {});
  const sign = Math.sign, round2dp = TM.round2dp;

  /* Resolve each path item to grid coordinates. */
  geo.anchors = (line) => {
    const out = [];
    line.path.forEach((item, i) => {
      const position = TM.store.itemPos(item);
      if (position) out.push({ i, x: position.x, y: position.y, s: item.s != null ? item.s : null });
    });
    return out;
  };

  /* ---------- circular arcs (schematic) ----------
     Two ways a line can be drawn as true circular arcs instead of grid-routed legs:
     - an arc section: consecutive path items whose "arc" is { b, g } (g = section id, b = bulge: the arc's height over
       the chord from the section's first item to its last, as a fraction of that chord — positive bulges to the left
       of the direction of travel). The items in between sit on that arc (actions.fitArc keeps them there).
     - a circle line: a loop line with circle = { x, y, r } (grid units) — every leg is an arc of that one circle.
     All in grid units. */
  const TAU = Math.PI * 2;
  /* the circle through A and B that bulges b × |AB| to the left of A→B: { cx, cy, r, sw, large, apex } (null when straight) */
  geo.arcFrom = (start, end, bulge) => {
    const dx = end.x - start.x, dy = end.y - start.y, chordLength = Math.hypot(dx, dy);
    if (chordLength < 1e-6 || !bulge || Math.abs(bulge) < 1e-3) return null;
    const normal = { x: dy / chordLength, y: -dx / chordLength };            // left of A→B on screen (y down)
    const sagitta = bulge * chordLength, radius = (sagitta * sagitta + chordLength * chordLength / 4) / (2 * Math.abs(sagitta)), midX = (start.x + end.x) / 2, midY = (start.y + end.y) / 2;
    const centreOffset = sagitta - Math.sign(sagitta) * radius, apex = { x: midX + normal.x * sagitta, y: midY + normal.y * sagitta };
    const cx = midX + normal.x * centreOffset, cy = midY + normal.y * centreOffset;
    const sweep = ((start.x - cx) * (apex.y - cy) - (start.y - cy) * (apex.x - cx)) > 0 ? 1 : 0;   // SVG sweep-flag: 1 = angle increasing
    return { cx, cy, r: radius, sw: sweep, large: Math.abs(sagitta) > radius, apex, A: start, B: end };
  };
  const angleOf = (c, p) => Math.atan2(p.y - c.cy, p.x - c.cx);
  /* how far round the circle c from p to q, going the circle's own way (sw), 0..2π */
  geo.arcSpan = (c, p, q) => { let turn = c.sw ? angleOf(c, q) - angleOf(c, p) : angleOf(c, p) - angleOf(c, q); turn %= TAU; if (turn < 0) turn += TAU; return turn; };
  /* the point of circle c at the angle of p (p pushed straight out / in onto the circle) */
  geo.onCircle = (c, p) => { const angle = angleOf(c, p); return { x: c.cx + Math.cos(angle) * c.r, y: c.cy + Math.sin(angle) * c.r }; };
  /* the point a fraction t of the way along arc c from its A to its B */
  geo.arcPoint = (c, t) => { const angle = angleOf(c, c.A) + (c.sw ? 1 : -1) * geo.arcSpan(c, c.A, c.B) * t; return { x: c.cx + Math.cos(angle) * c.r, y: c.cy + Math.sin(angle) * c.r }; };
  /* how far along arc c (0..1) the point p is — by angle; points off the arc's ends are clamped to the nearer end */
  geo.arcFrac = (circle, point) => {
    const total = geo.arcSpan(circle, circle.A, circle.B), along = geo.arcSpan(circle, circle.A, point);
    if (total < 1e-9) return 0;
    if (along <= total) return along / total;
    return along - total < TAU - along ? 1 : 0;
  };
  /* The arc sections of a line: [{ g, b, i0, i1, arc }] — i0 / i1 the path indices of the section's first and last item
     (i1 may be path.length on a loop: back round to item 0). */
  geo.arcSections = (line) => {
    const path = line.path, count = path.length, out = [];
    if (line.circle || count < 2) return out;
    const at = (i) => TM.store.itemPos(path[i % count]);
    let i = 0;
    while (i < count) {
      const itemArc = path[i].arc;
      if (!itemArc || (i === count - 1 && !line.loop)) { i++; continue; }
      let j = i + 1;
      while (j < count && path[j].arc && path[j].arc.g === itemArc.g && (j < count - 1 || line.loop)) j++;
      const start = at(i), end = at(j);
      if (start && end) out.push({ g: itemArc.g, b: itemArc.b, i0: i, i1: j, arc: geo.arcFrom(start, end, itemArc.b) });
      i = j;
    }
    return out;
  };
  /* A circle line's circle, with the way round it runs (the way its stops go round, by the area they enclose). */
  geo.circleOf = (line) => {
    const circle = line.circle;
    if (!circle || !line.loop || !(circle.r > 0)) return null;
    const points = line.path.map(TM.store.itemPos).filter(Boolean);
    let area = 0;
    points.forEach((p, i) => { const next = points[(i + 1) % points.length]; area += (p.x - circle.x) * (next.y - circle.y) - (p.y - circle.y) * (next.x - circle.x); });
    return { cx: circle.x, cy: circle.y, r: circle.r, sw: area >= 0 ? 1 : 0 };
  };
  /* path index → the circle its leg to the next item is drawn on ({ cx, cy, r, sw }), for every arc leg of the line */
  geo.arcLegs = (line) => {
    const out = new Map();
    const circ = geo.circleOf(line);
    if (circ) { line.path.forEach((it, i) => out.set(i, circ)); return out; }
    geo.arcSections(line).forEach((sec) => { if (sec.arc) for (let i = sec.i0; i < sec.i1; i++) out.set(i % line.path.length, sec.arc); });
    return out;
  };

  /* Elbow node for a non-aligned pair (octilinear or orthogonal); prefers continuing the previous heading. */
  function elbow(start, end, prev, style) {
    const dx = end.x - start.x, dy = end.y - start.y, absDx = Math.abs(dx), absDy = Math.abs(dy);
    if (dx === 0 || dy === 0 || absDx === absDy) return null;
    const stepX = sign(dx), stepY = sign(dy);
    let cands;
    if (style === 'orthogonal') cands = [{ x: end.x, y: start.y }, { x: start.x, y: end.y }];
    else if (absDx > absDy) cands = [{ x: start.x + stepX * (absDx - absDy), y: start.y }, { x: end.x - stepX * (absDx - absDy), y: end.y }];
    else cands = [{ x: start.x, y: start.y + stepY * (absDy - absDx) }, { x: end.x, y: end.y - stepY * (absDy - absDx) }];
    if (!prev) return cands[0];
    const score = (candidate) => {
      const dirX = sign(candidate.x - start.x), dirY = sign(candidate.y - start.y), length = Math.hypot(dirX, dirY) || 1;
      return (dirX * prev.x + dirY * prev.y) / length / (Math.hypot(prev.x, prev.y) || 1);
    };
    return score(cands[1]) > score(cands[0]) ? cands[1] : cands[0];
  }

  /* Expand a line into every grid node it passes through: [{x,y,i,s}] (i = path item index or -1).
     A station or bend placed freely (grid hidden, off-integer coordinates) cannot be split into whole-unit steps —
     its leg is pushed straight through instead, so it still draws correctly; it just does not offer intermediate
     lane-bundling points along that one leg, which only matters for edges actually touching the free point. */
  const whole = (n) => Number.isInteger(n.x) && Number.isInteger(n.y);
  geo.nodeSeq = (line) => {
    const anchors = geo.anchors(line);
    if (line.loop && anchors.length > 2) anchors.push(Object.assign({}, anchors[0]));
    const sequence = [], arcs = geo.arcLegs(line);
    let prev = null, lastI = null;
    anchors.forEach((anchor, index) => {
      if (index === 0) { sequence.push({ x: anchor.x, y: anchor.y, i: anchor.i, s: anchor.s }); lastI = anchor.i; return; }
      const last = sequence[sequence.length - 1];
      if (last.x === anchor.x && last.y === anchor.y) return;
      const arc = arcs.get(lastI);
      lastI = anchor.i;
      if (arc) {                                     // a leg drawn as an arc: straight to the next item, no grid steps
        last.arc = arc;
        sequence.push({ x: anchor.x, y: anchor.y, i: anchor.i, s: anchor.s });
        const radial = { x: anchor.x - arc.cx, y: anchor.y - arc.cy };   // leave heading along the circle's tangent there
        prev = arc.sw ? { x: -radial.y, y: radial.x } : { x: radial.y, y: -radial.x };
        return;
      }
      const e = elbow(last, anchor, prev, line.style);
      const legs = e ? [e, anchor] : [anchor];
      let current = last;
      legs.forEach((target, legIndex) => {
        const dx = target.x - current.x, dy = target.y - current.y, steps = Math.max(Math.abs(dx), Math.abs(dy));
        const stepX = sign(dx), stepY = sign(dy), end = legIndex === legs.length - 1;
        if (whole(current) && whole(target)) {
          for (let s = 1; s <= steps; s++) {
            const last = s === steps && end;
            sequence.push({ x: current.x + stepX * s, y: current.y + stepY * s, i: last ? anchor.i : -1, s: last ? anchor.s : null });
          }
        } else {
          sequence.push({ x: target.x, y: target.y, i: end ? anchor.i : -1, s: end ? anchor.s : null });
        }
        prev = { x: stepX, y: stepY };
        current = target;
      });
    });
    return sequence;
  };

  /* Walkway route between two grid nodes: straight when they are aligned, otherwise one bend (octilinear), corners rounded.
     Returns { d, a, b } — d is an SVG path in world px, a / b the headings (degrees) leaving each end — or null for one node. */
  geo.linkPath = (start, end, radius) => {
    if (start.x === end.x && start.y === end.y) return null;
    const e = elbow(start, end, null, 'octilinear'), sequence = [{ x: start.x, y: start.y, i: -1, s: null }];
    (e ? [e, end] : [end]).forEach((target) => {
      const current = sequence[sequence.length - 1], dx = target.x - current.x, dy = target.y - current.y, steps = Math.max(Math.abs(dx), Math.abs(dy));
      for (let s = 1; s <= steps; s++) sequence.push({ x: current.x + sign(dx) * s, y: current.y + sign(dy) * s, i: -1, s: null });
    });
    const built = geo.build(sequence, null, radius || 20);
    const degrees = (v) => Math.atan2(v.y, v.x) * 180 / Math.PI;
    return { d: built.runs.map((r, i) => (i ? r.d.replace(/^M\S+ \S+/, '') : r.d)).join(''), a: degrees({ x: -built.startDir.x, y: -built.startDir.y }), b: degrees({ x: -built.endDir.x, y: -built.endDir.y }) };
  };

  /* Walkway between two drawn symbols. It leaves from / arrives at the symbols' centres (pa, pb: world px — the circles can sit a
     little off their nodes because of lane offsets and rounded corners) and bends once, at the grid elbow of their nodes (na, nb).
     Returns { d, a, b }: an SVG path with rounded corners and the headings (degrees) leaving each end. */
  geo.linkRoute = (pointA, pointB, nodeA, nodeB, radius, bends) => {
    const GRID = TM.GRID;
    let middle;
    if (bends && bends.length) middle = bends.map((p) => ({ x: p[0] * GRID, y: p[1] * GRID }));   // a user-drawn bend replaces the automatic one
    else { const e = nodeA && nodeB ? elbow(nodeA, nodeB, null, 'octilinear') : null; middle = e ? [{ x: e.x * GRID, y: e.y * GRID }] : []; }
    const points = [pointA, ...middle, pointB];
    const degrees = (p, q) => Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
    return { d: geo.roundedPath(points, radius || 20), a: degrees(pointA, points[1]), b: degrees(pointB, points[points.length - 2]), pts: points };
  };
  /* An SVG path through pts with every corner rounded (radius up to r, less on short legs). */
  geo.roundedPath = (points, maxRadius) => {
    const distance = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);
    let pathData = `M${round2dp(points[0].x)} ${round2dp(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1], corner = points[i], next = points[i + 1], lengthIn = distance(prev, corner), lengthOut = distance(corner, next);
      if (lengthIn < 1 || lengthOut < 1) continue;
      const radius = Math.min(maxRadius, lengthIn / 2, lengthOut / 2);
      pathData += `L${round2dp(corner.x - (corner.x - prev.x) / lengthIn * radius)} ${round2dp(corner.y - (corner.y - prev.y) / lengthIn * radius)}Q${round2dp(corner.x)} ${round2dp(corner.y)} ${round2dp(corner.x + (next.x - corner.x) / lengthOut * radius)} ${round2dp(corner.y + (next.y - corner.y) / lengthOut * radius)}`;
    }
    const e = points[points.length - 1];
    return pathData + `L${round2dp(e.x)} ${round2dp(e.y)}`;
  };
  /* The polyline pts shifted sideways by off along each leg's normal (-dy, dx), corners mitred so parallel copies stay
     evenly apart. */
  geo.offsetLine = (points, off) => {
    const normalOf = (p, q) => { const length = Math.hypot(q.x - p.x, q.y - p.y) || 1; return { x: -(q.y - p.y) / length, y: (q.x - p.x) / length }; };
    return points.map((point, i) => {
      const normalIn = i > 0 ? normalOf(points[i - 1], point) : null, normalOut = i < points.length - 1 ? normalOf(point, points[i + 1]) : null;
      if (!normalIn || !normalOut) { const normal = normalIn || normalOut; return { x: point.x + normal.x * off, y: point.y + normal.y * off }; }
      const mitreX = normalIn.x + normalOut.x, mitreY = normalIn.y + normalOut.y, mitreLength = Math.hypot(mitreX, mitreY);
      if (mitreLength < 1e-6) return { x: point.x + normalIn.x * off, y: point.y + normalIn.y * off };
      const scale = Math.min(4, 1 / ((mitreX / mitreLength) * normalIn.x + (mitreY / mitreLength) * normalIn.y));
      return { x: point.x + (mitreX / mitreLength) * off * scale, y: point.y + (mitreY / mitreLength) * off * scale };
    });
  };
  /* pts cut in two at half its length: [first half, second half] (they share the middle point). */
  geo.splitHalf = (points) => {
    const lengths = points.slice(1).map((q, i) => Math.hypot(q.x - points[i].x, q.y - points[i].y)), half = lengths.reduce((a, b) => a + b, 0) / 2;
    let travelled = 0;
    for (let i = 0; i < lengths.length; i++) {
      if (travelled + lengths[i] >= half) {
        const fraction = lengths[i] ? (half - travelled) / lengths[i] : 0, middle = { x: points[i].x + (points[i + 1].x - points[i].x) * fraction, y: points[i].y + (points[i + 1].y - points[i].y) * fraction };
        return [[...points.slice(0, i + 1), middle], [middle, ...points.slice(i + 1)]];
      }
      travelled += lengths[i];
    }
    return [points, [points[points.length - 1]]];
  };

  /* ---------- block (mega-station) shapes: a ring/perimeter/bar parametrised by t = 0..1 ---------- */
  /* A point on the boundary for t. style: rapidkl | shape; shape: circle | square (shape only); orientation: horizontal |
     vertical (rapidkl only); size = radius (circle) | half-width (square) | half-length (rapidkl), local to the block centre. */
  geo.blockPoint = (style, shape, orientation, size, fraction) => {
    if (style !== 'shape') {
      const offset = (fraction - 0.5) * 2 * size;
      return orientation === 'vertical' ? { x: 0, y: offset } : { x: offset, y: 0 };
    }
    if (shape === 'square') {
      const wrapped = ((fraction % 1) + 1) % 1, side = Math.min(3, Math.floor(wrapped * 4)), edgeFraction = wrapped * 4 - side, sideLength = size * 2;
      return [
        { x: -size + edgeFraction * sideLength, y: -size },   // top: left -> right
        { x: size, y: -size + edgeFraction * sideLength },    // right: top -> bottom
        { x: size - edgeFraction * sideLength, y: size },     // bottom: right -> left
        { x: -size, y: size - edgeFraction * sideLength },    // left: bottom -> top
      ][side];
    }
    const angle = fraction * Math.PI * 2 - Math.PI / 2;   // start at the top, going clockwise
    return { x: Math.cos(angle) * size, y: Math.sin(angle) * size };
  };
  /* The t nearest a given point (local to the block centre) — used to constrain dragging to the ring / perimeter / bar. */
  geo.blockNearestT = (style, shape, orientation, size, point) => {
    if (style !== 'shape') {
      const along = orientation === 'vertical' ? point.y : point.x;
      return Math.min(1, Math.max(0, along / (2 * size) + 0.5));
    }
    if (shape === 'square') {
      const half = size, distances = [Math.abs(point.y + half), Math.abs(point.x - half), Math.abs(point.y - half), Math.abs(point.x + half)];
      const edge = distances.indexOf(Math.min(...distances)), cx = Math.min(half, Math.max(-half, point.x)), cy = Math.min(half, Math.max(-half, point.y));
      const edgeFraction = edge === 0 ? (cx + half) / (2 * half) : edge === 1 ? (cy + half) / (2 * half) : edge === 2 ? (half - cx) / (2 * half) : (half - cy) / (2 * half);
      return Math.min(0.9999, Math.max(0, (edge + Math.min(1, Math.max(0, edgeFraction))) / 4));
    }
    const angle = Math.atan2(point.y, point.x) + Math.PI / 2, fraction = angle / (Math.PI * 2);
    return fraction < 0 ? fraction + 1 : fraction % 1;
  };
  /* Where a ray from the block's centre in direction (dx,dy) first crosses the boundary: { x, y, t } (local to the centre). */
  geo.blockRayHit = (style, shape, orientation, size, dx, dy) => {
    const length = Math.hypot(dx, dy) || 1, unitX = dx / length, unitY = dy / length;
    let point;
    if (style === 'shape' && shape === 'square') {
      const half = size, reachX = unitX !== 0 ? half / Math.abs(unitX) : Infinity, reachY = unitY !== 0 ? half / Math.abs(unitY) : Infinity, reach = Math.min(reachX, reachY);
      point = { x: unitX * reach, y: unitY * reach };
    } else if (style === 'shape') point = { x: unitX * size, y: unitY * size };
    else point = { x: unitX * size, y: unitY * size };
    return Object.assign({ t: geo.blockNearestT(style, shape, orientation, size, point) }, point);
  };

  geo.edgeKey = (start, end) => {
    const swap = start.x > end.x || (start.x === end.x && start.y > end.y);
    return swap ? `${end.x},${end.y}|${start.x},${start.y}` : `${start.x},${start.y}|${end.x},${end.y}`;
  };
  /* Unit normal of an edge in its canonical direction. */
  geo.edgeNormal = (start, end) => {
    const swap = start.x > end.x || (start.x === end.x && start.y > end.y);
    const dx = (swap ? start.x - end.x : end.x - start.x), dy = (swap ? start.y - end.y : end.y - start.y), length = Math.hypot(dx, dy);
    return { x: -dy / length, y: dx / length };
  };

  const dist = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);

  /* Build rounded runs (split at station nodes so each run can be styled) for a node sequence.
     laneVec(a,b,k) -> {x,y} px offset for the edge a→b (k = index of the edge, i.e. seq[k] → seq[k+1]). */
  geo.build = (sequence, laneVec, radius) => {
    if (!sequence.some((n, k) => n.arc && k < sequence.length - 1)) return buildStraight(sequence, laneVec, radius);
    /* legs drawn as arcs: build the straight stretches between them as usual and each arc leg as one SVG arc — a lane
       offset on an arc is a circle of its own around the same centre (r + offset), so parallel lines stay parallel */
    const GRID = TM.GRID, lastIndex = sequence.length - 1, runs = [], positions = new Array(sequence.length);
    let startDir = null, endDir = null, stretchStart = 0;
    const tangent = (arc, p) => { const radial = { x: p.x - arc.cx, y: p.y - arc.cy }, length = Math.hypot(radial.x, radial.y) || 1; return arc.sw ? { x: -radial.y / length, y: radial.x / length } : { x: radial.y / length, y: -radial.x / length }; };
    const flush = (e) => {                           // straight stretch seq[s0..e]
      if (e > stretchStart) {
        const built = buildStraight(sequence.slice(stretchStart, e + 1), laneVec ? (a, b, k) => laneVec(a, b, k + stretchStart) : null, radius);
        built.runs.forEach((r) => runs.push(Object.assign({}, r, { k0: r.k0 + stretchStart, k1: r.k1 + stretchStart })));
        built.pos.forEach((p, k) => { if (!positions[k + stretchStart] || k > 0) positions[k + stretchStart] = p; });
        if (!startDir && stretchStart === 0) startDir = built.startDir;
        if (e === lastIndex) endDir = built.endDir;
      }
    };
    for (let k = 0; k < lastIndex; k++) {
      const arc = sequence[k].arc;
      if (!arc) continue;
      flush(k);
      const start = sequence[k], end = sequence[k + 1], laneVector = laneVec ? laneVec(start, end, k) : { x: 0, y: 0 };
      /* the lane offset is across the chord; across the arc it is along the radius through the arc's middle */
      const span = geo.arcSpan(arc, start, end), midAngle = Math.atan2(start.y - arc.cy, start.x - arc.cx) + (arc.sw ? 1 : -1) * span / 2;
      const off = laneVector.x * Math.cos(midAngle) + laneVector.y * Math.sin(midAngle), laneRadius = Math.max(0.5, arc.r * GRID + off);
      const onArc = (q) => { const angle = Math.atan2(q.y - arc.cy, q.x - arc.cx); return { x: arc.cx * GRID + Math.cos(angle) * laneRadius, y: arc.cy * GRID + Math.sin(angle) * laneRadius }; };
      const startPoint = onArc(start), endPoint = onArc(end);
      runs.push({ d: `M${round2dp(startPoint.x)} ${round2dp(startPoint.y)} A${round2dp(laneRadius)} ${round2dp(laneRadius)} 0 ${span > Math.PI ? 1 : 0} ${arc.sw} ${round2dp(endPoint.x)} ${round2dp(endPoint.y)}`, k0: k, k1: k + 1, i0: start.i, i1: end.i, arc: true });
      if (!positions[k]) positions[k] = startPoint;
      positions[k + 1] = endPoint;
      if (k === 0) { const direction = tangent(arc, start); startDir = { x: -direction.x, y: -direction.y }; }
      if (k + 1 === lastIndex) endDir = tangent(arc, end);
      stretchStart = k + 1;
    }
    flush(lastIndex);
    sequence.forEach((n, k) => { if (!positions[k]) positions[k] = { x: n.x * GRID, y: n.y * GRID }; });
    return { runs, pos: positions, seq: sequence, startDir: startDir || { x: -1, y: 0 }, endDir: endDir || { x: 1, y: 0 } };
  };
  function buildStraight(sequence, laneVec, radius) {
    const GRID = TM.GRID, lastIndex = sequence.length - 1;
    if (lastIndex < 1) return { runs: [], pos: [], seq: sequence };
    const pixels = sequence.map((n) => ({ x: n.x * GRID, y: n.y * GRID }));
    const directions = [], laneOffsets = [];
    for (let k = 0; k < lastIndex; k++) {
      const length = dist(pixels[k], pixels[k + 1]);
      directions.push({ x: (pixels[k + 1].x - pixels[k].x) / length, y: (pixels[k + 1].y - pixels[k].y) / length });
      laneOffsets.push(laneVec ? laneVec(sequence[k], sequence[k + 1], k) : { x: 0, y: 0 });
    }
    const breaks = new Set([0, lastIndex]);
    sequence.forEach((n, k) => { if (n.i >= 0) breaks.add(k); }); // split at every path item (stations and bends) so segments run node to node

    /* 1. offset vertices (miter at turns, jog where the lane changes on a straight) */
    const vertices = [{ x: pixels[0].x + laneOffsets[0].x, y: pixels[0].y + laneOffsets[0].y, k: 0 }];
    for (let k = 1; k < lastIndex; k++) {
      const dirIn = directions[k - 1], dOut = directions[k], laneIn = laneOffsets[k - 1], laneOut = laneOffsets[k];
      const cross = dirIn.x * dOut.y - dirIn.y * dOut.x, dot = dirIn.x * dOut.x + dirIn.y * dOut.y;
      if (Math.abs(cross) < 1e-6) {
        const same = Math.hypot(laneIn.x - laneOut.x, laneIn.y - laneOut.y) < 0.5 || dot < 0;
        vertices.push({ x: pixels[k].x + laneIn.x, y: pixels[k].y + laneIn.y, k });
        if (!same) vertices.push({ x: pixels[k].x + laneOut.x, y: pixels[k].y + laneOut.y, k, jog: true });
      } else {
        const shiftX = laneOut.x - laneIn.x, shiftY = laneOut.y - laneIn.y, along = (shiftX * dOut.y - shiftY * dOut.x) / cross;
        vertices.push({ x: pixels[k].x + laneIn.x + along * dirIn.x, y: pixels[k].y + laneIn.y + along * dirIn.y, k, cx: pixels[k].x, cy: pixels[k].y, turn: true });
      }
    }
    vertices.push({ x: pixels[lastIndex].x + laneOffsets[lastIndex - 1].x, y: pixels[lastIndex].y + laneOffsets[lastIndex - 1].y, k: lastIndex });

    /* 2. drop collinear vertices that are not path items */
    const out = [vertices[0]];
    for (let i = 1; i < vertices.length - 1; i++) {
      const prev = out[out.length - 1], vertex = vertices[i], next = vertices[i + 1];
      const cross = (vertex.x - prev.x) * (next.y - vertex.y) - (vertex.y - prev.y) * (next.x - vertex.x);
      const dot = (vertex.x - prev.x) * (next.x - vertex.x) + (vertex.y - prev.y) * (next.y - vertex.y);
      if (Math.abs(cross) < 1e-3 && dot > 0 && !breaks.has(vertex.k) && !vertex.jog) continue;
      if (dist(prev, vertex) < 0.01) continue;
      out.push(vertex);
    }
    out.push(vertices[vertices.length - 1]);

    /* 3. segments: straight lines + quadratic corners */
    const positions = pixels.map((p, k) => ({ x: p.x + laneOffsets[Math.min(k, lastIndex - 1)].x, y: p.y + laneOffsets[Math.min(k, lastIndex - 1)].y }));
    const segs = [];
    /* which vertices are real corners (the others are just stations / bends sitting on a straight run) */
    const isCorner = out.map((vertex, i) => {
      if (i === 0 || i === out.length - 1) return false;
      const prev = out[i - 1], next = out[i + 1], lengthIn = dist(prev, vertex), lengthOut = dist(vertex, next);
      return lengthIn > 0 && lengthOut > 0 && Math.abs(((vertex.x - prev.x) / lengthIn) * ((next.y - vertex.y) / lengthOut) - ((vertex.y - prev.y) / lengthIn) * ((next.x - vertex.x) / lengthOut)) > 1e-6;
    });
    /* straight length, counted in grid nodes, either side of corner i: how many node steps the line keeps going straight (through
       stations) until the next corner / the end. Counted on the nodes, not the drawn points, so lane offsets cannot stretch it. */
    const runNodes = (i, step) => {
      let j = i + step;
      const jog = (q) => (out[q - 1] && out[q - 1].k === out[q].k) || (out[q + 1] && out[q + 1].k === out[q].k);   // a lane change on a straight is not a turn
      while (j > 0 && j < out.length - 1 && (!isCorner[j] || jog(j))) j += step;
      j = Math.max(0, Math.min(out.length - 1, j));
      return Math.abs(out[j].k - out[i].k);
    };
    for (let i = 1; i < out.length - 1; i++) {
      const prev = out[i - 1], vertex = out[i], next = out[i + 1];
      const lengthIn = dist(prev, vertex), lengthOut = dist(vertex, next);
      const dirIn = { x: (vertex.x - prev.x) / lengthIn, y: (vertex.y - prev.y) / lengthIn };
      const dOut = { x: (next.x - vertex.x) / lengthOut, y: (next.y - vertex.y) / lengthOut };
      const cross = dirIn.x * dOut.y - dirIn.y * dOut.x;
      if (Math.abs(cross) < 1e-6) { segs.push({ t: 'L', x: vertex.x, y: vertex.y, k: breaks.has(vertex.k) ? vertex.k : -1 }); continue; }
      let cornerRadius = radius;
      /* a right-angle turn with more than two nodes of straight line on both sides is drawn much rounder */
      if (Math.abs(dirIn.x * dOut.x + dirIn.y * dOut.y) < 0.2 && runNodes(i, -1) > 2.01 && runNodes(i, 1) > 2.01) cornerRadius = GRID;
      if (vertex.turn) {
        const offsetX = vertex.x - vertex.cx, offsetY = vertex.y - vertex.cy, cx = dOut.x - dirIn.x, cy = dOut.y - dirIn.y;
        cornerRadius += (offsetX * cx + offsetY * cy < 0 ? 1 : -1) * Math.hypot(offsetX, offsetY) * 0.7;
      }
      const limit = Math.min(i === 1 || !isCorner[i - 1] ? lengthIn : lengthIn / 2, i === out.length - 2 || !isCorner[i + 1] ? lengthOut : lengthOut / 2);
      cornerRadius = Math.max(0.5, Math.min(cornerRadius, limit));
      const cornerStart = { x: vertex.x - dirIn.x * cornerRadius, y: vertex.y - dirIn.y * cornerRadius }, cornerEnd = { x: vertex.x + dOut.x * cornerRadius, y: vertex.y + dOut.y * cornerRadius };
      segs.push({ t: 'L', x: cornerStart.x, y: cornerStart.y, k: -1 });
      const cornerMid = { x: (cornerStart.x + 2 * vertex.x + cornerEnd.x) / 4, y: (cornerStart.y + 2 * vertex.y + cornerEnd.y) / 4 };
      segs.push({ t: 'Q', A: cornerStart, V: vertex, C: cornerEnd, M: cornerMid, k: vertex.k });
      if (vertex.turn || !vertex.jog) positions[vertex.k] = cornerMid;
    }
    const last = out[out.length - 1];
    segs.push({ t: 'L', x: last.x, y: last.y, k: lastIndex });

    /* 4. group into runs split at station nodes */
    const runs = [];
    let run = { d: `M${round2dp(out[0].x)} ${round2dp(out[0].y)}`, k0: 0 };
    const close = (nodeIndex, x, y) => {
      run.k1 = nodeIndex; run.i0 = sequence[run.k0].i; run.i1 = sequence[nodeIndex].i; runs.push(run);
      if (nodeIndex !== lastIndex) run = { d: `M${round2dp(x)} ${round2dp(y)}`, k0: nodeIndex };
    };
    segs.forEach((segment) => {
      if (segment.t === 'L') {
        run.d += ` L${round2dp(segment.x)} ${round2dp(segment.y)}`;
        if (segment.k >= 0 && breaks.has(segment.k)) close(segment.k, segment.x, segment.y);
      } else if (breaks.has(segment.k)) {
        run.d += ` Q${round2dp((segment.A.x + segment.V.x) / 2)} ${round2dp((segment.A.y + segment.V.y) / 2)} ${round2dp(segment.M.x)} ${round2dp(segment.M.y)}`;
        close(segment.k, segment.M.x, segment.M.y);
        run.d += ` Q${round2dp((segment.V.x + segment.C.x) / 2)} ${round2dp((segment.V.y + segment.C.y) / 2)} ${round2dp(segment.C.x)} ${round2dp(segment.C.y)}`;
      } else {
        run.d += ` Q${round2dp(segment.V.x)} ${round2dp(segment.V.y)} ${round2dp(segment.C.x)} ${round2dp(segment.C.y)}`;
      }
    });
    return {
      runs, pos: positions, seq: sequence,
      startDir: { x: -directions[0].x, y: -directions[0].y },
      endDir: directions[lastIndex - 1],
    };
  }
})(window.TM);
