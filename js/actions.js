/* User-level operations on the data model (used by canvas, panels and dialogs). */
(function (TM) {
  const actions = (TM.actions = {});
  const store = TM.store;

  /* the line being edited — or one of its branches */
  actions.activeLine = () => store.line(TM.state.activeLineId) || null;
  actions.ownsLine = (line) => !!line && (!!line.local || (!!line.author && line.author === store.author));
  actions.ownsStation = (st) => !!st && (!!st.local || (!!st.author && st.author === store.author));
  /* Whether the open map itself (its background image, etc. — things that belong to the map, not one line/station)
     may be edited: a map made in this browser, or a published map whose "author" matches the current name. */
  actions.ownsMap = () => { const currentMap = TM.maps && TM.maps.current; return !!currentMap && (TM.maps.isUser(currentMap) || (!!currentMap.author && currentMap.author === store.author)); };
  /* Whether a station's own record may be written to keep something about it (a stop suggestion): by default only a station
     made in this browser — a shipped record is not saved in the browser. The local editing server widens this to every file. */
  actions.recordEditable = (st) => !!st && !!st.local;
  actions.canEdit = (line) => !!line && !line.imported && actions.ownsLine(line);
  actions.editable = () => actions.canEdit(actions.activeLine());

  /* Path index of a station on a line, counting its interchange stations as the same station. */
  const indexInGroup = (line, id) => {
    const set = new Set(store.members(id));
    return line ? line.path.findIndex((it) => it.s && set.has(it.s)) : -1;
  };
  const lastIndexInGroup = (line, id) => {
    const set = new Set(store.members(id));
    for (let i = line.path.length - 1; i >= 0; i--) if (line.path[i].s && set.has(line.path[i].s)) return i;
    return -1;
  };
  /* The station of the group that the active line actually lists. */
  actions.memberOnActive = (id) => {
    const line = actions.activeLine();
    if (!line) return id;
    let i = indexInGroup(line, id);
    if (i < 0) { const complex = new Set(store.complexMembers(id)); i = line.path.findIndex((it) => it.s && complex.has(it.s)); }
    return i >= 0 ? line.path[i].s : id;
  };
  /* Every editable track line calling at station id (or a same-platform partner), with the index of its stop there —
     the active line first. [{ line, index }] */
  actions.editableStops = (id) => {
    const activeLine = actions.activeLine();
    return store.trackLines().filter((l) => actions.canEdit(l)).map((line) => ({ line, index: indexInGroup(line, id) }))
      .filter((x) => x.index >= 0).sort((a, b) => (b.line === activeLine) - (a.line === activeLine));
  };

  /* The path item to change a station's per-line display setting on: the active line's own item when it is editable,
     otherwise the item on the highest editable line in the list that calls at the station (or an interchange partner).
     Returns { line, index, item } or null. A symbol is a property of the station, so it needs no active line. */
  actions.itemRef = (id) => {
    const activeLine = actions.activeLine();
    if (actions.canEdit(activeLine)) { const i = indexInGroup(activeLine, id); if (i >= 0) return { line: activeLine, index: i, item: activeLine.path[i] }; }
    const set = new Set(store.members(id));
    for (const l of store.trackLines()) {
      if (!actions.canEdit(l)) continue;
      const i = l.path.findIndex((it) => it.s && set.has(it.s));
      if (i >= 0) return { line: l, index: i, item: l.path[i] };
    }
    return null;
  };
  /* The item to write a symbol choice on: like actions.itemRef, but any station sharing the one drawn symbol (store.shareMembers)
     will do — so a shared interchange symbol can be changed from either side, whichever line you can edit. */
  actions.symbolRef = (id) => {
    const own = actions.itemRef(id);
    if (own) return own;
    const set = new Set(store.shareMembers(id));
    for (const l of store.trackLines()) {
      if (!actions.canEdit(l)) continue;
      const i = l.path.findIndex((it) => it.s && set.has(it.s));
      if (i >= 0) return { line: l, index: i, item: l.path[i] };
    }
    return null;
  };
  /* Same, but only this exact raw station id — see store.itemsOfExact. Used for a block member's own Symbol / Number choice,
     which must not spill onto whichever other same-name interchange partner actions.itemRef would otherwise find first. */
  actions.itemRefExact = (id) => {
    const activeLine = actions.activeLine();
    if (actions.canEdit(activeLine)) { const i = activeLine.path.findIndex((it) => it.s === id); if (i >= 0) return { line: activeLine, index: i, item: activeLine.path[i] }; }
    for (const l of store.trackLines()) {
      if (!actions.canEdit(l)) continue;
      const i = l.path.findIndex((it) => it.s === id);
      if (i >= 0) return { line: l, index: i, item: l.path[i] };
    }
    return null;
  };

  actions.setActive = (id) => {
    TM.state.activeLineId = id && store.line(id) && store.lineFilter.has(store.rootId(id)) ? id : null;
    if (TM.state.activeLineId) store.visible.add(store.rootId(TM.state.activeLineId));
    TM.state.selected = null;
    if (!actions.editable() && ['station', 'route', 'linestyle', 'erase'].includes(TM.state.tool)) TM.state.tool = 'select';
    store.save(); TM.emit('active');
  };

  actions.select = (sel) => { TM.state.selected = sel; if (!sel) TM.state.moving = false; TM.emit('selection'); };

  /* Where the next item goes: after (default) or before the selected item; at the end / start when nothing is selected. */
  actions.insertIndex = () => {
    const line = actions.activeLine(), selection = TM.state.selected, before = TM.state.insertMode === 'before';
    if (!line) return 0;
    let i = -1;
    if (selection && selection.type === 'station') i = lastIndexInGroup(line, selection.id);
    else if (selection && selection.type === 'wp') i = selection.index;
    if (i < 0) return before ? (line.rootId ? 1 : 0) : line.path.length;
    return Math.max(line.rootId ? 1 : 0, before ? i : i + 1);   // nothing goes before a branch's junction
  };
  actions.setInsertMode = (m) => { TM.state.insertMode = m === 'before' ? 'before' : 'after'; TM.emit('tool'); TM.emit('display'); };

  actions.addItem = (item, index) => {
    const line = actions.activeLine();
    if (!actions.canEdit(line)) { TM.toast('Select or create one of your own lines first', 'err'); return -1; }
    const at = index == null ? actions.insertIndex() : index;
    line.path.splice(at, 0, item);
    /* dropped inside an arc section, or onto a circle line: it joins the arc and sits on it */
    const prev = line.path[at - 1], next = line.path[at + 1];
    if (prev && prev.arc && next && (next.arc ? next.arc.g === prev.arc.g : true) && !line.circle) item.arc = Object.assign({}, prev.arc);
    if (item.arc || line.circle) actions.snapOntoArc(line, at);
    store.save();
    return at;
  };

  actions.addStationToLine = (id, index) => {
    const line = actions.activeLine();
    if (line && indexInGroup(line, id) >= 0) { TM.toast('Already on this line'); actions.select({ type: 'station', id: actions.memberOnActive(id) }); return; }
    if (line && !actions.canEdit(line)) { if (actions.suggestStation(id)) actions.select({ type: 'station', id }); return; }   // not your line: propose it instead
    if (store.stations.get(id)) store.nodeOf(id);
    const at = actions.addItem({ s: id }, index);
    if (at >= 0) actions.select({ type: 'station', id });
  };

  /* ---------- suggested stops: propose a station as a stop on a line you cannot edit ---------- */
  /* The stop the suggestion would follow, from the selected stop and the Before / After switch (null = the start). */
  actions.suggestAnchor = () => {
    const line = actions.activeLine();
    if (!line) return null;
    for (let j = actions.insertIndex() - 1; j >= 0; j--) if (line.path[j] && line.path[j].s) return line.path[j].s;
    return null;
  };
  actions.suggestStation = (stationId, note) => {
    const line = actions.activeLine(), station = store.stations.get(stationId);
    if (!line || !station) return false;
    if (actions.canEdit(line)) { TM.toast('This is your line — add it directly'); return false; }
    if (store.members(stationId).some((m) => line.path.some((it) => it.s === m))) { TM.toast('Already on this line'); return false; }
    const after = actions.suggestAnchor();
    if (!store.addSuggestion({ station: stationId, line: line.id, after, author: store.author, note })) return false;
    store.visible.add(line.id);
    TM.toast(`${stationId} suggested for ${line.code}${after ? ' after ' + after : ' at the start'}`);
    TM.emit('visibility');
    return true;
  };
  /* The real path index a suggested stop would take (where it goes among the line's own items). */
  const realIndexOf = (line, station) => {
    const withSuggestions = store.pathWithSuggestions(line);
    const index = withSuggestions ? withSuggestions.findIndex((p) => p.sug && p.station === station) : -1;
    return index < 0 ? line.path.length : withSuggestions.slice(0, index).filter((p) => p.orig >= 0).length;
  };
  /* The line's owner takes a suggestion: the stop joins the real line and the suggestion is used up. */
  actions.acceptSuggestion = (station, lineId) => {
    const line = store.line(lineId), suggestion = store.suggestions().find((x) => x.station === station && x.line === lineId);
    if (!line || !suggestion) return false;
    if (!actions.canEdit(line)) { TM.toast('Only the line\'s owner can accept a suggestion', 'err'); return false; }
    store.nodeOf(station);
    line.path.splice(realIndexOf(line, station), 0, { s: station });
    store.removeSuggestion(station, lineId);
    TM.toast(`${station} added to ${line.code}`);
    actions.select({ type: 'station', id: station });
    return true;
  };
  /* Turn a suggestion down (the line's owner) or take back your own. */
  actions.dismissSuggestion = (station, lineId) => {
    const line = store.line(lineId), suggestion = store.suggestions().find((x) => x.station === station && x.line === lineId);
    if (!line || !suggestion) return false;
    if (!actions.canEdit(line) && !(suggestion.author && suggestion.author === store.author)) { TM.toast('Only the line\'s owner or whoever suggested it can remove it', 'err'); return false; }
    store.removeSuggestion(station, lineId);
    TM.toast('Suggestion removed');
    return true;
  };

  actions.addWaypoint = (x, y) => {
    const at = actions.addItem({ x, y });
    if (at >= 0) actions.select({ type: 'wp', index: at });
  };

  /* Point marker (TM.MARKS) on a bend of the line being edited: { k, s } or null to take it off. */
  actions.setMark = (index, mark) => {
    const line = actions.activeLine(), item = line && line.path[index];
    if (!actions.canEdit(line) || !item) return false;
    const mk = TM.normMark(mark);
    if (mk) item.mk = mk; else delete item.mk;
    store.save(); return true;
  };
  /* the same on a real-map route bend (index i of the stretch a → b, in that direction) */
  actions.setGeoMark = (lineId, stationA, stationB, i, mark) => {
    const line = store.line(lineId), bends = store.routeBends(line, stationA, stationB).map((p) => p.slice());
    if (!bends[i]) return false;
    const mk = TM.normMark(mark);
    bends[i] = mk ? [bends[i][0], bends[i][1], mk] : [bends[i][0], bends[i][1]];
    return actions.setBends(lineId, stationA, stationB, bends);
  };

  actions.removeItem = (index) => {
    const line = actions.activeLine();
    if (!actions.canEdit(line) || !line.path[index]) return;
    if (line.rootId && index === 0) { TM.toast('That is where the branch joins its line — remove the whole branch instead (left panel)', 'err'); return; }
    const gone = line.path.splice(index, 1)[0], prev = line.path[index - 1];
    if (gone && prev && prev.arc && (!gone.arc || gone.arc.g !== prev.arc.g)) delete prev.arc;
    TM.state.selected = null;
    store.save(); TM.emit('selection');
    const station = gone && gone.s && store.stations.get(gone.s);
    if (station && actions.ownsStation(station) && !store.trackLines().some((l) => l.path.some((it) => it.s === station.id))
      && confirm(`${TM.nameOf(station, TM.state.langs[0]) || station.id} is no longer on any line.\n\nAlso erase it from the map data? (Cancel keeps it as a station without a line.)`)) {
      store.removeStation(station.id);
      TM.toast(`${station.id} erased`);
    }
  };

  /* Put a station and all its interchange partners on a node. Only stations you own move — a partner you don't own
     (e.g. the other side of an interchange, owned by someone else) is skipped and stays where it is. */
  function place(id, node) {
    store.members(id).forEach((memberId) => {
      const member = store.stations.get(memberId);
      if (!actions.ownsStation(member)) return;
      if (member.node && member.node.x === node.x && member.node.y === node.y) return;
      member.node = { x: node.x, y: node.y };
    });
    store.save();
  }
  /* If id belongs to a block, every member of it (interchange complex + merged connecting stations) — a node any of them
     already sits at is a legitimate target, and they all move together, so the block never leaves one behind. */
  function blockMoveSet(id) {
    const leadId = store.rep(id), ownerId = store.blockOwnerOf(id);
    if (!ownerId) return null;
    const block = store.stations.get(ownerId).block;
    const raw = [...store.complexMembers(ownerId), ...(block.merged || []).filter((m) => store.stations.has(m))];
    return new Set(raw.map((m) => store.rep(m)).concat(leadId));
  }
  actions.moveStation = (id, node) => {
    const station = store.stations.get(id);
    if (!station) return false;
    if (!actions.ownsStation(station)) { TM.toast('Not your station to move', 'err'); return false; }
    const leadId = store.rep(id), blockReps = blockMoveSet(id);
    const other = store.stationAt(node.x, node.y);
    const allowed = !other || other === leadId || store.isSplitPartner(id, other) || (blockReps && blockReps.has(other));   // interchange partners with different names — or the rest of the same block — may share a node
    if (other && !allowed) { TM.toast('That node already holds a station', 'err'); return false; }
    const current = store.nodeOf(id);
    if (current && current.x === node.x && current.y === node.y && (!blockReps || blockReps.size < 2)) return false;
    const snap = arcSnapshot();
    place(id, node);
    if (blockReps) blockReps.forEach((r) => { if (r !== leadId) place(r, node); });
    arcRefit(snap);
    return true;
  };

  const round2dp = TM.round2dp;
  /* put path item it at p (grid units, free — off the node grid) without the checks of a hand move */
  function setItemPos(item, point) {
    const node = { x: round2dp(point.x), y: round2dp(point.y) };
    if (item.s == null) { item.x = node.x; item.y = node.y; return; }
    if (!actions.ownsStation(store.stations.get(item.s))) return;
    const blockReps = blockMoveSet(item.s), leadId = store.rep(item.s);
    place(item.s, node);
    if (blockReps) blockReps.forEach((q) => { if (q !== leadId) place(q, node); });
  }
  const arcLines = () => store.trackLines().filter((l) => l.circle || l.path.some((it) => it.arc));
  /* Before something moves: every arc section with where its ends are and how far along it each stop in between sits.
     After (arcRefit): a section whose end moved is redrawn between its ends' new places with the same bulge, the stops
     in between keeping their places along it; a circle line's stops are put back onto their circle. */
  function arcSnapshot() {
    return arcLines().map((line) => ({ line, secs: TM.geo.arcSections(line).filter((section) => section.arc).map((section) => {
      const count = line.path.length, inner = [];
      for (let k = section.i0 + 1; k < section.i1; k++) inner.push({ it: line.path[k % count], t: TM.geo.arcFrac(section.arc, store.itemPos(line.path[k % count])) });
      return { sec: section, a: store.itemPos(line.path[section.i0]), b: store.itemPos(line.path[section.i1 % count]), inner };
    }) }));
  }
  function arcRefit(snap) {
    snap.forEach(({ line, secs }) => {
      const count = line.path.length;
      secs.forEach(({ sec: section, a: startBefore, b: endBefore, inner }) => {
        const startNow = store.itemPos(line.path[section.i0]), endNow = store.itemPos(line.path[section.i1 % count]);
        if (!startNow || !endNow) return;
        const arc = TM.geo.arcFrom(startNow, endNow, section.b);
        if (!arc) return;
        if (startNow.x !== startBefore.x || startNow.y !== startBefore.y || endNow.x !== endBefore.x || endNow.y !== endBefore.y) { inner.forEach(({ it, t }) => setItemPos(it, TM.geo.arcPoint(arc, t))); return; }
        inner.forEach(({ it: item }) => {                    // ends stayed: a stop in between that was moved off the arc goes back onto it
          const point = store.itemPos(item);
          if (point && Math.abs(Math.hypot(point.x - arc.cx, point.y - arc.cy) - arc.r) > 0.02) setItemPos(item, TM.geo.arcPoint(arc, Math.min(0.995, Math.max(0.005, TM.geo.arcFrac(arc, point)))));
        });
      });
      if (line.circle) onCircle(line);
    });
  }
  function onCircle(line) {
    const circle = line.circle, circ = { cx: circle.x, cy: circle.y, r: circle.r };
    line.path.forEach((item) => {
      const point = store.itemPos(item);
      if (point && Math.abs(Math.hypot(point.x - circle.x, point.y - circle.y) - circle.r) > 0.02) setItemPos(item, TM.geo.onCircle(circ, point.x === circle.x && point.y === circle.y ? { x: circle.x + 1, y: circle.y } : point));
    });
  }
  /* The arc path item i of line is on, as drawn: its circle (with A/B/span for a section), or null */
  actions.arcOfItem = (line, i) => {
    if (!line) return null;
    if (line.circle) return { circle: true, cx: line.circle.x, cy: line.circle.y, r: line.circle.r };
    const count = line.path.length;
    const section = TM.geo.arcSections(line).find((x) => x.arc && ((i > x.i0 && i < x.i1) || (x.i1 >= count && i + count < x.i1 && i + count > x.i0)));
    return section ? Object.assign({ sec: section }, section.arc) : null;
  };
  /* Where p lands when an item of line that lives on an arc is dragged there: on its circle (a circle line, anywhere
     round it) or on its section's arc, between the section's two ends. */
  actions.constrainToArc = (line, i, point) => {
    const arc = actions.arcOfItem(line, i);
    if (!arc) return null;
    if (arc.circle) { const circlePoint = TM.geo.onCircle(arc, point); return { x: round2dp(circlePoint.x), y: round2dp(circlePoint.y) }; }
    const fraction = Math.min(0.995, Math.max(0.005, TM.geo.arcFrac(arc, point))), arcPoint = TM.geo.arcPoint(arc, fraction);
    return { x: round2dp(arcPoint.x), y: round2dp(arcPoint.y) };
  };
  actions.snapOntoArc = (line, i) => {
    const item = line.path[i], arc = actions.arcOfItem(line, i), point = store.itemPos(item);
    if (arc && point) setItemPos(item, actions.constrainToArc(line, i, point));
  };
  const newArcId = () => Math.random().toString(36).slice(2, 7);
  /* Turn the stretch of line between path items i and j (either order) into one arc section. The bulge starts on the
     side the stops in between already lean to (a gentle curve when there are none). */
  actions.addArc = (line, i, j) => {
    if (!actions.canEdit(line) || line.circle) return false;
    if (i > j) [i, j] = [j, i];
    if (j - i < 1 || !line.path[i] || !line.path[j]) return false;
    const start = store.itemPos(line.path[i]), end = store.itemPos(line.path[j]);
    if (!start || !end || (start.x === end.x && start.y === end.y)) { TM.toast('Those two stops sit on the same spot', 'err'); return false; }
    const chordLength = Math.hypot(end.x - start.x, end.y - start.y), inner = [];
    let side = 0, farthest = 0;
    for (let k = i + 1; k < j; k++) {
      const point = store.itemPos(line.path[k]);
      if (!point) continue;
      const offset = ((end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)) / chordLength;   // + = right of a→b on screen
      side += offset; farthest = Math.max(farthest, Math.abs(offset));
      inner.push({ it: line.path[k], t: ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / (chordLength * chordLength) });
    }
    const bulge = (side > 0 ? -1 : 1) * Math.min(1, Math.max(0.15, farthest / chordLength || 0.25));
    /* the stops in between keep their order, spread out if they would bunch at an end */
    inner.forEach((x, k) => { x.t = Math.min(0.97, Math.max(0.03, x.t)); if (k && x.t <= inner[k - 1].t) x.t = Math.min(0.99, inner[k - 1].t + 0.01); });
    if (inner.some((x, k) => k && x.t <= inner[k - 1].t)) inner.forEach((x, k) => { x.t = (k + 1) / (inner.length + 1); });
    const arcId = newArcId();
    for (let k = i; k < j; k++) line.path[k].arc = { b: bulge, g: arcId };
    if (line.path[j].arc && line.path[j].arc.g === arcId) delete line.path[j].arc;
    const arc = TM.geo.arcFrom(start, end, bulge);
    inner.forEach(({ it, t }) => setItemPos(it, TM.geo.arcPoint(arc, t)));
    store.save();
    return true;
  };
  /* A new bulge for the arc section starting at path item i0 (|b| under ~0.02 straightens it) */
  actions.setArcBulge = (line, firstIndex, bulge) => {
    if (!actions.canEdit(line)) return;
    const section = TM.geo.arcSections(line).find((x) => x.i0 === firstIndex);
    if (!section) return;
    if (Math.abs(bulge) < 0.02) { actions.removeArc(line, firstIndex); return; }
    bulge = Math.max(-3, Math.min(3, bulge));
    const count = line.path.length, inner = [];
    for (let k = section.i0 + 1; k < section.i1; k++) inner.push({ it: line.path[k % count], t: section.arc ? TM.geo.arcFrac(section.arc, store.itemPos(line.path[k % count])) : (k - section.i0) / (section.i1 - section.i0) });
    for (let k = section.i0; k < section.i1; k++) line.path[k % count].arc.b = Math.round(bulge * 1e4) / 1e4;
    const arc = TM.geo.arcFrom(store.itemPos(line.path[section.i0]), store.itemPos(line.path[section.i1 % count]), bulge);
    if (arc) inner.forEach(({ it, t }) => setItemPos(it, TM.geo.arcPoint(arc, t)));
    store.save();
  };
  actions.removeArc = (line, firstIndex) => {
    if (!actions.canEdit(line)) return;
    const section = TM.geo.arcSections(line).find((x) => x.i0 === firstIndex);
    if (!section) return;
    for (let k = section.i0; k < section.i1; k++) delete line.path[k % line.path.length].arc;
    store.save();
    TM.toast('Arc removed — the stretch is routed on the grid again');
  };
  /* A loop line drawn as one circle, round the middle of its stops at their average distance; each stop keeps its
     direction from the centre. */
  actions.makeCircle = (line) => {
    if (!actions.canEdit(line) || !line.loop || line.rootId) { TM.toast('Only a loop line of your own can be a circle', 'err'); return false; }
    const points = line.path.map(store.itemPos).filter(Boolean);
    if (points.length < 3) { TM.toast('A circle needs at least three stops', 'err'); return false; }
    const cx = points.reduce((a, p) => a + p.x, 0) / points.length, cy = points.reduce((a, p) => a + p.y, 0) / points.length;
    const radius = Math.max(1, points.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / points.length);
    line.path.forEach((it) => delete it.arc);
    line.circle = { x: round2dp(cx), y: round2dp(cy), r: round2dp(radius) };
    onCircle(line);
    store.save();
    return true;
  };
  /* Move / resize a circle line's circle: every stop keeps its direction from the centre. */
  actions.setCircle = (line, patch) => {
    if (!actions.canEdit(line) || !line.circle) return;
    const before = line.circle, after = { x: round2dp(patch.x != null ? patch.x : before.x), y: round2dp(patch.y != null ? patch.y : before.y), r: round2dp(Math.max(0.5, patch.r != null ? patch.r : before.r)) };
    line.path.forEach((item) => {
      const point = store.itemPos(item);
      if (!point) return;
      const angle = Math.atan2(point.y - before.y, point.x - before.x);
      setItemPos(item, { x: after.x + Math.cos(angle) * after.r, y: after.y + Math.sin(angle) * after.r });
    });
    line.circle = after;
    store.save();
  };
  actions.removeCircle = (line) => { if (actions.canEdit(line) && line.circle) { line.circle = null; store.save(); TM.toast('Circle removed — the line is routed on the grid again'); } };

  /* Change a station's real-world coordinates (drag on the real map, or Move station to point). Only your own stations
     may be moved — see actions.ownsStation. */
  actions.moveStationGeo = (id, lat, lng) => {
    const station = store.stations.get(id);
    if (!actions.ownsStation(station)) { TM.toast('Not your station to move', 'err'); return false; }
    lat = Math.round(+lat * 1e6) / 1e6; lng = Math.round(+lng * 1e6) / 1e6;
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
    if (Math.abs(station.lat - lat) < 1e-7 && Math.abs(station.lng - lng) < 1e-7) return false;
    station.lat = lat; station.lng = lng;
    store.save();
    return true;
  };

  /* Real-map route bends of the segment a → b of a line: the points the railway passes between the two stations.
     They belong to the real map only — the schematic never reads them. Only a line you own may be reshaped. */
  actions.setBends = (lineId, stationA, stationB, points) => {
    const line = store.line(lineId);
    if (!actions.ownsLine(line)) { TM.toast('Not your line to reshape', 'err'); return false; }
    const clean = points.map((p) => { const q = [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6], mk = TM.normMark(p[2]); if (mk) q.push(mk); return q; }).filter((p) => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
    /* keep each piece's own line style with it: pieces not touching an added / removed bend keep theirs, a new
       piece takes the style of the one it was split from (a moved bend keeps them all as they were) */
    const old = store.routeBends(line, stationA, stationB), styles = store.geoSegOf(line, stationA, stationB);
    if (styles.length && clean.length !== old.length) {
      const oldPoints = [null, ...old, null], newPoints = [null, ...clean, null], same = (p, q) => p && q && p[0] === q[0] && p[1] === q[1];
      const out = [];
      let oldIndex = 0;
      for (let j = 0; j < newPoints.length - 1; j++) {
        out.push(styles[oldIndex] || null);
        const match = j + 1 === newPoints.length - 1 ? oldPoints.length - 1 : oldPoints.findIndex((p, k) => k > oldIndex && same(p, newPoints[j + 1]));
        if (match > 0) oldIndex = match;
      }
      actions.setGeoSegAll(line, stationA, stationB, out);
    }
    /* a line that ships with the map keeps its new route in this browser (store.bendEdits), apart from the shipped one */
    if (!line.local && line.origBends === undefined) line.origBends = JSON.parse(JSON.stringify(line.geoBends || {}));
    const geoBends = line.geoBends || (line.geoBends = {});
    delete geoBends[stationB + '>' + stationA];
    if (clean.length) geoBends[stationA + '>' + stationB] = clean; else delete geoBends[stationA + '>' + stationB];
    if (!line.local) store.bendEdits[line.id] = line.geoBends;
    store.save();
    return true;
  };
  /* Real-map line style of one piece (index j of the stretch a → b, n pieces in all): a TM.SEG_STYLES key, or null to
     follow the schematic again. Only a line you own may be restyled. */
  actions.setGeoSegAll = (line, stationA, stationB, styles) => {
    const geoSegments = line.geoSeg || (line.geoSeg = {});
    delete geoSegments[stationB + '>' + stationA];
    const clean = styles.map((v) => (TM.SEG_STYLES[v] ? v : null));
    while (clean.length && clean[clean.length - 1] == null) clean.pop();
    if (clean.length) geoSegments[stationA + '>' + stationB] = clean; else delete geoSegments[stationA + '>' + stationB];
  };
  actions.setGeoSeg = (lineId, stationA, stationB, j, style) => {
    const line = store.line(lineId);
    if (!actions.canEdit(line)) { TM.toast('Not your line to restyle', 'err'); return false; }
    const styles = store.geoSegOf(line, stationA, stationB);
    while (styles.length <= j) styles.push(null);
    styles[j] = style;
    actions.setGeoSegAll(line, stationA, stationB, styles);
    store.save();
    return true;
  };
  actions.bendTotal = (l) => Object.values((l && l.geoBends) || {}).reduce((n, p) => n + p.length, 0);
  actions.resetBends = (lineId) => {
    const line = store.line(lineId);
    if (!line) return false;
    if (actions.ownsLine(line)) line.geoBends = {};
    else { line.geoBends = JSON.parse(JSON.stringify(line.origBends || {})); delete store.bendEdits[line.id]; delete line.origBends; }
    store.save();
    return true;
  };

  /* ---------- blocks (mega-stations) ---------- */
  const blockOf = (repId) => { const station = store.stations.get(repId); return station && station.block; };
  function writeBlock(repId, next) {
    const station = store.stations.get(repId);
    if (!station) return false;
    if (!actions.ownsStation(station)) {
      if (!Object.prototype.hasOwnProperty.call(store.blockEdits, repId)) station.origBlock = station.block;
      store.blockEdits[repId] = next;
    }
    station.block = next;
    store.save();
    return true;
  }
  const BLANK_BLOCK = { style: 'rapidkl', shape: 'circle', orientation: 'horizontal', size: null, label: '', color: null, members: {}, edges: {}, bundles: {}, symbol: {}, num: {}, labelPos: {}, merged: [] };
  const wrapT = (t) => { const wrapped = t % 1; return wrapped < 0 ? wrapped + 1 : wrapped; };
  actions.enableBlock = (repId) => writeBlock(repId, blockOf(repId) || Object.assign({}, BLANK_BLOCK));
  actions.disableBlock = (repId) => writeBlock(repId, null);
  actions.setBlockStyle = (repId, style) => { const block = blockOf(repId); return block ? writeBlock(repId, Object.assign({}, block, { style: style === 'shape' ? 'shape' : 'rapidkl' })) : false; };
  actions.setBlockShape = (repId, shape) => { const block = blockOf(repId); return block ? writeBlock(repId, Object.assign({}, block, { shape: shape === 'square' ? 'square' : 'circle' })) : false; };
  actions.setBlockOrientation = (repId, orientation) => { const block = blockOf(repId); return block ? writeBlock(repId, Object.assign({}, block, { orientation: orientation === 'vertical' ? 'vertical' : 'horizontal' })) : false; };
  actions.setBlockSize = (repId, size) => { const block = blockOf(repId); return block ? writeBlock(repId, Object.assign({}, block, { size: isFinite(size) && size > 0 ? Math.round(size) : null })) : false; };
  /* A member's position along the block's ring / perimeter / bar: t = 0..1, wrapping. */
  actions.moveBlockMember = (repId, memberId, fraction) => {
    const block = blockOf(repId);
    if (!block) return false;
    return writeBlock(repId, Object.assign({}, block, { members: Object.assign({}, block.members, { [memberId]: wrapT(fraction) }) }));
  };
  actions.setBlockLabel = (repId, label) => { const block = blockOf(repId); return block ? writeBlock(repId, Object.assign({}, block, { label: String(label || '').trim().slice(0, 60) })) : false; };
  actions.setBlockColor = (repId, color) => { const block = blockOf(repId); return block ? writeBlock(repId, Object.assign({}, block, { color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : null })) : false; };
  /* Group stations together inside the block (one shared symbol) or split them apart again — a view of this block only,
     the real interchange / connecting data is never touched. group = '' (or the id's own singleton) splits it off. */
  actions.setBlockGroup = (repId, memberId, group) => {
    const block = blockOf(repId);
    if (!block) return false;
    const bundles = Object.assign({}, block.bundles);
    const groupKey = String(group || '').trim().slice(0, 24);
    if (groupKey) bundles[memberId] = groupKey; else delete bundles[memberId];
    return writeBlock(repId, Object.assign({}, block, { bundles }));
  };
  /* A ring slot's symbol / number, for this block's own view only — it never touches the real per-line symbol/num the
     station would otherwise be drawn with outside the block (or if the block is later removed). */
  actions.setBlockSymbol = (repId, key, symbolKind) => {
    const block = blockOf(repId);
    if (!block) return false;
    const symbol = Object.assign({}, block.symbol);
    if (symbolKind && symbolKind !== 'auto') symbol[key] = symbolKind; else delete symbol[key];
    return writeBlock(repId, Object.assign({}, block, { symbol }));
  };
  actions.setBlockNum = (repId, key, value) => {
    const block = blockOf(repId);
    if (!block) return false;
    const numbers = Object.assign({}, block.num);
    if (value === true || value === false) numbers[key] = value; else delete numbers[key];
    return writeBlock(repId, Object.assign({}, block, { num: numbers }));
  };
  /* The block's own name label — position, offset, hide, font size — belongs to the block itself, never to a station's
     line item (a block's owner or members may not even have one you can edit). Merge-patch, like actions.setItem's label. */
  actions.setBlockLabelPos = (repId, patch) => {
    const block = blockOf(repId);
    if (!block) return false;
    const merged = Object.assign({}, block.labelPos, patch);
    if (patch.reset) { merged.dx = 0; merged.dy = 0; }
    if (patch.resetSize) delete merged.size;
    const clean = {};
    if (merged.pos) clean.pos = merged.pos;
    if (merged.dx) clean.dx = Math.round(merged.dx);
    if (merged.dy) clean.dy = Math.round(merged.dy);
    if (merged.hide) clean.hide = true;
    if (merged.size) clean.size = Math.min(40, Math.max(6, Math.round(merged.size)));
    if (TM.normAngle(merged.rot)) clean.rot = TM.normAngle(merged.rot);
    return writeBlock(repId, Object.assign({}, block, { labelPos: clean }));
  };
  /* Any (non-block) station's own name label — a view preference, never gated by line ownership. See store.setLabelPos. */
  actions.setLabelPos = (id, patch) => store.setLabelPos(id, patch);
  /* Merging a connecting station in moves it onto the block's own node — like an interchange — so its line's route actually
     reaches the block (the block's shape then covers the approach); un-merging gives it
     its own node back nearby. Mirrors the same-name-interchange merge/split in linkStations. */
  actions.setBlockMerge = (repId, connId, merged) => {
    const block = blockOf(repId);
    if (!block || !store.stations.get(connId)) return false;
    const set = new Set(block.merged);
    if (merged) {
      set.add(connId);
      const target = store.nodeOf(repId);
      if (target) place(connId, target);
    } else {
      set.delete(connId);
      const node = store.nodeOf(repId);
      if (node) place(connId, store.freeNodeNear(node.x + 1, node.y));
    }
    const members = Object.assign({}, block.members);
    if (!merged) delete members[connId];
    return writeBlock(repId, Object.assign({}, block, { merged: [...set], members }));
  };
  actions.resetBlock = (repId) => store.resetBlock(repId);

  /* ---------- connecting-line bends (schematic only) ---------- */
  actions.setConnBends = (a, b, points) => store.setConnBends(a, b, points);

  actions.moveItem = (index, node) => {
    const line = actions.activeLine(), item = line && line.path[index];
    if (!item) return;
    if (item.s) actions.moveStation(item.s, node);
    else if (actions.canEdit(line)) { const snap = arcSnapshot(); item.x = node.x; item.y = node.y; arcRefit(snap); store.save(); }
  };

  /* ---------- free-floating annotations (custom text / an image, placed anywhere — independent of any station or line) ---------- */
  actions.addAnnotation = (obj) => { const id = store.addAnnotation(obj); if (id) actions.select({ type: 'ann', id }); return id; };
  actions.setAnnotation = (id, patch) => store.setAnnotation(id, patch);
  actions.moveAnnotation = (id, dx, dy) => { const annotation = store.annotations[id]; if (annotation) store.setAnnotation(id, { x: annotation.x + dx, y: annotation.y + dy }); };
  actions.removeAnnotation = (id) => {
    store.removeAnnotation(id);
    if (TM.state.selected && TM.state.selected.type === 'ann' && TM.state.selected.id === id) actions.select(null);
  };

  /* Move the selected station / bend / annotation by (dx, dy) nodes. */
  actions.nudgeSelected = (dx, dy) => {
    const selection = TM.state.selected;
    if (!selection) return false;
    if (selection.type === 'ann') { actions.moveAnnotation(selection.id, dx * TM.GRID, dy * TM.GRID); return true; }
    if (selection.type === 'draw') return actions.moveDrawing(selection.id, dx * 4, dy * 4, selection.pt);
    if (selection.type === 'badge') {
      const line = store.line(selection.line), root = line && (store.rootLine(line) || line), off = (line && line.badges && line.badges[selection.end]) || { dx: 0, dy: 0 };
      if (!actions.canEdit(root) || root.badgeStyle === 'flag') return false;
      actions.setBadge(selection.line, selection.end, off.dx + dx * 4, off.dy + dy * 4); return true;
    }
    if (selection.type === 'station') {
      const node = store.nodeOf(selection.id);
      return !!node && actions.moveStation(selection.id, { x: node.x + dx, y: node.y + dy });
    }
    const line = actions.activeLine(), item = line && line.path[selection.index];
    if (!actions.canEdit(line) || !item) return false;
    const snap = arcSnapshot();
    item.x += dx; item.y += dy; arcRefit(snap); store.save();
    return true;
  };

  /* Set a per-line display property of a path item (symbol / number / links / label). */
  actions.setItem = (index, patch, onLine) => {
    const line = onLine || actions.activeLine();
    if (!actions.canEdit(line) || !line.path[index]) return;
    const item = line.path[index];
    if ('symbol' in patch) {
      /* The newest symbol choice for an interchange wins over older ones on the other lines; the timestamp records that. */
      const value = patch.symbol || 'auto';
      item.symbol = value; item.symAt = Date.now();
      if (value === 'auto' && !store.symbolItemsOf(item.s).some((o) => o.item !== item && o.item.symbol && o.item.symbol !== 'auto')) { delete item.symbol; delete item.symAt; }
    }
    if ('num' in patch) { if (patch.num === null) delete item.num; else item.num = !!patch.num; }
    if ('links' in patch) { if (patch.links.length) item.links = patch.links.slice(); else delete item.links; }
    if ('seg' in patch) { if (TM.SEG_STYLES[patch.seg] && patch.seg !== 'auto') item.seg = patch.seg; else delete item.seg; }
    /* a stop's time to the next stop and back: setting one direction fills the other too while that one is still empty,
       so a different time each way stays possible but one entry is enough when they are the same */
    const minutes = (v) => (isFinite(v) && v > 0 ? Math.round(Math.min(999, v) * 10) / 10 : null);
    if ('time' in patch) { const v = minutes(patch.time); if (v) { item.time = v; if (item.s != null && !item.timeBack) item.timeBack = v; } else delete item.time; }
    if ('timeBack' in patch) { const v = minutes(patch.timeBack); if (v) { item.timeBack = v; if (!item.time) item.time = v; } else delete item.timeBack; }
    /* platform: merge-patch of { next, prev } — an empty value removes that side (see store.normItemPlatform) */
    if ('platform' in patch && item.s != null) { const platform = store.normItemPlatform(Object.assign({}, item.platform, patch.platform)); if (platform) item.platform = platform; else delete item.platform; }
    if ('label' in patch) {
      const merged = Object.assign({}, item.label, patch.label);
      if (patch.label.reset) { merged.dx = 0; merged.dy = 0; }
      if (patch.label.resetSize) delete merged.size;
      const clean = {};
      if (merged.pos) clean.pos = merged.pos;
      if (merged.dx) clean.dx = Math.round(merged.dx);
      if (merged.dy) clean.dy = Math.round(merged.dy);
      if (merged.hide) clean.hide = true;
      if (merged.size) clean.size = Math.min(40, Math.max(6, Math.round(merged.size)));
      if (merged.icons && merged.icons.length) clean.icons = merged.icons.slice();
      if (Object.keys(clean).length) item.label = clean; else delete item.label;
    }
    store.save();
  };

  /* Segment style between path item i and the next one: auto -> dash -> dashdot -> hatch -> solid -> auto (TM.SEG_NEXT); shift extends over a range. */
  actions.segState = (i) => { const line = actions.activeLine(); return (line && line.path[i] && line.path[i].seg) || 'auto'; };
  actions.toggleSeg = (i, range) => {
    const line = actions.activeLine();
    if (!actions.canEdit(line) || !line.path[i]) return;
    const next = TM.SEG_NEXT[actions.segState(i)] || 'auto';
    const from = range && actions._lastSeg != null ? Math.min(actions._lastSeg, i) : i, to = range && actions._lastSeg != null ? Math.max(actions._lastSeg, i) : i;
    for (let k = from; k <= to; k++) { if (next === 'auto') delete line.path[k].seg; else line.path[k].seg = next; }
    actions._lastSeg = i;
    store.save();
    TM.toast(`Segment${to > from ? 's' : ''} ${next === 'auto' ? 'back to automatic' : TM.SEG_STYLES[next].toLowerCase()}`);
  };

  actions.indexOfStation = (id) => indexInGroup(actions.activeLine(), id);

  /* Drag position of a line-name badge at one end of a line (end: 's' start | 'e' end). dx = dy = 0 resets it. */
  actions.setBadge = (lineId, end, dx, dy) => {
    const line = store.line(lineId);
    if (!actions.canEdit(line)) return;
    line.badges = line.badges || {};
    if (Math.round(dx) || Math.round(dy)) line.badges[end] = { dx: Math.round(dx), dy: Math.round(dy) }; else delete line.badges[end];
    store.save();
  };
  /* the look of a line's name badges (both ends, its branches too): 'pill' | 'flag' — see symbols.badge / symbols.flag */
  actions.setBadgeStyle = (lineId, style) => {
    const line = store.line(lineId), root = line && (store.rootLine(line) || line);
    if (!actions.canEdit(root)) { TM.toast('Not your line to edit', 'err'); return; }
    root.badgeStyle = ['flag', 'picture', 'hidden'].includes(style) ? style : 'pill'; store.save();
  };
  actions.resetBadges = (lineId) => { const line = store.line(lineId); if (actions.canEdit(line)) { line.badges = {}; store.save(); } };

  /* Mark (or unmark) an end of a line as continuing past the edge of the map — not a real terminus, just this map's
     scope running out. label is a short optional caption (e.g. "to Singapore"); '' still shows the mark with no text. */
  actions.setBeyond = (lineId, end, label) => {
    const line = store.line(lineId);
    if (!actions.canEdit(line)) return;
    line.beyond = line.beyond || {};
    if (label == null) delete line.beyond[end]; else line.beyond[end] = String(label).trim().slice(0, 60);
    store.save();
  };

  /* Link two stations: type = interchange | link | walkway, or null to remove. Interchange partners share one node:
     the first station (the selected one) moves onto the second one. */
  /* A station that is itself an interchange (same-name merged, or joined to another differently-named interchange) is one
     physical place: linking it to another such place really links the whole complex, so every member's data record gets
     the connection too (rendering still draws only one line — the nearest pair — see render.js: drawLink / complexOf). */
  function propagateGroupLink(stationA, stationB, type) {
    const membersA = store.complexMembers(stationA), membersB = store.complexMembers(stationB);
    membersA.forEach((ma) => membersB.forEach((mb) => { if (ma !== mb) store.setLink(ma, mb, type); }));
  }

  actions.linkStations = (stationA, stationB, type) => {
    if (stationA === stationB || !store.stations.get(stationA) || !store.stations.get(stationB)) return false;
    /* Connecting two stations is allowed as long as at least one side is yours — you may always link your own
       station to someone else's, but two stations neither of which you own stay off-limits. */
    if (!actions.ownsStation(store.stations.get(stationA)) && !actions.ownsStation(store.stations.get(stationB))) { TM.toast('Connect from one of your own stations', 'err'); return false; }
    const before = store.connections().find((c) => (c.a === stationA && c.b === stationB) || (c.a === stationB && c.b === stationA)), wasMerged = !!before && before.type === 'platform' && !before.split;
    if (before && before.type === type) return false;
    const target = type === 'platform' && store.sameName(stationA, stationB) ? store.nodeOf(stationB) : null;   // only same-name stations share a node
    store.setLink(stationA, stationB, type);
    if (type === 'platform' && target) {
      const current = store.nodeOf(stationA);
      if (!current || current.x !== target.x || current.y !== target.y) place(stationA, target);
    } else if (wasMerged && !store.sameGroup(stationA, stationB)) {              // no longer one station: give them separate nodes
      const node = store.nodeOf(stationA), free = store.freeNodeNear(node.x + 1, node.y);
      place(stationA, free);
      TM.toast(`${stationA} moved to its own node — drag it where you want it`);
    }
    if (type === 'link' || type === 'walkway') meshLinks(stationA, stationB, type);
    if (type !== 'platform' || !target) propagateGroupLink(stationA, stationB, type);   // same-name merge (target) needs no extra data: store.groups() already treats them as one
    TM.emit('selection');
    return true;
  };

  /* Connecting stations are mutual: everything already connected to either station (in the same way) becomes connected
     to the new one too, so the whole set is linked to each other. Interchange partners count as one station. */
  function meshLinks(stationA, stationB, type) {
    const seen = new Set([store.rep(stationA)]), queue = [store.rep(stationA)];
    while (queue.length) {
      const current = queue.shift();
      store.complexMembers(current).forEach((member) => store.connectionsOf(member).forEach((connection) => {
        const other = store.rep(connection.other);
        if (connection.type === type && !seen.has(other)) { seen.add(other); queue.push(other); }
      }));
    }
    const reps = [...seen].slice(0, 12), idOf = (r) => (r === store.rep(stationA) ? stationA : r === store.rep(stationB) ? stationB : r);
    const linked = (x, y) => store.connections().some((c) => (store.rep(c.a) === x && store.rep(c.b) === y) || (store.rep(c.a) === y && store.rep(c.b) === x));
    for (let i = 0; i < reps.length; i++) for (let j = i + 1; j < reps.length; j++) if (!linked(reps[i], reps[j])) store.setLink(idOf(reps[i]), idOf(reps[j]), type);
  }

  actions.newLine = (fields) => {
    const id = store.nextLineId(TM.nameOf({ names: fields.names }, 'en'), fields.code);
    const line = store.addLine({
      id, code: (fields.code || id).toUpperCase(), names: fields.names, color: fields.color, mode: fields.mode || 'other',
      status: fields.status || 'fantasy', author: store.author, style: fields.style || 'octilinear', image: fields.image || null, lookFor: fields.lookFor || null, loop: !!fields.loop, loopDir: fields.loopDir || null, loopNames: fields.loopNames || null, traffic: fields.traffic || null, inOut: !!fields.inOut,
      created: TM.today(), path: [],
    });
    actions.setActive(line.id);
    return line;
  };

  /* ---------- branches (see store.branchLine) ---------- */
  /* Start a branch of the active line (or of the line a branch belongs to) at one of its stations, and make it the line
     being edited, with the Station tool on — its next stops are added after the junction like any line's. */
  actions.addBranch = (stationId) => {
    const root = store.rootLine(actions.activeLine());
    if (!actions.canEdit(root)) { TM.toast('Select one of your own lines first', 'err'); return null; }
    const onTrack = [root, ...store.branchesOf(root)].some((l) => l.path.some((it) => it.s === stationId));
    if (!onTrack) { TM.toast('A branch starts at a station of its line', 'err'); return null; }
    let number = (root.branches || []).length + 1;
    while ((root.branches || []).some((b) => b.id === 'b' + number)) number++;
    const branch = { id: 'b' + number, path: [{ s: stationId }], badges: {}, beyond: {} };
    root.branches = (root.branches || []).concat([branch]);
    store.save();
    actions.setActive(root.id + '~' + branch.id);
    TM.state.tool = 'station'; TM.state.insertMode = 'after'; TM.emit('tool');
    return branch;
  };
  actions.removeBranch = (branchLineId) => {
    const branchLine = store.line(branchLineId), root = branchLine && store.rootLine(branchLine);
    if (!branchLine || !branchLine.rootId || !actions.canEdit(root)) return false;
    root.branches = root.branches.filter((b) => b.id !== branchLine.branchId);
    if (TM.state.activeLineId === branchLineId) TM.state.activeLineId = root.id;
    store.save(); TM.emit('active');
    return true;
  };

  /* ---------- services (see store.normService) — part of the map, so whoever may edit the map may edit them ---------- */
  actions.canEditServices = () => actions.ownsMap();
  actions.saveService = (service, oldId) => {
    if (!actions.canEditServices()) { TM.toast('Only the map\'s own author can change its services', 'err'); return null; }
    const list = store.services.filter((x) => x.id !== (oldId || service.id));
    const at = store.services.findIndex((x) => x.id === (oldId || service.id));
    let id = service.id || TM.slugId(service.name || 'service');
    while (list.some((x) => x.id === id)) id += '-2';
    const next = Object.assign({}, service, { id });
    list.splice(at >= 0 ? at : list.length, 0, next);
    store.setServices(list);
    return store.services.find((x) => x.id === id);
  };
  actions.removeService = (id) => {
    if (!actions.canEditServices()) return false;
    store.setServices(store.services.filter((x) => x.id !== id));
    return true;
  };

  actions.duplicateLine = (id) => {
    const source = store.lines.get(store.rootId(id));
    if (!source) return null;
    const copy = JSON.parse(JSON.stringify(store.lineOut(source)));
    copy.id = store.nextLineId(TM.nameOf(copy, 'en'), copy.code); copy.code = copy.id; copy.author = store.author; copy.created = TM.today();
    copy.names.en = (copy.names.en || copy.id) + ' (my version)';
    delete copy.imported;
    const line = store.addLine(copy);
    actions.setActive(line.id);
    return line;
  };

  /* Edit an existing station's own fields (name, status, dates, note, links…) — only its owner may. */
  actions.updateStation = (id, patch) => {
    const station = store.stations.get(id);
    if (!actions.ownsStation(station)) { TM.toast('Not your station to edit', 'err'); return false; }
    store.updateStation(id, patch);
    return true;
  };

  /* Create a brand-new fantasy station at a node and put it on the active line. */
  actions.createStation = (fields, node, addToLine) => {
    const activeCode = actions.activeLine() && actions.activeLine().code;
    const station = store.addStation({
      id: store.nextFantasyCode(TM.nameOf({ names: fields.names }, 'en'), activeCode), names: fields.names, lat: fields.lat, lng: fields.lng,
      status: fields.status, platform: fields.platform, structure: fields.structure, opened: fields.opened || null, closed: fields.closed || null,
      node: node ? [node.x, node.y] : null, author: store.author, note: fields.note || '', linkedTo: fields.linkedTo || [],
    });
    if (!station.node) station.node = store.autoNode(station.lat, station.lng);
    store.save();
    if (addToLine) actions.addStationToLine(station.id);
    return station;
  };

  /* ---------- background drawings (store.drawing) — the map's own, like its background image ---------- */
  const drawEdit = (id, fn) => {
    const d = id ? store.drawingById(id) : null;
    if (!actions.ownsMap() || (id && !d)) return false;
    fn(d); store.save(); return true;
  };
  actions.addDrawing = (kind, point) => {
    if (!actions.ownsMap()) { TM.toast('Not your map to draw on', 'err'); return null; }
    const d = store.normDrawing({ kind, pts: [[point.x, point.y]], width: 6, color: TM.state.drawColors && TM.state.drawColors[kind] });
    store.drawing.items.push(d); store.save();
    return d;
  };
  actions.addDrawPoint = (id, point, at) => drawEdit(id, (d) => {
    const p = [TM.round2dp(point.x), TM.round2dp(point.y)];
    if (at != null) d.pts.splice(at, 0, p); else d.pts.push(p);
  });
  actions.moveDrawPoint = (id, i, point) => drawEdit(id, (d) => { if (d.pts[i]) { d.pts[i][0] = TM.round2dp(point.x); d.pts[i][1] = TM.round2dp(point.y); } });
  actions.removeDrawPoint = (id, i) => drawEdit(id, (d) => { d.pts.splice(i, 1); if (!d.pts.length) store.drawing.items = store.drawing.items.filter((x) => x !== d); });
  actions.moveDrawing = (id, dx, dy, onlyPoint) => drawEdit(id, (d) => d.pts.forEach((p, i) => { if (onlyPoint == null || onlyPoint === i) { p[0] = TM.round2dp(p[0] + dx); p[1] = TM.round2dp(p[1] + dy); } }));
  actions.updateDrawing = (id, patch) => drawEdit(id, (d) => {
    const next = store.normDrawing(Object.assign({}, d, patch, { id: d.id }));
    if (next) store.drawing.items[store.drawing.items.indexOf(d)] = next;
  });
  /* a line drawing's width */
  actions.setDrawWidth = (id, width) => drawEdit(id, (d) => { if (d.kind === 'line') d.width = Math.min(200, Math.max(1, Math.round(width))); });
  actions.removeDrawing = (id) => drawEdit(id, (d) => { store.drawing.items = store.drawing.items.filter((x) => x !== d); });
  /* one step up (+1, drawn later = on top) or down (-1) among the drawings */
  actions.orderDrawing = (id, step) => drawEdit(id, (d) => {
    const list = store.drawing.items, i = list.indexOf(d), j = Math.min(list.length - 1, Math.max(0, i + step));
    list.splice(i, 1); list.splice(j, 0, d);
  });
  actions.setDrawLayer = (patch) => drawEdit(null, () => {
    if (patch.top) store.drawing.top = patch.top === 'image' ? 'image' : 'drawings';
    if (patch.hidden != null) store.drawing.hidden = !!patch.hidden;
  });

  /* ---------- schematic background image (a picture behind the whole map, e.g. a scanned reference) ----------
     Stored as one object on the store (store.background), exported under images/background/ of the map. Only the
     map's own owner may add, move, resize, hide or remove it — see actions.ownsMap. */
  actions.setBackgroundImage = (file, dataUri, width, height) => {
    if (!actions.ownsMap()) { TM.toast('Not your map to edit', 'err'); return false; }
    const safe = String(file || 'background').replace(/[^\w.\- ]/g, '_').slice(-64) || 'background.png';
    store.background = { file: safe, dataUri, x: -(width || 800) / 2, y: -(height || 600) / 2, w: width || 800, h: height || 600, opacity: 1, visible: true };
    store.save();
    return true;
  };
  actions.clearBackground = () => {
    if (!actions.ownsMap() || !store.background) return false;
    store.background = null;
    store.save();
    return true;
  };
  actions.setBackgroundRect = (patch) => {
    const background = store.background;
    if (!actions.ownsMap() || !background) return false;
    if (isFinite(patch.x)) background.x = patch.x;
    if (isFinite(patch.y)) background.y = patch.y;
    if (isFinite(patch.w) && patch.w > 10) background.w = patch.w;
    if (isFinite(patch.h) && patch.h > 10) background.h = patch.h;
    store.save();
    return true;
  };
  actions.setBackgroundVisible = (visible) => {
    const background = store.background;
    if (!actions.ownsMap() || !background) return false;
    background.visible = !!visible;
    store.save();
    return true;
  };
  actions.setBackgroundOpacity = (opacity) => {
    const background = store.background;
    if (!actions.ownsMap() || !background) return false;
    background.opacity = Math.min(1, Math.max(0.05, +opacity || 1));
    store.save();
    return true;
  };
})(window.TM);
