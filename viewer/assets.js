// The assets: what is made from the player's own Ragnarok Online client (scripts/), never committed.
//
// Text: the committed tables (jobs.json, equip.json, world.json) name things as rAthena does (English); the
// client's words are assets, scripts/clienttext.py's text/zh-TW/*.json, one plain table each ({id: text}), and
// localize puts them in over the committed ones as they load. Without them (no assets yet) the English stays.
// No DOM: the bench (Node) uses it too, with its own read.

export const BASE = new URL('../assets/', import.meta.url).href;
export const TEXT = 'text/zh-TW/';
export const TEXTS = ['items', 'itemdesc', 'skills', 'skilldesc', 'mobs', 'maps', 'talk', 'states'];

// {name: table} of the text the assets have (a missing one: {}); read: path under the assets → its JSON (else throw)
export async function loadText(read = p => fetch(BASE + p, { cache: 'no-cache' }).then(r => r.ok ? r.json() : Promise.reject(r.status))) {
  const got = await Promise.all(TEXTS.map(n => Promise.resolve().then(() => read(TEXT + n + '.json')).catch(() => ({}))));
  return Object.fromEntries(TEXTS.map((n, i) => [n, got[i] || {}]));
}

const has = (t, k) => t && Object.prototype.hasOwnProperty.call(t, k);
const name = (T, id, fallback) => (has(T.items, id) ? T.items[id] : fallback);

// each committed table, its client words put in (in place; the table returned)
export const localize = {
  // maps.json: the map tab's list (name, size, models), each map's name in the client's words
  maps(t, T) {
    for (const m of t.maps) m.zh = T.maps[m.name.toLowerCase()] || '';
    return t;
  },
  jobs(db, T) {
    for (const [k, s] of Object.entries(db.skills || {})) {
      if (T.skills[k]) s.zh = T.skills[k];
      if (has(T.skilldesc, k)) s.desc = T.skilldesc[k];
      if (has(T.talk, k)) s.talk = T.talk[k];
    }
    for (const sec of ['items', 'gear', 'armors', 'headgear']) for (const [id, x] of Object.entries(db[sec] || {})) x.name = name(T, id, x.name);
    for (const [id, c] of Object.entries(db.cards || {})) {
      c.name = T.items[id] || c.name;
      if (has(T.itemdesc, id)) c.desc = T.itemdesc[id];
    }
    return db;
  },
  equip(eq, T) {
    for (const sec of ['weapons', 'armors', 'ammo', 'cards']) for (const x of eq[sec] || []) {
      x.name = T.items[x.id] || x.name;
      if (has(T.itemdesc, x.id)) x.desc = T.itemdesc[x.id];
      for (const d of x.drops || []) d[1] = T.mobs[d[0]] || d[1];
    }
    for (const sh of eq.shops || []) if (!sh.city) sh.town = T.maps[sh.map] || sh.town;
    return eq;
  },
  // states.json (scripts/states.py): each status icon's words (text: {efst: [name, line, ...]}, the client's)
  states(t, T) {
    t.text = T.states || {};
    return t;
  },
  world(w, T) {
    for (const [m, x] of Object.entries(w.maps || {})) x.zh = T.maps[m] || x.zh;
    for (const [id, x] of Object.entries(w.mobs || {})) {
      x.zh = T.mobs[id] || x.zh;
      for (const d of [...x.drops || [], ...x.mvpDrops || []]) if (d[3] != null) d[0] = T.items[d[3]] || d[0];
    }
    for (const k of Object.keys(w.skills || {})) w.skills[k] = T.skills[k] || w.skills[k];
    return w;
  },
};

// a committed table (url, fetched) with the client's words put in: kind is localize's
export async function loadTable(url, kind, text = loadText()) {
  const [t, T] = await Promise.all([fetch(url, { cache: 'no-cache' }).then(r => r.ok ? r.json() : Promise.reject(url + ' ' + r.status)), text]);
  return localize[kind](t, T);
}
