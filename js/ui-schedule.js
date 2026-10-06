/* Timetable dialog box: when a line's own all-stops trains (line.schedules) or a service's trains (service.schedules) run
   — see js/schedule.js for the shape — and the map's calendar of public holidays (store.calendar). */
(function (TM) {
  const ui = (TM.ui = TM.ui || {});
  const store = TM.store, actions = TM.actions, sched = TM.sched;
  const $ = (root, sel) => root.querySelector(sel);
  const esc = (s) => TM.esc(s);

  /* one line of text for a list: "2 plans · Asia/Kuala_Lumpur", or none */
  ui.scheduleSummary = (s) => (s ? `${s.plans.length} plan${s.plans.length === 1 ? '' : 's'} · ${s.tz}` : 'no timetable (a usual wait is assumed)');

  const ZONES = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch (e) { return ['UTC', 'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'America/New_York']; } })();
  const blankPlan = () => ({ name: '', dir: 'both', days: ['mon', 'tue', 'wed', 'thu', 'fri'], dates: [], except: [], first: '06:00', last: '23:30', starts: [], every: [{ from: '06:00', to: '23:30', min: 10 }] });

  /* target: { line: id } (its own all-stops trains — a branch's line) or { service: id } */
  ui.openScheduleDialog = (target) => {
    const line = target.line ? store.rootLine(store.line(target.line)) || store.line(target.line) : null;
    const service = target.service ? store.services.find((x) => x.id === target.service) : null;
    if (!line && !service) return;
    /* the stops it calls at, first to last (for "also starts at"), and the two ways it runs */
    let stops = [];
    if (line) stops = line.path.filter((it) => it.s && store.stations.has(it.s)).map((it) => it.s);
    else { const rt = store.serviceRoute(service); stops = rt.ok ? rt.places.map((p) => p.ids[0]) : service.via.slice(); }
    stops = stops.filter((id, i) => stops.indexOf(id) === i);
    const name = (id) => { const st = store.stations.get(id); return st ? TM.nameOf(st, TM.state.langs[0]) : id; };
    const dirs = { both: 'Both ways', fwd: `Towards ${name(stops[stops.length - 1])}`, back: `Towards ${name(stops[0])}` };
    const loopish = line ? line.loop : service.loop;
    if (loopish) { dirs.fwd = 'In its own order'; dirs.back = 'The other way round'; }
    const current = line ? line.schedules : service.schedules;
    const work = { tz: (current && current.tz) || store.calendar.tz || sched.userTz(), plans: JSON.parse(JSON.stringify((current && current.plans) || [])) };
    if (!work.plans.length) work.plans.push(blankPlan());
    const calendar = JSON.parse(JSON.stringify(store.calendar)), ownsMap = actions.ownsMap();
    const title = line ? `Timetable · ${esc(line.code)} all-stops trains` : `Timetable · ${esc(service.name)}`;

    const stationSel = (value, attr) => `<select class="input" ${attr} style="height:30px;flex:1;min-width:0">${stops.map((id) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(name(id))} (${esc(id)})</option>`).join('')}</select>`;
    const timeIn = (value, attr, label) => `<input class="input" type="time" ${attr} value="${esc(value || '')}" style="height:30px;width:112px" aria-label="${label}">`;
    const planHtml = (p, i) => {
      const timetable = !!p.times;
      return `<div class="sec tt-plan" data-plan="${i}" style="border:1px solid var(--line);border-radius:12px;padding:10px;margin:0 0 10px">` +
        `<div class="row" style="gap:8px;margin-bottom:8px"><input class="input" data-f="name" value="${esc(p.name)}" placeholder="Plan name, e.g. Weekdays" style="flex:1;height:30px">` +
        `<select class="input" data-f="dir" style="height:30px;width:auto">${Object.entries(dirs).map(([k, t]) => `<option value="${k}" ${p.dir === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` +
        `<button type="button" class="btn sm ghost icon-btn" data-rmplan="${i}" title="Remove this plan" style="width:28px;padding:0">${TM.icon('trash')}</button></div>` +
        `<div class="row wrap" style="gap:4px 12px;margin-bottom:8px">${Object.entries(sched.DAYS).map(([k, t]) => `<label class="check"><input type="checkbox" data-day="${k}" ${p.days.includes(k) ? 'checked' : ''}> ${t}</label>`).join('')}</div>` +
        `<div class="grid2" style="margin-bottom:8px"><div class="field" style="margin:0"><label>Only on these dates <span class="hint">(YYYY-MM-DD, comma-separated — wins over the days above)</span></label><input class="input" data-f="dates" value="${esc(p.dates.join(', '))}" placeholder="2026-12-24" style="height:30px"></div>` +
        `<div class="field" style="margin:0"><label>Not on these dates</label><input class="input" data-f="except" value="${esc(p.except.join(', '))}" placeholder="2026-12-25" style="height:30px"></div></div>` +
        `<div class="seg" style="margin-bottom:8px"><button type="button" data-kind="${i}:freq" class="${timetable ? '' : 'on'}">First / last train &amp; frequency</button><button type="button" data-kind="${i}:times" class="${timetable ? 'on' : ''}">Fixed timetable</button></div>` +
        (timetable
          ? `<div class="field" style="margin:0"><label>Departures from the first stop <span class="hint">— one time per line ("HH:MM"); "HH:MM @${esc(stops[1] || 'CODE')}" for a train starting part-way. Later stops follow by the line's own times between stops.</span></label><textarea class="input" data-f="times" rows="6" style="height:auto;font-family:ui-monospace,monospace">${esc(p.times.join('\n'))}</textarea></div>`
          : `<div class="row wrap" style="gap:12px;margin-bottom:8px"><label class="row" style="gap:6px"><span class="hint">First train</span>${timeIn(p.first, 'data-f="first"', 'First train')}</label><label class="row" style="gap:6px"><span class="hint">Last train</span>${timeIn(p.last, 'data-f="last"', 'Last train')}</label><span class="hint">from the first stop of that way</span></div>` +
            `<div class="lbl" style="margin:4px 0 6px">Trains also start at <span style="font-weight:500">(so a stop part-way gets its first train earlier)</span></div>` +
            p.starts.map((st, j) => `<div class="row tt-start" style="gap:6px;margin-bottom:4px">${stationSel(st.at, 'data-sf="at"')}${timeIn(st.time, 'data-sf="time"', 'First train from there')}<button type="button" class="btn sm ghost icon-btn" data-rmstart="${i}:${j}" style="width:26px;padding:0">${TM.icon('x')}</button></div>`).join('') +
            `<button type="button" class="btn sm ghost" data-addstart="${i}">${TM.icon('plus')} Start point</button>` +
            `<div class="lbl" style="margin:10px 0 6px">How often <span style="font-weight:500">(by the time trains leave the first stop)</span></div>` +
            p.every.map((b, j) => `<div class="row tt-band" style="gap:6px;margin-bottom:4px">${timeIn(b.from, 'data-bf="from"', 'From')}<span class="hint">to</span>${timeIn(b.to, 'data-bf="to"', 'To')}<span class="hint">every</span><input class="input" type="number" min="1" max="240" step="0.5" data-bf="min" value="${b.min}" style="height:30px;width:70px" aria-label="Minutes between trains"><span class="hint">min</span><button type="button" class="btn sm ghost icon-btn" data-rmband="${i}:${j}" style="width:26px;padding:0">${TM.icon('x')}</button></div>`).join('') +
            `<button type="button" class="btn sm ghost" data-addband="${i}">${TM.icon('plus')} Time band</button>`) +
        '</div>';
    };
    const calendarHtml = () => `<div class="sec" style="margin-top:6px"><div class="sec-h"><h3>Map calendar</h3></div>` +
      `<p class="hint" style="margin-top:0">Shared by every timetable of this map${ownsMap ? '' : ' — only the map\'s own author can change it'}.</p>` +
      `<div class="field"><label>Default time zone for new timetables</label><input class="input" id="ttCalTz" list="ttZones" value="${esc(calendar.tz)}" placeholder="${esc(sched.userTz())}" ${ownsMap ? '' : 'disabled'}></div>` +
      `<div class="field" style="margin:0"><label>Public holidays <span class="hint">— one per line: "YYYY-MM-DD Name"</span></label><textarea class="input" id="ttHols" rows="5" style="height:auto;font-family:ui-monospace,monospace" ${ownsMap ? '' : 'disabled'}>${esc(calendar.holidays.map((h) => (h.date + ' ' + h.name).trim()).join('\n'))}</textarea></div></div>`;

    const dialog = ui.modal({
      title, wide: true,
      body: `<datalist id="ttZones">${ZONES.map((z) => `<option value="${esc(z)}">`).join('')}</datalist>` +
        `<div class="field"><label>Time zone of these times</label><input class="input" id="ttTz" list="ttZones" value="${esc(work.tz)}"></div>` +
        `<p class="hint" style="margin-top:0">Each plan says when trains run, on which days. A plan for a specific date wins, then one for public holidays (on a holiday), then one for the weekday. The journey planner shows the wait for the next train from these.</p>` +
        `<div id="ttPlans"></div><button type="button" class="btn sm" id="ttAddPlan">${TM.icon('plus')} Add plan</button>` + calendarHtml() +
        `<p class="hint" id="ttErr" style="color:var(--danger)"></p>`,
      buttons: [
        ...(current ? [{ label: 'Remove timetable', cls: 'danger', onClick: () => { if (!confirm('Remove this timetable?')) return false; save(null); } }] : []),
        { label: 'Cancel', cls: 'ghost' },
        { label: 'Save', cls: 'primary', onClick: () => {
          collect();
          const s = sched.norm({ tz: work.tz, plans: work.plans });
          const dropped = work.plans.length - (s ? s.plans.length : 0);
          if (!sched.validTz(work.tz)) { $(dialog.body, '#ttErr').textContent = `"${work.tz}" is not a time zone (e.g. Asia/Kuala_Lumpur).`; return false; }
          if (dropped && !confirm(`${dropped} plan${dropped === 1 ? ' is' : 's are'} incomplete (a frequency plan needs a first and last train and at least one time band; a timetable at least one time) and will be left out. Save anyway?`)) return false;
          save(s);
        } },
      ],
    });
    const plansBox = $(dialog.body, '#ttPlans');
    const draw = () => { plansBox.innerHTML = work.plans.map(planHtml).join(''); };
    /* read every field back into work (before redrawing, and on save) */
    function collect() {
      work.tz = $(dialog.body, '#ttTz').value.trim();
      plansBox.querySelectorAll('.tt-plan').forEach((box) => {
        const p = work.plans[+box.dataset.plan];
        const f = (k) => { const el = box.querySelector(`[data-f="${k}"]`); return el ? el.value : undefined; };
        p.name = f('name') || ''; p.dir = f('dir') || 'both';
        p.days = [...box.querySelectorAll('[data-day]')].filter((c) => c.checked).map((c) => c.dataset.day);
        p.dates = (f('dates') || '').split(/[\s,;]+/).filter(Boolean); p.except = (f('except') || '').split(/[\s,;]+/).filter(Boolean);
        if (p.times) p.times = (f('times') || '').split('\n').map((t) => t.trim()).filter(Boolean);
        else {
          p.first = f('first') || ''; p.last = f('last') || '';
          p.starts = [...box.querySelectorAll('.tt-start')].map((r) => ({ at: r.querySelector('[data-sf="at"]').value, time: r.querySelector('[data-sf="time"]').value }));
          p.every = [...box.querySelectorAll('.tt-band')].map((r) => ({ from: r.querySelector('[data-bf="from"]').value, to: r.querySelector('[data-bf="to"]').value, min: +r.querySelector('[data-bf="min"]').value }));
        }
      });
    }
    function save(s) {
      if (ownsMap) {
        const holidays = $(dialog.body, '#ttHols').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [date, ...rest] = l.split(/\s+/); return { date, name: rest.join(' ') }; });
        const next = sched.normCalendar({ tz: $(dialog.body, '#ttCalTz').value.trim(), holidays });
        if (JSON.stringify(next) !== JSON.stringify(store.calendar)) store.setCalendar(next);
      }
      if (line) { if (s) line.schedules = s; else line.schedules = null; store.save(); }
      else actions.saveService(Object.assign({}, service, { schedules: s || undefined }), service.id);
      TM.toast(s ? 'Timetable saved' : 'Timetable removed');
    }
    draw();
    dialog.body.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const [i, j] = (b.dataset.rmstart || b.dataset.rmband || b.dataset.kind || '').split(':');
      if (b.id === 'ttAddPlan') { collect(); work.plans.push(blankPlan()); draw(); }
      else if (b.dataset.rmplan != null) { collect(); work.plans.splice(+b.dataset.rmplan, 1); draw(); }
      else if (b.dataset.kind) {
        collect();
        const p = work.plans[+i];
        if (j === 'times' && !p.times) p.times = [];
        if (j === 'freq' && p.times) { delete p.times; Object.assign(p, { first: p.first || '06:00', last: p.last || '23:30', starts: p.starts || [], every: p.every && p.every.length ? p.every : [{ from: '06:00', to: '23:30', min: 10 }] }); }
        draw();
      } else if (b.dataset.addstart != null) { collect(); work.plans[+b.dataset.addstart].starts.push({ at: stops[Math.floor(stops.length / 2)] || stops[0], time: work.plans[+b.dataset.addstart].first || '06:00' }); draw(); }
      else if (b.dataset.rmstart) { collect(); work.plans[+i].starts.splice(+j, 1); draw(); }
      else if (b.dataset.addband != null) { collect(); const ev = work.plans[+b.dataset.addband].every, prev = ev[ev.length - 1]; ev.push({ from: prev ? prev.to : '06:00', to: '23:30', min: 10 }); draw(); }
      else if (b.dataset.rmband) { collect(); work.plans[+i].every.splice(+j, 1); draw(); }
    });
  };
})(window.TM);
