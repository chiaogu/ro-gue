// RO 遠征: the battle sandbox's fight as a game (by request: a page of its own, to try the whole loop). A Novice made
// at level 1 trains up to level 10 (TRAIN), takes a first job and finds two recruits in its town; the party of three —
// a leader whose stat and skill points the player spends, two others on presets that grow by themselves — then
// fights a level chain (viewer/bench/chains.json's, picked at 新遊戲 and kept with the game, by request: one map a
// level, each with a hard version the player may take instead once a map is won) one map after another; past its last
// map, each map is planned for the party as it is (levels.planMap, as the sandbox's 動態計算). A map won takes
// everyone up a level and pays its loot (結算); then the leader's points, then the next map with the odds of
// winning it (the party fought through it in workers, as the sandbox's map panel does) and the potion shop. A
// map lost ends the game: it goes into the records (過往紀錄) and the save is gone.
// The fight is drawn by the viewer's stage.js (sprites and sounds: look.js); the rules are sim.js's.
import * as B from '../viewer/battle.js';
import * as sim from '../viewer/sim.js';
import * as A from '../viewer/arena.js';
import * as L from '../viewer/levels.js';
import * as F from '../viewer/fight.js';
import * as R from '../viewer/rng.js';
import * as LOOK from '../viewer/look.js';
import * as AS from '../viewer/assets.js';
import { TITLE_BGM, FIRST_JOBS, NOVICE, TRAIN, HOME_TOWN, TOWN_ZH, TOWNS, JOB_ROOM } from './places.js';
import { gameNeeds } from './needs.js';
import * as stage from '../viewer/stage.js';
import * as folk from './townfolk.js';
import * as E from '../viewer/effects.js';
import { buildsFor, skillBuildsFor, buildLabel, tacticOfBuild, secondJobsOf, recruitPairs } from '../viewer/builds.js';
import { supported, cardTypes, cardKeys, activeCalls, descHtml } from '../viewer/cards.js';
import { devContext, devlog, devlogNow, devOn, watchWorker } from '../viewer/devlog.js';
import { gridDebug } from '../viewer/grid.js';
const { W } = sim;

const $ = id => document.getElementById(id);
const esc = x => String(x).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const pct = x => Math.round(x * 100) + '%';
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del: k => { try { localStorage.removeItem(k); } catch (e) {} },
};
const SAVE_KEY = 'ro-game-save', HIST_KEY = 'ro-game-history', SET_KEY = 'ro-game-settings';

// No double-tap zoom (by request): iOS Safari still zooms on a quick second tap on a button the first one re-drew
// (素質's ◀ ▶), touch-action notwithstanding, so a tap soon after the last one is taken over: its default (the zoom)
// cancelled, its click sent by hand where the finger was. A slider or a text box is left alone; a pinch still zooms.
{
  let last = 0;
  document.addEventListener('touchend', e => {
    const now = e.timeStamp, quick = now - last < 400;
    last = now;
    if (!quick || e.touches.length || e.changedTouches.length !== 1) return;
    const t = e.target.closest ? e.target : e.target.parentElement;
    if (!t || t.closest('input, textarea, select')) return;
    const p = e.changedTouches[0];
    e.preventDefault();
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: p.clientX, clientY: p.clientY }));
  }, { passive: false });
}
// The games going, more than one (by request): each in a key of its own, SAVE_KEY + ':' + its id (one played a
// map rewrites only its own). The one save there was before, SAVE_KEY itself, is moved to one of them.
const saveKey = id => SAVE_KEY + ':' + id;
function saves() {
  const old = store.get(SAVE_KEY);
  if (old) { old.id ??= String(old.started || Date.now()); store.set(saveKey(old.id), old); store.del(SAVE_KEY); }
  const list = [];
  try { for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i).startsWith(SAVE_KEY + ':')) list.push(store.get(localStorage.key(i))); } catch (e) {}
  return list.filter(Boolean).sort((a, b) => (b.at || b.started || 0) - (a.at || a.started || 0));  // (the last played first)
}
// G kept, when it was played with it (at)
// (not a record's party looked at, G.view: viewRecord, by request read-only)
const put = () => { if (G.view) return; G.at = Date.now(); store.set(saveKey(G.id), G); };
// where game s is, in words: the training ground, or its map's number
const whereOf = s => s.train ? TRAIN.label : `第 ${noOf(s)} 關${s.hard ? '（困難）' : ''}`;
const ODDS_RUNS = 40;   // fights the odds of the next map are worked out from
// the map ahead's difficulty (by request, in place of the odds: a grade, not the answer): the party fought it ODDS_RUNS
// times with the bag as it is (by request, to try: without potions a party without an acolyte was always 危險), how
// often it won → 輕鬆 at TIERS[0] or more, 有挑戰 at TIERS[1] or more, else 危險; shown only with 選項's 難度 on
const TIERS = [0.97, 0.8];
const MAX_STEPS = 400;  // steps a frame at most (a long stall is made up over a few frames)

let db = null, INDEX = null, chain = null, STATES = { states: {}, files: {}, text: {} };
// the level chains to pick from (viewer/bench/chains.json: [{ file, label }]), and those loaded (file → chain, its
// maps at the base levels of the parties that fight them: a chain's shift added)
let chains = [];
const loaded = new Map();
// G: the game going (saved as it is: put): { id, chars (sandbox-style saved characters), zeny, bag, chain (its
// file), off (its first map's level − 1: the map at level l is its 第 l − off 關), level (the map next: its level, the
// party's base level), hard (the map next its hard version), plan (that map's, once planned: { level, hard, plan }), fight ({ seed, bag, zeny } as the map on started: a page
// loaded meanwhile fights it again the same), started (ms), maps (won so far), at (ms: last kept), base ({ stats, levels }: the leader's as the map ahead came, the least its
// points can be taken back to: allocate) }
let G = null;
// (for debugging, by request, only with the dev server: devlog.js) the fight's last moments, kept in memory and sent
// with an error: its last TRAIL_N events (sim's emits, units by name), everyone's state every SNAP_MS (the last
// SNAP_N) and as the last step began; and at each fight's start (beginFight) what it was started from, sent then
const TRAIL = { on: false, events: [], snaps: [], pre: null, snapAt: -Infinity }, TRAIL_N = 400, SNAP_MS = 250, SNAP_N = 40;
const nameOf = u => u == null || typeof u !== 'object' ? u
  : u.look ? `${u.name || u.look.job}${W.rivals.includes(u) ? '·敵' : ''}` : u.def ? `${u.def.name}#${W.mobs.indexOf(u)}`
  : u.sk ? u.sk.name : u.name && typeof u.name === 'string' ? u.name : Array.isArray(u) ? (u.length <= 4 && u.every(x => typeof x !== 'object') ? u : `[${u.length}]`)
  : u.cell ? { cell: u.cell } : '{…}';
function trailEvent(type, a) {
  const e = TRAIL.events;
  TRAIL.total = (TRAIL.total || 0) + 1;
  e.push([W.t, type, ...a.map(nameOf)]);
  if (e.length > TRAIL_N) e.splice(0, e.length - TRAIL_N);
}
const unitState = u => ({ n: nameOf(u), hp: u.hp, sp: u.sp, cell: u.w?.cell, moving: u.w?.moving, path: u.w?.path?.length, dead: u.dead,
  target: nameOf(u.target), cast: u.cast && { sk: u.cast.sk.name, end: u.cast.end, at: u.cast.target?.w?.cell }, pending: u.pending?.sk?.name,
  rule: u.rule, aiWalk: u.aiWalk, canAct: u.canAct, running: u.running, body: u.look ? !!u.look.ch?.body : undefined });
const unitsNow = () => [...W.chars, ...W.rivals, ...W.mobs.filter(m => m.dead == null)].map(unitState);
function trailStep(t) {
  TRAIL.pre = { t, units: unitsNow() };
  if (t - TRAIL.snapAt < SNAP_MS) return;
  TRAIL.snapAt = t;
  TRAIL.snaps.push(TRAIL.pre);
  if (TRAIL.snaps.length > SNAP_N) TRAIL.snaps.shift();
}
// (debugging, by request: a fight that hangs the page) from build/log/config.json's traceFrom (ms of the fight's
// clock; read at each fight's start, from the dev server) to its traceTo (else 3 s on): each step's start with
// everyone's state, and each part of it (sim.debug.mark: stepChar, think, approach, chaseStep, mobs, the walk), and
// the frame's drawing, each sent before going on (devlogNow) — the last one in is where it hung
const TRACE = { from: null, to: null, n: 0, dumpAt: null };
function traceConfig() {
  TRACE.from = null;
  try {
    const x = new XMLHttpRequest();
    x.open('GET', '/build/log/config.json?' + Date.now(), false);
    x.send();
    const c = x.status === 200 ? JSON.parse(x.responseText) : {};
    if (c.traceFrom != null) Object.assign(TRACE, { from: c.traceFrom, to: c.traceTo ?? c.traceFrom + 3000, n: 0, dumpAt: c.dumpAt ?? null });
  } catch (e) {}
}
const traceOn = t => TRACE.from != null && t >= TRACE.from && t <= TRACE.to;
const traceMark = (label, u, x) => devlogNow('mark', { t: W.t, n: ++TRACE.n, label, u: nameOf(u), x });
// a unit as it is, for config.json's dumpAt (its step's start): its own fields (not its look, timing or sprite), other
// units by name, its walker's cell, path and pos, 4 deep
const isUnit = v => v && typeof v === 'object' && v.w && (v.pc || v.st) && v.look !== undefined || v?.def && v?.w;
function dumpOf(x, depth = 0, root = x) {
  if (x == null || typeof x !== 'object') return typeof x === 'function' ? '[fn]' : x;
  if (x !== root && isUnit(x)) return '@' + nameOf(x);
  if (ArrayBuffer.isView(x)) return `[${x.constructor.name} ${x.length}]`;
  if (x.isObject3D || (typeof Node === 'function' && x instanceof Node)) return '[scene]';
  if (depth > 4) return '[…]';
  if (Array.isArray(x)) return x.slice(0, 50).map(v => dumpOf(v, depth + 1, root));
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (k === 'look' || k === 'timing' || k === 'spr' || k === 'tally') continue;
    out[k] = k === 'w' && v ? { cell: v.cell, pos: v.pos, path: v.path, moving: v.moving, rooted: v.rooted, confused: v.confused, steer: v.steer, cellMs: v.cellMs, pace: v.pace, onArrive: v.onArrive ? (v.onArrive === x.chaseOn ? 'chaseOn' : 'other') : null }
      : dumpOf(v, depth + 1, root);
  }
  return out;
}
// a beat to the dev server each BEAT_MS of the wall clock while a fight is on: the events since the last one and
// everyone now — where the page hangs the beats stop, the last one showing where; where the fight stalls they go on,
// its clock (t) standing still
const BEAT_MS = 1000;
function beats() {
  clearInterval(TRAIL.beat);
  TRAIL.sent = TRAIL.total = 0;
  TRAIL.beat = setInterval(() => {
    const r = run, n = Math.min(TRAIL.total - TRAIL.sent, TRAIL.events.length);
    TRAIL.sent = TRAIL.total;
    devlog('beat', { t: W.t, simT: r?.simT, over: r?.over, state: r?.map?.state, wave: r?.map?.wave, units: unitsNow(), events: n > 0 ? TRAIL.events.slice(-n) : [] });
    if (!r || r.over || !TRAIL.on) clearInterval(TRAIL.beat);
  }, BEAT_MS);
}
// (on an error, to the dev server: devlog.js) the game as saved and where its fight is: enough to fight it again
devContext('game', () => ({ G, t: W.t, lastStep: TRAIL.pre, snaps: TRAIL.snaps, events: TRAIL.events }));

// ---------- start ----------
async function boot() {
  LOOK.init({ volume: () => vol(settings.sfx), fx: () => 'glow', headgear: id => db.headgear?.[id] });
  settingsInit();
  offlineInit();
  const floors = fetch('../viewer/floors.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  const text = AS.loadText();
  [db, INDEX, chains, STATES] = await Promise.all([
    AS.loadTable('../viewer/jobs.json', 'jobs', text),  // (the client's names put in: viewer/assets.js)
    fetch('../viewer/index.json', { cache: 'no-cache' }).then(r => r.json()),
    fetch('../viewer/bench/chains.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : []).catch(() => []),
    AS.loadTable('../viewer/states.json', 'states', text).catch(() => ({ states: {}, files: {}, text: {} })),  // (the status icons: stateIcons)
  ]);
  if (!chains.length) chains = [{ file: 'chain.json', label: '' }];
  await useChain(chains[0].file);
  LOOK.setIndex(INDEX);
  sim.init({ db, motion: stage.motion, emit: (type, ...a) => { if (TRAIL.on) trailEvent(type, a); return stage.emit(type, ...a); } });
  FLOORS = await floors;
  L.init({ db, floors: FLOORS });
  stage.init({
    // (a replay's seek fast-forwards silently: quiet)
    api: { ...LOOK, playSound: loud(LOOK.playSound), playHit: loud(w => LOOK.playHit('human', w)), playMobHit: loud(() => LOOK.playHit('monster')), dataDir: INDEX.wav.replace(/\/wav$/, '') },
    db, canvas: $('stage'), overlay: $('fx'), onClick: clickField,
  });
  folk.init({ db, index: INDEX, dataDir: INDEX.wav.replace(/\/wav$/, '') });
  A.setFollow(true);
  $('t-new').onclick = () => newGame();
  $('t-cont').onclick = () => carryOn();
  $('t-hist').onclick = () => showHistory();
  requestAnimationFrame(loop);
  title();
  // (offline copies only from a server that has the assets: not with packs, not on a host without them, GitHub Pages)
  assetCheck().then(() => ASSETS.packs.length || !ASSETS.server || saveOffline()).catch(err => console.warn('offline', err));
}

// ---------- the level chain ----------
// chain file (its maps at the levels of the parties that fight them: its shift, a chain made for lower levels, added;
// raw: not, for a game from before chains were picked, begun at level 1 on chain.json as it was then)
async function useChain(file, raw = false) { return chain = await loadChain(file, raw); }
// (chain file, loaded once, without taking it: saveOffline goes over all of them)
async function loadChain(file, raw = false) {
  const key = file + (raw ? '#raw' : '');
  if (!loaded.has(key)) {
    const ch = await fetch('../viewer/bench/' + file, { cache: 'no-cache' }).then(r => r.ok ? r.json() : { maps: [] }).catch(() => ({ maps: [] }));
    const sh = raw ? 0 : ch.shift || 0;
    for (const m of ch.maps) { m.level += sh; if (m.hard) m.hard.level += sh; }
    loaded.set(key, ch);
  }
  return loaded.get(key);
}
// a chain's short name (chains.json's name, else its file's) and where a party begins it: its first map's level as
// the base level, its start's job level (a chain from level 1 without one: 1)
const chainName = file => { const x = chains.find(c => c.file === file); return x?.name || String(file || 'chain.json').replace(/\.json$/, ''); };
const chainStart = ch => ({ blv: ch.maps.length ? Math.min(...ch.maps.map(m => m.level)) : 1, jlv: ch.start?.jlv || 1 });
// game s's number of the map at level l (s.off: its chain's first map is 第 1 關)
const noOf = (s, l = s.level) => l - (s.off || 0);
// the chain's map at level l, its hard version if hard (and there is one)
const chainMap = (l, hard) => { const m = chain.maps.find(x => x.level === l); return m && hard && m.hard ? m.hard : m; };

// screen id on (null: none, the fight's HUD instead); 新遊戲, 繼續遊戲's list and 過往紀錄 over the title's
// background, its menu put away (by request, not the field of the game left)
const OVER_TITLE = ['s-create', 's-saves', 's-hist'];
function show(id) {
  for (const s of document.querySelectorAll('.screen:not(.layer)')) s.hidden = s.id !== id && !(s.id === 's-title' && OVER_TITLE.includes(id));
  $('s-title').classList.toggle('back', id !== 's-title');
  $('hud').hidden = id !== null;
  if (id !== 's-prep') { A.setView(0, 0); A.setFocus(null); }
}

// ---------- the party ----------
// what is kept of a character (as the sandbox's savedOf)
const savedOf = c => ({ name: c.name, sex: c.look.sex, job: c.look.job, weapon: c.look.weapon, hair: c.look.hair, hdye: c.look.hdye, blv: c.blv, jlv: c.jlv, bexp: c.bexp, jexp: c.jexp,
  ...c.firstJlv ? { firstJlv: c.firstJlv } : {}, ...c.second ? { second: c.second, changeAt: c.changeAt } : {},
  stats: { ...c.stats }, build: c.build, skillBuild: c.skillBuild, levels: { ...c.levels }, auto: true, tactic: c.tactic, ...c.arm ? { arm: c.arm } : {}, ...c.armL ? { armL: c.armL } : {},
  ...c.look.shield ? { shield: c.look.shield } : {}, ...c.body ? { body: c.body } : {}, ...c.hands ? { hands: { ...c.hands } } : {},
  ...c.look.hats && Object.values(c.look.hats).some(Boolean) ? { hats: { ...c.look.hats } } : {}, ...c.ownHats?.length ? { ownHats: [...c.ownHats] } : {},
  ...c.cards?.length ? { cards: [...c.cards] } : {} });
// a character as a fight takes it (the sandbox's buildOf: no EXP, its look's weapon held)
const buildOf = c => { const { bexp, jexp, hair, hdye, ...v } = savedOf(c); return { ...v, held: c.look.held || '' }; };
const jobLabel = job => (db.jobs[job] || {}).label || job;
// a job's name for a character of sex `sex` (a bard's or a dancer's, of the node of two)
const jobName = (job, sex) => { const j = db.jobs[job]; return j?.female ? j.label.split('／')[sex === '여' ? 1 : 0] || j.label : jobLabel(job); };
const partyText = chars => chars.map(c => {
  const job = jobLabel(c.job || c.look.job);
  return `${c.name && c.name !== job ? `${c.name}（${job}）` : job} Lv ${c.blv}`;
}).join('、');
const partyLv = () => Math.round(W.chars.reduce((n, c) => n + c.blv, 0) / (W.chars.length || 1));
// the characters of G, on the field with their sprites loading (the fight puts them anew: freshFight)
function bringParty() {
  for (const c of [...W.chars]) { sim.removeChar(c); stage.drop(c); }
  W.chars = G.chars.map(saved => { const c = sim.newChar(saved); c.name = saved.name || jobLabel(c.look.job); sim.calc(c); return c; });
  for (const c of W.chars) {
    LOOK.loadLook(c.look, () => {});
    sim.enter(c);
    stage.show(c);
  }
}
const ready = () => W.chars.every(c => stage.motion.ready(c));
const waitReady = async () => { for (let i = 0; i < 200 && !ready(); i++) await new Promise(r => setTimeout(r, 50)); };
function keep() {
  if (!G) return;
  G.chars = W.chars.map((c, i) => ({ ...savedOf(c), hair: c.look.hair ?? G.chars[i]?.hair, hdye: c.look.hdye ?? G.chars[i]?.hdye }));
  put();
}

// ---------- the skin ----------
// RO's windows (index.html .win): a title bar, a body, a bottom bar with the buttons (foot: its html, null for none)
const win = (title, body, foot = null, cls = '', x = false, attrs = '') => `<div class="win ${cls}" ${attrs}><div class="tb">${title}${x ? '<button class="x" aria-label="關閉"></button>' : ''}</div>` +
  `<div class="wb">${body}</div>${foot != null ? `<div class="bb">${foot}</div>` : ''}</div>`;
const rb = (label, attrs = '', on = false) => `<button class="rb${on ? ' on' : ''}" ${attrs}>${label}</button>`;
// ---------- title ----------
// The login screen's background (bgi_temp) and music, a small window with the menu
function title() {
  stopFight();
  unload();
  const list = saves(), s = list[0];
  $('t-cont').disabled = !s;
  $('t-party').textContent = list.length > 1 ? `${list.length} 個進行中的遊戲` : s ? `${chainName(s.chain)}・${whereOf(s)}・${partyText(s.chars)}・${s.zeny.toLocaleString()} z` : '沒有進行中的遊戲';
  show('s-title');
  playBgm(TITLE_BGM);
}
// the game left (by request: nothing of it kept once at the title): the map ahead's work stopped, the party, the
// monsters, the townsfolk and the field gone
function unload() {
  endRecruit();
  prepId++; prepChanged = null; setTab = null; pool.stop();
  folk.stop();
  for (const c of [...W.chars]) { sim.removeChar(c); stage.drop(c); }
  sim.resetWorld([]);
  stage.restart([]);
  sim.setFloor(null);
  A.showFloor(null);
  G = null;
}
// 繼續遊戲: the one game going straight on; more than one, a list of them to pick from (the last played first), each
// one to be thrown away too
function carryOn() {
  const list = saves();
  if (list.length > 1) return pickSave(list);
  play(list[0]);
}
function pickSave(list) {
  if (!list.length) return title();
  const day = ms => new Date(ms).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
  // (by request, for a phone: a card a game, in three lines: when it was last played, the level and zeny, the
  // party's heads with each one's job and level small under it)
  // (the level and zeny over the heads, by request; a head's canvas 80 px for 40 CSS px: drawPortrait takes half its
  // width in sprite px across, so the whole face, not the top of the hair)
  $('saves').innerHTML = win('繼續遊戲', list.map((s, i) => `<div class="save" data-i="${i}">` +
    `<div class="when"><span>${day(s.at || s.started)}</span>${rb('刪除', `data-del="${i}"`)}</div>` +
    `<div class="where">${esc(chainName(s.chain))}・${whereOf(s)}・${s.zeny.toLocaleString()} z</div>` +
    `<div class="who">${s.chars.map(c => `<span><canvas width="80" height="80"></canvas><small>${esc(jobLabel(c.job))} Lv ${c.blv}</small></span>`).join('')}</div></div>`).join(''),
    rb('回標題', 'id="v-back"'), 'dlg savedlg', true);
  // the heads, as their sprites come in (a look a slot of its own: LOOK.loadSprite keeps the last asked of a slot)
  list.forEach((s, i) => s.chars.forEach((c, j) => {
    const look = { sex: c.sex, job: c.job, weapon: '', hair: c.hair ?? null, hdye: c.hdye ?? null, id: `save${i}-${j}` };
    const cv = $('saves').querySelectorAll('.save')[i].querySelectorAll('canvas')[j];
    LOOK.loadLook(look, () => LOOK.drawPortrait(cv, look.ch || {}));
  }));
  for (const el of $('saves').querySelectorAll('.save')) el.onclick = () => play(list[+el.dataset.i]);
  for (const b of $('saves').querySelectorAll('[data-del]')) b.onclick = e => {
    e.stopPropagation();
    const s = list[+b.dataset.del];
    if (!confirm(`刪除這個存檔（${whereOf(s)}・${partyText(s.chars)}）？不會留下紀錄。`)) return;
    store.del(saveKey(s.id));
    const left = saves();
    left.length ? pickSave(left) : title();
  };
  $('v-back').onclick = title;
  $('saves').querySelector('.x').onclick = title;
  show('s-saves');
}
async function play(s) {
  G = s && store.get(saveKey(s.id));
  if (!G) return title();
  loadingScreen(true);  // (black with its bar until the town, or the fight, is there: by request)
  await useChain(G.chain || 'chain.json', !G.chain);  // (a game from before chains were picked: chain.json's, unshifted)
  bringParty();
  // (the start, left halfway: the job menu again, or the recruits coming again in the job's town)
  if (G.train?.step === 'job') { await waitReady(); await trainField(); loadingScreen(false); return jobMenu(); }
  if (G.train?.step === 'join') return arriveHome();
  if (G.fight || G.train) return startFight();  // (a map left halfway: fought again from its start, the same)
  G.base ??= leaderBase();
  // (the cards offered after the last map, none taken yet: taken first, then the town)
  if (G.draw) { loadingScreen(false); return drawCard(() => prep('load')); }
  prep('load');
}

// ---------- 新遊戲: making the Novice ----------
// One window in the client's style (by request, not its select and make windows): the one character (by request,
// a Novice at level 1: the rest of the party is recruited once it has a job, TRAIN), its figure at the top, under it
// its sex, hairstyle and hair colour, and its stats on the hexagon with a triangle at each corner (as the client's),
// each value by it: spent here by hand (from every stat at 5, by request: the 48 points level 1 has; a triangle
// raises its stat and lowers the opposite one, as the client's), as the levels come later, its skills too.
// The level chain is picked at its foot (by request; the game goes through that one, from its first map's level:
// chainStart, plan8's at base 10, job 1, the level the training ground takes it to).
const HEX_ORDER = ['str', 'vit', 'luk', 'int', 'dex', 'agi'];  // (clockwise from the top, as the client's)
const HEX_C = [105, 105], HEX_R = 62;
const hexAt = (i, r) => [HEX_C[0] + Math.sin(i * Math.PI / 3) * r, HEX_C[1] - Math.cos(i * Math.PI / 3) * r];
async function newGame() {
  stopFight();
  let file = (chains.find(x => x.file === 'plan8.json') || chains[0]).file;  // (plan8 first: by request)
  await useChain(file);
  // (its sex and hairstyle at random, by request, the hair its own colour)
  const c = sim.newChar({ job: NOVICE, sex: Math.random() < 0.5 ? '남' : '여', blv: 1, jlv: 1, weapon: '단검', tactic: 'job', build: null, skillBuild: null });
  autoGear(c);
  for (const s of B.STATS) c.stats[s] = 5;
  unlearn(c);
  sim.calc(c);
  c.name = jobLabel(NOVICE);
  // (a hairstyle of its sex at random, by request: at first and as its sex is picked)
  const anyHair = () => { const heads = LOOK.heads(c.look.sex); c.look.hair = heads[Math.floor(Math.random() * heads.length)].id; c.look.hdye = null; };
  anyHair();
  const pts = () => B.pointsTotal(db, sim.jobFor(c), c.blv) - B.pointsSpent(c.stats);
  // (the figure again as its sprites come in, without drawing the rest anew)
  function figures() {
    if ($('s-create').hidden) return;
    drawFigure($('create').querySelector('.slot canvas'), c, 18);  // (shoes hang well below the feet's point)
  }
  LOOK.loadLook(c.look, figures);
  function draw() {
    const left = pts();
    const scale = Math.max(9, ...B.STATS.map(s => c.stats[s]));
    const poly = f => HEX_ORDER.map((s, i) => hexAt(i, f(s)).map(v => v.toFixed(1)).join(',')).join(' ');
    const hex = `<svg width="210" height="212" viewBox="0 0 210 212"><polygon class="grid" points="${poly(() => HEX_R)}"/>` +
      [0, 1, 2].map(i => { const [a, b] = [hexAt(i, HEX_R), hexAt(i + 3, HEX_R)]; return `<line class="grid" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`; }).join('') +
      // (a stat at 1 still reaches 15% of the way out, by request; the highest of them, or 9, all of it)
      `<polygon class="shape" points="${poly(s => HEX_R * (0.15 + 0.85 * (c.stats[s] - 1) / (scale - 1)))}"/>` +
      HEX_ORDER.map((s, i) => { const [x, y] = hexAt(i, HEX_R - 13); return `<text class="val" x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="middle">${c.stats[s]}</text>`; }).join('') + `</svg>` +
      HEX_ORDER.map((s, i) => { const [x, y] = hexAt(i, HEX_R + 25);
        return `<button class="tri" data-tri="${s}" style="left:${(x - 19).toFixed(0)}px;top:${(y - 17).toFixed(0)}px;--a:${i * 60}deg"` +
          ` title="${s.toUpperCase()} ${c.stats[s]}（點一下：加一點，對面那項減一點）"><span>${s.toUpperCase()}</span></button>`; }).join('');
    const head = LOOK.heads(c.look.sex).findIndex(h => h.id === c.look.hair) + 1;
    const looks = `<div class="looks">` +
      `<div class="row"><span class="k">性別</span>${rb('男', 'data-sex="남"', c.look.sex === '남')}${rb('女', 'data-sex="여"', c.look.sex === '여')}</div>` +
      `<div class="row"><span class="k">髮型</span><button class="arw l" data-hair="-1" aria-label="上一個髮型"></button><span class="val">${head}</span><button class="arw r" data-hair="1" aria-label="下一個髮型"></button>` +
      `<span class="k" style="margin-left:14px">髮色</span><button class="arw l" data-hdye="-1" aria-label="上一個髮色"></button><span class="val">${c.look.hdye == null ? '原色' : c.look.hdye}</span><button class="arw r" data-hdye="1" aria-label="下一個髮色"></button></div>` +
      `</div>`;
    $('create').innerHTML = win('建立角色',
      `<div class="slots one"><div class="slot on"><canvas width="110" height="118"></canvas><div class="nm">${esc(c.name)}　Lv 1</div></div></div>` +
      `<div class="editor">${looks}<div><div class="hexbox">${hex}</div>` +
      `<div class="hexnote">剩餘點數 <b>${left}</b></div></div></div>`,
      `<label class="chainpick">關卡鏈<select class="rs" id="c-chain">${chains.map(x => `<option value="${esc(x.file)}"${x.file === file ? ' selected' : ''} title="${esc(x.label || '')}">${esc(chainName(x.file))}</option>`).join('')}</select></label>` +
      `<span class="grow"></span>${rb('回標題', 'id="c-back"')}${rb('出發', 'id="c-go"')}`, 'create');
    figures();
    // its stats, on the hexagon alone (by request), as the client's make window has it: a triangle raises its stat
    // and lowers the opposite one (STR–INT, VIT–DEX, LUK–AGI) when that is above 1, else spends a point left
    const raise = s => {
      const jj = sim.jobFor(c), o = HEX_ORDER[(HEX_ORDER.indexOf(s) + 3) % 6];
      if (c.stats[s] >= jj.maxStat) return;
      const was = c.stats[o];
      if (was > 1) c.stats[o]--;
      if (B.statCost(c.stats[s]) > pts()) { c.stats[o] = was; return; }
      c.stats[s]++;
      sim.calc(c);
      draw();
    };
    for (const b of $('create').querySelectorAll('[data-tri]')) b.onclick = () => raise(b.dataset.tri);
    for (const b of $('create').querySelectorAll('[data-sex]')) b.onclick = () => {
      c.look.sex = b.dataset.sex; c.look.ch = null; anyHair(); LOOK.loadLook(c.look, figures); draw();
    };
    // hairstyle and hair colour, through the sex's (a colour the new hairstyle has stays)
    const step = (list, i, d) => list[((i + d) % list.length + list.length) % list.length];
    for (const b of $('create').querySelectorAll('[data-hair], [data-hdye]')) b.onclick = () => {
      const look = c.look, list = LOOK.heads(look.sex), h = list.find(x => x.id === look.hair) || list[0];
      if (b.dataset.hair) {
        const nh = step(list, list.indexOf(h), +b.dataset.hair);
        look.hair = nh.id;
        if (!nh.dyes.includes(look.hdye)) look.hdye = null;
      } else {
        const colours = [null, ...h.dyes];
        look.hdye = step(colours, colours.indexOf(look.hdye), +b.dataset.hdye);
      }
      LOOK.loadLook(look, figures);
      draw();
    };
    $('c-chain').onchange = async e => { file = e.target.value; await useChain(file); };
    $('c-back').onclick = title;
    // (出發: straight to the training ground, TRAIN)
    $('c-go').onclick = () => {
      const at = chainStart(chain);
      G = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), chars: [{ ...savedOf(c), hair: c.look.hair, hdye: c.look.hdye }], zeny: 0, bag: {},
            chain: file, off: at.blv - 1, level: at.blv, hard: false, plan: null, fight: null, started: Date.now(), maps: 0, train: { step: 'fight' } };
      bringParty();
      G.base = leaderBase();
      put();
      startFight();
    };
  }
  show('s-create');
  draw();
}
// character c's hair as its job's figure in the job art has it (LOOK.jobHair), else the first hairstyle
function ownHair(c) {
  const [id, dye] = LOOK.jobHair(c.look.job, c.look.sex) || [], list = LOOK.heads(c.look.sex);
  const h = list.find(x => x.id === id) || list[0];
  c.look.hair = h.id;
  c.look.hdye = dye != null && h.dyes.includes(dye) ? dye : null;
}
// every skill of character c's job at level 0 (a skill missing from c.levels is taken as learned to the top:
// sim.fitSkills), but quest skills, learned for nothing
function unlearn(c) {
  for (const sk of sim.jobSkills(c)) if (!sim.questSkill(sk.name)) c.levels[sk.name] = 0;
}
// a character standing, on canvas cv, its feet `foot` px above the bottom (its sprites as they come in)
function drawFigure(cv, c, foot = 8) {
  if (!cv) return;
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  if (!c.look.ch || !c.look.ch.body) return;
  g.setTransform(1, 0, 0, 1, cv.width / 2, cv.height - foot);
  g.imageSmoothingEnabled = false;
  LOOK.drawHuman(g, 0, 0, c.look.ch);
}

