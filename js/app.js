/* Bootstrap: load data, then start the canvas and UI. */
(function (TM) {
  async function start() {
    try {
      await TM.maps.init();
      await TM.store.load();
    } catch (e) {
      const other = TM.maps.current && TM.maps.defaultId !== TM.maps.current.id;
      document.getElementById('stage').innerHTML = `<div class="empty" style="padding:60px 24px"><h2>Could not load the map</h2><p>${TM.esc(e.message)}</p><p>This is a static front-end project: serve the folder over HTTP, e.g. <code>python3 -m http.server 8000</code>, then open <code>http://localhost:8000</code>.</p>${other ? '<p><a href="./" id="openDefault">Open the default map instead</a></p>' : ''}</div>`;
      const link = document.getElementById('openDefault');
      if (link) link.onclick = () => TM.maps.forgetLast();
      return;
    }
    await TM.loadImages();
    TM.ui.init();
    TM.ui.mapPicker(document.getElementById('mapPicker'));
    TM.canvas.init();
    TM.on('display', TM.canvas.applyView);
    const shownCount = [...TM.store.visible].filter((id) => TM.store.lineFilter.has(id)).length;
    TM.toast(`${TM.maps.name(TM.maps.current)}: ${TM.store.stations.size} stations · ${TM.store.lines.size} lines (${shownCount} shown)`);
  }
  window.addEventListener('DOMContentLoaded', start);
})(window.TM);
