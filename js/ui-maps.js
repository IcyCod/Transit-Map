/* Map switcher (the brand in the top bar) and the dialogs to create, edit, import and share maps. */
(function (TM) {
  const ui = (TM.ui = TM.ui || {});
  const maps = TM.maps;
  const $ = (id) => document.getElementById(id);
  const DEFAULT_LOGO = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent)"/><path d="M7 22h6a4 4 0 0 0 4-4v-4a4 4 0 0 1 4-4h4" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="7" cy="22" r="3" fill="#fff"/><circle cx="25" cy="10" r="3" fill="#fff"/></svg>';
  const logoHTML = (m) => { const logoSrc = maps.logoSrc(m); return logoSrc ? `<img class="logo" alt="" src="${TM.esc(logoSrc)}">` : DEFAULT_LOGO; };

  /* ---------- reading a logo file: SVG as is, pictures shrunk to 128 px ---------- */
  const readLogo = (file) => new Promise((resolve, reject) => {
    if (!/^image\/(svg\+xml|png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error('Use an SVG, PNG, JPG, WebP or GIF image'));
    if (file.size > 4 * 1024 * 1024) return reject(new Error('That image is too large (4 MB max)'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image'));
    if (file.type === 'image/svg+xml') {
      reader.onload = () => (String(reader.result).length > 120000 ? reject(new Error('That SVG is too large (120 KB max)')) : resolve('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(reader.result)));
      reader.readAsText(file);
      return;
    }
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('Could not read the image'));
      image.onload = () => {
        const scale = Math.min(1, 128 / Math.max(image.width, image.height)), canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  /* ---------- the switcher ---------- */
  ui.mapPicker = (host) => {
    let open = false;
    host.innerHTML = '<div class="dd"><button class="brand-btn" aria-haspopup="listbox" title="Switch map"></button><div class="dd-pop map-pop" hidden></div></div>';
    const root = host.firstElementChild, button = root.querySelector('.brand-btn'), popup = root.querySelector('.map-pop');

    const paint = () => {
      const currentMap = maps.current;
      button.innerHTML = `${logoHTML(currentMap)}<span class="bt"><span class="t">${TM.esc(maps.name(currentMap))}</span><small>${TM.esc(currentMap.subtitle || (maps.isUser(currentMap) ? 'my map' : ''))}</small></span>${TM.icon('chevron', 'chev')}`;
      button.setAttribute('aria-label', `Map: ${maps.name(currentMap)}. Switch map`);
    };
    const row = (meta) => {
      const isCurrent = meta.id === maps.current.id;
      return `<div class="dd-item map-item ${isCurrent ? 'cur' : ''}" role="option" data-id="${TM.esc(meta.id)}" aria-selected="${isCurrent}">${logoHTML(meta)}<div class="nm"><b>${TM.esc(maps.name(meta))}</b><span>${TM.esc([[meta.area, meta.country].filter(Boolean).join(', '), meta.subtitle || meta.description || (maps.isUser(meta) ? 'Made in this browser' : '')].filter(Boolean).join(' · '))}</span></div>${isCurrent ? '<span class="pill ok">Open</span>' : ''}</div>`;
    };
    const build = () => {
      const currentMap = maps.current, mine = maps.isUser(currentMap), canInstall = typeof maps.devInstall === 'function';
      const groups = [['Published maps', maps.shipped], ['My maps', maps.user]].filter(([, l]) => l.length);
      popup.innerHTML = `<div class="dd-list" role="listbox">${groups.map(([t, l]) => `<div class="dd-group">${t}</div>${l.map(row).join('')}`).join('')}</div>` +
        `<div class="map-actions"><button class="btn sm" data-a="new">${TM.icon('plus')} New map…</button><button class="btn sm" data-a="import">${TM.icon('upload')} Import .zip</button></div>` +
        `<div class="map-cur"><div class="lbl">This map · ${mine ? 'made in this browser' : 'published with the site'}</div><div class="row wrap" style="margin-top:6px">` +
        `<button class="btn sm primary" data-a="export" title="Everything in this map — stations, lines, icons, logo — in one file">${TM.icon('zip')} Share as .zip</button>` +
        (mine ? `<button class="btn sm" data-a="edit">${TM.icon('edit')} Edit details</button><button class="btn sm danger" data-a="delete">${TM.icon('trash')} Delete</button>`
          : `<button class="btn sm" data-a="copy" title="Start your own editable map from this one">${TM.icon('copy')} Make my copy</button>` + (typeof maps.devSaveMeta === 'function' ? `<button class="btn sm" data-a="edit" title="Local editing server only: writes maps/&lt;id&gt;/map.json">${TM.icon('edit')} Edit details</button>` : '')) +
        (canInstall && mine ? `<button class="btn sm" data-a="devsave" title="Local editing server only: writes maps/&lt;id&gt;/ into the project">${TM.icon('file')} Save to project files</button>` : '') + '</div></div>';
    };
    const setOpen = (v) => { open = v; root.classList.toggle('open', v); popup.hidden = !v; if (v) build(); };

    button.onclick = () => setOpen(!open);
    popup.onclick = (e) => {
      const item = e.target.closest('.map-item'), action = e.target.closest('[data-a]');
      if (item) { setOpen(false); maps.switchTo(item.dataset.id); return; }
      if (!action) return;
      const currentMap = maps.current;
      setOpen(false);
      ({
        new: () => ui.openMapDialog({}),
        copy: () => ui.openMapDialog({ from: currentMap.id }),
        import: () => pickZip(),
        export: () => ui.exportMap(currentMap.id),
        edit: () => ui.openMapDialog({ edit: currentMap.id }),
        delete: () => ui.deleteMap(currentMap.id),
        devsave: () => maps.devInstall(currentMap.id),
      })[action.dataset.a]();
    };
    document.addEventListener('pointerdown', (e) => { if (open && !root.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') setOpen(false); });
    ['lang', 'map'].forEach((ev) => TM.on(ev, () => { paint(); if (open) build(); }));
    paint();
    if (maps.missing) TM.toast(`There is no map called “${maps.missing}” — opened ${maps.name(maps.current)} instead`, 'err');
  };

  /* ---------- share / import / delete ---------- */
  ui.exportMap = async (id) => {
    try {
      const result = await maps.exportZip(id);
      TM.toast(`${id}.zip saved · ${result.stations} stations, ${result.lines} lines. Send it to others, or unzip it into maps/ to publish.`);
    } catch (e) { TM.toast('Could not export the map: ' + e.message, 'err'); }
  };
  ui.importMapZip = async (file) => {
    try {
      const meta = await maps.importZip(file);
      TM.toast(`Imported “${maps.name(meta)}” — opening it`);
      setTimeout(() => maps.switchTo(meta.id), 400);
    } catch (e) { TM.toast('Could not import: ' + e.message, 'err'); }
  };
  function pickZip() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.zip,application/zip';
    input.onchange = () => { if (input.files[0]) ui.importMapZip(input.files[0]); };
    input.click();
  }
  ui.deleteMap = (id) => {
    const meta = maps.find(id);
    if (!meta || !maps.isUser(meta)) return;
    ui.modal({
      title: 'Delete this map?',
      body: `<p style="margin-top:0"><b>${TM.esc(maps.name(meta))}</b> and everything in it will be removed from this browser. This cannot be undone — export it as a zip first if you might need it.</p>`,
      buttons: [{ label: 'Cancel', cls: 'ghost' }, { label: `${TM.icon('zip')} Export first`, keep: true, onClick: () => { ui.exportMap(id); return false; } }, { label: `${TM.icon('trash')} Delete map`, cls: 'danger', onClick: () => { maps.remove(id); } }],
    });
  };

  /* ---------- new map / edit details ---------- */
  ui.openMapDialog = (options) => {
    options = options || {};
    const edit = options.edit ? maps.find(options.edit) : null;
    const devEdit = !!edit && !maps.isUser(edit) && typeof maps.devSaveMeta === 'function';   // a published map, through the local editing server
    if (options.edit && !(edit && (maps.isUser(edit) || devEdit))) return;
    const startFrom = edit ? null : (options.from || maps.defaultId);
    const src0 = maps.find(startFrom);
    const base = edit || src0 || maps.normMeta({}, 'x', 'user');
    const state = { from: startFrom, logo: undefined, touched: false };   // logo: undefined = keep the map's own, null = none, else a new image
    const anchorOf = () => (edit ? edit.anchor : (maps.find(state.from) || {}).anchor) || null;
    const centreOf = (m) => (m && (m.center || (m.anchor && [m.anchor.lat, m.anchor.lng]))) || [TM.store.anchor.lat, TM.store.anchor.lng];
    const centre = centreOf(base), step0 = Math.round(((base.anchor && base.anchor.step) || TM.store.anchor.step || 0.0035) * 111320);
    const nameVal = (k) => (edit ? edit.names[k] : (options.from && k === 'en' ? (base.names.en || '') + ' (copy)' : '')) || '';
    /* the map's own extra label languages (on top of the four every map has) — a new map starts with those of the map
       it copies, until they are edited here */
    state.langs = ((edit || src0 || {}).languages || []).map((l) => Object.assign({}, l));
    state.names = {};
    const allLangs = () => TM.BASE_LANGS.concat(state.langs.filter((l) => l.key && TM.LANG_KEY.test(l.key)));

    const html = `
      <div class="grid2" id="mp-names"></div>
      <div class="field"><label>Subtitle</label><input class="input" name="subtitle" maxlength="60" value="${TM.esc(edit ? edit.subtitle : '')}" placeholder="shown under the name, e.g. Penang · my proposal"></div>
      <div class="grid2"><div class="field"><label>Country</label><input class="input" name="country" maxlength="60" value="${TM.esc(edit ? edit.country : (options.from && base.country) || '')}" placeholder="e.g. Malaysia"></div>
        <div class="field"><label>Area</label><input class="input" name="area" maxlength="80" value="${TM.esc(edit ? edit.area : (options.from && base.area) || '')}" placeholder="e.g. Klang Valley"></div></div>
      <div class="field"><label>Description</label><textarea class="input" name="description" rows="2" maxlength="300" placeholder="what this map is about">${TM.esc(edit ? edit.description : '')}</textarea></div>
      <div class="field"><label>More languages <span style="font-weight:500">(besides English, Bahasa Melayu, 正體中文 and தமிழ் — stations and lines get a name field for each, and the language bar becomes a menu)</span></label>
        <div id="mp-langs" class="lang-rows"></div><button type="button" class="btn sm" id="mp-addlang">${TM.icon('plus')} Add language</button></div>
      <div class="field"><label>Label language order <span style="font-weight:500">(comma-separated codes — <span id="mp-keys"></span>; leftmost is the bold primary name, the rest are fallback order. Leave blank for the default order.)</span></label>
        <input class="input" name="langorder" value="${TM.esc(edit && edit.langOrder ? edit.langOrder.join(', ') : '')}"></div>
      <div class="field"><label>Default “Inside symbol shows” <span style="font-weight:500">(what everyone sees first when they open this map, here and in the journey planner — they can still change it)</span></label>
        <div class="row wrap" style="gap:10px"><div class="seg" id="mp-num">${[['', 'App default'], ...TM.NUMBER_MODES.map((k) => [k, { none: 'None', code: 'Code', full: 'Full', ordinal: 'Order' }[k]])].map(([k, t]) => `<button type="button" data-num="${k}">${t}</button>`).join('')}</div>
        <label class="check"><input type="checkbox" name="numoverride" ${(edit || src0 || {}).numModeOverride ? 'checked' : ''}> Allow a station to override this</label></div></div>
      <label class="check" style="margin:2px 0 12px"><input type="checkbox" name="navigator" ${(edit ? edit.navigator : (src0 ? src0.navigator : true)) !== false ? 'checked' : ''}> Show in the journey planner</label>
      <div class="field"><label>Logo <span style="font-weight:500">(SVG or PNG, shown in the top bar)</span></label>
        <div class="row" style="gap:10px"><span id="mp-logo" class="logo-prev"></span><label class="btn sm" style="cursor:pointer">${TM.icon('image')} Choose image…<input type="file" id="mp-file" accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif" hidden></label><button type="button" class="btn sm ghost" id="mp-nologo">Remove</button></div></div>
      ${edit ? '' : `<div class="field"><label>Start from</label><div id="mp-from" class="pick-list"></div><p class="hint" style="margin:2px 0 0" id="mp-fromhint"></p></div>`}
      <details style="margin:4px 0 8px"><summary class="lbl" style="cursor:pointer">Location &amp; grid</summary>
        <div class="grid2" style="margin-top:8px"><div class="field"><label>Centre latitude</label><input class="input" name="lat" inputmode="decimal" value="${centre[0]}"></div><div class="field"><label>Centre longitude</label><input class="input" name="lng" inputmode="decimal" value="${centre[1]}"></div>
        <div class="field"><label>Real-map zoom</label><input class="input" name="zoom" inputmode="numeric" value="${base.zoom || 12}"></div><div class="field"><label>Metres per grid node</label><input class="input" name="step" inputmode="numeric" value="${step0}"></div></div>
        <p class="hint" style="margin:0">Where the real map opens, and how new stations are placed on the grid from their coordinates. Existing stations keep their own positions.</p></details>
      <p class="hint" id="mp-err" style="color:var(--danger);margin:0" hidden></p>`;

    const dialog = ui.modal({
      title: edit ? 'Map details' : 'New map', body: html,
      buttons: [{ label: 'Cancel', cls: 'ghost' }, { label: edit ? 'Save' : `${TM.icon('plus')} Create map`, cls: 'primary', keep: true, onClick: (api) => submit(api) }],
    });
    const root = dialog.body, query = (s) => root.querySelector(s), field = (n) => root.querySelector(`[name="${n}"]`);
    const showError = (t) => { const e = query('#mp-err'); e.textContent = t || ''; e.hidden = !t; };

    /* name fields: one per language, typed values kept when the language list changes */
    const keepNames = () => root.querySelectorAll('#mp-names [name^="n-"]').forEach((i) => { state.names[i.name.slice(2)] = i.value; });
    const drawNames = () => {
      keepNames();
      query('#mp-names').innerHTML = allLangs().map((l) => `<div class="field"><label>Name · ${TM.esc(l.label || l.key)}${l.key === 'en' ? ' *' : ''}</label><input class="input" name="n-${TM.esc(l.key)}" value="${TM.esc(state.names[l.key] != null ? state.names[l.key] : nameVal(l.key))}" placeholder="${l.key === 'en' ? 'e.g. Penang Fantasy Rail' : ''}" maxlength="60"></div>`).join('');
      const keys = allLangs().map((l) => l.key).join(', ');
      query('#mp-keys').textContent = keys; field('langorder').placeholder = keys;
    };
    const drawLangs = () => {
      query('#mp-langs').innerHTML = state.langs.map((l, i) => `<div class="row lang-row" data-i="${i}"><input class="input" data-k="key" value="${TM.esc(l.key)}" placeholder="code, e.g. ja" maxlength="20" aria-label="Language code"><input class="input" data-k="short" value="${TM.esc(l.short)}" placeholder="bar, e.g. 日" maxlength="4" aria-label="Short label for the language bar"><input class="input" data-k="label" value="${TM.esc(l.label)}" placeholder="name, e.g. 日本語" maxlength="40" aria-label="Language name"><button type="button" class="btn sm ghost icon-btn" data-rmlang="${i}" aria-label="Remove language">${TM.icon('x')}</button></div>`).join('');
      drawNames();
    };
    drawLangs();
    query('#mp-addlang').onclick = () => { state.langsTouched = true; state.langs.push({ key: '', short: '', label: '' }); drawLangs(); query('#mp-langs .lang-row:last-child input').focus(); };
    query('#mp-langs').onclick = (e) => { const button = e.target.closest('[data-rmlang]'); if (button) { state.langsTouched = true; keepNames(); state.langs.splice(+button.dataset.rmlang, 1); drawLangs(); } };
    query('#mp-langs').oninput = (e) => {
      const row = e.target.closest('.lang-row'); if (!row) return;
      state.langsTouched = true;
      const language = state.langs[+row.dataset.i], fieldName = e.target.dataset.k;
      language[fieldName] = e.target.value.trim();
      if (fieldName === 'key') { e.target.classList.toggle('bad', !!language.key && (!TM.LANG_KEY.test(language.key) || TM.BASE_LANGS.some((b) => b.key === language.key))); drawNames(); }
      else if (fieldName === 'label') drawNames();
    };

    /* default "Inside symbol shows": '' = none recorded (the app's own default) */
    state.numberMode = (edit || src0 || {}).numberMode || '';
    const paintNum = () => root.querySelectorAll('#mp-num [data-num]').forEach((b) => b.classList.toggle('on', b.dataset.num === state.numberMode));
    paintNum();
    query('#mp-num').onclick = (e) => { const b = e.target.closest('[data-num]'); if (b) { state.numberMode = b.dataset.num; paintNum(); } };

    const paintLogo = () => {
      const meta = edit || maps.find(state.from);
      const logoSrc = state.logo === undefined ? (meta ? maps.logoSrc(meta) : null) : state.logo;
      query('#mp-logo').innerHTML = logoSrc ? `<img alt="" src="${TM.esc(logoSrc)}">` : DEFAULT_LOGO;
    };
    paintLogo();
    query('#mp-file').onchange = async (e) => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      try { state.logo = await readLogo(file); showError(''); paintLogo(); } catch (x) { showError(x.message); }
    };
    query('#mp-nologo').onclick = () => { state.logo = null; paintLogo(); };

    if (!edit) {
      const items = [...maps.all().map((m) => ({ id: m.id, m })), { id: '', m: null }];
      const drawFrom = () => {
        query('#mp-from').innerHTML = items.map(({ id, m }) => `<label class="pick ${state.from === (id || null) ? 'on' : ''}"><input type="radio" name="from" value="${TM.esc(id)}" ${state.from === (id || null) ? 'checked' : ''}>${m ? logoHTML(m) : '<span class="logo-blank">∅</span>'}<span class="nm"><b>${m ? TM.esc(maps.name(m)) : 'Empty map'}</b><span>${m ? TM.esc(m.subtitle || (maps.isUser(m) ? 'my map' : 'published')) + (m.id === maps.current.id ? ' · as you see it now' : '') : 'no stations or lines yet'}</span></span></label>`).join('');
        query('#mp-fromhint').textContent = state.from ? 'Copies its stations, lines and icons. The original map is never changed.' : 'Starts blank — add lines and stations yourself. Set the location below.';
      };
      drawFrom();
      query('#mp-from').onchange = (e) => {
        state.from = e.target.value || null;
        const meta = maps.find(state.from);
        if (meta) { const newCentre = centreOf(meta); field('lat').value = newCentre[0]; field('lng').value = newCentre[1]; field('zoom').value = meta.zoom || 12; field('step').value = Math.round(((meta.anchor && meta.anchor.step) || 0.0035) * 111320); }
        drawFrom(); paintLogo();
        if (!state.langsTouched) { state.langs = ((meta && meta.languages) || []).map((l) => Object.assign({}, l)); drawLangs(); }
        if (meta && !field('n-en').value.trim()) field('n-en').placeholder = maps.name(meta) + ' (copy)';
      };
    }

    const submit = async (dialogApi) => {
      const invalid = state.langs.find((l) => (l.key || l.label || l.short) && (!TM.LANG_KEY.test(l.key || '') || TM.BASE_LANGS.some((b) => b.key === l.key)));
      if (invalid) { showError(`“${invalid.key || invalid.label}” needs a language code like ja, ko, th or pt-BR (lower case, not one of en, ms, zh-Hant, ta).`); return false; }
      const languages = TM.normLanguages(state.langs.filter((l) => l.key));
      if (languages.length < state.langs.filter((l) => l.key).length) { showError('Each extra language needs its own code.'); return false; }
      const names = {};
      keepNames();
      TM.BASE_LANGS.concat(languages).forEach((l) => { names[l.key] = (state.names[l.key] || '').trim(); });
      if (!names.en) { showError('Give the map an English name.'); field('n-en').focus(); return false; }
      const lat = parseFloat(field('lat').value), lng = parseFloat(field('lng').value), zoom = parseInt(field('zoom').value, 10), metres = parseFloat(field('step').value);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && isFinite(lat) && isFinite(lng))) { showError('The centre needs a latitude (−90…90) and longitude (−180…180).'); return false; }
      if (!(metres >= 20 && metres <= 20000)) { showError('Metres per grid node should be between 20 and 20000.'); return false; }
      const geoChanged = String(lat) !== String(centre[0]) || String(lng) !== String(centre[1]) || Math.round(metres) !== step0;
      const prev = anchorOf() || TM.store.anchor;
      const anchor = geoChanged || !anchorOf() ? Object.assign({}, { x: 28, y: 28 }, prev, { lat, lng, step: Math.round(metres) === step0 && prev.step ? prev.step : metres / 111320 }) : undefined;
      const langOrderRaw = field('langorder').value.trim();
      const langOrder = langOrderRaw ? langOrderRaw.split(',').map((s) => s.trim()).filter((k) => TM.BASE_LANGS.concat(languages).some((l) => l.key === k)) : null;
      const common = { names, subtitle: field('subtitle').value.trim(), description: field('description').value.trim(), country: field('country').value.trim(), area: field('area').value.trim(), center: [lat, lng], zoom: zoom >= 2 && zoom <= 19 ? zoom : 12, langOrder: langOrder && langOrder.length ? langOrder : null, languages, numberMode: state.numberMode || null, numModeOverride: field('numoverride').checked, navigator: field('navigator').checked };
      try {
        if (edit) {
          if (devEdit) await maps.devSaveMeta(edit.id, Object.assign(common, anchor ? { anchor } : {}));   // the logo file itself is left as it is
          else maps.update(edit.id, Object.assign(common, { logo: state.logo === undefined ? edit.logo : state.logo }, anchor ? { anchor } : {}));
          TM.toast('Map details saved');
          if (geoChanged) TM.toast('Reload the page to use the new grid position');
          dialogApi.close();
        } else {
          const button = dialogApi.foot.querySelector('.primary'); button.disabled = true;
          const meta = await maps.create(Object.assign(common, { from: state.from, logo: state.logo }, anchor ? { anchor } : {}));
          dialogApi.close();
          TM.toast(`Created “${maps.name(meta)}” — opening it`);
          setTimeout(() => maps.switchTo(meta.id), 350);
        }
      } catch (x) { showError(x.message); const button = dialogApi.foot.querySelector('.primary'); if (button) button.disabled = false; }
      return false;
    };
    setTimeout(() => field('n-en').focus(), 40);
  };
})(window.TM);