// ---------- the map ahead ----------
const chainLast = () => Math.max(0, ...chain.maps.map(m => m.level));
// G.plan, when it is the map next's (its level, and its version: G.hard) and, for one of the chain's, still the
// chain's (by request: a map planned again since — plan8's 75 hard, its Iceicle a trap now — taken up by a game
// that had kept the old one, even halfway through it)
const wavesKey = p => JSON.stringify(p.waves.map(w => w.map(d => d.id)));
const planned = () => {
  if (!G.plan || G.plan.level !== G.level || !!G.plan.hard !== !!G.hard) return false;
  const m = chainMap(G.level, G.hard);
  return !m || wavesKey(G.plan.plan) === wavesKey(L.chainPlan(m));
};
// the plan of the map at G.level: the chain's (its hard version with G.hard), or past it one planned for the party
// (kept in G: a page loaded again finds the same map)
async function planNext() {
  if (planned()) return G.plan.plan;
  const m = chainMap(G.level, G.hard);
  let plan;
  if (m) plan = L.chainPlan(m);
  else {
    W.chars.forEach(c => sim.calc(c));
    // (what it is trying, on the screen meanwhile: it takes tens of seconds)
    const note = text => { const el = $('prep').querySelector('.loading'); if (el) el.textContent = text; };
    let theme = null;
    plan = await L.planMap(W.chars, G.level - 1, { rnd: Math.random, parallel: pool.size(),
      trying: t => { theme = t; note(`依隊伍現在的樣子規劃地圖中…（試 ${t.label} Lv ${t.level}）`); },
      tried: (N, k) => note(`依隊伍現在的樣子規劃地圖中…（${theme ? theme.label + '，' : ''}${N} 隻）`) },
      (p, seed) => pool.fight(p, seed, partyMsg()));
    if (!plan) throw new Error('找不到適合的地圖');
  }
  G.plan = { level: G.level, hard: !!G.hard, plan };
  put();
  return plan;
}
// what the workers fight with: the party as built, with what its sprites say of its swing (stage.timingOf)
const partyMsg = () => ({ presets: [], aggro: false, bag: structuredClone(G.bag), zeny: G.zeny,
  chars: W.chars.map(c => ({ ...buildOf(c), timing: stage.timingOf(c) })) });

