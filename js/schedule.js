/* Service schedules: when the trains of a line (its own all-stops service each way) or of a service (services.json)
   run — by a fixed timetable, or from a first train to a last train at a frequency that changes through the day —
   and on which days: days of the week, public holidays (the map's calendar) and / or specific dates.

   Stored on the line / service as  schedules: { tz, plans: [plan…] }  — tz an IANA time zone ("Asia/Kuala_Lumpur");
   every time is local to it, "HH:MM" (a night train may say "24:30" for half past midnight the next day); dates are
   ISO "YYYY-MM-DD".
   plan: {
     name, dir: 'both' | 'fwd' | 'back'  (fwd = the line's own order / a service as listed; back = the other way),
     days: ['mon'…'sun', 'hol'],  dates: [ISO…] (only on these dates, before any weekday plan),  except: [ISO…],
     first: "05:40", last: "23:30"        — first and last train from the first stop of that direction,
     starts: [{ at: station id, time }]   — trains that also begin part-way (the suburbs served as early as the centre);
                                           the stops after it get them by the line's own times between stops,
     every: [{ from, to, min }]           — how often trains leave the first stop between two times,
     times: ["05:40", "06:25 @KA10", …]   — or a fixed timetable: departures from the first stop (or from a stop of
                                           the line, "@station"), used instead of first / last / every when present
   }
   The map's calendar (store.calendar): { tz, holidays: [{ date, name }] } — which dates count as public holidays. */
