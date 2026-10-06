/* Label icons: maps/<id>/images/index.json lists the files; each is inlined as a data-URI so SVG/PNG export works.
   A map made in the browser keeps its icons in localStorage instead (see maps.js). */
(function (TM) {
  TM.images = new Map();      // file -> data URI
  TM.imageList = [];          // [{file, name}] — offered in the main icon picker
  TM.specialList = [];        // [{file, name}] — images/special/, offered separately (see images/special/index.json below)

  TM.toDataURI = async (url, file) => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(url + ' → ' + response.status);
    if (/\.svg$/i.test(file)) return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(await response.text());
    const blob = await response.blob();
    return new Promise((res, rej) => { const reader = new FileReader(); reader.onload = () => res(reader.result); reader.onerror = rej; reader.readAsDataURL(blob); });
  };

  /* Special icons: any image under the map's images/ folder (typically images/special/) can be named in a label's icons without being
     listed in index.json — it is then not offered in the Inspector's icon list. A bare file name means images/special/<name>. */
  const SAFE = /^(?!.*\.\.)[\w\-. /]+\.(svg|png|jpe?g|gif|webp)$/i;
  TM.safeImagePath = (f) => SAFE.test(String(f || ''));
  TM.iconPath = (raw) => {
    let file = String(raw || '').trim().replace(/^\/+/, '').replace(/^(maps\/[^/]+\/)?(data\/)?images\//, '');
    if (file && !file.includes('/')) file = 'special/' + file;
    return SAFE.test(file) ? file : null;
  };
  const pending = new Map();
  TM.loadImage = (file) => {
    if (TM.images.has(file)) return Promise.resolve(true);
    if (!SAFE.test(file) || TM.maps.isUser(TM.maps.current)) return Promise.resolve(false);
    if (!pending.has(file)) pending.set(file, TM.toDataURI(TM.maps.dir() + 'images/' + file, file).then((u) => { TM.images.set(file, u); return true; }).catch(() => false).finally(() => pending.delete(file)));
    return pending.get(file);
  };
  /* A line's own picture (line.image): a file of the map's images/ folder, or a picture uploaded into the line itself
     (a data: URI). Returns its data URI, or null while it loads / when there is none. */
  TM.lineImage = (line) => {
    const image = line && line.image;
    if (!image) return null;
    if (/^data:image\//.test(image)) return image;
    if (TM.images.has(image)) return TM.images.get(image);
    TM.loadImage(image).then((ok) => { if (ok) TM.emit('display'); });
    return null;
  };
  /* width / height of a picture (data URI), once the browser has measured it — null until then (a redraw follows) */
  const aspects = new Map();
  TM.imageAspect = (uri) => {
    if (!uri) return null;
    if (aspects.has(uri)) return aspects.get(uri);
    aspects.set(uri, null);
    if (typeof Image !== 'undefined') { const img = new Image(); img.onload = () => { if (img.naturalWidth && img.naturalHeight) { aspects.set(uri, img.naturalWidth / img.naturalHeight); TM.emit('display'); } }; img.src = uri; }
    return null;
  };
  TM.isSpecialIcon = (file) => !TM.imageList.some((im) => im.file === file);

  /* Reads one index.json (main or special/): { file, name }[] resolved against base, skipping any that fail to load. */
  const readIndex = async (base, indexUrl, prefix) => {
    const images = new Map(), list = [];
    try {
      const index = await TM.getJSON(indexUrl);
      await Promise.all((index.files || []).map(async (entry) => {
        const raw = typeof entry === 'string' ? { file: entry, name: entry.replace(/\.[^.]+$/, '') } : entry;
        const e = { file: prefix + raw.file, name: raw.name || raw.file.replace(/\.[^.]+$/, '') };
        try { images.set(e.file, await TM.toDataURI(base + raw.file, e.file)); list.push(e); } catch (err) { /* skip missing file */ }
      }));
      list.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) { /* this index is optional */ }
    return { images, list };
  };

  /* The icon library of a published map folder (base = 'maps/<id>/images/'): { images: Map(file -> data URI), list,
     specialList }. list is images/index.json (the main picker); specialList is the optional images/special/index.json
     — a second, separately offered set, for icons the main list would rather not clutter (flags, logos, one-offs).
     Icons named by the given lines but missing from either index (typed in by hand) are included in images too. */
  TM.readImageLib = async (base, lines) => {
    const main = await readIndex(base, base + 'index.json', '');
    const special = await readIndex(base + 'special/', base + 'special/index.json', 'special/');
    const images = new Map([...main.images, ...special.images]);
    const wanted = new Set();
    (lines || []).forEach((l) => (l.path || []).forEach((it) => ((it && it.label && it.label.icons) || []).forEach((f) => wanted.add(f))));
    await Promise.all([...wanted].filter((f) => !images.has(f) && SAFE.test(f)).map(async (f) => { try { images.set(f, await TM.toDataURI(base + f, f)); } catch (e) { /* missing */ } }));
    return { images, list: main.list, specialList: special.list };
  };

  TM.loadImages = async () => {
    const maps = TM.maps, meta = maps.current;
    TM.images.clear(); TM.imageList.length = 0; TM.specialList.length = 0;
    if (maps.isUser(meta)) {
      const images = maps.readImages(meta);
      Object.entries(images.files).forEach(([f, u]) => TM.images.set(f, u));
      images.list.forEach((e) => TM.imageList.push(e));
    } else {
      const imageLib = await TM.readImageLib(maps.dir(meta) + 'images/', [...TM.store.lines.values()]);
      imageLib.images.forEach((u, f) => TM.images.set(f, u));
      imageLib.list.forEach((e) => TM.imageList.push(e));
      imageLib.specialList.forEach((e) => TM.specialList.push(e));
    }
    TM.imageList.sort((a, b) => a.name.localeCompare(b.name));
    TM.specialList.sort((a, b) => a.name.localeCompare(b.name));
  };
})(window.TM);
