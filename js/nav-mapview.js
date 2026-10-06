/* Journey planner's real map (Leaflet + OpenStreetMap): read-only — every station and line is drawn exactly as it
   is, with no drag handles, and clicking a station only picks it as the departure / destination station. Kept separate from js/mapview.js
   (index.html's editor) rather than reused, so nothing here can call into a bend / move / restyle tool by accident. */
(function (TM) {
  const planRealMap = (TM.navMap = { map: null, layer: null, fitted: false });
  const LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
  let loading = null;
  planRealMap.ensure = () => {
    if (window.L) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = LEAFLET + 'leaflet.css'; document.head.appendChild(stylesheet);
      const script = document.createElement('script'); script.src = LEAFLET + 'leaflet.js';
      script.onload = () => { TM.patchLeaflet(); resolve(); }; script.onerror = () => { loading = null; reject(new Error('Leaflet failed to load')); };
      document.head.appendChild(script);
    });
    return loading;
  };

  const theme = () => document.documentElement.dataset.theme || 'light';
  const nameOf = (station) => {
    const out = [];
    TM.state.langs.forEach((lg) => { const name = (station.names[lg] || '').trim(); if (name && !out.includes(name)) out.push(name); });
    return out.length ? out.join(' · ') : TM.nameOf(station, 'en');
  };

  planRealMap.render = () => {
    if (!planRealMap.map) return;
    const store = TM.store, palette = TM.symbols.palette(theme()), flags = TM.navUI.flags();
    planRealMap.layer.clearLayers();
    const bounds = [];
    /* same dimming as the schematic (TM.navUI.routeDimOpts): with a route open, only the stretch of each line it
       rides and the stations it calls at or passes stay lit */
    const dimOpts = planRealMap.route ? TM.navUI.routeDimOpts() : {};
    const segs = dimOpts.activeSegs, litLines = dimOpts.activeExtra;
    store.trackLines().forEach((line) => {   // lines and their branches
      const stops = [];
      line.path.forEach((it, i) => { const station = it.s && store.stations.get(it.s); if (station && TM.route.allowed(station, flags)) stops.push({ st: station, i }); });
      const on = segs && segs.get(line.id);
      for (let k = 0; k < stops.length - 1; k++) {
        const stopA = stops[k], stopB = stops[k + 1], bends = store.routeBends(line, stopA.st.id, stopB.st.id);
        let ridden = !segs;
        if (on) { ridden = true; for (let j = stopA.i; j < stopB.i; j++) if (!on.has(j)) { ridden = false; break; } }
        L.polyline([[stopA.st.lat, stopA.st.lng], ...bends, [stopB.st.lat, stopB.st.lng]], { color: line.color, weight: ridden && segs ? 7 : 5, opacity: ridden ? 0.9 : 0.2, lineCap: 'round', lineJoin: 'round' })
          .addTo(planRealMap.layer).on('click', () => {});
      }
    });
    /* step markers (TM.navUI.routeSteps), at the end of the station's label — which, on the real map, is always to
       its right — so the same number reads the same way on either view */
    const steps = new Map();
    TM.navUI.routeSteps(planRealMap.route).forEach((st) => { const leadId = store.rep(st.id); (steps.get(leadId) || steps.set(leadId, []).get(leadId)).push(st); });
    const mark = ({ n, first, last }) => `<span class="step-mark" style="background:${last ? palette.fantasy : palette.ink};color:${last ? '#fff' : palette.paper};border-color:${palette.paper}">${first ? '▶' : n}</span>`;
    const drawn = new Set();
    store.trackLines().forEach((line) => line.path.forEach((item) => {
      if (!item.s || !store.stations.has(item.s)) return;
      const leadId = store.rep(item.s), station = store.stations.get(leadId);
      if (drawn.has(leadId) || !TM.route.allowed(station, flags)) return;
      drawn.add(leadId);
      bounds.push([station.lat, station.lng]);
      const faded = litLines && !litLines.has(leadId);
      const marker = L.circleMarker([station.lat, station.lng], { radius: 6, color: palette.ink, weight: 3, fillColor: palette.paper, fillOpacity: 1, opacity: faded ? 0.3 : 1 }).addTo(planRealMap.layer);
      if (faded) marker.setStyle({ fillOpacity: 0.3 });
      marker.bindTooltip(`<b>${TM.esc(nameOf(station))}</b> <span style="opacity:.6">${TM.esc(store.members(leadId).join(' · '))}</span>${(steps.get(leadId) || []).map(mark).join('')}`, { permanent: true, direction: 'right', offset: [8, 0], className: 'map-label', opacity: faded ? 0.35 : 0.9 });
      marker.on('click', () => { if (planRealMap.picking) planRealMap.picking(leadId); else TM.navUI.showStation(leadId); });
      marker.on('contextmenu', (e) => { L.DomEvent.preventDefault(e.originalEvent); TM.navUI.stationMenu(leadId, e.originalEvent.clientX, e.originalEvent.clientY); });
    }));

    /* the stretch ridden is already lit by the dimming above — only a walk needs drawing, as the real map shows no
       connecting links of its own */
    if (planRealMap.route) planRealMap.route.legs.forEach((leg) => {
      if (leg.kind !== 'walk') return;
      const stationA = store.stations.get(leg.from), stationB = store.stations.get(leg.to);
      if (stationA && stationB) L.polyline([[stationA.lat, stationA.lng], [stationB.lat, stationB.lng]], { color: palette.walk, weight: 5, dashArray: '2 8', opacity: 0.9 }).addTo(planRealMap.layer);
    });

    if (!planRealMap.fitted && bounds.length) { planRealMap.map.fitBounds(bounds, { padding: [40, 40] }); planRealMap.fitted = true; }
  };
  planRealMap.showRoute = (result) => { planRealMap.route = result || null; planRealMap.render(); };

  planRealMap.show = async () => {
    try { await planRealMap.ensure(); } catch (e) { TM.toast('Could not load the map library (offline?)', 'err'); return; }
    const host = document.getElementById('mapview');
    if (!planRealMap.map) {
      const currentMap = TM.maps.current, anchor = TM.store.anchor;
      planRealMap.map = L.map(host, { zoomControl: false }).setView(currentMap.center || [anchor.lat, anchor.lng], currentMap.zoom || 12);
      L.control.zoom({ position: 'bottomright' }).addTo(planRealMap.map);
      planRealMap.layer = L.layerGroup().addTo(planRealMap.map);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 }).addTo(planRealMap.map);
      const FitControl = L.Control.extend({ onAdd() {
        const button = L.DomUtil.create('button', 'btn icon-btn'); button.innerHTML = TM.icon('fit'); button.title = 'Fit lines';
        button.onclick = (ev) => { ev.stopPropagation(); planRealMap.fitted = false; planRealMap.render(); };
        return button;
      } });
      new FitControl({ position: 'bottomright' }).addTo(planRealMap.map);
    }
    setTimeout(() => { planRealMap.map.invalidateSize(); planRealMap.render(); }, 30);
  };

  TM.on('theme', () => planRealMap.render());
  TM.on('nav-display', () => planRealMap.render());
})(window.TM);
