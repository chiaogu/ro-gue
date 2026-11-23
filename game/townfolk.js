// Townsfolk (by request): other players going about the town while the party gets ready, only for show — their jobs,
// sexes, hairstyles and hair colours picked at random. Some walk in and sit down a while, some walk straight across,
// some walk in, stand a little and walk off; now and then one shows an emote or uses a skill of its job's. They come
// in from off the screen and go off it again (by request): they walk the town's own GAT (its .gat from the client's
// data) AROUND cells about the patch, beyond what is seen (the patch's floor shows MARGIN cells of the town about
// it: scripts/map2gltf.py); without it, the patch only, fading in and out at its edge. Drawn as props: no click
// falls on them, the camera does not follow them and the edge's wall does not light for them. Stepped by game.js's
// loop at the town's clock (step), begun as the party gets to town (start) and gone as it leaves (stop).
// The town's NPCs stand there too (by request): where rAthena's scripts put them, facing their way, in their sprites
// (scripts/townnpc.py: viewer/npcs.json, png/npc), the patch's and those about it within the folk's AROUND.
import * as A from '../viewer/arena.js';
import * as E from '../viewer/effects.js';
import * as LOOK from '../viewer/look.js';
import * as stage from '../viewer/stage.js';
import { Mover, findPath, parseGat, walkable } from '../viewer/grid.js';
import { keyed, spriteId, lookKey } from '../viewer/walker.js';
import { W } from '../viewer/sim.js';

const MOST = 8, MOST_SITTING = 3;       // folk on the patch at once, and of them sitting
const COME_MS = [1500, 5000];           // between one coming in and the next
const FADE_MS = 500;                    // fading in at the edge, and out
const STAND_MS = [2000, 6000], SIT_MS = [15000, 40000];  // a stop's length, a sit's
const DO_MS = [4000, 10000];            // between one's emotes or skills while it stays
const AROUND = 14;                      // cells about the patch they walk (off the screen)
const TOP = 95;                         // (sprite px above the feet, as stage.js's PC_TOP)
// the emotes they show (clif_emotion's ET_ ids: E.EMOTE_ACTION)
const EMOTES = [0, 1, 2, 3, 4, 5, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 26, 28, 29, 30, 31];
// the skills a job line can show off in town (on itself), and their effects (as stage.js's SKILL_EFFECTS)
const SKILLS = {
  검사: [['SM_ENDURE', 'EF_ENDURE']],
  궁수: [['AC_CONCENTRATION', 'EF_CONCENTRATION']],
  마법사: [['MG_SIGHT', 'EF_SIGHT', 3000], ['MG_ENERGYCOAT', 'EF_ENERGYCOAT']],
  성직자: [['AL_HEAL', 'EF_HEAL'], ['AL_INCAGI', 'EF_INCAGILITY'], ['AL_BLESSING', 'EF_BLESSING'], ['AL_ANGELUS', 'EF_ANGELUS']],
  상인: [['MC_LOUD', 'EF_LOUD']],
};
const SKILL_GROUP = 12;  // the skill action

let db = null, dataDir = '', jobs = [], folk = [], now = 0, nextAt = 0, uid = 0;
let npcList = null, npcs = [];  // (npcs.json, once fetched; the ones standing now: { n, w, spr })
// rAthena's dir (0 north, counter-clockwise) as a heading (+y north)
const DIRS = [[0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1]];
// where they walk: map (a Mover's: its GAT, pos the patch's south-west cell AROUND cells in), M (AROUND, or 0: the
// patch's own field)
let area = null, gen = 0;
// while the party recruits (keepOut): area's map with the patch and KEEP_OUT cells about it shut, for the folk to
// walk about it off the screen
let outer = null;
const KEEP_OUT = 3;
const gats = new Map();  // town → a promise of its GAT
const rand = ([a, b]) => a + Math.random() * (b - a);
const pick = list => list[Math.floor(Math.random() * list.length)];

// o: db (jobs.json, for the skills' names), index (viewer/index.json: the jobs and their bodies), dataDir (the
// client's extracted data/: the towns' .gat)
export function init(o) {
  db = o.db;
  dataDir = o.dataDir;
  jobs = o.index.jobs.filter(n => !/^other:/.test(n.id));
  for (const list of Object.values(SKILLS)) for (const [, fx] of list) E.preload(fx);
  npcList = fetch(new URL('../viewer/npcs.json', import.meta.url)).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  E.preload('EF_EMOTE');
}