(function (TM) {
  const sched = (TM.sched = {});
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  sched.DAYS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun', hol: 'Public holiday' };
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  /* "HH:MM" → minutes after midnight (up to 47:59), or null */
  sched.toMin = (text) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
    if (!match || +match[2] > 59 || +match[1] > 47) return null;
    return +match[1] * 60 + +match[2];
  };
  sched.fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  sched.validTz = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (e) { return false; } };
  sched.userTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } };

  /* ---------- normalising (what is stored) ---------- */
  const time = (t) => (sched.toMin(t) == null ? null : sched.fmtMin(sched.toMin(t)));
  const dates = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/)).map(String).filter((d) => ISO.test(d)))].sort();
  sched.normPlan = (p) => {
    if (!p || typeof p !== 'object') return null;
    const out = { name: String(p.name || '').trim().slice(0, 40), dir: ['fwd', 'back'].includes(p.dir) ? p.dir : 'both' };
    out.days = (Array.isArray(p.days) ? p.days : []).filter((d) => sched.DAYS[d]);
    out.dates = dates(p.dates); out.except = dates(p.except);
    const times = (Array.isArray(p.times) ? p.times : String(p.times || '').split(/[\n,]+/)).map((t) => {
      const [hm, at] = String(t).trim().split(/\s*@\s*/);
      return time(hm) ? time(hm) + (at ? ' @' + at.trim() : '') : null;
    }).filter(Boolean);
    if (times.length) { out.times = times.sort((a, b) => sched.toMin(a.split(' ')[0]) - sched.toMin(b.split(' ')[0])); return out; }
    if (time(p.first)) out.first = time(p.first);
    if (time(p.last)) out.last = time(p.last);
    out.starts = (Array.isArray(p.starts) ? p.starts : []).filter((s) => s && s.at && time(s.time)).map((s) => ({ at: String(s.at), time: time(s.time) }));
    out.every = (Array.isArray(p.every) ? p.every : []).filter((b) => b && time(b.from) && time(b.to) && +b.min > 0 && sched.toMin(b.to) > sched.toMin(b.from))   // an empty band says nothing
      .map((b) => ({ from: time(b.from), to: time(b.to), min: Math.min(240, Math.round(+b.min * 10) / 10) }))
      .sort((a, b) => sched.toMin(a.from) - sched.toMin(b.from));
    return out.first && out.last && out.every.length ? out : null;   // a frequency needs at least one band
  };
  sched.norm = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const plans = (Array.isArray(raw.plans) ? raw.plans : []).map(sched.normPlan).filter(Boolean).slice(0, 40);
    if (!plans.length) return null;
    return { tz: sched.validTz(raw.tz) ? String(raw.tz) : 'UTC', plans };
  };
  sched.normCalendar = (raw) => {
    const out = { tz: raw && sched.validTz(raw.tz) ? String(raw.tz) : '', holidays: [] };
    const seen = new Set();
    (raw && Array.isArray(raw.holidays) ? raw.holidays : []).forEach((h) => {
      const date = typeof h === 'string' ? h : h && h.date;
      if (!ISO.test(String(date)) || seen.has(date)) return;
      seen.add(date); out.holidays.push({ date: String(date), name: String((h && h.name) || '').trim().slice(0, 60) });
    });
    out.holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
  };

  /* ---------- clock ---------- */
  /* an instant (ms) as a date, weekday and minute of the day in a time zone */
  const fmtCache = new Map();
  sched.local = (ms, tz) => {
    let fmt = fmtCache.get(tz);
    if (!fmt) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); fmtCache.set(tz, fmt); }
    const p = {};
    fmt.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    const date = `${p.year}-${p.month}-${p.day}`;
    return { date, dow: new Date(date + 'T00:00:00Z').getUTCDay(), min: +p.hour * 60 + +p.minute + +p.second / 60 };
  };
  const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const isHoliday = (date) => !!(TM.store && TM.store.calendar && TM.store.calendar.holidays.some((h) => h.date === date));

  /* the plan running on a date in a direction: one for that very date first, then (on a public holiday) one for
     holidays, then one for the weekday */
  sched.planFor = (s, date, dir) => {
    const plans = s.plans.filter((p) => (p.dir === 'both' || p.dir === dir) && !p.except.includes(date));
    const dow = DAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
    return plans.find((p) => p.dates.includes(date))
      || (isHoliday(date) ? plans.find((p) => p.days.includes('hol') && !p.dates.length) : null)
      || plans.find((p) => p.days.includes(dow) && !p.dates.length) || null;
  };

  /* minutes between trains at a minute of the day of the first stop (the band covering it, else the nearest one) */
  const headwayAt = (plan, originMin) => {
    if (!plan.every.length) return null;
    const band = plan.every.find((b) => originMin >= sched.toMin(b.from) && originMin < sched.toMin(b.to));
    if (band) return band.min;
    let best = plan.every[0], gap = Infinity;
    plan.every.forEach((b) => { const g = Math.min(Math.abs(originMin - sched.toMin(b.from)), Math.abs(originMin - sched.toMin(b.to))); if (g < gap) { gap = g; best = b; } });
    return best.min;
  };

  /* The next train from a stop: { wait (minutes), exact (a timetabled train or the first train of the day — not just
     an average), at (ms) } or null when none runs within two days. off: minutes from the first stop of this direction
     to each stop (station id → minutes); board: the stop boarded at. A frequency gives the average wait, half the
     time between trains. */
  sched.next = (s, dir, off, board, ms) => {
    const here = off.get(board);
    if (here == null) return null;
    const now = sched.local(ms, s.tz);
    let best = null;
    for (let dd = -1; dd <= 2; dd++) {
      const date = addDays(now.date, dd), plan = sched.planFor(s, date, dir);
      if (!plan) continue;
      const shift = dd * 1440, t = now.min - shift;   // minutes into that service day
      let cand = null;
      if (plan.times) {
        plan.times.forEach((entry) => {
          const [hm, at] = entry.split(' @'), start = at ? off.get(at) : 0;
          if (start == null || start > here) return;   // starts after this stop: never calls here
          const dep = sched.toMin(hm) + (here - start);
          if (dep >= t - 1e-9 && (!cand || dep - t < cand.wait)) cand = { wait: dep - t, exact: true };
        });
      } else {
        /* the first train here: from the first stop, or from any stop it also starts at before this one */
        let first = sched.toMin(plan.first) + here;
        plan.starts.forEach((st) => { const o = off.get(st.at); if (o != null && o <= here) first = Math.min(first, sched.toMin(st.time) + (here - o)); });
        const last = sched.toMin(plan.last) + here;
        if (t < first) cand = { wait: first - t, exact: true };
        else if (t <= last) { const h = headwayAt(plan, t - here); cand = { wait: h ? h / 2 : 0, exact: !h }; }
      }
      if (cand && (!best || cand.wait < best.wait)) best = cand;
      if (best && dd >= 0) break;   // a later day can only be later
    }
    return best ? Object.assign(best, { at: ms + best.wait * 60000 }) : null;
  };

  /* The average wait when no time is set: half the typical time between trains, over the plans of a direction —
     each counted by how often it runs (days a week; a holiday or a single date only a little). */
  sched.averageWait = (s, dir) => {
    let sum = 0, weight = 0;
    s.plans.filter((p) => p.dir === 'both' || p.dir === dir).forEach((p) => {
      let gap = null;
      if (p.times && p.times.length > 1) { const m = p.times.map((t) => sched.toMin(t.split(' ')[0])); gap = (m[m.length - 1] - m[0]) / (m.length - 1); }
      else if (p.every && p.every.length) {
        let total = 0, span = 0;
        p.every.forEach((b) => { const len = Math.max(0, sched.toMin(b.to) - sched.toMin(b.from)); total += b.min * len; span += len; });
        if (span) gap = total / span;
      }
      if (gap == null) return;
      const w = p.days.filter((d) => d !== 'hol').length + (p.days.includes('hol') ? 0.2 : 0) + p.dates.length / 52 || 0.1;
      sum += gap * w; weight += w;
    });
    return weight ? sum / weight / 2 : null;
  };
})(window.TM);