let prepId = 0, prepTab = 'map', prepChanged = null, setTab = null;
// the camera frames the party (or the character whose status is open) in what the windows of the map ahead leave
// free (by request): over the windows at the foot (a character's status and skills, else the tab's window and the
// tabs), under 選項
function frame() {
  if ($('s-prep').hidden && $('s-alloc').hidden) return;
  const H = innerHeight, top = $('setbtn').getBoundingClientRect().bottom;
  const foot = !$('s-alloc').hidden ? $('alloc').firstElementChild
    : document.querySelector('.panes[data-tab="map"] [data-pane="map"], .panes[data-tab="shop"] [data-pane="shop"], .panes[data-tab="recruit"] [data-pane="recruit"]:not(.waiting), .panes[data-tab="job"] [data-pane="job"], .panes[data-tab="view"] [data-pane="view"]') || document.querySelector('#prep .tabs');  // (招募's, hidden till they come: not there)
  A.setView(top / H, foot ? (H - foot.getBoundingClientRect().top) / H : 0);
}
addEventListener('resize', frame);
// The party side by side across the screen with the camera turned to 45° to the grid, a cell between each along
// the diagonal, facing it (by request): the leader on its cell, the second to its left, the third to its right, put
// there (in town: enterTown, about at, the cell its Kafra stands on); the row moved over to the nearest place all
// three cells of it are open, KAFRA_GAP cells or more from `at` and the Kafras and NPC_GAP from the town's other NPCs,
// moved in front of it or behind (not along the row)
// (npcs: [{ x, y }]; by request: off to the Kafra's side, room about it), or, a cell short, the nearest free one to
// each.
// `az` a list of azimuths (enterTown): of those, the one the row, where it would stand seen from it, is hidden least
// from by the town's models (by report, issue 12: turned for the cells about the Kafra, the row moved off from it
// was hidden whole by Prontera's gates); on a tie the first.
const NPC_GAP = 2, KAFRA_GAP = 4;
function lineUp(at = null, az = A.alignedAzimuth(), npcs = []) {
  if (Array.isArray(az)) {
    let best = az[0], fewest = Infinity;
    for (const a of az) {
      const { cx, cy, right, ks } = rowAt(at, a, npcs), hits = A.hiddenFrom(ks.map(k => [cx + right[0] * k, cy + right[1] * k]), a);
      if (hits < fewest) { fewest = hits; best = a; }
    }
    az = best;
  }
  A.turnTo(az);
  const { cx, cy, face, right, ks } = rowAt(at, az, npcs), used = new Set(npcs.map(n => n.x + ',' + n.y));
  // the free cell nearest (x, y), not one already given out
  const near = (x, y) => {
    for (let r = 0; r < 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const p = [x + dx, y + dy];
      if (W.field.open(...p) && !used.has(p.join())) return used.add(p.join()), p;
    }
    return [x, y];
  };
  ks.forEach((k, i) => {
    const c = W.chars[i];
    if (!c) return;
    const p = near(cx + right[0] * k, cy + right[1] * k);
    if (c.dead != null) return;
    W.field.placeNear(c.w, p);
    c.w.heading = face;
  });
}
// where lineUp's row stands with the camera at azimuth az: its middle (cx, cy), the way it faces, its right and the
// steps along it (ks) of each
function rowAt(at, az, npcs) {
  // (at 45°: toward the camera and to its right, each a diagonal step)
  const face = [Math.round(Math.sin(az)), Math.round(-Math.cos(az))], right = [Math.round(Math.cos(az)), Math.round(Math.sin(az))];
  const ks = [0, -2, 2].slice(0, W.chars.length);
  // (where they all fit on their own cells, the nearest such to `at`: by request, not squeezed together where
  // the town has no room for the row)
  const fits = (x, y) => ks.every(k => { const px = x + right[0] * k, py = y + right[1] * k;
    return W.field.open(px, py) && npcs.every(n => Math.max(Math.abs(n.x - px), Math.abs(n.y - py)) >= (/kafra/.test(n.sprite) ? KAFRA_GAP : NPC_GAP)) &&
      (!at || Math.max(Math.abs(at[0] - px), Math.abs(at[1] - py)) >= KAFRA_GAP); });
  // (moved toward the camera or away from it, not along the row, by request: a row moved sideways put one of them
  // in front of the Kafra; the nearest that fits, toward the camera first, then a little to the side)
  let [cx, cy] = at || W.chars[0].w.cell;
  search: for (const l of [0, 1, -1, 2, -2]) for (let d = 0; d <= 10; d++) for (const sd of d ? [d, -d] : [0]) {
    const x = cx + face[0] * sd + right[0] * l, y = cy + face[1] * sd + right[1] * l;
    if (!fits(x, y)) continue;
    cx = x; cy = y;
    break search;
  }
  return { cx, cy, face, right, ks };
}
// The town between the maps (by request): an 18 × 18 patch of one of TOWNS (scripts/map2gltf.py --arena, as the
// maps' floors: one about each of its Kafras, by request), picked by chance as the party gets there (G.town, kept:
// a page loaded again finds the same). The party is put on it afresh (as a fight starts: beginFight), nothing of
// the fight left, and lined up where the Kafra stands.
let FLOORS = {};  // viewer/floors.json (boot)
const pickTown = () => L.floorOf(TOWNS[Math.floor(Math.random() * TOWNS.length)]);
let townT = 0;  // the clock the town is drawn at (no fight stepping it: loop)
async function enterTown() {
  const cut = t => t && (FLOORS[t.map] || [])[t.i];  // (its patch as floors.json has it: cut again, it may be gone)
  if (!cut(G.town) || cut(G.town).open !== G.town.open) G.town = pickTown();
  put();
  folk.stop();
  const town = G.town, floor = await A.loadFloor(town), shown = town && floor && floor.key === town.map + '_' + town.i ? floor : null;
  sim.setFloor(shown ? town : null, shown && shown.heights);
  A.showFloor(shown);
  const list = [...W.chars];
  for (const c of list) { A.remove(c.w); sim.removeChar(c); }
  list.forEach(c => {
    const { id, look, ...fresh } = sim.newChar(buildOf(c));
    Object.assign(c, fresh);
    sim.calc(c);
  });
  W.allAggressive = false;
  sim.resetWorld(list, G.bag, G.zeny);
  stage.restart(list);
  townT = W.t;
  // (the camera turned where the town's buildings hide them least, by request: where they will stand, lineUp)
  const at = shown && cut(town) ? cut(town).at : null;
  const npcs = shown && cut(town) ? await folk.npcsNear({ map: town.map, ...cut(town) }) : [];
  lineUp(at, A.turnsAbout(), npcs);
  await folk.start(townT, shown && cut(town) ? { map: town.map, ...cut(town) } : null);
}
// the screen fading to black (on) or back from it, over FADE_MS (by request: going to town)
const FADE_MS = 450;
const fadeOut = on => new Promise(r => { $('fade').classList.toggle('on', on); setTimeout(r, FADE_MS); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The map ahead (by request, laid out for a phone without scrolling; RO's windows over the arena, the party standing
// on it): 關卡 (the level's number its title: the map, its waves, the odds and 出發 at its foot) and 商店 (an NPC's
// shop, the Zeny), one at a time behind tabs at the top, a tab tapped again closing its window (by request). A
// character on the field tapped opens its status and skills (allocate: the leader's points spent there; by request,
// not after the map won). The windows are drawn on their own: the odds as each run comes in, the shop as things are
// bought. In town (enterTown), where the party gets to ('load': a page loaded, a new game, they teleport in as the
// loading screen goes; 'arrive': teleported in, landed: a promise, once they sit); none: the same map ahead drawn again.
async function prep(how = null, landed = null) {
  const id = ++prepId;
  stopFight();
  show('s-prep');
  const box = $('prep');
  box.innerHTML = win(`第 ${noOf(G)} 關`, `<span class="loading">${G.level > chainLast() && !planned() ? '依隊伍現在的樣子規劃地圖中…' : '準備中…'}</span>`, null, 'note');
  // ('load': the loading screen over it all until the town is there with the map ahead's windows, by request; a map
  // planned for the party past the chain takes tens of seconds: its note shown in town meanwhile)
  const cover = how === 'load';
  if (how === 'arrive') prepTab = null;  // (only the leader's status, once they land: by request)
  if (cover) loadingScreen(true);
  await waitReady();
  if (cover) loadingScreen(0.4);
  if (how === 'load') { await enterTown(); W.chars.forEach(c => stage.arrive(c, Infinity)); }  // (unseen till the loading screen goes)
  const uncover = () => { if (!$('loading').hidden) { loadingScreen(false); landed = teleportIn(200, -1); } };
  if (cover) { loadingScreen(0.8); if (!planned() && !chainMap(G.level, G.hard)) uncover(); }
  if (!how) seat();  // (getting there: standing as they land, sitting after: teleportIn)
  playBgm(G.town ? G.town.map : null);
  // (a map planned for the party takes tens of seconds: by request, only 野外 waits for it, the town's other tabs
  // there meanwhile; the chain's own maps are there at once)
  let plan = null;
  const planning = planNext(), slow = !planned() && !chainMap(G.level, G.hard);
  if (!slow) {
    try { plan = await planning; }
    catch (e) { if (cover) uncover(); box.querySelector('.loading').innerHTML = `<span class="bad">${esc(e.message || e)}</span> ${rb('重試', 'onclick="location.reload()"')}`; return; }
  }
  if (id !== prepId) return;
  const odds = { runs: [], key: null }, bought = {};
  gearAll();  // (the levels the map won brought: the best at them)
  endRecruit();
  // (招募 on the left, by request: not a window of its own but the party's look for recruits, recruitScene)
  // (轉職, by request: the leader a first job at CHANGE.from on, to pick its second job)
  const lead = W.chars[0], seconds = sim.jobFor(lead).tier === 1 && lead.jlv >= CHANGE.from ? secondJobsOf(lead.look.job).filter(j => db.jobs[j]) : [];
  const TABS = [...G.recruits?.length ? [['recruit', '招募', '招募']] : [], ...seconds.length ? [['job', '轉職', '轉職']] : [], ['map', `第 ${noOf(G)} 關`, '野外'], ['shop', '商店', '商店'], ['pvp', '對戰', '對戰']];
  if (prepTab && !TABS.some(([k]) => k === prepTab)) prepTab = 'map';
  box.innerHTML =
    `<main class="panes" data-tab="${prepTab || ''}">${win('怪物資訊', '<div id="p-mobinfo"></div>', null, 'mobcard', true, 'id="p-mob" hidden')}${TABS.map(([k, title]) => win(title,
      // (商店: 補給品 only, by request: the weapons and armour are put on by level, autoGear)
      k === 'shop' ? '<div id="p-supply"></div>' : `<div id="p-${k}"></div>`,
      k === 'map' ? `<div class="oddsbox"><div><div class="muted">難度</div><div class="meter"><i id="p-meter"></i></div></div><div class="odds" id="p-odds">…</div></div>` +
        `<span class="grow"></span>${rb('出發', 'id="p-go"')}` : k === 'recruit' ? '<span class="grow"></span><span class="rbtns" id="p-rfoot"></span>' :
        k === 'job' ? `<span class="grow"></span>${rb('轉職', 'id="p-jgo" disabled')}` :
        k === 'pvp' ? `<span class="grow"></span>${rb('開戰', 'id="p-vgo"')}` : null, 'pane', false, `data-pane="${k}"`)).join('')}</main>` +
    `<nav class="tabs">${TABS.map(([k, , label]) => rb(label, `data-tab="${k}"`, k === prepTab)).join('')}</nav>`;
  setTab = k => {
    prepTab = k;
    box.querySelector('.panes').dataset.tab = prepTab || '';
    for (const x of box.querySelectorAll('.tabs .rb')) x.classList.toggle('on', x.dataset.tab === prepTab);
    frame();
  };
  for (const b of box.querySelectorAll('.tabs [data-tab]')) b.onclick = () => {
    if (rec?.phase === 'go') return;  // (the swap under way: recruitSwap)
    const k = prepTab === b.dataset.tab ? null : b.dataset.tab;
    if (rec && k !== 'recruit') { endRecruit(); A.turnTo(frontOf(W.chars[0].w.heading || [1, 1])); }  // (as 取消招募)
    if (k === 'recruit' && !rec) recruitScene();
    setTab(k);
  };
  // (出發: the party teleports away, black, the loading screen, and on the map they teleport in: by request)
  $('p-go').onclick = async () => {
    if (rec?.phase === 'go' || !plan) return;
    endRecruit();
    prepId++; prepChanged = null; setTab = null; pool.stop();
    allocClose?.();
    if (G.recruits) { G.recruits = null; put(); }  // (those who would have joined gone as the party sets off)
    show('s-prep'); $('prep').innerHTML = '';
    A.setView(0, 0); A.setFocus(null);  // (the windows gone: the camera on the party as in the fight, by request)
    await sleep(600);
    await teleportOut(townT, true);
    await fadeOut(true);
    startFight();
  };
  // (對戰's 開戰, as 出發: the recruits stay on offer, the party coming back to this town)
  $('p-vgo').onclick = async () => {
    if (rec?.phase === 'go' || !pvpTeams().length) return;
    endRecruit();
    prepId++; prepChanged = null; setTab = null; pool.stop();
    allocClose?.();
    pvpFight();
    show('s-prep'); $('prep').innerHTML = '';
    A.setView(0, 0); A.setFocus(null);
    await sleep(600);
    await teleportOut(townT, true);
    await fadeOut(true);
    startFight();
  };
  // 轉職: the leader's two second jobs side by side (by request: no carousel for two), each in what it would wear
  // (jobPreview), as the first jobs' carousel has them (by request): no frames, under them the place it changes at
  // and the job's name, the one picked (the first at first;
  // one tapped, or ←→) in its battle stance, the other standing and faded, 轉職 taking the leader to its job change room
  // to change there (secondJobScene; its skill points all spent first, as in RO)
  let jobPick = seconds[0] || null, duoAt = null;
  if (seconds.length) {
    $('p-job').innerHTML = `<div class="jobduo">${seconds.map((j, i) => `<button class="jd" data-i="${i}" title="${esc(jobName(j, lead.look.sex))}"><canvas width="120" height="136"></canvas></button>`).join('')}</div>` +
      `<div class="jcname"><span class="town"><img id="p-jmap" alt=""><small id="p-jtown"></small></span><b id="p-jname"></b></div>` +
      `<p class="bad" id="p-jleft" hidden></p>`;
    const looks = seconds.map(j => { const look = jobPreview(lead, j); LOOK.loadLook(look, () => {}); return look; });
    const btns = [...$('p-job').querySelectorAll('.jd')];
    duoAt = btns;
    for (const b of btns) b.onclick = () => { jobPick = seconds[+b.dataset.i]; drawJob(); };
    const keys = e => {
      if (!btns[0].isConnected) return removeEventListener('keydown', keys);
      if (!btns[0].offsetParent || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      jobPick = seconds[Math.max(0, Math.min(seconds.length - 1, seconds.indexOf(jobPick) + (e.key === 'ArrowLeft' ? -1 : 1)))];
      drawJob();
    };
    addEventListener('keydown', keys);
    const frame = t => {
      if (!btns[0].isConnected) return;
      requestAnimationFrame(frame);
      if (!btns[0].offsetParent) return;
      btns.forEach((b, i) => figureAt(b.querySelector('canvas'), looks[i].ch, seconds[i] === jobPick, t));
    };
    requestAnimationFrame(frame);
  }
  const drawJob = () => {
    if (!duoAt || !$('p-job')) return;
    const left = sim.fitSkills(lead).left;
    for (const b of duoAt) b.classList.toggle('on', seconds[+b.dataset.i] === jobPick);
    // (under them, as the first jobs' carousel: where it changes, its minimap at the left, and the job's name)
    const room = jobPick && roomOf(jobPick, lead.look.sex), src = room ? `../assets/png/minimap/small/${encodeURIComponent(room.at)}.png` : '';
    $('p-jname').textContent = jobPick ? jobName(jobPick, lead.look.sex) : '';
    $('p-jtown').textContent = room ? room.zh : '';
    if ($('p-jmap').getAttribute('src') !== src) $('p-jmap').src = src;
    $('p-jleft').hidden = !left;
    $('p-jleft').textContent = `還有 ${left} 點技能點數沒用，用完才能轉職`;
    $('p-jgo').disabled = !jobPick || left > 0;
  };
  if (duoAt) $('p-jgo').onclick = () => {
    if (!jobPick || sim.fitSkills(lead).left > 0 || rec?.phase === 'go') return;
    endRecruit();
    prepId++; prepChanged = null; setTab = null; pool.stop();
    allocClose?.();
    prepTab = null;
    secondJobScene(jobPick);
  };
  drawJob();
  prepChanged = () => { runOdds(); drawJob(); };
  // 關卡: the map, then its waves
  const drawMap = () => {
    $('p-go').disabled = !plan;
    if (!plan) { $('p-map').innerHTML = '<span class="loading">依隊伍現在的樣子規劃地圖中…</span>'; return; }
    $('p-map').innerHTML = `<div class="maphead"><img src="../assets/png/minimap/small/${encodeURIComponent(plan.theme.map)}.png" alt="" onerror="this.style.visibility='hidden'">` +
      `<div><div class="name">${esc(plan.theme.label)}</div><div class="row"><span class="tag ${PHASE_CLASS[plan.phase.name] || ''}">${esc(plan.phase.name)}</span>${plan.hard ? '<span class="tag hard">困難</span>' : ''}<span>${plan.waves.length} 波・共 ${plan.waves.flat().length} 隻</span></div>` +
      `<div class="row muted small">${plan.chain ? `收入約 ${plan.income} z${plan.par ? `・${Math.round(plan.par)} 秒內過關有獎勵` : ''}` : '依隊伍現在的樣子規劃'}</div></div></div>` +
      // (by request: once a map is won, the next one's normal or hard version, the hard one harder and paying more)
      (G.maps && chainMap(G.level)?.hard ? `<div class="row diff"><span class="k">難度</span>${rb('普通', 'data-hard="0"', !G.hard)}${rb('困難', 'data-hard="1"', !!G.hard)}` +
        `<span class="muted small">${G.hard ? `收入 ×${chain.hard?.pay || 1.5}，比較容易全滅` : `困難版：收入約 ${chainMap(G.level, true).income} z`}</span></div>` : '') +
      `<div class="waves">${wavesHtml(plan)}</div>`;
    for (const b of $('p-map').querySelectorAll('[data-hard]')) b.onclick = () => {
      if (!!+b.dataset.hard === !!G.hard) return;
      G.hard = !!+b.dataset.hard;
      G.plan = null;
      put();
      prep();
    };
    drawWaveThumbs();
    // (a monster tapped: its details over the window, the same one again or × closing them)
    let open = null;
    const card = $('p-mob'), shut = () => { open = null; card.hidden = true; for (const x of $('p-map').querySelectorAll('.mob.on')) x.classList.remove('on'); };
    card.querySelector('.tb .x').onclick = shut;
    for (const el of $('p-map').querySelectorAll('.mob[data-id]')) el.onclick = () => {
      const key = el.dataset.w + '/' + el.dataset.id;
      if (open === key) return shut();
      shut();
      open = key;
      el.classList.add('on');
      $('p-mobinfo').innerHTML = mobCard(plan.waves[+el.dataset.w].map(baseMob).find(d => String(d.id) === el.dataset.id));
      card.hidden = false;
      card.querySelector('.wb').scrollTop = 0;
    };
    card.hidden = true;
  };
  // 商店: the bag, then each potion with − +1 +10 (− takes back what was bought here)
  const drawShop = () => {
    const lv = partyLv(), bag = Object.entries(G.bag).filter(([, n]) => n > 0);
    $('p-supply').innerHTML = `<div class="bagrow"><b style="color:var(--labeltext)">背包</b>${bag.length ? bag.map(([i, n]) => `<span class="bagit">${itemIcon(i)}×${n}</span>`).join('') : '<span class="muted">空的</span>'}` +
      `<span style="flex:1"></span><span class="zbig">${G.zeny.toLocaleString()} z</span></div>` +
      // (only what is on sale at the party's level: by request)
      L.SHOP.filter(([, , from]) => lv >= from).map(([itemId, price]) => {
        const it = db.items[itemId] || {}, have = G.bag[itemId] || 0;
        return `<div class="item">${itemIcon(itemId)}<div class="what"><span>${esc(it.name || itemId)}</span><small>${itemUse(it)}</small></div>` +
          `<div class="price">${price} z<small>持有 ${have}</small></div>` +
          `<div class="step">${rb('−', `data-buy="${itemId}" data-k="-1"${bought[itemId] ? '' : ' disabled'} aria-label="退回一瓶"`) +
            rb('+1', `data-buy="${itemId}" data-k="1"${G.zeny >= price ? '' : ' disabled'}`) + rb('+10', `data-buy="${itemId}" data-k="10"${G.zeny >= price * 10 ? '' : ' disabled'}`)}</div></div>`;
      }).join('');
    for (const b of $('p-supply').querySelectorAll('[data-buy]')) b.onclick = () => {
      const itemId = +b.dataset.buy, price = L.SHOP.find(x => x[0] === itemId)[1], k = Math.max(+b.dataset.k, -(bought[itemId] || 0));
      if (G.zeny < price * k) return;
      G.zeny -= price * k;
      G.bag[itemId] = (G.bag[itemId] || 0) + k;
      if (!G.bag[itemId]) delete G.bag[itemId];
      bought[itemId] = (bought[itemId] || 0) + k;
      put();
      drawShop();
      runOdds();
      frame();
    };
  };
  // (the grade once all ODDS_RUNS are in: a share of them would flip it back and forth meanwhile)
  const drawOdds = () => {
    const done = odds.runs.length, k = odds.runs.filter(r => !r.wiped).length / Math.max(1, done), all = done >= ODDS_RUNS;
    const [label, cls, about] = k >= TIERS[0] ? ['輕鬆', 'good', '很少輸'] : k >= TIERS[1] ? ['有挑戰', 'warn', '會輸一些'] : ['危險', 'bad', '常常輸'];
    $('p-odds').textContent = all ? label : '…';
    $('p-odds').className = 'odds ' + (all ? cls : '');
    $('p-odds').title = all ? `隊伍和背包現在的樣子：${about}` : `評估中 ${done}/${ODDS_RUNS}`;
    $('p-meter').style.width = pct(done / ODDS_RUNS);
  };
  // the grade, again whenever the bag or the leader's points change (the runs drink from the bag); none fought
  // while 選項's 難度 is off (turned on: prepChanged)
  const runOdds = () => {
    document.body.classList.toggle('no-odds', !settings.odds);
    if (!plan) return;  // (the workers planning it meanwhile: not stopped)
    if (!settings.odds) { odds.key = null; pool.stop(); return; }
    const key = JSON.stringify([G.bag, W.chars.map(c => [c.look.job, c.build, c.skillBuild, c.stats, c.levels, c.arm, c.armL, c.body, c.look.shield, c.cards])]);
    if (key === odds.key) return;
    odds.key = key; odds.runs = [];
    drawOdds();
    pool.runs(plan, ODDS_RUNS, partyMsg(), run => { if (id === prepId && odds.key === key) { odds.runs.push(run); drawOdds(); } });
  };
  drawMap(); drawShop(); drawOdds(); drawPvp();
  frame();
  runOdds();
  if (cover) uncover();
  if (slow) planning.then(p => { if (id !== prepId) return; plan = p; drawMap(); runOdds(); frame(); },
    e => { if (id !== prepId) return; $('p-map').innerHTML = `<span class="bad">${esc(e.message || e)}</span> ${rb('重試', 'onclick="location.reload()"')}`; });
  // (the recruits due their second job change once the party has landed: recruitJobs; by request, no windows nor
  // buttons till they all have: the map ahead drawn again after)
  if ((how === 'arrive' || how === 'load') && W.chars.some((c, i) => i > 0 && jobDue(c))) {
    prepId++; prepChanged = null; setTab = null; pool.stop();
    box.innerHTML = '';
    A.setView(0, 0); A.setFocus(null);
    landed = Promise.resolve(landed).then(recruitJobs);
  }
  return landed;
}
// Out of a map, the leader with a stat point it can spend or a skill point has a light bulb over its head (by
// request), staying there while it has (EF_EMOTE_LOOP: played over and over); not while it is off the field (walked by
// the game: offstage), while recruits are due their job change (by request: recruitJobs), while recruiting (by
// request: rec) nor from the Novice's start until its party is made in its job's town (by request: G.train). Points
// it cannot spend do not count (by request): stat points too few to raise every stat (any one short of them, none),
// skill points no skill can take
// (fitSkills' top: a level over the one it has). Its points looked at every BULB_MS.
const BULB_MS = 500;
let bulb = null, bulbAt = 0, bulbWant = false;
const bulbOff = () => !!(run || rec || G?.train || G?.view);
function leaderBulb() {
  const c = W.chars[0], now = performance.now();
  if (now >= bulbAt) {
    bulbAt = now + BULB_MS;
    bulbWant = false;
    if (!bulbOff() && c && c.w?.pos && !c.offstage && c.dead == null && !W.chars.some((x, i) => i > 0 && jobDue(x))) {
      const jj = sim.jobFor(c), left = B.pointsTotal(db, jj, c.blv) - B.pointsSpent(c.stats);
      const f = sim.fitSkills(c);
      const open = B.STATS.filter(s => c.stats[s] < jj.maxStat);
      bulbWant = open.length > 0 && open.every(s => B.statCost(c.stats[s]) <= left) ||
        f.left > 0 && Object.entries(f.top).some(([k, lv]) => lv > (c.levels[k] || 0));
    }
  }
  const want = bulbWant && !bulbOff() && c && !c.offstage;
  if (want && (!E.showing(bulb, townT) || bulb.w !== c.w)) {
    E.stop(bulb, townT);
    bulb = E.play('EF_EMOTE_LOOP', c.w, townT, undefined, { head: 95, action: E.EMOTE_ACTION[ET_AHA] });  // (95: stage.js PC_TOP)
  } else if (!want && bulb) { E.stop(bulb, townT); bulb = null; }
}
// a recruit at the job level it was to change jobs at, to the second job it was on its way to (by request)
const jobDue = c => !!(c.second && c.changeAt && sim.jobFor(c).tier === 1 && c.jlv >= c.changeAt);
// clif_emotion's ET_AHA: a light bulb
const ET_AHA = 5;
// The recruits due their second job change it in town (by request, not where the map was won), once the party has
// teleported in there: one after another, it stands up, a light bulb over its head, 2 s, and it walks off to its job
// change room and back as the leader does (secondJobScene); then the next, the map ahead drawn again after the last
// (none of its windows meanwhile: prep).
async function recruitJobs() {
  let k;
  // (by index: the party is made anew as each comes back, bringParty)
  while (!run && (k = W.chars.findIndex((c, i) => i > 0 && jobDue(c))) > 0) {
    const c = W.chars[k];
    if (c.sitting) sim.sit(c, false);
    E.play('EF_EMOTE', c.w, townT, undefined, { head: 95, action: E.EMOTE_ACTION[ET_AHA] });  // (95: stage.js PC_TOP)
    await sleep(2000);
    if (run || W.chars[k] !== c) break;
    endRecruit();
    prepId++; prepChanged = null; setTab = null; pool.stop();
    allocClose?.();
    prepTab = null;
    await secondJobScene(c.second, k, true);
  }
  if (!run) await prep();
}
const PHASE_CLASS = { 普通: 'p0', 特殊: 'p1', BOSS: 'p2' };
// ---------- 裝備 ----------
// The party's equipment (by request): free, the best a character can have at its base level put on it — the weapons
// on sale in any of the game's towns (jobs.json weaponShops, from levels.js weaponFrom), the body armours and shields
// the armour dealers sell (jobs.json armors, from levels.js armorFrom). What it holds is the player's to pick
// (c.hands, kept: { right: a weapon type, left: 'shield', 'none' or a weapon type }, the 裝備 tab): the best weapon of
// that type in its right hand (a staff's by MATK, any other's by ATK), and in its left the best shield, nothing, or
// with Lefthand Mastery (sim.dualWields) and a dagger, a one-handed sword or an axe in the right, the best of one of
// those (as RO's assassins: DUAL). A type it cannot have yet (none at its level) waits for the level, the best of
// what it can have meanwhile: the one it held, or its job's usual one (look.js defaultWeapon), or any.
const { DUAL, dualSprite, bestArm, armTypes, bestArmor } = L;
// what c holds and wears put on it (as c.hands picks: levels.js putOnGear) → whether its sprites changed (to load
// again: LOOK.loadLook)
function autoGear(c) {
  const was = [c.look.weapon, c.look.shield], dflt = LOOK.defaultWeapon(c.look.job, c.look.sex);
  const usual = Object.keys(WEAPON_SPRITE).find(t => WEAPON_SPRITE[t] === dflt);
  c.look.weapon = L.putOnGear(c, usual) || dflt || c.look.weapon;
  return was[0] !== c.look.weapon || was[1] !== c.look.shield;
}
// the whole party's (at the map ahead), kept
function gearAll() {
  for (const c of W.chars) { if (autoGear(c)) LOOK.loadLook(c.look, () => {}); sim.calc(c); }
  keep();
}
// The headgear (by request: looks only, no numbers; jobs.json headgear, drawn by look.js): worn as c.look.hats { top,
// mid, low } (one over more than a slot under each), the party's not worn in G.hats (item ids, one a piece). A recruit
// from Lv 20 comes with some (rollHats, its own: c.ownHats); one taken off goes to the party's (an own one too, the
// party's from then on). The party's on a member that leaves come back to it (returnHats); a BOSS map won brings one
// (mapOver).
const HAT_SLOTS = ['top', 'mid', 'low'];
const hatIcon = id => `<img src="../assets/png/item/${id}.png" alt="" onerror="this.style.visibility='hidden'">`;
// the odds a recruit of base level lv has one in slot k (by request: from Lv 20, small at first, each slot its own):
// 10 % at Lv 20 up to 60 % on the head (top) and 35 % for the others at Lv 99, on a line
const hatChance = (lv, k) => lv < 20 ? 0 : 0.1 + ((k === 'top' ? 0.6 : 0.35) - 0.1) * Math.min(1, (lv - 20) / 79);
// a recruit's headgear: each slot by its odds, one its job can wear (L.canWear) whose slots are all still free
function rollHats(job, lv) {
  const hats = {}, jj = db.jobs[job], all = Object.entries(db.headgear || {});
  for (const k of HAT_SLOTS) {
    if (hats[k] || Math.random() >= hatChance(lv, k)) continue;
    const pick = anyOf(all.filter(([, g]) => g.slots.includes(k) && g.slots.every(x => !hats[x]) && L.canWear(jj, g)));
    if (pick) for (const x of pick[1].slots) hats[x] = +pick[0];
  }
  return Object.keys(hats).length ? hats : null;
}
// character c takes off what it wears in slot k (all the slots that one takes): to the party's
function takeOffHat(c, k) {
  const id = c.look.hats?.[k];
  if (!id) return;
  for (const x of HAT_SLOTS) if (c.look.hats[x] === id) delete c.look.hats[x];
  c.ownHats = (c.ownHats || []).filter(x => x !== id);
  (G.hats ??= []).push(id);
}
// c puts on one of the party's (id): off the party's, what it wore in its slots taken off
function putOnHat(c, id) {
  const i = (G.hats || []).indexOf(id), g = db.headgear[id];
  if (i < 0 || !g) return;
  G.hats.splice(i, 1);
  c.look.hats ??= {};
  for (const k of g.slots) takeOffHat(c, k);
  for (const k of g.slots) c.look.hats[k] = id;
}
// the party's on a member leaving (not its own) back to the party; its cards all back to the party's (by request)
function returnHats(c) {
  for (const id of new Set(Object.values(c.look.hats || {}).filter(Boolean))) if (!(c.ownHats || []).includes(id)) (G.hats ??= []).push(id);
  if (c.cards?.length) { (G.cards ??= []).push(...c.cards); c.cards = []; }
}

// 裝備 (a tab of the character's window, by request): its slots, 頭 耳 嘴 (headgear: none yet) 身 (its armour, by
// level) 右手 左手; a hand tapped lists what it may hold there (the best of each kind at its level), picked at the
// map ahead (edit); `open`, the slot whose list is shown
const HAT_OF = { head: 'top', ear: 'mid', mouth: 'low' };
const HAT_ZH = { top: '頭', mid: '耳', low: '嘴' };
// a headgear's line: the slots it takes, and (on c, worn: id) whether it came with c
const hatLine = (g, c, id) => g.slots.map(k => HAT_ZH[k]).join('＋') + (c && (c.ownHats || []).includes(id) ? '・自己帶來的' : '');
const GEAR_SLOTS = [['head', '頭'], ['ear', '耳'], ['mouth', '嘴'], ['body', '身'], ['left', '左手'], ['right', '右手']];  // (two by two: 左手 on the left, by request)
function gearHtml(c, open, edit) {
  const icon = id => `<img src="../assets/png/item/${id}.png" alt="" onerror="this.style.visibility='hidden'">`;
  const arm = c.arm && db.gear[c.arm], armL = c.armL && db.gear[c.armL], body = c.body && db.armors[c.body];
  const shieldId = c.look.shield && sim.SHIELDS[c.look.shield]?.id, shield = shieldId && db.armors[shieldId];
  const armLine = g => `${WEAPON_ZH[g.type] || g.type}・ATK ${g.atk}${g.matk ? `・MATK ${g.matk}` : ''}`;
  const hat = k => { const id = c.look.hats?.[k], g = id && db.headgear?.[id]; return g && [id, g.name, hatLine(g, c, id)]; };
  const has = { head: hat('top'), ear: hat('mid'), mouth: hat('low'), body: body && [c.body, body.name, `DEF ${body.def}${body.mdef ? `・MDEF ${body.mdef}` : ''}`], right: arm && [c.arm, arm.name, armLine(arm)],
    left: armL ? [c.armL, armL.name, armLine(armL)] : shield ? [shieldId, shield.name, `盾・DEF ${shield.def}`]
      : arm && sim.BOTH_HANDS.has(arm.type) ? [c.arm, arm.name, armLine(arm)] : null };  // (a two-handed one in both hands: by request)
  const slot = ([k, label]) => { const x = has[k]; return rb(`<span class="gk">${label}</span>${x ? icon(x[0]) : ''}<span class="gn">${x ? esc(x[1]) : '—'}</span>`, `data-gear="${k}"`, k === open); };
  const row = (id, name, line, pick, on) => `<div class="item gpick">${id ? icon(id) : '<span></span>'}<div class="what"><span>${esc(name)}</span><small>${line}</small></div>` +
    (on ? rb('裝備中', 'disabled') : rb('裝備', `data-pick="${pick}"${edit ? '' : ' disabled'}`)) + '</div>';
  let list = '';
  if (open === 'head' || open === 'ear' || open === 'mouth') {
    const k = HAT_OF[open], worn = c.look.hats?.[k], jj = sim.jobFor(c);
    const mine = [...new Set(G.hats || [])].filter(id => db.headgear[id]?.slots.includes(k));
    list = (worn ? `<div class="item gpick">${hatIcon(worn)}<div class="what"><span>${esc(db.headgear[worn].name)}</span><small>${hatLine(db.headgear[worn], c, worn)}</small></div>` +
        rb('卸下', `data-hatoff="${k}"${edit ? '' : ' disabled'}`) + '</div>' : '') +
      mine.map(id => { const g = db.headgear[id], n = G.hats.filter(x => x === id).length, ok = L.canWear(jj, g);
        return `<div class="item gpick${ok ? '' : ' off'}">${hatIcon(id)}<div class="what"><span>${esc(g.name)}${n > 1 ? ` ×${n}` : ''}</span><small>${ok ? hatLine(g) : '這個職業不能戴'}</small></div>` +
          rb('裝備', `data-haton="${id}"${edit && ok ? '' : ' disabled'}`) + '</div>'; }).join('') ||
      (worn ? '' : '<div class="muted">隊伍沒有可以戴在這裡的頭飾。打完 BOSS 會得到。</div>');
  }
  else if (open === 'body') list = `<div class="muted">依等級自動穿上最好的鎧甲${body ? `：${esc(body.name)}` : '（還沒有）'}。</div>`;
  else if (open === 'right') {
    const right = arm && arm.type;
    list = armTypes(c).map(t => { const [i, g] = bestArm(c, t); return row(i, g.name, armLine(g), 'R:' + t, t === right); }).join('') || '<div class="muted">還沒有可以拿的武器。</div>';
  } else if (open === 'left') {
    const right = arm && arm.type;
    if (right && sim.BOTH_HANDS.has(right)) list = `<div class="muted">${esc(WEAPON_ZH[right] || right)}要用雙手拿，左手不能拿東西。</div>`;
    else {
      const sh = bestArmor(c, 'shield'), now = armL ? armL.type : shield ? 'shield' : 'none';
      list = (sh ? row(sh[0], sh[1].name, `盾・DEF ${sh[1].def}`, 'L:shield', now === 'shield') : '') +
        (right && DUAL.includes(right) && sim.dualWields(c) ? DUAL.filter(t => dualSprite(right, t)).map(t => bestArm(c, t) && [t, ...bestArm(c, t)]).filter(Boolean)
          .map(([t, i, g]) => row(i, g.name, armLine(g) + '（左手）', 'L:' + t, now === t)).join('') : '') +
        row(null, '不拿東西', '', 'L:none', now === 'none');
    }
  }
  return `<div class="gearslots">${GEAR_SLOTS.map(slot).join('')}</div>${open ? `<div class="gearlist">${list}</div>` : ''}`;
}

// ---------- cards (by request) ----------
// The party's cards: each character's on it (c.cards, as many as it likes, wherever RO would slot them), the rest the
// party's to give (G.cards), put on and taken off in a character's 卡片 tab at the map ahead. After a map won (not the
// training ground), before the party flies back to town, cards are offered (rollCards: CARD_PICK, the hard version of
// a map one more) and one of them taken, into G.cards (none passed over: by request). The offer is saved as it is
// made (G.draw), a reload showing the same. The pool: jobs.json cards the simulation works out (cards.js supported);
// an MVP's only on a BOSS map, one of them there among the offer.
const CARD_PICK = 3;
const cardPool = () => Object.keys(db.cards || {}).map(sim.cardOf).filter(x => x && supported(x));
function rollCards(plan) {
  const all = cardPool(), hard = !!plan.hard, pool = all.filter(x => !x.mvp), out = [];
  const take = list => { const left = list.filter(x => !out.includes(x)); if (left.length) out.push(anyOf(left)); };
  if (plan.phase?.name === 'BOSS') take(all.filter(x => x.mvp));
  // (a hard map's, by request: one or two of them like a card the party has on, cards.js cardKeys — as many as there are)
  if (hard) {
    const have = new Set(W.chars.flatMap(c => (c.cards || []).flatMap(id => sim.cardOf(id) ? cardKeys(sim.cardOf(id)) : [])));
    const like = pool.filter(x => cardKeys(x).some(k => have.has(k)));
    for (let k = between(1, 2); k > 0; k--) take(like);
  }
  while (out.length < CARD_PICK + (hard ? 1 : 0) && out.length < all.length) take(pool.length > out.length ? pool : all);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out.map(x => x.id);
}
// A hand of cards (by request: held as playing cards and swiped through, floating over the scene, no window): the
// cards' illustrations side by side, overlapping, those to each side a little turned, lower and smaller (a slight
// fan), the middle one whole and lit; dragged sideways (following the finger, let go to the nearest), a neighbour
// tapped or ←→ bringing one to the middle; shown(i) whenever the middle one changes. With put and pile (the stack at
// the top left, by request): the middle one dragged up past HAND.up of its height and let go (or ↑) flies into the
// pile, then put(i); short of it, it goes back. → { cur }
const HAND = { step: 0.56, rot: 3.5, drop: 2.5, scale: 0.9, up: 0.7 };
function cardHand(fan, ids, at, shown, put = null, pile = null) {
  const n = ids.length;
  let pos = Math.max(0, Math.min(n - 1, at)), last = -1, drag = null, gone = false;
  fan.innerHTML = ids.map((id, i) => { const x = sim.cardOf(id); return `<div class="hc" data-i="${i}">${x?.art ? `<img src="../assets/${x.art}" alt="" draggable="false">` : ''}</div>`; }).join('');
  const els = [...fan.children], cur = () => Math.max(0, Math.min(n - 1, Math.round(pos)));
  const zoom = () => fan.getBoundingClientRect().width / (fan.offsetWidth || 1) || 1;  // (the page's --z: client px to the fan's)
  const at0 = o => {  // a card o from the middle: where it sits, its turn and size
    const d = Math.abs(o), w = els[0].offsetWidth, k = Math.min(d, 1);
    return { x: o * w * HAND.step, y: Math.min(d, 4) ** 2 * HAND.drop, r: o * HAND.rot, s: 1 - k * (1 - HAND.scale), hide: d * w * HAND.step > fan.offsetWidth / 2 + w };
  };
  const set = (el, t, lift = [0, 0], extra = '') => { el.style.transform = `translate(${(t.x + lift[0]).toFixed(1)}px, ${(t.y + lift[1]).toFixed(1)}px) rotate(${t.r.toFixed(2)}deg) scale(${t.s.toFixed(3)})${extra}`; };
  const place = (anim = true) => {
    fan.classList.toggle('drag', !anim);
    els.forEach((el, i) => {
      const o = i - pos, t = at0(o);
      set(el, t);
      el.style.zIndex = String(100 - Math.round(Math.abs(o) * 2));
      el.style.visibility = t.hide ? 'hidden' : '';
      el.classList.toggle('mid', Math.round(o) === 0);
      el.classList.remove('ready');
    });
    pile?.classList.remove('ready');
    if (cur() !== last) shown(last = cur());
  };
  const go = d => { pos = Math.max(0, Math.min(n - 1, Math.round(pos) + d)); place(); };
  // (into the pile: from where it is to the pile's middle, small and turned, then put)
  const fly = (lift = [0, 0]) => {
    if (gone || !put || !pile) return;
    gone = true;
    const i = cur(), el = els[i], z = zoom(), a = el.getBoundingClientRect(), b = pile.getBoundingClientRect();
    el.classList.add('fly');
    set(el, at0(i - pos), [lift[0] + (b.left + b.width / 2 - a.left - a.width / 2) / z, lift[1] + (b.top + b.height / 2 - a.top - a.height / 2) / z], ' rotate(-14deg) scale(.3)');
    el.style.opacity = '.5';
    setTimeout(() => put(i), 200);
  };
  fan.onpointerdown = e => {
    if (gone) return;
    drag = { x: e.clientX, y: e.clientY, pos, axis: null, id: e.pointerId, on: e.target.closest('.hc'), lift: [0, 0] };
    fan.setPointerCapture(e.pointerId);
  };
  fan.onpointermove = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const z = zoom(), dx = (e.clientX - drag.x) / z, dy = (e.clientY - drag.y) / z;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.axis = put && drag.on && +drag.on.dataset.i === cur() && -dy > Math.abs(dx) ? 'y' : 'x';
    }
    if (drag.axis === 'x') {
      pos = drag.pos - dx / (els[0].offsetWidth * HAND.step);
      pos = pos < 0 ? pos / 3 : pos > n - 1 ? n - 1 + (pos - n + 1) / 3 : pos;
      return place(false);
    }
    // (up: the middle one after the finger, lit once far enough to go)
    const el = els[cur()], ready = -dy > el.offsetHeight * HAND.up;
    drag.lift = [dx, Math.min(0, dy)];
    fan.classList.add('drag');
    set(el, at0(cur() - pos), drag.lift);
    el.classList.toggle('ready', ready);
    pile.classList.toggle('ready', ready);
  };
  const up = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const was = drag; drag = null;
    if (was.axis === 'y') return els[cur()].classList.contains('ready') ? fly(was.lift) : place();
    if (was.axis === 'x') return go(0);
    if (was.on) go(+was.on.dataset.i - cur());
  };
  fan.onpointerup = fan.onpointercancel = up;
  const keys = e => {
    if (!fan.isConnected) return removeEventListener('keydown', keys);
    if (!fan.offsetParent || gone) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') go(e.key === 'ArrowLeft' ? -1 : 1);
    else if (e.key === 'ArrowUp' && put) { e.preventDefault(); fly(); }
  };
  addEventListener('keydown', keys);
  place(false);
  return { cur };
}
// the stack at the top left (by request): the last three cards of `ids` slanted one over another (an empty outline
// for none), what it is and how many under it; tapped, the other side shown
function pileHtml(ids, label, id) {
  const top = ids.slice(-3);
  return `<button class="cpile" id="${id}"><span class="stk">${top.length ? top.map(k => { const x = sim.cardOf(k); return `<i>${x?.art ? `<img src="../assets/${x.art}" alt="">` : ''}</i>`; }).join('') : '<i class="none"></i>'}</span>` +
    `<b>${esc(label)}</b><small>${ids.length} 張</small></button>`;
}
// a card's details under the hand (by request: its name and what it does, no tags, not where RO slots it): its
// description (assets text/zh-TW/itemdesc: the cards' as scripts/carddesc.json writes them) without its 系列,
// 裝備/裝置 (where it is slotted) and 重量 lines; `who`: the characters it does nothing for named (its conditions: a
// Thief's card on another job, a sword's without a sword)
const CARD_DESC_SKIP = /^(系列|裝置|裝備|位置|重量)\s*[:：]/;
function cardInfo(id, who = []) {
  const x = sim.cardOf(id);
  if (!x) return '';
  const desc = (x.desc || '').split('\n').filter(l => !CARD_DESC_SKIP.test(l.replace(/\^[0-9a-fA-F]{6}/g, '').trim())).join('\n').trim();
  const off = who.filter(c => !activeCalls(x, sim.cardWho(c)).length);
  return `<div class="tb">${esc(x.name)}${off.length ? `<span class="cwarn">${off.map(c => esc(c.name || jobLabel(c.look.job))).join('、')}用不到</span>` : ''}</div>` +
    `<div class="cdesc">${descHtml(desc, esc)}</div>`;
}
// (the card's details put in `box`: its description, four lines high, faded at the foot with ▼ while there is more
// below to scroll to, by request)
function showCardInfo(box, id, who) {
  box.innerHTML = cardInfo(id, who);
  const d = box.querySelector('.cdesc');
  if (!d) return;
  const more = () => box.classList.toggle('more', d.scrollTop + d.clientHeight < d.scrollHeight - 2);
  d.onscroll = more;
  more();
}
// 卡片 (a character's tab, by request: no window, the hand floating over the scene): the cards on it or (edit: at the
// map ahead) the party's to give, the other side the stack at the top left (tapped: swapped), the middle one
// swiped up into it — taken off into the party's, or put on
let cardSide = 'on';
const cardAt = { on: 0, bag: 0 };
function cardTabHtml(c, edit) {
  const side = edit ? cardSide : 'on', list = side === 'on' ? c.cards || [] : G.cards || [];
  return (edit ? pileHtml(side === 'on' ? G.cards || [] : c.cards || [], side === 'on' ? '隊伍' : '身上', 'a-pile') : '') +
    `<div class="cardfloat">` +
    (list.length ? `<div class="fan" id="a-fan"></div><div class="win cinfo" id="a-cinfo"></div>`
      : `<div class="cnone">${side === 'on' ? '身上沒有卡片' : '隊伍沒有沒裝上的卡片'}</div>`) + '</div>';
}
// (the tab drawn: its hand made, the stack on; changed(put): after a card is put on or taken off, or the side swapped)
function cardTabOn(c, edit, changed) {
  if ($('a-pile')) $('a-pile').onclick = () => { cardSide = cardSide === 'on' ? 'bag' : 'on'; changed(false); };
  const side = edit ? cardSide : 'on', list = side === 'on' ? c.cards || [] : G.cards || [];
  if (!list.length || !$('a-fan')) return;
  cardHand($('a-fan'), list, cardAt[side], i => { cardAt[side] = i; showCardInfo($('a-cinfo'), list[i], [c]); }, edit ? i => {
    if (side === 'on') (G.cards ??= []).push(...c.cards.splice(i, 1));
    else (c.cards ??= []).push(...G.cards.splice(i, 1));
    cardAt[side] = Math.max(0, Math.min(i, list.length - 1));
    changed(true);
  } : null, $('a-pile'));
}
// 抽卡 (by request): G.draw's cards as a hand over the map won, as the 卡片 tab's, the one in the middle described
// (who of the party it does nothing for named), swiped up into the party's stack at the top left to take it (into
// G.cards); then done()
function drawCard(done) {
  const ids = G.draw.ids;
  $('result').innerHTML = `<div class="resinfo">${pileHtml(G.cards || [], '隊伍', 'r-pile')}<div class="cardfloat big">` +
    `<div class="fan big" id="r-fan"></div><div class="win cinfo" id="r-cinfo"></div></div></div>`;
  cardHand($('r-fan'), ids, Math.floor((ids.length - 1) / 2), i => { showCardInfo($('r-cinfo'), ids[i], W.chars); }, i => {
    (G.cards ??= []).push(ids[i]);
    G.draw = null;
    put();
    done();
  }, $('r-pile'));
  show('s-result');
}

// a weapon type (item_db SubType) in Chinese, and the sprite a character holds it as (index.json weapon types)
const WEAPON_ZH = { Dagger: '短劍', '1hSword': '單手劍', '2hSword': '雙手劍', '1hSpear': '單手矛', '2hSpear': '雙手矛', '1hAxe': '單手斧',
  '2hAxe': '雙手斧', Mace: '鈍器', Staff: '單手杖', '2hStaff': '雙手杖', Bow: '弓', Knuckle: '拳套', Musical: '樂器', Whip: '鞭子',
  Book: '書', Katar: '拳刃' };
const WEAPON_SPRITE = L.WEAPON_SPRITE;
const itemIcon = id => { const it = db.items[id]; return it && it.icon ? `<img src="../assets/${it.icon}" alt="">` : ''; };
const itemUse = it => [it.heal && `補 HP ${it.heal.join('–')}`, it.sp && `補 SP ${it.sp.join('–')}`,
  it.aspd != null && `這張地圖攻擊快 ${B.BUFF_SKILLS['ASPDPOTION' + it.aspd].cut() / 10}%`,
  it.minLevel && `Lv ${it.minLevel} 起`, it.noJobs && '服事、詩人系不能用',
  ...Object.entries(sim.ITEM_COST).filter(([, id]) => db.items[id] === it).map(([sk]) => `${db.skills[sk].zh || sk}用`)].filter(Boolean).join('，');
const mobName = d => (d.label || d.name).replace(/（.*）$/, '');
// the monster a wave's def is (a filler, levels.scaled's `id@k`: the one it is made of, as mob_db has it)
const baseMob = d => String(d.id).includes('@') ? db.mobs.find(m => m.id === +String(d.id).split('@')[0]) || d : d;
function wavesHtml(plan) {
  return plan.waves.map((w, i) => {
    // (a filler, `id@k`, with the monster it is made of: one entry, the monster as it is: by request)
    const kinds = new Map();
    for (const x of w) { const d = baseMob(x), k = kinds.get(d.id) || { d, n: 0 }; k.n++; kinds.set(d.id, k); }
    const boss = plan.shape === 'boss' && i === plan.waves.length - 1;
    return `<div class="wave${boss ? ' boss' : ''}"><span class="wn">${boss ? 'BOSS' : `第${i + 1}波`}</span><div class="mobs">${[...kinds.values()].map(({ d, n }) =>
      `<span class="mob" role="button" data-w="${i}" data-id="${esc(String(d.id))}" title="${esc(d.label || d.name)} Lv ${d.level}"><canvas width="64" height="64" data-mob="${esc(d.sprite)}"></canvas>` +
      `<span class="t"><b>${esc(mobName(d))}</b><small>Lv ${d.level}${n > 1 ? `・×${n}` : ''}</small></span></span>`).join('')}</div></div>`;
  }).join('');
}
// ---------- a monster's details (by request: tapped in the wave list, over the 關卡 window) ----------
const ELEMENT_ZH = { Neutral: '無', Water: '水', Earth: '地', Fire: '火', Wind: '風', Poison: '毒', Holy: '聖', Dark: '暗', Ghost: '念', Undead: '不死' };
const RACE_ZH = { Formless: '無形', Undead: '不死', Brute: '動物', Plant: '植物', Insect: '昆蟲', Fish: '魚貝', Demon: '惡魔',
  Demihuman: '人形', Angel: '天使', Dragon: '龍族' };
const SIZE_ZH = { Small: '小型', Medium: '中型', Large: '大型' };
// what its mode says of how it fights, of what the fight has (every wave's monsters come for the party: no 主動攻擊)
const MOB_HABITS = [[B.MD.CHANGETARGETMELEE, '被近戰打就換目標'], [B.MD.CHANGETARGETCHASE, '追擊時被打就換目標'], [B.MD.CHANGECHASE, '追擊時改追更近的'],
  [B.MD.RANDOMTARGET, '每次隨機選目標'], [B.MD.CASTSENSORIDLE | B.MD.CASTSENSORCHASE, '察覺詠唱'], [B.MD.DETECTOR, '看得到隱身'], [B.MD.NOCAST, '不用技能']];
const MOB_EXTRA = { KnockBackImmune: '不會被擊退', IgnoreMelee: '近戰無效', IgnoreRanged: '遠距離無效', IgnoreMagic: '魔法無效', IgnoreMisc: '其他傷害無效' };
const MOB_STATE = { any: '任何時候', idle: '閒置時', walk: '走動時', attack: '攻擊時', angry: '憤怒時', chase: '追擊時', follow: '跟隨時', anytarget: '有目標時', dead: '死亡時' };
const MOB_TARGET = { target: '目標', self: '自己', friend: '同伴', master: '主人', randomtarget: '隨機目標',
  around1: '周圍 3×3', around2: '周圍 5×5', around3: '周圍 7×7', around4: '周圍 9×9' };
const skillZh = name => { const sk = db.skills[name]; return sk ? sk.zh || sk.en || name : name; };
const MOB_COND = {
  always: () => '', onspawn: () => '出現時', myhpltmaxrate: v => `HP < ${v}%`, myhpinrate: v => `HP ${v}%`,
  friendhpltmaxrate: v => `同伴 HP < ${v}%`, rudeattacked: () => '被打卻打不回去', longrangeattacked: () => '被遠距離攻擊',
  skillused: v => `被${skillZh(Object.values(db.skills).find(sk => sk.id === +v)?.name || v)}打`, attackpcge: v => `被 ${v} 人以上圍攻`,
  attackpcgt: v => `被超過 ${v} 人圍攻`, casttargeted: () => '被當作詠唱目標', closedattacked: () => '被近身攻擊',
  mobnearbygt: v => `周圍怪物 > ${v}`, slavele: v => `手下 ≤ ${v}`, slavelt: v => `手下 < ${v}`, damagedgt: v => `受到傷害 > ${v}`,
  mystatuson: v => `自己有 ${v}`, mystatusoff: v => `自己沒有 ${v}`, friendstatuson: v => `同伴有 ${v}`, friendstatusoff: v => `同伴沒有 ${v}`,
};
const secs = ms => +(ms / 1000).toFixed(1) + ' 秒';
function mobCard(d) {
  const mode = B.mobMode(d);
  const rank = d.modes?.includes('Mvp') ? 'MVP' : d.class === 'Boss' ? '頭目' : '';
  const habits = MOB_HABITS.filter(([bit]) => mode & bit).map(([, t]) => t)
    .concat(mode & B.MD.CANMOVE ? [] : ['不會移動'], rank ? ['不受異常狀態'] : [], (d.modes || []).map(x => MOB_EXTRA[x]).filter(Boolean));
  // (the skills the fight has: sim.usable; the same one at the same time in a few states, one row)
  const rows = new Map();
  for (const r of d.skills || []) {
    if (!sim.usable(r.skill) || r.skill === 'NPC_EMOTION') continue;
    const key = [r.skill, r.lv, r.cond, r.condValue, r.target].join();
    const x = rows.get(key) || rows.set(key, { r, states: [], rate: 0 }).get(key);
    if (!x.states.includes(r.state)) x.states.push(r.state);
    x.rate = Math.max(x.rate, r.rate);
  }
  const summons = r => (r.skill === 'NPC_SUMMONSLAVE' || r.skill === 'NPC_METAMORPHOSIS') && r.vals?.some(Boolean)
    ? `：${[...new Set(r.vals.filter(Boolean))].map(id => esc(mobName(db.mobs.find(m => m.id === id) || { name: String(id) }))).join('、')}` : '';
  // (element, race and size always, whether the party's attacks care or not: by request)
  const row = (t, v) => `<tr><th>${t}</th><td>${v}</td></tr>`;
  const n = x => Math.round(x).toLocaleString();
  return `<div class="mtitle"><b>${esc(mobName(d))}</b><span class="tag">Lv ${d.level}</span>${rank ? `<span class="tag p2">${rank}</span>` : ''}` +
    '</div>' +
    `<table class="mstat">${row('屬性', `${ELEMENT_ZH[d.element] || d.element} ${d.elementLv}`)}${row('種族', esc(RACE_ZH[d.race] || d.race))}${row('體型', esc(SIZE_ZH[d.size] || d.size))}` +
    row('HP', n(d.hp)) + row('ATK', `${n(d.atk)}　MATK ${n(d.matk)}`) + row('DEF', `${d.def}　MDEF ${d.mdef}`) +
    row('攻擊', d.range > 3 ? `遠距離，${d.range} 格` : `近戰${d.range > 1 ? `，${d.range} 格` : ''}`) +
    row('速度', `移動 ${d.walkSpeed} ms／格　攻擊間隔 ${secs(d.attackDelay)}`) + '</table>' +
    (habits.length ? `<div class="mtags">${habits.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : '') +
    (rows.size ? `<h4>技能</h4><table class="mskill">${[...rows.values()].map(({ r, states, rate }) => {
      const cond = (MOB_COND[r.cond] || (v => `${r.cond} ${v}`))(r.condValue);
      return `<tr><td>${esc(skillZh(r.skill))} <span class="muted">Lv ${r.lv}</span>${summons(r)}<br><span class="muted small">${states.map(x => MOB_STATE[x] || x).join('、')}${cond ? '・' + esc(cond) : ''}` +
        `・對${MOB_TARGET[r.target] || esc(r.target)}${r.cast ? `・詠唱 ${secs(r.cast)}` : ''}</span></td><td class="num">${+(rate / 100).toFixed(1)}%</td></tr>`;
    }).join('')}</table>` : '<div class="muted small">不用技能</div>');
}
// the monsters' standing sprites in the wave list (stage.mobSprite: the fight needs them loaded anyway): each drawn
// on a scratch canvas, cut to what it covers and fitted to its square, standing on its foot (not drawn bigger than it is)
const SCRATCH = 400;
function drawWaveThumbs() {
  for (const cv of document.querySelectorAll('canvas[data-mob]')) stage.mobSprite(cv.dataset.mob).then(spr => {
    if (!spr || !cv.isConnected) return;
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = SCRATCH;
    const t = tmp.getContext('2d', { willReadFrequently: true });
    t.setTransform(1, 0, 0, 1, SCRATCH / 2, SCRATCH * 0.75);
    t.imageSmoothingEnabled = false;
    LOOK.drawFrame(spr, LOOK.frameOf(spr, 0, 0), 0, 0, null, t);
    const box = alphaBox(t.getImageData(0, 0, SCRATCH, SCRATCH));
    if (!box) return;
    const g = cv.getContext('2d'), pad = 2, room = cv.width - pad * 2;
    const k = Math.min(2, room / box.w, room / box.h), w = box.w * k, h = box.h * k;
    g.clearRect(0, 0, cv.width, cv.height);
    g.imageSmoothingEnabled = k < 1;
    g.drawImage(tmp, box.x, box.y, box.w, box.h, (cv.width - w) / 2, cv.height - pad - h, w, h);
  });
}
// the box of what is not see-through in an ImageData, null when nothing is
function alphaBox({ data, width, height }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 8) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------- the workers (viewer/mapsim.js: the map panel's) ----------
// Each fight in a worker is a whole map in sim.TICK steps; several workers share them out. runs(plan, n, msg,
// each): plan fought n times from new dice, each run's outcome to `each` as it ends; fight(plan, seed, msg): one
// fight → a promise of its run (levels.planMap's). stop(): what is going on, dropped.
const pool = (() => {
  let workers = null, id = 0, tag = 0, sent = [], pend = new Map(), going = [];
  const start = () => {
    if (workers) return;
    const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    workers = Array.from({ length: n }, () => {
      const w = watchWorker(new Worker(new URL('mapsim.js' + new URL(import.meta.url).search, import.meta.url), { type: 'module' }), 'mapsim');  // (game/mapsim.js: why there)
      w.onmessage = ({ data: m }) => {
        if (m.id !== id) return;
        const f = pend.get(m.tag);
        if (!f) return;
        if (m.error) { pend.delete(m.tag); going[f.k]--; return f.reject(new Error(m.error)); }
        if (f.each) { f.each(m.run); if (--f.left <= 0) { pend.delete(m.tag); going[f.k]--; } }
        else { pend.delete(m.tag); going[f.k]--; f.resolve(m.run); }
      };
      return w;
    });
    sent = workers.map(() => false);
    going = workers.map(() => 0);
  };
  const send = (k, msg) => { workers[k].postMessage({ id, db: sent[k] ? undefined : db, ...msg }); sent[k] = true; };
  return {
    size: () => { start(); return workers.length; },
    stop() { id++; for (const f of pend.values()) f.reject?.(new Error('stale')); pend.clear(); going = going.map(() => 0); },
    runs(plan, n, msg, each) {
      start();
      this.stop();
      const seed = R.newSeed();
      for (let k = 0; k < workers.length; k++) {
        const mine = Array.from({ length: n }, (_, i) => i).filter(i => i % workers.length === k);
        if (!mine.length) continue;
        const t = ++tag;
        pend.set(t, { k, each, left: mine.length });
        going[k]++;
        send(k, { ...msg, tag: t, plan, seed, runs: mine });
      }
    },
    fight(plan, seed, msg) {
      start();
      return new Promise((resolve, reject) => {
        const t = ++tag, k = going.indexOf(Math.min(...going));
        going[k]++;
        pend.set(t, { k, resolve, reject });
        send(k, { ...msg, tag: t, plan, seed: 0, runs: [seed] });
      });
    },
  };
})();

// ---------- the fight ----------
// The clock (ms) the fight is stepped up to, moved on each frame by the time gone by × the speed (a frame long in
// coming counts as 250 ms at most), still while paused: while 選項 is open (by request). The speed is 選項's.
const clock = { t: 0, last: performance.now(), paused: false };
let run = null;  // the map on: { plan, start (beginFight's), map (fight.js MapRun), simT, T (s: the last wave down), over, end (ms: when it was over),
                //   replay ({ dur, playing }: the map fought again after a wipe, to watch: replayFight) }
let quiet = false;
const loud = f => (...x) => quiet ? undefined : f(...x);
async function startFight() {
  const pvp = G.fight?.pvp;  // (對戰: its map and the rival team, pvpFight)
  const plan = pvp ? pvp.plan : G.train ? trainPlan() : planned() ? G.plan.plan : await planNext();
  show(null);
  $('h-wave').textContent = $('h-lv').textContent = ''; $('h-mini').hidden = true; hudMap = null;
  loadingScreen(true);
  folk.stop();
  fadeSet(false);  // (from 出發's black: the loading screen's black, its bar)
  // the dice and the bag as the map starts, kept: the page loaded again fights it the same
  G.fight ??= { seed: R.newSeed(), bag: structuredClone(G.bag), zeny: G.zeny };
  put();
  // (the dev server's, in before anything else can hang: the fight as kept and the party as it goes in)
  if (devOn()) devlogNow('fight-load', { fight: G.fight, plan: pvp ? undefined : plan, builds: W.chars.map(buildOf), names: W.chars.map(c => c.name) });
  // (對戰's rival team: made as kept, their sprites loaded with the rest)
  const rivals = pvp ? pvp.rivals.chars.map(saved => { const c = sim.newChar(saved); c.name = saved.name || jobLabel(c.look.job); sim.calc(c); LOOK.loadLook(c.look, () => {}); return c; }) : null;
  // (and, one with a card that turns monsters into others, what it may turn one into: sim.classChangeMobs)
  const defs = [...plan.waves.flat(), ...[...W.chars, ...rivals || []].some(c => c.cardFx?.classChange) ? sim.classChangeMobs() : []];
  const names = [...new Set(defs.flatMap(d => [...sim.spritesOf(d)]))];
  let got = 0;
  const part = p => p.then(x => { loadingScreen(++got / (names.length + 2)); return x; });
  const rivalsReady = async () => { for (let i = 0; i < 200 && !(rivals || []).every(c => stage.motion.ready(c)); i++) await sleep(50); };
  const [sprs, floor] = await Promise.all([Promise.all(names.map(n => part(stage.mobSprite(n)))), part(A.loadFloor(plan.floor)), part(waitReady().then(rivalsReady)),
    new Promise(r => setTimeout(r, 900))]);  // (on a moment at least, whatever was loaded already: not a flash)
  fadeSet(true);
  loadingScreen(false);
  if (sprs.some(s => !s)) { fadeSet(false); $('h-wave').textContent = '讀不到怪物的圖，無法開始'; return; }
  const shown = plan.floor && floor && floor.key === plan.floor.map + '_' + plan.floor.i ? floor : null;
  beginFight(plan, { floor: shown, builds: W.chars.map(buildOf), seed: G.fight.seed, bag: G.fight.bag, zeny: G.fight.zeny, act: ACT_MS, lead: ARRIVE_MS,
    ...pvp && { rivals: { ...pvp.rivals, units: rivals } } });
  if (plan.train) W.chars.forEach(c => { c.undying = true; });
  teleportIn(FADE_MS * 0.6, null, clock.t);  // (the map's clock: at 0; all of them in by ARRIVE_MS)
  for (const c of W.rivals) stage.arrive(c, clock.t + FADE_MS * 0.6 + Math.random() * TP_SPREAD);  // (the rival team teleporting in as the party does)
  fadeOut(false);
  bagKey = null;
  playBgm(plan.bgm || plan.theme.map);
}
// the training ground (TRAIN) as a map: one wave of its monsters, not roused (fight.js MapRun: calm), on a floor of it
function trainPlan() {
  const waves = TRAIN.mobs.map(([id, n]) => Array(n).fill(L.scaled(db.mobs.find(m => m.id === id), TRAIN.k)));
  return { train: true, calm: true, theme: { id: TRAIN.map, map: TRAIN.map, label: TRAIN.label, level: 1 }, phase: { name: '普通' }, shape: 'swarm',
    waves, lull: 1, drop: 1, bgm: TRAIN.bgm, floor: L.floorOf(TRAIN.map, L.fixed(TRAIN.map)) };
}
// the fight from its start (startFight, and a replay going back): the party fresh as built (the sandbox's
// freshFight), the dice at seed, the bag and zeny as the map began
function beginFight(plan, start, replay = null) {
  folk.stop();
  sim.setFloor(plan.floor, start.floor && start.floor.heights);
  A.showFloor(start.floor);
  const list = [...W.chars];
  for (const c of list) { A.remove(c.w); sim.removeChar(c); }
  const fresh = (c, build) => {
    const { id, look, ...v } = sim.newChar(build);
    Object.assign(c, v);
    sim.calc(c);
  };
  list.forEach((c, i) => fresh(c, start.builds[i]));
  // (對戰: the rival team fresh as kept too, with its own bag and zeny: in again with the party, sim.resetWorld)
  if (start.rivals) {
    for (const c of W.rivals) stage.drop(c);
    start.rivals.units.forEach((c, i) => { fresh(c, start.rivals.chars[i]); c.name = start.rivals.chars[i].name || jobLabel(c.look.job); });
    sim.setRivals(start.rivals.units, structuredClone(start.rivals.bag), start.rivals.zeny);
  }
  if (!replay) { G.bag = structuredClone(start.bag); G.zeny = start.zeny; }
  R.seed(start.seed);
  W.allAggressive = false;
  sim.resetWorld(list, replay ? structuredClone(start.bag) : G.bag, start.zeny);
  stage.restart(list);
  run = { plan, start, map: plan.pvp ? new PvpRun() : new F.MapRun(plan, def => stage.placeMob(def, stage.loadedSprite(def.sprite))), simT: 0, T: 0, over: false, end: null, replay, kills: 0, down: new Set() };
  // (戰後報告's lowest point: the party's HP and its healers' SP as healing, levels.meter, as fight.js's margin)
  if (!replay) { const m = L.meter(list); run.low = { m, full: m(c => c.pc.maxHp, c => c.pc.maxSp), k: 1, wave: 0 }; }
  run.map.next = start.lead || 0;  // (the first wave once the party has teleported in: kept in start, a replay the same)
  for (const c of [...list, ...W.rivals]) c.canAct = start.act || 0;  // (and nobody doing anything till a moment after: ACT_MS)
  clock.t = 0;
  // (the dev server's: what the fight starts from, to fight it again headless, and everyone's status as worked out)
  if ((TRAIL.on = devOn())) {
    Object.assign(TRAIL, { events: [], snaps: [], pre: null, snapAt: -Infinity });
    beats();
    if (!replay) traceConfig();
    if (!replay) {
      // (not start.floor: the floor as shown, a three.js scene — plan.floor is what it is made from)
      const { units, ...rivals } = start.rivals || {};
      devlogNow('fight-start', { pvp: !!plan.pvp, plan, start: { ...start, floor: undefined, rivals: start.rivals ? rivals : undefined },
        units: [...list, ...W.rivals].map(c => ({ n: nameOf(c), tactic: c.tactic, rules: c.rules ? c.rules : undefined, cards: c.cards, pc: c.pc })) });
    }
  }
}
// 全滅's replay (by request): the map fought again from its start (the same dice, party and bag: the same fight),
// to its end (run.end) and no further; a seek back fights it from its start again, either way stepped up to `to`
// silently
function seekFight(to) {
  const r = run;
  if (!r || !r.replay) return;
  to = Math.floor(Math.max(0, Math.min(to, r.replay.dur)) / sim.TICK) * sim.TICK;
  if (to < r.simT) beginFight(r.plan, r.start, r.replay);
  quiet = true;
  try { while (run.simT + sim.TICK <= to) tick(run.simT += sim.TICK); }
  finally { quiet = false; }
  clock.t = run.simT;
  stage.render(run.simT);
}
// the loading screen as a map is entered: black with a bar (by request, not the client's pictures; on: true to show
// it, a share 0–1 for the bar, false to take it away)
function loadingScreen(on) {
  const el = $('loading');
  if (on === false) { el.hidden = true; return; }
  if (on === true) {
    el.querySelector('i').style.width = '0';
    el.hidden = false;
    return;
  }
  el.querySelector('i').style.width = pct(on);
}
function stopFight() {
  allocClose?.();
  $('replaybar').hidden = true;
  if (run) townT = run.simT;
  run = null;
  // (對戰's rival team gone with it: sim.resetWorld would bring it in again)
  for (const c of W.rivals) stage.drop(c);
  if (W.rivals.length) sim.setRivals([]);
  $('hud').hidden = true;
}
function tick(t) {
  if (TRAIL.on) trailStep(t);
  if (TRACE.from != null) {
    sim.debug.mark = gridDebug.mark = traceOn(t) ? traceMark : null;
    if (sim.debug.mark) devlogNow('tick', { t, n: ++TRACE.n, units: unitsNow() });
    if (t === TRACE.dumpAt) devlogNow('dump', { t, W: { t: W.t, tick: W.tick, unitNext: W.unitNext }, units: [...W.chars, ...W.rivals, ...W.mobs].map(u => dumpOf(u)) });
  }
  sim.step(t);
  if (run.over) return;
  run.map.step(t);
  if (run.map.state === 'fight') run.T = (t - (run.start.lead || 0)) / 1000;  // (from the first wave in, as the chain's par)
  if (run.low && run.map.state === 'fight') {
    const lo = run.low, k = lo.m(c => c.dead == null ? c.hp : 0, c => c.sp) / lo.full;
    if (k < lo.k) { lo.k = k; lo.wave = run.map.wave; }
  }
  if (run.plan.train) return trainStep(t);
  if (run.map.over && !run.over) { run.over = true; run.end = t; if (!run.replay) setTimeout(() => run?.plan.pvp ? pvpOver() : mapOver(t), 1200); }
}
// on the training ground: each of its monsters down a level (base and job) for the Novice up to TRAIN.top; the
// map over (its loot picked up), 結算 as after any map, then the job menu (by request: mapOver, trainOver); wiped,
// the game over as on any map
function trainStep(t) {
  const lead = W.chars[0];
  // (run.map.mobs: the wave on's only; run.down, those of every wave down so far)
  for (const m of run.map.mobs) if (m.dead != null && !run.down.has(m)) {
    run.down.add(m); run.kills++;
    if (lead.blv < TRAIN.top) sim.levelUp(lead, t);
  }
  if (!run.map.over) return;
  run.over = true; run.end = t;
  setTimeout(() => mapOver(t), 1500);  // (the level up seen first)
}
function loop(now) {
  const dt = Math.min(now - clock.last, 250);
  if (!clock.paused && !(run && run.replay && !run.replay.playing)) clock.t += dt * settings.speed * (run?.replay ? replayRate : 1);
  clock.last = now;
  // (a knight on the Peco or off it by itself, Riding learned or unlearned: sim.calc) its sprites again
  for (const c of W.chars) if (LOOK.mountStale(c.look)) LOOK.loadLook(c.look, () => {});
  if (run && run.replay) {
    if (clock.t >= run.replay.dur) { clock.t = run.replay.dur; run.replay.playing = false; }
    replayShown();
  }
  if (run) {
    for (let i = 0; i < MAX_STEPS && run.simT + sim.TICK <= clock.t; i++) tick(run.simT += sim.TICK);
    sim.debug.mark?.('render');
    stage.render(run.over || run.replay ? run.simT : clock.t);
    sim.debug.mark?.('hud');
    hud();
    sim.debug.mark?.('frame done');
  } else if (db && G) {  // (no game: nothing on the field, the title over it)
    folk.step(townT += dt);
    leaderBulb();
    stage.render(townT);
  }
  requestAnimationFrame(loop);
}
let bagKey = null, hudMap = null;
function hud() {
  const m = run.map, p = run.plan, n = p.waves.length;
  // the map's minimap, by it the level, its map and the wave, the bag in a row under them (by request)
  if (hudMap !== p) {
    hudMap = p;
    $('h-lv').textContent = p.train ? p.theme.label : p.pvp ? `對戰・${p.theme.label}` : `第 ${noOf(G)} 關・${p.theme.label}`;
    const img = $('h-mini');
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.hidden = true; };
    img.src = `../assets/png/minimap/small/${encodeURIComponent(p.theme.map)}.png`;
  }
  // the wave as 1/4: the one fought, or the one coming between them; all of them once done
  const up = xs => xs.filter(c => c.dead == null).length;  // (對戰: who of each side is standing)
  $('h-wave').textContent = p.pvp ? `${up(W.chars)} : ${up(W.rivals)}` : p.train ? `${run.kills}/${p.waves.flat().length}` : `${m.state === 'fight' ? m.wave + 1 : m.state === 'rest' ? Math.min(n, m.wave + 2) : m.state === 'wiped' ? Math.max(1, Math.min(n, m.wave + 1)) : n}/${n}`;
  // (the character shown on 行動: the rule it is on marked as it goes)
  if (allocOn && allocTab === 'act') $('alloc').querySelectorAll('.rules > li').forEach(li => li.classList.toggle('on', allocOn.rule === +li.dataset.i));
  stateIcons();
  // the bag and the zeny in a row under it (by request: no heads; a character tapped on the field shows its status)
  const key = JSON.stringify(W.bag) + W.zeny;
  if (key === bagKey) return;
  bagKey = key;
  const bag = Object.entries(W.bag).filter(([, k]) => k > 0);
  $('h-bag').innerHTML = bag.map(([id, k]) => `<span>${itemIcon(id)}${k}</span>`).join('') + `<span>${W.zeny.toLocaleString()} z</span>`;
}

// ---------- after the map ----------
function mapOver(t) {
  if (!run) return;
  allocClose?.();
  const won = run.map.state === 'done', train = run.plan.train;
  G.fight = null;
  G.zeny = W.zeny;  // (what Mammonite paid)
  if (!won) return gameOver();
  if (!train) W.chars.forEach(c => sim.levelUp(c, t));  // (the training ground's levels came with its kills)
  // (a recruit at the job level it was to change jobs at changes in town, once the party has landed there: by
  // request, not here; recruitJobs)
  // the loot sold (with the party's best Overcharge), and a chain's map cleared faster than its base party did pays
  // the speed bonus (the sandbox's settle)
  const rate = L.sellRate(Math.max(0, ...W.chars.map(c => c.levels.MC_OVERCHARGE || 0)));
  const sold = Object.entries(W.loot).map(([id, n]) => { const unit = Math.floor(((db.items[id] || {}).sell || 0) * (100 + rate) / 100); return { id, n, unit, sum: unit * n }; })
    .sort((a, b) => b.sum - a.sum);
  const gain = sold.reduce((z, x) => z + x.sum, 0), par = run.plan.chain && run.plan.par, speed = par ? L.speedBonus(run.plan.income, par, run.T) : 0;
  const used = { ...W.used }, before = G.zeny, plan = run.plan, T = run.T;
  G.zeny += gain + speed;
  if (train) G.train = { step: 'job' };  // (結算 paid: a game loaded from here goes on at the job menu)
  else {
    G.maps = (G.maps || 0) + 1;
    G.level++;
    G.plan = null;
    G.base = leaderBase();  // (the points the level brought, spent at the map ahead)
    G.town = null;  // (another town: goTown)
    // (by request: the cards offered, before the party flies back to town: drawCard)
    G.draw = { ids: rollCards(plan), hard: !!plan.hard };
  }
  keep();
  if (run.plan.phase?.name === 'BOSS') { G.recruits = makeRecruits(); recCame = false; recGone = []; put(); }
  // (by request: a BOSS map won brings a headgear at random, the party's to give one of it)
  const hatWon = !train && run.plan.phase?.name === 'BOSS' ? anyOf(Object.keys(db.headgear || {})) : null;
  if (hatWon) { (G.hats ??= []).push(+hatWon); put(); }
  const name = id => esc((db.items[id] || {}).name || id);
  const sumHtml = (`<div class="head good">過關！</div><div class="muted">${train ? '' : `第 ${noOf(G, G.level - 1)} 關${plan.hard ? '（困難）' : ''}・`}${esc(plan.theme.label)}・${Math.round(T)} 秒</div>` +
    `<div class="two"><div><h4>撿到的雜物${rate ? `（商人抬價 +${rate}%）` : ''}</h4>` +
    (sold.length ? `<table>${sold.map(x => `<tr><td>${itemIcon(x.id)}</td><td>${name(x.id)} ×${x.n}</td><td class="num">${x.sum.toLocaleString()} z</td></tr>`).join('')}` +
      `<tr class="total"><td></td><td>賣得</td><td class="num">${gain.toLocaleString()} z</td></tr></table>` : '<div class="muted">什麼都沒撿到</div>') +
    (par ? `<h4>通關速度獎勵</h4><div class="${speed ? '' : 'muted'}">${speed ? `＋${speed.toLocaleString()} z` : '沒有比基準隊伍快'}（${Math.round(T)} 秒，基準 ${Math.round(par)} 秒）</div>` : '') +
    `</div><div>` +
    `<h4>戰後報告</h4>${bagReport(run.start.bag, used, W.bag)}` +
    `<div>最危險：第 ${run.low.wave + 1} 波，隊伍剩 ${pct(Math.max(0, run.low.k))}<span class="muted small">（HP＋補師的 SP）</span></div>` +
    (downs(W.chars) ? `<div>倒下 ${downs(W.chars)} 次</div>` : '') +
    `<h4>Zeny</h4><div class="zbig">${G.zeny.toLocaleString()} z</div><div class="muted">原有 ${before.toLocaleString()} z ＋ ${(gain + speed).toLocaleString()} z</div>` +
    `<h4>升級</h4><div>${W.chars.map(c => `${esc(c.name || jobLabel(c.look.job))}　Base Lv. ${c.blv}　Job Lv. ${c.jlv}`).join('<br>')}</div>` +
    (hatWon ? `<h4>頭飾</h4><div>${hatIcon(hatWon)}得到了${esc(db.headgear[hatWon].name)}，可以在角色的裝備裡給一個人戴</div>` : '') +
    (G.recruits?.length ? `<h4>招募</h4><div>有 ${G.recruits.length} 位冒險者在城裡想加入，出發前可以招募</div>` : '') + `</div></div>`);
  // (by request, two tabs under the window as a character's info: 結算, and 統計, what each of the party did)
  const statHtml = tallyHtml(T);
  const draw = () => {
    $('result').innerHTML = `<div class="resinfo">${win('結算', resTab === 'stat' ? statHtml : sumHtml, rb('下一步', 'id="r-go"'), 'dlg wide')}` +
      `<nav class="tabs">${RESULT_TABS.map(([k, label]) => rb(label, `data-rtab="${k}"`, k === resTab)).join('')}</nav></div>`;
    for (const b of $('result').querySelectorAll('[data-rtab]')) b.onclick = () => { resTab = b.dataset.rtab; draw(); };
    $('result').querySelectorAll('.tally th canvas').forEach((cv, i) => LOOK.drawPortrait(cv, W.chars[i].look.ch || {}));
    $('r-go').onclick = train ? trainOver : () => drawCard(goTown);
  };
  draw();
  show('s-result');
  A.setView(0, 0.5);
}
// 戰後報告's bag (by request: to tell how much to take next time): each potion taken in, drunk and left, as a table
function bagReport(start, used, left) {
  const ids = [...new Set([...Object.keys(start || {}), ...Object.keys(used || {})])].filter(id => (start[id] || 0) + (used[id] || 0) > 0);
  if (!ids.length) return '<div class="muted">沒帶藥水</div>';
  const name = id => esc((db.items[id] || {}).name || id);
  return `<table class="bagrep"><tr><th></th><th></th><th class="num">帶</th><th class="num">喝</th><th class="num">剩</th></tr>` +
    ids.map(id => `<tr><td>${itemIcon(id)}</td><td>${name(id)}</td><td class="num">${start[id] || 0}</td><td class="num">${used[id] || 0}</td><td class="num">${left[id] || 0}</td></tr>`).join('') + '</table>';
}
const downs = chars => chars.reduce((n, c) => n + (sim.tallyOf(c).downs || 0), 0);
const RESULT_TABS = [['sum', '結算'], ['stat', '統計']];
let resTab = 'sum';
// 統計 (by request): what each of the party did on the map (sim.tallyOf), a column each; T: the map's time (s)
// (對戰's: both teams', chars, the party's first `ours` of them, the rival team's headed in red)
function tallyHtml(T, chars = W.chars, ours = chars.length) {
  const n = v => Math.round(v).toLocaleString(), none = '<span class="muted">—</span>';
  const items = x => Object.entries(x.items).map(([id, k]) => `<span class="bagit">${itemIcon(id)}×${k}</span>`).join('') || none;
  const rows = [
    ['造成傷害', x => n(x.dealt)], ['DPS', x => (x.dealt / Math.max(1, T)).toFixed(1)], ['最高一擊', x => n(x.best)], ['擊殺', x => x.kills],
    ['承受傷害', x => n(x.taken)], ['治療量', x => x.heals ? n(x.heals) : none], ['回復 HP', x => n(x.healed)],
    ['消耗 SP', x => n(x.sp)], ['使用技能', x => `${x.skills} 次`], ['用掉的道具', items], ['花費 Zeny', x => x.zeny ? `${n(x.zeny)} z` : none],
    ['倒下', x => x.downs ? `${x.downs} 次` : none]];
  const xs = chars.map(sim.tallyOf), rv = i => i >= ours ? ' rv' : '';
  // (by request, each column headed by the character's head: drawn once on the page, tallyHeads; its name on hover)
  return `<div class="tallyscroll"><table class="tally"><tr><th></th>${chars.map((c, i) => `<th class="${rv(i)}" title="${esc(c.name || jobLabel(c.look.job))}"><canvas width="80" height="80"></canvas></th>`).join('')}</tr>` +
    rows.map(([k, f]) => `<tr><td class="k">${k}</td>${xs.map((x, i) => `<td class="num${rv(i)}">${f(x)}</td>`).join('')}</tr>`).join('') + '</table></div>' +
    `<div class="muted small">DPS：造成傷害 ÷ ${Math.round(T)} 秒。治療量：技能補給隊伍（含自己）的 HP。回復 HP：自己補回的（技能、藥水，不含自然回復）。</div>`;
}
// 招募 (by request): after a BOSS map won, RECRUITS adventurers in town who would join, there until the party sets
// off again (G.recruits): each a first job and one of its two second jobs (`second`, by request: the one it is on its
// way to) on one of that second job's stat and skill build pairs by chance (builds.js recruitPairs: the skills its
// stats are for, by request, issue #3), none as one of the party is, and no two of
// them of one job (by request), nor of a job in `not` (the leader's, as the first two come: joinScene), each with a
// hairstyle and hair colour at random (by request), at a job level of its own (recruitLevel). One taken takes the
// place of a member but the leader at that one's base level and EXP (no cost and no catching up: by request), and the
// one it replaces leaves for good.
const RECRUITS = 2;
const anyOf = a => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const recruitKey = r => [r.second || r.job, r.build, r.skillBuild].join('|');
function makeRecruits(not = [], lead = W.chars[0]) {
  const seen = new Set(G.chars.map(recruitKey)), out = [];
  for (let n = 0; out.length < RECRUITS && n < 100; n++) {
    const r = newRecruit(anyOf(FIRST_JOBS.filter(j => !out.some(x => x.job === j) && !not.includes(j))), lead);
    if (seen.has(recruitKey(r))) continue;
    seen.add(recruitKey(r));
    out.push(r);
  }
  return out;
}
// one who would join as first job `job` (makeRecruits'; 對戰's rival teams too): its second job, builds, sex, hair,
// job level and headgear by chance
function newRecruit(job, lead) {
  const second = anyOf(secondJobsOf(job)) || null;
  const of = id => !second || [...buildsFor(second), ...skillBuildsFor(second)].some(b => b.id === id);
  const [build = null, skillBuild = null] = anyOf(recruitPairs(job).filter(([b, k]) => of(b) && of(k))) || [];
  const r = { job, second, sex: anyOf(['남', '여']), build, skillBuild };
  const h = anyOf(LOOK.heads(r.sex));  // (a hairstyle and colour at random, not the job's own: by request)
  const lv = recruitLevel(lead);
  return { ...r, ...lv, hair: h.id, hdye: anyOf([null, ...h.dyes]), hats: rollHats(lv.firstJlv && second ? second : job, lead?.blv || 1) };
}
// A recruit's job level (by request), by the leader's and the map ahead's number (a job level a map: 第 n 關 job n;
// CHANGE, the job levels about changing jobs, a first job's 40–50 and a second job's 1–10, 第 40–59 關): { jlv, and
// for a second job firstJlv (the job level its first job changed at), for a first job changeAt (the one it will) }.
// Before it (the leader a first job under 40), the leader's, changing at 40–50 by chance. Past it (the leader a
// second job over 10, or 第 60 關 on), only second jobs, changed at 40–50: at the leader's job level, or with the leader
// still a first job, at the map's as one changed then would be. In it, any of the 21 levels by chance: a second job
// changed at 40–50, a first job to change at one of the levels after its own (50 at 50: on the next map).
const CHANGE = { from: 40, top: 50, span: 10 };
function recruitLevel(lead) {
  const two = !!lead && sim.jobFor(lead).tier >= 2, jlv = lead?.jlv || 1, at = () => between(CHANGE.from, CHANGE.top);
  const no = noOf(G) + chainStart(chain).jlv - 1;
  if (!two && jlv < CHANGE.from) return { jlv, changeAt: at() };
  if ((two && jlv > CHANGE.span) || no >= CHANGE.top + CHANGE.span) { const a = at(); return { firstJlv: a, jlv: Math.min(two ? jlv : no - a + 1, 50) }; }
  const k = between(0, CHANGE.top - CHANGE.from + CHANGE.span);
  if (k <= CHANGE.top - CHANGE.from) { const j = CHANGE.from + k; return { jlv: j, changeAt: j < CHANGE.top ? between(j + 1, CHANGE.top) : CHANGE.top }; }
  return { firstJlv: at(), jlv: k - (CHANGE.top - CHANGE.from) };
}
// recruit r as a character at character `from`'s base level and EXP and its own job level (r.jlv; one kept before
// there were: from's), a second job if it has changed (r.firstJlv), its stats and skills as its builds have them there
function recruitChar(r, from) {
  const two = !!(r.firstJlv && r.second), job = two ? r.second : r.job, jlv = r.jlv || from.jlv;
  const same = jlv === from.jlv && (sim.jobFor(from).tier >= 2) === two;  // (its job EXP the other's only at one job level)
  const c = sim.newChar({ job, sex: r.sex, hair: r.hair, hdye: r.hdye, blv: from.blv, jlv, bexp: from.bexp, jexp: same ? from.jexp : 0,
    ...two ? { firstJlv: r.firstJlv } : { second: r.second, changeAt: r.changeAt },
    weapon: LOOK.defaultWeapon(job, r.sex) || '', tactic: tacticOfBuild(r.skillBuild), build: r.build, skillBuild: r.skillBuild });
  sim.refitStats(c); sim.refitSkills(c); autoGear(c); sim.calc(c);
  c.name = jobLabel(job);
  if (r.hats) { c.look.hats = { ...r.hats }; c.ownHats = [...new Set(Object.values(r.hats).filter(Boolean))]; }
  return c;
}
// (by request) character c changes to second job `job` (sim.changeJob): its equipment the new job's best (autoGear:
// what it held kept when the job holds it too); its name (its job's) the new job's
// character c's look as it would be as job `job` (changeTo on a copy: its gear the job's, the headgear the job cannot
// wear off), the party as it is (轉職's carousel at the map ahead)
// (what they hold there, by request: none a shield but the crusader, with a one-handed sword; an assassin a katar,
// a rogue a dagger, a monk a knuckle, a dancer a whip and a bard an instrument; c.hands as the 裝備 tab's)
const PREVIEW_HANDS = { 크루세이더: { right: '1hSword', left: 'shield' }, 어세신: { right: 'Katar' }, 로그: { right: 'Dagger' }, 몽크: { right: 'Knuckle' },
  무희: { right: 'Whip' }, 바드: { right: 'Musical' } };
function jobPreview(c, job) {
  const x = sim.newChar(savedOf(c));
  sim.changeJob(x, job);
  x.hands = { ...x.hands, left: 'none', ...PREVIEW_HANDS[job === '바드/무희' ? (x.look.sex === '여' ? '무희' : '바드') : job] };
  autoGear(x);
  for (const k of HAT_SLOTS) { const id = x.look.hats?.[k]; if (id && !L.canWear(sim.jobFor(x), db.headgear[id])) x.look.hats[k] = null; }
  return x.look;
}
function changeTo(c, job) {
  const was = c.look.job;
  sim.changeJob(c, job);
  autoGear(c);
  for (const k of HAT_SLOTS) { const id = c.look.hats?.[k]; if (id && !L.canWear(sim.jobFor(c), db.headgear[id])) takeOffHat(c, k); }
  if (!c.name || c.name === jobLabel(was)) c.name = jobLabel(job);
  LOOK.loadLook(c.look, () => {});
  sim.calc(c);
}
// The party's look for recruits (by request, as a party is made in RO): 招募 tapped, the party sitting, the leader with a chat
// room over it, and after a while those who would join (G.recruits) walk in from off the screen to before the party
// (townfolk.js actors), the camera turned on them from where the town's models hide them least. One tapped shows
// its status as a member's (allocate), with 確定選擇; picked, the camera goes back to the party, sitting, for
// the one to leave (the leader cannot), asked once more. Then that one waves (/bo) and walks off the screen, the one
// picked walks to where it stood and joins, and the other walks off. 招募 tapped again, another tab or the party
// setting off: the recruits walk off and stay on offer (rec: the look going on, null for none).
let rec = null, recId = 0;
const RECRUIT_WAIT = 2500, ET_WRAP = 12, ROOM_AFTER = 500;  // (ROOM_AFTER: ms sat before its chat room opens)  // (ms before they come; /bo, the open hand: a wave)
let recCame = false, recGone = [];  // (recGone: the actors of the look given up last, walking off)  // (they came once for these recruits: the next look has them walk up at once, by request)
// the azimuth (arena.js turnTo) the camera looks from at the front of one facing cell direction h (lineUp's face)
const frontOf = h => Math.atan2(h[0], -h[1]);
// of the azimuths 45° apart from frontOf(h) round to its back, the nearest it from which the town's models hide these
// cells least (by report, issue 12: at Prontera's gates the recruits' front looked from behind the gate's walls)
const clearFront = (cells, h) => { const f = frontOf(h), q = Math.PI / 4; return A.clearAzimuth(cells, [0, 1, -1, 2, -2, 3, -3, 4].map(k => f + k * q)); };
const recruitText = {
  wait: () => '隊長開了聊天室徵隊友，等等看有沒有人來…',
  come: () => `有 ${G.recruits.length} 位冒險者過來了…`,
  look: () => '點冒險者看他的資訊，可以的話按「確定選擇」',
  pick: () => '點一位隊員讓他離開（隊長不能離開）',
  lead: () => '隊長不能離開，點另一位隊員',
  ask: () => '確定這樣交換嗎？離開的隊員不會再回來。',
  go: () => '',
};
// 招募's window (by request): the one joining's head, an arrow, the one leaving's (an empty square till each is
// picked), what to do under them; 取消招募 only while neither is picked
function drawRecruit() {
  const el = $('p-recruit');
  if (!el || !rec) return;
  el.closest('.pane').classList.toggle('waiting', rec.phase === 'wait' || rec.phase === 'come');  // (shown once they are there: by request)
  const comer = rec.pick != null ? rec.cands[rec.pick] : null, leaver = rec.phase === 'ask' || rec.phase === 'go' ? rec.leaver : null;
  const head = (c, k, none) => `<div class="rslot${c ? '' : ' empty'}">${c ? `<canvas width="80" height="80" data-rh="${k}"></canvas>` : '<span>?</span>'}` +
    `<small>${c ? `${esc(c.name)} Lv ${c.blv}` : none}</small></div>`;
  const none = rec.pick == null && rec.out == null, text = recruitText[rec.phase]();
  el.innerHTML = `<div class="rswap">${head(comer, 0, '新隊友')}<span class="rarrow">→</span>${head(leaver, 1, '離開的隊員')}</div>` +
    (text ? `<div class="rtext">${text}</div>` : '');
  // (the buttons at the window's foot, on the right: by request)
  $('p-rfoot').innerHTML = (rec.phase === 'ask' ? rb('確定', 'data-rc="yes"') + rb('重選', 'data-rc="no"') : rec.phase === 'pick' || rec.phase === 'lead' ? rb('重選', 'data-rc="back"') : '') +
    (none && rec.phase !== 'go' ? rb('取消招募', 'data-rc="end"') : '');
  el.querySelectorAll('canvas[data-rh]').forEach(cv => { const c = cv.dataset.rh === '0' ? comer : leaver; LOOK.loadLook(c.look, () => LOOK.drawPortrait(cv, c.look.ch || {})); LOOK.drawPortrait(cv, c.look.ch || {}); });
  for (const b of $('p-rfoot').querySelectorAll('[data-rc]')) b.onclick = () => ({
    yes: recruitSwap, no: () => { A.mark(null); rec.out = null; rec.phase = 'pick'; seat(); drawRecruit(); }, back: recruitLook,
    end: () => { endRecruit(); setTab?.(null); A.turnTo(frontOf(W.chars[0].w.heading || [1, 1])); } })[b.dataset.rc]();  // (back to the party's front: by request)
  frame();
}
// cells about the party for n recruits to stand on: a few steps before the leader, a cell or so either side
function recruitSpots(n) {
  const L = W.chars[0].w.cell, f = W.chars[0].w.heading || [1, 1], r = [-f[1], f[0]], used = new Set(W.chars.map(c => c.w.cell.join())), out = [];
  for (let k = 0; k < n; k++) {
    const side = n === 1 ? 0 : k * 2 - (n - 1);
    const want = [L[0] + f[0] * 4 + r[0] * side, L[1] + f[1] * 4 + r[1] * side];
    let best = null;
    for (let d = 0; d < 5 && !best; d++) for (let y = -d; y <= d && !best; y++) for (let x = -d; x <= d && !best; x++) {
      const p = [want[0] + x, want[1] + y];
      if (Math.max(Math.abs(x), Math.abs(y)) === d && W.field.open(...p) && !used.has(p.join())) best = p;
    }
    best ??= want;
    used.add(best.join());
    out.push(best);
  }
  return out;
}
const towardOf = (from, to) => [Math.sign(to[0] - from[0]), Math.sign(to[1] - from[1])];
async function recruitScene() {
  allocClose?.();
  const my = ++recId;
  rec = { phase: 'wait', cands: [], actors: [], spots: [], pick: null, out: null };
  W.chars[0].room = { title: '徵隊友' };
  folk.keepOut(true);  // (the townsfolk off the screen meanwhile, by request)
  seat();  // (all sitting while they recruit: by request)
  drawRecruit();
  if (!recCame) await sleep(RECRUIT_WAIT);
  recCame = true;  // (given up from here on, the next look has no wait: by request)
  if (my !== recId) return;
  rec.cands = G.recruits.map(r => recruitChar(r, W.chars[1] || W.chars[0]));
  rec.spots = recruitSpots(rec.cands.length);
  rec.phase = 'come';
  drawRecruit();
  let left = rec.cands.length;
  const there = () => { if (my === recId && --left <= 0 && rec.phase === 'come') recruitLook(); };
  rec.actors = rec.cands.map((c, k) => {
    LOOK.loadLook(c.look, () => {});
    // (one still walking off from the look given up turns back: by request, no wait)
    const back = recGone[k] && folk.reclaim(recGone[k]) ? recGone[k] : null, f = back || folk.actor(c.look, null, rec.spots[k]);
    if (!f) { there(); return null; }
    f.cand = k;
    if (!folk.walk(f, rec.spots[k], () => { f.w.heading = towardOf(rec.spots[k], W.chars[0].w.cell); there(); })) there();
    return f;
  });
  setTimeout(() => { if (my === recId && rec.phase === 'come') recruitLook(); }, 20000);  // (one stuck on the way)
}
// the recruits to look at: the camera on them, turned where the town's models hide them least
function recruitLook() {
  if (!rec) return;
  A.mark(null);
  rec.phase = 'look'; rec.pick = rec.out = null;
  const ws = rec.actors.filter(Boolean).map(f => f.w);
  A.setFocus(ws.length ? ws : null);
  recCame = true;
  // (from their front, by request: they face the leader; as near it as the town's models leave them in sight)
  const at = rec.actors.filter(Boolean).map(folk.cellOf);
  if (at.length) { const L = W.chars[0].w.cell, mid = at.reduce((a, c) => [a[0] + c[0] / at.length, a[1] + c[1] / at.length], [0, 0]); A.turnTo(clearFront(at, [L[0] - mid[0], L[1] - mid[1]])); }
  seat();  // (all sitting while they recruit: by request)
  drawRecruit();
}
// recruit k picked: the camera back on the party, sitting, to tap the one to leave (it alone stands up: recruitClick)
function recruitPick(k) {
  rec.pick = k; rec.phase = 'pick';
  allocClose?.();
  A.setFocus(null);
  A.turnTo(frontOf(W.chars[0].w.heading || [1, 1]));  // (from the party's front, by request)
  setTab?.('recruit');
  drawRecruit();
}
// a tap on the field while recruiting (clickField) → true when it was taken
function recruitClick(m) {
  if (!rec) return false;
  const f = rec.actors.find(x => x && x.w === m);
  if (rec.phase === 'look' && f) {
    clickGuard = performance.now() + 400;
    setTab?.(null);  // (招募's window under the status, as a member's: clickField)
    A.turnTo(clearFront([folk.cellOf(f)], f.w.heading));
    allocate(-1, { char: rec.cands[f.cand], w: f.w, pick: () => recruitPick(f.cand), closed: () => { if (rec?.phase === 'look') { setTab?.('recruit'); recruitLook(); } } });
    return true;
  }
  const i = W.chars.findIndex(c => c.w === m);
  if ((rec.phase === 'pick' || rec.phase === 'lead' || rec.phase === 'ask') && i >= 0) {
    if (i === 0) { A.mark(null); rec.out = null; rec.phase = 'lead'; seat(); }
    else { A.mark(m); rec.out = i; rec.leaver = W.chars[i]; rec.phase = 'ask'; seat(i); }  // (only the one picked standing up)
    drawRecruit();
    return true;
  }
  return rec.phase !== 'look';  // (nothing else while it goes on; looking, the status of one shown closes as ever)
}
// the swap asked for: the one leaving waves and walks off (an actor in its place), the one picked walks to where it
// stood and joins at its level and EXP, the other walks off; the map ahead drawn again
async function recruitSwap() {
  const my = recId, k = rec.pick, i = rec.out, old = W.chars[i], r = G.recruits[k], cand = rec.cands[k];
  const cell = [...old.w.cell], heading = old.w.heading;
  rec.phase = 'go';
  drawRecruit();
  A.mark(null);
  W.chars[0].room = null;
  G.recruits = null;
  put();
  if (old.sitting) sim.sit(old, false);
  const gone = folk.actor(old.look, cell, null, true);
  // (the camera held on the party as it stood, the leader in the middle, the place left kept in it: by request, not
  // closing in on the two left while the one leaving and the one joining walk)
  A.setFocus([...W.chars.filter(c => c !== old).map(c => c.w), folk.spotAt(cell)]);
  returnHats(old);
  put();  // (what it gave back saved at once: a reload while they walk keeps it)
  sim.removeChar(old); stage.drop(old);
  if (gone) { gone.w.heading = heading; folk.emoteOf(gone, ET_WRAP); }
  rec.actors.forEach((f, j) => { if (f && j !== k) folk.away(f); });
  await sleep(1500);
  if (gone) folk.away(gone);
  const f = rec.actors[k];
  await new Promise(done => { if (!f || !folk.walk(f, cell, done)) done(); setTimeout(done, 15000); });
  if (my !== recId) return;
  if (f) folk.drop(f);
  const c = recruitChar(r, old);
  c.look = cand.look;
  c.hp = c.pc.maxHp; c.sp = c.pc.maxSp;
  sim.enter(c);
  W.chars.splice(i, 0, c);
  W.field.placeNear(c.w, cell);
  c.w.heading = heading;
  stage.show(c);
  A.setFocus(null);
  keep();
  rec = null;
  folk.keepOut(false);
  await sleep(400);
  if (!$('s-prep').hidden) { prepTab = null; prep(); }
}
// the look for recruits given up (or over): those come walk off, the leader's chat room gone
function endRecruit() {
  if (!rec) return;
  recId++;
  for (const f of rec.actors) if (f) folk.away(f);
  recGone = rec.actors;
  if (W.chars[0]) W.chars[0].room = null;
  A.mark(null);
  folk.keepOut(false);
  const was = rec;
  rec = null;
  if (allocOn && was.cands.includes(allocOn)) allocClose?.();
  A.setFocus(null);
  seat();
}
// ---------- the training ground over (TRAIN) ----------
// its 結算 closed (mapOver, which kept the game at the job menu): the job menu
function trainOver() {
  if (!run || !run.plan.train || !G) return;
  jobMenu();
}
// 轉職 (by request): the six first jobs on a carousel, each one's figure in what it will wear (asJob: the Novice's own
// hair, the job's gear), all facing front-left (by request, not turning), the one in the middle large, in its battle
// stance, its neighbours small and faded at its sides, both in sight however narrow the screen (by request; no ‹ ›
// either); dragged, it follows the finger (or the mouse), let go it springs to the nearest one; a neighbour tapped,
// or the arrow keys turn it too, 轉職 takes the one in the middle there (pickJob); under it its town's minimap and
// name on the left, its own name on the right (by request)
// where a figure stands by how far it is from the middle (0, 1, 2 places: between them on a line): px off the middle
// (a neighbour's JC_X[1] at most, nearer on a narrow screen to keep it whole in sight: jcX), scale and opacity;
// JC_DRAG, the px dragged a place moves by; JC_DIR, the facing (front-left: south-west); JC_W, a figure's width
const JC_X = [0, 150, 260], JC_W = 150, JC_SCALE = [1, 0.62, 0.4], JC_ALPHA = [1, 0.5, 0], JC_DRAG = 150, JC_DIR = 1;
function jobMenu() {
  const looks = FIRST_JOBS.map(j => { const c = asJob(j); LOOK.loadLook(c.look, () => {}); return c.look; });
  $('result').innerHTML = win('轉職', `<div class="head good">升到 ${TRAIN.top} 級了！</div><p class="jchint">選一個職業，轉職後到那個職業的城市招募兩位隊友。</p>` +
    carouselHtml(FIRST_JOBS.map(j => jobLabel(j))) +
    `<div class="jcname"><span class="town"><img id="j-map" alt=""><small id="j-town"></small></span><b id="j-name"></b></div>`,
    `<span class="grow"></span>${rb('轉職', 'id="j-go"')}`, 'dlg');
  const car = carousel($('result').querySelector('.jcs'), looks, i => {
    const j = FIRST_JOBS[i];
    $('j-name').textContent = jobLabel(j);
    $('j-town').textContent = TOWN_ZH[HOME_TOWN[j]];
    const src = `../assets/png/minimap/small/${encodeURIComponent(HOME_TOWN[j])}.png`;
    if ($('j-map').getAttribute('src') !== src) $('j-map').src = src;
  });
  $('j-go').onclick = () => { car.stop(); pickJob(FIRST_JOBS[car.cur()]); };
  show('s-result');
  car.fit();  // (once shown: its width known)
  A.setView(0, 0.5);
}
// a figure (sprites ch) on canvas cv at page time t, facing JC_DIR: in its battle stance (group 4, looping) when
// `stance`, else standing; drawn anew each frame (轉職's carousel and its two second jobs)
function figureAt(cv, ch, stance, t) {
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  if (!ch || !ch.body) return;
  const grp = stance ? 4 : 0, act = ch.body.act.actions[grp * 8 + JC_DIR];
  const fi = !stance || !act ? 0 : Math.floor(t / Math.max(1, act.delay_ms || 150));
  g.setTransform(1, 0, 0, 1, cv.width / 2, cv.height - 18);
  g.imageSmoothingEnabled = false;
  LOOK.drawHuman(g, grp * 8 + JC_DIR, fi, ch);
}
// a carousel's strip (carousel), a canvas for each of the figures titled `titles`
const carouselHtml = titles => `<div class="jcs">${titles.map((t, i) => `<canvas class="jc" data-i="${i}" width="120" height="136" title="${esc(t)}"></canvas>`).join('')}</div>`;
// The figures of looks `looks` on strip `strip` as a carousel (轉職's, by request: jobMenu, and prep's for the second
// jobs): the one in the middle large in its battle stance, its neighbours small and faded at its sides, all facing
// JC_DIR; dragged it follows the finger (or the mouse) and springs to the nearest let go; a neighbour tapped or the
// arrow keys (while it is on the screen) turn it. Round and round with more than 3 figures, else from the first to
// the last (the one past the end pulled at a third). `shown(i)`: figure i is in the middle now. → { cur(), fit(),
// stop() }; it stops by itself once the strip is off the page.
function carousel(strip, looks, shown) {
  const n = looks.length, cvs = [...strip.querySelectorAll('.jc')], wrap = n > 3;
  let pos = 0, raf = 0, last = -1;  // (pos: the place in the middle, a fraction of one while dragged, unwrapped)
  const mod = (v, m) => ((v % m) + m) % m;
  const cur = () => wrap ? mod(Math.round(pos), n) : Math.max(0, Math.min(n - 1, Math.round(pos)));
  const off = i => wrap ? mod(i - pos + n / 2, n) - n / 2 : i - pos;  // (i's places from the middle)
  const lerp = (t, a) => { const k = Math.min(2, t), i = Math.min(1, Math.floor(k)); return a[i] + (a[i + 1] - a[i]) * (k - i); };
  // (a neighbour JC_X[1] off the middle at most, nearer to be whole in sight on a narrow strip)
  const jcX = () => { const x1 = Math.max(90, Math.min(JC_X[1], strip.clientWidth / 2 - JC_W * JC_SCALE[1] / 2 - 2)); return [0, x1, x1 + JC_X[2] - JC_X[1]]; };
  // the figures where pos puts them (animated, or following the drag)
  const place = (anim = true) => {
    strip.classList.toggle('drag', !anim);
    const X = jcX();
    cvs.forEach((cv, i) => {
      const o = off(i), d = Math.abs(o);
      cv.style.transform = `translateX(${(Math.sign(o) * lerp(d, X)).toFixed(1)}px) scale(${lerp(d, JC_SCALE).toFixed(3)})`;
      cv.style.opacity = lerp(d, JC_ALPHA).toFixed(3);
      cv.style.zIndex = String(10 - Math.round(d * 2));
      cv.style.pointerEvents = d > 1.5 ? 'none' : '';
    });
    if (cur() !== last) shown(last = cur());
  };
  const go = d => { pos = Math.max(wrap ? -Infinity : 0, Math.min(wrap ? Infinity : n - 1, Math.round(pos) + d)); place(); };
  const keys = e => {
    if (!strip.offsetParent) return;
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  const sized = new ResizeObserver(() => place(false));  // (the screen turned, or the strip shown: in sight still)
  const stop = () => { cancelAnimationFrame(raf); removeEventListener('keydown', keys); sized.disconnect(); };
  // each figure drawn every frame while it is up: the middle one in its battle stance (group 4), the rest standing
  const frame = t => {
    if (!strip.isConnected) return stop();
    raf = requestAnimationFrame(frame);
    if (!strip.offsetParent) return;
    cvs.forEach((cv, i) => {
      const o = off(i), ch = looks[i].ch;
      if (Math.abs(o) <= 2) figureAt(cv, ch, Math.round(o) === 0, t);
    });
  };
  // dragged: following it; let go, to the nearest; hardly moved, a tap (a neighbour tapped: to it)
  let drag = null;
  strip.onpointerdown = e => {
    drag = { x: e.clientX, pos, moved: false, id: e.pointerId, on: e.target.closest('.jc') };
    strip.setPointerCapture(e.pointerId);
  };
  strip.onpointermove = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 6) drag.moved = true;
    if (!drag.moved) return;
    pos = drag.pos - dx / JC_DRAG;
    if (!wrap) pos = pos < 0 ? pos / 3 : pos > n - 1 ? n - 1 + (pos - n + 1) / 3 : pos;
    place(false);
  };
  const up = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const was = drag; drag = null;
    if (was.moved) { go(0); return; }
    const o = was.on ? Math.round(off(+was.on.dataset.i)) : 0;
    if (o) go(o);
  };
  strip.onpointerup = up;
  strip.onpointercancel = up;
  addEventListener('keydown', keys);
  sized.observe(strip);
  place(false);
  raf = requestAnimationFrame(frame);
  return { cur, fit: () => place(false), stop };
}
// the leader as it will be once it is job `job` (at its base level, job level 1 as the chain starts: chainStart; its
// hair as the Novice's, its equipment the job's best: autoGear), not yet in the party
function asJob(job) {
  const was = G.chars[0];
  const c = sim.newChar({ ...was, job, weapon: LOOK.defaultWeapon(job) || '', arm: null, armL: null, shield: '', body: null, hands: null,
    jlv: chainStart(chain).jlv, bexp: 0, jexp: 0, build: null, skillBuild: null, levels: {} });
  unlearn(c);
  autoGear(c);
  sim.calc(c);
  c.name = jobLabel(job);
  return c;
}
// the training ground with the Novice standing on it, nothing else there (a game loaded at the job menu: by
// request, not an empty field), as a town is entered (enterTown)
async function trainField() {
  const plan = trainPlan(), floor = await A.loadFloor(plan.floor), shown = plan.floor && floor && floor.key === plan.floor.map + '_' + plan.floor.i ? floor : null;
  sim.setFloor(shown ? plan.floor : null, shown && shown.heights);
  A.showFloor(shown);
  const list = [...W.chars];
  for (const c of list) { A.remove(c.w); sim.removeChar(c); }
  list.forEach(c => {
    const { id, look, ...fresh } = sim.newChar(buildOf(c));
    Object.assign(c, fresh);
    sim.calc(c);
  });
  W.allAggressive = false;
  sim.resetWorld(list, G.bag, G.zeny);
  stage.restart(list);
  townT = W.t;
  lineUp();
  playBgm(plan.bgm);
}
// job `job`'s room for a character of sex `sex` (the bard's or the dancer's for the node of two)
const roomOf = (job, sex) => JOB_ROOM[job === '바드/무희' ? (sex === '여' ? '무희' : '바드') : job];
// the cells about a job room's patch the Novice can walk (townfolk.js start's around): Geffen's door is 27 off the NPC
const ROOM_AROUND = 32, ROOM_IN = 9;
// how far a job change room's camera turns from north up at most (jobRoom)
const ROOM_TURN = Math.PI / 4;
// where the Novice walks off the training ground (by request: to the bridge north of it), new_zone03's cell
const TRAIN_EXIT = [105, 83];
// rAthena's dir (0 north, counter-clockwise) as a step on the field (+y north)
const DIR_STEP = [[0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1]];
// The Novice changes to job `job` (at its base level, job level 1 as the chain starts: chainStart; its stats as they
// are, its skills unlearned: the points of the job's levels to come spent by hand). By request, it walks off toward
// the training ground's bridge as the screen fades; the job's room fades in, where it walks in from off the screen to
// stand before the NPC, and with a job level up it changes; it walks off, and the job's town (HOME_TOWN, about one of
// its Kafras) fades in, where it walks in to where the party stands and the recruits come (joinScene). Walked by
// townfolk.js's actors, the party itself off the field meanwhile. A page loaded on the way lands in the town as before
// (arriveHome).
async function pickJob(job) {
  show('s-prep'); $('prep').innerHTML = '';
  A.setView(0, 0); A.setFocus(null);
  const was = G.chars[0], lead = W.chars[0], novice = lead.look;
  const c = asJob(job);
  LOOK.loadLook(c.look, () => {});  // (its sprites in by the time it changes)
  G.chars = [{ ...savedOf(c), hair: was.hair, hdye: was.hdye }];
  G.train = { step: 'join' };
  G.town = L.floorOf(HOME_TOWN[job]);
  G.recruits = makeRecruits([job], c);
  put();
  // off the training ground, toward the bridge; the screen going black on the way (by request: not once it is gone)
  stopFight();
  const train = trainPlan().floor, tw = train && (FLOORS[train.map] || [])[train.i];
  await folk.start(townT, tw ? { map: train.map, ...tw } : null, false);
  const from = lead.w.cell, f = folk.actor(novice, from, null, true);
  if (f) f.w.heading = lead.w.heading;
  for (const x of [...W.chars]) { sim.removeChar(x); stage.drop(x); }  // (the party off the field: its look walks)
  W.chars = [];
  if (f && tw) {
    folk.walk(f, [TRAIN_EXIT[0] - tw.x, TRAIN_EXIT[1] - tw.y]);
    await sleep(600);
  }
  await fadeOut(true);
  if (await jobRoom(JOB_ROOM[job], novice, c.look) === false) await fadeOut(true);
  // the town: the party on it as ever, the leader unseen till it has walked in to its place
  bringParty();
  G.base = leaderBase();
  put();
  await waitReady();
  await enterTown();
  const me = W.chars[0], to = me.w.cell, g = folk.actor(me.look, null, to, true, OFF_SCREEN);
  if (g) { stage.drop(me); me.offstage = true; }
  await sleep(250);
  fadeOut(false);
  playBgm(G.town ? G.town.map : null);
  if (g) {
    await walkActor(g, to);
    folk.drop(g);
    stage.show(me);
    me.offstage = false;
  }
  joinScene();
}
// cells from where it is going that one walking in to the party's place in town starts (by request: just off the
// screen, not at the town's edge)
const OFF_SCREEN = 10;
// actor f walking to field cell `to` → a promise, once there (or stuck: given up after a while)
const walkActor = (f, to) => new Promise(done => { if (!folk.walk(f, to, done)) done(); setTimeout(done, 15000); });
// The leader changes to second job `job` (by request, as the Novice to its first: pickJob): it walks off the screen
// from where the party stands in town, the rest of the party staying, as the screen fades; the job's room fades in
// (roomOf), where it walks in to the NPC and changes with a job level up, then walks off; the town fades in again and
// it walks back to its place in the party, and the map ahead is up again. The change itself is kept at once (a page
// loaded on the way finds it changed in town).
// (party member k, by request a recruit too: recruitJobs; the map ahead drawn again after it, but with `more`)
async function secondJobScene(job, k = 0, more = false) {
  show('s-prep'); $('prep').innerHTML = '';
  A.setView(0, 0); A.setFocus(null);
  const lead = W.chars[k], from = lead.w.cell;
  const was = sim.newChar(savedOf(lead)).look;  // (its look as it is, for the one walking off)
  LOOK.loadLook(was, () => {});
  const carts = [sim.hasCart(lead)];  // (a merchant's cart along with it, by request, and a blacksmith's or an alchemist's back)
  changeTo(lead, job);
  carts.push(sim.hasCart(lead));
  if (!k) G.base = leaderBase();  // (the new job's skills from none)
  keep();
  stage.drop(lead); lead.offstage = true;
  const f = folk.actor(was, from, null, true);
  if (f) {
    f.w.heading = lead.w.heading;
    if (carts[0]) stage.tow(f.w, true);
    // (off the screen, away from the camera's side of the party: back the way it faces, else to the nearest edge)
    const h = lead.w.heading || [0, -1], to = [from[0] - Math.sign(h[0]) * OFF_SCREEN, from[1] - Math.sign(h[1]) * OFF_SCREEN];
    if (!folk.walk(f, to)) folk.away(f);
    await sleep(900);
  }
  await fadeOut(true);
  if (f) stage.tow(f.w, false);
  for (const x of [...W.chars]) { sim.removeChar(x); stage.drop(x); }  // (the party off the field: its look walks)
  W.chars = [];
  const room = roomOf(job, lead.look.sex);
  if (!room || await jobRoom(room, was, lead.look, carts) === false) await fadeOut(true);
  bringParty();
  put();
  await waitReady();
  await enterTown();
  const me = W.chars[k], to = me.w.cell, g = folk.actor(me.look, null, to, true, OFF_SCREEN);
  if (g) { stage.drop(me); me.offstage = true; if (carts[1]) stage.tow(g.w, true); }
  await sleep(250);
  fadeOut(false);
  playBgm(G.town ? G.town.map : null);
  if (g) {
    await walkActor(g, to);
    stage.tow(g.w, false);
    folk.drop(g);
    stage.show(me);
    me.offstage = false;
  }
  if (!more) prep();
}
// job `job`'s room faded in (from black), the Novice (look `novice`) walking in from the room's door to stand before
// the NPC, a job level up, it in its new look (`look`), and back out it walks, the screen going black on the way
// (as it leaves the training ground) → false: no room to show (its floor missing), the screen left black
async function jobRoom(room, novice, look, carts = [false, false]) {
  const { map, door, out } = room, i = room.i || 0, cut = (FLOORS[map] || [])[i], win = cut && { map, i, open: cut.open };
  const floor = win && await A.loadFloor(win);
  if (!floor || floor.key !== map + '_' + i || !cut.at) return false;
  folk.stop();
  sim.setFloor(win, floor.heights);
  A.showFloor(floor);
  await folk.start(townT, { map, ...cut }, false, ROOM_AROUND);
  // before the NPC, a little way off (by request: across its counter): the open cell 3, 2 or 4 steps the way it faces,
  // else of those 3 (then 2, 4, 5…) cells off it the one nearest the way it faces
  const at = cut.at, npc = (await folk.npcsNear({ map, ...cut })).find(n => n.x === at[0] && n.y === at[1]), step = DIR_STEP[npc ? npc.dir : 4];
  // (or the room's own, JOB_ROOM's stand)
  let stand = room.stand ? [room.stand[0] - cut.x, room.stand[1] - cut.y] : [3, 2, 4].map(d => [at[0] + step[0] * d, at[1] + step[1] * d]).find(p => W.field.open(...p));
  for (const r of [3, 2, 4, 5, 6, 7, 8]) {
    if (stand) break;
    const ring = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
      if (Math.max(Math.abs(dx), Math.abs(dy)) === r && W.field.open(at[0] + dx, at[1] + dy)) ring.push([dx, dy]);
    ring.sort((a, b) => Math.hypot(a[0] / r - step[0], a[1] / r - step[1]) - Math.hypot(b[0] / r - step[0], b[1] / r - step[1]));
    if (ring.length) stand = [at[0] + ring[0][0], at[1] + ring[0][1]];
  }
  stand ||= at;
  // the camera turned so the NPC is above the Novice on the screen and to a side, 45° from straight up as far as
  // the room's models leave the Novice in sight (by request: it unhidden first), else nearer straight up or further
  // round (OrbitControls' azimuth: 0 has north up, π/2 west)
  const up = Math.atan2(-(at[0] - stand[0]), at[1] - stand[1]), e = Math.PI / 8;
  // (a room's `npc: 'right'`, by request: the NPC to the upper right only, 45° then 22.5°, 67.5°; +k puts it right;
  // `npc: 'left'` the same to the upper left)
  // Only from the south, 45° off it at most (by report: the rooms are built for the client's camera, north up, their
  // south and west walls left out and the walls' black tops showing from the other sides): those of the turns that
  // are, else the one of them nearest north up
  const turns = room.npc === 'right' ? [2, 1, 3] : room.npc === 'left' ? [-2, -1, -3] : [2, -2, 1, -1, 3, -3, 0];
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a)), azs = turns.map(k => wrap(up + k * e));
  const fine = azs.filter(a => Math.abs(a) <= ROOM_TURN + 1e-6);
  A.turnTo(A.clearAzimuth([stand], fine.length ? fine : [Math.max(-ROOM_TURN, Math.min(ROOM_TURN, azs[0]))], true), true);
  A.setFocus([folk.spotAt(at), folk.spotAt(stand)]);
  const f = folk.actor(novice, folk.onWay([door[0] - cut.x, door[1] - cut.y], stand, ROOM_IN), null, true);
  if (f) f.born = townT;  // (fading in as it comes)
  if (f && carts[0]) stage.tow(f.w, true);  // (carts: [before, after] the change, each one towing one)
  await sleep(250);
  fadeOut(false);
  playBgm(map);
  if (!f) return true;
  await walkActor(f, stand);
  f.w.heading = [Math.sign(at[0] - stand[0]), Math.sign(at[1] - stand[1])];
  await sleep(1000);
  // (the new look as the job level up goes off, by request: not after it)
  const g = folk.actor(look, folk.cellOf(f), null, true);
  if (g) { g.w.heading = f.w.heading; stage.tow(f.w, false); folk.drop(f); if (carts[1]) stage.tow(g.w, true); }
  E.play('EF_JOBLVUP', (g || f).w, townT);
  await sleep(1500);
  folk.walk(g || f, [out[0] - cut.x, out[1] - cut.y]);
  await sleep(600);
  await fadeOut(true);
  stage.tow(f.w, false);
  if (g) stage.tow(g.w, false);
  folk.stop();
  A.setFocus(null);
  return true;
}
// in the job's town (G.town; from black, or the loading screen): the party lands there, and the recruits come
async function arriveHome() {
  await waitReady();
  await enterTown();
  W.chars.forEach(c => stage.arrive(c, Infinity));  // (unseen till they teleport in)
  G.base ??= leaderBase();
  loadingScreen(false);
  await sleep(250);  // (the camera on the party there before it shows)
  fadeOut(false);
  playBgm(G.town ? G.town.map : null);
  await teleportIn(FADE_MS * 0.6, null);
  joinScene();
}
// The party's look for its first members (by request, as 招募's, recruitScene, but nobody to pick): the leader sits
// with a chat room over it, and after a while the recruits (G.recruits) walk in from off the screen to its left and
// right, where they join as they get there, nothing written on the screen meanwhile (by request); then the map ahead, the leader's status open for the points it has
async function joinScene() {
  const my = ++recId, lead = W.chars[0];
  show('s-prep');
  $('prep').innerHTML = '';  // (no words meanwhile, by request: the chat room says it)
  folk.keepOut(true);  // (the townsfolk off the screen meanwhile)
  seat();
  await sleep(ROOM_AFTER);  // (sat down first, by request)
  if (my !== recId) return;
  lead.room = { title: '徵隊友' };
  await sleep(RECRUIT_WAIT);
  if (my !== recId) return;
  const cands = G.recruits.map(r => recruitChar(r, lead)), spots = sideSpots();
  const actors = await Promise.all(cands.map((c, k) => new Promise(done => {
    LOOK.loadLook(c.look, () => {});
    const f = folk.actor(c.look, null, spots[k]);
    if (!f) return done(null);
    const there = () => { f.w.heading = lead.w.heading; done(f); };
    if (!folk.walk(f, spots[k], there)) there();
    setTimeout(there, 20000);  // (one stuck on the way)
  })));
  if (my !== recId) return;
  cands.forEach((c, k) => {
    if (actors[k]) folk.drop(actors[k]);
    c.hp = c.pc.maxHp; c.sp = c.pc.maxSp;
    sim.enter(c);
    W.chars.push(c);
    W.field.placeNear(c.w, spots[k]);
    c.w.heading = lead.w.heading;
    stage.show(c);
  });
  lead.room = null;
  folk.keepOut(false);
  G.recruits = null;
  G.train = null;
  keep();
  await sleep(600);
  if (my !== recId) return;
  prepTab = null;
  await prep();
  if (!$('s-prep').hidden && $('s-alloc').hidden) allocate(0);
}
// the cells to the leader's left and right, a cell between (as lineUp's row), or the free ones nearest them
function sideSpots() {
  const L = W.chars[0].w.cell, f = W.chars[0].w.heading || [1, 1], r = [-f[1], f[0]], used = new Set([L.join()]);
  return [-2, 2].map(k => {
    const want = [L[0] + r[0] * k, L[1] + r[1] * k];
    for (let d = 0; d < 6; d++) for (let y = -d; y <= d; y++) for (let x = -d; x <= d; x++) {
      const p = [want[0] + x, want[1] + y];
      if (Math.max(Math.abs(x), Math.abs(y)) === d && W.field.open(...p) && !used.has(p.join())) { used.add(p.join()); return p; }
    }
    return want;
  });
}
// 結算 closed, to town (by request): the party teleports away, the screen fades to black and back on a town, where
// they teleport in, a little apart, and sit, the leader's status open (prep)
async function goTown() {
  show('s-prep');
  $('prep').innerHTML = '';
  A.setView(0, 0); A.setFocus(null);  // (結算 gone: the camera on the party as in the fight, by request, as 出發's)
  await sleep(600);
  if (run) await teleportOut(run.simT, true);
  await fadeOut(true);
  stopFight();
  await enterTown();
  await sleep(250);  // (the camera on the party there before it shows)
  fadeOut(false);
  prep('arrive', teleportIn(FADE_MS * 0.6)).then(() => { if (!$('s-prep').hidden && $('s-alloc').hidden) allocate(0); });
}
// (by request, 設定's Debug 回城鎮繼續, on the 全滅 screen or its replay) the party wiped back in town at the same map
// ahead, as it stood as the map began: its record taken back off 過往紀錄 and its save put back, its bag and zeny
// then (what it drank or spent there given back), no level gained; no teleport out, as the party is down
let wiped = null;  // { start, rec, save }: the map lost (gameOver), while it is still on screen (its replay too: run.start the same)
const canRevive = () => !!(run && wiped && wiped.start === run.start);
async function reviveTown() {
  store.set(HIST_KEY, (store.get(HIST_KEY) || []).filter(r => r.at !== wiped.rec.at));
  G = wiped.save; wiped = null;  // (gameOver let G go and threw its save away: both back)
  G.bag = structuredClone(run.start.bag); G.zeny = run.start.zeny; G.fight = null;
  put();
  show('s-prep');
  $('prep').innerHTML = '';
  A.setView(0, 0); A.setFocus(null);
  await fadeOut(true);
  stopFight();
  bringParty();  // (the party as saved when the map began: whatever it got in the fight gone)
  await enterTown();
  await sleep(250);
  fadeOut(false);
  prep('arrive', teleportIn(FADE_MS * 0.6));
}
// the party standing up and teleporting away from where it is (as its own Teleport: stage.depart), each a moment
// apart by chance (by request), at t on the clock the field is drawn at → a promise, once they are gone
// (quiet: no 瞬間移動!! over their heads, neither as they set off for a map nor as the map won takes them home: by request)
async function teleportOut(t, quiet = false) {
  for (const c of [...W.chars, ...W.rivals]) if (c.dead == null) { if (c.sitting) sim.sit(c, false); stage.depart(c, t + Math.random() * TP_SPREAD, quiet); }
  await sleep(TP_SPREAD + 450);
}
// the screen black at once (on), or not (fadeOut fades)
function fadeSet(on) {
  const el = $('fade');
  el.style.transition = 'none';
  el.classList.toggle('on', on);
  void el.offsetWidth;
  el.style.transition = '';
}
// the party teleporting in where it stands in town, after `after` ms, each a moment apart by chance (by request),
// then sitting (but for the leader, standing for its status: stand) → a promise, once they sit
const TP_SPREAD = 300;
// On a map (its clock, by request): the party teleports in (teleportIn: FADE_MS × 0.6, then up to TP_SPREAD apart,
// each landing 550 ms), all landed by LANDED_MS; nobody acts (自動: sim.js think waits for canAct) until ACT_MS,
// 500 ms after; the first wave comes in at ARRIVE_MS, 500 ms after that. The same each time (a reload, a replay).
const LANDED_MS = FADE_MS * 0.6 + TP_SPREAD + 550, ACT_MS = LANDED_MS + 500, ARRIVE_MS = ACT_MS + 500;
function teleportIn(after, stand = 0, now = townT) {
  const ts = W.chars.map(() => after + Math.random() * TP_SPREAD);
  W.chars.forEach((c, i) => stage.arrive(c, now + ts[i]));
  return sleep(Math.max(...ts) + 500).then(() => stand != null && seat(stand));
}
// The skill tree as the sandbox's (sandbox.js buildSkills; by request): a square per skill, its icon and level, a
// skill its job's tree wants others learned first for a column to the right of the deepest of them, on the row of
// the first where that is free, joined to each by a line (amber while that one is below the level asked); each
// skill needing none heads a branch, laid out whole below the branches before it; those that neither need nor are
// needed follow on their own → { at: {skill: [column, row]}, needs, cols, rows }
const SK = 32, SK_COL = 46, SK_ROW = 38, SK_ICON = [4, 28, 15];  // a square, a column's and a row's step; the icon's left, right and middle
function treeLayout(c, list) {
  const requires = sim.jobFor(c).requires || {}, names = new Set(list.map(sk => sk.name));
  const needs = Object.fromEntries(list.map(sk => [sk.name, (requires[sk.name] || []).filter(([n]) => names.has(n))]));
  const linked = new Set();
  for (const [n, rs] of Object.entries(needs)) if (rs.length) { linked.add(n); rs.forEach(([r]) => linked.add(r)); }
  const depth = {}, col = n => depth[n] ??= Math.max(-1, ...needs[n].map(([r]) => col(r))) + 1;
  const roots = {}, root = n => roots[n] ??= needs[n].length ? root(needs[n][0][0]) : n;
  const order = list.map(sk => sk.name), branch = n => order.indexOf(root(n));
  const at = {}, taken = new Set();
  let rows = 0, cols = 0;
  for (const sk of list.filter(x => linked.has(x.name)).sort((a, b) => branch(a.name) - branch(b.name) || col(a.name) - col(b.name))) {
    const x = col(sk.name), first = needs[sk.name][0];
    let y = first ? at[first[0]][1] : rows;
    while (taken.has(y + ',' + x)) y++;
    taken.add(y + ',' + x);
    at[sk.name] = [x, y];
    rows = Math.max(rows, y + 1); cols = Math.max(cols, x + 1);
  }
  return { at, needs, cols, rows };
}
// A skill's details over the status and skills (edit: false, the other two's: only shown) (as the sandbox's openSkill): its icon and names, the client's description,
// the skills it needs first and the levels the leader has of them, and its levels, each with its SP and the client's
// line for that level. Its level is changed by ◀ ▶ or by picking a level, only within the points not yet spent
// (by request): no lower than it was before this 配點 (had), nor so low that a skill learned before then would be
// unlearned; no higher than the points left reach (with what it needs first, raised along: sim.learnSkill).
const LV_LINE = /^\[Lv\s*(\d+)\]\s*:\s*(.*)$/i;
function skillInfo(c, name, had, changed, edit = true) {
  const zh = n => (db.skills[n] || {}).zh || (db.skills[n] || {}).en || n;
  const requires = sim.jobFor(c).requires || {};
  // the least it may go down to: what it had, and what the skills learned before need of it
  const floorOf = () => Math.max(had[name] || 0, ...Object.entries(requires).filter(([n]) => (had[n] || 0) > 0)
    .flatMap(([, rs]) => rs.filter(([r]) => r === name).map(([, l]) => l)));
  const draw = () => {
    const sk = sim.jobSkills(c).find(x => x.name === name), fit = sim.fitSkills(c), lv = c.levels[name] || 0, low = floorOf(), top = fit.top[name] ?? lv;
    const perLv = {}, about = [];
    for (const line of sk.desc || []) { const m = line.match(LV_LINE); if (m) perLv[+m[1]] = m[2]; else about.push(line); }
    const head = about.filter(l => /^(系列|類型|對象|屬性)\s*:/.test(l)), body = about.filter(l => !head.includes(l));
    while (body.length && !body[body.length - 1]) body.pop();
    const reqs = requires[name] || [];
    const reqRow = ([r, l]) => {
      const left = r in fit.hidden || !sim.jobSkills(c).some(x => x.name === r), have = left ? (fit.hidden[r] || 0) : c.levels[r] || 0, icon = (db.skills[r] || {}).icon;
      return `<li class="${!left && have < l ? 'bad' : ''}">${icon ? `<img src="../assets/${icon}" alt="">` : '<span></span>'}<span>${esc(zh(r))} Lv ${l}</span>` +
        `<span class="muted">${left ? '學這個技能時一併扣點' : `目前 Lv ${have}`}</span></li>`;
    };
    const quest = sim.questSkill(name), why = l => quest ? '任務技能，不用技能點' : !edit ? '照技能配點自動學' : l < low ? (l < (had[name] || 0) ? '之前配的點不能收回' : '已學的技能需要這個等級') :
      fit.lacking[name] ? '技能點數不夠學前置技能' : '技能點數不夠';
    const along = l => l > lv ? Object.entries(fit.plan(name, l).want).filter(([n]) => n !== name) : [];
    const ok = l => edit && !quest && l !== lv && l >= low && l <= top;
    const row = l => {
      const more = ok(l) ? along(l) : [], also = more.length ? `一併學 ${more.map(([n, ml]) => `${zh(n)} Lv ${ml}`).join('、')}` : '';
      return `<button data-lv="${l}" class="${l === lv ? 'on' : ''}"${l !== lv && !ok(l) ? ` disabled title="${why(l)}"` : also ? ` title="${esc(also)}"` : ''}>` +
        `<b>${l ? 'Lv ' + l : '未學'}</b><span class="sp">${l ? `SP ${sk.sp[l - 1] || 0}` : ''}</span><span class="txt">${l ? esc(perLv[l] || '') : ''}</span></button>`;
    };
    $('skill').innerHTML = win(esc(sk.zh || sk.en), `<div class="skhead">${sk.icon ? `<img src="../assets/${sk.icon}" alt="">` : ''}` +
      `<div><b>${esc(sk.zh || sk.en)}</b><div class="muted">${esc(sk.en)}　MAX Lv ${sk.max}</div></div>` +
      `<div class="sklv"><button class="arw l" data-k="-1"${ok(lv - 1) ? '' : ' disabled'} aria-label="−1"></button><b>Lv ${lv} / ${sk.max}</b>` +
      `<button class="arw r" data-k="1"${ok(lv + 1) ? '' : ' disabled'} aria-label="+1"></button></div></div>` +
      (head.length ? `<div class="skmeta">${head.map(l => `<span>${esc(l.replace(/\s*:\s*/, '：'))}</span>`).join('')}</div>` : '') +
      (body.length ? `<div class="skdesc">${body.map(l => l ? `<p>${esc(l.replace(/^內容\s*:\s*/, ''))}</p>` : '<br>').join('')}</div>` : '') +
      (quest ? `<p class="muted">任務技能：靠任務學會，不用技能點${sim.QUEST_JLV[name] && sim.jobFor(c).tier <= sim.QUEST_JLV[name][1] ? `；Job Lv ${sim.QUEST_JLV[name][0]} 起自動學會` : ''}。</p>` : '') +
      (reqs.length && !quest ? `<h4>前置技能</h4><ul class="skreqs">${reqs.map(reqRow).join('')}</ul>` : '') +
      `<h4>各級數值</h4><div class="sklvs">${Array.from({ length: sk.max + 1 }, (_, l) => row(l)).join('')}</div>`,
      (edit ? `<span class="grow" style="padding-left:4px">Skill Point : <b style="color:var(--accent)">${fit.left}</b></span>` : '<span class="grow"></span>') + rb('關閉', 'id="k-x"'), 'dlg skwin', true);
    const set = l => { if (!ok(l)) return; sim.learnSkill(c, name, l); changed(); draw(); };
    for (const b of $('skill').querySelectorAll('.sklvs button')) b.onclick = () => set(+b.dataset.lv);
    for (const b of $('skill').querySelectorAll('.sklv .arw')) b.onclick = () => set(lv + +b.dataset.k);
    $('skill').querySelector('.tb .x').onclick = $('k-x').onclick = close;
  };
  const close = () => { $('s-skill').hidden = true; };
  $('s-skill').onclick = e => { if (e.target === $('s-skill')) close(); };
  draw();
  $('s-skill').hidden = false;
}
// the leader's stats and skill levels as they are: the least allocate takes them back to
const leaderBase = () => ({ stats: { ...W.chars[0].stats }, levels: { ...W.chars[0].levels } });
// a click on the field: a character, at the map ahead, opens its status and skills
// a click on the field at the map ahead: a character opens its status and skills (the tab's window closed: by
// request), anything else closes them
// (a character tapped at the map ahead, or in the fight too, by request: its status and skills, the camera on it)
function clickField(m) {
  const fighting = run && !run.over && !$('hud').hidden;
  if (!fighting && ($('s-prep').hidden || !prepChanged)) return;
  if (!fighting && recruitClick(m)) return;
  const i = W.chars.findIndex(c => c.w === m);
  if (i < 0) return allocClose?.();
  if (allocOn === W.chars[i] && !$('s-alloc').hidden) return allocClose?.();  // (the one shown tapped again: closed, by request)
  clickGuard = performance.now() + 400;  // (the tap's own click, after it, falls on the window it opened: dropped)
  setTab?.(null);
  allocate(i);
}
let allocClose = null;
const ALLOC_TABS = [['stat', '素質'], ['skill', '技能'], ['gear', '裝備'], ['card', '卡片'], ['act', '行動']];
let gearOpen = null;  // (裝備's slot whose list is shown)
let allocTab = 'stat', allocOn = null;  // (allocOn: the character shown)
// 行動: the rules character c follows on 自動 (sim.js: its preset's, 基本 or its job line's), as the sandbox's list
// reads them, only shown for now (by request), those for skills not learned left out; in the fight the rule it is
// on is marked (hud)
const RULE_ACT = { attack: '普攻', move: '移動', sit: '坐下（坐到 SP 滿）', wait: '等待', pickup: '撿東西', potion: '喝藥水', spPotion: '喝藍色藥水', speedPotion: '喝攻速藥水' };
const RULE_ICON = { potion: 501, spPotion: 505, speedPotion: 645 };
const RULE_WHO = { target: '對象', self: '自己' };
function rulesHtml(c) {
  const actName = d => Array.isArray(d) ? '箭類（挑傷害最高的）' : RULE_ACT[d] || db.skills[d]?.zh || d;
  const actIcon = d => { if (RULE_ICON[d]) return itemIcon(RULE_ICON[d]); const sk = db.skills[Array.isArray(d) ? d[0] : d]; return sk && sk.icon ? `<img src="../assets/${sk.icon}" alt="">` : ''; };
  const sel = it => { const d = sim.SELECT[it.k]; return !d ? it.k : typeof d.zh === 'function' ? d.zh(it.v || d.v) : d.zh; };
  const clause = x => {
    const n = x.n ?? 'any', who = x.who === 'foe' ? '怪物' : '隊友';
    const head = RULE_WHO[x.who] || (n === 'none' ? '沒有' + who : n === 'any' ? '有' + who : `至少 ${n} ${x.who === 'foe' ? '隻怪物' : '個隊友'}`);
    const is = x.is.map(sim.condText).join('、');
    return head + (is ? '：' + is : '');
  };
  return `<ol class="rules">${sim.rulesOf(c).map((r, i) => {
    if (!sim.ruleOn(c, { ...r, off: false })) return '';
    const tg = r.target && (r.target || []).length ? `<div class="rp"><span class="lab">對象</span>${r.target.map(sel).join(' → ')}</div>` : '';
    const ifs = (r.if || []).length ? `<div class="rp"><span class="lab">如果</span>${r.if.map(clause).map(esc).join('；')}</div>` : '';
    return `<li data-i="${i}" class="${r.off ? 'off' : ''}${c.rule === i ? ' on' : ''}"><div class="rdo">${actIcon(r.do)}${esc(actName(r.do))}</div>${tg}${ifs}</li>`;
  }).join('')}</ol>`;
}
// at the map ahead the party sits (by request), but for the one whose status is open (standing: i)
function seat(i = -1) {
  W.chars.forEach((c, k) => { if (c.dead == null && !!c.sitting !== (k !== i)) sim.sit(c, k !== i); });
}
const FOCUS_CELL = 44;  // (CSS px a cell, the character tapped: about 115 px tall)
let clickGuard = 0;
document.addEventListener('click', e => { if (performance.now() < clickGuard) { e.stopPropagation(); e.preventDefault(); } }, true);
// Character i's status window and skill tree, side by side (as the client's), over the map ahead. The leader's
// stat and skill points are spent here (what was spent before this map stays: G.base); the other two's only shown
// (they grow by their builds). In the fight only shown, the leader's too (what it fights with is as the map began).
// (o: one not of the party shown instead, as 招募's recruits are: { char, w its mover, pick() for 確定選擇, closed() })
function allocate(i, o = null) {
  const fighting = !!run, c = o ? o.char : W.chars[i], star = !o && i === 0, lead = star && !fighting && !G?.view, base = lead ? G.base || leaderBase() : { stats: c.stats, levels: c.levels };
  const floor = base.stats, had = base.levels;
  // (closed: the camera back on the whole party)
  const close = allocClose = () => {
    if ($('s-alloc').hidden) return;
    $('s-alloc').hidden = true; $('s-skill').hidden = true; A.setFocus(null); allocClose = allocOn = null;
    if (fighting) return A.setView(0, 0);
    if (o) { frame(); return o.closed?.(); }
    frame(); seat(); prepChanged?.();
  };
  const gearEdit = !fighting && !o && !G?.view;  // (what it holds picked at the map ahead, by a member of the party; not a record's: viewRecord)
  const draw = () => {
    if (gearEdit && autoGear(c)) LOOK.loadLook(c.look, () => {});  // (a skill or a stat point changes what it may have)
    sim.calc(c);
    const fit = sim.fitSkills(c), jj = sim.jobFor(c), left = B.pointsTotal(db, jj, c.blv) - B.pointsSpent(c.stats), pc = c.pc;
    // (as the client's status window: the stats on the left, what they make in two columns beside them)
    const right = [['Atk', `${pc.batk} + ${pc.watk}`, 'Def', `${pc.def} + ${pc.def2}`], ['Matk', pc.matk, 'Mdef', `${pc.mdef} + ${pc.mdef2}`],
      ['Hit', pc.hit, 'Flee', `${pc.flee} + ${pc.flee2 / 10 | 0}`], ['Crit', pc.cri / 10 | 0, 'Aspd', pc.aspd], ['HP', pc.maxHp, 'SP', pc.maxSp],
      lead ? ['Status Point', `<b style="color:var(--accent)">${left}</b>`, '', ''] : ['配點', esc(buildLabel(c.build) || '自訂'), '', '']];
    const stats = `<div class="statwin${lead ? '' : ' auto'}">${B.STATS.map((s, k) => {
      const v = c.stats[s], cost = B.statCost(v), r = right[k];
      return `<span class="k">${s[0].toUpperCase() + s.slice(1)}</span><span class="v">${v}</span>` +
        (lead ? `<button class="arw sl" data-stat="${s}" data-k="-1"${v > floor[s] ? '' : ' disabled'} aria-label="${s} −1"></button>` +
          `<button class="arw sr" data-stat="${s}" data-k="1"${cost <= left && v < jj.maxStat ? '' : ' disabled'} aria-label="${s} +1"></button><span class="c">${cost}</span>` : '') +
        `<span class="k${k === 5 ? ' wide' : ''}">${r[0]}</span><span>${r[1]}</span>${k === 5 ? '' : `<span class="k">${r[2]}</span><span>${r[3]}</span>`}`;
    }).join('')}</div>`;
    // (the tree: tapping a skill opens its details, where the leader's level is changed; the quest skills in it too,
    // see-through until their job level comes, as any not learned: by request)
    const list = sim.jobSkills(c), { at, needs, cols, rows } = treeLayout(c, list);
    const zh = n => (db.skills[n] || {}).zh || n;
    const square = sk => { const lv = c.levels[sk.name] || 0, pos = at[sk.name], lack = fit.lacking[sk.name];
      return `<button class="skt${lv ? '' : ' unlearned'}${lv > (had[sk.name] || 0) ? ' new' : ''}" data-sk="${sk.name}"` +
        ` title="${esc((sk.zh || sk.en) + ` Lv ${lv}/${sk.max}` + (lack ? `（要先學：${lack.map(([r, l]) => `${zh(r)} Lv ${l}`).join('、')}）` : '') +
          (!lv && sim.QUEST_JLV[sk.name] ? `（任務技能：Job Lv ${sim.QUEST_JLV[sk.name][0]} 學會）` : ''))}"` +
        (pos ? ` style="left:${pos[0] * SK_COL}px;top:${pos[1] * SK_ROW}px"` : '') + `>${sk.icon ? `<img src="../assets/${sk.icon}" alt="">` : ''}<b>${lv || ''}</b></button>`; };
    const lines = Object.entries(at).flatMap(([n, [x, y]]) => needs[n].map(([r, l]) => {
      const [px, py] = at[r], x1 = px * SK_COL + SK_ICON[1], y1 = py * SK_ROW + SK_ICON[2], x2 = x * SK_COL + SK_ICON[0], y2 = y * SK_ROW + SK_ICON[2], xm = (x1 + x2) / 2;
      return `<path${(c.levels[r] || 0) < l ? ' class="bad"' : ''} d="M${x1} ${y1}H${xm}V${y2}H${x2}"/>`;
    }));
    const skills = !list.length ? '<div class="muted">這個職業還沒有技能</div>' :
      (rows ? `<div class="sktree" style="width:${cols * SK_COL - (SK_COL - SK)}px;height:${rows * SK_ROW - (SK_ROW - SK)}px">` +
        `<svg width="1" height="1">${lines.join('')}</svg>${list.filter(sk => at[sk.name]).map(square).join('')}</div>` : '') +
      `<div class="skloose">${list.filter(sk => !at[sk.name]).map(square).join('')}</div>`;
    const skillPlan = (skillBuildsFor(c.look.job).find(b => b.id === c.skillBuild) || {}).label || '自訂';
    // (by request: one window, 素質, 技能 or 行動, picked by the tabs under it, at the map ahead and in the fight alike)
    // (by request: the leader's 行動 offers its line's presets, when it has more than one: sim.JOB_VARIANTS, picked at
    // the map ahead only, as its stats and skills)
    const variants = star && sim.jobVariants(c), onVar = variants && (variants.some(([k]) => k === c.tactic) ? c.tactic : 'job');
    const tacs = variants ? `<div class="tacs"><span class="lab">策略</span>${variants.map(([k, label]) =>
      rb(esc(label), `data-tac="${k}"${lead ? '' : ' disabled'}`, k === onVar)).join('')}</div>` : '';
    const body = { stat: stats, skill: skills, gear: allocTab === 'gear' ? gearHtml(c, gearOpen, gearEdit) : '', card: allocTab === 'card' ? cardTabHtml(c, gearEdit) : '', act: tacs + rulesHtml(c) }[allocTab];
    const info = allocTab === 'skill' ? (lead ? `Skill Point : <b style="color:var(--accent)">${fit.left}</b>` : `<span class="muted">技能：${esc(skillPlan)}（自動）</span>`)
      : allocTab === 'act' ? `<span class="muted">照順序，第一條符合的就做</span>` : allocTab === 'gear' ? `<span class="muted">身體和手依等級自動裝上最好的${G?.hats?.length ? `・隊伍的頭飾 ${G.hats.length} 個` : ''}</span>` : '';
    $('alloc').innerHTML = `<div class="charinfo">` + (fighting && !o && allocTab === 'stat' ? '<div class="states"><div class="strow"></div><div class="stcap" hidden></div></div>' : '') + (allocTab === 'card' ? body :  // (卡片: no window, by request)
      win(`${star ? '★' : ''}${esc(c.name || jobLabel(c.look.job))}　Base Lv. ${c.blv}　Job Lv. ${c.jlv}`, body,
        info || o?.pick ? `<span style="margin-right:auto;padding-left:4px">${info}</span>${o?.pick ? rb('確定選擇', 'id="a-pick"') : ''}` : null, `dlg tab-${allocTab}`, true)) +  // (no 關閉: by request, the × does)
      `<nav class="tabs">${ALLOC_TABS.map(([k, label]) => rb(label, `data-atab="${k}"`, k === allocTab)).join('')}</nav></div>`;
    // (the tab on tapped again: the window closed, by request, as the map ahead's tabs)
    for (const b of $('alloc').querySelectorAll('[data-atab]')) b.onclick = () => { if (b.dataset.atab === allocTab) return close(); allocTab = b.dataset.atab; draw(); frame(); };
    for (const b of $('alloc').querySelectorAll('[data-stat]')) b.onclick = () => {
      const s = b.dataset.stat, k = +b.dataset.k, l = B.pointsTotal(db, jj, c.blv) - B.pointsSpent(c.stats);
      if (k > 0 && (B.statCost(c.stats[s]) > l || c.stats[s] >= jj.maxStat)) return;
      if (k < 0 && c.stats[s] <= floor[s]) return;
      c.stats[s] += k;
      keep(); draw();
    };
    for (const b of $('alloc').querySelectorAll('[data-gear]')) b.onclick = () => { gearOpen = gearOpen === b.dataset.gear ? null : b.dataset.gear; draw(); };
    for (const b of $('alloc').querySelectorAll('[data-haton], [data-hatoff]')) b.onclick = () => {
      if (!gearEdit) return;
      if (b.dataset.haton) putOnHat(c, +b.dataset.haton); else takeOffHat(c, b.dataset.hatoff);
      LOOK.loadLook(c.look, () => {});
      keep(); draw(); frame();
    };
    for (const b of $('alloc').querySelectorAll('[data-pick]')) b.onclick = () => {
      if (!gearEdit) return;
      const [hand, v] = b.dataset.pick.split(':');
      c.hands = { ...c.hands, [hand === 'R' ? 'right' : 'left']: v };
      if (autoGear(c)) LOOK.loadLook(c.look, () => {});
      keep(); draw(); frame();
    };
    for (const b of $('alloc').querySelectorAll('[data-tac]')) b.onclick = () => { if (!lead || b.dataset.tac === onVar) return; sim.setRules(c, null, b.dataset.tac); keep(); draw(); };
    for (const b of $('alloc').querySelectorAll('[data-sk]')) b.onclick = () => skillInfo(c, b.dataset.sk, had, () => { keep(); draw(); }, lead);
    if (allocTab === 'card') cardTabOn(c, gearEdit, put => { if (put) keep(); draw(); frame(); });
    if ($('alloc').querySelector('.tb .x')) $('alloc').querySelector('.tb .x').onclick = close;
    if (o?.pick && $('a-pick')) $('a-pick').onclick = () => o.pick();
    stShown = null; stateIcons();
  };
  draw();
  $('s-alloc').hidden = false;
  allocOn = c;
  if (!fighting && !o) seat(i);  // (it stands up, the others sit)
  A.setFocus([o ? o.w : c.w], { cellPx: FOCUS_CELL });  // (the camera on it in what the windows leave free, always as big: by request)
  frame();
}
// The statuses on the character whose status window is open, in the fight (issue 8, by request: only then) and on
// 素質 only (issue 13, by request: not on the other tabs), as the
// client's icons (viewer/states.json, png/state/<efst>.png) in a row over the window, more rows going up when one is
// full; the time each has left as how much of it is still there, from the foot up (by request: the rest
// half transparent, the icon under it at 40%; all of it when put on, half at half the time), a tap on one its name, the time and the client's
// words for it under the row. A unit's statuses: its sc (skills', items'), and the ailments sim.js keeps on it of
// their own (u.frozen ...); one with no start, its start as first seen here.
const AILS = ['frozen', 'stunned', 'asleep', 'poison', 'curse', 'silenced', 'confused', 'bleeding', 'blind'];
const AIL_ZH = { frozen: '冰凍', stunned: '暈眩', asleep: '睡眠', stone: '石化', stoning: '石化中', poison: '中毒', curse: '詛咒', silenced: '沉默', confused: '混亂', bleeding: '出血', blind: '黑暗' };
const ailSeen = new WeakMap();
let stShown = null, stPick = null;
function statesOn(u, t) {
  const out = [], seen = new Set(), E = STATES.states;
  const put = (key, start, until) => {
    const e = E[key];
    if (e == null || seen.has(e) || !(t < until)) return;
    seen.add(e);
    out.push({ key, e, start, until });
  };
  const since = x => { if (!ailSeen.has(x)) ailSeen.set(x, t); return ailSeen.get(x); };
  for (const s of u.sc || []) put(s.name, s.start ?? since(s), s.until);
  for (const k of AILS) if (u[k]) put(k, since(u[k]), u[k].until);
  if (u.stone) put(u.stone.on ? 'stone' : 'stoning', u.stone.start, u.stone.on ? u.stone.until : u.stone.wait);
  return out;
}
function stateName(x) {
  const own = db.skills[x.key]?.zh || B.BUFF_SKILLS[x.key]?.name || AIL_ZH[x.key];
  return own || (STATES.text[x.e] || [])[0]?.replace(/\s*\([^)]*\)\s*$/, '') || x.key;
}
function stateIcons() {
  const box = $('alloc').querySelector('.states');
  if (!box || !allocOn || !run) return;
  const t = W.t, list = allocOn.dead == null ? statesOn(allocOn, t) : [];
  const ids = list.map(x => x.e).join();
  const row = box.querySelector('.strow'), cap = box.querySelector('.stcap');
  if (ids !== stShown) {
    const rows = row.offsetHeight;
    stShown = ids;
    row.innerHTML = list.map(x => `<button class="st${x.key === stPick ? ' on' : ''}" data-st="${x.key}" aria-label="${esc(stateName(x))}">` +
      `<img class="bg" src="../assets/png/state/${x.e}.png" alt=""><img src="../assets/png/state/${x.e}.png" alt=""></button>`).join('');
    for (const b of row.querySelectorAll('[data-st]')) b.onclick = () => { stPick = stPick === b.dataset.st ? null : b.dataset.st; stShown = null; stateIcons(); };
    if (row.offsetHeight !== rows) frame();  // (a row more or less: the camera framed again)
  }
  list.forEach((x, k) => {
    const left = x.until - t, all = x.until - x.start;
    row.children[k].style.setProperty('--left', isFinite(x.until) && all > 0 ? `${Math.max(0, Math.min(1, left / all)) * 100}%` : '100%');
  });
  const on = list.find(x => x.key === stPick);
  cap.hidden = !on;
  if (on) {
    const html = `<b>${esc(stateName(on))}</b>${isFinite(on.until) ? `　剩 ${Math.ceil((on.until - t) / 1000)} 秒` : ''}` +
      (STATES.text[on.e] || []).slice(1).map(l => `<div>${esc(l)}</div>`).join('');
    if (cap.innerHTML !== html) cap.innerHTML = html;
  }
}
// A party as it stood as its last map began (G.chars: kept then), whole: what 過往紀錄 brings back to town read-only
// (viewRecord) and, by request, what a PVP fight will take it from later. v: its shape's version.
const snapOf = s => ({ v: 1, chars: structuredClone(s.chars), bag: structuredClone(s.fight?.bag || s.bag || {}), zeny: s.fight?.zeny ?? s.zeny,
  hats: [...s.hats || []], cards: [...s.cards || []], town: s.town || null, chain: s.chain, off: s.off || 0, level: s.level, hard: !!s.hard, maps: s.maps || 0, started: s.started });
