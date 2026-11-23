// What a fight shows (no panel, no input of its own): sim.js's fight drawn on arena.js's 3D floor — the
// characters' and monsters' sprites as they move, attack, cast and fall, the skills' effects (effects.js), the
// numbers and names rising over them, HP bars, carts, loot, the sounds — as sim.js tells of it (its events: emit,
// and the sprite timings it reads: motion). The battle sandbox (sandbox.js) and the game (game/) both show their
// fights with it; the page says what goes on in its panel through hooks (see init).
import * as sim from './sim.js';
import * as A from './arena.js';
import * as E from './effects.js';
import { Mover } from './grid.js';
import { SpriteBatch, keyed, spriteId as idOf, lookKey as chKey } from './walker.js';
const { W } = sim;

let db = null, api = null;
// what the page does as the fight changes (each optional): hp(c) a character's HP, SP or ailments, status(c) its
// status (a level, a buff), sit(c), vending(c), rule(c) (自動 follows another rule), exp(c, up, jobUp) its EXP
// or levels, afterStep(t) after every frame's steps
const NONE = () => {};
let hooks = { hp: NONE, status: NONE, sit: NONE, vending: NONE, rule: NONE, look: NONE, exp: NONE, afterStep: NONE };
let floats = [];  // numbers and text rising above units

// o: api (look.js's drawing and sounds, as index.html hands them to the sandbox: loadSprite, img, tinted, frameOf,
// drawFrame, drawHuman, humanSounds, guessedHitFrame, attackGroup, playSound, preloadSound, playHit(weapon),
// playMobHit, dataDir), db (jobs.json), canvas and overlay (the arena's: arena.js), onClick (a click on the
// arena: arena.js), hooks (above)
export function init(o) {
  ({ db, api } = o);
  hooks = { ...hooks, ...o.hooks };
  api.loadSprite('cart', CART, null, spr => { cartSpr = spr; });
  api.loadSprite('falcon', FALCON, null, spr => { falconSpr = spr; });
  api.loadSprite('orcface', 'png/effect/orcface', null, spr => { orcHead = spr; });
  E.init({ dataDir: api.dataDir, playSound: api.playSound, preloadSound: api.preloadSound });  // before the skill list preloads
  E.preload(CRIT_EFFECT);
  E.preload('EF_HIT');
  Object.values(POTION_FX).forEach(E.preload);
  ['EF_ANGEL', 'EF_DEVIL', 'EF_JOBLVUP', 'EF_STUN', 'EF_SILENCE', 'EF_BLIND', 'EF_CONFUSE', 'EF_HIDE', 'EF_UNHIDE', 'EF_EMOTE', 'EF_PNEUMA', 'EF_TELEPORT', 'EF_TELEPORT_LAND', 'EF_READYPORTAL', 'EF_PORTAL',
   'EF_TRAP_SANDMAN', 'EF_TRAP_SKID', 'EF_SANDMAN', 'EF_SKIDTRAP', 'EF_TRAP_LANDMINE', 'EF_LANDMINE', 'EF_TRAP_ANKLESNARE', 'EF_ANKLESNARE', 'EF_TRAP_SHOCKWAVE', 'EF_SHOCKWAVEHIT', 'EF_TRAP_FLASHER', 'EF_FLASHER', 'EF_TRAP_FREEZING', 'EF_FREEZING', 'EF_TRAP_BLASTMINE', 'EF_BLASTMINEBOMB', 'EF_TRAP_CLAYMORE', 'EF_CLAYMORE', 'EF_TRAP_TALKIEBOX', 'EF_FIREPILLARON', 'EF_FIREPILLAR', 'EF_VENOMDUST2', 'EF_DEMONSTRATION', 'EF_DEMONSTRATION_CELL', 'EF_THROWFIREBOTTLE', 'EF_FIREBOTTLE_LAND', 'EF_THROWPOTION1', 'EF_THROWPOTION2', 'EF_THROWPOTION3', 'EF_THROWPOTION4', 'EF_THROWPOTION5', 'EF_THROWPLANTBOTTLE', 'EF_THROWMINEBOTTLE', 'EF_BOTTLE_BREAK', 'EF_ACIDBOTTLE_HIT', 'EF_THROWITEM', 'EF_CHEMICALPROTECTION', 'EF_SUI_EXPLOSION', 'EF_SPIDERWEB', 'EF_BOTTOM_SANC', 'EF_BOTTOM_MAG', 'EF_DETECTWIND', 'EF_SPRINGTRAP'].forEach(E.preload);
  STATE_SOUNDS.forEach(api.preloadSound);
  Object.keys(E.EFFECTS).filter(n => /^EF_(BEGINSPELL|DARKCASTING|LOCKON|SPHERES)/.test(n)).forEach(E.preload);  // casts, spirit spheres
  A.init({ canvas: o.canvas, overlay: o.overlay, field: W.field, onClick: o.onClick });
}
// character c (in the fight: sim.enter) drawn on the arena
export function show(c) {
  A.show(c.w, keyed((g, group, dir, clock, same) => drawPc(c, g, group, dir, clock, same)), true);
}
// character c and what is drawn of it leave the arena
export function drop(c) {
  floats = floats.filter(f => f.w !== c.w);
  later = later.filter(e => e.w !== c.w);
  flying = flying.filter(a => a.by !== c && a.to !== c);
  A.remove(c.w);
}
// the fight from nothing (its clock back at 0, the characters in it anew: sim.resetWorld): nothing of the last
// one's effects or numbers left, the characters drawn
// (and the rival team's, come in again with them: sim.resetWorld)
export function restart(chars) {
  for (const a of tpAnim.values()) if (a.ghost) A.remove(a.ghost);
  tpAnim.clear();
  for (const c of [...chars, ...W.rivals]) show(c);
  E.stopAll(0);
  mapFx = null;
  EVENTS.reset();
}
// the effects all stopped at time t, nothing left rising over anyone
export function clear(t) {
  E.stopAll(t);
  mapFx = null;
  EVENTS.reset();
}
// The floor's own effects (its map's RSW effect objects, by request: torches, bubbles under the sea, chimney smoke,
// the ant hell's gas; arena.js floorShown, effects.js MAP_EFFECTS), going on as long as it is shown: started again
// when another floor is shown, the clock starts again, or the effects are all stopped (restart, clear)
let mapFx = null;  // { floor, t, fx: [the effects] }
function mapEffects(t) {
  const floor = A.floorShown();
  if (mapFx && mapFx.floor === floor && t >= mapFx.t) { mapFx.t = t; return; }
  if (mapFx) for (const fx of mapFx.fx) E.stop(fx, t);
  const spot = ([x, y, z]) => ({ cell: [x, -z], pos: [x, -z], heading: [0, -1], path: [], moving: false,
                                 worldPosition: out => out.set(x, y, z) });
  mapFx = { floor, t, fx: (floor ? floor.effects : []).filter(e => E.MAP_EFFECTS[e.id])
    .map(e => E.play(E.MAP_EFFECTS[e.id], spot(e.pos), t, Infinity, { silent: true })) };
}
// a frame at time t (the fight stepped up to it): what goes on after the steps, the arena and what is drawn over it
export function render(t) {
  afterStep(t);
  towCarts(t);
  flyFalcons(t);
  showLoot();
  mapEffects(t);
  E.update(t);
  // (the camera on the party standing, not the fallen: by request, issue 15; all fallen, on them all)
  const pcs = W.chars.filter(c => c.pc), up = pcs.filter(c => c.dead == null);
  A.render((up.length ? up : pcs).map(c => c.w),
    W.mobs.filter(m => m.dead == null && !m.dying && m.mss === 'attack' && m.target && m.target.isPc).map(m => m.w),
    W.chars.flatMap(c => [c.cast, c.pending]).filter(p => p && p.target && p.target.w)
      .map(p => ({ w: p.target.w, area: p.target.ground ? sim.areaOf(p.sk, p.lv) : 0 }))
      .concat(W.chars.filter(c => c.pc && c.dead == null && c.target && c.target.w).map(c => ({ w: c.target.w }))));
  const g = A.overlayContext(), at = w => { const a = A.anchor(w); g.setTransform(a.s, 0, 0, a.s, a.x, a.y); };
  for (const c of sim.everyChar()) {
    if (!c.pc || c.offstage) continue;  // (offstage: not drawn for now, its look walked in by the game: game.js pickJob)
    at(c.w);
    // (the rival team's: red, as the monsters' are; by request, two teams fighting)
    const hp = c.hp / c.pc.maxHp, rival = c.side === sim.RIVAL;
    bar(g, hp, 60, hp <= 0.25 || rival ? '#e0443c' : '#3fd35a', 7, hpFlash(c, hp, t));
    bar(g, c.sp / c.pc.maxSp, 60, '#3f7fe0', 12);
    if (c.cast && !SKILL_EFFECTS[c.cast.sk.name]?.noBar) bar(g, castFrac(c.cast, t), 60, '#f0c040', -PC_TOP - 12);
    // Counter Attack's wait as a cast bar (roBrowser: a cast of 1000 ms whatever the level; here its own time)
    const ac = c.sc.find(s => s.name === 'KN_AUTOCOUNTER' && t < s.until);
    if (ac) bar(g, (t - ac.start) / Math.max(1, ac.until - ac.start), 60, '#f0c040', -PC_TOP - 12);
    if (c.vending || c.room) drawShop(g, c);
  }
  for (const m of W.mobs) {
    if (m.dead != null || m.w.alpha === 0) continue;  // (one in hiding: nothing over it either)
    at(m.w);
    const flash = hpFlash(m, m.hp / m.st.maxHp, t);
    // (one of the party's side, a summon or a homunculus: green as the party's, red at a quarter or less; by request)
    const frac = m.hp / m.st.maxHp, ours = W.chars.some(c => c.side === m.side);
    if (m.hp < m.st.maxHp) bar(g, frac, 40, ours && frac > 0.25 ? '#3fd35a' : '#e0443c', 7, flash);
    if (m.cast) bar(g, castFrac(m.cast, t), 40, '#f0c040', -m.top - 12);
  }
  E.draw(g, t);
  for (const a of [...W.shots, ...flying]) if (t >= a.t0) drawArrow(g, a, (t - a.t0) / Math.max(1, a.at - a.t0));
  for (const f of floats) { at(f.w); drawFloat(g, f, t); }
}

