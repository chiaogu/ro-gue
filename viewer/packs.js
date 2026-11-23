// Asset packs (scripts/pack.py) the player imports: each zip kept whole in the browser's own storage (the origin
// private file system; IndexedDB where that cannot be written), and an index of every file in them (IndexedDB:
// path → the pack, where its data is, its size, the recipe and version that made it). A newer pack takes over a
// path from an older one; a pack with no path left is deleted. The game's service worker answers /assets/<path>
// out of them (game/sw.js), the page imports them and asks what it lacks (game.js).
// A classic script (the service worker's importScripts, the page's <script>): self.Packs.
(() => {
  const DB = 'ro-packs';
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('files', { keyPath: 'p' });  // { p: path, k: pack file, o: offset, s: size, kind, rev } (s -1: the client has none)
      d.createObjectStore('packs', { keyPath: 'file' });  // { file, name, client, made, part, parts, count, where }
      d.createObjectStore('blobs');  // pack file → Blob (where: 'idb')
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { dbp = null; no(r.error); };
  }));
  const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const done = tx => new Promise((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => no(tx.error); });
  const get = async (store, key) => req((await open()).transaction(store).objectStore(store).get(key));
  const all = async store => req((await open()).transaction(store).objectStore(store).getAll());

  // a pack's pack.json (its last entry), found by the zip's central directory; null: not a pack
  async function meta(file) {
    const tail = Math.min(file.size, 65557), b = new DataView(await file.slice(file.size - tail).arrayBuffer());
    let e = -1;
    for (let i = tail - 22; i >= 0; i--) if (b.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) return null;
    const size = b.getUint32(e + 12, true), at = b.getUint32(e + 16, true);
    const cd = new DataView(await file.slice(at, at + size).arrayBuffer()), dec = new TextDecoder();
    let hit = null;
    for (let p = 0; p + 46 <= size && cd.getUint32(p, true) === 0x02014b50;) {
      const n = cd.getUint16(p + 28, true), x = cd.getUint16(p + 30, true), c = cd.getUint16(p + 32, true);
      if (n === 9 && dec.decode(new Uint8Array(cd.buffer, p + 46, n)) === 'pack.json')
        hit = { method: cd.getUint16(p + 10, true), size: cd.getUint32(p + 20, true), at: cd.getUint32(p + 42, true) };
      p += 46 + n + x + c;
    }
    if (!hit || hit.method !== 0) return null;
    const lh = new DataView(await file.slice(hit.at, hit.at + 30).arrayBuffer());
    const start = hit.at + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    try { return JSON.parse(await file.slice(start, start + hit.size).text()); } catch { return null; }
  }

  // the pack kept: in the private file system, written a piece at a time (progress: 0–1); else in IndexedDB
  async function keep(name, file, progress) {
    try {
      const dir = await navigator.storage.getDirectory(), fh = await dir.getFileHandle(name, { create: true });
      if (!fh.createWritable) throw new Error('no createWritable');
      const w = await fh.createWritable(), STEP = 16 << 20;
      for (let at = 0; at < file.size; at += STEP) {
        await w.write(file.slice(at, Math.min(file.size, at + STEP)));
        progress(Math.min(1, (at + STEP) / file.size));
      }
      await w.close();
      return 'opfs';
    } catch (e) {
      const tx = (await open()).transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(file, name);
      await done(tx);
      progress(1);
      return 'idb';
    }
  }
  async function drop(pk) {
    if (pk.where === 'opfs') await navigator.storage.getDirectory().then(d => d.removeEntry(pk.file)).catch(() => {});
    const tx = (await open()).transaction(['blobs', 'packs'], 'readwrite');
    tx.objectStore('blobs').delete(pk.file);
    tx.objectStore('packs').delete(pk.file);
    await done(tx);
  }

  // files (picked zips) → [{ file, name, made, count }]; progress({ file, at: 0–1, step }); throws on one that is
  // not a pack (none of them taken then)
  async function importPacks(files, progress = () => {}) {
    const got = [];
    for (const f of files) {
      const m = await meta(f);
      if (!m || m.format !== 1 || !m.files) throw new Error(`${f.name} 不是素材包`);
      got.push([f, m]);
    }
    got.sort((a, b) => a[1].made < b[1].made ? -1 : 1);  // (the newest last: it wins)
    const out = [];
    for (const [f, m] of got) {
      progress({ file: f.name, at: 0, step: '存檔' });
      const where = await keep(f.name, f, at => progress({ file: f.name, at, step: '存檔' }));
      progress({ file: f.name, at: 1, step: '建索引' });
      const packs = Object.fromEntries((await all('packs')).map(p => [p.file, p]));
      const old = new Map((await all('files')).map(e => [e.p, e]));
      const tx = (await open()).transaction(['files', 'packs'], 'readwrite'), fs = tx.objectStore('files');
      tx.objectStore('packs').put({ file: f.name, name: m.name, client: m.client, made: m.made, part: m.part, parts: m.parts,
        count: Object.keys(m.files).length, where });
      for (const [p, [o, s, kind, rev]] of Object.entries(m.files)) {
        const e = old.get(p), by = e && e.k !== f.name && packs[e.k];
        if (by && by.made > m.made) continue;  // (a newer pack has it)
        fs.put({ p, k: f.name, o, s, kind, rev });
      }
      // (what the client has no file for: known, not lacking; a file a pack has wins over it)
      for (const p of m.absent || []) if (!old.has(p) || old.get(p).s < 0) fs.put({ p, k: f.name, o: 0, s: -1 });
      await done(tx);
      out.push({ file: f.name, name: m.name, made: m.made, count: Object.keys(m.files).length });
    }
    // the packs no path points to any more: gone
    const used = new Set((await all('files')).map(e => e.k));
    for (const pk of await all('packs')) if (!used.has(pk.file)) await drop(pk);
    blobs.clear();
    return out;
  }

  // the packs kept, and what of `need` (asset paths) they do not have or have from an older recipe than `revs`'
  async function status(need = [], revs = {}) {
    const packs = await all('packs');
    if (!packs.length) return { packs, missing: need.slice(), old: [] };
    const have = new Map((await all('files')).map(e => [e.p, e]));
    const missing = [], old = [];
    for (const p of need) {
      const e = have.get(p);
      if (!e) missing.push(p);
      else if (revs[e.kind] && e.rev < revs[e.kind]) old.push(p);
    }
    return { packs, missing, old };
  }

  // every pack and the index gone
  async function clear() {
    for (const pk of await all('packs')) await drop(pk);
    const tx = (await open()).transaction('files', 'readwrite');
    tx.objectStore('files').clear();
    await done(tx);
    blobs.clear();
  }

  // a file out of the packs: a Blob, or null (the service worker's)
  const blobs = new Map();  // pack file → Promise of its Blob
  function blobOf(name) {
    if (!blobs.has(name)) blobs.set(name, (async () => {
      const pk = await get('packs', name);
      if (!pk) return null;
      if (pk.where === 'opfs') return (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
      return get('blobs', name);
    })().catch(() => { blobs.delete(name); return null; }));
    return blobs.get(name);
  }
  async function file(path) {
    const e = await get('files', path).catch(() => null);
    const b = e && e.s >= 0 && await blobOf(e.k);
    return b && e.s >= 0 ? b.slice(e.o, e.o + e.s) : null;
  }

  self.Packs = { importPacks, status, clear, file, meta, forget: () => blobs.clear() };
})();