function gameOver() {
  const plan = run.plan;
  const rec = { at: Date.now(), started: G.started, level: noOf(G), chain: G.chain, hard: !!plan.hard, maps: G.maps || 0, map: plan.theme.label,
    party: W.chars.map(c => ({ job: c.look.job, blv: c.blv, name: c.name, sex: c.look.sex, hair: c.look.hair, hdye: c.look.hdye })), zeny: G.zeny, snap: snapOf(G) };
  store.set(HIST_KEY, [rec, ...(store.get(HIST_KEY) || [])].slice(0, 100));
  store.del(saveKey(G.id));
  if (!plan.train) wiped = { start: run.start, rec, save: structuredClone(G) };  // (設定's Debug 回城鎮繼續 can take it back: reviveTown; G is let go below)
  $('result').innerHTML = win('全滅', `<div class="head bad">全滅了…</div><p>${esc(chainName(rec.chain))}・第 ${rec.level} 關${rec.hard ? '（困難）' : ''}・${esc(rec.map)}</p>` +
    `<p class="muted">過了 ${rec.maps} 關。隊伍：${esc(partyText(rec.party))}</p>` +
    `<h4>戰後報告</h4><div>倒在第 ${Math.max(1, run.map.wave + 1)}/${plan.waves.length} 波${run.T ? `（開打 ${Math.round(run.T)} 秒）` : ''}</div>${bagReport(run.start.bag, W.used, W.bag)}` +
    `<p>這次的冒險結束了，只能重新開始。</p>`,
    // (by request, two ways on: 重播, the fight watched again with its timeline at the screen's foot and the window
    // put away meanwhile, or 回標題, the title)
    `${rb('重播', 'id="r-replay"')}<span class="grow"></span>${rb('回標題', 'id="r-go"')}`, 'dlg');
  // (by request, asked first: the 全滅 screen and its replay are gone once left)
  $('r-go').onclick = () => { if (confirm('回標題？離開後就不能再看這場的重播。')) title(); };
  armReplay();
  $('r-replay').onclick = startReplay;
  G = null;
  show('s-result');
}
// the fight over (gameOver, 對戰's pvpOver): watched again (seekFight) with the timeline at the screen's foot
// (startReplay: from a button on the result's window, put away meanwhile; 結束 brings it back)
function startReplay() {
  $('s-result').hidden = true;
  $('replaybar').hidden = false;
  seekFight(0);
  run.replay.playing = true;
  clock.last = performance.now();
}
function armReplay() {
  run.replay = { dur: run.end, playing: false };
  $('rp-seek').max = run.end;
  $('rp-seek').step = sim.TICK;
  // 結束: the replay put away, the result's window again
  $('rp-end').onclick = () => { run.replay.playing = false; $('replaybar').hidden = true; $('s-result').hidden = false; };
  // (by request: the replay slowed to 50% or 25% of 選項's speed, a tap going on to the next; kept for later replays)
  $('rp-rate').onclick = () => { replayRate = REPLAY_RATES[(REPLAY_RATES.indexOf(replayRate) + 1) % REPLAY_RATES.length]; replayShown(); };
  $('rp-play').onclick = () => {
    const r = run.replay;
    if (!r.playing && run.simT >= r.dur) seekFight(0);
    r.playing = !r.playing;
    clock.last = performance.now();
  };
  let seekTo = null;  // (a drag seeks once a frame, to where it is then)
  $('rp-seek').oninput = e => {
    if (seekTo == null) requestAnimationFrame(() => { const to = seekTo; seekTo = null; seekFight(to); });
    seekTo = +e.target.value;
  };
}

