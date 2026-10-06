/* Top-bar chrome shared by the map editor (index.html) and the journey planner (navigator.html): the theme toggle, the
   left / right panel buttons (drawers on narrow screens, collapsible columns on wide ones) and --tbh, the bar's height. */
(function (TM) {
  const topbar = (TM.topbar = {});
  const $ = (id) => document.getElementById(id);

  /* The bar can wrap onto more rows on a narrow window: keep --tbh (its height, which the page grid and the slide-in
     panels are laid out by) equal to its real height. */
  document.addEventListener('DOMContentLoaded', () => {
    const bar = $('topbar'), app = $('app');
    if (!bar || !app || !window.ResizeObserver) return;
    const sync = () => app.style.setProperty('--tbh', Math.ceil(bar.getBoundingClientRect().height) + 'px');
    new ResizeObserver(sync).observe(bar); window.addEventListener('resize', sync); sync();
  });

  /* realMap(): the page's Leaflet map, if it has one open — it is told to re-measure after a side panel opens or closes */
  topbar.init = (realMap) => {
    $('btnLeft').innerHTML = TM.icon('menu'); $('btnRight').innerHTML = TM.icon('panel');
    const paintTheme = () => { $('btnTheme').innerHTML = TM.icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'); };
    paintTheme();
    $('btnTheme').onclick = () => {
      const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = theme;
      TM.storage.setQuiet('tm.theme', theme);   // read as plain text by the page's <head> script, before any CSS
      paintTheme(); TM.emit('theme');
    };
    const narrow = () => window.matchMedia('(max-width: 900px)').matches;
    const panelButton = (button, panelId, hideClass) => () => {
      if (narrow()) { $(panelId).classList.toggle('open'); return; }
      button.classList.toggle('off', $('app').classList.toggle(hideClass));
      const map = realMap && realMap();
      if (map) setTimeout(() => map.invalidateSize(), 220);
    };
    $('btnLeft').onclick = panelButton($('btnLeft'), 'left', 'hide-left');
    $('btnRight').onclick = panelButton($('btnRight'), 'right', 'hide-right');
    $('stage').addEventListener('pointerdown', () => { $('left').classList.remove('open'); $('right').classList.remove('open'); });
  };
})(window.TM);