// the town's folk begun at time t on the floor now shown, win: its patch of the town ({ map, x, y } as floors.json
// has it; null: none, the field alone): a couple already sitting about; crowd false: no folk, only its NPCs and
// room for the game's actors to walk (the training ground, a job change room); around: the cells about the patch
// they walk (AROUND; more for a job room's door far off it)
export async function start(t, win = null, crowd = true, around = AROUND) {
  stop();
  const my = ++gen;
  now = t;
  nextAt = crowd ? t + rand(COME_MS) : Infinity;
  area = { map: W.field.map, M: 0 };
  const big = win && await townArea(win, around);
  if (my !== gen) return;
  if (big) area = big;
  await showNpcs(win);
  if (my !== gen) return;
  for (let i = 0, n = crowd ? 1 + Math.floor(Math.random() * 2) : 0; i < n; i++) {
    const at = spot();
    if (!at) break;
    const f = make();
    f.w.spawn(area.map, ...at);
    f.w.heading = pick([[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]);
    f.born = t - FADE_MS;
    stay(f, 'sit');
    f.until = t + rand(SIT_MS) / 2;
  }
}
// all of them gone (leaving the town)
export function stop() {
  for (const f of folk) A.remove(f.w);
  for (const n of npcs) A.remove(n.w);
  npcs = [];
  folk = [];
  area = null;
  outer = null;
  gen++;
}
// the patch of the town and AROUND cells about it as a map to walk ({ map, M }), its heights as the patch's floor
// has them (less the height its middle was taken down by: the town's GAT and the field's differ by that at a cell)
async function townArea(win, M = AROUND) {
  if (!gats.has(win.map))
    gats.set(win.map, fetch(LOOK.url(dataDir + '/' + win.map + '.gat')).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status)).then(parseGat)
      .catch(err => { console.warn('town GAT', win.map, err); gats.delete(win.map); return null; }));
  const full = await gats.get(win.map), fg = W.field.map.gat;
  if (!full) return null;
  const n = fg.w + 2 * M, h0 = full.heights[(win.y * full.w + win.x) * 4] - fg.heights[0];
  const gat = { w: n, h: n, heights: new Float32Array(n * n * 4), walk: new Uint8Array(n * n), wall: new Uint8Array(n * n), walls: 0 };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const gx = win.x - M + x, gy = win.y - M + y;
    if (gx < 0 || gy < 0 || gx >= full.w || gy >= full.h) continue;
    const i = y * n + x, j = gy * full.w + gx;
    gat.walk[i] = full.walk[j];
    for (let k = 0; k < 4; k++) gat.heights[i * 4 + k] = full.heights[j * 4 + k] - h0;
  }
  return { map: { name: 'town', pos: { x: -M, y: -M, h: 0 }, gat }, M };
}

// The NPCs of town patch win ({ map, x, y }) and about it, in the patch's cells (as lineUp takes them):
// [{ x, y, dir, name, sprite }]
export async function npcsNear(win) {
  const all = win ? (await npcList || {})[win.map] || [] : [], M = AROUND, n = W.field.w;
  return all.map(o => ({ ...o, x: o.x - win.x, y: o.y - win.y })).filter(o => o.x >= -M && o.y >= -M && o.x < n + M && o.y < n + M);
}
// the NPCs put on the town (area: about the patch, or the patch alone), each in its sprite as that comes in
async function showNpcs(win) {
  for (const o of await npcsNear(win)) {
    const x = o.x + area.M, y = o.y + area.M, g = area.map.gat;
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
    const w = new Mover(), n = { o, w, spr: null };
    w.spawn(area.map, x, y);
    w.cell = [x, y]; w.pos = [x + 0.5, y + 0.5];  // (where it stands, a cell no one walks on too: behind a counter)
    w.heading = DIRS[o.dir];
    w.top = TOP;
    LOOK.loadSprite('npc' + uid++, 'png/npc/' + o.sprite, null, spr => { n.spr = spr; }).catch(() => {});
    A.show(w, keyed((g, group, dir, clock, same) => drawNpc(n, g, dir, same)), 'prop');
    npcs.push(n);
  }
}
// NPC n facing `dir` on the screen (a sprite with one way only: that one), its standing frames looping
// (same: painted only when that changes, walker.js keyed)
function drawNpc(n, g, dir, same) {
  const acts = n.spr && n.spr.act.actions, ai = acts && (acts.length >= 8 ? dir : 0), act = acts && acts[ai];
  if (!act || !act.frames.length) return false;
  const fi = Math.floor(now / Math.max(1, act.delay_ms || 100)) % act.frames.length;
  if (same(`${ai}:${fi}:${spriteId(n.spr)}`)) return true;
  LOOK.drawFrame(n.spr, act.frames[fi], 0, 0, null, g);
  return true;
}