// ---------- 對戰 (by request) ----------
// At the map ahead, by 野外 (the chain's map), 對戰: PVP_TEAMS rival teams to pick from, made as recruits are
// (newRecruit: first jobs, the same one twice or more in a team too (by request), as many as the party, at the leader's base level), each with cards
// by chance, about as many as the maps to the party's level would have brought (rivalCards), put on whom they suit
// best (giveCards). Kept in G.pvp till one is fought (or the leader's level changes). One picked and 開戰: the party
// teleports off as to a map, onto one of the chain's maps by chance, the rival team teleporting in across the floor
// facing it (sim.js W.rivals, on their own 自動, bag and zeny), the two fighting it out. No game over: 結算 and 統計
// as after a map, 重播, and back to the same town; nothing gained nor lost (the bag and zeny as they set off).
const PVP_TEAMS = 3, PVP_MAX = 180000;  // (ms: a fight on longer is judged by the share of HP each side has left)
const pvpKey = () => JSON.stringify([W.chars.length, W.chars[0].blv, W.chars[0].jlv]);
function pvpTeams() {
  if (G.pvp?.key === pvpKey()) return G.pvp.teams;
  G.pvp = { key: pvpKey(), teams: Array.from({ length: PVP_TEAMS }, () => rivalTeam(W.chars.length, W.chars[0])) };
  put();
  return G.pvp.teams;
}
// n characters, as recruits at character lead's level (recruitChar), with their cards on → as kept (savedOf)
function rivalTeam(n, lead) {
  const chars = Array.from({ length: n }, () => recruitChar(newRecruit(anyOf(FIRST_JOBS), lead), lead));
  giveCards(chars, rivalCards());
  return chars.map(savedOf);
}
// a rival team's cards: one a map passed (the party gets one after each), ×0.6–1.4 by chance; an MVP's for half the
// BOSS maps passed, by chance (one is offered on each)
function rivalCards() {
  const all = cardPool(), pool = all.filter(x => !x.mvp), mvps = all.filter(x => x.mvp);
  const maps = Math.max(0, noOf(G) - 1), n = Math.round(maps * (0.6 + Math.random() * 0.8));
  const bosses = chain.maps.filter(m => m.level < G.level && L.chainPlan(m).phase.name === 'BOSS').length;
  const out = [];
  for (let k = 0; k < bosses && out.length < n; k++) if (mvps.length && Math.random() < 0.5) out.push(anyOf(mvps).id);
  while (out.length < n && pool.length) out.push(anyOf(pool).id);
  return out;
}
// What a card does, roughly (by its bonuses: cards.js activeCalls on the character), and what each kind of character
// wants of it: a melee fighter hitting harder, an archer (or a bard, a dancer) shooting, a caster its spells, a healer
// its heals, and everyone a little of not being hurt. Each card goes to whom it suits best, less so the more cards
// one has already (as even as it fairly can); one nobody gets anything of is left out.
const CARD_KIND = [
  ['econ', /^b(AddMonsterDrop|ExpAdd|GetZeny|AddGetZeny)/],
  ['def', /^b(Vit|Def|Mdef|MaxHP|HPrecov|HPRegen|Sub|MagicSub|Flee|ResEff|NearAtkDef|LongAtkDef|NoKnockback|Unbreakable|AbsorbDmg|\w*DamageReturn|NoMagicDamage|AutoSpellWhenHit|AddEffWhenHit|DefEle|RestartFullRecover|AddItem)/],
  ['heal', /^bHealPower/],
  ['magic', /^b(Int|Matk|Magic|VariableCastrate|FixedCastrate|MaxSP|SPrecov|SPRegen|NoCastCancel|UseSPrate|SkillUseSP|NoGemStone)/],
  ['range', /^b(Dex|LongAtk|CriticalLong)/],
  ['phys', /^b/]];
