/* Modal dialogs: station create/use/edit (with 300 m proximity check), new line, import. */
(function (TM) {
  const ui = (TM.ui = TM.ui || {});
  const store = TM.store, actions = TM.actions;
  const $ = (root, sel) => root.querySelector(sel);

  /* Every colour picker gets a hex box beside it: type #RRGGBB / RRGGBB / #RGB (any case) instead of using the picker.
     The picker stays the real value — the box writes into it and fires its own input / change events, so whatever
     already listens to the picker keeps working. A hex box follows its picker's disabled state (see ui.syncHex). */
  const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
  const normHex = (value) => {
    const match = HEX.exec(String(value).trim());
    if (!match) return null;
    const hex = match[1].length === 3 ? match[1].split('').map((c) => c + c).join('') : match[1];
    return '#' + hex.toLowerCase();
  };
  ui.hexInputs = (root) => {
    root.querySelectorAll('input[type="color"]').forEach((col) => {
      if (col.nextElementSibling && col.nextElementSibling.classList.contains('hex')) return;
      const hexInput = document.createElement('input');
      hexInput.className = 'input hex'; hexInput.maxLength = 7; hexInput.spellcheck = false; hexInput.autocomplete = 'off';
      hexInput.setAttribute('aria-label', (col.getAttribute('aria-label') || col.title || 'Colour') + ' (hex code)');
      hexInput.placeholder = '#RRGGBB'; hexInput.value = col.value.toUpperCase(); hexInput.disabled = col.disabled;
      col.after(hexInput);
      col.addEventListener('input', () => { hexInput.value = col.value.toUpperCase(); hexInput.classList.remove('bad'); });
      col.addEventListener('change', () => { hexInput.value = col.value.toUpperCase(); hexInput.classList.remove('bad'); });
      hexInput.addEventListener('input', () => {
        const value = normHex(hexInput.value);
        hexInput.classList.toggle('bad', !value && hexInput.value.trim() !== '');
        if (value && value !== col.value) { col.value = value; col.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      hexInput.addEventListener('change', () => {
        const value = normHex(hexInput.value);
        if (!value) { hexInput.value = col.value.toUpperCase(); hexInput.classList.remove('bad'); return; }
        hexInput.value = value.toUpperCase();
        col.value = value; col.dispatchEvent(new Event('change', { bubbles: true }));
      });
      hexInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); hexInput.blur(); } });
    });
  };
  /* keep hex boxes enabled / disabled with their pickers after the pickers were toggled in code */
  ui.syncHex = (root) => root.querySelectorAll('input[type="color"]').forEach((col) => {
    const hexInput = col.nextElementSibling;
    if (hexInput && hexInput.classList.contains('hex')) hexInput.disabled = col.disabled;
  });

  ui.modal = (modalOptions) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal ${modalOptions.wide ? 'wide' : ''}" role="dialog" aria-modal="true"><div class="modal-h"><h2>${modalOptions.title}</h2><button class="btn icon-btn ghost" data-x aria-label="Close">${TM.icon('x')}</button></div><div class="modal-b"></div><div class="modal-f"></div></div>`;
    const body = $(back, '.modal-b'), foot = $(back, '.modal-f');
    if (typeof modalOptions.body === 'string') body.innerHTML = modalOptions.body; else if (modalOptions.body) body.appendChild(modalOptions.body);
    const api = { el: back, body, foot, close() { document.removeEventListener('keydown', onEscape); back.remove(); if (modalOptions.onClose) modalOptions.onClose(); } };
    const onEscape = (e) => { if (e.key === 'Escape') api.close(); };
    (modalOptions.buttons || []).forEach((spec) => {
      const button = document.createElement('button');
      button.className = 'btn ' + (spec.cls || ''); button.innerHTML = spec.label;
      button.onclick = () => { const result = spec.onClick && spec.onClick(api, button); if (result !== false && !spec.keep) api.close(); };
      foot.appendChild(button);
    });
    if (!modalOptions.buttons || !modalOptions.buttons.length) foot.remove();
    back.addEventListener('pointerdown', (e) => { if (e.target === back) api.close(); });
    $(back, '[data-x]').onclick = api.close;
    document.addEventListener('keydown', onEscape);
    document.getElementById('dialogs').appendChild(back);
    ui.hexInputs(body);
    return api;
  };

  const options = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${TM.esc(v)}</option>`).join('');

  /* Choose a free node beside the end of the active line for panel-driven additions. */
  function suggestNode() {
    const line = actions.activeLine(), anchors = line ? TM.geo.anchors(line) : [];
    if (!anchors.length) return store.autoNode(store.anchor.lat, store.anchor.lng);
    const last = anchors[anchors.length - 1], prev = anchors[anchors.length - 2];
    let dx = prev ? Math.sign(last.x - prev.x) : 1, dy = prev ? Math.sign(last.y - prev.y) : 0;
    if (!dx && !dy) dx = 1;
    for (const n of [2, 1, 3, 4, 5]) if (!store.stationAt(last.x + dx * n, last.y + dy * n)) return { x: last.x + dx * n, y: last.y + dy * n };
    return store.autoNode(store.nodeToLatLng(last.x, last.y).lat, store.nodeToLatLng(last.x, last.y).lng);
  }

  /* ---------- station dialog ---------- */
  ui.openStationDialog = (dialogOptions) => {
    dialogOptions = dialogOptions || {};
    const edit = dialogOptions.edit ? store.stations.get(dialogOptions.edit) : null;
    if (!edit && !actions.activeLine()) { TM.toast('Select a line first', 'err'); return; }
    const suggesting = !edit && !actions.editable();   // not your line: the station is created (or picked) and suggested for it
    const node = edit ? edit.node : (dialogOptions.node || suggestNode());
    const line = actions.activeLine();
    const latLng = edit ? { lat: edit.lat, lng: edit.lng } : store.nodeToLatLng(node.x, node.y);
    const values = edit || { names: {}, status: 'fantasy', platform: [{ type: 'island', count: 1 }], opened: '', closed: '', note: '', linkedTo: [] };
    /* the station's platforms, edited as rows of type + how many (a bus stop / terminal has no count) */
    const plats = store.normPlatforms(values.platform).map((p) => Object.assign({}, p));
    const linked = new Set(values.linkedTo || []);
    let picker = null, tab = 'new';

    const html = `
      ${edit ? '' : `<div class="seg" style="margin-bottom:12px" id="sd-tabs"><button data-t="new" class="on">Create new station</button><button data-t="existing">Use existing station</button></div>`}
      <div id="sd-existing" hidden><p class="hint" style="margin-top:0">Search by any language or code. The station will be ${suggesting ? 'suggested for' : 'added to'} <b>${TM.esc(line ? line.code : '')}</b>${suggesting ? '' : ' at its own node'}.</p><div id="sd-search"></div></div>
      <form id="sd-form" autocomplete="off">
        <div class="grid2">
          ${TM.LANGS.map((l) => `<div class="field"><label>${l.label}${l.key === 'en' ? ' *' : ''}</label><input class="input" name="n-${l.key}" value="${TM.esc(values.names[l.key] || '')}" placeholder="${l.key === 'en' ? 'e.g. Bukit Jalil Central' : ''}"></div>`).join('')}
        </div>
        <div class="grid2">
          <div class="field"><label>Latitude</label><input class="input" name="lat" inputmode="decimal" value="${latLng.lat.toFixed(6)}"></div>
          <div class="field"><label>Longitude</label><input class="input" name="lng" inputmode="decimal" value="${latLng.lng.toFixed(6)}"></div>
        </div>
        <div class="row" style="margin:-2px 0 10px"><button type="button" class="btn sm" id="sd-pick">${TM.icon('pin')} Pick on map</button><span class="hint" id="sd-nodeinfo">${edit ? '' : `Node (${node.x}, ${node.y}) · coordinates are a first guess — adjust them to the real spot.`}</span></div>
        <div id="sd-map" class="picker-map" hidden style="margin-bottom:12px"></div>
        <div class="grid2">
          <div class="field"><label>Status</label><select class="input" name="status">${options(TM.STATUSES, values.status)}</select></div>
          <div class="field"><label>Structure</label><select class="input" name="structure">${options(TM.STRUCTURES, values.structure || 'unknown')}</select></div>
          <div class="field"><label>Opened (YYYY[-MM-DD])</label><input class="input" name="opened" value="${TM.esc(values.opened || '')}" placeholder="optional"></div>
          <div class="field"><label>Closed (YYYY[-MM-DD])</label><input class="input" name="closed" value="${TM.esc(values.closed || '')}" placeholder="optional"></div>
        </div>
        <div class="field"><label>Platforms <span style="font-weight:500">(e.g. 1 island + 2 side; none = unknown)</span></label><div id="sd-plat" style="display:grid;gap:6px"></div>
          <button type="button" class="btn sm ghost" id="sd-addplat" style="margin-top:6px">${TM.icon('plus')} Add platform type</button></div>
        <div class="field"><label>Note</label><textarea class="input" name="note" placeholder="Why here? Any transfers or ideas…">${TM.esc(values.note || '')}</textarea></div>
        <div class="field"><label>Link to existing station(s) — counts towards “same station suggested”</label>
          <div id="sd-chips" class="row wrap"></div><div id="sd-link"></div></div>
        <p class="hint" id="sd-err" style="color:var(--danger)"></p>
      </form>`;

    const dialog = ui.modal({
      title: edit ? `Edit ${TM.esc(edit.id)}` : 'Add a station', body: html, wide: true, onClose: () => picker && picker.destroy(),
      buttons: [
        { label: 'Cancel', cls: 'ghost' },
        { label: edit ? 'Save changes' : 'Create station', cls: 'primary', keep: true, onClick: () => submit() },
      ],
    });
    const root = dialog.body, form = $(root, '#sd-form'), errorEl = $(root, '#sd-err'), primary = dialog.foot.lastElementChild;
    const drawPlats = () => {
      $(root, '#sd-plat').innerHTML = plats.length ? plats.map((platform, i) => `<div class="row" style="gap:6px">` +
        (TM.PLATFORM_NO_COUNT.has(platform.type) ? '' : `<input class="input" type="number" min="1" max="99" data-pc="${i}" value="${platform.count || 1}" style="width:64px" aria-label="How many">`) +
        `<select class="input" data-pt="${i}" style="flex:1">${options(TM.PLATFORMS, platform.type)}</select>` +
        `<button type="button" class="btn sm ghost icon-btn" data-prm="${i}" title="Remove" style="width:28px">${TM.icon('x')}</button></div>`).join('')
        : '<p class="hint" style="margin:0">Unknown — add a platform type.</p>';
      $(root, '#sd-addplat').hidden = plats.length >= Object.keys(TM.PLATFORMS).length;
    };
    drawPlats();
    $(root, '#sd-plat').addEventListener('change', (e) => {
      const data = e.target.dataset;
      if (data.pt != null) {
        const type = e.target.value, other = plats.findIndex((p, j) => p.type === type && j !== +data.pt);
        if (other >= 0) { plats.splice(+data.pt, 1); }   // that type is already listed: merge into it
        else plats[+data.pt] = TM.PLATFORM_NO_COUNT.has(type) ? { type } : { type, count: plats[+data.pt].count || 1 };
        drawPlats();
      }
      if (data.pc != null) plats[+data.pc].count = Math.max(1, Math.min(99, Math.round(+e.target.value) || 1));
    });
    $(root, '#sd-plat').addEventListener('click', (e) => { const button = e.target.closest('[data-prm]'); if (button) { plats.splice(+button.dataset.prm, 1); drawPlats(); } });
    $(root, '#sd-addplat').onclick = () => {
      const type = Object.keys(TM.PLATFORMS).find((t) => !plats.some((p) => p.type === t));
      if (type) { plats.push(TM.PLATFORM_NO_COUNT.has(type) ? { type } : { type, count: 1 }); drawPlats(); }
    };

    /* tabs: create vs existing */
    if (!edit) {
      root.querySelectorAll('#sd-tabs button').forEach((button) => button.onclick = () => {
        tab = button.dataset.t;
        root.querySelectorAll('#sd-tabs button').forEach((x) => x.classList.toggle('on', x === button));
        $(root, '#sd-existing').hidden = tab !== 'existing'; form.hidden = tab !== 'new'; primary.hidden = tab !== 'new';
        if (tab === 'existing') search.focus();
      });
    }
    const search = ui.searchStations($(root, '#sd-search'), {
      hint: 'Start typing, e.g. “Sentral”, “KJ13” or “吉隆坡”.',
      exclude: () => new Set(line ? line.path.filter((it) => it.s).map((it) => it.s) : []),
      onPick: (st) => { actions.addStationToLine(st.id); dialog.close(); },
    });

    /* linked stations chips */
    const chips = $(root, '#sd-chips');
    const drawChips = () => {
      chips.innerHTML = [...linked].map((id) => { const station = store.stations.get(id); return `<span class="pill" style="height:26px">${TM.esc(id)} ${TM.esc(station ? TM.nameOf(station, 'en') : '')} <button type="button" data-rm="${TM.esc(id)}" style="border:0;background:none;cursor:pointer;color:var(--muted)">×</button></span>`; }).join('');
    };
    chips.onclick = (e) => { const button = e.target.closest('[data-rm]'); if (button) { linked.delete(button.dataset.rm); drawChips(); } };
    ui.searchStations($(root, '#sd-link'), {
      placeholder: 'Search an existing station to link…',
      exclude: () => new Set([...linked, edit ? edit.id : '']),
      onPick: (st) => { linked.add(st.id); drawChips(); },
    });
    drawChips();

    /* map picker */
    $(root, '#sd-pick').onclick = async () => {
      const mapBox = $(root, '#sd-map');
      if (!mapBox.hidden) { mapBox.hidden = true; return; }
      mapBox.hidden = false;
      try {
        if (picker) picker.destroy();
        picker = await TM.map.picker(mapBox, { lat: +form.lat.value || latLng.lat, lng: +form.lng.value || latLng.lng }, (la, lo) => { form.lat.value = la.toFixed(6); form.lng.value = lo.toFixed(6); });
      } catch (e) { TM.toast('Map could not load (offline?)', 'err'); mapBox.hidden = true; }
    };

    function read() {
      const stationForm = form, names = {};
      TM.LANGS.forEach((l) => { names[l.key] = stationForm['n-' + l.key].value.trim(); });
      return {
        names, lat: parseFloat(stationForm.lat.value), lng: parseFloat(stationForm.lng.value), status: stationForm.status.value, platform: store.normPlatforms(plats), structure: stationForm.structure.value,
        opened: stationForm.opened.value.trim(), closed: stationForm.closed.value.trim(), note: stationForm.note.value.trim(), linkedTo: [...linked],
      };
    }
    function validate(draft) {
      if (!Object.values(draft.names).some(Boolean)) return 'Give the station a name in at least one language.';
      if (!(draft.lat >= -90 && draft.lat <= 90) || !(draft.lng >= -180 && draft.lng <= 180)) return 'Latitude / longitude are not valid numbers.';
      if (!TM.validDate(draft.opened) || !TM.validDate(draft.closed)) return 'Dates must look like 2031, 2031-06 or 2031-06-15.';
      if (draft.opened && draft.closed && draft.closed < draft.opened) return 'The end of use is before the start of use.';
      return '';
    }

    function submit() {
      const draft = read(), message = validate(draft);
      errorEl.textContent = message;
      if (message) return false;
      if (edit) {
        if (!actions.updateStation(edit.id, Object.assign({}, draft, { names: Object.assign({}, edit.names, draft.names) }))) return false;
        TM.toast('Station updated'); dialog.close(); return false;
      }
      const near = store.nearby(draft.lat, draft.lng, 300);
      if (near.length) return proximity(draft, near);
      finish(draft);
      return false;
    }

    function finish(draft) {
      const station = actions.createStation(draft, node, true);
      TM.toast(`${station.id} created and ${suggesting ? 'suggested for' : 'added to'} ${line.code}`);
      dialog.close();
    }

    /* 300 m check: offer existing stations, still allow creating + linking a note */
    function proximity(draft, near) {
      const rows = near.map((nearby) => `<div class="suggest"><div class="grow"><b>${TM.esc(TM.nameOf(nearby.station, 'en'))}</b> <span class="hint">${TM.esc(nearby.station.id)} · ${TM.esc(nearby.station.names['zh-Hant'] || '')}</span><br><span class="hint">${TM.fmtDist(nearby.dist)} away · ${TM.STATUSES[nearby.station.status]}${nearby.station.author && nearby.station.author !== 'system' ? ' · by ' + TM.esc(nearby.station.author) : ''}</span></div>` +
        `<button class="btn sm primary" data-use="${TM.esc(nearby.station.id)}">Use this station</button></div>`).join('');
      const links = near.map((n) => `<label class="check" style="display:flex;margin:6px 0"><input type="checkbox" data-link="${TM.esc(n.station.id)}" ${linked.has(n.station.id) ? 'checked' : ''}> <span>Link my station to <b>${TM.esc(n.station.id)}</b> ${TM.esc(TM.nameOf(n.station, 'en'))}</span></label>`).join('');
      const prompt = ui.modal({
        title: `${near.length === 1 ? 'A station is' : near.length + ' stations are'} within 300 m`,
        body: `<p class="hint" style="margin-top:0">Reusing a station keeps the map tidy and lets others see how many people want the same stop.</p>${rows}<div class="lbl" style="margin:14px 0 2px">Prefer a new station? Add a note linking it to existing ones</div>${links}<div class="field" style="margin-top:8px"><textarea class="input" id="px-note" placeholder="Optional note, e.g. “Different exit, 200 m north of the existing stop”">${TM.esc(draft.note)}</textarea></div>`,
        buttons: [
          { label: 'Back', cls: 'ghost' },
          { label: 'No, create a new station', cls: '', onClick: (dialogApi) => {
            dialogApi.body.querySelectorAll('[data-link]').forEach((c) => { if (c.checked) linked.add(c.dataset.link); });
            draft.linkedTo = [...linked]; draft.note = dialogApi.body.querySelector('#px-note').value.trim();
            finish(draft);
          } },
        ],
      });
      prompt.body.onclick = (e) => {
        const button = e.target.closest('[data-use]'); if (!button) return;
        actions.addStationToLine(button.dataset.use); prompt.close(); dialog.close();
      };
      return false;
    }
    setTimeout(() => form['n-en'] && form['n-en'].focus(), 40);
  };

  /* ---------- new / edit line dialog ---------- */
  const SWATCH = ['#8b5cf6', '#0ea5e9', '#ec4899', '#14b8a6', '#f97316', '#ef4444', '#22c55e', '#eab308', '#6366f1', '#64748b'];
  ui.openLineDialog = (edit) => {
    const line = edit || { code: '', names: {}, color: SWATCH[store.lines.size % SWATCH.length], mode: 'mrt', style: 'octilinear', loop: false, status: 'fantasy', path: [] };
    const dialog = ui.modal({
      title: edit ? `Edit line ${TM.esc(line.code)}` : 'Create a new line', wide: true,
      body: `<form id="ld" autocomplete="off"><div class="grid2">
        ${TM.LANGS.map((g) => `<div class="field"><label>Line name · ${g.label}${g.key === 'en' ? ' *' : ''}</label><input class="input" name="n-${g.key}" value="${TM.esc(line.names[g.key] || '')}"></div>`).join('')}
        <div class="field"><label>Short code (badge)</label><input class="input" name="code" maxlength="4" value="${TM.esc(line.code)}" placeholder="auto"></div>
        <div class="field"><label>Type</label><select class="input" name="mode">${options(TM.MODES, line.mode)}</select></div>
        <div class="field"><label>Routing style</label><select class="input" name="style"><option value="octilinear" ${line.style === 'octilinear' ? 'selected' : ''}>Octilinear (45° + 90°)</option><option value="orthogonal" ${line.style === 'orthogonal' ? 'selected' : ''}>Orthogonal (90° only)</option></select></div>
        <div class="field"><label>Status</label><select class="input" name="status">${options(TM.STATUSES, line.status)}</select></div>
        <div class="field"><label>Journey planner: look for the train</label><select class="input" name="lookfor">${options(TM.LOOK_FOR, line.lookFor || 'towards')}</select></div></div>
        <div class="field"><label>Colour</label><div class="row wrap" id="ld-sw">${SWATCH.map((c) => `<button type="button" class="dot" data-c="${c}" style="background:${c};width:26px;height:26px;border:3px solid var(--panel);box-shadow:0 0 0 1.5px var(--line);cursor:pointer"></button>`).join('')}<input type="color" class="input" name="color" value="${line.color}" style="width:52px"></div></div>
        <div class="field"><label>Picture <span class="hint">(optional — a logo or sign for the line, usable as its badge)</span></label><div class="row wrap" style="gap:8px;align-items:center">
          <span id="ld-pic" style="width:56px;height:36px;display:inline-flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:8px;overflow:hidden"></span>
          <select class="input" id="ld-picsel" style="flex:1;min-width:160px"></select>
          <label class="btn sm" style="cursor:pointer">${TM.icon('upload')} Upload…<input type="file" id="ld-picfile" accept="image/*" hidden></label></div>
          <p class="hint" style="margin:4px 0 0">Pick one of the map's images, or upload a picture (JPG, PNG, SVG, GIF, WebP — up to about 500 KB) kept with the line.</p></div>
        <label class="check"><input type="checkbox" name="loop" ${line.loop ? 'checked' : ''}> Circle line (joins its two ends)</label>
        <div class="field" id="ld-loopdir" style="margin:6px 0 0 26px" ${line.loop ? '' : 'hidden'}><label>Following its stops in order, the line runs</label><select class="input" name="loopdir"><option value="">Auto — from the map (${store.loopDir(Object.assign({}, line, { loopDir: null, loop: true })) || 'unknown'})</option><option value="clockwise" ${line.loopDir === 'clockwise' ? 'selected' : ''}>Clockwise</option><option value="anticlockwise" ${line.loopDir === 'anticlockwise' ? 'selected' : ''}>Anticlockwise</option></select>
          <div class="grid2" style="margin-top:8px"><div class="field" style="margin:0"><label>Journey planner names its ways round</label><select class="input" name="loopnames">${options(TM.LOOP_NAMES, line.loopNames || 'cw')}</select></div>
          <div class="field" style="margin:0"><label>Trains keep to the</label><select class="input" name="traffic">${options(TM.TRAFFIC, line.traffic || 'left')}</select></div></div>
          <p class="hint" style="margin:4px 0 0">Left-hand running: the outer loop runs clockwise; right-hand: anticlockwise.</p></div>
        <label class="check" style="margin-top:6px"><input type="checkbox" name="inout" ${line.inOut ? 'checked' : ''}> Same-station in-out (enter and exit at one station without riding anywhere)</label>
        <p class="hint" id="ld-err" style="color:var(--danger)"></p></form>`,
      buttons: [{ label: 'Cancel', cls: 'ghost' }, { label: edit ? 'Save' : 'Create line', cls: 'primary', onClick: (dialogApi) => {
        const form = $(dialogApi.body, '#ld'), names = {};
        TM.LANGS.forEach((g) => { names[g.key] = form['n-' + g.key].value.trim(); });
        if (!Object.values(names).some(Boolean)) { $(dialogApi.body, '#ld-err').textContent = 'Give the line a name.'; return false; }
        const fields = { names, code: form.code.value.trim(), color: form.color.value, mode: form.mode.value, style: form.style.value, status: form.status.value, loop: form.loop.checked, loopDir: form.loop.checked ? form.loopdir.value || null : null, loopNames: form.loop.checked && form.loopnames.value !== 'cw' ? form.loopnames.value : null, traffic: form.loop.checked && form.traffic.value === 'right' ? 'right' : null, inOut: form.inout.checked, image: picture, lookFor: form.lookfor.value === 'towards' ? null : form.lookfor.value };
        if (edit) { Object.assign(edit, fields, { code: (fields.code || edit.code).toUpperCase() }); store.save(); TM.toast('Line updated'); }
        else { const createdLine = actions.newLine(fields); TM.toast(`${createdLine.code} created — pick the Station tool and click a node`); }
      } }],
    });
    /* the line's picture: '' none · a map image file · an uploaded data: URI */
    let picture = line.image || null;
    const picSel = dialog.body.querySelector('#ld-picsel'), picBox = dialog.body.querySelector('#ld-pic');
    const drawPic = () => {
      const files = [...TM.imageList, ...TM.specialList];
      picSel.innerHTML = `<option value="">None</option>${/^data:/.test(picture || '') ? '<option value="__up" selected>Uploaded picture</option>' : ''}` +
        files.map((im) => `<option value="${TM.esc(im.file)}" ${im.file === picture ? 'selected' : ''}>${TM.esc(im.name)}</option>`).join('') +
        (picture && !/^data:/.test(picture) && !files.some((im) => im.file === picture) ? `<option value="${TM.esc(picture)}" selected>${TM.esc(picture)}</option>` : '');
      const uri = picture && TM.lineImage({ image: picture });
      picBox.innerHTML = uri ? `<img alt="" src="${uri}" style="max-width:100%;max-height:100%;object-fit:contain">` : '<span class="hint">—</span>';
    };
    drawPic();
    picSel.onchange = () => { if (picSel.value !== '__up') { picture = picSel.value || null; drawPic(); } };
    dialog.body.querySelector('#ld-picfile').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.type)) { TM.toast('Use a JPG, PNG, SVG, GIF or WebP picture', 'err'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        if (!store.normLineImage(reader.result)) { TM.toast('That picture is too large — keep it under about 500 KB', 'err'); return; }
        picture = reader.result; drawPic();
      };
      reader.readAsDataURL(file);
    };
    dialog.body.querySelector('[name=loop]').onchange = (e) => { dialog.body.querySelector('#ld-loopdir').hidden = !e.target.checked; };
    dialog.body.querySelector('#ld-sw').onclick = (e) => { const swatch = e.target.closest('[data-c]'); if (swatch) { const colourInput = dialog.body.querySelector('[name=color]'); colourInput.value = swatch.dataset.c; colourInput.dispatchEvent(new Event('input', { bubbles: true })); } };
    setTimeout(() => dialog.body.querySelector('[name=n-en]').focus(), 40);
  };

  /* ---------- import ---------- */
  ui.importFiles = async (files) => {
    const zipFile = files.find((f) => /\.zip$/i.test(f.name) || f.type === 'application/zip');
    files = files.filter((f) => f !== zipFile);
    const objs = [];
    for (const f of files) {
      try { objs.push(JSON.parse(await f.text())); } catch (e) { TM.toast(`${f.name} is not valid JSON`, 'err'); }
    }
    if (!objs.length) { if (zipFile) ui.importMapZip(zipFile); return; }
    const result = store.importData(objs);
    TM.toast(`Imported ${result.lines} line(s), ${result.stations} station(s)${result.suggestions ? `, ${result.suggestions} stop suggestion(s)` : ''}${result.remapped ? ` · ${result.remapped} code(s) renumbered` : ''}`);
    TM.emit('visibility');
    if (zipFile) ui.importMapZip(zipFile);
  };

  /* ---------- legend editor: the map's own legend items (store.legend) — lines, symbols, line styles, images ---------- */
  ui.openLegendDialog = () => {
    const symbols = TM.symbols, palette = symbols.palette(document.documentElement.dataset.theme), lang = TM.state.langs[0];
    const shown = [...store.visible].filter((id) => store.lineFilter.has(id)).map((id) => store.lines.get(id)).filter(Boolean);
    const allLines = [...store.lines.values()], colours = [(shown[0] || {}).color || '#e11d48', (shown[1] || {}).color || '#2563eb', (shown[2] || {}).color || '#16a34a'];
    let items = JSON.parse(JSON.stringify(store.legend || symbols.defaultLegend(shown)));
    const KINDS = { line: 'Line', symbol: 'Symbol', style: 'Line style', image: 'Image' };
    const fresh = (kind) => kind === 'line' ? { kind, line: (shown[0] || allLines[0] || {}).id || '' } : kind === 'symbol' ? { kind, symbol: 'station' } : kind === 'style' ? { kind, style: 'dash' } : { kind, file: (TM.imageList[0] || {}).file || '' };
    const preview = (item) => {
      const drawn = symbols.legendDraw(palette, item, 0, allLines, colours), top = (drawn.rowY || 0) - drawn.h / 2 - 2;
      return `<svg width="52" height="34" viewBox="8 ${top} 46 ${drawn.h + 4}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${drawn.svg}</svg>`;
    };
    const valueSelect = (item, i) => {
      const opts = item.kind === 'line' ? allLines.map((l) => [l.id, `${l.code} · ${TM.nameOf(l, lang)}`])
        : item.kind === 'symbol' ? Object.entries(symbols.LEGEND_SYMBOLS).map(([k, d]) => [k, d[0]])
        : item.kind === 'style' ? Object.entries(symbols.LEGEND_STYLES)
        : TM.imageList.map((im) => [im.file, im.name]);
      const cur = item[{ line: 'line', symbol: 'symbol', style: 'style', image: 'file' }[item.kind]];
      return `<select class="input" data-lval="${i}" style="height:32px">${opts.map(([v, t]) => `<option value="${TM.esc(v)}" ${v === cur ? 'selected' : ''}>${TM.esc(t)}</option>`).join('')}</select>`;
    };
    const row = (item, i) => `<div class="leg-row" style="display:grid;grid-template-columns:52px 1fr auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">
        ${preview(item)}
        <div style="display:grid;gap:6px">
          <div class="row" style="gap:6px"><select class="input" data-lkind="${i}" style="height:32px;flex:0 0 112px">${Object.entries(KINDS).map(([k, t]) => `<option value="${k}" ${k === item.kind ? 'selected' : ''} ${k === 'image' && !TM.imageList.length ? 'disabled' : ''}>${t}</option>`).join('')}</select><div style="flex:1;min-width:0">${valueSelect(item, i)}</div></div>
          <div class="row" style="gap:6px"><input class="input" data-lname="${i}" maxlength="60" value="${TM.esc(item.label || '')}" placeholder="${TM.esc(symbols.legendLabel(Object.assign({}, item, { label: '' }), allLines, lang))}" style="height:32px;flex:1;min-width:0" aria-label="Name">
          ${item.kind === 'image' ? '' : `<label class="check" title="Use a colour of its own" style="white-space:nowrap"><input type="checkbox" data-lcolon="${i}" ${item.color ? 'checked' : ''}> Colour</label><input type="color" data-lcolor="${i}" value="${item.color || (item.kind === 'line' ? ((allLines.find((l) => l.id === item.line) || {}).color || colours[0]) : colours[0])}" ${item.color ? '' : 'disabled'} style="width:36px;height:28px;padding:0;border-radius:6px" aria-label="Colour">`}</div>
        </div>
        <span class="row" style="gap:0"><button class="btn sm ghost icon-btn" data-lmv="-1" data-i="${i}" style="width:26px;padding:0" ${i ? '' : 'disabled'} aria-label="Move up">${TM.icon('up')}</button><button class="btn sm ghost icon-btn" data-lmv="1" data-i="${i}" style="width:26px;padding:0" ${i < items.length - 1 ? '' : 'disabled'} aria-label="Move down">${TM.icon('down')}</button><button class="btn sm ghost icon-btn" data-lrm="${i}" style="width:26px;padding:0" aria-label="Remove">${TM.icon('x')}</button></span>
      </div>`;
    const dialog = ui.modal({
      title: 'Edit legend', wide: true,
      body: `<p class="hint" style="margin-top:0">${store.legend ? 'This map has its own legend.' : 'Showing the automatic legend — any change gives the map a legend of its own.'} Leave a name blank to use its default. Images come from the map's images folder.</p>
        <div id="leg-list" style="max-height:56vh;overflow:auto"></div>
        <div class="row wrap" style="gap:6px;margin-top:10px">${Object.entries(KINDS).map(([k, t]) => `<button type="button" class="btn sm" data-ladd="${k}" ${k === 'image' && !TM.imageList.length ? 'disabled title="This map has no images"' : ''}>${TM.icon('plus')} ${t}</button>`).join('')}</div>`,
      buttons: [
        { label: '↺ Automatic', cls: 'ghost', onClick: () => { store.setLegend(null); TM.emit('display'); TM.toast('Legend back to automatic'); } },
        { label: 'Cancel', cls: 'ghost' },
        { label: 'Save', cls: 'primary', onClick: () => { store.setLegend(items); TM.emit('display'); TM.toast('Legend saved'); } },
      ],
    });
    const list = $(dialog.body, '#leg-list');
    const draw = () => { const top = list.scrollTop; list.innerHTML = items.map(row).join('') || '<div class="empty">No items — add one below.</div>'; list.scrollTop = top; };
    draw();
    dialog.body.addEventListener('click', (e) => {
      let b;
      if ((b = e.target.closest('[data-ladd]'))) { items.push(fresh(b.dataset.ladd)); draw(); list.scrollTop = list.scrollHeight; }
      else if ((b = e.target.closest('[data-lrm]'))) { items.splice(+b.dataset.lrm, 1); draw(); }
      else if ((b = e.target.closest('[data-lmv]'))) { const i = +b.dataset.i, j = i + +b.dataset.lmv; [items[i], items[j]] = [items[j], items[i]]; draw(); }
    });
    dialog.body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.lname != null) { const it = items[+t.dataset.lname]; if (t.value.trim()) it.label = t.value; else delete it.label; }
      else if (t.dataset.lcolor != null) { items[+t.dataset.lcolor].color = t.value; const pv = t.closest('.leg-row').firstElementChild; pv.outerHTML = preview(items[+t.dataset.lcolor]); }
    });
    dialog.body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.lkind != null) { const i = +t.dataset.lkind, old = items[i]; items[i] = Object.assign(fresh(t.value), old.label ? { label: old.label } : {}); draw(); }
      else if (t.dataset.lval != null) { const it = items[+t.dataset.lval]; it[{ line: 'line', symbol: 'symbol', style: 'style', image: 'file' }[it.kind]] = t.value; draw(); }
      else if (t.dataset.lcolon != null) { const it = items[+t.dataset.lcolon]; if (t.checked) it.color = t.closest('.leg-row').querySelector('[data-lcolor]').value; else delete it.color; draw(); }
    });
  };

  /* ---------- annotation dialog: a free-floating custom text label or a map image, placed anywhere on the canvas ---------- */
  ui.openAnnotationDialog = (labelOptions) => {
    labelOptions = labelOptions || {};
    const edit = labelOptions.edit ? store.annotations[labelOptions.edit] : null;
    const kind = edit ? edit.kind : 'text';
    const editText = edit && edit.kind === 'text' ? edit : {};
    const dialog = TM.ui.modal({
      title: edit ? 'Edit label' : 'Add a label',
      body: `<div class="field"><label>Kind</label><div class="seg" id="an-kind"><button type="button" data-k="text" class="${kind === 'text' ? 'on' : ''}">Text</button><button type="button" data-k="image" class="${kind === 'image' ? 'on' : ''}" ${TM.imageList.length ? '' : 'disabled'}>Image</button></div></div>
        <div id="an-text" ${kind === 'text' ? '' : 'hidden'}>
          <div class="field"><label>Text</label><input class="input" id="an-txt" maxlength="200" value="${TM.esc(edit && edit.kind === 'text' ? edit.text : '')}" placeholder="e.g. Under review"></div>
          <div class="grid2"><div class="field"><label>Size</label><input class="input" type="number" id="an-size" min="8" max="96" value="${edit && edit.kind === 'text' ? edit.size : 16}"></div>
          <div class="field"><label>Colour</label><div class="row" style="gap:8px"><input class="input" type="color" id="an-color" value="${edit && edit.kind === 'text' && edit.color ? edit.color : '#1b2333'}" style="width:44px;height:38px;padding:2px"></div></div></div>
          <label class="check"><input type="checkbox" id="an-bold" ${edit && edit.kind === 'text' && edit.bold ? 'checked' : ''}> Bold</label>
          <div class="field" style="margin-top:12px"><label>Background shape</label><select class="input" id="an-shape">${options(TM.ANN_SHAPES, editText.shape || 'none')}</select></div>
          <div id="an-frame">
            <div class="grid2"><div class="field"><label>Background colour</label><div class="row wrap" style="gap:8px"><select class="input" id="an-bgOn" style="flex:1 1 100%"><option value="">None</option><option value="1" ${editText.bg ? 'selected' : ''}>Colour</option></select><input class="input" type="color" id="an-bg" value="${editText.bg || '#ffffff'}" style="width:44px;height:38px;padding:2px"></div></div>
            <div class="field"><label>Border</label><div class="row wrap" style="gap:8px"><select class="input" id="an-border" style="flex:1 1 100%">${options(TM.ANN_BORDERS, editText.border || 'none')}</select><input class="input" type="color" id="an-bcol" value="${editText.borderColor || '#1b2333'}" style="width:44px;height:38px;padding:2px" title="Border colour" aria-label="Border colour"></div></div></div>
          </div>
          <p class="hint" id="an-frameHint" style="margin-top:0">Pick a shape to give the text a background colour or a border.</p>
        </div>
        <div id="an-image" ${kind === 'image' ? '' : 'hidden'}>
          ${TM.imageList.length ? `<div class="field"><label>Image</label><div class="row wrap">${TM.imageList.map((im) => `<button type="button" class="ico ${edit && edit.kind === 'image' && edit.file === im.file ? 'on' : ''}" data-img="${TM.esc(im.file)}" title="${TM.esc(im.name)}"><img alt="${TM.esc(im.name)}" src="${TM.images.get(im.file)}"></button>`).join('')}</div></div>
          <div class="field"><label>Width (px)</label><input class="input" type="number" id="an-w" min="10" max="2000" value="${edit && edit.kind === 'image' ? edit.w : 64}"></div>` : `<p class="hint">This map has no images to place — add one in the map's images folder first.</p>`}
        </div>
        <p class="hint" id="an-err" style="color:var(--danger)"></p>`,
      buttons: [
        ...(edit ? [{ label: 'Delete', cls: 'danger', onClick: () => { actions.removeAnnotation(labelOptions.edit); TM.toast('Label removed'); } }] : []),
        { label: 'Cancel', cls: 'ghost' },
        { label: edit ? 'Save' : 'Add', cls: 'primary', onClick: (dialogApi) => {
          const root = dialogApi.body, chosenKind = root.querySelector('#an-kind .on').dataset.k, errorEl = $(root, '#an-err');
          let annotation;
          if (chosenKind === 'text') {
            const text = $(root, '#an-txt').value.trim();
            if (!text) { errorEl.textContent = 'Type something to show.'; return false; }
            const shape = $(root, '#an-shape').value, border = $(root, '#an-border').value;
            annotation = { kind: 'text', x: edit ? edit.x : labelOptions.x, y: edit ? edit.y : labelOptions.y, text, size: +$(root, '#an-size').value || 16, color: $(root, '#an-color').value, bold: $(root, '#an-bold').checked,
              shape, bg: $(root, '#an-bgOn').value ? $(root, '#an-bg').value : null, border, borderColor: border !== 'none' ? $(root, '#an-bcol').value : null };
          } else {
            const icon = root.querySelector('#an-image .ico.on');
            if (!icon) { errorEl.textContent = 'Choose an image.'; return false; }
            annotation = { kind: 'image', x: edit ? edit.x : labelOptions.x, y: edit ? edit.y : labelOptions.y, file: icon.dataset.img, w: +$(root, '#an-w').value || 64 };
          }
          if (edit) actions.setAnnotation(labelOptions.edit, annotation); else actions.addAnnotation(annotation);
          TM.toast(edit ? 'Label updated' : 'Label added');
        } },
      ],
    });
    const root = dialog.body;
    root.querySelector('#an-kind').onclick = (e) => {
      const button = e.target.closest('[data-k]'); if (!button || button.disabled) return;
      root.querySelectorAll('#an-kind button').forEach((x) => x.classList.toggle('on', x === button));
      $(root, '#an-text').hidden = button.dataset.k !== 'text'; $(root, '#an-image').hidden = button.dataset.k !== 'image';
    };
    /* background colour / border only mean something once there is a shape to draw them on */
    const syncFrame = () => {
      const none = $(root, '#an-shape').value === 'none';
      root.querySelectorAll('#an-frame select, #an-frame input').forEach((el) => { el.disabled = none; });
      $(root, '#an-bg').disabled = none || !$(root, '#an-bgOn').value;
      $(root, '#an-bcol').disabled = none || $(root, '#an-border').value === 'none';
      ui.syncHex(root);
      $(root, '#an-frame').style.opacity = none ? 0.5 : 1;
      $(root, '#an-frameHint').hidden = !none;
    };
    ['#an-shape', '#an-bgOn', '#an-border'].forEach((q) => { $(root, q).onchange = syncFrame; });
    syncFrame();
    const imgWrap = root.querySelector('#an-image .row');
    if (imgWrap) imgWrap.onclick = (e) => { const button = e.target.closest('[data-img]'); if (button) { imgWrap.querySelectorAll('.ico').forEach((x) => x.classList.toggle('on', x === button)); } };
    setTimeout(() => { const textInput = $(root, '#an-txt'); if (textInput) textInput.focus(); }, 40);
  };

  /* ---------- a service (see store.normService): where a train runs and where it stops ---------- */
  ui.openServiceDialog = (service, rootId) => {
    if (!actions.canEditServices()) { TM.toast('Only the map\'s own author can change its services', 'err'); return; }
    const root = store.lines.get(rootId) || null;
    const name = (id) => { const station = store.stations.get(id); return station ? TM.nameOf(station, TM.state.langs[0]) : id; };
    /* a new service starts as the whole line: its first and last stop (a loop: round from its first stop) */
    const ends = () => {
      const stops = root ? root.path.filter((i) => i.s).map((i) => i.s) : [];
      return stops.length < 2 ? stops : root.loop ? [stops[0], stops[1], stops[0]] : [stops[0], stops[stops.length - 1]];
    };
    const draft = service ? JSON.parse(JSON.stringify(service)) : { id: '', name: root ? TM.displayName(root) : 'New service', via: ends(), loop: !!(root && root.loop) };
    const state = { via: draft.via.slice(), loop: !!draft.loop, both: draft.both !== false, hidden: !!draft.hidden, diffBack: !!draft.return };
    /* stop / pass choices per place, kept by the place's own codes so they survive changes to the route */
    const key = (pl) => pl.ids.slice().sort().join('+');
    const choice = { fwd: new Map(), back: new Map() };
    const seed = (serviceRoute) => {
      ['fwd', 'back'].forEach((direction) => {
        const at = store.serviceStopsAt(draft, serviceRoute, direction === 'back' && !!draft.return);
        serviceRoute.places.forEach((pl, i) => { if (!choice[direction].has(key(pl))) choice[direction].set(key(pl), at.has(i)); });
      });
    };
    seed(store.serviceRoute({ via: state.via, loop: state.loop }));

    const html = `<div class="grid2"><div class="field"><label>Name *</label><input class="input" id="svName" maxlength="60" value="${TM.esc(draft.name)}"></div>
        <div class="field"><label>Type <span style="font-weight:500">(optional — e.g. Express, Limited; shown as “Look for Express train …”)</span></label><input class="input" id="svType" maxlength="30" value="${TM.esc(draft.type || '')}"></div></div>
      <div class="field"><label>Route</label><p class="hint" style="margin:0 0 6px">The stations it runs through, in order — its termini and, where the track could go more than one way (round a loop, or at a junction), a station in between to say which. Everything between two of them is filled in along the track. It may run from one line onto another where a station is shared (a same-platform or interchange link): a train running through.</p>
        <div id="svVia" style="display:grid;gap:4px"></div><div id="svAdd" style="margin-top:6px"></div></div>
      <div class="row wrap" style="gap:14px;margin:4px 0 10px"><label class="check"><input type="checkbox" id="svLoop" ${state.loop ? 'checked' : ''}> Loop <span class="hint">(round and round: ends where it starts)</span></label>
        <label class="check"><input type="checkbox" id="svBoth" ${state.both ? 'checked' : ''}> Runs both ways</label>
        <label class="check"><input type="checkbox" id="svHidden" ${state.hidden ? 'checked' : ''}> Hidden <span class="hint">(off in the journey planner unless switched on)</span></label></div>
      <div class="grid2" id="svLoopNames" ${state.loop ? '' : 'hidden'}><div class="field"><label>Ways round named</label><select class="input" id="svLoopN"><option value="">As its line says</option>${Object.entries(TM.LOOP_NAMES).map(([k, t]) => `<option value="${k}" ${draft.loopNames === k ? 'selected' : ''}>${TM.esc(t)}</option>`).join('')}</select></div>
        <div class="field"><label>Trains keep to the</label><select class="input" id="svTraffic"><option value="">As its line says</option>${Object.entries(TM.TRAFFIC).map(([k, t]) => `<option value="${k}" ${draft.traffic === k ? 'selected' : ''}>${TM.esc(t)}</option>`).join('')}</select></div></div>
      <div class="field"><label>Journey planner: look for the train</label><select class="input" id="svLook"><option value="">As its line says${root ? ` (${TM.esc(TM.LOOK_FOR[root.lookFor || 'towards'].toLowerCase())})` : ''}</option>${Object.entries(TM.LOOK_FOR).map(([k, t]) => `<option value="${k}" ${draft.lookFor === k ? 'selected' : ''}>${TM.esc(t)}</option>`).join('')}</select></div>
      <div id="svDyn"></div>`;
    const dialog = ui.modal({
      title: service ? `Service · ${TM.esc(service.name)}` : `New service${root ? ' · ' + TM.esc(root.code) : ''}`, wide: true, body: html,
      buttons: [{ label: 'Cancel', cls: 'ghost' }, { label: service ? 'Save' : 'Create service', cls: 'primary', onClick: () => save() }],
      onClose: () => ui.showService(null),   // the map goes back to normal
    });
    const root_ = dialog.body, query = (sel) => $(root_, sel);

    const placeList = (serviceRoute, direction) => {
      const places = serviceRoute.places.map((p, i) => ({ p, i }));
      if (direction === 'fwd') return places;
      return serviceRoute.loop ? [places[0], ...places.slice(1).reverse()] : places.reverse();
    };
    const listHtml = (serviceRoute, direction) => placeList(serviceRoute, direction).map(({ p: place }, position, all) => {
      const end = !serviceRoute.loop && (position === 0 || position === all.length - 1), on = end || choice[direction].get(key(place)) !== false;
      return `<label class="${end ? 'end' : ''}"><input type="checkbox" data-stop="${direction}" data-key="${TM.esc(key(place))}" ${on ? 'checked' : ''} ${end ? 'disabled' : ''}><span class="code">${TM.esc(place.ids.join(' · '))}</span>${TM.esc(name(place.ids[0]))}${end ? ' <span class="hint">· terminus</span>' : ''}</label>`;
    }).join('');
    function render() {
      query('#svVia').innerHTML = state.via.map((id, i) => `<div class="svc-anchor"><span class="hint" style="width:18px;text-align:right">${i + 1}</span><span class="code">${TM.esc(id)}</span><span style="flex:1">${TM.esc(name(id))}</span>` +
        `<button type="button" class="btn sm ghost icon-btn" data-vmv="-1" data-i="${i}" style="width:24px;padding:0" ${i === 0 ? 'disabled' : ''}>${TM.icon('up')}</button><button type="button" class="btn sm ghost icon-btn" data-vmv="1" data-i="${i}" style="width:24px;padding:0" ${i === state.via.length - 1 ? 'disabled' : ''}>${TM.icon('down')}</button><button type="button" class="btn sm ghost icon-btn" data-vrm="${i}" style="width:24px;padding:0">${TM.icon('x')}</button></div>`).join('') ||
        '<p class="hint" style="margin:0">No stations yet — add the first below.</p>';
      const serviceRoute = state.via.length >= 2 ? store.serviceRoute({ via: state.via, loop: state.loop }) : null;
      if (serviceRoute) seed(serviceRoute);
      let rowsHtml = '';
      if (serviceRoute && serviceRoute.warn.length) rowsHtml += serviceRoute.warn.map((w) => `<p class="hint" style="color:var(--danger);margin:0 0 6px">⚠ ${TM.esc(w)}</p>`).join('');
      if (serviceRoute && serviceRoute.ok) {
        const lines = [...new Set(serviceRoute.hops.filter((x) => x.line).map((x) => store.rootLine(x.line)))].filter(Boolean);
        rowsHtml += `<p class="hint" style="margin:0 0 6px">${serviceRoute.places.length} stations${lines.length > 1 ? ' · runs through: ' + lines.map((l) => TM.esc(l.code)).join(' → ') : ''}. Untick a station it passes without stopping.</p>`;
        rowsHtml += `<div class="lbl" style="margin:6px 0 4px">Stops${state.both ? ' — ' + (serviceRoute.loop ? 'this way round' : `towards ${TM.esc(name(serviceRoute.places[serviceRoute.places.length - 1].ids[0]))}`) : ''} <button type="button" class="btn sm ghost" data-all="fwd" style="height:20px;padding:0 6px;font-size:11px">All</button></div><div class="svc-route">${listHtml(serviceRoute, 'fwd')}</div>`;
        if (state.both) {
          rowsHtml += `<label class="check" style="margin:10px 0 4px"><input type="checkbox" id="svDiff" ${state.diffBack ? 'checked' : ''}> Stops differently the other way</label>`;
          if (state.diffBack) rowsHtml += `<div class="lbl" style="margin:6px 0 4px">Stops — ${serviceRoute.loop ? 'the other way round' : `towards ${TM.esc(name(serviceRoute.places[0].ids[0]))}`} <button type="button" class="btn sm ghost" data-all="back" style="height:20px;padding:0 6px;font-size:11px">All</button></div><div class="svc-route">${listHtml(serviceRoute, 'back')}</div>`;
        }
      }
      const keepScroll = [...query('#svDyn').querySelectorAll('.svc-route')].map((x) => x.scrollTop);   // ticking a stop redraws the lists
      query('#svDyn').innerHTML = rowsHtml;
      query('#svDyn').querySelectorAll('.svc-route').forEach((x, i) => { x.scrollTop = keepScroll[i] || 0; });
      /* the route as it stands, lit on the map behind the dialog — stops lit, stations passed faded */
      if (serviceRoute && serviceRoute.ok) {
        const on = new Set();
        serviceRoute.places.forEach((p, i) => { if ((!serviceRoute.loop && (i === 0 || i === serviceRoute.places.length - 1)) || choice.fwd.get(key(p)) !== false) on.add(i); });
        ui.showService({ via: state.via, loop: state.loop }, on);
      } else ui.showService(null);
    }
    ui.searchStations(query('#svAdd'), Object.assign({ placeholder: 'Add a station to the route…', exclude: () => new Set(), onPick: (s) => { state.via.push(s.id); render(); const i = query('#svAdd input'); if (i) i.value = ''; } }, TM.navUI ? TM.navUI.groupOpts() : {}));
    root_.addEventListener('click', (e) => {
      let button;
      if ((button = e.target.closest('[data-vmv]'))) { const i = +button.dataset.i, j = i + +button.dataset.vmv; [state.via[i], state.via[j]] = [state.via[j], state.via[i]]; render(); return; }
      if ((button = e.target.closest('[data-vrm]'))) { state.via.splice(+button.dataset.vrm, 1); render(); return; }
      if ((button = e.target.closest('[data-all]'))) { choice[button.dataset.all].forEach((v, k) => choice[button.dataset.all].set(k, true)); render(); }
    });
    root_.addEventListener('change', (e) => {
      const target = e.target;
      if (target.id === 'svLoop') { query('#svLoopNames').hidden = !target.checked; state.loop = target.checked; if (state.loop && state.via.length >= 2 && state.via[state.via.length - 1] !== state.via[0]) state.via.push(state.via[0]); render(); }
      else if (target.id === 'svBoth') { state.both = target.checked; render(); }
      else if (target.id === 'svHidden') state.hidden = target.checked;
      else if (target.id === 'svDiff') { state.diffBack = target.checked; render(); }
      else if (target.dataset.stop) { choice[target.dataset.stop].set(target.dataset.key, target.checked); render(); }
    });
    function save() {
      const newName = query('#svName').value.trim();
      if (!newName) { TM.toast('Give the service a name', 'err'); return false; }
      if (state.via.length < 2) { TM.toast('A service needs at least two stations on its route', 'err'); return false; }
      const serviceRoute = store.serviceRoute({ via: state.via, loop: state.loop });
      if (!serviceRoute.ok) { TM.toast(serviceRoute.warn[0] || 'That route does not follow the track', 'err'); return false; }
      /* each stopping pattern written the shorter way: the stops, or the stations passed without stopping */
      const pattern = (direction) => {
        const ids = serviceRoute.places.map((p) => p.ids), on = new Set();
        serviceRoute.places.forEach((p, i) => { if ((!serviceRoute.loop && (i === 0 || i === serviceRoute.places.length - 1)) || choice[direction].get(key(p)) !== false) on.add(i); });
        return store.compactPattern(ids, on);
      };
      const next = { id: draft.id, name: newName, via: state.via.slice() };
      const type = query('#svType').value.trim();
      if (type) next.type = type;
      if (query('#svLook').value) next.lookFor = query('#svLook').value;
      if (state.loop && query('#svLoopN').value) next.loopNames = query('#svLoopN').value;
      if (state.loop && query('#svTraffic').value) next.traffic = query('#svTraffic').value;
      if (state.loop) next.loop = true;
      if (!state.both) next.both = false;
      if (state.hidden) next.hidden = true;
      Object.assign(next, pattern('fwd'));
      if (state.both && state.diffBack) next.return = pattern('back');   // {} = stops everywhere that way
      const saved = actions.saveService(next, service && service.id);
      if (saved) TM.toast(`${saved.name} saved${serviceRoute.warn.length ? ' — check the route: ' + serviceRoute.warn[0] : ''}`);
      return !!saved;
    }
    render();
    setTimeout(() => query('#svName').focus(), 40);
  };
})(window.TM);
