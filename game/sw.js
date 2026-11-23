// Offline support for the game, apart from the viewer's (viewer/sw.js: its own scope, /viewer/, and its own caches):
// the game's files and the viewer modules it is built on are saved when the worker installs, and every sprite,
// sound, texture and map the game loads is kept as it goes, so what was played once plays again with no server.
// - code and data (game/, viewer/ but its vendor/, the map indexes): network first (edits still show on reload),
//   the saved copy when the server does not answer within NET_WAIT
// - assets (/assets/: png/, map/, the client's files; vendor/): out of the asset packs the player imported
//   (viewer/packs.js) first, else the saved copy, checked afterwards
// Cache keys drop the query: index.html imports its modules with ?v=<load time>.
importScripts('../viewer/packs.js');
const SHELL = 'game-shell', ASSETS = 'game-assets', NET_WAIT = 3000;
const V = '../viewer/';
const OWN = ['./', 'index.html', 'game.js', 'places.js', 'needs.js', 'mapsim.js', 'townfolk.js', 'manifest.webmanifest', 'version.json']
  .concat(['sim.js', 'grid.js', 'battle.js', 'arena.js', 'walker.js', 'effects.js', 'map.js', 'levels.js', 'fight.js', 'rng.js',
    'builds.js', 'look.js', 'stage.js', 'mapsim.js', 'cards.js', 'devlog.js', 'assets.js', 'packs.js', 'jobs.json', 'states.json', 'index.json', 'floors.json', 'npcs.json', 'bgm.json', 'bench/chains.json', 'bench/chain.json',
    'icon-180.png', 'icon-192.png', 'icon-512.png',
    'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/three/addons/controls/OrbitControls.js',
    'vendor/three/addons/loaders/GLTFLoader.js', 'vendor/three/addons/utils/BufferGeometryUtils.js',
    'vendor/three/addons/utils/SkeletonUtils.js'].map(f => V + f))
  .concat(['../manifests/revs.json', '../assets/png/ui/logo.png']);