// the town at time t
export function step(t) {
  const dt = Math.max(0, t - now);
  now = t;
  if (!area) return;
  if (t >= nextAt) {
    nextAt = t + rand(COME_MS);
    if (folk.length < MOST) come();
  }
  for (const f of [...folk]) {
    f.w.advance(dt);
    if (f.actor && f.gone == null) { f.w.alpha = Math.min(1, (t - f.born) / FADE_MS); continue; }  // (the game moves it: actor)
    if (f.gone != null) {
      if (t - f.gone >= FADE_MS) { A.remove(f.w); folk.splice(folk.indexOf(f), 1); }
    } else if (f.state === 'stay') {
      if (t >= f.until) go(f);
      else if (t >= f.doAt) { f.doAt = t + rand(DO_MS); act(f); }
    } else if (f.state === 'walk' && f.emoteAt != null && t >= f.emoteAt) { f.emoteAt = null; emote(f); }
    f.w.alpha = Math.max(0, Math.min(1, (t - f.born) / FADE_MS, f.gone != null ? 1 - (t - f.gone) / FADE_MS : 1));
  }
}

// a townsman's job (by request): one up to the second jobs (index.json tier ≤ 2: the Novice, the first and second
// jobs) most of the time, a transcendent, third or fourth one (tier 3–5) LATE_SHARE of the time
const LATE_SHARE = 0.2;
const pickJob = () => {
  const late = jobs.filter(n => n.tier >= 3), early = jobs.filter(n => n.tier <= 2);
  return pick(late.length && (Math.random() < LATE_SHARE || !early.length) ? late : early);
};
// a new one, its look loading (not on the floor yet)
function make() {
  const node = pickJob(), sexes = Object.keys(node.bodies);
  const look = { id: 'folk' + uid++, sex: pick(sexes), job: node.id, weapon: LOOK.defaultWeapon(node.id) || '', hair: null, hdye: null };
  LOOK.loadLook(look, () => {});
  const w = new Mover();
  w.cellMs = rand([140, 190]);
  w.alpha = 0;
  w.top = TOP;
  const f = { look, w, line: lineOf(node), state: 'walk', born: now, gone: null, sitting: false, anim: null };
  A.show(w, keyed((g, group, dir, clock, same) => draw(f, g, group, dir, clock, same)), 'prop');
  folk.push(f);
  return f;
}
// the first job its job comes from (its skills: SKILLS)
function lineOf(node) {
  const byId = Object.fromEntries(jobs.map(n => [n.id, n]));
  for (let n = node; n; n = byId[n.parent]) if (SKILLS[n.id]) return n.id;
  return null;
}
// one comes in at an edge: to walk across, to stop a while or to sit down
function come() {
  const edges = edgeCells();
  if (edges.length < 2) return;
  if (outer?.none) return;
  const sitting = folk.filter(f => f.kind === 'sit').length, r = Math.random();
  const kind = outer ? 'pass' : r < 0.35 && sitting < MOST_SITTING ? 'sit' : r < 0.65 ? 'stop' : 'pass';
  // (a way there tried a few times: some edge cells lead nowhere, behind a wall)
  let from = null, to = null;
  for (let i = 0; i < 6 && !to; i++) {
    from = pick(edges);
    to = kind === 'pass' ? across(edges, from) : spot();
    if (to && !findPath(walkMap().gat, ...from, ...to)) to = null;
  }
  if (!to) return;
  const f = make();
  f.kind = kind;
  f.w.spawn(walkMap(), ...from);
  if (!f.w.walkTo(...to, () => kind === 'pass' ? leave(f) : stay(f, kind))) return leave(f);
  f.target = to;
  if (kind === 'pass' && Math.random() < 0.3) f.emoteAt = now + rand([2500, 5000]);  // (on the screen by then)
}
// stopping (kind 'stop') or sitting down ('sit') where it walked to, for a while
function stay(f, kind) {
  f.kind = kind;
  f.state = 'stay';
  f.sitting = kind === 'sit';
  f.until = now + rand(kind === 'sit' ? SIT_MS : STAND_MS);
  f.doAt = now + (kind === 'sit' ? rand(DO_MS) : rand([400, 1500]));
  // (one stopping does something only now and then: once, if at all)
  if (kind === 'stop' && Math.random() < 0.4) f.doAt = Infinity;
}
// getting up and walking off to an edge
function go(f) {
  f.sitting = false;
  f.state = 'walk';
  f.target = null;
  // (one of the nearer third of the edge's cells)
  const edges = edgeCells().sort((a, b) => dist(a, f.w.cell) - dist(b, f.w.cell));
  const to = edges.length ? pick(edges.slice(0, Math.max(1, Math.ceil(edges.length / 3)))) : null;
  if (!to || !f.w.walkTo(...to, () => leave(f))) leave(f);
}
function leave(f) {
  if (f.gone == null) f.gone = now;
}
// an emote, or (standing, now and then) a skill of its job's
function act(f) {
  if (f.kind === 'stop') f.doAt = Infinity;
  const skills = SKILLS[f.line];
  if (skills && !f.sitting && Math.random() < 0.6) return skill(f, pick(skills));
  emote(f);
}
function emote(f) {
  const action = E.EMOTE_ACTION[pick(EMOTES)];
  if (action != null && action < 1000) E.play('EF_EMOTE', f.w, now, undefined, { head: TOP, action });
}
function skill(f, [name, fx, ms]) {
  const sk = db.skills[name] || {}, body = f.look.ch.body;
  stage.emit('say', f.w, (sk.zh || sk.en || name) + '!!', now);
  const act = body && body.act.actions[SKILL_GROUP * 8];
  const fd = Math.max(1, act && act.delay_ms || 100), n = act ? act.frames.length : 1;
  f.anim = { group: SKILL_GROUP, start: now, fd, end: now + n * fd + 300 };
  E.play(fx, f.w, now, ms, { head: TOP });
}