// client damage sprites (data/sprite/이팩트/, converted to png/effect/ with spr2png.py)
const DIGITS = 'png/effect/숫자/frames/';          // 000–009 = digits 0–9
const MSG = 'png/effect/newnumber_msg/frames/';    // 000 Miss, 002 Critical!!, 003 red burst, 005 LUCKY!!
const MISS = 'png/effect/msg/frames/000.png';       // older white serif Miss
const FLOAT_MS = 1500;
const TAKEN_TINT = [255, 80, 80, 255];  // damage the character takes shows in red
const HEAL_TINT = [0, 255, 0, 255];     // HP restored shows in green (roBrowser Damage.js TYPE.HEAL)
const SP_TINT = [34, 48, 191, 255];     // SP restored in blue (TYPE.SP: 0.13, 0.19, 0.75)
const PC_TOP = 95;  // sprite px above the character's feet where its numbers start
// ranged normal attacks with a bow show an arrow flying to the target (roBrowser ef_arrow_projectile: the
// client's npc/skel_archer_arrow.spr, turned to the target). It leaves on the frame the bowstring snaps back
// and the hit comes one frame later, as it lands (roBrowser flies it for the last 140 ms before the hit).
const ARROW = 'png/monster/skel_archer_arrow/frames/000.png';
// the frame a bow lets go on: its sprite changes for the last time there, after the frames it is held drawn
// (the same picture repeated). Every job's bow attack has it on frame 7. null: no bow sprite to look at.
function releaseFrame(c, group) {
  const w = c.look.ch.weapon, a = w && w.act.actions[group * 8];
  if (!a) return null;
  const key = f => f.layers.map(l => l.file).join();
  let r = null;
  a.frames.forEach((f, i) => { if (i && key(f) !== key(a.frames[i - 1])) r = i; });
  return r;
}
// character c's attack motion: how many frames it has, the frame a bow lets go on (null: not a bow, or
// no bow sprite to look at) and the frame the hit shows on — the frame after the release (the arrow flies
// meanwhile), or the one the 人類 tab guesses (swing sound + 1, or 60% of the action). Only an attack
// group has a hit frame worth anything. `delay`: the action's own ms a frame (the act file's)
// (the crusader line's spear thrust, attack 3: its hit on the 7th frame, two later than the
// 60% guess, the 5th: by report)
const CRUSADER_LINE = new Set(['크루세이더', '팔라딘', '가드', 'imperial_guard']), CRUSADER_SPEAR_HIT_FRAME = 6;
function attackMotion(c, group) {
  const act = c.look.ch.body.act, frames = act.actions[group * 8].frames.length, delay = act.actions[group * 8].delay_ms;
  const release = c.pc.weapon === 'Bow' ? releaseFrame(c, group) : null;
  const hf = release != null ? Math.min(release + 1, frames) : c.look.ch.punch && group === 11 ? api.PUNCH_HIT_FRAME
    : CRUSADER_LINE.has(c.look.job) && group === 11 ? Math.min(CRUSADER_SPEAR_HIT_FRAME, frames - 1)
    : Math.max(0, api.guessedHitFrame(act, group, group * 8));
  return { frames, release, hf, delay };
}
// Effects a skill shows (effects.js; after roBrowser's SkillEffect.js): `cast` on the user and `target` on
// the target as soon as it goes off, `success` on the target when a status skill takes hold, `land` on the user when its damage starts landing (Magnum Break's
// blast goes off with the swing's hit frame; roBrowser plays it at once), `hit` on the target with each hit. (roBrowser puts Sonic Blow's 滅 on
// the target; in the client it is on the user.) Effects carry their sounds, which start with the skill.
// The damage follows the attack motion later (sim.js MULTIHIT_MS), so Sonic Blow's 滅 has nearly played out
// when the hits come; Bash strikes on the motion's hit frame (sim.js SKILL_USE hitAt).
// Double Strafe starts with the same burst as Bash (roBrowser beginCastEffectId 16 for both; the client's
// own EFID table names 16 EF_BASH) and its arrow is the one a normal shot flies (beforeHitEffectId
// ef_arrow_projectile, one per hit): no effect of its own, which is why the client has no ac_double sound.
// Heal: its green pillar on the one healed (roBrowser effectId 312) as it goes off; on an undead target the
// white one (hitEffectId 320) comes with the damage instead, and the hit sounds like a critical one (the
// "pa" of ef_hit2.wav). `hitSound`: a skill's hit sound in place of the weapon's.
// `bolt` falls on the target once for every hit, landing with that hit (roBrowser beforeHitEffectId: spammed
// at C_MULTIHIT_DELAY steps from the skill going off while the damage follows attackMT later, so a bolt and its
// hit only meet when the attack motion is as long as the fall; here each falls BOLT_MS, or what is left of it
// if the hit comes sooner, and ends on its hit):
// Fire Bolt's bolts, each hit then bursting into fire (hitEffectId 49); Cold Bolt's, each hit only a sound
// (51). With `lead`, the bolt is an effect of its own length that starts that many ms before its hit (cut short
// at the start when the hit comes sooner): Lightning Bolt's, the client's lightning.str (roBrowser effectId 29,
// one for the whole skill as the damage lands) striking about 880 ms in, one for every hit here as Fire Bolt's,
// each hit then the wind burst (52). `strike` comes down on the target cell of a 'rain' skill once for every
// hit, at a random spot in its area, `lead` ms before that hit: Thunderstorm's thunderstorm.str (roBrowser
// effectId 30, once on the cell), striking about 250 ms in; each monster hit bursts as Lightning Bolt's do.
// `fly`: a bolt's flight, if not BOLT_MS; `from`: it flies from the user (Soul Strike's spirits, roBrowser
// beforeHitEffectId 15, 200 ms there; 1000 here for its arc, by eye). Soul Strike's and Napalm Beat's hits: the light streaks (1).
// `toss` plays on the user as each bolt `from` it leaves (Water Ball's splash).
// `release` runs from the user to the target as the skill goes off (roBrowser releaseEffectId): Frost
// Diver's ice spikes, its hit the freeze STR (28).
const SKILL_EFFECTS = { SM_BASH: { cast: ['EF_BASH'], hit: 'EF_HIT1' }, SM_MAGNUM: { land: ['EF_MAGNUMBREAK'] },
  AL_HEAL: { success: ['EF_HEAL'], hit: 'EF_HEAL3', hitSound: 'effect/ef_hit2.wav' },
  AL_INCAGI: { success: ['EF_INCAGILITY'] }, AL_DECAGI: { success: ['EF_DECAGILITY'] }, AL_BLESSING: { success: ['EF_BLESSING'] }, AL_ANGELUS: { success: ['EF_ANGELUS'] },
  PR_IMPOSITIO: { success: ['EF_IMPOSITIO'] }, PR_SUFFRAGIUM: { success: ['EF_SUFFRAGIUM'] },
  // the songs' grounds are shown by BD_PERFORMING's song, on its player (see below); Melody Strike's and Slinging Arrow's arrows: see shoot
  BA_PANGVOICE: { success: ['EF_FVOICE'] }, DC_WINKCHARM: { success: ['EF_WINK'] },
  BA_MUSICALSTRIKE: { hit: 'EF_HIT1' }, DC_THROWARROW: { hit: 'EF_HIT1' },
  PR_GLORIA: { success: ['EF_GLORIA'] }, PR_KYRIE: { success: ['EF_KYRIE'] },
  PR_MAGNIFICAT: { success: ['EF_MAGNIFICAT'] }, PR_LEXAETERNA: { success: ['EF_LEXAETERNA'] },
  PR_TURNUNDEAD: { hit: 'EF_TURNUNDEAD' },
  // Status Recovery on its target (roBrowser effectId 78)
  PR_STRECOVERY: { success: ['EF_RECOVERY'] },
  // Slow Poison on its target (roBrowser effectId 136)
  PR_SLOWPOISON: { success: ['EF_SLOWPOISON'] },
  // Resurrection on the one it brings back (roBrowser effectId 77; its 140 only a second go of the sound), and with the
  // damage on an undead one
  ALL_RESURRECTION: { success: ['EF_RESURRECTION'], hit: 'EF_RESURRECTION' },
  // B.S. Sacramenti on each one it takes hold of (roBrowser effectId 91)
  PR_BENEDICTIO: { success: ['EF_BENEDICTIO'] },
  // Aspersio on its target (roBrowser effectId 86), or with the damage on an undead one
  PR_ASPERSIO: { success: ['EF_ASPERSIO'], hit: 'EF_ASPERSIO' },
  AL_HOLYLIGHT: { hit: 'EF_HOLYHIT' }, AL_CURE: { success: ['EF_CURE'] },
  // Signum Crucis: the cross on the user (roBrowser effect 40); Ruwach: its orbs round the user while it lasts
  // and roBrowser's hitEffectId 1 (EF_HIT1) on each one it hits
  AL_CRUCIS: { success: ['EF_SIGNUM'] }, AL_RUWACH: { status: 'EF_RUWACH', hit: 'EF_HIT1' },
  SM_PROVOKE: { success: ['EF_PROVOKE'] }, SM_ENDURE: { cast: ['EF_ENDURE'] }, AC_DOUBLE: { cast: ['EF_BASH'], hit: 'EF_HIT1' },
  AC_CONCENTRATION: { cast: ['EF_CONCENTRATION'] }, AC_SHOWER: { hit: 'EF_HIT1' }, AC_CHARGEARROW: { noAura: true, noLockOn: true, castStart: ['EF_BASH'] },
  // (each hit that does damage turns the target a quarter round, `spin`: roBrowser's EF_SONICBLOWHIT, 122; its 8 bring it back round)
  // Grimtooth: its spikes running out to the target, and the big ones on each it hits (roBrowser releaseEffectId 123, hitEffectId 132)
  AS_GRIMTOOTH: { release: ['EF_GRIMTOOTH'], hit: 'EF_GRIMTOOTHATK', hitPerCell: true },
  AS_SONICBLOW: { cast: ['EF_SONICBLOW', 'EF_SONICBLOW2'], spin: 2 },
  MG_FIREBOLT: { bolt: 'EF_FIREBOLT', hit: 'EF_FIREHIT' }, MG_COLDBOLT: { bolt: 'EF_COLDBOLT', hit: 'EF_COLDHIT' },
  MG_LIGHTNINGBOLT: { bolt: 'EF_LIGHTNINGBOLT', lead: 880, hit: 'EF_WINDHIT' },
  MG_THUNDERSTORM: { strike: 'EF_THUNDERSTORM', lead: 250, hit: 'EF_WINDHIT' },
  MG_SOULSTRIKE: { bolt: 'EF_SOULSTRIKE', fly: 1000, from: true, hit: 'EF_HIT1' }, MG_NAPALMBEAT: { hit: 'EF_HIT1' },
  MG_FROSTDIVER: { release: ['EF_FROSTDIVER'], hit: 'EF_FROSTDIVER2' },
  // Fire Ball's ball of fire flies from the user to the target (roBrowser beforeHitEffectId 24) as Soul Strike's
  // spirits do, in 250 ms; every monster it hits bursts into fire as Fire Bolt's (hitEffectId 49)
  MG_FIREBALL: { bolt: 'EF_FIREBALL', fly: 250, from: true, hit: 'EF_FIREHIT' },
  // Envenom's hit makes no weapon sound (its effect has ef_detoxication.wav); Sand Attack's and Stone Fling's are
  // bare hands', whatever the weapon (`hitSound: 'fist'`; by request)
  TF_STEAL: { success: ['EF_STEAL'] }, TF_POISON: { hit: 'EF_PATTACK', hitSound: null }, TF_DETOXIFY: { success: ['EF_DETOXICATION'] },
  TF_SPRINKLESAND: { hit: 'EF_SANDATTACK', hitSound: 'fist' }, TF_PICKSTONE: { noAura: true },
  // the rogue's (roBrowser SkillEffect): Back Stab's hit (hitEffectId 275), Sightless Mind on its user (effectIdOnCaster
  // 276), the Divests on the one they take hold on (successEffectId 269–272), Snatch on its target (effectId 227)
  RG_BACKSTAP: { hit: 'EF_BACKSTAP' }, RG_RAID: { cast: ['EF_TEIHIT3'] }, RG_INTIMIDATE: { target: ['EF_INTIMIDATE'] },
  RG_STRIPWEAPON: { success: ['EF_STRIPWEAPON'] }, RG_STRIPSHIELD: { success: ['EF_STRIPSHIELD'] },
  RG_STRIPARMOR: { success: ['EF_STRIPARMOR'] }, RG_STRIPHELM: { success: ['EF_STRIPHELM'] },
  // Mug taking hold on the monster (successEffectId 268, 274); Close Confine's cage on both while it holds (groundEffectId 604)
  RG_STEALCOIN: { success: ['EF_STEALCOIN', 'EF_RG_COIN'] }, RG_CLOSECONFINE: { status: 'EF_CCONFINE' }, RG_CLOSECONFINE2: { status: 'EF_CCONFINE' },
  // Stone Fling's stone flies from the user to the target (roBrowser beforeHitEffectId 308) in 200 ms, from the
  // swing's hit frame (sim.js flight), its hit sounding as it gets there
  TF_THROWSTONE: { bolt: 'EF_THROWSTONE', fly: 200, from: true, hitSound: 'fist' },
  MG_STONECURSE: { success: ['EF_STONECURSE'] }, MG_ENERGYCOAT: { success: ['EF_ENERGYCOAT'], spinAura: true, auraScale: 0.5 },
  MG_SIGHT: { status: 'EF_SIGHT' },
  // Mammonite: Bash's sound as it goes off, without its glow (by request), and the coins on the target as it goes off, so that their burst (230 ms into the STR) comes about with
  // the hit (by request; roBrowser effectId 10 on the target attackMT after it goes off, as the damage lands);
  // Crazy Uproar: on everyone it takes hold of (effectId 311 with each clif_skill_nodamage)
  MC_MAMMONITE: { cast: ['EF_BASH_SOUND'], target: ['EF_COIN'] },
  // Cart Revolution: Bash's sound as it goes off, without a glow, and Magnum Break's burst on the target's cell as
  // its damage lands (by request; roBrowser its own cartrevolution.str, effect 170, on the user as it goes off and
  // on each one hit). The cart swings round in front of the user meanwhile (see pushCart).
  // Blitz Beat: the falcon dives on the target (see flyFalcons); its sound with the first hit on each one (hitFirst)
  HT_BLITZBEAT: { hit: 'EF_BLITZBEAT', hitFirst: true, hitSound: null },
  // Detect: its sound on the user as it goes off (roBrowser effect 119, attachedEntity), the falcon flying to the cell
  // round a circle past it, blowing dust out there (see scout); Phantasmic Arrow: a normal shot's arrow (beforeHitEffectId ef_arrow_projectile), its hit EF_HIT1
  HT_DETECTING: { cast: ['EF_DETECTING'] }, HT_PHANTASMIC: { hit: 'EF_HIT1' },
  // Land Mine's damage: no hit sound of its own (its blast's in EF_LANDMINE)
  // Remove Trap: its sound on the cell (roBrowser effect 100); Spring Trap's spring.str (111) as its falcon passes over: see scout
  HT_REMOVETRAP: { success: ['EF_REMOVETRAP'] },
  HT_LANDMINE: { hitSound: null }, HT_BLASTMINE: { hitSound: null }, HT_CLAYMORETRAP: { hitSound: null },
  // Fire Pillar: firepillarbomb.str on each one it hits (roBrowser hitEffectId 97), once (one damage packet), its sound
  // for the hit's; the pillar where it stood as it goes off (see TRAP_FX)
  WZ_FIREPILLAR: { hit: 'EF_FIREPILLARBOMB', hitFirst: true, hitSound: null },
  // Freezing Trap: freezing.str on each one it hits (roBrowser hitEffectId 108), its sound for the hit's
  HT_FREEZINGTRAP: { hit: 'EF_FREEZING', hitSound: null },
  MC_CARTREVOLUTION: { cast: ['EF_BASH_SOUND'], landOn: ['EF_MAGNUMBREAK'] }, MC_LOUD: { success: ['EF_LOUD'] },
  // a monster's Poison, Stun and Petrify Attack (roBrowser effectId 192, 194, 195) and Poison Attribute Attack
  // (hitEffectId 53), on the target as each hit lands; Shadow Attribute Attack has none (roBrowser's 184 and 180 are empty)
  NPC_POISON: { hit: 'EF_POISONATTACK' }, NPC_STUNATTACK: { hit: 'EF_STUNATTACK' }, NPC_PETRIFYATTACK: { hit: 'EF_PETRIFYATTACK' },
  NPC_POISONATTACK: { hit: 'EF_POISONHIT' },
  // Critical Slash: Bash's glow on the user (roBrowser effectIdOnCaster 16); Piercing Attack and Pierce: pierce.str on
  // the user (148), Pierce's hits earthhit.str (147); Guided Attack: homing.str on the target (191); Jupitel Thunder:
  // its ball flying from the caster to the target in 300 ms (`once`: one for all its hits; by eye), each hit
  // bursting (94)
  NPC_CRITICALSLASH: { cast: ['EF_BASH'] }, NPC_PIERCINGATT: { cast: ['EF_PIERCESELF'] },
  KN_PIERCE: { cast: ['EF_PIERCESELF'], hit: 'EF_EARTHHIT' }, NPC_GUIDEDATTACK: { hit: 'EF_GUIDEDATTACK' },
  // Spear Boomerang: spearboomerang.str on the user as it goes off (roBrowser effectIdOnCaster 151), its spear flying
  // from the user to the target from the swing's hit frame (beforeHitEffectId ef_spear_projectile; sim.js flight),
  // its hit ef_fireball.wav (hitEffectId 80) with the weapon's
  KN_SPEARBOOMERANG: { cast: ['EF_SPEARBMRSELF'], bolt: 'EF_SPEARBOOMERANG', fly: 140, from: true, hit: 'EF_SPEARBMR' },
  // Shield Boomerang: its shield flying from the user to the target from the swing's hit frame (beforeHitEffectId
  // ef_shield_projectile, 140 ms; sim.js flight), its hit's sound (effectId 249) with Shield Charge's metal knock
  // (lg_shieldpress.wav, by request), not the weapon's
  CR_SHIELDBOOMERANG: { bolt: 'EF_SHIELD_PROJECTILE', fly: 140, from: true, hit: 'EF_SHIELDBOOMERANG', hitSound: 'effect/lg_shieldpress.wav' },
  // Spear Stab: spearstab.str on the user as it goes off (roBrowser effectIdOnCaster 150)
  KN_SPEARSTAB: { cast: ['EF_SPEARSTABSELF'] },
  // Bowling Bash: no aura and no cast bar over its 0.35 s fixed cast (roBrowser hideCastAura, hideCastBar: `noBar`),
  // bowling.str on the user as it goes off (effectIdOnCaster 149), the light streaks on each one hit (hitEffectId 1)
  KN_BOWLINGBASH: { noAura: true, noBar: true, cast: ['EF_BOWLINGSELF'], hit: 'EF_HIT1' },
  // Counter Attack: nothing as it is used (roBrowser hideCastAura); the bar over the user while it waits (see
  // drawBars), and autocounter.str with knight_autocounter.wav as it counters (EVENTS counter: roBrowser plays
  // EF_AUTOCOUNTER, 131, as the wait is cut short)
  KN_AUTOCOUNTER: { noAura: true, counter: 'EF_AUTOCOUNTER' },
  // Charge Attack: no effect of its own (roBrowser beginCastEffectId white_pulse is empty), but Bash's sound as it
  // goes off (by request), and _enemy_hit_normal1.wav as it hits (hitEffectId enemy_hit_normal1)
  // its dash raises dust along the way (by request, as Hiding's: EVENTS dash)
  // Back Sliding: the same dust along its slide (by request)
  TF_BACKSLIDING: { dust: 'EF_DASHDUST' },
  KN_CHARGEATK: { cast: ['EF_BASH_SOUND'], hitSound: '_enemy_hit_normal1.wav', dust: 'EF_DASHDUST' },
  // Brandish Spear: its 0.35 s cast without aura or bar (roBrowser hideCastBar, hideCastAura); as it goes off
  // brandish2.str on the user (effectIdOnCaster 144) and brandish.str where the target stands (effectId 70)
  KN_BRANDISHSPEAR: { noAura: true, noBar: true, cast: ['EF_BRANDISH2'], target: ['EF_BRANDISHSPEAR'] },
  // Sightrasher: roBrowser effect 62 on the user as it goes off, Fire Bolt's hit (49) on each one hit
  // (Sight's fireballs spiral in to the user first, E.SIGHT_COLLAPSE ms, its burst after: by request; `collapse`)
  WZ_SIGHTRASHER: { cast: ['EF_SIGHTRASHER'], hit: 'EF_FIREHIT', collapse: 'MG_SIGHT' },
  // Meteor Storm: roBrowser effect 92 where each meteor falls (clif_skill_poseffect: one of meteor1–4.str with
  // wizard_meteor.wav; its camera quake not done), Fire Bolt's hit (49) on each one hit
  WZ_METEOR: { success: ['EF_METEOR'], hit: 'EF_FIREHIT' },
  // Lord of Vermilion: roBrowser effect 90 where it is cast (lord.str with wizard_fire_ivy.wav), a wind spell's hit
  // (52) on each one hit
  WZ_VERMILION: { target: ['EF_LORD'], hit: 'EF_WINDHIT' },
  // Frost Nova: roBrowser effect 28 (freeze.str, Frost Diver's hit) on the user as it goes off (effectIdOnCaster), a
  // water spell's hit (51) on each one hit
  WZ_FROSTNOVA: { cast: ['EF_FROSTDIVER2'], hit: 'EF_COLDHIT' },
  // Storm Gust: a water spell's hit (51) on each one hit (its storm: EVENTS storm)
  WZ_STORMGUST: { hit: 'EF_COLDHIT' },
  // Earth Spike: roBrowser effect 79 (its spikes) on the target as it goes off, an earth spell's hit (147) on it with
  // each hit
  WZ_EARTHSPIKE: { target: ['EF_EARTHSPIKE'], hit: 'EF_EARTHHIT' },
  // Heaven's Drive: roBrowser effect 142 (a spike on each of its cells) where it is cast, an earth spell's hit (147) on
  // each one hit; nothing comes down on its area (`still`)
  WZ_HEAVENDRIVE: { target: ['EF_HEAVENDRIVE'], hit: 'EF_EARTHHIT', still: true },
  WZ_JUPITEL: { bolt: 'EF_JUPITEL', fly: 150, from: true, once: true, hit: 'EF_JUPITELHIT' },
  // Water Ball: each ball flies from the user to the target as it is thrown, landing with its hit (roBrowser
  // hitEffectIdOnCaster 117), the splash of water on the user as it leaves (`toss`: beforeHitEffectIdOnCaster 116,
  // with wizard_waterball_chulung.wav); no hit effect of its own nor the weapon's sound
  WZ_WATERBALL: { bolt: 'EF_WATERBALL2', fly: 1000, from: true, toss: 'EF_WATERBALL', hitSound: null },
  // Sleep Attack (roBrowser effectId 197) on the target as each hit lands; Curse Attack's (196) is empty. Stop
  // (453) on the one it holds. Sucking Blood (effectIdOnCaster 216): `drain` on the user, flying from the target,
  // as each hit lands.
  NPC_SLEEPATTACK: { hit: 'EF_SLEEPATTACK' }, NPC_STOP: { success: ['EF_NPC_STOP'] }, NPC_BLOODDRAIN: { drain: 'EF_BLOODDRAIN' },
  // a monster's buffs on itself (roBrowser: Agility Up as Increase AGI; Keeping 214, Two-Hand Quicken 130, Adrenaline
  // Rush 98 with its beginCast, Auto Guard 336 (again as it blocks: see hit), Reflect Shield 252, Cloaking 120;
  // Invisible and Snap's blur (166, a motion trail) none)
  NPC_AGIUP: { success: ['EF_INCAGILITY'] }, NPC_KEEPING: { success: ['EF_KEEPING'] }, KN_TWOHANDQUICKEN: { success: ['EF_TWOHANDQUICKEN'] },
  BS_ADRENALINE: { castStart: ['EF_ADRENALINE_CAST'], success: ['EF_ADRENALINE'] }, CR_AUTOGUARD: { success: ['EF_GUARD'] },
  CR_REFLECTSHIELD: { success: ['EF_REFLECTSHIELD'] }, CR_DEFENDER: { success: ['EF_DEFENDER'] }, CR_SPEARQUICKEN: { success: ['EF_SPEARQUICKEN'] }, AS_CLOAKING: { success: ['EF_CLOAKING'] },
  // the blacksmith's: Weapon Perfection (roBrowser 103) and Power Thrust (128) on each one they are put on; Maximize Power
  // (104 as it goes on, with its sounds: roBrowser's beginCastEffectId, which an instant skill would not play); Hammer
  // Fall (102) where it strikes
  BS_WEAPONPERFECT: { success: ['EF_PERFECTION'] }, BS_OVERTHRUST: { success: ['EF_OVERTHRUST'] },
  BS_MAXIMIZE: { success: ['EF_MAXPOWER_SOUNDS', 'EF_MAXPOWER'] }, BS_HAMMERFALL: { target: ['EF_CRASHEARTH'] },
  // the monk's: Absorb Spirit Sphere on the user as it gets its SP (roBrowser successEffectIdOnCaster 253); Raging
  // Trifecta Blow's sounds (effectId 329's: here one with each of its hits, `hitSounds`, by request, not 200 ms apart)
  // and speed lines on the target along the punch with each (as the game's, by report; Blitz Beat's, shorter: by eye); Occult Impaction's on the target (267), and its yellow burst out of the target's back as it hits (침투경_.spr, by request); Throw Spirit Sphere's sphere flying
  // to the target (265), each hit the light streaks (hitEffectId 1); Raging Quadruple Blow's on the target (262, 273)
  // and the rings round the user (effectIdOnCaster 263); Fury's rings round the user (effectIdOnCaster 261); Raging Thrust's sound (330), its yellow lines from the user as its fist strikes the ground. Summon Spirit Sphere and Snap
  // show nothing of their own (roBrowser: none; Snap's blur, 166, not done); the spheres: see spheres
  MO_ABSORBSPIRITS: { success: ['EF_ABSORBSPIRITS'] }, MO_EXPLOSIONSPIRITS: { land: ['EF_GUMGANG2'], status: 'EF_FURY_ZAPS' }, MO_TRIPLEATTACK: { hit: 'EF_TRIPLELINES', hitSounds: ['effect/ef_hit2.wav', 'effect/ef_hit4.wav', 'effect/ef_hit2.wav'] },
  MO_INVESTIGATE: { target: ['EF_CHIMTO'], hit: 'EF_CHIMTO_HIT' }, MO_FINGEROFFENSIVE: { bolt: 'EF_TANJI', fly: 150, from: true, once: true, hit: 'EF_HIT1' },
  MO_CHAINCOMBO: { cast: ['EF_GUMGANG3'], target: ['EF_TEIHIT1', 'EF_CHAINCOMBO'] }, MO_COMBOFINISH: { target: ['EF_COMBOFINISH'], land: ['EF_COMBOFINISH_LINES'] },
  MO_EXTREMITYFIST: { target: ['EF_BEGINASURA'], hit: 'EF_TEIHIT1X' }, MO_STEELBODY: { land: ['EF_STEELBODY'], status: 'EF_STEELBODY_ZAPS' },
  MO_BALKYOUNG: { landOn: ['EF_GI_EXPLOSION'] },
  AS_ENCHANTPOISON: { success: ['EF_ENCHANTPOISON'] },
  // Poison React: roBrowser's effect 126 as it goes on, and its hitEffectId 127 here on the user as it blocks a poison
  // attack (the counter readied: by eye, rAthena's counter being a normal attack that shows no skill)
  AS_POISONREACT: { success: ['EF_POISONREACT'], counter: 'EF_POISONREACT2' },
  // Venom Splasher: roBrowser's effect 129 on the target as it is set, and again on each its blast hits (roBrowser plays
  // effectId for the skill damage too)
  AS_SPLASHER: { success: ['EF_SPLASHER'], hit: 'EF_SPLASHER' },
  // Throw Venom Knife: its knife flying to the target (roBrowser beforeHitEffectId 600), as Stone Fling's stone
  AS_VENOMKNIFE: { bolt: 'EF_THROWITEM6', fly: 200, from: true },
  // on characters: Provocation as Provoke (successEffectId 67), Dispell (235), Lex Divina (87) on the target as
  // they go off; Dark Breath (212) on the one hit; Shield Charge's (246) on its target as it goes off (by request), its
  // shield coming down 400 ms in (its STR's frame 24 of 60 a second), as the hit lands (sim.js), the hit's sound a
  // shield's metal knock, the client's lg_shieldpress.wav (Shield Press's; by request: Bash's ef_hit2.wav and the
  // weapon's slash before); Aid Potion none (roBrowser's 299 is empty)
  NPC_PROVOCATION: { success: ['EF_PROVOKE'] }, SA_DISPELL: { success: ['EF_DISPELL'] }, PR_LEXDIVINA: { success: ['EF_LEXDIVINA'] },
  // the sage's: Spell Breaker on its target (roBrowser successEffectId 234), Magic Rod on its user as it takes a spell in (244)
  SA_SPELLBREAKER: { success: ['EF_SPELLBREAKER'] }, SA_MAGICROD: { success: ['EF_MAGICROD'] },
  // Hocus-Pocus's Suicide (roBrowser effectId ef_sa_instantdeath); its other skills have none
  SA_INSTANTDEATH: { success: ['EF_SA_INSTANTDEATH'] },
  // the endows on their target (successEffectId 255–258); Hindsight has none
  SA_FLAMELAUNCHER: { success: ['EF_FLAMELAUNCHER'] }, SA_FROSTWEAPON: { success: ['EF_FROSTWEAPON'] },
  SA_LIGHTNINGLOADER: { success: ['EF_LIGHTNINGLOADER'] }, SA_SEISMICWEAPON: { success: ['EF_SEISMICWEAPON'] },
  CR_SHIELDCHARGE: { target: ['EF_SHIELDCHARGE'], hitSound: 'effect/lg_shieldpress.wav' }, CR_HOLYCROSS: { hit: 'EF_HOLYCROSS', hitFirst: true },
  CR_GRANDCROSS: { success: ['EF_GRANDCROSS'] }, CR_PROVIDENCE: { success: ['EF_PROVIDENCE'] },
  // (Sacrifice: devotion.str on the one it is put on, and the line from its crusader while it lasts: roBrowser's
  // ZC_DEVOTIONLIST, EF_LINELINK)
  CR_DEVOTION: { success: ['EF_DEVOTION'], status: 'EF_LINELINK' }, NPC_DARKBREATH: { hit: 'EF_DARKBREATH' },
  // on the ground: Venom Dust's cloud where it is cast (roBrowser effectId 124); its cells, the traps and Fiber Lock's
  // web are drawn as their units (see EVENTS trap, dust, web)
  AS_VENOMDUST: { target: ['EF_VENOMDUST'] },
  // Sanctuary's sanctuary.str where it is cast (roBrowser effectId 83); its cells as their unit (see EVENTS sanct)
  PR_SANCTUARY: { target: ['EF_SANCTUARY'] },
  // Magnus Exorcismus' magnus.str where it is cast (roBrowser effectId 113), each hit Holy Light's holyhit.str (152); its
  // cells as their unit (see EVENTS magnus)
  PR_MAGNUS: { target: ['EF_MAGNUS'], hit: 'EF_HOLYHIT' },
  // the alchemist's: Acid Terror's bottle flies from the user to the target (roBrowser beforeHitEffectId 298) in 300
  // ms from the throw's hit frame (sim.js flight); Bomb's fire is drawn as its unit (see EVENTS bomb)
  AM_ACIDTERROR: { bolt: 'EF_THROWITEM', fly: 300, from: true, hit: 'EF_ACIDBOTTLE_HIT', hitSound: null },
  // Bomb's bottle the same way to its cell (by request), the fire up as it lands (EVENTS bomb); Acid Terror's breaking on
  // the one hit (by request: EF_ACIDBOTTLE_HIT, its sound in the weapon's place)
  AM_DEMONSTRATION: { bolt: 'EF_THROWFIREBOTTLE', fly: 300, from: true },
  // the other bottles the same way (by request): Bio Cannibalize's and Sphere Mine's to the cell, breaking there as the
  // plant or the sphere comes (sim.js summonFor); Aid Potion's potion of its level (sim.js names it AM_POTIONPITCHER_<lv>)
  // to the one of the party, breaking there with that potion's effect as one drunk, Heal's with its number after
  AM_CANNIBALIZE: { bolt: 'EF_THROWPLANTBOTTLE', fly: 300, from: true, success: ['EF_BOTTLE_BREAK'] },
  AM_SPHEREMINE: { bolt: 'EF_THROWMINEBOTTLE', fly: 300, from: true, success: ['EF_BOTTLE_BREAK'] },
  ...Object.fromEntries([1, 2, 3, 4, 5].map(lv => [`AM_POTIONPITCHER_${lv}`,
    { bolt: `EF_THROWPOTION${lv}`, fly: 300, from: true, success: ['EF_BOTTLE_BREAK', `EF_POTION${lv}`] }])),
  // Chemical Protection's sound (roBrowser effectId 300) on the one it is cast on; Aid Berserk Potion's the potion's own
  // (effectId 220, as one drunk: POTION_FX)
  AM_CP_WEAPON: { success: ['EF_CHEMICALPROTECTION'] }, AM_CP_SHIELD: { success: ['EF_CHEMICALPROTECTION'] },
  AM_CP_ARMOR: { success: ['EF_CHEMICALPROTECTION'] }, AM_CP_HELM: { success: ['EF_CHEMICALPROTECTION'] },
  AM_BERSERKPITCHER: { success: ['EF_POTION_BERSERK'] },
  // a Marine Sphere's Self Destruction on itself (roBrowser effectId 183)
  NPC_SELFDESTRUCTION: { success: ['EF_SUI_EXPLOSION'] } };
