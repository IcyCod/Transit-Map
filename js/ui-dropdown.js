/* Themed dropdowns (no native <select>): the multi-select line picker, the label-language bar / menu, and the reusable station search box. */
(function (TM) {
  const ui = (TM.ui = TM.ui || {});

  /* ---------- line picker ---------- */
  ui.linePicker = (host) => {
    let open = false, query = '';
    host.innerHTML = `<div class="dd"><button class="dd-btn" aria-haspopup="listbox"></button><div class="dd-pop" hidden></div></div>`;
    const root = host.firstElementChild, button = root.querySelector('.dd-btn'), popup = root.querySelector('.dd-pop');

    const setOpen = (value) => {
      open = value; root.classList.toggle('open', value); popup.hidden = !value;
      if (value) { buildPop(); popup.querySelector('input').focus(); }
    };
    const toggle = (id) => {
      const store = TM.store;
      if (store.lineFilter.has(id)) {
        store.lineFilter.delete(id);
        /* A filtered-out line is no longer editable/selected from the left panel. Its eye state in store.visible is
           intentionally untouched, so bringing the line back restores exactly the previous canvas state. */
        if (TM.state.activeLineId === id) {
          TM.state.activeLineId = null;
          TM.state.selected = null;
          TM.emit('active');
        }
      } else {
        store.lineFilter.add(id);
      }
      store.save(true); TM.emit('line-filter');
    };
    const setAll = (ids) => {
      TM.store.lineFilter = new Set(ids);
      if (TM.state.activeLineId && !TM.store.lineFilter.has(TM.state.activeLineId)) {
        TM.state.activeLineId = null;
        TM.state.selected = null;
        TM.emit('active');
      }
      TM.store.save(true); TM.emit('line-filter');
    };

    function label() {
      const lines = TM.store.lines, selected = [...TM.store.lineFilter].map((id) => lines.get(id)).filter(Boolean);
      button.innerHTML = `<span class="chips">${selected.slice(0, 5).map((l) => `<i style="background:${l.color}"></i>`).join('')}</span>` +
        `<span>${selected.length === 0 ? 'No lines selected' : `${selected.length} of ${lines.size} lines`}</span>${TM.icon('chevron', 'chev')}`;
    }

    function items() {
      const needle = query.trim().toLowerCase();
      const match = (l) => !needle || [l.code, l.author, ...Object.values(l.names)].join(' ').toLowerCase().includes(needle);
      const groups = TM.store.userMap ? [['Lines', () => true]]
        : [['Network', (l) => !l.local && l.author === 'system'], ['Community suggestions', (l) => !l.local && l.author !== 'system'], ['My lines & imports', (l) => l.local]];
      return groups.map(([title, fn]) => [title, [...TM.store.lines.values()].filter((l) => fn(l) && match(l))]).filter(([, ls]) => ls.length);
    }

    function buildPop() {
      const list = items();
      const body = list.length ? list.map(([title, lines]) => `<div class="dd-group">${title}</div>` + lines.map((line) => {
        const on = TM.store.lineFilter.has(line.id), count = line.path.filter((it) => it.s).length;
        return `<div class="dd-item" role="option" data-id="${TM.esc(line.id)}" aria-selected="${on}"><label class="check"><input type="checkbox" ${on ? 'checked' : ''} tabindex="-1"></label>` +
          `<span class="dot" style="background:${line.color}"></span><div class="nm"><b>${TM.esc(line.code)} · ${TM.esc(TM.displayName(line))}</b><span>${TM.esc(line.author || 'anonymous')} · ${count} stations · ${TM.esc(TM.STATUSES[line.status] || line.status)}</span></div></div>`;
      }).join('')).join('') : '<div class="empty">No lines match</div>';
      const keep = popup.querySelector('input') ? popup.querySelector('input').value : query;
      popup.innerHTML = `<div class="dd-head"><input class="input" placeholder="Search lines…" value="${TM.esc(keep)}"><button class="btn sm" data-a="all">All</button><button class="btn sm" data-a="none">None</button><button class="btn sm" data-a="def">Default</button></div>` +
        `<div class="dd-list" role="listbox" aria-multiselectable="true">${body}</div><div class="dd-foot"><span>${TM.store.lineFilter.size} selected</span><span>Selected lines will be listed in left side panel</span></div>`;
      const input = popup.querySelector('input');
      input.oninput = () => { query = input.value; const caret = input.selectionStart; buildPop(); const newInput = popup.querySelector('input'); newInput.focus(); newInput.setSelectionRange(caret, caret); };
    }

    button.onclick = () => setOpen(!open);
    popup.onclick = (e) => {
      const item = e.target.closest('.dd-item'), action = e.target.closest('[data-a]');
      const listEl = popup.querySelector('.dd-list'), scrollTop = listEl ? listEl.scrollTop : 0;
      if (item) toggle(item.dataset.id);
      else if (action) {
        const lines = [...TM.store.lines.values()];
        setAll(action.dataset.a === 'all' ? lines.map((l) => l.id) : action.dataset.a === 'none' ? [] : lines.filter((l) => l.default).map((l) => l.id));
      } else return;
      buildPop();
      const list = popup.querySelector('.dd-list');
      if (list) list.scrollTop = scrollTop;
    };
    document.addEventListener('pointerdown', (e) => { if (open && !root.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') setOpen(false); });
    ['line-filter', 'visibility', 'change', 'lang', 'active'].forEach((ev) => TM.on(ev, () => { label(); if (open) buildPop(); }));
    label();
    return { refresh: label };
  };

  /* ---------- label languages ----------
     The viewer's own on/off choice of languages is remembered across maps (tm.langs); its priority ORDER always follows
     the open map's hierarchy (TM.langOrder), so switching maps re-sorts it without losing the selection. At least one
     language stays on. */
  ui.sortLanguages = () => {
    TM.state.langs = TM.langOrder().filter((k) => TM.state.langs.includes(k));
    if (!TM.state.langs.length) TM.state.langs = [TM.langOrder()[0]];
  };
  ui.loadLanguages = () => {
    const saved = TM.storage.getJSON('tm.langs');
    if (Array.isArray(saved) && saved.length) TM.state.langs = saved;
    ui.sortLanguages();
  };

  /* ---------- label-language bar ----------
     The four standard languages fit as a row of toggle buttons. A map with languages of its own gets a dropdown instead
     (same look as the line picker): a checkbox per language, in the map's priority order. At least one stays on.
     host keeps its id; onChange runs after TM.state.langs changed (and was remembered). Returns { refresh }. */
  ui.languageBar = (host, onChange) => {
    const segClass = host.className;
    let open = false;
    const set = (key) => {
      const on = TM.state.langs.includes(key);
      if (on && TM.state.langs.length === 1) return;
      TM.state.langs = TM.langOrder().filter((x) => (x === key ? !on : TM.state.langs.includes(x)));
      TM.storage.setJSON('tm.langs', TM.state.langs);
      refresh(); if (onChange) onChange();
    };
    const langs = () => { const byKey = new Map(TM.LANGS.map((l) => [l.key, l])); return TM.langOrder().map((k) => byKey.get(k)).filter(Boolean); };
    function refresh() {
      const list = langs();
      if (list.length <= TM.BASE_LANGS.length) {                   // plain row of buttons
        open = false;
        host.className = segClass;
        host.innerHTML = list.map((l) => `<button data-l="${TM.esc(l.key)}" class="${TM.state.langs.includes(l.key) ? 'on' : ''}" title="${TM.esc(l.label)}">${TM.esc(l.short)}</button>`).join('');
        return;
      }
      host.className = segClass.split(/\s+/).filter((c) => c !== 'seg' && c !== 'multi').concat('lang-dd').join(' ');
      const selected = list.filter((l) => TM.state.langs.includes(l.key));
      host.innerHTML = `<div class="dd ${open ? 'open' : ''}"><button class="dd-btn" aria-haspopup="listbox" aria-expanded="${open}" title="Label languages"><span class="lang-dd-t">${selected.map((l) => TM.esc(l.short)).join(' · ')}</span>${TM.icon('chevron', 'chev')}</button>` +
        `<div class="dd-pop" ${open ? '' : 'hidden'}><div class="dd-list" role="listbox" aria-multiselectable="true">` +
        list.map((l) => { const on = TM.state.langs.includes(l.key); return `<div class="dd-item" role="option" data-l="${TM.esc(l.key)}" aria-selected="${on}"><label class="check"><input type="checkbox" ${on ? 'checked' : ''} tabindex="-1"></label><span class="lang-short">${TM.esc(l.short)}</span><div class="nm"><b>${TM.esc(l.label)}</b><span>${TM.esc(l.key)}</span></div></div>`; }).join('') +
        `</div><div class="dd-foot"><span>${selected.length} shown</span><span>First is the bold name</span></div></div></div>`;
    }
    host.addEventListener('click', (e) => {
      if (e.target.closest('.dd-btn')) { open = !open; refresh(); return; }
      const button = e.target.closest('[data-l]');
      if (button) { e.preventDefault(); set(button.dataset.l); }
    });
    document.addEventListener('pointerdown', (e) => { if (open && !host.contains(e.target)) { open = false; refresh(); } });
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { open = false; refresh(); } });
    refresh();
    return { refresh };
  };

  /* ---------- station search ---------- */
  /* The code pill of a result: one segment per code, each in the colour of that code's own line (not its
     interchange partners'), so every band sits exactly under its own code; a code listed on several lines splits its
     own segment into equal bands. A code on no line keeps the plain pill colours. */
  const codePill = (ids) => `<span class="code code-split">${ids.map((id) => {
    const colors = [...new Set(TM.store.usedBy(id).map((l) => l.color))];
    if (!colors.length) return `<span>${TM.esc(id)}</span>`;
    const background = colors.length === 1 ? colors[0]
      : `linear-gradient(90deg,${colors.map((c, i) => `${c} ${Math.round(i / colors.length * 100)}% ${Math.round((i + 1) / colors.length * 100)}%`).join(',')})`;
    const textColour = colors.length === 1 ? TM.symbols.contrast(colors[0]) : '#fff';
    return `<span class="on" style="background:${background};color:${textColour}${colors.length > 1 ? ';text-shadow:0 0 2px rgba(0,0,0,.55)' : ''}">${TM.esc(id)}</span>`;
  }).join('')}</span>`;
  const NEAR_M = 2000;   // "nearby" in search results: within 2 km of the selected station
  ui.searchStations = (host, options) => {
    const variant = options.variant === 'topbar' ? ' topbar-search-box' : '';
    const leading = options.leadingIcon ? `<span class="search-leading" aria-hidden="true">${TM.icon(options.leadingIcon)}</span>` : '';
    host.innerHTML = `<div class="search-box${variant}">${leading}<input class="input" placeholder="${TM.esc(options.placeholder || 'Search station name or code…')}" autocomplete="off"${options.ariaLabel ? ` aria-label="${TM.esc(options.ariaLabel)}"` : ''}></div><div class="results" style="margin-top:6px"></div>`;
    const input = host.querySelector('input'), results = host.querySelector('.results');
    const haystack = (s) => [s.id, ...Object.values(s.names)].join(' ').toLowerCase();
    function search() {
      const query = input.value.trim().toLowerCase();
      if (!query) { results.innerHTML = options.hint ? `<div class="hint" style="padding:6px 2px">${options.hint}</div>` : ''; return; }
      const excluded = options.exclude ? options.exclude() : new Set(), store = TM.store;
      /* what you are working on comes first: stations near the selected station (nearest first), then stations of the
         selected line, then everything else (best text match first) */
      const selId = TM.state.selected && TM.state.selected.type === 'station' ? TM.state.selected.id : null, near = selId && store.stations.get(selId);
      const activeLine = TM.actions.activeLine(), onLine = new Set();
      if (activeLine) activeLine.path.forEach((it) => { if (it.s) store.members(it.s).forEach((m) => onLine.add(m)); });
      const dist = (s) => (near ? TM.haversine(near.lat, near.lng, s.lat, s.lng) : Infinity);
      const group = (s) => (near && s.id !== selId && dist(s) <= NEAR_M ? 0 : onLine.has(s.id) ? 1 : 2);
      let found = [...store.stations.values()].filter((s) => !excluded.has(s.id) && haystack(s).includes(query)).map((s) => ({ s, g: group(s), d: dist(s) }))
        .sort((a, b) => a.g - b.g || (a.g === 0 ? a.d - b.d : 0) || (haystack(a.s).indexOf(query) - haystack(b.s).indexOf(query)) || a.s.id.localeCompare(b.s.id, undefined, { numeric: true }));
      /* o.groupBy (optional): same platform, an interchange, or a block are one pick — the first (best-matching)
         member of a group stands for the whole thing, showing every one of its codes at once (o.groupMembers). */
      if (options.groupBy) {
        const seen = new Set(), kept = [];
        found.forEach((f) => { const key = options.groupBy(f.s); if (seen.has(key)) return; seen.add(key); kept.push(f); });
        found = kept;
      }
      found = found.slice(0, near || activeLine ? 12 : 8);   // a few more when grouped, so later groups still show
      const heads = { 0: `Near ${near ? TM.esc(TM.nameOf(near, TM.state.langs[0])) : ''}`, 1: `On ${activeLine ? TM.esc(activeLine.code) : ''}`, 2: 'Other stations' };
      const grouped = found.some((f) => f.g < 2);
      results.innerHTML = found.length ? found.map(({ s: station, g: groupKey, d: distance }, i) => {
        const ids = options.groupBy ? options.groupMembers(station) : [station.id];
        const head = grouped && (i === 0 || found[i - 1].g !== groupKey) ? `<div class="dd-group">${heads[groupKey]}</div>` : '';
        return `${head}<div class="stn-item" data-id="${TM.esc(station.id)}">${codePill(ids)}<span class="nm">${TM.esc(TM.nameOf(station, TM.state.langs[0]))} <span class="hint">${TM.esc(station.names['zh-Hant'] || '')}</span></span>${groupKey === 0 ? `<span class="hint">${TM.fmtDist(distance)}</span>` : ''}<span class="pill ${station.status}">${TM.STATUSES[station.status]}</span></div>`;
      }).join('') : '<div class="hint" style="padding:6px 2px">No matching stations</div>';
    }
    input.oninput = () => { results.hidden = false; search(); };
    results.onclick = (e) => {
      const item = e.target.closest('.stn-item'); if (!item) return;
      options.onPick(TM.store.stations.get(item.dataset.id));
      input.value = ''; search();
    };
    if (options.variant === 'topbar') {
      /* a popup like the line picker: Esc or a press anywhere else closes it; focusing the box again reopens it */
      input.addEventListener('focus', () => { results.hidden = false; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { results.hidden = true; input.blur(); } });
      document.addEventListener('pointerdown', (e) => { if (!host.contains(e.target)) results.hidden = true; });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !results.hidden && results.innerHTML) results.hidden = true; });
    }
    search();
    return { focus: () => input.focus(), refresh: search };
  };
})(window.TM);
