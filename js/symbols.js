/* Transit symbols as SVG strings: stations, interchanges, links, labels (with icons), badges, legend. */
(function (TM) {
  const symbols = (TM.symbols = {});
  const round2dp = TM.round2dp;
  let pillClipSeq = 0;   // unique per-pill clipPath id, so multiple interchange pills in one render don't collide

  symbols.palette = (theme) => (theme === 'dark'
    ? { ink: '#e8ecf4', paper: '#111827', muted: '#7a869a', walk: '#8792a6', bg: '#0b1120', fantasy: '#c084fc', warn: '#fbbf24' }
    : { ink: '#1b2333', paper: '#ffffff', muted: '#98a2b3', walk: '#a7aebb', bg: '#ffffff', fantasy: '#9333ea', warn: '#fde68a' });

  symbols.FONT = '"Inter","Noto Sans","Noto Sans TC","Noto Sans Tamil","PingFang TC","Microsoft JhengHei","Latha",system-ui,sans-serif';

  symbols.contrast = (hex) => {
    const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    if (!match) return '#fff';
    const [red, green, blue] = [1, 2, 3].map((i) => parseInt(match[i], 16));
    return (0.299 * red + 0.587 * green + 0.114 * blue) > 165 ? '#111827' : '#ffffff';
  };

  /* Station number, in one of three modes (Display → Number inside symbol):
     'code' (default) — the digits of the station's own code (KJ13 -> 13); 'full' — the whole code (KJ13); 'ordinal' —
     the station's own position counted along this particular line, from its first stop (1, 2, 3, …). Each line lists
     its own stations, so 'code'/'full' read the same everywhere a station appears, but 'ordinal' differs per line. */
  symbols.numberFor = (station, mode, ordinal) => {
    if (mode === 'full') return station.id;
    if (mode === 'ordinal') return ordinal != null ? String(ordinal) : '';
    const match = /(\d+[A-Za-z]?)$/.exec(station.id);
    return match ? match[1] : '';
  };

  const numText = (number, fill, radius) => {
    const fontSize = number.length > 2 ? 7 : number.length > 1 ? 9.5 : 11;
    return `<text y="${round2dp(fontSize * 0.36)}" text-anchor="middle" font-size="${fontSize}" font-weight="800" fill="${symbols.contrast(fill)}" font-family='${symbols.FONT}'>${TM.esc(number)}</text>`;
  };

  const statusLook = (palette, status) => {
    const look = { stroke: palette.ink, fill: palette.paper, dash: '', op: 1 };
    if (status === 'under_construction') { look.fill = palette.warn; look.dash = ' stroke-dasharray="3.2 2.4"'; }
    else if (status === 'provisional') look.dash = ' stroke-dasharray="0.1 3.4" stroke-linecap="round"';
    else if (status === 'planned') { look.stroke = palette.muted; look.dash = ' stroke-dasharray="4 3"'; }
    else if (status === 'abandoned') { look.stroke = palette.muted; look.op = 0.7; }
    else if (status === 'demolished') { look.stroke = palette.muted; look.op = 0.5; look.dash = ' stroke-dasharray="1.6 2.4"'; }   // fainter than abandoned, outline broken up: nothing is left of it
    return look;
  };

  /* Single-line station. kind: station | terminal | interchange (ring) | disc | halt | pill. num = text inside, fill = disc/pill colour when numbered. */
  symbols.station = (x, y, options) => {
    const palette = options.pal, kind = options.kind, status = options.status || 'operational', big = kind === 'interchange', disc = kind === 'disc', pill = kind === 'pill', number = big ? '' : options.num;
    const look = statusLook(palette, status);
    if (pill) {
      /* Singapore-style: a rounded pill with the line code inside. At an interchange (two or more different lines
         calling here), it becomes one long pill — a single outline, no border between one line's colour and the
         next — divided into as many colour bands as lines (up to 7, o.codes), each with its own code in white,
         exactly like the real signage (e.g. Bishan: one pill, red "NS17" merging straight into orange "CC15"). */
      const fontSize = 11, height = 21;
      const codes = (options.codes && options.codes.length ? options.codes : [{ text: number || '', color: options.fill || palette.ink }]).slice(0, 7);
      const widths = codes.map((c) => Math.max(26, symbols.textWidth(c.text, fontSize) + 13));
      const totalW = widths.reduce((a, b) => a + b, 0);
      let cx = -totalW / 2;
      const segs = codes.map((c, i) => { const segment = { x: cx, w: widths[i], c }; cx += widths[i]; return segment; });
      let markup = `<g transform="translate(${round2dp(x)} ${round2dp(y)})" opacity="${look.op}">`;
      if (segs.length > 1) {
        const clipId = `pillclip-${pillClipSeq++}`;
        markup += `<defs><clipPath id="${clipId}"><rect x="${round2dp(-totalW / 2)}" y="${round2dp(-height / 2)}" width="${round2dp(totalW)}" height="${round2dp(height)}" rx="${round2dp(height / 2)}"/></clipPath></defs>` +
          `<g clip-path="url(#${clipId})">${segs.map((seg) => `<rect x="${round2dp(seg.x)}" y="${round2dp(-height / 2)}" width="${round2dp(seg.w + 0.6)}" height="${round2dp(height)}" fill="${seg.c.color}"/>`).join('')}</g>`;
      } else {
        markup += `<rect x="${round2dp(-totalW / 2)}" y="${round2dp(-height / 2)}" width="${round2dp(totalW)}" height="${round2dp(height)}" rx="${round2dp(height / 2)}" fill="${segs[0].c.color}"/>`;
      }
      markup += `<rect x="${round2dp(-totalW / 2)}" y="${round2dp(-height / 2)}" width="${round2dp(totalW)}" height="${round2dp(height)}" rx="${round2dp(height / 2)}" fill="none" stroke="${palette.paper}" stroke-width="2.5"${look.dash}/>`;
      segs.forEach((seg) => { if (seg.c.text) markup += `<text x="${round2dp(seg.x + seg.w / 2)}" y="${round2dp(fontSize * 0.36)}" text-anchor="middle" font-size="${fontSize}" font-weight="800" fill="${symbols.contrast(seg.c.color)}" font-family='${symbols.FONT}'>${TM.esc(seg.c.text)}</text>`; });
      return markup + '</g>';
    }
    if (kind === 'tick') {
      /* a small tab in the line's colour, sticking out of the line on the label side (o.dir) — one per line at an
         interchange, side by side across the line — as on many metro maps */
      const direction = options.dir && (options.dir.x || options.dir.y) ? options.dir : { x: 1, y: 0 }, W = options.lineW || 8;
      const colors = options.lineColors && options.lineColors.length ? options.lineColors : [options.fill || look.stroke];
      const perp = { x: -direction.y, y: direction.x }, thick = Math.max(8, W * 2.75), out = W / 2 + Math.max(4, W * 0.8), spread = Math.max(W + 1, thick + 1);   // its edge along the line a little longer than the line is wide
      let tabs = '';
      colors.forEach((colour, i) => {
        const off = (i - (colors.length - 1) / 2) * spread;
        /* a rounded-cornered tab, its inner end hidden inside the line so only the outer corners show round */
        const angle = Math.atan2(direction.y, direction.x) * 180 / Math.PI;
        tabs += `<rect x="0" y="${round2dp(-thick / 2)}" width="${round2dp(out)}" height="${round2dp(thick)}" rx="${round2dp(Math.min(2.5, out * 0.3))}" fill="${colour}" transform="translate(${round2dp(perp.x * off)} ${round2dp(perp.y * off)}) rotate(${round2dp(angle)})"${look.dash ? ` stroke="${colour}" stroke-width="0"` : ''}/>`;
      });
      return `<g transform="translate(${round2dp(x)} ${round2dp(y)})" opacity="${look.op}">${tabs}</g>`;
    }
    const isDash = kind === 'dash';
    const radius = disc ? 13 : big ? 10 : number ? 10 : 6.5, strokeWidth = disc ? 3.6 : big ? 4 : number ? 2.6 : 3.2;   // disc = terminus: a little larger than the interchange ring
    let fill = disc ? (options.fill || palette.ink) : number ? (options.fill || palette.paper) : look.fill;
    let svg = `<g transform="translate(${round2dp(x)} ${round2dp(y)})" opacity="${look.op}">`;
    if (kind === 'terminal' && options.dir) {
      const normalX = -options.dir.y, normalY = options.dir.x, halfLength = 16;
      svg += `<line x1="${round2dp(normalX * halfLength + options.dir.x)}" y1="${round2dp(normalY * halfLength + options.dir.y)}" x2="${round2dp(-normalX * halfLength + options.dir.x)}" y2="${round2dp(-normalY * halfLength + options.dir.y)}" stroke="${palette.ink}" stroke-width="5" stroke-linecap="round"/>`;
    }
    if (isDash) {
      /* Just a short dash — no ring, no dot — pointing out from the line in the same direction the station's own
         label sits (o.dir), with flat, square-cut (right-angle) ends, in the line's own colour. A bit thicker where
         it is a terminus. At an interchange, one dash per line, fanned side by side, each in its own colour. */
      const direction = options.dir && (options.dir.x || options.dir.y) ? options.dir : { x: 1, y: 0 }, length = 16, thick = options.terminus ? 7 : 5;
      const colors = (options.lineColors && options.lineColors.length ? options.lineColors : [options.fill || look.stroke]);
      const perp = { x: -direction.y, y: direction.x }, spread = thick + 2, count = colors.length;
      colors.forEach((colour, i) => {
        const off = (i - (count - 1) / 2) * spread, offsetX = perp.x * off, offsetY = perp.y * off;
        /* at a terminus the line stops at the station's centre (square end), so the dash starts half a line width
           behind it — otherwise the corner between the line's end and the dash is left open */
        const back = options.terminus ? options.back || 0 : 0;
        svg += `<line x1="${round2dp(offsetX - direction.x * back)}" y1="${round2dp(offsetY - direction.y * back)}" x2="${round2dp(direction.x * length + offsetX)}" y2="${round2dp(direction.y * length + offsetY)}" stroke="${colour}" stroke-width="${thick}" stroke-linecap="butt"${look.dash}/>`;
      });
    } else {
      svg += `<circle r="${radius}" fill="${fill}" stroke="${look.stroke}" stroke-width="${strokeWidth}"${look.dash}/>`;
    }
    if (isDash) { /* no number / status glyph — a plain halt mark */ }
    else if (number) svg += numText(number, fill, radius);
    else if (disc) { /* plain disc in the line colour */ }
    else if (status === 'fantasy') { const size = big ? 5 : 3.2, j = big ? 1.6 : 1; svg += `<path d="M0-${size}L${j}-${j}L${size} 0L${j} ${j}L0 ${size}L-${j} ${j}L-${size} 0L-${j}-${j}Z" fill="${palette.fantasy}"/>`; }
    else if (status === 'abandoned' || status === 'demolished') { const size = big ? 4.5 : 2.8; svg += `<path d="M-${size}-${size}L${size} ${size}M${size}-${size}L-${size} ${size}" stroke="${palette.muted}" stroke-width="1.6" stroke-linecap="round"/>`; }
    return svg + '</g>';
  };

  /* Interchange of several lines at one node.
     capsule = a circle per line joined by an outlined pill (Plaza Rakyat / Merdeka)
     stack   = coloured dots in a rounded box (Flamingo) — larger, numbered dots when o.showNum and a number exists. items: [{color,num}] */
  symbols.multi = (x, y, options) => {
    const palette = options.pal, count = options.items.length, isCapsule = options.style === 'capsule', chain = options.style === 'chain';
    const stackNum = !isCapsule && !chain && !!options.showNum && options.items.some((it) => it.num);
    const gap = options.gap || (chain ? 40 : isCapsule ? 23 : stackNum ? 21 : 15), radius = chain ? 13 : isCapsule ? 9.5 : stackNum ? 10 : 7, half = ((count - 1) * gap) / 2, axis = options.axis || { x: 0, y: 1 };
    const look = statusLook(palette, options.status || 'operational');
    const pointAt = (i) => ({ x: (i * gap - half) * axis.x, y: (i * gap - half) * axis.y });
    const first = pointAt(0), last = pointAt(count - 1);
    let svg = `<g transform="translate(${round2dp(x)} ${round2dp(y)})" opacity="${look.op}">`;
    if (chain) {
      /* "Linked": a small disc in each line's colour, sitting on that line (dx / dy = where the line runs), each in a white ring and
         a dark outline, all joined by a narrow neck. Only a little wider than the line itself; numbered discs are larger. */
      const withNumbers = !!options.showNum && options.items.some((it) => it.num);
      const core = withNumbers ? 8 : 4.7, ring = withNumbers ? 10 : 6.1, edge = withNumbers ? 11.6 : 7.5;
      const points = options.items.map((it, i) => (it.dx != null ? { x: it.dx, y: it.dy } : pointAt(i)));
      let extent = 0;
      points.forEach((p) => { extent = Math.max(extent, Math.hypot(p.x, p.y)); });
      for (let i = 0; i + 1 < points.length; i++) {
        svg += `<line x1="${round2dp(points[i].x)}" y1="${round2dp(points[i].y)}" x2="${round2dp(points[i + 1].x)}" y2="${round2dp(points[i + 1].y)}" stroke="${look.stroke}" stroke-width="${withNumbers ? 13 : 9.5}" stroke-linecap="round"/>`;
      }
      for (let i = 0; i + 1 < points.length; i++) {
        svg += `<line x1="${round2dp(points[i].x)}" y1="${round2dp(points[i].y)}" x2="${round2dp(points[i + 1].x)}" y2="${round2dp(points[i + 1].y)}" stroke="${look.fill}" stroke-width="${withNumbers ? 7.5 : 5.5}" stroke-linecap="round"/>`;
      }
      points.forEach((p) => { svg += `<circle cx="${round2dp(p.x)}" cy="${round2dp(p.y)}" r="${edge}" fill="${look.stroke}"/>`; });     // outlines first, then rings, then cores,
      points.forEach((p) => { svg += `<circle cx="${round2dp(p.x)}" cy="${round2dp(p.y)}" r="${ring}" fill="#fff"/>`; });          // so neighbouring discs merge cleanly
      options.items.forEach((item, i) => {
        const point = points[i], number = withNumbers && item.num;
        svg += `<circle cx="${round2dp(point.x)}" cy="${round2dp(point.y)}" r="${core}" fill="${item.color}"/>${number ? `<g transform="translate(${round2dp(point.x)} ${round2dp(point.y)})">${numText(item.num, item.color, core)}</g>` : ''}`;
      });
      return { svg: svg + '</g>', extent: extent + edge + 3 };
    }
    svg += `<line x1="${round2dp(first.x)}" y1="${round2dp(first.y)}" x2="${round2dp(last.x)}" y2="${round2dp(last.y)}" stroke="${look.stroke}" stroke-width="${2 * radius + 5}" stroke-linecap="round"${look.dash ? ' stroke-dasharray="0.1 0"' : ''}/>`;
    svg += `<line x1="${round2dp(first.x)}" y1="${round2dp(first.y)}" x2="${round2dp(last.x)}" y2="${round2dp(last.y)}" stroke="${look.fill}" stroke-width="${2 * radius}" stroke-linecap="round"/>`;
    options.items.forEach((item, i) => {
      const point = pointAt(i);
      if (isCapsule) {
        const number = options.showNum && item.num;
        svg += `<g transform="translate(${round2dp(point.x)} ${round2dp(point.y)})"><circle r="${radius - 1}" fill="${number ? item.color : palette.paper}" stroke="${look.stroke}" stroke-width="2"${look.dash}/>${number ? numText(item.num, item.color, radius) : `<circle r="3.6" fill="${item.color}"/>`}</g>`;
      } else if (stackNum && item.num) svg += `<g transform="translate(${round2dp(point.x)} ${round2dp(point.y)})"><circle r="8.2" fill="${item.color}"/>${numText(item.num, item.color, 8.2)}</g>`;
      else svg += `<circle cx="${round2dp(point.x)}" cy="${round2dp(point.y)}" r="${stackNum ? 6 : 4.8}" fill="${item.color}"/>`;
    });
    return { svg: svg + '</g>', extent: half + radius + 3 };
  };

  /* Mega-station "block": an interchange complex (and any connecting stations merged into it) drawn as one shape, each
     member kept at its own freely-movable spot. The shape itself stands for the walkways between them, so no separate
     connecting lines are drawn between the members.
     style: 'rapidkl' (a filled bar, like the interchange boxes on the official map) | 'shape' (an outlined circle/square).
     o.members: [{ id, dx, dy, arrive:{x,y}, mono }] (mono = that member's own line colour, when it has just one). */
  symbols.block = (x, y, options) => {
    const palette = options.pal, members = options.members, rapid = options.style !== 'shape', isSquare = options.shape === 'square', size = options.size, vert = options.orientation === 'vertical';
    const scale = members.length > 6 ? 0.5 : members.length > 3 ? 0.6 : 0.74;
    let svg = `<g transform="translate(${round2dp(x)} ${round2dp(y)})">`;
    /* outline */
    const pad = rapid ? 26 : 20, barLen = size * 2 + pad * 2, barThick = 46, fill = options.color || (rapid ? palette.ink : palette.paper);
    if (rapid) {
      const width = vert ? barThick : barLen, height = vert ? barLen : barThick;
      svg += `<rect x="${round2dp(-width / 2)}" y="${round2dp(-height / 2)}" width="${round2dp(width)}" height="${round2dp(height)}" rx="${round2dp(Math.min(width, height) / 2)}" fill="${fill}" stroke="${palette.paper}" stroke-width="3"/>`;
    } else if (isSquare) {
      const width = size * 2 + pad * 2;
      svg += `<rect x="${round2dp(-width / 2)}" y="${round2dp(-width / 2)}" width="${round2dp(width)}" height="${round2dp(width)}" rx="16" fill="${fill}" stroke="${palette.ink}" stroke-width="5"/>`;
    } else {
      svg += `<circle r="${round2dp(size + pad)}" fill="${fill}" stroke="${palette.ink}" stroke-width="5"/>`;
    }
    /* The inner connecting line is retained for outlined shape blocks. For RapidKL bars, omit the decorative rail:
       member positions still use geo.blockPoint/geo.blockNearestT and remain fully draggable along the same axis. */
    let innerD;
    if (!rapid && !isSquare) innerD = null;   // circle: drawn as a <circle> below (a true ring, not a path)
    else if (!rapid) { const half = size; innerD = `M${round2dp(-half)} ${round2dp(-half)}L${round2dp(half)} ${round2dp(-half)}L${round2dp(half)} ${round2dp(half)}L${round2dp(-half)} ${round2dp(half)}Z`; }
    else innerD = vert ? `M0 ${round2dp(-size)}L0 ${round2dp(size)}` : `M${round2dp(-size)} 0L${round2dp(size)} 0`;
    const noPointer = options.interactive ? ' pointer-events="none"' : '';   // decorative only — must not steal a click meant for a member dot sitting on it (that dot is otherwise on top, but its own hit-circle is only 13px across)
    const innerStroke = (d) => `<path d="${d}" fill="none" stroke="${palette.paper}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"${noPointer}/><path d="${d}" fill="none" stroke="${palette.walk}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"${noPointer}/>`;
    if (innerD && !rapid) svg += innerStroke(innerD);
    else if (!rapid && !isSquare) svg += `<circle r="${round2dp(size)}" fill="none" stroke="${palette.paper}" stroke-width="7"${noPointer}/><circle r="${round2dp(size)}" fill="none" stroke="${palette.walk}" stroke-width="4"${noPointer}/>`;
    /* members, each its own real symbol, scaled to fit */
    members.forEach((member) => {
      svg += `<g data-sid="${TM.esc(member.id)}"${options.interactive ? ` data-blk="${TM.esc(options.repId)}|${TM.esc(member.key || member.id)}"` : ''} transform="translate(${round2dp(member.dx)} ${round2dp(member.dy)})"${options.interactive ? ' style="cursor:move"' : ''}><circle r="13" fill="transparent"/><g transform="scale(${scale})">${member.sym}</g></g>`;
    });
    svg += '</g>';
    const extent = (rapid ? Math.hypot(barLen / 2, barThick / 2) : size + pad) + 14;
    return { svg: svg, extent: extent };
  };

  /* The frame behind a free-floating text label: a shape (rect / round / pill / ellipse / circle — the whole text inside it) filled with a.bg and / or outlined
     with a border (solid / dashed / dotted / double) in a.borderColor. Centred on (0,0) around a w×h run of text.
     No shape = nothing drawn. Returns { svg, w, h } — the size the label then takes up. */
  symbols.annFrame = (annotation, width, height, fontSize, palette) => {
    if (!annotation.shape || (!annotation.bg && !annotation.border)) return { svg: '', w: width, h: height };
    const borderWidth = Math.max(1.5, Math.round(fontSize * 0.09 * 10) / 10), frameWidth = width + fontSize * 0.9, frameHeight = height + fontSize * 0.5;
    const col = annotation.borderColor || palette.ink, fill = annotation.bg || 'none', frameRadius = Math.hypot(width / 2, height / 2) + fontSize * 0.3;   // circle: round the text's corners, with a little air
    const shape = (attrs) => {
      if (annotation.shape === 'circle') return `<circle r="${round2dp(frameRadius)}" ${attrs}/>`;
      if (annotation.shape === 'ellipse') return `<ellipse rx="${round2dp(frameWidth / 2 * 1.2)}" ry="${round2dp(frameHeight / 2 * 1.3)}" ${attrs}/>`;
      const cornerRadius = annotation.shape === 'pill' ? frameHeight / 2 : annotation.shape === 'round' ? Math.min(frameHeight / 2, fontSize * 0.4) : 0;
      return `<rect x="${round2dp(-frameWidth / 2)}" y="${round2dp(-frameHeight / 2)}" width="${round2dp(frameWidth)}" height="${round2dp(frameHeight)}" rx="${round2dp(cornerRadius)}" ${attrs}/>`;
    };
    let svg = '';
    if (!annotation.border) svg = shape(`fill="${fill}"`);
    else if (annotation.border === 'double') svg = shape(`fill="${fill}" stroke="${col}" stroke-width="${round2dp(borderWidth * 3)}"`) + shape(`fill="none" stroke="${annotation.bg || palette.paper}" stroke-width="${round2dp(borderWidth)}"`);
    else {
      const dash = annotation.border === 'dashed' ? ` stroke-dasharray="${round2dp(borderWidth * 3.5)} ${round2dp(borderWidth * 2.2)}"` : annotation.border === 'dotted' ? ` stroke-dasharray="0.1 ${round2dp(borderWidth * 2.2)}" stroke-linecap="round"` : '';
      svg = shape(`fill="${fill}" stroke="${col}" stroke-width="${round2dp(borderWidth)}"${dash}`);
    }
    const grow = annotation.border === 'double' ? borderWidth * 3 : annotation.border ? borderWidth : 0;
    const ellipseWidth = annotation.shape === 'circle' ? 2 * frameRadius : annotation.shape === 'ellipse' ? frameWidth * 1.2 : frameWidth, ellipseHeight = annotation.shape === 'circle' ? 2 * frameRadius : annotation.shape === 'ellipse' ? frameHeight * 1.3 : frameHeight;
    return { svg: svg, w: ellipseWidth + grow, h: ellipseHeight + grow };
  };

  /* Link between two different stations: 'link' (connecting station) = solid grey walkway, 'connect' (unofficial) = the
     same, dashed, 'neck' (interchange between stations on different nodes) = an outlined white band.
     d = optional SVG path with bends (from TM.geo.linkRoute); otherwise a straight line a -> b.
     o (optional): k = thickness scale; style = a line style (dash / dashdot / hatch / solid; absent or 'auto' = the kind's
     own look); color = the link's own colour (absent = grey walkway / white interchange band); border = 'none' or a colour
     for the outline (absent = the kind's own). */
  const LINK_DASH = { dash: [14, 8], dashdot: [14, 6, 2, 6], hatch: [3.6, 3.2] };
  symbols.connector = (start, end, kind, palette, pathData, options) => {
    options = options || {};
    const path = pathData || `M${round2dp(start.x)} ${round2dp(start.y)}L${round2dp(end.x)} ${round2dp(end.y)}`, scale = options.k || 1, neck = kind === 'neck';
    const style = options.style && options.style !== 'auto' ? options.style : kind === 'connect' ? 'unofficial' : 'solid';
    const border = options.border === 'none' ? null : options.border || (neck ? palette.ink : palette.paper);
    const coreW = (neck ? 5.5 : 7) * scale, caseW = (neck ? 9.5 : 11) * scale, core = options.color || (neck ? palette.paper : palette.walk);
    const dashPattern = style === 'unofficial' ? [7, 6] : LINK_DASH[style];
    const dash = dashPattern ? ` stroke-dasharray="${dashPattern.map((n) => round2dp(n * scale)).join(' ')}"` : '';
    const lineCap = neck || style === 'hatch' ? '' : dashPattern ? '' : ' stroke-linecap="round"';
    return `<g fill="none" stroke-linejoin="round">${border ? `<path d="${path}" stroke="${border}" stroke-width="${round2dp(caseW)}"${neck ? '' : ' stroke-linecap="round"'}/>` : ''}<path d="${path}" stroke="${core}" stroke-width="${round2dp(coreW)}"${dash}${lineCap}/></g>`;
  };
  /* The same link drawn in the colours of the lines at each end: halves[0] from the first station to the midpoint,
     halves[1] on to the second, each { pts, colors } — one band per line calling at that end, side by side in the order
     the lines themselves run (so a side with two lines is two bands, the other side one). r = corner radius. */
  symbols.splitConnector = (halves, palette, options) => {
    options = options || {};
    const scale = options.k || 1, bandWidth = 4.5 * scale, edge = 1.8 * scale, geo = TM.geo, border = options.border === 'none' ? null : options.border || palette.ink;
    let casing = '', bands = '';
    halves.forEach((half) => {
      if (half.pts.length < 2) return;
      const count = Math.max(1, half.colors.length);
      if (border) casing += `<path d="${geo.roundedPath(half.pts, options.r || 20)}" stroke="${border}" stroke-width="${round2dp(count * bandWidth + edge * 2)}"/>`;
      half.colors.forEach((colour, i) => {
        const off = (i - (count - 1) / 2) * bandWidth;
        bands += `<path d="${geo.roundedPath(off ? geo.offsetLine(half.pts, off) : half.pts, options.r || 20)}" stroke="${colour}" stroke-width="${round2dp(bandWidth + 0.4)}"/>`;
      });
    });
    return `<g fill="none" stroke-linejoin="round">${casing}${bands}</g>`;
  };

  /* Approximate text width (CJK / Tamil glyphs are wider). */
  const wide = (ch) => /[஀-௿⺀-鿿＀-￯]/.test(ch);
  symbols.textWidth = (t, fs) => [...t].reduce((a, c) => a + (wide(c) ? 1.0 : 0.56) * fs, 0);

  /* Multi-language label block around (x,y). pos: n ne e se s sw w nw. o.icons = data-URIs shown after the first row.
     o.rot = degrees (clockwise), turned about the point of the label nearest the station, so it swings around it.
     Returns { svg, box (unrotated), transform (for the label's own group: '' or ' transform="rotate(…)"'), hull (box once rotated) }. */
  symbols.label = (x, y, options) => {
    const palette = options.pal, rows = options.rows;
    if (!rows.length) return { svg: '', box: null };
    const gap = (options.big ? 15 : 12) + (options.gap || 0), diag = gap * 0.78;
    const icons = options.icons || [], iconSize = Math.round(rows[0].fs * 1.15), iconsW = icons.length ? icons.length * (iconSize + 3) + 1 : 0;
    const rowHeights = rows.map((r, i) => Math.max(r.fs * 1.22, i === 0 && icons.length ? iconSize + 2 : 0)), height = rowHeights.reduce((a, b) => a + b, 0);
    const firstWidth = symbols.textWidth(rows[0].text, rows[0].fs);
    const width = Math.max(firstWidth + iconsW, ...rows.slice(1).map((r) => symbols.textWidth(r.text, r.fs)));
    const position = options.pos, dx = options.dx || 0, dy = options.dy || 0;
    let anchor = 'middle', anchorX = x, top;
    if (position === 'e') { anchor = 'start'; anchorX = x + gap; top = y - height / 2; }
    else if (position === 'w') { anchor = 'end'; anchorX = x - gap; top = y - height / 2; }
    else if (position === 'n') { top = y - gap - height; }
    else if (position === 's') { top = y + gap; }
    else if (position === 'ne') { anchor = 'start'; anchorX = x + diag; top = y - diag - height; }
    else if (position === 'nw') { anchor = 'end'; anchorX = x - diag; top = y - diag - height; }
    else if (position === 'se') { anchor = 'start'; anchorX = x + diag; top = y + diag; }
    else { anchor = 'end'; anchorX = x - diag; top = y + diag; }
    anchorX += dx; top += dy;
    const left = anchor === 'start' ? anchorX : anchor === 'end' ? anchorX - width : anchorX - width / 2;
    let svg = '', cy = top;
    rows.forEach((row, i) => {
      let textX = anchorX;
      if (i === 0 && iconsW && anchor === 'middle') textX = anchorX - iconsW / 2;
      svg += `<text x="${round2dp(textX)}" y="${round2dp(cy + (rowHeights[i] - row.fs * 1.22) / 2 + row.fs * 0.9)}" text-anchor="${anchor}" font-size="${row.fs}" font-weight="${row.bold ? 700 : 500}" fill="${row.muted ? palette.muted : palette.ink}" stroke="${palette.paper}" stroke-width="3.2" stroke-linejoin="round" paint-order="stroke" font-family='${symbols.FONT}'>${TM.esc(row.text)}</text>`;
      if (i === 0 && iconsW) {
        const start = anchor === 'start' ? anchorX + firstWidth + 4 : anchor === 'end' ? anchorX - firstWidth - 4 - iconsW + 1 : textX + firstWidth / 2 + 4;
        icons.forEach((href, k) => { svg += `<image href="${href}" x="${round2dp(start + k * (iconSize + 3))}" y="${round2dp(cy + (rowHeights[0] - iconSize) / 2)}" width="${iconSize}" height="${iconSize}"/>`; });
      }
      cy += rowHeights[i];
    });
    const box = { x: left - 3, y: top - 2, w: width + 6, h: height + 4 }, rotation = options.rot || 0;
    if (!rotation) return { svg: svg, box, transform: '', hull: box };
    const pivotX = anchorX, pivotY = position === 'e' || position === 'w' ? top + height / 2 : position === 'n' || position === 'ne' || position === 'nw' ? top + height : top;
    return { svg: svg, box, transform: ` transform="rotate(${round2dp(rotation)} ${round2dp(pivotX)} ${round2dp(pivotY)})"`, hull: symbols.rotatedHull(box, rotation, pivotX, pivotY) };
  };
  /* Axis-aligned bounds of a rectangle {x,y,w,h} turned by deg about (px,py). */
  symbols.rotatedHull = (box, degrees, pivotX, pivotY) => {
    const radians = degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => [pivotX + (x - pivotX) * cos - (y - pivotY) * sin, pivotY + (x - pivotX) * sin + (y - pivotY) * cos]);
    const xValues = corners.map((p) => p[0]), yValues = corners.map((p) => p[1]);
    return { x: Math.min(...xValues), y: Math.min(...yValues), w: Math.max(...xValues) - Math.min(...xValues), h: Math.max(...yValues) - Math.min(...yValues) };
  };

  /* Line badge (code pill) shown beyond terminals. */
  symbols.badge = (x, y, text, color, palette) => {
    const width = Math.max(28, symbols.textWidth(text, 12) + 14);
    return `<g transform="translate(${round2dp(x)} ${round2dp(y)})"><rect x="${round2dp(-width / 2)}" y="-11" width="${round2dp(width)}" height="22" rx="7" fill="${color}" stroke="${palette.paper}" stroke-width="2"/>` +
      `<text y="4.3" text-anchor="middle" font-size="12" font-weight="800" fill="${symbols.contrast(color)}" font-family='${symbols.FONT}'>${TM.esc(text)}</text></g>`;
  };

  /* Line-end flag: the line runs on a little past its last station (dir: unit vector outwards) and ends in a box with
     its code inside. Returns { svg, cx, cy } — the box's centre. */
  symbols.flag = (x, y, dir, text, color, palette, lineW, at) => {
    const w = Math.max(22, symbols.textWidth(text, 12) + 10), h = 22, stub = 22;
    const half = Math.abs(dir.x) * w / 2 + Math.abs(dir.y) * h / 2;
    /* at: the box's centre when set by the caller (badges of several lines side by side) — the stub still runs straight on from the line */
    const cx = at ? at.cx : x + dir.x * (stub + half), cy = at ? at.cy : y + dir.y * (stub + half), reach = (cx - x) * dir.x + (cy - y) * dir.y;
    return { cx, cy, w, h, svg: `<path d="M${round2dp(x)} ${round2dp(y)} L${round2dp(x + dir.x * reach)} ${round2dp(y + dir.y * reach)}" stroke="${color}" stroke-width="${lineW || 8}" stroke-linecap="butt" fill="none"/>` +
      `<g transform="translate(${round2dp(cx)} ${round2dp(cy)})"><rect x="${round2dp(-w / 2)}" y="${-h / 2}" width="${round2dp(w)}" height="${h}" rx="4" fill="${color}"/>` +
      `<text y="4.3" text-anchor="middle" font-size="12" font-weight="800" fill="${symbols.contrast(color)}" font-family='${symbols.FONT}'>${TM.esc(text)}</text></g>` };
  };

  /* ---------- point markers on a line (TM.MARKS) ----------
     Drawn round the origin with the line running along +x (its own direction) and +y across it; W = the line's width.
     Returns { under, over }: what goes beneath the line's paint (a river's blue band) and what is drawn on top. */
  symbols.MARK_COLORS = { water: '#3a8fd9', customs: '#d6303a' };
  symbols.mark = (mk, W, palette) => {
    const r = (v) => round2dp(v), g = W / 2 + 3, rail = palette.muted, ink = palette.ink, paper = palette.paper;
    const stroke = (d, col, w, extra) => `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra || ''}/>`;
    const sideX = mk.s === 'b' ? -1 : 1;   // which way the tunnel / viaduct runs from here
    let under = '', over = '';
    if (mk.k === 'tunnel') {               // a portal: a bracket across the line, bulging into the tunnel — ")" … "("
      const h = W * 0.9 + 4, d = `M0 ${r(-h)}Q${r(sideX * h * 1.3)} 0 0 ${r(h)}`;
      over = stroke(d, paper, 5.5) + stroke(d, ink, 2.4);
    } else if (mk.k === 'viaduct') {       // the start / end of the rails along both sides, flared outwards
      const rg = (symbols.railWidth(W).outer + symbols.railWidth(W).inner) / 4;   // the middle of a rail
      [-1, 1].forEach((sy) => { const d = `M${r(-sideX * 5)} ${r(sy * (rg + 5))}L0 ${r(sy * rg)}L${r(sideX * 5)} ${r(sy * rg)}`; over += stroke(d, rail, 2); });
    } else if (mk.k === 'overbridge' || mk.k === 'water') {   // the line on a bridge: parapets on both sides, flared at both ends
      if (mk.k === 'water') under = stroke(`M0 ${r(-(g + 10))}L0 ${r(g + 10)}`, symbols.MARK_COLORS.water, 5, ' stroke-linecap="butt"');
      [-1, 1].forEach((sy) => { const d = `M-9 ${r(sy * (g + 4))}L-5 ${r(sy * g)}L5 ${r(sy * g)}L9 ${r(sy * (g + 4))}`; over += stroke(d, paper, 4.5) + stroke(d, rail, 2); });
    } else if (mk.k === 'underbridge') {   // a bridge over the line: its deck hides the line, parapets across it
      over = `<rect x="-4" y="${r(-(g + 3))}" width="8" height="${r(2 * (g + 3))}" fill="${paper}"/>`;
      [-1, 1].forEach((sx) => { over += stroke(`M${r(sx * 8)} ${r(-(g + 7))}L${r(sx * 4)} ${r(-(g + 3))}L${r(sx * 4)} ${r(g + 3)}L${r(sx * 8)} ${r(g + 7)}`, rail, 2); });
    } else if (mk.k === 'grade') {         // a road across at the same level
      const h = W * 1.3 + 2;
      over = stroke(`M0 ${r(-h)}L0 ${r(h)}`, paper, 6, ' stroke-linecap="butt"') + stroke(`M0 ${r(-h)}L0 ${r(h)}`, ink, 3, ' stroke-linecap="butt"');
    } else if (mk.k === 'border') {        // a dashed line across
      over = stroke(`M0 ${r(-(g + 8))}L0 ${r(g + 8)}`, ink, 2, ' stroke-dasharray="3 2.5" stroke-linecap="butt"');
    } else if (mk.k === 'customs') {       // ⊖ on the line
      const rad = W * 0.75 + 2.5;
      over = `<circle r="${r(rad)}" fill="${paper}" stroke="${symbols.MARK_COLORS.customs}" stroke-width="2.2"/>` + stroke(`M0 ${r(-rad * 0.55)}L0 ${r(rad * 0.55)}`, ink, 2.2);
    }
    return { under, over };
  };
  /* rails along both sides of an elevated stretch: drawn beneath the line, as wide as the line plus a gap each side */
  symbols.railWidth = (W) => ({ outer: W + 10, inner: W + 6 });   // two 2 px rails, 3 px off the line

  /* ---------- background drawings (store.drawing) ----------
     Points through which a drawing passes, as a dense polyline: straight between them, or a Catmull-Rom curve through
     them when smooth. */
  symbols.drawSamples = (pts, smooth, closed) => {
    const P = pts.map((p) => ({ x: p[0], y: p[1] }));
    if (!smooth || P.length < 3) return closed ? P.concat([P[0]]) : P;
    const n = P.length, at = (i) => (closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))]), out = [];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const steps = Math.max(4, Math.min(24, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 8)));
      for (let s = 0; s < steps; s++) {
        const t = s / steps, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
      }
    }
    out.push(closed ? out[0] : P[n - 1]);
    return out;
  };
  const pathOf = (samples, close) => samples.map((p, i) => `${i ? 'L' : 'M'}${round2dp(p.x)} ${round2dp(p.y)}`).join('') + (close ? 'Z' : '');
  /* One drawing as SVG: an area (a filled shape, optionally outlined) or a line of one width. */
  symbols.drawing = (d, attrs) => {
    const extra = attrs || '', op = d.opacity < 1 ? ` opacity="${d.opacity}"` : '';
    if (d.kind === 'area') {
      if (d.pts.length < 2) return `<g${extra}><circle cx="${d.pts[0][0]}" cy="${d.pts[0][1]}" r="4" fill="${d.color}"/></g>`;
      return `<g${extra}${op}><path d="${pathOf(symbols.drawSamples(d.pts, d.smooth, true), true)}" fill="${d.color}"${d.outline ? ` stroke="${d.outline}" stroke-width="2"` : ''} stroke-linejoin="round"/></g>`;
    }
    const samples = symbols.drawSamples(d.pts, d.smooth, false);
    return `<g${extra}${op}><path d="${pathOf(samples)}" fill="none" stroke="${d.color}" stroke-width="${d.width || 6}" stroke-linecap="round" stroke-linejoin="round"/>${samples.length < 2 ? `<circle cx="${samples[0].x}" cy="${samples[0].y}" r="${(d.width || 6) / 2}" fill="${d.color}"/>` : ''}</g>`;
  };

  /* A line's own picture used as its badge: { w, h } fitting its shape (28 px tall), and the picture itself centred on x, y. */
  symbols.pictureSize = (uri) => { const aspect = TM.imageAspect(uri) || 1, h = 28; return { w: Math.round(Math.min(4, Math.max(0.5, aspect)) * h), h }; };
  symbols.picture = (x, y, uri, size) => `<image href="${uri}" x="${round2dp(x - size.w / 2)}" y="${round2dp(y - size.h / 2)}" width="${size.w}" height="${size.h}" preserveAspectRatio="xMidYMid meet"/>`;

  /* Legend symbols an item can show (kind 'symbol'): key -> [default name, draw(y, colours), row height] */
  /* Legend symbols an item can show (kind 'symbol'): key -> [default name, draw(palette, centre y, colours), half its
     height]. Each row is as tall as its symbol plus a gap, the symbol and its name centred in it. */
  const mk2 = (style, items, extra) => (p, c) => symbols.multi(0, 0, Object.assign({ pal: p, style, items: items(c), axis: { x: 0, y: 1 } }, extra));
  const capsule = mk2('capsule', (c) => [{ color: c[0], num: '8' }, { color: c[1], num: '8' }], { showNum: true });
  const stack = mk2('stack', (c) => [{ color: c[0] }, { color: c[1] }, { color: c[2] }]);
  const chain = mk2('chain', (c) => [{ color: c[0], num: '8' }, { color: c[1], num: '17' }], { showNum: true });
  const at = (svg, cy) => `<g transform="translate(31 ${round2dp(cy)})">${svg}</g>`;
  symbols.LEGEND_SYMBOLS = {
    station: ['Station', (p, cy) => symbols.station(31, cy, { pal: p, kind: 'station', status: 'operational' }), 9],
    terminal: ['Terminus', (p, cy) => symbols.station(31, cy, { pal: p, kind: 'terminal', status: 'operational', dir: { x: 0, y: -1 } }), 9],
    disc: ['Larger circle', (p, cy, c) => symbols.station(31, cy, { pal: p, kind: 'disc', status: 'operational', fill: c[0] }), 15],
    tick: ['Station (tick)', (p, cy, c) => `<path d="M31 ${cy - 15}V${cy + 15}" stroke="${p.ink}" stroke-width="6"/>` + symbols.station(31, cy, { pal: p, kind: 'tick', status: 'operational', dir: { x: 1, y: 0 }, fill: p.ink, lineW: 6 }), 15],
    dash: ['Station (dash)', (p, cy, c) => `<path d="M31 ${cy - 13}V${cy + 13}" stroke="${p.ink}" stroke-width="6"/>` + symbols.station(31, cy, { pal: p, kind: 'dash', status: 'operational', dir: { x: 1, y: 0 }, fill: p.ink }), 13],
    number: ['Station number', (p, cy, c) => symbols.station(31, cy, { pal: p, kind: 'station', status: 'operational', num: '12', fill: c[0] }), 12],
    interchange: ['Interchange', (p, cy) => symbols.station(31, cy, { pal: p, kind: 'interchange', status: 'operational' }), 13],
    capsule: ['Interchange (capsule)', (p, cy, c) => at(capsule(p, c).svg, cy), 'capsule'],
    stack: ['Interchange (stacked)', (p, cy, c) => at(stack(p, c).svg, cy), 'stack'],
    chain: ['Interchange (linked)', (p, cy, c) => at(chain(p, c).svg, cy), 'chain'],
    link: ['Connecting stations', (p, cy) => symbols.connector({ x: 14, y: cy }, { x: 48, y: cy }, 'link', p) + symbols.station(14, cy, { pal: p, kind: 'station' }) + symbols.station(48, cy, { pal: p, kind: 'station' }), 9],
    connect: ['Unofficial connection', (p, cy) => symbols.connector({ x: 14, y: cy }, { x: 48, y: cy }, 'connect', p) + symbols.station(14, cy, { pal: p, kind: 'station' }) + symbols.station(48, cy, { pal: p, kind: 'station' }), 9],
    under_construction: ['Under construction', (p, cy) => symbols.station(31, cy, { pal: p, kind: 'station', status: 'under_construction' }), 9],
    provisional: ['Provisional', (p, cy) => symbols.station(31, cy, { pal: p, kind: 'station', status: 'provisional' }), 9],
    fantasy: ['Fantasy', (p, cy) => symbols.station(31, cy, { pal: p, kind: 'station', status: 'fantasy' }), 9],
    abandoned: ['Abandoned', (p, cy) => symbols.station(31, cy, { pal: p, kind: 'station', status: 'abandoned' }), 9],
    demolished: ['Demolished', (p, cy) => symbols.station(31, cy, { pal: p, kind: 'station', status: 'demolished' }), 9],
    /* point markers on a piece of vertical line, the stretch (tunnel / viaduct) running upwards from the marker */
    ...Object.fromEntries(Object.keys(TM.MARKS).map((k) => ['mk_' + k, [TM.MARKS[k].name, (p, cy, c) => {
      const range = TM.MARKS[k].range, rw = symbols.railWidth(6), top = cy - 19, bottom = cy + 19;
      const rails = range === 'elevated' ? `<path d="M31 ${cy}V${top}" stroke="${p.muted}" stroke-width="${rw.outer}"/><path d="M31 ${cy}V${top}" stroke="${p.paper}" stroke-width="${rw.inner}"/>` : '';
      const g = symbols.mark(TM.normMark({ k, s: 'a' }), 6, p), turn = (svg) => `<g transform="translate(31 ${cy}) rotate(-90)">${svg}</g>`;
      const line = range === 'tunnel' ? `<path d="M31 ${bottom}V${cy}" stroke="${c[0]}" stroke-width="6"/><path d="M31 ${cy}V${top}" stroke="${c[0]}" stroke-width="6" stroke-dasharray="2.7 2.4"/>` : `<path d="M31 ${bottom}V${top}" stroke="${c[0]}" stroke-width="6"/>`;
      return rails + turn(g.under) + line + turn(g.over);
    }, 19]])),
  };

  const LEGEND_DASH = { auto: ' stroke-dasharray="8 5"', dash: ' stroke-dasharray="8 5"', dashdot: ' stroke-dasharray="8 3 2 3"', hatch: ' stroke-dasharray="2.5 2.5"', solid: '', dotted: ' stroke-dasharray="0.1 6" stroke-linecap="round"' };
  symbols.LEGEND_STYLES = { solid: 'Solid', dash: 'Dashed', dashdot: 'Dash-dot', hatch: 'Stripes', dotted: 'Dotted' };
  /* the automatic legend: the given lines, then every symbol */
  symbols.defaultLegend = (lines) => [...lines.map((l) => ({ kind: 'line', line: l.id })), ...Object.keys(symbols.LEGEND_SYMBOLS).filter((k) => !k.startsWith('mk_')).map((k) => ({ kind: 'symbol', symbol: k }))];   // markers only when picked
  /* the line an item names: one of the given lines (already in their shown colours), else the map's own */
  const legendLine = (item, lines) => lines.find((l) => l.id === item.line) || (TM.store && TM.store.line(item.line));
  /* an item's name as shown: its own, else its default */
  symbols.legendLabel = (item, lines, lang) => {
    if (item.label) return item.label;
    if (item.kind === 'line') { const l = legendLine(item, lines || []); return l ? `${l.code} · ${TM.nameOf(l, lang)}` : 'Line'; }
    if (item.kind === 'symbol') return (symbols.LEGEND_SYMBOLS[item.symbol] || ['Symbol'])[0];
    if (item.kind === 'style') return symbols.LEGEND_STYLES[item.style] || 'Line';
    if (item.kind === 'image') { const im = TM.imageList.find((x) => x.file === item.file); return im ? im.name : 'Image'; }
    return '';
  };
  /* one item's picture, drawn with its centre line at y (x 14 – 48): returns { svg, h } */
  symbols.legendDraw = (palette, item, yy, lines, colours) => {
    if (item.kind === 'line') { const l = legendLine(item, lines); const c = item.color || (l ? (TM.lineColor ? TM.lineColor(l) : l.color) : palette.muted); return { svg: `<rect x="14" y="${yy - 3}" width="34" height="6" rx="3" fill="${c}"/>`, h: 22 }; }
    if (item.kind === 'style') return { svg: `<line x1="14" y1="${yy}" x2="48" y2="${yy}" stroke="${item.color || colours[0]}" stroke-width="6"${LEGEND_DASH[item.style] || ''}/>`, h: 22 };
    if (item.kind === 'image') { const uri = TM.images.get(item.file); return { svg: uri ? `<image href="${uri}" x="14" y="${yy - 11}" width="34" height="22" preserveAspectRatio="xMidYMid meet"/>` : '', h: 28 }; }
    const def = symbols.LEGEND_SYMBOLS[item.symbol];
    if (!def) return { svg: '', h: 22 };
    const c = item.color ? [item.color, colours[1], colours[2]] : colours;
    const half = typeof def[2] === 'number' ? def[2] : { capsule, stack, chain }[def[2]](palette, c).extent;   // an interchange's own size
    const h = Math.max(24, Math.ceil(2 * half + 10)), rowY = yy - 11 + h / 2;   // a row: the symbol plus a 10 px gap, centred
    return { svg: def[1](palette, rowY, c), h, rowY };
  };

  /* Legend as a self-contained SVG group: returns {svg,w,h}. items: the map's own legend (store.legend) — none: automatic. */
  symbols.legend = (palette, lines, lang, items) => {
    const textRow = (txt, yy, w) => `<text x="72" y="${yy + 4}" font-size="12" font-weight="${w || 500}" fill="${palette.ink}" font-family='${symbols.FONT}'>${TM.esc(txt)}</text>`;
    let y = 26, maxW = 0, svg = `<text x="14" y="${y - 4}" font-size="12" font-weight="800" letter-spacing=".08em" fill="${palette.muted}" font-family='${symbols.FONT}'>LEGEND</text>`;
    y += 14;
    const lineColours = lines.map((l) => l.color), colours = [lineColours[0] || '#e11d48', lineColours[1] || '#2563eb', lineColours[2] || '#16a34a'];
    let prev = null;
    (items || symbols.defaultLegend(lines)).forEach((item) => {
      if (prev === 'line' && item.kind !== 'line') y += 6;
      prev = item.kind;
      const label = symbols.legendLabel(item, lines, lang), drawn = symbols.legendDraw(palette, item, y, lines, colours), rowY = drawn.rowY != null ? drawn.rowY : y;
      svg += drawn.svg + textRow(label, rowY);
      maxW = Math.max(maxW, symbols.textWidth(label, 12)); y += drawn.h;
    });
    return { svg: svg, w: Math.max(230, Math.ceil(72 + maxW + 16)), h: y + 4 };   // as wide as its longest name, never cut off
  };
})(window.TM);
