/* Minimal ZIP writer / reader (no library): files are deflated when the browser has CompressionStream, else stored. */
(function (TM) {
  const zip = (TM.zip = {});
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const MAX_ENTRY = 24 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;

  let table = null;
  const crc32 = (input) => {
    if (!table) { table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let value = n; for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[n] = value >>> 0; } }
    let crc = 0xffffffff;
    for (let i = 0; i < input.length; i++) crc = table[(crc ^ input[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const bytes = (v) => (typeof v === 'string' ? encoder.encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v));
  const pipe = async (input, stream, limit) => {
    const writer = stream.writable.getWriter();
    writer.write(input).catch(() => {}); writer.close().catch(() => {});
    const reader = stream.readable.getReader(), parts = [];
    let total = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > limit) { reader.cancel().catch(() => {}); throw new Error('A file inside the zip is too large'); }
      parts.push(chunk.value);
    }
    const out = new Uint8Array(total); let offset = 0;
    parts.forEach((p) => { out.set(p, offset); offset += p.length; });
    return out;
  };
  const deflate = async (u8) => { try { return typeof CompressionStream === 'undefined' ? null : await pipe(u8, new CompressionStream('deflate-raw'), u8.length + 1024); } catch (e) { return null; } };

  /* files: [{ path, data: string | Uint8Array }] → Blob */
  zip.build = async (files) => {
    const now = new Date(), time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
      date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = encoder.encode(f.path), data = bytes(f.data), crc = crc32(data);
      let comp = data.length > 64 ? await deflate(data) : null, method = 8;
      if (!comp || comp.length >= data.length) { comp = data; method = 0; }
      const localHeader = new DataView(new ArrayBuffer(30));
      localHeader.setUint32(0, 0x04034b50, true); localHeader.setUint16(4, 20, true); localHeader.setUint16(6, 0x0800, true); localHeader.setUint16(8, method, true);
      localHeader.setUint16(10, time, true); localHeader.setUint16(12, date, true); localHeader.setUint32(14, crc, true); localHeader.setUint32(18, comp.length, true); localHeader.setUint32(22, data.length, true); localHeader.setUint16(26, name.length, true);
      parts.push(new Uint8Array(localHeader.buffer), name, comp);
      const centralHeader = new DataView(new ArrayBuffer(46));
      centralHeader.setUint32(0, 0x02014b50, true); centralHeader.setUint16(4, 20, true); centralHeader.setUint16(6, 20, true); centralHeader.setUint16(8, 0x0800, true); centralHeader.setUint16(10, method, true);
      centralHeader.setUint16(12, time, true); centralHeader.setUint16(14, date, true); centralHeader.setUint32(16, crc, true); centralHeader.setUint32(20, comp.length, true); centralHeader.setUint32(24, data.length, true); centralHeader.setUint16(28, name.length, true);
      centralHeader.setUint32(42, offset, true);
      central.push(new Uint8Array(centralHeader.buffer), name);
      offset += 30 + name.length + comp.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  };

  /* ArrayBuffer → [{ path, data: Uint8Array }] (directories skipped) */
  zip.read = async (buffer) => {
    const array = new Uint8Array(buffer), view = new DataView(buffer);
    let e = -1;
    for (let i = array.length - 22; i >= Math.max(0, array.length - 22 - 65535); i--) if (view.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('This is not a zip file');
    const count = view.getUint16(e + 10, true);
    let position = view.getUint32(e + 16, true), total = 0;
    const out = [];
    for (let n = 0; n < count; n++) {
      if (view.getUint32(position, true) !== 0x02014b50) throw new Error('The zip file is damaged');
      const flags = view.getUint16(position + 8, true), method = view.getUint16(position + 10, true), csize = view.getUint32(position + 20, true), usize = view.getUint32(position + 24, true),
        nlen = view.getUint16(position + 28, true), elen = view.getUint16(position + 30, true), clen = view.getUint16(position + 32, true), off = view.getUint32(position + 42, true);
      const path = decoder.decode(array.subarray(position + 46, position + 46 + nlen));
      position += 46 + nlen + elen + clen;
      if (path.endsWith('/') || /(^|\/)__MACOSX\//.test(path) || /(^|\/)\.DS_Store$/.test(path)) continue;
      if (flags & 1) throw new Error('Encrypted zip files are not supported');
      if (usize > MAX_ENTRY || (total += usize) > MAX_TOTAL) throw new Error('The zip file is too large');
      const start = off + 30 + view.getUint16(off + 26, true) + view.getUint16(off + 28, true), raw = array.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed zip files');
        data = await pipe(raw, new DecompressionStream('deflate-raw'), MAX_ENTRY);
      } else throw new Error('Unsupported zip compression (method ' + method + ')');
      out.push({ path, data });
    }
    return out;
  };
  zip.text = (u8) => decoder.decode(u8);
})(window.TM);