const ROLE_WANTS = {
  melee: { phys: 3, def: 1.5, range: 0.3, magic: 0.2, heal: 0, econ: 0.3 },
  range: { range: 3, phys: 2, def: 1, magic: 0.2, heal: 0, econ: 0.3 },
  magic: { magic: 3, range: 1, def: 1, phys: 0.1, heal: 0.5, econ: 0.3 },
  heal: { heal: 3, magic: 2, def: 1.5, range: 0.5, phys: 0.1, econ: 0.3 } };
const RANGED = new Set(['Bow', 'Musical', 'Whip']);
function roleOf(c) {
  const s = c.stats;
  if (RANGED.has(c.pc?.weapon) || (s.dex > s.str && s.dex >= s.int)) return 'range';
  if (s.int > Math.max(s.str, s.dex)) return c.levels.AL_HEAL ? 'heal' : 'magic';
  return 'melee';
}
function cardSuits(x, c) {
  const kinds = new Set(activeCalls(x, sim.cardWho(c)).map(k => k.call === 'autobonus2' ? 'def' : k.call === 'autobonus' ? 'phys'
    : (CARD_KIND.find(([, re]) => re.test(String(k.args[0]))) || ['phys'])[0]));
  const want = ROLE_WANTS[roleOf(c)], ws = [...kinds].map(k => want[k] ?? 0.3);
  return ws.length ? Math.max(...ws) + 0.2 * (ws.length - 1) : 0;
}
function giveCards(chars, ids) {
  for (const id of ids) {
    const x = sim.cardOf(id);
    if (!x) continue;
    let best = null, top = 0;
    for (const c of chars) {
      const k = cardSuits(x, c) / (1 + 0.3 * (c.cards?.length || 0)) * (0.9 + Math.random() * 0.2);
      if (k > top) { top = k; best = c; }
    }
    if (best) { (best.cards ??= []).push(+id); sim.calc(best); }
  }
}
// the 對戰 tab's list: the teams, each its heads with job and level and how many cards it has; one tapped picked
let pvpPick = 0;
function drawPvp() {
  const el = $('p-pvp');
  if (!el) return;
  const teams = pvpTeams();
  pvpPick = Math.max(0, Math.min(pvpPick, teams.length - 1));
  el.innerHTML = `<div class="muted small pvpnote">挑一支隊伍對打，等級和隊伍一樣。輸了不會結束遊戲；不會得到經驗、金錢或卡片，用掉的道具也會還回來。</div>` +
    teams.map((t, i) => `<div class="save pvpteam${i === pvpPick ? ' on' : ''}" data-v="${i}">` +
      `<div class="where">隊伍 ${i + 1}<small>卡片 ${t.reduce((n, c) => n + (c.cards?.length || 0), 0)} 張</small></div>` +
      `<div class="who">${t.map(c => `<span><canvas width="80" height="80"></canvas><small>${esc(jobName(c.job, c.sex))} Lv ${c.blv}</small></span>`).join('')}</div></div>`).join('');
  const cards = el.querySelectorAll('.pvpteam');
  teams.forEach((t, i) => t.forEach((c, j) => {
    const look = { sex: c.sex, job: c.job, weapon: '', hair: c.hair ?? null, hdye: c.hdye ?? null, id: `pvp${i}-${j}` };
    const cv = cards[i].querySelectorAll('canvas')[j];
    LOOK.loadLook(look, () => LOOK.drawPortrait(cv, look.ch || {}));
  }));
  for (const b of cards) b.onclick = () => { pvpPick = +b.dataset.v; for (const x of cards) x.classList.toggle('on', x === b); };
}
// 開戰: the team picked, a map of the chain's by chance (a floor of it by chance), the dice: kept in G.fight, so a
// page loaded again fights the same (startFight)
function pvpFight() {
  const team = pvpTeams()[pvpPick], m = anyOf(chain.maps);
  const plan = { pvp: true, theme: { id: 'pvp', map: m.map, label: m.label, level: m.level }, phase: { name: '對戰' }, waves: [], lull: 1, drop: 1,
    floor: L.floorOf(m.map) };
  G.fight = { seed: R.newSeed(), bag: structuredClone(G.bag), zeny: G.zeny, pvp: { plan, rivals: { chars: team, bag: structuredClone(G.bag), zeny: G.zeny } } };
  G.pvp = null;  // (other teams next time)
  put();
}
// a 對戰 going on (as fight.js MapRun, for tick and hud): 'rest' till the party is in (next), then 'fight' till
// either side is all down ('done': the party won; 'wiped': it lost, both down at once too), or PVP_MAX has gone by
// (timeUp: the side with more of its HP left wins)
class PvpRun {
  constructor() { Object.assign(this, { wave: 0, mobs: [], state: 'rest', next: 0, timeUp: false }); W.drop = 1; }
  get over() { return this.state === 'done' || this.state === 'wiped'; }
  step(t) {
    if (this.state === 'rest' && t >= this.next) this.state = 'fight';
    if (this.state !== 'fight') return;
    const down = xs => xs.every(c => c.dead != null), hp = xs => xs.reduce((n, c) => n + (c.dead == null ? c.hp : 0), 0) / Math.max(1, xs.reduce((n, c) => n + c.pc.maxHp, 0));
    if (down(W.chars)) this.state = 'wiped';
    else if (down(W.rivals)) this.state = 'done';
    else if (t - this.next >= PVP_MAX) { this.timeUp = true; this.state = hp(W.chars) >= hp(W.rivals) ? 'done' : 'wiped'; }
  }
}
// 對戰 over: won or lost, 結算 and 統計 (both teams'), 重播 and 回城鎮 (the same town, the bag and zeny as they set off)
function pvpOver() {
  allocClose?.();
  const won = run.map.state === 'done', plan = run.plan, T = run.T, start = run.start, used = { ...W.used }, left = { ...W.bag };
  G.fight = null;
  G.bag = structuredClone(start.bag); G.zeny = start.zeny;
  put();
  const alive = xs => xs.filter(c => c.dead == null).length, all = [...W.chars, ...W.rivals];
  const sumHtml = `<div class="head ${won ? 'good' : 'bad'}">${won ? '勝利！' : '落敗…'}</div>` +
    `<div class="muted">對戰・${esc(plan.theme.label)}・${Math.round(T)} 秒${run.map.timeUp ? '・時間到，比剩下的 HP' : ''}</div>` +
    `<div class="two"><div><h4>雙方</h4><div>我方剩 ${alive(W.chars)}/${W.chars.length} 人，對手剩 ${alive(W.rivals)}/${W.rivals.length} 人</div>` +
    `<h4>對手</h4><div>${esc(partyText(W.rivals))}</div><div class="muted small">卡片共 ${W.rivals.reduce((n, c) => n + (c.cards?.length || 0), 0)} 張</div></div>` +
    `<div><h4>戰後報告</h4>${bagReport(start.bag, used, left)}` + (downs(W.chars) ? `<div>倒下 ${downs(W.chars)} 次</div>` : '') +
    `<div class="muted small">對戰不會得到經驗、金錢或卡片，用掉的道具已經還回來。</div></div></div>`;
  const statHtml = tallyHtml(T, all, W.chars.length);
  armReplay();
  const draw = () => {
    $('result').innerHTML = `<div class="resinfo">${win('對戰結算', resTab === 'stat' ? statHtml : sumHtml,
      `${rb('重播', 'id="r-replay"')}<span class="grow"></span>${rb('回城鎮', 'id="r-go"')}`, 'dlg wide')}` +
      `<nav class="tabs">${RESULT_TABS.map(([k, label]) => rb(label, `data-rtab="${k}"`, k === resTab)).join('')}</nav></div>`;
    for (const b of $('result').querySelectorAll('[data-rtab]')) b.onclick = () => { resTab = b.dataset.rtab; draw(); };
    $('result').querySelectorAll('.tally th canvas').forEach((cv, i) => LOOK.drawPortrait(cv, all[i].look.ch || {}));
    $('r-replay').onclick = startReplay;
    // (the clock going on again, so that they teleport off: run.replay held it)
    $('r-go').onclick = () => { run.replay = null; clock.t = run.simT; clock.last = performance.now(); goTown(); };
  };
  draw();
  show('s-result');
  A.setView(0, 0.5);
}
const REPLAY_RATES = [1, 0.5, 0.25];
let replayRate = 1;
const mmss = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`;
function replayShown() {
  const r = run.replay, seek = $('rp-seek');
  if (!seek) return;
  if (document.activeElement !== seek) seek.value = run.simT;
  $('rp-play').textContent = r.playing ? '❚❚' : '▶';
  $('rp-rate').textContent = `${replayRate * 100}%`;
  $('rp-time').textContent = `${mmss(Math.min(run.simT, r.dur))} / ${mmss(r.dur)}`;
}
// 過往紀錄 (by request, as 繼續遊戲's list): a card a party lost, the last first: when it ended, the chain and map it
// fell at, its three heads with each one's job and level. One tapped is brought back to town read-only (viewRecord);
// a record from before the party was kept whole (no snap) only listed.
const recDay = ms => new Date(ms).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
const recWhere = r => `${r.chain ? esc(chainName(r.chain)) + '・' : ''}第 ${r.level} 關${r.hard ? '（困難）' : ''}`;
function showHistory() {
  const list = store.get(HIST_KEY) || [];
  const who = r => r.snap?.chars || r.party || [];
  $('hist').innerHTML = win('過往紀錄', list.length ? list.map((r, i) => `<div class="save${r.snap ? '' : ' old'}" data-i="${i}">` +
    `<div class="when"><span>${recDay(r.at)}</span>${r.snap ? '' : '<span>舊紀錄・不能載入</span>'}</div>` +
    `<div class="where">${recWhere(r)}<small>${esc(r.map || '')}</small></div>` +
    `<div class="who">${who(r).map(c => `<span><canvas width="80" height="80"></canvas><small>${esc(jobLabel(c.job))} Lv ${c.blv}</small></span>`).join('')}</div></div>`).join('')
    : '<p class="muted">還沒有紀錄。</p>', rb('回標題', 'id="h-back"'), 'dlg savedlg', true);
  // (the heads as their sprites come in, as pickSave's; a record from before sex and hair were kept: a boy, the
  // job's own hair)
  const cards = $('hist').querySelectorAll('.save');
  list.forEach((r, i) => who(r).forEach((c, j) => {
    const look = { sex: c.sex || '남', job: c.job, weapon: '', hair: c.hair ?? null, hdye: c.hdye ?? null, id: `hist${i}-${j}` };
    const cv = cards[i].querySelectorAll('canvas')[j];
    LOOK.loadLook(look, () => LOOK.drawPortrait(cv, look.ch || {}));
  }));
  for (const el of cards) if (!el.classList.contains('old')) el.onclick = () => viewRecord(list[+el.dataset.i]);
  $('h-back').onclick = title;
  $('hist').querySelector('.x').onclick = title;
  show('s-hist');
}
// A record's party back in town as it stood as its last map began (by request, read-only, ahead of PVP: a party kept
// to fight later): each one tapped opens its status, skills, gear, cards and 行動 as at the map ahead, nothing to
// change there (G.view: allocate), no map to set off for, no shop, no recruits; nothing of it saved (put). Its one
// window, the record's, put away while a character's is open; 回紀錄 back to the list.
async function viewRecord(r) {
  if (!r?.snap) return;
  unload();
  G = { ...structuredClone(r.snap), id: 'view:' + r.at, view: true, recruits: null, plan: null, fight: null, train: null };
  const id = ++prepId;
  loadingScreen(true);
  bringParty();
  show('s-prep');
  const box = $('prep');
  box.innerHTML = '';
  await waitReady();
  loadingScreen(0.5);
  await enterTown();
  if (id !== prepId) return;
  W.chars.forEach(c => stage.arrive(c, Infinity));  // (unseen till the loading screen goes)
  playBgm(G.town ? G.town.map : null);
  box.innerHTML = `<main class="panes" data-tab="view">${win('過往紀錄',
    `<div class="recview"><div class="where">${recWhere(r)}・${esc(r.map || '')}</div>` +
    `<div class="muted small">${recDay(r.at)} 全滅・過了 ${r.maps || 0} 關・${(r.snap.zeny || 0).toLocaleString()} z</div>` +
    `<div class="muted small">點角色看素質、技能、裝備、卡片（唯讀）</div></div>`,
    `<span class="tag">唯讀</span><span class="grow"></span>${rb('回紀錄', 'id="v-hist"')}`, 'pane', false, 'data-pane="view"')}</main>`;
  setTab = k => { box.querySelector('.panes').dataset.tab = k || ''; frame(); };
  prepTab = null;
  prepChanged = () => { if ($('s-alloc').hidden) setTab('view'); };  // (a character's window closed: the record's again)
  $('v-hist').onclick = () => { title(); showHistory(); };
  frame();
  loadingScreen(false);
  teleportIn(200, -1);
}

// ---------- 設定 ----------
// Opened from the ⚙ in the top right corner, there on every screen (the fight goes on under it). Remembered in
// SET_KEY: res, the arena's resolution (arena.js setResolution: 1, 0.5 or 0.25 of the screen's), full, full screen,
// odds, the map ahead's 難度 shown (by request, to try playing without it),
// and the volumes, 0–1: bgm the music's, sfx the sounds', played at vol(): squared (by request: the ear hears the
// gain's ratios, so on a straight line only the slider's bottom was heard to change), up to VOL_MAX (the viewer's
// sliders' top: by request there, louder is too loud). vol: 2, the volumes kept squared (those saved before, on a
// straight line, are made so: the same loudness). A browser goes full screen only on a tap or key, so with full on it does on the next one
// (the page loaded again); leaving it by the browser's own way (Esc) turns full off.
const VOL_MAX = 0.2, vol = v => v * v * VOL_MAX;
const settings = (old => ({ res: 1, speed: 1, full: false, odds: true, bgm: Math.SQRT1_2, sfx: Math.SQRT1_2, ...old, vol: 2,
  ...old && old.vol !== 2 && { bgm: Math.sqrt(old.bgm ?? 0.5), sfx: Math.sqrt(old.sfx ?? 0.5) } }))(store.get(SET_KEY));
// 選項 › 版本 (by request): the deployed commit's time and hash, game/version.json (scripts/deploy.py writes it; none locally)
let version = null;
fetch(new URL('version.json', import.meta.url), { cache: 'no-cache' }).then(r => r.ok ? r.json() : null)
  .then(v => { if (v && v.hash) version = v; }).catch(() => {});
const RES = [[1, '1x'], [0.5, '0.5x'], [0.25, '0.25x']], SPEED = [[1, '1×'], [2, '2×'], [4, '4×']];
function settingsInit() {
  A.setResolution(settings.res);
  $('setbtn').onclick = () => showSettings($('s-set').hidden);
  const goFull = () => { if (settings.full && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {}); };
  document.addEventListener('click', goFull, { capture: true });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && settings.full) { settings.full = false; store.set(SET_KEY, settings); }
    if (!$('s-set').hidden) showSettings(true);
  });
}
// (open, by request, the rest of the screen's windows put away and the fight paused, until it is closed)
function showSettings(open) {
  $('s-set').hidden = !open;
  document.body.classList.toggle('setting', open);
  clock.paused = open;
  if (!open) return;
  const seg = (k, opts) => `<span class="seg">${opts.map(([v, label]) => rb(label, `data-set="${k}" data-v="${v}"`, settings[k] === v)).join('')}</span>`;
  $('set').innerHTML = win('選項', `<div class="opt"><span class="k">BGM</span><input type="range" data-vol="bgm" min="0" max="1" step="0.01" value="${settings.bgm}"></div>` +
    `<div class="opt"><span class="k">Effect</span><input type="range" data-vol="sfx" min="0" max="1" step="0.01" value="${settings.sfx}"></div>` +
    `<div class="opt"><span class="k">解析度</span>${seg('res', RES)}</div><div class="muted small" style="margin:-4px 0 4px 56px">場地畫的解析度；低一點比較順</div>` +
    `<div class="opt"><span class="k">速度</span>${seg('speed', SPEED)}</div>` +
    `<div class="opt"><span class="k">全螢幕</span>${seg('full', [[true, '開'], [false, '關']])}</div>` +
    `<div class="opt"><span class="k">難度</span>${seg('odds', [[true, '顯示'], [false, '不顯示']])}</div>` +
    `<div class="opt"><span class="k">離線</span><div id="set-off"></div></div>` +
    `<div class="opt"><span class="k">素材</span><div id="set-assets"></div></div>` +
    (version ? `<div class="opt"><span class="k">版本</span><span class="muted small">${esc(version.date)} · ${esc(version.hash)}</span></div>` : '') + debugHtml(),
    // (回標題 here, by request, wherever the game is but the title itself)
    ($('s-title').hidden || $('s-title').classList.contains('back') ? rb('回標題', 'id="set-title"') + '<span class="grow"></span>' : '') + rb('關閉', 'id="set-close"'), 'dlg', true);
  $('set').querySelector('.x').onclick = () => showSettings(false);
  $('set').querySelector('.win').style.width = '300px';
  for (const b of $('set').querySelectorAll('[data-set]')) b.onclick = () => {
    const k = b.dataset.set, v = k === 'full' || k === 'odds' ? b.dataset.v === 'true' : +b.dataset.v;
    settings[k] = v;
    store.set(SET_KEY, settings);
    if (k === 'res') A.setResolution(v);
    if (k === 'odds') prepChanged?.();  // (the map ahead's 難度 shown or put away at once)
    if (k === 'full') v ? document.documentElement.requestFullscreen?.().catch(() => {}) : document.fullscreenElement && document.exitFullscreen();
    showSettings(true);
  };
  for (const el of $('set').querySelectorAll('[data-vol]')) {
    el.oninput = () => { settings[el.dataset.vol] = +el.value; if (el.dataset.vol === 'bgm') playBgm(); };
    el.onchange = () => { store.set(SET_KEY, settings); if (el.dataset.vol === 'sfx') LOOK.playSound('_hit_sword.wav'); };  // (a sound to hear it by)
  }
  offlineShown();
  assetsShown();
  debugInit();
  $('set-close').onclick = () => showSettings(false);
  if ($('set-title')) $('set-title').onclick = () => { showSettings(false); title(); };
}

// ---------- debug ----------
// (by request, to try changing jobs without the maps before) at the map ahead, 設定's Debug: 跳到 第 n 關 (one after
// the map ahead on), each of the party levelled up as the maps between would have (a base and a job level a map; a
// recruit changing jobs on the way at its changeAt), its new points spent by its builds (the leader's by its job's
// first ones, the builds left 自訂: with 主角配點 自動, else left to spend); 重抽招募, recruits anew for the map ahead;
// 加錢, zeny added; and 換關卡鏈 (switchChain)
let debugAuto = true;
const atPrep = () => !!(G && !G.train && !G.view && !run && prepChanged && !$('s-prep').hidden);
const debugHtml = () => canRevive() ? `<div class="opt"><span class="k">Debug</span>${rb('回城鎮繼續', 'id="dbg-revive"')}</div>` : !atPrep() ? '' :
  `<div class="opt"><span class="k">Debug</span><span>跳到第 <input type="number" id="dbg-n" min="${noOf(G) + 1}" value="${Math.max(noOf(G) + 1, 40)}" style="width:4em"> 關 ${rb('跳', 'id="dbg-go"')}</span></div>` +
  `<div class="opt"><span class="k"></span><span class="seg">${rb('主角自動配點', 'data-dbg="1"', debugAuto)}${rb('自己配', 'data-dbg="0"', !debugAuto)}</span></div>` +
  `<div class="opt"><span class="k"></span>${rb('重抽招募', 'id="dbg-rec"')}</div>` +
  `<div class="opt"><span class="k"></span><span>加錢 <input type="number" id="dbg-z" min="1" value="10000" style="width:6em"> z ${rb('加', 'id="dbg-zgo"')}</span></div>` +
  `<div class="opt"><span class="k"></span><span>換關卡鏈 <select class="rs" id="dbg-chain">${chains.map(x => `<option value="${esc(x.file)}"${x.file === G.chain ? ' selected' : ''}>${esc(chainName(x.file))}</option>`).join('')}</select> ${rb('換', 'id="dbg-chgo"')}</span></div>`;
function debugInit() {
  if ($('dbg-revive')) $('dbg-revive').onclick = () => { showSettings(false); if (canRevive()) reviveTown(); };
  if (!$('dbg-go')) return;
  for (const b of $('set').querySelectorAll('[data-dbg]')) b.onclick = () => { debugAuto = b.dataset.dbg === '1'; showSettings(true); };
  $('dbg-go').onclick = () => { const n = Math.trunc(+$('dbg-n').value); if (n > noOf(G)) { showSettings(false); jumpTo(n); } };
  $('dbg-chgo').onclick = () => { const f = $('dbg-chain').value; if (f && f !== G.chain) { showSettings(false); switchChain(f); } };
  // (by request) 加錢: zeny added to the party's, the map ahead drawn again (its shop with it)
  $('dbg-zgo').onclick = () => { const z = Math.trunc(+$('dbg-z').value); if (z > 0) { G.zeny += z; put(); showSettings(false); prep(); } };
  $('dbg-rec').onclick = () => { showSettings(false); endRecruit(); G.recruits = makeRecruits(); recCame = false; recGone = []; put(); prepTab = null; prep(); };
}
// (by request) 換關卡鏈: the game goes on through chain `file` from the party's level as it is (the maps are by base
// level), numbered as that chain numbers them (G.off: its first map 第 1 關); the map ahead planned anew, normal
async function switchChain(file) {
  allocClose?.(); endRecruit();
  await useChain(file);
  G.chain = file; G.off = chainStart(chain).blv - 1;
  G.plan = null; G.hard = false;
  keep();
  prepTab = null;
  prep();
}
function jumpTo(n) {
  const d = n - noOf(G);
  allocClose?.(); endRecruit();
  W.chars.forEach((c, i) => {
    const jj = sim.jobFor(c), two = jj.tier >= 2;
    const p = (two ? (c.firstJlv || 50) - 1 : 0) + c.jlv - 1 + d;  // (job levels from job 1)
    c.blv = Math.min(jj.maxBase, c.blv + d); c.bexp = 0; c.jexp = 0;
    if (!two && c.second && c.changeAt && p + 1 >= c.changeAt) {
      c.jlv = c.changeAt;
      if (i) sim.autoSkills(c);
      changeTo(c, c.second);
      c.jlv = Math.min(50, p - c.changeAt + 2);
    } else c.jlv = Math.min(jj.maxJob, two ? p - (c.firstJlv || 50) + 2 : p + 1);
    if (i) { sim.refitStats(c); sim.autoSkills(c); }
    else if (debugAuto) {
      const { build, skillBuild } = c;
      c.build = sim.defaultBuild(c.look.job); c.skillBuild = sim.defaultSkillBuild(c.look.job);
      sim.autoStats(c); sim.autoSkills(c);
      c.build = build; c.skillBuild = skillBuild;
    }
    sim.calc(c);
  });
  G.level += d; G.plan = null; G.hard = false;
  G.base = leaderBase();
  keep();
  prepTab = null;
  prep();
}

// ---------- music ----------
// the map's music (viewer/bgm.json, as the viewer plays it; name: a map's, or an .mp3's path), at the BGM setting.
// Played through Web Audio, the file decoded and looped (gapless) through a gain (by request: iOS does not let a
// page set an <audio>'s volume, so the slider did nothing but at 0), on a context of its own made on a tap (iOS lets
// one start only within a click / touchend) and closed as the page goes into the background (one back from there
// may play nothing on iOS: look.js); the file is fetched whole, no range requests, so sw.js keeps it for offline play.
// Put away (the page in the background, the BGM slider at 0), the track remembers where it was and goes on from
// there when it plays again (by request, not from its start): music.paused { path, at (s into it) }.
let bgmOf = null, bgmName = null;
// {map: its music} (viewer/bgm.json: scripts/map2gltf.py), once loaded
const bgmTable = () => bgmOf ??= fetch('../viewer/bgm.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
const music = { ctx: null, gain: null, src: null, path: null, buf: null, t0: 0, paused: null };
function musicCtx() {
  const m = music;
  if (!m.ctx || m.ctx.state === 'closed') {
    m.ctx = new (window.AudioContext || window.webkitAudioContext)();
    m.gain = m.ctx.createGain();
    m.gain.connect(m.ctx.destination);
    m.src = null;
  }
  if (m.ctx.state !== 'running') m.ctx.resume().catch(() => {});
}
function stopMusic() {
  if (music.src) { try { music.src.stop(); } catch (e) {} music.src = null; }
}
// the music stopped where it is, to go on from there (see above)
function pauseMusic() {
  const m = music;
  if (m.src && m.buf && m.ctx) m.paused = { path: m.path, at: (m.ctx.currentTime - m.t0) % m.buf.duration };
  stopMusic();
}
async function playBgm(name = bgmName) {
  bgmName = name;
  const p = name && (/\.mp3$/.test(name) ? name : (await bgmTable())[name]), m = music, v = vol(settings.bgm);
  if (m.gain) m.gain.gain.value = v;
  if (!p) { stopMusic(); return; }
  if (!v || document.hidden) { pauseMusic(); return; }
  if (p !== m.path) {  // (the track before stops at once; this one plays once decoded)
    stopMusic();
    Object.assign(m, { path: p, buf: null });
    const buf = await fetch(LOOK.url(p)).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status))
      .then(b => new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 44100).decodeAudioData(b)).catch(() => null);
    if (m.path !== p) return;  // (another asked for meanwhile)
    m.buf = buf;
  }
  if (!m.buf || !m.ctx || m.ctx.state === 'closed' || m.src || !vol(settings.bgm) || document.hidden) return;
  m.src = m.ctx.createBufferSource();
  m.src.buffer = m.buf;
  m.src.loop = true;
  m.src.connect(m.gain);
  const at = m.paused && m.paused.path === p ? m.paused.at : 0;  // (a track put away goes on; another starts over)
  m.paused = null;
  m.src.start(0, at);
  m.t0 = m.ctx.currentTime - at;
}
for (const ev of ['click', 'touchend', 'keydown'])
  document.addEventListener(ev, () => { if (bgmName && vol(settings.bgm)) { musicCtx(); playBgm(); } }, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && music.ctx) { pauseMusic(); music.ctx.close().catch(() => {}); music.ctx = null; }
  playBgm();  // (back: on the next tap, which makes the context anew)
});

// ---------- offline ----------
// sw.js (the game's own, apart from the viewer's) keeps the game and what it loads. Service workers need https
// (serve.sh's port 8443) or localhost; on localhost, this Mac itself, it stays off (sprites rebuilt here should show
// at once) unless localStorage ro-sw is '1', for testing, as in the viewer. Once it is on, all that every level chain
// (chains.json's, all their maps) can show is saved in the background, its progress under 選項 › 離線 (by request): the six first jobs'
// bodies and weapons, every hairstyle in every colour, the chain's monsters (and what they summon or turn into),
// their floors (and the textures those name) and minimaps, the drops, the effects, sounds and icons, the cards' illustrations, and the music of
// the towns, job change rooms, title and training ground (by request; not the maps', about 110 MB more). It goes through viewer/save.js (a sprite a request, serve.sh's /bundle) into sw.js's
// game-assets; what is saved already is skipped, so one cut off goes on where it stopped, and OFF_KEY remembers a
// finished one (how many there were).
const OFF_KEY = 'ro-game-offline';
const OFFLINE = { on: false, total: 0, done: 0, running: false, failed: false };
function offlineInit() {
  let test = null;
  try { test = localStorage.getItem('ro-sw'); } catch (e) {}
  OFFLINE.on = 'serviceWorker' in navigator && (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || test === '1');
  if (!OFFLINE.on) {  // (one left from testing here would keep serving saved files)
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration('./').then(r => r && r.unregister());
    return;
  }
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('service worker', err));
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();  // ask not to be evicted
}
// the game's assets (needs.js; every level chain a game can be on, chains.json's, not only the one a new game takes)
let needs = null;
function needList() {
  return needs ||= (async () => {
    const chainsAll = (await Promise.all(chains.map(c => loadChain(c.file).catch(() => null)))).filter(Boolean);
    const npcs = await fetch('../viewer/npcs.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
    return gameNeeds({ db, index: INDEX, chains: chainsAll, floors: FLOORS, npcs, bgm: await bgmTable(), sim, MOUNT: LOOK.MOUNT,
      HIT_SOUND: LOOK.HIT_SOUND, secondJobsOf, effects: E.effectNeeds(), stage: stage.stageNeeds(), states: STATES });
  })();
}
const OFF_CONTROLLED = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;  // (sw.js had the page from its start)
async function saveOffline() {
  if (!OFFLINE.on || OFFLINE.running) return;
  if (!navigator.serviceWorker.controller)  // the first visit: the worker takes the page once installed
    await new Promise(ok => navigator.serviceWorker.addEventListener('controllerchange', ok, { once: true }));
  if (ASSETS.packs.length) return;  // (the packs have them: nothing to download)
  const need = await needList();
  const sprites = need.sprites;  // folder → with its dye/ colours
  const glbs = need.files.filter(f => /^map\/arena\//.test(f)).map(f => '../assets/' + f.split('/').map(encodeURIComponent).join('/'));
  const files = need.files.filter(f => !/^map\/arena\//.test(f));
  const mark = sprites.size + ':' + files.length + ':' + glbs.length;
  if (store.get(OFF_KEY) === mark) return;
  // sw.js told it is saving (none of its NET_WAIT then), again every few seconds while it goes
  let said = 0;
  const saying = () => { if (Date.now() - said > 3000) { said = Date.now(); navigator.serviceWorker.controller?.postMessage('saving'); } };
  saying();
  // the effects first (textures, STR files and their sounds), through effects.js itself, sw.js keeping them: their
  // requests are in the queue ahead of the rest, done long before it
  import('../viewer/effects.js').then(E => Object.keys(E.EFFECTS).forEach(E.preload)).catch(() => {});
  Object.assign(OFFLINE, { running: true, failed: false, done: 0, total: glbs.length + sprites.size });
  offlineShown();
  // first the floors, through sw.js (which keeps them), each read for the textures it names (map/tex/…, by its
  // images' uris): those are saved with the rest
  const tex = new Set();
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < glbs.length && !OFFLINE.failed) {
      const u = new URL(glbs[next++], location.href);
      try {
        const r = await fetch(u);
        if (!r.ok) { OFFLINE.done++; continue; }  // (one the server does not have: passed over)
        const b = await r.arrayBuffer(), n = new DataView(b).getUint32(12, true);
        for (const im of JSON.parse(new TextDecoder().decode(new Uint8Array(b, 20, n))).images || [])
          if (im.uri) tex.add(decodeURIComponent(new URL(im.uri, u).pathname).slice(1));
      } catch (e) { OFFLINE.failed = true; }
      OFFLINE.done++;
      saying();
      offlineShown();
    }
  }));
  if (OFFLINE.failed) { OFFLINE.running = false; offlineShown(); return; }
  const worker = new Worker('../viewer/save.js'), before = glbs.length;
  worker.onmessage = ({ data: st }) => {
    Object.assign(OFFLINE, st, { done: before + st.done, total: before + st.total });
    saying();
    if (st.finished) {
      worker.terminate();
      OFFLINE.running = false;
      // (on the first visit, the effects the page loaded before sw.js had it were not kept, and effects.js does not
      // load them again: not marked done, so the next visit goes over it again, what is saved skipped, those saved)
      if (!st.failed) store.set(OFF_KEY, OFF_CONTROLLED ? mark : 'fx:' + mark);
    }
    offlineShown();
  };
  worker.postMessage({ sprites: [...sprites], files: files.concat([...tex]), wav: INDEX.wav, cache: 'game-assets' });
}
// ---------- the asset packs (issue #9: the player's own client made into packs, scripts/pack.py) ----------
// imported here (選項 › 素材, or the title's button while assets are lacking) into the browser (viewer/packs.js),
// sw.js answers /assets/ out of them. Lacking: what the game needs (needList) that no pack has, or a pack has
// from an older recipe (manifests/revs.json); with no pack, assets the server has (serve.sh: assets/) lack nothing.
// Only with sw.js (OFFLINE.on): on this computer (localhost) serve.sh hands out assets/ and packs/ itself.
const ASSETS = { packs: [], missing: 0, old: 0, server: true, busy: null, error: null };
async function assetCheck() {
  if (!OFFLINE.on || !self.Packs) return;
  const need = await needList();
  const paths = [...need.files, ...[...need.sprites.keys()].map(f => f + '/act.json')];
  const revs = await fetch('../manifests/revs.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  const st = await Packs.status(paths, revs);
  Object.assign(ASSETS, { packs: st.packs, missing: st.missing.length, old: st.old.length });
  if (st.missing.length) console.warn('素材包沒有的', st.missing.slice(0, 50));
  // (no pack: the server's, if it has them; a HEAD, past sw.js)
  if (!st.packs.length) ASSETS.server = await fetch('../assets/png/ui/logo.png', { method: 'HEAD', cache: 'no-store' }).then(r => r.ok).catch(() => false);
  assetsShown();
}
function importPacks() {
  const input = document.createElement('input');
  Object.assign(input, { type: 'file', accept: '.zip,application/zip', multiple: true });
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    ASSETS.error = null;
    ASSETS.busy = '讀取中…';
    assetsShown();
    try {
      await Packs.importPacks(files, st => { ASSETS.busy = `${st.step} ${st.file} ${Math.floor(st.at * 100)}%`; assetsShown(); });
      navigator.serviceWorker.controller?.postMessage('packs');
    } catch (e) {
      ASSETS.error = e.message || String(e);
    }
    ASSETS.busy = null;
    // (the first assets this page has: what it asked for before, failed, is asked for again)
    if (!ASSETS.error && !ASSETS.packs.length && !ASSETS.server) return location.reload();
    await assetCheck().catch(() => {});
    assetsShown();
  };
  input.click();
}
// the title's line (only while assets are lacking) and 選項 › 素材
function assetsShown() {
  const A = ASSETS, packs = A.packs, lack = !packs.length ? (A.server ? 0 : -1) : A.missing + A.old;
  const day = s => s ? s.slice(0, 10) : '';
  const what = A.busy ? `<span class="small">${esc(A.busy)}</span>`
    : A.error ? `<span class="small bad">${esc(A.error)}</span>`
    : lack < 0 ? '<span class="small">還沒有素材：匯入素材包</span>'
    : packs.length && A.missing ? `<span class="small bad">素材包缺 ${A.missing} 個檔${A.old ? `、${A.old} 個是舊版` : ''}：做一份新的再匯入</span>`
    : packs.length && A.old ? `<span class="small bad">素材包有 ${A.old} 個檔是舊版：做一份新的再匯入</span>`
    : '';
  const t = $('t-assets');
  if (t) {
    t.hidden = !OFFLINE.on || !(A.busy || A.error || lack);
    t.innerHTML = what + ' ' + (A.busy ? '' : rb('匯入素材', 'id="t-import"'));
    if ($('t-import')) $('t-import').onclick = importPacks;
  }
  const el = $('set-assets');
  if (!el) return;
  el.innerHTML = !OFFLINE.on ? '<span class="muted small">這台電腦直接從 server 讀素材（assets/、packs/）</span>'
    : (what || (packs.length ? `<span class="small">${packs.map(p => `${esc(p.name)} ${day(p.made)}${p.parts > 1 ? `（${p.part}/${p.parts}）` : ''}・${p.count} 個檔`).join('<br>')}</span>`
      : '<span class="muted small">從 server 讀</span>')) +
    (A.busy ? '' : ' ' + rb('匯入', 'id="as-import"') + (packs.length ? rb('清除', 'id="as-clear"') : ''));
  if ($('as-import')) $('as-import').onclick = importPacks;
  if ($('as-clear')) $('as-clear').onclick = async () => {
    if (!confirm('清除已匯入的素材包？')) return;
    await Packs.clear();
    navigator.serviceWorker.controller?.postMessage('packs');
    await assetCheck();
  };
}

// 選項 › 離線, as it is now
function offlineShown() {
  const el = $('set-off');
  if (!el) return;
  const O = OFFLINE, pc = O.total ? Math.floor(O.done * 100 / O.total) : 0;
  el.innerHTML = ASSETS.packs.length ? '<span class="small">用匯入的素材包（選項 › 素材）</span>'
    : !ASSETS.server ? '<span class="muted small">這個網站沒有素材：匯入素材包（選項 › 素材）就能離線玩</span>'
    : !O.on ? `<span class="muted small">${window.isSecureContext ? '這台電腦（localhost）不用離線功能' : '離線要用 https：serve.sh 印出的 https 網址'}</span>`
    : O.running ? `<div class="offbar"><i style="width:${pc}%"></i></div><span class="small">下載中 ${pc}%</span>`
    : /^fx:/.test(store.get(OFF_KEY)) ? '<span class="small">已存好，只剩特效：下次開啟時補上</span>'
    : store.get(OFF_KEY) ? `<span class="small">所有關卡的素材已存好</span> ${rb('清除', 'id="off-clear"')}`
    : O.failed ? `<span class="small bad">沒下載完（連不到 server）</span> ${rb('重試', 'id="off-go"')}`
    : '<span class="muted small">準備中…</span>';
  if ($('off-go')) $('off-go').onclick = () => saveOffline();
  if ($('off-clear')) $('off-clear').onclick = () => {
    const sw = navigator.serviceWorker.controller;
    if (!sw || !confirm('清除已存的素材？（之後會重新下載）')) return;
    store.del(OFF_KEY);
    navigator.serviceWorker.addEventListener('message', e => { if (e.data === 'cleared') saveOffline(); }, { once: true });
    sw.postMessage('clear');
    offlineShown();
  };
}

boot().catch(e => { document.body.insertAdjacentHTML('beforeend', `<p class="bad" style="position:fixed;top:10px;left:10px">載入失敗：${esc(e.message || e)}</p>`); });
