/* Left panel (lines + editor), right panel (inspector + suggestions), tools, banner, legend, top bar. */
(function (TM) {
  const ui = (TM.ui = TM.ui || {});
  const store = TM.store, actions = TM.actions;
  const $ = (id) => document.getElementById(id);
  const pill = (st) => `<span class="pill ${st}">${TM.STATUSES[st] || st}</span>`;
  const codeChip = (l) => `<span class="code" style="background:${l.color};color:${TM.symbols.contrast(l.color)}">${TM.esc(l.code)}</span>`;
  const lineName = (l) => `${TM.esc(TM.displayName(l))}`;

  /* ---- suggested stops ---- */
  const sugNote = (line) => {
    const count = store.suggestionsFor(line.id).length;
    return count ? ` · ${count} suggested${store.suggestShown(line.id, TM.state.showSuggested) ? '' : ' (hidden)'}` : '';
  };
  const stnName = (id) => { const station = store.stations.get(id); return station ? TM.nameOf(station, TM.state.langs[0]) : id; };
  /* the selected line's suggestions, with Accept / Dismiss, and this line's own Show / Hide choice */
  /* a branch (store.branchLine): where it leaves its line, and where it goes */
  const branchText = (b) => { const stops = b.path.filter((i) => i.s); return `Branch from ${TM.esc(stnName(stops[0].s))}${stops.length > 1 ? ` → ${TM.esc(stnName(stops[stops.length - 1].s))}` : ''}`; };
  function branchesSection(root, canEdit) {
    const list = store.branchesOf(root);
    if (!list.length && !canEdit) return '';
    return `<div class="lbl" style="margin:14px 0 6px">Branches</div>` + (list.length ? list.map((b) => `<div class="stn-item" data-line-go="${TM.esc(b.id)}"><span class="code">↳</span><span class="nm">${branchText(b)} <span class="hint">· ${b.path.filter((i) => i.s).length - 1} stop${b.path.filter((i) => i.s).length === 2 ? '' : 's'}</span></span>${canEdit ? `<button class="btn sm ghost icon-btn" data-br-rm="${TM.esc(b.id)}" title="Remove this branch" style="width:24px;padding:0">${TM.icon('x')}</button>` : ''}</div>`).join('') : '') +
      (canEdit ? `<p class="hint" style="margin:6px 0 0">To fork the line, select one of its stations and choose <b>Start a branch here</b> in the Inspector.</p>` : '');
  }
  /* Show one service on the schematic: the stretch of every track line it runs on stays lit, and of its stations only
     those it stops at — the ones it passes without stopping fade with the rest (the same dimming the journey planner
     uses for a route). sv: a service, or null to stop showing; stops: its stop Set of place indices (default: its own). */
  ui.showService = (service, stops) => {
    if (!service) { TM.state.svcHi = null; TM.state.svcShown = null; TM.emit('display'); return; }
    const serviceRoute = store.serviceRoute(service);
    if (!serviceRoute.ok) { TM.state.svcHi = null; TM.emit('display'); return; }
    const on = stops || store.serviceStopsAt(service, serviceRoute, false), segs = new Map(), lineIds = new Set(), extra = new Set();
    serviceRoute.hops.forEach((hop) => {
      if (hop.join) return;
      lineIds.add(hop.line.id);
      const set = segs.get(hop.line.id) || segs.set(hop.line.id, new Set()).get(hop.line.id);
      /* the path segments k (path[k] → path[k + 1]) between the two stops, either way, round a loop too — this page does
         not load the journey planner (js/route.js), so worked out here */
      const count = hop.line.path.length, low = hop.fwd ? hop.ia : hop.ib, high = hop.fwd ? hop.ib : hop.ia;
      for (let k = low; k !== high; k = (k + 1) % count) set.add(k);
    });
    serviceRoute.places.forEach((p, i) => { if (on.has(i)) p.ids.forEach((id) => extra.add(store.rep(id))); });
    TM.state.svcHi = { activeLineIds: lineIds, activeSegs: segs, activeExtra: extra, activeLineId: null, dimOthers: true };
    TM.state.svcShown = service.id || '(editing)';
    TM.emit('display');
  };
  /* The trains that run on a line (maps/<id>/services.json — see store.normService), and whether only they run on it. */
  function servicesSection(root) {
    const list = store.servicesOn(root.id), edit = actions.canEditServices(), canLine = actions.canEdit(root);
    if (!list.length && !edit && !canLine) return '';   // its own timetable is the line's (whoever may edit it)
    const ends = (sv, rt) => (rt.ok ? (rt.loop ? `loop from ${TM.esc(stnName(rt.places[0].ids[0]))}` : `${TM.esc(stnName(rt.places[0].ids[0]))} ↔ ${TM.esc(stnName(rt.places[rt.places.length - 1].ids[0]))}`) + (sv.both === false ? ' · one way' : '') : 'route not found');
    return `<div class="sec"><div class="sec-h"><h3>Services · ${TM.esc(root.code)}</h3>${edit ? `<button class="btn sm primary" id="svcNew">${TM.icon('plus')} New service</button>` : ''}</div>` +
      `<label class="check" style="margin-bottom:8px"><input type="checkbox" id="svcOnly" ${root.servicesOnly ? 'checked' : ''} ${canLine ? '' : 'disabled'}> Run by its services only <span class="hint">— no all-stops train each way along the whole line</span></label>` +
      (root.servicesOnly ? '' : `<div class="row" style="justify-content:space-between;gap:8px;margin-bottom:8px"><span class="hint">All-stops train: ${TM.esc(ui.scheduleSummary(root.schedules))}</span>${canLine ? `<button class="btn sm" data-tt-line="${TM.esc(root.id)}">${TM.icon('clock')} Timetable</button>` : ''}</div>`) +
      (list.length ? list.map((service) => {
        const serviceRoute = store.serviceRoute(service);
        return `<div class="stn-item"><span class="nm"><b>${TM.esc(service.type ? service.type + ' · ' + service.name : service.name)}</b><br><span class="hint">${ends(service, serviceRoute)}${service.hidden ? ' · hidden by default' : ''}${serviceRoute.warn.length ? ` · <span style="color:var(--danger)">⚠ ${TM.esc(serviceRoute.warn[0])}</span>` : ''}</span></span>` +
          `<button class="btn sm ${TM.state.svcShown === service.id ? 'primary' : 'ghost'} icon-btn" data-svc-show="${TM.esc(service.id)}" title="${TM.state.svcShown === service.id ? 'Stop showing' : 'Show on the map'}" style="width:24px;padding:0">${TM.icon('eye')}</button>` +
          (edit ? `<button class="btn sm ghost icon-btn" data-tt-svc="${TM.esc(service.id)}" title="Timetable · ${TM.esc(ui.scheduleSummary(service.schedules))}" style="width:24px;padding:0">${TM.icon('clock')}</button><button class="btn sm ghost icon-btn" data-svc-edit="${TM.esc(service.id)}" title="Edit service" style="width:24px;padding:0">${TM.icon('edit')}</button><button class="btn sm ghost icon-btn" data-svc-rm="${TM.esc(service.id)}" title="Delete service" style="width:24px;padding:0">${TM.icon('x')}</button>` : '') + '</div>';
      }).join('') : `<p class="hint" style="margin:0">No services — trains call at every stop of the line, both ways. Add one for trains that run only part of it, skip stations, go round a loop or run through onto another line.</p>`) + '</div>';
  }
  function suggestSection(line, canEdit) {
    const list = store.suggestionsFor(line.id), view = store.suggestView[line.id] || 'default';
    if (!list.length && view === 'default') return '';
    const shown = store.suggestShown(line.id, TM.state.showSuggested);
    let html = `<div class="sec"><div class="sec-h"><h3>Suggested stops · ${list.length}</h3></div>` +
      `<div class="row" style="justify-content:space-between;margin-bottom:8px"><span class="hint">On this line's map</span><div class="seg">${[['default', 'Default'], ['show', 'Show'], ['hide', 'Hide']].map(([v, t]) => `<button data-sugview="${v}" class="${view === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>` +
      `<p class="hint" style="margin:-2px 0 8px">${view === 'default' ? `Follows Display → Suggested stops (${TM.state.showSuggested !== false ? 'on' : 'off'}).` : `Set for this line only.`} ${shown ? 'Shown dashed with a dashed halo.' : 'Not drawn — the line looks as if none were suggested.'}</p>`;
    html += list.map((suggestion) => {
      const mine = suggestion.author && suggestion.author === store.author;
      return `<div class="sug-item"><div class="row" style="justify-content:space-between;gap:6px"><span data-go="${TM.esc(suggestion.station)}" style="cursor:pointer;min-width:0"><span class="code">${TM.esc(suggestion.station)}</span> <b>${TM.esc(stnName(suggestion.station))}</b></span>` +
        `<span class="row" style="gap:4px;flex:none">${canEdit ? `<button class="btn sm primary" data-sugacc="${TM.esc(suggestion.station)}|${TM.esc(line.id)}" title="Add it to the line">Accept</button>` : ''}${canEdit || mine ? `<button class="btn sm ghost" data-sugdis="${TM.esc(suggestion.station)}|${TM.esc(line.id)}" title="${canEdit ? 'Turn this suggestion down' : 'Take back your suggestion'}">${canEdit ? 'Dismiss' : 'Withdraw'}</button>` : ''}</span></div>` +
        `<span class="hint">${suggestion.after ? `after <b>${TM.esc(suggestion.after)}</b> ${TM.esc(stnName(suggestion.after))}` : 'at the start'} · by ${TM.esc(suggestion.author || 'anonymous')}${suggestion.note ? ` · “${TM.esc(suggestion.note)}”` : ''}</span></div>`;
    }).join('');
    return html + '</div>';
  }

  /* ================= LEFT ================= */
  function renderLeft() {
    const panel = $('left'), scrollTop = panel.scrollTop, activeLine = actions.activeLine(), canEdit = actions.canEdit(activeLine);
    const lines = [...store.lines.values()].filter((l) => store.lineFilter.has(l.id)), hiddenN = store.lines.size - lines.length;
    let html = `<div class="sec"><div class="sec-h"><h3>Contributing as</h3></div><input class="input" id="authorIn" value="${TM.esc(store.author)}" maxlength="24" placeholder="your name / handle"></div>`;
    html += `<div class="sec"><div class="sec-h"><h3>Lines</h3><button class="btn sm primary" id="newLine">${TM.icon('plus')} New line</button></div>` +
      lines.map((line) => `<div class="line-item ${activeLine && activeLine.id === line.id ? 'active' : ''}" data-line="${TM.esc(line.id)}">${codeChip(line)}<div class="nm"><b>${lineName(line)}</b><span>${TM.esc(line.author || 'anonymous')} · ${line.path.filter((i) => i.s).length} stations${(line.branches || []).length ? ` · ${line.branches.length} branch${line.branches.length === 1 ? '' : 'es'}` : ''}${line.local && !store.userMap ? ' · mine' : ''}${sugNote(line)}</span></div><button class="btn sm ghost icon-btn" data-eye="${TM.esc(line.id)}" title="Show / hide" style="width:28px">${TM.icon(store.visible.has(line.id) ? 'eye' : 'eyeoff')}</button></div>` +
        /* the line being edited lists its branches right under it — pick one to edit it like a line */
        (activeLine && store.rootId(activeLine) === line.id ? store.branchesOf(line).map((b) => `<div class="line-item branch ${activeLine.id === b.id ? 'active' : ''}" data-line="${TM.esc(b.id)}"><span class="br-mark">↳</span><div class="nm"><b>${branchText(b)}</b><span>${b.path.filter((i) => i.s).length - 1} stop${b.path.filter((i) => i.s).length === 2 ? '' : 's'} · branch of ${TM.esc(line.code)}</span></div></div>`).join('') : '')).join('') +
      (hiddenN ? `<p class="hint" style="margin:8px 0 0">${hiddenN} line${hiddenN === 1 ? ' is' : 's are'} deselected in the line picker in the top bar, so ${hiddenN === 1 ? 'it is' : 'they are'} not shown in this list. Select ${hiddenN === 1 ? 'it' : 'them'} there to list and show ${hiddenN === 1 ? 'it' : 'them'} again.</p>` : '') + '</div>';

    if (activeLine) {
      const root = store.rootLine(activeLine) || activeLine;
      html += `<div class="sec"><div class="sec-h"><h3>${canEdit ? 'Editing' : 'Selected'} · ${TM.esc(activeLine.code)}${activeLine.rootId ? ' · branch' : ''}</h3><div class="row">` +
        (canEdit ? `<button class="btn sm ghost icon-btn" id="lnEdit" title="Rename / recolour">${TM.icon('edit')}</button>` : '') +
        `<button class="btn sm ghost icon-btn" id="lnDup" title="Make my own copy">${TM.icon('copy')}</button>` +
        `<button class="btn sm ghost icon-btn" id="lnExp" title="Export this line as JSON">${TM.icon('download')}</button>` +
        (actions.ownsLine(activeLine) ? `<button class="btn sm ghost icon-btn danger" id="lnDel" title="Delete line">${TM.icon('trash')}</button>` : '') + '</div></div>' +
        (activeLine.rootId ? `<div class="row" style="justify-content:space-between;margin:-4px 0 10px;gap:8px"><span class="hint">${branchText(activeLine)} — its first stop is where it joins ${TM.esc(root.code)}.</span><span class="row" style="gap:4px"><button class="btn sm ghost" id="brBack">Back to line</button>${canEdit ? `<button class="btn sm ghost danger" id="brDel">Remove branch</button>` : ''}</span></div>` : '');
      if (TM.state.mode === 'map') html += lengthTable(activeLine);
      if (!canEdit) html += `<p class="hint" style="margin-top:0">By <b>${TM.esc(activeLine.author || 'anonymous')}</b>. Duplicate it to build your own variation and compare.</p>` + `<div class="row" style="margin-bottom:10px"><button class="btn sm primary" id="sugStn">${TM.icon('plus')} Suggest station</button>${insSeg()}</div><p class="hint" style="margin:-4px 0 8px">Proposes a stop on this line without changing it — its owner can accept it. Goes before / after the selected stop, or at the line's end when none is selected.</p><div id="stSearch" style="margin-bottom:8px"></div>`;
      else html += `<div class="row" style="margin-bottom:10px"><button class="btn sm primary" id="addStn">${TM.icon('plus')} Add station</button>${insSeg()}</div><p class="hint" style="margin:-4px 0 8px">Inserted before / after the selected stop, or at the line's end when none is selected.</p><div id="stSearch" style="margin-bottom:8px"></div>${Object.keys(activeLine.badges || {}).length ? `<div class="row" style="margin-bottom:8px;justify-content:space-between"><span class="hint">Line-name badges were moved</span><button class="btn sm ghost" id="badgeReset">↺ Reset badges</button></div>` : '<p class="hint" style="margin:0 0 8px">Drag the line-name badge at either end of the line to move it.</p>'}`;
      const selection = TM.state.selected;
      html += activeLine.path.map((item, i) => {
        if (item.s) {
          const station = store.stations.get(item.s); if (!station) return '';
          const junction = activeLine.rootId && i === 0;   // where a branch joins its line: fixed
          return `<div class="stn-item ${selection && selection.type === 'station' && selection.id === item.s ? 'sel' : ''}" data-sid="${TM.esc(item.s)}"><span class="idx">${i + 1}</span><span class="code">${TM.esc(station.id)}</span><span class="nm">${TM.esc(TM.nameOf(station, TM.state.langs[0]))}${junction ? ' <span class="hint">· junction</span>' : ''}</span>${canEdit && !junction ? rowBtns(i, activeLine.path.length, activeLine.rootId ? 1 : 0) : ''}</div>`;
        }
        return `<div class="stn-item ${selection && selection.type === 'wp' && selection.index === i ? 'sel' : ''}" data-wpi="${i}"><span class="idx">${i + 1}</span><span class="code">◆</span><span class="nm hint">Bend (${item.x}, ${item.y})</span>${canEdit ? rowBtns(i, activeLine.path.length) : ''}</div>`;
      }).join('') || '<div class="empty">No stations yet.<br>Pick the Station tool and click a node.</div>';
      if (!activeLine.rootId) html += branchesSection(activeLine, canEdit);
      html += '</div>' + (activeLine.rootId ? '' : suggestSection(activeLine, canEdit)) + servicesSection(root);
    }
    const mine = store.exportNewStations().length, movedN = store.exportStations().length - mine;
    html += `<div class="sec"><div class="sec-h"><h3>Display</h3></div><div style="display:grid;gap:9px">` +
      [['showNodes', 'Node grid (G)'], ['showCodes', 'Station codes'], ['showHotspots', 'Suggestion badges & 300 m zones'], ['showLegend', 'Legend'], ...TM.STATUS_TOGGLES.map((t) => [t.opt, t.label]), ['trimHidden', 'Hide line ends past hidden stations'], ['showSuggested', 'Suggested stops']].map(([k, t]) => `<label class="check"><input type="checkbox" data-opt="${k}" ${TM.state[k] !== false ? 'checked' : ''}> ${t}</label>`).join('') +
      (Object.keys(store.suggestView).length ? `<div class="row" style="justify-content:space-between"><span class="hint">${Object.keys(store.suggestView).length} line${Object.keys(store.suggestView).length === 1 ? ' has its' : 's have their'} own Suggested stops setting</span><button class="btn sm ghost" id="sugReset">↺ Reset per-line</button></div>` : '') +
      `<div class="row" style="justify-content:space-between"><span class="hint">${store.legend ? 'This map has its own legend' : 'Legend is automatic'}</span><button class="btn sm ghost" id="legEdit2">${TM.icon('edit')} Edit legend</button></div>` +
      `<label class="check"><input type="checkbox" data-opt="colorByType" ${TM.state.colorByType ? 'checked' : ''}> Colour lines by line type</label>` +
      (TM.state.colorByType ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 10px">${Object.entries(TM.MODES).map(([k, t]) => `<label class="row" style="gap:6px"><input type="color" data-typecolor="${k}" value="${TM.state.typeColors[k]}" style="width:28px;height:22px;padding:0;border:0;background:none" aria-label="${t} colour"><span>${t}</span></label>`).join('')}</div>` : '') +
      `<div><div style="margin-bottom:6px">Inside symbol shows</div><div class="seg">${[['none', 'None'], ['code', 'Code'], ['full', 'Full'], ['ordinal', 'Sequence']].map(([v, t]) => `<button data-nummode="${v}" class="${(TM.state.numberMode || 'none') === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>` +
      `<label class="check"><input type="checkbox" data-opt="numModeOverride" ${TM.state.numModeOverride ? 'checked' : ''}> Allow a station to override this <span class="hint">(set per-station in its Inspector; a view preference, station data is untouched)</span></label>` +
      SIZE_SLIDERS.map(([k, t, min, max, unit]) => `<div class="row" style="justify-content:space-between"><span>${t}</span><div class="row"><input type="range" min="${min}" max="${max}" value="${TM.state[k]}" data-num="${k}" style="width:110px" aria-label="${t}"><b data-numval="${k}" style="width:42px;text-align:right">${TM.state[k]}${unit}</b></div></div>`).join('') + '</div></div>';
    const userMap = store.userMap;
    html += `<div class="sec"><div class="sec-h"><h3>Share</h3></div><p class="hint" style="margin-top:0">` +
      (userMap ? 'Everything in this map is yours to edit and lives in this browser. Share it as one zip — others import it, or unzip it into <code>maps/</code> to publish it.'
        : `${mine} new station${mine === 1 ? '' : 's'} created by you${movedN ? ` and ${movedN} moved or re-linked` : ''}. Export them with the line JSON and send both to the collection — or share the whole map as a zip.`) +
      `</p><div class="row wrap"><button class="btn sm primary" id="expMap" title="Stations, lines, icons and logo of this map in one file">${TM.icon('zip')} Map (.zip)</button>` +
      (userMap ? '' : `<button class="btn sm" id="expStn" ${mine + movedN ? '' : 'disabled'}>${TM.icon('download')} Stations JSON</button>`) +
      `<button class="btn sm" id="expLn" ${activeLine ? '' : 'disabled'}>${TM.icon('download')} Line JSON</button>` +
      `<button class="btn sm" id="expKml" title="Pick lines to save as a KML file (Google Earth, My Maps, GIS)">${TM.icon('download')} Lines KML</button>` +
      `<button class="btn sm" id="impKml" title="Bring in chosen folders / placemarks of a KML or KMZ file as lines and stations">${TM.icon('upload')} Import KML</button></div></div>`;
    panel.innerHTML = html; panel.scrollTop = scrollTop;
    if (activeLine && canEdit) ui.searchStations($('stSearch'), { placeholder: 'Search existing stations to add…', exclude: () => new Set(activeLine.path.filter((i) => i.s).map((i) => i.s)), onPick: (s) => { actions.addStationToLine(s.id); } });
    else if (activeLine) ui.searchStations($('stSearch'), { placeholder: 'Search a station to suggest…', exclude: () => new Set(activeLine.path.filter((i) => i.s).map((i) => i.s)), onPick: (s) => { actions.suggestStation(s.id); } });
  }
  /* Real map: how long the selected line is, by the style each piece is drawn in, and in all. */
  const LEN_NAMES = { solid: 'Solid', dash: 'Dashed', dashdot: 'Dash-dot', hatch: 'Stripes', dotted: 'Dotted (abandoned / demolished)', suggested: 'Suggested stops (dashed)' };
  function lengthTable(line) {
    const lengths = store.geoLengths(store.effectiveLine(line, TM.state.showSuggested)), toKm = (m) => (m / 1000).toFixed(2) + ' km';
    const rows = Object.keys(LEN_NAMES).filter((k) => lengths.by[k] > 0).map((k) => `<dt>${LEN_NAMES[k]}</dt><dd>${toKm(lengths.by[k])}</dd>`).join('');
    const structRows = Object.keys(lengths.struct || {}).some((k) => k !== 'grade') ? Object.entries(TM.STRUCTURES_LEN).filter(([k]) => lengths.struct[k] > 0).map(([k, t]) => `<dt>${t}</dt><dd>${toKm(lengths.struct[k])}</dd>`).join('') : '';
    return `<div class="lbl" style="margin:0 0 6px">Length on the real map</div><dl class="kv" style="margin-bottom:10px">${rows}<dt><b>Total</b></dt><dd><b>${toKm(lengths.total)}</b></dd></dl>` +
      (structRows ? `<div class="lbl" style="margin:0 0 6px">By structure <span style="font-weight:500">(real-map markers)</span></div><dl class="kv" style="margin-bottom:10px">${structRows}</dl>` : '');
  }
  /* Display sliders: view settings for the whole map, like the label size (state key, label, min, max, unit shown) */
  const SIZE_SLIDERS = [['labelSize', 'Label font size', 8, 24, ''], ['lineWidth', 'Line thickness', 3, 20, ''], ['symbolScale', 'Symbol size', 50, 200, '%'], ['connWidth', 'Connecting line thickness', 2, 16, '']];
  const rowBtns = (i, n, first = 0) => `<span class="row" style="gap:0"><button class="btn sm ghost icon-btn" data-mv="-1" data-i="${i}" style="width:24px;padding:0" ${i <= first ? 'disabled' : ''}>${TM.icon('up')}</button><button class="btn sm ghost icon-btn" data-mv="1" data-i="${i}" style="width:24px;padding:0" ${i === n - 1 ? 'disabled' : ''}>${TM.icon('down')}</button><button class="btn sm ghost icon-btn" data-rm="${i}" style="width:24px;padding:0">${TM.icon('x')}</button></span>`;

  function wireLeft() {
    const panel = $('left');
    panel.addEventListener('click', (e) => {
      const target = e.target, activeLine = actions.activeLine();
      let button;
      if ((button = target.closest('[data-eye]'))) { const id = button.dataset.eye; if (store.visible.has(id)) store.visible.delete(id); else store.visible.add(id); if (TM.state.activeLineId === id && !store.visible.has(id)) { TM.state.activeLineId = null; TM.emit('active'); } store.save(true); TM.emit('visibility'); return; }
      if ((button = target.closest('[data-mv]'))) { const i = +button.dataset.i, j = i + +button.dataset.mv; if (activeLine.rootId && (i === 0 || j === 0)) return; const path = activeLine.path; [path[i], path[j]] = [path[j], path[i]]; store.save(); return; }
      if ((button = target.closest('[data-br-rm]'))) { const branchLine = store.line(store.rootId(activeLine) + '~' + button.dataset.brRm); if (branchLine && confirm(`Remove this branch (${branchLine.path.filter((i) => i.s).length - 1} stops)? Its stations stay.`)) actions.removeBranch(branchLine.id); return; }
      if ((button = target.closest('[data-line-go]'))) { actions.setActive(button.dataset.lineGo); return; }
      if ((button = target.closest('[data-svc-show]'))) { const service = store.services.find((x) => x.id === button.dataset.svcShow); ui.showService(TM.state.svcShown === button.dataset.svcShow ? null : service); renderLeft(); return; }
      if ((button = target.closest('[data-tt-line]'))) { ui.openScheduleDialog({ line: button.dataset.ttLine }); return; }
      if ((button = target.closest('[data-tt-svc]'))) { ui.openScheduleDialog({ service: button.dataset.ttSvc }); return; }
      if ((button = target.closest('[data-svc-edit]'))) { ui.openServiceDialog(store.services.find((x) => x.id === button.dataset.svcEdit), store.rootId(activeLine)); return; }
      if ((button = target.closest('[data-svc-rm]'))) { const service = store.services.find((x) => x.id === button.dataset.svcRm); if (service && confirm(`Delete the service “${service.name}”?`)) actions.removeService(service.id); return; }
      if ((button = target.closest('[data-rm]'))) { actions.removeItem(+button.dataset.rm); return; }
      if ((button = target.closest('[data-sugview]')) && activeLine) { store.setSuggestView(activeLine.id, button.dataset.sugview); TM.emit('visibility'); return; }
      if ((button = target.closest('[data-sugacc]'))) { const [stationId, lineId] = button.dataset.sugacc.split('|'); actions.acceptSuggestion(stationId, lineId); return; }
      if ((button = target.closest('[data-sugdis]'))) { const [stationId, lineId] = button.dataset.sugdis.split('|'); actions.dismissSuggestion(stationId, lineId); return; }
      if ((button = target.closest('[data-go]'))) { focusStation(button.dataset.go); return; }
      if ((button = target.closest('[data-nummode]'))) { TM.state.numberMode = button.dataset.nummode; renderLeft(); if (TM.state.selected) renderRight(); TM.emit('display'); return; }
      if ((button = target.closest('.stn-item'))) { button.dataset.sid ? focusStation(button.dataset.sid) : actions.select({ type: 'wp', index: +button.dataset.wpi }); return; }
      if ((button = target.closest('.line-item'))) { const id = button.dataset.line; actions.setActive(TM.state.activeLineId === id ? null : id); if (TM.state.activeLineId) { store.visible.add(store.rootId(id)); fitLine(id); } return; }
      const root = activeLine && (store.rootLine(activeLine) || activeLine);   // a branch's line: renaming, copying, exporting or deleting is the whole line's
      const ids = { newLine: () => ui.openLineDialog(), addStn: () => ui.openStationDialog({}), sugStn: () => ui.openStationDialog({}), sugReset: () => { store.suggestView = {}; store.save(true); TM.emit('visibility'); }, lnEdit: () => ui.openLineDialog(root), lnDup: () => actions.duplicateLine(root.id), lnExp: () => TM.exportUI.lineJSON(root.id), expLn: () => TM.exportUI.lineJSON(root.id), expKml: () => TM.kml.openExport(activeLine && activeLine.id), impKml: () => TM.kml.openImport(), legEdit2: () => ui.openLegendDialog(),
        brBack: () => actions.setActive(root.id), brDel: () => { if (confirm('Remove this branch? Its stations stay.')) actions.removeBranch(activeLine.id); }, svcNew: () => ui.openServiceDialog(null, root.id), expStn: () => TM.exportUI.stationsJSON(), expMap: () => ui.exportMap(TM.maps.current.id), lnDel: () => { if (confirm(`Delete line ${root.code}? Your stations stay in the database.`)) store.removeLine(root.id); }, badgeReset: () => actions.resetBadges(activeLine.id) };
      if (target.closest('button') && ids[target.closest('button').id]) ids[target.closest('button').id]();
    });
    panel.addEventListener('input', (e) => {
      if (e.target.dataset.typecolor) { TM.state.typeColors[e.target.dataset.typecolor] = e.target.value; renderLegend(); TM.emit('display'); return; }
      const key = e.target.dataset.num, slider = key && SIZE_SLIDERS.find((d) => d[0] === key);
      if (!slider) return;
      TM.state[key] = +e.target.value;
      panel.querySelector(`[data-numval="${key}"]`).textContent = e.target.value + slider[4];
      TM.emit('display');
    });
    panel.addEventListener('change', (e) => {
      if (e.target.dataset.opt) { const key = e.target.dataset.opt; TM.state[key] = e.target.checked; if (key === 'showLegend' || key === 'colorByType') renderLegend(); if (key === 'colorByType') renderLeft(); if (key === 'numModeOverride' && TM.state.selected) renderRight(); TM.emit('display'); }
      if (e.target.id === 'authorIn') { store.author = e.target.value.trim() || 'me'; store.save(true); }
      if (e.target.id === 'svcOnly') { const root = store.rootLine(actions.activeLine()); if (root && actions.canEdit(root)) { root.servicesOnly = e.target.checked; store.save(); } }
    });
  }

  function fitLine(id) {
    const line = store.line(id);
    if (TM.state.mode === 'map' && TM.map.map && line) {
      const points = line.path.filter((i) => i.s).map((i) => store.stations.get(i.s)).filter(Boolean).map((s) => [s.lat, s.lng]);
      if (points.length) TM.map.map.fitBounds(points, { padding: [60, 60] });
    }
  }
  function focusStation(id) {
    actions.select({ type: 'station', id });
    const station = store.stations.get(id);
    if (TM.state.mode === 'map' && TM.map.map && station) TM.map.map.flyTo([station.lat, station.lng], Math.max(TM.map.map.getZoom(), 15));
    else if (TM.canvas.model && TM.canvas.model.pos.get(id)) { const point = TM.canvas.model.pos.get(id); TM.canvas.centerOn(point.x, point.y); }
  }
  ui.focusStation = focusStation;

  /* ================= RIGHT ================= */
  let rtab = 'inspect';
  function renderRight() {
    const panel = $('right');
    panel.innerHTML = `<div class="tabs"><button data-tab="inspect" class="${rtab === 'inspect' ? 'on' : ''}">Inspector</button><button data-tab="hot" class="${rtab === 'hot' ? 'on' : ''}">Suggestions ${TM.icon('users', '').replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-2px"')}</button></div><div id="rBody"></div>`;
    $('rBody').innerHTML = rtab === 'inspect' ? inspector() : hotspots();
    if (rtab === 'inspect') wireInspector();
    ui.hexInputs($('rBody'));
  }

  const symPreview = (kind) => {
    const symbols = TM.symbols, palette = symbols.palette(document.documentElement.dataset.theme), colour1 = '#e11d48', colour2 = '#2563eb';
    if (kind === 'auto') return '<text y="5" text-anchor="middle" font-size="13" font-weight="800" fill="currentColor">A</text>';
    if (kind === 'capsule') return symbols.multi(0, 0, { pal: palette, style: 'capsule', items: [{ color: colour1 }, { color: colour2 }], axis: { x: 1, y: 0 } }).svg;
    if (kind === 'stack') return symbols.multi(0, 0, { pal: palette, style: 'stack', items: [{ color: colour1 }, { color: colour2 }, { color: '#16a34a' }], axis: { x: 1, y: 0 } }).svg;
    if (kind === 'chain') return `<g transform="scale(.62)">${symbols.multi(0, 0, { pal: palette, style: 'chain', items: [{ color: colour1, num: '8' }, { color: colour2, num: '17' }], showNum: true, axis: { x: 1, y: 0 } }).svg}</g>`;
    if (kind === 'link' || kind === 'walkway') { const connector = symbols.connector({ x: -19, y: 0 }, { x: 19, y: 0 }, kind === 'walkway' ? 'connect' : 'link', palette); return connector + symbols.station(-19, 0, { pal: palette, kind: 'station' }) + symbols.station(19, 0, { pal: palette, kind: 'station' }); }
    if (kind === 'disc') return symbols.station(0, 0, { pal: palette, kind: 'disc', status: 'operational', fill: colour1 });
    if (kind === 'pill') return symbols.station(0, 0, { pal: palette, kind: 'pill', status: 'operational', fill: colour1, num: '12' });
    if (kind === 'tick' || kind === 'dash') return `<path d="M0 -15V15" stroke="${palette.ink}" stroke-width="6"/>` + symbols.station(0, 0, { pal: palette, kind, status: 'operational', fill: palette.ink, dir: { x: 1, y: 0 }, lineW: 6 });   // on a piece of line, in the station-border colour
    if (kind === 'ix') return symbols.station(0, 0, { pal: palette, kind: 'interchange', status: 'operational' });
    return symbols.station(0, 0, { pal: palette, kind: kind, status: 'operational', dir: { x: 0, y: -1 } });
  };

  /* Point marker on a bend of the line being edited (TM.MARKS): what it marks, and for a tunnel / viaduct which way the
     stretch runs from it. Each picture is the marker itself on a short piece of line. */
  const markPreview = (k, s, color) => {
    const palette = TM.symbols.palette(document.documentElement.dataset.theme), glyph = k ? TM.symbols.mark(TM.normMark({ k, s }), 6, palette) : { under: '', over: '' };
    const range = k && TM.MARKS[k].range, sideX = s === 'b' ? -1 : 1;
    const rails = range === 'elevated' ? `<path d="M0 0H${sideX * 22}" stroke="${palette.muted}" stroke-width="16"/><path d="M0 0H${sideX * 22}" stroke="${palette.paper}" stroke-width="12"/>` : '';
    const line = range === 'tunnel' ? `<path d="M-22 0H0" stroke="${color}" stroke-width="6" ${sideX < 0 ? 'stroke-dasharray="2.7 2.4"' : ''}/><path d="M0 0H22" stroke="${color}" stroke-width="6" ${sideX > 0 ? 'stroke-dasharray="2.7 2.4"' : ''}/>` : `<path d="M-22 0H22" stroke="${color}" stroke-width="6"/>`;
    return `<svg width="44" height="44" viewBox="-22 -22 44 44" style="transform:rotate(-90deg)">${rails}${glyph.under}${line}${glyph.over}</svg>`;
  };
  ui.markPreview = markPreview;   // shared with the real map's marker popup
  function markSection(index, line) {
    const item = line && line.path[index];
    if (!item) return '';
    const can = actions.canEdit(line), mk = item.mk || null, color = TM.lineColor(store.rootLine(line) || line);
    const kinds = [['', 'None'], ...Object.entries(TM.MARKS).map(([k, m]) => [k, m.name])];
    return `<div class="sec"><div class="sec-h"><h3>Point marker</h3></div><div class="sym-grid">${kinds.map(([k, t]) => `<button data-mark="${k}" class="${(mk ? mk.k : '') === k ? 'on' : ''}" ${can ? '' : 'disabled'}>${markPreview(k, mk && mk.k === k ? mk.s : 'a', color)}${t}</button>`).join('')}</div>` +
      (mk && TM.MARKS[mk.k].range ? `<div class="row" style="justify-content:space-between;margin-top:8px;gap:8px"><span>The ${TM.MARKS[mk.k].range === 'tunnel' ? 'tunnel' : 'viaduct'}</span><div class="seg"><button data-markside="b" class="${mk.s === 'b' ? 'on' : ''}" ${can ? '' : 'disabled'}>Ends here</button><button data-markside="a" class="${mk.s !== 'b' ? 'on' : ''}" ${can ? '' : 'disabled'}>Starts here</button></div></div>` +
        `<p class="hint" style="margin:6px 0 0">“Starts here” runs on along the line's own order, up to the next marker that ends it. ${TM.MARKS[mk.k].range === 'tunnel' ? 'A tunnel is drawn striped unless its segments have a style of their own.' : 'An elevated stretch gets grey rails on both sides; its own line style (dashed, stripes…) still shows between them.'}</p>` : '') +
      `<p class="hint" style="margin:8px 0 0">Schematic only — markers on the real map are set on its own route bends (Real map → Bend route → click a bend).</p></div>`;
  }

  /* The "Line segment" section of one line at one of its stops: the style, time and platform of the stretch from the
     previous stop and to the next. Its inputs name the line (data-seg-line on the section), so it works for any line
     at the station, not only the active one. */
  const segSection = (index, line) => {
    if (!actions.canEdit(line)) return '';
    const segButtons = (i, label) => {
      const current = (line.path[i] && line.path[i].seg) || 'auto';
      return `<div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="hint">${label}</span></div><div class="sym-grid" style="margin-bottom:8px">${Object.entries(TM.SEG_STYLES).map(([v, t]) => `<button data-segset="${i}:${v}" class="${current === v ? 'on' : ''}">${TM.segSwatch(v)}${t}</button>`).join('')}</div>`;
    };
    /* travel times live on the stops only: a stop's time to the next stop of the line and back (timeBack) — bends
       carry none. Shown for this stop and its neighbouring stop on each side, both ways. */
    const stopAt = (from, step) => { let j = from + step; while (line.path[j] && !line.path[j].s) j += step; return line.path[j] && line.path[j].s ? j : -1; };
    const nameAt = (j) => { const st = store.stations.get(line.path[j].s); return st ? TM.nameOf(st, TM.state.langs[0]) : line.path[j].s; };
    const minutesInput = (i, field, label) => {
      const item = line.path[i], value = item && isFinite(item[field]) ? item[field] : '';
      const placeholder = field === 'timeBack' && item && item.time ? item.time : '—';   // no time back: the same as there
      return `<div class="row" style="justify-content:space-between;margin:2px 0 6px"><span class="hint">${TM.esc(label)}</span><div class="row" style="gap:4px"><input class="input" type="number" min="0" max="999" step="0.5" placeholder="${placeholder}" value="${value}" data-timeset="${i}:${field}" style="width:70px;height:28px" aria-label="${TM.esc(label)} in minutes"><span class="hint">min</span></div></div>`;
    };
    const timeRows = (side) => {
      const item = line.path[index];
      if (!item || !item.s) return '';
      const other = stopAt(index, side === 'next' ? 1 : -1);
      if (other < 0) return '';
      const here = nameAt(index), there = nameAt(other), from = side === 'next' ? index : other;   // the stop whose item holds this stretch's times
      const forward = side === 'next' ? `${here} → ${there}` : `${there} → ${here}`, backward = side === 'next' ? `${there} → ${here}` : `${here} → ${there}`;
      return `<div style="margin:0 0 6px">${minutesInput(from, 'time', forward)}${minutesInput(from, 'timeBack', backward)}</div>`;
    };
    /* the platform this line uses at the stop, towards its previous / next stop — kept on the line's own item, like its
       time, so a station on several lines has platforms of its own on each. Named after the stop it heads for. */
    const platformRow = (direction) => {
      const item = line.path[index];
      if (!item || !item.s) return '';
      const step = direction === 'next' ? 1 : -1;
      let j = index + step;
      while (line.path[j] && !line.path[j].s) j += step;
      const to = line.path[j] && store.stations.get(line.path[j].s), value = (item.platform && item.platform[direction]) || '';
      return `<div class="row" style="justify-content:space-between;margin:-4px 0 10px"><span class="hint">Platform towards ${TM.esc(to ? TM.nameOf(to, TM.state.langs[0]) : direction === 'next' ? 'the next stop' : 'the previous stop')}</span><input class="input" maxlength="12" placeholder="—" value="${TM.esc(value)}" data-pfset="${index}:${direction}" style="width:70px;height:28px" aria-label="Platform towards the ${direction === 'next' ? 'next' : 'previous'} stop"></div>`;
    };
    const parts = [];
    if (index > 0) parts.push(segButtons(index - 1, 'From previous stop'), timeRows('prev'), platformRow('prev'));
    if (index < line.path.length - 1) parts.push(segButtons(index, 'To next stop'), timeRows('next'), platformRow('next'));
    const root = store.rootLine(line) || line;
    /* always name the line, so the section reads the same whether or not a line is being edited */
    const title = ` <span class="line-pill" style="margin-left:6px;"background:${TM.lineColor(root)};color:${TM.symbols.contrast(TM.lineColor(root))}">${TM.esc(root.code)}</span>`;
    return parts.length ? `<div class="sec" data-seg-line="${TM.esc(line.id)}"><div class="sec-h"><h3>Line segment${title}</h3></div>${parts.join('')}<p class="hint" style="margin:6px 0 0">Or use the Line style tool (D) on the canvas; Shift+click extends over a range. Times are stop to stop, each way — entering one fills the other way while it is empty. A station on several lines keeps its own times and platforms on each.</p></div>` : '';
  };

  /* ---- station links: interchange / connecting station / unofficial connection ---- */
  let linkType = 'interchange';
  function connectionsSection(station) {
    const rows = store.connectionsOf(station.id), direct = new Set(rows.map((r) => r.other));
    const indirect = store.members(station.id).filter((id) => id !== station.id && !direct.has(id));
    const typeSel = (cur, attr) => `<select class="input" ${attr} style="height:28px;width:auto;padding:0 6px;font-size:12px">${Object.entries(TM.LINK_TYPES).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${TM.esc(v.short)}</option>`).join('')}</select>`;
    let html = `<div class="sec"><div class="sec-h"><h3>Connections</h3></div>`;
    html += rows.length ? rows.map((row) => {
      const other = store.stations.get(row.other);
      return `<div class="stn-item" data-go="${TM.esc(row.other)}"><span class="code">${TM.esc(row.other)}</span><span class="nm">${TM.esc(other ? TM.nameOf(other, TM.state.langs[0]) : '')}</span>${typeSel(row.type, `data-cchg="${TM.esc(row.other)}"`)}<button class="btn sm ghost icon-btn" data-cdel="${TM.esc(row.other)}" title="Remove this link" style="width:24px;padding:0">${TM.icon('x')}</button></div>` +
        `<div class="row" style="justify-content:flex-end;gap:4px;margin:-2px 0 8px"><span class="hint" style="margin-right:auto">Avg. travel time</span>` +
        `<span class="hint">to</span><input class="input" type="number" min="0" max="999" step="0.5" placeholder="—" value="${row.time || ''}" data-ctime="${TM.esc(row.other)}" data-cdir="to" style="width:56px;height:24px;padding:0 4px;font-size:12px" aria-label="Minutes from ${TM.esc(station.id)} to ${TM.esc(row.other)}">` +
        `<span class="hint">back</span><input class="input" type="number" min="0" max="999" step="0.5" placeholder="—" value="${row.timeReturn || ''}" data-ctime="${TM.esc(row.other)}" data-cdir="back" style="width:56px;height:24px;padding:0 4px;font-size:12px" aria-label="Minutes from ${TM.esc(row.other)} to ${TM.esc(station.id)}"><span class="hint">min</span></div>`;
    }).join('') : '<p class="hint" style="margin:0 0 6px">Not linked to any other station.</p>';
    if (indirect.length) html += `<p class="hint" style="margin:6px 0 0">Same interchange: ${indirect.map((id) => `<a href="#" data-go="${TM.esc(id)}">${TM.esc(id)}</a>`).join(', ')}</p>`;
    html += `<div class="lbl" style="margin:12px 0 6px">Link ${TM.esc(station.id)} with another station</div>` +
      `<div class="seg seg-wrap" id="linkTypeSeg">${Object.entries(TM.LINK_TYPES).map(([k, v]) => `<button data-ltype="${k}" class="${linkType === k ? 'on' : ''}" title="${TM.esc(v.tip)}">${TM.esc(v.short)}</button>`).join('')}</div>` +
      `<p class="hint" style="margin:6px 0 8px">${TM.esc(TM.LINK_TYPES[linkType].tip)}${linkType === 'platform' ? `. If the names match, ${TM.esc(station.id)} moves onto the other station's node; if they differ, both keep their own node and are drawn joined.` : linkType === 'interchange' ? `. Both keep their own node and are drawn joined, even if the names match — move one onto the other's node yourself to share one symbol.` : ''}</p><div id="lnkSearch"></div></div>`;
    return html;
  }

  /* ---- block (mega-station): turn an interchange group into one shape, each member free to move within it ---- */
  function blockSection(station) {
    const owner = store.blockOwnerOf(station.id), leadId = owner || store.rep(station.id), repSt = store.stations.get(leadId), block = repSt && repSt.block;
    let html = `<div class="sec"><div class="sec-h"><h3>Block</h3></div>`;
    if (!block) {
      html += `<p class="hint" style="margin-top:0">Turn this station — and everything already interchanging here — into a mega-station block: several stops drawn together in one shape, each free to move, like KL Sentral.</p>` +
        `<button class="btn sm" id="blkOn">${TM.icon('block')} Make a block</button>`;
    } else {
      const conns = store.connectionsOf(leadId).filter((r) => r.type !== 'platform');
      const nMembers = store.blockGroups([...store.complexMembers(leadId), ...(block.merged || []).filter((m) => store.stations.has(m))], block.bundles).length, defSize = Math.max(34, 15 * nMembers);
      html += `<p class="hint" style="margin-top:0">Replaces the usual symbol above. Drag a dot along the ring to place that station, drag the block itself with the Select tool.</p>` +
        `<div class="seg" id="blkStyleSeg"><button data-blkstyle="rapidkl" class="${block.style !== 'shape' ? 'on' : ''}">RapidKL bar</button><button data-blkstyle="shape" class="${block.style === 'shape' ? 'on' : ''}">Shape</button></div>`;
      if (block.style === 'shape') html += `<div class="seg" style="margin-top:6px"><button data-blkshape="circle" class="${block.shape !== 'square' ? 'on' : ''}">Circle</button><button data-blkshape="square" class="${block.shape === 'square' ? 'on' : ''}">Square</button></div>`;
      else html += `<div class="seg" style="margin-top:6px"><button data-blkorient="horizontal" class="${block.orientation !== 'vertical' ? 'on' : ''}">Horizontal</button><button data-blkorient="vertical" class="${block.orientation === 'vertical' ? 'on' : ''}">Vertical</button></div>`;
      html += `<div class="row" style="justify-content:space-between;margin-top:10px"><span class="hint">Size</span><div class="row"><input type="range" min="24" max="160" value="${block.size || defSize}" id="blkSizeR" style="width:110px"><b id="blkSizeVal" style="width:30px;text-align:right">${block.size || defSize}</b></div></div>` +
        `<div class="row" style="justify-content:space-between;margin-top:10px"><span class="hint">Fill colour</span><input type="color" id="blkColor" value="${block.color || (block.style === 'shape' ? '#ffffff' : '#1b2333')}" style="width:44px;height:28px;padding:0;border-radius:8px"></div>` +
        `<div class="field" style="margin-top:10px"><label>Block label <span style="font-weight:500">(the big name, shown instead of the station's own)</span></label><input class="input" id="blkLabel" placeholder="e.g. KL Sentral" value="${TM.esc(block.label || '')}" maxlength="60"></div>`;
      const allMembers = [...store.complexMembers(leadId), ...(block.merged || []).filter((m) => store.stations.has(m))];
      const codeDefault = allMembers.join(' · '), codeLabel = store.codeLabel(leadId);
      html += `<div class="field" style="margin-top:2px"><label>Code text <span style="font-weight:500">(the small text underneath; only changes how it looks here — station data is untouched)</span></label><input class="input" id="blkCode" placeholder="${TM.esc(codeDefault)}" value="${TM.esc(codeLabel.text || '')}" maxlength="60"></div>`;
      const groups = store.blockGroups(allMembers, block.bundles);
      html += `<div class="lbl" style="margin:12px 0 6px">Group stations together <span style="font-weight:500">(view only — same group, one shared symbol; blank keeps it on its own)</span></div><div style="display:grid;gap:6px">` +
        allMembers.map((memberId) => {
          const member = store.stations.get(memberId);
          return `<div class="row" style="gap:8px"><span class="code" style="min-width:44px;text-align:center">${TM.esc(memberId)}</span><span class="nm hint" style="flex:1">${TM.esc(member ? TM.nameOf(member, TM.state.langs[0]) : memberId)}</span><input class="input" data-blkgroup="${TM.esc(memberId)}" value="${TM.esc((block.bundles || {})[memberId] || '')}" placeholder="—" style="width:64px"></div>`;
        }).join('') + '</div>';
      const bundled = groups.filter((g) => g.ids.length > 1);
      if (bundled.length) html += `<p class="hint" style="margin:2px 0 0">Select a grouped station above and use its Symbol section to pick how the group is drawn (capsule, stacked…).</p>`;
      if (conns.length) {
        html += `<div class="lbl" style="margin:12px 0 6px">Merge a connecting station into the block</div><div style="display:grid;gap:6px">` + conns.map((row) => {
          const other = store.stations.get(row.other), merged = (block.merged || []).includes(row.other);
          return `<label class="check"><input type="checkbox" data-blkmerge="${TM.esc(row.other)}" ${merged ? 'checked' : ''}> <b>${TM.esc(row.other)}</b> · ${TM.esc(other ? TM.nameOf(other, TM.state.langs[0]) : row.other)}</label>`;
        }).join('') + '</div>';
      }
      html += `<div class="row wrap" style="margin-top:12px"><button class="btn sm danger" id="blkOff">${TM.icon('trash')} Remove block</button>${store.isBlockEdited(leadId) ? `<button class="btn sm ghost" id="blkReset">↺ Reset</button>` : ''}</div>`;
    }
    return html + '</div>';
  }

  /* Rotation picker shared by station labels and free-floating labels: a 3×3 pad like the label-position one, each
     button showing an "a" turned to that direction (e = upright, 0°; clockwise from there), plus an exact angle box. */
  const ROT_DIRS = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const rotSection = (current, hint) => {
    const grid = ['nw', 'n', 'ne', 'w', '', 'e', 'sw', 's', 'se'];
    return `<div class="row" style="margin-top:12px;align-items:flex-start;gap:18px"><div class="pad3 rot">${grid.map((g) => `<button data-rot="${g ? ROT_DIRS[g] : ''}" class="${g && ROT_DIRS[g] === current ? 'on' : ''}" ${g ? `title="${ROT_DIRS[g]}°" aria-label="Rotate to ${ROT_DIRS[g]} degrees"` : 'disabled'}>${g ? `<span style="transform:rotate(${ROT_DIRS[g]}deg)">a</span>` : ''}</button>`).join('')}</div>` +
      `<div style="display:grid;gap:6px"><span class="hint">Rotation</span><div class="row" style="gap:4px"><input class="input" type="number" step="any" id="rotIn" value="${current}" style="width:84px;height:30px" aria-label="Rotation in degrees"><span class="hint">°</span></div><span class="hint">${hint}</span></div></div>`;
  };

  const kindName = (k) => (k === 'block' ? 'Block' : (TM.SYMBOLS[k] || { short: k || 'Auto' }).short);

  function inspector() {
    const selection = TM.state.selected, activeLine = actions.activeLine();
    if (selection && selection.type === 'wp' && activeLine && activeLine.path[selection.index]) {
      const bendItem = activeLine.path[selection.index];
      return markSection(selection.index, activeLine) + `<div class="sec"><h3 style="margin:0 0 8px">Bend point</h3><p class="hint">Node (${bendItem.x}, ${bendItem.y}). Drag it to another node with the Select tool; the line turns here with a rounded corner.</p>${actions.canEdit(activeLine) ? `<div class="row wrap"><button class="btn sm" id="insMove">${TM.icon('cursor')} Move</button><button class="btn sm danger" id="insRm">${TM.icon('trash')} Remove bend</button></div>` : ''}</div>` + segSection(selection.index, activeLine);
    }
    if (selection && selection.type === 'ann') {
      const annotation = store.annotations[selection.id];
      if (!annotation) return `<div class="sec"><div class="empty"><p>This label was removed.</p></div></div>`;
      return `<div class="sec"><h3 style="margin:0 0 8px">${annotation.kind === 'image' ? 'Image label' : 'Text label'}</h3>` +
        (annotation.kind === 'image' ? `<div class="row" style="gap:10px"><img alt="" src="${TM.images.get(annotation.file) || ''}" style="width:40px;height:40px;object-fit:contain"><span class="hint">${TM.esc(annotation.file)}</span></div>` : `<p style="margin:0;font-weight:700;color:${annotation.color || 'inherit'}">${TM.esc(annotation.text)}</p>`) +
        `<p class="hint">Drag it on the canvas to move it, or use the arrow keys. It is a view-local extra, not part of any station or line.</p>` +
        rotSection(annotation.rot || 0, 'Clockwise, 0 – 359.99') +
        `<div class="row wrap" style="margin-top:8px"><button class="btn sm" id="annEdit">${TM.icon('edit')} Edit</button><button class="btn sm danger" id="annRm">${TM.icon('trash')} Delete</button></div></div>`;
    }
    if (selection && selection.type === 'draw') {
      const d = store.drawingById(selection.id);
      if (!d) return `<div class="sec"><div class="empty"><p>This drawing was removed.</p></div></div>`;
      const can = actions.ownsMap(), dis = can ? '' : 'disabled', pt = selection.pt != null && d.pts[selection.pt] ? selection.pt : null;
      const PRESETS = { area: ['#cfe6c4', '#b9dcf2', '#e8e1cf', '#f1d6d6', '#dcdcdc'], line: ['#9cc6ea', '#5b8fc7', '#b9c2cf', '#e8b77a', '#9aa5b1'] }[d.kind];
      const slider = (attr, value, min, max, label) => `<div class="row" style="justify-content:space-between;gap:8px"><span>${label}</span><div class="row"><input type="range" ${attr} min="${min}" max="${max}" value="${value}" style="width:120px" ${dis}><b data-dval style="width:40px;text-align:right">${value}</b></div></div>`;
      return `<div class="sec"><h3 style="margin:0 0 8px">${store.DRAW_KINDS[d.kind]} drawing</h3><p class="hint" style="margin-top:0">${d.pts.length} points · drawn under the map. Drag a point to move it, drag a half-way handle to add one, double-click a point to remove it. Arrow keys move ${pt != null ? 'the picked point' : 'the whole drawing'}.</p>` +
        `<div class="seg" style="margin-bottom:10px">${Object.entries(store.DRAW_KINDS).map(([k, t]) => `<button data-dkind="${k}" class="${d.kind === k ? 'on' : ''}" ${dis}>${t}</button>`).join('')}</div>` +
        `<div class="lbl" style="margin:0 0 6px">Colour</div><div class="row wrap" style="gap:6px;margin-bottom:10px">${PRESETS.map((c) => `<button type="button" data-dcolor="${c}" ${dis} style="width:24px;height:24px;border-radius:50%;background:${c};border:2px solid ${d.color === c ? 'var(--accent)' : 'var(--line)'};cursor:pointer" aria-label="${c}"></button>`).join('')}<input type="color" id="dColor" value="${d.color}" ${dis} style="width:40px;height:26px;padding:0;border-radius:6px" aria-label="Colour"></div>` +
        `<div style="display:grid;gap:8px">` +
        slider('data-dop', Math.round(d.opacity * 100), 5, 100, 'Opacity %') +
        (d.kind === 'line' ? slider('data-dw', d.width, 1, 120, 'Width') : '') +
        (d.kind === 'area' ? `<label class="check"><input type="checkbox" id="dOutline" ${d.outline ? 'checked' : ''} ${dis}> Outline</label>` + (d.outline ? `<input type="color" id="dOutlineC" value="${d.outline}" ${dis} style="width:40px;height:26px;padding:0;border-radius:6px" aria-label="Outline colour">` : '') : '') +
        `<label class="check"><input type="checkbox" id="dSmooth" ${d.smooth ? 'checked' : ''} ${dis}> Smooth curves through the points</label></div>` +
        (can ? `<div class="row wrap" style="margin-top:10px;gap:6px"><button class="btn sm" data-dorder="1">Bring forward</button><button class="btn sm" data-dorder="-1">Send backward</button>${pt != null ? `<button class="btn sm" id="dPtRm">Remove point</button>` : ''}<button class="btn sm danger" id="dRm">${TM.icon('trash')} Delete</button></div>` : `<p class="hint">Only the map's own author can change it.</p>`) + '</div>' +
        drawLayerSection(can);
    }
    if (selection && selection.type === 'badge') {
      const line = store.line(selection.line), root = line && (store.rootLine(line) || line);
      if (!line) return `<div class="sec"><div class="empty"><p>This line was removed.</p></div></div>`;
      const current = root.badgeStyle || 'pill', can = actions.canEdit(root), palette = TM.symbols.palette(document.documentElement.dataset.theme), color = TM.lineColor(root);
      const pic = TM.lineImage(root);
      const preview = (style) => style === 'picture'
        ? (pic ? `<svg width="44" height="44" viewBox="-22 -22 44 44">${TM.symbols.picture(0, 0, pic, { w: 40, h: 30 })}</svg>` : `<svg width="44" height="44" viewBox="-22 -22 44 44"><rect x="-16" y="-12" width="32" height="24" rx="4" fill="none" stroke="currentColor" stroke-dasharray="3 3" opacity=".5"/></svg>`)
        : style === 'flag'
        ? `<svg width="44" height="44" viewBox="-22 -22 44 44">${TM.symbols.flag(0, 22, { x: 0, y: -1 }, root.code, color, palette, 5).svg.replace('font-size="12"', 'font-size="11"')}</svg>`   // its foot on the bottom edge, like the pill's line
        : style === 'hidden'
        ? `<svg width="44" height="44" viewBox="-22 -22 44 44"><path d="M0 22 L0 10" stroke="${color}" stroke-width="5"/><rect x="-14" y="-15" width="28" height="22" rx="7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" opacity=".5"/><path d="M-10 -11 L10 3" stroke="currentColor" stroke-width="1.5" opacity=".5"/></svg>`
        : `<svg width="44" height="44" viewBox="-22 -22 44 44"><path d="M0 22 L0 10" stroke="${color}" stroke-width="5"/>${TM.symbols.badge(0, -4, root.code, color, palette)}</svg>`;
      return `<div class="sec"><h3 style="margin:0 0 8px">Line badge</h3><p class="hint" style="margin-top:0"><b>${TM.esc(root.code)}</b> ${TM.esc(TM.displayName(root))} · ${selection.end === 's' ? 'start' : 'end'} of the line</p>` +
        `<div class="sec-h"><h3>Style</h3></div><div class="sym-grid">${[['pill', 'Code pill'], ['flag', 'Line-end flag'], ['picture', 'Picture'], ['hidden', 'Hidden']].map(([v, t]) => `<button data-bstyle="${v}" class="${current === v ? 'on' : ''}" ${can && (v !== 'picture' || root.image) ? '' : 'disabled'} ${v === 'picture' && !root.image ? 'title="Link a picture to the line first (Edit line → Picture)"' : ''}>${preview(v)}${t}</button>`).join('')}</div>` +
        `<p class="hint" style="margin:6px 0 0">${current === 'hidden' ? 'No badge is drawn at the line\'s ends — on the map, in exports and in the planner. While you edit the line it shows as a faint outline, so you can click it to bring it back.' : current === 'flag' ? 'The line runs on a little past its last station and ends in a box with its code. It stays fixed to the line\'s end.' : current === 'picture' ? 'The line\'s own picture just past the last station — drag it on the canvas to move it.' : 'A code pill just past the last station — drag it on the canvas to move it.'}${root.image ? '' : ' To use a picture, link one to the line first (Edit line → Picture).'} Applies to both ends of the line${store.branchesOf(root).length ? ' and its branches' : ''}.</p>` +
        (can && current !== 'flag' && current !== 'hidden' && Object.keys(line.badges || {}).length ? `<div class="row wrap" style="margin-top:8px"><button class="btn sm" id="badgeReset2">↺ Reset position</button></div>` : '') +
        (can ? `<div class="row wrap" style="margin-top:8px"><button class="btn sm" id="badgeLnEdit">${TM.icon('edit')} Edit line${root.image ? '' : ' · Add a picture'}</button></div>` : `<p class="hint">Not your line to edit.</p>`) + '</div>';
    }
    if (selection && selection.type === 'conn') {
      const stationA = store.stations.get(selection.a), stationB = store.stations.get(selection.b), count = store.connBends(selection.a, selection.b).length, connection = store.connOf(selection.a, selection.b) || {};
      const title = connection.type === 'interchange' || connection.type === 'platform' ? 'Interchange line' : connection.type === 'walkway' ? 'Unofficial connection' : 'Connecting line';
      const styles = [...Object.entries(TM.SEG_STYLES), ['split', 'Line colours']], currentStyle = connection.style || 'auto', border = connection.border || '';
      return `<div class="sec"><h3 style="margin:0 0 8px">${title}</h3><p class="hint" style="margin-top:0">${TM.esc(stationA ? TM.nameOf(stationA, TM.state.langs[0]) : selection.a)} ↔ ${TM.esc(stationB ? TM.nameOf(stationB, TM.state.langs[0]) : selection.b)}</p>` +
        `<p class="hint">Drag the line to bend it, drag a bend to move it, double-click a bend to remove it.</p>` +
        `<div class="row wrap"><button class="btn sm" id="connReset" ${count ? '' : 'disabled'}>↺ Reset bends${count ? ` (${count})` : ''}</button></div></div>` +
        `<div class="sec"><div class="sec-h"><h3>Line style</h3></div><div class="sym-grid">${styles.map(([v, t]) => `<button data-cstyle="${v}" class="${currentStyle === v ? 'on' : ''}">${TM.segSwatch(v)}${t}</button>`).join('')}</div>` +
        `<p class="hint" style="margin:6px 0 0">${currentStyle === 'split' ? 'Each half is drawn in the colours of the lines at its own end — one band per line, side by side.' : 'Auto keeps the usual look of this kind of link.'}</p>` +
        (currentStyle === 'split' ? '' : `<div class="lbl" style="margin:12px 0 6px">Colour</div><div class="row wrap" style="gap:8px"><div class="seg"><button data-ccolor="" class="${!connection.color ? 'on' : ''}">Default</button><button data-ccolor="color" class="${connection.color ? 'on' : ''}">Colour</button></div>` +
          `<input type="color" id="connColor" value="${connection.color || (connection.type === 'interchange' || connection.type === 'platform' ? TM.symbols.palette(document.documentElement.dataset.theme).paper : TM.symbols.palette(document.documentElement.dataset.theme).walk)}" style="width:44px;height:28px;padding:0;border-radius:8px" aria-label="Line colour"></div>`) +
        `<div class="lbl" style="margin:12px 0 6px">Border</div><div class="row wrap" style="gap:8px"><div class="seg"><button data-cborder="" class="${!border ? 'on' : ''}">Default</button><button data-cborder="none" class="${border === 'none' ? 'on' : ''}">None</button><button data-cborder="color" class="${border && border !== 'none' ? 'on' : ''}">Colour</button></div>` +
        `<input type="color" id="connBorder" value="${border && border !== 'none' ? border : TM.symbols.palette(document.documentElement.dataset.theme).ink}" style="width:44px;height:28px;padding:0;border-radius:8px" aria-label="Border colour"></div></div>`;
    }
    if (!selection || selection.type !== 'station' || !store.stations.get(selection.id)) {
      return `<div class="sec"><div class="empty">${TM.icon('cursor').replace('<svg', '<svg style="width:28px;height:28px;opacity:.5"')}<p>Select a station to see its details, change its symbol or label.</p></div>
        <dl class="kv" style="margin-top:8px"><dt>V</dt><dd>Select / move</dd><dt>S</dt><dd>Station tool</dd><dt>B</dt><dd>Add bend to route</dd><dt>I</dt><dd>Insert before / after</dd><dt>D</dt><dd>Change line style</dd><dt>A</dt><dd>Arc / circle</dd><dt>E</dt><dd>Erase from line</dd><dt>P</dt><dd>Draw under the map</dd><dt>G</dt><dd>Toggle node grid</dd><dt>F</dt><dd>Fit all</dd><dt>Drag</dt><dd>Pan · Scroll to zoom</dd></dl>
        <div class="empty" style="margin-top:14px">${TM.icon('info').replace('<svg', '<svg style="width:28px;height:28px;opacity:.5"')}<p><b>Transit Map Tool</b> — a tool for transit  You can duplicate a map or line to edit yourself, and submit your edits at https://github.com/IcyCod/Transit-Map .</p></div></div>`;
    }
    const station = store.stations.get(selection.id), index = actions.indexOfStation(station.id), canEdit = actions.editable() && index >= 0;
    const item = canEdit ? activeLine.path[index] : null;
    const blockOwnerRep = store.blockOwnerOf(station.id);   // a block's own name label belongs to the block, an interchange's to the whole group — never to this one line item
    const label = blockOwnerRep ? (store.stations.get(blockOwnerRep).block.labelPos || {}) : (store.labelPos[store.rep(station.id)] || (item && item.label) || {});
    const used = store.usedByGroup(station.id), near = store.nearby(station.lat, station.lng, 300, station.id), cluster = store.clusterOf(station.id);
    const info = TM.canvas.model && TM.canvas.model.info.get(station.id);
    /* same platform (one station under several codes) and interchanges (the rest of its complex); a station that is not
       in use yet or any more says so, e.g. "CC09 (planned)" */
    const samePlatform = store.members(station.id).filter((id) => id !== station.id);
    const interchanges = store.complexMembers(station.id).filter((id) => id !== station.id && !samePlatform.includes(id));
    const stationLink = (id) => {
      const other = store.stations.get(id), status = other && other.status;
      const note = status && status !== 'operational' ? ` <span class="hint">(${TM.esc(status === 'fantasy' ? 'suggested' : (TM.STATUSES[status] || status).toLowerCase())})</span>` : '';
      return `<a href="#" data-go="${TM.esc(id)}">${TM.esc(id)}</a>${note}`;
    };
    let html = `<div class="sec"><div class="row" style="justify-content:space-between"><b style="font-size:16px">${TM.esc(station.id)}</b>${pill(station.status)}</div>` +
      TM.LANGS.map((g) => station.names[g.key] ? `<div style="margin-top:4px"><span class="hint" style="display:inline-block;width:34px">${g.short}</span><b>${TM.esc(station.names[g.key])}</b></div>` : '').join('') +
      `<div class="row wrap" style="margin-top:10px">${used.map((l) => `<span class="pill" style="background:${l.color};color:${TM.symbols.contrast(l.color)};border:0">${TM.esc(l.code)}</span>`).join('')}</div></div>`;
    html += `<div class="sec"><dl class="kv"><dt>Coordinates</dt><dd>${station.lat.toFixed(5)}, ${station.lng.toFixed(5)}</dd><dt>Platforms</dt><dd>${TM.esc(TM.platformText(station.platform))}</dd><dt>Structure</dt><dd>${TM.STRUCTURES[station.structure] || '—'}</dd><dt>Opened</dt><dd>${TM.esc(station.opened || '—')}</dd><dt>Closed</dt><dd>${TM.esc(station.closed || '—')}</dd>` +
      (samePlatform.length ? `<dt>Same platform</dt><dd>${samePlatform.map(stationLink).join(', ')}</dd>` : '') +
      (interchanges.length ? `<dt>Interchange</dt><dd>${interchanges.map(stationLink).join(', ')}</dd>` : '') + (station.author && station.status !== 'planned' ? `<dt>Suggested by</dt><dd>${TM.esc(station.author)}</dd>` : '') + (station.note ? `<dt>Note</dt><dd>${TM.esc(station.note)}</dd>` : '') +
      (station.linkedTo.length ? `<dt>Linked to</dt><dd>${station.linkedTo.map((id) => `<a href="#" data-go="${TM.esc(id)}">${TM.esc(id)}</a>`).join(', ')}</dd>` : '') + '</dl>' +
      `<div class="row wrap" style="margin-top:10px"><button class="btn sm" id="insGo">${TM.icon('pin')} Locate</button>${TM.state.mode === 'map' ? `<span class="hint" style="align-self:center">Drag the dashed marker on the map to change its coordinates.</span>` : `<button class="btn sm ${TM.state.moving ? 'primary' : ''}" id="insMove" title="Click, then click a node (M). Or drag the selected station, or use the arrow keys (Shift = 3 nodes).">${TM.icon('cursor')} Move</button>`}${store.isMoved(station.id) ? `<button class="btn sm ghost" id="insUnmove" title="Back to the original position">↺ Reset position</button>` : ''}${actions.ownsStation(station) ? `<button class="btn sm" id="insEdit">${TM.icon('edit')} Edit</button>` : ''}${actions.editable() && index < 0 ? `<button class="btn sm primary" id="insAdd">${TM.icon('plus')} Add to ${TM.esc(activeLine.code)}</button>` : ''}${activeLine && !actions.canEdit(activeLine) && index < 0 && !store.suggestionsOfStation(station.id).some((g) => g.line === activeLine.id) ? `<button class="btn sm primary" id="insSuggest" title="Propose ${TM.esc(station.id)} as a stop on ${TM.esc(activeLine.code)} — the station itself is unchanged">${TM.icon('plus')} Suggest for ${TM.esc(activeLine.code)}</button>` : ''}${canEdit ? `<button class="btn sm" id="insBranch" title="Fork ${TM.esc(activeLine.code)} here: a branch starting at this station, edited like a line">${TM.icon('route')} Start a branch here</button>` : ''}${canEdit ? `<button class="btn sm danger" id="insRm">Remove from line</button>` : ''}</div></div>`;
    if (canEdit && activeLine && !activeLine.loop && activeLine.path.length > 1 && (index === 0 || index === activeLine.path.length - 1)) {
      const end = index === 0 ? 's' : 'e', beyond = activeLine.beyond && activeLine.beyond[end];
      html += `<div class="sec"><div class="sec-h"><h3>Beyond the map</h3></div><p class="hint" style="margin-top:0">This is where ${TM.esc(activeLine.code)} ends on this map — mark it as not a real terminus: the line (and its stations) simply continue past what this map covers.</p>` +
        `<label class="check"><input type="checkbox" id="beyondOn" ${beyond != null ? 'checked' : ''}> Continues beyond the map</label>` +
        (beyond != null ? `<div class="field" style="margin-top:8px"><label>Caption <span style="font-weight:500">(optional, e.g. "to Singapore")</span></label><input class="input" id="beyondLabel" maxlength="60" value="${TM.esc(beyond)}"></div>` : '') + '</div>';
    }
    if (cluster || near.length) {
      html += `<div class="sec"><div class="sec-h"><h3>Same area</h3></div>` + (cluster ? `<p style="margin:0 0 8px"><b style="color:#a855f7">${cluster.authors.length} people</b> suggested a station here: ${TM.esc(cluster.authors.join(', '))}.</p>` : '') +
        (near.length ? near.slice(0, 6).map((n) => `<div class="stn-item" data-go="${TM.esc(n.station.id)}"><span class="code">${TM.esc(n.station.id)}</span><span class="nm">${TM.esc(TM.nameOf(n.station, TM.state.langs[0]))}</span><span class="hint">${TM.fmtDist(n.dist)}</span></div>`).join('') : '') + '</div>';
    }
    html += connectionsSection(station);
    const suggestions = store.suggestionsOfStation(station.id);
    if (suggestions.length) {
      html += `<div class="sec"><div class="sec-h"><h3>Suggested stops</h3></div><p class="hint" style="margin-top:0">${TM.esc(station.id)} is proposed as a stop on:</p>` + suggestions.map((suggestion) => {
        const line = store.lines.get(suggestion.line), mayEdit = actions.canEdit(line), mine = suggestion.author && suggestion.author === store.author;
        if (!line) return '';
        return `<div class="sug-item"><div class="row" style="justify-content:space-between;gap:6px"><span>${codeChip(line)} <b>${lineName(line)}</b></span><span class="row" style="gap:4px;flex:none">${mayEdit ? `<button class="btn sm primary" data-sugacc="${TM.esc(station.id)}|${TM.esc(suggestion.line)}">Accept</button>` : ''}${mayEdit || mine ? `<button class="btn sm ghost" data-sugdis="${TM.esc(station.id)}|${TM.esc(suggestion.line)}">${mayEdit ? 'Dismiss' : 'Withdraw'}</button>` : ''}</span></div>` +
          `<span class="hint">${suggestion.after ? `after <b>${TM.esc(suggestion.after)}</b> ${TM.esc(stnName(suggestion.after))}` : 'at the start'} · by ${TM.esc(suggestion.author || 'anonymous')}${suggestion.note ? ` · “${TM.esc(suggestion.note)}”` : ''}</span></div>`;
      }).join('') + `<p class="hint" style="margin:6px 0 0">${TM.esc(station.id)}'s own status and data are unchanged.</p></div>`;
    }
    if (TM.state.mode !== 'schematic') return html;

    const disabled = canEdit ? '' : 'disabled';
    const blockSlot = store.blockSlotOf(station.id);
    let current, symDis, symHint, symKeys;
    if (blockSlot) {
      const blkSt = store.stations.get(blockSlot.owner).block;
      current = blkSt.symbol[blockSlot.key] || 'auto';
      symDis = '';
      symKeys = blockSlot.ids.length > 1 ? ['auto', 'capsule', 'stack', 'chain', 'interchange'] : Object.keys(TM.SYMBOLS);
      symHint = `Shown only within this block — the station's own data is unchanged.${blockSlot.ids.length > 1 ? ` Grouped with ${blockSlot.ids.filter((i2) => i2 !== station.id).join(', ')}.` : ''}`;
    } else {
      const symbolRef = actions.symbolRef(station.id);
      current = (store.pickSymbol(store.symbolItemsOf(station.id)) || { sym: 'auto' }).sym;   // the whole shared symbol's choice, not just this station's own items
      symDis = symbolRef ? '' : 'disabled';
      symKeys = Object.keys(TM.SYMBOLS);
      symHint = symbolRef ? `Drawn as <b id="symKind">${TM.esc(kindName(info && info.kind))}</b>. When lines share a station, the symbol you chose last is used — otherwise the line highest in the list decides.`
        : 'This station is on none of the lines you can edit. Duplicate a line to change how it is drawn.';
    }
    html += `<div class="sec"><div class="sec-h"><h3>Symbol</h3></div>${!blockSlot && symDis ? `<p class="hint" style="margin-top:0">${symHint}</p>` : ''}<div class="sym-grid">` +
      symKeys.map((k) => `<button data-sym="${k}" title="${TM.esc(TM.SYMBOLS[k].tip)}" class="${current === k ? 'on' : ''}" ${symDis}><svg viewBox="-30 -17 60 34">${symPreview(k)}</svg>${TM.SYMBOLS[k].short}</button>`).join('') + '</div>';
    if (blockSlot || !symDis) html += `<p class="hint" style="margin:8px 0 0">${symHint}</p>`;
    if (TM.state.numModeOverride) {
      const numberMode = store.numMode[store.rep(station.id)] || 'default';
      html += `<div style="margin-top:12px"><div class="hint" style="margin-bottom:6px">Inside symbol shows${info && info.showNum ? ' (shown)' : ''}</div><div class="seg seg-wrap">${[['default', 'Default'], ['none', 'None'], ['code', 'Code'], ['full', 'Full'], ['ordinal', 'Sequence']].map(([v, t]) => `<button data-stnnum="${v}" class="${numberMode === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>` +
        `<p class="hint" style="margin:6px 0 0">Overrides the map-wide "Inside symbol shows" setting for this station only — a view preference, its data is untouched.</p>`;
    }
    html += '</div>';

    html += blockSection(station);

    const position = label.pos || (info && info.labelPos) || 'e', size = (info && info.labelSize) || TM.state.labelSize || 13;
    const grid = ['nw', 'n', 'ne', 'w', '', 'e', 'sw', 's', 'se'], arrows = { nw: '↖', n: '↑', ne: '↗', w: '←', e: '→', sw: '↙', s: '↓', se: '↘' };
    html += `<div class="sec"><div class="sec-h"><h3>Label</h3></div><p class="hint" style="margin-top:0">Where the name sits is a view preference — it works on any station, and an interchange's several lines all share the one place you set.</p><div class="row" style="align-items:flex-start;gap:18px"><div class="pad3">${grid.map((g) => `<button data-lp="${g}" class="${g === position ? 'on' : ''}" ${g ? '' : 'disabled'}>${arrows[g] || ''}</button>`).join('')}</div>` +
      `<div style="display:grid;gap:8px"><label class="check"><input type="checkbox" id="lblHide" ${label.hide ? 'checked' : ''}> Hide label</label><button class="btn sm" id="lblReset">Reset offset</button><span class="hint">Or drag the label on the canvas.</span></div></div>` +
      rotSection(label.rot || 0, 'Clockwise, turned about the end nearest the station') +
      `<div class="row" style="margin-top:12px;justify-content:space-between"><span class="hint">Font size</span><div class="row"><input type="range" min="8" max="30" value="${size}" id="lsizeR" style="width:110px"><input class="input" type="number" min="6" max="40" value="${size}" id="lsize" style="width:64px;height:30px"><button class="btn sm ghost" id="lsizeReset" title="Use default size">↺</button></div></div>`;
    const codeInfo = info && info.codeInfo, codeSetting = store.codeLabel(station.id), codeChoice = codeSetting.show === true ? 'show' : codeSetting.show === false ? 'hide' : 'default';
    if (codeInfo) {
      html += `<div class="row" style="margin-top:12px;justify-content:space-between"><span class="hint">Code label${codeInfo.shown ? '' : ' (hidden)'}</span><div class="seg">${[['default', 'Default'], ['show', 'Show'], ['hide', 'Hide']].map(([v, t]) => `<button data-codeshow="${v}" class="${codeChoice === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>` +
        `<div class="row" style="margin-top:8px"><input class="input" id="codeText" placeholder="${TM.esc(codeInfo.def)}" value="${TM.esc(codeSetting.text || '')}" style="flex:1" aria-label="Custom code label"><button class="btn sm ghost" id="codeReset" title="Use the station's own codes">↺</button></div>` +
        `<p class="hint" style="margin:6px 0 0">Only changes how the map looks in this browser — the station data is not touched.</p>`;
    }
    if (TM.imageList.length) {
      const on = new Set(label.icons || []);
      html += `<div class="lbl" style="margin:12px 0 6px">Icons after the name <span style="font-weight:500">(from this map's images/ folder)</span></div><div class="row wrap">${TM.imageList.map((im) => `<button class="ico ${on.has(im.file) ? 'on' : ''}" data-ico="${TM.esc(im.file)}" title="${TM.esc(im.name)}" ${disabled}><img alt="${TM.esc(im.name)}" src="${TM.images.get(im.file)}"></button>`).join('')}</div>`;
    }
    const specials = (label.icons || []).filter((f) => TM.isSpecialIcon(f));
    html += `<div class="lbl" style="margin:12px 0 6px">Special icons <span style="font-weight:500">(images/special — kept out of the list above so it stays short)</span></div>`;
    if (TM.specialList.length) {
      const onSp = new Set(label.icons || []);
      html += `<div class="row wrap" style="margin-bottom:6px">${TM.specialList.map((im) => `<button class="ico ${onSp.has(im.file) ? 'on' : ''}" data-ico="${TM.esc(im.file)}" title="${TM.esc(im.name)}" ${disabled}><img alt="${TM.esc(im.name)}" src="${TM.images.get(im.file)}"></button>`).join('')}</div>`;
    }
    html += `<div class="row wrap" style="margin-bottom:6px">${specials.filter((f) => !TM.specialList.some((im) => im.file === f)).map((f) => `<span class="pill" style="height:26px;gap:6px">${TM.images.get(f) ? `<img alt="" src="${TM.images.get(f)}" style="width:16px;height:16px">` : '⚠'} ${TM.esc(f)} <button data-spdel="${TM.esc(f)}" ${disabled} style="border:0;background:none;cursor:pointer;color:var(--muted)">×</button></span>`).join('') || (TM.specialList.length ? '' : '<span class="hint">None used here.</span>')}</div>` +
      `<div class="row"><input class="input" id="spPath" placeholder="special/my-icon.svg" style="flex:1" ${disabled} aria-label="Path of a special icon"><button class="btn sm" id="spAdd" ${disabled}>Add</button></div>` +
      `<p class="hint" style="margin:6px 0 0">Listed here via this map's images/special/index.json (optional); anything else in that folder still works if you type its path above.</p>`;
    html += '</div>';
    /* one "Line segment" per editable line calling here — the active line first, each named when there is more than one
       or it is not the active line */
    const stops = actions.editableStops(station.id);
    stops.forEach(({ line, index: at }) => { html += segSection(at, line); });
    return html;
  }

  /* the line a "Line segment" input belongs to (its section's data-seg-line), else the active line */
  const segLineOf = (el) => { const section = el.closest('[data-seg-line]'); return (section && store.line(section.dataset.segLine)) || actions.activeLine(); };

  /* the drawings layer as a whole: shown or not, and above or below the background image */
  function drawLayerSection(can) {
    const layer = store.drawing, dis = can ? '' : 'disabled';
    return `<div class="sec"><div class="sec-h"><h3>Drawings layer</h3></div><div style="display:grid;gap:8px">` +
      `<label class="check"><input type="checkbox" id="dLayerShow" ${layer.hidden ? '' : 'checked'} ${dis}> Show drawings (${layer.items.length})</label>` +
      `<div class="row" style="justify-content:space-between;gap:8px"><span>On top</span><div class="seg"><button data-dtop="drawings" class="${layer.top !== 'image' ? 'on' : ''}" ${dis}>Drawings</button><button data-dtop="image" class="${layer.top === 'image' ? 'on' : ''}" ${dis}>Background image</button></div></div>` +
      `<p class="hint" style="margin:0">Both stay under the lines and stations.</p></div></div>`;
  }
  ui.drawLayerSection = drawLayerSection;

  function wireDrawInspector(body, selection) {
    const id = selection.id;
    body.addEventListener('click', (e) => {
      let x;
      if ((x = e.target.closest('[data-dkind]'))) actions.updateDrawing(id, { kind: x.dataset.dkind });
      else if ((x = e.target.closest('[data-dcolor]'))) actions.updateDrawing(id, { color: x.dataset.dcolor });
      else if ((x = e.target.closest('[data-dorder]'))) actions.orderDrawing(id, +x.dataset.dorder);
      else if ((x = e.target.closest('[data-dtop]'))) actions.setDrawLayer({ top: x.dataset.dtop });
      else if (e.target.closest('#dPtRm')) { const d = store.drawingById(id); if (d.pts.length > (d.kind === 'area' ? 3 : 2)) { actions.removeDrawPoint(id, selection.pt); actions.select({ type: 'draw', id }); } else TM.toast('A drawing needs at least ' + (d.kind === 'area' ? 3 : 2) + ' points', 'err'); }
      else if (e.target.closest('#dRm')) { if (confirm('Delete this drawing?')) { actions.removeDrawing(id); actions.select(null); } }
    });
    /* sliders: the number follows while dragging, the drawing changes on release */
    body.addEventListener('input', (e) => { const v = e.target.closest('.row') && e.target.closest('.row').querySelector('[data-dval]'); if (v && e.target.type === 'range') v.textContent = e.target.value; });
    body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.dop != null) actions.updateDrawing(id, { opacity: +t.value / 100 });
      else if (t.dataset.dw != null) actions.setDrawWidth(id, +t.value);
      else if (t.id === 'dColor') { actions.updateDrawing(id, { color: t.value }); const d = store.drawingById(id); if (d) TM.state.drawColors[d.kind] = t.value; }
      else if (t.id === 'dSmooth') actions.updateDrawing(id, { smooth: t.checked });
      else if (t.id === 'dOutline') actions.updateDrawing(id, { outline: t.checked ? '#5b8fc7' : null });
      else if (t.id === 'dOutlineC') actions.updateDrawing(id, { outline: t.value });
      else if (t.id === 'dLayerShow') actions.setDrawLayer({ hidden: !t.checked });
    });
  }

  function wireInspector() {
    const body = $('rBody'), selection = TM.state.selected;
    if (selection && selection.type === 'draw') { wireDrawInspector(body, selection); return; }
    const indexOf = () => (selection.type === 'wp' ? selection.index : actions.indexOfStation(selection.id));
    const blkOwner = () => (selection && (store.blockOwnerOf(selection.id) || store.rep(selection.id)));
    /* A station's name label is a view preference, never tied to one line's item — the block's own when it has one,
       otherwise shared by the whole interchange (store.setLabelPos), so every line that calls there agrees. */
    const labelSet = (patch) => {
      if (!selection) return;
      const owner = store.blockOwnerOf(selection.id);
      if (owner) { actions.setBlockLabelPos(owner, patch); return; }
      /* the first override starts from what a line's own item already says, so e.g. rotating keeps the label on its side */
      const stationInfo = !store.labelPos[store.rep(selection.id)] && TM.canvas.model && TM.canvas.model.info.get(selection.id), autoLabel = stationInfo && stationInfo.label;
      actions.setLabelPos(selection.id, autoLabel ? Object.assign({ pos: autoLabel.pos, dx: autoLabel.dx, dy: autoLabel.dy, hide: autoLabel.hide, size: autoLabel.size }, patch) : patch);
    };
    const setRot = (value) => {
      const rotation = TM.normAngle(value);
      if (selection.type === 'ann') actions.setAnnotation(selection.id, { rot: rotation }); else if (selection.type === 'station') labelSet({ rot: rotation });
    };
    const rotIn = $('rotIn');
    /* applied once the number is final (Enter / leaving the box), then brought into 0 – 359.99 */
    if (rotIn && selection) rotIn.onchange = () => { if (rotIn.value.trim() === '') return; rotIn.value = TM.normAngle(rotIn.value); setRot(rotIn.value); };
    body.onclick = (e) => {
      const target = e.target;
      let x;
      if ((x = target.closest('[data-rot]')) && !x.disabled && selection) { setRot(+x.dataset.rot); return; }
      if (selection && selection.type === 'ann') {
        if (target.closest('#annEdit')) TM.ui.openAnnotationDialog({ edit: selection.id });
        else if (target.closest('#annRm')) actions.removeAnnotation(selection.id);
        return;
      }
      if ((x = target.closest('[data-cdel]')) && selection) { actions.linkStations(selection.id, x.dataset.cdel, null); return; }   // before data-go: the button sits inside a link row
      if (target.closest('[data-cchg]')) return;
      if ((x = target.closest('[data-go]'))) { e.preventDefault(); focusStation(x.dataset.go); return; }
      if ((x = target.closest('[data-sym]')) && selection) {
        const slot = store.blockSlotOf(selection.id);
        if (slot) actions.setBlockSymbol(slot.owner, slot.key, x.dataset.sym);
        else { const symbolRef = actions.symbolRef(selection.id); if (symbolRef) actions.setItem(symbolRef.index, { symbol: x.dataset.sym }, symbolRef.line); }
      }
      else if ((x = target.closest('[data-stnnum]')) && selection) store.setNumMode(selection.id, x.dataset.stnnum === 'default' ? null : x.dataset.stnnum);
      else if ((x = target.closest('[data-lp]')) && selection) labelSet({ pos: x.dataset.lp });
      else if ((x = target.closest('[data-segset]'))) { const [i, style] = x.dataset.segset.split(':'); actions.setItem(+i, { seg: style === 'auto' ? null : style }, segLineOf(x)); }
      else if ((x = target.closest('[data-ico]')) && selection) {
        const label = actions.activeLine().path[indexOf()].label || {}, set = new Set(label.icons || []);
        if (set.has(x.dataset.ico)) set.delete(x.dataset.ico); else set.add(x.dataset.ico);
        actions.setItem(indexOf(), { label: { icons: [...set] } });
      }
      else if ((x = target.closest('[data-ltype]'))) { linkType = x.dataset.ltype; renderRight(); }
      else if ((x = target.closest('[data-codeshow]')) && selection) store.setCodeLabel(selection.id, { show: { default: undefined, show: true, hide: false }[x.dataset.codeshow] });
      else if (target.closest('#codeReset') && selection) store.setCodeLabel(selection.id, { text: '' });
      else if ((x = target.closest('[data-spdel]')) && selection) { const label = actions.activeLine().path[indexOf()].label || {}; actions.setItem(indexOf(), { label: { icons: (label.icons || []).filter((f) => f !== x.dataset.spdel) } }); }
      else if (target.closest('#spAdd') && selection) addSpecial();
      else if (target.closest('#lblReset')) labelSet({ reset: true });
      else if (target.closest('#lsizeReset')) labelSet({ resetSize: true });
      else if (target.closest('#insGo')) focusStation(selection.id);
      else if (target.closest('#insMove')) TM.canvas.setMoving(!TM.state.moving);
      else if (target.closest('#insUnmove')) store.resetMove(selection.id);
      else if (target.closest('#insEdit')) ui.openStationDialog({ edit: selection.id });
      else if (target.closest('#insAdd')) actions.addStationToLine(selection.id);
      else if (target.closest('#insSuggest')) actions.suggestStation(selection.id);
      else if ((x = target.closest('[data-sugacc]'))) { const [stationId, lineId] = x.dataset.sugacc.split('|'); actions.acceptSuggestion(stationId, lineId); }
      else if ((x = target.closest('[data-sugdis]'))) { const [stationId, lineId] = x.dataset.sugdis.split('|'); actions.dismissSuggestion(stationId, lineId); }
      else if (target.closest('#insRm')) actions.removeItem(indexOf());
      else if (target.closest('#insBranch')) actions.addBranch(selection.id);
      else if ((x = target.closest('[data-mark]')) && selection && selection.type === 'wp') actions.setMark(selection.index, x.dataset.mark ? { k: x.dataset.mark, s: 'a' } : null);
      else if ((x = target.closest('[data-markside]')) && selection && selection.type === 'wp') { const it = actions.activeLine().path[selection.index]; if (it && it.mk) actions.setMark(selection.index, { k: it.mk.k, s: x.dataset.markside }); }
      else if ((x = target.closest('[data-bstyle]')) && selection && selection.type === 'badge') actions.setBadgeStyle(selection.line, x.dataset.bstyle);
      else if (target.closest('#badgeReset2') && selection && selection.type === 'badge') actions.resetBadges(selection.line);
      else if (target.closest('#badgeLnEdit') && selection && selection.type === 'badge') { const l = store.line(selection.line); ui.openLineDialog(store.rootLine(l) || l); }
      else if (target.closest('#connReset') && selection && selection.type === 'conn') actions.setConnBends(selection.a, selection.b, []);
      else if ((x = target.closest('[data-cstyle]')) && selection && selection.type === 'conn') store.setConnLook(selection.a, selection.b, { style: x.dataset.cstyle === 'auto' ? null : x.dataset.cstyle });
      else if ((x = target.closest('[data-ccolor]')) && selection && selection.type === 'conn') store.setConnLook(selection.a, selection.b, { color: x.dataset.ccolor ? $('connColor').value : null });
      else if ((x = target.closest('[data-cborder]')) && selection && selection.type === 'conn') store.setConnLook(selection.a, selection.b, { border: x.dataset.cborder === 'color' ? $('connBorder').value : x.dataset.cborder || null });
      else if (target.closest('#blkOn') && selection) actions.enableBlock(blkOwner());
      else if (target.closest('#blkOff') && selection) { if (confirm('Remove this block? Its stations go back to their normal symbols.')) actions.disableBlock(blkOwner()); }
      else if (target.closest('#blkReset') && selection) actions.resetBlock(blkOwner());
      else if ((x = target.closest('[data-blkstyle]')) && selection) actions.setBlockStyle(blkOwner(), x.dataset.blkstyle);
      else if ((x = target.closest('[data-blkshape]')) && selection) actions.setBlockShape(blkOwner(), x.dataset.blkshape);
      else if ((x = target.closest('[data-blkorient]')) && selection) actions.setBlockOrientation(blkOwner(), x.dataset.blkorient);
    };
    body.querySelectorAll('[data-blkgroup]').forEach((inp) => { inp.onchange = () => selection && actions.setBlockGroup(blkOwner(), inp.dataset.blkgroup, inp.value); });
    const blkSizeR = $('blkSizeR'), blkSizeVal = $('blkSizeVal');
    if (blkSizeR) {
      blkSizeR.oninput = () => { blkSizeVal.textContent = blkSizeR.value; };
      blkSizeR.onchange = () => selection && actions.setBlockSize(blkOwner(), +blkSizeR.value);
    }
    const connBorder = $('connBorder');
    if (connBorder && selection && selection.type === 'conn') connBorder.onchange = () => store.setConnLook(selection.a, selection.b, { border: connBorder.value });
    const connColor = $('connColor');
    if (connColor && selection && selection.type === 'conn') connColor.onchange = () => store.setConnLook(selection.a, selection.b, { color: connColor.value });
    const blkColor = $('blkColor');
    if (blkColor) blkColor.onchange = () => selection && actions.setBlockColor(blkOwner(), blkColor.value);
    const blkLabel = $('blkLabel');
    if (blkLabel) blkLabel.onchange = () => selection && actions.setBlockLabel(blkOwner(), blkLabel.value);
    const blkCode = $('blkCode');
    if (blkCode) blkCode.onchange = () => selection && store.setCodeLabel(blkOwner(), { text: blkCode.value });
    const addSpecial = () => {
      const input = $('spPath'), file = TM.iconPath(input.value);
      if (!file) { TM.toast('Use a path such as special/my-icon.svg (svg, png, jpg, gif or webp)', 'err'); return; }
      TM.loadImage(file).then((loaded) => {
        if (!loaded) { TM.toast(`Could not load ${TM.maps.dir()}images/${file}`, 'err'); return; }
        const label = actions.activeLine().path[indexOf()].label || {}, set = new Set(label.icons || []);
        set.add(file); actions.setItem(indexOf(), { label: { icons: [...set] } });
      });
    };
    const spPath = $('spPath');
    if (spPath) spPath.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addSpecial(); } };
    const codeText = $('codeText');
    if (codeText && selection) codeText.onchange = () => store.setCodeLabel(selection.id, { text: codeText.value });
    const hide = $('lblHide');
    if (hide) hide.onchange = () => labelSet({ hide: hide.checked });
    const beyondOn = $('beyondOn');
    if (beyondOn && selection) {
      const end = indexOf() === 0 ? 's' : 'e';
      beyondOn.onchange = () => actions.setBeyond(actions.activeLine().id, end, beyondOn.checked ? '' : null);
    }
    const beyondLabel = $('beyondLabel');
    if (beyondLabel && selection) {
      const end = indexOf() === 0 ? 's' : 'e';
      beyondLabel.onchange = () => actions.setBeyond(actions.activeLine().id, end, beyondLabel.value);
    }
    const numberInput = $('lsize'), rangeInput = $('lsizeR');
    if (numberInput) numberInput.onchange = () => labelSet({ size: +numberInput.value || TM.state.labelSize });
    if (rangeInput) { rangeInput.oninput = () => { numberInput.value = rangeInput.value; }; rangeInput.onchange = () => labelSet({ size: +rangeInput.value }); }
    body.onchange = (e) => {
      const changeButton = e.target.closest && e.target.closest('[data-cchg]');
      if (changeButton && selection) actions.linkStations(selection.id, changeButton.dataset.cchg, e.target.value);
      const mergeButton = e.target.closest && e.target.closest('[data-blkmerge]');
      if (mergeButton && selection) actions.setBlockMerge(blkOwner(), mergeButton.dataset.blkmerge, e.target.checked);
      const timeButton = e.target.closest && e.target.closest('[data-timeset]');
      if (timeButton) { const [i, field] = timeButton.dataset.timeset.split(':'); actions.setItem(+i, { [field || 'time']: timeButton.value === '' ? null : +timeButton.value }, segLineOf(timeButton)); }
      const platformButton = e.target.closest && e.target.closest('[data-pfset]');
      if (platformButton) { const [i, direction] = platformButton.dataset.pfset.split(':'); actions.setItem(+i, { platform: { [direction]: platformButton.value } }, segLineOf(platformButton)); }
      const connTimeInput = e.target.closest && e.target.closest('[data-ctime]');
      if (connTimeInput && selection) {
        const other = connTimeInput.dataset.ctime, back = connTimeInput.dataset.cdir === 'back', value = connTimeInput.value === '' ? null : +connTimeInput.value;
        if (back) store.setConnTime(other, selection.id, value); else store.setConnTime(selection.id, other, value);
      }
    };
    const searchBox = $('lnkSearch');
    if (searchBox && selection && selection.type === 'station') {
      ui.searchStations(searchBox, {
        placeholder: 'Search a station by name or code to link…', hint: 'Type a name or code, e.g. “Sentral” or “KJ13”.',
        exclude: () => new Set([selection.id]),
        onPick: (station) => {
          if (actions.linkStations(selection.id, station.id, linkType)) TM.toast(`${selection.id} ${linkType === 'platform' ? 'now shares a platform with' : linkType === 'interchange' ? 'is now an interchange with' : linkType === 'link' ? 'now connects to' : 'now has an unofficial link to'} ${station.id}`);
          else TM.toast(`${selection.id} is already linked to ${station.id} this way`);
        },
      });
    }
  }

  function hotspots() {
    const clusters = store.clusters(), stns = [...store.stations.values()].filter((s) => s.local || s.status === 'fantasy').length;
    const authors = new Set([...store.lines.values()].map((l) => l.author).filter((a) => a && a !== 'system'));
    let html = `<div class="sec"><div class="grid2"><div><div class="n" style="font-size:24px;font-weight:800">${stns}</div><span class="hint">fantasy stations</span></div><div><div style="font-size:24px;font-weight:800">${authors.size}</div><span class="hint">contributors</span></div></div></div><div class="sec"><div class="sec-h"><h3>Same station, same area (≤ 300 m)</h3></div>`;
    html += clusters.length ? clusters.map((c, i) => `<div class="hot" data-hot="${i}"><div class="row"><span class="n">${c.authors.length}</span><div><b>people suggested a station here</b><br><span class="hint">${TM.esc(c.authors.join(', '))}</span></div></div><div style="margin-top:8px">${c.members.map((m) => `<span class="pill" style="margin:2px">${TM.esc(m.id)} ${TM.esc(TM.nameOf(m, 'en'))}</span>`).join('')}</div></div>`).join('') : '<div class="empty">No overlapping suggestions yet.</div>';
    return html + '</div>';
  }

  function wireRight() {
    const panel = $('right');
    panel.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { rtab = tab.dataset.tab; renderRight(); return; }
      const hotspot = e.target.closest('[data-hot]');
      if (hotspot) { const cluster = store.clusters()[+hotspot.dataset.hot]; if (cluster) focusStation(cluster.members[0].id); }
    });
  }

  /* ================= TOOLS / BANNER / LEGEND / TOP BAR ================= */
  let bgOpen = false;
  function bgSubtools() {
    const background = store.background;
    return `<div class="tools-flyout"><input type="file" id="bgFile" accept="image/*" hidden>` +
      `<button class="tool" id="bgAdd" aria-label="Add / replace background image">${TM.icon('image')}<span class="tip">${background ? 'Replace' : 'Add'} background image</span></button>` +
      (background ? `<button class="tool" id="bgDel" aria-label="Delete background image">${TM.icon('trash')}<span class="tip">Delete background image</span></button>` : '') +
      (background ? `<button class="tool ${TM.state.bgMode ? 'on' : ''}" id="bgMove" aria-label="Relocate / resize background">${TM.icon('edit')}<span class="tip">Relocate / resize</span></button>` : '') +
      (background && store.drawing.items.length ? `<button class="tool" id="bgOrder" aria-label="Swap image and drawings">${TM.icon('swap')}<span class="tip">${store.drawing.top === 'image' ? 'Put drawings above the image' : 'Put the image above drawings'}</span></button>` : '') +
      (background ? `<button class="tool ${background.visible !== false ? 'on' : ''}" id="bgShow" aria-label="Show / hide background">${TM.icon(background.visible !== false ? 'eye' : 'eyeoff')}<span class="tip">${background.visible !== false ? 'Hide' : 'Show'} background</span></button>` : '') +
      '</div>';
  }
  function renderTools() {
    const canEdit = actions.editable(), current = TM.state.tool, ownsMap = actions.ownsMap();
    const tools = [['select', 'cursor', current === 'select' ? 'Select / move (click again to pan only)' : 'Pan only — click to select / move again', 'V', true], ['station', 'station', 'Add station on node', 'S', canEdit], ['route', 'route', 'Add bend to route', 'B', canEdit], ['linestyle', 'linestyle', 'Change line style', 'D', canEdit], ['arc', 'arc', 'Arc: curve the line between two stops, or draw a loop line as a circle', 'A', canEdit], ['erase', 'erase', 'Remove from line', 'E', canEdit], ['label', 'text', 'Add a custom text or image label anywhere', 'L', true], ['draw', 'pen', ownsMap ? 'Draw under the map: areas and lines (water, parks, coasts, roads)' : 'Draw under the map (not your map)', 'P', ownsMap]];
    $('tools').innerHTML = tools.map(([k, ic, tip, key, ok]) => `<button class="tool ${current === k ? 'on' : ''}" data-tool="${k}" ${ok ? '' : 'disabled'} aria-label="${tip}">${TM.icon(ic)}<span class="tip">${tip} · ${key}</span></button>`).join('') +
      `<hr><div class="tools-anchor"><button class="tool ${bgOpen ? 'on' : ''}" id="bgToggle" ${ownsMap ? '' : 'disabled'} aria-label="Background image">${TM.icon('image')}<span class="tip">Background image${ownsMap ? '' : ' (not your map)'}</span></button>` +
      (bgOpen && ownsMap ? bgSubtools() : '') + '</div>' +
      `<button class="tool ${TM.state.showNodes ? 'on' : ''}" data-tool="grid" aria-label="Toggle nodes">${TM.icon('grid')}<span class="tip">Show / hide nodes · G</span></button>`;
    const banner = $('banner'), activeLine = actions.activeLine(), selection = TM.state.selected;
    const selSt = selection && selection.type === 'station' && store.stations.get(selection.id);
    const selName = selSt ? TM.nameOf(selSt, TM.state.langs[0]) : selection && selection.type === 'wp' ? 'this bend' : '';
    let message = '';
    if (current === 'draw') {
      const kinds = Object.entries(store.DRAW_KINDS).map(([k, t]) => `<button data-drawkind="${k}" class="${TM.state.drawKind === k ? 'on' : ''}">${t}</button>`).join('');
      const drawing = TM.state.drawId && store.drawingById(TM.state.drawId);
      message = (drawing ? `<b>Drawing a ${store.DRAW_KINDS[drawing.kind].toLowerCase()}</b> · Click to add points · Double-click, <kbd>Enter</kbd> or click the last point to finish${drawing.kind === 'area' ? ' (or the first point to close it)' : ''}`
        : `<b>Draw</b> · Click on the map to start a new shape under it, or click a drawing to edit it`) +
        `<div class="row" style="justify-content:center;gap:10px;margin-top:6px"><div class="seg">${kinds}</div><label class="check"><input type="checkbox" id="drawSnap" ${TM.state.drawSnap ? 'checked' : ''}> 45° steps <span class="hint">(Shift: ${TM.state.drawSnap ? 'free' : 'snap'})</span></label>${drawing ? '<button class="btn sm" id="drawDone">Finish</button>' : ''}</div>`;
    } else if (TM.state.moving && selection) {
      message = `<b>Move</b> · Click a node to place <b>${TM.esc(selName)}</b> · <kbd>Esc</kbd> cancels`;
    } else if (activeLine && canEdit) {
      const before = TM.state.insertMode === 'before';
      const where = selName ? `New stops go <b>${before ? 'before' : 'after'} ${TM.esc(selName)}</b>` : `New stops go at the <b>${before ? 'start' : 'end'}</b> of ${TM.esc(activeLine.code)}`;
      const insertRow = `<div class="row" style="justify-content:center;gap:10px;margin-top:6px"><span class="hint">${where}</span>${insSeg()}</div>`;
      message = { station: `<b>Station tool</b> · Click a free node to create a station, or an existing station to add it to <b>${TM.esc(activeLine.code)}</b>${insertRow}`, route: `<b>Route tool</b> · Click nodes to add rounded bends to <b>${TM.esc(activeLine.code)}</b>${insertRow}`, linestyle: `<b>Line style</b> · Click a segment of <b>${TM.esc(activeLine.code)}</b> to cycle automatic → dashed → dash-dot → stripes → solid; Shift+click extends over a range`, erase: `<b>Erase</b> · Click a station or bend to take it off <b>${TM.esc(activeLine.code)}</b>`, arc: arcBanner(activeLine), select: '' }[current];
    } else if (activeLine) message = `Viewing <b>${TM.esc(activeLine.code)}</b> by ${TM.esc(activeLine.author || 'anonymous')} — duplicate it to edit`;
    banner.hidden = !message || TM.state.mode !== 'schematic'; banner.innerHTML = message || '';
    syncIns();
  }

  function arcBanner(line) {
    const button = (k, t) => `<button class="btn sm" data-arcact="${k}">${t}</button>`;
    if (line.circle) return `<b>Circle line</b> · Drag the centre to move the circle, the handle on its rim to resize it. With Select (V), drag any stop round the circle.` +
      `<div class="row" style="justify-content:center;margin-top:6px">${button('uncircle', 'Remove circle')}</div>`;
    const pick = TM.canvas.arcPick, item = pick != null && line.path[pick];
    const first = item ? (item.s ? TM.nameOf(store.stations.get(item.s) || { names: {}, id: item.s }, TM.state.langs[0]) : 'this bend') : '';
    return (item ? `<b>Arc</b> · from <b>${TM.esc(first)}</b> — now click the other end · <kbd>Esc</kbd> cancels`
      : `<b>Arc tool</b> · Click two stops or bends of <b>${TM.esc(line.code)}</b> to curve the stretch between them. Drag an arc's handle to change its curve (either side), double-click it to straighten. Stops in between stay on the arc — drag them along it with Select (V).`) +
      (line.loop && !line.rootId ? `<div class="row" style="justify-content:center;margin-top:6px">${button('circle', 'Draw the whole loop as a circle')}</div>` : '');
  }
  /* before / after switch used by the banner and the line editor */
  function insSeg() {
    const mode = TM.state.insertMode;
    return `<div class="seg" title="Where new stops are inserted relative to the selected stop (I)"><button data-ins="before" class="${mode === 'before' ? 'on' : ''}">Before</button><button data-ins="after" class="${mode !== 'before' ? 'on' : ''}">After</button></div>`;
  }
  function syncIns() {
    document.querySelectorAll('[data-ins]').forEach((x) => x.classList.toggle('on', x.dataset.ins === TM.state.insertMode));
  }

  let legendOpen = false, legendHtml = null;
  /* The toggle button stays the same element across redraws, and the body is only rewritten when it changed — a redraw
     between pressing and releasing the button would otherwise swallow the click (the 'display' event fires often). */
  function renderLegend() {
    const legend = $('legend');
    legend.hidden = TM.state.showLegend === false || TM.state.mode !== 'schematic';
    if (legend.hidden) return;
    if (!$('legBtn')) legend.innerHTML = `<button class="btn sm ghost" id="legBtn" style="width:100%;justify-content:space-between;gap:14px">Legend ${TM.icon('chevron', '')}</button><div id="legBody"></div>`;
    const chevron = $('legBtn').querySelector('svg');
    if (chevron) chevron.style.transform = `rotate(${legendOpen ? 0 : 180}deg)`;
    let html = '';
    if (legendOpen) {
      const lines = [...store.visible].filter((id) => store.lineFilter.has(id)).map((id) => store.lines.get(id)).filter(Boolean).map((l) => TM.recolor(l, new Map())), legendSvg = TM.symbols.legend(TM.symbols.palette(document.documentElement.dataset.theme), lines, TM.state.langs[0], store.legend);
      html = `<svg width="${legendSvg.w}" height="${legendSvg.h}" viewBox="0 0 ${legendSvg.w} ${legendSvg.h}">${legendSvg.svg}</svg><button class="btn sm" id="legEdit" style="width:100%;margin-top:6px">${TM.icon('edit')} Edit legend</button>`;
    }
    const body = $('legBody');
    if (body.innerHTML === '' || legendHtml !== html) { body.innerHTML = html; legendHtml = html; }
    legend.classList.toggle('open', legendOpen);
  }

  let languageBar = null;
  function renderLang() {
    if (!languageBar) languageBar = ui.languageBar($('langSeg'), () => TM.emit('lang'));
    else languageBar.refresh();
  }

  ui.init = () => {
    ui.loadLanguages();
    TM.on('map', () => { ui.sortLanguages(); renderLang(); renderLeft(); TM.emit('display'); });
    TM.topbar.init(() => TM.map.map);
    $('btnImport').innerHTML = `${TM.icon('upload')}<span class="hide-narrow">Import</span>`;
    $('navLink').innerHTML = TM.icon('ticket');
    /* only for a map the journey planner offers (map.json "navigator") — and it opens that same map there */
    const syncNavLink = () => { const currentMap = TM.maps.current; $('navLink').hidden = !(currentMap && currentMap.navigator); if (currentMap) $('navLink').href = 'navigator.html?map=' + encodeURIComponent(currentMap.id); };
    TM.on('map', syncNavLink); syncNavLink();
    $('btnExport').innerHTML = `${TM.icon('download')}<span class="hide-narrow">Export</span>`;
    $('zFit').innerHTML = TM.icon('fit');
    $('btnUndo').innerHTML = TM.icon('undo'); $('btnRedo').innerHTML = TM.icon('redo');
    $('btnUndo').onclick = () => TM.history.doUndo(); $('btnRedo').onclick = () => TM.history.doRedo();
    const syncHistory = () => { $('btnUndo').disabled = !TM.history.canUndo(); $('btnRedo').disabled = !TM.history.canRedo(); };
    TM.on('history', syncHistory); syncHistory();
    $('btnImport').onclick = () => $('fileIn').click();
    $('fileIn').onchange = (e) => { ui.importFiles([...e.target.files]); e.target.value = ''; };
    $('btnExport').onclick = () => TM.exportUI.openDialog();
    document.querySelectorAll('#modeSeg button').forEach((button) => button.onclick = () => {
      TM.state.mode = button.dataset.mode;
      document.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('on', x === button));
      $('schematic').hidden = TM.state.mode !== 'schematic'; $('mapview').hidden = TM.state.mode !== 'map';
      renderTools(); renderLegend(); renderLeft(); renderRight(); TM.emit('mode');
    });
    document.addEventListener('click', (e) => { const button = e.target.closest('[data-ins]'); if (button) actions.setInsertMode(button.dataset.ins); });
    $('banner').addEventListener('change', (e) => { if (e.target.id === 'drawSnap') { TM.state.drawSnap = e.target.checked; renderTools(); } });
    $('banner').addEventListener('click', (e) => {
      const kindBtn = e.target.closest('[data-drawkind]');
      if (kindBtn) { TM.state.drawKind = kindBtn.dataset.drawkind; renderTools(); return; }
      if (e.target.closest('#drawDone')) { TM.canvas.finishDrawing(); return; }
      const button = e.target.closest('[data-arcact]'), line = actions.activeLine();
      if (!button || !line) return;
      if (button.dataset.arcact === 'circle') { if (line.path.some((it) => it.arc) && !confirm('The loop\'s arc sections are replaced by the circle. Go on?')) return; actions.makeCircle(line); }
      else if (button.dataset.arcact === 'uncircle') actions.removeCircle(line);
      TM.emit('tool');
    });
    $('tools').onclick = (e) => {
      const button = e.target.closest('[data-tool]');
      if (button) {
        if (button.dataset.tool === 'grid') { TM.state.showNodes = !TM.state.showNodes; TM.emit('display'); }
        else if (button.dataset.tool === 'select') TM.canvas.toggleSelectTool();
        else TM.canvas.setTool(button.dataset.tool);
        return;
      }
      if (e.target.closest('#bgToggle')) { bgOpen = !bgOpen; if (!bgOpen) TM.state.bgMode = false; renderTools(); TM.emit('tool'); return; }
      if (e.target.closest('#bgAdd')) { $('bgFile').click(); return; }
      if (e.target.closest('#bgDel')) { if (confirm('Delete the background image?')) actions.clearBackground(); renderTools(); return; }
      if (e.target.closest('#bgMove')) { TM.state.bgMode = !TM.state.bgMode; renderTools(); TM.emit('tool'); return; }
      if (e.target.closest('#bgOrder')) { actions.setDrawLayer({ top: store.drawing.top === 'image' ? 'drawings' : 'image' }); renderTools(); return; }
      if (e.target.closest('#bgShow')) { const background = store.background; if (background) { actions.setBackgroundVisible(background.visible === false); renderTools(); } return; }
    };
    $('tools').addEventListener('change', (e) => {
      if (e.target.id !== 'bgFile' || !e.target.files || !e.target.files[0]) return;
      const file = e.target.files[0];
      const image = new Image();
      const reader = new FileReader();
      reader.onload = () => {
        image.onload = () => {
          const max = 1600, scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
          actions.setBackgroundImage(file.name, reader.result, Math.round(image.naturalWidth * scale), Math.round(image.naturalHeight * scale));
          renderTools();
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    $('legend').onclick = (e) => {
      if (e.target.closest('#legBtn')) { if (TM.legendToggleOk()) { legendOpen = !legendOpen; renderLegend(); if (legendOpen) $('legend').scrollTop = 0; } }
      else if (e.target.closest('#legEdit')) ui.openLegendDialog();
    };
    ui.searchStations($('stationSearch'), { variant: 'topbar', leadingIcon: 'search', placeholder: 'Search stations…', ariaLabel: 'Search stations by name or code', onPick: (s) => { if (s) ui.focusStation(s.id); const focused = document.activeElement; if (focused && $('stationSearch').contains(focused)) focused.blur(); } });   // hand the keyboard back to the canvas, so V / S … work straight away
    ui.linePicker($('linePicker'));
    wireLeft(); wireRight(); renderLang();
    TM.on('pick-line', (id) => { actions.setActive(id); fitLine(id); });
    const renderAll = () => { renderLeft(); renderRight(); renderTools(); renderLegend(); };
    ['change', 'visibility', 'line-filter', 'lang', 'active'].forEach((ev) => TM.on(ev, renderAll));
    TM.on('display', () => { renderTools(); renderLegend(); });
    TM.on('selection', () => { renderRight(); renderLeft(); });
    TM.on('tool', () => { renderTools(); renderRight(); });
    TM.on('theme', () => { renderLegend(); renderRight(); });
    /* the canvas is redrawn a frame after a change, so the symbol it actually drew is filled in once it has been */
    TM.on('rendered', (model) => {
      const symbolSelect = $('symKind'), selection = TM.state.selected, stationInfo = symbolSelect && selection && selection.type === 'station' && model.info.get(selection.id);
      if (stationInfo) symbolSelect.textContent = kindName(stationInfo.kind);
    });
    renderAll();
  };
})(window.TM);