// `status`: an effect on the unit for as long as the skill's status is on it (Sight's fireballs, roBrowser's
// effect for SC_SIGHT); started again with it when the skill is used again (see statusEffects)
// the light streaks and "pa" (ef_hit2.wav) of a critical normal attack
const CRIT_EFFECT = 'EF_HIT1';
// the ring of a normal attack hitting a monster (EF_HIT), on these skills' hits too (by request; Shield Boomerang's
// shield too)
const PUNCHES = new Set(['MO_TRIPLEATTACK', 'MO_CHAINCOMBO', 'MO_COMBOFINISH', 'CR_SHIELDBOOMERANG']);
// landAt: when the damage starts landing
function skillStart(name, w, target, t, landAt = t) {
  const fx = SKILL_EFFECTS[name] || {};
  for (const name of fx.cast || []) E.play(name, w, t);
  // `collapse`: the user's status of that name (its effect) ended by the skill, its orbit spiralling in
  if (fx.collapse) for (const [s, e] of statusFx) if (s.name === fx.collapse && e && e.w === w) { E.stop(e, t, { collapse: E.SIGHT_COLLAPSE }); statusFx.delete(s); }
  for (const name of fx.target || []) E.play(name, target, t);
  for (const name of fx.release || []) E.play(name, target, t, undefined, { from: w });
  for (const name of fx.land || []) later.push({ at: landAt, name, w });
  // `landOn`: on the target's cell (where it stands as the skill goes off) as the damage lands
  for (const name of fx.landOn || []) later.push({ at: landAt, name, w: W.field.spot(...target.cell) });
  if (name === 'MC_CARTREVOLUTION') pushCart(w, target, t, landAt);
}
// A cast's effects (roBrowser onEntityCastSkill): the aura for the skill's element under the caster and the
// lock-on mark under whom it is cast at, both lasting the cast (with the aura's ef_beginspell.wav); none when
// cast at itself (as roBrowser).
// A ground skill marks the cell it is cast on instead (EF_GROUNDSAMPLE), as wide as the area it will hit
// (Thunderstorm's 5×5, Arrow Shower's 3×3 or 5×5; one cell for Fire Wall; by eye, roBrowser one cell).
// lv: the cast's level.
// A skill's SKILL_EFFECTS may leave out the aura (noAura: roBrowser hideCastAura), the mark (noLockOn) or the cast
// bar (noBar: hideCastBar), and
// play effects of their own on the caster as the cast starts (castStart, played through whatever the cast
// does). Arrow Repel: no aura and no mark (by eye), and Bash's burst and sound as it starts (by ear). `spinAura`:
// the aura turns even where roBrowser's stands still (the neutral one: Energy Coat's, by request); `auraScale`: the
// aura that much smaller (Energy Coat's half: by request).
function castEffects(w, sk, target, t, ct, ground = false, lv = 1) {
  const own = SKILL_EFFECTS[sk.name] || {};
  const fx = own.noAura ? [] : [E.play(E.castAura(sk.element), w, t, ct, { spin: !!own.spinAura, scale: own.auraScale || 1 })];
  if (target && target !== w && !own.noLockOn) fx.push(E.play(ground ? 'EF_GROUNDSAMPLE' : 'EF_LOCKON', target, t, ct, { size: ground ? 2 * sim.areaOf(sk, lv) + 1 : 0 }));
  for (const name of own.castStart || []) E.play(name, w, t);
  return fx;
}
// effects of casts that ended early: their caster is casting something else now, or nothing
function stopCasts(t) {
  for (let i = casting.length - 1; i >= 0; i--) {
    const e = casting[i];
    if (e.unit.cast === e.cast && (sim.everyChar().includes(e.unit) || W.mobs.includes(e.unit))) continue;
    for (const fx of e.fx) E.stop(fx, t);
    casting.splice(i, 1);
  }
}
// (from: the attacker's mover, for a hit that goes the way it was struck: Sand Attack's)
// (head: px from the feet to the head of the one hit, for a hit effect over its head: Dark Breath's)
// (`hitPerCell`: a hit effect that stays — Grimtooth's spikes — ends the one left on the same cell before it, by
// request, so they do not pile up)
const cellHits = new Map();  // cell 'x,y' → the lasting hit effect on it
function skillHit(name, w, t, from = null, head = 0, first = true) {
  const fx = SKILL_EFFECTS[name];
  if (fx && fx.hit && (first || !fx.hitFirst)) {
    const key = fx.hitPerCell && w.cell.join(), old = key && cellHits.get(key);
    if (old) E.stop(old, t);
    const e = E.play(fx.hit, w, t, undefined, { from, head });
    if (key) cellHits.set(key, e);
  }
  if (fx && fx.drain && from) E.play(fx.drain, from, t, undefined, { from: w });
}
export function preloadSkill(name) {
  const fx = SKILL_EFFECTS[name] || {};
  [...fx.cast || [], ...fx.castStart || [], ...fx.target || [], ...fx.release || [], ...fx.land || [], ...fx.landOn || [], ...fx.success || [], fx.hit, fx.counter, fx.dust, fx.drain, fx.bolt, fx.toss, fx.status].forEach(E.preload);
  if (fx.hitSound && fx.hitSound !== 'fist') api.preloadSound(fx.hitSound);
  (fx.hitSounds || []).forEach(api.preloadSound);
}
const LABEL_MS = 1200;  // skill names shouted above the user
const CHAT_MS = 5000;  // a chat message over a unit's head (roBrowser EntityDialog: removed after 5 s)
const DUST_STEP = 0.7, DUST_JITTER = 0.25;  // cells between a dash's dust puffs, and how far off the line they may be (by eye)
const BOLT_MS = 500;  // a falling bolt's flight (roBrowser ef_firebolt / ef_coldbolt)

