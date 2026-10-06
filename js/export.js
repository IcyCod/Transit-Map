/* Export: transit-map PNG / SVG (nodes hidden) and line / station JSON files. */
(function (TM) {
  const exporter = (TM.exportUI = {});
  const slug = (s) => String(s || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
  const today = () => TM.today();

  /* ---------- JSON ---------- */
  exporter.lineJSON = (id) => {
    const line = TM.store.lines.get(id);
    if (!line) return;
    const data = TM.store.lineOut(line);
    delete data.imported;
    const text = TM.maps.fmtLine(data);
    TM.download(`line-${slug(line.code)}-${slug(line.author)}.json`, text);
    const mine = line.path.filter((it) => it.s && TM.store.stations.get(it.s) && TM.store.stations.get(it.s).local && !TM.store.stations.get(it.s).imported);
    TM.toast(mine.length ? `Line saved. It uses ${mine.length} new station(s) — export the stations JSON too.` : 'Line JSON saved');
  };

  exporter.stationsJSON = () => {
    const list = TM.store.exportStations();
    if (!list.length) { TM.toast('You have not created or moved any stations yet', 'err'); return; }
    TM.download(`stations-${slug(TM.store.author)}-${today()}.json`, '[\n' + list.map((s) => '  ' + JSON.stringify(s)).join(',\n') + '\n]\n');
    TM.toast(`${list.length} station(s) saved (new + moved)`);
  };

  /* ---------- SVG / PNG ---------- */
  exporter.buildSVG = (options) => {
    /* the map exactly as the canvas shows it (languages, numbers, Display toggles, sizes), minus editing handles */
    const symbols = TM.symbols, model = TM.render.build(TM.render.currentOpts({ theme: options.theme, interactive: false, activeLineId: null, hotspots: !!options.hotspots, badges: true }));
    const palette = symbols.palette(options.theme), pad = 70, titleH = options.title ? 76 : 0;
    const legend = options.legend ? symbols.legend(palette, model.lines, TM.state.langs[0], TM.store.legend) : null;
    const left = model.bbox.x - pad, top = model.bbox.y - pad - titleH;
    const mapW = model.bbox.w + pad * 2, height = Math.max(model.bbox.h + pad * 2 + titleH, legend ? legend.h + 40 + titleH : 0);
    const width = mapW + (legend ? legend.w + 30 : 0);
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}" width="${Math.round(width)}" height="${Math.round(height)}" font-family='${symbols.FONT}'>`;
    if (options.embedFonts && embeddedFontCSS) svg += `<style>${embeddedFontCSS}</style>`;
    if (!options.transparent) svg += `<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="${palette.bg}"/>`;
    if (options.title) svg += `<text x="${left + 34}" y="${top + 52}" font-size="30" font-weight="800" fill="${palette.ink}" letter-spacing="-.01em">${TM.esc(options.title)}</text>`;
    svg += model.svg.replace(/ data-(sid|lbl|line|badge|ann|beyond)="[^"]*"/g, '');
    if (legend) {
      const legendX = left + mapW, legendY = top + titleH + 20;
      svg += `<g transform="translate(${legendX} ${legendY})"><rect width="${legend.w}" height="${legend.h}" rx="14" fill="${palette.paper}" stroke="${palette.muted}" stroke-opacity=".35"/>${legend.svg}</g>`;
    }
    return { svg: svg + '</svg>', w: width, h: height };
  };

  /* An SVG drawn through an <img> (the PNG path) or opened as a standalone file cannot see the page's Google-Fonts Inter,
     so it fell back to a system font whose bold barely differs from normal. PNG / SVG export therefore embeds Inter's
     own static weights (Latin subset, ~24 KB each) as data URIs — bold labels come out as bold as on the canvas. */
  const EMBED_WEIGHTS = [400, 500, 600, 700, 800];
  let embeddedFontCSS = '', embedLoading = null;
  exporter.ensureEmbeddedFonts = () => embedLoading || (embedLoading = Promise.all(EMBED_WEIGHTS.map((weight) =>
    fetchFontBuffer(`https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-${weight}-normal.woff2`).then((buffer) =>
      `@font-face{font-family:"Inter";font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${toBase64(buffer)}) format("woff2")}`)))
    .then((css) => { embeddedFontCSS = css.join(''); })
    .catch(() => { embedLoading = null; }));   // offline: export still works, just with the system font

  exporter.saveSVG = async (o) => { await exporter.ensureEmbeddedFonts(); exporter.writeSVG(Object.assign({}, o, { embedFonts: true })); };
  exporter.writeSVG = (o) => TM.download(`${TM.maps.current.id}-${today()}.svg`, exporter.buildSVG(o).svg, 'image/svg+xml');

  exporter.savePNG = async (o) => { await exporter.ensureEmbeddedFonts(); return exporter.renderPNG(Object.assign({}, o, { embedFonts: true })); };
  exporter.renderPNG = (options) => new Promise((resolve, reject) => {
    const { svg, w: width, h: height } = exporter.buildSVG(options);
    const scale = Math.min(options.scale, 12000 / Math.max(width, height));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => { if (!b) return reject(new Error('empty')); TM.download(`${TM.maps.current.id}-${today()}.png`, b, 'image/png'); resolve(); }, 'image/png');
    };
    image.onerror = () => reject(new Error('render failed'));
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });

  /* ---------- PDF (single page, the whole map at its own size) ---------- */
  const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
  const SVG2PDF_URL = 'https://cdn.jsdelivr.net/npm/svg2pdf.js@2.8.1/dist/svg2pdf.umd.min.js';
  let pdfLoading = null, svg2pdfLoading = null;
  exporter.ensurePDF = () => {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
    if (pdfLoading) return pdfLoading;
    pdfLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = JSPDF_URL;
      script.onload = resolve;
      script.onerror = () => { pdfLoading = null; reject(new Error('PDF library failed to load (are you offline?)')); };
      document.head.appendChild(script);
    });
    return pdfLoading;
  };
  /* jsPDF's .svg() plugin method — it converts an SVG's shapes and <text> into real vector drawing / text objects
     instead of one flattened image, so words in the PDF stay words (selectable, searchable, crisp at any zoom). It
     needs jsPDF loaded first. Latin text uses the PDF's own built-in font; Chinese or Tamil script needs a real font
     embedded (see UNICODE_FONTS below) — savePDF below falls back to the flattened image for the whole page if either
     library, or fetching a script's font, fails. */
  exporter.ensureSvg2pdf = () => {
    if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && typeof window.jspdf.jsPDF.API.svg === 'function') return Promise.resolve();
    if (svg2pdfLoading) return svg2pdfLoading;
    svg2pdfLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SVG2PDF_URL;
      script.onload = resolve;
      script.onerror = () => { svg2pdfLoading = null; reject(new Error('SVG-to-PDF library failed to load')); };
      document.head.appendChild(script);
    });
    return svg2pdfLoading;
  };

  const pdfPageSize = (w, h) => { const pageWidth = w * 0.75, pageHeight = h * 0.75; return { ptW: pageWidth, ptH: pageHeight, orientation: pageWidth >= pageHeight ? 'landscape' : 'portrait' }; };   // css px -> pt (96dpi -> 72dpi)

  /* jsPDF's built-in core fonts (helvetica etc.) only cover Latin script and are not the app's own typeface, so every
     script gets a real font embedded instead — a genuine .ttf (jsPDF cannot parse .woff/.woff2/.otf) — fetched once
     per session and cached. jsPDF embeds only the glyphs actually used, so even the ~7 MB Traditional Chinese font
     adds well under 1 MB to the finished PDF. 'latin' is last and matches everything else (Latin/Malay, digits, line
     codes, …), so it is what a plain map ends up using throughout — the same Inter the canvas itself uses.
     dualStyle: true fonts are safe to register under both 'normal' and 'bold' (svg2pdf then gets a real bold, though
     with a single-weight source file like Inter's it is visually the same weight as normal — still correct, just not
     heavier). dualStyle: false fonts are NOT safe that way — jsPDF's subsetting corrupts the WHOLE font's glyph
     mapping, not just the bold text, the moment a second style is registered for it (seen with Noto Sans TC and
     Tamil specifically; Inter does not have this problem) — pdfSafeSvg flattens those runs to a plain weight instead
     so svg2pdf never asks for a style that was not registered. */
  const UNICODE_FONTS = [
    { key: 'zhHant', test: /[㐀-䶿一-鿿]/, name: 'NotoSansTC', file: 'NotoSansTC.ttf', url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf', dualStyle: false },
    { key: 'ta', test: /[஀-௿]/, name: 'NotoSansTamil', file: 'NotoSansTamil.ttf', url: 'https://cdn.jsdelivr.net/gh/notofonts/noto-fonts@main/hinted/ttf/NotoSansTamil/NotoSansTamil-Regular.ttf', dualStyle: false },
    { key: 'latin', test: /./, name: 'Inter', file: 'Inter.ttf', url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/inter/Inter%5Bopsz,wght%5D.ttf', dualStyle: true,
      boldFile: 'Inter-Bold.ttf', boldUrl: 'https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-700-normal.ttf' },
  ];
  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));   // chunked: a single spread/apply over a multi-MB font overflows the call stack
    return btoa(binary);
  };
  const fontBufferCache = new Map();   // url -> Promise<ArrayBuffer>, kept for the page's lifetime
  const fetchFontBuffer = (url) => {
    if (!fontBufferCache.has(url)) {
      const request = fetch(url, { cache: 'force-cache' }).then((r) => { if (!r.ok) throw new Error(url + ' → ' + r.status); return r.arrayBuffer(); })
        .catch((e) => { fontBufferCache.delete(url); throw e; });
      fontBufferCache.set(url, request);
    }
    return fontBufferCache.get(url);
  };
  const fetchFontB64 = (url) => fetchFontBuffer(url).then(toBase64);
  /* Registers on this one jsPDF document (fonts are per-instance) whichever scripts the map's text actually needs —
     'latin' always matches, so Inter is always registered. If a needed font fails to fetch this throws, so vectorPDF
     gives up and savePDF falls back to the flattened image — better an honest picture than text silently rendered
     with the wrong font. */
  const registerUnicodeFonts = async (pdf, svgText) => {
    const fontOf = {};
    for (const f of UNICODE_FONTS) {
      if (!f.test.test(svgText)) continue;
      const base64 = await fetchFontB64(f.url);
      pdf.addFileToVFS(f.file, base64);
      pdf.addFont(f.file, f.name, 'normal');
      /* the variable Inter file draws only its default (regular) instance, so bold gets a real static Bold file; if that
         cannot be fetched, fall back to registering the regular file as bold (text stays correct, just not heavier) */
      let boldB64 = null;
      if (f.boldUrl) boldB64 = await fetchFontB64(f.boldUrl).catch(() => null);
      if (boldB64) { pdf.addFileToVFS(f.boldFile, boldB64); pdf.addFont(f.boldFile, f.name, 'bold'); }
      else if (f.dualStyle) pdf.addFont(f.file, f.name, 'bold');
      fontOf[f.key] = f.name;
    }
    return fontOf;
  };

  /* svg2pdf draws each element with the PDF's own fonts, not the browser's. jsPDF's font matching is style-based:
     its normal/bold registrations correspond to CSS 400/700. The map deliberately uses intermediate/heavier numeric
     weights too (500 for muted secondary labels, 800 for line badges), but registering only normal + bold means those
     weights can resolve to unregistered styles. Normalize them to the closest registered style.

     Anchored SVG text is also normalized to text-anchor=start. svg2pdf has to calculate the text width itself for
     text-anchor=end/middle, while jsPDF is using its embedded-font metrics. That can leave a small but visible gap at
     the anchored edge. Measuring with the exact PDF font and moving x explicitly makes the anchor deterministic.

     Tamil needs one extra step: Tamil is an Indic script whose correct appearance depends on shaping (reordering,
     OpenType GSUB substitutions and GPOS positioning). svg2pdf/jsPDF's text path does not provide an Indic shaping
     engine, so an embedded Noto Tamil font alone is not enough. For PDF export only, Tamil <text> nodes are therefore
     drawn with the browser's shaping engine onto a high-resolution canvas and inserted as SVG images. The surrounding
     map remains vector; only the complex-script glyph run becomes an image, preserving the browser's correct Tamil
     shaping and exact anchor position.

     The conversion is DOM-based so every SVG <text> is handled consistently. The screen-only label halo is removed
     before vector/raster text is emitted; svg2pdf does not implement SVG paint-order reliably. */
  const ensureBrowserTamilFont = (() => {
    let promise = null;
    return (fontOf) => {
      if (!fontOf.ta) return Promise.resolve();
      if (promise) return promise;
      promise = fetchFontBuffer(UNICODE_FONTS.find((f) => f.key === 'ta').url).then((buffer) => {
        if (!('FontFace' in window) || !document.fonts) return;
        const face = new FontFace('TransitMapPdfTamil', buffer, { style: 'normal', weight: '400' });
        return face.load().then(() => { document.fonts.add(face); });
      }).catch((e) => { promise = null; throw e; });
      return promise;
    };
  })();

  const textHasTamil = (text) => /[஀-௿]/.test(text || '');

  const parseNum = (value, fallback = 0) => {
    const number = Number.parseFloat(String(value ?? ''));
    return Number.isFinite(number) ? number : fallback;
  };

  const tamilTextImage = (svgDoc, element) => {
    const text = element.textContent || '';
    const fontSize = parseNum(element.getAttribute('font-size'), 16);
    const rawWeight = String(element.getAttribute('font-weight') || '400').trim().toLowerCase();
    const weight = (rawWeight === 'bold' || Number(rawWeight) >= 700) ? '700' : '400';
    const fill = element.getAttribute('fill') || '#000';
    const anchor = (element.getAttribute('text-anchor') || 'start').trim();
    const x = parseNum(element.getAttribute('x'), 0);
    const y = parseNum(element.getAttribute('y'), 0);
    const scale = 4; // enough resolution for normal map/PDF zoom without making every Tamil run huge
    const pad = Math.max(2, fontSize * 0.16);

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas unavailable for Tamil PDF text');
    context.font = `${weight} ${fontSize}px "TransitMapPdfTamil"`;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    const metrics = context.measureText(text);
    const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? metrics.actualBoundingBoxLeft : 0;
    const right = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : metrics.width;
    const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : fontSize * 0.9;
    const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : fontSize * 0.25;
    const cssW = Math.max(1, left + right + pad * 2);
    const cssH = Math.max(1, ascent + descent + pad * 2);
    canvas.width = Math.ceil(cssW * scale);
    canvas.height = Math.ceil(cssH * scale);
    context.scale(scale, scale);
    context.font = `${weight} ${fontSize}px "TransitMapPdfTamil"`;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillStyle = fill;
    context.fillText(text, pad + left, pad + ascent);

    const image = svgDoc.createElementNS('http://www.w3.org/2000/svg', 'image');
    const href = canvas.toDataURL('image/png');
    image.setAttribute('href', href);
    image.setAttribute('width', String(cssW));
    image.setAttribute('height', String(cssH));
    image.setAttribute('x', String(anchor === 'end' ? x - (cssW - pad) : anchor === 'middle' ? x - cssW / 2 : x - pad));
    image.setAttribute('y', String(y - (pad + ascent)));
    ['opacity', 'transform', 'clip-path'].forEach((name) => {
      const value = element.getAttribute(name);
      if (value != null) image.setAttribute(name, value);
    });
    return image;
  };

  const pdfSafeSvg = async (svgText, fontOf, pdf) => {
    const svgDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    if (svgDoc.querySelector('parsererror')) throw new Error('invalid SVG generated for PDF export');
    await ensureBrowserTamilFont(fontOf);

    const weightFor = (value, dualStyle) => {
      if (!dualStyle) return 400;
      const raw = String(value || '').trim().toLowerCase();
      if (raw === 'bold') return 700;
      if (raw === 'normal') return 400;
      const number = Number(raw);
      if (!Number.isFinite(number)) return 400;
      return number >= 600 ? 700 : 400;
    };

    svgDoc.querySelectorAll('text').forEach((element) => {
      const content = element.textContent || '';
      const hit = UNICODE_FONTS.find((f) => fontOf[f.key] && f.test.test(content)) || UNICODE_FONTS[UNICODE_FONTS.length - 1];
      const family = fontOf[hit.key] || 'helvetica';
      const pdfWeight = weightFor(element.getAttribute('font-weight'), hit.dualStyle);

      /* Remove the screen-only halo before either vector or raster text is emitted. */
      const halo = element.getAttribute('stroke-width') === '3.2' && element.getAttribute('stroke-linejoin') === 'round' && element.getAttribute('paint-order') === 'stroke';
      if (halo) {
        element.removeAttribute('stroke');
        element.removeAttribute('stroke-width');
        element.removeAttribute('stroke-linejoin');
        element.removeAttribute('paint-order');
      }

      /* svg2pdf cannot correctly shape Tamil. Use the browser's already-installed shaping engine instead. */
      if (hit.key === 'ta' && fontOf.ta && textHasTamil(content)) {
        if (!('FontFace' in window) || !document.fonts) throw new Error('browser font API unavailable for Tamil PDF text');
        const image = tamilTextImage(svgDoc, element);
        element.parentNode.replaceChild(image, element);
        return;
      }

      element.setAttribute('font-family', family);
      element.setAttribute('font-weight', String(pdfWeight));

      const anchor = (element.getAttribute('text-anchor') || 'start').trim();
      const xAttr = element.getAttribute('x');
      if (anchor !== 'start') {
        const x = xAttr == null ? 0 : Number.parseFloat(xAttr);
        const size = parseNum(element.getAttribute('font-size'), 16);
        if (!Number.isFinite(x)) return;
        try {
          pdf.setFont(family, pdfWeight >= 700 ? 'bold' : 'normal');
          /* pdf is measured in points while the source SVG uses CSS px (the page conversion is 96dpi -> 72pt).
             Convert through the same 0.75 factor and return to SVG units before moving x. */
          const PX_TO_PT = 0.75;
          pdf.setFontSize(size * PX_TO_PT);
          const width = pdf.getTextWidth(content) / PX_TO_PT;
          element.setAttribute('x', String(anchor === 'end' ? x - width : x - width / 2));
          element.setAttribute('text-anchor', 'start');
        } catch (_) {
          /* Keep svg2pdf's native anchor handling if this particular font cannot be measured. */
        }
      }
    });

    return new XMLSerializer().serializeToString(svgDoc.documentElement);
  };

  /* Real vector text (and shapes) — the normal path. Builds the SVG into an off-screen, unstyled host so the browser's
     own CSS never leaks into it, hands the live element to svg2pdf, then cleans the host up either way. */
  const vectorPDF = async (options) => {
    await exporter.ensurePDF(); await exporter.ensureSvg2pdf();
    const { svg: svg0, w: width, h: height } = exporter.buildSVG(options);
    if (typeof window.jspdf.jsPDF.API.svg !== 'function') throw new Error('svg2pdf did not attach');
    const { ptW: pageWidth, ptH: pageHeight, orientation } = pdfPageSize(width, height);
    const pdf = new window.jspdf.jsPDF({ orientation, unit: 'pt', format: [pageWidth, pageHeight] });
    const fontOf = await registerUnicodeFonts(pdf, svg0);
    const safeSvg = await pdfSafeSvg(svg0, fontOf, pdf);
    const host = document.createElement('div');
    host.setAttribute('style', 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden');
    host.innerHTML = safeSvg;
    document.body.appendChild(host);
    try {
      const svgEl = host.querySelector('svg');
      svgEl.setAttribute('width', String(width)); svgEl.setAttribute('height', String(height));
      await pdf.svg(svgEl, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    } finally { host.remove(); }
    pdf.save(`${TM.maps.current.id}-${today()}.pdf`);
  };

  /* Flattened image — the fallback used only if the vector path is unavailable or throws (offline, an unusual glyph,
     a browser quirk), so exporting a PDF always succeeds. */
  const rasterPDF = (options) => new Promise((resolve, reject) => {
    exporter.ensurePDF().then(() => {
      const { svg, w: width, h: height } = exporter.buildSVG(options);
      const scale = Math.min(options.scale, 12000 / Math.max(width, height));
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/png');
          const { ptW: pageWidth, ptH: pageHeight, orientation } = pdfPageSize(width, height);
          const pdfDoc = new window.jspdf.jsPDF({ orientation, unit: 'pt', format: [pageWidth, pageHeight] });
          pdfDoc.addImage(dataUrl, 'PNG', 0, 0, pageWidth, pageHeight);
          pdfDoc.save(`${TM.maps.current.id}-${today()}.pdf`);
          resolve();
        } catch (e) { reject(e); }
      };
      image.onerror = () => reject(new Error('render failed'));
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }, reject);
  });

  exporter.savePDF = async (options) => {
    try { await vectorPDF(options); } catch (e) { await rasterPDF(options); }
  };

  /* ---------- dialog ---------- */
  exporter.openDialog = () => {
    const appTheme = document.documentElement.dataset.theme;
    const options = { format: 'png', theme: appTheme, transparent: false, legend: true, hotspots: false, title: TM.maps.title(), scale: 2 };
    if (![...TM.store.visible].some((id) => TM.store.lineFilter.has(id))) { TM.toast('Select at least one line and show it with the eye control first', 'err'); return; }
    const segmented = (name, items) => `<div class="seg" data-seg="${name}">${items.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(options[name]) === String(v) ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    const dialog = TM.ui.modal({
      title: 'Export', wide: true,
      body: `<p class="hint" style="margin-top:0">The exported map hides the node grid and editing handles — only the transit map remains.</p>
        <div class="grid2"><div class="field"><label>Image format</label>${segmented('format', [['png', 'PNG'], ['svg', 'SVG'], ['pdf', 'PDF']])}</div>
        <div class="field"><label>Theme</label>${segmented('theme', [['light', 'Light'], ['dark', 'Dark']])}</div>
        <div class="field"><label>Resolution (PNG / PDF)</label>${segmented('scale', [[1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']])}</div>
        <div class="field"><label>Title</label><input class="input" id="ex-title" value="${TM.esc(options.title)}"></div></div>
        <div class="row wrap" style="margin-bottom:12px"><label class="check"><input type="checkbox" id="ex-leg" checked> Legend</label><label class="check"><input type="checkbox" id="ex-tr"> Transparent background</label><label class="check"><input type="checkbox" id="ex-hot"> Suggestion badges</label></div>
        <div id="ex-prev" style="border:1px solid var(--line);border-radius:12px;overflow:hidden;max-height:300px;display:grid;place-items:center;background:repeating-conic-gradient(var(--panel-2) 0 25%, transparent 0 50%) 0 0/16px 16px"></div>
        <div class="row wrap" style="margin-top:14px"><span class="lbl" style="margin-right:4px">JSON</span><button class="btn sm" id="ex-line" ${TM.state.activeLineId ? '' : 'disabled'}>${TM.icon('file')} Active line</button><button class="btn sm" id="ex-stn" ${TM.store.exportStations().length && !TM.store.userMap ? '' : 'disabled'}>${TM.icon('file')} My new / moved stations</button><button class="btn sm" id="ex-zip" title="Stations, lines, icons and logo of this map in one file">${TM.icon('zip')} Whole map (.zip)</button></div>`,
      buttons: [{ label: 'Close', cls: 'ghost' }, { label: `${TM.icon('download')} Download map`, cls: 'primary', keep: true, onClick: async (api, button) => {
        button.disabled = true;
        try { if (options.format === 'svg') exporter.saveSVG(options); else if (options.format === 'pdf') await exporter.savePDF(options); else await exporter.savePNG(options); TM.toast('Map exported'); } catch (e) { TM.toast('Export failed: ' + e.message, 'err'); }
        button.disabled = false; return false;
      } }],
    });
    const root = dialog.body, prev = root.querySelector('#ex-prev');
    const preview = () => { const result = exporter.buildSVG(options); prev.innerHTML = result.svg.replace(/width="\d+" height="\d+"/, 'style="max-width:100%;max-height:296px;height:auto"'); };
    root.onclick = (e) => {
      const button = e.target.closest('[data-seg] button'); if (button) {
        const name = button.parentElement.dataset.seg; options[name] = name === 'scale' ? +button.dataset.v : button.dataset.v;
        button.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === button)); preview(); return;
      }
      if (e.target.closest('#ex-line')) exporter.lineJSON(TM.state.activeLineId);
      if (e.target.closest('#ex-stn')) exporter.stationsJSON();
      if (e.target.closest('#ex-zip')) TM.ui.exportMap(TM.maps.current.id);
    };
    root.oninput = root.onchange = () => { options.title = root.querySelector('#ex-title').value.trim(); options.legend = root.querySelector('#ex-leg').checked; options.transparent = root.querySelector('#ex-tr').checked; options.hotspots = root.querySelector('#ex-hot').checked; preview(); };
    preview();
  };
})(window.TM);
