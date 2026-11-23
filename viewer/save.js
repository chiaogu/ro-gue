// Saves the battle sandbox's files for offline use, off the page's main thread. index.html sends what to
// save and hears back how far it got.
//   in:  { sprites: [[folder, dyes], ...], files: [path, ...], wav, cache }  (paths from the repo root; dyes: with
//        the dye/ colours too; cache: the cache to save into, 'assets' (sw.js's) unless given: the game's is its own)
//   out: { done, total } as it goes, then { done, total, finished: true, failed }
// A sprite is one request, serve.sh's /bundle (its act.json and frames in one response), saved as one cache
// entry, <folder>/.bundle, that sw.js cuts the files out of: file by file, the phone would make over 70,000
// requests and cache writes. The sounds its act.json names, and the other files, are saved one by one. The
// requests are marked x-save, which sw.js leaves to the network. What is saved already is skipped, so an
// interrupted run goes on where it stopped.
'use strict';
const url = p => encodeURI('../assets/' + p).replace(/#/g, '%23');
const req = p => new Request(p.startsWith('bundle?') ? '../' + p : url(p), { headers: { 'x-save': '1' } });

onmessage = async ({ data: { sprites, files, wav, cache: name = 'assets' } }) => {
  const cache = await caches.open(name), extra = new Set(files);
  const st = { done: 0, total: sprites.length, failed: false };
  let last = 0;
  const tell = () => { const now = Date.now(); if (now - last > 250) { last = now; postMessage(st); } };
  const pool = async (items, job) => {  // six at a time; stops at the first unreachable file
    let i = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < items.length && !st.failed) {
        if (!await job(items[i++])) st.failed = true;
        st.done++; tell();
      }
    }));
  };
  // false when the server cannot be reached; a file it does not have is passed over
  const save = async (p, key = url(p)) => {
    try {
      let r = await cache.match(key);
      if (!r) {
        r = await fetch(req(p));
        if (!r.ok) return true;
        await cache.put(key, r.clone());
      }
      return r;
    } catch (e) { return false; }
  };
  await pool(sprites, async ([dir, dyes]) => {
    const r = await save('bundle?dir=' + encodeURIComponent(dir) + (dyes ? '&dyes=1' : ''), url(dir + '/.bundle'));
    if (!(r instanceof Response)) return r;
    try {  // the sounds its act.json names
      const blob = await r.blob(), n = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0);
      const at = JSON.parse(await blob.slice(4, 4 + n).text())['act.json'];
      const act = JSON.parse(await blob.slice(4 + n + at[0], 4 + n + at[0] + at[1]).text());
      for (const s of act.sounds || []) if (s && s !== 'atk') extra.add(wav + '/' + s.replace(/\\/g, '/'));
    } catch (e) {}
    return true;
  });
  st.total += extra.size;
  if (!st.failed) await pool([...extra], async p => !!await save(p));
  postMessage({ ...st, finished: true });
};
