// The battle itself: the characters and monsters in the fight, and every rule they follow (normal attacks,
// skills, casts, statuses, ground units, monster AI, regen). No DOM, three.js or effects here: sandbox.js
// shows the fight, and hands in what this needs from outside (see init). Numbers come from battle.js.
//
// Units stand and walk on W.field (a grid.js Field); a unit's `w` is its Mover there, which step() walks on.
//
// Outside, for now:
//  - motion: when an attack's hit lands, read off the sprites (ready(c): the character's sprite is in;
//    attackGroup(c); pc(c, group) → { frames, release, hf }; mob(m, group) → { n, delay, frames };
//    mobAttack(m) → { n, delay, hf }).
//  - emit(type, ...args): what happened, for sandbox.js to show (see there for the list).
import * as B from './battle.js';
import * as R from './rng.js';
import { buildsFor, stepsOf, skillBuildsFor, skillStepsOf, firstJobOf, liveBuild } from './builds.js';
import { Field, flatGat, cheb, walkable, findPath } from './grid.js';
import { cardBonus, jobConsts, setKnown, setCombos, BF, ATF } from './cards.js';

let db = null, motion = null, emit = null;
export function init(o) {
  ({ db, motion, emit } = o);
  // a skill used on a trap (skill_db TargetType Trap: Remove Trap, Spring Trap) is aimed at the trap's cell here, as a
  // ground skill (traps are not units one clicks)
  for (const sk of Object.values(db.skills)) if (sk.target === 'Trap') sk.target = 'Ground';
  // (the cards the simulation works out: their autospells' skills it has, their drops' items, their statuses)
  setKnown({ skill: n => !!SKILL_USE[n] && !!db.skills[n], item: id => !!db.items[id], eff: k => k in CARD_EFF_MS,
             group: g => !!CARD_GROUPS[g] });
  setCombos(db.combos);
}
// The fight goes on in steps of TICK ms, whatever the frames (sandbox.js) or the runs (fight.js) go by: the same
// steps, the same dice (rng.js) and the same commands between the same steps make the same fight.
export const TICK = 16;
const { rnd } = R;
// the floor: SIZE cells square, flat and all walkable (by request), or a patch of a real map's (setFloor).
// Characters come in at PC_AT (cells, +y north: south-west of the middle) or on the free cell nearest it; monsters
// on a random free cell at least MOB_GAP cells from every character.
export const SIZE = 18;
const PC_AT = [6, 6], MOB_GAP = 2;
const field = new Field({ name: 'arena', pos: { x: 0, y: 0, h: 0 }, gat: flatGat(SIZE, SIZE) });
field.random = R.random;
// The floor the next fight is on (before resetWorld): a map plan's floor (levels.js floorOf: { map, i, open: SIZE²
// cells, rows from the south: '1' can be walked on, 'x' a wall, which nothing is shot or cast over (grid.js
// clearShot), '0' neither }), or flat with none; heights (SIZE² × 4 corners, RO units, +Y down: what the page shows
// it with, scripts/map2gltf.py --arena) only move what is drawn.
export function setFloor(floor, heights = null) {
  const gat = flatGat(SIZE, SIZE);
  if (floor) for (let i = 0; i < SIZE * SIZE; i++) {
    gat.walk[i] = floor.open[i] === '1' ? 1 : 0;
    if (floor.open[i] === 'x') { gat.wall[i] = 1; gat.walls++; }
  }
  if (heights) gat.heights.set(heights);
  field.map.gat = gat;
}
// the world
export const W = {
  field,
  chars: [],               // the party, see newChar
  rivals: [],              // the rival team's characters (side RIVAL: by request, two teams fighting), see setRivals
  tick: 0,                 // steps gone by with a rival team there (which team goes first: step)
  mobs: [],                // monsters, see addMob
  t: 0, lastClock: 0,      // the clock (ms) as of the last step
  shots: [],               // the characters' arrows on their way: { by (character), from (mover), to (monster), t0 (shot), at (when they hit), skill }
  hits: [],                // hits on their way: { at, from (a character or a monster), to (a monster or a character), r, skill, first, combo }
  walls: [],               // fire walls on the ground, see placeWall
  ices: [],                // ice walls on the ground, see placeIce
  guards: [],              // safety walls on the ground, see placeSafetyWall
  pneumas: [],             // pneumas on the ground, see placePneuma
  warps: [],               // warp portals on the ground, see placeWarp
  traps: [],               // traps on the ground (Sandman, Skid Trap), see placeTrap
  dusts: [],               // Venom Dust on the ground, see placeDust
  sancts: [],              // Sanctuaries on the ground, see placeSanctuary
  sanctNext: new Map(),    // when a unit may next be touched by a Sanctuary (any: NoOverlap)
  magni: [],               // Magnus Exorcismus on the ground, see placeMagnus
  bombs: [],               // Bomb's fires on the ground, see placeBomb
  magnusNext: new Map(),   // when a unit may next be hit by a Magnus Exorcismus (any: NoOverlap)
  storms: [],              // Storm Gusts on the ground, see placeStorm
  songs: [],               // songs, dances and ensembles being played, see placeSong
  stormNext: new Map(),    // when a unit may next be hit by a Storm Gust (any: NoOverlap)
  quags: [],               // Quagmires on the ground, see placeQuag
  fields: [],              // the sage's element fields and Land Protectors, see placeField
  webs: [],                // Fiber Lock's webs on the ground, see placeWeb
  later: [],               // what goes off a while after a skill (skill_addtimerskill): { at, by, to, run(t) }
  unitNext: 0,             // when the ground skills' units next act (every UNIT_MS)
  mobN: 0,                 // monsters added since the fight started (each one's `n`: commands name them by it)
  allAggressive: false,    // 全部主動攻擊: every monster also looks for enemies as if its mode had Aggressive
  items: [],               // loot on the ground, see dropLoot
  itemN: 0,                // loot dropped since the fight started (each one's `n`)
  drop: 1,                 // how much more often than mob_db the monsters drop (and are stolen from): a map's plan.drop
                           // (fight.js), 1 otherwise — here too, or the sandbox before any map had none (NaN odds)
  loot: {},                // what the party has picked up since the fight started: { item id: how many } (shared)
  bag: {},                 // the party's items it fights with, { item id: how many } (shared; resetWorld), drunk from
  used: {},                // what the party has drunk since the fight started: { item id: how many }
  zeny: 0,                 // the party's money (shared; resetWorld), paid from for Mammonite
  spent: 0,                // what it has paid since the fight started
  rival: newPurse(),       // the rival team's bag, money, drunk, paid and picked up, as the party's above (purse)
};

// the client's weapon sprite names (index.json weapon types) → rAthena weapon SubType. Dual-wield pairs
// (단검_검 …: right hand, left hand) are their first weapon with the second in the left hand (a katar,
// 카타르_카타르, is one weapon). Named weapon sprites are the items they show; the ones known
// here are listed, the rest count as bare hands. Numbered ones are item ids (jobs.json 'weapons').
const WEAPON_CLASS = {
  단검: 'Dagger', 검: '1hSword', 양손검: '2hSword', 도끼: '1hAxe', 양손도끼: '2hAxe', 창: '1hSpear', 양손창: '2hSpear',
  클럽: 'Mace', 해머: 'Mace', 스패너: 'Mace', 롯드: 'Staff', 캔디케인롯드: 'Staff', 양손지팡이: '2hStaff', 책: 'Book',
  활: 'Bow', 악기: 'Musical', 채찍: 'Whip', 너클: 'Knuckle', 카타르: 'Katar', 수리검: 'Huuma',
  권총: 'Revolver', handgun2: 'Revolver', 라이플: 'Rifle', 기관총: 'Gatling', gun: 'Gatling', 샷건: 'Shotgun', 그레네이드: 'Grenade',
  망고슈: 'Dagger', 스텔레토: 'Dagger', 포이즌나이프: 'Dagger', 프린세스나이프: 'Dagger', 그라디우스: 'Dagger',
  츠루기: '1hSword', 세이버: '1hSword', 해동검: '1hSword', 투핸드엑스: '2hAxe', 소드메이스: 'Mace',
};
// the weapon character c holds: { type (SubType), range (the item's, or the usual one for its type), and for one
// it has (c.arm: an item id in jobs.json gear, the game's 武器 shop) its atk, matk and wlv }; without one, the
// look's alone (no ATK: as every character had before there were weapons to buy), with `left`, the type of the
// one in its left hand, for a dual-wield pair (a bought one, c.armL, with its ATK and level too: leftAtk, leftWlv)
function weaponInfo(c) {
  const g = c.arm && db.gear && db.gear[c.arm], lh = g && leftArm(c);
  if (g) return { type: g.type, range: g.range, atk: g.atk, matk: g.matk, wlv: g.wlv, ...lh && { left: lh.type, leftAtk: lh.atk, leftWlv: lh.wlv } };
  const v = c.look.held || '', item = db.weapons && db.weapons[v];
  if (item) return { type: item[0], range: item[1] };
  const [r, l] = v.split('_'), type = WEAPON_CLASS[r] || 'Fist', left = type !== 'Katar' && WEAPON_CLASS[l];
  return { type, range: type === 'Fist' ? 1 : (db.weaponRange || {})[type] || 1, ...left && { left } };
}

// whether character c holds a weapon in its left hand too (by request: an assassin with Lefthand Mastery learned,
// a dagger bought for each hand in the game's 武器 shop, the left one c.armL): Lefthand Mastery is what lets it
export const dualWields = c => passiveLv(c, 'AS_LEFT') > 0;
// the bought weapon in character c's left hand (jobs.json gear), or null: none, or no Lefthand Mastery to hold it
function leftArm(c) {
  const l = c.armL && db.gear && db.gear[c.armL];
  return l && dualWields(c) ? l : null;
}

// the shields (by request, in the 左手 slot: the client's shield sprite types), rAthena renewal's item_db_equip: Guard
// (2101), Buckler (2103), Shield (2105), Mirror Shield (2107), Mad Bunny (2189); weight as the client shows it (the db's
// tenths / 10: what Shield Boomerang adds), DEF, unrefined
export const SHIELDS = {
  가드: { id: 2101, weight: 30, def: 20 }, 버클러: { id: 2103, weight: 60, def: 40 }, 쉴드: { id: 2105, weight: 130, def: 60 },
  미러쉴드: { id: 2107, weight: 100, def: 45 }, 매드바니: { id: 2189, weight: 10, def: 40 },
};
// the weapon types held in both hands (item_db Both_Hand), with nothing in the left hand then
export const BOTH_HANDS = new Set(['2hSword', '2hSpear', '2hAxe', '2hMace', '2hStaff', 'Bow', 'Katar', 'Huuma', 'Rifle', 'Gatling', 'Shotgun', 'Grenade']);
// the shield character c holds (its sprite type, '' none): the one picked (look.shield) but with a weapon in both hands
// or one in the left (the bow a bard or a dancer took up too), and one its job holds (look.shields, the sprites it has:
// look.js loadLook; look.shieldShown is the same)
export function heldShield(c) {
  const v = c.look.shield || '', w = weaponInfo(c), job = c.look.shields;
  return SHIELDS[v] && !BOTH_HANDS.has(w.type) && !w.left && (!job || job.some(([x]) => x === v)) ? v : '';
}
// character c takes up a bow (on) or its own weapon again (by request: a bard's or a dancer's 換弓, 換回樂器): the
// equipment not worked out yet, a bow of no ATK, its look's alone (weaponInfo), its own kept in c.bowHeld; the swing
// it had going stops, and its sprites are loaded again (stage weapon). → whether it changed. `weapon`: another to take
// up than a bow (a bow rogue's dagger, by request: 換短劍), held the same way
export function holdBow(c, on, weapon = '활') {
  if (!on === !c.bowHeld) return false;
  if (on) {
    c.bowHeld = { weapon: c.look.weapon, held: c.look.held, arm: c.arm, armL: c.armL };
    c.look.weapon = c.look.held = weapon;
    c.arm = c.armL = null;
  } else {
    c.look.weapon = c.bowHeld.weapon; c.look.held = c.bowHeld.held; c.arm = c.bowHeld.arm; c.armL = c.bowHeld.armL || null;
    c.bowHeld = null;
  }
  if (c.w) cancelSwing(c);
  c.sc = c.sc.filter(s => !WEAPON_ELEMENTS.includes(s.name));  // (RemoveOnUnequipWeapon)
  recalc(c);
  emit('weapon', c);
  return true;
}

// mob.cpp: idle monsters walk every MIN_RANDOMWALKTIME + rnd()%1000 ms (plus the walk itself), up to 7 cells
const RANDOMWALK_MS = 4000, RANDOMWALK_CELLS = 7;
const CORPSE_MS = 1000;  // a dead monster stays this long after its death animation
// unit_attack_timer_sub: an assisting monster calls its kind within assist_range (monster.conf, official 11)
// on an attack, at most every MIN_MOBLINKTIME
const ASSIST_RANGE = 11, LINK_MS = 1000;
// battle_calc_walkdelay: each hit after the first adds multihit_delay (battle.conf 200) to the time before a
// hit monster reacts; mob_ai_sub_hard ignores an attacker farther than area_size (14 cells)
const MULTIHIT_DELAY = 200, AREA_SIZE = 14;
// Skill damage shows up the attacker's attack motion after the skill goes off (the attackMT the server
// sends), and a multi-hit skill's hits follow each other PLUSATTACKED_MOTIONTIME apart (roBrowser
// C_MULTIHIT_DELAY), each showing its share of the damage.
const MULTIHIT_MS = 200;
// a normal attack's left-hand hit (a weapon in each hand, or a katar's second) shows C_MULTIHIT_DELAY × 1.75
// after the right's (roBrowser, ZC_NOTIFY_ACT leftDamage)
const LEFT_MS = MULTIHIT_MS * 1.75;
// so at an attack interval (adelay) of LEFT_ADELAY ms or more; a faster one's comes as much sooner (by request: with a
// fast attack it would land on the next swing's right-hand hit), the attack's motion all quicker alike
const LEFT_ADELAY = 1000;
const leftMs = u => u.isPc && u.pc ? LEFT_MS * Math.min(1, u.pc.adelay / LEFT_ADELAY) : LEFT_MS;
// the title of a shop Vending opens (the client asks for one; the sandbox puts it up as it is)
const VEND_TITLE = '露天商店';
// the skills that need a cart (skill_db Requires State: Cart)
const CART_SKILLS = new Set(['MC_VENDING', 'MC_CARTREVOLUTION']);
// the skills that need the falcon (skill_db Requires State: Falcon)
const FALCON_SKILLS = new Set(['HT_BLITZBEAT', 'HT_DETECTING', 'HT_SPRINGTRAP']);
// ms from Blitz Beat going off to its first hit: the falcon's dive to the target (stage.js), BLITZ_MS and BLITZ_CELL_MS a
// cell to it (roBrowser has it fly there at 35 ms a cell, rAthena's damage comes at once; by eye)
const BLITZ_MS = 100, BLITZ_CELL_MS = 20;
// Detect's falcon flies round a circle from the character to DETECT_BEHIND cells past the cell (stage.js scout), shot off
// at DETECT_LAUNCH cells a second and slowing to a stop as it gets round (its way round 1 − (1 − u)² of the circle at u of
// its time), getting over that far end, half way round, as the skill takes hold (by request; rAthena's is at once)
const DETECT_BEHIND = 1.5, DETECT_LAUNCH = 45;

// ---------- the skills ----------
// Every skill worked out, and how it is used: its figures are battle.js' (SKILLS, STATUS_SKILLS, BUFF_SKILLS,
// HEAL_SKILLS), its effects sandbox.js' (SKILL_EFFECTS); the rest (SP, range, cast, delay, hits, splash,
// knockback, duration) comes from skill_db via jobs.json. A skill is used by a character whose job has it,
// and by a monster whose mob_skill_db rows name it. Adding one: its figures in battle.js, a line here, its
// effects in sandbox.js.
//   does: what it does as it goes off, one of DOES (see there);
//   pose: the user shows the casting pose (詠唱) for its attack motion time, not its attack motion (status skills
//     and magic: roBrowser's default SkillAction);
//   hitAt: when its damage starts landing, if not after the whole attack motion: 'frame' strikes like a normal
//     attack, on the motion's hit frame; a number is that share of the attack motion (by eye; 0: as it goes off). The monsters'
//     element attacks are their normal attack with an element, so they land where it does (the Zombie's as
//     it spits);
//   hold: the frame of its motion the user holds all through it, not played (Occult Impaction's palm); holdHits: held
//     on till its last hit lands (Raging Quadruple Blow's raised hand, the casting pose's sixth frame: by request);
//     holdDelay: held on till the skill's delay is over (canAct: Raging Thrust's fist on the ground, by request);
//   seq: the frames of its motion it plays instead, one after another over the attack motion, the last held;
//   bare: the user's weapon and shield not drawn through its motion (Shield Charge, the alchemist's bottle throws: by request);
//   pace: ms its motion takes whatever the user's attack motion (hitAt a share of that);
//   gap: ms between its hits, if not MULTIHIT_MS (by eye: the client's own timing is in the packed exe);
//   knockFirst: its knockback with its first hit, not its last (Jupitel Thunder: by request);
//   place: what a ground skill puts on the ground;
//   area: the cells around the target cell a 'rain' or 'ground' skill reaches, if not its splash (Thunderstorm:
//     skill_db's Unit Range 2, the 5×5; Pneuma: its unit layout 1, the 3×3);
//   noCast: no cast time, whatever skill_db says (Find Stone's 0.5 s fixed cast: by request);
//   flight: ms after hitAt its damage lands, what it throws flying meanwhile (Stone Fling's stone, 200: its
//     effect's flight);
//   group: the action group the user shows instead (Find Stone: 3, picking up); still: no motion at all;
//   split: it shares its MATK among the enemies it hits (SplashSplit); aside: a character uses it on the way, as
//     magic, without taking the monster as its target (Steal);
//   ail: the status a 'wide' skill puts on the enemies around the user, an 'inflict' one on its target (see AIL_ODDS);
//   mob: worked out for monsters only, not in a character's skill list (Two-Hand Quicken, Auto Guard…: what a
//     player's needs — its weapon or shield, its own figures — is not done); self: a monster's row on itself
//     whatever skill_db's TargetType (Invisible's is Passive);
//   knockDir: the way a skill's knockback pushes, [dx, dy] cells (+y north), whoever it comes from (Cart
//     Revolution: west, skill_blown dir 6 with cart_revo_knockback, as official servers do).
const SONG_AREA = 3, ENSEMBLE_AREA = 4;
const SKILL_USE = {
  SM_BASH: { does: 'attack', hitAt: 'frame' },
  SM_MAGNUM: { does: 'area', hitAt: 'frame' },
  SM_PROVOKE: { does: 'status', pose: true },
  SM_ENDURE: { does: 'buff', pose: true },
  TF_HIDING: { does: 'hide', pose: true },
  // (Steal, Envenom, Detoxify and Sand Attack in the casting pose, Stone Fling with the bare-handed swing:
  // by request)
  TF_STEAL: { does: 'steal', pose: true, aside: true },
  TF_POISON: { does: 'attack', pose: true, hitAt: 0.5 },
  TF_DETOXIFY: { does: 'cure', pose: true },
  TF_SPRINKLESAND: { does: 'attack', pose: true, hitAt: 0.5 },
  TF_BACKSLIDING: { does: 'backslide', still: true },
  TF_PICKSTONE: { does: 'pickStone', group: 3, noCast: true },
  TF_THROWSTONE: { does: 'attack', hitAt: 'frame', group: 5, flight: 200 },
  SM_AUTOBERSERK: { does: 'toggle', pose: true },
  AC_DOUBLE: { does: 'attack', hitAt: 'frame' },
  AC_CHARGEARROW: { does: 'attack', hitAt: 'frame' },
  AC_SHOWER: { does: 'rain', hitAt: 'frame' },
  AC_CONCENTRATION: { does: 'buff', pose: true },
  // (a character's: one swing at its pace, then `rush` more `rushFd` ms a frame (roBrowser's SkillAction: 30 ms),
  // a hit on each of the swing's `strikes` frames — the katar's thrust and its two-handed slash, frames 4 and 7 of
  // attack 3: by request, a hit for each hand, so 4 swings for its 8 hits, not roBrowser's 8; a monster's as
  // before, by eye)
  AS_SONICBLOW: { does: 'attack', hitAt: 0.6, gap: 100, rush: true, rushFd: 30, strikes: [3, 6] },
  // (a character's takes the casting pose facing the target, by request — first a swing — at the pose's own pace (over
  // the attack motion it went by too fast); the spikes set off as it is used, not waiting on it (by request); roBrowser
  // shows no motion)
  AS_GRIMTOOTH: { does: 'grimtooth', pose: true, ownPace: true },
  AL_HEAL: { does: 'heal', pose: true },
  AL_CURE: { does: 'cure', pose: true },
  AL_INCAGI: { does: 'buff', pose: true },
  AS_ENCHANTPOISON: { does: 'buff', pose: true },
  AS_POISONREACT: { does: 'buff', pose: true },
  AS_SPLASHER: { does: 'splasher' },
  // (thrown from the casting pose, by request — first Stone Fling's motion — at the pose's own pace as Grimtooth's,
  // leaving halfway through it; its knife flying 200 ms as Stone Fling's stone, roBrowser's effect 600)
  AS_VENOMKNIFE: { does: 'attack', pose: true, ownPace: true, hitAt: 0.5, flight: 200 },
  // The rogue's: Back Stab, Sightless Mind and Snatch with the attack motion (roBrowser SkillAction: ATTACK), the
  // Divests in the casting pose. (Back Stab pre-renewal's, by request: no cooldown, `noCooldown`; renewal's 0.5 s)
  RG_BACKSTAP: { does: 'backstab', hitAt: 'frame', noCooldown: true },
  RG_RAID: { does: 'raid', hitAt: 'frame' },
  RG_INTIMIDATE: { does: 'snatch', hitAt: 'frame' },
  RG_STRIPWEAPON: { does: 'strip', pose: true }, RG_STRIPSHIELD: { does: 'strip', pose: true },
  RG_STRIPARMOR: { does: 'strip', pose: true }, RG_STRIPHELM: { does: 'strip', pose: true },
  // Mug in the casting pose, on the way (as Steal); Close Confine in the casting pose
  RG_STEALCOIN: { does: 'mug', pose: true, aside: true }, RG_CLOSECONFINE: { does: 'confine', pose: true },
  AL_DECAGI: { does: 'slow', pose: true, aside: true },
  AL_BLESSING: { does: 'buff', pose: true },
  AL_HOLYLIGHT: { does: 'attack', pose: true },
  AL_ANGELUS: { does: 'partyBuff', pose: true },
  PR_IMPOSITIO: { does: 'partyBuff', pose: true },
  PR_SUFFRAGIUM: { does: 'partyBuff', pose: true },
  PR_GLORIA: { does: 'partyBuff', pose: true },
  PR_MAGNIFICAT: { does: 'partyBuff', pose: true },
  PR_KYRIE: { does: 'buff', pose: true },
  // (only from a card's autospell, by request: Assumptio on oneself, Earthquake round oneself — no AI rule has them)
  HP_ASSUMPTIO: { does: 'buff', pose: true }, NPC_EARTHQUAKE: { does: 'quake', pose: true },
  PR_ASPERSIO: { does: 'buff', pose: true },
  PR_BENEDICTIO: { does: 'benedictio', pose: true },
  ALL_RESURRECTION: { does: 'resurrect', pose: true },
  PR_SLOWPOISON: { does: 'buff', pose: true },
  PR_STRECOVERY: { does: 'recover', pose: true },
  PR_REDEMPTIO: { does: 'redemptio', pose: true },
  PR_LEXAETERNA: { does: 'aeterna', pose: true },
  PR_TURNUNDEAD: { does: 'attack', pose: true },
  AL_CRUCIS: { does: 'crucis', pose: true },
  AL_RUWACH: { does: 'buff', pose: true },
  AL_HOLYWATER: { does: 'none', pose: true },
  MC_IDENTIFY: { does: 'none', pose: true },
  MC_MAMMONITE: { does: 'attack', hitAt: 'frame' },
  MC_CARTREVOLUTION: { does: 'splash', pose: true, hitAt: 0.5, knockDir: [-1, 0] },
  MC_LOUD: { does: 'partyBuff', pose: true },
  MC_VENDING: { does: 'vend', still: true },
  AL_TELEPORT: { does: 'teleport', pose: true },
  AL_WARP: { does: 'ground', pose: true, place: (u, p, cell, t) => placeWarp(u, p, cell, t) },
  AL_PNEUMA: { does: 'ground', pose: true, area: 1, place: (u, p, cell, t) => placePneuma(u, p, cell, t) },
  MG_SIGHT: { does: 'buff', pose: true },
  MG_FIREBOLT: { does: 'attack', pose: true },
  MG_COLDBOLT: { does: 'attack', pose: true },
  MG_LIGHTNINGBOLT: { does: 'attack', pose: true },
  MG_SOULSTRIKE: { does: 'attack', pose: true },
  MG_NAPALMBEAT: { does: 'splash', pose: true, split: true },
  MG_FIREBALL: { does: 'splash', pose: true },
  HT_BLITZBEAT: { does: 'blitz', pose: true },
  HT_DETECTING: { does: 'ground', pose: true, place: (u, p, cell, t) => detect(u, p, cell, t) },
  HT_PHANTASMIC: { does: 'attack', hitAt: 'frame' },
  MG_STONECURSE: { does: 'stone', pose: true },
  MG_THUNDERSTORM: { does: 'rain', pose: true, area: 2 },
  MG_FROSTDIVER: { does: 'attack', pose: true },
  MG_FIREWALL: { does: 'ground', pose: true, place: (u, p, cell, t) => placeWall(u, p, cell, t) },
  MG_SAFETYWALL: { does: 'ground', pose: true, place: (u, p, cell, t) => placeSafetyWall(u, p, cell, t) },
  // Sightrasher: as Magnum Break round the user, in the casting pose; Sight is spent (see fireSkill)
  WZ_SIGHTRASHER: { does: 'area', pose: true },
  // (the area shown where they are aimed, by report it was one cell: what they can reach — Meteor Storm's 7×7 of cells
  // and each meteor's Range 3 round its own, the 13×13; Lord of Vermilion's layout 6 and its cells' Range 1, the 15×15)
  WZ_METEOR: { does: 'meteor', pose: true, area: 6 },
  WZ_VERMILION: { does: 'vermilion', pose: true, area: 7 },
  WZ_WATERBALL: { does: 'waterball', pose: true },
  // Frost Nova: as Sightrasher round the user, but not on its own cell nor on one frozen already (see DOES.area)
  WZ_FROSTNOVA: { does: 'area', pose: true },
  // Storm Gust: its 9×9 of cells and their Range 1 round them, the 11×11, shown where it is aimed
  WZ_STORMGUST: { does: 'ground', pose: true, area: 5, place: (u, p, cell, t) => placeStorm(u, p, cell, t) },
  WZ_QUAGMIRE: { does: 'ground', pose: true, area: 2, place: (u, p, cell, t) => placeQuag(u, p, cell, t) },
  // the sage's element fields and Land Protector (placeField; its area by level: 7×7 to 11×11)
  SA_VOLCANO: { does: 'ground', pose: true, area: 3, place: (u, p, cell, t) => placeField(u, p, cell, t) },
  SA_DELUGE: { does: 'ground', pose: true, area: 3, place: (u, p, cell, t) => placeField(u, p, cell, t) },
  SA_VIOLENTGALE: { does: 'ground', pose: true, area: 3, place: (u, p, cell, t) => placeField(u, p, cell, t) },
  SA_LANDPROTECTOR: { does: 'ground', pose: true, place: (u, p, cell, t) => placeField(u, p, cell, t) },
  WZ_ICEWALL: { does: 'ground', pose: true, place: (u, p, cell, t) => placeIce(u, p, cell, t) },
  WZ_FIREPILLAR: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  MG_ENERGYCOAT: { does: 'buff', pose: true },
  NPC_WATERATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_GROUNDATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_FIREATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_UNDEADATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_WINDATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_SILENCEATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_BLINDATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_POISONATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_DARKNESSATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_POISON: { does: 'attack', hitAt: 'frame' },
  NPC_STUNATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_PETRIFYATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_TELEKINESISATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_CRITICALSLASH: { does: 'attack', hitAt: 'frame' },
  NPC_PIERCINGATT: { does: 'attack', hitAt: 'frame' },
  NPC_COMBOATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_GUIDEDATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_RANGEATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_SPLASHATTACK: { does: 'splash', hitAt: 'frame' },
  KN_PIERCE: { does: 'attack', hitAt: 'frame' },
  KN_SPEARBOOMERANG: { does: 'attack', hitAt: 'frame', group: 5, flight: 140 },
  KN_SPEARSTAB: { does: 'line', hitAt: 'frame' },
  KN_BOWLINGBASH: { does: 'splash', hitAt: 'frame' },
  KN_AUTOCOUNTER: { does: 'counter', hitAt: 'frame' },
  KN_BRANDISHSPEAR: { does: 'brandish', hitAt: 'frame' },
  KN_CHARGEATK: { does: 'charge', hitAt: 'frame' },
  // Two-Hand Quicken: the monsters' buff, which a knight with a two-handed sword uses on itself too (its figures:
  // B.BUFF_SKILLS for a character, B.mobBuffed for a monster)
  KN_TWOHANDQUICKEN: { does: 'mobBuff', pose: true },
  // the blacksmith's: Adrenaline Rush (a monster's as before, on itself), Weapon Perfection and Power Thrust on the user
  // and its party (DOES.smith); Maximize Power on until used again (DOES.maximize); Hammer Fall on the ground, striking it as a normal
  // attack does (roBrowser's SkillAction: ATTACK)
  BS_ADRENALINE: { does: 'smith', pose: true },
  BS_WEAPONPERFECT: { does: 'smith', pose: true },
  BS_OVERTHRUST: { does: 'smith', pose: true },
  BS_MAXIMIZE: { does: 'maximize', pose: true },
  BS_HAMMERFALL: { does: 'hammer', hitAt: 'frame' },
  // the sage's (by request, the first of them): Cast Cancel on its own cast (DOES.castCancel; no motion, it acts at once),
  // Magic Rod on itself (guard), Spell Breaker on one casting; Study, Dragonology and Free Cast are passive
  SA_CASTCANCEL: { does: 'castCancel', still: true },
  SA_MAGICROD: { does: 'rod', pose: true },
  SA_SPELLBREAKER: { does: 'spellBreak', pose: true, aside: true },  // (by request: its target kept, not this one)
  // Hindsight with the spell picked (useSelf's `pick`: autoSpells), and the endows on one of the party (DOES.buff)
  SA_AUTOSPELL: { does: 'autospell', pose: true },
  // Hocus-Pocus and the skills only it gives (abraRoll)
  SA_ABRACADABRA: { does: 'abra', pose: true },
  SA_MONOCELL: { does: 'classChange', pose: true }, SA_CLASSCHANGE: { does: 'classChange', pose: true },
  SA_SUMMONMONSTER: { does: 'monsterChant', pose: true }, SA_DEATH: { does: 'grimReaper', pose: true },
  SA_QUESTION: { does: 'question', pose: true }, SA_GRAVITY: { does: 'gravity', pose: true },
  SA_INSTANTDEATH: { does: 'suicide', pose: true }, SA_FULLRECOVERY: { does: 'rejuvenate', pose: true },
  SA_COMA: { does: 'coma', pose: true },
  SA_FLAMELAUNCHER: { does: 'buff', pose: true },
  SA_FROSTWEAPON: { does: 'buff', pose: true },
  SA_LIGHTNINGLOADER: { does: 'buff', pose: true },
  SA_SEISMICWEAPON: { does: 'buff', pose: true },
  // the bard's and the dancer's (their ground: placeSong; 7×7 and 9×9 as the pre-renewal skill_db's Layout 3 and 4, by request)
  BA_MUSICALSTRIKE: { does: 'attack', hitAt: 'frame' },
  DC_THROWARROW: { does: 'attack', hitAt: 'frame' },
  BA_DISSONANCE: { does: 'song', pose: true, area: SONG_AREA },
  DC_UGLYDANCE: { does: 'song', pose: true, area: SONG_AREA },
  // (the jokes: the casting pose's first frame held as they go off, by request)
  BA_FROSTJOKER: { does: 'joke', ail: 'freeze', rate: 150, pose: true, hold: 0 },
  DC_SCREAM: { does: 'joke', ail: 'stun', rate: 250, pose: true, hold: 0 },
  BA_WHISTLE: { does: 'song', pose: true, area: SONG_AREA },
  BA_ASSASSINCROSS: { does: 'song', pose: true, area: SONG_AREA },
  BA_POEMBRAGI: { does: 'song', pose: true, area: SONG_AREA },
  BA_APPLEIDUN: { does: 'song', pose: true, area: SONG_AREA },
  DC_HUMMING: { does: 'song', pose: true, area: SONG_AREA },
  DC_DONTFORGETME: { does: 'song', pose: true, area: SONG_AREA },
  DC_FORTUNEKISS: { does: 'song', pose: true, area: SONG_AREA },
  DC_SERVICEFORYOU: { does: 'song', pose: true, area: SONG_AREA },
  BD_ADAPTATION: { does: 'amp', still: true },
  BD_ENCORE: { does: 'encore', still: true },
  BD_LULLABY: { does: 'song', pose: true, area: ENSEMBLE_AREA },
  BD_RICHMANKIM: { does: 'song', pose: true, area: ENSEMBLE_AREA },
  BD_ETERNALCHAOS: { does: 'song', pose: true, area: ENSEMBLE_AREA },
  BD_DRUMBATTLEFIELD: { does: 'song', pose: true, area: ENSEMBLE_AREA },
  BD_RINGNIBELUNGEN: { does: 'song', pose: true, area: ENSEMBLE_AREA },
  BD_ROKISWEIL: { does: 'song', pose: true, area: ENSEMBLE_AREA },
  BD_INTOABYSS: { does: 'song', pose: true, area: ENSEMBLE_AREA },
  BD_SIEGFRIED: { does: 'song', pose: true, area: ENSEMBLE_AREA },
  BA_PANGVOICE: { does: 'pang', pose: true },
  DC_WINKCHARM: { does: 'wink', pose: true },
  // (by request, not rAthena's: its hits as quick as an ASPD 190 attack motion, 100 ms apart, and its knockback with
  // the first, not the last — with no delay, one after another held its target in place)
  WZ_JUPITEL: { does: 'attack', pose: true, gap: 100, knockFirst: true },
  // Earth Spike, Heaven's Drive: their first hit as the spikes come up, as they go off (by request; after the attack
  // motion, they came well after)
  WZ_EARTHSPIKE: { does: 'attack', pose: true, hitAt: 0 },
  // Heaven's Drive: as Thunderstorm on its 5×5 (a Dummyskill unit of layout 2 lasting 100 ms: once), hitting the hidden
  // too (TargetHidden; not the cloaked)
  WZ_HEAVENDRIVE: { does: 'rain', pose: true, area: 2, hidden: true, hitAt: 0 },
  NPC_CURSEATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_SLEEPATTACK: { does: 'attack', hitAt: 'frame' },
  NPC_BLOODDRAIN: { does: 'attack', hitAt: 'frame' },
  NPC_LICK: { does: 'inflict', ail: 'stun' },
  NPC_HALLUCINATION: { does: 'inflict', ail: 'hallucinate' },
  SA_REVERSEORCISH: { does: 'inflict', ail: 'orcish' },
  NPC_STOP: { does: 'stop' },
  // a monster's own buffs (monsters only for now: `mob`, see skillTable)
  NPC_AGIUP: { does: 'mobBuff', mob: true },
  NPC_KEEPING: { does: 'mobBuff', mob: true },
  // the crusader's on itself (a monster's as before: DOES.mobBuff; a character's needs a shield, NEED_SHIELD); Auto Guard,
  // Defending Aura and Shrink used again end instead (end_if_running)
  CR_AUTOGUARD: { does: 'mobBuff', pose: true },
  CR_REFLECTSHIELD: { does: 'mobBuff', pose: true },
  CR_DEFENDER: { does: 'mobBuff', pose: true },
  CR_SHRINK: { does: 'mobBuff', pose: true },
  CR_SPEARQUICKEN: { does: 'mobBuff', pose: true },
  // Shield Boomerang: as Shield Charge (by request), the casting pose's 2nd to 6th frames 100 ms each, neither weapon nor
  // shield drawn; the shield thrown on the 6th, 400 ms in (flight: its effect's, stage.js)
  CR_SHIELDBOOMERANG: { does: 'attack', pose: true, seq: [1, 2, 3, 4, 5], pace: 500, hitAt: 0.8, bare: true, flight: 140 },
  // Holy Cross: a weapon attack on the motion's hit frame (B.SKILLS); Grand Cross: the cross round the user (grandCross);
  // Sacrifice: see DOES.devotion; Resistant Souls: a status on another character (casterFail)
  CR_HOLYCROSS: { does: 'attack', hitAt: 'frame' },
  CR_GRANDCROSS: { does: 'grandCross', pose: true },
  CR_DEVOTION: { does: 'devotion', pose: true },
  CR_PROVIDENCE: { does: 'buff', pose: true },
  AS_CLOAKING: { does: 'cloak', pose: true },
  NPC_INVISIBLE: { does: 'cloak', mob: true, self: true },
  // the monk's: Summon Spirit Sphere, Absorb Spirit Sphere and Snap with no motion of their own (roBrowser's
  // SkillAction for them: IDLE); Occult Impaction and Throw Spirit Sphere holding the casting pose's fifth frame, the
  // palm thrust out (SkillAction: SKILL, frame 4, not played: `hold`); the two combo skills with the attack motion,
  // on the one the chain began on (see combo)
  MO_CALLSPIRITS: { does: 'spheres', still: true },
  MO_ABSORBSPIRITS: { does: 'absorb', still: true },
  MO_BODYRELOCATION: { does: 'snap', still: true },
  // Fury: a status on the user (BUFF_SKILLS), with no motion of its own (roBrowser SkillAction: IDLE)
  // Fury: Raging Thrust's fist on the ground, held half a second (by request; roBrowser IDLE)
  MO_EXPLOSIONSPIRITS: { does: 'buff', pose: true, seq: [1, 2], hitAt: 0.5, holdFor: 500 },
  // Mental Strength: as Fury, Raging Thrust's fist on the ground held half a second (by request; roBrowser IDLE)
  MO_STEELBODY: { does: 'buff', pose: true, seq: [1, 2], hitAt: 0.5, holdFor: 500 },
  MO_KITRANSLATION: { does: 'kiTranslation', still: true },
  // Ki Explosion: the attack motion (roBrowser: none of its own)
  MO_BALKYOUNG: { does: 'kiExplosion', hitAt: 'frame' },
  // Root: the casting motion's frame 4 held (roBrowser SKILL frame 3, 3 s)
  MO_BLADESTOP: { does: 'bladeWait', pose: true, hold: 3 },
  // Asura Strike: Raging Thrust's fist on the ground, striking (and dashing) as it comes down, held half a second
  // after (by request; roBrowser SkillAction: ATTACK)
  MO_EXTREMITYFIST: { does: 'asura', pose: true, seq: [1, 2], hitAt: 0.5, holdFor: 500 },
  MO_INVESTIGATE: { does: 'attack', pose: true, hold: 4 },
  MO_FINGEROFFENSIVE: { does: 'attack', pose: true, hold: 4 },
  MO_CHAINCOMBO: { does: 'combo', pose: true, hold: 5, hitAt: 0, holdHits: true },
  // Raging Thrust: the casting pose's second frame, the hand raised, for half the attack motion, then its third, the
  // fist down on the ground, the hit landing with it, held till the skill's delay is over and the attack goes on
  // (`seq`, `holdDelay`; by request)
  MO_COMBOFINISH: { does: 'combo', pose: true, seq: [1, 2], hitAt: 0.5, holdDelay: true },
  // on characters or on its own kind (monsters only for now)
  NPC_PROVOCATION: { does: 'giveUp', mob: true },
  SA_DISPELL: { does: 'dispell', pose: true, aside: true },
  PR_LEXDIVINA: { does: 'lex', pose: true },
  // (Shield Charge: the casting pose's 2nd to 6th frames, 100 ms each, by request, its hit landing on the 6th, 400 ms in,
  // as its effect's shield comes down (stage.js); neither the weapon nor the shield shown meanwhile, by request)
  CR_SHIELDCHARGE: { does: 'attack', pose: true, seq: [1, 2, 3, 4, 5], pace: 500, hitAt: 0.8, bare: true },
  NPC_DARKBREATH: { does: 'darkBreath', mob: true },
  // the alchemist's (by request, its first ones): thrown as roBrowser has them (SkillAction ATTACK1, the throw with no
  // weapon drawn: Stone Fling's group 5), Acid Terror's bottle flying to the target as Stone Fling's stone does
  // (effects.js EF_THROWITEM); Bomb's fire put on the ground (placeBomb) once its bottle, thrown the same way (by
  // request; roBrowser shows none), lands there; Aid Potion on one of the party
  // (pitchPotion; a monster's as before)
  AM_ACIDTERROR: { does: 'attack', hitAt: 'frame', group: 5, flight: 300, bare: true },
  AM_DEMONSTRATION: { does: 'ground', hitAt: 'frame', group: 5, flight: 300, bare: true, place: (u, p, cell, t, mo) => placeBomb(u, p, cell, t, mo) },
  AM_POTIONPITCHER: { does: 'potion', group: 5, hitAt: 'frame', flight: 300, bare: true },
  // Chemical Protection on one of the party (in the casting pose, roBrowser's default), and Aid Berserk Potion
  AM_CP_WEAPON: { does: 'buff', pose: true },
  AM_CP_SHIELD: { does: 'buff', pose: true },
  AM_CP_ARMOR: { does: 'buff', pose: true },
  AM_CP_HELM: { does: 'buff', pose: true },
  AM_BERSERKPITCHER: { does: 'berserkPotion', pose: true },
  // the alchemist's summons on a cell (summonFor): Bio Cannibalize thrown (roBrowser ATTACK1), Sphere Mine in the
  // casting pose
  // (by request, their bottles thrown too, as Acid Terror's: the plant, the sphere, the potion only where it lands, throwLater)
  AM_CANNIBALIZE: { does: 'ground', group: 5, hitAt: 'frame', flight: 300, bare: true, place: (u, p, cell, t, mo) => plantCellTaken(cell)
    ? (giveBack(u, PLANT_BOTTLE), say(u.w, '技能使用失敗', t)) : throwLater(u, p, p.target.w, t, mo, at => summonFor(u, p, cell, at), u, cell) },
  AM_SPHEREMINE: { does: 'ground', flight: 300, place: (u, p, cell, t, mo) => throwLater(u, p, p.target.w, t, mo, at => summonFor(u, p, cell, at)) },
  // the homunculus (callHomun and the rest, in the casting pose: roBrowser's default)
  AM_CALLHOMUN: { does: 'callHomun', pose: true },
  AM_REST: { does: 'restHomun', pose: true },
  AM_RESURRECTHOMUN: { does: 'reviveHomun', pose: true },
  // the homunculus's own (skills/homunculus/*.cpp; its AI picks them: homunSkill): on its master, on both, on itself, at
  // its target (Moonlight and S.B.R.44 with its attack motion), Caprice one of four bolts, Bio Explosion round itself
  HLIF_HEAL: { does: 'homunHeal', mob: true, still: true },
  HLIF_AVOID: { does: 'homunBoth', mob: true, still: true },
  HAMI_DEFENCE: { does: 'homunBoth', mob: true, still: true },
  HLIF_CHANGE: { does: 'homunSelf', mob: true, still: true },
  HAMI_BLOODLUST: { does: 'homunSelf', mob: true, still: true },
  HFLI_FLEET: { does: 'homunSelf', mob: true, still: true },
  HFLI_SPEED: { does: 'homunSelf', mob: true, still: true },
  HAMI_CASTLE: { does: 'castling', mob: true, still: true },
  HFLI_MOON: { does: 'attack', mob: true },
  HFLI_SBR44: { does: 'attack', mob: true },
  HVAN_CAPRICE: { does: 'caprice', mob: true },
  HVAN_CHAOTIC: { does: 'chaotic', mob: true, still: true },
  HVAN_EXPLOSION: { does: 'bioExplosion', mob: true, still: true },
  // the Marine Sphere's (mob_skill_db): Random Move, run off from whoever hit it (a 'target' row, used with no target:
  // `untargeted`), Speed Up as it runs, then Self Destruction
  NPC_RANDOMMOVE: { does: 'randomMove', mob: true, self: true, untargeted: true, still: true, quiet: true },
  NPC_SPEEDUP: { does: 'speedUp', mob: true, self: true, still: true, quiet: true },
  NPC_SELFDESTRUCTION: { does: 'selfDestruct', mob: true, self: true, still: true },
  NPC_WIDESILENCE: { does: 'wide', ail: 'silence' },
  NPC_WIDECONFUSE: { does: 'wide', ail: 'confuse' },
  // what is put on the ground: the hunter's traps (a character's take Booby Traps, ITEM_COST; set in the casting pose,
  // roBrowser's default), Venom Dust (a Red Gemstone)
  HT_SANDMAN: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  HT_SKIDTRAP: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  HT_LANDMINE: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  HT_ANKLESNARE: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  HT_SHOCKWAVE: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  HT_FLASHER: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  HT_FREEZINGTRAP: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  HT_BLASTMINE: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  HT_CLAYMORETRAP: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  HT_REMOVETRAP: { does: 'ground', pose: true, place: (u, p, cell, t) => removeTrap(u, p, cell, t) },
  HT_SPRINGTRAP: { does: 'ground', pose: true, place: (u, p, cell, t) => disarm(u, p, cell, t) },
  HT_TALKIEBOX: { does: 'ground', pose: true, place: (u, p, cell, t) => placeTrap(u, p, cell, t) },
  AS_VENOMDUST: { does: 'ground', pose: true, place: (u, p, cell, t) => placeDust(u, p, cell, t) },
  PR_SANCTUARY: { does: 'ground', pose: true, area: 3, place: (u, p, cell, t) => placeSanctuary(u, p, cell, t) },
  PR_MAGNUS: { does: 'ground', pose: true, area: 4, place: (u, p, cell, t) => placeMagnus(u, p, cell, t) },
  PF_SPIDERWEB: { does: 'web', mob: true },
  // more of its kind (monsters only): its slaves (summonMobs), or what it hatches into (morph)
  NPC_SUMMONSLAVE: { does: 'summon', mob: true },
  NPC_METAMORPHOSIS: { does: 'morph', mob: true },
  // an emote (monsters only), with no motion and its name not shouted (`quiet`)
  NPC_EMOTION: { does: 'emote', mob: true, still: true, quiet: true },
};
// the emotes (clif_emotion's ET_ ids) the sim shows itself; a skill row's own are its `emotion` column
const ET_QUESTION = 1, ET_SWEAT = 4, ET_ANGER = 7, ET_MAX = 81;
export const usable = name => !!SKILL_USE[name];
// the action group a character holds while casting skill sk: its `group` (Find Stone's picking up), else the 詠唱 pose
export const castGroup = sk => SKILL_USE[sk.name]?.group ?? 12;
// a character's cast time for skill sk at level lv (none for a `noCast` one)
// (and none for Asura Strike right after Raging Thrust: skill_castfix_sc, SC_COMBO MO_COMBOFINISH)
const castTimeOf = (sk, lv, pc, u = null) => SKILL_USE[sk.name]?.noCast || (u && sk.name === 'MO_EXTREMITYFIST' && inCombo(u, 'MO_COMBOFINISH')) ? 0 : B.castTime(sk, lv, pc);
// the cells around its target cell a ground skill reaches at level lv (SKILL_USE's `area`, or its splash)
export const areaOf = (sk, lv) => sk.name === 'SA_LANDPROTECTOR' ? fieldReach(sk.name, lv) : SKILL_USE[sk.name]?.area ?? (sk.splash[lv - 1] || 0);
// when skill `name` starts landing after it goes off, for an attack motion amotion long with its hit on hitFrame (ms)
// (`flight`: ms more for what it throws to get there: Stone Fling's stone leaves on the hit frame)
const hitDelay = (name, amotion, hitFrame) => {
  const at = SKILL_USE[name].hitAt, flight = SKILL_USE[name].flight || 0;
  return (at === 'frame' ? hitFrame : at != null ? amotion * at : amotion) + flight;
};

// ---------- units ----------
// A unit is a character (isPc, see newChar) or a monster (see addMob). Every unit has: side (who fights whom:
// 'party' or 'monsters'), w (its mover), hp, dead (time of death, or null), dying (a monster between losing its
// last HP and the last hit of the attack that took it), cast (a skill being cast: { sk, lv, target, start, end,
// cancelable }), sc (statuses on it: { name (the skill that put it there), lv, until (Infinity: until ended), effect
// (a STATUS_SKILLS status' figures, for withStatus), hits (Endure's left), auto (Auto Berserk's Provoke), start,
// ticks (Hiding's seconds gone by) }),
// frozen ({ until } while frozen), stunned ({ until } while stunned), poison ({ until, next (its next HP loss) }),
// blind ({ until }), silenced ({ until }), confused ({ until }), curse ({ until }), asleep ({ until }), stopped
// ({ until, with: the unit held with it }), webbed ({ until, n, webs }: see placeWeb), hallucinating ({ until }), orcish ({ until }), stolen (a successful Steal took from it), stone ({ wait, until, on, drain } while
// petrified or about to be: see petrify) and anim (its motion).
// The rules below take either kind (as rAthena's unit.cpp, status.cpp and battle.cpp do); what differs by kind
// — its status, its motions, how it reacts to a hit, and its brain (the player's orders and 自動 for a
// character, mob AI for a monster) — is in the characters' and the monsters' sections.
// (a falling icicle is no unit to anyone: ICICLES)
const units = () => [...W.chars, ...W.rivals, ...W.mobs.filter(m => !m.trap)];
const inFight = u => W.chars.includes(u) || W.rivals.includes(u) || W.mobs.includes(u);
const alive = u => u.dead == null && !u.dying;
// the enemies unit u can see: not those in hiding (see sees)
const enemies = u => units().filter(x => x.side !== u.side && sees(u, x));
// (a character's the party, a monster's the monsters of its side: not the party's summons, sim.js summonFor, nor their master)
const allies = u => units().filter(x => x.side === u.side && x.isPc === u.isPc);
// ---------- the rival team (by request: two teams fighting; the monsters fight both) ----------
// Its characters (W.rivals) are characters as the party's are, on side RIVAL, run by their own 自動; each team its
// own bag and money (purse), the monsters as they are. No damage cut between them (no GvG rules), no EXP lost on
// death while there is one (PvP: the map's noexppenalty), none gained by it (what it kills gives the party nothing).
export const RIVAL = 'rivals';
// every character in the fight, the party's and the rival team's
const allChars = () => [...W.chars, ...W.rivals];
export const everyChar = allChars;
// character c's own team (the party, or the rival team)
const crewOf = c => (c.side === RIVAL ? W.rivals : W.chars);
// the bag and money of unit u's team (a summon's or homunculus's: its master's): W itself for the party
function newPurse() { return { bag: {}, zeny: 0, used: {}, spent: 0, loot: {} }; }
const purse = u => ((u.owner || u.master || u).side === RIVAL ? W.rival : W);
export const purseOf = purse;
// unit u's attack range and the ms it walks a cell in, a character's or a monster's
const atkRangeOf = u => (u.isPc ? u.pc.range : u.st.range);
const walkMsOf = u => (u.isPc ? u.pc.walkSpeed : u.st.walkSpeed);
// unit u is swinging at its target (a monster in its attack state; a character with a target)
const onAttack = u => (u.isPc ? !!u.target && u.dead == null : u.mss === 'attack');
// unit u is in hiding (SC_HIDING, see DOES.hide)
const hidden = u => has(u, 'TF_HIDING');
export const isHidden = hidden;
// unit u cannot walk for hiding: in hiding without Stalk (status_check_skilluse NoMoveCond: a character with
// RG_TUNNELDRIVE learned walks, slower: B.playerStatus' walkSpeed)
const stuck = u => hidden(u) && !(u.isPc && passiveLv(u, 'RG_TUNNELDRIVE') > 0);
// unit u is cloaked (SC_CLOAKING: Cloaking, a monster's Invisible, see DOES.cloak): unseen as in hiding, but it
// walks and attacks
const cloaked = u => has(u, 'AS_CLOAKING');
export const isCloaked = cloaked;
// whether unit a sees unit b, to go for it, hit it or use a skill on it: one in hiding or cloaked only itself, a boss and
// a Detector monster do (status_check_visibility, status_check_skilluse; allies no more than enemies) — and, by request,
// a character with a card that sees them (Maya Purple's bIntravision: in rAthena only the client's showing them)
// (by request: a hit of a character with that card leaves the one it hits hidden or cloaked)
// (a card's bIntravision, or SC_INTRAVISION: Box of Sunlight's, openBox)
const clairvoyant = u => !!u.cardFx?.intravision || has(u, 'INTRAVISION');
const keepsHidden = by => !!by?.isPc && clairvoyant(by);
const sees = (a, b) => a === b || (!b.trap && ((!hidden(b) && !cloaked(b)) || (a.isPc ? clairvoyant(a) : isBoss(a) || !!(a.st.mode & B.MD.DETECTOR))));
const baseStatus = u => u.isPc ? u.pc : u.st;
// whom monster m is charmed by (Wink of Charm), and so will not attack
const charmedBy = m => (m.sc.find(s => s.name === 'DC_WINKCHARM' && W.t < s.until) || {}).by;
const maxHp = u => baseStatus(u).maxHp;
const isBoss = u => !!baseStatus(u).boss;
// the unit's status as it is now: with the status change on it (STATUS_SKILLS) while that lasts, and frozen
export function statusOf(u) {
  const sc = u.sc.find(s => s.effect && W.t < s.until);
  let base = u.frozen ? B.frozen(baseStatus(u)) : u.stone && u.stone.on ? B.stoned(baseStatus(u)) : baseStatus(u);
  if (u.poison) base = B.poisoned(base);
  if (u.webbed) base = B.webbed(base);
  if (u.blind) base = B.blinded(base);
  if (u.curse) base = B.cursed(base);
  // (a monster's equipment broken or taken off: B.stripped)
  const strips = !u.isPc && u.sc.filter(s => B.MOB_STRIPS[s.name] && W.t < s.until).map(s => s.name);
  if (strips && strips.length) base = B.stripped(base, strips);
  // (frozen, stunned, asleep or stone: always hit; asleep: critical hits twice as likely, see battle.js)
  if (u.frozen || u.stunned || u.asleep || (u.stone && u.stone.on)) base = { ...base, opt1: true, asleep: !!u.asleep };
  const slow = u.sc.find(s => s.name === 'AL_DECAGI' && W.t < s.until);
  if (slow) base = B.slowed(base, slow.lv);
  const quag = u.sc.find(s => s.name === 'WZ_QUAGMIRE' && W.t < s.until);
  if (quag) base = B.quagmired(base, quag.lv);
  // (a monster's Endure: + Lv MDEF, status_calc_mdef; a character's is in playerStatus with its other buffs)
  const endure = !u.isPc && u.sc.find(s => s.name === 'SM_ENDURE' && W.t < s.until);
  if (endure) base = { ...base, mdef: base.mdef + endure.lv };
  // (Down Tempo: no VIT DEF, status_calc_def2; before renewal the hard DEF stays)
  if (u.sc.some(s => s.name === 'BD_ETERNALCHAOS' && W.t < s.until)) base = { ...base, def2: 0 };
  const cross = u.sc.find(s => s.name === 'AL_CRUCIS');
  if (cross) base = B.crossed(base, cross.lv);
  // (a monster's Maximize Power: a character's is in playerStatus)
  if (!u.isPc && u.sc.some(s => s.name === 'BS_MAXIMIZE' && W.t < s.until)) base = { ...base, maximize: true };
  // (a monster in an element field: its element's % up, B.fieldUp; a character's is in playerStatus)
  if (!u.isPc && u.sc.some(s => B.BUFF_SKILLS[s.name]?.attrUp && W.t < s.until)) base = { ...base, attrUp: B.fieldUp(u.sc.filter(s => W.t < s.until)) };
  return B.withStatus(base, sc ? sc.effect : null);
}
// the unit as it attacks (a character: with what its passive skills add) and as it is hit
const offense = u => u.isPc ? attacker(u) : statusOf(u);
// (a character's FLEE drops with the monsters attacking it at once: B.crowdedFlee; divine: its Divine Protection)
function defense(u) {
  const st = statusOf(u);
  return { ...st, hp: u.hp, flee: u.isPc ? B.crowdedFlee(st.flee, crowd(u)) : st.flee, ...u.isPc && { divine: passiveLv(u, 'AL_DP') } };
}
// how many monsters are attacking unit u at once (unit_counttargeted: those whose attack target it is, set
// by unit_attack — here, the ones after it standing in range to attack, MSS_BERSERK; and the rival team's characters
// attacking it)
export const crowd = u => W.mobs.filter(m => alive(m) && m.target === u && m.mss === 'attack').length
  + allChars().filter(x => x.side !== u.side && alive(x) && x.target === u).length;
// skill sk's status at level lv on unit u from time t, for the skill's Duration1 (status_change_start); the same
// again starts over. A character's status is worked out again with it; a monster's is read as it is (statusOf).
// hits: the hits it has left, for one that ends after so many (Endure).
function addStatus(u, sk, lv, t, effect = null, ms = sk.duration[lv - 1] || 0) {
  const hits = (B.BUFF_SKILLS[sk.name] || {}).hits;
  u.sc = [...u.sc.filter(s => s.name !== sk.name), { name: sk.name, lv, start: t, until: t + ms, effect, ...hits && { hits } }];
  if (u.isPc) recalc(u); else mobRecalc(u);
}
// a monster's figures under its own buffs (B.mobBuffed), from those it came with (m.base), worked out again
// whenever a status on it begins or ends; its walk follows
function mobRecalc(m) {
  if (m.homun) return homunRecalc(m);
  if (!m.base) return;
  const on = m.sc.filter(s => W.t < s.until && B.MOB_BUFFS.includes(s.name));
  if (!on.length && !m.buffed) return;  // (nothing to put back)
  m.buffed = on.length > 0;
  Object.assign(m.st, B.mobBuffed(m.base, on));
  m.w.cellMs = m.st.walkSpeed;
}
// unit u's status `name` ends now, if it has it (status_change_end)
function endStatus(u, name) {
  if (!u.sc.some(s => s.name === name)) return;
  u.sc = u.sc.filter(s => s.name !== name);
  if (u.isPc) recalc(u); else mobRecalc(u);
}
// Hiding on character c pays 1 SP every Lv + 3 of its seconds, counted down from its duration (status_change_timer
// SC_HIDING: val2 the seconds left, val4 = Lv + 3), and ends when the SP is not there; monsters pay nothing
// (status_charge: only BL_CONSUME units)
function hidingDrain(c, t) {
  const s = c.sc.find(x => x.name === 'TF_HIDING');
  if (!s) return;
  const secs = Math.round((s.until - s.start) / 1000);
  s.ticks ??= 0;
  while (t - s.start >= (s.ticks + 1) * 1000) {
    const left = secs - ++s.ticks;
    if (left <= 0 || left % (s.lv + 3)) continue;
    if (c.sp < 1) return endStatus(c, 'TF_HIDING');
    c.sp -= 1;
    emit('hp', c);
  }
}
// Unit u stands by a wall: one of the 8 cells round it cannot be walked on (skill_check_cloaking: CELL_CHKNOPASS;
// off the floor counts so)
const byWall = u => [[0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]]
  .some(([dx, dy]) => !walkable(field.map.gat, u.w.cell[0] + dx, u.w.cell[1] + dy));
// Cloaking on character c (see DOES.cloak) pays 1 SP every Duration1 of its level, ending when the SP is not there
// (status_change_timer SC_CLOAKING); by a wall it walks faster, away from one slower, and below Lv 3 it ends
// there (skill_check_cloaking, as it moves: clif_walkok), its walk worked out again as that changes
function cloakTurn(c, t) {
  const s = c.sc.find(x => x.name === 'AS_CLOAKING');
  if (!s) return;
  const every = db.skills.AS_CLOAKING.duration[s.lv - 1] || 1000;
  s.paid ??= 0;
  while (t - s.start >= (s.paid + 1) * every) {
    s.paid++;
    if (c.sp < 1) return endStatus(c, 'AS_CLOAKING');
    c.sp -= 1;
    emit('hp', c);
  }
  const wall = byWall(c);
  if (wall === s.wall) return;
  if (!wall && s.lv < 3) return endStatus(c, 'AS_CLOAKING');
  s.wall = wall;
  recalc(c);
}
// Maximize Power on character c (B.BUFF_SKILLS) pays 1 SP every Duration1 of its level (Lv s), ending when the SP is
// not there (status_change_timer SC_MAXIMIZEPOWER, as Cloaking's)
function maximizeDrain(c, t) {
  const s = c.sc.find(x => x.name === 'BS_MAXIMIZE');
  if (!s) return;
  const every = db.skills.BS_MAXIMIZE.duration[s.lv - 1] || 1000;
  s.paid ??= 0;
  while (t - s.start >= (s.paid + 1) * every) {
    s.paid++;
    if (c.sp < 1) return endStatus(c, 'BS_MAXIMIZE');
    c.sp -= 1;
    emit('hp', c);
  }
}
// everyone in hiding within `area` cells of unit u comes out of it (status_change_timer_sub: Sight and Ruwach
// every 20 ms while they last, Improve Concentration as it is used), whichever side — or with foesOnly, only u's
// enemies (Sight and Ruwach here: a party member's leaves the party's hidden ones be, by request; rAthena
// reveals them too). Returns the ones that came out.
function reveal(u, area, foesOnly = false) {
  const out = units().filter(x => x.dead == null && (hidden(x) || cloaked(x)) && !(foesOnly && x.side === u.side) && field.distance(u.w, x.w) <= area);
  for (const x of out) { endStatus(x, 'TF_HIDING'); endStatus(x, 'AS_CLOAKING'); }
  return out;
}
// whoever cannot see unit u now (it went into hiding) lets it go: a character stops attacking it and drops a
// skill on it, a monster drops it as its target (mob_ai_sub_hard: status_check_visibility), a cast at it fails,
// and a hit of theirs still on its way (not yet landed) is called off, by request
function lostSight(u, t) {
  W.hits = W.hits.filter(h => h.to !== u || sees(h.from, u));
  for (const x of units()) {
    if (x === u || sees(x, u)) continue;
    if (x.target === u) { if (x.isPc) loseFoe(x); else unlockTarget(x, t); }
    if (x.cast && x.cast.target === u) x.cast = null;
    if (x.isPc && x.pending && x.pending.target === u) x.pending = null;
  }
}
// statuses whose time is up end (status_change_end → status_calc_pc: the character is back as it was)
function expireStatuses(u, t) {
  if (!u.sc.some(s => t >= s.until)) return;
  // (a homunculus's Mental Change running out leaves it at 10 HP and 10 SP: status_change_end_ SC_CHANGE)
  if (u.homun && u.sc.some(s => s.name === 'HLIF_CHANGE' && t >= s.until)) { u.hp = Math.min(u.hp, 10); u.sp = Math.min(u.sp, 10); emit('hp', u); }
  u.sc = u.sc.filter(s => t < s.until);
  if (u.isPc) recalc(u); else mobRecalc(u);
}
// every status on u ends (status_change_clear)
function clearStatuses(u) {
  if (!u.sc.length) return;
  u.sc = [];
  if (u.isPc) recalc(u); else mobRecalc(u);
}
// whoever is after u lets it go (it died or left)
function dropTarget(u, t) {
  for (const x of units()) {
    if (x.target === u) { if (x.isPc) loseFoe(x); else unlockTarget(x, t); }
    // a cast at it (magic cast from aside, a heal) stops too: its target is gone (skill_castend_id fails)
    if (x.cast && x.cast.target === u) x.cast = null;
    if (x.isPc && x.pending && x.pending.target === u) x.pending = null;
  }
}

// ---------- characters ----------
// a character: what the party remembers (look, levels, stats, skill levels) and its fight
let nextId = 1;
export function newChar(saved = {}) {
  const c = {
    isPc: true, side: 'party', id: nextId++, w: null,
    // sex, job, weapon (remembered: a job that cannot hold it shows bare hands), hair and hdye (hairstyle id and
    // hair colour, null = the default colour; picked at random when missing); index.html's loadLook adds
    // label, body, weapons (the job's), held (the weapon shown) and ch (the sprites)
    look: { sex: saved.sex || '남', job: saved.job || '초보자', weapon: saved.weapon || '', shield: saved.shield || '', hair: saved.hair ?? null, hdye: saved.hdye ?? null, mount: saved.mount ?? null, noFalcon: !!saved.noFalcon,
      // (the game's headgear: { top, mid, low } item ids, jobs.json headgear; look.js draws them)
      ...saved.hats ? { hats: { ...saved.hats } } : {} },
    ownHats: saved.ownHats ? [...saved.ownHats] : [],  // (the game's: the headgear worn that came with it, a recruit's; the rest is the party's)
    arm: saved.arm || null,  // the weapon it has (an item id in jobs.json gear: weaponInfo), or none
    armL: saved.armL || null,  // the one in its left hand (an assassin's: leftArm), or none
    body: saved.body || null,  // the body armour it wears (an item id in jobs.json armors: calc), or none
    cards: saved.cards ? [...saved.cards] : [],  // the game's: the cards on it (item ids in jobs.json cards, as many of one as it has: calc)
    hands: saved.hands || null,  // the game's: what it holds, picked (game.js autoGear: { right: a weapon type, left })
    blv: +saved.blv || 1, jlv: +saved.jlv || 1,  // (numbers: once kept as the panel typed them, strings)
    // (by request) a second job's first job's level when it changed (changeJob; null: at the top, 50), and a first
    // job's plan: the second job it is to change to and at what job level (the game's recruits; null for none)
    firstJlv: +saved.firstJlv || null, second: saved.second || null, changeAt: +saved.changeAt || null,
    homun: saved.homun ? { id: saved.homun, state: saved.homunState || 'rest', unit: null, evolved: !!saved.homunEvo, evoLv: saved.homunEvoLv ?? null } : null,  // (its homunculus: see spawnHomun)
    bexp: saved.bexp || 0, jexp: saved.jexp || 0,  // EXP toward the next base / job level
    stats: Object.fromEntries(B.STATS.map(s => [s, (saved.stats || {})[s] || 1])),
    // the build its stat points go into on their own (builds.js: an id, or steps as they are; null: 自訂, they
    // wait to be spent by hand). One saved before there were builds is on its job's first.
    build: saved.build !== undefined ? liveBuild(saved.build) : defaultBuild(saved.job || '초보자'),
    levels: { ...saved.levels },  // skill → level chosen in the skill list
    plag: saved.plag || null,  // the skill Plagiarism copied, { name, lv } (plagiarize)
    // the skill build its skill points go into on their own (builds.js; null: 自訂). One saved before there were
    // skill builds is on its job's first.
    skillBuild: saved.skillBuild !== undefined ? saved.skillBuild : defaultSkillBuild(saved.job || '초보자'),
    pc: null,                // status
    hp: null, sp: null, dead: null,  // HP / SP; time of death (null = alive)
    regen: { hp: 0, sp: 0 },  // last natural regen ticks
    pending: null,           // skill to use once in range: { sk, lv, target }
    selfPending: null,       // skill on the character itself (area around it) to use once free: { sk, lv }
    cooldown: {},            // skill → time it can be used again
    sc: [], frozen: null, stunned: null,  // statuses on it, a freeze, a stun (see units)
    cast: null,              // skill being cast: { sk, lv, target, start, end }
    canAct: 0,               // no skill or attack before this (skill delay / attack motion)
    target: null,            // monster the character was told to attack
    auto: saved.auto ?? true,  // 自動 (its tactics, see think) or 手動 (only what the player tells it)
    autoPick: null,          // the target 自動 picked (turning 手動 drops only that one)
    // the preset its 自動 rules come from ('basic', 'job': its job line's, or the id of one the player saved),
    // and its own rules, edited from the preset's (null: the preset's; see rulesOf). (A character saved before
    // there were presets is on its job line's.)
    tactic: saved.tactic || 'job', rules: saved.rules || null,
    rule: null,              // the rule 自動 last followed (its index in rulesOf(c))
    aiAt: null, aiFoes: 0,   // when 自動 next reads its rules, and how many monsters were standing then (see think)
    stallHit: null,          // the monster it went for with nobody fighting (see stalled)
    aiWalk: false, aiSat: false,  // the walk it is on ('back': backing off, 'rest'), the sitting down: 自動's (not the player's)
    sitAfter: 0,             // 自動 sits down again no sooner (see pcHurt)
    restAt: null,            // the cell 自動 sits out a lull on (see restSpot)
    running: false,          // in range and attacking
    sitting: false,          // sat down (坐下): no walking or normal attacks, regen twice as fast
    vending: null,           // its shop, while it vends (Vending): { title, since }
    recover: 0,              // hit while walking: the sandbox walks the character on by itself from this time
    stops: [],               // when damage stopped its walk lately (see STOP_MS)
    ready: 0,                // the next normal attack can start from this time (attackabletime)
    stay: false,             // standing its ground (a gamepad's L2): it attacks what is in its reach, walking to nothing
    next: 0, anim: null, hurt: null,
    alert: false,            // in the battle stance (待機, action 4) since its last attack, skill or damage, until it walks
    last: null,              // the character's last hit, for the info line
    dealt: [], dealtSince: null,  // damage it has dealt lately, and since when (see dps)
    // set as it fights, here so a map fought again (sandbox.js freshFight: newChar's fields over the old ones)
    // starts without the last one's (by report: its times, from a later clock, kept a replay fought again from
    // drinking and had the thief hide from damage taken in the last one)
    taken: [],               // damage it has taken lately (see burst)
    itemAt: 0,               // no item before this (see drink)
    stones: 0,               // stones picked up (see pickStone)
    spheres: [],             // its spirit spheres: when each goes, soonest first (see addSphere)
    combo: null,             // the monk's combo it may follow up now (see startCombo)
    endureUntil: 0, loot: null,
  };
  c.look.id = c.id;
  return c;
}

export const clampv = (x, lo, hi) => {
  const v = Math.trunc(+x);
  return Number.isFinite(v) && x !== '' ? Math.min(hi, Math.max(lo, v)) : lo;
};
// the character's job in jobs.json (null: rAthena has none for it), and the one its figures use
// (a node of two jobs, a bard and a dancer: the female one's own skills, ASPD and bonus over it, jobs.json female)
const femaleJobs = new WeakMap();
export const jobOf = c => {
  const j = db.jobs[c.look.job] || null;
  if (!j || !j.female || c.look.sex !== '여') return j;
  if (!femaleJobs.has(j)) femaleJobs.set(j, { ...j, ...j.female });
  return femaleJobs.get(j);
};
export const jobFor = c => jobOf(c) || db.jobs['초보자'];

// ---------- status ----------
// work character c's status out from its levels, stats, weapon, passive skills and statuses; full HP / SP
// stay full when the max changes
// fill: a character at full HP or SP stays full (what the panel changes); a status that raises MaxHP leaves HP
// as it is (Angelus: status_calc_bl_ only caps HP at the new MaxHP)
export function calc(c, fill = true) {
  const jj = jobFor(c);
  const blv = clampv(c.blv, 1, jj.maxBase), jlv = clampv(c.jlv, 1, jj.maxJob);
  const base = Object.fromEntries(B.STATS.map(s => [s, clampv(c.stats[s], 1, jj.maxStat)]));
  const full = c.hp == null || (fill && c.pc && c.hp === c.pc.maxHp), spFull = fill && c.pc && c.sp === c.pc.maxSp;
  fitSkills(c);  // (first: passive levels go into the status)
  // (off the Peco with Riding unlearned: pc_checkskill.) On it (by request) once Riding is learned, and with it learned
  // already when the toggle was never set (look.mount null: a new character, one saved before this): off, by the
  // player, it stays off until Riding is learned again
  const rides = passiveLv(c, 'KN_RIDING') > 0;
  if (!rides) { if (c.look.mount) c.look.mount = false; }
  else if (c.look.mount == null || c.rides === false) c.look.mount = true;
  c.rides = rides;
  const weapon = weaponInfo(c);
  if (weapon.type === 'Bow') weapon.range += passiveLv(c, 'AC_VULTURE');  // Vulture's Eye
  // a status that needs the weapon its skill asked for ends with another in hand (status.yml RequireWeapon: Two-Hand
  // Quicken without a two-handed sword, Adrenaline Rush without an axe or a mace: skill_db Requires)
  if (c.sc) c.sc = c.sc.filter(s => !REQUIRE_WEAPON.has(s.name) || (db.skills[s.name].weapon || []).includes(weapon.type));
  const passives = Object.fromEntries(Object.keys(B.PASSIVE_SKILLS).map(k => [k, passiveLv(c, k)]));
  // (the shield: its DEF, the job's ASPD for it, Shield Boomerang's weight; a status needing one ends without it)
  const shield = SHIELDS[heldShield(c)] || null;
  // (Shrink's own status stays, and what Sacrifice gave)
  if (c.sc && !shield) c.sc = c.sc.filter(s => !NEED_SHIELD.has(s.name) || s.name === 'CR_SHRINK' || s.devoted);
  // (the body armour, the game's: c.body, an item id in jobs.json armors)
  const armor = c.body && db.armors && db.armors[c.body] || null;
  // (the cards on it, by request: what they add up to there, their scripts' conditions on its job, levels, stats and weapon)
  const cards = cardsOn(c, jj, blv, jlv, base, weapon);
  c.cardFx = cards;  // (what goes off as it hits, is hit or kills: cardsOnHit, cardsOnKill)
  const pc = c.pc = B.playerStatus(db, { job: jj, baseLv: blv, jobLv: jlv, base, weapon, shield, armor, buffs: c.sc, passives, cursed: !!c.curse, riding: riding(c), cards });
  c.hp = full && c.dead == null ? pc.maxHp : Math.min(c.hp, pc.maxHp);
  if (c.w) c.w.cellMs = pc.walkSpeed;  // Increase AGI walks faster
  c.sp = c.sp == null || spFull ? pc.maxSp : Math.min(c.sp, pc.maxSp);
  return { jj, blv, jlv, base };
}
// what the cards on character c (c.cards: jobs.json cards ids) add up to (cards.js cardBonus), null for none
function cardsOn(c, jj, blv, jlv, base, weapon) {
  if (!c.cards || !c.cards.length || !db.cards) return null;
  // (and what an autobonus of theirs has on for now: its script as one more card, cardBuffs)
  const on = (c.cardBuffs || []).filter(b => b.until > W.t).map(b => ({ id: 'buff:' + b.script, script: b.script }));
  return cardBonus([...c.cards.map(cardOf), ...on], whoOf(c, jj, blv, jlv, base, weapon));
}
// a card by its id (jobs.json cards, with its id), the same object every time (cards.js keeps what it works out on it)
const cardObjs = new Map();
export const cardOf = id => { if (!cardObjs.has(+id) && db.cards && db.cards[id]) cardObjs.set(+id, { id: +id, ...db.cards[id] }); return cardObjs.get(+id) || null; };
// character c as a card's script sees it (cards.js run: its job line, levels, stats put in, weapon, cards)
function whoOf(c, jj, blv, jlv, base, weapon) {
  const first = jj.tier === 2 ? db.jobs[firstJobOf(c.look.job)] : null;
  return { ...jobConsts(jj, first, c.look.sex), jobLv: jlv, baseLv: blv, stats: base, levels: c.levels, weapon: weapon.type, cards: c.cards || [] };
}
export function cardWho(c) {
  const jj = jobFor(c);
  return whoOf(c, jj, clampv(c.blv, 1, jj.maxBase), clampv(c.jlv, 1, jj.maxJob), Object.fromEntries(B.STATS.map(s => [s, clampv(c.stats[s], 1, jj.maxStat)])), weaponInfo(c));
}
const MOB_MAXIMIZE_MS = 10000;
const REQUIRE_WEAPON = new Set(['KN_TWOHANDQUICKEN', 'BS_ADRENALINE', 'CR_SPEARQUICKEN']);
// the crusader's skills used with a shield in the left hand (skill_db Requires: Shield; the client's 裝備盾牌後可使用),
// failing without one; their statuses end once it is off (status.yml RemoveOnUnequipArmor / skill_unequip)
export const NEED_SHIELD = new Set(['CR_AUTOGUARD', 'CR_SHIELDCHARGE', 'CR_SHIELDBOOMERANG', 'CR_REFLECTSHIELD', 'CR_DEFENDER', 'CR_SHRINK']);
// a character's status changed (a status on it began or ended): work it out again
function recalc(c) {
  calc(c, false);
  emit('status', c);
}

// ---------- skills ----------
// the skills of character c's job that are worked out (SKILL_USE, and battle.js' PASSIVE_SKILLS),
// in skill_tree order (one list a job, made once and shared: not to be changed)
export const jobSkills = c => skillTable(jobFor(c)).list;
const skillTables = new WeakMap();  // job → { list (jobSkills'), names (of them) }
function skillTable(j) {
  let x = skillTables.get(j);
  if (!x) {
    const list = Object.freeze(Object.entries(j.skills).filter(([k]) => ((SKILL_USE[k] && !SKILL_USE[k].mob) || B.PASSIVE_SKILLS[k]) && db.skills[k])
      .map(([k, max]) => Object.freeze({ ...db.skills[k], max })));
    skillTables.set(j, x = { list, names: new Set(list.map(sk => sk.name)) });
  }
  return x;
}
// the skill points character c has: those of the jobs before its own (jobs.json earlierPoints), and 1 a job
// level after the first
// (a second job changed before its first job's top level, c.firstJlv, the points of the levels it did not reach fewer)
export const skillPoints = c => { const j = jobFor(c); return (j.earlierPoints || 0) - earlyBy(c) + clampv(c.jlv, 1, j.maxJob) - 1; };
// the job c changed from early (c.firstJlv), and the job levels short of its top (0 for none)
const firstOf = c => { const f = c.firstJlv && jobFor(c).tier === 2 && firstJobOf(c.look.job); return f && db.jobs[f] ? db.jobs[f] : null; };
const earlyBy = c => { const f = firstOf(c); return f ? f.maxJob - clampv(c.firstJlv, 1, f.maxJob) : 0; };
// keep character c's skill levels to what it can learn (pc_skillup): a skill only once the skills its job's
// tree wants first (skill_tree Requires) are at the levels asked, and all of them within its skill points. A
// skill not set yet in the list is taken at its top level, as far as the points go (0: not learned). The skills
// go in the tree's order, each after those it needs, so lowering one unlearns what needs it and the points run
// out on the last. A skill the sandbox leaves out of the list (it does not work it out) that one in it needs
// is taken as learned to the level asked, its points spent with it. A quest skill (skill_db IsQuest: First Aid,
// Fatal Blow, Holy Light…) is learned through a quest, not with points: at its top level, for nothing, whatever
// the tree says it needs, once the job level its quest asks for is reached (QUEST_JLV; by request, as the quest
// would be done then).
// → { total, left, hidden (left-out skill → level), top (skill → highest level the list offers, its needs
//     raised with it: plan), lacking (skill → [[skill, level], ...] it needs and is short of),
//     plan (skill, level → { want: {skill in the list: level it goes to}, cost }: what learning it takes) }
export const questSkill = name => !!(db.skills[name] || {}).quest;
// The job level a skill's quest asks for (rAthena npc/quests/skills/*_skills.txt: the NPC's JobLevel check), and
// the tier of the job it is of: [job level, tier]. One of the job a tier below the character's (a Knight's
// Fatal Blow) the quest gives at any job level (its `BaseJob == Job_Knight ||`). The others' quests ask for none
// (Novice's First Aid: past job level 3, which a first job is).
export const QUEST_JLV = {
  DC_WINKCHARM: [40, 2],
  SM_MOVINGRECOVERY: [35, 1], SM_FATALBLOW: [25, 1], SM_AUTOBERSERK: [30, 1], MG_ENERGYCOAT: [35, 1], AL_HOLYLIGHT: [30, 1],
  AC_MAKINGARROW: [30, 1], AC_CHARGEARROW: [35, 1], MC_LOUD: [15, 1], MC_CHANGECART: [30, 1], MC_CARTREVOLUTION: [35, 1],
  TF_THROWSTONE: [15, 1], TF_PICKSTONE: [20, 1], TF_SPRINKLESAND: [25, 1], TF_BACKSLIDING: [35, 1],
  BS_UNFAIRLYTRICK: [30, 2], AM_BIOETHICS: [40, 2], HT_PHANTASMIC: [40, 2], BA_PANGVOICE: [40, 2],
};
// character c has done quest skill `name`'s quest (see QUEST_JLV)
export const questDone = (c, name) => { const q = QUEST_JLV[name]; return !q || jobFor(c).tier > q[1] || (c.jlv || 1) >= q[0]; };
export function fitSkills(c) {
  const j = jobFor(c), requires = j.requires || {}, list = jobSkills(c), shown = new Set(list.map(sk => sk.name));
  const total = skillPoints(c), hidden = {}, top = {}, lacking = {};
  const paid = r => r in j.skills && !questSkill(r);  // (a skill outside the job's tree, or a quest one, costs nothing)
  // the left-out skills (and the ones they need in turn) skill `name` brings in, as {skill: level}
  const brought = (name, into = {}) => {
    for (const [r, l] of requires[name] || []) {
      if (shown.has(r) || !paid(r) || Math.max(hidden[r] || 0, into[r] || 0) >= l) continue;
      into[r] = l;
      brought(r, into);
    }
    return into;
  };
  const cost = more => Object.entries(more).reduce((n, [r, l]) => n + l - (hidden[r] || 0), 0);
  const depth = {}, deep = n => depth[n] ??= Math.max(-1, ...(requires[n] || []).filter(([r]) => shown.has(r)).map(([r]) => deep(r))) + 1;
  let left = total;
  for (const sk of [...list].sort((a, b) => deep(a.name) - deep(b.name))) {
    const name = sk.name;
    if (questSkill(name)) { c.levels[name] = questDone(c, name) ? sk.max : 0; continue; }
    const more = brought(name);
    const short = [...requires[name] || [], ...Object.keys(more).flatMap(r => requires[r] || [])]
      .filter(([r, l]) => shown.has(r) && (c.levels[r] || 0) < l);
    let lv = clampv(c.levels[name] ?? sk.max, 0, sk.max);
    if (short.length) { lacking[name] = short; c.levels[name] = 0; continue; }
    const extra = cost(more);
    lv = left > extra ? Math.min(lv, left - extra) : 0;
    if (lv) { Object.assign(hidden, more); left -= extra + lv; }
    c.levels[name] = lv;
  }
  // skill `name` at level lv with everything it needs (in the list or left out, in turn) raised to the levels
  // asked: the levels in the list it takes, and the points (none for what is there already)
  const plan = (name, lv) => {
    const want = {}, more = {};
    const up = (n, l) => {
      if (shown.has(n)) {
        if (questSkill(n) || Math.max(want[n] || 0, c.levels[n] || 0) >= l) return;
        want[n] = l;
      }
      for (const [r, rl] of requires[n] || []) if (paid(r)) up(r, rl);
    };
    up(name, lv);
    for (const n of Object.keys(want)) brought(n, more);
    return { want, cost: Object.entries(want).reduce((s, [n, l]) => s + l - (c.levels[n] || 0), 0) + cost(more) };
  };
  // (raised in the list, a skill takes only points left over, so none it had goes from another)
  for (const sk of list) {
    let t = c.levels[sk.name];
    if (!questSkill(sk.name)) while (t < sk.max && plan(sk.name, t + 1).cost <= left) t++;
    top[sk.name] = t;
  }
  return { total, left, hidden, top, lacking, plan };
}
// the skill build a character of job `job` starts on: its first (builds.js), or none
export const defaultSkillBuild = job => (skillBuildsFor(job)[0] || {}).id || null;
// Spend character c's skill points left on its skill build (c.skillBuild, builds.js): its steps in order, each
// skill raised a level at a time to the level the step lists; once they run out, the rest wait for the next job
// level. (A skill already that high is passed by.) False without a build.
export function autoSkills(c) {
  const steps = skillStepsOf(c.skillBuild);
  if (!steps) return false;
  walkSteps(c, buildOrder(c, steps));
  return true;
}
// character c takes steps in order as far as its points go: the index of the step it stopped on (steps.length: all)
function walkSteps(c, steps) {
  const names = skillTable(jobFor(c)).names;
  // (a level at a time, at what it costs with what it needs: the left-out skills it brings in too, Pharmacy for Bio
  // Cannibalize, fitSkills' plan; one it cannot have yet, its quest skill not done, ends the build there)
  let f = fitSkills(c);
  for (let k = 0; k < steps.length; k++) {
    const [name, lv] = steps[k];
    if (!names.has(name)) continue;
    while ((c.levels[name] || 0) < lv) {
      const was = c.levels[name] || 0, p = f.plan(name, was + 1);
      if (p.cost > f.left) break;
      Object.assign(c.levels, p.want);
      f = fitSkills(c);
      if ((c.levels[name] || 0) <= was) break;
    }
    if ((c.levels[name] || 0) < lv) return k;
  }
  return steps.length;
}
// The steps of a skill build in the order character c takes them. A second job changed early (c.firstJlv, by
// request): first what its first job had learned of them by then (as far as they went, the one it stopped on as
// far as it got), then the rest in order without the first job's skills it had not got to before its top level
// (they would take the points its own skills go to first), and those last. (The skills its own need first come
// in with them all the same: fitSkills' plan.)
const orders = new Map();  // first job, sex, skill build, job level → the order
function buildOrder(c, steps) {
  const first = firstOf(c);
  if (!first || earlyBy(c) <= 0) return steps;
  const key = [first.name, c.look.sex, c.skillBuild, c.firstJlv].join('|');
  if (orders.has(key)) return orders.get(key);
  const fj = Object.keys(db.jobs).find(k => db.jobs[k] === first);
  const asFirst = jlv => { const f = { look: { job: fj, sex: c.look.sex }, jlv, levels: Object.fromEntries(skillTable(first).list.filter(sk => !questSkill(sk.name)).map(sk => [sk.name, 0])) }; return { k: walkSteps(f, steps), levels: f.levels }; };
  const got = asFirst(clampv(c.firstJlv, 1, first.maxJob)), top = asFirst(first.maxJob);
  const names = skillTable(first).names, put = new Set();
  const late = steps.slice(got.k, top.k).filter(([n]) => names.has(n));
  late.forEach(st => put.add(st));
  const [at, lv] = steps[got.k] || [], had = at && names.has(at) ? got.levels[at] || 0 : 0;
  const order = [...steps.slice(0, got.k), ...had ? [[at, had]] : [], ...steps.slice(got.k).filter(st => !put.has(st)), ...late];
  orders.set(key, order);
  return order;
}
// take back all of character c's skill points and spend them again on its skill build (none: they stay)
export function refitSkills(c) {
  if (!skillStepsOf(c.skillBuild)) return false;
  for (const sk of jobSkills(c)) if (!questSkill(sk.name)) c.levels[sk.name] = 0;
  return autoSkills(c);
}
// (by request) first job character c changes to second job `job` at the job level it is on (kept: firstJlv, its skill
// points), at job level 1 with no job EXP; its levels, stats and skills stay. A stat or skill build of the other second
// job goes over to one of its own (spent again on it), and a character on its line's 職業預設 goes on the new line's.
export function changeJob(c, job) {
  const from = jobFor(c);
  c.firstJlv = clampv(c.jlv, 1, from.maxJob);
  c.look.job = job;
  c.jlv = 1; c.jexp = 0;
  c.second = null; c.changeAt = null;
  for (const sk of jobSkills(c)) if (!(sk.name in c.levels) && !questSkill(sk.name)) c.levels[sk.name] = 0;  // (not at their top: fitSkills)
  if (c.build && !Array.isArray(c.build) && !buildsFor(job).some(b => b.id === c.build)) { c.build = defaultBuild(job); refitStats(c); }
  if (c.skillBuild && !skillBuildsFor(job).some(b => b.id === c.skillBuild)) { c.skillBuild = defaultSkillBuild(job); refitSkills(c); }
  else autoSkills(c);
  c.rule = null;
}
// character c learns skill `name` at level lv: what it needs first, short of the levels asked, is raised to
// them too (as far as the points go: see fitSkills' top); lower, it unlearns what needs it more
export function learnSkill(c, name, lv) {
  if (questSkill(name)) return;
  const want = lv > (c.levels[name] || 0) ? fitSkills(c).plan(name, lv).want : { [name]: lv };
  Object.assign(c.levels, want);
}
// character c's job has this skill and it is learned (a level above 0 in the list)
export const knows = (c, name) => skillLv(c, name) > 0;
// the level character c uses skill `name` at: its own learned one, else the one Plagiarism copied (c.plag, while it
// has Plagiarism learned: plagiarize); 0 if neither
export const skillLv = (c, name) => c.levels[name] > 0 && skillTable(jobFor(c)).names.has(name) ? c.levels[name]
  : c.plag && c.plag.name === name && passiveLv(c, 'RG_PLAGIARISM') > 0 ? c.plag.lv : 0;
// Plagiarism (skill_attack → skill_do_copy, skill_isCopyable): a skill that hits character c, with Plagiarism learned
// (by request any hit, damage or not: rAthena's wants damage), and does not kill it, one copyable (skill_db CopyFlags Plagiarism: jobs.json `plagiarism`) that c has not learned
// itself, is the one it has copied from then on (the last one only), at its level, no higher than Plagiarism's. Only
// what the sandbox has worked out for a character is taken (SKILL_USE, not a passive). c uses it by hand (in the row:
// sandbox.js); 自動 does not. Said over c as it is taken (not in the client: by choice).
function plagiarize(c, r, by, t) {
  const plv = passiveLv(c, 'RG_PLAGIARISM'), s = r.skill, sk = s && db.skills[s.name];
  if (!plv || !sk || !sk.plagiarism || r.type === 'heal' || r.type === 'miss' || (r.damage || 0) >= c.hp || !by || by.side === c.side) return;
  if (!SKILL_USE[s.name] || SKILL_USE[s.name].mob || B.PASSIVE_SKILLS[s.name]) return;
  if (c.levels[s.name] > 0 && skillTable(jobFor(c)).names.has(s.name)) return;  // (its own: not copied)
  const lv = Math.max(1, Math.min(s.lv || 1, plv, sk.maxLevel || 10));
  if (c.plag && c.plag.name === s.name && c.plag.lv === lv) return;
  c.plag = { name: s.name, lv };
  say(c.w, `抄襲：${sk.zh || sk.en} Lv ${lv}`, t);
}
// the level of a passive skill character c's job has (0: it has not)
const passiveLv = (c, name) => skillTable(jobFor(c)).names.has(name) ? c.levels[name] || 0 : 0;
// character c rides a Peco: Riding learned and its toggle on (look.mount, which the look's body goes by: look.js)
export const riding = c => !!c.look.mount && passiveLv(c, 'KN_RIDING') > 0;
// Riding's toggle (by request: on or off at will, as pc_setriding does at once): on only with Riding learned
// (learning it puts the character on the Peco: calc)
export function ride(c, on) {
  if (on && !(passiveLv(c, 'KN_RIDING') > 0)) return;
  c.look.mount = on;
  recalc(c);
}
// character c pulls a cart: its job has Pushcart and it is learned (battle.js PASSIVE_SKILLS)
export const hasCart = c => passiveLv(c, 'MC_PUSHCART') > 0;
// a character with a falcon: one that has learned Falconry Mastery (as with the cart, no one to rent it from: learning it
// is having it; stage.js draws it), unless sent off by its toggle (by request; look.noFalcon, on again at will)
export const hasFalcon = c => passiveLv(c, 'HT_FALCON') > 0 && !c.look.noFalcon;
export function setFalcon(c, on) {
  c.look.noFalcon = !on;
}
// the character as it attacks: its status plus what its passive skills add with the weapon held
// (Double Attack needs a dagger, or a bow with a rogue, by request; Vulture's Eye's hit bonus goes with any weapon; a weapon mastery, the weapons
// it is for: B.MASTERY; Fatal Blow goes with Bash, Sonic Acceleration with Sonic Blow)
export function attacker(c) {
  const dbl = passiveLv(c, 'TF_DOUBLE'), eye = passiveLv(c, 'AC_VULTURE');
  // (Weaponry Research's with any weapon; Hilt Binding's apart, as Cart Revolution has none of it: B.hitDamage)
  const research = passiveLv(c, 'BS_WEAPONRESEARCH');
  const mastery = Object.entries(B.MASTERY).reduce((n, [k, m]) => n + (m.weapons.includes(c.pc.weapon) ? (riding(c) && m.ride || m.atk) * passiveLv(c, k) : 0), 2 * research);
  return { ...statusOf(c), doubleAttack: c.pc.weapon === 'Dagger' || (c.pc.weapon === 'Bow' && skillTable(jobFor(c)).names.has('RG_SNATCHER')) ? dbl : 0, hitBonus: eye, vulture: eye, mastery,
           hilt: passiveLv(c, 'BS_HILTBINDING') > 0 ? 4 : 0, hitPct: 2 * research,
           fatalBlow: passiveLv(c, 'SM_FATALBLOW') > 0, demonBane: passiveLv(c, 'AL_DEMONBANE'), beastBane: passiveLv(c, 'HT_BEASTBANE'), steelCrow: passiveLv(c, 'HT_STEELCROW'), sonicAccel: passiveLv(c, 'AS_SONICACCEL') > 0,
           poisonReact: passiveLv(c, 'AS_POISONREACT'), potionResearch: passiveLv(c, 'AM_LEARNINGPOTION'), spheres: c.spheres.length, sp: c.sp,
           ...hands(c) };
}
// a normal attack's left hand (battle_calc_attack_left_right_hands): with a weapon in each hand, the right one's
// damage × (50 + 10 × Righthand Mastery) % and the left one's × (30 + 10 × Lefthand Mastery) % (the Thief line;
// any other job's both whole); with a katar, a second hit of (1 + 2 × Double Attack's Lv) % of the first
function hands(c) {
  if (c.pc.left) {
    const thief = skillTable(jobFor(c)).names.has('AS_RIGHT');
    return { hands: { right: thief ? 50 + 10 * passiveLv(c, 'AS_RIGHT') : 100, left: thief ? 30 + 10 * passiveLv(c, 'AS_LEFT') : 100 } };
  }
  return c.pc.weapon === 'Katar' ? { katar: passiveLv(c, 'TF_DOUBLE') } : {};
}
// the skills a character in hiding may use (skill_db AllowWhenHidden): Hiding itself (ending it), Grimtooth, Sightless Mind,
// Back Stab (pre-renewal's skill_db)
const HIDDEN_SKILLS = new Set(['TF_HIDING', 'AS_GRIMTOOTH', 'RG_RAID', 'RG_BACKSTAP']);
// why unit u cannot use the skill now, in the client's words, or null (skill_check_condition_castbegin): a
// character's weapon must be one of the types skill_db asks for (USESKILL_FAIL_THIS_WEAPON; the arrows a bow
// skill also needs are not counted), its SP enough (monsters have none) and the gemstone it takes in the bag
// (ITEM_COST)
// (自動, by request: an ensemble's rule with its partner too far off still goes, walking it to its spot first: songSpot)
let anyPartner = false;
// (free: a skill Hocus-Pocus gave, its SP, zeny, items and spheres not asked for: skill_get_requirement, abraUse)
function skillFail(u, sk, lv, free = false) {
  if (u.silenced) return '技能使用失敗';  // silenced: no skill at all (NoCast)
  // (nor under Classical Pluck, Wink of Charm on a monster: NoCast, status_check_skilluse)
  if (has(u, 'BD_ROKISWEIL') || has(u, 'DC_WINKCHARM')) return '技能使用失敗';
  // (Encore: a song or dance played before, its job having it; an ensemble: its partner in the 9×9, as its cast starts and
  // as it goes off: the client's description, rAthena's skill_check_pc_partner a cell off and then within 3)
  if (sk.name === 'BD_ENCORE' && !(u.dance && knows(u, u.dance.name))) return '技能使用失敗';
  if (sk.name === 'SA_CASTCANCEL' && !u.cast) return '技能使用失敗';  // (only in a cast of its own: skill_check_condition_castbegin)
  // (playing: only AllowWhenPerforming's, Amp not in a song's first 3 s; see placeSong)
  if (u.isPc && has(u, 'BD_PERFORMING') && (!PERFORMING_SKILLS.has(sk.name) || (sk.name === 'BD_ADAPTATION' && W.t < (u.ampAt || 0)))) return '技能使用失敗';
  if (u.isPc && ENSEMBLES.has(sk.name) && !anyPartner && !ensemblePartner(u, sk.name)) return '技能使用失敗';
  if (has(u, 'MO_STEELBODY')) return '技能使用失敗';  // (nor under Mental Strength: NoCast)
  // a character in hiding uses only skills with AllowWhenHidden (Hiding itself: status_check_skilluse)
  if (u.isPc && hidden(u) && !HIDDEN_SKILLS.has(sk.name)) return '技能使用失敗';
  if (u.isPc && (sk.name === 'AS_GRIMTOOTH' || sk.name === 'RG_RAID') && !hidden(u)) return '技能使用失敗';  // (skill_db Requires Status: Hiding)
  // used again, a toggled skill ends its status with nothing to pay (skill_check_condition: skill_disable_check)
  if (sk.name === 'TF_HIDING' && hidden(u)) return null;
  if (sk.name === 'MC_VENDING' && u.vending) return null;  // (closing the shop: see DOES.vend)
  if (sk.name === 'AS_CLOAKING' && cloaked(u)) return null;  // (the same: ending it)
  // a character's Cloaking below Lv 3 starts only by a wall (status_change_start: skill_check_cloaking)
  if (sk.name === 'AS_CLOAKING' && u.isPc && lv < 3 && !byWall(u)) return '技能使用失敗';
  if (u.vending) return '技能使用失敗';  // vending: no other skill (pc_cant_act2)
  if (has(u, 'KN_AUTOCOUNTER')) return '技能使用失敗';  // (Counter Attack on: status_check_skilluse)
  if (CART_SKILLS.has(sk.name) && u.isPc && !hasCart(u)) return '技能使用失敗';  // (skill_db RequiredState: Cart)
  if (FALCON_SKILLS.has(sk.name) && u.isPc && !hasFalcon(u)) return '技能使用失敗';  // (RequiredState: Falcon, clif_skill_fail)
  if (sk.name === 'KN_BRANDISHSPEAR' && u.isPc && !riding(u)) return '技能使用失敗';  // (State: Riding)
  if (u.isPc && (sk.weapon || []).length && !sk.weapon.includes(u.pc.weapon)) return '這個武器不能用';
  if (u.isPc && NEED_SHIELD.has(sk.name) && !heldShield(u)) return '尚未裝備盾牌';  // (State: Shield; the client's msgstringtable line 3966)
  // at most WALL_MAX fire walls of one's own at once: another fails (skill_pos_maxcount_check, checked
  // for Fire Wall as the cast starts and again as it goes off)
  if (sk.name === 'MG_FIREWALL' && W.walls.filter(x => x.by === u).length >= WALL_MAX) return '技能使用失敗';
  if (sk.name === 'PR_REDEMPTIO' && u.isPc && !redeemable(u).length) return '技能使用失敗';  // (no one to bring back)
  if (sk.name === 'PR_BENEDICTIO' && u.isPc && benedictioPartners(u).length < BENEDICTIO_PARTNERS) return '技能使用失敗';
  if (sk.name === 'AL_WARP' && W.warps.filter(x => x.by === u).length >= WARP_MAX) return '技能使用失敗';  // (the same: 3)
  // (Fire Pillar: a character's 5 at most, ActiveInstance under land_skill_limit; a monster's any number)
  if (sk.name === 'WZ_FIREPILLAR' && u.isPc && W.traps.filter(x => x.by === u && x.sk.name === sk.name).length >= PILLAR_MAX) return '技能使用失敗';
  // (a character's spirit spheres: as many as the skill uses up, skill_db SpiritSphereCost, USESKILL_FAIL_SPIRITS;
  // Summon Spirit Sphere with Lv of them already fails; a combo skill only right after the one before it)
  if (u.isPc && !free && sphereCost(u, sk, lv) > u.spheres.length) return `需要 ${sk.spheres[lv - 1]} 個氣球體`;
  if (u.isPc && sk.name === 'MO_CALLSPIRITS' && u.spheres.length >= lv) return '技能使用失敗';
  if (u.isPc && !comboOpen(u, sk.name)) return '技能使用失敗';
  // (caught in Root: none but those its level allows, on the one caught, status_check_skilluse SC_BLADESTOP)
  if (u.bladeStop && !(BLADE_SKILLS[sk.name] <= u.bladeStop.lv)) return '技能使用失敗';
  // (Water Ball: a character only standing in water — the floor has none — or in an element field of Deluge,
  // skill_check_condition_castbegin ST_WATER; by request, it was too strong anywhere)
  if (u.isPc && sk.name === 'WZ_WATERBALL' && !has(u, 'SA_DELUGE') && !waterAt(...u.w.cell)) return '技能使用失敗';
  // (Asura Strike only under Fury: skill_db Requires Status)
  if (u.isPc && sk.name === 'MO_EXTREMITYFIST' && !has(u, 'MO_EXPLOSIONSPIRITS')) return '技能使用失敗';
  if (!free) {
    if (u.sp != null && spCost(u, sk, lv) > u.sp) return 'SP 不足';
    if (u.isPc && zenyCost(sk, lv) > purse(u).zeny) return '金錢不足無法使用此技能';  // (its team's: USESKILL_FAIL_MONEY)
    const item = costItem(sk.name, lv, u);
    if (u.isPc && item && !gemFree(u, item) && !(purse(u).bag[item] >= itemN(sk.name, lv))) return gemFail(item, itemN(sk.name, lv));
    if (u.isPc && ITEM_ALSO[sk.name] && !(purse(u).bag[ITEM_ALSO[sk.name]] >= 1)) return GEM_FAIL[ITEM_ALSO[sk.name]];
  }
  // (no Ice Wall in Volcano: status_check_skilluse)
  if (sk.name === 'WZ_ICEWALL' && has(u, 'SA_VOLCANO')) return '技能使用失敗';
  if ((sk.hp || [])[lv - 1] && u.hp <= sk.hp[lv - 1]) return 'HP 不足';  // HpCost: more HP than it takes
  return null;
}
// why skill sk cannot be used on unit u, or null: Detoxify only on one poisoned, Cure only on one blind, silenced
// or confused (by request; rAthena lets both go on anyone), Turn Undead only on an undead (skill_castend_id_check). Checked as it is picked and again as it goes off,
// before anything is paid.
const cures = u => !!(u && (u.blind || u.silenced || u.confused));
// Sightrasher needs Sight on a character (Requires Status: Sight), checked only as it goes off (skill_check_condition_castend;
// its cast starts without it); a monster's needs none
const sightFail = (u, sk) => sk.name === 'WZ_SIGHTRASHER' && u.isPc && !has(u, 'MG_SIGHT') ? '技能使用失敗' : null;
// A damaging skill aimed at a unit (skill_get_casttype CAST_DAMAGE: not a ground, support or self skill, nor one
// that does no damage) fails as it goes off with a wall between the user and the target (skill_castend_id under
// OFFICIAL_WALKPATH: path_search_long, wherever the two stand by then), unpaid
const damageCast = sk => !['Ground', 'Support', 'Self', 'Passive'].includes(sk.target) && !sk.noDamage;
function wallFail(u, p) {
  const m = p.target;
  return m && m !== u && !m.ground && m.w && damageCast(p.sk) && !field.sees(u.w.cell, m.w.cell) ? '技能使用失敗' : null;
}
function targetFail(sk, u) {
  if (sk.name === 'TF_DETOXIFY' && !(u && u.poison)) return '技能使用失敗';
  if (sk.name === 'AL_CURE' && !cures(u)) return '技能使用失敗';
  if (sk.name === 'PR_TURNUNDEAD' && !(u && !u.isPc && B.isUndead(statusOf(u)))) return '技能使用失敗';  // (undead only)
  // (Resurrection: on a character down, or an undead monster)
  if (sk.name === 'ALL_RESURRECTION' && !(u && (u.isPc ? u.dead != null : B.isUndead(statusOf(u))))) return '技能使用失敗';
  // (Ki Translation: on a character with fewer than 5 spheres; else nothing paid, kitranslation.cpp SKILL_NOCONSUME_REQ)
  if (sk.name === 'MO_KITRANSLATION' && !(u && u.isPc && u.spheres.length < 5)) return '技能使用失敗';
  return null;
}
// why character c cannot use skill sk (Lv lv) on unit x, the user and the target both counted, or null: Resistant Souls
// and Sacrifice not on the user (NoTargetSelf) nor on one of the crusader's line (resistantsouls.cpp, sacrifice.cpp:
// MAPID_CRUSADER); Sacrifice only on a character (here an ally), its base level within DEVOTION_LV of the user's
// (devotion_level_difference), not under another's Sacrifice, and with a place for it among the user's Lv (MAX_DEVOTION:
// the ones under it already, or this one again)
const DEVOTION_LV = 10;
const crusaderLine = x => !!x.isPc && jobFor(x).itemClass === 'Crusader';
// the characters under character c's Sacrifice
export const devotees = c => allChars().filter(x => x.sc.some(s => s.name === 'CR_DEVOTION' && s.by === c && W.t < s.until));
function casterFail(c, sk, x, lv) {
  if (SUMMONS[sk.name]) return summonFail(c, sk.name, lv);
  if (HOMUN_SKILLS[sk.name]) return HOMUN_SKILLS[sk.name](c) ? null : '技能使用失敗';
  if (!x || !['CR_PROVIDENCE', 'CR_DEVOTION'].includes(sk.name)) return null;
  if (x === c || crusaderLine(x)) return '技能使用失敗';
  if (sk.name !== 'CR_DEVOTION') return null;
  if (!x.isPc || !c.isPc || Math.abs(c.blv - x.blv) > DEVOTION_LV) return '技能使用失敗';
  const s = x.sc.find(y => y.name === 'CR_DEVOTION' && W.t < y.until);
  if (s ? s.by !== c : devotees(c).length >= lv) return '技能使用失敗';
  return null;
}
// The zeny a skill costs a character (skill_db Requires ZenyCost), paid from the party's money (W.zeny) as it
// goes off: Mammonite's 100 × Lv a hundredth of it (by request: 10 z at Lv 10, for the sandbox's money)
const ZENY_COST = { MC_MAMMONITE: lv => lv };
const zenyCost = (sk, lv) => ZENY_COST[sk.name] ? ZENY_COST[sk.name](lv) : 0;
// The gemstone (Holy Water, Booby Trap) a character's skill takes from the party's bag (skill_db Requires ItemCost: one,
// ITEM_N if more: some traps take two; none below ITEM_FROM's level: Fire Pillar's from Lv 6; by request, Safety Wall's, Stone Curse's and Warp Portal's: every one a character
// has that takes one), checked as it is picked, as its cast starts and as it goes off (skillFail:
// USESKILL_FAIL_REDJAMSTONE / BLUEJAMSTONE) and taken as it goes off (skill_consume_requirement; Stone Curse's
// in its DOES, which keeps it on some failures). Monsters' skills take none.
export const YELLOW_GEM = 715, RED_GEM = 716, BLUE_GEM = 717, RED_BLOOD = 990, CRYSTAL_BLUE = 991, WIND_OF_VERDURE = 992, GREEN_LIVE = 993, HOLY_WATER = 523, BOOBY_TRAP = 1065;
export const FIRE_BOTTLE = 7135, ACID_BOTTLE = 7136, PLANT_BOTTLE = 7137, MARINE_BOTTLE = 7138, COATING_BOTTLE = 7139, BERSERK_POTION = 657;
export const ITEM_COST = { MG_SAFETYWALL: BLUE_GEM, MG_STONECURSE: RED_GEM, AL_WARP: BLUE_GEM, AS_VENOMDUST: RED_GEM, PR_SANCTUARY: BLUE_GEM, PR_MAGNUS: BLUE_GEM, PR_ASPERSIO: HOLY_WATER, ALL_RESURRECTION: BLUE_GEM, SA_DISPELL: YELLOW_GEM,
  SA_ABRACADABRA: YELLOW_GEM, SA_VOLCANO: BLUE_GEM, SA_DELUGE: BLUE_GEM, SA_VIOLENTGALE: BLUE_GEM, SA_LANDPROTECTOR: BLUE_GEM,
  SA_FLAMELAUNCHER: RED_BLOOD, SA_FROSTWEAPON: CRYSTAL_BLUE, SA_LIGHTNINGLOADER: WIND_OF_VERDURE, SA_SEISMICWEAPON: GREEN_LIVE,
  HT_SKIDTRAP: BOOBY_TRAP, HT_SANDMAN: BOOBY_TRAP, HT_LANDMINE: BOOBY_TRAP, HT_ANKLESNARE: BOOBY_TRAP, HT_SHOCKWAVE: BOOBY_TRAP, HT_FLASHER: BOOBY_TRAP, HT_FREEZINGTRAP: BOOBY_TRAP, HT_BLASTMINE: BOOBY_TRAP, HT_CLAYMORETRAP: BOOBY_TRAP, WZ_FIREPILLAR: BLUE_GEM, HT_TALKIEBOX: BOOBY_TRAP,
  AM_DEMONSTRATION: FIRE_BOTTLE, AM_ACIDTERROR: ACID_BOTTLE, AM_BERSERKPITCHER: BERSERK_POTION, AM_CANNIBALIZE: PLANT_BOTTLE, AM_SPHEREMINE: MARINE_BOTTLE,
  AM_CP_WEAPON: COATING_BOTTLE, AM_CP_SHIELD: COATING_BOTTLE, AM_CP_ARMOR: COATING_BOTTLE, AM_CP_HELM: COATING_BOTTLE };
export const ITEM_N = { SA_ABRACADABRA: 2, AM_BERSERKPITCHER: 2, HT_SHOCKWAVE: 2, HT_FLASHER: 2, HT_FREEZINGTRAP: 2, HT_BLASTMINE: 2, HT_CLAYMORETRAP: 2 };
const ITEM_FROM = { WZ_FIREPILLAR: 6 };
// a second item a skill takes besides its ITEM_COST (Land Protector's Yellow Gemstone: skill_db ItemCost)
export const ITEM_ALSO = { SA_LANDPROTECTOR: YELLOW_GEM };
const itemN = (name, lv) => lv < (ITEM_FROM[name] || 0) ? 0 : ITEM_N[name] || 1;
// Chemical Protection: whether character c has that part on (pc_checkequip: a weapon, a shield; no body armour or
// headgear in the sandbox, so those always)
const CHEM_PROTECT = { AM_CP_WEAPON: c => c.pc.weapon !== 'Fist', AM_CP_SHIELD: c => !!heldShield(c), AM_CP_ARMOR: () => true, AM_CP_HELM: () => true };
// the item a skill takes going by its level instead (Aid Potion: skill_get_requirement takes only the ItemCost of index
// Lv − 1, the Red, Orange, Yellow, White or Blue Potion), and the one skill sk takes at level lv either way
export const ITEM_BY_LV = { AM_POTIONPITCHER: [501, 502, 503, 504, 505] };
// (Call Homunculus, renewal skill_get_requirement: an Embryo to make one, a Seed of Life to call one back from rest)
export const EMBRYO = 7142, SEED_OF_LIFE = 7140;
export const costItem = (name, lv, u = null) => name === 'AM_CALLHOMUN' ? (u && u.homun ? SEED_OF_LIFE : EMBRYO) : ITEM_BY_LV[name]?.[lv - 1] ?? ITEM_COST[name];
// (any other: the client's [%s]需要 %d個, USESKILL_FAIL_NEED_ITEM)
const gemFail = (id, n) => GEM_FAIL[id] || `[${(db.items[id] || {}).name || id}]需要 ${n}個`;
const GEM_FAIL = { [RED_BLOOD]: '需要火靈礦石', [CRYSTAL_BLUE]: '需要水靈礦石', [WIND_OF_VERDURE]: '需要風靈礦石', [GREEN_LIVE]: '需要地靈礦石', [YELLOW_GEM]: '需要黃色魔力礦石', [RED_GEM]: '需要紅色魔力礦石', [BLUE_GEM]: '需要藍色魔力礦石', [HOLY_WATER]: '需要聖水', [BOOBY_TRAP]: '需要設置用陷阱道具' };
// character c uses up item id of the bag (counted with the potions drunk: W.used, its tally's items)
// (no gemstone under Power Chord: skill_get_requirement SC_INTOABYSS)
// (and a card's bNoGemStone: none of the three gemstones)
const gemFree = (c, id) => ((id === RED_GEM || id === BLUE_GEM) && has(c, 'BD_INTOABYSS')) || (!!c.cardFx?.noGem && (id === RED_GEM || id === BLUE_GEM || id === YELLOW_GEM));
function useItem(c, id, n = 1) {
  if (gemFree(c, id)) return;
  const p = purse(c);
  p.bag[id] -= n;
  bagN++;
  p.used[id] = (p.used[id] || 0) + n;
  tallyOf(c).items[id] = (tallyOf(c).items[id] || 0) + n;
}
// and given back: a ground skill whose cell has one of its kind already fails before it is paid for
// (skill_check_unit_range, NoReiteration), so the gem paid as it went off goes back
function giveBack(c, id, n = 1) {
  if (!c.isPc || gemFree(c, id)) return;
  const p = purse(c);
  p.bag[id] += n;
  bagN++;
  p.used[id] -= n;
  tallyOf(c).items[id] -= n;
}
// the SP skill sk takes from unit u (skill_get_requirement): half right after Encore, less Gypsy's Kiss's %, Amp's 20% for a
// song and the Ring of Nibelungen's 30%; and a share of the SP it has (skill_db SpRateCost: Aid Berserk Potion's 8 %)
const SP_RATE = { AM_BERSERKPITCHER: 8 };
const spCost = (u, sk, lv) => {
  let sp = sk.sp[lv - 1] || 0;
  if (!u.isPc) return sp;
  if (u.encore === sk.name) sp = Math.trunc(sp / 2);
  if (SP_RATE[sk.name]) sp += Math.trunc(u.sp * SP_RATE[sk.name] / 100);
  sp = Math.trunc(sp * (100 - (u.pc.spCut || 0)) / 100);

  return sp;
};
// a share of the HP the user has a skill takes (skill_db HpRateCost: Grand Cross's 20 %)
const HP_RATE = { CR_GRANDCROSS: 20 };
// a skill's SP, HP for one with an HpCost (Increase AGI) or an HpRateCost, zeny for one with a ZenyCost and its gemstone, paid as it
// goes off
function pay(u, sk, lv) {
  if (sk.name === 'TF_HIDING' && hidden(u)) return;  // (ending it: see skillFail)
  if (sk.name === 'MC_VENDING' && u.vending) return;  // (closing the shop)
  const sp = sk.name === 'BD_ADAPTATION' || sk.name === 'BD_ENCORE' ? 0 : spCost(u, sk, lv);  // (those two ask for it, and take none: skill_consume_requirement)
  if (u.encore === sk.name) u.encore = null;
  if (u.isPc) (u.usedAt ||= {})[sk.name] = W.t;  // (自動's 「N 秒內沒用過這招」)
  // (and Amp with 2 monsters at it or more, its play stopped for the bow: 自動's ampMobbed)
  if (u.isPc && sk.name === 'BD_ADAPTATION' && livingFoes(u).filter(m => m.target === u).length >= 2) u.ampMobbed = W.t;
  if (u.sp != null) u.sp -= sp;
  u.hp -= (sk.hp || [])[lv - 1] || 0;
  if (HP_RATE[sk.name]) u.hp -= Math.trunc(u.hp * HP_RATE[sk.name] / 100);
  if (u.isPc) {
    const z = zenyCost(sk, lv), x = tallyOf(u);
    purse(u).zeny -= z; purse(u).spent += z;
    x.sp += sp; x.zeny += z; x.skills++;
    if (costItem(sk.name, lv, u) && sk.name !== 'MG_STONECURSE' && itemN(sk.name, lv)) useItem(u, costItem(sk.name, lv, u), itemN(sk.name, lv));
    if (ITEM_ALSO[sk.name]) useItem(u, ITEM_ALSO[sk.name]);
    useSpheres(u, sphereCost(u, sk, lv));
  }
}
// the spirit spheres skill sk (Lv lv) uses up for character u (skill_db SpiritSphereCost; none for Snap under Fury:
// skill_get_requirement)
// (and Asura Strike right after Raging Thrust all it has, 1 at least: renewal)
const sphereCost = (u, sk, lv) => sk.name === 'MO_BODYRELOCATION' && has(u, 'MO_EXPLOSIONSPIRITS') ? 0
  : sk.name === 'MO_EXTREMITYFIST' && inCombo(u, 'MO_COMBOFINISH') ? Math.max(1, u.spheres.length)
  // (and in Root one fewer)
  : Math.max(0, ((sk.spheres || [])[lv - 1] || 0) - (sk.name === 'MO_EXTREMITYFIST' && u.bladeStop ? 1 : 0));
// ---------- spirit spheres ----------
// Character c's spirit spheres (pc_addspiritball): one more at time t lasting ms, `max` at most — past it the one
// going soonest goes first; each goes by itself as its time is up (pc_spiritball_timer: sphereTick). A skill uses
// up those going soonest (pc_delspiritball); death takes them all (pc_dead). Each is 3 mastery ATK on its attacks
// (B.hitDamage: src.spheres).
function addSphere(c, t, ms, max) {
  if (c.spheres.length >= max) c.spheres.shift();
  c.spheres = [...c.spheres, t + ms].sort((a, b) => a - b);
  emit('spheres', c);
}
function useSpheres(c, n) {
  if (!n || !c.spheres.length) return;
  c.spheres = c.spheres.slice(n);
  emit('spheres', c);
}
function sphereTick(c, t) {
  if (!c.spheres.length || c.spheres[0] > t) return;
  c.spheres = c.spheres.filter(x => x > t);
  emit('spheres', c);
}
export const spheresOf = c => (c.spheres || []).length;
// ---------- the monk's combos ----------
// What a combo skill follows (skill_check_condition_castbegin: SC_COMBO's val1): Raging Quadruple Blow a Raging
// Trifecta Blow, Raging Thrust a Raging Quadruple Blow
const COMBO_AFTER = { MO_CHAINCOMBO: 'MO_TRIPLEATTACK', MO_COMBOFINISH: 'MO_CHAINCOMBO' };
const COMBO_NEXT = { MO_TRIPLEATTACK: 'MO_CHAINCOMBO', MO_CHAINCOMBO: 'MO_COMBOFINISH', MO_COMBOFINISH: 'MO_EXTREMITYFIST' };
const inCombo = (c, name) => !!c.combo && c.combo.name === name && W.t < c.combo.until;
// whether character c may use skill `name` now as far as the combos go: one not in the chain any time, one in it only
// right after the one before it (Chain Combo also when caught in Root); the sandbox does not send one out of its moment
export const comboOpen = (c, name) => !COMBO_AFTER[name] || inCombo(c, COMBO_AFTER[name]) || (name === 'MO_CHAINCOMBO' && !!c.bladeStop);
// Character c used combo skill `sk` (Lv lv) on m at time t (skill_combo): if it has learned the next in the chain
// (Raging Thrust also wanting a sphere), it may follow up with that on m (val2 0: its target) once the skill's delay
// is over (B.skillDelay: canAct), until the attack motion or the delay, whichever is longer, and 300 ms more have
// gone by (SC_COMBO, combo_delay_rate 100) — no normal attack before then (attackabletime). The next skill ends it.
// (Its walk delay is not done: the sandbox has none.)
function startCombo(c, sk, lv, m, t) {
  const next = COMBO_NEXT[sk.name];
  if (!next || !knows(c, next) || (next === 'MO_COMBOFINISH' && !c.spheres.length)) return;
  // (Asura Strike after Raging Thrust: with 4 spheres left and under Fury)
  if (next === 'MO_EXTREMITYFIST' && (c.spheres.length < 4 || !has(c, 'MO_EXPLOSIONSPIRITS'))) return;
  const until = t + Math.max(c.pc.amotion, B.skillDelay(sk, lv, c.pc)) + COMBO_WAIT_MS;
  c.combo = { name: sk.name, target: m, until };
  c.ready = Math.max(c.ready, until);
  c.next = Math.max(c.next || 0, until);
}
const COMBO_WAIT_MS = 300;
const TRIPLE_GAP = 3;
// Raging Trifecta Blow (battle_weapon_attack): a character that has learned it, at tripleRate % its normal
// attack on m at time t is the skill instead (skill_attack: B.SKILLS, its hits split in 3), shouted, with no SP; the
// skill's delay from then on (canact_tick: B.skillDelay), and a combo after it (startCombo: back by request, after a
// while without, for Raging Quadruple Blow to be easier to follow it up with), which puts the next normal attack off
// (stepChar). → its result r. Its rate is pre-renewal's, 30 − Lv (the lower the level, the likelier: by request;
// renewal's is 30 at every level). It is one swing in the one attack interval, held on its hit frame as its three hits
// land TRIPLE_GAP frames apart (stepChar; by request)
const tripleRate = lv => 30 - lv;
function triple(c, m, t) {
  const sk = db.skills.MO_TRIPLEATTACK, lv = passiveLv(c, 'MO_TRIPLEATTACK');
  if (!lv || !(rnd(100) < tripleRate(lv))) return null;
  const r = B.skillAttack(db, offense(c), defense(m), sk, lv);
  shout(c.w, sk, t);
  c.canAct = Math.max(c.canAct, t + B.skillDelay(sk, lv, c.pc));
  startCombo(c, sk, lv, m, t);
  return r;
}

// B.S. Sacramenti's partners for character c (skill_check_pc_partner: two acolytes, the monk line too, right and left of
// it with 10 SP and able to cast; by request one, anywhere in the party: BENEDICTIO_PARTNERS)
const BENEDICTIO_PARTNERS = 1;
const benedictioPartners = c => crewOf(c).filter(x => x !== c && x.dead == null && ['priest', 'acolyte', 'monk'].includes(lineOf(x))
  && x.sp >= 10 && !x.silenced);
// the party members down within Redemptio's splash (14 cells) of character c, whom it brings back
// the songs and dances, whose status on one ends the others (status.yml EndOnStart), and the ensembles, the same among
// themselves; a song's partner for an ensemble (skill_check_condition_char_sub): one of the party of the other sex, in the 9×9
// round character c, a bard or a dancer with that skill learned and an instrument or a whip, not sitting and able
// to move
const SONGS = new Set(['BA_DISSONANCE', 'BA_WHISTLE', 'BA_ASSASSINCROSS', 'BA_POEMBRAGI', 'BA_APPLEIDUN', 'DC_UGLYDANCE', 'DC_HUMMING', 'DC_DONTFORGETME', 'DC_FORTUNEKISS', 'DC_SERVICEFORYOU']);
const ENSEMBLES = new Set(['BD_LULLABY', 'BD_RICHMANKIM', 'BD_ETERNALCHAOS', 'BD_DRUMBATTLEFIELD', 'BD_RINGNIBELUNGEN', 'BD_ROKISWEIL', 'BD_INTOABYSS', 'BD_SIEGFRIED']);
const ENEMY_SONGS = new Set(['BA_DISSONANCE', 'DC_UGLYDANCE', 'DC_DONTFORGETME', 'BD_LULLABY', 'BD_ETERNALCHAOS', 'BD_ROKISWEIL']);
// a song on the ground (by request, as before renewal: UF_SONG's unit group, skill_unitsetting): it stays for Duration1 round
// its player, its ground following it, the partner of an ensemble playing too at that one's level averaged (not tired after: no
// SC_ENSEMBLEFATIGUE before renewal, and it barred Amp from ending it; by request).
// Each one playing walks slower (BD_PERFORMING), does no normal attack and uses only Amp, Melody Strike and Slinging Arrow
// (pre-renewal, by request: SC_DANCING's NoAttack, status_check_skilluse with AllowWhenPerforming; Amp not in its first 3 s,
// skill_blockpc_start), so another song only after Amp; it pays 1 SP every few seconds (SONG_UPKEEP), the song ending
// with none left. The two of an ensemble cannot walk at all while it lasts (by request, as before renewal: SC_DANCING with a partner,
// val4, is NoMoveCond there unless Longing for Freedom, which is not here), a knockback still moving them.
// One of its party in reach, or an enemy for one aimed at them, has its status as long as it stays, and for Duration2 after
// it leaves; Unchained Serenade and Hip Shaker land every 3 s on the enemies in reach (Interval 3000), Lullaby rolls every
// 6 s. One playing another song stops the first.
const SONG_EVERY = { BA_DISSONANCE: 3000, DC_UGLYDANCE: 3000, BD_LULLABY: 6000 };
// (Song of Lutie's HP on its party every 6 s besides: skill_db Interval 6000, UNT_APPLEIDUN)
const APPLE_EVERY = 6000, AMP_WAIT = 3000;
// the seconds between each 1 SP a player pays playing it (status_change_timer SC_DANCING, pre-renewal)
const SONG_UPKEEP = { BD_RICHMANKIM: 3, BD_DRUMBATTLEFIELD: 3, BD_RINGNIBELUNGEN: 3, BD_SIEGFRIED: 3, BA_DISSONANCE: 3, BA_ASSASSINCROSS: 3,
  DC_UGLYDANCE: 3, BD_LULLABY: 4, BD_ETERNALCHAOS: 4, BD_ROKISWEIL: 4, DC_FORTUNEKISS: 4, BD_INTOABYSS: 5, BA_WHISTLE: 5, DC_HUMMING: 5,
  BA_POEMBRAGI: 5, DC_SERVICEFORYOU: 5, BA_APPLEIDUN: 6, DC_DONTFORGETME: 10 };
// the skills one playing may use (pre-renewal skill_db AllowWhenPerforming)
const PERFORMING_SKILLS = new Set(['BD_ADAPTATION', 'BA_MUSICALSTRIKE', 'DC_THROWARROW']);
const lessonOf = (u, name) => u.levels[name] || 0;
// a song's figures from its player as it starts (skill_unitsetting, pre-renewal; the stats are its whole ones): v1 and v2,
// what its status gives (battle.js BUFF_SKILLS), `heal` Song of Lutie's HP. Song of Lutie's MaxHP is 5 + 2 × Lv + VIT / 10 +
// Musical Lesson % as rAthena had it (this checkout sets none: its MaxHP bonus would be 0 before renewal)
function songValues(u, name, lv) {
  const { agi, dex, int: int_, luk, vit } = statusOf(u).stats, ba = lessonOf(u, 'BA_MUSICALLESSON'), dc = lessonOf(u, 'DC_DANCINGLESSON'), d = (a, b) => Math.trunc(a / b);
  switch (name) {
    case 'BA_WHISTLE': return { v1: lv + d(agi, 10) + d(ba, 2), v2: d(lv + 1, 2) + d(luk, 30) + d(ba, 5) };
    case 'BA_ASSASSINCROSS': return { v1: (d(ba, 2) + 5 + lv + d(agi, 20)) * 10 };
    case 'BA_POEMBRAGI': return { v1: 3 * lv + d(dex, 10) + ba, v2: (lv < 10 ? 3 * lv : 50) + d(int_, 5) + 2 * ba };
    case 'BA_APPLEIDUN': return { v1: 5 + 2 * lv + d(vit, 10) + ba, heal: 30 + 5 * lv + d(vit, 2) + 5 * ba };
    case 'DC_HUMMING': return { v1: 1 + 2 * lv + d(dex, 10) + dc };
    case 'DC_DONTFORGETME': return { v1: (5 + 3 * lv + d(dex, 10) + dc) * 10, v2: 5 + 3 * lv + d(agi, 10) + dc };
    case 'DC_FORTUNEKISS': return { v1: (10 + lv + d(luk, 10)) * 10 + 5 * dc };
    case 'DC_SERVICEFORYOU': return { v1: 15 + lv + d(int_, 10) + d(dc, 2), v2: 20 + 3 * lv + d(int_, 10) + d(dc, 2) };
    default: return {};
  }
}
function placeSong(u, sk, lv, t) {
  const name = sk.name;
  const by = ENSEMBLES.has(name) ? ensemblePartner(u, name) : null;
  W.songs.filter(n => n.by === u || n.with === u || (by && (n.by === by || n.with === by))).forEach(songOut);
  u.dance = { name, lv };
  if (by) {
    by.dance = { name, lv: by.levels[name] };
    lv = Math.trunc((lv + by.levels[name]) / 2);
  }
  const ms = sk.duration[lv - 1] || 0;
  W.songs.push({ by: u, with: by, sk, lv, until: t + ms, next: t, area: areaOf(sk, lv), v: songValues(u, name, lv), upkeep: t });
  u.ampAt = t + AMP_WAIT;
  for (const x of by ? [u, by] : [u]) {
    addStatus(x, { name: 'BD_PERFORMING' }, x.levels[x.look.sex === '여' ? 'DC_DANCINGLESSON' : 'BA_MUSICALLESSON'] || 0, t, null, ms);
    if (x === u) u.sc.find(s => s.name === 'BD_PERFORMING').song = name;  // (what stage.js shows on its ground)
    if (by) { x.w.stop(); root(x); }
  }
}
function songOut(n) {
  W.songs = W.songs.filter(x => x !== n);
  for (const x of n.with ? [n.by, n.with] : [n.by]) { endStatus(x, 'BD_PERFORMING'); if (n.with) root(x); }
}
// Two songs, or two dances, of two players over the same cells (pre-renewal skill_db UnitFlag Song: the bard's; Dance: the
// dancer's; an ensemble neither): on those cells each of the two is Unchained Serenade (a song) or Hip Shaker (a dance) at
// its own level instead (skill_dance_overlap, skill_dance_switch: the unit's skill turned into that one, Interval 3000),
// by request as rAthena has it; a song and a dance over each other both go on as they are
// a song or an ensemble (stage.js: its player loops the 詠唱 action's frames as it casts it and as it goes off)
export const isSong = name => SONGS.has(name) || ENSEMBLES.has(name);
const songKind = name => SONGS.has(name) ? (name.startsWith('BA_') ? 'song' : 'dance') : null;
const clashAt = (n, cell) => { const k = songKind(n.sk.name); return !!k && W.songs.some(o => o !== n && songKind(o.sk.name) === k && cheb(o.by.w.cell, cell) <= o.area); };
// cell [x, y] is one where unit u's song (it playing it) is turned so (stage.js shows it so)
export const songClash = (u, x, y) => { const n = W.songs.find(o => o.by === u); return !!n && cheb(n.by.w.cell, [x, y]) <= n.area && clashAt(n, [x, y]); };
// unit m stands where song n reaches as itself
const inSong = (n, m) => field.distance(n.by.w, m.w) <= n.area && (SONG_EVERY[n.sk.name] || !clashAt(n, m.w.cell));
const CLASH_EVERY = 3000;
// Hip Shaker's SP (pre-renewal, hipshaker.cpp: 5 + 5 × Lv + Lv × Dancing Lesson's level); Unchained Serenade's attacker,
// with its Musical Lesson (battle.js BA_DISSONANCE)
const uglySp = (u, lv) => 5 + 5 * lv + lv * lessonOf(u, 'DC_DANCINGLESSON');
const songSrc = u => ({ ...offense(u), lesson: lessonOf(u, 'BA_MUSICALLESSON') });
function songTurn(n, t) {
  const { by, sk, lv, area } = n, name = sk.name, reach = m => inSong(n, m);
  // (1 SP every SONG_UPKEEP s from each playing it; none left, it ends)
  const every = (SONG_UPKEEP[name] || 0) * 1000;
  if (every && t >= n.upkeep + every) {
    n.upkeep += every;
    for (const x of n.with ? [by, n.with] : [by]) { x.sp = Math.max(0, x.sp - 1); emit('hp', x); }
    if (by.sp <= 0 || (n.with && n.with.sp <= 0)) return songOut(n);
  }
  // (Song of Lutie: every 6 s HP on each of its party in reach but its player, skill_calc_heal)
  if (name === 'BA_APPLEIDUN' && t >= (n.healNext ?? t + APPLE_EVERY)) {
    for (const m of allies(by)) if (m !== by && m.dead == null && reach(m)) healUnit(m, { type: 'heal', damage: n.v.heal }, t, by);
    n.healNext = t + APPLE_EVERY;
  } else if (name === 'BA_APPLEIDUN' && n.healNext == null) n.healNext = t + APPLE_EVERY;
  const foes = ENEMY_SONGS.has(name) ? enemies(by).filter(m => alive(m) && reach(m)) : [];
  const kind = songKind(name);
  if (kind && !SONG_EVERY[name] && t >= (n.clashNext ?? 0)) {
    const on = enemies(by).filter(m => alive(m) && field.distance(by.w, m.w) <= area && clashAt(n, m.w.cell));
    if (on.length) {
      n.clashNext = t + CLASH_EVERY;
      // (at its level, as far as Unchained Serenade's goes; Hip Shaker's SP: see uglySp)
      const dis = db.skills.BA_DISSONANCE, dlv = Math.min(lv, dis.maxLevel || 5);
      for (const m of on)
        if (kind === 'dance') { if (m.sp != null) { m.sp = Math.max(0, m.sp - uglySp(by, lv)); emit('hp', m); } }
        else schedule(B.skillAttack(db, songSrc(by), defense(m), dis, dlv, undefined, field.distance(by.w, m.w)), by, m, t);
    }
  }
  if (SONG_EVERY[name]) {
    if (t < n.next) return;
    n.next = t + SONG_EVERY[name];
    for (const m of foes) {
      if (name === 'BD_LULLABY') {
        // (pre-renewal, skills/archer/lullaby.cpp: (the two players' INT + 100 to 300) / 10 %, against its resistance, for
        // Duration2)
        const ints = statusOf(by).stats.int + (n.with ? statusOf(n.with).stats.int : 0), rate = (ints + 100 + rnd(201)) / 10;
        const o = B.sleepOdds(statusOf(by), statusOf(m), rate, sk.duration2[lv - 1] || 0);
        if (!m.asleep && rnd(10000) < o.chance * 100) sleep(m, t, o.ms);
      } else if (name === 'DC_UGLYDANCE') {
        if (m.sp != null) { m.sp = Math.max(0, m.sp - uglySp(by, lv)); emit('hp', m); }
      } else schedule(B.skillAttack(db, songSrc(by), defense(m), sk, lv, undefined, field.distance(by.w, m.w)), by, m, t);
    }
    if (name === 'BA_DISSONANCE' && by.sitting) sit(by, false);
    return;
  }
  const ms = sk.duration2[lv - 1] || 0;
  // (not on its player itself: skill_unit_onplace, src_id; different songs all at once, before renewal none ending another)
  const on = ENEMY_SONGS.has(name) ? foes : allies(by).filter(x => x !== by && x.dead == null && reach(x));
  for (const m of on) {
    const mine = m.sc.find(s => s.from === n);
    if (mine) { mine.until = t + ms; continue; }
    // (the same song of another player's on it already: that one stays, sc_start only without it)
    if (m.sc.some(s => s.name === name && s.from && W.songs.includes(s.from) && inSong(s.from, m))) continue;
    if (quagFail(m, name) || (name === 'BD_ROKISWEIL' && isBoss(m))) continue;  // (Impressive Riff: status.yml Fail; BossResist)
    if (name === 'DC_DONTFORGETME') for (const a of ['AL_INCAGI', 'NPC_AGIUP', 'KN_TWOHANDQUICKEN', 'BS_ADRENALINE']) endStatus(m, a);  // (EndOnStart)
    endStatus(m, name);
    addStatus(m, sk, lv, t, null, ms);
    const s = m.sc.find(x => x.name === name);
    s.from = n;
    Object.assign(s, { v1: n.v.v1, v2: n.v.v2 });
    if (m.isPc) recalc(m); else mobRecalc(m);  // (a monster's: Eternal Chaos, Don't Forget Me)
  }
}
const ENSEMBLE_RANGE = 4;
const ensemblePartner = (c, name) => crewOf(c).find(x => x !== c && x.dead == null && x.look.sex !== c.look.sex && knows(x, name)
  && ['Musical', 'Whip'].includes(x.pc.weapon) && !x.sitting && !x.frozen && !x.stunned && !x.asleep && !x.stone && !x.stopped && !x.snared
  && field.distance(c.w, x.w) <= ENSEMBLE_RANGE);
const redeemable = c => crewOf(c).filter(x => x !== c && x.dead != null && field.distance(c.w, x.w) <= (db.skills.PR_REDEMPTIO.splash[0] || 0));
// a skill p ({ sk, target }) that goes to a character down (Resurrection), the one skill that may (skill_castend_id)
const raising = p => p.sk.name === 'ALL_RESURRECTION' && !!p.target.isPc;
// a Support skill that hurts unit u instead, an undead monster (skill_castend_nodamage_id: a player's Heal or Aspersio)
const undeadFoe = (name, u) => ['AL_HEAL', 'PR_ASPERSIO', 'ALL_RESURRECTION'].includes(name) && !u.isPc && B.isUndead(baseStatus(u));
// character c uses a skill on unit u (an enemy, or with a Support skill an ally, itself included).
// Going for an enemy with a weapon skill makes it the target (the normal attack goes on with it
// afterwards); magic, and a skill that helps (Heal on an ally, or on an enemy that is not undead; Detoxify, Cure), is
// used on the way, and whatever c was attacking stays its target (none: it stays where it cast); `aside`
// uses any skill that way. `level`: another level than the one set in the list.
export function useSkill(c, name, u, aside = false, level = null) {
  if (!knows(c, name) || (hidden(c) && !HIDDEN_SKILLS.has(name)) || c.vending || !sees(c, u)) return;
  const sk = db.skills[name], lv = level || skillLv(c, name) || 1;
  if (magicImmune(c, u, sk)) return;  // (one magic cannot be aimed at: magicImmune)
  // (in hiding it cannot walk, but with Stalk: only on one in range, used from where it is, keeping whatever it was after)
  if (stuck(c) && !field.inRange(c.w, u.w, Math.abs(sk.range[lv - 1] || 1))) return;
  if (hidden(c)) aside = true;
  if (SKILL_USE[name].does === 'buff' && u.side !== c.side && !undeadFoe(name, u)) return;  // Increase AGI and Blessing: on allies only, here
  if ((name === 'AM_POTIONPITCHER' || name === 'AM_BERSERKPITCHER') && u.side !== c.side) return;  // (Aid Potion, Aid Berserk Potion: PartyOnly)
  if (targetFail(sk, u)) return say(c.w, targetFail(sk, u), W.t);
  if (casterFail(c, sk, u, lv)) return say(c.w, casterFail(c, sk, u, lv), W.t);
  if (has(c, 'KN_AUTOCOUNTER')) return say(c.w, '技能使用失敗', W.t);  // (at once, not turning to the target first)
  c.pending = { sk, lv, target: u };
  if (aside || SKILL_USE[name].aside || u.side === c.side || (sk.target === 'Support' && !undeadFoe(name, u)) || (B.SKILLS[name] || {}).magic) { setRunning(c, false); approach(c); }
  else engage(c, u);
}
// character c uses a ground skill on cell [x, y]: it walks into range of the cell, casts and places it there,
// and whatever it was attacking stays its target. The cell stands in for a unit (`ground`).
export function useGround(c, name, [x, y], level = null) {
  if (!knows(c, name) || hidden(c) || c.vending) return;
  const sk = db.skills[name], lv = level || skillLv(c, name) || 1;
  c.pending = { sk, lv, target: { w: field.spot(x, y), ground: true } };
  setRunning(c, false);
  approach(c);
}
// whom character c is heading for: the target of the skill it is about to use, else the one it attacks
const goal = c => c.pending ? c.pending.target : c.target;
// Unit u's skill p ({ sk, lv, target }) goes off, whichever kind u is: paid for, its motion (skillMotion), and
// what it does (SKILL_USE's `does`). A skill on the user itself has the user as its target. `cast`: after a
// cast, whose start already shouted the skill's name.
function fireSkill(u, p, t, cast = false) {
  debug.mark?.('fire', u, { sk: p?.sk?.name, lv: p?.lv, on: p?.target?.name });
  // a monster's row's emote, as its skill goes off, even if it fails (skill_castend_id / _nodamage_id / _pos: clif_emotion)
  if (p.emotion != null) emit('emotion', u, p.emotion, t);
  // (Hindsight's spell, `auto`: not skillFail's checks, its SP paid already, but for silence: status_check_skilluse;
  // the attack whose hit set it off not cut off)
  const use = SKILL_USE[p.sk.name], fail = (p.auto != null ? (u.silenced ? '技能使用失敗' : null) : skillFail(u, p.sk, p.lv, p.abra)) || targetFail(p.sk, p.target) || casterFail(u, p.sk, p.target, p.lv) || wallFail(u, p) || sightFail(u, p.sk);
  if (fail) return say(u.w, fail, t);
  // (Back Stab not from behind the target, or on its cell: nothing at all, no SP, no message — USESKILL_FAIL_MAX)
  if (p.sk.name === 'RG_BACKSTAP' && !behind(u, p.target)) return;
  if (p.sk.name === 'WZ_SIGHTRASHER') endStatus(u, 'MG_SIGHT');  // (castendNoDamageId: status_change_end SC_SIGHT)
  if (u.isPc && p.auto == null) cancelSwing(u);
  if (u.isPc && p.sk.name !== 'AS_CLOAKING') endStatus(u, 'AS_CLOAKING');  // (its skills end Cloaking: unit_skilluse_id2)
  if (p.auto != null) { u.sp -= p.auto; tallyOf(u).sp += p.auto; tallyOf(u).skills++; }  // (Hindsight's spell: 2/3 of its SP, autoSpell)
  else if (p.abra) { if (u.isPc) tallyOf(u).skills++; }  // (Hocus-Pocus's: nothing to pay, abraUse)
  else pay(u, p.sk, p.lv);
  emit('hp', u);
  if (u.bladeStop) { p = { ...p, root: true }; endBladeStop(u, t); }  // (the skill it may use ends Root: occultimpaction.cpp and the others)
  // (ending Hiding shouts nothing: by request)
  if (!cast && !use.quiet && !(p.sk.name === 'TF_HIDING' && hidden(u)) && !(p.sk.name === 'MC_VENDING' && u.vending)) shout(u.w, p.sk, t);
  const other = p.target === u ? null : p.target;  // (what it is aimed at, for the motion and the effects)
  // the user's motion: the casting pose (`pose`), action `group` (Find Stone's picking up), none (`still`: Back
  // Slide's slide is all of it), else its attack motion
  const mo = use.still ? { at: t } : skillMotion(u, p.sk, t, other, use.group ?? (use.pose ? 12 : null));
  emit('skill', p.sk.name, u.w, other && other.w, t, mo.at);
  // (which characters used what on a monster: 自動's thief uses Envenom once on each)
  // (and on a rival team's character: by report, a thief's 施毒 once went on for ever on one)
  if (u.isPc && other && (!other.isPc || other.side !== u.side)) (other.usedOn ??= new Set()).add(u.id + ':' + p.sk.name);
  const aside = DOES[use.does](u, p, t, mo);
  afterSkill(u, p, t, other, aside);
}
// monster m may be stolen from at all (see DOES.steal): one with Etc drops (all the sandbox has), not stolen from
export const stealable = m => !m.isPc && !m.stolen && !m.by && !isBoss(m) && !m.frozen && !m.stone && !m.stunned && !!(m.def.drops || []).length;
// what character c's Steal at level lv takes from monster m, or null (its odds, then the drops in order)
function stealRoll(c, m, lv) {
  const rate = Math.trunc((statusOf(c).stats.dex - baseStatus(m).stats.dex) / 2) + 6 * lv + 4;
  if (rate < 1 || rnd(100) >= rate) return null;
  for (const [id, r] of m.def.drops) if (rnd(10000) < r * W.drop) return id;
  return null;
}
// the statuses that give the weapon its element (each ending the others: status.yml EndOnStart), the sage's endows
const ENDOWS = ['SA_FLAMELAUNCHER', 'SA_FROSTWEAPON', 'SA_LIGHTNINGLOADER', 'SA_SEISMICWEAPON'];
const WEAPON_ELEMENTS = ['AS_ENCHANTPOISON', 'PR_ASPERSIO', ...ENDOWS, 'ITEM_ENCHANTARMS'];  // (and Box of Storm's: openBox)
// Hindsight's spells (by the client's description, as renewal's clif_autospell: the bolts from Lv 1, Soul Strike and
// Fire Ball from 4, Frost Diver and Earth Spike from 7, Thunderstorm and Heaven's Drive at 10), those learned, for
// character c at Hindsight Lv lv
const AUTOSPELLS = [['MG_FIREBOLT', 1], ['MG_COLDBOLT', 1], ['MG_LIGHTNINGBOLT', 1], ['MG_SOULSTRIKE', 4], ['MG_FIREBALL', 4],
  ['MG_FROSTDIVER', 7], ['WZ_EARTHSPIKE', 7], ['MG_THUNDERSTORM', 10], ['WZ_HEAVENDRIVE', 10]];
export const autoSpells = (c, lv = c.levels.SA_AUTOSPELL || 0) => AUTOSPELLS.filter(([n, from]) => lv >= from && (c.levels[n] || 0) > 0).map(([n]) => n);
// Hindsight on character c (SC_AUTOSPELL) as its normal attack on m lands at t: at 2 × Lv % (renewal: the client's
// description) its spell goes off on m, no cast, no motion, at half Hindsight's level (no higher than learned, 1 at
// least), that less at random (battle_weapon_attack: 1 in 2 halved, 7 in 20 one less), for 2/3 of its SP (none if
// short of it), no skill delay after it (by request; rAthena's is the skill's, skill_delayfix)
// the level Hindsight at Lv lv casts spell `name` at: half its own, no higher than learned, 1 at least
// Gank (RG_SNATCHER, skill_additional_effect) as character c's normal attack lands on monster m, not with a bow: at
// (15 × Lv + 55 + 10 × its Steal Lv) / 1000 a Steal at its Steal level goes off (pc_steal_item: stealable, stealRoll),
// shown as Steal's (clif_skill_nodamage TF_STEAL); one that takes nothing says nothing (by request: display_skill_fail 4,
// not rAthena's default 2, under which 技能使用失敗 shows).
// On one it cannot steal from (stolen from already, a boss…) it does not try at all (by request: rAthena's would, and fail)
function gank(c, m, t) {
  const steal = passiveLv(c, 'TF_STEAL');
  if (!alive(m) || !stealable(m) || rnd(1000) >= 15 * passiveLv(c, 'RG_SNATCHER') + 55 + 10 * steal) return;
  const id = stealRoll(c, m, steal);
  if (id == null) return;
  m.stolen = true;
  emit('success', 'TF_STEAL', m.w, t);
  emit('stolen', c, id, m, t);
  gain(c, id, t);
}
const autoSpellLv = (c, name, lv) => Math.max(1, Math.min(c.levels[name] || 1, Math.trunc(lv / 2)));
function autoSpell(c, m, t) {
  const s = c.sc.find(x => x.name === 'SA_AUTOSPELL' && t < x.until);
  if (!s || !s.spell || !alive(m) || rnd(100) >= 2 * s.lv) return;
  const sk = db.skills[s.spell];
  let lv = s.max;
  const i = rnd(100);
  if (lv > 1) { if (i >= 50) lv = Math.trunc(lv / 2); else if (i >= 15) lv--; }
  const sp = Math.trunc((sk.sp[lv - 1] || 0) * 2 / 3);
  if (c.sp < sp) return;
  const target = sk.target === 'Ground' ? { w: field.spot(...m.w.cell), ground: true } : m;
  // (it goes off as a skill does, its motion and effects too, but with no cast, no name shouted and its own SP: fireSkill
  // `auto`; and no skill delay after it, by request: afterSkill)
  fireSkill(c, { sk, lv, target, auto: sp }, t, true);
}
// Hocus-Pocus (skills/mage/hocuspocus.cpp) at Lv lv: a skill of db/abra_db.yml at random, taken at its chance at that
// level (1/10000; drawn again if not, at most 3 × as many times as there are, the last one drawn kept), those the
// sandbox has (SKILL_USE) only
function abraRoll(lv) {
  const pool = (db.abra || []).filter(([n]) => SKILL_USE[n] && db.skills[n]);
  let pick = pool[0];
  for (let i = 0; i <= pool.length * 3; i++) { pick = pool[rnd(pool.length)]; if (rnd(10000) < pick[1][lv - 1]) break; }
  return pick && pick[0];
}
// what character c does with the skill Hocus-Pocus gave it (sd->skillitem: no SP, no items, its cast time as any; the
// level Hocus-Pocus's, no higher than the skill's): on its own as a monster's is (the mob branch of hocuspocus.cpp; a
// player picks the target in the game): a self or support skill on itself, a ground skill on the cell of whom it is
// after (else its own), any other on whom it is after (else the nearest enemy it sees; none, nothing)
export function abraUse(c, name, lv, t) {
  const sk = db.skills[name], foe = c.target && alive(c.target) && c.target.side !== c.side ? c.target
    : enemies(c).filter(m => alive(m) && sees(c, m)).sort((a, b) => field.distance(c.w, a.w) - field.distance(c.w, b.w))[0];
  lv = Math.max(1, Math.min(lv, sk.maxLevel || 1));
  if (sk.target === 'Self') { c.selfPending = { sk, lv, abra: true }; return; }
  const target = sk.target === 'Support' ? c : sk.target === 'Ground' ? { w: field.spot(...(foe || c).w.cell), ground: true } : foe;
  if (!target) return say(c.w, '技能使用失敗', t);
  c.pending = { sk, lv, target, abra: true };
  setRunning(c, false);
  approach(c);
}
// a monster of one of rAthena's random groups (db/re/mob_summon.yml: CLASSCHANGE, BRANCH_OF_DEAD_TREE, the sandbox's
// monsters; mob_get_random_id with RMF_DB_RATE: one at random taken at its rate of 1000000, at most 3 × as many
// tries, else the group's default), whose sprite is in (motion.has: the sandbox loads those it may need, sandbox.js)
function randomMob(group, notBoss = false) {
  const g = (db.summonGroups || {})[group];
  if (!g) return null;
  const ok = id => { const d = mobDef(id); return d && inSprites(d) && !(notBoss && d.class === 'Boss'); };
  const list = g.mobs.filter(([id]) => ok(id));
  for (let i = 0; i < list.length * 3; i++) { const [id, rate] = list[rnd(list.length)]; if (rate >= 1000000 || rnd(1000000) < rate) return mobDef(id); }
  return ok(g.default) ? mobDef(g.default) : list.length ? mobDef(list[0][0]) : null;
}
// whether monster def's sprite and those of what it may summon or turn into are all in (motion.has; by report: a
// Baphomet from Class Change calling its slaves, not loaded, stopped the page)
const inSprites = def => !motion.has || [...spritesOf(def)].every(n => motion.has({ sprite: n }));
// the monsters Hocus-Pocus may bring in, for loading their sprites before a fight with one who knows it: Mono Cell's
// Poring, Class Change's bosses and the dead branch's default; not all the dead branch's (by report: some 240 sprites
// at once crashed the page), Monster Chant drawing from those of them already in (randomMob: motion.has)
// the monster a card's polymorph (bClassChange) turns one into when none of the dead branch's on the map is in: the
// group's default, loaded before a fight with one who has it (as abraMobs)
export const classChangeMobs = () => [((db.summonGroups || {}).BRANCH_OF_DEAD_TREE || {}).default].map(mobDef).filter(Boolean);
export const abraMobs = () => {
  const g = db.summonGroups || {}, cc = g.CLASSCHANGE || { mobs: [] }, br = g.BRANCH_OF_DEAD_TREE || {};
  return [...new Set([1002, cc.default, ...cc.mobs.map(([id]) => id), br.default])].map(mobDef).filter(Boolean);
};
// What a skill does as it goes off (SKILL_USE's `does`): unit u's skill p at time t, the user's motion mo
// (skillMotion: at, when its damage starts landing). Each returns whether the user is done with someone other
// than whom it was attacking (a character then goes back to that).
const JOKE_MS = 3000;
// (Snatch's warp: rAthena's is 800 ms after it goes off (skill_addtimerskill tick + 800); here SNATCH_MS after the
// motion reaches SNATCH_FRAME, the 9th, and not before its hit has landed: by request, 800 was a long wait.
// SNATCH_LAND_MS: how long the teleport takes to show, stage.js TP_OUT_MS + TP_IN_MS — the user held in that frame
// till it has landed)
const SNATCH_MS = 100, SNATCH_FRAME = 8, SNATCH_LAND_MS = 800;
const DOES = {
  // a status on an ally, or on the user (Increase AGI, Blessing, Improve Concentration, Endure, Sight, Ruwach): it takes hold at once
  // and lasts the skill's Duration1; cast again it starts over (status_change_start). Sitting goes on: these
  // have no SetStand flag in status_db.
  buff(u, p, t, mo) {
    const m = p.target;
    if (magicImmune(u, m, p.sk)) return say(u.w, '技能使用失敗', t), m !== u.target;
    // Aspersio on a monster: an undead one takes its damage with the motion (skill_attack), any other it fails on
    if (p.sk.name === 'PR_ASPERSIO' && !m.isPc) {
      if (!undeadFoe(p.sk.name, m)) return say(u.w, '技能使用失敗', t), m !== u.target;
      if (u.sitting) sit(u, false);
      schedule(B.skillAttack(db, offense(u), defense(m), p.sk, p.lv), u, m, mo.at);
      return m !== u.target;
    }
    // Aspersio and Enchant Poison: each ends the other (status.yml EndOnStart)
    // (an endow on one with no weapon fails: endow*.cpp, W_FIST)
    if (ENDOWS.includes(p.sk.name) && m.isPc && m.pc.weapon === 'Fist') return say(u.w, '技能使用失敗', t), m !== u.target;
    // (the endows each end the others and those two, and they the endows: status.yml EndOnStart)
    if (WEAPON_ELEMENTS.includes(p.sk.name)) for (const n of WEAPON_ELEMENTS) if (n !== p.sk.name) endStatus(m, n);
    // Blessing on a character cursed or turned to stone ends that instead, the curse first (status_change_start:
    // SC_BLESSING cures SC_CURSE, else SC_STONE, on a player — not the stone wait — and gives nothing more)
    if (p.sk.name === 'AL_BLESSING' && m.isPc && (m.curse || (m.stone && m.stone.on))) {
      if (m.curse) uncurse(m, t); else unpetrify(m, t);
      emit('success', p.sk.name, m.w, t);
      return m !== u.target;
    }
    if (p.sk.name === 'PR_KYRIE' && !m.isPc) return say(u.w, '技能使用失敗', t), m !== u.target;
    // Chemical Protection: only on a character with that part on (alchemicalweapon.cpp etc.: pc_checkequip), its
    // Glistening Coat given back (SKILL_NOCONSUME_REQ). The sandbox has no body armour or headgear: always worn here.
    if (CHEM_PROTECT[p.sk.name] && (!m.isPc || !CHEM_PROTECT[p.sk.name](m))) return giveBack(u, COATING_BOTTLE), say(u.w, '技能使用失敗', t), m !== u.target;
    if (quagFail(m, p.sk.name)) return m !== u.target;  // (status.yml Fail: Quagmire)
    addStatus(m, p.sk, p.lv, t);  // (the stats it raises change everything worked out from them)
    if (p.sk.name === 'PR_KYRIE') {
      const s = m.sc.find(x => x.name === 'PR_KYRIE'), k = B.BUFF_SKILLS.PR_KYRIE;
      s.barrier = Math.trunc(m.pc.maxHp * k.shield(p.lv) / 100);
      s.left = k.barrier(p.lv);
    }
    if (p.sk.name === 'AC_CONCENTRATION') reveal(u, p.sk.splash[p.lv - 1] || 0);  // (skills/archer/concentration.cpp)
    emit('success', p.sk.name, m.w, t);
    return m !== u.target;
  },
  // Earthquake (NPC_EARTHQUAKE, from a card only: earthquake.cpp, UNT_EARTHQUAKE): its unit on the user's cell hits every
  // enemy within its splash (Lv 2: 7 cells) each Interval (300 ms) of its Duration1 (910 ms: 3 times); a character's
  // (renewal): STR × 2 + its weapon attack's damage on that one, shared among those hit (SplashSplit), no MDEF
  // (IgnoreDefense), neutral
  quake(u, p, t, mo) {
    if (u.sitting) sit(u, false);
    const area = p.sk.splash[p.lv - 1] || 0, cell = [...u.w.cell], every = 300, n = Math.trunc((p.sk.duration[p.lv - 1] || 0) / every);
    emit('success', p.sk.name, u.w, t);
    for (let i = 1; i <= n; i++) W.later.push({ at: t + i * every, by: u, to: u, run(at) {
      if (!alive(u)) return;
      const hit = enemies(u).filter(x => alive(x) && cheb(x.w.cell, cell) <= area);
      for (const x of hit) {
        const a = offense(u), d = defense(x), w = B.hitDamage(db, a, d, false).damage, base = a.stats.str * 2 + w, share = Math.trunc(base / hit.length);
        const ratio = B.attrRatio(db, 'Neutral', d.element, d.elementLv), damage = Math.max(0, Math.trunc(share * ratio / 100));
        schedule({ type: 'hit', damage, hits: 1, skill: { ...p.sk, lv: p.lv }, steps: [[`STR ${a.stats.str} × 2 + 武器攻擊 ${w}`, base], ...hit.length > 1 ? [[`${hit.length} 個平分`, share]] : [],
          [`無屬性對${B.ELEMENT_ZH[d.element]} ${d.elementLv} ${ratio}%`, damage]] }, u, x, at);
      }
    } });
    return false;
  },
  // a status on every living ally within the skill's splash of the user, the user too (Angelus, Crazy Uproar,
  // Impositio Manus, Suffragium, Gloria, Magnificat: skill_castend_nodamage_id → party_foreachsamemap within the splash; a splash
  // below 0 is AREA_SIZE: skill_get_splash); all at once
  partyBuff(u, p, t) {
    const s = p.sk.splash[p.lv - 1] || 0, area = s < 0 ? AREA_SIZE : s;
    for (const m of allies(u).filter(x => x.dead == null && sees(u, x) && (x === u || field.distance(u.w, x.w) <= area) && !magicImmune(u, x, p.sk))) {
      addStatus(m, p.sk, p.lv, t);
      emit('success', p.sk.name, m.w, t);
    }
    return false;
  },
  // a song, dance or ensemble, on the ground round its player and following it (by request, as before renewal, not
  // skill_castend_song): see placeSong
  song(u, p, t) {
    if (!u.isPc) return false;
    placeSong(u, p.sk, p.lv, t);
    return false;
  },
  // Amp (skills/archer/amp.cpp, pre-renewal): ends the user's playing, an ensemble's for both; nothing else
  amp(u, p, t) {
    W.songs.filter(n => n.by === u || n.with === u).forEach(songOut);
    return false;
  },
  // Encore (skills/archer/encore.cpp): what was played last, on the user, at the level it was, for half its SP (spCost)
  encore(u, p, t) {
    const d = u.dance;
    u.encore = d.name;
    W.later.push({ at: t, by: u, to: u, run() { useSkill(u, d.name, u, true, d.lv); } });
    return false;
  },
  // Unbarring Octave and Dazzler (skills/archer/unbarringoctave.cpp, dazzler.cpp): the user says something, and 3 s on
  // (skill_addtimerskill; none if it is down by then) everyone within AREA_SIZE of where it stood but itself rolls: 15 + 5 × Lv %
  // to be frozen, or 25 + 5 × Lv % stunned, against its resistance for Duration2, one of its party a quarter of that for Duration1
  joke(u, p, t) {
    const use = SKILL_USE[p.sk.name], at = u.w.cell, talk = p.sk.talk || [];
    if (talk.length) say(u.w, talk[rnd(talk.length)], t, null, true);  // (as a chat message: see stage.js drawChat)
    W.later.push({ at: t + JOKE_MS, by: u, to: u, run(when) {
      for (const m of units()) {
        if (m === u || !alive(m) || field.distance(m.w, field.spot(...at)) > AREA_SIZE || ailOn(m, use.ail)) continue;
        const mine = m.side === u.side, rate = (use.rate + 50 * p.lv) / 10 / (mine ? 4 : 1);
        const o = AIL_ODDS[use.ail](statusOf(u), statusOf(m), rate, p.sk[mine ? 'duration' : 'duration2'][p.lv - 1] || 0);
        if (rnd(10000) < o.chance * 100) AIL_START[use.ail](m, when, o.ms);
      }
    } });
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Pang Voice (skills/archer/pangvoice.cpp, pre-renewal: by request): not on a boss; confused for Duration1 at 70%
  pang(u, p, t) {
    const m = p.target;
    if (isBoss(m)) return say(u.w, '技能使用失敗', t), m !== u.target;
    const o = B.confuseOdds(statusOf(u), statusOf(m), 70, p.sk.duration[p.lv - 1] || 0);
    if (!m.confused && rnd(10000) < o.chance * 100) confuse(m, t, o.ms);
    emit('success', p.sk.name, m.w, t);
    return m !== u.target;
  },
  // Wink of Charm (skills/archer/winkofcharm.cpp): on a demon, demi-human or angel, not a boss (skill_check_condition): at
  // the user's level less its own + 40 % for Duration2 it drops its target, cannot use a skill, nor attack the user
  // (status_check_skilluse: SC_WINKCHARM val2), until a hit lands on it (RemoveOnDamaged)
  wink(u, p, t) {
    const m = p.target, st = statusOf(m);
    if (m.isPc || isBoss(m) || !['Demon', 'Demihuman', 'Angel'].includes(st.race)) return say(u.w, '技能使用失敗', t), m !== u.target;
    if (rnd(100) < baseStatus(u).lv - st.lv + 40) {
      addStatus(m, p.sk, p.lv, t, null, p.sk.duration2[p.lv - 1] || 0);
      m.sc.find(s => s.name === p.sk.name).by = u;
      if (m.target === u) m.target = null;
    }
    emit('success', p.sk.name, m.w, t);
    return m !== u.target;
  },
  // Signum Crucis (skills/acolyte/crucis.cpp): on every enemy within its splash square around the user
  // (map_foreachinallrange) that is an undead or demon monster, at B.crucisOdds, a hard DEF cut (B.crossed) until
  // it dies (INFINITE_TICK); one under it already is left as it is (status.yml Fail). Each it takes hold of
  // sweats (clif_emotion ET_SWEAT); the user shows the cross whatever comes of it (clif_skill_nodamage).
  // Venom Splasher (skills/thief/venomsplasher.cpp): on a status-immune target (Boss class here) it fails; otherwise
  // SC_SPLASHER on it for Duration1 (11 − Lv s), at whose end — not if it ends before, as with the target's death —
  // it blows up (skill_castend_damage_id with SD_LEVEL): B.SKILLS' blast on every enemy of the user within its splash
  // (2: the 5×5) around the target, the target too, each hit at once. A later one on the same target takes its place.
  // (Renewal asks for no Red Gemstone, nor for the target below 3/4 of its HP.)
  splasher(u, p, t) {
    const m = p.target;
    if (isBoss(m)) return say(u.w, '技能使用失敗', t), false;
    const ms = p.sk.duration[p.lv - 1] || 0;
    addStatus(m, p.sk, p.lv, t, null, ms);
    const s = m.sc.find(x => x.name === p.sk.name);
    emit('success', p.sk.name, m.w, t);
    W.later.push({ at: t + ms, by: u, to: m, run(at) {
      if (!m.sc.includes(s)) return;  // (replaced by another)
      endStatus(m, p.sk.name);
      const area = p.sk.splash[p.lv - 1] || 0;
      for (const x of enemies(u).filter(x => alive(x) && field.distance(x.w, m.w) <= area && field.sees(m.w.cell, x.w.cell))) {
        const r = B.skillAttack(db, offense(u), defense(x), p.sk, p.lv);
        if (r.damage > 0) rollAils(u, x, p, r);
        schedule(r, u, x, at);
      }
    } });
    return m !== u.target;
  },
  crucis(u, p, t) {
    const area = p.sk.splash[p.lv - 1] || 0, st = statusOf(u);
    for (const m of enemies(u)) {
      if (!alive(m) || field.distance(u.w, m.w) > area || has(m, 'AL_CRUCIS')) continue;
      if (rnd(100) < B.crucisOdds(st, statusOf(m), p.lv)) {
        addStatus(m, p.sk, p.lv, t, null, Infinity);
        emit('emotion', m, ET_SWEAT, t);
      }
    }
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // a status on the user that stays until the skill is used again, which ends it (Auto Berserk: see berserk)
  toggle(u, p, t) {
    if (has(u, p.sk.name)) {
      u.sc = u.sc.filter(s => s.name !== p.sk.name && !s.auto);  // (and what it brought on)
      if (u.isPc) recalc(u);
      return false;
    }
    u.sc = [...u.sc, { name: p.sk.name, lv: p.lv, start: t, until: Infinity, effect: null }];
    if (u.isPc) recalc(u);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Steal (skills/thief/steal.cpp → pc_steal_item, renewal): (DEX − the monster's DEX) / 2 + 6 × Lv + 4 % to
  // succeed; it fails on a character, a status-immune (Boss) monster, one summoned (master_id), one stolen from
  // already (steal_flag), and one frozen, petrified or stunned (opt1). Past the odds, its drops are gone through
  // in order, each at its own rate (× the map's W.drop, as dropLoot's), the first that comes up taken: into the
  // party's loot (W.loot, as one picked up; it flies from the monster to the thief) and the monster stolen from; none coming up, the skill fails and it
  // may be tried again.
  steal(u, p, t) {
    const m = p.target;
    m.stealTries = (m.stealTries || 0) + 1;  // (自動 gives up after a few: see the thief's rules)
    const id = stealable(m) ? stealRoll(u, m, p.lv) : null;
    if (id == null) say(u.w, '技能使用失敗', t);
    else {
      m.stolen = true;
      emit('success', p.sk.name, m.w, t);
      emit('stolen', u, id, m, t);  // (what it took flies to the thief: by request, no text)
      gain(u, id, t);
    }
    return m !== u.target;
  },
  // Detoxify (skills/thief/detoxify.cpp): the target's poison ends; Cure (skills/acolyte/cure.cpp): its silence,
  // blindness and confusion. It always shows.
  cure(u, p, t) {
    const m = p.target;
    if (p.sk.name === 'TF_DETOXIFY') { if (m.poison) unpoison(m, t); }
    else {
      if (m.silenced) unsilence(m, t);
      if (m.blind) unblind(m, t);
      if (m.confused) unconfuse(m, t);
    }
    emit('success', p.sk.name, m.w, t);
    return m !== u.target;
  },
  // Back Slide (skills/thief/backslide.cpp, renewal): the user slides 5 cells (Knockback) back from the way it
  // faces (skill_blown with its own direction), stopping at what it cannot cross. A character holds the
  // bare-handed swing's hit frame as it slides (the leap of Hiding's: by request).
  backslide(u, p, t) {
    if (u.isPc) setRunning(u, false);
    const before = [...u.w.cell], from = [...u.w.pos];
    field.knockback(u.w, null, p.sk.knockback[p.lv - 1] || 0);
    if (u.w.slide) emit('dash', p.sk.name, from, u.w.slide.to, t, u.w.slide.dur, u.w.slide.ease);  // (dust along it: by request)
    if (u.isPc) {
      const cells = Math.max(Math.abs(u.w.cell[0] - before[0]), Math.abs(u.w.cell[1] - before[1]));
      u.anim = { start: t, group: 5, frames: 1, fd: Math.max(1, cells * field.knockMs), hold: motion.pc(u, 5).hf, target: null };
    }
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Find Stone (skills/thief/findstone.cpp): it picks a Stone up. The sandbox has no inventory: the character
  // only counts its stones (c.stones; Stone Fling uses one up if it has any, but does not ask for one)
  pickStone(u) {
    u.stones = (u.stones || 0) + 1;
    return false;
  },
  // Hiding (skills/thief/hiding.cpp, SC_HIDING): used again it ends. Otherwise, for Duration1 (30 s a level), only
  // the user itself, bosses and Detector monsters see it (see sees: whoever was after it lets go, area damage
  // and Fire Wall pass it by); it stops where it is and cannot walk (NoMoveCond), stops attacking (StopAttacking),
  // and gets no natural regen (status_calc_regen). A character uses no other skill (skillFail) and pays SP for
  // it as it goes (hidingDrain); a monster may use its skills but not attack (mob_ai_sub_hard). Damage brings it
  // out (RemoveOnDamaged: see hurt), and so do Sight and Improve Concentration (reveal).
  hide(u, p, t) {
    if (hidden(u)) { endStatus(u, 'TF_HIDING'); return false; }
    addStatus(u, p.sk, p.lv, t);
    u.w.halt();
    if (u.isPc) disengage(u);
    lostSight(u, t);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Counter Attack (skills/swordman/counterattack.cpp, SC_AUTOCOUNTER): for Duration1 (0.4 s a level) the user
  // stands holding its attack motion's first frame (roBrowser SkillAction: ATTACK, frame 0, not playing), neither
  // walking, attacking nor using a skill (status.yml NoMove, NoAttack; status_check_skilluse); a normal attack on
  // it then is countered (autoCounter)
  counter(u, p, t) {
    addStatus(u, p.sk, p.lv, t);
    u.w.halt();
    const ms = p.sk.duration[p.lv - 1] || 0;
    // (a monster's, the Wanderer's: its attack's first frame, as a monster's motion is told — by report, the page
    // stopped, a character's sprites looked for on it)
    u.anim = u.isPc ? { start: t, group: motion.attackGroup(u), frames: 1, fd: ms, hold: 0 } : { grp: 2, start: t, fd: ms, end: t + ms };
    u.alert = true;
    return false;
  },
  // The blacksmith's party buffs (skills/merchant/adrenalinerush.cpp, weaponperfection.cpp, powerthrust.cpp): a
  // monster's on itself (mobBuff); a character's on itself (`self`: sc_start2's val2) and on every living party member
  // within its splash (−1: AREA_SIZE) that holds a weapon the skill asks for (skill_db Requires: pc_check_weapontype),
  // for Duration1, a tenth longer when the user has Hilt Binding (status_change_start). One that has the user's own
  // already is not given the party's, weaker (val2 the greater: it fails); Adrenaline Rush fails under Decrease AGI and
  // Quagmire (status.yml Fail). Their figures: B.BUFF_SKILLS.
  smith(u, p, t) {
    if (!u.isPc) return DOES.mobBuff(u, p, t);
    const name = p.sk.name, s = p.sk.splash[p.lv - 1] || 0, area = s < 0 ? AREA_SIZE : s, need = p.sk.weapon || [];
    const ms = (n => passiveLv(u, 'BS_HILTBINDING') > 0 ? n + Math.trunc(n / 10) : n)(p.sk.duration[p.lv - 1] || 0);
    for (const m of allies(u).filter(x => x.dead == null && sees(u, x) && (x === u || field.distance(u.w, x.w) <= area))) {
      if (!m.isPc || (need.length && !need.includes(m.pc.weapon))) continue;
      const own = m.sc.find(x => x.name === name);
      if (own && own.self && m !== u) continue;
      if (name === 'BS_ADRENALINE' && (has(m, 'AL_DECAGI') || quagFail(m, name))) continue;
      addStatus(m, p.sk, p.lv, t, null, ms);
      m.sc.find(x => x.name === name).self = m === u;
      recalc(m);
      emit('success', name, m.w, t);
    }
    return false;
  },
  // Maximize Power (a StatusSkillImpl ending if on): on one that has it, it ends; else a character's is on until then
  // (B.BUFF_SKILLS, maximizeDrain), a monster's for a fixed 10 s, as it pays no SP (status_change_start: not
  // BL_CONSUME), its attacks at the top of its ATK (B.mobHitDamage)
  maximize(u, p, t) {
    if (has(u, p.sk.name)) { endStatus(u, p.sk.name); return false; }
    if (u.isPc) return DOES.toggle(u, p, t);
    addStatus(u, p.sk, p.lv, t, null, MOB_MAXIMIZE_MS);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Hammer Fall (skills/merchant/hammerfall.cpp): every enemy in its splash square (5×5) round the target cell
  // (map_foreachinallarea: no line of sight asked), each a second after it goes off (skill_addtimerskill tick + 1000)
  // stunned at min(20 + 10 × Lv, 50 + 5 × Lv) % against its resistance (B.stunOdds) for Duration2; no damage
  hammer(u, p, t) {
    if (u.sitting) sit(u, false);
    const at = p.target.w, area = areaOf(p.sk, p.lv), rate = Math.min(20 + 10 * p.lv, 50 + 5 * p.lv), ms = p.sk.duration2[p.lv - 1] || 0;
    for (const m of enemies(u)) {
      if (!alive(m) || field.distance(m.w, at) > area) continue;
      m.hammered = t + 1000;
      W.later.push({ at: t + 1000, by: u, to: m, run(when) {
        if (!alive(m) || m.stunned) return;
        const o = B.stunOdds(statusOf(u), statusOf(m), rate, ms);
        if (rnd(10000) < o.chance * 100) stun(m, when, o.ms);
      } });
    }
    return false;
  },
  // A monster's buff on itself (a StatusSkillImpl, at 100%) for the skill's Duration1: Agility Up (ending Decrease
  // AGI: EndOnStart), Keeping, Two-Hand Quicken and Adrenaline Rush (failing under Decrease AGI: status.yml Fail),
  // Auto Guard (on it already: ended instead, end_if_running), Reflect Shield. What they do: B.mobBuffed (its
  // figures: mobRecalc), Keeping's standstill (mobAi), Auto Guard's block (schedule), Reflect Shield's damage
  // sent back (landHits).
  mobBuff(u, p, t) {
    const name = p.sk.name;
    if (['CR_AUTOGUARD', 'CR_DEFENDER', 'CR_SHRINK'].includes(name) && has(u, name)) { endStatus(u, name); return false; }
    if (['KN_TWOHANDQUICKEN', 'BS_ADRENALINE'].includes(name) && has(u, 'AL_DECAGI')) return false;
    if (quagFail(u, name)) return false;
    if (name === 'NPC_AGIUP') endStatus(u, 'AL_DECAGI');
    addStatus(u, p.sk, p.lv, t);
    emit('success', name, u.w, t);
    return false;
  },
  // Sacrifice (skills/swordman/sacrifice.cpp, SC_DEVOTION) on character m for Duration2 (30–90 s): what hits m does it no
  // harm, its crusader u taking all of it instead (landHits: devotedTo), while u stays within the skill's range of m (val3)
  // and is up. On m with it, at u's levels, u's Auto Guard, Defending Aura, Reflect Shield and Endure, ending with it
  // (status_change_start SC_DEVOTION: inherited; status.yml EndOnEnd). The blue line between the two: stage.js.
  devotion(u, p, t) {
    const m = p.target, ms = p.sk.duration2[p.lv - 1] || 0;
    endDevotion(m);
    addStatus(m, p.sk, p.lv, t, null, ms);
    Object.assign(m.sc[m.sc.length - 1], { by: u, range: Math.abs(p.sk.range[p.lv - 1] || 0) });
    // (marked as Sacrifice's as they go on: the shield ones stay without a shield, recalc)
    for (const name of DEVOTION_SHARES) {
      const s = u.sc.find(x => x.name === name && W.t < x.until), hits = (B.BUFF_SKILLS[name] || {}).hits;
      if (!s) continue;
      const until = t + Math.min(db.skills[name].duration[s.lv - 1] || 0, ms);
      m.sc = [...m.sc.filter(x => x.name !== name), { name, lv: s.lv, start: t, until, effect: null, devoted: true, ...hits && { hits } }];
    }
    recalc(m);
    emit('success', p.sk.name, m.w, t);
    return m !== u.target;
  },
  // Grand Cross (skills/swordman/grandcross.cpp castendPos2 → skill_unitsetting): GX_CELLS round the user, those it sees
  // (PathCheck) and not on Land Protector, each hitting whatever enemy stands on it every GX_MS (Interval 300), the first
  // as it is set down, for as long as it lasts: Duration1 / Interval hits a cell (val1, 3), spent by each one it hits. The
  // user is held where it stands meanwhile (SC_ANKLE for Duration1).
  grandCross(u, p, t) {
    const [x0, y0] = u.w.cell, ms = p.sk.duration[p.lv - 1] || 0, n = Math.trunc(ms / GX_MS);
    const cells = GX_CELLS.map(([dx, dy]) => ({ cell: [x0 + dx, y0 + dy], left: n })).filter(c => field.sees(u.w.cell, c.cell) && !onLP(...c.cell));
    holdWalk(u, t + ms);
    for (let i = 0; i < n; i++) W.later.push({ at: t + i * GX_MS, by: u, to: u, run: at => gxWave(u, p, cells, at) });
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Cloaking, Invisible (skills/thief/cloaking.cpp, npc/invisible.cpp): SC_CLOAKING on the monster at 100% — a
  // monster pays no SP, so it lasts a fixed 10 s whatever the skill says (status_change_start). It is unseen as
  // one in hiding (sees: only bosses and Detector monsters see it; characters let it go, lostSight) but walks
  // and attacks; damage ends it (RemoveOnDamaged), and so does Cloaking's user attacking (monster_cloak_check_type
  // 4: not its skills), not Invisible's (val4 6: neither). Cloaking used again while cloaked ends it instead;
  // Invisible starts it over. A character's lasts until it ends so, paying 1 SP every Duration1 (0.5–9 s:
  // cloakTurn), its walk and critical rate changed (B.playerStatus); its own attacks and skills end it too
  // (pc_cloak_check_type 1), as does being away from a wall below Lv 3.
  cloak(u, p, t) {
    if (p.sk.name === 'AS_CLOAKING' && cloaked(u)) { endStatus(u, 'AS_CLOAKING'); return false; }
    if (u.isPc) disengage(u);
    addStatus(u, db.skills.AS_CLOAKING, p.lv, t, null, u.isPc ? Infinity : CLOAK_MS);
    Object.assign(u.sc[u.sc.length - 1], { stay: p.sk.name === 'NPC_INVISIBLE', ...u.isPc && { wall: byWall(u) } });
    if (u.isPc) recalc(u);
    lostSight(u, t);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Summon Spirit Sphere (skills/acolyte/summonspiritsphere.cpp): a spirit sphere more for Duration1 (600 s), Lv at
  // most (addSphere; with Lv already it fails: skillFail)
  spheres(u, p, t) {
    addSphere(u, t, p.sk.duration[p.lv - 1] || 0, p.lv);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Absorb Spirit Sphere (skills/acolyte/absorbspiritsphere.cpp): on the user, all its spheres gone for 7 SP each
  // (none: nothing, no message); on a monster that is not a boss (MD_STATUSIMMUNE), at 20% 2 SP for each of its levels,
  // the monster turning on the user (mob_target); any other way (another party member, the 80%) it fails. The SP comes
  // shown (status_heal flag 3), the skill's effect on the user with it.
  absorb(u, p, t) {
    const m = p.target;
    let n = 0;
    if (m === u) { n = 7 * u.spheres.length; useSpheres(u, u.spheres.length); }
    else if (!m.isPc && !isBoss(m) && rnd(100) < 20) {
      n = 2 * m.st.lv;
      if (m.st.mode & B.MD.CANATTACK && m.target !== u && (!m.target || canChangeTarget(m, u, false))) m.target = u;
    } else return say(u.w, '技能使用失敗', t), false;
    if (!n) return false;
    u.sp = Math.min(u.pc.maxSp, u.sp + n);
    emit('heal', u, { type: 'heal', sp: true, damage: n }, t);
    emit('hp', u);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Raging Quadruple Blow, Raging Thrust (skills/acolyte/ragingquadrupleblow.cpp, ragingthrust.cpp): used only right
  // after the skill before them in the chain (skillFail), on whom that hit (p.target: see the self skills in stepChar),
  // within 2 cells (Range −2); it ends that combo (skill_combo) and hits as an attack skill does, and may start the next
  // (startCombo)
  combo(u, p, t, mo) {
    const m = p.target, from = u.combo;
    u.combo = null;
    if ((!from && !p.root) || m === u || !alive(m) || !field.inRange(u.w, m.w, Math.abs(p.sk.range[p.lv - 1] || 1))) return say(u.w, '技能使用失敗', t), false;
    DOES.attack(u, p, t, mo);
    startCombo(u, p.sk, p.lv, m, t);
    // (`holdHits`: the held pose lasts till its last hit has landed)
    if (SKILL_USE[p.sk.name].holdHits && u.anim) u.anim.until = Math.max(...W.hits.filter(h => h.from === u && h.skill && h.skill.name === p.sk.name).map(h => h.at), 0);
    return false;
  },
  // Asura Strike (skills/acolyte/asurastrike.cpp): on its target within 2 cells, under Fury (skillFail), as an attack
  // skill does, the user's SP going into it; then all its SP gone, Fury over, no SP regen for Duration1 (3 s: the
  // status MO_EXTREMITYFIST), and the user dashing 3 cells on the way it struck, through the target, if it can stand
  // there with nothing in the way (unit_movepos; clif_blown: a slide). Failing — its target gone or out of reach — it
  // costs all the same (skill_castend_id) but does not move here. Right after Raging Thrust it ends that combo.
  asura(u, p, t, mo) {
    const m = p.target, sk = p.sk;
    if (u.combo && u.combo.name === 'MO_COMBOFINISH') u.combo = null;
    const ok = m && m !== u && alive(m) && field.inRange(u.w, m.w, Math.abs(sk.range[p.lv - 1] || 2));
    if (ok) DOES.attack(u, p, t, mo); else say(u.w, '技能使用失敗', t);
    u.sp = 0;
    emit('hp', u);
    addStatus(u, sk, p.lv, t);
    endStatus(u, 'MO_EXPLOSIONSPIRITS');
    if (ok) {
      const [x, y] = u.w.cell, dx = Math.sign(m.w.cell[0] - x), dy = Math.sign(m.w.cell[1] - y), to = [x + 3 * dx, y + 3 * dy];
      if ((dx || dy) && field.open(...to) && field.sees(u.w.cell, to))
        // (and holds its fist on the ground there with its back to the target, not turning to it till the attack
        // goes on: by request)
        W.later.push({ at: mo.at, by: u, to: u, run() { u.w.stop(); u.w.knock(to, SNAP_MS); if (u.anim) u.anim.noFace = true; } });
    }
    return false;
  },
  // Root (MO_BLADESTOP): the user waits, unable to walk, for Duration1 (0.5 s + 0.2 s a level: SC_BLADESTOP_WAIT) to
  // catch a normal attack (bladeCatch). Its pose held 3 s, as roBrowser's.
  bladeWait(u, p, t) {
    const ms = p.sk.duration[p.lv - 1] || 0;
    u.bladeWait = { lv: p.lv, until: t + ms };
    holdWalk(u, t + ms);
    if (u.anim) u.anim.until = t + 3000;
    return false;
  },
  // Ki Explosion (skills/acolyte/kiexplosion.cpp, a quest skill): an attack on its target, not knocking it back; if it
  // hits (skill_attack), every other enemy within a cell of the target (SplashArea 1) is knocked 5 cells away from the
  // user (skill_blown, Knockback 5) and stunned at 70 % against its VIT for Duration2 (4.5 s), as the hit lands
  // (skill_additional_effect BF_MISC).
  kiExplosion(u, p, t, mo) {
    const m = p.target, r = B.skillAttack(db, offense(u), defense(m), p.sk, p.lv);
    schedule(r, u, m, mo.at);
    emit('bolts', p.sk.name, m.w, t, mo.at, 1, 0, u.w);
    if (r.damage > 0) W.later.push({ at: mo.at, by: u, to: m, run(at) {
      for (const x of groundFoes(u)) {
        if (x === m || cheb(x.w.cell, m.w.cell) > 1) continue;
        if (!isBoss(x)) field.knockback(x.w, u.w, p.sk.knockback[p.lv - 1] || 0);
        const o = B.stunOdds(statusOf(u), statusOf(x), 70, p.sk.duration2[p.lv - 1] || 0);
        if (!x.stunned && rnd(10000) < o.chance * 100) stun(x, at, o.ms);
      }
    } });
    return false;
  },
  // Ki Translation (skills/acolyte/kitranslation.cpp, a quest skill): the sphere it costs the user (pay) goes to the
  // character it is used on (one of the party, or the user itself), any job's, for Duration1 (10 min), 5 at most
  // (targetFail). No motion (roBrowser IDLE) and no effect (roBrowser none).
  kiTranslation(u, p, t) {
    const m = p.target;
    addSphere(m, t, p.sk.duration[p.lv - 1] || 0, 5);
    emit('success', p.sk.name, m.w, t);
    return false;
  },
  // Snap (skills/acolyte/snap.cpp, MO_BODYRELOCATION): a monster casts it on its target's cell (mobskill_use:
  // a ground skill at MST_TARGET) and is there at once (unit_movepos, stopping its walk and attack); the
  // client slides it there (clif_snap: here SNAP_MS a cell). A character's, on the cell picked (18 cells off at
  // most, a sphere paid: skill_db), goes nowhere on one it cannot stand on or with a wall on the straight line to
  // it (unit_movepos checkpath, path_search_long: no message), and leaves what it was attacking
  snap(u, p, t) {
    const cell = p.target.w.cell;
    if (u.isPc && (!field.open(...cell) || !field.sees(u.w.cell, cell))) return false;
    if (u.isPc) disengage(u);
    u.w.stop();
    u.anim = null;
    u.w.knock([...cell], SNAP_MS);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Provocation (skills/npc/provocation.cpp): the monster shows it on its target and gives the target up
  // (mob_unlocktarget: back to idle, its chase over). On a character it also takes hold as a swordsman's Provoke
  // does (by request: rAthena puts nothing on it) — at Provoke's odds for the row's level (B.STATUS_SKILLS
  // SM_PROVOKE: 70 + 3 × Lv + the monster's level − the character's %), the same status (ATK + 2 + 3 × Lv %, DEF
  // − 5 + 5 × Lv %) for Provoke's Duration1 — and while it lasts its 自動 attacks only that monster (provokedBy).
  giveUp(u, p, t) {
    const m = p.target;
    emit('success', p.sk.name, m.w, t);
    if (m.isPc && !u.isPc) {
      const f = B.STATUS_SKILLS.SM_PROVOKE, sk = db.skills.SM_PROVOKE;
      if (rnd(100) < f.chance(baseStatus(u), baseStatus(m), p.lv)) {
        addStatus(m, sk, p.lv, t, f.status(p.lv));
        m.sc[m.sc.length - 1].by = u;
      }
    }
    if (!u.isPc) unlockTarget(u, t);
    return false;
  },
  // Dispell (skills/mage/dispell.cpp): it shows on the target, and at 50 + 10 × Lv % every status on it ends but
  // those status.yml marks NoDispell (Hiding, Sight, Auto Berserk's Provoke, Hallucination, Cloaking): the
  // buffs, and poison, blindness, silence, confusion, a curse, sleep, a stun, stone, a freeze, Stop, the orc's
  // head too
  dispell(u, p, t) {
    const m = p.target;
    emit('success', p.sk.name, m.w, t);
    if (rnd(100) >= 50 + 10 * p.lv) { if (u.isPc) say(u.w, '技能使用失敗', t); return m !== u.target; }  // (clif_skill_fail)
    if (!m.isPc) unlockTarget(m, t);  // (a monster drops its target: mob_unlocktarget)
    // (not what has NoDispell, nor a song while its player's ground is on it: dispel_song off)
    const keep = s => ['TF_HIDING', 'MG_SIGHT', 'AS_CLOAKING', 'BD_PERFORMING', 'RG_RAID'].includes(s.name) || CHEM_PROTECT[s.name] || B.MOB_STRIPS[s.name] || s.auto || (s.from && W.songs.includes(s.from) && inSong(s.from, m));
    if (m.sc.some(s => !keep(s))) { m.sc = m.sc.filter(keep); if (m.isPc) recalc(m); else mobRecalc(m); }
    const hallucinating = m.hallucinating;
    endAils(m, t);
    if (m.frozen) thaw(m, t);
    if (hallucinating) hallucinate(m, t, hallucinating.until - t);  // (NoDispell)
    return m !== u.target;
  },
  // Cast Cancel (skills/mage/castcancel.cpp): the user's cast stops (unit_skillcastcancel: it may act at once), and the SP
  // of the skill it was casting × (90 − 20 × (Lv − 1)) % goes all the same (status_zap: skill_get_sp's, as it stands)
  castCancel(u, p, t) {
    const k = u.cast;
    u.cast = null;
    u.canAct = t;
    if (!k) return false;
    const sp = Math.trunc((k.sk.sp[k.lv - 1] || 0) * (90 - 20 * (p.lv - 1)) / 100);
    if (sp > 0) { u.sp = Math.max(0, u.sp - sp); tallyOf(u).sp += sp; emit('hp', u); }
    return false;
  },
  // Hocus-Pocus: the skill it gives (abraRoll), used next (abraUse)
  abra(u, p, t) {
    const name = abraRoll(p.lv);
    emit('success', p.sk.name, u.w, t);
    if (name && u.isPc) abraUse(u, name, p.lv, t);
    return false;
  },
  // Mono Cell (monocell.cpp) and Class Change (classchange.cpp): the monster turns into a Poring, or a boss of the
  // CLASSCHANGE group (randomMob), as Metamorphosis does (changeClass: at full HP); not on a boss, nor a character.
  // Turned into a boss, its common statuses end (and Quagmire, Provoke, Classical Pluck).
  classChange(u, p, t) {
    const m = p.target, def = p.sk.name === 'SA_MONOCELL' ? mobDef(1002) : randomMob('CLASSCHANGE');
    if (m.isPc || isBoss(m) || !def || !inSprites(def)) return say(u.w, '技能使用失敗', t), m !== u.target;
    emit('success', p.sk.name, m.w, t);
    if (m.def.id !== def.id) changeClass(m, def, t);
    if (isBoss(m)) { endAils(m, t); for (const n of ['WZ_QUAGMIRE', 'SM_PROVOKE', 'BD_ROKISWEIL']) endStatus(m, n); }
    return m !== u.target;
  },
  // Monster Chant (monsterchant.cpp, mob_once_spawn with −1): a monster of the dead branch's group (randomMob) on the
  // user's cell, aggressive and angry for 60 s (dead_branch_active: SC_MODECHANGE), as one Dead Branch brings
  monsterChant(u, p, t) {
    emit('success', p.sk.name, u.w, t);
    const def = u.isPc && randomMob('BRANCH_OF_DEAD_TREE', true);
    if (!def) return false;
    const m = addMob(def, freeCellNear(u.w.cell, 1) || [...u.w.cell]), was = m.st.mode;
    m.st.mode |= B.MD.AGGRESSIVE | B.MD.CANATTACK | B.MD.CANMOVE | B.MD.ANGRY;
    m.aggressive = true;
    emit('spawn', m, t);
    W.later.push({ at: t + 60000, by: m, to: m, run() { m.st.mode = was; } });
    return false;
  },
  // Grim Reaper (grimreaper.cpp): the target dies (status_kill), no EXP and no items for it (the client's description);
  // not a boss
  grimReaper(u, p, t) {
    const m = p.target;
    if (isBoss(m)) return say(u.w, '技能使用失敗', t), m !== u.target;
    emit('success', p.sk.name, m.w, t);
    if (m.isPc) { m.hp = 0; die(m, t); } else { m.struck = false; killMob(m, t); }
    return m !== u.target;
  },
  // Questioning (questioning.cpp): a question mark over the user's head, nothing else
  question(u, p, t) { emit('emotion', u, ET_QUESTION, t); emit('success', p.sk.name, u.w, t); return false; },
  // Gravity (gravity.cpp): nothing (the client shows the maker's logo)
  gravity(u, p, t) { emit('success', p.sk.name, u.w, t); return false; },
  // Suicide (suicide.cpp): the user dies (status_kill)
  suicide(u, p, t) {
    emit('success', p.sk.name, u.w, t);
    if (u.isPc) { u.hp = 0; die(u, t); } else killMob(u, t);
    return false;
  },
  // Rejuvenation (rejuvenation.cpp): the user's HP and SP full (status_percent_heal 100, 100)
  rejuvenate(u, p, t) {
    const hp = maxHp(u) - u.hp, sp = u.isPc ? u.pc.maxSp - u.sp : 0;
    emit('success', p.sk.name, u.w, t);
    if (hp > 0) healUnit(u, { type: 'heal', damage: hp }, t, u);
    if (sp > 0) { u.sp += sp; emit('heal', u, { type: 'heal', sp: true, damage: sp }, t); }
    emit('hp', u);
    return false;
  },
  // Coma (coma.cpp, SC_COMA): the user's HP and SP 1 (status_zap)
  coma(u, p, t) {
    emit('success', p.sk.name, u.w, t);
    u.hp = Math.min(u.hp, 1);
    if (u.sp != null) u.sp = Math.min(u.sp, 1);
    emit('hp', u);
    return false;
  },
  // Hindsight (skills/mage/hindsight.cpp → skill_autospell): its status for Duration1 with the spell the player picked
  // (p.pick; else the one it had, else the first it may), at half its level (renewal; the learned one if lower, 1 at
  // least); with none of them learned it fails
  autospell(u, p, t) {
    const can = autoSpells(u, p.lv), spell = [p.pick, u.autospellPick, can[0]].find(n => n && can.includes(n));
    if (!spell) return say(u.w, '技能使用失敗', t), false;
    u.autospellPick = spell;
    addStatus(u, p.sk, p.lv, t);
    Object.assign(u.sc.find(x => x.name === 'SA_AUTOSPELL'), { spell, max: autoSpellLv(u, spell, p.lv), wave: W.mobsAt });
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Magic Rod (skills/mage/magicrod.cpp): its status on the user for Duration1 (0.4–1.2 s), nothing shown as it starts
  // (pre-renewal: clif_skill_nodamage only as it takes a spell in, see guard)
  rod(u, p, t) {
    addStatus(u, p.sk, p.lv, t);
    return false;
  },
  // Spell Breaker (skills/mage/spellbreaker.cpp) on one casting: its cast stops (unit_skillcastcancel), it loses the
  // SP of the skill it was casting (skill_get_sp; a monster has none to lose) and the user gets 25 × (Lv − 1) % of that
  // back; at Lv 5 it loses 2% of its MaxHP too (not when that would kill it), the user healed half of it. On a boss
  // (MD_STATUSIMMUNE) 10% only, and none of the HP (by the client's description, as renewal has it)
  spellBreak(u, p, t) {
    const m = p.target, k = m.cast;
    if (!k) return say(u.w, '技能使用失敗', t), m !== u.target;  // (nothing to cancel)
    const boss = isBoss(m);
    if (boss && rnd(100) < 90) return say(u.w, '技能使用失敗', t), m !== u.target;
    emit('success', p.sk.name, m.w, t);
    m.cast = null;
    const sp = k.sk.sp[k.lv - 1] || 0;
    if (m.sp != null) { m.sp = Math.max(0, m.sp - sp); emit('hp', m); }
    const back = Math.trunc(sp * 25 * (p.lv - 1) / 100);
    if (back > 0 && u.isPc) { u.sp = Math.min(u.pc.maxSp, u.sp + back); emit('heal', u, { type: 'heal', sp: true, damage: back }, t); emit('hp', u); }
    const hp = p.lv >= 5 && !boss ? Math.trunc(maxHp(m) / 50) : 0;
    if (hp && hp < m.hp) {
      W.hits.push({ at: t, from: u, to: m, first: true, atk: {}, r: { type: 'hit', damage: hp, steps: [['念咒拆除：MaxHP 的 2%', hp]] } });
      if (Math.trunc(hp / 2) > 0) healUnit(u, { type: 'heal', damage: Math.trunc(hp / 2) }, t, u);
    }
    return m !== u.target;
  },
  // Lex Divina (skills/acolyte/lexdivina.cpp): on one silenced it ends the silence; otherwise a second later
  // (skill_addtimerskill) silence at 100% against its resistance (silenceOdds) — from a character for the skill's
  // Duration2 (30–60 s), from a monster for silence's own time (Silence's DurationLookup, NPC_SILENCEATTACK's
  // Duration2). A silenced monster casts nothing (NoCast).
  lex(u, p, t) {
    const m = p.target;
    emit('success', p.sk.name, m.w, t);
    if (m.silenced) { unsilence(m, t); return false; }
    const ms = (u.isPc ? p.sk.duration2[p.lv - 1] : db.skills.NPC_SILENCEATTACK.duration2[0]) || 0;
    W.later.push({ at: t + 1000, by: u, to: m, run(at) {
      const o = B.silenceOdds(statusOf(u), statusOf(m), 100, ms);
      if (!m.silenced && rnd(10000) < o.chance * 100) silence(m, at, o.ms);
    } });
    return false;
  },
  // Status Recovery (skills/acolyte/statusrecovery.cpp), on an ally or an enemy: one not undead comes out of stone (and
  // turning to it), a freeze, a stun and sleep, and a monster drops its target (mob_unlocktarget: back to idle); an undead
  // one is blinded a second later at 100% against its resistance (skill_addtimerskill → SC_BLIND for Duration2, 18 s)
  recover(u, p, t) {
    const m = p.target;
    emit('success', p.sk.name, m.w, t);
    if (!m.isPc && B.isUndead(statusOf(m))) {
      const ms = p.sk.duration2[p.lv - 1] || 0;
      W.later.push({ at: t + 1000, by: u, to: m, run(at) {
        const o = B.blindOdds(statusOf(u), statusOf(m), 100, ms);
        if (!m.blind && rnd(10000) < o.chance * 100) blindUnit(m, at, o.ms);
      } });
      return m !== u.target;
    }
    if (m.stone) unpetrify(m, t);
    if (m.frozen) thaw(m, t);
    if (m.stunned) unstun(m, t);
    if (m.asleep) wake(m, t);
    if (!m.isPc) unlockTarget(m, t);
    return m !== u.target;
  },
  // Dark Breath (skills/npc/darkbreath.cpp): the monster always shows its anger (clif_emotion ET_ANGER), and half
  // the time nothing more; else its magic (B.SKILLS: a share of the target's HP) lands with the motion
  darkBreath(u, p, t, mo) {
    emit('emotion', u, ET_ANGER, t);
    if (rnd(2) === 0) return false;
    return DOES.attack(u, p, t, mo);
  },
  // Aid Potion from a monster (skills/merchant/aidpotion.cpp): HP back on the one it is used on (B.mobPotion), at once
  // Summon Slave (followersummons.cpp → mob_summonslave): Lv of the row's monsters as its slaves (summonMobs)
  summon(u, p, t) {
    summonMobs(u, p.vals || [], p.lv, t, true);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Metamorphosis (metamorphosis.cpp): it turns into one of the row's monsters, picked at random (mob_random_class),
  // and above Lv 1 brings Lv − 1 more of them along, not as slaves (summonMobs, before it turns)
  morph(u, p, t) {
    const ids = (p.vals || []).filter(mobDef), id = ids.length ? ids[rnd(ids.length)] : 0;
    if (p.lv > 1) summonMobs(u, ids, p.lv - 1, t, false);
    if (id) changeClass(u, mobDef(id), t);
    return false;
  },
  // Emotion (skills/npc/emotion.cpp): emote Val1 over the monster's head. Val2–Val4 would set, add and remove modes
  // for the skill's duration (SC_MODECHANGE), but NPC_EMOTION has none in skill_db, so that never takes (status_get_sc_def
  // gives 0 and status_change_start fails); what stays is that with Val2 set, a monster neither idle nor walking drops
  // its target (mob_unlocktarget, npc_emotion_behavior 0: a chasing Bigfoot gives up now and then) and its aggressive
  // state follows its mode (Angry) again.
  emote(u, p, t) {
    const v = p.vals || [];
    emit('emotion', u, v[0] || 0, t);
    if (!u.isPc && v[1] && !['idle', 'walk'].includes(skillState(u))) unlockTarget(u, t);
    if (!u.isPc) u.aggressive = !!(u.st.mode & B.MD.ANGRY);
    return false;
  },
  // Call Homunculus (skills/merchant/callhomunculus.cpp, hom_call): with none yet, one of the eight made at random
  // (hom_create_request: HM_CLASS_BASE + rnd 0..7), else the one at rest called back; on a free cell next to the user
  callHomun(u, p, t) {
    if (!u.isPc) return false;
    if (!u.homun) { const all = db.homuns || []; u.homun = { id: all[rnd(all.length)].id, state: 'rest' }; emit('homun', u); }
    spawnHomun(u, freeCellNear(u.w.cell, 1) || [...u.w.cell], t);
    return false;
  },
  // Vaporize (skills/merchant/vaporize.cpp, hom_vaporize HOM_ST_REST): the homunculus put to rest, its HP and SP kept
  restHomun(u, p, t) {
    if (u.isPc) homunRest(u, t);
    return false;
  },
  // Homunculus Resurrection (homunculusresurrection.cpp, hom_ressurect): the one down back next to the user at 20 × Lv %
  // of its HP
  reviveHomun(u, p, t) {
    if (u.isPc) spawnHomun(u, freeCellNear(u.w.cell, 1) || [...u.w.cell], t, 20 * p.lv);
    return false;
  },
  // Healing Hands (healingtouch.cpp): its master healed (unit_skilluse_id: the homunculus's Self skills on its master),
  // a Condensed Red Potion from the party's bag (skill_db ItemCost: its master's)
  homunHeal(u, p, t) {
    const m = u.master;
    if (!alive(m)) return false;
    useItem(m, CONDENSED_RED);
    const r = B.heal(db, statusOf(u), statusOf(m), p.sk, p.lv);
    healUnit(m, r, t, u);
    emit('success', p.sk.name, m.w, t);
    return false;
  },
  // Urgent Escape and Amistr Bulwark (avoid.cpp, defense.cpp): the status on its master and on itself
  homunBoth(u, p, t) {
    if (alive(u.master)) { addStatus(u.master, p.sk, p.lv, t); emit('success', p.sk.name, u.master.w, t); }
    addStatus(u, p.sk, p.lv, t);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Mental Change, Bloodlust, Flitting, Accelerated Flight: on itself (B.homunStatus)
  homunSelf(u, p, t) {
    addStatus(u, p.sk, p.lv, t);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Castling (castling.cpp): at 20 × Lv % it and its master trade places, one of the monsters after its master
  // (battle_gettargeted: the first found) now after it; else it fails
  castling(u, p, t) {
    const ma = u.master;
    if (!alive(ma) || rnd(100) >= 20 * p.lv) return say(u.w, '技能使用失敗', t), false;
    const foe = units().find(x => alive(x) && x.side !== ma.side && x.target === ma);
    if (foe) foe.target = u;
    const a = [...u.w.cell], b = [...ma.w.cell];
    u.w.stop(); ma.w.stop();
    u.w.knock(b, SNAP_MS);
    ma.w.knock(a, SNAP_MS);
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // Caprice (caprice.cpp): Cold Bolt, Fire Bolt, Lightning Bolt or Earth Spike at random, at its level, at the target
  caprice(u, p, t, mo) {
    const name = CAPRICE[rnd(CAPRICE.length)], sk = db.skills[name];
    emit('skill', name, u.w, p.target.w, t, mo.at);
    return DOES.attack(u, { ...p, sk }, t, mo);
  },
  // Chaotic Blessings (benedictionofchaos.cpp): a heal at a random level up to its own on itself, its master or a monster
  // after its master (none: itself), by the odds of its level
  chaotic(u, p, t) {
    const roll = 1 + rnd(100), self = CHAOTIC_SELF[p.lv - 1], master = self + CHAOTIC_MASTER[p.lv - 1];
    const to = roll <= self ? u : roll <= master ? u.master : units().find(x => alive(x) && x.side !== u.side && x.target === u.master) || u;
    if (!alive(to)) return false;
    const r = B.heal(db, statusOf(u), statusOf(to), p.sk, 1 + rnd(p.lv));
    healUnit(to, { ...r, type: 'heal' }, t, u);
    emit('success', 'AL_HEAL', to.w, t);
    return false;
  },
  // Bio Explosion (bioexplosion.cpp): its MaxHP's worth (B.SKILLS) on every enemy within its splash (5: 11×11), not in
  // hiding, then down Duration1 (1.5 s) later (skill_addtimerskill); once a map here (by request: no intimacy, which it
  // would leave at its lowest)
  bioExplosion(u, p, t) {
    const area = p.sk.splash[p.lv - 1] || 0, src = offense(u);
    for (const x of units().filter(x => x !== u && alive(x) && inFight(x) && !hidden(x) && x.side !== u.side && field.distance(x.w, u.w) <= area))
      schedule(B.skillAttack(db, src, defense(x), p.sk, p.lv), u, x, t);
    emit('success', p.sk.name, u.w, t);
    W.later.push({ at: t + (p.sk.duration[p.lv - 1] || 0), by: u, to: u, run(when) { if (alive(u)) { u.hp = 0; W.hits = W.hits.filter(h => h.to !== u); mobDies(u, when, true); } } });
    return false;
  },
  // Random Move (skills/npc/randommove.cpp): for MOB_SKILL_INTERVAL × 3 (3 s) it is "trick casting" (m.trick: its
  // end), floating up to 8 cells toward whoever hit it last, to blow up there (by request; rAthena's unit_escape runs
  // off from it), else toward the nearest foe, else about; whatever its mode says of walking (state.can_escape), not
  // stopped by its other skills on the way (chaseSkill)
  randomMove(u, p, t) {
    if (u.isPc) return false;
    u.trick = t + 3 * MOB_SKILL_MS;
    const by = u.hitBy && alive(u.hitBy) && inFight(u.hitBy) && u.hitBy.side !== u.side ? u.hitBy : null;
    const foe = by || livingFoes(u).sort((a, b) => field.distance(u.w, a.w) - field.distance(u.w, b.w))[0];
    if (foe && field.distance(u.w, foe.w) > 1 && field.approach(u.w, foe.w, 1)) u.w.path = u.w.path.slice(0, 8);
    else if (!foe) field.wander(u.w, 8);
    return false;
  },
  // Speed Up (skills/npc/speedup.cpp): trick casting with 700 ms or more left, its walk 250 ms a cell quicker (its base
  // speed, down to MIN_WALK_SPEED); less left, the trick casting ends and its next skill is checked at once
  speedUp(u, p, t) {
    if (u.isPc) return false;
    if (u.trick - t >= 700) {
      u.base.walkSpeed = Math.max(u.base.walkSpeed - 250, MIN_WALK_MS);
      mobRecalc(u);
      if (!u.buffed) u.st.walkSpeed = u.base.walkSpeed;
      u.w.cellMs = u.st.walkSpeed;
    } else { u.trick = 0; u.skillCheck = t; }
    return false;
  },
  // Self Destruction (skills/npc/suicidebombing.cpp): misc damage of the HP it has (B.SKILLS), fire, on everyone within
  // its splash (5 cells; not one in hiding) but itself, knocked 3 cells away; then it dies of it (status_zap). A Marine
  // Sphere one of the party summoned hits only the party's foes and the party's other summons (BCT_ENEMY | BCT_SLAVE,
  // alchemist_summon_setting 8), any other everyone (BCT_ALL): the party, and the other monsters too.
  selfDestruct(u, p, t) {
    if (u.isPc) return false;
    const area = p.sk.splash[p.lv - 1] || 0, knock = p.sk.knockback[p.lv - 1] || 0, src = { ...offense(u), hp: u.hp };
    const mine = !!u.owner, hit = units().filter(x => x !== u && alive(x) && inFight(x) && !hidden(x) && field.distance(x.w, u.w) <= area
      && (!mine || x.side !== u.side || (!!x.owner && x.owner.side === u.side)));
    for (const x of hit) {
      const r = B.skillAttack(db, src, defense(x), p.sk, p.lv);
      if (knock && !isBoss(x)) r.knock = { from: u.w, cells: knock };
      r.posthumous = true;
      schedule(r, u, x, t);
    }
    emit('success', p.sk.name, u.w, t);
    u.hp = 0;
    W.hits = W.hits.filter(h => h.to !== u);
    mobDies(u, t, true);
    return false;
  },
  // Aid Berserk Potion (skills/merchant/aidberserkpotion.cpp): the potion's script on one of the party, SC_ASPDPOTION2
  // for 30 min (as drunk: see drink), failing with the potions given back on one below its EquipLevelMin (85)
  berserkPotion(u, p, t) {
    const m = p.target;
    if (!m.isPc || m.blv < (db.items[BERSERK_POTION].minLevel || 0)) return giveBack(u, BERSERK_POTION, 2), say(u.w, '技能使用失敗', t), false;
    emit('success', p.sk.name, m.w, t);
    if (aspdOn(m) <= 2) {
      m.sc = [...m.sc.filter(s => !/^ASPDPOTION\d$/.test(s.name)), { name: 'ASPDPOTION2', lv: 1, start: t, until: t + ASPD_POTION_MS, effect: null }];
      recalc(m);
    }
    return false;
  },
  potion(u, p, t, mo) {
    const m = p.target;
    if (u.isPc) return throwLater(u, p, m.w, t, mo, at => pitchPotion(u, p, at), m), false;
    healUnit(m, { type: 'heal', damage: B.mobPotion(p.lv, statusOf(m)) }, t);
    emit('success', p.sk.name, m.w, t);
    return false;
  },
  // a heal: restored at once (clif_skill_nodamage); on an undead enemy, magic damage with the motion
  heal(u, p, t, mo) {
    const m = p.target, r = u.last = B.heal(db, statusOf(u), statusOf(m), p.sk, p.lv);
    if (r.type === 'heal' && magicImmune(null, m, p.sk)) { r.damage = 0; r.steps = [['黃金蟲卡：治癒無效', 0]]; }  // (heal.cpp: status_isimmune)
    if (r.type === 'heal') {
      healUnit(m, r, t, u);
      emit('success', p.sk.name, m.w, t);
    } else {
      if (u.sitting) sit(u, false);  // hurting stands the user up (skill_attack)
      schedule(r, u, m, mo.at);
    }
    return m !== u.target;
  },
  // no damage: a status on the target that takes hold (or not) as the skill goes off (STATUS_SKILLS: its odds
  // and what it does)
  status(u, p, t) {
    const m = p.target, f = B.STATUS_SKILLS[p.sk.name];
    if (rnd(100) < f.chance(baseStatus(u), baseStatus(m), p.lv)) {
      addStatus(m, p.sk, p.lv, t, f.status(p.lv));
      emit('success', p.sk.name, m.w, t);
      if (!m.isPc) provoked(m, u);
    } else say(u.w, '技能使用失敗', t);
    return false;
  },
  // Decrease AGI on an enemy: it takes hold at B.decAgiOdds (an AGI cut: B.slowed; and all it does slower: SLOW),
  // ending its Increase AGI; cast again it starts over. It fails with the skill's
  // failure message.
  slow(u, p, t) {
    const m = p.target, o = B.decAgiOdds(statusOf(u), statusOf(m), p.lv, p.sk.duration[p.lv - 1] || 0);
    if (!(rnd(10000) < o.chance * 100)) return say(u.w, '技能使用失敗', t), m !== u.target;
    // (and Two-Hand Quicken and Adrenaline Rush: status.yml EndOnStart)
    for (const n of ['AL_INCAGI', 'KN_TWOHANDQUICKEN', 'BS_ADRENALINE']) endStatus(m, n);
    addStatus(m, p.sk, p.lv, t, null, o.ms);
    emit('success', p.sk.name, m.w, t);
    return m !== u.target;
  },
  // Lex Aeterna (StatusSkillImpl, SC_AETERNA) on an enemy: at once, for Duration1 (10 min), the next attack on it
  // that does damage does twice that (see aeterna); one frozen or turned to stone it fails on (status.yml Fail),
  // and cast again it starts over
  aeterna(u, p, t) {
    const m = p.target;
    if (m.frozen || (m.stone && m.stone.on)) return say(u.w, '技能使用失敗', t), m !== u.target;
    addStatus(m, p.sk, p.lv, t);
    emit('success', p.sk.name, m.w, t);
    return m !== u.target;
  },
  // damage on the target, landing with the motion (SKILLS: ratio and hit rate; magic with magicDamage). A skill
  // that freezes (Frost Diver) rolls for it now; it takes hold as the damage lands (freeze), or fails with the
  // skill's failure message. One with a knockback (Arrow Repel) knocks the target back away from the user as
  // it lands (skill_attack → skill_blown), if it deals damage.
  attack(u, p, t, mo) {
    const m = p.target;
    if (p.sk.name === 'TF_THROWSTONE' && u.stones > 0) u.stones--;  // (see pickStone)
    if (u.sitting) sit(u, false);  // an attacking skill stands the user up (skill_attack)
    // (Throw Spirit Sphere's sphere ATK counts the one it threw: B.SKILLS)
    const src = p.sk.name === 'MO_FINGEROFFENSIVE' && u.isPc ? { ...offense(u), spheres: u.spheres.length + (p.sk.spheres[p.lv - 1] || 0) } : offense(u);
    const r = B.skillAttack(db, src, defense(m), p.sk, p.lv);
    // (a card's cells more on this skill: bAddSkillBlow, skill_get_blewcount + skillblown)
    const knock = (p.sk.knockback[p.lv - 1] || 0) + (u.cardFx ? u.cardFx.skillBlow[p.sk.name] || u.cardFx.skillBlow[p.sk.id] || 0 : 0);
    if (knock) r.knock = { from: u.w, cells: knock, ...SKILL_USE[p.sk.name].knockFirst && { first: true } };
    // (a single-target spell on a character whose cards send magic back, at their %: skill_magic_reflect's
    // magic_damage_return — the damage as worked out, on its caster instead, not knocked back; a boss's too)
    if (m.isPc && m !== u && B.SKILLS[p.sk.name].magic && r.damage > 0 && m.cardFx?.magicReturn && rnd(100) < m.cardFx.magicReturn) {
      schedule({ ...r, knock: undefined, reflected: true }, m, u, mo.at, mo.gap);
      projectiles(u, m, r, mo.at, mo);
      return false;
    }
    const freezes = B.SKILLS[p.sk.name].freeze, stuns = B.SKILLS[p.sk.name].stun;
    if (freezes && r.damage > 0) {
      const o = B.freezeOdds(statusOf(u), statusOf(m), freezes(p.lv), p.sk.duration2[p.lv - 1] || 0);
      r.freeze = rnd(10000) < o.chance * 100 ? o.ms : 0;
    }
    // one that stuns (Bash with Fatal Blow) rolls for it too; it takes hold as the damage lands (stun)
    const stunRate = stuns && r.damage > 0 ? stuns(p.lv, offense(u)) : 0;
    if (stunRate) {
      const o = B.stunOdds(statusOf(u), statusOf(m), stunRate / 100, p.sk.duration2[p.lv - 1] || 0);
      if (rnd(10000) < o.chance * 100) r.stun = o.ms;
    }
    if (r.damage > 0) { rollAils(u, m, p, r); rollBreak(p.sk, p.lv, r); }
    schedule(r, u, m, mo.at, mo.gap);
    projectiles(u, m, r, mo.at, mo);
    emit('bolts', p.sk.name, m.w, t, mo.at, r.hits || 1, Array.isArray(mo.gap) ? mo.gap[1] ?? 0 : mo.gap || hitGap(r), u.w);
    return !!B.SKILLS[p.sk.name].magic && m !== u.target;
  },
  // damage on the target and every other enemy in the cells from it toward the user, the target's and 3 more
  // (Spear Stab, skills/swordman/spearstab.cpp: map_foreachincell on the 4 cells from the target in the direction
  // of the user, map_calc_dir), landing with the motion; each one hit is knocked back its Knockback cells away
  // from the user (skill_blown, after the damage: only the ones it hurts)
  line(u, p, t, mo) {
    const m = p.target, knock = p.sk.knockback[p.lv - 1] || 0, dir = calcDir(m.w.cell, u.w.cell);
    if (u.sitting) sit(u, false);  // an attacking skill stands the user up (skill_attack)
    const cells = [0, 1, 2, 3].map(i => [m.w.cell[0] + DIR_X[dir] * i, m.w.cell[1] + DIR_Y[dir] * i]);
    const hit = [m, ...enemies(u).filter(x => x !== m && alive(x) && cells.some(c => sameCell(c, x.w.cell)))];
    for (const x of hit) {
      const r = B.skillAttack(db, offense(u), defense(x), p.sk, p.lv);
      if (knock) r.knock = { from: u.w, cells: knock };
      schedule(r, u, x, mo.at);
    }
    emit('bolts', p.sk.name, m.w, t, mo.at, 1, MULTIHIT_MS, u.w);
    return false;
  },
  // Brandish Spear: every enemy in the area in front of the user, the target's way (inDir; seen from the user, none
  // past a wall), damaged and knocked back 2 cells away from the user, with the motion. The area is 5 cells wide
  // and, as the client's description has it (pre-renewal's), 2 deep from the user's own row, 3 from Lv 4, 4 from Lv 7
  // and 5 at Lv 10 (renewal: 5 at every level, ActiveInstance), so the target 2 cells off is not hit below Lv 4
  brandish(u, p, t, mo) {
    const m = p.target, dir = calcDir(u.w.cell, m.w.cell), knock = p.sk.knockback[p.lv - 1] || 0;
    const deep = 2 + (p.lv >= 4) + (p.lv >= 7) + (p.lv >= 10);
    if (u.sitting) sit(u, false);  // an attacking skill stands the user up (skill_attack)
    const hit = enemies(u).filter(x => alive(x) && inDir(u.w.cell, dir, 2, deep, x.w.cell) && field.sees(u.w.cell, x.w.cell));
    for (const x of hit) {
      const r = B.skillAttack(db, offense(u), defense(x), p.sk, p.lv);
      if (knock) r.knock = { from: u.w, cells: knock };
      schedule(r, u, x, mo.at);
    }
    emit('bolts', p.sk.name, m.w, t, mo.at, 1, MULTIHIT_MS, u.w);
    return m !== u.target;
  },
  // Charge Attack (skills/swordman/chargeattack.cpp, renewal): the user is at once on the cell next to the target on
  // its own side (skill_check_unit_movepos: only onto a walkable one; the client slides it there, here CHARGE_MS a
  // cell, easing in and out: by request, easeInOutCirc), then, if nothing walls the way from where it stood, hits
  // it, knocking it back 2 cells away. Its swing waits on its first frame until it is there (by request: the
  // slash shows as it strikes, as a normal attack's), at a normal attack's pace (over adelay, not amotion: by
  // request); while it dashes the swing waits on its first frame, and once there it plays on from CHARGE_SWING_FROM
  // (`wait`; by request: from the middle frame there was hardly a swing left), the hit landing with the swing's hit
  // frame, a little sooner. The way it
  // dashes shows (`dash`: dust along it).
  charge(u, p, t, mo) {
    const m = p.target, path = field.sees(u.w.cell, m.w.cell), dir = calcDir(m.w.cell, u.w.cell);
    const to = [m.w.cell[0] + DIR_X[dir], m.w.cell[1] + DIR_Y[dir]];
    if (u.sitting) sit(u, false);  // an attacking skill stands the user up (skill_attack)
    const fd = u.anim.fd = u.pc.adelay / mo.mo.frames, mid = Math.min(CHARGE_SWING_FROM, mo.mo.hf);
    let there = t;
    if (field.open(...to) && !sameCell(to, u.w.cell)) {
      const from = [...u.w.pos];
      u.w.stop();
      u.w.knock(to, CHARGE_MS, easeInOutCirc);
      if (u.w.slide) { there += u.w.slide.dur; emit('dash', p.sk.name, from, u.w.slide.to, t, u.w.slide.dur, u.w.slide.ease); }
    }
    Object.assign(u.anim, { start: there - mid * fd, wait: there });
    const at = there + (mo.mo.hf - mid) * fd;
    if (path) {
      const r = B.skillAttack(db, offense(u), defense(m), p.sk, p.lv);
      r.knock = { from: u.w, cells: p.sk.knockback[p.lv - 1] || 0 };
      schedule(r, u, m, at);
    }
    return false;
  },
  // damage on the target and every other enemy within the splash square around it (SkillImplRecursiveDamageSplash:
  // map_foreachinrange from the target: none past a wall from it, skill_wall_check), landing with the motion, each at its distance from the target (Fire
  // Ball's edge); a SplashSplit skill (`split`: Napalm Beat) shares its MATK among the enemies there, counted as
  // it goes off. What flies to the target comes as the damage lands (bolts: Fire Ball's). One with a knockback
  // (Cart Revolution) pushes each one it hits, away from the user or `knockDir`'s way. How many enemies are there
  // goes to the damage too (Bowling Bash's hits).
  splash(u, p, t, mo) {
    const m = p.target, area = p.sk.splash[p.lv - 1] || 0, use = SKILL_USE[p.sk.name], knock = p.sk.knockback[p.lv - 1] || 0;
    if (u.sitting) sit(u, false);  // an attacking skill stands the user up (skill_attack)
    const hit = enemies(u).filter(x => alive(x) && field.distance(x.w, m.w) <= area && field.sees(m.w.cell, x.w.cell));
    for (const x of hit) {
      const r = B.skillAttack(db, offense(u), defense(x), p.sk, p.lv, undefined, field.distance(x.w, m.w), use.split ? hit.length : 1, hit.length);
      if (knock) r.knock = { from: u.w, dir: use.knockDir, cells: knock };
      schedule(r, u, x, mo.at);
    }
    emit('bolts', p.sk.name, m.w, t, mo.at, 1, MULTIHIT_MS, u.w);
    return m !== u.target;
  },
  // Blitz Beat (skills/archer/blitzbeat.cpp, SkillImplRecursiveDamageSplash): the falcon dives on the target (stage.js
  // 'falcon') and its damage (B.SKILLS) falls on it and every enemy in the 3×3 round it (SplashArea 1) as the falcon gets
  // there (BLITZ_MS + BLITZ_CELL_MS a cell away), Lv hits
  blitz(u, p, t) {
    const at = t + BLITZ_MS + BLITZ_CELL_MS * field.distance(u.w, p.target.w);
    emit('falcon', u, p.target.w, t, at, (p.lv - 1) * MULTIHIT_MS);  // (the hits' span)
    return DOES.splash(u, p, t, { at });
  },
  // Grimtooth (skills/thief/grimtooth.cpp): from hiding (skillFail), which it stays in, 120 + 20 × Lv % on the
  // target and every enemy in the 3×3 round it (SplashArea 1), as the stone spikes running along the ground from
  // the user at GRIM_SPEED get there (roBrowser's EF_GRIMTOOTH trail: 24 cells a second; the user shows no
  // motion); a monster it hits, not status-immune, is slowed by SC_QUAGMIRE for Duration2 (1 s; val1 0: no AGI
  // or DEX off, only the walk: r.quag, see landHits)
  grimtooth(u, p, t) {
    const at = t + field.distance(u.w, p.target.w) * 1000 / GRIM_SPEED, ms = p.sk.duration2[p.lv - 1] || 0;
    const before = W.hits.length, aside = DOES.splash(u, p, t, { at });
    for (const h of W.hits.slice(before)) if (!h.to.isPc && !isBoss(h.to)) h.r = { ...h.r, quag: ms };
    return aside;
  },
  // Back Stab (skills/thief/backstab.cpp, pre-renewal's, by request): from behind the target only (fireSkill: behind), the
  // user where it stands; it comes out of hiding (AllowWhenHidden: it may be used from there) and strikes (B.SKILLS),
  // the target turned round to face it (unit_setdir: map_calc_dir reversed)
  backstab(u, p, t, mo) {
    endStatus(u, 'TF_HIDING');
    field.face(p.target.w, u.w);
    return DOES.attack(u, p, t, mo);
  },
  // Sightless Mind (skills/thief/sightlessmind.cpp): from hiding (skillFail), damage on every enemy within its splash
  // (5×5) round the user (map_foreachinrange: none past a wall), landing with the motion; each one hit may be stunned
  // and blinded (B.SKILLS) and takes SC_RAID for 10 s (r.raid: see raided); then the user is out of hiding
  raid(u, p, t, mo) {
    const area = p.sk.splash[p.lv - 1] || 0;
    for (const m of enemies(u)) {
      const d = field.distance(u.w, m.w);
      if (!alive(m) || d > area || !field.sees(u.w.cell, m.w.cell)) continue;
      const r = B.skillAttack(db, offense(u), defense(m), p.sk, p.lv, undefined, d);
      if (r.damage > 0) { rollAils(u, m, p, r); r.raid = p.lv; }
      schedule(r, u, m, mo.at);
    }
    endStatus(u, 'TF_HIDING');
    return false;
  },
  // Snatch (skills/thief/snatch.cpp): its damage on the target (B.SKILLS); one it hurts, not status-immune (a boss
  // here), at 50 + 5 × Lv + the user's level − its %, 800 ms after it went off (skill_addtimerskill) the user goes to
  // a random free cell of the floor (unit_warp −1, −1) and the target with it, to a cell it can stand on in the 3×3
  // round it (map_search_freecell 1, 1), a monster still after it; with the target down or gone by then, the user
  // goes alone (skill_timerskill: target = src)
  snatch(u, p, t, mo) {
    const m = p.target, before = W.hits.length, aside = DOES.attack(u, p, t, mo);
    if (!W.hits.slice(before).some(h => h.to === m && h.r.damage > 0) || isBoss(m)) return aside;
    if (rnd(100) >= 50 + 5 * p.lv + statusOf(u).lv - statusOf(m).lv) return aside;
    // (自動 keeps at it from now, by request: SELECT.snatched; by report, set only as they landed it Snatched again
    // in the 800 ms before, and flew twice)
    if (u.isPc) u.snatched = m;
    // a character holds its attack motion's 9th frame (without the slash trail) from there on, through the teleport,
    // till it has landed; then it attacks on (by request)
    const a = u.isPc && u.anim, rest = a ? Math.min(SNATCH_FRAME, a.frames - 1) : 0;
    const go = Math.max(a ? a.start + rest * a.fd : t, mo.at) + SNATCH_MS;
    if (a) Object.assign(a, { rest, until: go + SNATCH_LAND_MS });
    W.later.push({ at: go, by: u, to: u, run(when) {
      const along = alive(m) && inFight(m) && field.distance(u.w, m.w) <= AREA_SIZE;  // (check_distance_bl, before it goes)
      const held = u.isPc && u.anim === a;
      teleportUnit(u, when, false, null, held && along, held && { group: a.group, fi: rest });
      if (held) {
        a.until = when + SNATCH_LAND_MS;
        u.next = Math.max(u.next || 0, a.until);
        u.canAct = Math.max(u.canAct || 0, a.until);
      }
      if (!along) return;
      const [x, y] = u.w.cell, near = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (field.open(x + dx, y + dy)) near.push([x + dx, y + dy]);
      teleportUnit(m, when, false, near[rnd(near.length)], true);
    } });
    return aside;
  },
  // The Divests (skills/thief/divest*.cpp, skill_strip_equip) on a monster: at (50 × (Lv + 1) + 2 × (the user's DEX −
  // its DEX)) / 1000 that part's status takes hold (B.MOB_STRIPS, stripMob) for Duration1 + 15 s + max(1, Lv + 500 ×
  // the DEX difference) ms; it fails on a boss (BossResist) and on a character (the sandbox has no PvP)
  strip(u, p, t) {
    const m = p.target, a = statusOf(u).stats.dex, b = statusOf(m).stats.dex;
    if (m.isPc || isBoss(m) || rnd(1000) >= 50 * (p.lv + 1) + 2 * (a - b)) return say(u.w, '技能使用失敗', t), m !== u.target;
    stripMob(m, p.sk.name, t, { lv: p.lv, ms: (p.sk.duration[p.lv - 1] || 0) + 15000 + Math.max(1, p.lv + 500 * (a - b)) });
    emit('success', p.sk.name, m.w, t);
    return m !== u.target;
  },
  // Mug (skills/thief/mug.cpp): on a monster not a boss nor mugged already (skill_check_condition_target: steal_coin_flag),
  // at (10 × its learned Lv + DEX / 2 + LUK / 2 + 2 × (the user's level − the monster's)) / 1000 it takes 8 × to 10 ×
  // the monster's level in zeny, + Lv × its level / 10, into the party's money (W.zeny; the amount said over the
  // user, which the client shows); the monster mugged. Hit or not, the monster turns on the user as from a hit of 0
  // (battle_damage)
  mug(u, p, t) {
    const m = p.target;
    if (m.isPc || isBoss(m) || m.mugged) return say(u.w, '技能使用失敗', t), m !== u.target;
    const s = statusOf(u), lv = statusOf(m).lv;
    const rate = 10 * (u.levels.RG_STEALCOIN || p.lv) + Math.trunc(s.stats.dex / 2) + Math.trunc(s.stats.luk / 2) + 2 * (s.lv - lv);
    if (rnd(1000) >= rate) say(u.w, '技能使用失敗', t);
    else {
      m.mugged = true;
      const zeny = 8 * lv + rnd(2 * lv + 1) + Math.trunc(p.lv * lv / 10);
      purse(u).zeny += zeny;
      emit('success', p.sk.name, m.w, t);
      say(u.w, `偷到 ${zeny.toLocaleString()} z`, t);
    }
    m.attacked.push({ at: t + Math.max(1, m.st.dmotion * slowK(m)), by: u, norm: false });
    m.attacked.sort((a, b) => a.at - b.at);
    return m !== u.target;
  },
  // Close Confine (skills/thief/closeconfine.cpp; SC_CLOSECONFINE2 on the target, SC_CLOSECONFINE on the user): a
  // monster not a boss (BossResist) nor held by one already (Fail) is held for Duration1 (10 s), and the user with it
  // till a second after the last one it holds is let go (val2: a count of them), with FLEE + 50 (renewal: B.BUFF_SKILLS).
  // Neither walks (NoMove, StopWalking: root); both still attack and cast. See confineTick for what ends it.
  confine(u, p, t) {
    const m = p.target;
    if (m.isPc || isBoss(m) || has(m, 'RG_CLOSECONFINE2')) return say(u.w, '技能使用失敗', t), false;
    const ms = p.sk.duration[p.lv - 1] || 0, own = u.sc.find(s => s.name === 'RG_CLOSECONFINE' && t < s.until);
    m.sc = [...m.sc.filter(s => s.name !== 'RG_CLOSECONFINE2'), { name: 'RG_CLOSECONFINE2', lv: p.lv, start: t, until: t + ms, holder: u, cell: [...m.w.cell] }];
    addStatus(u, p.sk, p.lv, t, null, Math.max(own ? own.until - t : 0, ms + 1000));
    u.sc[u.sc.length - 1].cell = [...u.w.cell];
    for (const x of [u, m]) { x.w.stop(); confineTick(x, t); }
    return false;
  },
  // Stone Curse (skills/mage/stonecurse.cpp): on a status-immune target (Boss class here) it fails; on one being
  // petrified or petrified already it ends that instead and fails (status.yml StoneWait: EndReturn), and so on
  // one frozen or stunned (Fail); otherwise SC_STONEWAIT takes hold at B.stoneOdds (see petrify) or the skill
  // fails. A character's Red Gemstone is used up, but not when it fails at Lv 6 or more past the Boss check
  // (skills/mage/stonecurse.cpp: SKILL_NOCONSUME_REQ). A monster it is cast at does not turn on the caster for it
  // (a skill without damage: mobskill_event only).
  stone(u, p, t) {
    const m = p.target, gem = () => { if (u.isPc) useItem(u, RED_GEM); }, fail = () => { if (p.lv <= 5) gem(); say(u.w, '技能使用失敗', t); };
    if (isBoss(m)) return gem(), say(u.w, '技能使用失敗', t), false;
    if (m.stone) return unpetrify(m, t), fail(), false;
    if (m.frozen || m.stunned) return fail(), false;
    const o = B.stoneOdds(statusOf(u), statusOf(m), p.lv, p.sk.duration[p.lv - 1] || 0, p.sk.duration2[p.lv - 1] || 0);
    if (!(rnd(10000) < o.chance * 100)) return fail(), false;
    gem();
    petrify(m, t, o.wait, o.ms);
    emit('success', p.sk.name, m.w, t);
    return false;
  },
  // damage on every enemy within the splash area around the user (Chebyshev cells, as
  // map_foreachinshootrange: none past a wall from the user), each at its distance, landing with the motion, and knocking the ones it hits back
  area(u, p, t, mo) {
    if (u.sitting) sit(u, false);  // an attacking skill stands the user up (skill_attack)
    const area = p.sk.splash[p.lv - 1] || 0, knock = p.sk.knockback[p.lv - 1] || 0;
    const freezes = B.SKILLS[p.sk.name].freeze;
    for (const m of enemies(u)) {
      const d = field.distance(u.w, m.w);
      if (!alive(m) || d > area || !field.sees(u.w.cell, m.w.cell)) continue;
      // Frost Nova: not on the user's own cell (skill_attack_area), nor on one frozen already (status_check_skilluse)
      if (freezes && (m.frozen || sameCell(m.w.cell, u.w.cell) || onLP(...m.w.cell))) continue;  // (Frost Nova: nor on Land Protector)
      const r = B.skillAttack(db, offense(u), defense(m), p.sk, p.lv, undefined, d);
      if (knock) r.knock = { from: u.w, cells: knock };
      // each one hit freezes at its rate against its resistance as the damage lands (no failure message: Frost Diver's alone)
      if (freezes && r.damage > 0) {
        const o = B.freezeOdds(statusOf(u), statusOf(m), freezes(p.lv, offense(u)), p.sk.duration2[p.lv - 1] || 0);
        if (rnd(10000) < o.chance * 100) r.freeze = o.ms;
      }
      schedule(r, u, m, mo.at);
    }
    return false;
  },
  // no damage: a status on the target (SKILL_USE's `ail`), rolled at 20 × Lv % against its resistance (AIL_ODDS)
  // for Duration2: Lick's stun (skills/npc/lick.cpp: it first takes 100 SP, status_zap), Hallucination
  // (hallucination.cpp: nothing resists it); Grampus Morph's orc head (a StatusSkillImpl: 100%, Duration1). One
  // the target has already fails (ailOn).
  inflict(u, p, t) {
    const m = p.target, kind = SKILL_USE[p.sk.name].ail;
    if (p.sk.name === 'NPC_LICK' && m.sp != null) { m.sp = Math.max(0, m.sp - 100); emit('hp', m); }
    const orc = p.sk.name === 'SA_REVERSEORCISH', ms = p.sk[orc ? 'duration' : 'duration2'][p.lv - 1] || 0;
    const o = AIL_ODDS[kind](statusOf(u), statusOf(m), orc ? 100 : 20 * p.lv, ms);
    if (ailOn(m, kind) || !(rnd(10000) < o.chance * 100)) return false;
    AIL_START[kind](m, t, o.ms);
    emit('success', p.sk.name, m.w, t);
    return false;
  },
  // Stop (skills/npc/stop.cpp): SC_STOP on the target at 100% for Duration1, nothing resisting it, and then on
  // the user too, the two held together (stopUnit)
  stop(u, p, t) {
    const m = p.target, ms = p.sk.duration[p.lv - 1] || 0;
    if (m.stopped) unstop(m, t);
    if (u.stopped) unstop(u, t);
    stopUnit(m, u, t, ms);
    stopUnit(u, m, t, ms);
    emit('success', p.sk.name, m.w, t);
    return false;
  },
  // a status on every enemy within the splash square around the user (Wide Silence, Wide Confusion:
  // skills/npc/widesilence.cpp → map_foreachinallrange), at once: each rolls at 100% against its resistance
  // (AIL_ODDS) for Duration2. Confusion on one confused already ends it instead (status.yml EndReturn).
  wide(u, p, t) {
    const kind = SKILL_USE[p.sk.name].ail, area = p.sk.splash[p.lv - 1] || 0;
    for (const m of enemies(u)) {
      if (!alive(m) || field.distance(u.w, m.w) > area) continue;
      if (kind === 'confuse' && m.confused) { unconfuse(m, t); continue; }
      if (ailOn(m, kind)) continue;
      const o = AIL_ODDS[kind](statusOf(u), statusOf(m), 100, p.sk.duration2[p.lv - 1] || 0);
      if (rnd(10000) < o.chance * 100) AIL_START[kind](m, t, o.ms);
    }
    emit('success', p.sk.name, u.w, t);
    return false;
  },
  // damage on every enemy within the splash square around the target cell (skill_castend_pos2 →
  // map_foreachinarea: none past a wall from that cell, the area's middle), landing with the motion, each knocked back away from that cell (arrow_shower_knockback
  // yes: skill_blown from the cell; one standing on it goes back against its own facing). What comes down on
  // the area comes as the damage lands ('rain'): Arrow Shower's arrows; Thunderstorm's bolts, one a hit.
  // (Thunderstorm is a Dummyskill unit lasting 100 ms with an interval of 1000: it hits what is in its 5×5
  // once, as it is set down.)
  rain(u, p, t, mo) {
    if (u.sitting) sit(u, false);  // an attacking skill stands the user up (skill_attack)
    const at = p.target.w, [x, y] = at.cell, knock = p.sk.knockback[p.lv - 1] || 0;
    const area = areaOf(p.sk, p.lv), use = SKILL_USE[p.sk.name];
    for (const m of use.hidden ? units().filter(x => x.side !== u.side && (sees(u, x) || !cloaked(x))) : enemies(u)) {
      if (!alive(m) || field.distance(m.w, at) > area || !field.sees([x, y], m.w.cell)) continue;
      if (B.SKILLS[p.sk.name].magic && onLP(...m.w.cell)) continue;  // (magic falling on an area: not on Land Protector, placeField)
      const r = B.skillAttack(db, offense(u), defense(m), p.sk, p.lv);
      if (knock) r.knock = { from: sameCell(m.w.cell, [x, y]) ? null : at, cells: knock };
      schedule(r, u, m, mo.at);
    }
    emit('rain', p.sk.name, u.w, at, mo.at, area, p.sk.hits[p.lv - 1] || 1, SKILL_USE[p.sk.name].gap || MULTIHIT_MS);
    return true;
  },
  // Meteor Storm (castendPos2): Duration1 / its Interval (1 s) meteors, the i-th on a cell picked at random as it goes
  // off in the 7×7 (its splash, 3) round the target cell, none on a wall (skill_unitsetting); each its unit of
  // Interval × i ms, which a second before it ends shows the meteor falling there (clif_skill_poseffect: the i-th
  // (i − 1) s after) and then ends METEOR_FALL_MS on ("all meteors hit 700ms after the effect starts"), hitting every
  // enemy within its Range (3: the 7×7) in sight of it (PathCheck), each on its own (meteorHits). None fall once their
  // user is down or gone (W.later).
  meteor(u, p, t) {
    if (u.sitting) sit(u, false);
    const [x0, y0] = p.target.w.cell, area = p.sk.splash[p.lv - 1] || 0, n = Math.trunc((p.sk.duration[p.lv - 1] || 0) / METEOR_MS);
    for (let i = 0; i < n; i++) {
      const cell = [x0 - area + rnd(area * 2 + 1), y0 - area + rnd(area * 2 + 1)];
      if (!field.open(...cell)) continue;
      W.later.push({ at: t + i * METEOR_MS, by: u, to: u, run(at) {
        emit('success', p.sk.name, field.spot(...cell), at);
        W.later.push({ at: at + METEOR_FALL_MS, by: u, to: u, run(at) { meteorHits(u, p, cell, at); } });
      } });
    }
    return true;
  },
  // Lord of Vermilion (castendPos2: a UNT_DUMMYSKILL unit of layout 6, 13×13 cells, each of Range 1, Interval 1250,
  // for Duration1, 1 s): the unit timer's first pass (UNIT_MS on) hits every enemy within a cell of one of its cells
  // (the 15×15) in sight of it (PathCheck: from the nearest), once (NoOverlap: one tickset for the group; its next
  // hit, 1250 ms on, is past its end). One walking in during that second is not hit here.
  vermilion(u, p, t) {
    if (u.sitting) sit(u, false);
    const [x0, y0] = p.target.w.cell;
    W.later.push({ at: t + UNIT_MS, by: u, to: u, run(at) {
      for (const m of groundFoes(u)) {
        const [x, y] = m.w.cell, near = [Math.max(x0 - VERMILION_LAYOUT, Math.min(x0 + VERMILION_LAYOUT, x)), Math.max(y0 - VERMILION_LAYOUT, Math.min(y0 + VERMILION_LAYOUT, y))];
        if (cheb(near, m.w.cell) > 1 || !field.sees(near, m.w.cell) || onLP(...m.w.cell)) continue;
        const r = B.skillAttack(db, offense(u), defense(m), p.sk, p.lv);
        if (r.damage > 0) rollAils(u, m, p, r);
        schedule(r, u, m, at);
      }
    } });
    return true;
  },
  // Water Ball (castendDamageId: UNT_DUMMYSKILL cells round the user, Layout 0, 1 or 2 by level — a monster's at
  // Lv 10 or more the 9×9, skill_get_unit_layout — then skill_addtimerskill): every TIMERSKILL_INTERVAL one cell is
  // spent, from the one at once, and every one after the first throws a ball, so one ball a cell, the first
  // WATERBALL_MS on and the last one with the last cell gone. A ball hits the target, if nothing walls it off from the
  // user however far (path_search_long), landing the user's amotion later (battle_delay_damage). While cells are
  // left the user cannot walk (unit_set_walkdelay) nor act till its amotion after the ball (canact_tick). The
  // balls stop with the target down or the user. A monster's cells are all of them; a character's only the water
  // ones (skill_unitsetting: map water — the floor here has none — or a Deluge's cell, Suiton not being here), each
  // Deluge cell taken up by its ball's (skill_cell_overlap: the field loses it, drinkDeluge); it can only cast at all
  // standing in one (skillFail, ST_WATER). By request: everywhere, it was too strong.
  waterball(u, p, t) {
    if (u.sitting) sit(u, false);
    const m = p.target, size = !u.isPc && p.lv >= 10 ? 4 : p.lv >= 4 ? 2 : p.lv >= 2 ? 1 : 0;
    const n = u.isPc ? drinkDeluge(u.w.cell, size, t) : (2 * size + 1) ** 2;
    if (!n) return say(u.w, '技能使用失敗', t), m !== u.target;
    holdWalk(u, t + WATERBALL_MS);
    for (let i = 1; i <= n; i++) W.later.push({ at: t + i * WATERBALL_MS, by: u, to: m, run(at) {
      const pace = u.isPc ? u.pc.amotion : u.st.amotion * slowK(u);
      if (i < n) holdWalk(u, at + WATERBALL_MS);
      if (u.isPc) { u.canAct = Math.max(u.canAct, at + pace); u.next = Math.max(u.next || 0, u.canAct); }
      else u.nextAttack = Math.max(u.nextAttack || 0, at + pace);
      if (!field.sees(u.w.cell, m.w.cell)) return;
      const r = B.skillAttack(db, offense(u), defense(m), p.sk, p.lv);
      schedule(r, u, m, at + pace);
      emit('bolts', p.sk.name, m.w, at, at + pace, 1, 0, u.w);
    } });
    return m !== u.target;
  },
  // Teleport: the user goes to a random free cell of the floor (teleportUnit; Lv 2's save point is not there
  // to choose, so both levels do the same)
  teleport(u, p, t) {
    teleportUnit(u, t, true);
    return true;
  },
  // nothing (Aqua Benedicta: rAthena turns an Empty Bottle into Holy Water standing in water; the sandbox has
  // neither water nor items, so it goes off anywhere and only costs its SP, by request. Item Appraisal: rAthena
  // lists the unidentified items to pick one; the sandbox has no items yet, so it only costs its SP, by request)
  none() { return false; },
  // Vending (skills/merchant/vending.cpp → clif_openvendingreq, vending_openvending): the character opens a shop
  // where it stands and is vending (sd->state.vending) until it closes it: it stops what it was doing and can
  // neither walk (unit_can_move), sit, attack nor use another skill (pc_cant_act2), whatever 自動 says. It is
  // still a target, and dying does not close the shop. The sandbox has no items: nothing is put up for sale and
  // nobody buys (by request), the shop is its title (VEND_TITLE) over the character. The client closes it from
  // the shop window (CZ_REQ_CLOSESTORE); here Vending used again closes it, for nothing (see skillFail, pay).
  vend(u, p, t) {
    if (u.vending) { u.vending = null; emit('vending', u); return false; }
    disengage(u);
    u.selfPending = null;
    u.w.stop();
    u.vending = { title: VEND_TITLE, since: t };
    emit('vending', u);
    return false;
  },
  // something on the ground, on the target cell (SKILL_USE's `place`)
  ground(u, p, t, mo) {
    SKILL_USE[p.sk.name].place(u, p, p.target.w.cell, t, mo);
    return true;
  },
  // B.S. Sacramenti on a cell: every character in the 3×3 round it (the splash; map_foreachinallarea BL_PC, either side) that
  // is not unholy gets its status (B.BUFF_SKILLS.PR_BENEDICTIO), and every unholy enemy there takes its damage (B.SKILLS
  // .PR_BENEDICTIO) with the motion. Its partner (benedictioPartners) pays 10 SP.
  benedictio(u, p, t, mo) {
    for (const x of benedictioPartners(u).slice(0, BENEDICTIO_PARTNERS)) { x.sp -= 10; emit('hp', x); }
    const at = p.target.w.cell, area = p.sk.splash[p.lv - 1] || 0;
    for (const m of allChars()) {
      if (m.dead != null || cheb(m.w.cell, at) > area || B.unholy(statusOf(m))) continue;
      addStatus(m, p.sk, p.lv, t);
      emit('success', p.sk.name, m.w, t);
    }
    for (const m of enemies(u)) {
      if (!alive(m) || cheb(m.w.cell, at) > area || !B.unholy(statusOf(m))) continue;
      if (u.sitting) sit(u, false);
      schedule(B.skillAttack(db, offense(u), defense(m), p.sk, p.lv), u, m, mo.at);
    }
    return true;
  },
  // Resurrection (skills/acolyte/resurrection.cpp): a character down gets up with B.resurrectHp % of its MaxHP (at least 1),
  // its SP as it was (status_revive); an undead monster takes Turn Undead's damage (attack)
  resurrect(u, p, t, mo) {
    const m = p.target;
    if (!m.isPc) return DOES.attack(u, p, t, mo);
    if (m.dead == null) return false;
    m.dead = null;
    m.hp = Math.max(1, Math.trunc(m.pc.maxHp * B.resurrectHp(p.lv) / 100));
    if (m.cardFx?.fullRecover) { m.hp = m.pc.maxHp; m.sp = m.pc.maxSp; }  // (a card's bRestartFullRecover)
    emit('hp', m);
    emit('success', p.sk.name, m.w, t);
    return false;
  },
  // Redemptio (skills/acolyte/redemptio.cpp, renewal): every party member down within 14 cells gets up as by Resurrection
  // Lv 3 (50% of its MaxHP, shown as Resurrection: clif_skill_nodamage ALL_RESURRECTION), and the user is left with 1 HP
  // (renewal: no EXP lost, its SP not emptied beyond the 800 paid); with no one down it fails (skillFail), unpaid here
  redemptio(u, p, t) {
    for (const m of redeemable(u)) {
      m.dead = null;
      m.hp = Math.max(1, Math.trunc(m.pc.maxHp * B.resurrectHp(3) / 100));
      if (m.cardFx?.fullRecover) { m.hp = m.pc.maxHp; m.sp = m.pc.maxSp; }
      emit('hp', m);
      emit('success', 'ALL_RESURRECTION', m.w, t);
    }
    u.hp = 1;
    emit('hp', u);
    return false;
  },
  // Fiber Lock: a web on its target's cell (placeWeb)
  web(u, p, t) {
    placeWeb(u, p, p.target.w.cell, t);
    return false;
  },
};
// Unit u's motion for skill sk going off at time t (on `target`, a unit or a ground spot, or null): a
// character's is its attack motion, or with `pose` the casting pose, over its amotion; a monster's its attack
// motion, turned to the target. Returns when the skill's damage starts landing (at), and for a character the
// motion (mo: frames, release, hf) and its frame time (fd).
// the crusader line (by request): every skill of theirs in the casting pose's 2nd to 6th frames (CAST_SEQ) over its
// motion, one striking on its hit frame striking on the 6th (`noTrail`: without the weapon's slash trail, which a sword's
// sprite draws in the casting pose too — a swing, by report)
const CRUSADER_LINE = new Set(['크루세이더', '팔라딘', '가드', 'imperial_guard']), CAST_SEQ = [1, 2, 3, 4, 5];
function skillMotion(u, sk, t, target, group = null) {
  if (!u.isPc) {
    const k = slowK(u), { n, delay: d, hf } = motion.mobAttack(u), delay = d * k * aspdK(u);
    if (target) field.face(u.w, target.w);
    u.anim = { grp: 2, start: t, fd: delay, end: t + n * delay };
    return { at: t + hitDelay(sk.name, u.st.amotion * k, hf * delay) };
  }
  const cru = CRUSADER_LINE.has(u.look.job);
  group = cru ? 12 : group ?? motion.attackGroup(u);
  let use = SKILL_USE[sk.name] || {};
  if (cru) use = { ...use, seq: use.seq ?? CAST_SEQ, hold: null, rush: false };
  const mo = motion.pc(u, group);
  // (`ownPace`: the motion at the act file's own pace, as roBrowser plays a skill's, not stretched over the attack motion)
  const pace = use.pace ?? (use.ownPace && mo.delay ? mo.delay * mo.frames : u.pc.amotion), fd = pace / (use.seq ? use.seq.length : mo.frames);
  // (a rush: as many quick swings as its hits take, on each one's strike frames — its hit frame for a motion
  // without them — as offsets from the first)
  const strikes = use.rush && group === motion.attackGroup(u) ? (use.strikes || []).filter(f => f < mo.frames) : null;
  if (strikes && !strikes.length) strikes.push(mo.hf);
  const rush = strikes && { n: Math.ceil(Math.abs(sk.hits[0] || 1) / strikes.length), fd: use.rushFd };
  u.anim = { start: t, group, frames: use.seq ? use.seq.length : mo.frames, fd, target, skill: true, ...rush && { rush }, ...isSong(sk.name) && { song: true },
             ...use.hold != null && { hold: Math.min(use.hold, mo.frames - 1) }, ...use.seq && { seq: use.seq.map(f => Math.min(f, mo.frames - 1)) }, ...use.bare && { bare: true }, ...cru && { noTrail: true } };
  u.alert = true;
  if (rush) {
    const at = Array.from({ length: rush.n }, (_, i) => strikes.map(f => (i * mo.frames + f) * rush.fd)).flat();
    return { at: t + mo.frames * fd + at[0], gap: at.map(x => x - at[0]), mo, fd };
  }
  return { at: t + hitDelay(sk.name, pace, (cru ? use.seq.length - 1 : mo.hf) * fd), mo, fd };
}
// after unit u's skill p (on target, a unit or a ground spot, or null) went off at t: a character's next skill
// waits out the skill's delay from now and the act delay from the skill's start (B.castDelays; p.start: when
// its cast began), its normal attack the attack delay from that start, and the skill its cooldown; it goes back
// to what it was attacking if the skill was `aside`. A monster's next attack waits out its attack delay.
function afterSkill(u, p, t, target, aside) {
  if (!u.isPc) return mobAttacked(u, target && !target.ground ? target : null, t);
  // (Hindsight's spell, `auto`: no skill delay after it, the attack going on as it was: by request, not rAthena's
  // canact_tick, under which it stopped for the delay)
  if (p.auto != null) return;
  if (aside) setRunning(u, false);
  const t0 = p.start ?? t, d = B.castDelays(u.pc, jobFor(u).maxAspd);
  u.canAct = Math.max(t + B.skillDelay(p.sk, p.lv, u.pc), t0 + d.act);
  u.ready = Math.max(u.ready, t0 + d.attack);
  u.cooldown[p.sk.name] = t + (SKILL_USE[p.sk.name]?.noCooldown ? 0 : p.sk.cooldown[p.lv - 1] || 0);
  u.next = Math.max(u.next || 0, u.canAct, u.ready);  // the auto attack goes on after the skill
  // (a swing that waits for its user to get there, Charge Attack's, or a rush, Sonic Blow's: the next attack not
  // before it has played out, or it would start over the swing: by report)
  if (u.anim && (u.anim.wait != null || u.anim.rush)) u.next = Math.max(u.next, animEnd(u.anim));
  if (u.anim && (SKILL_USE[p.sk.name] || {}).holdDelay) u.anim.until = Math.max(u.anim.until ?? 0, u.canAct);
  // (`holdFor`: so long after the motion has played)
  if (u.anim && (SKILL_USE[p.sk.name] || {}).holdFor) u.anim.until = Math.max(u.anim.until ?? 0, animEnd(u.anim) + SKILL_USE[p.sk.name].holdFor);
}
// when a motion of the character's is over (a double attack starts over at frame `restart`; a `rush` swings n times
// more, rush.fd ms a frame)
export const animEnd = a => Math.max(a.start + ((a.restart ?? 0) + a.frames) * a.fd + (a.rush ? a.rush.n * a.frames * a.rush.fd : 0), a.until ?? 0);
// character c's normal attack in progress stops: its motion and its hit that has not landed yet (an arrow
// already let go flies on and hits)
function cancelSwing(c) {
  dropUnshot(c);
  c.anim = null;
  W.hits = W.hits.filter(h => h.from !== c || h.skill || W.shots.some(a => a.by === c && a.at === h.at));
}
// an arrow still on c's string is not shot: it goes, and its hit with it (a skill's arrows stay: the skill
// went off, so its hits land whatever the user does next)
function dropUnshot(c) {
  const gone = W.shots.filter(a => a.by === c && !a.skill && W.t < a.t0);
  if (!gone.length) return;
  W.shots = W.shots.filter(a => !gone.includes(a));
  W.hits = W.hits.filter(h => h.from !== c || h.skill || !gone.some(a => a.at === h.at));
}
// how many hits an attack lands (a miss is one), and how far apart they come
const hitCount = r => r.damage > 0 ? r.hits || 1 : 1;
const hitGap = r => (r.skill && SKILL_USE[r.skill.name] && SKILL_USE[r.skill.name].gap) || MULTIHIT_MS;
// queue an attack's hits to land from time `at` on (a multi-hit skill: one per MULTIHIT_MS, or `gap` ms
// apart, each its share)
// (gap: an array instead, each hit's ms after the first: a rush's, see skillMotion)
function schedule(r, from, to, at, gap = null) {
  r = coatPoison(raided(aeterna(autoGuard(r, to), to), to), from, to);
  // (a normal attack's left hand, r.left, lands leftMs after the right's last hit, a hit of its own)
  const n = hitCount(r), left = r.damage > 0 && r.left || 0, main = r.damage - left, per = Math.trunc(main / n);
  // the hits of a multi-hit attack share one `combo` (sandbox.js shows their running total on it); a single hit
  // and its left hand's one too, `apart` (each its own number, as roBrowser shows them: only so that the
  // monster it kills holds on for the second, see landHits)
  const combo = n + (left ? 1 : 0) > 1 ? { n: n + (left ? 1 : 0), ...n === 1 && { apart: true } } : null;
  const atk = { damage: r.damage };  // (atk: what the attack's hits share, see guard)
  gap = gap || hitGap(r);
  // (a knockback comes with the last hit: skill_attack knocks back once, after the damage; `first`, with the first)
  const knockAt = r.knock?.first ? 0 : n - 1;
  for (let i = 0; i < n; i++)
    W.hits.push({ at: at + (Array.isArray(gap) ? gap[Math.min(i, gap.length - 1)] : i * gap), from, to, skill: r.skill, first: i === 0, k: i, combo, atk,
                  r: { ...r, damage: i === n - 1 ? main - per * (n - 1) : per, knock: i === knockAt ? r.knock : undefined } });
  if (left) W.hits.push({ at: at + (n - 1) * gap + leftMs(from), from, to, first: false, combo, atk, r: { ...r, damage: left, steps: r.leftSteps } });
}
// a meteor of unit u's Meteor Storm p landing on `cell` (UNT_DUMMYSKILL's onplace as it ends): its damage, with its stun,
// on every enemy within its unit's Range in sight of the cell
// (Lord of Vermilion's unit, skill_db Unit Layout: 6)
const VERMILION_LAYOUT = 6;
// a Water Ball's cells spent one a while (skill.hpp TIMERSKILL_INTERVAL)
const WATERBALL_MS = 150;
// (skill_db Unit: Interval 1000, Range 3)
const METEOR_MS = 1000, METEOR_FALL_MS = 700, METEOR_RANGE = 3;
function meteorHits(u, p, cell, t) {
  for (const m of groundFoes(u)) {
    if (cheb(m.w.cell, cell) > METEOR_RANGE || !field.sees(cell, m.w.cell) || onLP(...m.w.cell)) continue;
    const r = B.skillAttack(db, offense(u), defense(m), p.sk, p.lv);
    if (r.damage > 0) rollAils(u, m, p, r);
    schedule(r, u, m, t);
  }
}
// Grand Cross's cells round its user (skill_unit_layout: 29, the cross 9 cells each way and the diamond in its middle) and
// its unit's Interval
const GX_CELLS = [[0, -4], [0, -3], [-1, -2], [0, -2], [1, -2], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1],
  [-4, 0], [-3, 0], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [-2, 1], [-1, 1], [0, 1], [1, 1], [2, 1],
  [-1, 2], [0, 2], [1, 2], [0, 3], [0, 4]];
const GX_MS = 300;
// a turn of Grand Cross p by unit u (skill_unit_onplace_timer): every enemy on a cell of it with hits left takes one, the
// cell's hits one fewer for each; an undead or demon monster hit is blinded at 100 % against its resistance for Duration2
// (grandcross.cpp applyAdditionalEffects: not a player)
function gxWave(u, p, cells, t) {
  for (const c of cells) {
    if (c.left <= 0) continue;
    for (const m of groundFoes(u).filter(x => sameCell(x.w.cell, c.cell))) {
      c.left--;
      const r = B.skillAttack(db, offense(u), defense(m), p.sk, p.lv), st = statusOf(m);
      if (r.damage > 0 && !m.isPc && !m.blind && (B.isUndead(st) || st.race === 'Demon')) {
        const o = B.blindOdds(statusOf(u), st, 100, p.sk.duration2[p.lv - 1] || 0);
        if (rnd(10000) < o.chance * 100) r.blind = o.ms;
      }
      schedule(r, u, m, t);
    }
  }
}
// Sacrifice: the statuses of its crusader's a character under it has too (status_change_start SC_DEVOTION)
const DEVOTION_SHARES = ['CR_AUTOGUARD', 'CR_DEFENDER', 'CR_REFLECTSHIELD', 'SM_ENDURE'];
// character c's Sacrifice ends, and what it had of its crusader's with it (EndOnEnd)
function endDevotion(c) {
  if (!c.sc.some(s => s.name === 'CR_DEVOTION' || s.devoted)) return;
  c.sc = c.sc.filter(s => s.name !== 'CR_DEVOTION' && !s.devoted);
  recalc(c);
}
// the crusader taking unit u's damage under its Sacrifice, or null; one down, gone or past the skill's range of u ends
// it as the hit lands (battle_delay_damage: check_distance_bl with val3), u taking that hit
function devotedTo(u) {
  const s = u.isPc && u.sc.find(x => x.name === 'CR_DEVOTION' && W.t < x.until);
  if (!s) return null;
  if (s.by.dead != null || !inFight(s.by) || field.distance(u.w, s.by.w) > s.range) { endDevotion(u); return null; }
  return s.by;
}
// crusader c takes `damage` for one under its Sacrifice, hit by `by` (battle_fix_damage: as it is, nothing of c's own
// taking any of it off), standing up if sitting, its number shown on it (clif_damage)
function sacrifice(c, damage, by, t) {
  if (c.sitting) sit(c, false);
  const r = { type: 'hit', damage, devotion: true };
  emit('hit', { from: c, to: c, r, first: true, atk: {} }, t);
  hurt(c, r, t, true, by);
}
// what was set to go off a while after a skill (W.later) and whose time has come, unless its user or the one it
// is on has died or gone (skill_timerskill: the user must still be there)
function laterTurn(t) {
  if (!W.later.length) return;
  const due = W.later.filter(x => x.at <= t);
  W.later = W.later.filter(x => x.at > t);
  for (const x of due) if (alive(x.by) && inFight(x.by) && alive(x.to) && inFight(x.to)) x.run(t);
}
// Enchant Poison on unit u (SC_ENCPOISON: skill_additional_effect): a weapon attack of its that does damage (a
// normal one or a weapon skill; not magic, nor misc) tries to poison m at B.BUFF_SKILLS' rate against its VIT (see
// poisonOdds), once for the attack, for the skill's Duration2 — unless the attack poisons it already (Envenom)
function coatPoison(r, u, m) {
  const s = u.sc.find(x => x.name === 'AS_ENCHANTPOISON' && W.t < x.until), f = r.skill && B.SKILLS[r.skill.name];
  if (!s || !(r.damage > 0) || r.poison || m.poison || (f && (f.magic || f.misc))) return r;
  const sk = db.skills.AS_ENCHANTPOISON, o = B.poisonOdds(statusOf(u), statusOf(m), B.BUFF_SKILLS.AS_ENCHANTPOISON.poison(s.lv), sk.duration2[s.lv - 1]);
  return rnd(10000) < o.chance * 100 ? { ...r, poison: o.ms } : r;
}
// Auto Guard (battle_calc_damage, SC_AUTOGUARD) on unit u: a weapon attack that hits (a normal one or a weapon
// skill; not magic, nor misc as Stone Fling) is blocked at B.guardRate %, missing (ATK_MISS) and showing the
// guard on u as it lands (r.guard)
function autoGuard(r, u) {
  const g = u.sc.find(s => s.name === 'CR_AUTOGUARD' && W.t < s.until), f = r.skill && B.SKILLS[r.skill.name];
  if (!g || !(r.type === 'hit' || r.type === 'crit') || (f && (f.magic || f.misc))) return r;
  return rnd(100) < B.guardRate(g.lv) ? { type: 'miss', damage: 0, skill: r.skill, guard: g.lv } : r;
}
// Lex Aeterna on unit u (battle_calc_damage, SC_AETERNA): an attack that does damage (all its hits) does twice
// that, and the status ends with it; one Auto Guard stopped does none, and leaves it on
function aeterna(r, u) {
  if (!(r.damage > 0) || !u.sc.some(s => s.name === 'PR_LEXAETERNA' && W.t < s.until)) return r;
  endStatus(u, 'PR_LEXAETERNA');
  const step = n => ['天使之怒 × 2', n * 2];
  return { ...r, damage: r.damage * 2, steps: [...(r.steps || []), step(r.damage - (r.left || 0))],
           ...r.left && { left: r.left * 2, leftSteps: [...(r.leftSteps || []), step(r.left)] } };
}
// SC_RAID on unit u (Sightless Mind's, battle_calc_damage, renewal; after Lex Aeterna): an attack that does damage does
// 30 % more, on a boss 15 %, for as long as it lasts
function raided(r, u) {
  if (!(r.damage > 0) || !u.sc.some(s => s.name === 'RG_RAID' && W.t < s.until)) return r;
  const n = isBoss(u) ? 15 : 30, step = d => [`潛擊 +${n}%`, d + Math.trunc(d * n / 100)];
  return { ...r, damage: r.damage + Math.trunc((r.damage - (r.left || 0)) * n / 100) + Math.trunc((r.left || 0) * n / 100),
           steps: [...(r.steps || []), step(r.damage - (r.left || 0))],
           ...r.left && { left: step(r.left)[1], leftSteps: [...(r.leftSteps || []), step(r.left)] } };
}
// SC_RAID put on unit u at level lv (sc_start 100, 10 s: sightlessmind.cpp; one of a higher level on it stays)
const RAID_MS = 10000;
function raidOn(u, lv, t) {
  if (u.sc.some(s => s.name === 'RG_RAID' && s.lv > lv && t < s.until)) return;
  u.sc = [...u.sc.filter(s => s.name !== 'RG_RAID'), { name: 'RG_RAID', lv, start: t, until: t + RAID_MS, effect: null }];
}
// what flies to the target with each hit of an attack: a ranged monster's projectile (sandbox.js knows which
// monsters have one), or a character's arrow with a bow skill (see shoot). m: the skill's motion (skillMotion).
function projectiles(u, target, r, at, m) {
  if (u.isPc) shoot(u, target, r, at, m.mo, m.fd);
  else emit('mobAttack', u, target, at, hitCount(r), hitGap(r));
}
const SHOT_MS = 150;
// a bow skill shoots an arrow for every hit it lands (二連矢: two, a hit apart), each leaving the string
// the same frame before its hit as a normal attack's does. mo/fd: the attack motion it goes off with.
function shoot(c, m, r, at, mo, fd) {
  // (Melody Strike's and Slinging Arrow's, from an instrument or a whip, whose motion lets no arrow go: SHOT_MS on the way)
  const arrow = r.skill && (B.SKILLS[r.skill.name] || {}).arrow;
  if (!arrow && (c.pc.weapon !== 'Bow' || mo.release == null)) return;
  const gap = hitGap(r), flight = mo.release == null ? SHOT_MS : (mo.hf - mo.release) * fd;
  for (let i = 0; i < hitCount(r); i++)
    W.shots.push({ by: c, from: c.w, to: m, t0: at + i * gap - flight, at: at + i * gap, skill: true });
}
// ---------- freezing ----------
// SC_STUN on unit u for ms (status.yml Stun): it cannot move, attack or cast (its cast is dropped, NoMove /
// NoAttack / NoCast, StopCasting); unlike a freeze, hits do not end it, and one stunned already is not stunned
// again (Fail: Stun). roBrowser's body state STUN: the status-stun sprite circling over its head, _stun.wav.
function stun(u, t, ms) {
  u.cast = null;
  u.w.halt();
  u.stunned = { until: t + ms };
  emit('stun', u, t);
}
// A hit r of skill sk (Lv lv) that may break a part of its target's equipment (B.SKILLS breaks: skill_break_equip, its
// rate in hundredths of a percent × equip_skill_break_rate 100 %) rolls for it as it is worked out; it breaks as the hit
// lands (r.strip: stripMob). A character's equipment does not break here (the monsters' skills do not break any).
function rollBreak(sk, lv, r) {
  const b = B.SKILLS[sk.name]?.breaks;
  if (b && rnd(10000) < b.rate(lv)) r.strip = b.part;
}
// monster m's equipment broken (break_mob_equip on, by request; skill_break_equip): the Divest status of that part on it
// (B.MOB_STRIPS, its figures in statusOf) for RG_STRIP…'s Lv 1 Duration1 (75 s), again from now if it has it; a boss
// resists it (BossResist) but shows the emote all the same; Acid Terror's armour broken shows ET_HUK over it
// (clif_emotion, as skill_break_equip reports the break). Not Dispell's to end (NoDispell). The rogue's Divests put it on
// at their level for `ms` (DOES.strip); one of a higher level on it already stays (status_change_start: val1 the greater)
const ET_HUK = 23;
// (`divest`: { lv, ms }, a Divest's, with no emote)
function stripMob(m, name, t, divest = null) {
  if (m.isPc) return;
  const lv = divest ? divest.lv : 1, ms = divest ? divest.ms : db.skills[name].duration[0] || 0;
  if (!isBoss(m) && !m.sc.some(s => s.name === name && s.lv > lv && t < s.until))
    m.sc = [...m.sc.filter(s => s.name !== name), { name, lv, start: t, until: t + ms, effect: null }];
  if (name === 'RG_STRIPARMOR' && !divest) emit('emotion', m, ET_HUK, t);
}
// SC_BLEEDING on unit u for ms (status.yml: BossResist; its odds B.bleedOdds): see above; no regen while it lasts
const BLEED_MS = 10000;
function bleed(u, t, ms) {
  if (isBoss(u)) return;
  u.bleeding = { until: t + ms, next: t + BLEED_MS };
}
function unstun(u, t) {
  u.stunned = null;
  emit('unstun', u, t);
}
// The statuses a hit of skill p on m may bring on (B.SKILLS' ails, in order): each rolls at its rate against
// the target's resistance (stunOdds, poisonOdds, blindOdds, silenceOdds, confuseOdds, petrifyOdds: Duration1 its
// wait), for the skill's Duration2 (or `dur`); `orElse`: only
// if the one before did not take (Stone Fling's blind). One the target has already fails (status.yml Fail). What
// takes is put on hit r, to start as it lands (landHits); `fails`: a player's skill fails when it does not
// (Envenom's message).
const AIL_ODDS = { freeze: B.freezeOdds, stun: B.stunOdds, poison: B.poisonOdds, blind: B.blindOdds, silence: B.silenceOdds, confuse: B.confuseOdds,
  curse: B.curseOdds, sleep: B.sleepOdds, bleed: B.bleedOdds, hallucinate: (src, dst, rate, ms) => ({ chance: rate, ms }), orcish: (src, dst, rate, ms) => ({ chance: rate, ms }) };
// unit m has that status already
const ailOn = (m, kind) => !!{ freeze: m.frozen, stun: m.stunned, poison: m.poison, blind: m.blind, silence: m.silenced, confuse: m.confused, stone: m.stone,
  curse: m.curse, sleep: m.asleep, bleed: m.bleeding, hallucinate: false, orcish: false }[kind];
function rollAils(u, m, p, r) {
  let took = false;
  for (const a of B.SKILLS[p.sk.name].ails?.(statusOf(u)) || []) {
    if (a.orElse && took) continue;
    took = false;
    const ms = p.sk[a.dur || 'duration2'][p.lv - 1] || 0, has = ailOn(m, a.kind);
    const o = a.kind === 'stone' ? B.petrifyOdds(statusOf(u), statusOf(m), a.rate(p.lv), p.sk.duration[p.lv - 1] || 0, ms)
      : AIL_ODDS[a.kind](statusOf(u), statusOf(m), a.rate(p.lv), ms);
    if (!has && rnd(10000) < o.chance * 100) { r[a.kind] = a.kind === 'stone' ? { wait: o.wait, ms: o.ms } : o.ms; took = true; }
    else if (a.fails && u.isPc) r.ailFail = true;
  }
}
// SC_POISON on unit u for ms (Slow Poison holding off its HP loss and the regen's stop): it loses B.poisonDamage HP every second (status_change_timer, interval 1000) while
// that leaves it above a quarter of its MaxHP (no number shown: status_zap), has no natural regen
// (status_calc_regen) and less DEF (B.poisoned). SC_BLIND: less HIT and FLEE (B.blinded), and a monster sees
// only 1 cell (mob_ai_sub_hard: view_range 1; status_check_visibility with checkblind). Neither ends on damage.
function poisonUnit(u, t, ms) {
  u.poison = { until: t + ms, next: t + 1000 };
  if (u.isPc) recalc(u);
  emit('poison', u, t);
}
function unpoison(u, t) {
  u.poison = null;
  if (u.isPc) recalc(u);
  emit('unpoison', u, t);
}
function blindUnit(u, t, ms) {
  u.blind = { until: t + ms };
  if (u.isPc) recalc(u);
  emit('blind', u, t);
}
function unblind(u, t) {
  u.blind = null;
  if (u.isPc) recalc(u);
  emit('unblind', u, t);
}
// SC_SILENCE on unit u for ms: it cannot use skills (NoCast: skillFail, mobSkill), and its cast stops
// (StopCasting); damage does not end it
function silence(u, t, ms) {
  u.silenced = { until: t + ms };
  u.cast = null;
  emit('silence', u, t);
}
function unsilence(u, t) {
  u.silenced = null;
  emit('unsilence', u, t);
}
// SC_CONFUSION on unit u for ms: it stops walking (StopWalking), and every walk it sets out on goes to a cell
// in a random direction instead (unit_walktoxy / unit_walktobl → map_random_dir: grid.js Mover.confused);
// damage does not end it
function confuse(u, t, ms) {
  u.confused = { until: t + ms };
  u.w.confused = true;
  u.w.stop();
  emit('confuse', u, t);
}
function unconfuse(u, t) {
  u.confused = null;
  if (u.w) u.w.confused = false;  // (none: off the floor, a replay making it again — enter gives it a walker of its own)
  emit('unconfuse', u, t);
}
// SC_CURSE on unit u for ms (status.yml Curse): its LUK is 0, it walks 300% slower (a character's: playerStatus'
// `cursed`) and its attacks do 25% less (B.cursed); damage does not end it, Blessing on a character does (see
// DOES.buff). roBrowser's health state CURSE: status-curse.spr over its head at half opacity, the body darkened
// red, _curse.wav.
function curse(u, t, ms) {
  u.curse = { until: t + ms };
  if (u.isPc) recalc(u);
  emit('curse', u, t);
}
function uncurse(u, t) {
  u.curse = null;
  if (u.isPc) recalc(u);
  emit('uncurse', u, t);
}
// SC_SLEEP on unit u for ms (status.yml Sleep): as a stun, it cannot move, attack or cast (its cast is dropped);
// any damage wakes it (RemoveOnDamaged), and hits on it always land, criticals twice as often (B: opt1, asleep).
// roBrowser's body state SLEEP: status-sleep.spr over its head.
function sleep(u, t, ms) {
  u.cast = null;
  u.w.halt();
  u.asleep = { until: t + ms };
  emit('sleep', u, t);
}
function wake(u, t) {
  u.asleep = null;
  emit('wake', u, t);
}
// SC_HALLUCINATION on unit u for ms: nothing in the fight; the damage shown on it is a random number
// (clif_hallucination_damage: sandbox.js), and the player's screen wobbles (the client's). Started again, it starts over.
function hallucinate(u, t, ms) {
  u.hallucinating = { until: t + ms };
  emit('hallucinate', u, t);
}
function unhallucinate(u, t) {
  u.hallucinating = null;
  emit('unhallucinate', u, t);
}
// SC_ORCISH on unit u for ms (Grampus Morph): only a character's look, its head an orc's (OPTION_ORCISH: roBrowser
// draws 이팩트/orcface in place of the head). Started again, it starts over.
function orcish(u, t, ms) {
  u.orcish = { until: t + ms };
  emit('orcish', u, t);
}
function unorcish(u, t) {
  u.orcish = null;
  emit('unorcish', u, t);
}
// SC_STOP (Stop: skills/npc/stop.cpp) on unit u for ms, held with unit `other` (val2; none from a Skid Trap): it
// cannot walk (NoMove; its walk stops, StopWalking: grid.js Mover.rooted) but still attacks and casts. As one of the
// two ends (its time, death), the other's ends with it (status_change_end SC_STOP).
function stopUnit(u, other, t, ms) {
  u.stopped = { until: t + ms, with: other };
  u.w.stop();
  root(u);
  emit('stop', u, t);
}
function unstop(u, t) {
  const other = u.stopped.with;
  u.stopped = null;
  root(u);
  emit('unstop', u, t);
  if (other && other.stopped && other.stopped.with === u) unstop(other, t);
}
// how each status a hit or a skill brings on starts (landHits, DOES.wide, DOES.inflict)
const AIL_START = { freeze, stun, poison: poisonUnit, blind: blindUnit, silence, confuse, curse, sleep, hallucinate, orcish };
// poison, blindness, silence, confusion and the others above on unit u at time t: the poison's HP loss, and each
// ending (a stun's and a sleep's: where the unit acts)
function ailTick(u, t) {
  const p = u.poison;
  if (p) {
    for (; p.next <= Math.min(t, p.until); p.next += 1000) {
      const max = maxHp(u), d = B.poisonDamage(baseStatus(u));
      if (u.hp > Math.max(Math.trunc(max / 4), d) && !has(u, 'PR_SLOWPOISON')) { u.hp -= d; emit('hp', u); }  // (none under Slow Poison)
    }
    if (t >= p.until) unpoison(u, t);
  }
  const bl = u.bleeding;
  if (bl && t >= bl.next) {
    // (SC_BLEEDING: 200 to 799 HP every 10 s, no number shown; a monster's never its last: status_change_timer)
    bl.next += BLEED_MS;
    const d = 200 + rnd(600);
    u.hp = u.isPc ? u.hp - d : Math.max(1, u.hp - d);
    emit('hp', u);
    if (u.isPc && u.hp <= 0) { u.hp = 0; die(u, t); }
  }
  if (bl && t >= bl.until) u.bleeding = null;
  if (u.blind && t >= u.blind.until) unblind(u, t);
  if (u.silenced && t >= u.silenced.until) unsilence(u, t);
  if (u.confused && t >= u.confused.until) unconfuse(u, t);
  if (u.curse && t >= u.curse.until) uncurse(u, t);
  if (u.hallucinating && t >= u.hallucinating.until) unhallucinate(u, t);
  if (u.orcish && t >= u.orcish.until) unorcish(u, t);
  if (u.stopped && t >= u.stopped.until) unstop(u, t);
  if (u.webbed && t >= u.webbed.until) unweb(u, t);
  if (u.held && t >= u.held) { u.held = 0; root(u); }
}
// all of them end (death, the clock reset: status_change_clear), and a petrification
function endAils(u, t) {
  if (u.stone) unpetrify(u, t);
  if (u.stunned) unstun(u, t);
  if (u.asleep) wake(u, t);
  if (u.curse) uncurse(u, t);
  if (u.hallucinating) unhallucinate(u, t);
  if (u.orcish) unorcish(u, t);
  if (u.stopped) unstop(u, t);
  if (u.snared) unsnare(u, t);
  if (u.poison) unpoison(u, t);
  if (u.blind) unblind(u, t);
  if (u.silenced) unsilence(u, t);
  if (u.confused) unconfuse(u, t);
  u.bleeding = null;
  if (u.held) { u.held = 0; root(u); }
}
// SC_FREEZE on unit u for ms (status.yml Freeze): it cannot move, attack or cast (its cast is dropped,
// NoMove / NoAttack / NoCast, StopCasting), it holds the pose it was in, tinted blue in a block of ice
// (roBrowser's body state FREEZE: colour 0, 0.4, 0.8 and the 얼음땡 sprite; monsters have no freeze action),
// and its status turns Water 1 with half its hard DEF and a quarter more hard MDEF (B.frozen). It ends when
// the time is up or any hit lands (RemoveOnDamaged), the ice shattering with _frozen_explosion.wav.
// (stage.js draws a frozen monster or character so.)
function freeze(u, t, ms) {
  u.cast = null;
  u.w.halt();
  u.frozen = { until: t + ms };
  emit('freeze', u, t, ms);
}
function thaw(u, t) {
  u.frozen = null;
  emit('thaw', u, t);
}
// Petrification (status.yml StoneWait, then Stone): for `wait` ms unit u is turning to stone — it can still
// walk but not attack or cast (NoAttack, NoCast, StopAttacking) and hits do not end it; then (stoneStep) it is
// stone for `ms`: it cannot move, attack or cast (its cast is dropped), holds its pose, and its status turns
// Earth 1 with half its hard DEF and a quarter more hard MDEF (B.stoned); every 5 s it loses 1% of its MaxHP
// while above a quarter of it (status_change_timer SC_STONE, interval 5000). Any hit ends the stone
// (RemoveOnDamaged), as does its time running out. (sandbox.js draws it. Monsters are petrified by Stone Curse,
// characters by a monster's Petrify Attack.)
const STONE_DRAIN_MS = 5000;
function petrify(u, t, wait, ms) {
  u.stone = { start: t, wait: t + wait, ms, until: Infinity, on: false, drain: 0 };
  emit('stoneWait', u, t);
}
// the stone wait over: stone (SC_STONE started with SCSTART_NOAVOID)
function stoneStep(u, t) {
  const s = u.stone;
  if (!s || s.on || t < s.wait) return;
  Object.assign(s, { on: true, until: s.wait + s.ms, drain: s.wait + STONE_DRAIN_MS });
  u.cast = null;
  u.w.halt();
  emit('stone', u, t);
}
function unpetrify(u, t) {
  const was = u.stone && u.stone.on;
  u.stone = null;
  emit('unstone', u, t, was);
}
// stone on unit u at time t: its HP drain, and its end; true while it is stone (it does nothing then)
function stoneTick(u, t) {
  stoneStep(u, t);
  const s = u.stone;
  if (!s || !s.on) return false;
  if (t >= s.until) { unpetrify(u, t); return false; }
  for (; t >= s.drain; s.drain += STONE_DRAIN_MS) {
    const max = maxHp(u);
    if (u.hp > Math.trunc(max / 4)) { u.hp = Math.max(1, u.hp - Math.max(1, Math.trunc(max / 100))); emit('hp', u); }
  }
  return true;
}
// ---------- pace ----------
// How fast unit u goes at time t, 1 being its own speed: its walking and its animations go that much slower
// (u.w.pace, u.animT; set every step). Turning to stone it slows down evenly over the wait, from 1 to
// STONE_PACE as it turns (by request; rAthena's stone wait leaves the speed alone). Not its attacks or skills:
// what slows is drawn and walked only.
// Under Decrease AGI everything a monster does takes SLOW times as long (by request): rAthena only has it walk
// 25% slower (status_calc_speed: speed_rate 125, a monster's 200 ms a cell becoming 250), so that is how much its
// walk and animations, its attack motion and attack delay, its damage motion and its casts are stretched.
const SLOW = 1.25;
// a monster's attack motion under its ASPD buffs (B.mobBuffed): its sprite's frames that much quicker (the client
// plays the attack in the amotion it is sent); one with no AttackMotion in mob_db (Iceicle: 0) as it is, not 0/0
const aspdK = m => m.base && m.base.amotion ? m.st.amotion / m.base.amotion : 1;
const slowK = u => u.sc.some(s => s.name === 'AL_DECAGI' && W.t < s.until) ? SLOW : 1;
const STONE_PACE = 0.15;
function paceOf(u, t) {
  const s = u.stone;
  const stone = s && !s.on ? 1 - (1 - STONE_PACE) * Math.min(1, Math.max(0, (t - s.start) / (s.wait - s.start))) : 1;
  // (the slowest of Decrease AGI's and a quagmire's — Grimtooth's or Quagmire's — counts: status_calc_speed's max)
  const quag = u.sc.some(s => (s.name === 'AS_GRIMTOOTH' || s.name === 'WZ_QUAGMIRE') && t < s.until);
  return stone / Math.max(slowK(u), quag ? QUAG_SLOW : 1);
}
// SC_QUAGMIRE on monster u for ms (Grimtooth's): it walks QUAG_SLOW times as long (status_calc_speed: 50% slower)
const QUAG_SLOW = 1.5;
function quagmire(u, t, ms) {
  u.sc = [...u.sc.filter(s => s.name !== 'AS_GRIMTOOTH'), { name: 'AS_GRIMTOOTH', lv: 1, start: t, until: t + ms }];
}
// ---------- fire walls ----------
// Fire Wall (skill_unitsetting, UNT_FIREWALL): a line of cells across the way it is cast (map_calc_dir from
// the caster to the cell; the same cell counts as east), 3 cells straight or 5 in steps on a diagonal
// (skill_init_unit_layout, firewall_unit_pos). Each cell burns for the skill's Duration1 or until it has hit
// 4 + Lv times (val2). Ground units act every SKILLUNITTIMER_INTERVAL (100 ms), on whoever stands on their
// cell (walking onto one does nothing by itself: a unit with an interval is not dual-mode); a fire wall cell
// then hits each enemy on it again and again, WALL_HIT_MS apart, until the enemy leaves the cell, dies, or
// the cell runs out — at most UNIT_MS / WALL_HIT_MS times a turn. The first hit knocks the enemy back 2 cells
// against its facing (skill_blown with unit_getdir), which ends it, and it walks back in for another; fire
// and undead enemies are not knocked back but cannot be stopped for 2 s instead (endure_tick), so they soak
// up a cell's hits in a row. Boss class is not knocked back either. The hits in a row come 100 ms apart
// here, one a turn, by eye, so the numbers come apart; rAthena's are the unit's Interval, 20 ms, up to 5 a turn.
// At most WALL_MAX of one's own at once (ActiveInstance). The walls stay when their caster falls
// (clear_skills_on_death 0) but do nothing then (skill_caster_check).
const UNIT_MS = 100, WALL_HIT_MS = 100, WALL_KNOCK = 2, WALL_MAX = 3, ENDURE_MS = 2000;
// map_calc_dir_xy: the direction from cell a to cell b (rAthena's: 0 north, counter-clockwise to 7 north-east)
// a direction's step (rAthena dirx, diry; +y north)
const DIR_X = [0, -1, -1, -1, 0, 1, 1, 1], DIR_Y = [1, 1, 0, -1, -1, -1, 0, 1];
function calcDir([ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  if (!dx && !dy) return 6;  // skill_get_unit_layout: the default aegis direction, east
  if (dx >= 0 && dy >= 0) return dx >= dy * 3 ? 6 : dx * 3 < dy ? 0 : 7;
  if (dx >= 0 && dy <= 0) return dx >= -dy * 3 ? 6 : dx * 3 < -dy ? 4 : 5;
  if (dx <= 0 && dy <= 0) return dx * 3 >= dy ? 4 : dx < dy * 3 ? 2 : 3;
  return -dx * 3 <= dy ? 0 : -dx > dy * 3 ? 2 : 1;
}
// cell c is in the area map_foreachindir searches from cell [x0, y0] in direction dir (offset 0): `length` rows
// from the start's own row on, `range` cells either side, the start cell left out; a diagonal one as a band
// (half-cell steps: rx + ry within 2 × (length − 1), |rx − ry| within 2 × range)
function inDir([x0, y0], dir, range, length, [x, y]) {
  const dx = DIR_X[dir], dy = DIR_Y[dir], sx = DIR_X[(dir + 2) % 8], sy = DIR_Y[(dir + 2) % 8];
  const xs = [x0, x0 + dx * (length - 1)].sort((a, b) => a - b), ys = [y0, y0 + dy * (length - 1)].sort((a, b) => a - b);
  if (x < xs[0] - Math.abs(range * sx) || x > xs[1] + Math.abs(range * sx) || y < ys[0] - Math.abs(range * sy) || y > ys[1] + Math.abs(range * sy)) return false;
  if (x === x0 && y === y0) return false;
  const rx = (x - x0) * dx, ry = (y - y0) * dy;
  return !(dir & 1) || (rx + ry >= 0 && rx + ry <= 2 * (length - 1) && Math.abs(rx - ry) <= 2 * range);
}
// the cells of a fire wall around its centre, for the direction it is cast in
function wallLayout(dir) {
  if (dir & 1) return dir & 2 ? [[-1, 1], [-1, 0], [0, 0], [0, -1], [1, -1]] : [[1, 1], [1, 0], [0, 0], [0, -1], [-1, -1]];
  return dir % 4 === 0 ? [[-1, 0], [0, 0], [1, 0]] : [[0, -1], [0, 0], [0, 1]];
}
// unit c's Fire Wall (p: the skill and level) goes up around cell `at`; its cells burn (EF_FIREWALL,
// one sound for them all) until they run out
function placeWall(c, p, at, t) {
  // (its user in Violent Gale: half as long again, skill_unitsetting)
  const until = t + Math.trunc((p.sk.duration[p.lv - 1] || 0) * (has(c, 'SA_VIOLENTGALE') ? 3 : 2) / 2), dir = calcDir(c.w.cell, at);
  const cells = wallLayout(dir).map(([dx, dy]) => [at[0] + dx, at[1] + dy]).filter(([x, y]) => field.open(x, y) && !onLP(x, y))
    .map(([x, y]) => ({ x, y, left: 4 + p.lv }));
  const wall = { by: c, sk: p.sk, lv: p.lv, cells, until };
  W.walls.push(wall);
  emit('wall', wall, t);
}
// Ice Wall (skills/mage/icewall.cpp, UNT_ICEWALL): 5 cells across the way from the user to the target cell, centred on it
// (skill_init_unit_layout's icewall layout for map_calc_dir), each but a wall (CELL_CHKREACH) or one iced already
// (skill_cell_overlap: not on itself) — under a unit too. Each is a cliff (map_setgatcell 5): nothing walks onto it
// (a walk under way goes round, grid.js) but shots and spells go over. It has 200 + 200 × Lv HP and loses 50 every
// second (Interval 1000: skill_unit_timer_sub), gone at none; nothing here hurts it (no one aims at it). Whoever
// stands on one as it goes up is pushed off it (see pushOffIce). It stays when its user falls (a monster's goes with
// its body, as fire walls). The cast fails with no cell.
const ICE_MS = 1000, ICE_LOSS = 50;
function iceLayout(dir) {
  const k = [-2, -1, 0, 1, 2];
  if (dir & 1) return k.map(d => dir & 2 ? [d, -d] : [d, d]);
  return k.map(d => dir % 4 === 0 ? [d, 0] : [0, d]);
}
const iced = (x, y) => W.ices.some(n => n.cells.some(c => c.x === x && c.y === y)) || trialIce.some(([a, b]) => a === x && b === y);
// the cells of an ice wall tried for a while (wallSaves), not up
let trialIce = [];
// (a cell's walk on the floor it went up on: not one shown since, setFloor)
function setIce(gat, x, y, on) { if (gat === field.map.gat) gat.walk[y * gat.w + x] = on ? 0 : 1; }
function placeIce(c, p, at, t) {
  const cells = iceLayout(calcDir(c.w.cell, at)).map(([dx, dy]) => [at[0] + dx, at[1] + dy])
    .filter(([x, y]) => field.open(x, y) && !iced(x, y) && !onLP(x, y)).map(([x, y]) => ({ x, y, hp: 200 + 200 * p.lv }));
  if (!cells.length) return say(c.w, '技能使用失敗', t);
  const n = { by: c, lv: p.lv, cells, next: t + ICE_MS, gat: field.map.gat }, dir = calcDir(c.w.cell, at);
  for (const x of cells) setIce(n.gat, x.x, x.y, true);
  for (const u of units()) if (alive(u) && inFight(u) && cells.some(x => sameCell([x.x, x.y], u.w.cell))) pushOffIce(u, dir, c.w.cell, u.side === c.side);
  W.ices.push(n);
  emit('ice', n, t);
}
// unit u, on a cell of an ice wall going up the way `dir` from cell `from`, slides off it to the side (by request; in
// rAthena it stays on the ice, a monster trapped there: mob_icewall_walk_block): a cell straight off the wall's line —
// on the caster's side for one of its own side (`ours`), the far side for an enemy, else the other — or failing both
// the nearest cell it can stand on
function pushOffIce(u, dir, from, ours) {
  const [x0, y0] = u.w.cell, side = [DIR_X[dir], DIR_Y[dir]];
  const off = (dir & 1 ? [[side[0], 0], [0, side[1]], side] : [side]).flatMap(([dx, dy]) => [[x0 - dx, y0 - dy], [x0 + dx, y0 + dy]]);
  const near = ([x, y]) => (Math.abs(x - from[0]) + Math.abs(y - from[1])) * (ours ? 1 : -1);
  const to = off.filter(([x, y]) => field.open(x, y)).sort((a, b) => near(a) - near(b))[0] || nearestOpen(u.w.cell);
  if (to) u.w.knock(to, field.knockMs);
}
// the free cell nearest `cell` (a ring at a time, Chebyshev), or null
function nearestOpen([x0, y0]) {
  for (let d = 1; d < SIZE; d++)
    for (let y = y0 - d; y <= y0 + d; y++) for (let x = x0 - d; x <= x0 + d; x++)
      if (cheb([x, y], [x0, y0]) === d && field.open(x, y)) return [x, y];
  return null;
}
// its cells losing their HP each second, those out of it gone; all of it gone (`all`: the clock reset, its monster gone)
function iceTurn(n, t, all = false) {
  if (!all && t < n.next) return;
  n.next += ICE_MS;
  for (const x of n.cells) if (all || (x.hp -= ICE_LOSS) <= 0) { setIce(n.gat, x.x, x.y, false); emit('iceOut', x, t); }
  n.cells = all ? [] : n.cells.filter(x => x.hp > 0);
  if (!n.cells.length) W.ices = W.ices.filter(x => x !== n);
}
// Safety Wall (skills/mage/safetywall.cpp, UNT_SAFETYWALL): one cell, for Duration1 (5 s a level). Whoever of the
// caster's side stands on it (Unit Flag NoEnemy; onplace, Interval −1: while on the cell) has SC_SAFETYWALL:
// a short-range physical attack on it (BF_SHORT, not magic: a monster's from within 3 cells,
// skillrange_by_distance) is blocked whole (ATK_BLOCK, shown as Miss), each block taking one of its Lv + 1 hits
// and, renewal, the damage blocked from its 300 × Lv + 65 × (INT + level) + MaxSP; it is gone when either runs
// out (the one that does is still blocked) or its time is up. Not on a cell with one already (NoReiteration:
// the skill fails). A character's takes a Blue Gemstone (ITEM_COST). It stays when its caster falls.
function placeSafetyWall(c, p, [x, y], t) {
  if (onLP(x, y)) return say(c.w, '技能使用失敗', t);  // (not on Land Protector: its gemstone gone, skill_unitsetting)
  if (W.guards.some(g => g.x === x && g.y === y) || W.pneumas.some(n => cheb([n.x, n.y], [x, y]) <= 1)) return giveBack(c, BLUE_GEM), say(c.w, '技能使用失敗', t);
  const st = statusOf(c);
  const g = { by: c, x, y, lv: p.lv, hits: p.lv + 1, hp: 300 * p.lv + 65 * (st.stats.int + st.lv) + (st.maxSp || 0),
              until: t + (p.sk.duration[p.lv - 1] || 0) };
  g.full = { hits: g.hits, hp: g.hp };  // (what it started with)
  W.guards.push(g);
  emit('guard', g, t);
}
// Pneuma (UNT_PNEUMA, unit layout 1): the 3×3 around its cell, for Duration1 (10 s). Whoever stands in it,
// of either side (no NoEnemy flag), has SC_PNEUMA: a long-range attack on it that is not magic (BF_LONG:
// from farther than 3 cells, as Safety Wall's short range; the bow skills', the ranged monsters', Stone
// Fling's) is blocked whole (battle_calc_damage, ATK_BLOCK, shown as Miss), as many as come while it lasts.
// Not where a pneuma or a safety wall stands within its 3×3 already (NoReiteration: skill_check_unit_range,
// both ways; the skill fails). It stays when its caster falls.
// Detect (skills/archer/detect.cpp): the falcon flies round a circle past the cell and back (stage.js 'falcon', `high`;
// DETECT_LAUNCH, by request); as it passes behind the cell every enemy in hiding or cloaked in the splash square
// round the cell (SplashArea 3: the 7×7) comes out (status_change_timer_sub SC_SIGHT; a party member's leaves the party's
// hidden ones be, as Sight). rAthena's is at once. Traps are seen already (traps_setting 0: skill_reveal_trap_inarea).
// when character c's falcon, sent round a circle through cell w at time t (Detect, Spring Trap), is over it: round the
// circle in 2 × its length / DETECT_LAUNCH, half way at 1 − √½ of that
const scoutAt = (c, w, t) => t + (1 - Math.SQRT1_2) * 2 * Math.PI * (field.distance(c.w, w) + DETECT_BEHIND) / DETECT_LAUNCH * 1000;
function detect(c, p, [x, y], t) {
  const at = scoutAt(c, p.target.w, t), area = p.sk.splash[p.lv - 1] || 0;
  emit('falcon', c, p.target.w, t, at, 0, 'EF_DETECTWIND');
  W.later.push({ at, by: c, to: c, run() {
    for (const u of units()) if (u.side !== c.side && u.dead == null && (hidden(u) || cloaked(u)) && cheb(u.w.cell, [x, y]) <= area) {
      endStatus(u, 'TF_HIDING');
      endStatus(u, 'AS_CLOAKING');
    }
  } });
}
function placePneuma(c, p, [x, y], t) {
  if (onLP(x, y)) return say(c.w, '技能使用失敗', t);
  if (W.pneumas.some(n => cheb([n.x, n.y], [x, y]) <= 2) || W.guards.some(g => cheb([g.x, g.y], [x, y]) <= 1))
    return say(c.w, '技能使用失敗', t);
  const n = { by: c, x, y, until: t + (p.sk.duration[p.lv - 1] || 0) };
  W.pneumas.push(n);
  emit('pneuma', n, t);
}
function pneumaOut(n, t) {
  W.pneumas = W.pneumas.filter(x => x !== n);
  emit('pneumaOut', n, t);
}
// Warp Portal (UNT_WARP_WAITING → UNT_WARP_ACTIVE): one cell, waiting WARP_WAIT_MS (skill_unitsetting's limit
// 2000) before it opens, then open for Duration1 (10–25 s). Whoever stands on it while it is open, of either
// side (rAthena sends only characters, unless battle.conf mob_warp: here monsters too, by request), goes to a
// random free cell of the floor (teleportUnit; the memo points to pick from are not there), up to Lv + 6 of
// them (val1), then it is gone. It may go under a unit (by request), which it sends off as it opens; not on a
// cell with a portal already (the skill fails); at
// most WARP_MAX of one's own at once (ActiveInstance). A character's takes a Blue Gemstone (ITEM_COST). It stays
// when its caster falls.
const WARP_WAIT_MS = 2000, WARP_MAX = 3;
function placeWarp(c, p, [x, y], t) {
  if (onLP(x, y)) return say(c.w, '技能使用失敗', t);
  if (W.warps.some(n => n.x === x && n.y === y)) return giveBack(c, BLUE_GEM), say(c.w, '技能使用失敗', t);
  const n = { by: c, x, y, open: t + WARP_WAIT_MS, until: t + WARP_WAIT_MS + (p.sk.duration[p.lv - 1] || 0), left: p.lv + 6, opened: false };
  W.warps.push(n);
  emit('warp', n, t);
}
function warpOut(n, t) {
  W.warps = W.warps.filter(x => x !== n);
  emit('warpOut', n, t);
}
// the enemies of unit `by` its ground units act on (battle_check_target BCT_ENEMY): standing, and not in hiding
// (skill_unit_onplace_timer: OPTION_HIDE is immune to them; Cloaking is not)
const groundFoes = by => units().filter(x => x.side !== by.side && alive(x) && !hidden(x));
// Traps (Sandman, Skid Trap: skill_unitsetting, a unit of Range 1 and Interval 1000): one cell, for Duration1
// (Lv 5: 30 s and 60 s). Every UNIT_MS (skill_unit_timer) an enemy of its setter within a cell of it
// (map_foreachinallrange: the 3×3) sets it off, the first found, and it is spent (UNT_USED_TRAPS, which roBrowser does
// not draw: gone here). Sandman: every enemy within its splash (2: the 5×5) around the one who set it off rolls
// 10 × Lv + 40 % against its resistance (B.sleepOdds) to sleep for Duration2, 18 s (skill_trap_splash →
// skill_additional_effect). Skid Trap, renewal: the one who set it off slides Knockback (Lv + 5) cells away from where
// its setter stood as it set it (val1; one standing there goes west: map_calc_dir_xy's east, pushed back), and is held
// by SC_STOP for Duration2, 3 s (no partner); a boss does not set it off. Not on a cell with a trap already
// (NoReiteration: the skill fails, its Booby Traps given back). Visible (traps_setting 0). A character's takes Booby
// Traps (ITEM_COST, ITEM_N); a monster's none. A monster's go when it does (removeMob: unit_free → skill_clear_unitgroup).
//
// Fire Pillar (skill_unitsetting: UNT_FIREPILLAR_WAITING, Range 1) waits so for Duration1, 30 s; set off, it goes
// (UNT_FIREPILLAR_ACTIVE for a second, spent the moment it acts: UNT_USED_TRAPS) with its damage on every enemy in its
// splash (1, 2 from Lv 6: the 3×3, the 5×5) round the pillar (skill_trap_splash). A character's: not within a cell of
// another of its kind (NoReiteration: skill_check_unit_range, the unit's Range for a player; a monster's on the same
// cell only), nor of anyone standing (NoFootSet, skill_nofootset 1: players' only, anyone alive in the 3×3, the user
// too); the skill fails then, its Blue Gemstone given back. It is no trap to the hunter's (no IsTrap: they go on its
// cell, Claymore Trap leaves it be). A character's takes a Blue Gemstone from Lv 6 (ITEM_COST, ITEM_FROM).
const PILLAR_MAX = 5;
// A character's hunter trap but Talkie Box (NoFootSet, skill_nofootset 1: a player's) is not set within a cell of anyone
// alive, the hunter too, monsters too: skill_check_unit_range2 with the unit's Range 1; the skill fails then, its Booby
// Traps given back. So none goes on a monster's own cell.
export const TRAP_SKILLS = new Set(['HT_SKIDTRAP', 'HT_LANDMINE', 'HT_ANKLESNARE', 'HT_SHOCKWAVE', 'HT_SANDMAN', 'HT_FLASHER', 'HT_FREEZINGTRAP', 'HT_BLASTMINE', 'HT_CLAYMORETRAP']);
const footFail = (name, x, y) => TRAP_SKILLS.has(name) && units().some(u => alive(u) && inFight(u) && cheb(u.w.cell, [x, y]) <= 1);
function pillarFail(c, x, y) {
  const reach = c.isPc ? 1 : 0;
  if (W.traps.some(n => n.sk.name === 'WZ_FIREPILLAR' && cheb([n.x, n.y], [x, y]) <= reach)) return true;
  return c.isPc && units().some(u => alive(u) && inFight(u) && cheb(u.w.cell, [x, y]) <= 1);
}
function placeTrap(c, p, [x, y], t) {
  const pillar = p.sk.name === 'WZ_FIREPILLAR';
  if (pillar && onLP(x, y)) return say(c.w, '技能使用失敗', t);  // (Fire Pillar not on Land Protector; traps are)
  if (pillar ? pillarFail(c, x, y) : W.traps.some(n => n.x === x && n.y === y && n.sk.name !== 'WZ_FIREPILLAR') || (c.isPc && footFail(p.sk.name, x, y)))
    return giveBack(c, ITEM_COST[p.sk.name], itemN(p.sk.name, p.lv)), say(c.w, '技能使用失敗', t);
  if (c.tour && c.tour.cells.length && sameCell(c.tour.cells[0], [x, y])) { c.tour.cells.shift(); c.tour.i++; }  // (佈陷阱's: on to the next)
  const n = { by: c, sk: p.sk, lv: p.lv, x, y, from: [...c.w.cell], until: t + (p.sk.duration[p.lv - 1] || 0) };
  if (p.sk.name === 'HT_TALKIEBOX') n.text = c.talkie || '……';  // (its message: what the player typed, sandbox.js)
  W.traps.push(n);
  emit('trap', n, t);
}
// trap n goes: its time is up, or (`sprung`) someone set it off
function trapOut(n, t, sprung = false) {
  W.traps = W.traps.filter(x => x !== n);
  emit('trapOut', n, t, sprung);
  if (n.held && n.held.snared && n.held.snared.trap === n) unsnare(n.held, t);  // (its snare ends with it)
}
// Remove Trap (skills/archer/removetrap.cpp) on a cell: a trap of character c's own there goes, and a Booby Trap comes
// back to the bag (skill_removetrap_type 0: one, whatever it took), not for one that is holding something (Ankle
// Snare's); none of its own there, the skill fails
function removeTrap(c, p, [x, y], t) {
  const n = W.traps.find(n => n.x === x && n.y === y && n.by === c);
  if (!n) return say(c.w, '技能使用失敗', t);
  emit('success', p.sk.name, field.spot(x, y), t);
  if (!n.held && c.isPc) giveBack(c, BOOBY_TRAP);
  trapOut(n, t);
}
// Spring Trap (skills/archer/springtrap.cpp): the falcon sets off the trap on the cell, anyone's, with nothing done
// (UNT_USED_TRAPS); not an Ankle Snare holding something (Remove Trap is for that)
// (the falcon flies there as Detect's does, by request; the trap goes, spring.str on it, as it passes over)
function disarm(c, p, [x, y], t) {
  const at = scoutAt(c, p.target.w, t);
  emit('falcon', c, p.target.w, t, at, 0, 'EF_SPRINGTRAP');
  W.later.push({ at, by: c, to: c, run() {
    const n = W.traps.find(n => n.x === x && n.y === y);
    if (n && !n.held) trapOut(n, at);
  } });
}
// Ankle Snare's hold on unit u ends (SC_ANKLE), and the trap holding it goes (skill_delunit)
function unsnare(u, t) {
  const n = u.snared.trap;
  u.snared = null;
  root(u);
  emit('unsnared', u, t);
  if (W.traps.includes(n)) trapOut(n, t);
}
// unit u sets trap n off
function springTrap(n, u, t) {
  // Ankle Snare (UNT_ANKLESNARE): the one that set it off is pulled onto the trap (unit_movepos) and held there by
  // SC_ANKLE (NoMove) for Duration2 × (1 − AGI / 200), at least 30 × (its setter's BaseLv + 100) ms; the trap stays
  // until then, setting nothing else off (interval −1), and goes with it, as the hold ends with the trap
  if (n.sk.name === 'HT_ANKLESNARE') {
    const sec = n.sk.duration2[n.lv - 1] || 0, ms = Math.max(sec + Math.trunc(sec * defense(u).stats.agi / -200), 30 * (offense(n.by).lv + 100));
    if (u.snared) unsnare(u, t);
    if (!sameCell(u.w.cell, [n.x, n.y])) u.w.knock([n.x, n.y], SNAP_MS);
    u.snared = { until: t + ms, trap: n };
    root(u);
    n.held = u;
    n.until = t + ms;
    emit('snared', u, n, t);
    return;
  }
  trapOut(n, t, true);
  // Shockwave Trap (skills/archer/shockwavetrap.cpp: status_percent_damage, sp_rate −(15 × Lv + 5)): the one that set it
  // off loses that % of its MaxSP, at least 1; a monster has none to lose
  if (n.sk.name === 'HT_SHOCKWAVE') {
    if (u.isPc) { u.sp = Math.max(0, u.sp - Math.max(1, Math.trunc(u.pc.maxSp * (15 * n.lv + 5) / 100))); emit('hp', u); }
    return;
  }
  // Flasher (skills/archer/flasher.cpp): the one that set it off rolls 100% against its resistance (B.blindOdds) to be
  // blinded for Duration2, 18 s (no splash)
  if (n.sk.name === 'HT_FLASHER') {
    const o = B.blindOdds(statusOf(n.by), statusOf(u), 100, n.sk.duration2[n.lv - 1] || 0);
    if (!u.blind && rnd(10000) < o.chance * 100) blindUnit(u, t, o.ms);
    return;
  }
  // Freezing Trap: its damage on every enemy in its splash (1: the 3×3) round the one that set it off (centered on it:
  // skill_unit_onplace_timer), each hit freezing it at 100% against its resistance (B.freezeOdds) for Duration2 as it lands
  if (n.sk.name === 'HT_FREEZINGTRAP') {
    const area = n.sk.splash[n.lv - 1] || 0;
    for (const x of groundFoes(n.by)) {
      if (cheb(x.w.cell, u.w.cell) > area) continue;
      const r = B.skillAttack(db, offense(n.by), defense(x), n.sk, n.lv);
      if (r.damage > 0) {
        const o = B.freezeOdds(statusOf(n.by), statusOf(x), 100, n.sk.duration2[n.lv - 1] || 0);
        if (rnd(10000) < o.chance * 100) r.freeze = o.ms;
      }
      schedule(r, n.by, x, t);
    }
    return;
  }
  // Blast Mine, Claymore Trap: its damage shared among every enemy in its splash (1, 2: the 3×3, the 5×5) round the trap
  // (skill_trap_splash with SplashSplit); Claymore's spends the other traps there too, but Skid Trap and Ankle Snare
  // (skill_trap_splash UNT_CLAYMORETRAP: UNT_USED_TRAPS, nothing set off). Neither goes off when its time is up
  // (renewal: UNT_USED_TRAPS at its limit)
  if (n.sk.name === 'HT_CLAYMORETRAP') {
    const area = n.sk.splash[n.lv - 1] || 0;
    for (const x of [...W.traps]) if (!['HT_SKIDTRAP', 'HT_ANKLESNARE', 'WZ_FIREPILLAR'].includes(x.sk.name) && cheb([x.x, x.y], [n.x, n.y]) <= area) trapOut(x, t);
  }
  if (n.sk.name === 'HT_BLASTMINE' || n.sk.name === 'HT_CLAYMORETRAP') {
    const area = n.sk.splash[n.lv - 1] || 0, hit = groundFoes(n.by).filter(x => cheb(x.w.cell, [n.x, n.y]) <= area);
    for (const x of hit) schedule(B.skillAttack(db, offense(n.by), defense(x), n.sk, n.lv, undefined, 0, hit.length), n.by, x, t);
    return;
  }
  // Fire Pillar: its damage on every enemy in its splash round the pillar, each one hit with damage held from walking
  // for Duration2 (r.hold, see holdWalk)
  if (n.sk.name === 'WZ_FIREPILLAR') {
    const area = n.sk.splash[n.lv - 1] || 0;
    for (const x of groundFoes(n.by)) {
      if (cheb(x.w.cell, [n.x, n.y]) > area) continue;
      const r = B.skillAttack(db, offense(n.by), defense(x), n.sk, n.lv);
      if (r.damage > 0) r.hold = n.sk.duration2[n.lv - 1] || 0;
      schedule(r, n.by, x, t);
    }
    return;
  }
  // Land Mine: its damage on the one that set it off (no splash: skill_attack from the trap), with its stun
  if (n.sk.name === 'HT_LANDMINE') {
    const r = B.skillAttack(db, offense(n.by), defense(u), n.sk, n.lv);
    if (r.damage > 0) rollAils(n.by, u, n, r);
    schedule(r, n.by, u, t);
    return;
  }
  if (n.sk.name === 'HT_SANDMAN') {
    const area = n.sk.splash[n.lv - 1] || 0, ms = n.sk.duration2[n.lv - 1] || 0;
    for (const x of groundFoes(n.by)) {
      if (cheb(x.w.cell, u.w.cell) > area || x.asleep || !field.sees(u.w.cell, x.w.cell)) continue;
      const o = B.sleepOdds(statusOf(n.by), statusOf(x), 10 * n.lv + 40, ms);
      if (rnd(10000) < o.chance * 100) sleep(x, t, o.ms);
    }
    return;
  }
  const from = sameCell(u.w.cell, n.from) ? [n.from[0] + 1, n.from[1]] : n.from;
  field.knockback(u.w, { cell: from }, n.sk.knockback[n.lv - 1] || 0);
  if (u.stopped) unstop(u, t);
  stopUnit(u, null, t, n.sk.duration2[n.lv - 1] || 0);
}
// Venom Dust (UNT_VENOMDUST: layout −1, its cell and the four next to it, each a unit of Range 1 and Interval
// 1000): for Duration1 (Lv 1: 5 s). An enemy of its setter within a cell of any of its cells (the 3×3 around each),
// once a second at most (skill_unitgrouptickset: `next`), not poisoned already, rolls 100% against its resistance
// (B.poisonOdds) to be poisoned for Duration2, 18 s (SCSTART_NONE). A character's takes a Red Gemstone (ITEM_COST); a
// monster's asks for none. Its setter's go when it does (removeMob).
const DUST_LAYOUT = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]], DUST_MS = 1000;
function placeDust(c, p, [x, y], t) {
  const cells = DUST_LAYOUT.map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b]) => field.open(a, b) && !onLP(a, b));
  const n = { by: c, sk: p.sk, lv: p.lv, x, y, cells, until: t + (p.sk.duration[p.lv - 1] || 0), next: new Map() };
  W.dusts.push(n);
  emit('dust', n, t);
}
function dustOut(n, t) {
  W.dusts = W.dusts.filter(x => x !== n);
  emit('dustOut', n, t);
}
// Sanctuary (skills/acolyte/sanctuary.cpp, UNT_SANCTUARY: layout −1, the 5×5 round its cell without the corners, 21
// units of Range 1 and Interval 1000): for Duration1 (3.9 s + 3 s a level). Everyone within a cell of any of its cells,
// of either side, once a second at most and once for all the Sanctuaries it stands in (NoOverlap: one tick a skill,
// sanctNext), is touched by the first of its cells (in layout order) that reaches it: an unholy one (B.unholy: undead
// or a demon) that is an enemy of the caster takes the holy damage (B.SKILLS.PR_SANCTUARY) and is pushed 2 cells
// (Knockback) away from that cell, each such hit one of its Lv + 3 (`left`: it is gone when they run out); anyone
// else not at full HP gets B.sanctuaryHeal back, shown as a Heal (clif_skill_nodamage AL_HEAL). A character's takes a
// Blue Gemstone (ITEM_COST). It stays when its caster falls, but does no damage then.
const SANCT_LAYOUT = [[-1, -2], [0, -2], [1, -2], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1], [-2, 0], [-1, 0],
  [0, 0], [1, 0], [2, 0], [-2, 1], [-1, 1], [0, 1], [1, 1], [2, 1], [-1, 2], [0, 2], [1, 2]], SANCT_MS = 1000;
function placeSanctuary(c, p, [x, y], t) {
  const cells = SANCT_LAYOUT.map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b]) => field.open(a, b) && !onLP(a, b));
  const n = { by: c, sk: p.sk, lv: p.lv, x, y, cells, left: p.lv + 3, until: t + (p.sk.duration[p.lv - 1] || 0) };
  W.sancts.push(n);
  emit('sanct', n, t);
}
function sanctTurn(n, t) {
  const c = n.by;
  for (const u of units()) {
    if (!alive(u) || t < (W.sanctNext.get(u) ?? 0)) continue;
    const cell = n.cells.find(x => cheb(x, u.w.cell) <= 1);
    if (!cell) continue;
    W.sanctNext.set(u, t + SANCT_MS);
    const st = statusOf(u);
    if (B.unholy(st)) {
      if (u.side === c.side || c.dead != null) continue;
      const r = B.skillAttack(db, offense(c), defense(u), n.sk, n.lv);
      r.knock = { from: sameCell(cell, u.w.cell) ? null : { cell }, cells: n.sk.knockback[n.lv - 1] || 0 };
      schedule(r, c, u, t);
      if (--n.left <= 0) return sanctOut(n, t);
    } else if (u.hp < maxHp(u)) {
      healUnit(u, { type: 'heal', damage: B.sanctuaryHeal(n.lv) }, t, u.side === c.side ? c : null);
      emit('success', 'AL_HEAL', u.w, t);
    }
  }
}
function sanctOut(n, t) {
  W.sancts = W.sancts.filter(x => x !== n);
  emit('sanctOut', n, t);
}
// Magnus Exorcismus (skills/acolyte/magnusexorcismus.cpp, UNT_MAGNUS: layout −1, a cross 7 cells across with arms 3
// wide, 33 units of Range 1 and Interval 3000, Target Enemy): for Duration1 (3 s + 1 s a level). Every enemy of its
// caster within a cell of any of its cells (groundFoes), once every 3 s at most and once for all the ones it stands in
// (NoOverlap: magnusNext), takes the skill's damage (B.SKILLS.PR_MAGNUS: renewal hits any enemy, not only the undead and
// demons). A character's takes a Blue Gemstone (ITEM_COST). It stays when its caster falls, but does no damage then.
const MAGNUS_LAYOUT = [[-1, -3], [0, -3], [1, -3], [-1, -2], [0, -2], [1, -2],
  ...[-1, 0, 1].flatMap(dy => [-3, -2, -1, 0, 1, 2, 3].map(dx => [dx, dy])), [-1, 2], [0, 2], [1, 2], [-1, 3], [0, 3], [1, 3]], MAGNUS_MS = 3000;
function placeMagnus(c, p, [x, y], t) {
  const cells = MAGNUS_LAYOUT.map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b]) => field.open(a, b) && !onLP(a, b));
  const n = { by: c, sk: p.sk, lv: p.lv, x, y, cells, until: t + (p.sk.duration[p.lv - 1] || 0) };
  W.magni.push(n);
  emit('magnus', n, t);
}
function magnusTurn(n, t) {
  const c = n.by;
  if (c.dead != null) return;
  for (const u of groundFoes(c)) {
    if (t < (W.magnusNext.get(u) ?? 0) || !n.cells.some(x => cheb(x, u.w.cell) <= 1)) continue;
    W.magnusNext.set(u, t + MAGNUS_MS);
    schedule(B.skillAttack(db, offense(c), defense(u), n.sk, n.lv), c, u, t);
  }
}
function magnusOut(n, t) {
  W.magni = W.magni.filter(x => x !== n);
  emit('magnusOut', n, t);
}
// Bomb (skills/merchant/bomb.cpp, UNT_DEMONSTRATION: one unit of Range 1, Interval 500, Target Enemy): its fire on the
// cell for Duration1 (40 s + 5 s a level). Every enemy of its thrower within a cell of it (the 3×3) is hit once every
// 500 ms at most by each fire it stands in (skill_unitgrouptickset, a fire's own: `next`), a weapon attack of the
// skill's (B.SKILLS: 100 + 20 × Lv %, fire). Not within a cell of another fire (NoReiteration: skill_check_unit_range,
// the unit's Range for a player), nor of anyone alive standing there, the thrower too (NoFootSet, skill_nofootset 1:
// a player's) — checked as it goes off (skill_pos_maxcount_check): the skill fails then, its Bottle Grenade given back.
// A hit may break the monster's weapon (B.SKILLS breaks, rollBreak). A character's takes a Bottle Grenade
// (ITEM_COST). It stays when its thrower falls, but does no damage then.
const BOMB_MS = 500;
// ---------- the homunculus ----------
// An alchemist's homunculus (c.homun: { id (jobs.json homuns), state 'out', 'rest' or 'dead', unit (its monster while
// out), hp, sp (kept at rest), evolved (with the Stone of Sage: evolveHomun) and evoLv (its level then), used (its
// once-a-map skills, this map) }; the sandbox remembers which one it has, and whether evolved: sandbox.js savedOf). Out,
// it is a unit of the party's side as a summon is (summonFor: no EXP, no loot, not to be hit by the party, the monsters
// going for it — and keeping to it once they have it, hom_setting 0x04: mobTarget), of its level's figures
// (B.homunStatus): its master's base level, at most homunculus_max_level 99 (by choice: no EXP of its own, intimacy or
// hunger). Its skills: a point every third level (hom_levelup), spent by itself (homunLevels). What it does is the
// client's own AI (homunAi), its skills by the sandbox's rules (homunSkill). Out for SC_HOMUN_TIME (Duration1, 30 min,
// renewal) it goes to rest by itself; its master down, it does too if at 80 % of its HP or more
// (homunculus_auto_vapor), else it fights on. A map starts with it out at full HP if it was out, at rest or down as it
// was. Its HP and SP come back as a player's do (homunRegen).
const HOMUN_MAX_LV = 99, HOMUN_TIME_MS = 1800000, HOMUN_VAPOR = 80;
export const CONDENSED_RED = 545, STONE_OF_SAGE = 12040;
const homunDb = id => (db.homuns || []).find(h => h.id === id) || null;
// its monster: evolved, the _H's id, class and sprite (hom_change_class), its name the same
const homunDef = (h, lv, evolved = false) => ({ id: evolved ? h.evo.id : h.id, aegis: evolved ? h.evo.cls : h.cls, name: h.name, label: h.label,
  sprite: evolved ? h.evo.sprite : h.sprite, level: lv, skills: [], drops: [], baseExp: 0, jobExp: 0,
  ai: '00', modes: [], race: h.race, element: h.element, size: h.size });
// the skills of the party's that may heal a homunculus (by request: rAthena lets any; here only these, used on it by a
// click or by 自動's 血量比例最低的隊友 — Kyrie Eleison, for one, fails on it here)
export const HOMUN_HEALABLE = new Set(['AL_HEAL', 'AM_POTIONPITCHER']);
// the homunculi out of character c's party, in sight
const partyHomuns = c => crewOf(c).map(homunOf).filter(m => m && alive(m) && sees(c, m));
export const homunOf = c => { const m = c.homun && c.homun.unit; return m && m.dead == null && inFight(m) ? m : null; };
// the monsters character c's homunculus may be, for loading their sprites (sandbox.js): its own and what it evolves into,
// or any of the eight
export const homunMobs = c => !((c.levels || {}).AM_CALLHOMUN > 0) ? [] : (c.homun ? [homunDb(c.homun.id)] : db.homuns || []).filter(Boolean)
  .flatMap(h => c.homun ? [homunDef(h, 1), homunDef(h, 1, true)] : [homunDef(h, 1)]);
// its level: its master's base level, at most HOMUN_MAX_LV
export const homunLv = c => Math.min(c.blv, HOMUN_MAX_LV);
// The levels of its skills (hom_levelup: a point at every third level), spent by itself (by request: as the job's
// skill builds, its tree's order): each point on the first of its skills, in homunculus_db's order, below its top
// level with those it needs first learned (Required); its evolved one only once evolved (RequireEvolution; by request no
// intimacy asked), and from then on first. The points it had at evolving (evoLv) stay where they went; any it had no
// skill for then go to the evolved one.
export function homunLevels(c) {
  const h = c.homun && homunDb(c.homun.id);
  if (!h) return {};
  const lv = homunLv(c), all = Math.trunc(lv / 3), before = c.homun.evolved ? Math.min(all, Math.trunc((c.homun.evoLv ?? lv) / 3)) : all;
  const out = {}, evolved = !!c.homun.evolved;
  const ok = ([n, max, req, evo]) => (out[n] || 0) < max && (!evo || evolved) && Object.entries(req).every(([r, l]) => (out[r] || 0) >= l);
  for (let i = 0; i < all; i++) {
    const sk = (i >= before && h.skills.find(x => x[3] && ok(x))) || h.skills.find(x => !x[3] && ok(x)) || h.skills.find(ok);
    if (sk) out[sk[0]] = (out[sk[0]] || 0) + 1;
  }
  return out;
}
// (what each of its master's skills asks: none out to call one back, one out to put to rest and at 80 % of its HP, one
// down to bring back; one to be made or called needs its sprite in)
const HOMUN_SKILLS = {
  AM_CALLHOMUN: c => c.isPc && (!c.homun || c.homun.state === 'rest') && homunMobs(c).every(inSprites),
  AM_REST: c => { const m = c.isPc && homunOf(c); return !!m && m.hp * 100 >= m.st.maxHp * HOMUN_VAPOR; },
  AM_RESURRECTHOMUN: c => c.isPc && !!c.homun && c.homun.state === 'dead',
};
// homunculus m's figures again (as mobRecalc is for any other): its level, skills and statuses (B.homunStatus), walking
// as its master does (hom_setting 0x08), then what other statuses on it change (B.mobBuffed)
function homunRecalc(m) {
  const c = m.owner, k = c.homun, h = homunDb(k.id);
  const st = B.homunStatus(h, homunLv(c), c.pc.walkSpeed, { evolved: k.evolved, levels: m.homunLevels || {},
    sc: m.sc.filter(s => W.t < s.until && B.HOMUN_BUFFS.includes(s.name)) });
  m.st = st;
  m.base = { amotion: st.amotion, adelay: st.adelay, walkSpeed: st.walkSpeed, hit: st.hit, flee: st.flee, def: st.def, batk: st.batk };
  const on = m.sc.filter(s => W.t < s.until && B.MOB_BUFFS.includes(s.name));
  if (on.length) Object.assign(m.st, B.mobBuffed(m.base, on));
  m.hp = Math.min(m.hp, st.maxHp);
  m.sp = Math.min(m.sp ?? st.maxSp, st.maxSp);
  m.w.cellMs = m.st.walkSpeed;
}
function spawnHomun(c, at, t, pct = null) {
  const h = homunDb(c.homun.id), k = c.homun, levels = homunLevels(c);
  const st = B.homunStatus(h, homunLv(c), c.pc.walkSpeed, { evolved: k.evolved, levels });
  const m = addMob(homunDef(h, st.lv, k.evolved), at);
  Object.assign(m, { side: c.side, master: c, owner: c, homun: true, aggressive: false, restAt: t + HOMUN_TIME_MS, homunLevels: levels, homunCd: {} });
  m.hp = pct != null ? Math.max(1, Math.trunc(st.maxHp * pct / 100)) : Math.min(k.hp ?? st.maxHp, st.maxHp);
  m.sp = pct != null ? st.maxSp : Math.min(k.sp ?? st.maxSp, st.maxSp);
  homunRecalc(m);
  Object.assign(k, { state: 'out', unit: m });
  emit('spawn', m, t);
  return m;
}
function homunRest(c, t) {
  const m = homunOf(c);
  if (!m) return;
  Object.assign(c.homun, { state: 'rest', unit: null, hp: m.hp, sp: m.sp });
  removeMob(m);
}
// The Stone of Sage (item_db Stone_Of_Intelligence_, homevolution): character c's homunculus, out, evolves
// (hom_evolution) — by request at any time, with no intimacy asked; one evolved already, nothing. Its stone used up from
// the party's bag. Out on the field it turns into its _H there (its sprite: sandbox.js loads it with the other), its
// figures again with what evolving adds (B.homunStatus), its HP as it was. → whether it did
export const canEvolve = c => !!c.homun && !c.homun.evolved && c.homun.state === 'out' && (purse(c).bag[STONE_OF_SAGE] || 0) >= 1;
export function evolveHomun(c) {
  if (!canEvolve(c)) return false;
  const h = homunDb(c.homun.id), m = c.homun.unit;
  if (m && !inSprites(homunDef(h, 1, true))) return false;
  useItem(c, STONE_OF_SAGE);
  Object.assign(c.homun, { evolved: true, evoLv: homunLv(c) });
  emit('homun', c);
  if (m && alive(m)) {
    m.homunLevels = homunLevels(c);
    m.def = homunDef(h, homunLv(c), true);
    homunRecalc(m);
    emit('morph', m, W.t);
    emit('hp', m);
  }
  return true;
}
// a homunculus's HP and SP back (status_natural_heal, BL_HOM: as a player's, every natural_healhp_interval /
// natural_healsp_interval, HP not while walking; its amounts B.homunStatus' hpRegen / spRegen)
function homunRegen(m, t) {
  m.regen ??= { hp: t, sp: t };
  let changed = false;
  if (t - m.regen.hp >= B.HP_REGEN_MS) {
    m.regen.hp = t;
    if (!m.w.moving && m.hp < m.st.maxHp) { m.hp = Math.min(m.st.maxHp, m.hp + m.st.hpRegen); changed = true; }
  }
  if (t - m.regen.sp >= B.SP_REGEN_MS) {
    m.regen.sp = t;
    if (m.sp < m.st.maxSp) { m.sp = Math.min(m.st.maxSp, m.sp + m.st.spRegen); changed = true; }
  }
  if (changed) emit('hp', m);
}
// The client's default homunculus AI (AI.lua): it keeps near its master, goes for what its master attacks, for what
// attacks its master or itself, and hits back (as any monster); nothing on its own (not aggressive). Its master gone
// or down, it stays where it is and fights what comes. Its skills by homunSkill, once a second at most (as a monster's,
// MOB_SKILL_MS), not mid-attack. → true when that was its turn, false when its master is not there to follow (slaveAi),
// null for the rest of slaveAi
function homunAi(m, t) {
  const ma = m.master;
  homunRegen(m, t);
  if (!inFight(ma) || ma.dead != null) return false;
  if (!m.target) {
    const foe = enemies(m).filter(x => alive(x) && (x.target === ma || x.target === m) && field.distance(m.w, x.w) <= m.st.viewRange)
      .sort((a, b) => field.distance(m.w, a.w) - field.distance(m.w, b.w))[0];
    if (foe) m.target = foe;
  }
  if (!m.cast && !(busy(m.anim, t) && m.anim.grp === 2) && t >= (m.homunNext || 0)) {
    m.homunNext = t + MOB_SKILL_MS;
    const p = homunSkill(m, t);
    if (p) {
      m.homunCd[p.sk.name] = t + (p.sk.cooldown[p.lv - 1] || 0);
      if (ONCE_A_MAP.has(p.sk.name)) ma.homun.used[p.sk.name] = true;
      fireSkill(m, p, t);
      return true;
    }
  }
  return null;  // (then as a slave: follow, its master's target)
}
// What a homunculus uses next (by request, the sandbox's own rules; the client's AI.lua uses none): the first of its
// skills learned (homunLevels), off cooldown, with the SP and, for Healing Hands, a Condensed Red Potion in the bag, that
// its rule asks for now — its master below 60 % of its HP (Healing Hands, Chaotic Blessings: or itself), its master below
// 40 % with a monster after it (Castling), a monster after its master or itself (Urgent Escape, Amistr Bulwark,
// Accelerated Flight), a target (Bloodlust, Flitting; Mental Change at a big one, ten times its own MaxHP or more), its
// target in reach and in sight (Moonlight, Caprice; S.B.R.44 once a map, at one with half its damage's HP
// or more), Bio Explosion once a map below 25 % of its HP with an enemy within its reach — each status skill not while
// its status is on. → { sk, lv, target } or null
const CAPRICE = ['MG_COLDBOLT', 'MG_FIREBOLT', 'MG_LIGHTNINGBOLT', 'WZ_EARTHSPIKE'];
const CHAOTIC_SELF = [20, 50, 25, 50, 34], CHAOTIC_MASTER = [30, 10, 50, 4, 33];
const ONCE_A_MAP = new Set(['HFLI_SBR44', 'HVAN_EXPLOSION']);
const HOMUN_RULES = [
  ['HVAN_EXPLOSION', (m, lv, sk) => m.hp * 100 < m.st.maxHp * 25 && units().some(x => alive(x) && x.side !== m.side && !hidden(x) && field.distance(x.w, m.w) <= (sk.splash[lv - 1] || 0)) && m],
  ['HLIF_HEAL', m => hpPct(m.master) < 60 && (purse(m).bag[CONDENSED_RED] || 0) >= 1 && m.master],
  ['HVAN_CHAOTIC', m => (hpPct(m.master) < 60 || hpPct(m) < 60) && m],
  ['HAMI_CASTLE', m => hpPct(m.master) < 40 && units().some(x => alive(x) && x.side !== m.side && x.target === m.master) && m.master],
  ['HLIF_AVOID', m => chased(m) && m],
  ['HAMI_DEFENCE', m => chased(m) && m],
  ['HFLI_SPEED', m => chased(m) && m],
  ['HAMI_BLOODLUST', m => m.target && m],
  ['HFLI_FLEET', m => m.target && m],
  ['HLIF_CHANGE', m => m.target && alive(m.target) && maxHp(m.target) >= 10 * m.st.maxHp && m],
  ['HFLI_SBR44', (m, lv) => homunReach(m, lv, 'HFLI_SBR44') && m.target.hp * 2 >= 100000 * lv && m.target],
  ['HFLI_MOON', (m, lv) => homunReach(m, lv, 'HFLI_MOON') && m.target],
  ['HVAN_CAPRICE', (m, lv) => homunReach(m, lv, 'HVAN_CAPRICE') && m.target],
];
const hpPct = u => alive(u) ? u.hp * 100 / maxHp(u) : 100;
// a monster is after homunculus m or its master
const chased = m => units().some(x => alive(x) && x.side !== m.side && (x.target === m || x.target === m.master));
const homunReach = (m, lv, name) => !!m.target && alive(m.target) && sees(m, m.target) && field.distance(m.w, m.target.w) <= mobRange(db.skills[name], lv)
  && field.sees(m.w.cell, m.target.w.cell);
function homunSkill(m, t) {
  const levels = m.homunLevels || {}, used = m.owner.homun.used || (m.owner.homun.used = {});
  for (const [name, rule] of HOMUN_RULES) {
    const lv = levels[name], sk = db.skills[name];
    if (!lv || !sk || t < (m.homunCd[name] || 0) || used[name]) continue;
    if (B.HOMUN_BUFFS.includes(name) && has(m, name)) continue;
    if ((sk.sp[lv - 1] || 0) > m.sp) continue;
    const target = rule(m, lv, sk);
    if (target) return { sk, lv, target };
  }
  return null;
}

// ---------- the alchemist's summons ----------
// Bio Cannibalize (skills/merchant/summonflora.cpp) and Sphere Mine (summonmarinesphere.cpp): the monster of the skill's
// level (SUMMONS) on the cell (mob_once_spawn_sub), the caster's (master_id, special_state.ai): of its side, giving
// no EXP or loot, gone (mob_timer_delete: no death) after the skill's Duration1 — Bio Cannibalize's 5 min down to 1 at
// Lv 5, Sphere Mine's 30 s — or as its master goes down (slaveAi). The party cannot hit it (alchemist_summon_setting 12,
// renewal: neither 1 nor 2); the other monsters go for it as for the party. rAthena's slaves_inherit_mode 4 would
// give it the slave mode (CanMove, CanAttack): here it keeps its own (by choice: the plants have no walk to draw), the
// plants standing where they are and going for any foe within sight (Ai 10), the Marine Sphere doing nothing but its
// skills (Ai 06). As many out of the one kind as the skill allows (6 − Lv plants of that level's kind, none while one
// of another kind is out: alchemist_summon_setting 4; 3 spheres, ActiveInstance), else it fails (summonFail).
const SUMMONS = { AM_CANNIBALIZE: lv => [1589, 1579, 1575, 1555, 1590][lv - 1], AM_SPHEREMINE: () => 1142 };
const summonMax = (name, lv) => name === 'AM_CANNIBALIZE' ? 6 - lv : 3, MIN_WALK_MS = 20;  // (MIN_WALK_SPEED)
const summonsOf = (c, name) => W.mobs.filter(m => m.owner === c && m.summonedBy === name && alive(m));
// the monsters character c's summons may be, for loading their sprites (sandbox.js)
export const alchemistMobs = c => Object.entries(SUMMONS).filter(([n]) => (c.levels || {})[n] > 0)
  .flatMap(([n, id]) => [1, 2, 3, 4, 5].slice(0, c.levels[n]).map(lv => mobDef(id(lv)))).filter(Boolean);
function summonFail(c, name, lv) {
  const id = SUMMONS[name](lv), out = summonsOf(c, name), def = mobDef(id);
  if (!def || !inSprites(def)) return '技能使用失敗';
  return out.filter(m => m.def.id === id).length >= summonMax(name, lv) || (name === 'AM_CANNIBALIZE' && out.some(m => m.def.id !== id)) ? '技能使用失敗' : null;
}
// (by request, not in rAthena) Bio Cannibalize fails on a cell someone stands on (the monster it is for, a plant, anyone)
// or one a plant's bottle is flying to
const plantCellTaken = p => units().some(u => alive(u) && sameCell(u.w.cell, p)) || W.later.some(x => x.cell && sameCell(x.cell, p));
// the cell character c plants for monster m (by request): one next to it it can be (plantCellTaken), in reach and in
// sight, the nearest to c; null when none
function plantCell(c, m, lv) {
  const reach = B.skillRange(db.skills.AM_CANNIBALIZE, lv, attacker(c)), [mx, my] = m.w.cell;
  let best = null, k = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const p = [mx + dx, my + dy], d = cheb(p, c.w.cell);
    if ((!dx && !dy) || d > reach || d >= k || !field.open(...p) || !field.sees(c.w.cell, p) || plantCellTaken(p)) continue;
    best = p; k = d;
  }
  return best;
}
function summonFor(c, p, cell, t) {
  const def = mobDef(SUMMONS[p.sk.name](p.lv));
  const m = addMob({ ...def, baseExp: 0, jobExp: 0, drops: [] }, cell);
  Object.assign(m, { side: c.side, master: c, owner: c, summonedBy: p.sk.name, expires: t + (p.sk.duration[p.lv - 1] || 0), aggressive: false });
  if (p.sk.name === 'AM_CANNIBALIZE') c.plantLv = null;
  emit('success', p.sk.name, m.w, t);  // (its bottle breaking there, stage.js)  // (the next plant with none out: rolled again, plantLevel)
  emit('spawn', m, t);
}
// (a character's: checked as it goes off, as rAthena does, its fire on the ground once the bottle lands at mo.at:
// sim.js SKILL_USE flight, the bottle drawn flying meanwhile, stage.js; not if the thrower is gone by then)
function placeBomb(c, p, [x, y], t, mo = null) {
  if (onLP(x, y)) return giveBack(c, FIRE_BOTTLE), say(c.w, '技能使用失敗', t);
  const reach = c.isPc ? 1 : 0;
  if (W.bombs.some(n => cheb([n.x, n.y], [x, y]) <= reach) || (c.isPc && units().some(u => alive(u) && inFight(u) && cheb(u.w.cell, [x, y]) <= 1)))
    return giveBack(c, FIRE_BOTTLE), say(c.w, '技能使用失敗', t);
  throwLater(c, p, p.target.w, t, mo, at => {
    const n = { by: c, sk: p.sk, lv: p.lv, x, y, until: at + (p.sk.duration[p.lv - 1] || 0), next: new Map() };
    W.bombs.push(n);
    emit('bomb', n, at);
  });
}
// An alchemist's bottle (by request): thrown at w (a spot or a unit) as the skill goes off, `run` once it gets there at
// mo.at (SKILL_USE flight: drawn flying meanwhile, stage.js bolts) — not if the thrower is gone by then, nor the one
// it is thrown at (`to`); at once with no flight (a monster's)
// (`cell`: the cell it lands on, kept on the way: plantCellTaken)
function throwLater(c, p, w, t, mo, run, to = c, cell = null) {
  const land = mo && mo.at > t ? mo.at : t;
  if (land <= t) return run(t);
  emit('bolts', p.lv && p.sk.name === 'AM_POTIONPITCHER' ? `${p.sk.name}_${p.lv}` : p.sk.name, w, t, land, 1, 0, c.w);
  W.later.push({ at: land, by: c, to, cell, run: () => run(land) });
}
function bombTurn(n, t) {
  const c = n.by;
  if (c.dead != null) return;
  for (const u of groundFoes(c)) {
    if (t < (n.next.get(u) ?? 0) || cheb([n.x, n.y], u.w.cell) > 1) continue;
    n.next.set(u, t + BOMB_MS);
    const r = B.skillAttack(db, offense(c), defense(u), n.sk, n.lv);
    if (r.damage > 0) rollBreak(n.sk, n.lv, r);
    schedule(r, c, u, t);
  }
}
function bombOut(n, t) {
  W.bombs = W.bombs.filter(x => x !== n);
  emit('bombOut', n, t);
}
// Storm Gust (skills/mage/stormgust.cpp, renewal; a UNT_DUMMYSKILL unit of layout 4, 9×9 cells, each of Range 1,
// Interval 450, Target Enemy, NoOverlap, PathCheck): for Duration1 (4.5 s), its cells those not a wall that a line from
// the user reaches (skill_unitsetting). Every enemy within a cell of one of them, in sight of it, is hit once every
// 450 ms at most, by all the Storm Gusts it stands in together (NoOverlap: stormNext), by the first such cell in the
// layout's order (south-west first, west to east: skill_init_unit_layout): 70 + 50 × Lv % magic, water (B.SKILLS),
// knocked back 2 cells away from that cell (stormgust_knockback yes: skill_blown from the unit; one on it goes back
// against its own facing), each one hit with damage frozen at 65 − 5 × Lv % for Duration2. One frozen is not hit
// (status_check_skilluse). It stays when its user falls, but does no damage then (as Magnus Exorcismus).
const STORM_MS = 450, STORM_LAYOUT = [-4, -3, -2, -1, 0, 1, 2, 3, 4].flatMap(dy => [-4, -3, -2, -1, 0, 1, 2, 3, 4].map(dx => [dx, dy]));
function placeStorm(c, p, [x, y], t) {
  const cells = STORM_LAYOUT.map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b]) => field.open(a, b) && field.sees(c.w.cell, [a, b]) && !onLP(a, b));
  const n = { by: c, sk: p.sk, lv: p.lv, x, y, cells, until: t + (p.sk.duration[p.lv - 1] || 0) };
  W.storms.push(n);
  emit('storm', n, t);
}
function stormTurn(n, t) {
  const c = n.by, freezes = B.SKILLS[n.sk.name].freeze;
  if (c.dead != null) return;
  for (const u of groundFoes(c)) {
    if (u.frozen || t < (W.stormNext.get(u) ?? 0)) continue;
    const cell = n.cells.find(x => cheb(x, u.w.cell) <= 1 && field.sees(x, u.w.cell));
    if (!cell) continue;
    W.stormNext.set(u, t + STORM_MS);
    const r = B.skillAttack(db, offense(c), defense(u), n.sk, n.lv);
    r.knock = { from: sameCell(cell, u.w.cell) ? null : { cell }, cells: n.sk.knockback[n.lv - 1] || 0 };
    if (r.damage > 0) {
      const o = B.freezeOdds(statusOf(c), statusOf(u), freezes(n.lv, offense(c)), n.sk.duration2[n.lv - 1] || 0);
      if (rnd(10000) < o.chance * 100) r.freeze = o.ms;
    }
    schedule(r, c, u, t);
  }
}
function stormOut(n, t) {
  W.storms = W.storms.filter(x => x !== n);
  emit('stormOut', n, t);
}
// Quagmire (skills/mage/quagmire.cpp, UNT_QUAGMIRE: layout 2, 5×5 cells, Interval −1, Target Enemy, PathCheck; the
// skill TargetHidden): for Duration1 (5 s a level), its cells those not a wall that a line from the user reaches. An
// enemy on one of them (the hidden too, not the cloaked), not under SC_QUAGMIRE already, gets it for the unit's whole
// Duration1 from then (skill_unit_onplace: sc_start4 at 100% with sg->limit; nothing resists it, a boss neither): see
// B.quagmired and paceOf. A character loses it as it steps off (skill_unit_onleft; and as the unit goes), a monster
// keeps it to its end. Going on, it ends Increase AGI, Improve Concentration, Loud Exclamation, Two-Hand Quicken and
// Adrenaline Rush (status.yml EndOnStart), and those fail on one under it (QUAG_FAIL; not Two-Hand Quicken or Loud).
// At most QUAG_MAX of one's own at once (ActiveInstance 3), the oldest going. It stays when its user falls but does
// nothing then (as fire walls).
const QUAG_MAX = 3, QUAG_ENDS = ['AL_INCAGI', 'AC_CONCENTRATION', 'MC_LOUD', 'KN_TWOHANDQUICKEN', 'BS_ADRENALINE', 'CR_SPEARQUICKEN'];
const QUAG_FAIL = ['AL_INCAGI', 'AC_CONCENTRATION', 'BS_ADRENALINE', 'BA_ASSASSINCROSS', 'CR_SPEARQUICKEN'];
const quagFail = (u, name) => QUAG_FAIL.includes(name) && has(u, 'WZ_QUAGMIRE');
function placeQuag(c, p, [x, y], t) {
  const own = W.quags.filter(n => n.by === c);
  if (own.length >= QUAG_MAX) quagOut(own[0], t);  // (skill_unitsetting: the oldest group past ActiveInstance goes)
  const cells = STORM_LAYOUT.filter(([dx, dy]) => Math.abs(dx) <= 2 && Math.abs(dy) <= 2).map(([dx, dy]) => [x + dx, y + dy])
    .filter(([a, b]) => field.open(a, b) && field.sees(c.w.cell, [a, b]) && !onLP(a, b));
  const n = { by: c, sk: p.sk, lv: p.lv, x, y, cells, ms: p.sk.duration[p.lv - 1] || 0 };
  n.until = t + n.ms;
  W.quags.push(n);
  emit('quag', n, t);
}
const onQuag = (n, u) => n.cells.some(x => sameCell(x, u.w.cell));
function quagTurn(n, t) {
  const c = n.by;
  // a character off the cells of the one it got it from loses it (skill_unit_onleft: a monster does not)
  for (const u of allChars()) if (u.sc.some(s => s.name === 'WZ_QUAGMIRE' && s.from === n) && !onQuag(n, u)) endStatus(u, 'WZ_QUAGMIRE');
  if (c.dead != null) return;
  for (const u of units()) {
    if (u.side === c.side || !alive(u) || cloaked(u) || has(u, 'WZ_QUAGMIRE') || !onQuag(n, u)) continue;
    for (const name of QUAG_ENDS) endStatus(u, name);
    addStatus(u, n.sk, n.lv, t, null, n.ms);
    u.sc.find(s => s.name === 'WZ_QUAGMIRE').from = n;
  }
}
function quagOut(n, t) {
  W.quags = W.quags.filter(x => x !== n);
  for (const u of allChars()) if (u.sc.some(s => s.name === 'WZ_QUAGMIRE' && s.from === n)) endStatus(u, 'WZ_QUAGMIRE');
  emit('quagOut', n, t);
}
// The sage's element fields (skills/mage/volcano.cpp, deluge.cpp, whirlwind.cpp: Unit layout 3, 7×7, Interval −1, Target
// All, PathCheck) for Duration1: whoever stands on one of its cells (either side) has its status (B.BUFF_SKILLS) while
// there (skill_unit_onplace: sc_start unless it has it already; skill_unit_onout ends it), not on Land Protector's. A
// sage has one at a time (skill_clear_group flag 1: Land Protector too); one of the three going down while another of
// the three is still on keeps its time left and takes no Blue Gemstone (skill_unitsetting, SKILL_NOCONSUME_REQ).
// Land Protector (magneticearth.cpp: 7×7, 9×9 at Lv 3–4, 11×11 at 5): ground skills' cells on it go as it goes down
// (skill_cell_overlap: everything but traps; another Land Protector, both go — here a whole unit if any of its cells is
// on it), and none are set on it while it lasts (placeWall and the others: Fire Pillar, Safety Wall, Pneuma, Warp
// Portal and Fiber Lock fail there); the magic of one that falls on an area (Thunderstorm, Heaven's Drive, Lord of
// Vermilion, Meteor Storm, Frost Nova: units in renewal) does not reach one standing on it (skill_unit_onplace_timer).
// Songs left as they are.
const FIELDS = ['SA_VOLCANO', 'SA_DELUGE', 'SA_VIOLENTGALE'];
const fieldReach = (name, lv) => name === 'SA_LANDPROTECTOR' ? [3, 3, 4, 4, 5][lv - 1] || 3 : 3;
export const onLP = (x, y) => W.fields.some(n => n.sk.name === 'SA_LANDPROTECTOR' && n.cells.some(([a, b]) => a === x && b === y));
const onField = (n, u) => n.cells.some(x => sameCell(x, u.w.cell));
function placeField(c, p, [x, y], t) {
  const name = p.sk.name, r = fieldReach(name, p.lv), own = W.fields.filter(n => n.by === c);
  let ms = p.sk.duration[p.lv - 1] || 0;
  if (FIELDS.includes(name)) {
    const old = own.find(n => FIELDS.includes(n.sk.name) && t < n.until);
    if (old) { ms = old.until - t; giveBack(c, BLUE_GEM); }
    for (const n of own) fieldOut(n, t);
  }
  let cells = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) cells.push([x + dx, y + dy]);
  cells = cells.filter(([a, b]) => field.open(a, b) && field.sees(c.w.cell, [a, b]));
  if (name === 'SA_LANDPROTECTOR') {
    const hit = n => n.cells.some(([a, b]) => cells.some(([e, f]) => a === e && b === f));
    const lp = W.fields.filter(n => n.sk.name === 'SA_LANDPROTECTOR' && hit(n));
    if (lp.length) { for (const n of lp) fieldOut(n, t); return; }  // (two of them: both go)
    clearUnder(cells, t);
  } else cells = cells.filter(([a, b]) => !onLP(a, b));
  if (!cells.length) return say(c.w, '技能使用失敗', t);
  const n = { by: c, sk: p.sk, lv: p.lv, x, y, cells, until: t + ms };
  W.fields.push(n);
  emit('field', n, t);
  if (FIELDS.includes(name)) fieldTurn(n, t);
}
// Land Protector going down on `cells`: the ground skills there go (but traps)
function clearUnder(cells, t) {
  const on = ([a, b]) => cells.some(([e, f]) => a === e && b === f), any = n => (n.cells || []).some(x => on(Array.isArray(x) ? x : [x.x, x.y]));
  for (const wall of W.walls) for (const x of wall.cells.filter(x => on([x.x, x.y]))) { emit('cellOut', [x.x, x.y], t); wall.cells = wall.cells.filter(y => y !== x); }
  W.walls = W.walls.filter(w => w.cells.length);
  for (const n of [...W.ices]) if (any(n)) iceTurn(n, t, true);
  for (const g of [...W.guards]) if (on([g.x, g.y])) guardOut(g, t);
  for (const n of [...W.pneumas]) if (cells.some(x => cheb(x, [n.x, n.y]) <= 1)) pneumaOut(n, t);
  for (const n of [...W.warps]) if (on([n.x, n.y])) warpOut(n, t);
  for (const n of [...W.traps]) if (n.sk.name === 'WZ_FIREPILLAR' && on([n.x, n.y])) trapOut(n, t);
  for (const n of [...W.webs]) if (on([n.x, n.y])) webOut(n, t);
  for (const n of [...W.dusts]) if (any(n)) dustOut(n, t);
  for (const n of [...W.sancts]) if (any(n)) sanctOut(n, t);
  for (const n of [...W.magni]) if (any(n)) magnusOut(n, t);
  for (const n of [...W.bombs]) if (on([n.x, n.y])) bombOut(n, t);
  for (const n of [...W.storms]) if (any(n)) stormOut(n, t);
  for (const n of [...W.quags]) if (any(n)) quagOut(n, t);
  for (const n of [...W.fields]) if (any(n)) fieldOut(n, t);
}
function fieldTurn(n, t) {
  if (!FIELDS.includes(n.sk.name)) return;
  const name = n.sk.name;
  for (const u of units()) {
    const s = u.sc.find(x => x.name === name);
    if (s && s.from === n && !onField(n, u)) endStatus(u, name);
    else if (!s && alive(u) && inFight(u) && onField(n, u)) {
      addStatus(u, n.sk, n.lv, t, null, n.until - t);
      u.sc.find(x => x.name === name).from = n;
    }
  }
}
function fieldOut(n, t) {
  W.fields = W.fields.filter(x => x !== n);
  for (const u of units()) if (u.sc.some(s => s.name === n.sk.name && s.from === n)) endStatus(u, n.sk.name);
  emit('fieldOut', n, t);
}
// whether cell (x, y) is water (CELL_CHKWATER): the floors here carry none (setFloor), so never
const waterAt = (x, y) => false;
// a character's Water Ball at cell `at`: the cells within `size` of it that are water, or a Deluge's — those Deluges
// losing them (one losing its last goes down; who stood on a lost one loses its status) — counted, one ball each
function drinkDeluge([x, y], size, t) {
  const near = ([a, b]) => Math.abs(a - x) <= size && Math.abs(b - y) <= size;
  const wet = new Set();
  for (let dy = -size; dy <= size; dy++) for (let dx = -size; dx <= size; dx++) if (waterAt(x + dx, y + dy)) wet.add(`${x + dx},${y + dy}`);
  for (const n of W.fields.filter(n => n.sk.name === 'SA_DELUGE' && t < n.until)) {
    const took = n.cells.filter(near);
    if (!took.length) continue;
    for (const c of took) wet.add(c.join());
    emit('fieldOut', n, t);
    n.cells = n.cells.filter(c => !near(c));
    if (!n.cells.length) { fieldOut(n, t); continue; }
    emit('field', n, t);  // (drawn again on what is left)
    fieldTurn(n, t);
  }
  return wet.size;
}
// Fiber Lock (skills/mage/fiberlock.cpp; Unit Interval −1, so it acts only as it is set down: skill_unit_onplace): a
// web on the target's cell (splash 0), for Duration1 (16 s), catching every enemy of the user standing on that cell
// (SC_SPIDERWEB at 100%, nothing resisting it: SCSTART_NORATEDEF). Caught, a unit cannot walk (NoMove, StopWalking:
// grid.js Mover.rooted) and has half its FLEE (status_calc_flee: B.webbed); a fire attack on it does double
// (battle_attr_fix, renewal: + 100 to the element's %: B.attrOf) and burns away the web with the least time left
// (status_change_end SC_SPIDERWEB). Webs on one unit (val1, at most three: val2–val4 their groups): the first holds it
// Duration2 (8 s), the second 16 s, the third 8 (outside PvP × (val1 + 1) while val1 < 2), never less than it had left,
// and the web lasts as long as that (the group's limit); a web on one held by three goes at once. The status ends
// when the last of its webs goes, or its time is up. Walking onto a web later does nothing (skill_unit_move_sub). The
// Spider Web it needs is not asked for. Its setter's go when it does (removeMob).
function placeWeb(c, p, [x, y], t) {
  if (onLP(x, y)) return say(c.w, '技能使用失敗', t);
  const n = { by: c, sk: p.sk, lv: p.lv, x, y, until: t + (p.sk.duration[p.lv - 1] || 0), on: [] };
  W.webs.push(n);
  const base = p.sk.duration2[p.lv - 1] || 0;
  for (const u of groundFoes(c)) {
    if (!sameCell(u.w.cell, [x, y])) continue;
    const s = u.webbed;
    if (s && s.webs.length >= 3) { n.until = t; continue; }  // (already triple affected: immune)
    const ms = s ? Math.max(s.until - t, base * (s.n < 2 ? s.n + 1 : 1)) : base;
    u.webbed = { until: t + ms, n: (s ? s.n : 0) + 1, webs: [...s ? s.webs : [], n] };
    n.on.push(u);
    n.until = t + ms;
    u.w.stop();
    root(u);
    if (u.isPc) recalc(u);
    emit('webbed', u, t);
  }
  emit('web', n, t);
  if (t >= n.until) webOut(n, t);
}
// web n goes (its time is up, burned, or its setter gone): off whoever it holds, whose status ends with its last web
function webOut(n, t) {
  W.webs = W.webs.filter(x => x !== n);
  emit('webOut', n, t);
  for (const u of n.on) {
    if (!u.webbed || !u.webbed.webs.includes(n)) continue;
    u.webbed.webs = u.webbed.webs.filter(x => x !== n);
    if (!u.webbed.webs.length) unweb(u, t);
  }
}
function unweb(u, t) {
  u.webbed = null;
  root(u);
  if (u.isPc) recalc(u);
  emit('unwebbed', u, t);
}
// a fire hit on unit u, held by webs: the one with the least time left burns away (status_change_end SC_SPIDERWEB)
function burnWeb(u, t) {
  const n = u.webbed.webs.reduce((a, b) => b.until < a.until ? b : a);
  webOut(n, t);
}
// whether unit u can walk: not while held by Stop, a web or Ankle Snare (NoMove)
// (no walker: off the floor — by report, a 對戰's replay ending the ails it was left with — enter gives it a new one)
function root(u) { if (u.w) u.w.rooted = !!(u.stopped || u.webbed || u.snared || u.held || u.confined || W.songs.some(n => n.with && (n.by === u || n.with === u))); }
// Close Confine on unit u (DOES.confine), as time goes on: the hold on a monster ends with its time, its holder gone
// or no longer holding, or it moved off its cell (map_moveblock: knocked back, teleported); the user's with its time,
// hiding (by the client's description), moving off its cell (Back Slide, a teleport, a Fly Wing) or none held any
// more (status_change_end: the count down to 0). Either one holding keeps it from walking (root).
function confineTick(u, t) {
  const held = u.sc.find(s => s.name === 'RG_CLOSECONFINE2' && t < s.until);
  if (held && (!alive(held.holder) || !has(held.holder, 'RG_CLOSECONFINE') || !sameCell(u.w.cell, held.cell))) endStatus(u, 'RG_CLOSECONFINE2');
  const own = u.sc.find(s => s.name === 'RG_CLOSECONFINE' && t < s.until);
  if (own && (hidden(u) || !alive(u) || !sameCell(u.w.cell, own.cell) || !units().some(x => alive(x) && x.sc.some(s => s.name === 'RG_CLOSECONFINE2' && s.holder === u && t < s.until))))
    endStatus(u, 'RG_CLOSECONFINE');
  const on = has(u, 'RG_CLOSECONFINE') || has(u, 'RG_CLOSECONFINE2');
  if (on !== !!u.confined) { u.confined = on; root(u); }
}
// unit u cannot walk till time `until` (unit_set_walkdelay with a skill's delay: Fire Pillar's), its walk stopped; it
// still attacks and casts. Not a status (nothing shown).
function holdWalk(u, until) {
  if ((u.held || 0) >= until) return;
  u.held = until;
  u.w.stop();
  root(u);
}
// Unit u goes to a random free cell of the floor (Teleport; a warp portal; a monster's Teleport): whoever was
// after it keeps after it, as far as it chases (a monster: chaseRange), but what was on its way to it misses
// (battle_delay_damage_sub: too far now). It stops what it was doing: a character its attack and skill (and
// stands as it lands, out of its battle stance: by request), a monster drops its target. roBrowser shows the teleport effect where it was (EF_TELEPORTATION2).
// `cast`: by its own Teleport skill (sandbox.js: the figure left behind is casting). `to`: onto that cell instead
// (Snatch's); `keep`: a monster keeps its target (Snatch's, the user by it)
// (a character with `keep`: it keeps its target and stance, and `pose`, {group, fi}, is the frame it leaves in:
// Snatch's)
function teleportUnit(u, t, cast = false, to = null, keep = false, pose = null) {
  emit('teleport', u, field.spot(...u.w.cell), t, cast, pose);
  if (to) { u.w.stop(); u.w.spawn(field.map, ...to); } else field.teleport(u.w);
  W.hits = W.hits.filter(h => h.to !== u);
  W.shots = W.shots.filter(a => a.to !== u);
  for (const x of units()) if (x.cast && x.cast.target === u) x.cast = null;
  if (u.isPc) { if (!keep) { disengage(u); u.alert = false; } }
  else if (!keep) unlockTarget(u, t);
}
// a safety wall gone (its hits or HP used up, its time up, or all of them: the clock was reset)
function guardOut(g, t) {
  W.guards = W.guards.filter(x => x !== g);
  emit('guardOut', g, t);
}
// What stands between hit h and unit u as it lands (battle_calc_damage): a safety wall under u blocks a short
// one, a pneuma around u a long one (all the attack's hits, decided on the first: what it costs the wall is the
// attack's whole damage), else Energy Coat on u takes SP and cuts it (once an attack, the cut on each of its
// hits), and Mental Strength to a tenth. A miss (no damage) meets none of them.
// whether hit h is a long-range attack (battle_range_type: BF_LONG): a character's by its skill's range, or its
// weapon's for a normal attack, 4 cells and up (skill_get_range2 < 4: short); a monster's by how far it is, more
// than 3 cells (skillrange_by_distance 14: monsters, pets, homunculi)
const longAttack = h => h.from.isPc ? (h.skill ? Math.abs(h.skill.range[h.skill.lv - 1] || 0) : h.from.pc.range) >= 4
  : field.distance(h.from.w, h.to.w) > 3;
function guard(h, t) {
  const u = h.to, by = h.from, a = h.atk, r = h.r;
  if (by.isPc === u.isPc || r.reflected) return;  // (damage sent back meets none: battle_delay_damage)
  // Magic Rod on u (skill_attack, SC_MAGICROD): a spell its caster aims at it (not one from a unit on the ground) does
  // nothing, and none of what it would start (ATK_MISS); u gets Lv × 20 % of the spell's SP (skill_get_sp; one ball
  // of a Water Ball's), shown with Magic Rod's effect (pre-renewal), once an attack, whatever damage it would have done
  const sk = r.skill || h.skill;
  if (u.isPc && sk && B.SKILLS[sk.name]?.magic && sk.target !== 'Ground' && has(u, 'SA_MAGICROD')) {
    if (a.rod == null) {
      const s = u.sc.find(x => x.name === 'SA_MAGICROD'), lv = sk.lv || 1;
      let sp = Math.trunc((sk.sp[lv - 1] || 0) * 20 * s.lv / 100);
      if (sk.name === 'WZ_WATERBALL' && lv > 1) sp = Math.trunc(sp / ((lv | 1) * (lv | 1)));
      a.rod = sp;
      emit('success', 'SA_MAGICROD', u.w, t);
      if (sp > 0) { u.sp = Math.min(u.pc.maxSp, u.sp + sp); emit('heal', u, { type: 'heal', sp: true, damage: sp }, t); emit('hp', u); }
    }
    h.r = { type: 'miss', damage: 0, skill: r.skill, rod: true };
    return;
  }
  if (!(r.damage > 0)) return;
  if (a.kyrie == null) a.kyrie = kyrie(u, h, a.damage);
  if (a.kyrie && a.kyrie.pass < a.damage) {
    const damage = Math.trunc(r.damage * a.kyrie.pass / a.damage);
    if (damage <= 0) { h.r = { ...r, type: 'miss', damage: 0, blocked: true, kyrie: true }; return; }
    h.r = { ...r, damage, kyrie: true, steps: [...(r.steps || []), [`霸邪之陣擋下 ${r.damage - damage}`, damage]] };
  }
  if (a.blocked == null) {
    const g = W.guards.find(g => g.x === u.w.cell[0] && g.y === u.w.cell[1] && g.by.side === u.side);
    const magic = !!(r.skill && r.skill.type === 'Magic'), short = !longAttack(h);
    a.blocked = !!(g && !magic && short && t < g.until);
    if (a.blocked && (--g.hits <= 0 || (g.hp -= a.damage) <= 0)) guardOut(g, t);
    if (!magic && !short && W.pneumas.some(n => t < n.until && cheb([n.x, n.y], u.w.cell) <= 1)) a.blocked = true;
  }
  if (a.blocked) { h.r = { ...r, type: 'miss', damage: 0, blocked: true }; return; }
  if (u.isPc && has(u, 'MG_ENERGYCOAT')) {
    if (a.cut == null) {
      const e = B.energyCoat(u.sp, u.pc.maxSp);
      a.cut = e.cut;
      if (u.sp >= e.cost) u.sp -= e.cost;  // (status_charge)
      else endStatus(u, 'MG_ENERGYCOAT');
      emit('hp', u);
    }
    const damage = r.damage - Math.trunc(r.damage * a.cut / 100);
    h.r = { ...r, damage, steps: [...(r.steps || []), [`能量外套 −${a.cut}%`, damage]] };
  }
  // Defending Aura: a long-range weapon attack (not magic nor misc) 5 + 15 × Lv % less (battle_calc_damage, SC_DEFENDER)
  const aura = u.sc.find(x => x.name === 'CR_DEFENDER' && W.t < x.until), fd = sk && B.SKILLS[sk.name];
  if (aura && h.r.damage > 0 && !(fd && (fd.magic || fd.misc)) && longAttack(h)) {
    const cut = B.BUFF_SKILLS.CR_DEFENDER.rangedCut(aura.lv), damage = h.r.damage - Math.trunc(h.r.damage * cut / 100);
    h.r = { ...h.r, damage, steps: [...(h.r.steps || []), [`光之盾 −${cut}%`, damage]] };
  }
  // Mental Strength: a tenth of each hit, 1 at least (battle_calc_damage, renewal)
  if (has(u, 'MO_STEELBODY')) {
    const damage = h.r.damage > 10 ? Math.trunc(h.r.damage / 10) : 1;
    h.r = { ...h.r, damage, steps: [...(h.r.steps || []), ['金剛不壞 ÷10', damage]] };
  }
}
// Kyrie Eleison on unit u (battle_status_block_damage, first of all): an attack doing `damage` (all its hits, settled
// on the first) takes that off the barrier and one off its attacks. A weapon attack (or Stone Fling) is stopped by it,
// only what the barrier lacked getting through; magic and the rest wear it down all the same, their damage whole.
// It ends with its attacks or barrier gone, or on Holy Light. Returns { pass: the damage let through } or false.
function kyrie(u, h, damage) {
  const s = u.sc.find(x => x.name === 'PR_KYRIE' && W.t < x.until);
  if (!s) return false;
  const name = h.skill && h.skill.name, f = name && B.SKILLS[name];
  s.barrier -= damage;
  const weapon = !f || !(f.magic || f.misc) || name === 'TF_THROWSTONE';
  if (--s.left <= 0 || s.barrier <= 0 || name === 'AL_HOLYLIGHT') endStatus(u, 'PR_KYRIE');
  return { pass: weapon ? Math.max(0, -s.barrier) : damage };
}
// the ground units' turn at time t (every UNIT_MS)
function unitTurn(t) {
  for (const wall of W.walls) {
    const c = wall.by;
    for (const cell of wall.cells) {
      if (cell.left <= 0 || t >= wall.until || c.dead != null) continue;
      for (const m of enemies(c)) {
        if (cell.left <= 0) break;
        if (!alive(m) || m.w.cell[0] !== cell.x || m.w.cell[1] !== cell.y) continue;
        const st = statusOf(m), fireproof = st.element === 'Fire' || B.isUndead(st);
        let hp = m.hp, n = 0;
        for (;;) {
          const r = B.skillAttack(db, offense(c), { ...st, hp }, wall.sk, wall.lv);
          const knock = !fireproof && !st.boss && r.damage > 0;
          if (knock) r.knock = { from: null, cells: WALL_KNOCK };
          if (fireproof) r.endure = ENDURE_MS;
          schedule(r, c, m, t + n * WALL_HIT_MS);
          hp -= r.damage;
          if (--cell.left <= 0 || knock || hp <= 0 || ++n >= UNIT_MS / WALL_HIT_MS) break;
        }
      }
    }
    // a cell out of hits goes out; so does all of the wall when its time is up
    for (const cell of wall.cells) if (cell.left <= 0 || t >= wall.until) emit('cellOut', cell, t);
    wall.cells = wall.cells.filter(x => x.left > 0 && t < wall.until);
  }
  W.walls = W.walls.filter(x => x.cells.length);
  for (const n of [...W.ices]) iceTurn(n, t);
  for (const g of [...W.guards]) if (t >= g.until) guardOut(g, t);
  for (const n of [...W.pneumas]) if (t >= n.until) pneumaOut(n, t);
  for (const n of [...W.warps]) {
    if (t >= n.until) { warpOut(n, t); continue; }
    if (t < n.open) continue;
    if (!n.opened) { n.opened = true; emit('warpOpen', n, t); }
    for (const u of units()) {
      if (!alive(u) || !sameCell(u.w.cell, [n.x, n.y])) continue;
      teleportUnit(u, t);
      if (--n.left <= 0) { warpOut(n, t); break; }
    }
  }
  for (const n of [...W.traps]) {
    if (t >= n.until) { trapOut(n, t); continue; }
    if (n.held) continue;
    // Talkie Box: any player but its setter sets it off (no Target: all; NoMob; skill_unit_onplace_timer skips its
    // src), its message said over it, the trap then spent
    if (n.sk.name === 'HT_TALKIEBOX') {
      const u = allChars().find(x => x !== n.by && alive(x) && !hidden(x) && cheb(x.w.cell, [n.x, n.y]) <= 1);
      if (u) { trapOut(n, t, true); say(Object.assign(field.spot(n.x, n.y), { top: 30 }), n.text, t); }
      continue;
    }
    // (a boss sets off no Skid Trap nor, in renewal, Ankle Snare; a plant boss no Flasher)
    const u = groundFoes(n.by).find(x => cheb(x.w.cell, [n.x, n.y]) <= 1 && !(['HT_SKIDTRAP', 'HT_ANKLESNARE'].includes(n.sk.name) && isBoss(x))
      && !(n.sk.name === 'HT_FLASHER' && isBoss(x) && statusOf(x).race === 'Plant'));
    if (u) springTrap(n, u, t);
  }
  for (const n of [...W.dusts]) {
    if (t >= n.until) { dustOut(n, t); continue; }
    for (const u of groundFoes(n.by)) {
      if (!n.cells.some(x => cheb(x, u.w.cell) <= 1) || t < (n.next.get(u) ?? 0)) continue;
      n.next.set(u, t + DUST_MS);
      if (u.poison) continue;
      const o = B.poisonOdds(statusOf(n.by), statusOf(u), 100, n.sk.duration2[n.lv - 1] || 0);
      if (rnd(10000) < o.chance * 100) poisonUnit(u, t, o.ms);
    }
  }
  for (const n of [...W.webs]) if (t >= n.until) webOut(n, t);
  for (const n of [...W.sancts]) t >= n.until ? sanctOut(n, t) : sanctTurn(n, t);
  for (const n of [...W.magni]) t >= n.until ? magnusOut(n, t) : magnusTurn(n, t);
  for (const n of [...W.bombs]) t >= n.until ? bombOut(n, t) : bombTurn(n, t);
  for (const n of [...W.storms]) t >= n.until ? stormOut(n, t) : stormTurn(n, t);
  for (const n of [...W.songs]) t >= n.until || n.by.dead != null || (n.with && n.with.dead != null) ? songOut(n) : songTurn(n, t);
  for (const n of [...W.quags]) t >= n.until ? quagOut(n, t) : quagTurn(n, t);
  for (const n of [...W.fields]) t >= n.until ? fieldOut(n, t) : fieldTurn(n, t);
}
// walls go out at once: all of them (the clock was reset), or those of a unit that left (a monster: its corpse gone)
function clearWalls(t, by = null) {
  for (const wall of W.walls) if (!by || wall.by === by) wall.cells.forEach(x => emit('cellOut', x, t));
  W.walls = W.walls.filter(x => by && x.by !== by);
  for (const n of [...W.ices]) if (!by || n.by === by) iceTurn(n, t, true);  // (ice walls too)
  for (const g of [...W.guards]) if (!by || g.by === by) guardOut(g, t);  // (safety walls too)
  for (const n of [...W.pneumas]) if (!by || n.by === by) pneumaOut(n, t);  // (and pneumas)
  for (const n of [...W.warps]) if (!by || n.by === by) warpOut(n, t);  // (and warp portals)
  for (const n of [...W.traps]) if (!by || n.by === by) trapOut(n, t);  // (traps, Venom Dust, webs)
  for (const n of [...W.dusts]) if (!by || n.by === by) dustOut(n, t);
  for (const n of [...W.webs]) if (!by || n.by === by) webOut(n, t);
  for (const n of [...W.sancts]) if (!by || n.by === by) sanctOut(n, t);
  for (const n of [...W.magni]) if (!by || n.by === by) magnusOut(n, t);
  for (const n of [...W.bombs]) if (!by || n.by === by) bombOut(n, t);
  for (const n of [...W.storms]) if (!by || n.by === by) stormOut(n, t);  // (and Storm Gusts)
  for (const n of [...W.songs]) if (!by || n.by === by || n.with === by) songOut(n);  // (and songs)
  for (const n of [...W.quags]) if (!by || n.by === by) quagOut(n, t);  // (and Quagmires)
  for (const n of [...W.fields]) if (!by || n.by === by) fieldOut(n, t);  // (and the sage's fields)
}
// Hits whose time has come land (in order), on either kind of unit. A hit is dropped if the one it is for is
// gone or down, and a monster's hits when the monster is down itself. A monster a multi-hit attack brings to
// 0 HP partway is `dying`: the rest of that attack (and of any other still landing on it) goes on hitting it —
// numbers, the running total, effects, the hurt motion — and it dies with the last of them (by eye); anything
// else is dropped then.
function landHits(t) {
  W.hits.sort((a, b) => a.at - b.at);
  while (W.hits.length && W.hits[0].at <= t) {
    const h = W.hits.shift(), u = h.to, by = h.from;
    if (!inFight(u) || u.dead != null || (u.dying && !h.combo) || (!by.isPc && by.dead != null && !h.r.posthumous)) continue;  // (Self Destruction's land with its user gone)
    guard(h, t);
    W.lastBlow = t;
    if (by.isPc) by.last = h.r;
    // (under Sacrifice its crusader takes the damage, u none: nor is its cast cut off, battle_delay_damage; the number
    // shown only on the crusader, by request)
    const dv = h.r.damage > 0 && !h.r.reflected ? devotedTo(u) : null;
    emit('hit', dv ? { ...h, r: { ...h.r, devoted: true } } : h, t);
    if (h.r.endure) u.endureUntil = Math.max(u.endureUntil || 0, t + h.r.endure);
    // a hit (not a miss) breaks a freeze, before anything it starts: a freeze it broke keeps the same hit from
    // freezing again (status_damage ends it, and sc_start still sees it for that attack)
    const wasFrozen = !!u.frozen;
    if (u.frozen && (h.r.type === 'hit' || h.r.type === 'crit')) thaw(u, t);
    if (u.stone && u.stone.on && (h.r.type === 'hit' || h.r.type === 'crit')) unpetrify(u, t);
    if (u.asleep && h.r.damage > 0) wake(u, t);  // (damage wakes it, before the hit's own status: status_damage)
    if (h.r.damage > 0) endStatus(u, 'DC_WINKCHARM');  // (RemoveOnDamaged)
    if (hidden(u) && h.r.damage > 0 && !keepsHidden(by)) endStatus(u, 'TF_HIDING');  // (Hiding: RemoveOnDamaged; Heaven's Drive reaches one)
    if (dv) sacrifice(dv, h.r.damage, by, t);
    if (by.isPc && !u.isPc && h.r.damage > 0) u.hitBy = by;  // (the last character to hit it: its cards' drops, cardDrops)
    hurt(u, dv ? { ...h.r, damage: 0 } : h.r, t, h.first, by);
    if (u.webbed && h.first && h.r.damage > 0 && h.skill?.element === 'Fire') burnWeb(u, t);  // (a fire attack burns a web)
    // a monster hit (the attack connecting with damage, once an attack) by something not magic: its 'closedattacked' or
    // 'longrangeattacked' rows for its state (battle_delay_damage_sub → mobskill_event: BF_SHORT / BF_LONG)
    if (!u.isPc && h.first && h.r.damage > 0 && alive(u) && !(h.skill && h.skill.type === 'Magic') && !h.r.reflected)
      mobEventSkill(u, longAttack(h) ? 'longrangeattacked' : 'closedattacked', t);
    // Sucking Blood: the monster heals by the damage it dealt (status_heal, with Heal's number: clif_skill_nodamage AL_HEAL)
    if (h.skill && B.SKILLS[h.skill.name]?.drain && h.r.damage > 0 && alive(by)) healUnit(by, { type: 'heal', damage: h.r.damage }, t);
    // Bloodlust: a homunculus's weapon attack takes 20 % of its damage back at 9 × Lv % (battle_calc_damage SC_BLOODLUST)
    { const bl = by.homun && h.first && h.r.damage > 0 && !(h.skill && h.skill.type === 'Magic') && alive(by) && by.sc.find(x => x.name === 'HAMI_BLOODLUST' && t < x.until);
      if (bl && rnd(100) < 9 * bl.lv) healUnit(by, { type: 'heal', damage: Math.trunc(h.r.damage * 20 / 100) }, t); }
    reflect(h, u, by, t);
    if (h.r.guard && h.first && u.dead == null) guarded(u, by, h.r.guard, t);
    if (h.r.freeze != null && u.dead == null) {
      if (h.r.freeze > 0 && !wasFrozen) freeze(u, t, h.r.freeze);
      else say(by.w, '技能使用失敗', t);  // clif_skill_fail
    }
    if (h.r.stun && u.dead == null && !u.dying && !u.stunned) stun(u, t, h.r.stun);
    if (h.r.hold && h.first && u.dead == null && !u.dying) holdWalk(u, t + h.r.hold);
    if (h.r.quag && h.r.damage > 0 && u.dead == null && !u.dying) quagmire(u, t, h.r.quag);
    if (h.r.poison && u.dead == null && !u.dying && !u.poison) poisonUnit(u, t, h.r.poison);
    if (h.r.blind && u.dead == null && !u.dying && !u.blind) blindUnit(u, t, h.r.blind);
    if (h.r.bleed && u.dead == null && !u.dying && !u.bleeding) bleed(u, t, h.r.bleed);
    if (h.r.strip && u.dead == null && !u.dying) stripMob(u, h.r.strip, t);
    if (h.r.raid && h.first && u.dead == null && !u.dying) raidOn(u, h.r.raid, t);
    if (h.r.silence && u.dead == null && !u.dying && !u.silenced) silence(u, t, h.r.silence);
    if (h.r.confuse && u.dead == null && !u.dying && !u.confused) confuse(u, t, h.r.confuse);
    if (h.r.curse && u.dead == null && !u.dying && !u.curse) curse(u, t, h.r.curse);
    if (h.r.sleep && u.dead == null && !u.dying && !u.asleep) sleep(u, t, h.r.sleep);
    // (one frozen or stunned is not petrified: status.yml StoneWait Fail)
    if (h.r.stone && u.dead == null && !u.dying && !u.stone && !u.frozen && !u.stunned) petrify(u, t, h.r.stone.wait, h.r.stone.ms);
    if (h.r.ailFail && h.first) say(by.w, '技能使用失敗', t);  // (clif_skill_fail)
    if (by.isPc && !h.skill && h.first && h.r.damage > 0 && !h.r.reflected && alive(u) && !u.dying) autoBlitz(by, u, t);
    if (h.first && !h.r.reflected && (by.cardFx || u.cardFx)) cardsOnHit(h, u, by, t, wasFrozen);
    if (u.dying && !comboOn(u)) mobDies(u, t);  // the last hit on it: now it dies
    if (h.r.knock && h.r.damage > 0 && !isBoss(u) && u.dead == null && !u.cardFx?.noKnock) {
      const k = h.r.knock, from = k.dir ? { cell: [u.w.cell[0] - k.dir[0], u.w.cell[1] - k.dir[1]] } : k.from;
      field.knockback(u.w, from, k.cells);
    }
  }
}
// Blitz Beat going off by itself (skill_additional_effect): character c's normal attack landing on m with damage, a bow
// in hand and the falcon with it, Blitz Beat learned: at LUK × 10 / 3 + 1 in 1000 (rnd() % 1000 <=) the falcon dives on
// m at Lv (job Lv + 9) / 10 at most (the level learned if lower), with no SP, cast or motion (SD_LEVEL; its name not
// shouted here)
function autoBlitz(c, m, t) {
  const lv = c.levels.HT_BLITZBEAT || 0;
  if (!lv || c.pc.weapon !== 'Bow' || !hasFalcon(c)) return;
  if (rnd(1000) > Math.trunc(statusOf(c).stats.luk * 10 / 3) + 1) return;
  DOES.blitz(c, { sk: db.skills.HT_BLITZBEAT, lv: Math.min(lv, Math.trunc((c.jlv + 9) / 10)), target: m }, t);
}
// ---------- the cards' procs (by request: the second batch; cards.js) ----------
// The statuses a card puts on (Eff_…: cards.js effOf), each for its own skill's Duration2 at Lv 7 when the card gives
// none (pc_bonus_addeff: status.yml DurationLookup — NPC_STUNATTACK, NPC_WIDEFREEZE … — skill_get_time2 at 7);
// stone: NPC_PETRIFYATTACK's, its wait its Duration1 (0.1 s)
const CARD_EFF_MS = { stun: 4500, freeze: 27000, stone: 17000, sleep: 18000, poison: 18000, curse: 18000, silence: 18000, confuse: 18000, blind: 18000, bleed: 108000 };
// status `kind` on dst from src at `rate` (1/10000) for ms (0: CARD_EFF_MS), against dst's resistance (the odds of
// battle.js, a character's cards' bResEff in them); `wasFrozen`: the hit that set it off broke a freeze on dst
// (status_damage ended it, and sc_start still sees it for that attack)
function cardEff(src, dst, kind, rate, ms, t, wasFrozen = false) {
  if (!alive(dst) || ailOn(dst, kind) || (kind === 'freeze' && wasFrozen)) return;
  const time = ms || CARD_EFF_MS[kind], a = statusOf(src), d = statusOf(dst);
  const o = kind === 'stone' ? B.petrifyOdds(a, d, rate / 100, 100, time) : AIL_ODDS[kind](a, d, rate / 100, time);
  if (!(o.chance > 0) || rnd(10000) >= o.chance * 100) return;
  switch (kind) {
    case 'stun': return stun(dst, t, o.ms);
    case 'freeze': return freeze(dst, t, o.ms);
    case 'stone': if (!dst.frozen && !dst.stunned) petrify(dst, t, o.wait, o.ms); return;
    case 'poison': return poisonUnit(dst, t, o.ms);
    case 'blind': return blindUnit(dst, t, o.ms);
    case 'bleed': return bleed(dst, t, o.ms);
    case 'silence': return silence(dst, t, o.ms);
    case 'confuse': return confuse(dst, t, o.ms);
    case 'curse': return curse(dst, t, o.ms);
    case 'sleep': return sleep(dst, t, o.ms);
  }
}
// an attack's battle flags (BF: weapon, magic or misc; a skill's or a normal one; short or long range)
function attackBf(h) {
  const sk = h.skill, kind = sk && sk.type === 'Magic' ? BF.MAGIC : sk && sk.type === 'Misc' ? BF.MISC : BF.WEAPON;
  return kind | (sk ? BF.SKILL : BF.NORMAL) | (longAttack(h) ? BF.LONG : BF.SHORT);
}
// does an add effect's ATF flags take an attack of battle flags bf (skill_additional_effect: its kinds, its ranges)
const atfTakes = (f, bf) => !!((f & ATF.WEAPON && bf & BF.WEAPON) || (f & ATF.MAGIC && bf & BF.MAGIC) || (f & ATF.MISC && bf & BF.MISC)) &&
  !((f & ATF.LONG && !(f & ATF.SHORT) && !(bf & BF.LONG)) || (f & ATF.SHORT && !(f & ATF.LONG) && !(bf & BF.SHORT)));
// Character c's cards' autospells (`list`: cards.js { sk, lv, rate ‰, bf, self, random }) on an attack of battle flags
// bf (its own landing on foe, or foe's landing on it): each whose flags take it, at its rate (halved: a bow's attack,
// or a long-range weapon one it took), goes off at its level (a random one up to it) on c itself (a support skill or one
// on oneself, unless the card says) or on foe, a ground one where that one stands — as Hindsight's spell does: no
// cast, no SP (autocast: skill_get_requirement), no skill delay after it (by request, as Hindsight's); none if c is
// silenced (fireSkill)
function cardSpells(c, foe, list, bf, t, half) {
  for (const a of list) {
    if (!(a.bf & bf & BF.TYPE && a.bf & bf & BF.RANGE && a.bf & bf & BF.HOW)) continue;
    if (!alive(c) || rnd(1000) >= (half ? Math.trunc(a.rate / 2) : a.rate)) continue;
    const sk = db.skills[a.sk], top = (sk.sp || []).length || a.lv || 1;
    const lv = Math.min(top, a.random ? 1 + rnd(a.lv || 1) : a.lv || 1);
    const self = a.self ?? (sk.target === 'Support' || sk.target === 'Self'), at = self ? c : foe;
    if (!at || !alive(at)) continue;
    const target = sk.target === 'Ground' ? { w: field.spot(...at.w.cell), ground: true } : sk.target === 'Self' ? c : at;
    fireSkill(c, { sk, lv, target, auto: 0 }, t, true);
  }
}
// HP and SP to character c (a card's drain or what a kill gives back; less, if negative), shown if `show`
// (battle.conf show_hp_sp_drain no, show_hp_sp_gain yes)
function cardRegain(c, hp, sp, t, show) {
  if (c.dead != null) return;
  if (hp) { const was = c.hp; c.hp = Math.max(1, Math.min(c.pc.maxHp, c.hp + hp)); if (hp > 0) tallyOf(c).healed += c.hp - was; if (show && hp > 0) emit('heal', c, { type: 'heal', damage: hp }, t); }
  if (sp) { c.sp = Math.max(0, Math.min(c.pc.maxSp, c.sp + sp)); if (show && sp > 0) emit('heal', c, { type: 'heal', sp: true, damage: sp }, t); }
  emit('hp', c);
}
// Hit h of `by` landing on u (its first, not reflected): what their cards do then.
//  - by's (a character's): on a weapon attack that connects, its add effects (bAddEff: at u, bAddEff2: at itself) and its
//    drains (battle_drain: HP, SP at their rate ‰ per % of the damage, a flat SP); u killed by a short-range weapon
//    attack, the SP and HP it gives back (bSPGainRace, bSPGainValue, bHPGainValue)
//  - u's (a character's), hit by a weapon attack (skill_counter_additional_effect): bAddEffWhenHit's (ATF_TARGET at
//    `by`, ATF_SELF at itself), then, any attack but a no-damage one, its autospells when hit
function cardsOnHit(h, u, by, t, wasFrozen) {
  const bf = attackBf(h), hit = h.r.type !== 'miss' && h.r.type !== 'lucky', fx = by.isPc && by.cardFx;
  if (fx && hit) {
    cardBuffs(by, fx.autoBonus, false, bf, t);
    if (bf & BF.WEAPON) {
      for (const e of fx.addEff) {
        if (!atfTakes(e.flag, bf)) continue;
        if (e.flag & ATF.TARGET) cardEff(by, u, e.kind, e.rate, 0, t, wasFrozen);
        if (e.flag & ATF.SELF) cardEff(by, by, e.kind, e.rate, 0, t);
      }
      // (its target's weapon and armour broken, at their rate /10000: skill_additional_effect's break_weapon_rate; a coma,
      // its HP to 1, on one not a boss: SC_COMA)
      if (!u.isPc && alive(u)) {
        if (fx.breakWeapon && rnd(10000) < fx.breakWeapon) stripMob(u, 'RG_STRIPWEAPON', t);
        if (fx.breakArmor && rnd(10000) < fx.breakArmor) stripMob(u, 'RG_STRIPARMOR', t);
        const race = statusOf(u).race, coma = (fx.coma[isBoss(u) ? 'Boss' : 'Normal'] || 0) + (fx.coma.All || 0) + (fx.comaRace[race] || 0) + (fx.comaRace.All || 0);
        if (coma && !isBoss(u) && rnd(10000) < coma) { u.hp = 1; emit('hp', u); }
      }
      // (and turned into another, not a boss, at its rate /10000: a monster of the dead branch's — classchange)
      if (!u.isPc && alive(u) && !u.dying && fx.classChange && !isBoss(u) && rnd(10000) < fx.classChange) {
        const def = randomMob('BRANCH_OF_DEAD_TREE', true);
        if (def && def.id !== u.def.id) changeClass(u, def, t);
      }
      const d = h.r.damage || 0, drain = (r, n) => n.per && (n.rate > 1000 || rnd(1000) < n.rate) ? Math.trunc(d * n.per / 100) || (n.per > 0 ? 1 : -1) : 0;
      if (d > 0) { const hp = drain(d, fx.hpDrain), sp = drain(d, fx.spDrain) + fx.spDrainValue; if (hp || sp) cardRegain(by, hp, sp, t, false); }
    }
    if (!u.isPc && (u.dying || u.dead != null)) {
      if ((bf & (BF.WEAPON | BF.SHORT)) === (BF.WEAPON | BF.SHORT)) {
        const race = statusOf(u).race, sp = fx.spGain + (fx.spGainRace[race] || 0) + (fx.spGainRace.All || 0);
        if (sp || fx.hpGain) cardRegain(by, fx.hpGain, sp, t, true);
      }
    }
  }
  const mine = u.isPc && u.cardFx;
  if (!mine || u.dead != null || u.dying || !(h.r.damage > 0) || u === by) return;
  if (bf & BF.TYPE) for (const e of mine.addEffHit) {
    if (!atfTakes(e.flag, bf)) continue;
    if (e.flag & ATF.TARGET) cardEff(u, by, e.kind, e.rate, 0, t);
    if (e.flag & ATF.SELF) cardEff(u, u, e.kind, e.rate, 0, t);
  }
  if (mine.autoSpellHit.length) cardSpells(u, by, mine.autoSpellHit, bf, t, (bf & (BF.WEAPON | BF.LONG)) === (BF.WEAPON | BF.LONG));
  cardBuffs(u, mine.autoBonus, true, bf, t);
}
// character c's cards' autobonuses (cards.js: `hit` the autobonus2 ones, on it being hit) on an attack of battle flags
// bf: each whose flags take it, at its rate ‰, puts its script's bonuses on c for its time (again from now if on:
// pc_exeautobonus), c's status worked out again (cardsOn); off again when the time is up (cardBuffsOff)
function cardBuffs(c, list, hit, bf, t) {
  let on = false;
  for (const a of list) {
    if (a.hit !== hit || !(a.bf & bf & BF.TYPE && a.bf & bf & BF.RANGE && a.bf & bf & BF.HOW) || rnd(1000) >= a.rate) continue;
    c.cardBuffs = [...(c.cardBuffs || []).filter(b => b.script !== a.script), { script: a.script, until: t + a.ms }];
    on = true;
  }
  if (on) recalc(c);
}
function cardBuffsOff(c, t) {
  if (!c.cardBuffs?.some(b => b.until <= t)) return;
  c.cardBuffs = c.cardBuffs.filter(b => b.until > t);
  recalc(c);
}
// a character u's cards' bShortWeaponDamageReturn: that % of a short-range weapon attack's damage back at `by`, at least
// 1 (battle_calc_return_damage)
function cardReturn(h, u, by, t) {
  const n = u.isPc && u.cardFx?.shortReturn;
  if (!n || !(h.r.damage > 0) || h.r.reflected || !alive(by) || longAttack(h) || (h.skill && h.skill.type !== 'Weapon')) return;
  W.hits.push({ at: t, from: u, to: by, first: true, atk: {}, r: { type: 'hit', damage: Math.max(1, Math.trunc(h.r.damage * n / 100)), reflected: true } });
}
// a character's cards' HP and SP every so often (bHPRegenRate, bSPRegenRate; bHPLossRate's the other way, down to 1 at
// the least: pc_regen), each on a clock of its own
function cardEvery(c, dt, t) {
  const fx = c.cardFx;
  if (!fx || (!fx.hpEvery.length && !fx.spEvery.length)) return;
  const clocks = c.regen.cards ??= {};
  let hp = 0, sp = 0;
  [...fx.hpEvery.map(e => ['h', e]), ...fx.spEvery.map(e => ['s', e])].forEach(([k, e], i) => {
    const key = k + i;
    clocks[key] = (clocks[key] || 0) + dt;
    while (e.ms > 0 && clocks[key] >= e.ms) { clocks[key] -= e.ms; if (k === 'h') hp += e.n; else sp += e.n; }
  });
  if (hp < 0) hp = Math.max(hp, 1 - c.hp);
  if (hp || sp) cardRegain(c, hp, sp, t, false);
}
// what monster m drops besides, killed by a character (the last to hit it: m.hitBy, landHits) with cards making it (bAddMonsterDropItem:
// its race's, or any; mob_dead's item bonus drops, rate /10000)
// The item groups of bAddMonsterDropItemGroup (Blazer's IG_Food, Tengu's IG_Recovery): rAthena's item_group_db has
// neither (the constants and nothing in them: no drop), so the game's own (by request, the cards made to work): the
// food and the potions and herbs it has, each kept at `rate` /10000 once picked
const CARD_GROUPS = {
  Food: { items: [513, 517, 529, 530, 531, 532, 534, 536, 544, 551], rate: 1000 },
  Recovery: { items: [501, 502, 503, 504, 505, 507, 508, 509, 545], rate: 1000 },
};
// whether a magic skill sk of u's (null: anyone's) takes on m, a character whose cards keep 50 % and more of magic off
// (status_isimmune ≥ gtb_sc_immunity 50: its statuses and heals — on oneself only one cast on a target, a Self skill's
// not). By request such a one cannot be aimed at with magic at all: no one casts it at it (useSkill, fits, mobSkill),
// so no SP goes on it; what still comes (a ground spell, a party one) does nothing or no damage
const magicImmune = (u, m, sk) => !!m?.isPc && (m.cardFx?.noMagic || 0) >= 50 && sk.type === 'Magic' && (sk.target !== 'Self' || m !== u);
function cardDrops(m) {
  const fx = m.hitBy?.cardFx;
  if (!fx || m.by) return;
  const race = statusOf(m).race;
  for (const d of fx.drops) if ((d.race === 'All' || d.race === race) && db.items[d.item] && rnd(10000) < d.rate) dropItem(m, d.item);
  // (a group's: one of it at random, kept at the group's rate — GROUP_ALGORITHM_DROP)
  for (const d of fx.groupDrops) {
    const g = CARD_GROUPS[d.group];
    if (!g || !(d.race === 'All' || d.race === race) || rnd(10000) >= d.rate) continue;
    const id = g.items[rnd(g.items.length)];
    if (db.items[id] && rnd(10000) < g.rate) dropItem(m, id);
  }
  // (and zeny now and then: bGetZenyNum, 1 to its most at its rate %, into the party's money: mob_dead)
  for (const z of fx.zeny) if (rnd(100) < z.rate) {
    const n = 1 + rnd(Math.max(1, z.max > 0 ? z.max : -z.max * statusOf(m).lv));
    purse(m.hitBy).zeny += n;
    say(m.hitBy.w, `${n.toLocaleString()} z`, W.t);
  }
}
// Auto Guard on unit u blocked an attack of `by`'s at level lv (battle_calc_damage): u stands if sitting and cannot walk
// for 300 ms (Lv 1–5), 200 (6–9) or 100 (10) (unit_set_walkdelay); with Shrink on, `by` is stunned at 50 % against
// its resistance (renewal's sc_start SC_STUN 50) for Shrink's Duration2 (5 s; rAthena takes the attack's own
// Duration2, none for a normal attack: the skill's description has it stun)
function guarded(u, by, lv, t) {
  if (u.sitting) sit(u, false);
  holdWalk(u, t + (lv <= 5 ? 300 : lv <= 9 ? 200 : 100));
  if (!has(u, 'CR_SHRINK') || !alive(by) || by.stunned) return;
  const o = B.stunOdds(statusOf(u), statusOf(by), 50, db.skills.CR_SHRINK.duration2[0]);
  if (rnd(10000) < o.chance * 100) stun(by, t, o.ms);
}
// Reflect Shield (battle_calc_return_damage, SC_REFLECTSHIELD) on unit u, hit h from `by` landing: of a short-range
// weapon attack (longAttack: a character's normal attack with its range under 4, a weapon skill whose range is)
// B.reflectRate % of the damage, at least 1, goes back to `by` at once (clif_damage on it)
function reflect(h, u, by, t) {
  cardReturn(h, u, by, t);
  const rs = u.sc.find(s => s.name === 'CR_REFLECTSHIELD' && W.t < s.until);
  if (!rs || !(h.r.damage > 0) || !alive(by) || h.r.reflected) return;
  if (rs.devoted && !h.skill) return;  // (one Sacrifice gave reflects skills only: devotion_rdamage_skill_only)
  const f = h.skill && B.SKILLS[h.skill.name];
  if (f && (f.magic || f.misc)) return;
  if (longAttack(h)) return;
  W.hits.push({ at: t, from: u, to: by, first: true, atk: {}, r: { type: 'hit', damage: Math.max(1, Math.trunc(h.r.damage * B.reflectRate(rs.lv) / 100)), reflected: true } });
}
// Unit u takes hit r from unit `by` (damage already rolled). react: only on the first hit of an attack (the
// reaction to the attacker and the stop, once per damage packet); the hurt motion plays with every hit.
function hurt(u, r, t, react, by) {
  if (u.isPc && !u.dying) plagiarize(u, r, by, t);  // (a hit of 0 too: by request)
  if (!r.damage) return;
  if (u.dying) return hurtMotion(u, t);  // at 0 HP already: only the hurt motion
  const lost = Math.min(u.hp, r.damage);
  if (by.isPc) {
    logDamage(by, lost, t);
    const x = tallyOf(by);
    x.dealt += lost; x.best = Math.max(x.best, r.damage);
    if (!u.isPc && lost >= u.hp) x.kills++;
  }
  if (u.isPc) tallyOf(u).taken += lost;
  u.hp = Math.max(u.undying ? 1 : 0, u.hp - r.damage);  // (undying: never down to 0, the game's training ground)
  // damage brings it out of hiding (RemoveOnDamaged), and out of cloaking — not a hit of one whose card sees them
  if (!keepsHidden(by)) { endStatus(u, 'TF_HIDING'); endStatus(u, 'AS_CLOAKING'); }
  // damage cuts a cast off (status_damage → unit_skillcastcancel) if it can be: a character's unless skill_db
  // says CastCancel false, a monster's if its mob_skill_db row says cancelable; its aura and mark go with it
  if (u.cast && u.cast.cancelable) u.cast = null;
  if (u.isPc) pcHurt(u, r, t, react, by);
  else mobHurt(u, r, t, react, by);
}
// ---------- EXP ----------
// rAthena conf/battle/exp.conf defaults but for the rates (EXP_RATE below): multi_level_up no, death_penalty_type 1 with
// death_penalty_base / _job 100 (dying loses 1% of the EXP to the next level)
const DEATH_PENALTY = 100;
const MAX_LEVEL_BASE_EXP = 99999999, MAX_LEVEL_JOB_EXP = 999999999;
// EXP character c needs for its next base / job level (pc_nextbaseexp / pc_nextjobexp): at the top level,
// what it may still hold
export function nextBaseExp(c) {
  const jj = jobFor(c), lv = clampv(c.blv, 1, jj.maxBase);
  return lv >= jj.maxBase ? MAX_LEVEL_BASE_EXP : jj.baseExp[lv - 1];
}
export function nextJobExp(c) {
  const jj = jobFor(c), lv = clampv(c.jlv, 1, jj.maxJob);
  return lv >= jj.maxJob ? MAX_LEVEL_JOB_EXP : jj.jobExp[lv - 1];
}
// monster m died: every character in the party that is not down gets the monster's whole base and job EXP
// times EXP_RATE (not rAthena's shares by damage dealt, nor its renewal level penalty)
const EXP_RATE = 10;  // (base_exp_rate / job_exp_rate 1000)
function giveExp(m, t) {
  if (m.hitBy && m.hitBy.side === RIVAL) return;  // (one the rival team finished off: none for the party, none for it)
  for (const c of W.chars) {
    if (c.dead != null) continue;
    // (Mental Sensing: 25 + 11 × Lv % more for one under it, mob_dead; pre-renewal's skill_unitsetting)
    // (and its cards' bExpAddRace on the monster's race: pc_calcexp)
    const kim = c.sc.find(s => s.name === 'BD_RICHMANKIM'), xr = c.cardFx ? (c.cardFx.expRace[m.def.race] || 0) + (c.cardFx.expRace.All || 0) : 0;
    const k = (kim ? 125 + 11 * kim.lv : 100) * (100 + xr) / 10000;
    gainExp(c, Math.trunc(m.def.baseExp * EXP_RATE * k), Math.trunc(m.def.jobExp * EXP_RATE * k), t);
  }
}
// the build a character of job `job` starts on: its first (builds.js), or none
export const defaultBuild = job => (buildsFor(job)[0] || {}).id || null;
// Spend character c's unspent stat points on its build (c.build, builds.js): its steps in order, each step's
// stats raised to what it lists before the next step's. Within a step, again and again the stat least far along
// from the step before toward this one goes up by 1 (the one listed first on a tie) — or, when that one costs
// more than is left, the points wait for it. Points left once the last step is reached wait too, and so do all
// of them without a build (自訂). False without a build.
export function autoStats(c) {
  const steps = stepsOf(c.build);
  if (!steps) return false;
  const jj = jobFor(c), st = Object.fromEntries(B.STATS.map(s => [s, clampv(c.stats[s], 1, jj.maxStat)]));
  let left = B.pointsTotal(db, jj, clampv(c.blv, 1, jj.maxBase)) - B.pointsSpent(st);
  spend: for (let k = 0; k < steps.length; k++) {
    const want = steps[k][1], from = k ? steps[k - 1][1] : {};
    const along = s => (st[s] - (from[s] || 1)) / Math.max(1, want[s] - (from[s] || 1));
    for (;;) {
      const open = Object.keys(want).filter(s => st[s] < Math.min(want[s], jj.maxStat));
      if (!open.length) break;
      const s = open.reduce((a, b) => along(b) < along(a) ? b : a);
      const cost = B.statCost(st[s]);
      if (cost > left) break spend;
      left -= cost;
      st[s]++;
    }
  }
  Object.assign(c.stats, st);
  return true;
}
// take back all of character c's stat points and spend them again on its build (none: they stay as they are)
export function refitStats(c) {
  if (!stepsOf(c.build)) return false;
  for (const s of B.STATS) c.stats[s] = 1;
  return autoStats(c);
}
// character c gains EXP (pc_gainexp), levelling up once it has enough (pc_checkbaselevelup /
// pc_checkjoblevelup). Without multi_level_up, one gain carries over at most the EXP needed for the level
// just reached, less 1. A base level up spends the new stat points on the build (autoStats) and heals HP and
// SP in full, a job level up its skill points (autoSkills); either plays its effect.
export function gainExp(c, base, job, t) {
  if (c.dead != null) return;
  const jj = jobFor(c);
  c.blv = clampv(c.blv, 1, jj.maxBase);
  c.jlv = clampv(c.jlv, 1, jj.maxJob);
  let up = false, jobUp = false;
  if (base) {
    c.bexp = Math.min(MAX_LEVEL_BASE_EXP, c.bexp + base);
    let next = nextBaseExp(c);
    if (c.blv < jj.maxBase && c.bexp >= next) {
      up = true;
      do {
        c.bexp = Math.min(c.bexp - next, next - 1);
        c.blv++;
        if (c.blv >= jj.maxBase) { c.bexp = Math.min(c.bexp, MAX_LEVEL_BASE_EXP); break; }
      } while (c.bexp >= (next = nextBaseExp(c)));
    }
  }
  if (job) {
    c.jexp = Math.min(MAX_LEVEL_JOB_EXP, c.jexp + job);
    let next = nextJobExp(c);
    if (c.jlv < jj.maxJob && c.jexp >= next) {
      jobUp = true;
      do {
        c.jexp = Math.min(c.jexp - next, next - 1);
        c.jlv++;
        if (c.jlv >= jj.maxJob) { c.jexp = Math.min(c.jexp, MAX_LEVEL_JOB_EXP); break; }
      } while (c.jexp >= (next = nextJobExp(c)));
    }
  }
  if (up || jobUp) {
    if (up) autoStats(c);
    if (jobUp) autoSkills(c);
    calc(c);
    if (up) { c.hp = c.pc.maxHp; c.sp = c.pc.maxSp; }  // status_percent_heal(sd, 100, 100)
    emit('status', c);
    emit('hp', c);
  }
  emit('exp', c, base, job, t, up, jobUp);
}
// character c goes up one base level and one job level at once, as far as its job goes, down or not (a map
// cleared: sandbox.js, whose maps' monsters give no EXP); the EXP it held toward them is kept (less than the new
// ones need). A base level spends its stat points (autoStats) and heals one standing in full, a job level its
// skill points (autoSkills), as gainExp's.
export function levelUp(c, t) {
  const jj = jobFor(c);
  c.blv = clampv(c.blv, 1, jj.maxBase);
  c.jlv = clampv(c.jlv, 1, jj.maxJob);
  const up = c.blv < jj.maxBase, jobUp = c.jlv < jj.maxJob;
  if (up) { c.blv++; c.bexp = Math.min(c.bexp, nextBaseExp(c) - 1); autoStats(c); }
  if (jobUp) { c.jlv++; c.jexp = Math.min(c.jexp, nextJobExp(c) - 1); autoSkills(c); }
  if (!up && !jobUp) return;
  calc(c);
  if (up && c.dead == null) { c.hp = c.pc.maxHp; c.sp = c.pc.maxSp; }
  emit('status', c);
  emit('hp', c);
  emit('exp', c, 0, 0, t, up, jobUp);
}
// character c died (pc_dead): it loses 1% of the EXP to its next base and job level, down to none; not a
// Novice, nor at the top level (death_penalty_maxlv 0)
function deathPenalty(c) {
  const jj = jobFor(c);
  if (jj.name === 'Novice') return;
  if (clampv(c.blv, 1, jj.maxBase) < jj.maxBase) c.bexp -= Math.min(c.bexp, Math.trunc(nextBaseExp(c) * DEATH_PENALTY / 10000));
  if (clampv(c.jlv, 1, jj.maxJob) < jj.maxJob) c.jexp -= Math.min(c.jexp, Math.trunc(nextJobExp(c) * DEATH_PENALTY / 10000));
  emit('exp', c, 0, 0, W.t, false, false);
}

// ---------- DPS ----------
// A character's DPS as measured: the HP its hits (skills and fire walls too) took off monsters over the last
// DPS_MS, over that long — or since its first hit, when that was less long ago. c.dealt: { t, dmg } of each.
const DPS_MS = 60000;
function logDamage(c, dmg, t) {
  c.dealt.push({ t, dmg });
  if (dmg > 0) W.lastDealt = t;
  if (c.dealtSince == null) c.dealtSince = t;
}
// { dps, span (ms it is over) }, or null before its first hit
export function dps(c, t = W.t) {
  if (c.dealtSince == null) return null;
  c.dealt = c.dealt.filter(e => t - e.t < DPS_MS);
  const span = Math.min(DPS_MS, t - c.dealtSince);
  return { dps: span > 0 ? c.dealt.reduce((n, e) => n + e.dmg, 0) * 1000 / span : 0, span };
}
// unit u (a character or a monster) gets HP back (r.damage: the amount, all of it shown, even what tops
// the HP out)
function healUnit(u, r, t, by = null) {
  const was = u.hp;
  u.hp = Math.min(maxHp(u), u.hp + r.damage);
  if (u.isPc) tallyOf(u).healed += u.hp - was;
  if (by && by.isPc) tallyOf(by).heals += u.hp - was;
  emit('hp', u);
  emit('heal', u, r, t);
}
// ---------- a character's tally ----------
// What character c did and had done to it since the fight began (resetWorld; by request, for the game's 結算):
// dealt (HP taken off monsters), best (its biggest hit), kills, taken (HP it lost), heals (HP its skills gave back,
// itself included, what was missing only), healed (HP it got back: skills, potions, Increase HP Recovery's, not its
// regen), sp (spent on skills), skills (used), zeny (Mammonite's), items ({ id: n } drunk), downs (times it died)
const newTally = () => ({ dealt: 0, best: 0, kills: 0, taken: 0, heals: 0, healed: 0, sp: 0, skills: 0, zeny: 0, items: {}, downs: 0 });
export const tallyOf = c => c.tally ??= newTally();
// a skill's name shouted above its user, as it goes off or, with a cast time, as the cast starts (the
// client shows it when the cast begins); `cast`: that cast, which the name stays up for
const shout = (w, sk, t, cast = null) => say(w, (sk.zh || sk.en) + '!!', t, cast);
// a line of text above a unit (skill names, the client's failure messages)
const say = (w, text, t, cast = null, chat = false) => emit('say', w, text, t, cast, chat);

// ---------- monsters ----------
// a monster (a unit, see there): { def (mob_db entry), st (status), hp, w (mover), target (whom it is after, or null),
//              anim ({ grp, start, fd, end }), stunUntil, nextWalk, nextAttack,
//              dead (time of death), gone (when the corpse is removed) }
// it comes in on the floor at once
// monster def joins the fight: on a random free cell away from the characters, or on cell `at` (one summoned)
export function addMob(def, at = null) {
  const w = field.add();
  if (at) w.spawn(field.map, ...at);
  else field.placeAway(w, allChars().map(c => c.w).filter(Boolean), MOB_GAP);
  const st = B.mobStatus(def);
  // (what its own buffs work from: mobRecalc)
  const base = { amotion: st.amotion, adelay: st.adelay, walkSpeed: st.walkSpeed, hit: st.hit, flee: st.flee, def: st.def, batk: st.batk };
  const m = { isPc: false, side: 'monsters', n: W.mobN++, def, st, base, hp: st.maxHp, w, target: null, anim: null, stunUntil: 0, lastLink: -LINK_MS,
              cast: null, skillReady: {}, sc: [], frozen: null, stunned: null,
              // mob_setstate: `mss` is 'idle', 'attack' (MSS_BERSERK) or 'chase' (MSS_RUSH); while `aggressive`
              // (angry monsters until hit or provoked, again after dropping their target) those two are
              // MSS_ANGRY and MSS_FOLLOW, which `mssAngry` keeps from when the state was set. `attacked`:
              // hits waiting to be reacted to, { at, by, norm }.
              mss: 'idle', aggressive: !!(st.mode & B.MD.ANGRY), mssAngry: false, attacked: [], rude: 0,
              nextWalk: W.t + RANDOMWALK_MS + rnd(1000), nextAttack: 0, dead: null };
  m.w.cellMs = st.walkSpeed;
  m.w.heading = [R.random() - 0.5, R.random() - 0.5];
  if (ICICLES.has(def.aegis)) m.trap = true;
  W.mobs.push(m);
  return m;
}
// Iceicle and Solid Icicle (by request): not monsters but a trap the client draws as one, its shadow on the floor —
// no one can target, hit or see it as a foe (units), nor does a wave wait for it (fight.js); a character stepping
// on its cell has the icicle fall on it, its normal attack once (its sprite's attack: the icicle dropping and
// shattering), and it is gone when that is over, with no EXP nor loot
const ICICLES = new Set(['ICEICLE', 'ILL_ICEICLE']);
export const isTrap = m => !!m.trap;
function icicleTurn(m, t) {
  if (m.fell != null) { if (t >= m.fell) removeMob(m); return; }
  const c = allChars().find(x => alive(x) && sameCell(x.w.cell, m.w.cell));
  if (!c) return;
  startMobAttack(m, t, c);
  m.fell = m.anim.end;
}
export function removeMob(m) {
  dropTarget(m, W.t);
  clearWalls(W.t, m);  // (unit_free → skill_clear_unitgroup)
  W.mobs = W.mobs.filter(x => x !== m);
  field.remove(m.w);
  emit('removed', m);
}
export const busy = (a, t) => a && t < a.end;

// ---------- loot ----------
// A monster the party kills drops its loot (by request; jobs.json drops: its Etc items) as rAthena's mob_dead
// does: each of them on its own by its rate (/10000, item_rate_common 100), on a random open cell of the 3×3
// about the monster (map_addflooritem), each rate times the map's W.drop (levels.dropFor; fight.js MapRun sets it). One summoned (a slave, a brood) drops nothing (by choice: the party
// would farm a summoner). Loot stays on the ground until it is picked up or the fight ends (by request: no
// flooritem_lifetime). W.items: [{ n, id (item id), w: { cell } }].
function dropLoot(m) {
  if (m.by) return;
  for (const [id, rate] of m.def.drops || []) if (rnd(10000) < rate * W.drop) dropItem(m, id);
}
// item `id` dropped by monster m, on its cell or one next to it, open
function dropItem(m, id) {
  const [x, y] = m.w.cell, cells = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (field.open(x + dx, y + dy)) cells.push([x + dx, y + dy]);
  const it = { n: W.itemN++, id, w: { cell: cells.length ? cells[rnd(cells.length)] : [x, y] } };
  W.items.push(it);
  emit('drop', it, m);
}
// Character c picks up loot `it`, standing on its cell or next to it (rAthena lets one 2 cells off: pc_takeitem;
// next to it by eye): it goes into the party's W.loot at once, and the character plays its pick-up action
// (撿東西) for PICKUP_MS, doing nothing else meanwhile (by eye).
const PICKUP_MS = 400;
export const canReach = (c, it) => cheb(c.w.cell, it.w.cell) <= 1;
export function pickUp(c, it, t) {
  if (c.dead != null || cloaked(c) || !W.items.includes(it) || !canReach(c, it)) return false;  // (cloaked: NoPickItem)
  W.items = W.items.filter(x => x !== it);
  const frames = motion.pc(c, 3).frames || 1;
  c.anim = { start: t, group: 3, frames, fd: PICKUP_MS / frames, target: null };
  c.canAct = Math.max(c.canAct, t + PICKUP_MS);
  c.alert = false;
  if (c.loot === it) c.loot = null;
  emit('pickup', c, it, t);
  gain(c, it.id, t);
  return true;
}
// ---------- the boxes (by request: one picked up or stolen is used at once, by whoever got it) ----------
// Item `id` come to character c: into the party's loot (W.loot, sold at the 結算), unless it is a box, which c opens
// there and then (its item_db script: openBox) and which is gone.
function gain(c, id, t, depth = 0) {
  const it = db.items[id] || {};
  if (depth < 4 && (it.group || BOXES[it.aegis])) return openBox(c, id, t, depth);
  const p = purse(c);
  p.loot[id] = (p.loot[id] || 0) + 1;
}
// The boxes the cards make monsters drop (bAddMonsterDropItem) and their scripts (item_db_usable.yml):
// - Old Blue Box, Gift Box: getgroupitem — one item of its group (item_group_db BLUEBOX, GIFTBOX: jobs.json items
//   `group`, [id, rate, amount]) at random by its rate, into the loot (a box among them opened in turn);
// - Giggling Box: percentheal 9,0 and SC_CURSE at 30 % for 30 s; Painting Box: percentheal 0,9 and SC_SILENCE the
//   same (sc_start rate 3000: against c's own resistance, cardEff);
// - Box of Thunder: SC_SPEEDUP0 25 for 20 s (bSpeedRate: movement 25 % quicker, battle.js BUFF_SKILLS SPEEDUP0);
// - Gloomy Box: itemskill AC_CONCENTRATION 1 (as the skill at Lv 1: its status for its Duration1, hiding revealed
//   round c; not under Quagmire);
// - Box of Grudge: SC_ATKPOTION 20 for 60 s (bBaseAtk); Sleepy Box: SC_MATKPOTION 20 for 60 s (bMatk2);
// - Box of Storm: itemskill ITEM_ENCHANTARMS 2 (SC_ENCHANTARMS: the weapon's element water, skill_db Lv 2, for its
//   Duration1, 20 min; it ends and is ended by the other weapon elements: EndOnStart);
// - Box of Sunlight: SC_INTRAVISION for 30 s (the hidden and cloaked seen: clairvoyant).
// Each one's name rises over c (as a skill's: say); what a status does shows as the skill's would.
const BOXES = {
  Giggling_Box: (c, t) => { boxHeal(c, Math.trunc(c.pc.maxHp * 9 / 100), 0, t); cardEff(c, c, 'curse', 3000, 30000, t); },
  Box_Of_Thunder: (c, t) => itemStatus(c, 'SPEEDUP0', 20000, t),
  Gloomy_Box: (c, t) => {
    const sk = db.skills.AC_CONCENTRATION;
    if (!sk || quagFail(c, sk.name)) return;
    addStatus(c, sk, 1, t);
    reveal(c, sk.splash[0] || 0);
    emit('success', sk.name, c.w, t);
  },
  Box_Of_Grudge: (c, t) => itemStatus(c, 'ATKPOTION', 60000, t),
  Sleepy_Box: (c, t) => itemStatus(c, 'MATKPOTION', 60000, t),
  Box_Of_Storm: (c, t) => {
    for (const n of WEAPON_ELEMENTS) if (n !== 'ITEM_ENCHANTARMS') endStatus(c, n);
    itemStatus(c, 'ITEM_ENCHANTARMS', 1200000, t, 2);
    emit('success', 'SA_FROSTWEAPON', c.w, t);
  },
  Box_Of_Sunlight: (c, t) => itemStatus(c, 'INTRAVISION', 30000, t),
  Painting_Box: (c, t) => { boxHeal(c, 0, Math.trunc(c.pc.maxSp * 9 / 100), t); cardEff(c, c, 'silence', 3000, 30000, t); },
};
function itemStatus(c, name, ms, t, lv = 1) { addStatus(c, { name, duration: [] }, lv, t, null, ms); }
function boxHeal(c, hp, sp, t) {
  if (hp > 0) healUnit(c, { type: 'heal', damage: hp }, t);
  if (sp > 0) { c.sp = Math.min(c.pc.maxSp, c.sp + sp); emit('heal', c, { type: 'heal', sp: true, damage: sp }, t); emit('hp', c); }
}
function openBox(c, id, t, depth) {
  const it = db.items[id];
  say(c.w, it.name, t);
  if (!it.group) return BOXES[it.aegis](c, t);
  const g = it.group, all = g.reduce((n, x) => n + x[1], 0);
  let r = rnd(all), k = 0;
  while (r >= g[k][1]) r -= g[k++][1];
  const [got, , n] = g[k];
  for (let i = 0; i < n; i++) gain(c, got, t, depth + 1);
}
// ---------- potions ----------
// Character c drinks potion `id` from the party's bag (W.bag; by request, the 喝藥水 rules). An HP potion heals
// what its item_db script heals (itemheal rand(least, most): jobs.json items heal) times rAthena's pc_itemheal
// bonus — 100% + 2% a point of VIT, 10% a level of Increase HP Recovery, 5% a level of Potion Research; an SP one
// (Blue Potion: itemheal 0,rand(…), items sp) the same with INT, Increase SP Recovery and Potion Research; an
// attack speed one (items aspd: Concentration, Awakening) puts its status on (battle.js BUFF_SKILLS ASPDPOTION…)
// for rAthena's 30 minutes, and not one weaker than one on, nor one its job or level may not use (item_db Jobs,
// EquipLevelMin: mayDrink). Not while frozen, stunned, asleep or stone (pc_useitem: opt1), nor dead; it may cast,
// sit or swing meanwhile (a potion is no skill: no motion), and its next item waits ITEM_MS (item_use_interval).
// The client plays the potion's effect over it (roBrowser ItemEffect: EF_POTION1–5, EF_POTION_CON, the Awakening one).
const ITEM_MS = 100, ASPD_POTION_MS = 1800000;
export const potionHeal = (c, id, roll = true) => {
  const [lo, hi] = db.items[id].heal, st = statusOf(c);
  const bonus = 100 + st.stats.vit * 2 + passiveLv(c, 'SM_RECOVERY') * 10 + passiveLv(c, 'AM_LEARNINGPOTION') * 5;
  // (no Song of Lutie bonus before renewal: pc_itemheal's SC_APPLEIDUN val3 is 0 then)
  return Math.floor((roll ? lo + rnd(hi - lo + 1) : (lo + hi) / 2) * bonus / 100);
};
export const potionSp = (c, id, roll = true) => {
  const [lo, hi] = db.items[id].sp, st = statusOf(c);
  const bonus = 100 + st.stats.int * 2 + passiveLv(c, 'MG_SRECOVERY') * 10 + passiveLv(c, 'AM_LEARNINGPOTION') * 5;
  return Math.floor((roll ? lo + rnd(hi - lo + 1) : (lo + hi) / 2) * bonus / 100);
};
// A character's Aid Potion (skills/merchant/aidpotion.cpp) at level lv on one of the party m: the potion of that level
// (ITEM_BY_LV, paid as the skill goes off) heals what its item_db script does (itemheal, rolled: jobs.json items heal
// and sp) × (100 + 10 × the thrower's Aid Potion + 5 × its Potion Research) %, then × (100 + 2 × m's VIT) % and
// × (100 + 10 × m's Increase HP Recovery) % — SP with INT and Increase SP Recovery instead; m's own Potion Research
// does nothing for it. HP shown as Heal's number (clif_skill_nodamage AL_HEAL), unless it heals SP alone (the Blue
// Potion), whose number is SP's; Heal's effect with Heal's number (roBrowser plays it for that packet; Aid Potion's own,
// effect 299, is nothing).
function pitchPotion(c, p, t) {
  const m = p.target, it = db.items[ITEM_BY_LV.AM_POTIONPITCHER[p.lv - 1]] || {}, st = statusOf(m);
  const skill = 100 + passiveLv(c, 'AM_POTIONPITCHER') * 10 + passiveLv(c, 'AM_LEARNINGPOTION') * 5;
  const roll = ([lo, hi]) => lo + rnd(hi - lo + 1);
  let hp = 0, sp = 0;
  if (it.heal) {
    hp = Math.trunc(Math.trunc(roll(it.heal) * skill / 100) * (100 + st.stats.vit * 2) / 100);
    if (m.isPc) hp = Math.trunc(hp * (100 + passiveLv(m, 'SM_RECOVERY') * 10) / 100);
  }
  if (it.sp) {
    sp = Math.trunc(Math.trunc(roll(it.sp) * skill / 100) * (100 + st.stats.int * 2) / 100);
    if (m.isPc) sp = Math.trunc(sp * (100 + passiveLv(m, 'MG_SRECOVERY') * 10) / 100);
  }
  emit('success', `${p.sk.name}_${p.lv}`, m.w, t);  // (the bottle of that level breaking, stage.js)
  if (hp > 0 || sp <= 0) { healUnit(m, { type: 'heal', damage: hp }, t, c); emit('success', 'AL_HEAL', m.w, t); }
  if (sp > 0 && m.isPc) { m.sp = Math.min(m.pc.maxSp, m.sp + sp); emit('heal', m, { type: 'heal', sp: true, damage: sp }, t); emit('hp', m); }
}
// character c's job and base level may use item `id` (item_db Jobs: jobs.json items noJobs; EquipLevelMin)
export const mayDrink = (c, id) => { const it = db.items[id] || {}; return !(it.noJobs || []).includes(jobFor(c).name) && c.blv >= (it.minLevel || 0); };
// the attack speed potion on character c (its SC_ASPDPOTION number), or -1
const aspdOn = c => {
  let n = -1;
  for (const s of c.sc) if (s.name.startsWith('ASPDPOTION') && W.t < s.until) n = Math.max(n, +s.name.slice(10));
  return n;
};
export function drink(c, id, t) {
  const it = db.items[id] || {};
  if (c.dead != null || c.frozen || c.stunned || c.asleep || c.stone || t < (c.itemAt || 0) || !(purse(c).bag[id] > 0) || !mayDrink(c, id)) return false;
  if (!it.heal && !it.sp && (it.aspd == null || it.aspd <= aspdOn(c))) return false;
  const p = purse(c);
  p.bag[id]--;
  bagN++;
  p.used[id] = (p.used[id] || 0) + 1;
  tallyOf(c).items[id] = (tallyOf(c).items[id] || 0) + 1;
  c.itemAt = t + ITEM_MS;
  emit('potion', c, id, t);
  if (it.heal) healUnit(c, { damage: potionHeal(c, id) }, t);
  if (it.sp) c.sp = Math.min(c.pc.maxSp, c.sp + potionSp(c, id));
  if (it.aspd != null) {
    c.sc = [...c.sc.filter(s => !/^ASPDPOTION\d$/.test(s.name)), { name: 'ASPDPOTION' + it.aspd, lv: 1, start: t, until: t + ASPD_POTION_MS, effect: null }];
    recalc(c);
  }
  return true;
}
// the potions in the bag of a kind ('heal', 'sp' or 'aspd') that character c may drink, in the order its rule goes
// through them (heal, sp: least first, as they give it back on average; aspd: strongest first). Worked out again
// only when the bag changes (a potion drunk, bagChanged) or is another (by profile: the drink rules, read every
// step, worked them out every time, a fifth of a fight's time)
let bagSeen = null, rivalBagSeen = null, bagN = 0, bagAt = -1;
const shelves = new Map();
export const bagChanged = () => { bagN++; };
function inBag(c, kind) {
  if (bagSeen !== W.bag || rivalBagSeen !== W.rival.bag || bagAt !== bagN) { shelves.clear(); bagSeen = W.bag; rivalBagSeen = W.rival.bag; bagAt = bagN; }
  let shelf = shelves.get(c);
  if (!shelf) shelves.set(c, shelf = {});
  if (!shelf[kind]) {
    const bag = purse(c).bag, have = Object.keys(bag).filter(id => { const v = (db.items[id] || {})[kind]; return bag[id] > 0 && (kind === 'aspd' ? v != null : v) && mayDrink(c, +id); }).map(Number);
    shelf[kind] = kind === 'heal' ? have.sort((a, b) => potionHeal(c, a, false) - potionHeal(c, b, false))
      : kind === 'sp' ? have.sort((a, b) => potionSp(c, a, false) - potionSp(c, b, false))
      : have.sort((a, b) => db.items[b].aspd - db.items[a].aspd);
  }
  return shelf[kind];
}
// the potion character c's 喝藥水 drinks: of those in the bag, the smallest that makes up what it is missing (on
// average), else the biggest; null for none
function potionFor(c) {
  const have = inBag(c, 'heal');
  return have.find(id => potionHeal(c, id, false) >= maxHp(c) - c.hp) ?? have[have.length - 1] ?? null;
}
// the SP potion character c's 喝藍藥水 drinks (the same way), and the attack speed potion its 喝攻速藥水 does: the
// strongest it may drink, if stronger than the one on it
function spPotionFor(c) {
  const have = inBag(c, 'sp');
  return have.find(id => potionSp(c, id, false) >= c.pc.maxSp - c.sp) ?? have[have.length - 1] ?? null;
}
function speedPotionFor(c) {
  const have = inBag(c, 'aspd');
  return have.length && db.items[have[0]].aspd > aspdOn(c) ? have[0] : null;
}
// the rules that drink (read apart from the rest: drinkRules), and which potion each picks
const DRINKS = { potion: potionFor, spPotion: spPotionFor, speedPotion: speedPotionFor };
// (asked of every rule every step: a rule's do may be a list, which Object.hasOwn would turn into a string each time)
export const isDrink = d => typeof d === 'string' && Object.hasOwn(DRINKS, d);

// ---------- slaves and metamorphosis ----------
// a monster's def by its mob_db id (jobs.json; summoned and hatched ones are listed there too)
const mobDef = id => db.mobs.find(x => x.id === id) || null;
// the sprites monster def may bring into the fight: its own, and those of what it summons or turns into, and so on
// (what the sandbox and mapsim.js load before a fight: the motions are read off them)
export function spritesOf(def, out = new Set()) {
  if (!def || out.has(def.sprite)) return out;
  out.add(def.sprite);
  for (const r of def.skills || []) if (r.skill === 'NPC_SUMMONSLAVE' || r.skill === 'NPC_METAMORPHOSIS') for (const id of r.vals || []) spritesOf(mobDef(id), out);
  return out;
}
// monster m's slaves on the floor, standing (mob_countslave: on the map, so not the dead)
const slaves = m => W.mobs.filter(x => x.master === m && alive(x));
export const slavesOf = slaves;
// what a monster spawned by monster m is: its own def, but giving no EXP if m gives none (a map's waves give none: fight.js)
const kinOf = (m, def) => m.def.baseExp || m.def.jobExp ? def : { ...def, baseExp: 0, jobExp: 0 };
// Monster m brings `amount` of the monsters `ids` (mob_summonslave): round-robin through them, from a random one when
// it brings fewer than there are kinds (amount + k, k random), each on a random free cell within MOB_SLAVEDISTANCE of
// it (map_search_freecell, flag 0; else its own cell). As slaves (Summon Slave: master_id) they take the slave mode
// (slaves_inherit_mode 4, official: CanMove, CanAttack and NoRandomWalk, nothing else: not aggressive) and its walk
// speed (slaves_inherit_speed 3), and follow it (slaveAi); otherwise (Metamorphosis' others) they are on their own.
// Each is `by` m (fight.js counts them in m's wave). sandbox.js shows them ('spawn').
const MOB_SLAVEDISTANCE = 2;
function summonMobs(m, ids, amount, t, slave) {
  ids = ids.filter(mobDef);
  const count = ids.length;
  if (!count) return;
  let k = 0;
  if (amount > 0 && amount < count) { k = rnd(count); amount += k; }
  for (; k < amount; k++) {
    const at = freeCellNear(m.w.cell, MOB_SLAVEDISTANCE) || [...m.w.cell];
    const s = addMob(kinOf(m, mobDef(ids[k % count])), at);
    s.by = m;
    if (slave) {
      s.master = m;
      s.st.mode = B.MD.CANMOVE | B.MD.NORANDOMWALK | B.MD.CANATTACK;
      s.aggressive = false;
      s.st.walkSpeed = s.base.walkSpeed = s.w.cellMs = m.st.walkSpeed;
    }
    emit('spawn', s, t);
  }
}
// Monster m turns into monster def (mob_class_change): its figures, look and skills are def's, at full HP
// (monster_class_change_full_recover, official); Keeping ends, its attack, walk and cast stop, its skill delays and
// target are cleared (and whom it was reacting to). Its other statuses stay.
function changeClass(m, def, t) {
  endStatus(m, 'NPC_KEEPING');
  def = kinOf(m, def);
  const st = B.mobStatus(def);
  Object.assign(m, { def, st, hp: st.maxHp, cast: null, chaseRow: null, skillReady: {}, attacked: [], buffed: false,
                     base: { amotion: st.amotion, adelay: st.adelay, walkSpeed: st.walkSpeed, hit: st.hit, flee: st.flee, def: st.def, batk: st.batk } });
  m.w.stop();
  m.w.cellMs = st.walkSpeed;
  mobRecalc(m);
  unlockTarget(m, t);
  emit('morph', m, t);
}
// A slave's turn (mob_ai_sub_hard_slavemob), before the rest of its AI: its master gone, it dies (status_kill). Busy with
// a target, nothing more. Else, farther than MOB_SLAVEDISTANCE from its master (or on its very cell) it walks back to
// a random free cell that near it (map_search_freecell flag 1), and else, once a MIN_MOBLINKTIME at most, takes its
// master's target if it can see it. True when that was its turn.
function slaveAi(m, t) {
  const ma = m.master;
  if (m.homun) { const k = homunAi(m, t); if (k != null) return k; }  // (a homunculus: homunAi)
  if (!inFight(ma) || ma.dead != null) { killMob(m, t); return true; }
  if (m.target) return false;
  const d = field.distance(m.w, ma.w);
  if (m.st.mode & B.MD.CANMOVE && (d > MOB_SLAVEDISTANCE || d === 0) && t >= m.stunUntil && !m.w.rooted && !(m.w.moving && cheb(walkEnd(m), ma.w.cell) <= MOB_SLAVEDISTANCE)) {
    const at = freeCellNear(ma.w.cell, MOB_SLAVEDISTANCE);
    if (at && m.w.walkTo(...at)) return true;
  }
  if (m.st.mode & B.MD.CANATTACK && t - m.lastLink >= LINK_MS && ma.target && alive(ma.target) && ma.target.side !== m.side) {
    m.lastLink = t;
    if (sees(m, ma.target)) { m.target = ma.target; return true; }
  }
  return false;
}
// monster m dies at once, of nothing that hit it (status_kill: a slave whose master fell)
function killMob(m, t) {
  m.hp = 0;
  W.hits = W.hits.filter(h => h.to !== m);
  mobDies(m, t, true);
}

// monster m took hit r from unit c (see hurt)
function mobHurt(m, r, t, react, c) {
  if (c.isPc) m.struck = true;  // (the party has hit it)
  if (r.damage > 0) m.hitBy = c;  // (whom a Marine Sphere runs off from: randomMove)
  if (r.damage > 0 && r.skill && mobEventSkill(m, 'skillused', t, r.skill.name) && m.dead != null) return;
  // An attack that connects (a miss does not) makes the monster react to its attacker once its damage motion
  // is over (battle_damage → mob_attacked / mob_norm_attacked after battle_calc_walkdelay): see mobAi.
  if (react && m.hp > 0) {
    const div = r.hits > 10 ? 2 : r.hits || 1;
    m.attacked.push({ at: t + Math.max(1, m.st.dmotion * slowK(m) + MULTIHIT_DELAY * (div - 1)), by: c, norm: !!r.norm });
    m.attacked.sort((a, b) => a.at - b.at);
  }
  if (m.hp === 0) {
    // with more of a multi-hit attack still to land it holds on, dying, until the last of it (landHits)
    if (!comboOn(m)) return mobDies(m, t);
    m.dying = true;
    m.cast = null;
    m.w.halt();
    dropTarget(m, t);
    return hurtMotion(m, t);
  }
  if (!hurtMotion(m, t) || !react) return;
  // damage motion: no walking until it is over (unit_set_walkdelay; attacks go on), once per attack
  m.stunUntil = t + m.st.dmotion * slowK(m);
  m.w.halt();
}
// the hurt animation, again with every hit of a multi-hit attack (by eye: the client reacts once per damage
// packet, roBrowser onEntityWillBeHitSub); an attack motion in progress plays on. Not while the monster cannot
// be stopped (endure: fire and undead monsters in a Fire Wall; Endure on it, SC_ENDURE: its dmotion 0): false then.
function hurtMotion(m, t) {
  if (t < (m.endureUntil || 0) || has(m, 'SM_ENDURE')) return false;
  const { n, delay } = motion.mob(m, 3);
  if (!busy(m.anim, t) || m.anim.grp !== 2) m.anim = { grp: 3, start: t, fd: delay, end: t + n * delay };
  return true;
}
// a multi-hit attack's hits are still to land on monster m
const comboOn = m => W.hits.some(h => h.to === m && h.combo);
// monster m dies: its death animation, then the corpse goes (step)
// (killed: by status_kill, which gives EXP only to who had hurt it: here only if the party had)
function mobDies(m, t, killed = false) {
  endAils(m, t);
  m.dead = t;
  if (m.homun && m.owner.homun && m.owner.homun.unit === m) Object.assign(m.owner.homun, { state: 'dead', unit: null, hp: 0 });  // (hom_dead)
  if (!killed || m.struck) { giveExp(m, t); dropLoot(m); cardDrops(m); }
  for (const s of slaves(m)) killMob(s, t);  // (its slaves with it: mob_deleteslave)
  m.dying = false;
  m.anim = null;
  m.w.halt();
  dropTarget(m, t);
  const { n, delay } = motion.mob(m, 4);
  m.gone = t + n * delay + CORPSE_MS;  // step() removes the corpse then
}
// RandomTarget: each normal attack goes to a random enemy within its attack range (mob_randomtarget);
// whom it is after stays the same
function randomTarget(m) {
  if (!(m.st.mode & B.MD.RANDOMTARGET)) return m.target;
  const near = enemies(m).filter(c => c.dead == null && field.distance(m.w, c.w) <= m.st.range && !slyOff(m, c));
  return near.length ? near[rnd(near.length)] : m.target;
}
// the direction unit u faces (its heading, as map_calc_dir's eight), and whether two directions are the same or next to
// each other (map_check_dir 0)
const facing = u => calcDir([0, 0], u.w.heading);
// the step one cell in each of calcDir's directions
// the weapon each swap order takes up ('' its own)
const SWAPS = { bow: '활', dagger: '단검', instrument: '', ownWeapon: '' };
const DIVESTS = ['RG_STRIPWEAPON', 'RG_STRIPARMOR', 'RG_STRIPSHIELD', 'RG_STRIPHELM'];
const DIR_STEP = [[0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1]];
const nearDir = (a, b) => Math.min((a - b + 8) % 8, (b - a + 8) % 8) <= 1;
// unit u stands behind unit m for Back Stab (pre-renewal skill_check_condition_target): not on its cell, and m facing the
// way from u to it, or one direction off (map_check_dir of map_calc_dir(u, m) and m's own)
const behind = (u, m) => !sameCell(u.w.cell, m.w.cell) && nearDir(calcDir(u.w.cell, m.w.cell), facing(m));
// Counter Attack on character c (battle_weapon_attack: SC_AUTOCOUNTER) as unit `by`'s normal attack comes: one from
// its own cell, or from in front of it (within one direction of where it faces: map_check_dir) and within its
// weapon's range + 1, is blocked (a Miss), the status ends and c strikes back at once with KN_AUTOCOUNTER at its
// level (skill_attack: no SP, no delay; always critical), its attack motion's hit frame bringing it. True if so.
function autoCounter(c, by, t) {
  const s = c.isPc && c.sc.find(x => x.name === 'KN_AUTOCOUNTER' && t < x.until);
  if (!s) return false;
  const dist = field.distance(c.w, by.w), front = nearDir(calcDir(c.w.cell, by.w.cell), facing(c));
  if (!(dist <= 0 || (front && dist <= c.pc.range + 1))) return false;
  endStatus(c, 'KN_AUTOCOUNTER');
  emit('counter', c, t);
  const p = { sk: db.skills.KN_AUTOCOUNTER, lv: s.lv, target: by };
  DOES.attack(c, p, t, skillMotion(c, p.sk, t, by));
  return true;
}
// Root (MO_BLADESTOP, battle_weapon_attack): a normal attack on character c while it waits (bladeWait), from within 2
// cells, is caught — shown as a Miss — and both are held (SC_BLADESTOP) for Duration2 (10 s; 2 s on a boss, renewal):
// neither walks or attacks, the monster does nothing at all, and c may use only what Root's level allows (BLADE_SKILLS,
// skillFail; Raging Quadruple Blow with no combo before it, on the one caught; Asura Strike a sphere cheaper), any of
// which ends it for both (fireSkill), as the time running out or either going down does (status_change_end: the other's
// with it). roBrowser greys both (OPT3 BLADESTOP, 0.25: stage.js).
const BLADE_SKILLS = { MO_FINGEROFFENSIVE: 2, MO_INVESTIGATE: 3, MO_CHAINCOMBO: 4, MO_EXTREMITYFIST: 5 };
function bladeCatch(c, by, t) {
  const w = c.isPc && c.bladeWait;
  if (!w || t >= w.until || field.distance(c.w, by.w) > 2) return false;
  c.bladeWait = null;
  const until = t + (isBoss(by) ? 2000 : db.skills.MO_BLADESTOP.duration2[w.lv - 1] || 0);
  c.bladeStop = { with: by, lv: c.levels.MO_BLADESTOP || w.lv, until };
  by.bladeStop = { with: c, lv: w.lv, until };
  for (const u of [c, by]) { u.cast = null; holdWalk(u, until); }
  // both held as they are caught till it ends (by request): the monk turned to it in the casting pose's fifth frame,
  // the monster's swing played to its hit frame and held there
  field.face(c.w, by.w);
  c.anim = { start: t, group: castGroup(db.skills.MO_BLADESTOP), frames: 1, fd: 1, target: by, skill: true, blade: true,
             hold: Math.min(4, motion.pc(c, castGroup(db.skills.MO_BLADESTOP)).frames - 1), until };
  if (by.anim && !by.isPc) Object.assign(by.anim, { end: until, hold: motion.mobAttack(by).hf, blade: true });
  emit('success', 'MO_BLADESTOP', c.w, t);
  return true;
}
function endBladeStop(u, t) {
  for (const x of [u, u.bladeStop && u.bladeStop.with]) {
    if (!x || !x.bladeStop) continue;
    x.bladeStop = null;
    x.held = t;
    if (x.anim && x.anim.blade) x.anim = null;  // (its held pose with it)
  }
}
// (Root's wait or hold run out, or the other gone: true while u is held)
function bladeTick(u, t) {
  if (u.bladeWait && t >= u.bladeWait.until) u.bladeWait = null;
  const s = u.bladeStop;
  if (s && (t >= s.until || !alive(s.with) || !alive(u))) endBladeStop(u, t);
  return !!u.bladeStop;
}
export const bladeStopped = u => !!u.bladeStop;
// Poison React on character c (SC_POISONREACT, battle.cpp) as monster `by`'s normal attack comes (battle_weapon_attack).
// From a poison-element monster, while it waits (val4 0): the attack is blocked (ATK_BLOCK; shown here as a Miss, its
// swing having played), the status turns to the counter (`boost`) and c goes for `by` (unit_attack) — its next
// normal attack is poisonReactAtk's. Otherwise, one that does damage: at 50% c strikes back with Envenom Lv 5 as it
// lands (skill_attack: no SP, its attack motion), and either way that uses up one of its Lv / 2 (at least one)
// (val2; ending it at none left). True if blocked.
function poisonReact(c, by, t, r = null) {
  const s = c.isPc && c.sc.find(x => x.name === 'AS_POISONREACT' && t < x.until);
  if (!s) return false;
  if (!r) {
    if (s.boost || statusOf(by).element !== 'Poison') return false;
    s.boost = true;
    emit('counter', c, t, 'AS_POISONREACT');
    if (!c.pending && !hidden(c)) engage(c, by);
    return true;
  }
  if (!(r.damage > 0) || rnd(100) >= 50) return false;
  W.later.push({ at: r.at, by: c, to: by, run(at) {
    const p = { sk: db.skills.TF_POISON, lv: 5, target: by };
    DOES.attack(c, p, at, skillMotion(c, p.sk, at, by));
  } });
  s.left ??= Math.max(1, Math.trunc(s.lv / 2));
  if (--s.left <= 0) endStatus(c, 'AS_POISONREACT');
  return false;
}
// Poison React's counter (battle_calc_attack_skill_ratio: SC_POISONREACT val4 1) on character c's normal attack:
// + 30 × Lv % (the skill's level learned), and as it hits, a 50% try at poisoning the target for Duration2 (60 s,
// against its VIT: poisonOdds); the status ends with that hit
function poisonReactAtk(c, src) {
  const s = c.sc.find(x => x.name === 'AS_POISONREACT' && x.boost && W.t < x.until);
  if (!s) return { src, s: null };
  const lv = c.levels.AS_POISONREACT || s.lv;
  return { src: { ...src, atkRate: (src.atkRate || 0) + 30 * lv, atkBy: [...src.atkBy || [], `毒性反彈 +${30 * lv}%`] }, s };
}
// monster m's normal attack on unit c (its skills go off as anyone's do, fireSkill)
function startMobAttack(m, t, c) {
  const { n, delay: d, hf } = motion.mobAttack(m), delay = d * slowK(m) * aspdK(m);
  // (a Cloaking monster's attack ends it: monster_cloak_check_type 4; Invisible's stays)
  if (cloaked(m) && !m.sc.find(s => s.name === 'AS_CLOAKING').stay) endStatus(m, 'AS_CLOAKING');
  field.face(m.w, c.w);
  m.anim = { grp: 2, start: t, fd: delay, end: t + n * delay };
  const r = bladeCatch(c, m, t) || autoCounter(c, m, t) || poisonReact(c, m, t) ? { type: 'miss', damage: 0 } : B.attack(db, offense(m), defense(c)), at = t + hf * delay;
  poisonReact(c, m, t, { damage: r.damage, at });
  schedule(r, m, c, at);
  emit('mobAttack', m, c, at, hitCount(r), hitGap(r));
  mobAttacked(m, c, t);
}
// monster m attacked unit c (a normal attack or a skill): its next attack waits out its attack delay, and an
// assisting monster calls its kind (mob_linksearch: same monster, assist mode, no target yet, not linked
// within the last second)
function mobAttacked(m, c, t) {
  m.nextAttack = t + m.st.adelay * slowK(m);
  if (c && m.st.mode & B.MD.ASSIST && t - m.lastLink >= LINK_MS) {
    m.lastLink = t;
    for (const o of allies(m))
      if (o !== m && alive(o) && o.def.id === m.def.id && o.st.mode & B.MD.ASSIST && !o.target &&
          t - o.lastLink >= LINK_MS && field.distance(o.w, m.w) <= ASSIST_RANGE) { o.lastLink = t; o.target = c; }
  }
}
// character c took hit r from unit `by` (see hurt). Under Endure it has no damage motion (dmotion 0): no hurt
// motion, no battle stance from it, and a walk goes on.
const SIT_AGAIN_MS = 500;
function pcHurt(c, r, t, react, by) {
  // damage stands a sitting character up (pc_damage); 自動 waits SIT_AGAIN_MS before sitting down again (by request)
  if (c.sitting) { sit(c, false); c.sitAfter = t + SIT_AGAIN_MS; }
  // (what it has taken lately: 自動's thief hides when it is a lot: see burst)
  c.taken = [...(c.taken || []).filter(x => t - x.t < BURST_MS), { t, dmg: r.damage }];
  const shows = react && c.pc.dmotion > 0;
  if (shows && (!c.anim || t >= animEnd(c.anim))) c.hurt = t;
  if (shows) c.alert = true;  // roBrowser: the hurt motion, then READYFIGHT (not for a miss or an endured hit)
  // damage stops a walk on the next cell centre (damage_walk_delay 0: no further walk delay, a new walk
  // command goes at once). Walking on to the target is the player's click; the sandbox makes it once
  // the damage motion is over, so the hurt motion shows.
  // (a stop within the damage motion of the last is still that one: stops)
  if (shows && c.w.moving && !c.cardFx?.noWalkDelay) {  // (a card's bNoWalkDelay: none)
    if (t >= c.recover) c.stops = [...c.stops.filter(x => t - x < STOP_MS), t];
    c.w.stop();
    c.recover = t + c.pc.dmotion;
  }
  if (react) endured(c, by);
  if (c.hp === 0) die(c, t);
  emit('hp', c);
}
// an attack that dealt damage landed on character c: Endure counts it if a monster's (battle_calc_damage:
// once an attack, not for players), and ends with its last hit (that one was still endured)
function endured(c, by) {
  const s = c.sc.find(x => x.name === 'SM_ENDURE');
  if (!s || by.isPc || --s.hits > 0) return;
  c.sc = c.sc.filter(x => x !== s);
  recalc(c);
}

// mobskill_use: the first of the monster's skills for this state that is ready (its delay since the last
// use is over), whose condition holds and whose rate roll passes (rate is out of 10000). Only rows whose
// skill is worked out (SKILL_USE) are used: at the current target, or on the monster itself for a skill that
// is not an attack (Hiding, Heal; `self` in the row returned). selfOnly: only those on itself. One whose target
// is out of the skill's range (mobRange) is not used, and no other is tried after it (mob_ai 0x1000 off: break).
function mobSkill(m, state, t, selfOnly = false) {
  if (m.silenced) return null;  // (NoCast)
  const rows = m.def.skills || [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!(r.state === state || r.state === 'any' || (r.state === 'anytarget' && m.target)) || !SKILL_USE[r.skill]) continue;
    const sk = db.skills[r.skill], spot = sk.target === 'Ground' ? groundRow(r.target) : null;
    if (sk.target === 'Ground' && !spot) continue;
    const self = !spot && (r.target === 'self' || (SKILL_USE[r.skill].untargeted && !m.target)) && (MOB_SELF_TARGETS.includes(sk.target) || !!SKILL_USE[r.skill].self);
    const forFriend = !spot && r.target === 'friend';
    if (spot ? spot.onTarget && (selfOnly || !m.target) : !self && !forFriend && (selfOnly || r.target !== 'target' || !m.target)) continue;
    if (t < (m.skillReady[i] || 0)) continue;
    // a friend row: at the friend its condition found (friendhpltmaxrate), else at itself (MST_FRIEND's fallthrough)
    const friend = forFriend && r.cond === 'friendhpltmaxrate' ? hurtFriend(m, +r.condValue) : null;
    if (forFriend ? r.cond === 'friendhpltmaxrate' && !friend : !mobCond(m, r)) continue;
    if (rnd(10000) >= r.rate) continue;
    const at = spot ? (spot.onTarget ? m.target : m) : friend || (forFriend ? m : !self && m.target);
    if (at && at !== m && !spot && magicImmune(m, at, sk)) continue;  // (a character magic cannot be aimed at: not cast)
    if (at && at !== m && (field.distance(m.w, at.w) > mobRange(sk, r.lv) || !field.sees(m.w.cell, at.w.cell))) return null;
    m.skillReady[i] = t + r.delay;
    if (spot) return { ...r, cell: (spot.n && freeCellNear(at.w.cell, spot.n)) || [...at.w.cell] };  // (flag 3: else the cell itself)
    return { ...r, self: self || at === m, friend: at && at !== m && friend };
  }
  return null;
}
const GRIM_SPEED = 24;  // cells a second (see DOES.grimtooth)
const CLOAK_MS = 10000, SNAP_MS = 40, CHARGE_MS = 30, CHARGE_SWING_FROM = 3;  // (the swing's fourth frame, from 0: by request)
export const easeInOutCirc = k => k < 0.5 ? (1 - Math.sqrt(1 - 4 * k * k)) / 2 : (Math.sqrt(1 - (2 - 2 * k) ** 2) + 1) / 2;
// condition friendhpltmaxrate (mob_getfriendhprate): another monster of its side within 8 cells (a square, as
// map_foreachinallrange) at no more than `rate` % of its HP (get_percentage, whole), the first found; not itself
const hurtFriend = (m, rate) => W.mobs.find(x => x !== m && alive(x) && x.side === m.side && field.distance(m.w, x.w) <= 8
  && Math.trunc(x.hp * 100 / x.st.maxHp) <= rate) || null;
// what a self row's skill may be (skill_db TargetType)
const MOB_SELF_TARGETS = ['Self', 'Support'];
// Where a row's ground skill goes (mobskill_use, CAST_GROUND): at its target's cell ('target', 'around5'–'around8'),
// else at its own ('self', 'around1'–'around4'; 'around' is 'around4'): { onTarget, n }, an 'around' row on a free cell
// up to n cells off that one (freeCellNear). Other targets (randomtarget, friend, master) are not worked out: null.
function groundRow(target) {
  if (target === 'target') return { onTarget: true, n: 0 };
  if (target === 'self') return { onTarget: false, n: 0 };
  const k = target.match(/^around([1-8]?)$/);
  if (!k) return null;
  const v = +(k[1] || 4);
  return v >= 5 ? { onTarget: true, n: v - 4 } : { onTarget: false, n: v };
}
// a random cell up to n cells off cell [bx, by] either way, not that cell, one to be stood on (map_search_freecell;
// rAthena also keeps 5 cells off the map's edge, which on the sandbox's small floor would leave little): 50 tries,
// else null
function freeCellNear([bx, by], n) {
  for (let i = 0; i < 50; i++) {
    const x = bx - n + rnd(2 * n + 1), y = by - n + rnd(2 * n + 1);
    if ((x !== bx || y !== by) && field.open(x, y)) return [x, y];
  }
  return null;
}
// a monster's range for skill sk at level lv (skill_get_range2): skill_db's, negated if below 0 (skillrange_from_weapon
// off: an element attack's -7 is 7 cells, whatever its own attack range), at most 14; none is 9
const mobRange = (sk, lv) => Math.min(14, Math.abs(sk.range[lv - 1] || 0)) || 9;
// a skill row's condition (mob_skill_db ConditionType, the ones worked out): always, its HP under condValue %,
// a status on itself (MSC_MYSTATUSON: condValue the status, of MOB_STATUS), at least (more than) condValue
// enemies attacking it (MSC_ATTACKPCGE / GT: unit_counttargeted, the characters whose target it is), at most
// (fewer than) condValue slaves (MSC_SLAVELE / LT: mob_countslave). 'onspawn' rows go as it spawns (mobEventSkill).
const MOB_STATUS = { hiding: 'TF_HIDING' };
export const mobCondDone = r => ['always', 'myhpltmaxrate', 'attackpcge', 'attackpcgt', 'slavele', 'slavelt', 'onspawn', 'alchemist', 'trickcasting'].includes(r.cond) || (r.cond === 'mystatuson' && !!MOB_STATUS[r.condValue]);
const attackers = m => allChars().filter(c => c.dead == null && c.target === m).length;
// whether skill row r is worked out here (the monster panel's 未做), as mobSkill and mobEventSkill take it: its skill,
// its target and its condition
export function mobRowDone(r) {
  if (r.state === 'loot') return false;  // (nothing lies on the floor to pick up: no MSS_LOOT)
  if (r.cond === 'rudeattacked') return !!MOB_EVENT_SKILLS[r.skill];
  if (MOB_EVENTS.includes(r.cond)) return !!SKILL_USE[r.skill] && r.target === 'self';
  const use = SKILL_USE[r.skill], sk = db.skills[r.skill];
  if (!use || !sk) return false;
  if (sk.target === 'Ground') return !!groundRow(r.target) && mobCondDone(r);
  if (r.target === 'friend') return r.cond === 'friendhpltmaxrate' || mobCondDone(r);
  return (r.target === 'target' || (r.target === 'self' && (MOB_SELF_TARGETS.includes(sk.target) || !!use.self))) && mobCondDone(r);
}
function mobCond(m, r) {
  if (r.cond === 'always') return true;
  if (r.cond === 'attackpcge') return attackers(m) >= +r.condValue;
  if (r.cond === 'attackpcgt') return attackers(m) > +r.condValue;
  if (r.cond === 'myhpltmaxrate') return m.hp * 100 / m.st.maxHp < +r.condValue;
  if (r.cond === 'mystatuson') return !!MOB_STATUS[r.condValue] && has(m, MOB_STATUS[r.condValue]);
  if (r.cond === 'slavele') return slaves(m).length <= +r.condValue;
  if (r.cond === 'slavelt') return slaves(m).length < +r.condValue;
  // (MSC_ALCHEMIST: one an alchemist summoned, hurt, not trick casting; MSC_TRICKCASTING: trick casting, Random Move's)
  if (r.cond === 'alchemist') return !!m.owner && !m.trick && m.hp < m.st.maxHp;
  if (r.cond === 'trickcasting') return !!m.trick;
  return false;
}
// monster m uses the skill of row `row` (mobSkill): cast first if the row has a cast time, else at once
function mobUse(m, row, t) {
  // (a cast at a friend stays on that friend, one on the ground on its cell: `fixed`)
  const target = row.cell ? { w: field.spot(...row.cell), ground: true } : row.self ? m : row.friend || m.target;
  const p = { sk: db.skills[row.skill], lv: row.lv, target, self: row.self, fixed: !!row.friend || !!row.cell, vals: row.vals,
              emotion: rowEmotion(row) };
  if (row.cast > 0) {
    const ms = row.cast * slowK(m);
    m.cast = { ...p, start: t, end: t + ms, cancelable: !!row.cancelable };
    emit('cast', m, p.sk, p.target.w, t, ms, !!row.cell);
    shout(m.w, p.sk, t, m.cast);
  } else fireSkill(m, p, t);
}
// the skills a monster uses on itself outside of its attack (Smokie's Heal while hidden), checked every
// MOB_SKILL_INTERVAL while it is not walking (mob_ai_sub_hard; only rows on itself here, the others go with its
// attack as before)
const MOB_SKILL_MS = 1000;
// Chasing (MSS_RUSH, or MSS_FOLLOW angry), a monster checks its skills for that state every MOB_SKILL_INTERVAL as
// it walks (unit_walktoxy_timer, each cell: less half a cell's time, so once a second on average): one picked
// (its target within the skill's range: Dark Frame's Petrify Attack from 7 cells off, the Sageworm's bolts) stops
// the walk (clif_fixpos; here on the cell being walked into) and goes off there (chaseSkill)
// The same as it walks about with no target (MSS_WALK: its 'walk' rows). An emote, and a walk row's skill, go off
// without stopping the walk (unit_walktoxy_timer: NPC_EMOTION and MSS_WALK do not abort it).
function chaseSkill(m, t) {
  if (m.cast || m.chaseRow || t < (m.skillCheck || 0) - m.w.cellMs / 2) return false;
  m.skillCheck = t + MOB_SKILL_MS;
  const row = mobSkill(m, skillState(m), t);
  if (!row) return false;
  if (row.skill === 'NPC_EMOTION' || row.state === 'walk' || m.trick) { mobUse(m, row, t); return false; }  // (nor on Random Move's: state.can_escape)
  if (!m.target) { m.w.stop(); mobUse(m, row, t); return true; }  // (any other with no target: there and then)
  m.chaseRow = row;
  m.w.stop();
  return true;
}
function idleSkill(m, t) {
  if (m.w.moving || m.stone || m.cast || t < (m.skillCheck || 0)) return;
  m.skillCheck = t + MOB_SKILL_MS;
  const row = mobSkill(m, skillState(m), t, true);
  if (row) mobUse(m, row, t);
}
// a monster that cannot walk to its target (here: in hiding) idles for its idle skills, keeping the target,
// and lets it go after mob_unlock_time
const MOB_UNLOCK_MS = 2000;
// the state a monster's skill rows are picked by (mob_setstate names: MSS_IDLE / WALK, BERSERK / ANGRY,
// RUSH / FOLLOW)
// (walking off on Random Move it stays idle: unit_escape sets no state)
const skillState = m => !m.target ? (m.w.moving && !m.trick ? 'walk' : 'idle')
  : m.mss === 'attack' ? (m.mssAngry ? 'angry' : 'attack') : m.mss === 'chase' ? (m.mssAngry ? 'follow' : 'chase') : 'idle';
// skills a monster uses on an event (mobskill_use with an event): what each does
export const MOB_EVENT_SKILLS = {
  // Teleport: it reappears on a random cell of the floor and drops its target
  AL_TELEPORT: (m, r, t) => teleportUnit(m, t),
};
// a skill row's emote (its `emotion` column, an ET_ id), or null for none
const rowEmotion = r => r.emotion !== '' && r.emotion != null && +r.emotion >= 0 && +r.emotion < ET_MAX ? +r.emotion : null;
// the events mobEventSkill takes rows on itself for (besides 'rudeattacked': MOB_EVENT_SKILLS)
const MOB_EVENTS = ['onspawn', 'longrangeattacked', 'closedattacked', 'skillused'];
// mobskill_use for an event (cond: 'rudeattacked', MOB_EVENTS): the first row for that event and the monster's state
// whose delay is over and whose rate roll passes: a MOB_EVENT_SKILLS one at once, else one on itself as any other
// (mobUse: Vocal's Summon Slave as it spawns)
// ('skillused': hit by the skill of id condValue, MSC_SKILLUSED; `name` that skill)
function mobEventSkill(m, cond, t, name = null) {
  if (m.silenced) return false;  // (NoCast)
  const rows = m.def.skills || [], state = skillState(m);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], use = SKILL_USE[r.skill];
    if (r.cond !== cond || !(MOB_EVENT_SKILLS[r.skill] || (use && r.target === 'self'))) continue;
    if (cond === 'skillused' && (db.skills[name] || {}).id !== +r.condValue) continue;
    if (!(r.state === state || r.state === 'any' || (r.state === 'anytarget' && m.target))) continue;
    if (t < (m.skillReady[i] || 0) || rnd(10000) >= r.rate) continue;
    m.skillReady[i] = t + r.delay;
    if (!MOB_EVENT_SKILLS[r.skill]) { mobUse(m, { ...r, self: true }, t); return true; }
    if (rowEmotion(r) != null) emit('emotion', m, rowEmotion(r), t);
    shout(m.w, db.skills[r.skill], t);
    MOB_EVENT_SKILLS[r.skill](m, r, t);
    return true;
  }
  return false;
}

// Slyness (RG_GANGSTER, skill_sit → gangsterparadise): a character sitting with it learned, with another sitting with it
// within its splash (1: the 3×3) — monster m, not a boss, leaves it be: it does not go for it, and lets it go if it was
// after it (mob_target, mob_ai_sub_hard)
const gangster = c => c.isPc && c.sitting && c.dead == null && passiveLv(c, 'RG_GANGSTER') > 0;
const slyOff = (m, c) => !!c && !isBoss(m) && gangster(c) &&
  crewOf(c).some(x => x !== c && gangster(x) && cheb(x.w.cell, c.w.cell) <= (db.skills.RG_GANGSTER.splash[0] || 1));
// the monster's state (mob_setstate): attacking or chasing keeps whether it was angry when the state was set
function setMss(m, s) {
  m.mss = s;
  m.mssAngry = m.aggressive;
}
// drop the target and idle (mob_unlocktarget): an angry monster is angry again, and walks about later
function unlockTarget(m, t) {
  m.target = null;
  m.provoker = null;  // (provoke_flag)
  m.cast = null;
  m.chaseRow = null;
  m.mss = 'idle';
  m.aggressive = !!(m.st.mode & B.MD.ANGRY);
  m.nextWalk = t + RANDOMWALK_MS + rnd(1000);
}
// monster_ai 0x800 (battle.conf, off by default in rAthena): a provoked monster attacks only whom provoked
// it — Provoke always turns it, and no one else's attack turns it away
const PROVOKE_LOCK = true;
// monster m was provoked by unit c (Provoke): its cast drops (unit_skillcastcancel), it remembers c
// (provoke_flag, until it drops its target: mob_unlocktarget), and it turns on c if it would turn to it now
// (mob_target → mob_can_changetarget: with PROVOKE_LOCK, always); one it turns leaves angry mode
function provoked(m, c) {
  m.cast = null;
  m.provoker = c;
  if (m.st.mode & B.MD.CANATTACK && m.target !== c && (!m.target || canChangeTarget(m, c, false))) {
    m.target = c;
    m.aggressive = false;
  }
}
// Whether monster m, after someone already, turns to unit `by` (mob_can_changetarget, monster_ai 0x800):
// a provoked one only to whom provoked it, and always to that one (PROVOKE_LOCK); otherwise angry
// (MSS_ANGRY / MSS_FOLLOW), idle or walking about: always; attacking (MSS_BERSERK): only with
// ChangeTargetMelee, and only for a normal attack from within its attack range + 1 (`norm`, worked out
// as the attack starts); chasing (MSS_RUSH): only with ChangeTargetChase. (Taking a nearer enemy by
// ChangeChase, or by an angry monster's search, does not ask: as in rAthena, those can still leave the
// provoker.)
function canChangeTarget(m, by, norm) {
  if (PROVOKE_LOCK && m.provoker && m.provoker.dead == null && inFight(m.provoker)) return by === m.provoker;
  if (m.mssAngry || m.mss === 'idle') return true;
  if (m.mss === 'attack') return !!(m.st.mode & B.MD.CHANGETARGETMELEE) && norm;
  return !!(m.st.mode & B.MD.CHANGETARGETCHASE);
}
// mob AI for one monster (mob_ai_sub_hard, for the behaviour flags of its AI type)
function mobAi(m, t) {
  if (m.dead != null || m.dying) return;
  expireStatuses(m, t);
  confineTick(m, t);
  if (m.frozen) { if (t < m.frozen.until) return; thaw(m, t); }  // frozen: nothing until it thaws
  if (m.stunned) { if (t < m.stunned.until) return; unstun(m, t); }  // stunned: the same
  if (m.asleep) { if (t < m.asleep.until) return; wake(m, t); }  // asleep: the same
  if (bladeTick(m, t)) return;  // caught in Root: the same
  // Keeping: it cannot attack, act or move for as long (status_change_start: attackabletime, canact_tick and
  // canmove_tick at its end), nor does damage stop it (endure_tick)
  if (has(m, 'NPC_KEEPING')) { m.w.stop(); return; }
  ailTick(m, t);
  if (stoneTick(m, t)) return;  // stone: the same
  // as it spawns, its 'onspawn' rows (mob_spawn → mobskill_use MSC_SPAWN; here on its first turn)
  if (!m.born) { m.born = true; if (mobEventSkill(m, 'onspawn', t)) return; }
  if (m.master && slaveAi(m, t)) return;
  const st = m.st, mode = st.mode | (W.allAggressive ? B.MD.AGGRESSIVE : 0), w = m.w, a = m.anim;
  if (m.target && (m.target.dead != null || m.target.side === m.side || !sees(m, m.target) || slyOff(m, m.target))) unlockTarget(m, t);  // (or Slyness keeps it off)  // its target is down, no enemy now, or in hiding
  // hits whose damage motion is over: the monster is no longer angry, and turns to the attacker if it has
  // no target or would change it now (mob_set_attacked_id → mob_ai_sub_hard)
  // An attacker it cannot hit back nor walk to is a "rude attack" (its target out of its attack range and
  // farther than its chase range, or a new attacker beyond its visual area); the second one in a row
  // sets off its 'rudeattacked' skills (RUDE_ATTACKED_COUNT 1). Taking a new target counts one down.
  while (m.attacked.length && t >= m.attacked[0].at) {
    const e = m.attacked.shift(), by = e.by;
    m.aggressive = false;
    if (!(mode & B.MD.CANATTACK) || by.dead != null || !inFight(by) || !sees(m, by) || slyOff(m, by)) continue;
    const d = field.distance(w, by.w);
    if (by === m.target) {
      if (d > st.range && d > st.chaseRange && ++m.rude > 1) mobEventSkill(m, 'rudeattacked', t);
    } else if (!m.target || canChangeTarget(m, by, e.norm)) {
      if (d > AREA_SIZE) { if (++m.rude > 1) mobEventSkill(m, 'rudeattacked', t); }
      else if (charmedBy(m) !== by) { m.target = by; if (m.rude) m.rude--; }
    }
    if (m.dead != null || !inFight(m)) return;
  }
  // aggressive monsters pick up the nearest enemy within their view range; an angry one chasing
  // (MSS_FOLLOW) keeps looking and goes for anyone nearer (mob_ai_sub_hard_activesearch). One that finds a
  // new target already within its attack range is no longer angry.
  // TargetWeak: it only goes for enemies at least 5 levels below it.
  if ((!m.target || (m.mss === 'chase' && m.mssAngry)) && mode & B.MD.AGGRESSIVE && mode & B.MD.CANATTACK) {
    const prev = m.target;
    const view = m.blind ? 1 : st.viewRange;  // (blind: 1 cell)
    let bd = m.target ? field.distance(w, m.target.w) : view + 1;
    for (const c of enemies(m)) {
      const d = field.distance(w, c.w);
      if (mode & B.MD.TARGETWEAK && baseStatus(c).lv >= st.lv - 5) continue;
      if (charmedBy(m) === c || slyOff(m, c)) continue;  // (Wink of Charm; Slyness)
      if (m.target && m.target.homun && !c.homun) continue;  // (one after a homunculus keeps to it: hom_setting 0x04)
      if (c.dead == null && d < bd && d <= view && field.sees(w.cell, c.w.cell)) { m.target = c; bd = d; }
    }
    if (m.target && m.target !== prev && bd <= st.range) m.aggressive = false;
  }
  // ChangeChase: chasing (MSS_RUSH), it goes for anyone already within its attack range instead
  // (mob_ai_sub_hard_changechase; the nearest here)
  else if (mode & B.MD.CHANGECHASE && m.target && m.mss === 'chase') {
    let bd = Math.min(st.range, m.blind ? 1 : st.viewRange) + 1;
    for (const c of enemies(m)) {
      const d = field.distance(w, c.w);
      if (c !== m.target && c.dead == null && d < bd && field.sees(w.cell, c.w.cell) && !slyOff(m, c)) { m.target = c; bd = d; }
    }
  }
  if (busy(a, t) && a.grp === 2) return;  // mid-attack (a hurt animation does not stop the next attack)
  if (!hidden(m)) m.canMoveAt = t;
  // a skill cast on itself goes off on itself, whatever became of its target (and one at a friend on that friend,
  // if it is still there)
  if (m.cast && (m.cast.self || m.cast.fixed)) {
    if (t >= m.cast.end) { const k = m.cast; m.cast = null; if (k.target.ground || (alive(k.target) && inFight(k.target))) fireSkill(m, k, t, true); }
    return;
  }
  if (looting(m, t, mode)) return;
  if (m.target) {
    const pw = m.target.w, d = field.distance(w, pw);
    if (d > st.chaseRange) return unlockTarget(m, t);  // lost: give up and idle
    // blind, it loses sight of a target more than a cell off once it stands still (mob_ai_sub_hard)
    if (m.blind && d > 1 && !w.moving) return unlockTarget(m, t);
    if (m.cast) {  // casting a skill: stand still until it goes off, at whom it is after by then (not while turning to stone: NoCast)
      if (t >= m.cast.end) { const k = m.cast; m.cast = null; if (!m.stone) fireSkill(m, { ...k, target: m.target }, t, true); }
      return;
    }
    if (mode & B.MD.CANATTACK && d <= st.range && !w.moving && field.sees(w.cell, pw.cell)) {
      setMss(m, 'attack');  // unit_attack
      field.face(w, pw);
      if (m.stone) return;  // turning to stone: no attack, no skill (NoAttack, NoCast)
      if (t >= m.nextAttack) {
        const row = mobSkill(m, m.aggressive ? 'angry' : 'attack', t);
        if (row) mobUse(m, row, t);
        else if (!hidden(m)) startMobAttack(m, t, randomTarget(m));
        else m.nextAttack = t + st.adelay * slowK(m);  // in hiding: no attack, though it stays in the attack state
      }
      return;
    }
    if (hidden(m)) {
      if (t - m.canMoveAt > MOB_UNLOCK_MS) return unlockTarget(m, t);
      m.mss = 'idle';
      return idleSkill(m, t);
    }
    // a chase skill picked: it goes off once the monster stands on its cell (at whom it is after by then)
    if (m.chaseRow) {
      if (w.moving) return;
      const row = m.chaseRow;
      m.chaseRow = null;
      return mobUse(m, row, t);
    }
    if (m.mss === 'chase' && w.moving && chaseSkill(m, t)) return;
    // chase: walk again whenever the current path no longer ends within range of the character
    if (mode & B.MD.CANMOVE && t >= m.stunUntil) {
      const end = w.path.length ? w.path[w.path.length - 1] : w.cell;
      // (confused: it walks where its walk took it before setting out again, as it chases)
      if (m.confused && (w.moving || w.path.length)) return;
      if (cheb(end, pw.cell) > st.range || !field.sees(end, pw.cell)) field.approach(w, pw, st.range);
      if (w.moving || w.path.length) setMss(m, 'chase');  // unit_walktobl
    }
    return;
  }
  if (w.moving) chaseSkill(m, t);  // (walking about: its walk rows)
  else idleSkill(m, t);
  // idle: random walk (mob_randomwalk)
  if (!hidden(m) && mode & B.MD.CANMOVE && !(mode & B.MD.NORANDOMWALK) && !w.moving && t >= m.nextWalk && t >= m.stunUntil) {
    field.wander(w, RANDOMWALK_CELLS);
    m.nextWalk = t + RANDOMWALK_MS + rnd(1000) + field.pathLength(w) * st.walkSpeed * slowK(m);
  }
}

// Looter (its mode): it goes for the nearest loot within its view range that no other monster is going for (m.loot)
// and picks it up once on its cell or next to it, even with a target it is chasing (by request; rAthena's only
// looks for loot with no target, mob_ai_sub_hard_lootsearch) — not while it attacks one in its range, though
// once on its way it keeps going. Picked up, the loot is gone for good (by request: not dropped again at its
// death, as rAthena's lootitem are) and it shows an emote: its own 'loot' rows' (NPC_EMOTION, MSS_LOOT), else
// ET_DELIGHT (by request). → it is about its loot this turn
const ET_DELIGHT = 2;
function looting(m, t, mode) {
  const w = m.w;
  if (!(mode & B.MD.LOOTER) || !(mode & B.MD.CANMOVE) || hidden(m) || m.cast || m.chaseRow || m.confused || t < m.stunUntil) return false;
  let it = m.loot && W.items.includes(m.loot) ? m.loot : null;
  if (!it) {
    m.loot = null;
    if (m.target && field.distance(w, m.target.w) <= m.st.range) return false;
    const view = m.blind ? 1 : m.st.viewRange, taken = new Set(W.mobs.filter(x => x !== m && x.dead == null && x.loot).map(x => x.loot));
    let bd = view + 1;
    for (const x of W.items) { const d = cheb(w.cell, x.w.cell); if (!taken.has(x) && d < bd) { it = x; bd = d; } }
    if (!it) return false;
  }
  if (!w.moving && cheb(w.cell, it.w.cell) <= 1) {
    W.items = W.items.filter(x => x !== it);
    m.loot = null;
    field.face(w, { pos: [it.w.cell[0] + 0.5, it.w.cell[1] + 0.5] });
    const row = (m.def.skills || []).find(r => r.state === 'loot' && r.skill === 'NPC_EMOTION');
    emit('emotion', m, row ? row.vals[0] : ET_DELIGHT, t);
    return true;
  }
  const end = w.path.length ? w.path[w.path.length - 1] : w.cell;
  if (!sameCell(end, it.w.cell) && !w.walkTo(...it.w.cell)) { m.loot = null; return false; }
  m.loot = it;
  setMss(m, 'loot');
  return true;
}

// ---------- the characters ----------
function setRunning(c, on) {
  c.running = on;
  c.next = null;  // start on the next frame
}
// ---------- commands (what the player, or the sandbox for a character, tells a character to do) ----------
// character c comes in on the floor (one of W.chars), facing north-east; one of the rival team's (W.rivals) at the
// corner across from PC_AT, facing south-west
export function enter(c) {
  c.w = field.add();
  const rival = c.side === RIVAL;
  field.placeNear(c.w, rival ? [field.w - 1 - PC_AT[0], field.h - 1 - PC_AT[1]] : PC_AT);
  c.w.heading = rival ? [-1, -1] : [1, 1];
  if (c.pc) c.w.cellMs = c.pc.walkSpeed;
}
// a homunculus out with no unit (its master just came in: the party loaded, a map started) comes in by its master
// (by report: one saved out came back as nothing, and was never called again — 自動 calls one only at rest)
function homunBack(c, t) {
  if (c.homun && c.homun.state === 'out' && !c.homun.unit && c.pc && c.w && c.dead == null && inFight(c) && homunDb(c.homun.id))
    spawnHomun(c, freeCellNear(c.w.cell, 1) || [...c.w.cell], t);
}
// The fight from nothing, at clock 0 (a map's start: sandbox.js, fight.js): no monsters, nothing on the ground or
// on its way, and characters chars (each new: newChar, calc) coming in in that order at full HP and SP. With the
// dice seeded (rng.js), what follows is the same every time.
// The rival team's characters (setRivals) come in again too, after the party, at full HP and SP, with their bag and
// money as they are now.
export function resetWorld(chars, bag = {}, zeny = 0) {
  bagN++;  // (who may drink what may have changed with the characters: inBag)
  for (const m of [...W.mobs]) removeMob(m);  // (first: a monster losing its target to a character leaving would pick another, with the dice)
  const rivals = [...W.rivals];
  for (const c of [...W.chars, ...rivals]) removeChar(c);
  for (const c of rivals) endAils(c, W.t);
  for (const c of chars) endAils(c, W.t);  // (their times are on the clock about to be reset)
  clearWalls(W.t);
  Object.assign(W, { t: 0, lastClock: 0, shots: [], hits: [], walls: [], ices: [], guards: [], pneumas: [], warps: [], songs: [], fields: [], traps: [], dusts: [], webs: [], sancts: [], sanctNext: new Map(), magni: [], magnusNext: new Map(), bombs: [], storms: [], stormNext: new Map(), quags: [], later: [], unitNext: 0, tick: 0, mobN: 0, lastBlow: 0, busyAt: 0, stallN: 0, stallT: null, lastDealt: 0, mobsAt: 0, items: [], itemN: 0, drop: 1, loot: {}, bag, used: {}, zeny, spent: 0 });
  Object.assign(W.rival, { used: {}, spent: 0, loot: {} });
  for (const c of chars) { comeIn(c); W.chars.push(c); enter(c); }
  for (const c of rivals) { comeIn(c); W.rivals.push(c); enter(c); }
}
// character c as it comes into a fight anew: at full HP and SP, nothing tallied yet
function comeIn(c) {
  c.cardBuffs = [];
  c.usedOn = null;  // (自動's 「自己對牠用過這招」: what the other team used on it, the last fight)
  c.hp = c.pc.maxHp; c.sp = c.pc.maxSp; c.dead = null; c.sitAfter = 0; c.tally = newTally();
  // (a homunculus that was out comes in out, at full HP and SP, on the first step: homunBack; one at rest or down stays so)
  if (c.homun) Object.assign(c.homun, { unit: null, hp: null, sp: null, used: {} });
}
// The rival team (by request: 對戰) in place of the one there was, if any: characters chars (each new: newChar, calc)
// on side RIVAL, coming in at full HP and SP across from the party, with bag and zeny their own (purse). None: no
// rival team. The caller shows them (and drops the ones that were: stage.js drop).
export function setRivals(chars, bag = {}, zeny = 0) {
  for (const c of [...W.rivals]) removeChar(c);
  W.rival = { ...newPurse(), bag, zeny };
  bagN++;
  for (const c of chars) {
    c.side = RIVAL;
    endAils(c, W.t);
    comeIn(c);
    W.rivals.push(c);
    enter(c);
  }
}
// character c leaves the fight: what it had going on goes with it, and the monsters after it lose their target
export function removeChar(c) {
  holdBow(c, false);
  if (homunOf(c)) { const m = c.homun.unit; c.homun.unit = null; removeMob(m); }  // (its homunculus with it, as it was)
  disengage(c);
  dropTarget(c, W.t);
  W.hits = W.hits.filter(h => h.from !== c && h.to !== c);
  W.shots = W.shots.filter(a => a.by !== c && a.to !== c);
  clearWalls(W.t, c);
  W.chars = W.chars.filter(x => x !== c);
  W.rivals = W.rivals.filter(x => x !== c);
  field.remove(c.w);
}
// walk to cell (x, y), dropping the fight; false when it cannot get there (cost: findPath's, a way round cells)
export function walkTo(c, x, y, cost = null) {
  if (stuck(c)) return false;  // in hiding: no walking (NoMoveCond), but with Stalk
  if (c.vending) return false;  // vending: no walking (unit_can_move)
  if (has(c, 'KN_AUTOCOUNTER')) return false;  // Counter Attack on: no walking (NoMove)
  const keep = freeCastLv(c) ? c.cast : null;  // (with Free Cast the cast goes on as it walks)
  disengage(c);
  if (keep) c.cast = keep;
  c.aiWalk = false;  // (自動 marks its own walks after this)
  return cost ? c.w.walkPath(findPath(field.map.gat, c.w.cell[0], c.w.cell[1], x, y, cost)) : c.w.walkTo(x, y);
}
// walking freely the way k of STEER_DIRS points (a gamepad's stick: grid.js steerTo), or null: on into its cell's
// middle, and stop there. The way is one of STEER_DIRS, so that a replay's walk is the same.
export const STEER_DIRS = 32;
export function steer(c, k) {
  if (k == null) return c.w.steerTo(null);
  if (stuck(c) || c.vending || has(c, 'KN_AUTOCOUNTER')) return false;  // (as walkTo)
  const keep = freeCastLv(c) ? c.cast : null;
  disengage(c);
  if (keep) c.cast = keep;
  c.aiWalk = false;
  const a = k * 2 * Math.PI / STEER_DIRS;
  return c.w.steerTo([Math.cos(a), Math.sin(a)]);
}
// whether monster m is in character c's reach as it stands (a normal attack's)
export const inReach = (c, m) => field.inRange(c.w, m.w, c.pc.range);
// a normal attack's swing at nothing (a gamepad's L2 with no monster near: by request), over the attack interval as one
// at a monster is, and not before the last one's interval is over (airReady: whether it would swing now)
export const airReady = c => c.dead == null && !c.sitting && !c.vending && !hidden(c) && !has(c, 'BD_PERFORMING') && !c.w.moving && !c.cast && !c.pending && !c.target &&
  W.t >= c.ready && W.t >= c.canAct && !!motion.ready(c);
export function swingAir(c) {
  if (!airReady(c)) return false;
  const group = motion.attackGroup(c), { frames } = motion.pc(c, group);
  c.anim = { start: W.t, group, frames, fd: c.pc.adelay / frames };
  c.alert = true;
  c.ready = W.t + c.pc.adelay;
  return true;
}
// a skill on the character itself, used once it is free; refused while it still cools down, as the server does
export function useSelf(c, name, pick = null) {
  if (hidden(c) && !HIDDEN_SKILLS.has(name)) return;  // (see skillFail: Hiding itself, Sightless Mind)
  if (c.vending && name !== 'MC_VENDING') return;
  // (pick: Hindsight's spell, the player's choice)
  if (c.dead == null && knows(c, name) && W.t >= (c.cooldown[name] || 0)) c.selfPending = { sk: db.skills[name], lv: skillLv(c, name) || 1, ...pick && { pick } };
}
export function engage(c, m) {
  if (!m || c.dead != null || hidden(c) || c.vending || !sees(c, m)) return;
  c.target = m;
  approach(c);
}
// character c's foe is gone (dead, left, out of sight): the fight is dropped as disengage, but a cast not at that foe
// goes on — a ground spell at its cell, one on itself, one on another (by report: a sage's Thunderstorm, then its
// Energy Coat, cut off as the monster it was fighting fell); only Cast Cancel or a hit stops that
function loseFoe(c) {
  const keep = c.cast && c.cast.target !== c.target ? c.cast : null;
  disengage(c);
  if (keep) c.cast = keep;
}
export function disengage(c) {
  c.target = null;
  c.pending = c.cast = null;  // a queued skill or a cast in progress is dropped too
  setRunning(c, false);
  // a skill's hits still land: it went off; and its motion plays out (by report: Charge Attack's swing stopped as
  // the monster it killed fell)
  const skill = c.anim && c.anim.skill ? c.anim : null;
  cancelSwing(c);
  if (skill) c.anim = skill;
}
// Free Cast (SA_FREECAST, by request with the sage's first skills): a character casting with it learned may walk and
// attack meanwhile (unit_can_move, unit_attack), walking at (25 + 5 × Lv) % of its speed and attacking at (50 + 5 × Lv) %
// (the client's description: 30–75%, 55–100%; rAthena's status_calc_speed and amotion have other figures); without it
// the cast holds it still (castBound)
const freeCastLv = c => c.isPc && c.cast ? passiveLv(c, 'SA_FREECAST') : 0;
export const castBound = c => !!c.cast && !freeCastLv(c);
// attack if in range (of the queued skill, if any), otherwise walk to the nearest cell in range and
// check again on arrival
const wantedRange = c => c.pending ? B.skillRange(c.pending.sk, c.pending.lv, attacker(c)) : c.pc.range;
// (A skill on someone other than the target — a heal on the way — is dropped instead of the fight.)
function approach(c) {
  debug.mark?.('approach', c);
  const u = goal(c);
  if (!u) return;
  const aside = u !== c.target, drop = () => { if (!aside) return loseFoe(c); c.pending = null; approach(c); };
  if ((u.dead != null && !(c.pending && c.pending.target === u && raising(c.pending))) || u.dying) return drop();
  if (field.inRange(c.w, u.w, wantedRange(c))) return setRunning(c, true);
  if (c.stay && !c.pending) return setRunning(c, false);  // (standing its ground: it waits for the monster to come)
  if (c.sitting || stuck(c)) return drop();  // out of range and cannot walk
  setRunning(c, false);
  if (has(c, 'KN_AUTOCOUNTER')) return;  // (Counter Attack on: NoMove; it walks on once that is over: stepChar)
  if (castBound(c)) return;  // cannot walk while casting (but with Free Cast): it sets off once the cast is over (stepChar)
  c.chaseOn ||= () => approach(c);
  c.w.onCell ||= () => chaseStep(c);
  // (dodging, by request: to a cell out of the areas it dodges, round them; none such: it waits where it is, out of
  // them, for the cast to be over — not in after the monster and out again)
  const avoid = avoidOf(dangerOf(c));
  debug.mark?.('approach:field', c, { avoid: !!avoid, to: u.name, at: u.w.cell, range: wantedRange(c) });
  if (avoid && field.approach(c.w, u.w, wantedRange(c), c.chaseOn, avoid)) return;
  if (avoid && !avoid.shun(...c.w.cell)) return c.w.halt();
  const ok = field.approach(c.w, u.w, wantedRange(c), c.chaseOn);
  debug.mark?.('approach:done', c, { ok, path: c.w.path.length });
  if (!ok) drop();
}
// (by request: a chase that keeps up, not past the one it is after and back, as rAthena's unit_walktoxy_timer looks
// each cell) on each cell's middle character c walks through on its way to the one it goes for (approach): in range
// of it here (and out of the areas it dodges), it stops here; its way's end no longer in range of it (it has moved
// on), the way is found again from here
function chaseStep(c) {
  debug.mark?.('chaseStep', c);
  const w = c.w, u = goal(c);
  if (!u || w.onArrive !== c.chaseOn || c.dead != null || u.dead != null) return;
  const range = wantedRange(c), end = w.path[w.path.length - 1], inZone = dangerOf(c);
  if (cheb(w.cell, u.w.cell) <= range && field.sees(w.cell, u.w.cell) && !(inZone && inZone(...w.cell))) return w.halt();
  if (cheb(end, u.w.cell) > range || !field.sees(end, u.w.cell)) approach(c);
}
function die(c, t) {
  tallyOf(c).downs++;
  if (c.sitting) sit(c, false);
  for (const x of allChars()) if (x.cast && x.cast.target === c) x.cast = null;  // (a heal being cast at it stops)
  c.dead = t;
  emit('died', c, t);
  { const m = homunOf(c); if (m && m.hp * 100 >= m.st.maxHp * HOMUN_VAPOR) homunRest(c, t); }  // (homunculus_auto_vapor)
  if (!W.rivals.length && c.side !== RIVAL) deathPenalty(c);  // (none with a rival team there: PvP's noexppenalty, by request)
  c.selfPending = null;
  clearStatuses(c);  // death ends the statuses on the character (status_change_clear)
  c.combo = null;
  if (c.spheres.length) { c.spheres = []; emit('spheres', c); }  // (and its spirit spheres go: pc_dead)
  endAils(c, t);
  disengage(c);
  c.w.halt();
  c.hurt = null;
  c.alert = false;
  c.rule = null;  // (自動 follows nothing while down)
  emit('rule', c);
}
// sit down / stand up (the client's Insert key; the server's DMG_SIT_DOWN / DMG_STAND_UP). Not while dead
// or casting; sitting down drops the fight and ends the step being walked. The Basic Skill level 3 it
// needs (basic_skill_check) is not checked: the sandbox has no skill points.
export function sit(c, on) {
  if (c.vending || (on && (c.dead != null || c.cast))) return;  // (vending: pc_cant_act2)
  c.sitting = on;
  c.aiSat = false;  // (自動 marks its own sitting down after this)
  if (on) { disengage(c); c.alert = false; c.selfPending = null; c.w.stop(); }
  emit('sit', c);
}
// the 復活 button: a character down gets up, and one standing is topped up, with full HP and SP
export function revive(c) {
  c.dead = null;
  c.hp = c.pc.maxHp;
  c.sp = c.pc.maxSp;
  emit('hp', c);
}
// natural regen (status_natural_heal): HP every 6 s unless walking, SP every 8 s; twice as often sitting
// Moving HP Recovery: HP regen goes on while walking, every other tick (the interval doubled). HP Recovery: its
// own clock (c.regen.skill), running only while not walking and short of full HP, heals B.recoveryHp every
// B.SKILL_REGEN_MS, shown as a heal (status_heal flag 2). Increase SP Recovery the same with SP (c.regen.skillSp,
// short of full SP, B.recoverySp), shown in blue. A status may quicken the natural SP regen (pc.spRate %: Magnificat's).
function regen(c, t) {
  const dt = t - (c.regen.at ?? t);
  c.regen.at = t;
  // (a card's: HP or SP every so often, HP lost — never the last of it: pc_regen, whatever stops the natural regen; an
  // autobonus over)
  cardEvery(c, dt, t);
  cardBuffsOff(c, t);
  // (none while in hiding or poisoned, unless under Slow Poison: status_calc_regen)
  // (nor bleeding: status_calc_regen)
  if (c.dead != null || hidden(c) || c.bleeding || (c.poison && !has(c, 'PR_SLOWPOISON'))) { c.regen.hp = c.regen.sp = t; return; }
  let changed = false;
  const k = c.sitting ? 2 : 1, walking = c.w.moving, onFoot = walking && passiveLv(c, 'SM_MOVINGRECOVERY') > 0;
  if (t - c.regen.hp >= B.HP_REGEN_MS / k * 100 / c.pc.hpRate * (onFoot ? 2 : 1)) {
    c.regen.hp = t;
    if ((!walking || onFoot) && c.hp < c.pc.maxHp) { c.hp = Math.min(c.pc.maxHp, c.hp + c.pc.hpRegen); changed = true; }
  }
  const rec = passiveLv(c, 'SM_RECOVERY');
  if (rec && !walking && c.hp < c.pc.maxHp && (c.regen.skill = (c.regen.skill || 0) + dt) >= B.SKILL_REGEN_MS) {
    c.regen.skill -= B.SKILL_REGEN_MS;
    healUnit(c, { type: 'heal', damage: B.recoveryHp(rec, c.pc.maxHp) }, t);
  }
  const srec = passiveLv(c, 'MG_SRECOVERY');
  if (srec && !walking && c.sp < c.pc.maxSp && (c.regen.skillSp = (c.regen.skillSp || 0) + dt) >= B.SKILL_REGEN_MS) {
    c.regen.skillSp -= B.SKILL_REGEN_MS;
    const n = B.recoverySp(srec, c.pc.maxSp);
    c.sp = Math.min(c.pc.maxSp, c.sp + n);
    emit('heal', c, { type: 'heal', sp: true, damage: n }, t);
    changed = true;
  }
  // Spiritual Cadence (status_calc_regen: ssregen, status_natural_heal: only sitting): its own clocks (c.regen.sit,
  // sitSp), running only while sat down, heal B.cadenceHp / cadenceSp every SKILL_REGEN_MS, shown; standing up, or
  // full, a clock starts over
  const cad = c.sitting ? passiveLv(c, 'MO_SPIRITSRECOVERY') : 0;
  if (!cad || c.hp >= c.pc.maxHp) c.regen.sit = 0;
  else if ((c.regen.sit = (c.regen.sit || 0) + dt) >= B.SKILL_REGEN_MS) {
    c.regen.sit -= B.SKILL_REGEN_MS;
    healUnit(c, { type: 'heal', damage: B.cadenceHp(cad, c.pc.maxHp) }, t);
  }
  if (!cad || c.sp >= c.pc.maxSp) c.regen.sitSp = 0;
  else if ((c.regen.sitSp = (c.regen.sitSp || 0) + dt) >= B.SKILL_REGEN_MS) {
    c.regen.sitSp -= B.SKILL_REGEN_MS;
    const n = B.cadenceSp(cad, c.pc.maxSp);
    c.sp = Math.min(c.pc.maxSp, c.sp + n);
    emit('heal', c, { type: 'heal', sp: true, damage: n }, t);
    changed = true;
  }
  // (renewal: a monk under Fury, every other tick: status_natural_heal)
  if (t - c.regen.sp >= B.SP_REGEN_MS / k * 100 / c.pc.spRate * (has(c, 'MO_EXPLOSIONSPIRITS') ? 2 : 1)) {
    c.regen.sp = t;
    // (none under Maximize Power, nor for a while after Asura Strike: status_calc_regen)
    if (c.sp < c.pc.maxSp && !has(c, 'BS_MAXIMIZE') && !has(c, 'MO_EXTREMITYFIST')) { c.sp = Math.min(c.pc.maxSp, c.sp + c.pc.spRegen); changed = true; }
  }
  if (changed) emit('hp', c);
}

// ---------- 自動: what a character does by itself ----------
// A character on 自動 (c.auto) follows its tactics: rules in order, the first that applies giving its next
// order. A rule is data, which the player can edit in the 行動 list (c.rules); else the character follows a
// preset of rules (c.tactic, see presetRules): 基本 (BASIC), its job line's (RULES, the other jobs following
// COMMON) or one the player saved:
//   { do, at, target, if, off }
// `do`: what it does — 'attack', 'move', 'sit' (sat down by it, it sits on until its SP is full), 'wait'
//   (nothing for now), 'pickup' (walks to the loot picked and picks it up), 'layTraps' (a hunter's: trapTour), 'potion', 'spPotion', 'speedPotion' (drink one
//   from the party's bag: DRINKS), a skill's name, or a list of them (BOLTS: the one and level that does the most damage).
//   `at`: a ground skill goes that many cells from the character toward the one picked, not on its cell (a hunter's
//   trap with none: on the monster's way, wayCell).
// `target`: whom, or where — selectors (SELECT, { k, v }) tried in order: the first that has a candidate
//   passing the rule's 對象 clauses gives the one it ranks first (its own ranking, then the target the
//   character has, then the nearest). Not read for a Self skill, 'sit', 'wait' nor a drink.
// `if`: clauses { who, n, is: [{ k, v, not }] } (CONDS), all of `is` holding: who 'target' (對象) leaves out
//   the candidates that fail it; 'self' is the character; 'foe' and 'ally' (itself included) hold when the
//   count of them meeting `is` is n: 'any' (one at least), 'none', or a number (at least that many).
// `off`: left out.
// What a skill needs goes without saying (follow, fits): learned, cooled down, its SP and weapon, and that it
// does something to the one picked — Provoke's odds, a buff not on one under it already, an element that hurts.
// A rule for a skill not learned is passed over.
//
// The rules are read whenever the character could take an order: alive, not casting, past a skill's delay
// and a hit's stop, not sat down by the player, and with no order of the player's still waiting (a skill
// picked, a walk). An order it is carrying out already is not given again, so a rule above can cut in on one
// below. One that 自動 sat down stands up for any other order, and when no rule applies. What the player
// tells it goes on meanwhile: a monster clicked becomes its target.
//
// A job's line, by a skill that only that line has (jobs.json skill trees carry the first job's skills;
// in this order, as Crusaders have Heal and Divine Protection too, and Monks all of the Acolyte's; a knight's
// own, by request, ahead of the swordsman's it has too, and so a crusader's; so a wizard's, ahead of the mage's, a priest's, ahead of
// the acolyte's, a sage's, ahead of the mage's too, a hunter's and a bard's or a dancer's, ahead of the archer's, a blacksmith's and an alchemist's, ahead of the merchant's, and an assassin's and a rogue's, ahead
// of the thief's)
const LINES = [['knight', 'KN_PIERCE'], ['crusader', 'CR_TRUST'], ['swordman', 'SM_BASH'], ['wizard', 'WZ_SIGHTRASHER'], ['sage', 'SA_ADVANCEDBOOK'], ['mage', 'MG_FIREBOLT'], ['hunter', 'HT_FALCON'], ['bard', 'BD_ADAPTATION'], ['archer', 'AC_OWL'], ['monk', 'MO_CALLSPIRITS'], ['priest', 'PR_KYRIE'], ['acolyte', 'AL_DP'], ['assassin', 'AS_KATAR'], ['rogue', 'RG_SNATCHER'], ['thief', 'TF_STEAL'],
  ['blacksmith', 'BS_HAMMERFALL'], ['alchemist', 'AM_PHARMACY'], ['merchant', 'MC_MAMMONITE']];
const lineOf = c => (LINES.find(([, sk]) => sk in jobFor(c).skills) || [])[0];
export const LINE_LABEL = { knight: '騎士', crusader: '十字軍', swordman: '劍士', wizard: '巫師', sage: '賢者', mage: '法師', hunter: '獵人', bard: '詩人／舞孃', archer: '弓箭手', blacksmith: '鐵匠', alchemist: '鍊金術師', monk: '武僧', priest: '祭司', acolyte: '服事', assassin: '刺客', rogue: '流氓', thief: '盜賊', merchant: '商人' };
// the lines a swordsman stands in front of: a monster going for one of them is provoked, and fought first
const FRAGILE = ['mage', 'wizard', 'sage', 'hunter', 'archer', 'priest', 'acolyte'];
// monster m is after one of c's allies who cannot take its hits
const threatens = (c, m) => alive(m) && !!m.target && m.target !== c && m.target.isPc && m.target.side === c.side &&
  m.target.dead == null && FRAGILE.includes(lineOf(m.target));
// the one of `list` nearest to character c
function nearest(c, list) {
  let best = null, bd = Infinity;
  for (const x of list) { const d = field.distance(c.w, x.w); if (d < bd) { best = x; bd = d; } }
  return best;
}
const livingFoes = c => enemies(c).filter(alive);
const friends = c => crewOf(c).filter(x => x !== c && x.dead == null && x.pc && sees(c, x));  // the rest of the party, standing (and not in hiding)
const party = c => [c, ...friends(c)];
// the ones the rest of the party is fighting: their targets, and the ones their skills are for
function partyFoes(c) {
  const out = new Set();
  for (const x of friends(c)) for (const u of [x.target, x.pending?.target, x.cast?.target]) if (u) out.add(u);
  return out;
}
// character c could use skill `name` now: its job has it, it has cooled down, and its weapon, SP and HP allow it
const canUse = (c, name, t) => knows(c, name) && t >= (c.cooldown[name] || 0) && !skillFail(c, db.skills[name], c.levels[name] || 1);
const spOf = (c, name) => db.skills[name].sp[(c.levels[name] || 1) - 1] || 0;
const has = (u, name) => u.sc.some(s => s.name === name && W.t < s.until);
export const hasStatus = has;
const sameCell = (a, b) => a[0] === b[0] && a[1] === b[1];
// where character c is walking to (its cell, standing)
const walkEnd = c => c.w.path.length ? c.w.path[c.w.path.length - 1] : c.w.cell;
// Where character c sits out a lull (c.restAt, picked once; think forgets it when monsters come): the party's
// first standing character where it is, the others 1–3 cells from it (a distance picked at random, on a free
// cell), and one that near already where it is. No two on one cell (by request): a cell another character stands
// on, walks to or rests on is not c's to rest on (so neither where it is nor what it had picked, then).
function restSpot(c) {
  const lead = crewOf(c).find(x => x.dead == null && x.pc);
  if (!lead || lead === c) return walkEnd(c);
  const at = walkEnd(lead), mine = p => !claimed(c).has(p.join());
  if (c.restAt && cheb(c.restAt, at) <= 3 && mine(c.restAt)) return c.restAt;
  if (cheb(walkEnd(c), at) <= 3 && mine(walkEnd(c))) return c.restAt = walkEnd(c);
  const busy = claimed(c);
  for (const d of [1 + rnd(3), 1, 2, 3]) {
    const cells = [];
    for (let y = at[1] - d; y <= at[1] + d; y++) for (let x = at[0] - d; x <= at[0] + d; x++)
      if (cheb([x, y], at) === d && field.open(x, y) && !busy.has(x + ',' + y)) cells.push([x, y]);
    if (cells.length) return c.restAt = cells[rnd(cells.length)];
  }
  return c.restAt = walkEnd(c);
}
// the cells not free for character c: where any other unit is or walks to, and where the other characters rest
function claimed(c) {
  const out = field.taken(c.w);
  for (const x of crewOf(c)) if (x !== c && x.dead == null && x.restAt) out.add(x.restAt.join());
  return out;
}
// another character holds the cell c is on (standing on it, or on its way there) before c: sat there already, or
// ahead of c in the party (so of two on one cell, one keeps it: think)
const crowded = c => crewOf(c).some(x => x !== c && x.dead == null && x.w && x.w.pos && sameCell(walkEnd(x), c.w.cell) &&
  (x.sitting || crewOf(c).indexOf(x) < crewOf(c).indexOf(c)));
// the free cell nearest character c (claimed), up to 3 away, or null
function freeNear(c) {
  const busy = claimed(c), [cx, cy] = c.w.cell;
  for (let r = 1; r <= 3; r++) {
    const cells = [];
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++)
      if (cheb([x, y], [cx, cy]) === r && field.open(x, y) && !busy.has(x + ',' + y)) cells.push([x, y]);
    if (cells.length) return cells[rnd(cells.length)];
  }
  return null;
}
// the windows the damage taken (burst: the thief's hiding) and the walks stopped (the swordsman's Endure) are
// counted over
const BURST_MS = 2000, STOP_MS = 3000;
// the damage character c has taken within the last BURST_MS
const burst = (c, t) => (c.taken || []).filter(x => t - x.t < BURST_MS).reduce((n, x) => n + x.dmg, 0);
// Backing off from the monsters in the fight (after the character or an ally; ones after no one are left be),
// stepping off to a free cell up to RETREAT cells away (see retreat and backOff).
const RETREAT = 8;
const dangers = c => livingFoes(c).filter(m => m.target && m.target.side === c.side);
// how far cell p is from the nearest of monsters ms
const clearance = (p, ms) => Math.min(...ms.map(m => cheb(m.w.cell, p)));
// A cell is worth backing off to only if it is more than `near` cells from every one of them, and once the
// character gets there it has at least BACK_SPARE_MS (to cast, to shoot) before any monster after it can hit it
// there (within its attack range; a frozen, stunned or trapped one sets off once free). Otherwise — cornered, or a
// monster as fast as it is right behind it — it stays and fights: a step that gains nothing would have it and
// the monster after it shuffle back and forth for ever, the monster re-routing and never hitting.
const BACK_SPARE_MS = 1000;
// ms before monster m (after the character) gets within its attack range of cell p, from time t
// (or a character of the rival team's)
const catchUp = (m, p, t) => Math.max(0, m.frozen ? m.frozen.until - t : 0, (m.stunUntil || 0) - t, m.stunned ? m.stunned.until - t : 0, m.snared ? m.snared.until - t : 0, m.stopped ? m.stopped.until - t : 0) +
  (cheb(m.w.cell, p) - atkRangeOf(m)) * walkMsOf(m) * slowK(m);
// the free cell within RETREAT of character c worth backing off to from monsters ms (see above) farthest
// from them (as far as `far` cells matters), then the shortest walk, then nearest the party; null when none is
// (it looks at up to 17 × 17 cells, often, so it goes by plain loops: nothing made for each cell)
function retreat(c, ms, near, far, t) {
  const busy = field.taken(c.w), mine = ms.filter(m => m.target === c);
  const [cx, cy] = c.w.cell, foes = ms.map(m => m.w.cell), mates = friends(c).map(f => f.w.cell);
  let best = null, k0 = 0, k1 = 0, k2 = 0;
  const y1 = Math.min(field.h - 1, cy + RETREAT), x0 = Math.max(0, cx - RETREAT), x1 = Math.min(field.w - 1, cx + RETREAT);  // (off the floor: none open)
  for (let y = Math.max(0, cy - RETREAT); y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!field.open(x, y) || busy.has(x + ',' + y)) continue;
    let gap = Infinity;
    for (const q of foes) gap = Math.min(gap, Math.max(Math.abs(q[0] - x), Math.abs(q[1] - y)));
    if (gap <= near) continue;
    const away = Math.max(Math.abs(x - cx), Math.abs(y - cy)), walk = away * c.w.cellMs;
    if (mine.length && mine.some(m => catchUp(m, [x, y], t) < walk + BACK_SPARE_MS)) continue;
    // farthest from them (up to far), then the shortest walk, then nearest the party
    const a = -Math.min(gap, far);
    let mate = 0;
    if (mates.length) { mate = Infinity; for (const q of mates) mate = Math.min(mate, Math.max(Math.abs(q[0] - x), Math.abs(q[1] - y))); }
    if (!best || a < k0 || (a === k0 && (away < k1 || (away === k1 && mate < k2)))) { best = [x, y]; k0 = a; k1 = away; k2 = mate; }
  }
  return best;
}
// (by request) where character c leads a monster after it into the party's area on the ground (lureZones): a monster
// after it at arm's length (range LURE_REACH or less) in none yet, and a free cell out of every area, up to RETREAT
// cells off, whose straight way from the monster crosses one and ends in it (the cell the monster stops on, next to
// c, in the area): the shortest walk (not across a wide one: by report, a knight crossed all of a Storm Gust), then the
// one with the most of the way in the areas. On that cell already, it
// is its own cell (stayed on: follow) until the monster is in; none when no area, none after it, or each after it in
// one already.
const LURE_LEFT_MS = 3000, LURE_REACH = 2;
// the ground skills of the party's a monster is led into while one casts them (the area it will land on: areaOf, at
// least the 3×3; not c's own, which a walk would cut short)
const LURE_CASTS = new Set(['AC_SHOWER', 'MG_THUNDERSTORM', 'WZ_HEAVENDRIVE', 'WZ_METEOR', 'WZ_VERMILION', 'WZ_STORMGUST', 'WZ_QUAGMIRE',
  'MG_FIREWALL', 'AM_DEMONSTRATION', 'AS_VENOMDUST', 'PR_MAGNUS']);
// the areas on the ground character c's party has that do a monster harm, as sets of 'x,y': Bomb's fire (the 3×3),
// Storm Gust, Magnus Exorcismus, Quagmire, Venom Dust, Fire Wall, LURE_LEFT_MS or more left on each; and those cast
// (LURE_CASTS) by the others
function lureZones(c, t) {
  const out = [], mine = u => u && u.side === c.side;
  const add = cells => out.push(new Set(cells.map(([x, y]) => x + ',' + y)));
  const square = (x, y, r) => { const a = []; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) a.push([x + dx, y + dy]); return a; };
  for (const n of W.bombs) if (mine(n.by) && n.until - t >= LURE_LEFT_MS) add(square(n.x, n.y, 1));
  for (const n of [...W.storms, ...W.magni, ...W.quags, ...W.dusts]) if (mine(n.by) && n.until - t >= LURE_LEFT_MS) add(n.cells);
  for (const n of W.walls) if (mine(n.by) && n.until - t >= LURE_LEFT_MS) add(n.cells.map(x => [x.x, x.y]));
  for (const u of crewOf(c)) {
    const k = u.cast;
    if (u === c || !mine(u) || u.dead != null || !k || !k.target || !k.target.ground || !LURE_CASTS.has(k.sk.name)) continue;
    const [x, y] = k.target.w.cell;
    add(square(x, y, Math.max(1, areaOf(k.sk, k.lv))));
  }
  return out;
}
// (by request, everyone's) the areas the other side is casting on the ground that do harm — a ground spell with
// damage (B.SKILLS: Storm Gust, Lord of Vermilion, Meteor Storm, Heaven's Drive, Thunderstorm, Arrow Shower, Magnus
// Exorcismus …) or a status (Quagmire, Venom Dust); not Fire Wall, a line — as squares of its area round its cell
const DODGE_ALSO = new Set(['WZ_QUAGMIRE', 'AS_VENOMDUST']);
// (all: every one, not leaving out the one character c would rather cut off: breakCaster)
function castZones(c, all = false) {
  const out = [];
  for (const us of [W.chars, W.rivals, W.mobs]) for (const u of us) {  // (units(), not made anew: asked each cell a chase walks)
    const k = u.cast;
    if (!k || u.trap || u.side === c.side || u.dead != null || !k || !k.target || !k.target.ground || k.sk.name === 'MG_FIREWALL') continue;
    if (!B.SKILLS[k.sk.name] && !DODGE_ALSO.has(k.sk.name)) continue;
    const [x, y] = k.target.w.cell, r = Math.max(1, areaOf(k.sk, k.lv));
    out.push({ x, y, r, u, k });
  }
  if (all || !out.length) return out;
  // (by request: not the cast it cuts off by attacking the caster sooner than it walks out: breakCaster)
  const by = breakCaster(c, W.t, out);
  return by ? out.filter(z => z.u !== by) : out;
}
// (by request) the caster character c (自動) cuts the cast off sooner by attacking it than it walks out of the areas
// it stands in (zones: castZones(c, true)): standing in areas of that one caster's alone, a cast a hit cuts off
// (cancelable), the caster seen; its hit landing — the walk into weapon range (cells × its walk speed), its next
// attack's wait (skill delay, attack interval), the swing to its hit frame — before the cast is over and before it
// could get out (dodgeSpot's cell, cells × walk speed; never, with none). null when walking out is as quick. (A miss
// cuts nothing off: not reckoned with.)
function breakCaster(c, t, zones) {
  if (!c.auto || c.dead != null || c.vending || c.sitting || !c.pc) return null;
  const [cx, cy] = c.w.cell, here = zones.filter(z => Math.abs(cx - z.x) <= z.r && Math.abs(cy - z.y) <= z.r);
  if (!here.length) return null;
  const u = here[0].u;
  if (here.some(z => z.u !== u || !z.k.cancelable) || !alive(u) || !sees(c, u)) return null;
  const walk = Math.max(0, field.distance(c.w, u.w) - c.pc.range);
  if (walk && (stuck(c) || c.w.rooted)) return null;
  // (its sprite not in yet — a rival just teleported in: the page's motion.pc reads it — the hit guessed at 60% of the swing)
  const mo = motion.ready(c) && motion.pc(c, motion.attackGroup(c)), share = mo && mo.frames ? mo.hf / mo.frames : 0.6;
  const ready = Math.max(0, c.canAct - t, c.ready - t, c.target === u && c.next != null ? c.next - t : 0);
  const hit = walk * c.w.cellMs + ready + c.pc.adelay * share;
  if (t + hit >= Math.min(...here.map(z => z.k.end))) return null;
  const out = dodgeSpot(c, zones)[0];
  return !out || hit < cheb(out, c.w.cell) * c.w.cellMs ? u : null;
}
// where character c steps out of them (dodge): standing in one (or walking out of it: where it is going), the open cell no one holds nearest it (DODGE_REACH
// cells at most) in none of them, the one nearest the party on a tie; none when it is in none, or none is free
const DODGE_REACH = 8;
function dodgeSpot(c, zones = castZones(c)) {
  const inZone = (x, y) => zones.some(z => Math.abs(x - z.x) <= z.r && Math.abs(y - z.y) <= z.r);
  const [cx, cy] = c.w.cell, end = walkEnd(c);
  if (!zones.length || !inZone(cx, cy)) return [];
  if (c.w.moving && !inZone(...end)) return [end];  // (on its way out already: that way, not another rule's back in)
  const busy = field.taken(c.w), mates = friends(c).map(f => f.w.cell);
  let best = null, k0 = 0, k1 = 0;
  for (let y = cy - DODGE_REACH; y <= cy + DODGE_REACH; y++) for (let x = cx - DODGE_REACH; x <= cx + DODGE_REACH; x++) {
    if (!field.open(x, y) || busy.has(x + ',' + y) || inZone(x, y)) continue;
    const away = Math.max(Math.abs(x - cx), Math.abs(y - cy));
    let mate = 0;
    for (const q of mates) mate = Math.min(mate || Infinity, cheb(q, [x, y]));
    if (!best || away < k0 || (away === k0 && mate < k1)) { best = [x, y]; k0 = away; k1 = mate; }
  }
  return best ? [best] : [];
}
// (by request: not back in once out) character c's 自動 dodging (its dodge rule on) and the areas it dodges (castZones)
// now: whether cell (x, y) is in one of them; null when it is not dodging or there are none
const dodgeRule = c => rulesOf(c).find(r => r === DODGE || (r.do === 'move' && !r.off && r.target?.length === 1 && r.target[0].k === 'dodge'));
function dangerOf(c) {
  if (!c.auto || c.dead != null) return null;
  const r = dodgeRule(c);
  if (!r || r.off) return null;
  const zones = castZones(c);
  return zones.length ? (x, y) => zones.some(z => Math.abs(x - z.x) <= z.r && Math.abs(y - z.y) <= z.r) : null;
}
// what a cell in one costs a walk on top of its step (findPath's cost): a way round it if there is one not much longer
const DANGER_COST = 10;
const avoidOf = inZone => inZone && { cost: (x, y) => inZone(x, y) ? DANGER_COST : 0, shun: inZone };
// the monster x is one character c cannot get within range of (its weapon's, rng) but in an area it dodges: none of
// the cells in range round it out of them
function walledOff(c, x, inZone, rng = c.pc.range) {
  const [fx, fy] = x.w.cell;
  if (!inZone(fx, fy)) return false;
  for (let y = fy - rng; y <= fy + rng; y++) for (let X = fx - rng; X <= fx + rng; X++)
    if ((X !== fx || y !== fy || !rng) && field.open(X, y) && !inZone(X, y)) return false;
  return true;
}
function lureSpot(c, t) {
  const zones = lureZones(c, t);
  if (!zones.length) return [];
  const inZone = p => zones.some(z => z.has(p[0] + ',' + p[1]));
  const ms = livingFoes(c).filter(m => m.target === c && atkRangeOf(m) <= LURE_REACH);
  if (!ms.length || ms.some(m => inZone(m.w.cell))) return [];
  const m = ms.reduce((a, b) => cheb(b.w.cell, c.w.cell) < cheb(a.w.cell, c.w.cell) ? b : a);
  const busy = field.taken(c.w), [cx, cy] = c.w.cell;
  // (how much of the way from the monster to p is in the areas; 0 when the cell it stops on, next to p, is not)
  const score = p => { const way = between(m.w.cell, p); return way.length && inZone(way[way.length - 1]) ? way.filter(inZone).length : 0; };
  if (c.aiWalk === 'lure' && c.w.moving) { const here = walkEnd(c); if (!inZone(here) && score(here) > 0) return [here]; }
  let best = null, k0 = 0, k1 = 0;
  for (let y = cy - RETREAT; y <= cy + RETREAT; y++) for (let x = cx - RETREAT; x <= cx + RETREAT; x++) {
    const p = [x, y];
    if (!field.open(x, y) || inZone(p) || (busy.has(x + ',' + y) && !sameCell(p, c.w.cell))) continue;
    const k = score(p), away = cheb(c.w.cell, p);
    if (k > 0 && (!best || away < k1 || (away === k1 && k > k0))) { best = p; k0 = k; k1 = away; }
  }
  return best ? [best] : [];
}
// where character c backs off to when a monster in the fight is within `near` cells: to `far` cells from them if
// it can (retreat); on the way already, it keeps going while where it is going stays clear
// A bow rogue hidden (by request): the cell more than HIDE_FAR cells off every monster within RETREAT of it, the
// farthest from them, then the shortest walk (retreat); none once it is that far, the one it walks to kept
const HIDE_FAR = 5, HIDDEN_WALK = 9, ROGUE_HIDE_HP = 30;
function hideAway(c, t) {
  const ms = livingFoes(c);
  if (!ms.length || clearance(c.w.cell, ms) > HIDE_FAR) return [];
  if (c.w.moving && clearance(walkEnd(c), ms) > HIDE_FAR) return [walkEnd(c)];
  const p = retreat(c, ms, HIDE_FAR, RETREAT, t);
  return p ? [p] : [];
}
// A dagger rogue hidden (by request): the free cell within RAID_WALK of it with the most monsters within Sightless
// Mind's area (its splash, 2) round it, then the shortest walk; none when where it stands (or is walking to) has as many
const RAID_WALK = 5;
function raidSpot(c) {
  const ms = livingFoes(c), area = db.skills.RG_RAID.splash[(c.levels.RG_RAID || 1) - 1] || 2, busy = field.taken(c.w);
  const count = p => ms.filter(m => cheb(m.w.cell, p) <= area).length;
  const [cx, cy] = c.w.cell, here = Math.max(count(c.w.cell), c.w.moving ? count(walkEnd(c)) : 0);
  let best = null, n0 = here, d0 = 0;
  for (let y = cy - RAID_WALK; y <= cy + RAID_WALK; y++) for (let x = cx - RAID_WALK; x <= cx + RAID_WALK; x++) {
    if (!field.open(x, y) || busy.has(x + ',' + y)) continue;
    const n = count([x, y]), d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
    if (n > n0 || (best && n === n0 && d < d0)) { best = [x, y]; n0 = n; d0 = d; }
  }
  return best ? [best] : [];
}
function backOff(c, near, far, t) {
  const ms = dangers(c);
  if (!ms.length) return [];
  if (c.aiWalk === 'back' && c.w.moving && clearance(walkEnd(c), ms) > near) return [walkEnd(c)];
  if (clearance(c.w.cell, ms) > near) return [];
  const p = retreat(c, ms, near, far, t);
  return p ? [p] : [];
}
// A mage's bolts: what it casts at a monster is the bolt and level (up to the one learned) whose one cast
// does it the most damage (B.skillAttack: MATK, the skill's ratio and hits, MDEF, the element against the
// monster's; a player's magic has no spread; Soul Strike 5×Lv % more on undead). Only levels whose cast is
// over within `time` (see timeToCast) and that the SP left covers; of those worked out here (SKILL_USE) and cooled down; the first in this list,
// then the lower level, on a tie; none when no bolt hurts it.
// (a wizard's Jupitel Thunder and Earth Spike among them: one target, as the bolts)
export const BOLTS = ['MG_FIREBOLT', 'MG_COLDBOLT', 'MG_LIGHTNINGBOLT', 'MG_SOULSTRIKE', 'WZ_JUPITEL', 'WZ_EARTHSPIKE'];
function bestBolt(c, m, t, time = Infinity, names = BOLTS) {
  const src = offense(c), dst = defense(m);
  let best = null;
  for (const name of names) {
    if (!SKILL_USE[name] || !knows(c, name) || t < (c.cooldown[name] || 0)) continue;
    const sk = db.skills[name];
    for (let lv = 1; lv <= c.levels[name]; lv++) {
      const ct = B.castTime(sk, lv, c.pc);
      if (ct >= time || skillFail(c, sk, lv)) continue;
      const dmg = B.skillAttack(db, src, dst, sk, lv).damage;
      if (dmg > 0 && (!best || dmg > best.dmg)) best = { name, lv, dmg };
    }
  }
  return best;
}
// the cells on the straight line from cell a to cell b, both left out, from a's end (Bresenham)
function between(a, b) {
  const out = [], dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]), sx = Math.sign(b[0] - a[0]), sy = Math.sign(b[1] - a[1]);
  let [x, y] = a, e = dx - dy;
  for (;;) {
    const e2 = 2 * e;
    if (e2 > -dy) { e -= dy; x += sx; }
    if (e2 < dx) { e += dx; y += sy; }
    if (x === b[0] && y === b[1]) return out;
    out.push([x, y]);
  }
}
// the cells character c's fire walls burn on
const wallCells = c => W.walls.filter(w => w.by === c).flatMap(w => w.cells.map(x => [x.x, x.y]));
// how long a mage (c) has to cast before the first monster after it hits it (Infinity: none is after it):
// a hit of its already on the way, else it gets within its attack range (a frozen one sets off once it thaws),
// waits out its attack delay and swings (the hit lands hf frames into the attack motion). A cast goes off
// between two of its hits. One of the mage's fire walls on the way holds a monster back (it is knocked back),
// but not a fire or undead one, nor a boss. `but`: a monster left out (Arrow Repel's own target: castClear)
function timeToCast(c, t, but) {
  const walls = wallCells(c);
  const held = x => {
    const st = statusOf(x);
    return st.element !== 'Fire' && !B.isUndead(st) && !st.boss && between(x.w.cell, c.w.cell).some(p => walls.some(w => sameCell(w, p)));
  };
  const hitIn = x => {
    const on = W.hits.filter(h => h.from === x && h.to === c && h.at > t).map(h => h.at - t);
    if (on.length) return Math.min(...on);
    const arrive = (x.frozen ? x.frozen.until - t : 0) + Math.max(0, walkOf(x) - atkRangeOf(x)) * walkMsOf(x) * slowK(x);
    if (x.isPc) return Math.max(arrive, (x.canAct || 0) - t) + x.pc.amotion;  // (a rival character: its next swing, by its attack motion)
    const { delay, hf } = motion.mobAttack(x);
    return Math.max(arrive, x.nextAttack - t) + hf * delay * slowK(x);
  };
  // (the cells it walks: round an ice wall in the way, if it has to walk round it to hit; none round it, never)
  const walkOf = x => {
    const d = field.distance(c.w, x.w);
    if (atkRangeOf(x) > 3 || !iceBetween(x, c)) return d;
    const way = findPath(field.map.gat, x.w.cell[0], x.w.cell[1], c.w.cell[0], c.w.cell[1]);
    return way ? Math.max(d, way.length) : Infinity;
  };
  return Math.min(Infinity, ...livingFoes(c).filter(x => x.target === c && x !== but && !held(x)).map(hitIn));
}
// an ice wall's cell on the straight line between units a and b
const iceBetween = (a, b) => (W.ices.length > 0 || trialIce.length > 0) && between(a.w.cell, b.w.cell).some(([x, y]) => iced(x, y));
// character c, about to cast crowd skill `name` (learned, off its cooldown, the SP for it and `more`: a monster in its
// range with 3 at least round it, crowdAt), would be cut off before the cast ends, but not with an ice wall put up 2
// cells off across the way of monster x (its cells tried on the floor: x walks round them, timeToCast)
function wallSaves(c, x, name, ctx, more = 0) {
  const sk = db.skills[name];
  if (!sk || !knows(c, name) || ctx.t < (c.cooldown[name] || 0) || c.sp < spOf(c, name) + more) return false;
  const sub = { ...ctx, name, lv: c.levels[name] }, ct = B.castTime(sk, sub.lv, c.pc);
  if (ct < timeToCast(c, ctx.t)) return false;
  if (!livingFoes(c).some(m => field.distance(c.w, m.w) <= rangeOf(c, sub) && field.sees(c.w.cell, m.w.cell) && crowdAt(c, sub, m) >= 3)) return false;
  const at = aheadOf(c, x, 2);
  if (!at) return false;
  const cells = iceLayout(calcDir(c.w.cell, at)).map(([dx, dy]) => [at[0] + dx, at[1] + dy]).filter(([a, b]) => field.open(a, b) && !iced(a, b));
  if (cells.some(p => sameCell(p, x.w.cell))) return false;  // (one on it is slid off, maybe to the near side)
  for (const [a, b] of cells) setIce(field.map.gat, a, b, true);
  trialIce = cells;
  try { return ct < timeToCast(c, ctx.t); }
  finally { for (const [a, b] of cells) setIce(field.map.gat, a, b, false); trialIce = []; }
}

// --- the rules' words ---
// A rule's context while it is read (ctx): t, the skill it uses (name: the first of a list) and its level, and
// the target 自動 attacks (focus), worked out once a reading.
const skillOf = r => typeof r.do === 'string' ? (db.skills[r.do] ? r.do : null) : r.do[0];
const rangeOf = (c, ctx) => ctx.name ? B.skillRange(db.skills[ctx.name], ctx.lv, attacker(c)) : c.pc.range;
// the reach of a skill's area around its centre (cells; a splash below 0 is AREA_SIZE)
function reachOf(ctx) {
  if (!ctx.name) return 0;
  const sk = db.skills[ctx.name], s = ctx.name === 'SA_LANDPROTECTOR' ? fieldReach(ctx.name, ctx.lv) : SKILL_USE[ctx.name]?.area ?? (sk.splash[ctx.lv - 1] ?? sk.splash[0] ?? 0);
  return s < 0 ? AREA_SIZE : s;
}
// skill `name` (character c's) hurts monster m: the element of a magic one does not miss it altogether
// (a hunter's damage trap, by choice: its element hurting it at full at least, else another trap, of another element,
// is laid: Claymore Trap's fire is not for a fire one, nor a frozen one, water)
const ELEMENT_TRAPS = new Set(['HT_LANDMINE', 'HT_BLASTMINE', 'HT_CLAYMORETRAP', 'HT_FREEZINGTRAP']);
const hurts = (c, name, m) => { const st = statusOf(m), r = () => B.attrRatio(db, db.skills[name].element, st.element, st.elementLv);
  return ELEMENT_TRAPS.has(name) ? r() >= 100 : !B.SKILLS[name]?.magic || r() > 0; };
// the monsters the rule's skill would hit with monster m at the centre: under the cells of a Fire Wall cast at
// it, else within its area, of those it hurts
function crowdAt(c, ctx, m) {
  const foes = livingFoes(c);
  if (ctx.name === 'MG_FIREWALL') {
    const at = m.w.cell, cells = wallLayout(calcDir(c.w.cell, at)).map(([dx, dy]) => [at[0] + dx, at[1] + dy]);
    return foes.filter(f => cells.some(p => sameCell(p, f.w.cell))).length;
  }
  if (ctx.name === 'KN_BRANDISHSPEAR') {  // (the area in front of the user, m's way: DOES.brandish)
    const dir = calcDir(c.w.cell, m.w.cell), deep = 2 + (ctx.lv >= 4) + (ctx.lv >= 7) + (ctx.lv >= 10);
    return foes.filter(f => inDir(c.w.cell, dir, 2, deep, f.w.cell) && field.sees(c.w.cell, f.w.cell)).length;
  }
  if (ctx.name === 'AS_VENOMDUST') {  // (the cells round m's it would cover, a cell off them: dustTurn; the ones it can poison, not poisoned yet)
    const cells = DUST_LAYOUT.map(([dx, dy]) => [m.w.cell[0] + dx, m.w.cell[1] + dy]);
    return foes.filter(f => cells.some(p => cheb(p, f.w.cell) <= 1) && !f.poison && B.poisonOdds(statusOf(c), statusOf(f), 100, 1).chance > 0).length;
  }
  const area = reachOf(ctx);
  return foes.filter(f => field.distance(f.w, m.w) <= area && (!ctx.name || hurts(c, ctx.name, f))
    && (ctx.name !== 'PR_SANCTUARY' || B.unholy(statusOf(f)))  // (Sanctuary: the undead and demons, it heals the rest)
    && (ctx.name !== 'WZ_QUAGMIRE' || !has(f, ctx.name))  // (Quagmire: the ones not in one yet)
    && (!['WZ_STORMGUST', 'HT_FREEZINGTRAP'].includes(ctx.name) || !f.frozen)  // (Storm Gust, Freezing Trap: the ones not frozen yet)
    && (ctx.name !== 'HT_SANDMAN' || !f.asleep)  // (Sandman: the ones not asleep)
    // (Hammer Fall: the ones it can stun, not stunned, nor in one it is about to stun: DOES.hammer's second)
    && (ctx.name !== 'BS_HAMMERFALL' || (!f.stunned && !(f.hammered > W.t) && B.stunOdds(statusOf(c), statusOf(f), 50, 1).chance > 0))).length;
}
const defOf = m => { const st = statusOf(m); return st.def * 10000 + st.def2; };
// Selectors: zh (its words; v its numbers), of (what it picks: self, ally, foe or cell), pool(c, ctx, v) (the
// candidates), rank(c, x, ctx) (lower first; else the character's target, then the nearest), v (its numbers'
// defaults, with their words: vs)
const SONG_SPOT = 6, SONG_STAY = 3000, SONG_REFRESH = 5000;  // (a bard's and a dancer's: songSpot, below)
export const ENSEMBLE_PICK = ['BD_DRUMBATTLEFIELD', 'BD_ETERNALCHAOS', 'BD_RINGNIBELUNGEN'];
const ENSEMBLE_PICK_ZH = '（戰鼓震天、永遠的混沌、尼貝隆根之戒指）';
export const SELECT = {
  self: { zh: '自己', of: 'self', pool: c => [c] },
  // one of the party down, in sight (Resurrection's)
  deadAlly: { zh: '倒下的隊友', of: 'ally', pool: c => crewOf(c).filter(x => x.dead != null && x.pc && sees(c, x)) },
  // (a character's Heal and Aid Potion: the party's homunculi too, by request)
  weakAlly: { zh: '血量比例最低的隊友', of: 'ally', pool: (c, ctx) => [...allies(c).filter(x => x.dead == null && (!x.isPc || x.pc)),
    ...c.isPc && ctx && HOMUN_HEALABLE.has(ctx.name) ? partyHomuns(c) : []], rank: (c, x) => x.hp / maxHp(x) },
  nearAlly: { zh: '最近的隊友', of: 'ally', pool: party },
  // (a rogue's, by request: the one its Snatch took away with it, standing, till it is down)
  snatched: { zh: '自己脅持帶走的怪', of: 'foe', pool: c => c.snatched && alive(c.snatched) && livingFoes(c).includes(c.snatched) ? [c.snatched] : [] },
  focus: { zh: '普攻目標', of: 'foe', pool: (c, ctx) => focusOf(c, ctx) ? [ctx.focus] : [] },
  current: { zh: '目前目標', of: 'foe', pool: c => livingFoes(c).filter(m => m === c.target) },
  near: { zh: '最近的怪', of: 'foe', pool: livingFoes },
  onMe: { zh: '正在打自己的怪', of: 'foe', pool: c => livingFoes(c).filter(m => m.target === c) },
  onAlly: { zh: '正在打隊友的怪', of: 'foe', pool: c => livingFoes(c).filter(m => m.target && m.target !== c && m.target.side === c.side && m.target.dead == null) },
  // (a mage's and a wizard's single-target spells, by request: one at the party that none of the rest is fighting)
  onAllyFree: { zh: '正在打隊友但沒有隊友在打的怪', of: 'foe', pool: c => { const s = partyFoes(c);
    return livingFoes(c).filter(m => m.target && m.target !== c && m.target.side === c.side && m.target.dead == null && !s.has(m)); } },
  onFragile: { zh: '正在打法師、巫師、賢者、獵人、弓箭手、祭司、服事系隊友的怪', of: 'foe', pool: c => livingFoes(c).filter(m => threatens(c, m)) },
  party: { zh: '隊友在打的怪', of: 'foe', pool: c => { const s = partyFoes(c); return livingFoes(c).filter(m => s.has(m)); } },
  weak: { zh: '血最少的怪', of: 'foe', pool: livingFoes, rank: (c, m) => m.hp / maxHp(m) },
  lowDef: { zh: '防禦最低的怪', of: 'foe', pool: livingFoes, rank: (c, m) => defOf(m) },
  lowDefRanged: { zh: '防禦最低的遠距離怪', of: 'foe', pool: c => livingFoes(c).filter(m => atkRangeOf(m) > 3), rank: (c, m) => defOf(m) },
  crowd: { zh: '範圍內最多隻的怪', of: 'foe', pool: livingFoes, rank: (c, m, ctx) => -crowdAt(c, ctx, m) },
  safe: { zh: v => `安全的格子（在打人的怪 ${v[0]} 格內就退，退到 ${v[1]} 格外）`, of: 'cell', v: [3, 5], vs: ['格內就退', '格外'],
    pool: (c, ctx, v) => backOff(c, v[0], v[1], ctx.t) },
  // loot no one else is on its way to (c.loot): the nearest
  loot: { zh: '最近的掉落物', of: 'item', pool: c => W.items.filter(it => !allChars().some(x => x !== c && x.loot === it && x.dead == null)) },
  // (playing a song alone: where it does the most, songSpot)
  // (once there, it stays SONG_STAY ms before it looks again: by request, not after every step of the others)
  songSpot: { zh: `演奏中的歌能影響最多目標的格子（${SONG_SPOT} 格內；走到後停 ${SONG_STAY / 1000} 秒才再找）`, of: 'cell', pool: (c, ctx) => {
    const n = W.songs.find(x => x.by === c && !x.with);
    if (!n) return [];
    if (!c.w.moving) { c.songStill ??= ctx.t; if (ctx.t - c.songStill < SONG_STAY) return []; }
    const p = songSpot(c, n.sk.name, n.lv);
    if (p) c.songStill = null;
    return p ? [p] : [];
  } },
  // (the sage's element fields: fieldSpot)
  fieldSpot: { zh: '元素領域涵蓋最多在打怪的隊友的格子（自己的同一種已經涵蓋那麼多就不找）', of: 'cell', pool: (c, ctx) => { const p = ctx.name && fieldSpot(c, ctx.name); return p ? [p] : []; } },
  dodge: { zh: '敵方正在詠唱的地面範圍魔法（暴風雪、怒雷強擊、隕石術、天堂之怒、雷鳴術、箭雨、聖光、泥沼地、毒霧…）範圍外最近的格子（自己在範圍內才走）', of: 'cell', pool: c => dodgeSpot(c) },
  lure: { zh: `把正在打自己的近戰怪引進隊伍地上的範圍技能（火煙瓶、暴風雪、聖光、泥沼地、毒霧、火牆，還剩 ${LURE_LEFT_MS / 1000} 秒以上；或隊友正在詠唱的範圍魔法）：站到範圍另一邊`, of: 'cell', pool: (c, ctx) => lureSpot(c, ctx.t) },
  // (a rogue's Back Stab: the cell right behind the one it attacks, the way that one faces, while it is not after the
  // rogue, and not one another stands on; none once there. Kept while it walks there (by report: none then had the
  // rules below send it to attack, and back, to and fro for ever))
  backOf: { zh: '普攻目標背後的格子（牠沒在打自己時）', of: 'cell', pool: (c, ctx) => {
    const m = focusOf(c, ctx);
    if (!m || m.isPc || m.target === c) return [];
    // (the one right behind, else the two either side of it, which behind() takes too, the nearest: one taken, by a
    // monster in the crowd or the one of the party it fights, had the rogue in hiding stand there doing nothing)
    const f = facing(m), busy = field.taken(c.w), ps = [f, (f + 1) % 8, (f + 7) % 8]
      .map(d => [m.w.cell[0] - DIR_STEP[d][0], m.w.cell[1] - DIR_STEP[d][1]]);
    if (ps.some(p => sameCell(c.w.cell, p)) && !c.w.moving) return [];
    if (c.w.moving && ps.some(p => sameCell(walkEnd(c), p))) return [walkEnd(c)];  // (the one it is on its way to kept)
    return ps.filter(p => field.open(p[0], p[1]) && !busy.has(p[0] + ',' + p[1]) && !sameCell(c.w.cell, p))
      .sort((a, b) => cheb(a, c.w.cell) - cheb(b, c.w.cell)).slice(0, 1);
  } },
  // (a bow rogue's, hidden: away from them to shoot from, by request: hideAway)
  // (a hunter's Detect, by request: the cell of the nearest enemy in hiding or cloaked within the skill's reach)
  hiddenFoe: { zh: '射程內最近的隱匿或偽裝敵人所在的格子', of: 'cell', pool: (c, ctx) => units()
    .filter(u => u.side !== c.side && alive(u) && (hidden(u) || cloaked(u)) && field.distance(c.w, u.w) <= rangeOf(c, ctx))
    .sort((a, b) => field.distance(c.w, a.w) - field.distance(c.w, b.w)).map(u => [...u.w.cell]) },
  // (Sight's and Ruwach's, by request: on, it walks to the nearest enemy still in hiding or cloaked, HIDDEN_WALK
  // cells off at most, till it is brought out)
  hiddenNear: { zh: `${HIDDEN_WALK} 格內最近的隱匿或偽裝敵人所在的格子`, of: 'cell', pool: c => units()
    .filter(u => u.side !== c.side && alive(u) && (hidden(u) || cloaked(u)) && cheb(u.w.cell, c.w.cell) <= HIDDEN_WALK)
    .sort((a, b) => cheb(a.w.cell, c.w.cell) - cheb(b.w.cell, c.w.cell)).map(u => [...u.w.cell]) },
  // (a bow rogue's round of Divests: the monster it took up the dagger for, standing)
  divestOn: { zh: '換短劍時的那隻怪', of: 'foe', pool: c => c.divestOn && alive(c.divestOn) ? [c.divestOn] : [] },
  hideAway: { zh: `離所有怪 ${HIDE_FAR} 格外、走最少的格子（${RETREAT} 格內找）`, of: 'cell', pool: (c, ctx) => hideAway(c, ctx.t) },
  // (a dagger rogue's, hidden: where Sightless Mind takes in the most, by request: raidSpot)
  raidSpot: { zh: `潛擊範圍內最多隻怪的格子（${RAID_WALK} 格內找；比站著的地方多才走）`, of: 'cell', pool: c => raidSpot(c) },
  rest: { zh: '隊長旁 1～3 格', of: 'cell', pool: c => { const p = restSpot(c); return sameCell(walkEnd(c), p) && !c.w.moving ? [] : [p]; } },
};
// Conditions: zh / no (its words, and with `not`; v its number), who (the clauses it goes in: t 對象, s 自己,
// f 怪物, a 隊友), v (the number's default; unit: its unit), test(c, x, ctx, v)
const pctOf = (x, v) => x.sp != null && x.pc ? x.sp * 100 < x.pc.maxSp * v : false;
export const CONDS = {
  hpBelow: { zh: v => `HP < ${v}%`, no: v => `HP ≥ ${v}%`, who: 'tsfa', v: 50, test: (c, x, ctx, v) => x.hp * 100 < maxHp(x) * v },
  hpAbove: { zh: v => `HP > ${v}%`, no: v => `HP ≤ ${v}%`, who: 'tsfa', v: 50, test: (c, x, ctx, v) => x.hp * 100 > maxHp(x) * v },
  spBelow: { zh: v => `SP < ${v}%`, no: v => `SP ≥ ${v}%`, who: 'tsa', v: 75, test: (c, x, ctx, v) => pctOf(x, v) },
  spAtLeast: { zh: v => `SP ≥ ${v}%`, no: v => `SP < ${v}%`, who: 'tsa', v: 75, test: (c, x, ctx, v) => x.sp != null && x.pc && !pctOf(x, v) },
  spAfter: { zh: v => `放完 SP 還剩 ≥ ${v}%`, no: v => `放完 SP 剩不到 ${v}%`, who: 's', v: 50, test: (c, x, ctx, v) => (x.sp - (ctx.name ? spOf(x, ctx.name) : 0)) * 100 >= x.pc.maxSp * v },
  cantAfford: { zh: v => `SP 不夠放${db.skills[v]?.zh || v}`, no: v => `SP 夠放${db.skills[v]?.zh || v}`, who: 's', v: 'MG_FIREBOLT', skill: true, test: (c, x, ctx, v) => !!db.skills[v] && x.sp < spOf(x, v) },
  // none of the skills its rules use learned yet (a mage or an acolyte fresh from the Novice: it fights with its
  // weapon instead, by request; not one merely out of SP, which the bench found walking into a boss and falling)
  noSkill: { zh: '還沒學會能用的技能', no: '學會了能用的技能', who: 's', test: (c, x) => !rulesOf(x).some(r => [r.do].flat().some(n =>
    !isDrink(n) && db.skills[n] && db.skills[n].target !== 'Passive' && knows(x, n))) },
  spheresBelow: { zh: v => `氣彈少於 ${v} 顆`, no: v => `氣彈至少 ${v} 顆`, who: 's', v: 1, test: (c, x, ctx, v) => (x.spheres || []).length < v },
  notFull: { zh: 'HP 或 SP 沒滿', no: 'HP 和 SP 都滿', who: 'tsa', test: (c, x) => x.hp < maxHp(x) || (x.sp != null && !!x.pc && x.sp < x.pc.maxSp) },
  ailing: { zh: '沉默、黑暗或混亂', no: '沒有沉默、黑暗、混亂', who: 'tsa', test: (c, x) => cures(x) },
  poisoned: { zh: '中毒', no: '沒中毒', who: 'tsfa', test: (c, x) => !!x.poison },
  undead: { zh: '不死屬性', no: '非不死屬性', who: 'tf', test: (c, x) => B.isUndead(baseStatus(x)) },
  fire: { zh: '火屬性', no: '非火屬性', who: 'tf', test: (c, x) => baseStatus(x).element === 'Fire' },
  stealable: { zh: '偷得到（有掉落物、還沒被偷過）', no: '偷不到', who: 'tf', test: (c, x) => stealable(x) },
  stealTries: { zh: v => `被偷了 ${v} 次以上`, no: v => `被偷不到 ${v} 次`, who: 't', v: 3, test: (c, x, ctx, v) => (x.stealTries || 0) >= v },
  small: { zh: '小型', no: '中型或大型', who: 'tf', test: (c, x) => baseStatus(x).size === 'Small' },
  boss: { zh: 'BOSS', no: '非 BOSS', who: 'tf', test: (c, x) => isBoss(x) },
  frozen: { zh: '冰凍中', no: '沒在冰凍', who: 'tfa', test: (c, x) => !!x.frozen },
  stoned: { zh: '石化', no: '沒石化', who: 'tfa', test: (c, x) => !!(x.stone && x.stone.on) },
  cursed: { zh: '詛咒', no: '沒詛咒', who: 'tfa', test: (c, x) => !!x.curse },
  ranged: { zh: '遠距離攻擊（射程超過 3 格）', no: '近距離攻擊', who: 'tsfa', test: (c, x) => (x.isPc ? x.pc.range : x.st.range) > 3 },
  inRange: { zh: '在射程內', no: '在射程外', who: 'tfa', test: (c, x, ctx) => field.distance(c.w, x.w) <= rangeOf(c, ctx) && field.sees(c.w.cell, x.w.cell) },
  within: { zh: v => `${v} 格內`, no: v => `超過 ${v} 格`, who: 'tfa', v: 3, test: (c, x, ctx, v) => field.distance(c.w, x.w) <= v },
  inArea: { zh: '在技能範圍內（以自己為中心）', no: '在技能範圍外', who: 'tfa', test: (c, x, ctx) => field.distance(c.w, x.w) <= reachOf(ctx) },
  walkOver: { zh: v => `要走超過 ${v} 格才打得到`, no: v => `走 ${v} 格內就打得到`, who: 'tf', v: 3, test: (c, x, ctx, v) => field.distance(c.w, x.w) - c.pc.range > v },
  onMe: { zh: '正在打自己', no: '沒在打自己', who: 'tf', test: (c, x) => x.target === c },
  onUs: { zh: '正在打隊友（含自己）', no: '沒在打人', who: 'tf', test: (c, x) => !!x.target && x.target.side === c.side && x.target.dead == null },
  onFragile: { zh: '正在打法師、巫師、獵人、弓箭手、祭司、服事系隊友', no: '沒在打法師、巫師、獵人、弓箭手、祭司、服事系隊友', who: 'tf', test: (c, x) => threatens(c, x) },
  chasing: { zh: '正在追人（還沒打到）', no: '沒在追人', who: 'tf', test: (c, x) => x.mss === 'chase' },
  meleed: { zh: '被近身的怪攻擊（3 格內）', no: '沒被近身攻擊', who: 'tsa',
    test: (c, x) => livingFoes(c).some(m => m.target === x && onAttack(m) && atkRangeOf(m) <= 3 && field.distance(m.w, x.w) <= 3) },
  shot: { zh: '被 3 格外的怪遠距離攻擊', no: '沒被遠距離攻擊', who: 'tsa',
    test: (c, x) => livingFoes(c).some(m => m.target === x && onAttack(m) && atkRangeOf(m) > 3 && field.distance(m.w, x.w) > 3) },
  crowd: { zh: v => `技能範圍內至少 ${v} 隻（以牠為中心）`, no: v => `技能範圍內不到 ${v} 隻（以牠為中心）`, who: 't', v: 3, test: (c, x, ctx, v) => crowdAt(c, ctx, x) >= v },
  pushable: { zh: v => `後面能推 ${v} 格以上`, no: v => `後面推不到 ${v} 格`, who: 't', v: 4, test(c, x, ctx, v) {
    const knock = ctx.name ? db.skills[ctx.name].knockback?.[ctx.lv - 1] || 0 : 0, [px, py] = field.knockTo(x.w, c.w, knock);
    return Math.max(Math.abs(px - x.w.cell[0]), Math.abs(py - x.w.cell[1])) >= v;
  } },
  wallBetween: { zh: '和自己中間有自己的火牆', no: '和自己中間沒有自己的火牆', who: 't', test: (c, x) => { const ws = wallCells(c); return between(x.w.cell, c.w.cell).some(p => ws.some(w => sameCell(w, p))); } },
  wallNear: { zh: '旁邊有自己的火牆', no: '旁邊沒有自己的火牆', who: 't', test: (c, x) => wallCells(c).some(w => cheb(w, x.w.cell) <= 1) },
  used: { zh: '自己對牠用過這招', no: '自己沒對牠用過這招', who: 't', test: (c, x, ctx) => !!x.usedOn?.has(c.id + ':' + ctx.name) },
  line: { zh: v => `是${LINE_LABEL[v] || v}系`, no: v => `不是${LINE_LABEL[v] || v}系`, who: 'ta', v: 'acolyte', lines: true, test: (c, x, ctx, v) => !!x.isPc && lineOf(x) === v },
  burst: { zh: v => `${BURST_MS / 1000} 秒內受到 MaxHP ${v}% 以上的傷害`, no: v => `${BURST_MS / 1000} 秒內受到的傷害不到 MaxHP ${v}%`, who: 's', v: 20, test: (c, x, ctx, v) => burst(x, ctx.t) * 100 >= maxHp(x) * v },
  stopped: { zh: v => `${STOP_MS / 1000} 秒內走路被打停 ${v} 次以上`, no: v => `${STOP_MS / 1000} 秒內走路被打停不到 ${v} 次`, who: 's', v: 2, test: (c, x, ctx, v) => x.stops.filter(s => ctx.t - s < STOP_MS).length >= v },
  hidden: { zh: '隱匿中', no: '沒在隱匿', who: 's', test: (c, x) => hidden(x) },
  // (Back Stab's: standing behind it, the way it faces, as fireSkill checks)
  behind: { zh: '自己在牠背後', no: '自己不在牠背後', who: 't', test: (c, x) => !x.isPc && behind(c, x) },
  // (a bow rogue's, by request: a dagger in its hands, its own or one taken up)
  daggerHeld: { zh: '拿著短劍', no: '沒拿短劍', who: 's', test: (c, x) => x.look.weapon === '단검' },
  daggerAgo: { zh: v => `換回弓超過 ${v} 秒（或還沒換過）`, no: v => `換回弓不到 ${v} 秒`, who: 's', v: 5, test: (c, x, ctx, v) => ctx.t - (x.daggerBack ?? -Infinity) >= v * 1000 },
  // (a round of the Divests it has learned, each tried on it once)
  divested: { zh: '自己對牠用過卸除', no: '自己沒對牠用過卸除', who: 't',
    test: (c, x) => DIVESTS.some(n => !!x.usedOn?.has(c.id + ':' + n)) },
  // (by request one of the Divests it has learned at random for each monster, picked the first time it is asked)
  divestPick: { zh: '是對牠隨機挑的那個卸除', no: '不是對牠隨機挑的那個卸除', who: 't', test: (c, x, ctx) => {
    const ks = DIVESTS.filter(n => knows(c, n)), picks = x.divestPicks ??= {};
    if (!ks.includes(picks[c.id])) picks[c.id] = ks.length ? ks[rnd(ks.length)] : null;
    return !!ctx.name && picks[c.id] === ctx.name;
  } },
  // (a bow rogue's Back Slide, by request: the slide, the way it faces, takes it `v` cells at least from every monster
  // next to it now)
  canSlide: { zh: v => `後退迴避退得開（離貼著的怪 ${v} 格以上）`, no: v => `後退迴避退不開（離貼著的怪不到 ${v} 格）`, who: 's', v: 3, test: (c, x, ctx, v) => {
    const p = field.knockTo(x.w, null, db.skills.TF_BACKSLIDING.knockback[0] || 5), near = livingFoes(x).filter(m => cheb(m.w.cell, x.w.cell) <= 1);
    return near.every(m => cheb(m.w.cell, p) >= v);
  } },
  // (the Divests': its status on it already)
  stripped: { zh: '身上已經有這招的效果', no: '身上沒有這招的效果', who: 'ts', test: (c, x, ctx) => !!ctx.name && has(x, ctx.name) },
  cloaked: { zh: '偽裝中', no: '沒在偽裝', who: 's', test: (c, x) => cloaked(x) },
  // (an acolyte's Ruwach, by request: an enemy in hiding or cloaked, which none can see, `v` cells off at most)
  revealing: { zh: '身上有火狩或光獵', no: '身上沒有火狩、光獵', who: 's', test: (c, x) => has(x, 'MG_SIGHT') || has(x, 'AL_RUWACH') },
  // (Snatch's, by request: right next to one of the party, not the user)
  snatching: { zh: '脅持帶走的怪還在', no: '沒有脅持帶走的怪', who: 's', test: (c, x) => !!x.snatched && alive(x.snatched) },
  // (a rogue's, by report: one that sees through hiding, a boss or a Detector, which hiding does not shake off)
  detector: { zh: '看得到隱匿（BOSS 或偵測型）', no: '看不到隱匿', who: 'tf', test: (c, x) => !x.isPc && (isBoss(x) || !!(x.st.mode & B.MD.DETECTOR)) },
  nextToAlly: { zh: '貼著隊友（1 格內，不算自己）', no: '沒貼著隊友', who: 't', test: (c, x) => friends(c).some(f => cheb(f.w.cell, x.w.cell) <= 1) },
  foeHidden: { zh: v => `${v} 格內有隱匿或偽裝的敵人`, no: v => `${v} 格內沒有隱匿或偽裝的敵人`, who: 's', v: 5,
    test: (c, x, ctx, v) => units().some(u => u.side !== x.side && alive(u) && (hidden(u) || cloaked(u)) && cheb(u.w.cell, x.w.cell) <= v) },
  // (within the reach of a skill of c's at its level: Grimtooth's, 3–7 cells)
  inRangeOf: { zh: v => `在${db.skills[v]?.zh || v}的射程內`, no: v => `在${db.skills[v]?.zh || v}的射程外`, who: 'tf', v: 'AS_GRIMTOOTH', skill: true,
    test: (c, x, ctx, v) => !!db.skills[v] && knows(c, v) && field.distance(c.w, x.w) <= (db.skills[v].range[(c.levels[v] || 1) - 1] || 1) && field.sees(c.w.cell, x.w.cell) },
  hiddenFor: { zh: v => `隱匿了 ${v} 秒以上`, no: v => `隱匿不到 ${v} 秒`, who: 's', v: 2, test(c, x, ctx, v) { const s = x.sc.find(s => s.name === 'TF_HIDING' && ctx.t < s.until); return !!s && ctx.t - s.start >= v * 1000; } },
  noIncoming: { zh: '沒有攻擊正要打到', no: '有攻擊正要打到', who: 's', test: (c, x) => !W.hits.some(h => h.to === x) },
  iceBetween: { zh: '和自己中間有冰牆', no: '和自己中間沒有冰牆', who: 't', test: (c, x) => iceBetween(x, c) },
  wallSaves: { zh: v => `有一群可以放${db.skills[v]?.zh || v}（射程內、至少 3 隻），詠唱完前會被打到，在往牠 2 格處立冰牆、牠繞過來就不會`,
    no: v => `立冰牆擋牠也放不了${db.skills[v]?.zh || v}`, who: 't', v: 'WZ_STORMGUST', skill: true, test: (c, x, ctx, v) => wallSaves(c, x, v, ctx, ctx.name ? spOf(c, ctx.name) : 0) },
  // a monster in the middle of casting a skill (Lex Divina's: silenced, it is cut off)
  casting: { zh: '正在詠唱技能', no: '沒在詠唱技能', who: 'tf', test: (c, x) => !x.isPc && !!x.cast },
  // a monster's attack on it, or one coming at it (Kyrie Eleison's)
  beingHit: { zh: '有怪正在打牠或追牠', no: '沒有怪在打牠、追牠', who: 'ta', test: (c, x) => livingFoes(c).some(m => m.target === x) },
  // the party's ones hurt (below 75%) round it, in the 5×5 a Sanctuary on its cell covers
  hurtNear: { zh: v => `周圍 2 格內至少 ${v} 個隊友 HP < 75%`, no: v => `周圍 2 格內受傷的隊友不到 ${v} 個`, who: 'ta', v: 2,
    test: (c, x, ctx, v) => party(c).filter(y => cheb(y.w.cell, x.w.cell) <= 2 && y.hp * 100 < maxHp(y) * 75).length >= v },
  // a monster a Sanctuary on its cell would heal (one not undead nor a demon within reach of its cells: sanctTurn)
  healsFoe: { zh: '光耀之堂會補到旁邊的怪', no: '光耀之堂不會補到怪', who: 'ta', test: (c, x) => livingFoes(c).some(m => !B.unholy(statusOf(m)) && cheb(m.w.cell, x.w.cell) <= 3) },
  // fighting an undead or a demon with its weapon (Aspersio's: holy on it)
  hitsUnholy: { zh: '拿武器在打不死屬性或惡魔型的怪', no: '沒在拿武器打不死屬性或惡魔型的怪', who: 'ta',
    test: (c, x) => weaponFighter(x) && !!x.target && alive(x.target) && x.target.side !== x.side && B.unholy(statusOf(x.target)) },
  // (Enchant Poison: one fighting with its weapon, its target taking poison no worse than neutral, as it would without)
  poisonWorks: { zh: '拿武器在打毒屬性打得痛的怪（不比無屬性差）', no: '沒在拿武器打毒屬性打得痛的怪', who: 'ta',
    test: (c, x) => { const m = x.target; if (!weaponFighter(x) || !m || !alive(m) || m.side === x.side) return false;
      const st = statusOf(m); return B.attrRatio(db, 'Poison', st.element, st.elementLv) >= B.attrRatio(db, 'Neutral', st.element, st.elementLv); } },
  // (a skill learned and its weapon in hand: Grimtooth with a katar)
  usable: { zh: v => `能用${db.skills[v]?.zh || v}（學會了、武器對）`, no: v => `不能用${db.skills[v]?.zh || v}`, who: 's', v: 'AS_GRIMTOOTH', skill: true,
    test: (c, x, ctx, v) => !!db.skills[v] && knows(x, v) && (!(db.skills[v].weapon || []).length || db.skills[v].weapon.includes(x.pc.weapon)) },
  fragile: { zh: '是法師、巫師、賢者、獵人、弓箭手、祭司、服事系', no: '不是法師、巫師、賢者、獵人、弓箭手、祭司、服事系', who: 'ta', test: (c, x) => !!x.isPc && FRAGILE.includes(lineOf(x)) },
  // a trap of the rule's can go on its way (wayCell)
  trapWay: { zh: '往目標走的路上放得了這個陷阱（射程內、周圍 1 格沒人、路上還沒有自己的這種陷阱）', no: '路上放不了這個陷阱', who: 't', test: (c, x, ctx) => !!ctx.name && TRAP_SKILLS.has(ctx.name) && !!wayCell(c, x, ctx.name, ctx.lv) },
  // held where it stands by a trap (Ankle Snare's snare, Skid Trap's stop), or asleep (Sandman's)
  held: { zh: '被陷阱定住（定位陷阱、滑動陷阱）', no: '沒被陷阱定住', who: 'tf', test: (c, x) => !!x.snared || !!x.stopped },
  asleep: { zh: '睡眠中', no: '沒在睡', who: 'tf', test: (c, x) => !!x.asleep },
  // (the damage the rule's skill would deal it, its dice at the middle: Asura Strike's, not wasted on one nearly down)
  hpVsSkill: { zh: v => `HP ≥ 這招傷害的 ${v}%`, no: v => `HP < 這招傷害的 ${v}%`, who: 't', v: 50,
    test: (c, x, ctx, v) => !!ctx.name && x.hp * 100 >= B.skillAttack(db, offense(c), defense(x), db.skills[ctx.name], ctx.lv, n => n >> 1).damage * v },
  performing: { zh: '演奏中', no: '沒在演奏', who: 'sa', test: (c, x) => has(x, 'BD_PERFORMING') },
  // (not in one already, a partner for one it has in the party: ensembleMate)
  // (by request: one of 自動's, ENSEMBLE_PICK, with the SP for it; any other ensemble the two have had it stop a song
  // alone for one it would not play)
  ensembleReady: { zh: `能合奏${ENSEMBLE_PICK_ZH}其中一個（隊伍裡有也會、拿樂器或鞭子的異性詩人／舞孃，SP 夠；戰鼓震天要有近戰隊友，永遠的混沌要有物理攻擊隊友）`, no: '不能合奏', who: 's',
    test: (c, x) => { if (inEnsemble(x)) return false; const m = ensembleMate(x, ENSEMBLE_PICK); return !!m && ENSEMBLE_PICK.some(n => knows(x, n) && knows(m, n) && ensembleWanted(x, n) && x.sp >= spCost(x, db.skills[n], x.levels[n] || 1)); } },
  // (by request: a bard or a dancer mobbed while playing: Amp, Frost Joke or Scream once, then the bow: holdBow)
  bowHeld: { zh: '換成弓了', no: '拿著樂器或鞭子', who: 's', test: (c, x) => !!x.bowHeld },
  ampMobbed: { zh: v => `${v} 秒內被圍攻（2 隻以上在打自己）時用過臨機應變`, no: v => `${v} 秒內沒在被圍攻時用過臨機應變`, who: 's', v: 10,
    test: (c, x, ctx, v) => ctx.t - (x.ampMobbed ?? -Infinity) < v * 1000 },
  jokedAfterAmp: { zh: '被圍攻用臨機應變後放過冷笑話或驚聲尖叫', no: '被圍攻用臨機應變後還沒放冷笑話或驚聲尖叫', who: 's',
    test: (c, x) => { const a = x.ampMobbed; return a != null && ['BA_FROSTJOKER', 'DC_SCREAM'].some(n => (x.usedAt?.[n] ?? -Infinity) >= a); } },
  physical: { zh: '物理攻擊（不是法師、巫師、賢者、祭司、服事、詩人／舞孃系；不算自己）', no: '不是物理攻擊的隊友', who: 'a', test: (c, x) => physicalAlly(c, x) },
  caster: { zh: '施法系（法師、巫師、賢者系；不算自己）', no: '不是施法系的隊友', who: 'a', test: (c, x) => casterAlly(c, x) },
  // (by request: which song alone, the one for the more of the party; as many, the fighters')
  physicalFirst: { zh: '物理攻擊的隊友不比施法系少', no: '施法系隊友比物理攻擊的多', who: 's', test: (c, x) => { const f = friends(x); return f.filter(y => physicalAlly(x, y)).length >= f.filter(y => casterAlly(x, y)).length; } },
  sinceUsed: { zh: v => `${v} 秒內沒用過這招`, no: v => `${v} 秒內用過這招`, who: 's', v: 20, test: (c, x, ctx, v) => !ctx.name || ctx.t - (x.usedAt?.[ctx.name] ?? -Infinity) >= v * 1000 },
  // the sage's (by request): a monster casting a spell at it that lands within Magic Rod's time at its level (Magic Rod's)
  spellAtMe: { zh: '正在對自己詠唱魔法（魔法懲罰的時間內唸完）', no: '沒在對自己詠唱魔法', who: 'f',
    test: (c, x, ctx) => !x.isPc && !!x.cast && x.cast.target === c && !!B.SKILLS[x.cast.sk.name]?.magic
      && x.cast.end - ctx.t <= (db.skills.SA_MAGICROD.duration[(c.levels.SA_MAGICROD || 1) - 1] || 0) },
  // a monster with a buff of its own on it (Dispell's: Agility Up, Keeping, Two-Hand Quicken, Adrenaline Rush)
  buffed: { zh: '身上有增益（加速、硬化、雙手劍攻擊速度增加、速度激發）', no: '身上沒有增益', who: 'tf',
    test: (c, x) => !x.isPc && x.sc.some(s => W.t < s.until && MOB_OWN_BUFFS.includes(s.name)) },
  // one of the party fighting with its weapon (not bare-handed, where an endow fails), the endow `v` the one of those the user knows whose element hurts its
  // target most, more than neutral, and not on it (by request: by the monster's weakness)
  endowBest: { zh: v => `拿武器在打的怪最怕${db.skills[v]?.zh || v}的屬性（比無屬性痛，身上還沒有）`, no: v => `${db.skills[v]?.zh || v}不是最好的屬性附加`, who: 'ta', v: 'SA_FLAMELAUNCHER', skill: true,
    test: (c, x, ctx, v) => weaponFighter(x) && x.pc.weapon !== 'Fist' && !!x.target && alive(x.target) && x.target.side !== x.side && !has(x, v) && bestOf(c, ENDOW_ELE, x.target) === v },
  // the element field `v` the one of those the user knows that the monsters in the fight are weakest to, more than
  // neutral; with none so, Volcano (its ATK) where fire is no worse than neutral (by request: by their weakness)
  fieldBest: { zh: v => `打的怪最怕${db.skills[v]?.zh || v}的屬性（都不怕就放火元素領域）`, no: v => `${db.skills[v]?.zh || v}不是最好的元素領域`, who: 's', v: 'SA_VOLCANO', skill: true,
    test: (c, x, ctx, v) => bestField(c) === v },
  // a monster casting a ground skill (Land Protector's, on the sage's own cell)
  groundCast: { zh: '正在詠唱地面技能', no: '沒在詠唱地面技能', who: 'f', test: (c, x) => !x.isPc && !!x.cast && !!x.cast.target?.ground },
  weaponPays: { zh: '普攻打牠划算（看牠的 DEF／MDEF：箭類的每秒傷害不到普攻的 1.5 倍）', no: '放箭類打牠划算（箭類的每秒傷害是普攻的 1.5 倍以上）', who: 't', test: (c, x, ctx) => !x.isPc && weaponPays(c, x, ctx.t) },
  bestArea: { zh: v => `${db.skills[v]?.zh || v}對牠周圍的怪最痛（崩裂術、雷爆術、火球術裡每秒傷害最高的，看牠們的屬性）`, no: v => `${db.skills[v]?.zh || v}不是對牠周圍最痛的範圍魔法`, who: 't', v: 'MG_FIREBALL', skill: true,
    test: (c, x, ctx, v) => !x.isPc && bestArea(c, x, ctx.t) === v },
  // a monster to attack (its target, standing)
  attacking: { zh: '有普攻目標', no: '沒有普攻目標', who: 's', test: (c, x) => !!x.target && alive(x.target) && x.target.side !== x.side },
  // casting a skill, walking meanwhile (Free Cast learned)
  freeCasting: { zh: '詠唱中（學了自由施法，可以邊走）', no: '沒在邊走邊詠唱', who: 's', test: (c, x) => !!x.cast && !!freeCastLv(x) },
  castSafe: { zh: '詠唱完前不會被打到', no: '詠唱完前會被打到', who: 's', test: (c, x, ctx) => !ctx.name || B.castTime(db.skills[ctx.name], ctx.lv, c.pc) < timeToCast(c, ctx.t) },
  // (issue 10) no monster but this one gets a hit in on character c before the cast ends: one alone on it, the rest
  // far off. (Arrow Repel's: pushing one back when others are on it too, or on their way, frees nothing, a cast wasted)
  castClear: { zh: '詠唱完前只有牠打得到自己', no: '詠唱完前還有別的怪打得到自己', who: 't', test: (c, x, ctx) => !ctx.name || B.castTime(db.skills[ctx.name], ctx.lv, c.pc) < timeToCast(c, ctx.t, x) },
};
// the words of condition item i; `not` turns them round
export function condText(i) {
  const d = CONDS[i.k];
  if (!d) return i.k;
  const z = i.not ? d.no || (v => `不是${typeof d.zh === 'function' ? d.zh(v) : d.zh}`) : d.zh;
  return typeof z === 'function' ? z(i.v ?? d.v) : z;
}
const testItem = (c, x, ctx, i) => !!CONDS[i.k]?.test(c, x, ctx, i.v ?? CONDS[i.k].v) !== !!i.not;
const holds = (c, x, ctx, is) => is.every(i => testItem(c, x, ctx, i));
// skill `name` does something to unit x, used by character c (see above)
function fits(c, name, x, ctx) {
  const sk = db.skills[name];
  if (targetFail(sk, x)) return false;  // (Detoxify, Cure)
  if (magicImmune(c, x, sk)) return false;  // (Golden Thief Bug's: not aimed at, no SP spent)
  if (casterFail(c, sk, x, ctx.lv)) return false;  // (Resistant Souls, Sacrifice)
  if (name === 'AL_BLESSING' && x.isPc && (x.curse || (x.stone && x.stone.on))) return true;  // (it lifts the curse or breaks the stone: see buff)
  // (Enchant Poison: not over an Aspersio, which each would end)
  if (x.side === c.side) return (!['AL_INCAGI', 'AL_BLESSING', 'PR_KYRIE', 'PR_ASPERSIO', 'AS_ENCHANTPOISON', 'CR_DEVOTION'].includes(name) || !has(x, name))
    && (name !== 'AS_ENCHANTPOISON' || !has(x, 'PR_ASPERSIO'));
  switch (name) {
    case 'SM_PROVOKE': return !has(x, name) && B.STATUS_SKILLS.SM_PROVOKE.chance(c.pc, baseStatus(x), ctx.lv) > 0;
    case 'AL_DECAGI': return !isBoss(x) && !has(x, name);
    case 'AL_HEAL': return B.isUndead(baseStatus(x));  // (on a monster: it hurts the undead, and heals the rest)
    case 'AC_CHARGEARROW': return !isBoss(x);
    case 'TF_STEAL': return stealable(x);
    case 'WZ_QUAGMIRE': return !has(x, name);
    // (Venom Splasher: not a boss, where it fails, nor one about to blow up already: a second would take its place)
    case 'AM_DEMONSTRATION': return !!bombCell(c, x, ctx.lv);
    case 'AM_CANNIBALIZE': return !!plantCell(c, x, ctx.lv || 1);
    case 'AS_SPLASHER': return !isBoss(x) && !has(x, name) && hurts(c, name, x);
    // (Lex Divina on one silenced lifts it; one it cannot silence it is wasted on: lex)
    case 'PR_LEXDIVINA': return !x.silenced && B.silenceOdds(statusOf(c), statusOf(x), 100, 1000).chance > 0;
    case 'PR_LEXAETERNA': return !has(x, name) && !x.frozen && !(x.stone && x.stone.on);
    // (a hunter's traps that hold one: not a boss, which does not set them off; nor one held already; Freezing Trap's,
    // Sandman's: one it can freeze, put to sleep)
    case 'HT_ANKLESNARE': case 'HT_SKIDTRAP': return !isBoss(x) && !x.snared && !x.stopped;
    case 'HT_FREEZINGTRAP': return !x.frozen && hurts(c, name, x) && B.freezeOdds(statusOf(c), statusOf(x), 100, sk.duration2[ctx.lv - 1] || 0).chance > 0;
    case 'HT_FLASHER': return !x.blind && !(isBoss(x) && statusOf(x).race === 'Plant');
    case 'HT_SANDMAN': return !x.asleep && B.sleepOdds(statusOf(c), statusOf(x), 10 * ctx.lv + 40, sk.duration2[ctx.lv - 1] || 0).chance > 0;
    // (Frost Diver, by request: not on one it cannot freeze — a boss, the undead, or one its water does no harm to,
    // as the freeze is rolled only on a hit that does damage)
    case 'MG_FROSTDIVER': return !x.frozen && hurts(c, name, x) && B.freezeOdds(statusOf(c), statusOf(x), B.SKILLS.MG_FROSTDIVER.freeze(ctx.lv), sk.duration2[ctx.lv - 1] || 0).chance > 0;
  }
  return hurts(c, name, x);
}
// a Self skill does something: a buff not on the character, one for the party not on all of them in its area,
// Signum Crucis with a monster in its area it may take, Sightrasher in Sight
const SMITH_BUFFS = ['BS_ADRENALINE', 'BS_OVERTHRUST', 'BS_WEAPONPERFECT'];
function fitsSelf(c, name, ctx) {
  // (the crusader's too: Auto Guard and Defending Aura used again would end them)
  if (['SM_ENDURE', 'AC_CONCENTRATION', 'KN_TWOHANDQUICKEN', 'CR_AUTOGUARD', 'CR_REFLECTSHIELD', 'CR_DEFENDER', 'CR_SPEARQUICKEN', 'MG_SIGHT', 'AS_POISONREACT', 'AS_CLOAKING', 'MO_EXPLOSIONSPIRITS', 'MO_STEELBODY', 'SA_MAGICROD', 'MG_ENERGYCOAT', 'AL_RUWACH'].includes(name)) return !has(c, name);
  if (name === 'SA_AUTOSPELL') return hindsightDue(c);
  if (HOMUN_SKILLS[name]) return HOMUN_SKILLS[name](c);  // (the homunculus's: none out to call, one down to bring back)
  if (name === 'WZ_SIGHTRASHER') return has(c, 'MG_SIGHT');
  const area = reachOf(ctx);
  if (['MC_LOUD', 'AL_ANGELUS', 'PR_IMPOSITIO', 'PR_SUFFRAGIUM', 'PR_GLORIA', 'PR_MAGNIFICAT'].includes(name)) return party(c).some(x => field.distance(c.w, x.w) <= area && !has(x, name));
  // the blacksmith's party buffs: one of the party in reach that would take it (DOES.smith: the weapon the skill asks
  // for) not on it; Maximize Power on in a fight, off (used again) with no monster left
  if (SMITH_BUFFS.includes(name)) { const need = db.skills[name].weapon || []; return party(c).some(x => x.isPc && x.pc && field.distance(c.w, x.w) <= area && (!need.length || need.includes(x.pc.weapon)) && !has(x, name)); }
  if (name === 'BS_MAXIMIZE') return livingFoes(c).length ? !has(c, name) : has(c, name);
  if (name === 'AL_CRUCIS') { const st = statusOf(c); return livingFoes(c).some(m => field.distance(c.w, m.w) <= area && !has(m, name) && B.crucisOdds(st, statusOf(m), ctx.lv) > 0); }
  return true;
}
// a rule character c can follow at all: on, and its skill (one of them, for a list) learned
export const ruleOn = (c, r) => !r.off && (Array.isArray(r.do) ? r.do.some(n => knows(c, n)) : !db.skills[r.do] || knows(c, r.do));
// the one rule r has character c go for (or where): its selectors in order, the candidates its 對象 clauses
// and the skill (fits) let through, the first one's best
function pick(c, r, ctx) {
  const is = (r.if || []).filter(x => x.who === 'target').flatMap(x => x.is), group = Array.isArray(r.do);
  for (const s of r.target || []) {
    const sel = SELECT[s.k];
    if (!sel || (s.k === 'focus' && ctx.inFocus)) continue;
    const ok = sel.pool(c, ctx, s.v || sel.v).filter(x => (sel.of === 'cell' || !ctx.name || (group ? bestBolt(c, x, ctx.t, Infinity, r.do) : fits(c, ctx.name, x, ctx))) && (sel.of === 'cell' || holds(c, x, ctx, is)));
    if (!ok.length) continue;
    if (sel.of === 'cell') return ok[0];
    // (dodging, an attack: one reached out of the areas it dodges before one only reached in them, by request; that
    // one all the same if it is all there is, waited for out of them: approach)
    const inZone = r.do === 'attack' && dangerOf(c), walled = x => inZone && walledOff(c, x, inZone) ? 1 : 0;
    const key = x => [sel.rank ? sel.rank(c, x, ctx) : 0, walled(x), x === c.target ? 0 : 1, field.distance(c.w, x.w)];
    return ok.map(x => [key(x), x]).sort(([a], [b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3])[0][1];
  }
  return null;
}
// the default target of the ones who attack (a job without a normal attack in its rules: the acolyte's, the mage's)
const ATTACK_TARGET = [{ k: 'current' }, { k: 'party' }, { k: 'near' }];
// the monster character c attacks (its first attack rule's pick: 普攻目標), worked out once a reading
function focusOf(c, ctx) {
  if (ctx.focus === undefined) {
    const r = rulesOf(c).find(r => r.do === 'attack' && !r.off) || { do: 'attack', target: ATTACK_TARGET };
    ctx.focus = pick(c, r, { t: ctx.t, inFocus: true }) || null;
  }
  return ctx.focus;
}
// the level of Heal character c gives ally x: the lowest learned that makes up what it is missing (B.heal: a
// player's heal has no luck in it), else the top one; a level the SP left does not cover is passed over
function healLevel(c, x) {
  const sk = db.skills.AL_HEAL, st = statusOf(c), dst = statusOf(x), missing = maxHp(x) - x.hp;
  const lvs = Array.from({ length: c.levels.AL_HEAL }, (_, i) => i + 1).filter(lv => !skillFail(c, sk, lv));
  return lvs.find(lv => B.heal(db, st, dst, sk, lv).damage >= missing) || lvs[lvs.length - 1];
}
// the skills whose level a rule picks as it goes (not the top one learned): Heal's (healLevel), Aid Potion's (potionLevel)
const LEVEL_PICKED = new Set(['AL_HEAL', 'AM_POTIONPITCHER']);
// the level of Aid Potion character c throws ally x (by choice, as Heal's): of the HP potions (Lv 1–4: Red to White;
// Lv 5's Blue heals SP alone) with one in the bag, the lowest that makes up what x is missing (pitchPotion, its roll
// at the middle), else the top one; undefined with none
function potionLevel(c, x) {
  const sk = db.skills.AM_POTIONPITCHER, missing = maxHp(x) - x.hp, vit = statusOf(x).stats.vit;
  const skill = 100 + passiveLv(c, 'AM_POTIONPITCHER') * 10 + passiveLv(c, 'AM_LEARNINGPOTION') * 5;
  const heals = lv => { const h = (db.items[ITEM_BY_LV.AM_POTIONPITCHER[lv - 1]] || {}).heal; if (!h) return 0;
    const n = Math.trunc(Math.trunc((h[0] + h[1]) / 2 * skill / 100) * (100 + vit * 2) / 100);
    return x.isPc ? Math.trunc(n * (100 + passiveLv(x, 'SM_RECOVERY') * 10) / 100) : n; };
  const lvs = Array.from({ length: Math.min(c.levels.AM_POTIONPITCHER || 0, 4) }, (_, i) => i + 1).filter(lv => !skillFail(c, sk, lv) && heals(lv) > 0);
  return lvs.find(lv => heals(lv) >= missing) ?? lvs[lvs.length - 1];
}
// the cell `n` cells from character c toward unit x (its own, nearer), if open
function aheadOf(c, x, n) {
  const way = between(c.w.cell, x.w.cell), at = way[Math.min(n, way.length) - 1];
  return at && field.open(at[0], at[1]) ? at : null;
}
// A hunter's trap can go on cell p: open, no trap on it, no one within a cell of it (footFail)
const trapCellOk = p => field.open(p[0], p[1]) && !W.traps.some(n => n.x === p[0] && n.y === p[1] && n.sk.name !== 'WZ_FIREPILLAR') && !footFail('HT_SKIDTRAP', p[0], p[1]);
// Traps on the way (by request): monster m coming at someone (chasing) walks the cells between it and the one it is
// after; character c's trap `name` goes on the first of them (from m's end) that it reaches (the skill's range) and
// sees and can take the trap — so m walks into it. None while c has that trap on m's way already, or WAY_MAX traps of
// its own (within a cell of the way: what m would set off).
const WAY_MAX = 2;
function wayCell(c, m, name, lv) {
  const to = m.target;
  if (m.mss !== 'chase' || !to || !inFight(to) || !alive(to)) return null;
  const way = between(m.w.cell, to.w.cell);
  const mine = W.traps.filter(n => n.by === c && TRAP_SKILLS.has(n.sk.name) && way.some(p => cheb(p, [n.x, n.y]) <= 1));
  if (mine.length >= WAY_MAX || mine.some(n => n.sk.name === name)) return null;
  const range = B.skillRange(db.skills[name], lv, attacker(c));
  return way.find(p => cheb(p, c.w.cell) <= range && field.sees(c.w.cell, p) && trapCellOk(p)) || null;
}
// The level of Bio Cannibalize character c's rules use (by request: at random): with plants of its own out, theirs
// (another kind would fail: summonFail), else one of the levels learned at random, kept until a plant comes of it
function plantLevel(c) {
  const out = summonsOf(c, 'AM_CANNIBALIZE')[0];
  if (out) return [1, 2, 3, 4, 5].find(lv => SUMMONS.AM_CANNIBALIZE(lv) === out.def.id) || c.levels.AM_CANNIBALIZE;
  return c.plantLv ??= 1 + rnd(c.levels.AM_CANNIBALIZE || 1);
}
// Demonstration on the way (by request): monster m, close-range, coming at one of c's side (chasing), its fire goes on
// the cell of m's way 2 cells short of the one it is after, so that m, stopped next to it to attack, stands in the
// fire's 3×3; only one m will not have walked within a cell of by the time the cast is over (its cells at m's pace, the
// cast BOMB_MARGIN ms longer), in c's reach
// and sight, with no one within a cell of it and no fire within a cell (NoFootSet, NoReiteration: placeBomb), nor on a
// Land Protector
const BOMB_MARGIN = 200;
function bombCell(c, m, lv) {
  const to = m.target;
  if (m.isPc || m.mss !== 'chase' || !to || !inFight(to) || !alive(to) || m.st.range > 3) return null;
  const way = between(m.w.cell, to.w.cell), sk = db.skills.AM_DEMONSTRATION;
  const i = way.findIndex(p => cheb(p, to.w.cell) === 2);
  const p = way[i];
  if (!p || (i - 2) * (m.w.cellMs || m.st.walkSpeed) < B.castTime(sk, lv, c.pc) + BOMB_MARGIN) return null;
  if (cheb(p, c.w.cell) > B.skillRange(sk, lv, attacker(c)) || !field.sees(c.w.cell, p) || !field.open(p[0], p[1]) || onLP(p[0], p[1])) return null;
  if (W.bombs.some(n => cheb([n.x, n.y], p) <= 1) || units().some(u => alive(u) && inFight(u) && cheb(u.w.cell, p) <= 1)) return null;
  return p;
}
// 佈陷阱 (by request: layTraps): with no monster about, character c goes round the party once, here and there, laying
// TOUR_N to TOUR_N + 1 traps on the way: cells TOUR_NEAR to TOUR_FAR off the leader at random, spread round it (one
// each way, a little off), gone round in order. Each its kind in TOUR_KINDS (Ankle Snare and Flasher first, by
// request), else the first after it c can use (Blast Mine, gone in seconds, not among them). A new round once fewer
// than TOUR_MIN of c's traps are left on the floor, with TOUR_SPARE Booby Traps in the bag at least; one left behind
// (the leader moved on) or taking too long (TOUR_MS: a cell it cannot get to) is given up.
const TOUR_N = 4, TOUR_NEAR = 3, TOUR_FAR = 7, TOUR_MIN = 2, TOUR_SPARE = 10, TOUR_MS = 30000;
const TOUR_KINDS = ['HT_ANKLESNARE', 'HT_FLASHER', 'HT_ANKLESNARE', 'HT_FLASHER', 'HT_CLAYMORETRAP', 'HT_FREEZINGTRAP', 'HT_SANDMAN', 'HT_LANDMINE', 'HT_SKIDTRAP'];
function trapTour(c, ctx) {
  const lead = crewOf(c).find(x => x.dead == null && x.pc) || c, at = walkEnd(lead);
  // (round the leader where it was: c leading, round where c set off)
  if (c.tour && ((lead !== c && cheb(c.tour.at, at) > 3) || ctx.t - c.tour.since > TOUR_MS)) c.tour = null;
  if (!c.tour || !c.tour.cells.length) {
    c.tour = null;
    if ((purse(c).bag[BOOBY_TRAP] || 0) < TOUR_SPARE || W.traps.filter(n => n.by === c && TRAP_SKILLS.has(n.sk.name)).length >= TOUR_MIN) return null;
    if (!TOUR_KINDS.some(k => knows(c, k))) return null;
    const n = TOUR_N + rnd(2), a0 = rnd(360), cells = [];
    for (let i = 0; i < n; i++) {
      const a = (a0 + i * 360 / n + rnd(41) - 20) * Math.PI / 180, d = TOUR_NEAR + rnd(TOUR_FAR - TOUR_NEAR + 1);
      const p = [at[0] + Math.round(d * Math.cos(a)), at[1] + Math.round(d * Math.sin(a))];
      if (field.open(p[0], p[1])) cells.push(p);
    }
    if (!cells.length) return null;
    c.tour = { at: [...at], since: ctx.t, cells, i: 0 };
  }
  while (c.tour.cells.length && !trapCellOk(c.tour.cells[0])) { c.tour.cells.shift(); c.tour.i++; }
  const p = c.tour.cells[0];
  if (!p) return null;
  const k = TOUR_KINDS.slice(Math.min(c.tour.i, 4)).find(k => canUse(c, k, ctx.t));
  if (!k) return null;
  return { ground: k, at: p };
}
// The ensembles 自動 picks among at random (by request), and the lines that fight with magic (施法系)

// (by request: an acolyte's and a priest's line neither, as a bard's and a dancer's)
const CASTER_LINES = ['mage', 'wizard', 'sage'], NOT_PHYSICAL = ['mage', 'wizard', 'sage', 'priest', 'acolyte', 'bard'];
// one of the party fighting with its weapon: not a caster's line (nor a priest's), but a sage on its 近戰 preset
const SPELL_LINES = ['mage', 'wizard', 'sage', 'priest', 'acolyte'];
const weaponFighter = x => !!x.isPc && (!SPELL_LINES.includes(lineOf(x)) || x.tactic === 'job:melee');
// the sage's endows and element fields, and their elements; the monsters' own buffs Dispell takes off
const ENDOW_ELE = { SA_FLAMELAUNCHER: 'Fire', SA_FROSTWEAPON: 'Water', SA_LIGHTNINGLOADER: 'Wind', SA_SEISMICWEAPON: 'Earth' };
const FIELD_ELE = { SA_VOLCANO: 'Fire', SA_DELUGE: 'Water', SA_VIOLENTGALE: 'Wind' };
const MOB_OWN_BUFFS = ['NPC_AGIUP', 'NPC_KEEPING', 'KN_TWOHANDQUICKEN', 'BS_ADRENALINE'];
// the % of element e on the monsters `ms`, on average
const eleOn = (e, ms) => ms.reduce((n, m) => { const st = statusOf(m); return n + B.attrRatio(db, e, st.element, st.elementLv); }, 0) / ms.length;
// of skills `table` (skill → element) character c knows, the one whose element hurts monster(s) m most, more than neutral
function bestOf(c, table, m) {
  const ms = Array.isArray(m) ? m : [m];
  if (!ms.length) return null;
  let best = null, top = eleOn('Neutral', ms);
  for (const [n, e] of Object.entries(table)) if (knows(c, n) && eleOn(e, ms) > top) { best = n; top = eleOn(e, ms); }
  return best;
}
// the element field for the monsters in character c's fight (fieldBest)
function bestField(c) {
  const ms = livingFoes(c);
  if (!ms.length) return null;
  return bestOf(c, FIELD_ELE, ms) || (knows(c, 'SA_VOLCANO') && eleOn('Fire', ms) >= eleOn('Neutral', ms) ? 'SA_VOLCANO' : null);
}
// where character c's element field `name` does the most (the fieldSpot selector): the cell, of the party in the fight's
// (and its own), with the most of them within its 7×7; none while its own field of the same is on as many already
const FIGHTING = x => x.dead == null && !!x.target && alive(x.target);
function fieldSpot(c, name) {
  const who = party(c).filter(x => x === c || FIGHTING(x));
  if (!who.some(FIGHTING) && !livingFoes(c).some(m => m.target && m.target.side === c.side)) return null;
  const r = fieldReach(name, 1), covers = cell => who.filter(x => cheb(x.w.cell, cell) <= r).length;
  let best = null, n = 0;
  for (const x of who) { const k = covers(x.w.cell); if (k > n || (k === n && best && cheb(c.w.cell, x.w.cell) < cheb(c.w.cell, best))) { best = [...x.w.cell]; n = k; } }
  const own = W.fields.find(f => f.by === c && FIELDS.includes(f.sk.name) && W.t < f.until);
  if (own && own.sk.name === name && who.filter(x => onField(own, x)).length >= n) return null;
  return best;
}
// the spell 自動 picks for Hindsight (at Lv lv) against monsters ms (by request: by their weakness, as a wave comes in):
// of those it may, the one that deals them the most in all at the level it goes off at (B.skillAttack: its element
// against theirs, MDEF and all), the later in its list as much; with none, the last
function bestAutoSpell(c, ms, lv = c.levels.SA_AUTOSPELL || 0) {
  const can = autoSpells(c, lv);
  if (!can.length || !ms.length) return can[can.length - 1] || null;
  const src = offense(c), of = n => ms.reduce((d, m) => d + B.skillAttack(db, src, defense(m), db.skills[n], autoSpellLv(c, n, lv), x => x >> 1).damage, 0);
  return can.reduce((a, b) => of(b) >= of(a) ? b : a);
}
// Hindsight to cast (again): not on; or on, a wave in since it was cast, and the spell for the monsters now another
// (by request: not every so often, only with a new lot of them)
function hindsightDue(c) {
  const s = c.sc.find(x => x.name === 'SA_AUTOSPELL' && W.t < x.until);
  return !s || (W.mobsAt > (s.wave ?? 0) && bestAutoSpell(c, livingFoes(c)) !== s.spell);
}
// A sage's 近戰 (by request: by the target's DEF and MDEF): its normal attacks deal monster m as much a second as its
// best bolt would, that over SPELL_OVER times (by choice: a bolt's SP, and the swings it would cost, for no more than that) (B.attack and B.skillAttack, each over a few draws of its own, not the fight's: cast time and skill
// delay against the attack delay)
// of the area spells character c may use now, the one dealing the most a second (cast and skill delay) to the monsters
// it would hit with monster m at the centre (its area, those it hurts: crowdAt's), by their element and MDEF
function bestArea(c, m, t) {
  const src = offense(c);
  let best = null, top = 0;
  for (const n of AREA_SPELLS) {
    if (!canUse(c, n, t)) continue;
    const sk = db.skills[n], lv = c.levels[n], ctx = { name: n, lv }, area = reachOf(ctx);
    const dmg = livingFoes(c).filter(f => field.distance(f.w, m.w) <= area).reduce((d, f) => d + B.skillAttack(db, src, defense(f), sk, lv, x => x >> 1).damage, 0);
    const rate = dmg / (B.castTime(sk, lv, c.pc) + B.skillDelay(sk, lv, c.pc));
    if (rate > top) { best = n; top = rate; }
  }
  return best;
}
const SPELL_OVER = 1.5;
const ownRnd = seed => { let x = seed; return n => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; }; };
function weaponPays(c, m, t) {
  const src = offense(c), dst = defense(m), N = 12, r = ownRnd(7);
  let hit = 0;
  for (let i = 0; i < N; i++) hit += B.attack(db, src, dst, r).damage;
  const b = bestBolt(c, m, t);
  if (!b) return true;
  const sk = db.skills[b.name], spell = B.skillAttack(db, src, dst, sk, b.lv, n => n >> 1).damage;
  return hit / N / Math.max(c.pc.adelay, 1) * SPELL_OVER >= spell / (B.castTime(sk, b.lv, c.pc) + B.skillDelay(sk, b.lv, c.pc));
}
const physicalAlly = (c, x) => x !== c && !!x.isPc && x.dead == null && !NOT_PHYSICAL.includes(lineOf(x));
const casterAlly = (c, x) => x !== c && !!x.isPc && x.dead == null && CASTER_LINES.includes(lineOf(x));
// the ones of the party a song of character c's is for (by request): Assassin Cross and Fortune's Kiss its fighters with
// weapons, Poem of Bragi and Service for You its casters, the rest of its party for the others; one on the
// monsters, them
const PHYSICAL_SONGS = new Set(['BA_ASSASSINCROSS', 'DC_FORTUNEKISS']), CASTER_SONGS = new Set(['BA_POEMBRAGI', 'DC_SERVICEFORYOU']);
const songFor = (c, name) => ENEMY_SONGS.has(name) ? livingFoes(c) : friends(c).filter(x =>
  PHYSICAL_SONGS.has(name) ? physicalAlly(c, x) : CASTER_SONGS.has(name) ? casterAlly(c, x) : true);
// (by request: Drum on the Battlefield only with one of the party fighting in melee, a weapon of 3 cells' reach at most;
// Eternal Chaos, which takes only the monsters' soft DEF, only with one of the party fighting with a weapon, at any reach)
const ensembleWanted = (c, name) => name === 'BD_DRUMBATTLEFIELD' ? friends(c).some(x => physicalAlly(c, x) && x.pc.range <= 3)
  : name === 'BD_ETERNALCHAOS' ? friends(c).some(x => physicalAlly(c, x)) : true;
const isEnsemblePick = d => Array.isArray(d) && d.length > 0 && d.every(n => ENSEMBLES.has(n));
// unit u plays an ensemble now (with whoever)
const inEnsemble = u => W.songs.some(n => n.with && (n.by === u || n.with === u));
// one of character c's party who could play one of ensembles `names` with it, wherever it stands: the other sex,
// that one learned by both, an instrument or a whip in hand, free to (not sitting, held, nor in an ensemble already)
const ensembleMate = (c, names) => crewOf(c).find(x => x !== c && x.dead == null && x.pc && x.look.sex !== c.look.sex
  && names.some(n => knows(c, n) && knows(x, n)) && ['Musical', 'Whip'].includes(x.pc.weapon) && !x.sitting && !x.frozen
  && !x.stunned && !x.asleep && !x.stone && !x.stopped && !x.snared && !inEnsemble(x));
// 自動's pick of ensemble from `names` (by request, at random among those it and a partner have, with the SP for it),
// kept ENSEMBLE_PICK_MS so that it walks to that one's spot
const ENSEMBLE_PICK_MS = 10000;
function ensemblePick(c, names, t) {
  const mate = ensembleMate(c, names);
  if (!mate) return null;
  anyPartner = true;
  const ok = names.filter(n => knows(mate, n) && ensembleWanted(c, n) && canUse(c, n, t));
  anyPartner = false;
  if (c.ensPick && ok.includes(c.ensPick.name) && t - c.ensPick.at < ENSEMBLE_PICK_MS) return c.ensPick.name;
  if (!ok.length) return null;
  c.ensPick = { name: ok[rnd(ok.length)], at: t };
  return c.ensPick.name;
}
// Where a song of character c's does the most (by request: 自動 walks there to play it, and goes on walking there as it
// plays a song alone; an ensemble's two cannot walk once it starts): of the cells within SONG_SPOT cells, the one the
// song's area (around its player) takes in the most of, of the ones it is for (songFor); as many, the more of those it was
// playing for (c.songCover).
// Null when where it stands is as good (or none is in reach of any), so it plays there. An ensemble's: a cell within
// ENSEMBLE_RANGE − 1 of its partner (a cell to spare, as that one may walk), none of them near it: the one nearest it.
function songSpot(c, name, lv, mate = null) {
  if (c.w.rooted) return null;
  // (playing it: only the ones whose status from it runs out within SONG_REFRESH, by request: it stays on them Duration2
  // after they leave, so it need not walk after one who walks off)
  const n = W.songs.find(x => x.by === c && x.sk.name === name), fresh = x => !!n && !SONG_EVERY[name] && x.sc.some(s => s.from === n && s.until - W.t > SONG_REFRESH);
  const area = areaOf(db.skills[name], lv), on = songFor(c, name).filter(x => !fresh(x));
  // (as many either way, the ones it has been playing for count first: by request, not off to another of them and back)
  const prev = c.songCover && c.songCover.name === name ? c.songCover.ids : null, ids = p => on.filter(x => cheb(x.w.cell, p) <= area);
  const score = p => { const n = ids(p); return n.length * 100 + (prev ? n.filter(i => prev.has(i)).length : 0); };
  const near = p => !mate || cheb(p, mate.w.cell) <= ENSEMBLE_RANGE - 1;
  const here = c.w.cell, end = walkEnd(c), busy = claimed(c);
  let best = null, bs = -1, bd = Infinity;
  for (let y = here[1] - SONG_SPOT; y <= here[1] + SONG_SPOT; y++) for (let x = here[0] - SONG_SPOT; x <= here[0] + SONG_SPOT; x++) {
    const p = [x, y], mine = sameCell(p, here) || sameCell(p, end);
    // (a cell another stands on or walks to is not its own either, by request: with two of them after the one cell that
    // takes in both of the party, the second went there and was moved off, again and again)
    if (!near(p) || (!mine && !field.open(x, y)) || busy.has(x + ',' + y)) continue;
    // (ties: where it is, then where it walks to, then the nearest)
    const sc = score(p), d = sameCell(p, here) ? -2 : sameCell(p, end) ? -1 : cheb(p, here);
    if (sc > bs || (sc === bs && d < bd)) { best = p; bs = sc; bd = d; }
  }
  if (!best) {
    if (!mate) return null;
    const way = between(here, mate.w.cell);  // (its partner far off: toward it)
    return way.length > 1 ? way[way.length - 2] : null;
  }
  const stay = sameCell(best, here) || (bs === 0 && near(here));
  c.songCover = { name, ids: new Set(ids(stay ? here : best)) };
  return stay ? null : best;
}
// the order rule r (the i-th) gives character c now, or null
function follow(c, r, i, ctx) {
  // (one of the ensembles, by request at random: ensemblePick)
  if (isEnsemblePick(r.do)) { const n = ensemblePick(c, r.do, ctx.t); return n && follow(c, { ...r, do: n }, i, ctx); }
  const name = skillOf(r), sk = name && db.skills[name];
  ctx.name = name; ctx.lv = name ? c.levels[name] || 1 : 1;
  if (name === 'AM_CANNIBALIZE' && knows(c, name)) ctx.lv = plantLevel(c);
  const group = Array.isArray(r.do);
  anyPartner = ENSEMBLES.has(name);
  const can = group ? r.do.some(n => knows(c, n)) : !sk || (LEVEL_PICKED.has(name) ? knows(c, name) && ctx.t >= (c.cooldown[name] || 0) : canUse(c, name, ctx.t));
  anyPartner = false;
  if (!can) return null;
  if (sk && sk.target === 'Self' && !fitsSelf(c, name, ctx)) return null;
  // (sat down by this rule, it sits on until its SP is full, whatever the character's own state says)
  const sat = r.do === 'sit' && c.sitting && c.aiSat && c.rule === i && c.sp < c.pc.maxSp;
  for (const x of r.if || []) {
    if (x.who === 'target' || (sat && x.who === 'self')) continue;
    if (x.who === 'self') { if (!holds(c, c, ctx, x.is)) return null; continue; }
    const n = (x.who === 'foe' ? livingFoes(c) : party(c)).filter(u => holds(c, u, ctx, x.is)).length;
    if (x.n === 'none' ? n > 0 : n < (x.n === 'any' || x.n == null ? 1 : x.n)) return null;
  }
  if (r.do === 'sit') return { sit: true };
  if (isDrink(r.do)) { const id = ctx.t >= (c.itemAt || 0) ? DRINKS[r.do](c) : null; return id == null ? null : { potion: id }; }
  if (r.do === 'wait') return { hold: true };
  if (r.do === 'layTraps') return trapTour(c, ctx);
  // a weapon taken up (換弓, 換短劍) or its own again (換回樂器／鞭子, 換回自己的武器): none when it holds that already
  // (by request, a bow rogue's: the bow may be its own, the dagger the one taken up)
  if (SWAPS[r.do] !== undefined) {
    const own = c.bowHeld ? c.bowHeld.weapon : c.look.weapon, want = SWAPS[r.do] || own;
    if (c.look.weapon === want) return null;
    // (by request one round of Divests a dagger: on the one monster its 怪物 clause finds first, the nearest: divestOn)
    let on;
    if (r.do === 'dagger') {
      const is = (r.if || []).filter(x => x.who === 'foe').flatMap(x => x.is);
      on = livingFoes(c).filter(x => holds(c, x, ctx, is)).sort((a, b) => field.distance(c.w, a.w) - field.distance(c.w, b.w))[0];
      if (!on) return null;
    }
    return { swap: want !== own, weapon: want, on };
  }
  // a song: walked to where it does the most first (songSpot), an ensemble's partner in reach; the one played last
  // again by Encore (by request: for half its SP)
  if (sk && isSong(name)) {
    const mate = ENSEMBLES.has(name) ? ensembleMate(c, [name]) : null;
    if (ENSEMBLES.has(name) && !mate) return null;
    const p = songSpot(c, name, ctx.lv, mate);
    if (p) return { walk: p, why: 'song' };
    if (ENSEMBLES.has(name) && !ensemblePartner(c, name)) return null;
    if (c.dance && c.dance.name === name && canUse(c, 'BD_ENCORE', ctx.t)) return { skill: 'BD_ENCORE', on: c };
  }
  // (Hindsight: the spell for the one it attacks, bestAutoSpell)
  if (name === 'SA_AUTOSPELL') c.autospellPick = bestAutoSpell(c, livingFoes(c)) || c.autospellPick;
  if (sk && sk.target === 'Self') return { skill: name, on: c };
  // (the dodge rule, by request: the caster attacked instead, when that cuts its cast off sooner than walking out)
  if (r.do === 'move' && r.target?.some(s => s.k === 'dodge')) { const by = breakCaster(c, ctx.t, castZones(c, true)); if (by) return { attack: by }; }
  const x = pick(c, r, ctx);
  if (!x) return null;
  if (r.do === 'move' && r.target.some(s => s.k === 'lure')) return sameCell(x, c.w.cell) && !c.w.moving ? { hold: true } : { walk: x, why: 'lure' };
  if (r.do === 'move') return { walk: x, why: r.target.some(s => s.k === 'safe') ? 'back' : 'rest' };
  if (r.do === 'pickup') return { pickup: x };
  if (r.do === 'attack') return { attack: x };
  if (group) {
    const b = bestBolt(c, x, ctx.t, timeToCast(c, ctx.t), r.do);
    return b && { skill: b.name, on: x, aside: true, lv: b.lv };
  }
  if (sk.target === 'Ground') {
    // (a hunter's trap with no `at`: on the monster's way, wayCell; never on its cell, where it fails)
    const at = Array.isArray(x) ? x : r.at ? aheadOf(c, x, r.at) : TRAP_SKILLS.has(name) ? wayCell(c, x, name, ctx.lv)
      : name === 'AM_DEMONSTRATION' ? bombCell(c, x, ctx.lv) : name === 'AM_CANNIBALIZE' ? plantCell(c, x, ctx.lv || 1) : [...x.w.cell];
    if (!at) return null;
    if (name === 'AL_PNEUMA' && (W.pneumas.some(n => cheb([n.x, n.y], at) <= 2) || W.guards.some(g => cheb([g.x, g.y], at) <= 1))) return null;
    if (name === 'MG_SAFETYWALL' && (W.guards.some(g => sameCell([g.x, g.y], at)) || W.pneumas.some(n => cheb([n.x, n.y], at) <= 1))) return null;
    if (TRAP_SKILLS.has(name) && !trapCellOk(at)) return null;
    if (name === 'AS_VENOMDUST' && W.dusts.some(n => n.by === c && cheb([n.x, n.y], at) <= 1)) return null;  // (not over its own)
    return { ground: name, at, lv: ctx.lv };
  }
  // (playing, a weapon skill too: it cannot attack after it, nor walk after the monster)
  const aside = x.side === c.side ? x !== c : !!(B.SKILLS[name]?.magic || sk.target === 'Support' || SKILL_USE[name]?.aside || has(c, 'BD_PERFORMING'));
  const lv = name === 'AL_HEAL' && x.side === c.side ? healLevel(c, x) : name === 'AM_POTIONPITCHER' ? potionLevel(c, x) : null;
  if (lv === undefined) return null;  // (no level of Heal the SP left covers; no potion in the bag for Aid Potion)
  return { skill: name, on: x, aside, lv };
}

// --- the jobs' rules ---
const T = (k, v) => v == null ? { k } : { k, v };
const C = (k, v, not) => ({ k, ...v != null ? { v } : {}, ...not ? { not: true } : {} });
const ON = (...is) => ({ who: 'target', is });
const SELF = (...is) => ({ who: 'self', is });
const FOES = (n, ...is) => ({ who: 'foe', n, is });
const ALLIES = (n, ...is) => ({ who: 'ally', n, is });
// everyone, last: with no monster left, pick up the loot on the ground (by request), then gather (restSpot) and
// sit down while HP or SP is not full (regen twice as fast), standing up once both are
const REST = [
  { do: 'pickup', target: [T('loot')], if: [FOES('none')] },
  { do: 'move', target: [T('rest')], if: [FOES('none')] },
  { do: 'sit', if: [FOES('none'), SELF(C('notFull'))] },
];
// (by request: below 75%, at the level that makes up what is missing: healLevel)
const HEAL = { do: 'AL_HEAL', target: [T('weakAlly')], if: [ON(C('hpBelow', 75))] };
// everyone, first (by request): a potion from the party's bag below POTION_HP % of its HP
const POTION_HP = 60;
const POTION = { do: 'potion', if: [SELF(C('hpBelow', POTION_HP))] };
// and a Blue Potion below SP_POTION_SP % of its SP in a fight (by choice: sitting is for after it); one who fights
// with its weapon an attack speed potion once the fight is on (not a mage nor an acolyte, whose skills it does not
// speed up). With none in the bag they do nothing.
const SP_POTION_SP = 20;
const DRINK = [POTION, { do: 'spPotion', if: [FOES('any'), SELF(C('spBelow', SP_POTION_SP))] }];
const SPEED = { do: 'speedPotion', if: [FOES('any')] };
const ATTACK = { do: 'attack', target: ATTACK_TARGET };
const COMMON = [...DRINK, SPEED, HEAL, ATTACK, ...REST];
// a character that joins the party: it attacks the nearest monster (and keeps to the one it has) and rests
// (by request, every preset's: right after drinking) a melee monster after it led into the party's areas (lureSpot)
const LURE = { do: 'move', target: [T('lure')] };
// (by request, every preset's and the basic one's: right after drinking, before the lure) out of an area the other
// side is casting on the ground (dodgeSpot)
const DODGE = { do: 'move', target: [T('dodge')] };
const BASIC = [...DRINK, DODGE, LURE, SPEED, { do: 'attack', target: [T('current'), T('near')] }, ...REST];
// a swordsman keeps SP for a Provoke (SPARE: % of its SP)
const SPARE = 10;
// an archer kites: it backs off and shoots the monsters coming for it first. (Arrow Repel's cast is not cut off by
// damage: it goes off while the monster hits; by request (issue 10) only on one alone on it, none other getting a hit
// in before the cast ends: castClear. Mobbed, it backs off, or shoots, at once.) A monster a wall would stop short
// is walked away from instead, into the open.
const ARCHER_FIGHT = [
  { do: 'AC_CHARGEARROW', target: [T('onMe')], if: [ON(C('within', 1), C('pushable', 4), C('castClear'))] },
  { do: 'move', target: [T('safe', [2, 7])], if: [SELF(C('ranged'))] },
  { do: 'AC_CONCENTRATION', if: [FOES('any')] },
  { do: 'AC_SHOWER', target: [T('crowd')], if: [ON(C('crowd', 3))] },
  { do: 'AC_DOUBLE', target: [T('focus')] },
  { do: 'attack', target: [T('onMe'), T('current'), T('party'), T('near')] },
];
// a sage's endows (by the weakness of the one fought: endowBest), on `who` (nearAlly: the party's, itself among them)
// (by request: as it casts, it backs off from the ones coming at it, 3 cells, to 5 off; Free Cast's walk: castKite)
const SAGE_KITE = { do: 'move', target: [T('safe', [3, 5])], if: [SELF(C('freeCasting'))] };
// a sage's spells on a crowd, first (by request): of Heaven's Drive, Thunderstorm and Fire Ball, the one that deals the
// most a second to the ones round it (by their element: bestArea), on 3 at least
const AREA_SPELLS = ['WZ_HEAVENDRIVE', 'MG_THUNDERSTORM', 'MG_FIREBALL'];
const SAGE_AREA = (...self) => AREA_SPELLS.map(n => ({ do: n, target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3), C('bestArea', n)), SELF(C('castSafe'), ...self)] }));
const SAGE_ENDOWS = who => ['SA_FLAMELAUNCHER', 'SA_FROSTWEAPON', 'SA_LIGHTNINGLOADER', 'SA_SEISMICWEAPON']
  .map(n => ({ do: n, target: [T(who)], if: [ON(C('endowBest', n), C('inRange'))] }));
const RULES = {
  // a monk (by request: one set for the combo, Asura Strike and tank builds, what it has not learned passed over) follows
  // Raging Trifecta Blow up with the rest of the chain the moment it can (each fails outside its combo, so the rule is
  // passed over: skillFail), then: Mental Strength (the tank's) once the fight is on (by request), and Snap
  // to the one at a fragile one of the party a walk off; Asura Strike on the one it attacks, in reach, with HP for half
  // of what it would deal at least (not wasted on one nearly down), the cast not cut short, SP 50 % (it deals more the
  // more SP); Fury in a fight with SP 75 % (not the tank, whose 5 spheres are for Mental Strength), and the spheres
  // summoned again for Asura Strike (5, SP 50 %) or Mental Strength (5), else only with none left (Raging Thrust wants
  // one), when the cast will not be cut short; Throw Spirit Sphere at a ranged one out of reach; Occult Impaction on the
  // one it attacks with a sphere to spare for Raging Thrust (not the Asura Strike nor the tank build, whose spheres it
  // would take); as many spheres as it can between fights. Left out Absorb Spirit Sphere, Root and the quest skills.
  monk: [
    ...DRINK,
    { do: 'MO_COMBOFINISH' },
    { do: 'MO_CHAINCOMBO' },
    SPEED,
    // (no Heal, by request: on no one)
    { do: 'MO_STEELBODY', if: [FOES('any')] },
    { do: 'MO_BODYRELOCATION', target: [T('onFragile')], if: [ON(C('walkOver', 3), C('inRange')), SELF(C('spAfter', 30))] },
    { do: 'MO_EXTREMITYFIST', target: [T('focus')], if: [ON(C('inRange'), C('hpVsSkill', 50)), SELF(C('castSafe'), C('spAtLeast', 50))] },
    { do: 'MO_EXPLOSIONSPIRITS', if: [FOES('any'), SELF(C('spAtLeast', 75), C('usable', 'MO_STEELBODY', true))] },
    { do: 'MO_CALLSPIRITS', if: [FOES('any'), SELF(C('usable', 'MO_EXTREMITYFIST'), C('spheresBelow', 5), C('spAtLeast', 50), C('castSafe'))] },
    { do: 'MO_CALLSPIRITS', if: [FOES('any'), SELF(C('usable', 'MO_STEELBODY'), C('spheresBelow', 5), C('castSafe'), C('spAfter', SPARE))] },
    { do: 'MO_CALLSPIRITS', if: [FOES('any'), SELF(C('spheresBelow', 1), C('castSafe'), C('spAfter', SPARE))] },
    { do: 'MO_FINGEROFFENSIVE', target: [T('lowDefRanged')], if: [ON(C('walkOver', 2), C('inRange')), SELF(C('spAfter', 30))] },
    { do: 'MO_INVESTIGATE', target: [T('focus')], if: [ON(C('hpAbove', 50)), SELF(C('spheresBelow', 2, true), C('usable', 'MO_EXTREMITYFIST', true), C('usable', 'MO_STEELBODY', true), C('spAfter', 30))] },
    ATTACK,
    { do: 'MO_CALLSPIRITS', if: [FOES('none')] },
    ...REST,
  ],
  // a merchant fights as a swordsman does, with its own skills in Magnum Break's and Bash's places
  merchant: [
    ...DRINK,
    SPEED,
    { do: 'MC_LOUD', if: [FOES('any')] },
    // Cart Revolution hits the 3×3 round the one it is used on: on the one in reach with the most monsters there
    { do: 'MC_CARTREVOLUTION', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 2))] },
    { do: 'MC_MAMMONITE', target: [T('focus')], if: [ON(C('hpAbove', 50))] },
    ATTACK,
    ...REST,
  ],
  // a blacksmith (by request) fights as a merchant does, with its own skills on top: once the fight is on, Crazy Uproar,
  // Adrenaline Rush, Power Thrust and Weapon Perfection, each again when one of the party in reach that would take it
  // (its weapon) is without it, then Maximize Power (off again with no monster left: no SP comes back meanwhile);
  // Hammer Fall (no damage) to stun a crowd of 3 in reach (crowdAt: the ones it can stun, not stunned yet); Cart Revolution, Mammonite. Left out its making
  // skills, Weapon Repair and Greed.
  blacksmith: [
    ...DRINK,
    SPEED,
    { do: 'MC_LOUD', if: [FOES('any')] },
    { do: 'BS_ADRENALINE', if: [FOES('any'), SELF(C('spAfter', SPARE))] },
    { do: 'BS_OVERTHRUST', if: [FOES('any'), SELF(C('spAfter', SPARE))] },
    { do: 'BS_WEAPONPERFECT', if: [FOES('any'), SELF(C('spAfter', SPARE))] },
    { do: 'BS_MAXIMIZE', if: [FOES('any'), SELF(C('spAfter', 30))] },
    { do: 'BS_MAXIMIZE', if: [FOES('none')] },
    { do: 'BS_HAMMERFALL', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3)), SELF(C('spAfter', SPARE))] },
    { do: 'MC_CARTREVOLUTION', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 2))] },
    { do: 'MC_MAMMONITE', target: [T('focus')], if: [ON(C('hpAbove', 50))] },
    ATTACK,
    ...REST,
  ],
  // an alchemist (by request) fights as a merchant does, with its own skills on top: its homunculus called out
  // whenever none is (in a fight or not: an Embryo the first time, a Seed of Life after), brought back when it is down
  // and the cast will not be cut short; Aid Potion to the one of the party lowest on HP, below 50 %, the potion that
  // makes up what it is missing (potionLevel); Sphere Mine (by request) on the cell next to it toward a monster coming
  // at it, the cast over before it gets there: a monster takes the sphere in its way for its target (the nearest enemy,
  // ChangeChase) and, hit, the sphere goes for it and blows up (3 at most: summonFail); Bio Cannibalize on the cell of
  // the one it attacks, in reach (as many plants as its level lets), at a level picked at random (by request: plantLevel),
  // the cast not cut short (the same for Demonstration);
  // Demonstration (by request) on the way of a close-range monster coming at one of its side, 2 cells short of that
  // one, so the monster attacks from in the fire (bombCell); Acid Terror on the one it attacks, HP above 50 %.
  // Left out Rest, the Chemical Protections and its making skills.
  alchemist: [
    ...DRINK,
    { do: 'AM_CALLHOMUN' },
    { do: 'AM_RESURRECTHOMUN', if: [SELF(C('castSafe'))] },
    SPEED,
    { do: 'MC_LOUD', if: [FOES('any')] },
    { do: 'AM_POTIONPITCHER', target: [T('weakAlly')], if: [ON(C('hpBelow', 50), C('inRange'))] },
    { do: 'AM_SPHEREMINE', target: [T('onMe')], at: 1, if: [ON(C('chasing')), SELF(C('castSafe'), C('spAfter', SPARE))] },
    { do: 'AM_CANNIBALIZE', target: [T('focus')], if: [ON(C('inRange')), SELF(C('castSafe'), C('spAfter', SPARE))] },
    { do: 'AM_DEMONSTRATION', target: [T('onAlly'), T('onMe')], if: [ON(C('chasing')), SELF(C('castSafe'), C('spAfter', SPARE))] },
    { do: 'AM_ACIDTERROR', target: [T('focus')], if: [ON(C('hpAbove', 10)), SELF(C('spAfter', SPARE))] },
    { do: 'MC_CARTREVOLUTION', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 2))] },
    { do: 'MC_MAMMONITE', target: [T('focus')], if: [ON(C('hpAbove', 50))] },
    ATTACK,
    ...REST,
  ],
  swordman: [
    ...DRINK,
    SPEED,
    // Provoke turns the monster on the user; one a walk of PROVOKE_WALK cells or less off it just goes and
    // fights (the attack rule has those first)
    { do: 'SM_PROVOKE', target: [T('onFragile')], if: [ON(C('walkOver', 3))] },
    { do: 'SM_ENDURE', if: [SELF(C('stopped', 2), C('spAfter', SPARE))] },
    { do: 'SM_MAGNUM', if: [FOES(2, C('inArea')), SELF(C('spAfter', SPARE))] },
    { do: 'SM_BASH', target: [T('focus')], if: [ON(C('hpAbove', 50)), SELF(C('spAfter', SPARE))] },
    { do: 'attack', target: [T('onFragile'), T('current'), T('party'), T('near')] },
    ...REST,
  ],
  // a knight (by request) fights as a swordsman does, with its own skills on top; what its weapon or mount does not
  // allow is passed over (skillFail: Two-Hand Quicken a two-handed sword, the spear skills a spear, Brandish Spear
  // riding), so one set does for the two-handed sword's builds and the spear's. Spear Stab is left out: it knocks
  // the monster 6 cells off, out of the knight's reach.
  knight: [
    ...DRINK,
    SPEED,
    { do: 'SM_PROVOKE', target: [T('onFragile')], if: [ON(C('walkOver', 3))] },
    // Two-Hand Quicken once the fight is on (and again as it runs out)
    { do: 'KN_TWOHANDQUICKEN', if: [FOES('any')] },
    { do: 'SM_ENDURE', if: [SELF(C('stopped', 2), C('spAfter', SPARE))] },
    // Counter Attack when a boss is at it in melee: its next swing is blocked and struck back at, critical
    { do: 'KN_AUTOCOUNTER', if: [FOES('any', C('boss'), C('onMe'), C('ranged', null, true), C('within', 2))] },
    // Charge Attack (its quest's) to the monster it is going for, far off; Spear Boomerang at a ranged one out of reach
    { do: 'KN_CHARGEATK', target: [T('focus')], if: [ON(C('walkOver', 3), C('inRange')), SELF(C('spAfter', 30))] },
    { do: 'KN_SPEARBOOMERANG', target: [T('lowDefRanged')], if: [ON(C('walkOver', 2), C('inRange')), SELF(C('spAfter', SPARE))] },
    // a crowd: Brandish Spear (the ones in front, the target's way), Bowling Bash (round the one it hits), Magnum Break
    { do: 'KN_BRANDISHSPEAR', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 2)), SELF(C('spAfter', SPARE))] },
    { do: 'KN_BOWLINGBASH', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 2)), SELF(C('spAfter', SPARE))] },
    { do: 'SM_MAGNUM', if: [FOES(2, C('inArea')), SELF(C('spAfter', SPARE))] },
    // one: Pierce on a medium or large one (2 or 3 hits), else Bowling Bash, else Bash
    { do: 'KN_PIERCE', target: [T('focus')], if: [ON(C('hpAbove', 50), C('small', null, true)), SELF(C('spAfter', SPARE))] },
    { do: 'KN_BOWLINGBASH', target: [T('focus')], if: [ON(C('hpAbove', 50)), SELF(C('spAfter', SPARE))] },
    { do: 'SM_BASH', target: [T('focus')], if: [ON(C('hpAbove', 50)), SELF(C('spAfter', SPARE))] },
    { do: 'attack', target: [T('onFragile'), T('current'), T('party'), T('near')] },
    ...REST,
  ],
  // a crusader (by request) fights as a swordsman does, with its own skills on top; what it has not learned, or its
  // weapon does not allow, is passed over (skillFail: the shield skills a shield, Spear Quicken a spear), so one set
  // does for the 聖十, the 坦十 and the 矛十. Once the fight is on: Auto Guard, Reflect Shield, Spear Quicken, and
  // Defending Aura with a ranged monster at it; Sacrifice on a fragile one of the party in reach; Grand Cross with 3
  // round it (2 cells) and HP to spare (it takes 20 %); Heal on one of the party under half; Shield Boomerang at a
  // ranged one out of reach; then Holy Cross or Bash, whichever deals more (Holy Cross holy: the undead's, a
  // demon's). Left out Shield Charge, Providence and Shrink.
  crusader: [
    ...DRINK,
    SPEED,
    { do: 'SM_PROVOKE', target: [T('onFragile')], if: [ON(C('walkOver', 3))] },
    { do: 'CR_AUTOGUARD', if: [FOES('any')] },
    { do: 'CR_REFLECTSHIELD', if: [FOES('any'), SELF(C('spAfter', SPARE))] },
    { do: 'CR_SPEARQUICKEN', if: [FOES('any')] },
    { do: 'CR_DEFENDER', if: [FOES('any', C('ranged'), C('onMe')), SELF(C('spAfter', SPARE))] },
    { do: 'CR_DEVOTION', target: [T('nearAlly')], if: [FOES('any'), ON(C('fragile'), C('inRange')), SELF(C('spAfter', SPARE))] },
    { do: 'SM_ENDURE', if: [SELF(C('stopped', 2), C('spAfter', SPARE))] },
    { do: 'AL_HEAL', target: [T('weakAlly')], if: [ON(C('hpBelow', 50), C('inRange')), SELF(C('spAfter', SPARE))] },
    { do: 'CR_GRANDCROSS', if: [FOES(3, C('within', 2)), SELF(C('hpAbove', 50), C('spAfter', SPARE))] },
    { do: 'CR_SHIELDBOOMERANG', target: [T('lowDefRanged')], if: [ON(C('walkOver', 2), C('inRange')), SELF(C('spAfter', SPARE))] },
    { do: 'SM_MAGNUM', if: [FOES(2, C('inArea')), SELF(C('spAfter', SPARE))] },
    { do: ['CR_HOLYCROSS', 'SM_BASH'], target: [T('focus')], if: [ON(C('hpAbove', 50)), SELF(C('spAfter', SPARE))] },
    { do: 'attack', target: [T('onFragile'), T('current'), T('party'), T('near')] },
    ...REST,
  ],
  archer: [...DRINK, SPEED, ...ARCHER_FIGHT, ...REST],
  // a hunter (by request) kites as an archer does, with its traps and falcon on top (what it has not learned is passed
  // over, so one set does for the trap build and the falcon's). In a fight, the traps with no cast only (by request),
  // each on the way of a monster coming at someone (trapWay: it walks into it), Ankle Snare first, then Flasher (by
  // request: blinded, a monster sees a cell off, no more), then Freezing Trap or Sandman on the way of a crowd, Skid
  // Trap; then it backs off, Blitz Beat on a crowd of 2 ahead of Arrow Shower's 3. With no monster about, it goes round
  // the party laying traps (佈陷阱: trapTour). Left out Shockwave Trap (a monster has no SP), Remove Trap, Talkie Box,
  // Detecting and Spring Trap.
  hunter: [
    ...DRINK,
    SPEED,
    // (by request: Detect on an enemy in hiding or cloaked in its reach; the falcon brings out what is round it)
    { do: 'HT_DETECTING', target: [T('hiddenFoe')] },
    { do: 'HT_ANKLESNARE', target: [T('onMe'), T('onFragile'), T('onAlly')], if: [ON(C('chasing'), C('ranged', null, true), C('trapWay'))] },
    { do: 'HT_FLASHER', target: [T('onMe'), T('onFragile'), T('onAlly')], if: [ON(C('chasing'), C('trapWay'))] },
    { do: 'HT_FREEZINGTRAP', target: [T('crowd')], if: [ON(C('chasing'), C('crowd', 3), C('trapWay'))] },
    { do: 'HT_SANDMAN', target: [T('crowd')], if: [ON(C('chasing'), C('crowd', 3), C('trapWay'))] },
    { do: 'HT_SKIDTRAP', target: [T('onMe'), T('onFragile')], if: [ON(C('chasing'), C('ranged', null, true), C('trapWay'))] },
    { do: 'AC_CHARGEARROW', target: [T('onMe')], if: [ON(C('within', 1), C('pushable', 4), C('castClear'))] },
    { do: 'move', target: [T('safe', [2, 7])], if: [SELF(C('ranged'))] },
    { do: 'AC_CONCENTRATION', if: [FOES('any')] },
    { do: 'HT_BLITZBEAT', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 2)), SELF(C('castSafe'), C('spAfter', 30))] },
    { do: 'AC_SHOWER', target: [T('crowd')], if: [ON(C('crowd', 3))] },
    { do: 'AC_DOUBLE', target: [T('focus')] },
    { do: 'attack', target: [T('onMe'), T('current'), T('party'), T('near')] },
    REST[0],
    { do: 'layTraps', if: [FOES('none')] },
    ...REST.slice(1),
  ],
  // a bard and a dancer (by request; each passes over the other's skills): with no monster about it stops playing (Amp),
  // and so too a song alone once an ensemble can start. Playing, Melody Strike or Slinging Arrow on one coming at it,
  // and alone it walks to where its song does the most. An ensemble when it can (Drum on the Battlefield, Eternal
  // Chaos or Ring of Nibelungen at random), else Assassin Cross / Fortune's Kiss for the party's fighters with weapons,
  // Poem of Bragi / Service for You for its casters (a mage's, a wizard's line), the one for the more of them first; each walked to where it does the most first (songSpot), the one
  // played last by Encore. Now and then (20 s apart) Frost Joke / Scream; out of SP, it attacks.
  bard: [
    ...DRINK,
    SPEED,
    { do: 'instrument', if: [FOES('none', C('onMe')), SELF(C('bowHeld'))] },
    { do: 'BD_ADAPTATION', if: [FOES('none'), SELF(C('performing'))] },
    { do: 'BD_ADAPTATION', if: [SELF(C('performing'), C('ensembleReady'))] },
    // (by request: two monsters or more on it while it plays, Amp, Frost Joke or Scream once, then the bow, fighting
    // as an archer does until no monster is on it, and the instrument or whip again: holdBow)
    { do: 'BD_ADAPTATION', if: [FOES(2, C('onMe')), SELF(C('performing'))] },
    { do: 'BA_FROSTJOKER', if: [FOES('any', C('onMe')), SELF(C('ampMobbed', 5), C('jokedAfterAmp', null, true), C('bowHeld', null, true))] },
    { do: 'DC_SCREAM', if: [FOES('any', C('onMe')), SELF(C('ampMobbed', 5), C('jokedAfterAmp', null, true), C('bowHeld', null, true))] },
    { do: 'bow', if: [FOES('any', C('onMe')), SELF(C('ampMobbed', 10))] },
    ...ARCHER_FIGHT.map(r => ({ ...r, if: [...r.if || [], SELF(C('bowHeld'))] })),
    { do: 'BA_MUSICALSTRIKE', target: [T('onMe')], if: [ON(C('chasing'), C('inRange')), SELF(C('performing'))] },
    { do: 'DC_THROWARROW', target: [T('onMe')], if: [ON(C('chasing'), C('inRange')), SELF(C('performing'))] },
    { do: 'move', target: [T('songSpot')], if: [SELF(C('performing'))] },
    { do: ENSEMBLE_PICK, if: [FOES('any'), SELF(C('ensembleReady'))] },
    { do: 'BA_ASSASSINCROSS', if: [FOES('any'), ALLIES('any', C('physical')), SELF(C('physicalFirst'))] },
    { do: 'DC_FORTUNEKISS', if: [FOES('any'), ALLIES('any', C('physical')), SELF(C('physicalFirst'))] },
    { do: 'BA_POEMBRAGI', if: [FOES('any'), ALLIES('any', C('caster'))] },
    { do: 'DC_SERVICEFORYOU', if: [FOES('any'), ALLIES('any', C('caster'))] },
    // (the fighters' all the same, with neither song for the casters learned)
    { do: 'BA_ASSASSINCROSS', if: [FOES('any'), ALLIES('any', C('physical'))] },
    { do: 'DC_FORTUNEKISS', if: [FOES('any'), ALLIES('any', C('physical'))] },
    { do: 'BA_FROSTJOKER', if: [FOES('any'), SELF(C('sinceUsed', 20), C('spAfter', 30))] },
    { do: 'DC_SCREAM', if: [FOES('any'), SELF(C('sinceUsed', 20), C('spAfter', 30))] },
    // (not playing: it cannot attack then, and walked up to the monster for nothing)
    { do: 'attack', target: [T('onMe'), T('current'), T('party'), T('near')], if: [SELF(C('performing', null, true))] },
    ...REST,
  ],
  // a mage stands back and casts; with no skill learned yet it goes and fights with its weapon (by request)
  mage: [
    ...DRINK,
    // (by request: Sight with an enemy in hiding or cloaked within its area, 3 cells, while it is not on; on, it walks
    // to the nearest still so, to bring it out)
    { do: 'MG_SIGHT', if: [SELF(C('foeHidden', 3))] },
    { do: 'move', target: [T('hiddenNear')], if: [SELF(C('revealing'))] },
    { do: 'move', target: [T('safe', [3, 5])], if: [SELF(C('noSkill', null, true))] },
    // Fire Wall is for the ones Frost Diver cannot freeze
    { do: 'MG_FROSTDIVER', target: [T('onMe')], if: [ON(C('within', 9)), SELF(C('castSafe'))] },
    // Safety Wall under one of the party standing in melee (it blocks the hits from within 3 cells): only with a
    // Blue Gemstone in the bag (by request)
    { do: 'MG_SAFETYWALL', target: [T('nearAlly')], if: [ON(C('meleed'), C('inRange')), SELF(C('castSafe'))] },
    // across the way between them, 2 cells from the mage: as it casts, the monster comes on into it
    { do: 'MG_FIREWALL', at: 2, target: [T('onMe')], if: [ON(C('fire', null, true), C('frozen', null, true), C('within', 1, true), C('within', 9), C('wallBetween', null, true))] },
    { do: 'MG_FIREWALL', target: [T('crowd')], if: [ON(C('inRange'), C('wallNear', null, true), C('crowd', 3))] },
    { do: 'MG_THUNDERSTORM', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3)), SELF(C('castSafe'))] },
    // (a cast a monster after it would cut short is not started: only the levels over before the first hits it; by
    // request, after the one at itself, one at the party none of the rest is fighting)
    { do: BOLTS, target: [T('onMe'), T('onAllyFree'), T('onAlly'), T('near')] },
    { do: 'attack', target: ATTACK_TARGET, if: [SELF(C('noSkill'))] },
    { do: 'sit', if: [FOES('any'), SELF(C('cantAfford', 'MG_FIREBOLT'))] },
    ...REST,
  ],
  // a wizard (by request) fights as a mage does, with its own skills on top (what it has not learned is passed over,
  // so one set does for the fire build and the ice): first, one coming at it slowed (Quagmire) before it backs off;
  // then the ground's: an Ice Wall to hold one off a long cast, Quagmire, Storm Gust and Lord of Vermilion on what it
  // froze, Meteor Storm, Heaven's Drive on a crowd, before Thunderstorm; Water Ball on one; Jupitel Thunder and Earth
  // Spike are among the bolts. Left out (by request) Frost Nova and Sightrasher; and Fire Pillar (no one may stand
  // round it as it goes up, and the monster coming on is there by then).
  wizard: [
    ...DRINK,
    // (by request: Sight with an enemy in hiding or cloaked within its area, 3 cells, while it is not on; on, it walks
    // to the nearest still so, to bring it out)
    { do: 'MG_SIGHT', if: [SELF(C('foeHidden', 3))] },
    { do: 'move', target: [T('hiddenNear')], if: [SELF(C('revealing'))] },
    // Quagmire (no cast) under one coming at it or at one of the party: slowed, on the way
    { do: 'WZ_QUAGMIRE', target: [T('onMe'), T('onAlly')], if: [ON(C('chasing'), C('inRange'))] },
    { do: 'move', target: [T('safe', [3, 5])], if: [SELF(C('noSkill', null, true))] },
    // an Ice Wall 2 cells off across the way of one coming at it, when it would cut short the Storm Gust or the Lord
    // of Vermilion it has a crowd for, and walking round the wall it would not (wallSaves)
    { do: 'WZ_ICEWALL', at: 2, target: [T('onMe')], if: [ON(C('chasing'), C('ranged', null, true), C('within', 2, true), C('iceBetween', null, true), C('wallSaves', 'WZ_STORMGUST'))] },
    { do: 'WZ_ICEWALL', at: 2, target: [T('onMe')], if: [ON(C('chasing'), C('ranged', null, true), C('within', 2, true), C('iceBetween', null, true), C('wallSaves', 'WZ_VERMILION'))] },
    { do: 'MG_FROSTDIVER', target: [T('onMe')], if: [ON(C('within', 9)), SELF(C('castSafe'))] },
    { do: 'MG_SAFETYWALL', target: [T('nearAlly')], if: [ON(C('meleed'), C('inRange')), SELF(C('castSafe'))] },
    { do: 'MG_FIREWALL', at: 2, target: [T('onMe')], if: [ON(C('fire', null, true), C('frozen', null, true), C('within', 1, true), C('within', 9), C('wallBetween', null, true))] },
    { do: 'MG_FIREWALL', target: [T('crowd')], if: [ON(C('inRange'), C('wallNear', null, true), C('crowd', 3))] },
    { do: 'WZ_QUAGMIRE', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3))] },
    // Storm Gust, then Lord of Vermilion on the ones it froze (held there, and wind on the frozen: water)
    { do: 'WZ_VERMILION', target: [T('crowd')], if: [ON(C('inRange'), C('frozen'), C('crowd', 3)), SELF(C('castSafe'))] },
    { do: 'WZ_STORMGUST', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3)), SELF(C('castSafe'))] },
    { do: 'WZ_VERMILION', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3)), SELF(C('castSafe'))] },
    { do: 'WZ_METEOR', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3)), SELF(C('castSafe'))] },
    { do: 'WZ_HEAVENDRIVE', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3)), SELF(C('castSafe'))] },
    { do: 'MG_THUNDERSTORM', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3)), SELF(C('castSafe'))] },
    // Water Ball (a ball a cell round it: 25 at Lv 5) on one with half its HP left at least (not one nearly down)
    { do: 'WZ_WATERBALL', target: [T('onMe'), T('onAllyFree'), T('onAlly'), T('near')], if: [ON(C('hpAbove', 50)), SELF(C('castSafe'))] },
    { do: BOLTS, target: [T('onMe'), T('onAllyFree'), T('onAlly'), T('near')] },
    { do: 'attack', target: ATTACK_TARGET, if: [SELF(C('noSkill'))] },
    { do: 'sit', if: [FOES('any'), SELF(C('cantAfford', 'MG_FIREBOLT'))] },
    ...REST,
  ],
  // a sage (by request: two presets, 施法 and 近戰, what it has not learned passed over, so they do for both its builds).
  // 施法 fights as a mage does, with its own on top: Magic Rod with a spell coming at it, Spell Breaker on one casting,
  // Land Protector under itself with a ground skill coming, Dispell on one buffed; the element field the monsters are
  // weakest to (Volcano, its ATK, where none is more) where it covers the most of the party fighting, and the endow
  // they are weakest to on one of the party fighting with its weapon; Hindsight on in a fight (the spell for the one
  // it attacks: bestAutoSpell), Hocus-Pocus every 10 s with SP 50 % (by request); then Heaven's Drive, Thunderstorm
  // and Fire Ball on a crowd, the bolts. 近戰 has Hindsight on, its endow on itself, and goes and fights with its book
  // (the spells off its hits), the crowds' spells only on 3 at least, Hocus-Pocus as 施法's.
  sage: [
    ...DRINK,
    SAGE_KITE,
    // (by request: Sight with an enemy in hiding or cloaked within its area, 3 cells, while it is not on; on, it walks
    // to the nearest still so, to bring it out)
    { do: 'MG_SIGHT', if: [SELF(C('foeHidden', 3))] },
    { do: 'move', target: [T('hiddenNear')], if: [SELF(C('revealing'))] },
    { do: 'SA_MAGICROD', if: [FOES(1, C('spellAtMe'))] },
    { do: 'SA_SPELLBREAKER', target: [T('onMe'), T('onAlly'), T('near')], if: [ON(C('casting'), C('inRange'))] },
    { do: 'SA_LANDPROTECTOR', target: [T('self')], if: [FOES(1, C('groundCast'))] },
    { do: 'move', target: [T('safe', [3, 5])], if: [SELF(C('noSkill', null, true))] },
    { do: 'MG_FROSTDIVER', target: [T('onMe')], if: [ON(C('within', 9)), SELF(C('castSafe'))] },
    { do: 'SA_DISPELL', target: [T('party'), T('near')], if: [ON(C('buffed'), C('inRange')), SELF(C('castSafe'))] },
    ...SAGE_AREA(),
    { do: 'SA_VOLCANO', target: [T('fieldSpot')], if: [SELF(C('fieldBest', 'SA_VOLCANO'))] },
    { do: 'SA_DELUGE', target: [T('fieldSpot')], if: [SELF(C('fieldBest', 'SA_DELUGE'))] },
    { do: 'SA_VIOLENTGALE', target: [T('fieldSpot')], if: [SELF(C('fieldBest', 'SA_VIOLENTGALE'))] },
    ...SAGE_ENDOWS('nearAlly'),
    { do: 'SA_AUTOSPELL', if: [FOES('any'), SELF(C('castSafe'))] },
    { do: 'SA_ABRACADABRA', if: [FOES('any'), SELF(C('sinceUsed', 10), C('spAtLeast', 50))] },
    { do: BOLTS, target: [T('onMe'), T('onAlly'), T('near')] },
    { do: 'attack', target: ATTACK_TARGET, if: [SELF(C('noSkill'))] },
    { do: 'sit', if: [FOES('any'), SELF(C('cantAfford', 'MG_FIREBOLT'))] },
    ...REST,
  ],
  sagemelee: [
    ...DRINK,
    SPEED,
    // (no backing off as it casts, by request: it goes on casting and swinging at the one before it)
    // (by request: always at it with its book, its spells cast on top, the swings going on through a cast with Free
    // Cast: a target first, before any spell, kept as it casts)
    // (Hindsight before its first swing, none at it, the cast not cut short: by report, mobbed it cast it over and
    // over, its swings drawing them on it)
    { do: 'SA_AUTOSPELL', if: [FOES('any'), FOES('none', C('onMe')), SELF(C('castSafe'))] },
    // (by request: Energy Coat on, as Hindsight: its 5 s cast before the swings, none at it)
    { do: 'MG_ENERGYCOAT', if: [FOES('any'), FOES('none', C('onMe')), SELF(C('castSafe'))] },
    { do: 'attack', target: [T('onMe'), T('current'), T('party'), T('near')], if: [SELF(C('attacking', null, true))] },
    { do: 'SA_MAGICROD', if: [FOES(1, C('spellAtMe'))] },
    { do: 'SA_SPELLBREAKER', target: [T('onMe'), T('current'), T('onAlly'), T('near')], if: [ON(C('casting'), C('inRange'))] },
    { do: 'SA_LANDPROTECTOR', target: [T('self')], if: [FOES(1, C('groundCast'))] },
    { do: 'SA_DISPELL', target: [T('current'), T('onMe')], if: [ON(C('buffed'), C('inRange'))] },
    ...SAGE_AREA(C('spAfter', 10)),
    ...SAGE_ENDOWS('self'),
    { do: 'SA_VOLCANO', target: [T('fieldSpot')], if: [SELF(C('fieldBest', 'SA_VOLCANO'))] },
    { do: 'SA_DELUGE', target: [T('fieldSpot')], if: [SELF(C('fieldBest', 'SA_DELUGE'))] },
    { do: 'SA_VIOLENTGALE', target: [T('fieldSpot')], if: [SELF(C('fieldBest', 'SA_VIOLENTGALE'))] },
    { do: 'SA_ABRACADABRA', if: [FOES('any'), SELF(C('sinceUsed', 10), C('spAtLeast', 50))] },
    // (by request: the bolts too, with SP to spare and the cast not cut short: bestBolt only those over in time;
    // only where they pay more than the book, by the target's DEF and MDEF: weaponPays)
    { do: BOLTS, target: [T('current'), T('onMe'), T('party'), T('near')], if: [ON(C('weaponPays', null, true)), SELF(C('spAfter', 10))] },
    { do: 'attack', target: [T('onMe'), T('current'), T('party'), T('near')] },
    ...REST,
  ],
  // an assassin (by request) fights as a thief does, with its own skills on top (what it has not learned, or its weapon
  // does not allow, is passed over, so one set does for the katar build and the two weapons'). Taking a lot of damage
  // fast it cloaks (by request; with no Cloaking, it hides as a thief does): the ones after it let it go, and it walks
  // unseen to the one it goes for and attacks, which ends it (its skills would too, so none until then). A ranged one
  // at the party in Grimtooth's reach, out of melee (by request), it hides for, and Grimtooths (katar) from hiding,
  // staying in it while one is in reach, the rest in reach for its first 2 s. Then Enchant Poison on itself or one of
  // the party by it (where poison does no worse than neutral), Poison React with one at it, Venom Dust under a crowd of
  // 3 it can poison (a Red Gemstone a time), Venom Splasher on a crowd of 2, Sonic Blow (katar), Throw Venom Knife (its
  // quest's) at a ranged one out of reach, then the thief's.
  assassin: [
    ...DRINK,
    SPEED,
    { do: 'AS_GRIMTOOTH', target: [T('lowDefRanged')], if: [ON(C('inRange')), SELF(C('hidden'))] },
    { do: 'TF_HIDING', if: [SELF(C('hidden'), C('hiddenFor', 2))] },
    { do: 'AS_GRIMTOOTH', target: [T('crowd'), T('onAlly'), T('near')], if: [ON(C('inRange')), SELF(C('hidden'))] },
    { do: 'wait', if: [SELF(C('hidden'))] },
    { do: 'AS_CLOAKING', if: [SELF(C('burst', 20), C('noIncoming'))] },
    { do: 'attack', target: [T('onFragile'), T('onAlly'), T('current'), T('lowDefRanged'), T('lowDef')], if: [SELF(C('cloaked'))] },
    { do: 'TF_HIDING', if: [SELF(C('burst', 20), C('noIncoming'), C('usable', 'AS_CLOAKING', true))] },
    { do: 'TF_HIDING', if: [FOES('any', C('ranged'), C('onUs'), C('within', 1, true), C('inRangeOf', 'AS_GRIMTOOTH')), SELF(C('usable', 'AS_GRIMTOOTH'), C('noIncoming'), C('spAfter', 30))] },
    { do: 'TF_DETOXIFY', target: [T('nearAlly')], if: [ON(C('poisoned'))] },
    { do: 'AS_ENCHANTPOISON', target: [T('self'), T('nearAlly')], if: [ON(C('poisonWorks'), C('inRange')), SELF(C('spAfter', 30))] },
    { do: 'AS_POISONREACT', if: [FOES('any', C('onMe'), C('within', 2)), SELF(C('spAfter', 30))] },
    { do: 'AS_VENOMDUST', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3)), SELF(C('spAfter', 30))] },
    { do: 'AS_SPLASHER', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 2), C('hpAbove', 50)), SELF(C('spAfter', 30))] },
    { do: 'AS_SONICBLOW', target: [T('focus')], if: [ON(C('hpAbove', 50)), SELF(C('spAfter', 30))] },
    { do: 'AS_VENOMKNIFE', target: [T('lowDefRanged')], if: [ON(C('walkOver', 2), C('inRange')), SELF(C('spAfter', 30))] },
    { do: 'TF_STEAL', target: [T('focus')], if: [ON(C('stealable'), C('stealTries', 3, true)), SELF(C('spAfter', 30))] },
    { do: 'TF_POISON', target: [T('focus')], if: [ON(C('used', null, true))] },
    { do: 'attack', target: [T('onFragile'), T('onMe'), T('onAlly'), T('current'), T('lowDefRanged'), T('lowDef')] },
    ...REST,
  ],
  // a rogue (by request) fights as a thief does, with its own skills on top (what it has not learned, or its weapon does
  // not allow, is passed over); by request two presets, 短劍 (this) and 弓 (roguebow, below). Its own weapon taken up
  // again first (one left in its hands by 弓). In hiding (by request), with 3 or more within RAID_WALK cells, it walks to
  // where Sightless Mind takes in the most and uses it, else to behind the one it attacks and Back Stabs it; then the
  // thief's hiding (out after 2 s, waiting), and hiding for Sightless Mind with 2 at it next to it. Snatch on a monster
  // attacking one of the party right next to it (by request, not one shooting from afar), a fragile one's first, its HP above 75 % (by
  // request: not one nearly down; it takes that one away with the rogue), none while the one it took is standing; that one it attacks first (by
  // request, its 普攻目標, so its Back Stab and Mug too) till it is down; Back Stab on the one it attacks from behind,
  // walking behind it when it is not after the rogue; Mug once a monster; then the thief's. Left out Close Confine, the
  // Divests, the Graffiti ones and a copied skill (by hand). Against one at it that sees through hiding (a boss, a
  // Detector: by report it stood there in hiding, the monster still after it) it does not hide, out at once if it is.
  rogue: [
    ...DRINK,
    SPEED,
    { do: 'ownWeapon' },
    { do: 'move', target: [T('raidSpot')], if: [FOES(3, C('within', RAID_WALK)), SELF(C('hidden'), C('usable', 'RG_RAID'))] },
    { do: 'RG_RAID', if: [FOES(3, C('within', RAID_WALK)), FOES('any', C('inArea')), SELF(C('hidden'))] },
    { do: 'RG_BACKSTAP', target: [T('focus')], if: [ON(C('behind')), SELF(C('hidden'))] },
    { do: 'TF_HIDING', if: [FOES('any', C('onMe'), C('detector')), SELF(C('hidden'))] },
    { do: 'move', target: [T('backOf')], if: [SELF(C('hidden'), C('usable', 'RG_BACKSTAP'))] },
    { do: 'TF_HIDING', if: [SELF(C('hidden'), C('hiddenFor', 2))] },
    { do: 'wait', if: [SELF(C('hidden'))] },
    { do: 'TF_HIDING', if: [FOES('none', C('onMe'), C('detector')), SELF(C('burst', 20), C('noIncoming'))] },
    { do: 'TF_HIDING', if: [FOES(2, C('onMe'), C('within', 1)), SELF(C('usable', 'RG_RAID'), C('noIncoming'), C('spAfter', 30))] },
    { do: 'TF_HIDING', if: [FOES('any', C('onMe'), C('within', 2)), FOES('none', C('onMe'), C('detector')), SELF(C('usable', 'RG_BACKSTAP'), C('usable', 'RG_TUNNELDRIVE'), C('noIncoming'), C('spAfter', 40))] },
    { do: 'TF_DETOXIFY', target: [T('nearAlly')], if: [ON(C('poisoned'))] },
    { do: 'RG_INTIMIDATE', target: [T('onFragile'), T('onAlly')], if: [ON(C('boss', null, true), C('nextToAlly'), C('hpAbove', 75)), SELF(C('snatching', null, true), C('spAfter', 30))] },
    { do: 'RG_BACKSTAP', target: [T('focus')], if: [ON(C('behind')), SELF(C('spAfter', 10))] },
    { do: 'move', target: [T('backOf')], if: [SELF(C('usable', 'RG_BACKSTAP'), C('spAfter', 10))] },
    { do: 'RG_STEALCOIN', target: [T('focus')], if: [ON(C('boss', null, true), C('used', null, true)), SELF(C('spAfter', 30))] },
    { do: 'TF_STEAL', target: [T('focus')], if: [ON(C('stealable'), C('stealTries', 3, true)), SELF(C('spAfter', 30))] },
    { do: 'TF_POISON', target: [T('focus')], if: [ON(C('used', null, true))] },
    { do: 'attack', target: [T('snatched'), T('onFragile'), T('onMe'), T('onAlly'), T('current'), T('lowDefRanged'), T('lowDef')] },
    ...REST,
  ],
  // a bow rogue (by request, 職業預設's 弓): a bow in its hands, its own or one taken up (ATK 0, as a bard's); no dagger
  // (by request: its DEX is what its bow hits with, and a Divest goes with any weapon). A monster at it next to it: one
  // of the Divests it has learned on it, picked at random for that one (divestPick), tried once (none on a boss); then
  // Back Slide away, where the slide takes it 3 cells off every one next to it (canSlide). No backing off else. With its
  // HP below ROGUE_HIDE_HP % and one after it it hides (by request; not from one that sees through hiding), walks off
  // (Tunnel Drive) more than HIDE_FAR cells from every monster and comes out there to shoot (out after 2 s, as a thief,
  // when it cannot get away; at once with one at it that sees it). Double Strafe; Mug once a monster; then the thief's,
  // but the ones after it attacked first (by request).
  roguebow: [
    ...DRINK,
    SPEED,
    { do: 'TF_HIDING', if: [FOES('none', C('within', HIDE_FAR)), SELF(C('hidden'))] },
    { do: 'TF_HIDING', if: [FOES('any', C('onMe'), C('detector')), SELF(C('hidden'))] },
    { do: 'move', target: [T('hideAway')], if: [SELF(C('hidden'))] },
    { do: 'TF_HIDING', if: [SELF(C('hidden'), C('hiddenFor', 2))] },
    { do: 'wait', if: [SELF(C('hidden'))] },
    { do: 'TF_HIDING', if: [FOES('any', C('onMe')), FOES('none', C('onMe'), C('detector')), SELF(C('hpBelow', ROGUE_HIDE_HP))] },
    { do: 'bow' },
    ...DIVESTS.map(n => ({ do: n, target: [T('onMe')], if: [ON(C('within', 1), C('boss', null, true), C('divested', null, true), C('divestPick')), SELF(C('spAfter', 10))] })),
    { do: 'TF_BACKSLIDING', if: [FOES('any', C('onMe'), C('within', 1)), SELF(C('canSlide', 3))] },
    { do: 'TF_DETOXIFY', target: [T('nearAlly')], if: [ON(C('poisoned'))] },
    { do: 'AC_DOUBLE', target: [T('focus')], if: [SELF(C('spAfter', 10))] },
    { do: 'RG_STEALCOIN', target: [T('focus')], if: [ON(C('boss', null, true), C('used', null, true)), SELF(C('spAfter', 30))] },
    { do: 'TF_STEAL', target: [T('focus')], if: [ON(C('stealable'), C('stealTries', 3, true)), SELF(C('spAfter', 30))] },
    { do: 'TF_POISON', target: [T('focus')], if: [ON(C('used', null, true))] },
    // (by request: the ones after it first, chasing or hitting, then the ones at the party)
    { do: 'attack', target: [T('onMe'), T('onFragile'), T('onAlly'), T('current'), T('lowDefRanged'), T('lowDef')] },
    ...REST,
  ],
  // a thief finishes monsters off
  thief: [
    ...DRINK,
    SPEED,
    // taking a lot of damage fast: it hides, which makes whoever is after it let it go (lostSight), and comes
    // out 2 s later. A hit already on its way still lands and brings it out (RemoveOnDamaged), so it waits for
    // a moment with none coming.
    { do: 'TF_HIDING', if: [SELF(C('hidden'), C('hiddenFor', 2))] },
    { do: 'wait', if: [SELF(C('hidden'))] },
    { do: 'TF_HIDING', if: [SELF(C('burst', 20), C('noIncoming'))] },
    { do: 'TF_DETOXIFY', target: [T('nearAlly')], if: [ON(C('poisoned'))] },
    { do: 'TF_POISON', target: [T('focus')], if: [ON(C('used', null, true))] },
    // a monster with something to take: Steal until it takes something (by request), 3 tries at most (a monster
    // whose drops are rare would take its SP for ever), SP kept for Hiding
    { do: 'TF_STEAL', target: [T('focus')], if: [ON(C('stealable'), C('stealTries', 3, true)), SELF(C('spAfter', 30))] },
    { do: 'attack', target: [T('onFragile'), T('onMe'), T('onAlly'), T('current'), T('lowDefRanged'), T('lowDef')] },
    ...REST,
  ],
  // a priest (by request) supports as an acolyte does, with its own skills on top (what it has not learned is passed
  // over, so one set does for the support build and the exorcist): one of the party down raised first (Resurrection),
  // then Heal; a freeze broken (Status Recovery); Kyrie Eleison on the one being hit; Safety Wall under a fragile one
  // in melee; Lex Divina on a monster casting; Magnus Exorcismus on a crowd; Sanctuary on the hurt ones (where it
  // heals no monster), or on a crowd of the undead and demons; the party's prayers (Impositio Manus, Suffragium,
  // Gloria, Magnificat) as Angelus is; Aspersio for one fighting the unholy with its weapon; Lex Aeterna on the one the
  // party is fighting. Left out Turn Undead (by request) and Redemptio.
  priest: [
    ...DRINK,
    { do: 'ALL_RESURRECTION', target: [T('deadAlly')], if: [ON(C('inRange'))] },
    HEAL,
    { do: 'PR_STRECOVERY', target: [T('nearAlly')], if: [ON(C('frozen'), C('inRange'))] },
    // (as an acolyte's, by request)
    { do: 'AL_RUWACH', if: [SELF(C('foeHidden', 5))] },
    { do: 'move', target: [T('hiddenNear')], if: [SELF(C('revealing'))] },
    { do: 'AL_CURE', target: [T('nearAlly')], if: [ON(C('ailing'))] },
    { do: 'AL_BLESSING', target: [T('nearAlly')], if: [ON(C('stoned'))] },
    { do: 'AL_BLESSING', target: [T('nearAlly')], if: [ON(C('cursed'))] },
    { do: 'AL_PNEUMA', target: [T('nearAlly')], if: [ON(C('shot'))] },
    { do: 'PR_KYRIE', target: [T('weakAlly')], if: [ON(C('beingHit'), C('inRange'))] },
    { do: 'MG_SAFETYWALL', target: [T('nearAlly')], if: [ON(C('fragile'), C('meleed'), C('inRange')), SELF(C('castSafe'))] },
    { do: 'PR_LEXDIVINA', target: [T('near')], if: [ON(C('casting'), C('inRange'))] },
    { do: 'move', target: [T('safe', [3, 4])], if: [SELF(C('noSkill', null, true))] },
    { do: 'PR_MAGNUS', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3)), SELF(C('castSafe'))] },
    { do: 'PR_SANCTUARY', target: [T('weakAlly')], if: [ON(C('hurtNear', 2), C('healsFoe', null, true), C('inRange'))] },
    { do: 'PR_SANCTUARY', target: [T('crowd')], if: [ON(C('inRange'), C('crowd', 3), C('healsFoe', null, true))] },
    { do: 'PR_IMPOSITIO', if: [FOES('any'), SELF(C('spAfter', 50))] },
    { do: 'PR_SUFFRAGIUM', if: [FOES('any'), SELF(C('spAfter', 50))] },
    { do: 'PR_GLORIA', if: [FOES('any'), SELF(C('spAfter', 50))] },
    { do: 'PR_MAGNIFICAT', if: [FOES('any'), SELF(C('spAfter', 50))] },
    { do: 'PR_ASPERSIO', target: [T('nearAlly')], if: [ON(C('hitsUnholy'), C('inRange')), SELF(C('spAfter', 50))] },
    { do: 'AL_INCAGI', target: [T('nearAlly')], if: [ON(C('line', 'priest', true), C('line', 'acolyte', true), C('line', 'mage', true), C('line', 'wizard', true), C('stripped', null, true)), SELF(C('spAfter', 50))] },
    { do: 'AL_BLESSING', target: [T('nearAlly')], if: [ON(C('stripped', null, true)), SELF(C('spAfter', 50))] },
    { do: 'AL_ANGELUS', if: [FOES('any'), SELF(C('spAfter', 50))] },
    { do: 'PR_LEXAETERNA', target: [T('party')], if: [ON(C('hpAbove', 50), C('inRange')), SELF(C('spAfter', 50))] },
    { do: 'AL_CRUCIS', if: [SELF(C('spAfter', 50))] },
    { do: 'AL_DECAGI', target: [T('near')], if: [ON(C('chasing'), C('onUs'), C('inRange')), SELF(C('spAfter', 50))] },
    { do: 'AL_HEAL', target: [T('near')], if: [ON(C('undead'), C('inRange')), SELF(C('spAtLeast', 75))] },
    { do: 'AL_HOLYLIGHT', target: [T('party')], if: [ON(C('inRange')), SELF(C('spAtLeast', 75))] },
    { do: 'attack', target: ATTACK_TARGET, if: [SELF(C('noSkill'))] },
    { do: 'sit', if: [FOES('any'), SELF(C('spBelow', 75))] },
    ...REST,
  ],
  // an acolyte that fights (by request: the one on its way to a monk, 攻擊型): at the monsters with its weapon, not
  // backing off; Increase AGI, Blessing and Angelus on itself only (Angelus, the party's, when it is without it), no Heal
  // (by request: not on itself, and on no one else either), its attack speed potion (the acolyte line's is
  // Concentration: it may not drink Awakening nor Berserk), Cure, Blessing and Pneuma on itself as the
  // acolyte's are on the party; Ruwach as the acolyte's. Left out Decrease AGI, Holy Light and Signum Crucis.
  acolytemelee: [
    ...DRINK,
    SPEED,
    { do: 'AL_CURE', target: [T('self')], if: [ON(C('ailing'))] },
    { do: 'AL_BLESSING', target: [T('self')], if: [ON(C('stoned'))] },
    { do: 'AL_BLESSING', target: [T('self')], if: [ON(C('cursed'))] },
    { do: 'AL_PNEUMA', target: [T('self')], if: [ON(C('shot'))] },
    { do: 'AL_RUWACH', if: [SELF(C('foeHidden', 5))] },
    { do: 'move', target: [T('hiddenNear')], if: [SELF(C('revealing'))] },
    { do: 'AL_INCAGI', target: [T('self')], if: [FOES('any'), ON(C('stripped', null, true)), SELF(C('spAfter', 30))] },
    { do: 'AL_BLESSING', target: [T('self')], if: [FOES('any'), ON(C('stripped', null, true)), SELF(C('spAfter', 30))] },
    { do: 'AL_ANGELUS', if: [FOES('any'), SELF(C('stripped', null, true), C('spAfter', 30))] },
    ATTACK,
    ...REST,
  ],
  acolyte: [
    ...DRINK,
    HEAL,
    { do: 'AL_CURE', target: [T('nearAlly')], if: [ON(C('ailing'))] },
    { do: 'AL_BLESSING', target: [T('nearAlly')], if: [ON(C('stoned'))] },
    { do: 'AL_BLESSING', target: [T('nearAlly')], if: [ON(C('cursed'))] },
    { do: 'AL_PNEUMA', target: [T('nearAlly')], if: [ON(C('shot'))] },
    // (by request: Ruwach with an enemy in hiding or cloaked within 5 cells, while it is not on: it brings them out)
    { do: 'AL_RUWACH', if: [SELF(C('foeHidden', 5))] },
    { do: 'move', target: [T('hiddenNear')], if: [SELF(C('revealing'))] },
    { do: 'move', target: [T('safe', [3, 4])], if: [SELF(C('noSkill', null, true))] },
    { do: 'AL_INCAGI', target: [T('nearAlly')], if: [ON(C('line', 'priest', true), C('line', 'acolyte', true), C('line', 'mage', true), C('line', 'wizard', true), C('stripped', null, true)), SELF(C('spAfter', 50))] },
    { do: 'AL_BLESSING', target: [T('nearAlly')], if: [ON(C('stripped', null, true)), SELF(C('spAfter', 50))] },
    { do: 'AL_ANGELUS', if: [FOES('any'), SELF(C('spAfter', 50))] },
    { do: 'AL_CRUCIS', if: [SELF(C('spAfter', 50))] },
    // used from where it stands, these do not make the monster the acolyte's target
    { do: 'AL_DECAGI', target: [T('near')], if: [ON(C('chasing'), C('onUs'), C('inRange')), SELF(C('spAfter', 50))] },
    { do: 'AL_HEAL', target: [T('near')], if: [ON(C('undead'), C('inRange')), SELF(C('spAtLeast', 75))] },
    { do: 'AL_HOLYLIGHT', target: [T('party')], if: [ON(C('inRange')), SELF(C('spAtLeast', 75))] },
    // with no skill learned yet it goes and fights with its weapon (by request)
    { do: 'attack', target: ATTACK_TARGET, if: [SELF(C('noSkill'))] },
    { do: 'sit', if: [FOES('any'), SELF(C('spBelow', 75))] },
    ...REST,
  ],
};
for (const list of [...Object.values(RULES), COMMON]) if (!list.includes(LURE)) list.splice(list.findIndex(r => !DRINK.includes(r)), 0, LURE);
for (const list of [...Object.values(RULES), COMMON]) if (!list.includes(DODGE)) list.splice(list.findIndex(r => !DRINK.includes(r)), 0, DODGE);
// The presets a character's rules can come from: 基本, 職業預設 (its job line's, whatever the job is now) and the
// ones the player saved (saved: [{ id, name, rules }], kept by the sandbox; see setSaved)
export const PRESETS = { basic: '基本', job: '職業預設' };
let kept = [];
export const savedPresets = () => kept;
export function setSaved(list) { kept = list; }
// the rules of preset `key` for character c (a saved one that is gone: 基本's)
// (a line with more than one: JOB_VARIANTS, 'job:<variant>' its others; one it does not have, its first's)
export const JOB_VARIANTS = { sage: [['job', '施法'], ['job:melee', '近戰']], rogue: [['job', '短劍'], ['job:bow', '弓']],
  acolyte: [['job', '輔助'], ['job:melee', '攻擊型']] };
export const jobVariants = c => JOB_VARIANTS[lineOf(c)] || null;
export const isJobPreset = key => key === 'job' || /^job:/.test(key || '');
export const presetRules = (c, key) => isJobPreset(key) ? RULES[lineOf(c) + (key === 'job' ? '' : key.slice(4))] || RULES[lineOf(c)] || COMMON : (key !== 'basic' && kept.find(p => p.id === key)?.rules) || BASIC;
// character c's line, in words (職業預設's which)
export const lineLabel = c => LINE_LABEL[lineOf(c)] || '';
// character c's rules, in order: its own (c.rules), else its preset's
export const rulesOf = c => c.rules || presetRules(c, c.tactic);
export const tactics = rulesOf;
// character c's rules from now on: its own (null: preset `tactic`'s, by default the one it is on)
export function setRules(c, rules, tactic = c.tactic) {
  c.rules = rules;
  c.tactic = tactic;
  c.rule = null;
  emit('rule', c);
}
// the skills character c's rules can use: its job's that 自動 can carry out (SKILL_USE), not passive
export const ruleSkills = c => jobSkills(c).filter(sk => SKILL_USE[sk.name] && db.skills[sk.name] && db.skills[sk.name].target !== 'Passive' && sk.name !== 'MC_VENDING');
// 自動 on character c at time t, when it could take an order (see above)
// 自動 reads its rules again at once when the character has just become free to act (its cast, motion or
// skill delay over, the player's order done) or the monsters standing are more or fewer (a wave in, one down),
// and otherwise every AI_MS while it walks, attacks or stands (by request: reading them every step was most of
// what a fight cost; what it has started goes on meanwhile)
const AI_MS = 100;
// (by request: not a rule, so not shown or deleted) with monsters standing and nobody fighting for STALL_MS —
// no hit landing, no character going for a monster (its target, or a skill or cast on one), no monster that can
// walk after a character, and the monsters standing as many — as when only ones that do not come for you are
// left (eggs, a pupa) and no one's rules go for them, every character on 自動 whose rules have it do nothing
// or only walk (one sitting down for SP has a skill to come back with) attacks the nearest one it sees,
// and keeps at it (c.stallHit) until it is down. The fight would otherwise never end.
// So too (by request) when the party has taken no HP off a monster for DRY_MS since the last of them came in,
// the monsters at it all the while: as when the ones with the weapons are down and the rest only walk away (an
// acolyte backing off, never with the SP its rules want to attack with) or sit for SP they have no skill for (a
// mage): then one sitting down attacks too. Its rules still go first for a skill (a Heal), just not for walking,
// waiting or sitting, until that monster is down.
const STALL_MS = 5000, DRY_MS = 30000;
const fighting = c => c.dead == null && [c.target, c.pending?.target, c.cast?.target].some(u => u && u.side !== c.side && alive(u));
// → false, 'still' (nobody fighting) or 'dry' (no HP taken off them)
function stalled(t) {
  if (W.stallT === t) return W.stallOn;
  const n = W.mobs.filter(m => alive(m) && !m.owner && !m.trap).length;  // (not the party's summons)
  if (n > W.stallN) W.mobsAt = t;
  if (n !== W.stallN || allChars().some(fighting) || W.mobs.some(m => alive(m) && m.target && m.target.dead == null && m.st.mode & B.MD.CANMOVE)) W.busyAt = t;
  W.stallN = n; W.stallT = t;
  return W.stallOn = n > 0 && (t - Math.max(W.busyAt, W.lastBlow) >= STALL_MS ? 'still' : t - Math.max(W.lastDealt, W.mobsAt) >= DRY_MS ? 'dry' : false);
}
// 喝藥水 rules are read apart from the rest, every step (by request: rAthena lets an item be used in a skill's
// delay, a cast or a hit's stop, which keep the rest of 自動 waiting), wherever they are in the list: the first
// that applies drinks, and what the character is doing goes on, sat down too
function drinkRules(c, t) {
  if (!c.auto || c.dead != null || c.vending || t < (c.itemAt || 0)) return;
  const rules = rulesOf(c);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    // (none it would drink, whatever its conditions say: on to the next, its conditions not read)
    if (!isDrink(r.do) || r.off || DRINKS[r.do](c) == null) continue;
    const o = follow(c, r, i, { t, focus: undefined });
    if (o) return void drink(c, o.potion, t);
  }
}
function think(c, t) {
  debug.mark?.('think', c);
  if (c.cast && freeCastLv(c)) return castKite(c, t);
  // (a skill's delay keeps it from acting, not from walking — canact_tick: out of an area cast at it all the same, by its
  // dodge rule if on)
  if (t < c.canAct && c.auto && c.dead == null && !c.cast && !c.sitting && !c.vending && t >= c.recover && !c.pending && !c.selfPending) {
    const r = dodgeRule(c);
    const p = r && !r.off && dodgeSpot(c)[0];
    if (p) give(c, { walk: p, why: 'rest' });
  }
  if (!c.auto || c.dead != null || c.vending || (c.sitting && !c.aiSat) || c.cast || t < c.canAct || t < c.recover ||
      (c.pending && !c.pending.ai) || (c.selfPending && !c.selfPending.ai) ||  // (the player's order first)
      (c.w.moving && !goal(c) && !c.aiWalk)) {  // (walking where the player sent it)
    c.aiAt = null;
    return;
  }
  const foes = livingFoes(c).length;
  if (c.aiAt != null && t < c.aiAt && foes === c.aiFoes) return;
  c.aiAt = t + AI_MS;
  c.aiFoes = foes;
  if (foes) c.restAt = null;
  if (c.stallHit && (!alive(c.stallHit) || (c.target !== c.stallHit && !c.pending && !c.cast))) c.stallHit = null;
  // provoked by a monster (see DOES.giveUp): before any of its rules, it attacks that one and nothing else, while
  // the monster is there to be seen (by request)
  const by = provokedBy(c);
  if (by) {
    if (c.rule !== null) { c.rule = null; emit('rule', c); }
    if (c.sitting) sit(c, false);
    c.aiWalk = false;
    return give(c, { attack: by });
  }
  const rules = rulesOf(c), ctx = { t, focus: undefined };
  let i = 0, o = null;
  for (; i < rules.length; i++) if (!isDrink(rules[i].do) && ruleOn(c, rules[i]) && (o = follow(c, rules[i], i, ctx))) break;
  // (its rules having it do nothing, or only walk: one sitting down for SP has a skill to come back with, but
  // not after DRY_MS; one at a stalled fight's monster already keeps at it but for a skill)
  const idle = !o || o.walk || o.hold || o.sit, st = idle && (c.stallHit || stalled(t));
  if (st && (c.stallHit || st === 'dry' || !o || !o.sit) && (c.stallHit ||= nearest(c, livingFoes(c)))) {
    if (c.rule !== null) { c.rule = null; emit('rule', c); }
    if (c.sitting) sit(c, false);
    c.aiWalk = false;
    if (c.target === c.stallHit && !c.pending && !c.selfPending) return;
    c.pending = c.selfPending = null;
    return engage(c, c.autoPick = c.stallHit);
  }
  debug.mark?.('rule', c, o && { i, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? v.name || '{…}' : v])) });
  if (c.rule !== (o ? i : null)) { c.rule = o ? i : null; emit('rule', c); }
  if (!o || !o.pickup) c.loot = null;  // (no longer on its way to loot: another may go for it)
  if (o && o.sit) {
    // (not on a cell another character holds: a step off it first, by request)
    const off = !c.sitting && crowded(c) && freeNear(c);
    if (off) return give(c, { walk: off, why: 'rest' });
    if (!c.sitting && t >= c.sitAfter) { sit(c, true); c.aiSat = !!c.sitting; }
    return;
  }
  if (c.sitting) sit(c, false);  // (only one 自動 sat down gets here)
  if (o) give(c, o);
}
// 自動 on character c casting with Free Cast (by request: the sage kites as it casts): of its rules, only the walks and
// the attacks (by request: 近戰 swings on through a Thunderstorm, a new one when its foe falls; its others wait for the
// cast to be over), each AI_MS
function castKite(c, t) {
  if (!c.auto || c.dead != null || (c.pending && !c.pending.ai)) return;
  if (c.aiAt != null && t < c.aiAt) return;
  c.aiAt = t + AI_MS;
  const rules = rulesOf(c), ctx = { t, focus: undefined };
  for (let i = 0; i < rules.length; i++) {
    if ((rules[i].do !== 'move' && rules[i].do !== 'attack') || !ruleOn(c, rules[i])) continue;
    const o = follow(c, rules[i], i, ctx);
    if (o) return give(c, o);
  }
}
// the monster whose Provocation has character c provoked now, if it is still there and seen (see DOES.giveUp)
function provokedBy(c) {
  const s = c.sc.find(x => x.name === 'SM_PROVOKE' && x.by && W.t < x.until);
  return s && alive(s.by) && inFight(s.by) && sees(c, s.by) ? s.by : null;
}
// 自動 gives character c order o (see think), unless it is carrying it out already
function give(c, o) {
  if ('swap' in o) {
    const was = c.look.weapon;
    if (o.swap && c.bowHeld) holdBow(c, false);  // (another taken up already: its own first)
    holdBow(c, o.swap, o.weapon);
    if (c.look.weapon === was) return;
    c.divestOn = o.on || null;
    if (o.on) { const ks = DIVESTS.filter(n => knows(c, n)); c.divestPick = ks.length ? ks[rnd(ks.length)] : null; }
    if (was === '단검') c.daggerBack = W.t;
    return;
  }
  if (o.hold) return;  // (nothing to do for now: a thief waiting in hiding)
  c.loot = o.pickup || null;
  if (o.pickup) {  // (next to it: picked up; else walked to)
    const it = o.pickup;
    if (!c.w.moving && canReach(c, it)) { c.aiWalk = false; return pickUp(c, it, W.t); }
    o = { walk: it.w.cell, why: 'loot' };
  }
  if (o.walk) {
    const [x, y] = o.walk, end = walkEnd(c);
    if (c.aiWalk && c.w.moving && end[0] === x && end[1] === y) return;
    // (dodging, by request: not into an area it dodges from out of them, and round them on the way)
    const inZone = dangerOf(c);
    if (inZone && inZone(x, y) && !inZone(...c.w.cell)) return;
    walkTo(c, x, y, inZone && avoidOf(inZone).cost);
    c.aiWalk = o.why;
    return;
  }
  c.aiWalk = false;
  if (o.ground) {
    const p = c.pending;
    if (p && p.sk.name === o.ground && p.target.ground && sameCell(p.target.w.cell, o.at)) return;
    c.selfPending = null;
    useGround(c, o.ground, o.at, o.lv);
    if (c.pending) c.pending.ai = true;
    return;
  }
  if (o.attack) {
    if (c.target === o.attack && !c.pending && !c.selfPending) return;
    c.pending = c.selfPending = null;  // (the rule that gave them no longer applies)
    return engage(c, c.autoPick = o.attack);
  }
  if (o.on === c && db.skills[o.skill].target === 'Self') {
    if (c.selfPending && c.selfPending.sk.name === o.skill) return;
    c.pending = null;
    useSelf(c, o.skill);
    if (c.selfPending) c.selfPending.ai = true;
    return;
  }
  if (c.pending && c.pending.sk.name === o.skill && c.pending.target === o.on && (!o.lv || c.pending.lv === o.lv)) return;
  c.selfPending = null;
  if (o.on.side !== c.side && !o.aside) c.autoPick = o.on;
  useSkill(c, o.skill, o.on, !!o.aside, o.lv);
  if (c.pending) c.pending.ai = true;
}
// 自動 on (the default) or 手動: turning it off drops what 自動 was doing (its skills waiting, the target it
// picked); a walk it started goes on, and sitting it stays sat. Turning it on hands the character over, sat
// down or not.
export function setAuto(c, on) {
  c.auto = on;
  if (on) { c.aiSat = c.sitting; return; }
  if (c.sitting) sit(c, false);  // back to the player's hands: it stands up
  if (c.pending && c.pending.ai) c.pending = null;
  if (c.selfPending && c.selfPending.ai) c.selfPending = null;
  if (c.target && c.target === c.autoPick) disengage(c);
  c.aiWalk = false;
  c.rule = null;
  emit('rule', c);
}

// ---------- simulation (t = animation clock in ms: follows pause and speed) ----------
// the fight at time t: every unit acts on what it sees, then walks on for the time since the last step (at
// most 100 ms, after a pause)
// (debugging, by request: a page hung inside a step) debug.mark(label, unit) called at each part of a step and of each
// character's (stepChar, think, chaseStep), so that the last one heard of is where it hung; null: none
export const debug = { mark: null };
export function step(t) {
  const dt = Math.min(Math.max(t - W.t, 0), 100);
  W.t = t;
  if (t < W.lastClock) {  // clock was reset
    W.hits = []; W.shots = []; W.later = [];
    emit('reset', t);
    clearWalls(t);
    W.unitNext = 0; W.lastBlow = W.busyAt = W.lastDealt = W.mobsAt = 0; W.stallT = null;
    for (const c of allChars()) { c.dealt = []; c.dealtSince = null; c.next = null; c.anim = null; c.hurt = null; c.alert = false; c.recover = 0; c.stops = []; c.ready = 0; c.canAct = 0; c.sitAfter = 0; c.cooldown = {}; c.cast = null; c.aiAt = null; c.stallHit = null; clearStatuses(c); endAils(c, t); }
    // (the monsters' times were on the old clock too: a motion started "later" would be drawn before its start)
    for (const m of W.mobs) { m.anim = null; m.cast = null; m.attacked = []; m.nextAttack = m.stunUntil = 0; m.nextWalk = t + RANDOMWALK_MS; m.skillReady = {}; endAils(m, t); if (m.gone != null) m.gone = t; }
  }
  W.lastClock = t;
  // each unit's pace, and its own animation clock (animT: ms of its animations gone by, at its pace)
  for (const u of units()) if (u.w) { u.w.pace = paceOf(u, t); u.animT = (u.animT || 0) + dt * u.w.pace; }
  // (with a rival team, the two teams take turns going first, step by step: neither always a step ahead)
  for (const c of W.rivals.length && W.tick++ & 1 ? [...W.rivals, ...W.chars] : allChars()) { debug.mark?.('stepChar', c); homunBack(c, t); stepChar(c, t); }
  debug.mark?.('reveal');
  // Sight: every 20 ms while it lasts, the user's enemies in hiding within its splash come out (status_change_timer)
  for (const u of units()) for (const s of u.sc) if (s.name === 'MG_SIGHT' && t < s.until && u.dead == null) reveal(u, db.skills.MG_SIGHT.splash[s.lv - 1] || 0, true);
  // Ruwach the same, and each enemy it brings out takes its holy hit at once (status_change_timer_sub → skill_attack)
  for (const u of units()) for (const s of [...u.sc]) if (s.name === 'AL_RUWACH' && t < s.until && u.dead == null) {
    const sk = db.skills.AL_RUWACH;
    for (const x of reveal(u, sk.splash[s.lv - 1] || 0, true)) schedule(B.skillAttack(db, offense(u), defense(x), sk, s.lv), u, x, t);
  }
  if (W.unitNext < t - 1000) W.unitNext = t;  // (after a long pause, not every turn missed)
  debug.mark?.('unitTurn');
  for (; W.unitNext <= t; W.unitNext += UNIT_MS) unitTurn(W.unitNext);
  debug.mark?.('landHits');
  landHits(t);
  debug.mark?.('laterTurn');
  laterTurn(t);
  for (const mob of [...W.mobs]) {
    debug.mark?.('mob', mob);
    if (mob.gone != null && t >= mob.gone) removeMob(mob);
    else if (mob.expires != null && t >= mob.expires && mob.dead == null) removeMob(mob);  // (a summon's time up: mob_timer_delete)
    else if (mob.restAt != null && t >= mob.restAt && mob.dead == null) homunRest(mob.owner, t);  // (SC_HOMUN_TIME's end)
    else if (mob.dying && !comboOn(mob)) mobDies(mob, t);  // (its last hits were dropped)
    else if (mob.trap) icicleTurn(mob, t);
    else mobAi(mob, t);
  }
  W.shots = W.shots.filter(a => t < a.at);
  // face whom the motion in progress is for, else whom the character is heading for (not while a motion that
  // asks not to is held: Asura Strike's, its back to the target)
  for (const c of allChars()) {
    if (c.anim && c.anim.noFace && t < Math.max(animEnd(c.anim), c.anim.until ?? 0)) continue;
    const u = (c.anim && t < animEnd(c.anim) && c.anim.target) || goal(c);
    if (u && u !== c && !c.w.moving) field.face(c.w, u.w);
  }
  debug.mark?.('advance');
  field.advance(dt);
  debug.mark?.('stepped');
}
// Auto Berserk on character c: at a quarter of its HP or less, a Provoke Lv 10 of its own (`auto`, val4) that
// lasts until its HP is above a quarter again (status_change_timer SC_AUTOBERSERK)
function berserk(c) {
  if (!has(c, 'SM_AUTOBERSERK') || c.dead != null) return;
  const low = c.hp <= Math.trunc(c.pc.maxHp / 4), on = c.sc.some(s => s.auto);
  if (low === on) return;
  c.sc = c.sc.filter(s => s.name !== 'SM_PROVOKE');
  if (low) c.sc.push({ name: 'SM_PROVOKE', lv: 10, until: Infinity, effect: B.STATUS_SKILLS.SM_PROVOKE.status(10), auto: true });
  recalc(c);
}
// one character's turn: every character goes on with what it was told, controlled or not
function stepChar(c, t) {
  if (!c.pc) return;
  ailTick(c, t);
  regen(c, t);
  // (Sacrifice ends with its crusader down or gone: pc_dead; its time up, with what it gave, expireStatuses)
  const dv = c.sc.find(s => s.name === 'CR_DEVOTION');
  if (dv && (dv.by.dead != null || !inFight(dv.by))) endDevotion(c);
  expireStatuses(c, t);
  confineTick(c, t);
  hidingDrain(c, t);
  cloakTurn(c, t);
  maximizeDrain(c, t);
  sphereTick(c, t);
  berserk(c);
  if (c.frozen) { if (t < c.frozen.until) return; thaw(c, t); }  // frozen: nothing until it thaws
  if (c.stunned) { if (t < c.stunned.until) return; unstun(c, t); }  // stunned: the same
  if (c.asleep) { if (t < c.asleep.until) return; wake(c, t); }  // asleep: the same, until damage wakes it
  bladeTick(c, t);
  if (stoneTick(c, t)) return;  // stone: the same, until a hit breaks it or its time is up
  // turning to stone (Petrify Attack's 100 ms): no attack or skill (NoAttack, NoCast); its walk goes on by itself
  if (c.stone) return;
  const w = c.w;
  // (casting with Free Cast: its walk slower, freeCastLv)
  const free = freeCastLv(c), cellMs = free ? Math.trunc(c.pc.walkSpeed * 100 / (25 + 5 * free)) : c.pc.walkSpeed;
  if (w.cellMs !== cellMs) w.cellMs = cellMs;
  // a walk cuts the attack motion off (attack_walk_delay 0: players may move during it); its hit still lands,
  // unless it is a bow's that has not let go yet
  if (w.moving && c.anim) { dropUnshot(c); c.anim = null; }
  // setting off on a walk drops the battle stance (roBrowser: the walk ends in IDLE); finishing the step a
  // hit stopped does not
  if (w.path.length) c.alert = false;
  drinkRules(c, t);
  think(c, t);
  debug.mark?.('thought', c);
  if (c.target && (c.target.side === c.side || !sees(c, c.target))) loseFoe(c);  // no enemy now, or one gone into hiding
  const body = motion.ready(c), m = c.target, u = goal(c);
  const swinging = c.anim && t < animEnd(c.anim);
  // the target (or the one a skill is for) walked off: follow it
  if (u && c.running && !w.moving && !swinging && !castBound(c) && t >= c.recover && !field.inRange(w, u.w, wantedRange(c))) approach(c);
  // stopped on the way by a hit, or done with a skill on someone else: walk on — a skill's motion played out first
  // (by report: Throw Venom Knife's pose was cut off by the walk to its target), and a normal attack's (by request:
  // its hit lands wherever the target has gone, schedule)
  else if (u && !c.running && !w.moving && !swinging && !castBound(c) && t >= c.recover && c.dead == null && !c.sitting) approach(c);
  // a queued skill goes first: cast (if it has a cast time), then fire
  const p = c.pending;
  // (no waiting for a normal swing: the skill cuts it off, see cancelSwing)
  if (p && !c.cast && c.running && body && !w.moving && t >= c.canAct && t >= (c.cooldown[p.sk.name] || 0)) {
    const ct = castTimeOf(p.sk, p.lv, c.pc, c), fail = skillFail(c, p.sk, p.lv, p.abra);
    if (fail) { c.pending = null; say(w, fail, t); }
    else if (ct > 0) {
      cancelSwing(c);
      c.cast = { ...p, start: t, end: t + ct, cancelable: p.sk.castCancel !== false && !c.cardFx?.noCastCancel };
      emit('cast', c, p.sk, p.target.w, t, ct, !!p.target.ground);
      shout(w, p.sk, t, c.cast);
      c.pending = null;
    }
    else { c.pending = null; fireSkill(c, p, t); }
  }
  // (Cast Cancel during a cast: at once, whatever the skill delay)
  if (c.selfPending && c.selfPending.sk.name === 'SA_CASTCANCEL' && c.cast) { const q = c.selfPending; c.selfPending = null; fireSkill(c, { ...q, target: c }, t); }
  if (c.cast && t >= c.cast.end) { const k = c.cast; c.cast = null; if ((k.target.dead == null || raising(k)) && !k.target.dying) fireSkill(c, k, t, true); }
  // a skill on the character itself: stop walking (after the current step), then use it and go on
  // toward the target, if any
  // (one with a cast time is cast first, as any other: Angelus)
  const q = c.selfPending;
  if (q && !c.cast && body && t >= c.canAct) {
    if (w.moving) w.halt();
    else {
      c.selfPending = null;
      const ct = castTimeOf(q.sk, q.lv, c.pc, c), fail = skillFail(c, q.sk, q.lv, q.abra);
      if (ct > 0 && !fail) {
        cancelSwing(c);
        c.cast = { ...q, target: c, start: t, end: t + ct, cancelable: q.sk.castCancel !== false && !c.cardFx?.noCastCancel };
        emit('cast', c, q.sk, c.w, t, ct, false);
        shout(w, q.sk, t, c.cast);
      } else fireSkill(c, { ...q, target: q.sk.name === 'MO_CHAINCOMBO' && c.bladeStop ? c.bladeStop.with : COMBO_AFTER[q.sk.name] && c.combo ? c.combo.target : c }, t);
      if (c.target) approach(c);
    }
  }
  // (in range of a skill and not of the weapon: the skill gone off or failed this step, Not Enough SP, it walks
  // into the weapon's range first — once the skill's motion has played out: by report, Throw Venom Knife's pose was
  // cut off by the walk; and not during a normal attack's either, by request: a monster running off is chased once the
  // swing has played out, its hit landing all the same)
  if (c.running && m && !c.pending && !castBound(c) && !(c.anim && t < animEnd(c.anim)) && !field.inRange(w, m.w, c.pc.range)) approach(c);
  if (c.running && body && m && !c.sitting && !w.moving && !c.pending && !castBound(c) && t >= c.canAct && !has(c, 'KN_AUTOCOUNTER') && !c.bladeStop && !has(c, 'BD_PERFORMING')) {
    // first attack, or resuming after a pause: not before the last attack's interval is over, however often
    // the monster is clicked (unit_attack waits for attackabletime)
    if (c.next == null || c.next < t - 1000) c.next = Math.max(t, c.ready);
    if (t >= c.next) {
      debug.mark?.('swing', c, { on: m.name });
      endStatus(c, 'AS_CLOAKING');  // (its attack ends Cloaking: battle_weapon_attack)
      // the attack animation is stretched over the attack interval (adelay), so the swings follow each
      // other without a pause; the hit shows on the motion's hit frame (motion.pc)
      const group = motion.attackGroup(c), { frames, release, hf } = motion.pc(c, group);
      // a double attack: the first swing is cut off at its hit frame and a second one starts over, its hit
      // on its own hit frame (the client's motion for it is in the packed exe: this is by eye); both swings fit in
      // the one attack interval, at an even pace (rAthena: the next attack comes after adelay either way)
      // (or a Raging Trifecta Blow in its place: triple; its combo puts c.next off, not this swing)
      const at = c.next, tri = triple(c, m, at);
      const pr = tri ? {} : poisonReactAtk(c, offense(c));
      const r = tri || B.attack(db, pr.src, defense(m)), restart = r.hits === 2 && !tri ? hf : null;
      if (pr.s && r.damage > 0) {
        const sk = db.skills.AS_POISONREACT, o = B.poisonOdds(statusOf(c), statusOf(m), 50, sk.duration2[pr.s.lv - 1]);
        if (!m.poison && rnd(10000) < o.chance * 100) r.poison = o.ms;
        endStatus(c, 'AS_POISONREACT');
      }
      // (a Raging Trifecta Blow: the one swing, the fist held out on its hit frame while its three hits land, then the
      // rest of it, all in the one attack interval: by request, the client's own motion for it not being in this sprite)
      const n = hitCount(r), seq = tri ? [...Array(frames).keys()].flatMap(f => f === hf ? Array((n - 1) * TRIPLE_GAP + 1).fill(f) : [f]) : null;
      // (casting with Free Cast: its attacks slower, freeCastLv)
      const adelay = free ? Math.trunc(c.pc.adelay * 100 / (50 + 5 * free)) : c.pc.adelay;
      const fd = adelay / (seq ? seq.length : frames + (restart ?? 0));
      // a monster's "normally attacked" event: it is attacking someone else and this comes from within
      // its attack range + 1 (battle_weapon_attack)
      r.norm = !m.isPc && m.mss === 'attack' && !m.mssAngry && m.target !== c && field.distance(c.w, m.w) <= m.st.range + 1;
      c.anim = { start: at, group, frames: seq ? seq.length : frames, fd, restart, target: m, ...seq && { seq } };
      c.alert = true;
      schedule(r, c, m, at + hf * fd, seq ? TRIPLE_GAP * fd : hf * fd);
      // (its cards' splash: a normal attack of its own on every other enemy within that many cells of the target, as it
      // lands, if it dealt damage — battle_weapon_attack's skill_castend_damage_id with no skill)
      if (c.cardFx?.splash && r.damage > 0 && !tri)
        for (const x of enemies(c)) if (x !== m && alive(x) && cheb(x.w.cell, m.w.cell) <= c.cardFx.splash) schedule(B.attack(db, offense(c), defense(x)), c, x, at + hf * fd);
      if (tri) emit('skill', 'MO_TRIPLEATTACK', w, m.w, at, at + hf * fd);
      if (c.pc.weapon === 'Bow') W.shots.push({ by: c, from: w, to: m, t0: at + (release ?? 0) * fd, at: at + hf * fd });
      // (Hindsight on: its spell may go off as the attack lands, autoSpell)
      if (has(c, 'SA_AUTOSPELL')) W.later.push({ at: at + hf * fd, by: c, to: m, run(when) { autoSpell(c, m, when); } });
      // (Gank: a steal as it lands, gank)
      if (r.damage > 0 && c.pc.weapon !== 'Bow' && passiveLv(c, 'RG_SNATCHER') > 0) W.later.push({ at: at + hf * fd, by: c, to: m, run(when) { gank(c, m, when); } });
      // (its cards' autospells, by request: as it lands, if it does not miss — skill_additional_effect)
      if (c.cardFx?.autoSpell.length && r.type !== 'miss' && r.type !== 'lucky')
        W.later.push({ at: at + hf * fd, by: c, to: m, run(when) { cardSpells(c, m, c.cardFx.autoSpell, BF.WEAPON | BF.NORMAL | (c.pc.range >= 4 ? BF.LONG : BF.SHORT), when, c.pc.weapon === 'Bow'); } });
      // (a combo it may follow the blow up with puts the next attack off: startCombo)
      c.next = Math.max(at + adelay, c.combo && c.combo.target === m ? c.combo.until : 0);
      c.ready = c.next;
    }
  }
}