// its figure: walking, a skill's motion, sitting or standing
function draw(f, g, group, dir, clock, same) {
  const body = f.look.ch.body;
  if (!body) return false;
  const acts = body.act.actions;
  let grp = 0, fi = 0;
  if (group === 1) grp = 1;
  else if (f.anim && now < f.anim.end) grp = f.anim.group;
  else if (f.sitting) grp = 2;
  const act = acts[grp * 8 + dir];
  if (!act || !act.frames.length) return false;
  const n = act.frames.length;
  if (grp === 1) fi = Math.floor(clock / Math.max(1, act.delay_ms || 100)) % n;
  else if (grp === f.anim?.group) fi = Math.min(n - 1, Math.floor((now - f.anim.start) / f.anim.fd));
  if (same(`${grp * 8 + dir}:${fi}:${lookKey(f.look.ch)}`)) return true;
  LOOK.drawHuman(g, grp * 8 + dir, fi, f.look.ch);
  return true;
}

// The folk kept off the patch and KEEP_OUT cells about it (on), by request while the party recruits: those on it
// walk off, the rest go round it, and those coming only pass by round it; without the town's GAT about the patch
// (nowhere off the screen to walk) those on it walk off and none come. Off: as before.
export function keepOut(on) {
  if (!area) return;
  if (!on) { outer = null; return; }
  if (outer) return;
  const g = area.map.gat, M = area.M, walk = new Uint8Array(g.walk), lo = M - KEEP_OUT, hiX = M + W.field.w + KEEP_OUT, hiY = M + W.field.h + KEEP_OUT;
  const inside = ([x, y]) => x >= lo && x < hiX && y >= lo && y < hiY;
  if (M) for (let y = Math.max(0, lo); y < Math.min(g.h, hiY); y++) for (let x = Math.max(0, lo); x < Math.min(g.w, hiX); x++) walk[y * g.w + x] = 0;
  outer = M ? { ...area.map, gat: { ...g, walk }, inside } : { inside, none: true };
  for (const f of folk) {
    if (f.actor || f.gone != null) continue;
    if (inside(f.w.cell) || outer.none) { go(f); continue; }
    f.w.map = outer;  // (the same cells: only where it may walk differs)
    if (f.state === 'stay') go(f);
    else if (f.target && !f.w.walkTo(...f.target, f.w.onArrive)) go(f);
  }
}
const walkMap = () => outer && !outer.none ? outer : area.map;