const GAME = new URL('./', self.location).pathname;                 // /game/
const VIEWER = new URL(V, self.location).pathname;                  // /viewer/
const ASSET_PNG = new URL('../assets/png/', self.location).pathname;
const ASSET = new URL('../assets/', self.location).pathname;          // /assets/

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL)
    .then(c => Promise.all(OWN.map(f => fetch(f, { cache: 'no-store' }).then(r => r.ok && c.put(new URL(f, self.location).href, r)).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const key = req => { const u = new URL(req.url); u.search = ''; return u.href; };
const put = (name, req, res) => { if (res.ok && res.status === 200) caches.open(name).then(c => c.put(key(req), res)); };
// (only the game's caches: the viewer's, on the same origin, are left alone)
const match = async (name, k) => (await caches.open(name)).match(k);

// Once the server has not answered one (late or failed), the rest go to the saved copy at once for UNREACHED ms
// (the page's modules import one another, each else waited NET_WAIT), the server still asked in the background
// for next time; one it answers in time ends that.
// While the page saves for offline play (選項 › 離線) it says so ('saving', every few seconds: savingUntil) and none of
// that applies: its hundreds of requests queue for the server's few connections, so many take longer than NET_WAIT
// though the server is there (by request: the effects, loaded through here, were not all saved).
const UNREACHED = 30000, SAVING = 15000;
let unreachedUntil = 0, savingUntil = 0;
const saving = () => Date.now() < savingUntil;
const late = () => new Promise(ok => { if (!saving()) setTimeout(ok, NET_WAIT, 'late'); });
async function networkFirst(req, e) {
  const net = fetch(req).then(res => { put(SHELL, req, res.clone()); unreachedUntil = 0; return res; });
  if (Date.now() < unreachedUntil && !saving()) {
    const hit = await match(SHELL, key(req));
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  }
  // a server that is asleep or out of Wi-Fi range can leave the request hanging instead of failing
  try {
    const res = await Promise.race([net, late()]);
    if (res !== 'late') return res;
  } catch {}
  unreachedUntil = Date.now() + UNREACHED;
  const hit = await match(SHELL, key(req)) ||
    (req.mode === 'navigate' ? await match(SHELL, new URL('index.html', self.location).href) : undefined);
  return hit || net.catch(() => Response.error());
}

// A sprite saved for offline play (選項 › 離線: viewer/save.js, told to save into ASSETS) is one cache entry,
// <folder>/.bundle (serve.sh's /bundle: a 4-byte length, a JSON index {path in the folder: [offset, length]}, the
// files); its act.json and frames are cut out of it, as viewer/sw.js does. Bundles are not checked with the server:
// after rebuilding sprites, clear the saved files (選項 › 離線 › 清除) and save them again.
const bundles = new Map();  // folder URL → Promise of { blob, index, base } (the last 200 used)
const TYPES = { png: 'image/png', json: 'application/json' };
function bundle(dir) {
  let b = bundles.get(dir);
  if (b) bundles.delete(dir);  // most recent last
  else b = match(ASSETS, dir + '/.bundle').then(async r => {
    if (!r) return null;
    const blob = await r.blob(), n = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0);
    return { blob, index: JSON.parse(await blob.slice(4, 4 + n).text()), base: 4 + n };
  });
  bundles.set(dir, b);
  if (bundles.size > 200) bundles.delete(bundles.keys().next().value);
  b.then(x => { if (!x) bundles.delete(dir); });  // not saved (yet): ask again next time
  return b;
}
async function fromBundle(u) {
  const m = u.pathname.startsWith(ASSET_PNG) && u.pathname.match(/^(.+?\/png\/.+?)\/(act\.json|frames\/.+|dye\/.+)$/);
  const b = m && await bundle(u.origin + m[1]), at = b && b.index[decodeURIComponent(m[2])];
  if (!at) return null;
  return new Response(b.blob.slice(b.base + at[0], b.base + at[0] + at[1]),
    { headers: { 'Content-Type': TYPES[m[2].split('.').pop()] || '' } });
}

// the saved copy at once; with the server in reach, it is asked (If-Modified-Since, so mostly a 304) whether
// the file changed since, and a newer one is saved for next time: sprites rebuilt on the Mac reach the phone
const TYPE = { png: 'image/png', jpg: 'image/jpeg', json: 'application/json', glb: 'model/gltf-binary', mp3: 'audio/mpeg',
  wav: 'audio/wav', bmp: 'image/bmp', tga: 'image/x-tga' };
async function fromPack(u) {
  if (!u.pathname.startsWith(ASSET)) return null;
  const p = decodeURIComponent(u.pathname.slice(ASSET.length)), b = await Packs.file(p);
  return b && new Response(b, { headers: { 'Content-Type': TYPE[p.split('.').pop().toLowerCase()] || 'application/octet-stream' } });
}
async function cacheFirst(req, e) {
  const packed = await fromPack(new URL(req.url));
  if (packed) return packed;
  const part = await fromBundle(new URL(req.url));
  if (part) return part;
  const hit = await match(ASSETS, key(req)) || await match(SHELL, key(req));
  if (hit) {
    e.waitUntil(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.headers.get('last-modified') !== hit.headers.get('last-modified')) put(ASSETS, req, res);
    }).catch(() => {}));
    return hit;
  }
  // one not saved: from the server, unless it is out of reach (unreachedUntil), or does not answer within
  // NET_WAIT, so it fails rather than leave the game waiting on it
  if (Date.now() < unreachedUntil && !saving()) return Response.error();
  const net = fetch(req).then(res => { put(ASSETS, req, res.clone()); unreachedUntil = 0; return res; });
  const res = await Promise.race([net, late()]).catch(() => null);
  if (res && res !== 'late') return res;
  unreachedUntil = Date.now() + UNREACHED;
  e.waitUntil(net.catch(() => {}));
  return Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url), p = u.pathname;
  // Range requests go to the network as they are, and so does the page's own saving for offline play (x-save;
  // viewer/save.js stores those itself)
  if (req.method !== 'GET' || u.origin !== self.location.origin || req.headers.has('range') || req.headers.has('x-save')) return;
  const own = p.startsWith(GAME) || p.startsWith(VIEWER) && !p.startsWith(VIEWER + 'vendor/') && !/\.png$/.test(p);
  e.respondWith(own ? networkFirst(req, e) : cacheFirst(req, e));
});

// the page says it is saving (see savingUntil), or asks to forget the saved assets (選項 › 離線 › 清除), and hears
// back once they are gone
self.addEventListener('message', async e => {
  if (e.data === 'saving') { savingUntil = Date.now() + SAVING; unreachedUntil = 0; return; }
  if (e.data === 'packs') { Packs.forget(); return; }  // (packs imported or cleared: the files open on them dropped)
  if (e.data !== 'clear') return;
  await caches.delete(ASSETS);
  bundles.clear();
  e.source.postMessage('cleared');
});
