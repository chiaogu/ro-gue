// sim.js with no sandbox: a map's waves fought to the end with nothing shown, for measuring fights in bulk —
// bench/headless.mjs (Node) and mapsim.js (the map panel's worker) — and the map itself (MapRun), which the page
// goes by too. The sprite timings sim.js asks for come from the monsters' act.json (act(sprite) → it, or null),
// and a character's from c.timing, what the page worked out of its sprites (sandbox.js timingOf; without it, a
// fixed 6-frame swing): with the same dice (rng.js), a run here is the fight the page would show.
//
// A map here is waves of monster defs, as levels.js makes them. Monsters give no EXP, so no one levels up (and
// heals in full) halfway through a map.
import * as sim from './sim.js';
import * as levels from './levels.js';
import * as R from './rng.js';

const { W } = sim;

// db: jobs.json; floors: the maps' sandbox floors (levels.init); act: sprite → its act.json (synchronous: what a map needs is loaded before it is fought); emit:
// sim.js's events (sandbox.js has the list), for a run that counts them (none by default)
export function setup({ db, act, emit = () => {}, floors = {} }) {
  const actionInfo = (m, grp) => {
    const a = act(m.def.sprite), x = a && (a.actions[grp * 8] || a.actions[0]);
    if (!x) return { n: 6, delay: 100, frames: Array(6).fill({}) };
    return { n: x.frames.length, delay: Math.max(1, x.delay_ms || 100), frames: x.frames };
  };
  // (the hit frame as sandbox.js finds it)
  const motion = {
    ready: () => true,
    attackGroup: c => c.timing ? c.timing.group : 10,
    pc: (c, group) => (c.timing && c.timing.pc[group]) || { frames: 6, release: c.pc.weapon === 'Bow' ? 3 : null, hf: 4 },
    mob: (m, grp) => actionInfo(m, grp),
    mobAttack(m) {
      const { n, delay, frames } = actionInfo(m, 2), a = act(m.def.sprite);
      const sounded = frames.map((f, i) => f.sound != null && f.sound >= 0 ? i : -1).filter(i => i >= 0);
      let hf = a ? frames.findIndex(f => f.sound != null && a.sounds && a.sounds[f.sound] === 'atk') : -1;
      if (hf < 0) hf = sounded.length ? sounded[sounded.length - 1] : Math.floor(n * 0.6);
      return { n, delay, hf };
    },
  };
  sim.init({ db, motion, emit });
  levels.init({ db, floors });
}

const WAVE_MAX = 300000;  // (ms: a wave going on longer is given up on, and the map lost)

// A map going on — the page's (sandbox.js) and each of the runs here alike, so the two are the same fight: its
// waves sent in one after another, each once the one before is down (with what its monsters summoned) and
// plan.lull s have gone by, its monsters' loot dropped plan.drop times as often (levels.dropFor), each wave's monsters coming for the party at once (levels.rouse). step(t) goes after every sim.step(t). addMob(def) puts a
// monster in the fight at once (sim.addMob, and whatever is shown of it) and gives it back.
// state: 'rest' (the next wave at `next`), 'fight' (wave `wave`, its monsters `mobs`), 'loot' (the last wave down,
// the party picking up the loot on the ground: until there is none, or LOOT_MS have gone by, `next`), 'done' or
// 'wiped'.
const LOOT_MS = 30000;
export class MapRun {
  constructor(plan, addMob) { Object.assign(this, { plan, addMob, wave: -1, mobs: [], state: 'rest', next: 0 }); W.drop = plan.drop ?? 1; }
  get over() { return this.state === 'done' || this.state === 'wiped'; }
  // monster m is one of this wave's or was spawned by one (a slave, an egg's brood: sim.js `by`)
  ours(m) { return this.mobs.includes(m) || (!!m.by && this.ours(m.by)); }
  step(t) {
    if (this.state === 'fight') {
      if (W.chars.every(c => c.dead != null)) this.state = 'wiped';
      // (the wave over with its monsters down: its icicles not stepped on, sim.js ICICLES, cleared away)
      else if ([...this.mobs, ...W.mobs.filter(m => this.ours(m))].every(m => m.dead != null || !W.mobs.includes(m) || sim.isTrap(m))) {
        for (const m of this.mobs) if (sim.isTrap(m) && m.fell == null && W.mobs.includes(m)) sim.removeMob(m);
        if (this.wave < this.plan.waves.length - 1) { this.state = 'rest'; this.next = t + this.plan.lull * 1000; }
        else { this.state = 'loot'; this.next = t + LOOT_MS; }
      }
    } else if (this.state === 'loot') {
      if (W.chars.every(c => c.dead != null)) this.state = 'wiped';
      else if (!W.items.length || t >= this.next) this.state = 'done';
    } else if (this.state === 'rest' && t >= this.next) {
      this.wave++;
      this.state = 'fight';
      this.mobs = this.plan.waves[this.wave].map(def => {
        const m = this.addMob({ ...def, baseExp: 0, jobExp: 0 });
        if (!this.plan.calm) levels.rouse(m);  // (calm: left as mob_db has them, the game's training ground)
        return m;
      });
    }
  }
}

// map plan (levels.planMap's) fought by party (characters, each new: sim.newChar, calc) from dice seed, as the
// page fights it: sim.resetWorld, then sim.TICK steps →
// { waves: [{ T (s), D (HP lost), healed, taken: [HP lost per character], dealt: [damage per character] }],
//   margin, wiped (also when a wave went on past WAVE_MAX: by request, lost), timedOut (that), deaths, T (s, from the
//   first wave in to the last one down) }
export function runMap(party, plan, seed, bag = {}, zeny = 0) {
  R.seed(seed);
  sim.setFloor(plan.floor);
  sim.resetWorld(party, bag, zeny);
  const run = new MapRun(plan, def => sim.addMob(def));
  const resources = levels.meter(party), hp = c => c.dead == null ? c.hp : 0;
  const full = resources(c => c.pc.maxHp, c => c.pc.maxSp);
  let t = 0, margin = 1, done = 0, rec = null, t0 = 0, last = party.map(hp);
  const out = [];
  const end = () => {
    rec.T = (t - t0) / 1000;
    rec.dealt = party.map(c => c.dealt.filter(e => e.t > t0 && e.t <= t).reduce((n, e) => n + e.dmg, 0));
    out.push(rec);
    done = t;
    rec = null;
  };
  while (!run.over && (rec ? t - t0 < WAVE_MAX : t < run.next + WAVE_MAX)) {
    t += sim.TICK;
    sim.step(t);
    const wave = run.wave;
    run.step(t);
    // (what each character lost or got back this step: a wave's, from its first step to its last)
    party.forEach((c, i) => {
      const d = hp(c) - last[i];
      if (rec) { if (d < 0) { rec.D -= d; rec.taken[i] -= d; } else rec.healed += d; }
      last[i] = hp(c);
    });
    margin = Math.min(margin, resources(hp, c => c.sp) / full);
    if (rec && run.state !== 'fight') end();
    if (run.wave !== wave) { rec = { T: 0, D: 0, healed: 0, taken: party.map(() => 0) }; t0 = t; }
  }
  if (rec) end();
  const timedOut = !run.over, wiped = run.state === 'wiped' || timedOut;
  return { waves: out, margin: wiped ? 0 : margin, wiped, timedOut, deaths: party.filter(c => c.dead != null).length, T: done / 1000 };
}