// (roBrowser ItemEffect: the item's effectId)
// the sounds of turning to stone, back, and of poison (stoneWait, unstone, poison)
const STATE_SOUNDS = ['_stonecurse.wav', '_stone_explosion.wav', '_poison.wav'];
// the sounds played here by name (under data/wav/: the states', the skills' hitSound(s)), for game/needs.js; files:
// the pictures the game has drawn here by name, as asset paths (a chat room's icon, drawShop: 招募's, by report,
// issue 17, was not in the packs; not a shop's, no vending in the game)
export const stageNeeds = () => ({ sounds: [...new Set([...STATE_SOUNDS,
  ...Object.values(SKILL_EFFECTS).flatMap(x => [x.hitSound, ...(x.hitSounds || [])]).filter(w => /\.wav$/.test(w || ''))])],  // ('fist': the bare hands' hit sounds, listed as such)
  files: ['raw/texture/' + CHAT_ICON.replace(/^\.\.\//, '')] });
const POTION_FX = { 501: 'EF_POTION1', 502: 'EF_POTION2', 503: 'EF_POTION3', 504: 'EF_POTION4', 505: 'EF_POTION5', 645: 'EF_POTION_CON', 656: 'EF_POTION_AWAKENING', 657: 'EF_POTION_BERSERK' };
// what the fight reads off character c's sprites (motion: its attack's action and each action's frames and hit
// frame), for the worker's runs to go by the same
export function timingOf(c) {
  if (!motion.ready(c)) return null;
  const pc = {};
  for (let g = 0; g * 8 < c.look.ch.body.act.actions.length; g++) pc[g] = attackMotion(c, g);
  return { group: motion.attackGroup(c), pc };
}
// ---------- what the fight shows (sim.js events) ----------
let later = [];              // effects waiting for their time: { at, name, w, duration (for layers taking the caller's), opts (E.play's) }
let flying = [];             // monsters' projectiles on their way: { by, from (mover), to, t0, at, img, fromTop }
const casting = [];          // casts' effects: { unit (character or monster), cast (the one the effects belong to), fx }
const combos = new WeakMap();  // a multi-hit attack's combo (sim.js) → its running total: { sum, left, float }
const frozenFx = new Map();    // frozen monster → its block of ice
const stunFx = new Map();      // stunned unit → the stars over its head
const sleepFx = new Map();     // a unit asleep → the sleep sprite over its head
const curseFx = new Map();     // a cursed unit → the curse sprite over its head
const ailFx = new Map();       // a blind, silenced or confused unit → its emote: { kinds (in the order they began), kind (shown), fx }
const poses = new WeakMap();   // a monster's freeze (m.frozen) or a unit's stone (u.stone) → the pose it holds: { action, fi }
const wallFx = new Map();      // fire wall cell → its flames
const iceFx = new Map();       // ice wall cell → its ice
const stormFx = new Map();     // Storm Gust → its storm
const quagFx = new Map();      // Quagmire → its cells' mud
const fieldFx = new Map();     // a sage's element field or Land Protector → its cells' effects (EF_BOTTOM_*)
const FIELD_SHARE = 0.85, FIELD_SIZE = [0.9, 1.3], FIELD_OFF = 0.25;
const FIELD_FX = { SA_VOLCANO: 'EF_BOTTOM_VO', SA_DELUGE: 'EF_BOTTOM_DE', SA_VIOLENTGALE: 'EF_BOTTOM_VI', SA_LANDPROTECTOR: 'EF_BOTTOM_LA' };
const guardFx = new Map();     // safety wall → its glow
const pneumaFx = new Map();    // pneuma → its effect
const warpFx = new Map();      // warp portal → its effect
const trapFx = new Map();      // trap → its model
// each trap's model on the ground, and what plays where it was as it is set off (effects.js)
const TRAP_FX = { HT_SANDMAN: ['EF_TRAP_SANDMAN', 'EF_SANDMAN'], HT_SKIDTRAP: ['EF_TRAP_SKID', 'EF_SKIDTRAP'],
  HT_LANDMINE: ['EF_TRAP_LANDMINE', 'EF_LANDMINE'], HT_ANKLESNARE: ['EF_TRAP_ANKLESNARE', null],
  HT_SHOCKWAVE: ['EF_TRAP_SHOCKWAVE', 'EF_SHOCKWAVEHIT'], HT_FLASHER: ['EF_TRAP_FLASHER', 'EF_FLASHER'],
  HT_FREEZINGTRAP: ['EF_TRAP_FREEZING', null], HT_BLASTMINE: ['EF_TRAP_BLASTMINE', 'EF_BLASTMINEBOMB'],
  HT_CLAYMORETRAP: ['EF_TRAP_CLAYMORE', 'EF_CLAYMORE'], HT_TALKIEBOX: ['EF_TRAP_TALKIEBOX', null],
  WZ_FIREPILLAR: ['EF_FIREPILLARON', 'EF_FIREPILLAR'] };
const dustFx = new Map();      // Venom Dust → its cells' effects
const webFx = new Map();       // Fiber Lock's web → its effect
const sanctFx = new Map();     // a Sanctuary → its cells' effects
const magnusFx = new Map();    // a Magnus Exorcismus → its cells' effects
const bombFx = new Map();      // Bomb's fire → its effects (one a cell)
const BOMB_LOOP_MS = 480;  // (the sprite's loop: 5 frames of 96 ms)
const BOMB_SPREAD_MS = 150, BOMB_GROW = 0.2, BOMB_GROW_MS = 400;  // (by eye)
const statusFx = new Map();    // a status on a unit (its sc entry) → its SKILL_EFFECTS `status` effect
const sphereFx = new Map();    // a character → { n (how many spirit spheres it shows), fx (them going round it) }
// sprite px above a unit's feet where what rises above it starts
const topOf = w => w.top ?? (sim.everyChar().some(c => c.w === w) ? PC_TOP : (W.mobs.find(m => m.w === w) || {}).top || 60);  // (w.top: a mover drawn on its own, game/townfolk.js's)
const EVENTS = {
  // loot on the ground (sim.dropLoot), and picked up: what is drawn of it keeps up by itself (showLoot), from
  // monster m's feet (its arc: see there)
  drop(it, m) { lootArcs.set(it, { t0: W.t, from: [...m.w.pos] }); },
  // what a Steal took (sim DOES.steal): item id flying from monster m to character c (see showLoot)
  stolen(c, id, m, t) { stealArcs.push({ c, id, t0: t, from: [...m.w.pos] }); },
  // a potion drunk (sim.drink; its HP comes as a heal): its effect over the character
  potion(c, id, t) { const k = POTION_FX[id]; if (k) E.play(k, c.w, t); },
  // a character down: roBrowser's EF_DEVIL over it (its own character's only there; every one of the party here, by request)
  died(c, t) { E.play('EF_DEVIL', c.w, t); },
  // a dash (Charge Attack's, Back Sliding's: sim DOES.charge, backslide) from position `from` to `to` over `dur` ms
  // from t, eased by `ease` (the slide's): the skill's `dust` on the ground every DUST_STEP cells of the way, each as the user passes it,
  // with a little chance in it (by request): up to DUST_JITTER cells off the line, a little early or late, its size
  // 0.7–1.3 times, now and then one left out
  dash(name, from, to, t, dur, ease) {
    const dust = (SKILL_EFFECTS[name] || {}).dust;
    if (!dust) return;
    const n = Math.max(1, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / DUST_STEP));
    for (let i = 0; i < n; i++) {
      const e = i / n;
      let lo = 0, hi = 1;  // (the time it is e of the way there: the easing turned round by halving)
      for (let k = 0; k < 20; k++) { const mid = (lo + hi) / 2; if (ease(mid) < e) lo = mid; else hi = mid; }
      if (i && Math.random() < 0.15) continue;
      const j = () => (Math.random() * 2 - 1) * DUST_JITTER;
      later.push({ at: t + lo * dur + (Math.random() - 0.5) * 40, name: dust, opts: { scale: 0.7 + Math.random() * 0.6 },
                   w: W.field.spot(from[0] + (to[0] - from[0]) * e - 0.5 + j(), from[1] + (to[1] - from[1]) * e - 0.5 + j()) });
    }
  },
  // Counter Attack countering (sim autoCounter): roBrowser's EF_AUTOCOUNTER on the one countering
  counter(c, t, name = 'KN_AUTOCOUNTER') { E.play(SKILL_EFFECTS[name].counter, c.w, t); },
  pickup() {},
  // a line of text rising above a unit (skill names); one shouted as a cast starts holds still until the cast
  // is over (`cast`, see update), then rises and fades
  // (`chat`: what the unit says, as a chat message over its head, one at a time: a new one takes the last one's place)
  say(w, text, t, cast, chat) {
    if (chat) floats = floats.filter(f => !(f.chat && f.w === w));
    floats.push({ t0: t, text, w, top: topOf(w), cast, chat });
  },
  // character c's falcon dives on target w, to strike it at `at` (Blitz Beat: see flyFalcons)
  // (Detect, Spring Trap: `high`, round a circle through the cell, no dive, `high` played on it half way: see scout)
  falcon(c, w, t, at, span, high) { falconNext.set(c, { t0: t, at, span, aim: [...w.pos], target: w, high }); },
  // a skill goes off (its hits land from landAt on)
  skill(name, w, target, t, landAt) { skillStart(name, w, target, t, landAt); },
  // (a character's spirit spheres changed: drawn as they stand after each step, see spheres)
  spheres() {},
  // `bolt` falls on the target once for every hit (n of them, from `at`, gap ms apart), each landing with its hit
  bolts(name, w, t, at, n, gap, by) {
    const { bolt, lead, fly, from, once, toss } = SKILL_EFFECTS[name] || {};
    for (let i = 0; bolt && i < (once ? 1 : n); i++) {
      const hit = at + i * gap, start = Math.max(t + i * gap, hit - (lead || fly || BOLT_MS));
      later.push(lead ? { at: hit - lead, name: bolt, w }
        : { at: start, name: bolt, w, duration: Math.max(1, hit - start), opts: from ? { from: by } : undefined });
      if (toss && by) later.push({ at: start, name: toss, w: by });
    }
  },
  // Arrow Shower's arrows (roBrowser ef_arrow_shower_projectile): RAIN_ARROWS of them at once from the user to
  // spots up to RAIN_SPREAD cells off the target cell's middle, each flying the last MOB_PROJECTILE_MS before
  // the damage lands at `at`. A skill with a `strike` (Thunderstorm): that, once for every hit (n of them, gap
  // ms apart), anywhere up to `area` cells off the middle.
  rain(name, w, spot, at, area, n, gap) {
    const { strike, lead, still } = SKILL_EFFECTS[name] || {};
    if (still) return;
    if (strike) {
      const [x, y] = spot.cell, rand = () => (Math.random() * 2 - 1) * area;
      for (let i = 0; i < n; i++) later.push({ at: at + i * gap - lead, name: strike, w: W.field.spot(x + rand(), y + rand()) });
      return;
    }
    const [x, y] = spot.cell, rand = () => (Math.random() * 2 - 1) * RAIN_SPREAD;
    for (let i = 0; i < RAIN_ARROWS; i++)
      flying.push({ by: null, from: w, to: { w: W.field.spot(x + rand(), y + rand()), top: 0 }, t0: at - MOB_PROJECTILE_MS, at, skill: true });
  },
  // a status skill took hold on w
  success(name, w, t) { for (const fx of (SKILL_EFFECTS[name] || {}).success || []) E.play(fx, w, t); },
  // unit u starts casting (target: the mover or floor spot it is cast at); its effects go when the cast does
  cast(u, sk, target, t, ct, ground) { casting.push({ unit: u, cast: u.cast, fx: castEffects(u.w, sk, target, t, ct, ground, u.cast.lv) }); },
  // a hit lands on unit h.to: its number (in red on one of the party), a multi-hit attack's running total above a
  // monster or a rival, the hit's sound (a character's weapon or the skill's own; a monster's hit sound) and effects
  hit(h, t) {
    // (taken: on one of the party's characters, in red; the rival team's take theirs as a monster does, in white, a
    // multi-hit attack's total in yellow over them — by request)
    const u = h.to, by = h.from, taken = u.isPc && u.side !== sim.RIVAL;
    // (on one hallucinating, the number shown is a random one of 1 to 5 digits: clif_hallucination_damage;
    // display only, off the fight's dice)
    const r = u.hallucinating && h.r.damage ? { ...h.r, damage: hallucinated() } : h.r;
    // (one under Sacrifice: no number, its crusader showing it instead, by request)
    if (!h.r.devoted) floats.push({ t0: t, r, w: u.w, top: u.isPc ? PC_TOP : u.top, taken, dir: awayFrom(by.w, u.w) });
    if (h.r.devotion) return;  // (a crusader taking a hit for another under its Sacrifice: only the number)
    if (h.r.guard && h.first) E.play('EF_GUARD', u.w, t, undefined, { from: by.w });  // (Auto Guard blocked it: clif_skill_nodamage CR_AUTOGUARD)
    // (Kyrie Eleison stopped some of it: Auto Guard's shield toward the attacker, by request, kyrie_guard.wav being Kyrie's own)
    if (h.r.kyrie && h.first) E.play('EF_GUARD', u.w, t, undefined, { from: by.w });
    if (h.combo && !h.combo.apart && !taken) {  // count the total up in one number, shown from the first hit on (roBrowser: COMBO); it floats away after the last hit
      let k = combos.get(h.combo);
      if (!k) combos.set(h.combo, k = { sum: 0, left: h.combo.n, float: null });
      k.sum += h.r.damage; k.left--;
      if (!k.float) floats.push(k.float = { t0: t, r: { type: 'combo', damage: 0 }, w: u.w, top: u.isPc ? PC_TOP : u.top, combo: h.combo });
      Object.assign(k.float, { t1: t, done: k.left === 0 });
      k.float.r.damage = k.sum;
    }
    if (h.r.damage > 0) {
      // the skill's own hit sound if it has one; magic has no weapon sound
      // (a `hitSound` of null: none at all)
      const own = h.skill && SKILL_EFFECTS[h.skill.name] || {}, hitSound = own.hitSound;
      if (!by.isPc) api.playMobHit();
      else if ('hitSound' in own) { if (hitSound === 'fist') api.playHit(null); else if (hitSound) api.playSound(hitSound); }
      else if (!(h.skill && h.skill.type === 'Magic')) api.playHit(by.look.ch.weapon && by.look.held);
    }
    // (a skill's sounds one with each of its hits, the k-th the k-th, a miss too: Raging Trifecta Blow's)
    const hitSounds = h.skill && (SKILL_EFFECTS[h.skill.name] || {}).hitSounds;
    if (hitSounds) api.playSound(hitSounds[Math.min(h.k || 0, hitSounds.length - 1)]);
    if (h.skill && h.r.damage > 0) skillHit(h.skill.name, u.w, t, by.w, u.isPc ? PC_TOP : u.top, h.first);
    const spin = h.skill && h.r.damage > 0 && (SKILL_EFFECTS[h.skill.name] || {}).spin;
    // (display only: walker.js; back as it was after its last hit, whatever of it did not land)
    if (spin) u.w.spin = h.combo && W.hits.some(x => x.combo === h.combo) ? ((u.w.spin || 0) + spin) % 8 : 0;  // (on a character too: a monster's)
    if (u.isPc) return;
    if (h.r.damage > 0 && (!h.skill || PUNCHES.has(h.skill.name))) E.play('EF_HIT', u.w, t, undefined, { from: by.w });
    if (h.r.type === 'crit') E.play(CRIT_EFFECT, u.w, t);
  },
  // HP restored rises above the unit in green (SP, r.sp: in blue)
  heal(u, r, t) { floats.push({ t0: t, r, w: u.w, top: u.isPc ? PC_TOP : u.top }); if (!r.sp) healed.add(u); },
  hp(u) { if (u.isPc) hooks.hp(u); },
  // a character's status changed
  status(c) { hooks.status(c); },
  sit(c) { hooks.sit(c); },
  // a character opened or closed its shop (Vending: drawn in render, see drawShop)
  vending(c) { hooks.vending(c); },
  // 自動 follows another of the character's tactics (or none)
  rule(c) { hooks.rule(c); },
  // an alchemist's homunculus made (sim.js callHomun): sandbox.js remembers it
  homun(c) { hooks.homun && hooks.homun(c); },
  // character c took up another weapon (sim.holdBow): its sprites again
  weapon(c) { api.loadLook(c.look, () => hooks.look(c)); },
  freeze(m, t, ms) { frozenFx.set(m, E.play('EF_ICEBLOCK', m.w, t, ms)); },
  // stunned: the stars over its head until it comes to
  stun(u, t) { stunFx.set(u, E.play('EF_STUN', u.w, t, u.stunned.until - t, { head: u.isPc ? PC_TOP : u.top })); },
  unstun(u, t) {
    E.stop(stunFx.get(u), t);
    stunFx.delete(u);
  },
  // asleep, cursed: their sprite over its head while it lasts (a curse also darkens it red: see drawPc)
  sleep(u, t) { sleepFx.set(u, E.play('EF_SLEEP', u.w, t, u.asleep.until - t, { head: u.isPc ? PC_TOP : u.top })); if (u.isPc) hooks.hp(u); },
  wake(u, t) { E.stop(sleepFx.get(u), t); sleepFx.delete(u); if (u.isPc) hooks.hp(u); },
  curse(u, t) { curseFx.set(u, E.play('EF_CURSE', u.w, t, u.curse.until - t, { head: u.isPc ? PC_TOP : u.top })); },
  uncurse(u, t) { E.stop(curseFx.get(u), t); curseFx.delete(u); },
  // held by Stop, hallucinating, an orc's head: shown on the HP line (and the head: see drawPc)
  stop(u) { if (u.isPc) hooks.hp(u); },
  unstop(u) { if (u.isPc) hooks.hp(u); },
  hallucinate(u) { if (u.isPc) hooks.hp(u); },
  unhallucinate(u) { if (u.isPc) hooks.hp(u); },
  orcish(u) { if (u.isPc) hooks.hp(u); },
  unorcish(u) { if (u.isPc) hooks.hp(u); },
  // turning to stone (roBrowser body state STONEWAIT: _stonecurse.wav), stone (STONE: its pose held), and
  // back (leaving STONE: _stone_explosion.wav); sandbox.js greys it (see drawMob)
  stoneWait(u) { api.playSound('_stonecurse.wav'); },
  // poisoned (roBrowser health state POISON: _poison.wav, the unit tinted 0.9, 0.4, 0.8 — see drawMob)
  poison() { api.playSound('_poison.wav'); },
  unpoison() {},
  // blind, silenced, confused: an emote over its head while it lasts (see ailBegin)
  blind(u, t) { ailBegin(u, 'blind', t); },
  unblind(u, t) { ailEnd(u, 'blind', t); },
  silence(u, t) { ailBegin(u, 'silenced', t); },
  unsilence(u, t) { ailEnd(u, 'silenced', t); },
  confuse(u, t) { ailBegin(u, 'confused', t); },
  unconfuse(u, t) { ailEnd(u, 'confused', t); },
  // an emote over its head, played once (clif_emotion: Signum Crucis' sweat)
  emotion(u, id, t) {
    const action = E.EMOTE_ACTION[id];
    if (action != null && action < 1000) E.play('EF_EMOTE', u.w, t, undefined, { head: u.isPc ? PC_TOP : u.top, action });
  },
  stone(u) { if (u.isPc) hooks.hp(u); },
  unstone(u, t, was) { if (was) api.playSound('_stone_explosion.wav'); if (u.isPc) hooks.hp(u); },
  thaw(m, t) {
    E.stop(frozenFx.get(m), t);
    frozenFx.delete(m);
    E.play('EF_ICEBREAK', m.w, t);
  },
  // a fire wall's cells burn (one sound for them all) until they go out
  wall(wall, t) {
    wall.cells.forEach((cell, i) => wallFx.set(cell, E.play('EF_FIREWALL', W.field.spot(cell.x, cell.y), t, wall.until - t, { silent: i > 0 })));
  },
  // an ice wall's cells stand till each is gone (EF_ICEWALL, one sound for them all)
  ice(n, t) { n.cells.forEach((cell, i) => iceFx.set(cell, E.play('EF_ICEWALL', W.field.spot(cell.x, cell.y), t, null, { silent: i > 0 }))); },
  iceOut(cell, t) {
    E.stop(iceFx.get(cell), t);
    iceFx.delete(cell);
  },
  // a safety wall stands on its cell until it is gone
  guard(g, t) { guardFx.set(g, E.play('EF_SAFETYWALL', W.field.spot(g.x, g.y), t, g.until - t)); },
  guardOut(g, t) {
    E.stop(guardFx.get(g), t);
    guardFx.delete(g);
  },
  // a pneuma stands over its 3×3 until it is gone
  pneuma(n, t) { pneumaFx.set(n, E.play('EF_PNEUMA', W.field.spot(n.x, n.y), t)); },
  pneumaOut(n, t) {
    E.stop(pneumaFx.get(n), t);
    pneumaFx.delete(n);
  },
  // a warp portal: its rings while it waits, then the open portal until it is gone
  warp(n, t) { warpFx.set(n, E.play('EF_READYPORTAL', W.field.spot(n.x, n.y), t, n.open - t)); },
  warpOpen(n, t) { warpFx.set(n, E.play('EF_PORTAL', W.field.spot(n.x, n.y), t, n.until - t)); },
  warpOut(n, t) {
    E.stop(warpFx.get(n), t);
    warpFx.delete(n);
  },
  // a trap (its model) on its cell until it goes; set off, its effect where it was (Sandman's sleep dust, Skid Trap's)
  // (Skid Trap's arrow, west as converted, turned the way it pushes: from where its setter stood, one of the 8 ways —
  // west when set on that cell, as sim.js springTrap)
  trap(n, t) {
    const [dx, dy] = n.sk.name === 'HT_SKIDTRAP' && (n.x !== n.from[0] || n.y !== n.from[1]) ? [n.x - n.from[0], n.y - n.from[1]] : [-1, 0];
    const yaw = Math.round(Math.atan2(-dy, -dx) / (Math.PI / 4)) * Math.PI / 4;
    trapFx.set(n, E.play(TRAP_FX[n.sk.name][0], W.field.spot(n.x, n.y), t, n.until - t, { yaw }));
  },
  trapOut(n, t, sprung) {
    E.stop(trapFx.get(n), t);
    trapFx.delete(n);
    if (sprung && TRAP_FX[n.sk.name][1]) E.play(TRAP_FX[n.sk.name][1], W.field.spot(n.x, n.y), t);
  },
  // Venom Dust: each of its cells sparkles until it goes
  dust(n, t) { dustFx.set(n, n.cells.map(([x, y]) => E.play('EF_VENOMDUST2', W.field.spot(x, y), t))); },
  dustOut(n, t) {
    for (const fx of dustFx.get(n) || []) E.stop(fx, t);
    dustFx.delete(n);
  },
  // Sanctuary: each of its cells glows green until it goes (its heals and hits: AL_HEAL's success, the damage)
  sanct(n, t) { sanctFx.set(n, n.cells.map(([x, y]) => E.play('EF_BOTTOM_SANC', W.field.spot(x, y), t, n.until - t))); },
  sanctOut(n, t) {
    for (const fx of sanctFx.get(n) || []) E.stop(fx, t);
    sanctFx.delete(n);
  },
  // Magnus Exorcismus: each of its cells glows red until it goes (its hits: PR_MAGNUS's hit effect)
  magnus(n, t) { magnusFx.set(n, n.cells.map(([x, y]) => E.play('EF_BOTTOM_MAG', W.field.spot(x, y), t, n.until - t))); },
  magnusOut(n, t) {
    for (const fx of magnusFx.get(n) || []) E.stop(fx, t);
    magnusFx.delete(n);
  },
  // Bomb: its fire until it goes (roBrowser's unit effect 302, EF_DEMONSTRATION, one on its cell), by request on each
  // cell of the 3×3 it burns, each at its own point of the loop, spreading (by request): its cell first, the four next
  // to it BOMB_SPREAD_MS later, the corners as long again, each growing from BOMB_GROW of its size and fading in over
  // BOMB_GROW_MS (the fire burns all of it from the start: sim.js bombTurn); the bottle breaking and the fire's sound as
  // it lands (EF_FIREBOTTLE_LAND)
  bomb(n, t) {
    const fx = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const off = Math.random() * BOMB_LOOP_MS, at = t + (Math.abs(dx) + Math.abs(dy)) * BOMB_SPREAD_MS;
      fx.push(E.play('EF_DEMONSTRATION_CELL', W.field.spot(n.x + dx, n.y + dy), at - off, n.until - at + off, { born: at, grow: [BOMB_GROW_MS, BOMB_GROW] }));
    }
    E.play('EF_FIREBOTTLE_LAND', W.field.spot(n.x, n.y), t);
    bombFx.set(n, fx);
  },
  bombOut(n, t) {
    for (const fx of bombFx.get(n) || []) E.stop(fx, t);
    bombFx.delete(n);
  },
  // Storm Gust: its storm where it is cast (roBrowser effect 89), cut short if it goes early (its hits: WZ_STORMGUST's hit effect)
  storm(n, t) { stormFx.set(n, E.play('EF_STORMGUST', W.field.spot(n.x, n.y), t)); },
  stormOut(n, t) {
    if (t < n.until) E.stop(stormFx.get(n), t);
    stormFx.delete(n);
  },
  // Quagmire: each of its cells bubbling with mud until it goes (roBrowser's ground effect 95 on each of its units),
  // one sound for them all
  quag(n, t) { quagFx.set(n, n.cells.map(([x, y], i) => E.play('EF_QUAGMIRE', W.field.spot(x, y), t, n.until - t, { silent: i > 0 }))); },
  // (by request not in step with the cells: on about FIELD_SHARE of them, but every one on its edge so that its reach
  // shows, anywhere up to FIELD_OFF cells off its middle, each FIELD_SIZE [low, high] times its size at random;
  // roBrowser one on every cell's middle, all alike)
  field(n, t) {
    const lp = n.sk.name === 'SA_LANDPROTECTOR', name = FIELD_FX[n.sk.name];
    const r = Math.max(...n.cells.map(([x, y]) => Math.max(Math.abs(x - n.x), Math.abs(y - n.y))));
    const edge = ([x, y]) => Math.max(Math.abs(x - n.x), Math.abs(y - n.y)) === r;
    fieldFx.set(n, n.cells.filter(c => edge(c) || Math.random() < FIELD_SHARE).map(([x, y]) => {
      const s = W.field.spot(x, y), dx = (Math.random() * 2 - 1) * FIELD_OFF, dy = (Math.random() * 2 - 1) * FIELD_OFF;
      const f = FIELD_SIZE[0] + Math.random() * (FIELD_SIZE[1] - FIELD_SIZE[0]);
      const w = { ...s, worldPosition: out => s.groundAt(dx, dy, out), groundAt: (a, b, out) => s.groundAt(dx + a, dy + b, out) };
      return E.play(name, w, t, n.until - t, { silent: true, ...lp ? { size: E.EFFECTS[name].layers[0].size * f } : { scale: f } });
    }));
  },
  fieldOut(n, t) {
    for (const fx of fieldFx.get(n) || []) E.stop(fx, t);
    fieldFx.delete(n);
  },
  quagOut(n, t) {
    for (const fx of quagFx.get(n) || []) E.stop(fx, t);
    quagFx.delete(n);
  },
  // Fiber Lock's web on its cell until it goes; who it holds shows it on the HP line
  web(n, t) { webFx.set(n, E.play('EF_SPIDERWEB', W.field.spot(n.x, n.y), t, n.until - t)); },
  webOut(n, t) {
    E.stop(webFx.get(n), t);
    webFx.delete(n);
  },
  webbed(u) { if (u.isPc) hooks.hp(u); },
  // Ankle Snare catching unit u: its sound where the trap is (the trap stays while it holds)
  snared(u, n, t) { E.play('EF_ANKLESNARE', W.field.spot(n.x, n.y), t); if (u.isPc) hooks.hp(u); },
  unsnared(u) { if (u.isPc) hooks.hp(u); },
  unwebbed(u) { if (u.isPc) hooks.hp(u); },
  // a monster the fight brought in (a slave, an egg's brood: its sprite loaded with its summoner's, mobSprites), and
  // one turned into another (Metamorphosis: drawn anew, its new sprite)
  // (one whose sprite is not in yet, shown once it is: by report, a homunculus brought back out as the party comes in,
  // sim.js resetWorld, showed only its shadow)
  // (its sprite failing to load, asked for again every SPRITE_RETRY_MS while it is on the field: by report, a summon
  // left a shadow for good)
  spawn(m) {
    const spr = loadedSprite(m.def.sprite);
    if (spr) return void showMob(m, spr);
    const tryLoad = () => mobSprite(m.def.sprite).then(s => {
      if (!W.mobs.includes(m) || m.dead != null || m.spr) return;
      if (s) showMob(m, s); else setTimeout(tryLoad, SPRITE_RETRY_MS);
    });
    tryLoad();
  },
  morph(m) { A.remove(m.w); showMob(m, loadedSprite(m.def.sprite)); },
  // a unit teleported away from `at` (see teleporting)
  teleport(u, at, t, cast, pose) { teleportBegin(u, at, t, cast, pose); },
  cellOut(cell, t) {
    if (wallFx.has(cell)) E.stop(wallFx.get(cell), t);
    wallFx.delete(cell);
  },
  // a monster's attack on character c: a ranged one's projectile flies for every hit
  mobAttack(m, c, at, n, gap) {
    const img = MOB_PROJECTILE[m.def.sprite];
    for (let i = 0; img && i < n; i++) {
      const hit = at + i * gap;
      flying.push({ by: m, from: m.w, to: c, t0: hit - MOB_PROJECTILE_MS, at: hit, skill: true, img, fromTop: m.top / 2 });
    }
  },
  // a monster is gone
  removed(m) {
    if (frozenFx.has(m)) E.stop(frozenFx.get(m), W.t);
    frozenFx.delete(m);
    if (stunFx.has(m)) E.stop(stunFx.get(m), W.t);
    stunFx.delete(m);
    for (const fx of [sleepFx, curseFx]) { if (fx.has(m)) E.stop(fx.get(m), W.t); fx.delete(m); }
    if (ailFx.has(m)) E.stop(ailFx.get(m).fx, W.t);
    ailFx.delete(m);
    A.remove(m.w);
  },
  // character c gained (or, dying, lost) EXP; up / jobUp: its base / job level went up, which the client
  // marks with an angel over it / a job level up effect
  exp(c, base, job, t, up, jobUp) {
    if (up) E.play('EF_ANGEL', c.w, t);
    if (jobUp) E.play('EF_JOBLVUP', c.w, t);
    hooks.exp(c, up, jobUp);
  },
  // the clock was reset
  reset() { floats = []; later = []; flying = []; songNow = null; if (api.playSong) api.playSong(null); },
};
export const emit = (type, ...args) => EVENTS[type](...args);
// a damage number as one hallucinating sees it (clif_hallucination_damage): below 10, 100, 1000, 10000 or 32767,
// each as likely
const hallucinated = () => Math.floor(Math.random() * [10, 100, 1000, 10000, 32767][Math.floor(Math.random() * 5)]);
// A blind, silenced or confused unit shows it over its head (EF_BLIND, EF_SILENCE, EF_CONFUSE, with its sound),
// one at a time: the one that began last; as that one ends, the one before it shows again, silently, for what is
// left of it.
const AIL_FX = { blind: 'EF_BLIND', silenced: 'EF_SILENCE', confused: 'EF_CONFUSE' };
function ailBegin(u, kind, t) {
  const a = ailFx.get(u) || { kinds: [], kind: null, fx: null };
  a.kinds = [...a.kinds.filter(k => k !== kind), kind];
  ailFx.set(u, a);
  ailShow(u, a, t, true);
}
function ailEnd(u, kind, t) {
  const a = ailFx.get(u);
  if (!a) return;
  a.kinds = a.kinds.filter(k => k !== kind);
  if (a.kind === kind) ailShow(u, a, t, false);
}
function ailShow(u, a, t, fresh) {
  if (a.fx) E.stop(a.fx, t);
  a.kind = a.kinds[a.kinds.length - 1] || null;
  a.fx = a.kind && E.play(AIL_FX[a.kind], u.w, t, u[a.kind].until - t, { head: u.isPc ? PC_TOP : u.top, silent: !fresh });
  if (!a.kind) ailFx.delete(u);
}
// what goes on after the fight's step at time t
// the statuses with an effect of their own show it while they last: started as one begins (a new sc entry,
// also when the skill is used again), stopped as it ends, early or not (death, the unit gone)
// A song's ground (BD_PERFORMING's song) put in place of another's by the same player (or by an ensemble's partner) comes
// in once that one has faded out (E.TILE_FADE_MS; by request, not the two at once)
const songOff = new WeakMap();  // a player's walker → when its last song's ground began to fade out
// The songs' music: only the last song played on the field (sim's W.songs, newest last) is heard, from its start, in place
// of the one before (by request: not all at once); as it ends, the one played before it still going is heard again from
// its start, and with none left, nothing
let songNow = null;  // the W.songs entry whose music is playing
function songMusic() {
  const n = W.songs[W.songs.length - 1] || null;
  if (n === songNow) return;
  songNow = n;
  if (api.playSong) api.playSong(n && (E.EFFECTS['EF_SONG_' + n.sk.name] || {}).music || null);
}
function statusEffects(t) {
  const on = [];
  for (const u of [...sim.everyChar(), ...W.mobs]) for (const s of u.sc) {
    const name = s.song ? 'EF_SONG_' + s.song : (SKILL_EFFECTS[s.name] || {}).status;
    if (name && t < s.until) on.push([u, s, name]);
  }
  const live = new Set(on.map(([, s]) => s));
  for (const [s, fx] of statusFx) if (!live.has(s)) {
    E.stop(fx, t);
    statusFx.delete(s);
    if (s.song && fx) songOff.set(fx.w, t);
  }
  for (const [u, s, name] of on) if (!statusFx.has(s)) {
    // (an ensemble's: once its partner's too has faded out, a song it was playing alone)
    const n = s.song && W.songs.find(x => x.by === u), off = Math.max(...[u, n && n.with].map(x => (x && songOff.get(x.w)) ?? -Infinity));
    const at = s.song ? Math.min(s.until, Math.max(t, off + E.TILE_FADE_MS)) : t;
    const fx = E.play(name, u.w, at, s.until - at, s.by ? { from: s.by.w } : undefined);  // (Sacrifice's line: from its crusader)
    if (s.song && fx) fx.clash = (x, y) => sim.songClash(u, x, y);  // (cells turned into Unchained Serenade or Hip Shaker)
    statusFx.set(s, fx);
  }
}
// a character's spirit spheres go round it (EF_SPHERES), evenly round as many as it has, coming, going and moving round
// as that changes (E.setOrbs); the effect stays with it from its first on, gone once it has left the fight
function spheres(t) {
  for (const c of sim.everyChar()) {
    const n = Math.min(5, sim.spheresOf(c)), was = sphereFx.get(c);
    if ((was ? was.n : 0) === n) continue;
    const x = was || { fx: E.play('EF_SPHERES', c.w, t, 1e9) };
    x.n = n;
    E.setOrbs(x.fx, n, t);
    sphereFx.set(c, x);
  }
  for (const [c, x] of sphereFx) if (!sim.everyChar().includes(c)) { E.stop(x.fx, t); sphereFx.delete(c); }
}
// a unit in hiding is not drawn (roBrowser: EffectState HIDE, alpha 0); the party's own are, faintly, so the
// player can still see where they are (by eye). Going into hiding it sinks HIDE_LIFT cells down and fades out all
// the way over HIDE_MS (speeding up as it sinks), with EF_HIDE; a character's faint figure then fades in slowly
// where it stood over GHOST_MS. Coming out, that faint figure first fades out over GHOST_OUT_MS; then it rises
// back up from HIDE_LIFT below, fading in as it rises, over UNHIDE_MS (slowing as it comes up), with EF_UNHIDE (a
// monster, with no figure to fade out, rises at once). (It leapt up and dropped back at first; turned round by request.) Not in roBrowser (by request); none of it for one that dies.
const HIDDEN_PC_ALPHA = 0.35, HIDE_LIFT = 0.4, HIDE_MS = 250, GHOST_MS = 600, GHOST_OUT_MS = 150, UNHIDE_MS = 200;
const hideAnim = new WeakMap();  // unit → { on (in hiding), t0 (when that last changed), from (its alpha then) }
// unit u is going into hiding at time t (drawPc: LEAP_GROUP's pose)
const leaping = (u, t) => { const a = hideAnim.get(u); return !!a && a.on && t >= a.t0 && t - a.t0 < HIDE_MS; };
const LEAP_GROUP = 5;  // the bare-handed attack
function hiding(t) {
  for (const u of [...sim.everyChar(), ...W.mobs]) {
    if (!u.w) continue;
    // (a monster dying: its sprite with no depth test, so the floor cuts none of what its death throws out, an Elder
    // Willow's branches; by request: walker.js overFloor)
    u.w.overFloor = !u.isPc && u.dead != null;
    // (cloaked: as in hiding; a monster without sinking or the hiding's effects: roBrowser's CLOAK, alpha 0)
    const cloak = !sim.isHidden(u) && sim.isCloaked(u), on = sim.isHidden(u) || cloak;
    let a = hideAnim.get(u);
    if (!a || t < a.t0) hideAnim.set(u, a = { on, t0: -Infinity, from: 1 });  // (new, or the clock went back: settled)
    const pre = u.isPc ? GHOST_OUT_MS : 0;  // coming out: the faint figure's fade first
    if (a.on !== on) {
      Object.assign(a, { on, t0: u.dead == null ? t : -Infinity, from: u.w.alpha ?? 1 });
      // (a character's Cloaking too, by request; going in without the hiding's sound, Cloaking having its own,
      // assasin_cloaking.wav)
      if (u.dead == null && (!(cloak || a.cloak) || u.isPc))
        on ? E.play('EF_HIDE', u.w, t, undefined, { silent: cloak }) : later.push({ at: t + pre, name: 'EF_UNHIDE', w: u.w });
      // (coming out goes the way it went in; a character's Cloaking sinks and rises as Hiding does, by request)
      if (on) a.cloak = cloak && !u.isPc;
    }
    const el = t - a.t0;
    if (on) {
      const k = Math.min(1, el / HIDE_MS);
      u.w.lift = k < 1 && !a.cloak ? -HIDE_LIFT * k * k : 0;
      u.w.alpha = k < 1 ? a.from * (1 - k) : u.isPc ? HIDDEN_PC_ALPHA * Math.min(1, (el - HIDE_MS) / GHOST_MS) : 0;
    } else if (el < pre) {
      u.w.lift = 0;
      u.w.alpha = a.from * (1 - el / pre);
    } else {
      const k = Math.min(1, (el - pre) / UNHIDE_MS);
      u.w.lift = a.cloak ? 0 : -HIDE_LIFT * (1 - k) * (1 - k);
      u.w.alpha = k;
    }
    // a monster fades in as it comes in, and its corpse out before it goes (sim.js m.gone): by request
    if (!u.isPc) {
      const k = Math.min(1, (t - (u.shownAt ?? -Infinity)) / MOB_IN_MS, u.gone != null ? (u.gone - t) / MOB_OUT_MS : 1);
      u.w.alpha *= Math.max(0, k);
    }
  }
}
const MOB_IN_MS = 400, MOB_OUT_MS = 600;
// Teleporting (Teleport, a warp portal, a monster's Teleport): where it was, the unit's figure (standing; a
// character's own Teleport: casting) rises
// TP_UP cells and fades out over TP_OUT_MS (slowing as it rises), with EF_TELEPORT; then where it went
// EF_TELEPORT_LAND starts TP_LAND_LEAD ms before it shows, it drops from TP_DROP cells, fading in over TP_IN_MS
// (speeding up as it falls), and touches down with EF_TELEPORT_LAND fading out over TP_LAND_FADE_MS (by request) and its sound (a character's only: roBrowser plays it for
// characters coming into sight, not monsters). Not in roBrowser, which only plays
// effect 304 where it was (by request; the figure rose 1.5 cells at first). The name it shouts stays there too.
const TP_UP = 0.6, TP_DROP = 1.5, TP_OUT_MS = 400, TP_IN_MS = 400, TP_LAND_LEAD = 150, TP_LAND_FADE_MS = 100;
const tpAnim = new Map();  // unit → { t0, ghost (the figure left behind: its mover), land (its EF_TELEPORT_LAND) }
// (`pose`: a character leaves in that frame of that action group instead, held, without the slash trail: Snatch's)
function teleportBegin(u, at, t, cast, pose = null) {
  E.play('EF_TELEPORT', at, t);
  // the skill's name, shouted just now, stays over where it was (by request)
  for (const f of floats) if (f.text && f.w === u.w && f.t0 === t) f.w = at;
  const old = tpAnim.get(u);
  if (old) A.remove(old.ghost);
  const ghost = { ...at, heading: [...u.w.heading], clock: 0, alpha: 1, lift: 0 };
  // a character that teleported itself plays the casting pose (詠唱) as it rises, held on its last frame (by
  // request); one a portal sends off stands
  if (u.isPc) A.show(ghost, keyed((g, group, dir, clock, same) => {
    const body = u.look.ch.body, grp = sim.castGroup({ name: 'AL_TELEPORT' });
    if (!body) return false;
    if (pose) {
      const ch = { ...u.look.ch, fx: null };
      if (!same(`${pose.group * 8 + dir}:${pose.fi}:${chKey(ch)}`)) api.drawHuman(g, pose.group * 8 + dir, pose.fi, ch);
      return true;
    }
    const act = cast && body.act.actions[grp * 8 + dir];
    if (!act || !act.frames.length) { if (!same(`${dir}:0:${chKey(u.look.ch)}`)) api.drawHuman(g, dir, 0, u.look.ch); return true; }
    const fi = Math.min(act.frames.length - 1, Math.floor(Math.max(0, W.t - t) / Math.max(1, act.delay_ms || 100)));
    if (!same(`${grp * 8 + dir}:${fi}:${chKey(u.look.ch)}`)) api.drawHuman(g, grp * 8 + dir, fi, u.look.ch);
    return true;
  }), true);
  else A.show(ghost, keyed((g, group, dir, clock, same) => {
    const acts = u.spr.act.actions, act = acts[dir] || acts[0];
    if (!act || !act.frames.length) return false;
    if (!same(`${act === acts[dir] ? dir : 0}:${idOf(u.spr)}`)) api.drawFrame(u.spr, act.frames[0], 0, 0, null, g);
    return true;
  }), false, spriteBox(u.spr));
  tpAnim.set(u, { t0: t, ghost });
}
// Character u teleporting away for good at time t, now or to come (the game's way between the town and a map: by
// request): as its own Teleport, the skill's name shouted (not when quiet), the casting pose as it rises and fades where it stands
// (above), and it stays unseen (no landing) until restart
export function depart(u, t, quiet = false) {
  tpAnim.set(u, { t0: t, ghost: null, leave: true, quiet });
}
function leave(u, t) {
  const sk = db.skills.AL_TELEPORT || {};
  if (!tpAnim.get(u).quiet) EVENTS.say(u.w, (sk.zh || sk.en || 'Teleport') + '!!', t);
  teleportBegin(u, W.field.spot(...u.w.cell), t, true);
  tpAnim.get(u).away = true;
}
// Character u teleporting in where it stands (the game's town: by request): only the landing above, its
// EF_TELEPORT_LAND at time t (unseen until then, even if t is still to come)
export function arrive(u, t) {
  tpAnim.set(u, { t0: t - (TP_OUT_MS - TP_LAND_LEAD), ghost: null, arrive: true });
}
// (after hiding, which settles every unit's lift and alpha first)
function teleporting(t) {
  for (const [u, a] of tpAnim) {
    const el = t - a.t0;
    if (a.leave && u.w && u.dead == null) { if (el >= 0) leave(u, a.t0); continue; }  // (as it stands till then)
    if (el < 0 && !a.arrive || !u.w || u.dead != null) { if (a.ghost) A.remove(a.ghost); tpAnim.delete(u); continue; }  // (the clock went back, or it is gone)
    if (a.away) {
      if (a.ghost && el < TP_OUT_MS) { const k = el / TP_OUT_MS; a.ghost.lift = TP_UP * (1 - (1 - k) * (1 - k)); a.ghost.alpha = 1 - k; }
      else if (a.ghost) { A.remove(a.ghost); a.ghost = null; }
      u.w.alpha = 0;
      continue;
    }
    if (a.land === undefined && el >= TP_OUT_MS - TP_LAND_LEAD) a.land = E.play('EF_TELEPORT_LAND', u.w, a.t0 + TP_OUT_MS - TP_LAND_LEAD, undefined, { silent: !u.isPc });
    if (el < TP_OUT_MS) {
      const k = el / TP_OUT_MS;
      if (a.ghost) { a.ghost.lift = TP_UP * (1 - (1 - k) * (1 - k)); a.ghost.alpha = 1 - k; }
      u.w.alpha = 0;
      continue;
    }
    if (a.ghost) { A.remove(a.ghost); a.ghost = null; }
    const k = (el - TP_OUT_MS) / TP_IN_MS;
    if (k >= 1) { E.fade(a.land, a.t0 + TP_OUT_MS + TP_IN_MS, TP_LAND_FADE_MS); tpAnim.delete(u); continue; }
    u.w.lift = TP_DROP * (1 - k * k);
    u.w.alpha = k;
  }
}
// a safety wall's glow fades as it wears down: by the share it has left of its hits or its HP (the less), to
// GUARD_FADED when it is all but gone (by request)
const GUARD_FADED = 0.3;
function guardFade() {
  for (const [g, fx] of guardFx) if (fx) fx.alpha = GUARD_FADED + (1 - GUARD_FADED) * Math.min(g.hits / g.full.hits, Math.max(0, g.hp) / g.full.hp);
}
function afterStep(t) {
  statusEffects(t);
  songMusic();
  spheres(t);
  guardFade();
  hiding(t);
  teleporting(t);
  for (const e of later) if (t >= e.at) E.play(e.name, e.w, e.at, e.duration, e.opts);
  later = later.filter(e => t < e.at);
  flying = flying.filter(a => t < a.at);
  // a running total whose remaining hits will never land (the monster died first, the swing was cut off,
  // the character left) floats away now instead of staying up for good
  for (const f of floats)
    if (f.combo && !f.done && !W.hits.some(h => h.combo === f.combo)) Object.assign(f, { done: true, t1: t });
  stopCasts(t);
  // (a name held for a cast: the cast is over, done or cut off)
  for (const f of floats) if (f.cast && ![...sim.everyChar(), ...W.mobs].some(u => u.cast === f.cast)) Object.assign(f, { t0: t, cast: null });
  floats = floats.filter(f => f.r && f.r.type === 'combo' ? !f.done || t - f.t1 < FLOAT_MS : f.cast || t - f.t0 < (f.chat ? CHAT_MS : f.text ? LABEL_MS : FLOAT_MS));
  hooks.afterStep(t);
}
// how the fight's timing reads the sprites (see sim.js)
export const motion = {
  ready: c => !!c.look.ch.body,
  attackGroup: c => api.attackGroup(c.look.ch),
  pc: attackMotion,
  mob: (m, grp) => actionInfo(m.spr, grp),
  // (whether monster def's sprite is in, to bring one in: Hocus-Pocus's, sim.randomMob)
  has: def => loaded.has(def.sprite),
  // the hit lands on the frame the ACT marks 'atk' (most monsters have it); without one, on the last frame
  // with a sound, the attack's own (the Zombie spits its green burst with ghoul_attack4 on frame 16 of
  // 19); with no sound at all, at 60% of the animation
  mobAttack(m) {
    const { n, delay, frames } = actionInfo(m.spr, 2);
    const sounded = frames.map((f, i) => f.sound != null && f.sound >= 0 ? i : -1).filter(i => i >= 0);
    let hf = frames.findIndex(f => f.sound != null && m.spr.act.sounds[f.sound] === 'atk');
    if (hf < 0) hf = sounded.length ? sounded[sounded.length - 1] : Math.floor(n * 0.6);
    return { n, delay, hf };
  },
};

// which way on screen a damage number flies: on from the attacker past the one hit (+1 right, −1 left;
// right when one stands straight above the other), fixed when the hit lands
function awayFrom(from, to) {
  const dx = A.anchor(to).x - A.anchor(from).x;
  return dx < 0 ? -1 : 1;
}

// ---------- monsters ----------
const sprites = new Map();  // path → Promise of the loaded sprite
export function mobSprite(name) {
  const path = 'png/monster/' + name;
  // (null: it could not be loaded, e.g. offline and not saved; asked for again next time)
  if (!sprites.has(path)) sprites.set(path, new Promise(res => api.loadSprite('mob:' + path, path, null, spr => { loaded.set(name, spr); res(spr); })
    .catch(() => { sprites.delete(path); res(null); })));
  return sprites.get(path);
}
const loaded = new Map();  // sprite name → the sprite, once it is in (mobSprite)
const SPRITE_RETRY_MS = 3000;
export const loadedSprite = name => loaded.get(name);
// sprite px from the feet to the top of the standing pose (where numbers start)
function spriteTop(spr) {
  const f = api.frameOf(spr, 0, 0);
  let top = 20;
  for (const l of (f && f.layers) || []) {
    const im = l.file && api.img(spr.path + '/' + l.file);
    if (im && im.naturalHeight) top = Math.max(top, -l.y + im.naturalHeight / 2 * ((l.scale && l.scale[1]) || 1));
  }
  return top;
}
// the canvas a monster's frames all fit on (walker.js Figure box): every layer of every frame, at its offset
// and scale (a turned one by its diagonal), with a few px to spare; never smaller than the default (256 square,
// feet 200 down). A death can throw pieces far out (Willow's: 400 px to either side).
function spriteBox(spr) {
  let side = 128, up = 200, down = 56;
  for (const a of spr.act.actions) for (const f of a.frames) for (const l of f.layers) {
    const im = l.file && api.img(spr.path + '/' + l.file);
    if (!im || !im.naturalWidth) continue;
    const [sx, sy] = l.scale || [1, 1];
    let hw = im.naturalWidth * Math.abs(sx) / 2, hh = im.naturalHeight * Math.abs(sy) / 2;
    if (l.angle) hw = hh = Math.hypot(hw, hh);
    side = Math.max(side, Math.abs(l.x) + hw + 4);
    up = Math.max(up, -l.y + hh + 4);
    down = Math.max(down, l.y + hh + 4);
  }
  return { w: 2 * Math.ceil(side), h: Math.ceil(up) + Math.ceil(down), feet: Math.ceil(up) };
}
export async function addMob(def) {
  await mobSprites(def);
  return placeMob(def, loadedSprite(def.sprite));
}
// monster def's sprite and those of what it may summon or hatch into (sim.spritesOf), all loaded
export const mobSprites = def => Promise.all([...sim.spritesOf(def)].map(mobSprite));
// monster def in the fight at once, with its sprite spr (loaded)
export function placeMob(def, spr) {
  return showMob(sim.addMob(def), spr);
}
// monster m shown, with its sprite spr (loaded): as it is added, as the fight brings one in (a slave, an egg's brood:
// EVENTS.spawn), and again as it turns into another (EVENTS.morph)
function showMob(m, spr) {
  (m.def.skills || []).forEach(r => preloadSkill(r.skill));
  (m.def.drops || []).forEach(([id]) => itemSprite(id));  // (what a Steal takes flies at once: EVENTS.stolen)
  A.show(m.w, keyed((g, group, dir, clock, same) => drawMob(m, g, group, dir, clock, same)), false, spriteBox(spr));
  m.shownAt ??= W.t;         // when it came in (fading in from then: hiding; not again as it turns into another)
  m.spr = spr;               // its sprite, and px from its feet to the top of it
  m.top = spriteTop(spr);
  m.soundKey = null;         // the frame whose sound last played
  return m;
}
// frames of an action group (direction 0) and its frame delay
// (a sprite not in yet: one frame of 100 ms — a unit shown once its sprite is in, EVENTS.spawn)
function actionInfo(spr, grp) {
  if (!spr) return { n: 1, delay: 100, frames: [{ layers: [] }] };
  const a = spr.act.actions[grp * 8] || spr.act.actions[0];
  return { n: a.frames.length, delay: Math.max(1, a.delay_ms || 100), frames: a.frames };
}
// monsters whose attack flies to the target (roBrowser AttackEffectTable PROJECTILE: ef_arrow_projectile,
// ef_ragged_projectile, ef_stone_shooter_projectile, ef_wootan_shooter_projectile), for the last 140 ms before each hit
const bullet = name => `png/monster/${name}_bullet/frames/000.png`;
const MOB_PROJECTILE = { skel_archer: ARROW, ragged_zombie: bullet('ragged_zombie'), stone_shooter: bullet('stone_shooter'),
  wootan_shooter: bullet('wootan_shooter') };
const MOB_PROJECTILE_MS = 140;
const RAIN_ARROWS = 10, RAIN_SPREAD = 1.5;
// ---------- carts ----------
// A character that pulls a cart (Pushcart: sim.hasCart) has the client's cart (data/sprite/이팩트/손수레, converted to
// png/effect/손수레 with spr2png.py; roBrowser DB.getCartPath(1), the cart a Kafra rents) as a figure of its own,
// with its own shadow, that cannot be clicked. roBrowser glues it to the character (EntityRender: fixed sprite px
// beside the feet by direction, turning with it at once); here the character tows it (by request): the cart
// keeps CART_GAP cells from the character's feet, pulled straight after it, so it lags and swings wide round a
// turn. Turned back toward its cart (more than 90° off), the character swings it round behind itself at
// CART_SWING radians a second, on the nearer side. The cart faces along the bar to the character (its action is
// that direction: its 8 actions are roBrowser's action × 8 + direction modulo their count) and its wheels roll
// (the action's frames) while it moves, standing on the first frame otherwise. Moved further than CART_SNAP cells
// at once (a teleport, a warp portal) it comes along straight behind the character. It fades and rises with the
// character (hiding, a teleport's drop). Gap and swing by eye.
const CART = 'png/effect/손수레', CART_GAP = 1, CART_SWING = 2 * Math.PI, CART_SNAP = 3;
let cartSpr = null, cartClock = null;
let orcHead = null;  // 이팩트/orcface: the head of one under Grampus Morph
// Cart Revolution rams the cart into the target (by request): as the skill goes off the cart jumps onto the
// character's own spot and runs straight at where the target stood then, faster and faster (k²), striking it
// CART_RAM_SHORT cells short of that spot as the damage lands; it bounces back CART_BOUNCES times, each hop
// CART_BOUNCE_MS long, CART_HOP cells high and CART_BOUNCE_BACK cells back at first, half as much each time; then
// it rolls straight back past the character to CART_GAP behind it over CART_BACK_MS (eased in and out), and is
// towed again from there. By eye.
const CART_RAM_SHORT = 0.45, CART_BOUNCES = 2, CART_BOUNCE_MS = 120, CART_HOP = 0.12, CART_BOUNCE_BACK = 0.15, CART_BACK_MS = 350;
const cartPushes = new Map();  // character → { t0, at (when it strikes), aim (where the target stood) }
function pushCart(w, target, t, at) {
  const c = sim.everyChar().find(x => x.w === w);
  if (c && target) cartPushes.set(c, { t0: t, at: Math.max(at, t + 1), aim: [...target.pos] });
}
const CART_RAM_MS = CART_BOUNCES * CART_BOUNCE_MS + CART_BACK_MS;  // (from the strike to being towed again)
// where a rammed cart is at time t: s cells along the line from the character toward the aim (below 0: behind
// it), lift cells up
function ramAt(push, t, reach) {
  if (t < push.at) { const k = (t - push.t0) / (push.at - push.t0); return { s: reach * k * k, lift: 0 }; }
  let el = t - push.at, back = 0, hop = CART_HOP, step = CART_BOUNCE_BACK;
  for (let i = 0; i < CART_BOUNCES; i++, hop /= 2, step /= 2) {
    if (el < CART_BOUNCE_MS) { const u = el / CART_BOUNCE_MS; return { s: reach - back - step * u, lift: hop * Math.sin(Math.PI * u) }; }
    el -= CART_BOUNCE_MS;
    back += step;
  }
  const from = reach - back, u = Math.min(1, el / CART_BACK_MS), e = u * u * (3 - 2 * u);
  return { s: from + (-CART_GAP - from) * e, lift: 0 };
}
const carts = new Map();  // character (or a towing mover) → its cart: { map, pos, heading, clock, moving, alpha, lift, worldPosition }
// Movers that are not the party's characters towing a cart all the same (by request: game.js's townfolk actors, a
// merchant walking to its job change and back): tow(w, true) from when it shows, tow(w, false) once it goes
const towed = new Set();
export function tow(w, on) { if (on) towed.add(w); else towed.delete(w); }
function newCart(w) {
  const h = Math.hypot(...w.heading) || 1;
  const cart = { map: w.map, pos: [w.pos[0] - w.heading[0] / h * CART_GAP, w.pos[1] - w.heading[1] / h * CART_GAP],
                 heading: [...w.heading], clock: 0, moving: false, alpha: 1, lift: 0, path: [],
                 worldPosition(out) { return Mover.world(this.map, this.pos[0], this.pos[1], out); } };
  A.show(cart, keyed((g, group, dir, clock, same) => drawCart(g, group, dir, clock, same)), 'prop');
  return cart;
}
function drawCart(g, group, dir, clock, same) {
  const ai = cartSpr && dir % cartSpr.act.actions.length, act = cartSpr && cartSpr.act.actions[ai];
  if (!act || !act.frames.length) return false;
  const fi = group === 1 ? Math.floor(clock / Math.max(1, act.delay_ms || 100)) % act.frames.length : 0;
  if (same(`${ai}:${fi}:${idOf(cartSpr)}`)) return true;
  api.drawFrame(cartSpr, act.frames[fi], 0, 0, null, g);
  return true;
}
// every character's cart where its towing leaves it at time t
// ---------- falcons ----------
// A character with a falcon (Falconry Mastery: sim.hasFalcon) has the client's falcon (data/sprite/이팩트/매, converted to
// png/effect/매 with spr2png.py; roBrowser DB's 'xx_FALCON' path) as a figure of its own, no shadow, that cannot be clicked,
// FALCON_UP cells above the ground (roBrowser's gliding height, 5). roBrowser's companion (EntityWalk entitiesWalkProcess)
// sets off once a second at most when 2 cells or more away, flies to within 1 and glides (action group 1) on the way; here
// (by request) it always flaps (group 0, 8 frames) and follows smoothly: every frame it closes on the spot FALCON_NEAR
// cells from the character (on its own side) by 1 − e^(−dt / FALCON_TAU) of the way, but never faster than FALCON_FAST
// cells a second (so that it is seen flying back from afar, as after Blitz Beat), facing the way it moves while it
// moves faster than FALCON_TURN cells a second (hovering, it keeps its way). The character moved further than
// FALCON_SNAP cells at once (a teleport) it comes along at once. It flaps at FALCON_FLAP_MS a frame whichever way it
// faces (by report: the sprite's two ways away from the camera at a slant are 216 ms a frame, the rest 96). It fades with
// the character. By eye.
// Blitz Beat (by request: roBrowser flies it at the target at 35 ms a cell, 5 cells past it, still 5 up, gliding): it
// goes on as it was (following, or still looping round from the last one) until it is FALCON_DIVE cells a second from
// the target for the time left till the hit (at once if it is further: faster then), and then dives gliding (group 1)
// from where it is straight onto the target, FALCON_HIT cells up its body as the first hit lands,
// speeding up (from 0.75 its mean speed to 1.25 times it), speed lines along its dive on the target from the strike till
// BLITZ_LINES_TAIL after the last hit (EF_BLITZLINES, by request). Then, keeping that speed (FALCON_SWOOP at most), it flies on FALCON_OVER cells straight
// and loops round to the left or the right at random, FALCON_LOOP cells across (turning that way until it heads back
// toward the character), climbing back FALCON_CLIMB cells a second; flapping again it turns no faster to head for the
// spot beside the character, slowing as its following would (its distance / FALCON_TAU) once near, and follows as ever
// once that is under FALCON_FAST and it heads there. By eye.
const FALCON = 'png/effect/매', FALCON_UP = 5, FALCON_NEAR = 1, FALCON_TAU = 400, FALCON_FAST = 8, FALCON_SNAP = 10;
const FALCON_TURN = 0.5, FALCON_FLAP_MS = 96;
const BLITZ_LINES_TAIL = 100;  // ms the speed lines go on after the last hit
const FALCON_HIT = 1, FALCON_DIVE = 25, FALCON_SWOOP = 25, FALCON_OVER = 2, FALCON_LOOP = 2.5, FALCON_CLIMB = 6;
// Detect's flight (by request): the falcon flies fast once round the circle whose diameter runs from the character to
// SCOUT_BEHIND cells past the cell, to one side at random, gliding down to SCOUT_UP over the far end, which it passes as
// the skill takes hold (sim.js DETECT_LAUNCH: shot off fast, slowing to a stop as it gets round; its pace set by that); setting off from beside the character it draws onto the
// circle over the first quarter of it, and once round it follows the character as ever. As it passes the far end the wind
// of its wings blows dust out over the 7×7 (EF_DETECTWIND). By eye.
const SCOUT_UP = 3.5, SCOUT_BEHIND = 1.5;
// character → { t0, at (its first hit), aim (where the target stood), from (where the falcon set off); after the hit:
// a (its heading, radians), speed (cells a second), run (cells straight on so far), side (±1), turned (radians so far),
// home (heading back) }
const falconDives = new Map();
const falconNext = new Map();  // character → the dive it is to make next, not yet set off on: { t0, at, span (ms of its hits), aim, target }
let falconSpr = null, falconClock = null;
const falcons = new Map();  // character → its falcon: { map, pos, heading, clock, moving, alpha, lift, flat }
function newFalcon(c) {
  const w = c.w;
  const f = { map: w.map, pos: [...w.pos], heading: [...w.heading], clock: 0, moving: false, alpha: 1, lift: FALCON_UP, flat: true,
              path: [], worldPosition(out) { return Mover.world(this.map, this.pos[0], this.pos[1], out); } };
  A.show(f, keyed((g, group, dir, clock, same) => drawFalcon(g, group, dir, clock, same)), 'prop');
  return f;
}
function drawFalcon(g, group, dir, clock, same) {
  const ai = falconSpr && (group * 8 + dir) % falconSpr.act.actions.length, act = falconSpr && falconSpr.act.actions[ai];
  if (!act || !act.frames.length) return false;
  const fi = Math.floor(clock / FALCON_FLAP_MS) % act.frames.length;
  if (same(`${ai}:${fi}:${idOf(falconSpr)}`)) return true;
  api.drawFrame(falconSpr, act.frames[fi], 0, 0, null, g);
  return true;
}
// Detect's falcon (dive.high) at time t, round its circle (see SCOUT_UP); dive.done once round
function scout(dive, f, t, w) {
  if (!dive.ring) {
    const [ox, oy] = w.pos, [tx, ty] = dive.aim, L = Math.hypot(tx - ox, ty - oy) || 1;
    const far = [tx + (tx - ox) / L * SCOUT_BEHIND, ty + (ty - oy) / L * SCOUT_BEHIND], c = [(ox + far[0]) / 2, (oy + far[1]) / 2];
    dive.ring = { c, r: Math.hypot(far[0] - c[0], far[1] - c[1]), a0: Math.atan2(oy - c[1], ox - c[0]), s: Math.random() < 0.5 ? -1 : 1,
                  off: [dive.from.pos[0] - ox, dive.from.pos[1] - oy] };
  }
  const { c, r, a0, s, off } = dive.ring, u = Math.min(1, (t - dive.t0) / (dive.at - dive.t0) * (1 - Math.SQRT1_2));
  const phi = 2 * Math.PI * (1 - (1 - u) * (1 - u)), a = a0 + s * phi;
  const k = Math.max(0, 1 - phi / (Math.PI / 2)), drift = k * k * (3 - 2 * k);  // (from beside the character onto the circle)
  f.pos = [c[0] + Math.cos(a) * r + off[0] * drift, c[1] + Math.sin(a) * r + off[1] * drift];
  f.heading = [-Math.sin(a) * s, Math.cos(a) * s];
  f.lift = SCOUT_UP + (dive.from.lift - SCOUT_UP) * (1 - Math.sin(phi / 2));
  f.moving = true;
  if (phi >= Math.PI && !dive.blown) {
    dive.blown = true;
    E.play(dive.high, dive.target, t);
  }
  if (phi >= 2 * Math.PI) dive.done = true;
}
// every falcon where its flight leaves it at time t
function flyFalcons(t) {
  const dt = falconClock == null ? 0 : Math.max(0, Math.min(100, t - falconClock));
  falconClock = t;
  for (const [c, f] of falcons) if (!sim.everyChar().includes(c) || !sim.hasFalcon(c) || !c.w.pos) { A.remove(f); falcons.delete(c); }
  for (const c of sim.everyChar()) {
    if (!c.w || !c.w.pos || !sim.hasFalcon(c)) continue;
    let f = falcons.get(c);
    if (!f) falcons.set(c, f = newFalcon(c));
    const w = c.w, d = Math.hypot(w.pos[0] - f.pos[0], w.pos[1] - f.pos[1]);
    const jumped = f.owner && Math.hypot(w.pos[0] - f.owner[0], w.pos[1] - f.owner[1]) > FALCON_SNAP;
    f.owner = [...w.pos];
    f.map = w.map;
    f.clock += dt;
    f.alpha = w.alpha ?? 1;
    f.lift = FALCON_UP + (w.lift || 0);
    const next = falconNext.get(c);
    if (next && (jumped || next.high || t >= next.at - Math.hypot(next.aim[0] - f.pos[0], next.aim[1] - f.pos[1], f.lift - FALCON_HIT) * 1000 / FALCON_DIVE)) {
      falconNext.delete(c);
      falconDives.set(c, { ...next, t0: t, at: Math.max(next.at, t + 1), from: null });
    }
    const dive = falconDives.get(c);
    if (dive && !jumped && t >= dive.t0 && t < dive.at + 5000 && !dive.done) {
      if (!dive.from) dive.from = { pos: [...f.pos], lift: f.lift };
      if (dive.high) { scout(dive, f, t, w); continue; }
      const [ax, ay] = dive.aim, [fx, fy] = dive.from.pos, dx = ax - fx, dy = ay - fy, dl = Math.hypot(dx, dy) || 1;
      if (t < dive.at) {
        const k = (t - dive.t0) / (dive.at - dive.t0), e = k * (0.75 + 0.25 * k);
        f.pos = [fx + dx * e, fy + dy * e];
        dive.lift = dive.high ? dive.from.lift : FALCON_HIT;
        f.lift = dive.from.lift + (dive.lift - dive.from.lift) * e;
        f.heading = [dx, dy];
        f.moving = true;
        continue;
      }
      if (dive.a == null) {
        f.pos = [ax, ay];
        Object.assign(dive, { a: Math.atan2(dy, dx), speed: Math.min(FALCON_SWOOP, 1.25 * dl * 1000 / (dive.at - dive.t0)),
                              run: 0, side: Math.random() < 0.5 ? -1 : 1, turned: 0, home: false });
        const map = f.map, start = { pos: [fx, fy], lift: dive.from.lift };
        if (!dive.high && (W.mobs.some(m => m.w === dive.target) || sim.everyChar().some(x => x.w === dive.target)))
          E.play('EF_BLITZLINES', dive.target, t, (dive.span || 0) + BLITZ_LINES_TAIL, { from: { worldPosition: out => { Mover.world(map, ...start.pos, out); out.y += start.lift; return out; } } });
      }
      const goal = d > 1e-6 ? [w.pos[0] + (f.pos[0] - w.pos[0]) / d * FALCON_NEAR, w.pos[1] + (f.pos[1] - w.pos[1]) / d * FALCON_NEAR] : w.pos;
      const gx = goal[0] - f.pos[0], gy = goal[1] - f.pos[1], gl = Math.hypot(gx, gy);
      const turn = dive.speed / FALCON_LOOP * 2 * dt / 1000;  // (radians this frame: a loop FALCON_LOOP across)
      let err = Math.atan2(Math.sin(Math.atan2(gy, gx) - dive.a), Math.cos(Math.atan2(gy, gx) - dive.a));
      if (dive.run < FALCON_OVER) dive.run += dive.speed * dt / 1000;
      else if (!dive.home) {
        dive.a += dive.side * turn;
        dive.turned += turn;
        err = Math.atan2(Math.sin(Math.atan2(gy, gx) - dive.a), Math.cos(Math.atan2(gy, gx) - dive.a));
        if (dive.turned > Math.PI / 2 && Math.abs(err) < 0.3) dive.home = true;
      } else dive.a += Math.max(-turn, Math.min(turn, err));
      const speed = dive.home ? Math.min(dive.speed, gl * 1000 / FALCON_TAU) : dive.speed, step = speed * dt / 1000;
      f.pos = [f.pos[0] + Math.cos(dive.a) * step, f.pos[1] + Math.sin(dive.a) * step];
      dive.lift = Math.min(FALCON_UP, dive.lift + FALCON_CLIMB * dt / 1000);
      f.lift = dive.lift + (w.lift || 0);
      f.heading = [Math.cos(dive.a), Math.sin(dive.a)];
      f.moving = !dive.home;  // (gliding round the loop, flapping home)
      if (!(dive.home && speed <= FALCON_FAST && Math.abs(err) < 0.5 && dive.lift >= FALCON_UP)) continue;
    }
    if (dive) falconDives.delete(c);
    f.moving = false;
    if (jumped) { f.pos = [...w.pos]; continue; }
    // (the spot FALCON_NEAR from the character on the falcon's side of it)
    const goal = d > 1e-6 ? [w.pos[0] + (f.pos[0] - w.pos[0]) / d * FALCON_NEAR, w.pos[1] + (f.pos[1] - w.pos[1]) / d * FALCON_NEAR] : f.pos;
    const gx = goal[0] - f.pos[0], gy = goal[1] - f.pos[1], gl = Math.hypot(gx, gy);
    const step = Math.min(gl * (1 - Math.exp(-dt / FALCON_TAU)), FALCON_FAST * dt / 1000), mx = gl ? gx / gl * step : 0, my = gl ? gy / gl * step : 0;
    f.pos = [f.pos[0] + mx, f.pos[1] + my];
    if (dt && step > FALCON_TURN * dt / 1000) f.heading = [mx, my];
  }
}
// ---------- loot on the ground ----------
// Each piece of loot (sim W.items) is its item's sprite on the ground (아이템/<res>.spr, jobs.json items
// sprite, no shadow), a little off its cell's middle as the client puts it (rAthena's subx/suby, picked at random here: it
// is only shown), from the step it drops to the step it is picked up. Dropped, it flies there from the monster's
// feet over DROP_MS, up DROP_UP cells at the top of its arc and down again (by request; by eye).
const DROP_MS = 450, DROP_UP = 1.2;
const lootSpots = new Map();  // sim item → where it lies: [x, y] (cells)
const lootArcs = new Map();   // sim item → its arc still going: { t0 (fight ms), from (cells) }
// What a Steal takes flies the same way from the monster to the thief (by request, not the skill's success text),
// ending STEAL_END cells up its body, where it is gone: { c, id, t0, from }
const STEAL_END = 0.6;
let stealArcs = [];
const itemSprs = new Map();   // item id → its sprite once loaded (null while it loads)
function itemSprite(id) {
  if (!itemSprs.has(id)) {
    itemSprs.set(id, null);
    const path = (db.items[id] || {}).sprite;
    if (path) api.loadSprite('item:' + id, path, null, spr => itemSprs.set(id, spr));
  }
  return itemSprs.get(id);
}
// All of it, still pictures, is drawn as one (walker.js SpriteBatch: each item's sprite painted once into its
// atlas, by request: a Figure apiece, painted and sent to the GPU every frame, lagged with tens on the ground).
let lootBatch = null;
function lootDraw() {
  if (!lootBatch || lootBatch.scene !== A.scene) { if (lootBatch) lootBatch.dispose(); lootBatch = new SpriteBatch(A.scene); }
  return lootBatch;
}
// item id's picture standing at cell spot [x, y], lift cells up (not yet: its sprite still loading)
function putItem(b, id, [x, y], lift) {
  const spr = itemSprite(id), act = spr && spr.act.actions[0];
  if (!act || !act.frames.length) return;
  const slot = b.slot(id, g => api.drawFrame(spr, act.frames[0], 0, 0, null, g));
  Mover.world(W.field.map, x, y, b.v).y += lift;
  b.add(b.v, slot);
}
function showLoot() {
  const live = new Set(W.items), b = lootDraw();
  for (const it of lootSpots.keys()) if (!live.has(it)) lootSpots.delete(it);
  for (const it of lootArcs.keys()) if (!live.has(it)) lootArcs.delete(it);
  b.begin();
  for (const it of W.items) {
    let land = lootSpots.get(it);
    if (!land) { const [x, y] = it.w.cell; lootSpots.set(it, land = [x + 0.2 + Math.random() * 0.6, y + 0.2 + Math.random() * 0.6]); }
    const arc = lootArcs.get(it), u = arc && (W.t - arc.t0) / DROP_MS;
    if (arc && (u >= 1 || u < 0)) lootArcs.delete(it);
    if (!arc || u >= 1 || u < 0) { putItem(b, it.id, land, 0); continue; }
    putItem(b, it.id, [arc.from[0] + (land[0] - arc.from[0]) * u, arc.from[1] + (land[1] - arc.from[1]) * u], DROP_UP * 4 * u * (1 - u));
  }
  stealArcs = stealArcs.filter(a => {
    const u = (W.t - a.t0) / DROP_MS, to = a.c.w && a.c.w.pos;
    if (u >= 1 || u < 0 || !to || !sim.everyChar().includes(a.c)) return false;
    putItem(b, a.id, [a.from[0] + (to[0] - a.from[0]) * u, a.from[1] + (to[1] - a.from[1]) * u], DROP_UP * 4 * u * (1 - u) + STEAL_END * u);
    return true;
  });
  b.end();
}
// (and the movers off the party towing one: tow; a character offstage, its look walked by the game, none)
function towCarts(t) {
  const dt = cartClock == null ? 0 : Math.max(0, Math.min(100, t - cartClock));
  cartClock = t;
  const pulling = [...sim.everyChar().filter(c => c.w && c.w.pos && !c.offstage && sim.hasCart(c)).map(c => [c, c.w]),
    ...[...towed].filter(w => w.pos).map(w => [w, w])], on = new Set(pulling.map(([k]) => k));
  for (const [c, cart] of carts) if (!on.has(c)) { A.remove(cart); carts.delete(c); }
  for (const [c, w] of pulling) {
    let cart = carts.get(c);
    if (!cart) carts.set(c, cart = newCart(w));
    const was = [...cart.pos];
    let bx = w.pos[0] - cart.pos[0], by = w.pos[1] - cart.pos[1], d = Math.hypot(bx, by);
    if (d > CART_SNAP || d < 1e-6) {
      const h = Math.hypot(...w.heading) || 1;
      [bx, by, d] = [w.heading[0] / h, w.heading[1] / h, 1];
    }
    let ang = Math.atan2(by, bx);
    const push = cartPushes.get(c);
    if (push && t >= push.t0 && t < push.at + CART_RAM_MS) {
      const dx = push.aim[0] - w.pos[0], dy = push.aim[1] - w.pos[1], d = Math.hypot(dx, dy) || 1, nx = dx / d, ny = dy / d;
      const { s, lift } = ramAt(push, t, Math.max(0.3, d - CART_RAM_SHORT));
      cart.map = w.map;
      cart.pos = [w.pos[0] + nx * s, w.pos[1] + ny * s];
      cart.heading = s > 0 ? [-nx, -ny] : [nx, ny];  // (its handle toward the character, as always)
      cart.moving = Math.hypot(cart.pos[0] - was[0], cart.pos[1] - was[1]) > 1e-4;
      if (cart.moving) cart.clock += dt;
      cart.alpha = w.alpha ?? 1;
      cart.lift = (w.lift || 0) + lift;
      continue;
    }
    if (push && t >= push.at + CART_RAM_MS) cartPushes.delete(c);
    // turned back toward the cart: swing it round behind
    const want = Math.atan2(w.heading[1], w.heading[0]);
    let off = Math.atan2(Math.sin(want - ang), Math.cos(want - ang));
    if (Math.abs(off) > Math.PI / 2) ang += Math.sign(off || 1) * Math.min(Math.abs(off) - Math.PI / 2, CART_SWING * dt / 1000);
    cart.map = w.map;
    cart.pos = [w.pos[0] - Math.cos(ang) * CART_GAP, w.pos[1] - Math.sin(ang) * CART_GAP];
    cart.heading = [Math.cos(ang), Math.sin(ang)];
    cart.moving = Math.hypot(cart.pos[0] - was[0], cart.pos[1] - was[1]) > 1e-4;
    if (cart.moving) cart.clock += dt;
    cart.alpha = w.alpha ?? 1;
    cart.lift = w.lift || 0;
  }
}

// ---------- drawing (walker.js callbacks: feet at (0, 0) of g, dir relative to the camera) ----------
// playing a song (or casting one), not walking: the 詠唱 action's 2nd to 4th frames over and over, at half its frame
// rate (by request); [action, frame], or null without such an action
function songPose(acts, dir, t) {
  const action = 12 * 8 + dir, act = acts[action];
  if (!act || act.frames.length < 2) return null;
  const n = Math.min(3, act.frames.length - 1);
  return [action, 1 + Math.floor(t / (2 * Math.max(1, act.delay_ms || 100))) % n];
}
// playing a song and not walking, it turns another way now and then (by request): a random one of the 8 every
// SONG_TURN_MS, turned on top of the way it heads (so it turns with the camera); from the way it faced as it stopped
const SONG_TURN_MS = [1500, 4000];
const songTurns = new WeakMap();  // character → { off: steps turned, next: when it turns again, seen: last drawn so }
function songDir(c, dir, t) {
  let s = songTurns.get(c);
  if (!s || t - s.seen > 500 || t < s.seen) songTurns.set(c, s = { off: 0, next: t + turnWait(), seen: t });
  if (t >= s.next) {
    s.off = (s.off + 1 + Math.floor(Math.random() * 7)) % 8;  // (any way but the one it faces)
    s.next = t + turnWait();
  }
  return (dir + s.off) % 8;
}
const turnWait = () => SONG_TURN_MS[0] + Math.random() * (SONG_TURN_MS[1] - SONG_TURN_MS[0]);
// character c casting a song or an ensemble, or its motion as one goes off (a: its motion)
const songCasting = (c, a, t) => a && t < sim.animEnd(a) ? !!a.song : !!(c.cast && sim.isSong(c.cast.sk.name));
// (keyed: painted only when what it paints changes, walker.js)
function drawPc(c, g, group, dir, walkClock, same = null) {
  const body = c.look.ch.body;
  if (!body) return false;
  const t = W.t, a = c.anim, acts = body.act.actions;
  let action, fi, r, swingK = null, rested = false;
  const once = (grp, start, hold) => {  // play an action group once from start (hold: keep the last frame)
    const act = acts[grp * 8 + dir];
    if (!act || !act.frames.length) return null;
    const n = act.frames.length, k = Math.floor((t - start) / Math.max(1, act.delay_ms || 100));
    return k < n || hold ? [grp * 8 + dir, Math.min(k, n - 1)] : null;
  };
  if (c.dead != null && (r = once(8, c.dead, true))) {
    [action, fi] = r;
  } else if (c.asleep && acts[6 * 8 + dir]) {  // asleep: the hurt action's first frame, held (by request)
    action = 6 * 8 + dir; fi = 0;
  } else if (leaping(c, t) && acts[LEAP_GROUP * 8 + dir]) {
    // leaping into hiding: the bare-handed attack's frame with the arm swung down (its hit frame), held, so it
    // looks like a jump (by request); without the frame's sounds
    action = LEAP_GROUP * 8 + dir;
    fi = Math.max(0, Math.min(acts[action].frames.length - 1, api.guessedHitFrame(body.act, LEAP_GROUP, action)));
    if (same?.(`L${action}:${fi}:${chKey(c.look.ch)}`)) return true;
    api.drawHuman(g, action, fi, c.look.ch);
    return true;
  } else if (group !== 1 && songCasting(c, a, t) && (r = songPose(acts, dir, t))) {
    // casting a song or an ensemble, and as it goes off: looping as while it plays (below), not the 詠唱 action's
    // first frame held (by request)
    [action, fi] = r;
  } else if (a && t < sim.animEnd(a)) {
    // frames since the motion started (a second swing counts on); before `wait` it holds its first (Charge Attack's)
    swingK = a.wait != null && t < a.wait ? 0 : Math.max(0, Math.floor((t - a.start) / a.fd));
    action = a.group * 8 + dir; fi = a.hold ?? (a.seq ? a.seq[Math.min(swingK, a.seq.length - 1)] : a.restart != null && swingK >= a.restart ? swingK - a.restart : swingK);
    // (`rest`: held on that frame once there, without the slash trail: Snatch's)
    if (a.rest != null && fi >= a.rest) { fi = a.rest; rested = true; }
    // (a rush's quick swings after the first, over and over: Sonic Blow's)
    const rushT = a.rush ? t - a.start - a.frames * a.fd : -1;
    if (rushT >= 0) { swingK = a.frames + Math.floor(rushT / a.rush.fd); fi = swingK % a.frames; }
  } else if (group !== 1 && c.cast && acts[sim.castGroup(c.cast.sk) * 8 + dir]) {
    // casting: the 詠唱 action held on its first frame; it plays when the skill goes off (roBrowser
    // onEntityCastSkill: the SKILL action, frame 0, not playing while there is a cast time). A skill with an action
    // of its own holds that one's first frame instead (Find Stone: picking up). Walking with Free Cast: the walk
    action = sim.castGroup(c.cast.sk) * 8 + dir; fi = 0;
  } else if (group !== 1 && c.sitting && acts[2 * 8 + dir]) {  // sitting (坐下), looking straight ahead
    action = 2 * 8 + dir; fi = 0;
  } else if (group !== 1 && c.hurt != null && (r = once(6, c.hurt, false))) {
    [action, fi] = r;
  } else if (group !== 1 && sim.hasStatus(c, 'BD_PERFORMING') && (r = songPose(acts, songDir(c, dir, t), t))) {
    [action, fi] = r;
    songTurns.get(c).seen = t;
  } else {
    // walking; battle stance while fighting or after its last attack, skill or damage (roBrowser READYFIGHT:
    // until it walks, sits or picks something up), and while it plays a song (by request: not standing idle when it
    // stops walking); otherwise standing and looking ahead
    const grp = group === 1 ? 1 : c.target || c.alert || sim.hasStatus(c, 'BD_PERFORMING') ? 4 : 0;
    action = grp * 8 + dir;
    const act = acts[action];
    if (!act || !act.frames.length) return false;
    const clock = grp === 1 ? walkClock : t;
    fi = grp === 0 ? 0 : Math.floor(clock / Math.max(1, act.delay_ms || 100)) % act.frames.length;
  }
  // petrified (a monster's Petrify Attack): as a monster, the pose it was in held, in grey, without its frame
  // sounds; greying over the wait (see drawMob)
  if (c.stone) {
    const s = c.stone;
    if (s.on) {
      if (!poses.has(s)) poses.set(s, { action, fi });
      ({ action, fi } = poses.get(s));
    }
    if (same?.(`S${action}:${fi}:${s.on ? 'on' : greyOf(s, t).toFixed(2)}:${chKey(c.look.ch)}`)) return true;
    g.save();
    g.filter = s.on ? 'grayscale(1) brightness(0.85)' : `grayscale(${greyOf(s, t).toFixed(2)})`;
    api.drawHuman(g, action, fi, c.look.ch);
    g.restore();
    return true;
  }
  // frozen: as a monster (see drawMob), the pose it was in when it froze held, tinted blue, without its frame
  // sounds (by report: it kept playing its idle)
  if (c.frozen) {
    if (!poses.has(c.frozen)) poses.set(c.frozen, { action, fi });
    ({ action, fi } = poses.get(c.frozen));
    if (same?.(`F${action}:${fi}:${chKey(c.look.ch)}`)) return true;
    api.drawHuman(g, action, fi, c.look.ch);
    tintFigure(g, `rgb(${FROZEN_TINT.slice(0, 3).join(', ')})`);
    return true;
  }
  // a second swing plays its sounds again: its frames count on from the first's
  // (Grampus Morph: an orc's head in place of its own, roBrowser's 이팩트/orcface)
  let ch = c.orcish && orcHead ? { ...c.look.ch, head: orcHead } : c.look.ch;
  // (a motion with `bare`: neither its weapon, the weapon's slash nor its shield drawn: Shield Charge's, by request)
  if (a && a.bare && t < sim.animEnd(a)) ch = { ...ch, weapon: null, fx: null, shield: null };
  // (`noTrail`: without the slash trail — a crusader's skill in the casting pose, which a sword's trail would make a swing)
  else if (a && (a.noTrail || rested) && t < sim.animEnd(a)) ch = { ...ch, fx: null };
  api.humanSounds(`b${c.id}-`, action, fi, (a ? a.start : 0) + ':' + (c.hurt || 0) + ':' + (c.dead || 0) + ':' + (swingK ?? fi), ch);
  // Energy Coat: the character tinted (roBrowser OPT3 ENERGYCOAT: colour 0.5, 0.5, 0.85), multiplied over what
  // was drawn (the figure's canvas holds only this character), then cut back to its shape
  // caught in Root, or holding one: roBrowser's OPT3 BLADESTOP, (0.25, 0.25, 0.25)
  // Power Thrust, while it lasts: roBrowser's OPT3 OVERTHRUST, the character tinted (1, 0.75, 0.75) and after-images as
  // it walks (a trail, see walker.js); Fury the same (OPT3 EXPLOSIONSPIRITS)
  const thrust = sim.hasStatus(c, 'BS_OVERTHRUST') || sim.hasStatus(c, 'MO_EXPLOSIONSPIRITS');
  c.w.trail = thrust;
  const tints = [sim.hasStatus(c, 'MG_ENERGYCOAT') && 'rgb(128, 128, 217)', sim.hasStatus(c, 'KN_TWOHANDQUICKEN') && QUICKEN_TINT,
    c.poison && POISON_TINT, c.curse && CURSE_TINT, sim.bladeStopped(c) && BLADESTOP_TINT, thrust && OVERTHRUST_TINT].filter(Boolean);
  if (same?.(`${action}:${fi}:${chKey(ch)}:${tints.join('|')}`)) return true;
  api.drawHuman(g, action, fi, ch);
  for (const css of tints) tintFigure(g, css);
  return true;
}
// multiply everything drawn on figure canvas g by colour `css`, keeping its alpha
let tintMask = null;
function tintFigure(g, css) {
  const cv = g.canvas;
  if (!tintMask) tintMask = document.createElement('canvas');
  if (tintMask.width !== cv.width || tintMask.height !== cv.height) { tintMask.width = cv.width; tintMask.height = cv.height; }
  const m = tintMask.getContext('2d');
  m.clearRect(0, 0, cv.width, cv.height);
  m.drawImage(cv, 0, 0);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = css;
  g.fillRect(0, 0, cv.width, cv.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(tintMask, 0, 0);
  g.restore();
}
const FROZEN_TINT = [0, 102, 204, 255];  // roBrowser's frozen body colour (0, 0.4, 0.8)
const POISON_TINT = 'rgb(230, 102, 204)';  // roBrowser's poisoned colour (0.9, 0.4, 0.8)
const BLADESTOP_TINT = 'rgb(64, 64, 64)';  // roBrowser's Root colour (0.25, 0.25, 0.25)
const CURSE_TINT = 'rgb(128, 38, 26)';  // roBrowser's cursed colour (0.5, 0.15, 0.1)
const QUICKEN_TINT = 'rgb(255, 255, 0)';
const OVERTHRUST_TINT = 'rgb(255, 191, 191)';  // roBrowser's OPT3 OVERTHRUST (Power Thrust): green and blue × 0.75  // roBrowser's OPT3 QUICKEN (Two-Hand Quicken): no blue
// how far the grey has come over a unit turning to stone (u.stone): over its wait (Stone Curse's 5 s, Petrify
// Attack's 0.1 s), all of it once it is stone
const greyOf = (s, t) => s.on ? 1 : Math.min(1, Math.max(0, (t - s.start) / Math.max(1, s.wait - s.start)));
function drawMob(m, g, group, dir, walkClock, same = null) {
  const t = W.t, a = m.anim, acts = m.spr.act.actions;
  let grp, k, start;
  const delayOf = gp => Math.max(1, (acts[gp * 8] || acts[0]).delay_ms || 100);
  if (m.dead != null) {
    grp = 4; start = m.dead; k = Math.floor((t - start) / delayOf(4));
    k = Math.min(k, actionInfo(m.spr, 4).n - 1);  // hold the last frame of the death
  } else if (sim.busy(a, t)) {
    grp = a.grp; start = a.start; k = Math.floor((t - start) / a.fd);
    if (a.hold != null) k = Math.min(k, a.hold);  // (held on a frame: caught in Root)
  } else if (group === 1) {
    // the walk cycle slows down with the walk speed (roBrowser: delay × speed / 150)
    grp = 1; start = 0; k = Math.floor(walkClock / (delayOf(1) * m.w.cellMs / 150));
  } else {
    grp = 0; start = 0; k = Math.floor((m.animT || 0) / delayOf(0));  // (standing: at its own pace, sim.js paceOf)
  }
  let action = acts[grp * 8 + dir] ? grp * 8 + dir : grp * 8;
  if (!acts[action] || !acts[action].frames.length) return false;
  let fi = k % acts[action].frames.length;
  // petrified: the pose it was in when it turned to stone, held, in grey (no frame sounds); turning to stone, it
  // greys over the wait. roBrowser darkens it instead (colour × 0.3 waiting, × 0.1 as stone); by eye, the
  // client's stone is grey.
  let grey = 0;
  if (m.stone && m.stone.on) {
    const s = m.stone;
    if (!poses.has(s)) poses.set(s, { action, fi });
    ({ action, fi } = poses.get(s));
    if (same?.(`S${action}:${fi}:${idOf(m.spr)}`)) return true;
    g.save();
    g.filter = 'grayscale(1) brightness(0.85)';
    api.drawFrame(m.spr, acts[action].frames[fi], 0, 0, null, g);
    g.restore();
    return true;
  } else if (m.stone) grey = greyOf(m.stone, t);
  if (m.frozen) {  // frozen: the pose it was in when it froze, held, tinted blue (no frame sounds)
    if (!poses.has(m.frozen)) poses.set(m.frozen, { action, fi });
    ({ action, fi } = poses.get(m.frozen));
    if (same?.(`F${action}:${fi}:${idOf(m.spr)}`)) return true;
    const f = acts[action].frames[fi];
    api.drawFrame(m.spr, { ...f, layers: f.layers.map(l => ({ ...l, color: FROZEN_TINT.map((v, i) => Math.round(v * (l.color || [255, 255, 255, 255])[i] / 255)) })) }, 0, 0, null, g);
    return true;
  }
  const act = acts[action], f = act.frames[fi];
  // the frame's sound (poring_move, poring_attack ...), once each time playback reaches the frame
  const key = grp + ':' + start + ':' + k;
  if (key !== m.soundKey) {
    m.soundKey = key;
    const name = f.sound != null && f.sound >= 0 && m.spr.act.sounds[f.sound];
    if (name && name !== 'atk') api.playSound(name);
  }
  const tints = [m.poison && POISON_TINT, sim.bladeStopped(m) && BLADESTOP_TINT, sim.hasStatus(m, 'KN_TWOHANDQUICKEN') && QUICKEN_TINT].filter(Boolean);
  if (same?.(`${action}:${fi}:${idOf(m.spr)}:${grey.toFixed(2)}:${tints.join('|')}`)) return true;
  g.save();
  if (grey) g.filter = `grayscale(${grey.toFixed(2)})`;
  api.drawFrame(m.spr, f, 0, 0, null, g);
  g.restore();
  for (const css of tints) tintFigure(g, css);
  return true;
}
// damage numbers arc away from the attacker (f.dir) and drop; messages rise straight up; all fade
// (timing and sizes approximate the client). g: sprite px with the unit's feet at (0, 0)
function drawFloat(g, f, t) {
  if (f.chat) return drawChat(g, f, t);
  if (f.text) {  // a shouted skill name: rises a little and fades
    const k = f.cast ? 0 : (t - f.t0) / LABEL_MS;
    g.save();
    g.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    g.translate(0, -f.top - 18 - k * 10);
    text(g, f.text, '#fff6c8');
    g.restore();
    return;
  }
  if (f.r.type === 'heal') {
    // big at first, shrinking fast and then slower (ease-out over the first 40%) while it rises from the
    // start, slowly and then faster (ease-in over its whole time). roBrowser shrinks it linearly and holds
    // it still until 40% before it rises; sizes by eye, as for the damage numbers.
    const k = (t - f.t0) / FLOAT_MS, p = Math.min(k / 0.4, 1), scale = 2.6 - 1.4 * (1 - (1 - p) * (1 - p));
    g.save();
    g.globalAlpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
    g.translate(0, -f.top - 60 * k * k);
    g.scale(scale, scale);
    digits(g, String(f.r.damage), f.r.sp ? SP_TINT : HEAL_TINT);
    g.restore();
    return;
  }
  const r = f.r, msg = r.type === 'miss' || r.type === 'lucky', combo = r.type === 'combo';
  // a running total stays put and pops with each hit, then floats away from its last update
  const age = t - (combo ? f.t1 : f.t0), k = combo && !f.done ? 0 : age / FLOAT_MS;
  const x = msg || combo ? 0 : k * 50 * f.dir;
  // numbers peak at k = 1/3; a multi-hit total rises straight up above them
  const y = -f.top - (combo ? 30 + k * 30 : msg ? k * 40 : k * 120 - k * k * 180);
  const scale = (age < 120 ? 2.6 - age / 120 * 1.1 : 1.5) * (r.type === 'miss' ? 0.6 : 1);
  g.save();
  g.globalAlpha = (k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1) * (r.type === 'miss' ? 0.8 : 1);
  g.translate(x, y); g.scale(scale, scale);
  if (msg) {
    image(g, r.type === 'miss' ? MISS : MSG + '005.png', r.type === 'miss' ? 'Miss' : 'Lucky');
  } else {
    if (r.type === 'crit') {
      // the star's face sits below the image centre (its 3D edge runs down-right): centre the face on the digits
      g.save(); g.scale(0.8, 0.8); g.translate(0.5, -2.7); image(g, MSG + '003.png', ''); g.restore();
    }
    digits(g, String(r.damage), f.taken ? TAKEN_TINT : r.type === 'crit' || combo ? [255, 220, 40, 255] : null);
  }
  g.restore();
}
// an arrow k (0–1) of the way from the shooter's middle to the target's, pointing where it flies (the
// sprite's head is at its bottom)
function drawArrow(g, a, k) {
  const im = api.img(a.img || ARROW);
  if (!im.complete || !im.naturalWidth) return;
  const p = A.anchor(a.from), q = A.anchor(a.to.w);
  const x0 = p.x, y0 = p.y - (a.fromTop ?? 45) * p.s, x1 = q.x, y1 = q.y - (a.to.top ?? PC_TOP) / 2 * q.s;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.translate(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k);
  g.rotate(Math.atan2(y1 - y0, x1 - x0) - Math.PI / 2);
  g.scale(p.s, p.s);
  g.drawImage(im, -im.width / 2, -im.height / 2);
}
function image(g, path, fallback) {
  const im = api.img(path);
  if (im.complete && im.naturalWidth) g.drawImage(im, -im.width / 2, -im.height / 2);
  else if (fallback) text(g, fallback, '#fff');
}
function digits(g, s, tint) {
  const ims = [...s].map(d => api.img(DIGITS + '00' + d + '.png'));
  if (!ims.every(im => im.complete && im.naturalWidth)) return text(g, s, tint ? '#ffdc28' : '#fff');
  const w = ims.reduce((n, im) => n + im.width - 1, 0);
  let x = -w / 2;
  ims.forEach((im, i) => {
    const src = tint ? api.tinted(im, DIGITS + s[i] + tint.join(), tint) : im;
    g.drawImage(src, x, -im.height / 2);
    x += im.width - 1;
  });
}
// a chat message (a joke's line): as the client's, roBrowser EntityDialog: white 12 px Arial with a black shadow 1 px down
// and right, on a box of black at 0.4, 7 px either side (without roBrowser's grey #525252 edge, by request); its bottom
// CHAT_UP sprite px over the feet, above where the skill's name is shouted (so the two do not overlap, by report). Still,
// gone after CHAT_MS, its last 300 ms fading
const CHAT_UP = 34;
function drawChat(g, f, t) {
  const el = t - f.t0;
  g.save();
  g.globalAlpha = Math.max(0, Math.min(1, (CHAT_MS - el) / 300));
  g.font = '12px Arial'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  const w = Math.ceil(g.measureText(f.text).width) + 14, h = 8 + 17, x = -w / 2, y = -f.top - CHAT_UP - h;
  g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(x, y, w, h);
  g.fillStyle = '#000'; g.fillText(f.text, x + 8, y + 17);
  g.fillStyle = '#fff'; g.fillText(f.text, x + 7, y + 16);
  g.restore();
}
function text(g, s, color) {
  g.font = 'bold 10px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 2; g.strokeStyle = '#000'; g.strokeText(s, 0, 0);
  g.fillStyle = color; g.fillText(s, 0, 0);
}
// a bar under (y > 0) or over a unit's feet, as the client draws HP/SP under the player (sprite px)
// A vending character's shop over it (roBrowser EntityRoom: the room's box SHOP_UP sprite px above the feet, its
// top edge there; 140 × 26 px, white with rounded corners, a grey-edged inner frame, the client's shop.bmp
// (data/texture/유저인터페이스/, magenta keyed out) at 24 px and the title in black after it, a white tail under it).
// Here in sprite px, so it scales with the view as the bars do; it fades with the character. A chat room (c.room:
// { title }; the game's 招募, by request) the same with the client's chat_open.bmp, as EntityRoom's.
const SHOP_ICON = '../유저인터페이스/shop.bmp', CHAT_ICON = '../유저인터페이스/chat_open.bmp', SHOP_W = 140, SHOP_H = 26, SHOP_UP = 120;
const roomIcons = {};
function drawShop(g, c) {
  const file = c.vending ? SHOP_ICON : CHAT_ICON;
  if (!(file in roomIcons)) roomIcons[file] = null, E.image(file).then(cv => { roomIcons[file] = cv || false; });
  const shopIcon = roomIcons[file];
  const x = -SHOP_W / 2, y = -SHOP_UP, round = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  g.save();
  g.globalAlpha = c.w.alpha ?? 1;
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(-8, y + SHOP_H - 2); g.lineTo(8, y + SHOP_H - 2); g.lineTo(-4, y + SHOP_H + 9); g.fill();
  round(x, y, SHOP_W, SHOP_H, 5); g.fill();
  g.strokeStyle = '#c1c6c2'; g.lineWidth = 1;
  round(x + 2.5, y + 2.5, SHOP_W - 5, SHOP_H - 5, 5); g.stroke();
  if (shopIcon instanceof HTMLCanvasElement) g.drawImage(shopIcon, x + 3, y + 1, 24, 24);
  g.fillStyle = '#000'; g.font = '12px sans-serif'; g.textBaseline = 'middle';
  let title = (c.vending || c.room).title;
  const room = SHOP_W - 36;
  while (title.length > 1 && g.measureText(title).width > room) title = title.slice(0, -2) + '…';
  g.fillText(title, x + 32, y + SHOP_H / 2 + 0.5);
  g.restore();
}
function bar(g, frac, width, color, y = 7, flash) {
  const px = f => Math.round(width * Math.min(1, Math.max(0, f)));
  g.fillStyle = '#10141c'; g.fillRect(-width / 2 - 1, y, width + 2, 5);
  g.fillStyle = color; g.fillRect(-width / 2, y + 1, px(frac), 3);
  if (flash && flash.a > 0) {
    g.globalAlpha = flash.a; g.fillStyle = '#fff';
    g.fillRect(-width / 2 + px(flash.lo), y + 1, px(flash.hi) - px(flash.lo), 3);
    g.globalAlpha = 1;
  }
}
// an HP bar's loss, or what a heal gave back (not natural regen: the heal event marks the unit: EVENTS.heal),
// shows white for a moment (FLASH_MS of the fight's clock, the last half fading) over that part of the bar;
// changes the same way close together make one flash from where the first began. Kept per unit from frame to
// frame; a clock gone back or jumped ahead (a reset, a seek) starts it again with nothing to show.
const FLASH_MS = 160, hpFlashes = new WeakMap(), healed = new WeakSet();
function hpFlash(u, frac, t) {
  let f = hpFlashes.get(u);
  if (!f || t < f.t || t - f.t > 1000) hpFlashes.set(u, f = { frac, t, at: -Infinity, lo: 0, hi: 0, a: 0, up: false });
  else if (frac < f.frac || frac > f.frac && healed.has(u)) {
    const up = frac > f.frac, going = t - f.at < FLASH_MS && f.up === up;
    if (up) { f.lo = going ? Math.min(f.lo, f.frac) : f.frac; f.hi = frac; }
    else { f.hi = going ? Math.max(f.hi, f.frac) : f.frac; f.lo = frac; }
    f.up = up; f.at = t;
  }
  healed.delete(u);
  f.frac = frac; f.t = t;
  f.a = Math.min(1, 2 * (1 - (t - f.at) / FLASH_MS));
  return f;
}
const castFrac = (c, t) => (t - c.start) / Math.max(1, c.end - c.start);