// ---------- actors (by request: 招募) ----------
// One the game moves itself, as a character of the party is drawn (look: loaded), clickable unless `prop`: standing
// on field cell `at`, or (null) coming in at the edge of where the folk walk, nearest field cell `toward` (with
// `within`: put down on the way from there, the first cell of it that many cells or fewer from `toward`, so its walk in is
// short: by request) → its handle (f; f.w its mover), or null when there is no town to walk. Field cells are the
// party's (W.field's); the folk's map has AROUND more on each side.
export function actor(look, at = null, toward = null, prop = false, within = null) {
  if (!area) return null;
  const w = new Mover();
  w.cellMs = 150;
  w.top = TOP;
  const f = { look, w, actor: true, state: 'act', born: at ? now - FADE_MS : now, gone: null, sitting: false, anim: null };
  A.show(w, keyed((g, group, dir, clock, same) => draw(f, g, group, dir, clock, same)), prop ? 'prop' : true);
  folk.push(f);
  let from = at && toArea(at);
  if (!from) {
    const edges = edgeCells(), goal = toward ? toArea(toward) : [area.map.gat.w / 2, area.map.gat.h / 2];
    edges.sort((a, b) => dist(a, goal) - dist(b, goal));
    from = edges.slice(0, Math.max(1, Math.ceil(edges.length / 4))).find(e => findPath(area.map.gat, ...e, ...goal)) || edges[0] || goal;
    const path = within != null && findPath(area.map.gat, ...from, ...goal);
    if (path && path.length) from = path.find(p => dist(p, goal) <= within) || from;
  }
  w.spawn(area.map, ...from);
  w.alpha = at ? 1 : 0;
  return f;
}
const toArea = ([x, y]) => [x + area.M, y + area.M];
// on the way from field cell `from` to `to` (the folk's map's walk), the first cell `within` or fewer off `to`
// (from itself when no way leads there)
export function onWay(from, to, within) {
  const path = area && findPath(area.map.gat, ...toArea(from), ...toArea(to));
  const p = path && path.find(c => dist(c, toArea(to)) <= within);
  return p ? [p[0] - area.M, p[1] - area.M] : from;
}
// actor f's field cell
export const cellOf = f => [f.w.cell[0] - area.M, f.w.cell[1] - area.M];
// actor f walking to field cell `to`, then done() (false: it cannot get there)
export function walk(f, to, done = null) { return !!area && f.w.walkTo(...toArea(to), done); }
// actor f showing emote `id` (clif_emotion's ET_ ids) over its head
export function emoteOf(f, id) {
  const action = E.EMOTE_ACTION[id];
  if (action != null && action < 1000) E.play('EF_EMOTE', f.w, now, undefined, { head: TOP, action });
}
// actor f walking off to the nearest edge and fading there (then gone with the rest of the folk)
export function away(f) { f.actor = false; go(f); }
// actor f, walking off (away), the game's again → false when it is gone already
export function reclaim(f) {
  if (!f || f.gone != null || !folk.includes(f)) return false;
  f.actor = true; f.state = 'act'; f.target = null;
  return true;
}
// a mover standing unseen on field cell `at`, for the camera to keep in view (arena.js setFocus)
export function spotAt(at) {
  const w = new Mover();
  if (area) w.spawn(area.map, ...toArea(at));
  return w;
}
// actor f gone at once
export function drop(f) {
  A.remove(f.w);
  if (folk.includes(f)) folk.splice(folk.indexOf(f), 1);
}

// ---------- where they go ----------
const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
// the open cells along the edges of where they walk
function edgeCells() {
  const { w, h } = area.map.gat, out = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++)
    if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && walkable(area.map.gat, x, y)) out.push([x, y]);
  return out;
}
// an edge cell across from `from`, the walk between them going over the patch: on the far side, about as far along
// it as the patch reaches (else any well away)
function across(edges, from) {
  const { w, h } = area.map.gat, M = area.M, lo = M - 2, hi = w - M + 1;
  const side = c => c[1] === 0 ? 0 : c[0] === w - 1 ? 1 : c[1] === h - 1 ? 2 : 3;
  const s = side(from), far = edges.filter(c => side(c) === (s + 2) % 4 && (s % 2 ? c[1] : c[0]) >= lo && (s % 2 ? c[1] : c[0]) <= hi);
  const away = edges.filter(c => dist(c, from) >= w * 0.6);
  return pick(far.length ? far : away.length ? away : edges);
}
// an open cell inside the patch, off its edge, kept clear of the party (lined up about its middle) and of the others
function spot() {
  const { w, h } = W.field, M = area.M, party = W.chars.map(c => c.w.cell).filter(Boolean).map(([x, y]) => [x + M, y + M]);
  const others = folk.flatMap(f => [f.target, f.w.cell]).filter(Boolean);
  for (let i = 0; i < 60; i++) {
    const q = [2 + Math.floor(Math.random() * (w - 4)), 2 + Math.floor(Math.random() * (h - 4))], p = [q[0] + M, q[1] + M];
    if (!W.field.open(...q) || !walkable(area.map.gat, ...p)) continue;
    if (party.some(c => dist(c, p) < 3) || others.some(c => dist(c, p) < 2)) continue;
    return p;
  }
  return null;
}
