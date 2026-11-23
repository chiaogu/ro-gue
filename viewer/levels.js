// Maps made for the party: waves of monsters sized so the party, fighting them on 自動, wins about as often as
// the phase calls for, by fighting them for real (fight.js, the same fight the page shows) rather than by any
// estimate of it: what the fight learns (a skill, a job, a monster's AI) the planner goes by with nothing more
// to write. No DOM: sandbox.js plays the maps (the fights in its workers: mapsim.js), bench/ (Node) checks them.
//
// A map is a theme (one of jobs.json maps at a level: which of the monsters spawning there are near it; one of
// those nearest the party's level, by chance among them), a phase and a shape. The phases come round in turn, one map each (PHASES: a plain one, one with monsters that
// do something special, one with a boss), and say how often the party should come through it (win: the share
// of fights not wiped). A shape lays the theme's monsters out in its waves; how many there are in all (N) is
// what the planner tunes (by request: the monsters as they are in mob_db, the map finer by one monster more or
// less): the most for which `runs` fights (seeds 1…runs, the same for every N, so two N differ by the monsters
// only) are won often enough. How they are spread over the waves is the phase's `spike` (see spread). Only when
// N can go no lower (nMinOf) or no higher (nMax) does every monster's HP and ATK go by k (kMin–kMax)
// instead. Every one of these can be set for a plan (DEFAULTS, planMap).
import * as sim from './sim.js';
import * as B from './battle.js';

let db = null, floors = {};
export function init(o) { ({ db } = o); floors = o.floors || {}; }

// ---------- floors ----------
// A map is fought on a patch of its own floor (by request): one of the few scripts/map2gltf.py --arena cut out
// of it (floors: viewer/floors.json, { map: [{ x, y, open }] }), by chance (rnd), or flat where it has none.
// The plan carries it (plan.floor: { map, i, open }), so the fights that size the map and the map fought go on
// the same one, and a replay with it.
export function floorOf(map, rnd = Math.random) {
  const list = floors[map];
  if (!list || !list.length) return null;
  const i = Math.floor(rnd() * list.length);
  return { map, i, open: list[i].open };
}
// a number in 0…1 fixed by string s, for a choice that is always the same (a level chain's floor)
export const fixed = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return () => (h >>> 0) / 2 ** 32; };

// ---------- money and potions ----------
// The potion shop (by request, RO's prices — rAthena's item_db Buy, twice jobs.json's sell — times 3, as the level
// chain was worked out with: the bigger potions dearer for each HP they heal, as in RO: red 0.55 z an HP, orange 1.2,
// yellow 2.6, white 9.9; each on sale from a party level on): [item id, price (z), on sale from party level].
// sandbox.js's 結算 sells from it. The Blue Potion and the attack speed potions are priced by what they were worth
// to the base party on the chain's maps (bench/potions.mjs, 30 fights a map at levels 10–55: the speed bonus they
// brought, levels.speedBonus, and the red potions they spared), not RO's ×3 (Blue 15000, Concentration 3600,
// Awakening 6600 z: tens of maps' money here): a Blue Potion (40–60 SP, + 2% a point of INT) 10 z at level 10,
// 30–60 z from 20 to 40, over 100 from 45 (where it wins maps the reds alone lose); Concentration's 10% faster
// attacks (on its swordsman alone) about 25 z; Awakening's 15% 60–100 z from 40 (it needs base level 40 and no
// acolyte or bard line: item_db, sim.mayDrink). Each a little under what it is worth from the middle levels on.
// The gemstones Stone Curse, Safety Wall and Warp Portal take (sim.ITEM_COST; by request; Fire Pillar's too, from Lv 6), 50 z each from level 1,
// not RO's ×3 (1350 z: 2 to 10 maps' income here, 130–800 z a map on plan4): as the Blue Potion, about what one
// cast is worth — Safety Wall's Lv + 1 hits blocked, a red potion or two at the low levels.
// Holy Water (Aspersio) and the hunter's Booby Traps 20 z each.
export const SHOP = [[501, 30, 1], [502, 150, 20], [503, 540, 35], [504, 3600, 50], [505, 50, 1], [645, 20, 1], [656, 60, 40],
  [716, 50, 1], [717, 50, 1], [523, 20, 1], [1065, 20, 1]];
// how much more loot sells for with a merchant's Overcharge at level lv (pc_modifysellvalue, %), and how much less
// an NPC sells for with Discount (pc_modifybuyvalue: the same numbers)
export const sellRate = lv => lv ? 5 + lv * 2 - (lv === 10 ? 1 : 0) : 0;
export const buyRate = sellRate;
// how much less an NPC sells for to `party` (pc_modifybuyvalue): the better of a merchant's Discount (buyRate) and a
// rogue's Haggle (RG_COMPULSION: 5 + 4 × Lv %), each the best one's in it
export const buyOff = party => Math.max(buyRate(Math.max(0, ...party.map(c => c.levels.MC_DISCOUNT || 0))),
  ...party.map(c => c.levels.RG_COMPULSION ? 5 + 4 * c.levels.RG_COMPULSION : 0));
// The 武器 shop (game.js; by request; gone since the game's equipment is free, by request: armorFrom — the prices kept
// for bench/weapons.mjs): what the weapon dealers of the town the party is in sell (jobs.json
// weaponShops, gear), each on sale from the level it takes (EquipLevelMin; 1 at least). RO's prices (50 z to 65,000 z
// for the main towns' ones) are a dozen maps' income here and more, so a weapon costs the maps' income it would take
// to save up for it at that level: incomeOf(level) × 1.5 × (RO price / 1000)^0.4 — a Knife half a map's, a Katana
// two, a Haedonggum about eight: the dearer ones in RO dearer here too, the gap narrowed. One sold back (another
// bought in its place) brings half (RO's: Buy / 2), Overcharge on it as on the loot; Discount comes off the price.
// (the level a weapon is on sale or, the game's equipment being free since, put on from: weaponLevels)
export const weaponFrom = g => (weaponLv ??= weaponLevels()).get(g) ?? Math.max(1, g.lv);
export const weaponPrice = g => Math.max(1, Math.round(1.5 * (g.buy / 1000) ** 0.4 * incomeOf(weaponFrom(g), 0)));
// whether job (jobs.json) can hold weapon g (gear): its type is one the job has an attack speed for, and the item's
// jobs (item classes) take the job's
export const canWield = (job, g) => !!job && !!g && job.aspd[g.type] != null && (!g.jobs || g.jobs.includes(job.itemClass));
// The game's equipment (by request: free, put on by level, game.js autoGear): the weapons on sale in any of its towns
// (jobs.json weaponShops) from weaponFrom, the body armours and shields (jobs.json armors) from armorFrom. Most armour
// takes no level in RO (EquipLevelMin 0), so its price gives it one (by request: the game starts at Lv 10 in a Cotton
// Shirt, a Jacket from Lv 12, each dearer one later, the Adventurer's Suit getting its turn): 12 + 4 ln(Buy / 200),
// under 200 z Lv 1, its own when higher — a Guard Lv 16, an Adventurer's Suit 18, a Mantle 28, a Buckler 29, a Coat
// 31, a Chain Mail 35, Thief Clothes 36, a Full Plate 40 (its own). (First, by request too: the level the weapons of
// about that price take, 4 + 9.1 ln(Buy / 2500).)
const priceLevel = buy => buy < 200 ? 1 : Math.round(12 + 4 * Math.log(buy / 200));
export const armorFrom = g => Math.max(1, g.lv, priceLevel(g.buy));
// The weapons the same way (by request: RO's come in three or four tiers of levels, 1 / 12 / 24 or 2 / 14 / 27, of
// which only each tier's strongest was ever put on): of each type, from the weakest (by ATK; a staff's by MATK, then
// the cheaper), the weakest from its own level (one at the start, as the Cotton Shirt), the next from Lv 12 (as the
// Jacket, by request: not the start's one till Lv 20 or so), each after it from its price's level (as armour's), its
// own when higher, and a level after the one before it at least, so each gets its turn — daggers: a Knife Lv 1, a
// Cutter 12, a Main Gauche 22, a Dirk 27, a Dagger 29, a Stiletto 30, a Gladius 33, a Fist Sword 34, a Damascus 35.
// (Before, by request too: RO's own, EquipLevelMin.)
let weaponLv = null;  // (gear → level, made once db is in)
// The weapon types no first job holds (katars, instruments, whips, knuckles) are a second job's from its start, which
// comes at Base 49 at the earliest (the game: Base 10 Job 1, a level of each a map, the change from Job 40), so in the
// line above they were all theirs at once (by request): spread from Base 49 to 85, the strongest there.
const SECOND_ARMS = [49, 85];
function weaponLevels() {
  const m = new Map(), byType = {};
  for (const i of new Set(Object.values(db.weaponShops || {}).flat())) { const g = db.gear[i]; if (g) (byType[g.type] ??= []).push(g); }
  const key = g => g.type === 'Staff' || g.type === '2hStaff' ? g.matk : g.atk;
  const first = new Set(Object.values(db.jobs).flatMap(j => j.tier <= 1 && j.aspd ? Object.keys(j.aspd) : []));
  for (const [type, list] of Object.entries(byType)) {
    list.sort((a, b) => key(a) - key(b) || a.buy - b.buy);
    // (a type only second jobs hold, by request: spread evenly from SECOND_ARMS' first level to its last)
    if (!first.has(type)) {
      const [lo, hi] = SECOND_ARMS;
      list.forEach((g, k) => m.set(g, Math.max(1, g.lv, Math.round(lo + (hi - lo) * k / Math.max(1, list.length - 1)))));
      continue;
    }
    list.reduce((prev, g, k) => { const lv = Math.max(1, g.lv, k === 1 ? 12 : k ? priceLevel(g.buy) : 1, prev + 1); m.set(g, lv); return lv; }, 0);
  }
  return m;
}
export const canWear = (job, g) => !!job && !!g && (!g.jobs || g.jobs.includes(job.itemClass));
// The game's equipment put on by level (by request; game.js autoGear, and the level chain's parties, bench/parties.mjs,
// the same: the base party fights in what the game would give it): what it holds is c.hands' pick ({ right: a weapon
// type, left: 'shield', 'none' or a weapon type }) — the best weapon of that type in its right hand (a staff's by
// MATK, any other's by ATK), in its left the best shield, nothing, or with Lefthand Mastery (sim.dualWields) and a
// dagger, a one-handed sword or an axe in the right, the best of one of those (as RO's assassins: DUAL). A type it
// cannot have yet waits for the level, the best of what it can have meanwhile: the one it held, its job's usual one
// (`usual`, a weapon type), or any. A shield only one its job has a sprite for when that is known (c.look.shields).
// a weapon type (item_db SubType) → the sprite a character holds it as (index.json weapon types)
export const WEAPON_SPRITE = { Dagger: '단검', '1hSword': '검', '2hSword': '양손검', '1hSpear': '창', '2hSpear': '양손창', '1hAxe': '도끼',
  '2hAxe': '양손도끼', Mace: '클럽', Staff: '롯드', '2hStaff': '양손지팡이', Bow: '활', Knuckle: '너클', Musical: '악기', Whip: '채찍',
  Book: '책', Katar: '카타르_카타르' };  // (a katar's sprite is the pair, one weapon: as the sandbox holds it, by report)
export const DUAL = ['Dagger', '1hSword', '1hAxe'];
// the dual-wield sprites (index.json weapon types: right hand, left hand; either way about for the ones listed once)
const DUAL_SPRITES = new Set(['단검_단검', '단검_검', '단검_도끼', '검_검', '검_도끼', '도끼_도끼']);
export const dualSprite = (r, l) => [`${WEAPON_SPRITE[r]}_${WEAPON_SPRITE[l]}`, `${WEAPON_SPRITE[l]}_${WEAPON_SPRITE[r]}`].find(v => DUAL_SPRITES.has(v));
let armIds = null;  // (every weapon on sale, in any town)
const magicType = t => t === 'Staff' || t === '2hStaff';
// the best weapon of `type` character c can have now: [item id, gear] or null
export function bestArm(c, type) {
  const job = sim.jobFor(c), key = g => magicType(g.type) ? [g.matk, g.atk] : [g.atk, g.matk];
  armIds ??= [...new Set(Object.values(db.weaponShops || {}).flat())];
  return armIds.map(i => [i, db.gear[i]]).filter(([, g]) => g && g.type === type && canWield(job, g) && c.blv >= weaponFrom(g))
    .sort(([ia, a], [ib, b]) => key(b)[0] - key(a)[0] || key(b)[1] - key(a)[1] || a.buy - b.buy || ia - ib)[0] || null;
}
// the weapon types c can have one of now, in WEAPON_SPRITE's order
export const armTypes = c => Object.keys(WEAPON_SPRITE).filter(t => bestArm(c, t));
export const SHIELD_SPRITE = Object.fromEntries(Object.entries(sim.SHIELDS).map(([v, x]) => [x.id, v]));
// the best body armour or shield (slot) c can wear now: [item id, armor] or null (a shield only one sim.SHIELDS knows,
// as it gives the DEF)
export function bestArmor(c, slot) {
  const job = sim.jobFor(c);
  return Object.entries(db.armors || {}).filter(([i, g]) => g.slot === slot && canWear(job, g) && c.blv >= armorFrom(g) &&
      (slot !== 'shield' || (SHIELD_SPRITE[i] && (!c.look.shields || c.look.shields.some(([v]) => v === SHIELD_SPRITE[i])))))
    .sort(([ia, a], [ib, b]) => b.def - a.def || b.mdef - a.mdef || a.buy - b.buy || ia - ib)[0] || null;
}
// what c holds and wears as c.hands picks, put on it (c.arm, c.armL, c.body, c.look.shield; usual: its job's usual
// weapon type) → the weapon sprite it holds then (null: none, its job's usual one's look to keep)
export function putOnGear(c, usual = null) {
  const h = c.hands || {}, types = armTypes(c), had = c.arm && db.gear[c.arm]?.type;
  const right = [h.right, had, usual].find(t => t && types.includes(t)) || types[0] || null;
  const arm = right && bestArm(c, right), two = !!right && sim.BOTH_HANDS.has(right);
  const left = h.left || 'shield';
  const armL = arm && !two && DUAL.includes(left) && DUAL.includes(right) && sim.dualWields(c) && dualSprite(right, left) && bestArm(c, left) || null;
  const shield = !two && !armL && left === 'shield' ? bestArmor(c, 'shield') : null;
  const body = bestArmor(c, 'body');
  c.arm = arm ? +arm[0] : null;
  c.armL = armL ? +armL[0] : null;
  c.look.shield = shield ? SHIELD_SPRITE[shield[0]] : '';
  c.body = body ? +body[0] : null;
  return armL ? dualSprite(right, left) : arm ? WEAPON_SPRITE[right] : null;
}
// what the loot picked up (sim W.loot: { item id: how many }) sells for, rate % more (a merchant's Overcharge)
export const lootWorth = (loot, rate = 0) =>
  Object.entries(loot).reduce((z, [id, n]) => z + Math.floor(((db.items[id] || {}).sell || 0) * (100 + rate) / 100) * n, 0);
// A typical player's shopping before a map (by request): the bag topped up with the HP potion on sale at the party's
// level that heals the most for its price (with nothing to carry it in yet, a red one: by request, no weight for now) until the potions in it heal `stock` times the party's HP in all (each potion by what it heals
// the party on average: sim.potionHeal), as many as the money buys; prices × `price`. With `speed`, then an attack
// speed potion for each one whose rules drink one (sim.rulesOf: speedPotion), the strongest on sale it may drink
// (it lasts the map: one each), those in the bag counted; with `sp`, then Blue Potions until they give back `sp`
// times the SP of those whose rules drink one (spPotion: by what one gives them on average, sim.potionSp). Each
// as far as the money left goes. Party: calc'd characters.
// → { bag, zeny, bought: { item id: how many }, cost }
export function restock(party, bag, zeny, { stock, sp = 0, speed = false, price = 1 }) {
  const lv = Math.round(party.reduce((n, c) => n + c.blv, 0) / party.length), sale = SHOP.filter(x => lv >= x[2]);
  const out = { bag: { ...bag }, zeny, bought: {}, cost: 0 };
  const buy = ([id, p], k) => {
    const unit = p * price;
    k = Math.max(0, Math.min(k, Math.floor(out.zeny / unit)));
    if (!k) return;
    out.bag[id] = (out.bag[id] || 0) + k; out.bought[id] = (out.bought[id] || 0) + k;
    out.zeny -= k * unit; out.cost += k * unit;
  };
  const drinks = (c, d) => sim.rulesOf(c).some(r => r.do === d);
  const per = (who, f) => who.reduce((n, c) => n + f(c), 0) / who.length;
  const inBag = (kind, f) => Object.entries(out.bag).reduce((n, [i, k]) => n + ((db.items[i] || {})[kind] ? f(+i) * k : 0), 0);
  const heal = id => per(party, c => sim.potionHeal(c, id, false));
  const hp = sale.filter(x => db.items[x[0]].heal).sort((a, b) => a[1] / heal(a[0]) - b[1] / heal(b[0]))[0];
  buy(hp, Math.ceil((stock * party.reduce((n, c) => n + c.pc.maxHp, 0) - inBag('heal', heal)) / heal(hp[0])));
  if (speed) {
    const want = new Map();
    for (const c of party.filter(c => drinks(c, 'speedPotion'))) {
      const x = sale.filter(x => db.items[x[0]].aspd != null && sim.mayDrink(c, x[0])).sort((a, b) => db.items[b[0]].aspd - db.items[a[0]].aspd)[0];
      if (x) want.set(x, (want.get(x) || 0) + 1);
    }
    for (const [x, k] of want) buy(x, k - (out.bag[x[0]] || 0));
  }
  const spWho = party.filter(c => drinks(c, 'spPotion'));
  if (sp && spWho.length) {
    const gives = id => per(spWho, c => sim.potionSp(c, id, false));
    const x = sale.filter(x => db.items[x[0]].sp).sort((a, b) => a[1] / gives(a[0]) - b[1] / gives(b[0]))[0];
    if (x) buy(x, Math.ceil((sp * spWho.reduce((n, c) => n + c.pc.maxSp, 0) - inBag('sp', gives)) / gives(x[0])));
  }
  return out;
}
// The bag a typical player takes into a map for `budget` z of drinking a map (by request: bench/plan2.mjs's chain,
// whose potion need grows from none with the level; bench/DESIGN.md): what it may drink of it, the potions on sale
// at the party's level priced as the shop sells them (× price). An attack speed potion for each one whose rules
// drink one (as restock's), when they come to no more than speedShare of the budget; then of the rest a share
// `blue` in Blue Potions for those whose rules drink one (fuel: drunk to the last, so as many as a map's budget
// buys), the rest in the HP potion that heals the most for its price, `carry` maps' worth of it (a spare: red
// ones are drunk only when it goes badly). → { bag: { item id: how many }, cost }
export function typicalBag(party, budget, { carry = 2, blue = 0.5, speedShare = 1 / 3, price = 1 } = {}) {
  const lv = Math.round(party.reduce((n, c) => n + c.blv, 0) / party.length), sale = SHOP.filter(x => lv >= x[2]);
  const bag = {}, put = ([id, p], k) => { if (k > 0) { bag[id] = (bag[id] || 0) + k; left -= k * p * price; } };
  let left = budget;
  if (budget <= 0) return { bag, cost: 0 };
  const drinks = (c, d) => sim.rulesOf(c).some(r => r.do === d), per = (who, f) => who.reduce((n, c) => n + f(c), 0) / who.length;
  const speed = party.filter(c => drinks(c, 'speedPotion')).map(c => sale.filter(x => db.items[x[0]].aspd != null && sim.mayDrink(c, x[0]))
    .sort((a, b) => db.items[b[0]].aspd - db.items[a[0]].aspd)[0]).filter(Boolean);
  if (speed.length && speed.reduce((n, x) => n + x[1] * price, 0) <= speedShare * budget) for (const x of speed) put(x, 1);
  const spWho = party.filter(c => drinks(c, 'spPotion'));
  if (blue > 0 && spWho.length) {
    const gives = id => per(spWho, c => sim.potionSp(c, id, false));
    const x = sale.filter(x => db.items[x[0]].sp).sort((a, b) => a[1] / gives(a[0]) - b[1] / gives(b[0]))[0];
    if (x) put(x, Math.floor(blue * left / (x[1] * price)));
  }
  const heal = id => per(party, c => sim.potionHeal(c, id, false));
  const hp = sale.filter(x => db.items[x[0]].heal).sort((a, b) => a[1] / heal(a[0]) - b[1] / heal(b[0]))[0];
  if (hp) put(hp, Math.floor(carry * left / (hp[1] * price)));
  return { bag, cost: budget - left };
}
// A bag topped up to `want` (item id → how many) as far as zeny goes, in want's order: → { bag, zeny, bought, cost }
export function topUp(bag, zeny, want, price = 1) {
  const out = { bag: { ...bag }, zeny, bought: {}, cost: 0 };
  for (const [id, k] of Object.entries(want)) {
    const unit = (SHOP.find(x => x[0] === +id) || [0, Infinity])[1] * price;
    const n = Math.max(0, Math.min(k - (out.bag[id] || 0), Math.floor(out.zeny / unit)));
    if (!n) continue;
    out.bag[id] = (out.bag[id] || 0) + n; out.bought[id] = n;
    out.zeny -= n * unit; out.cost += n * unit;
  }
  return out;
}

// The speed bonus (by request): a chain's map cleared in T s, against the base party's T0 (its average: val.T)
// on it, pays income × (T0 / T − 1) more — nothing as fast as the base party or slower, twice as fast its income
// again, which is the most
export const speedBonus = (income, T0, T) => T0 > 0 && T > 0 ? Math.round(income * Math.min(1, Math.max(0, T0 / T - 1))) : 0;

// What a map's loot is worth, all of it picked up, on average (by request: the money a map brings in goes by its
// level and phase, not by how many monsters it has nor what they drop): a curve fitted to what the potion chains'
// maps brought in (bench/chain-p*.json, chain-ro*.json: about 20 L^0.8 z) times the phase's (by request, a harder
// map more: 特殊 ×1.25, BOSS ×1.5). lv: the party's level; phase: index into PHASES.
export const INCOME_PHASE = [1, 1.25, 1.5];
// (plan6's REPRICE fit, by request: what a party without an acolyte drinks × 1.2; plan2–5's was 20 × L^0.8)
export const INCOME = { a: 1.842, p: 1.35 };
export const incomeOf = (lv, phase) => Math.round(INCOME.a * lv ** INCOME.p * INCOME_PHASE[phase]);
// How much more often than mob_db says a map's monsters drop their loot (sim.js W.drop) for it to be worth `income`
// on average (each drop's chance at most 100%; the monsters they summon drop nothing), found by halves; 1 for a
// map whose monsters drop nothing that sells, and for one that falls short even with every drop sure, the least
// that makes them all sure.
export function dropFor(waves, income) {
  const sells = waves.flat().flatMap(d => (d.drops || []).filter(([id, rate]) => rate > 0 && (db.items[id] || {}).sell));
  const worth = r => sells.reduce((n, [id, rate]) => n + Math.min(1, rate * r / 10000) * db.items[id].sell, 0);
  if (!sells.length) return 1;
  const all = Math.max(...sells.map(([, rate]) => 10000 / rate));
  if (worth(all) <= income) return Math.round(all * 1000) / 1000;
  let lo = 0, hi = 1;
  while (worth(hi) < income) hi *= 2;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (worth(m) < income) lo = m; else hi = m; }
  return Math.round(hi * 1000) / 1000;
}

export const PHASES = [
  { name: '普通', win: 0.95, spike: 0, shapes: ['swarm', 'mixed'] },
  { name: '特殊', win: 0.85, spike: 0, shapes: ['special'] },
  { name: 'BOSS', win: 0.7, spike: 0, shapes: ['boss'] },
];
export const LULL_S = 3;  // between waves (s)
// what the planner goes by unless told otherwise (planMap's options, from the map panel: sandbox.js): the lull
// between waves (s), how many fights each N is tried with (at most: see size) and how many go at once (the page:
// its workers), k's and N's ends, and how many a wave a map has while a theme of stronger monsters would do (by
// request: a map made harder by its monsters' level rather than their number; see planMap)
export const DEFAULTS = { lull: LULL_S, runs: 20, parallel: 1, kMin: 0.5, kMax: 2, nMax: 80, waveMax: 6 };
// the fewest monsters a map of W waves has (by request: a map of one or two a wave was dull): two a wave, and five
// at least (a map of two waves 2 and 3); a theme too strong for that is left for a later level
export const nMinOf = W => Math.max(2 * W, 5);
// a wave's monsters come for the party wherever they stand on the floor (their sight and chase ranges at least this)
const ROUSE_RANGE = 30;

// ---------- monsters ----------
const canFight = m => (B.mobMode(m) & (B.MD.CANATTACK | B.MD.CANMOVE)) === (B.MD.CANATTACK | B.MD.CANMOVE);
// something to do about it beyond hitting it: it shoots from afar, heals, or puts a status on its target
const SPECIAL_SKILL = /HEAL|POTIONPITCHER|BLIND|POISON|STUN|CURSE|SLEEP|SANDMAN|SPRINKLESAND|SILENCE|STONE|BLOODDRAIN|MENTALBREAKER/;
export const special = m => m.range > 3 || (m.skills || []).some(s => SPECIAL_SKILL.test(s.skill));
// monster def with its HP and ATK times k (its own id, so what is worked out for it is kept apart)
export function scaled(def, k) {
  if (k === 1) return def;
  return { ...def, hp: Math.round(def.hp * k), atk: Math.round(def.atk * k), id: `${def.id}@${k.toFixed(2)}` };
}
// a wave's monster m (sim.js addMob) comes for the party at once, from anywhere on the floor
export function rouse(m) {
  m.st.mode |= B.MD.AGGRESSIVE;
  m.st.viewRange = Math.max(m.st.viewRange, ROUSE_RANGE);
  m.st.chaseRange = Math.max(m.st.chaseRange, ROUSE_RANGE);
}

// ---------- themes ----------
// (by request) a theme is one of jobs.json maps at a level L: its monsters within WINDOW levels of L (jobs.json
// leaves out champion variants; plants and the like, which take 1 from any hit, are left out here) as the plain
// ones that fight, the special ones and the ones that do not come for you (still: eggs, pupas, Mandragora; for the
// 混合 shape, and hatching later), and a boss: of those that can attack, at most BOSS_ABOVE above L and either
// mob_db's own bosses (頭目: class Boss or Guardian; from the window's bottom up), or above L and above the window
// or at most BOSS_SHARE of the map's spawns (one that fills the map is no boss); mob_db's bosses first, then the
// highest level (then HP). mob_db's bosses are never in a theme but as its boss (by request: they come in the BOSS
// phase only). MVPs are left out for now (by request: no party beat one even alone at k 0.5, so a theme they were
// the boss of was lost; they are for strong parties later). A map has a theme at each level whose window holds a
// plain one, or (by request) a special one and it has a boss (for the BOSS shape only: its special ones in the
// plain ones' place), and two kinds at least, its boss counted; so a map gives themes at many levels, each its own
// mix, and a level has themes from many maps.
const WINDOW = 3, BOSS_ABOVE = 12, BOSS_SHARE = 0.25;
const gathered = m => ['IgnoreMelee', 'IgnoreMagic', 'IgnoreRanged', 'IgnoreMisc'].every(k => (m.modes || []).includes(k));
const mvp = m => (m.modes || []).includes('Mvp');
// (by request) no theme has Iceicle nor Solid Icicle: a trap on the floor, not a monster to fight (sim.js ICICLES)
const TRAPS = new Set(['ICEICLE', 'ILL_ICEICLE']);
const headman = m => m.class === 'Boss' || m.class === 'Guardian';
let themeList = null;
export function themes() {
  if (themeList) return themeList;
  const byId = new Map(db.mobs.map(m => [m.id, m]));
  themeList = [];
  for (const mp of db.maps || []) {
    const mobs = mp.mobs.map(([id, count]) => ({ def: byId.get(id), count })).filter(x => x.def && !gathered(x.def) && !mvp(x.def) && !TRAPS.has(x.def.aegis));
    const total = mobs.reduce((n, x) => n + x.count, 0) || 1, top = Math.max(0, ...mobs.map(x => x.def.level));
    for (let L = 1; L <= top + WINDOW; L++) {
      const boss = mobs.filter(x => (B.mobMode(x.def) & B.MD.CANATTACK) && x.def.level <= L + BOSS_ABOVE && (headman(x.def)
          ? x.def.level >= L - WINDOW : x.def.level > L && (x.def.level > L + WINDOW || x.count <= BOSS_SHARE * total))).map(x => x.def)
        .sort((a, b) => headman(b) - headman(a) || b.level - a.level || b.hp - a.hp)[0] || null;
      const near = mobs.filter(x => Math.abs(x.def.level - L) <= WINDOW && !headman(x.def)).map(x => x.def);
      const fights = near.filter(canFight), plain = fights.filter(d => !special(d));
      if (!(plain.length || (boss && fights.length)) || near.length + !!boss < 2) continue;
      themeList.push({ id: `${mp.map}@${L}`, map: mp.map, label: mp.label, level: L, boss, plain,
                       special: fights.filter(special), still: near.filter(d => !canFight(d)) });
    }
  }
  return themeList;
}
// how many of a map's N monsters each of its W waves gets (N ≥ W): of them, a share `spike` all in the last wave
// (a wave suddenly much bigger), the rest spread evenly (every wave a little bigger); rounded so they come to N
// (what is left over going to the earlier waves: by request, one more in a BOSS map's boss wave or a last wave
// made the map far harder than one more in its first: bench, 100 fights each), one a wave at least
export function spread(N, W, spike) {
  const want = Array.from({ length: W }, (_, i) => (1 - spike) * N / W + (i === W - 1 ? spike * N : 0));
  const out = want.map(Math.floor);
  const order = want.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);  // (earlier waves first)
  for (let left = N - out.reduce((a, b) => a + b, 0), j = 0; left > 0; left--, j++) out[order[j % W][1]]++;
  for (let i = 0; i < W; i++) while (out[i] < 1) { out[i]++; out[out.indexOf(Math.max(...out))]--; }
  return out;
}
const cycle = (list, n, from = 0) => Array.from({ length: n }, (_, i) => list[(from + i) % list.length]);
const weakest = list => [...list].sort((a, b) => a.hp * Math.max(1, a.atk) - b.hp * Math.max(1, b.atk))[0];
// a shape: its waves, at most how many a wave (max; none: nMax for them all), and (theme) → (how many each wave
// gets → waves of monster defs), or null when the theme has not what it needs. 小怪群 is two waves of at most 12
// (by request: a map of it fought in 30–60 s) of the theme's weakest plain monster, or of `mob` in its place: one
// of its ladder (the stronger plain monsters of the theme's map, at any level of it, weakest first), which size
// goes up when 24 of the one before are too few (by request: a stronger monster rather than k).
const ladder = th => {
  const from = weakest(th.plain), power = d => d.hp * Math.max(1, d.atk), seen = new Set();
  return themes().filter(t => t.map === th.map).flatMap(t => t.plain)
    .filter(d => power(d) > power(from) && !seen.has(d.id) && seen.add(d.id)).sort((a, b) => power(a) - power(b));
};
export const SHAPES = {
  swarm: { name: '小怪群', waves: 2, max: 12, ladder,
           make: (th, mob) => th.plain.length ? sizes => sizes.map(n => Array(n).fill(mob || weakest(th.plain))) : null },
  mixed: { name: '混合', waves: 4, make: th => th.plain.length ? sizes => sizes.map((n, w) => cycle([...th.plain, ...th.still], n, w)) : null },
  // every other monster a special one, the rest plain
  special: { name: '特殊行為', waves: 4, make: th => th.special.length && th.plain.length ? sizes => sizes.map((n, w) =>
    Array.from({ length: n }, (_, i) => i % 2 ? th.plain[(w + i) % th.plain.length] : th.special[(w + (i >> 1)) % th.special.length])) : null },
  // the boss in the last wave, with the rest of that wave's count plain (special, a theme with none)
  boss: { name: 'BOSS', waves: 3, make: th => th.boss ? (pool => sizes => sizes.map((n, w) =>
    w === sizes.length - 1 ? [th.boss, ...cycle(pool, n - 1, w)] : cycle(pool, n, w)))(th.plain.length ? th.plain : th.special) : null },
};

// ---------- the party's resources ----------
// what a map's margin is measured in (fight.js runMap, the page's fight): the party's HP, and a healer's SP as
// the HP it would heal
const N_MC = 400;
const mean = f => { let s = 0; for (let i = 0; i < N_MC; i++) s += f(); return s / N_MC; };
// (dice of its own, apart from the fight's: rng.js)
const dice = n => Math.floor(Math.random() * n);
const memo = new Map(), once = (k, f) => memo.has(k) ? memo.get(k) : (memo.set(k, f()), memo.get(k));
// (by what a character is (job, levels, stats, skills, weapon), not who: the same build gets the same draws)
const who = c => JSON.stringify([c.look.job, c.look.held, c.blv, c.jlv, c.stats, c.levels]);

// Heal (AL_HEAL) of character c, if its job has it and it is learned: { amt (expected), cost (SP), time (s it takes up) }
export const healOf = c => once('h' + who(c), () => {
  const lv = sim.knows(c, 'AL_HEAL') ? c.levels.AL_HEAL : 0, sk = db.skills.AL_HEAL;
  if (!lv) return null;
  return { amt: mean(() => B.heal(db, c.pc, c.pc, sk, lv, dice).damage), cost: sk.sp[lv - 1],
           time: (B.castTime(sk, lv, c.pc) + Math.max(B.skillDelay(sk, lv, c.pc), B.castDelays(c.pc, sim.jobFor(c).maxAspd).act)) / 1000 };
});
// The party's resources: its HP, and a healer's SP as the HP it would heal (hp, sp: (character, i) → its own).
// A map's margin is the least of it along the way over all of it at full (0: wiped).
export const resources = (party, hp, sp) => meter(party)(hp, sp);
// resources for party, its healers' Heal looked up once (a fight measured every step: fight.js, sandbox.js)
export function meter(party) {
  const heals = party.map(c => healOf(c));
  return (hp, sp) => party.reduce((n, c, i) => {
    const h = heals[i];
    return n + Math.max(0, hp(c, i)) + (h && hp(c, i) > 0 ? sp(c, i) / h.cost * h.amt : 0);
  }, 0);
}

// ---------- the planner ----------
// fight(plan, seed) → a promise of { wiped, margin }, plan (its waves and lull) fought from seed by the party on
// 自動 (fight.js runMap: in Node, bench/; in the page's workers, sandbox.js). It may reject (the planning given up
// on: a newer one has started), and the planner with it.
const R2 = k => Math.round(k * 100) / 100;
// The fights a planning wants, `slots` of them going at once (the page's workers; 1 in Node): when one ends, the
// next is the next seed of the try wanted most (the lowest prio) that is not yet plain. A try is plan fought from
// seeds until it is plain whether the party wins `need` of them: won or lost is told as soon as it is, the same
// as had they all been fought, whatever order they end in. A try no longer wanted (prio Infinity) keeps what it
// has and starts no more fights until it is wanted again.
function pool(fight, slots) {
  const tries = [];
  let going = 0, failed = null;
  const pump = () => {
    while (going < slots && !failed) {
      let t = null;
      for (const x of tries) if (!x.done && x.next < x.seeds.length && x.prio < Infinity && (!t || x.prio < t.prio)) t = x;
      if (!t) return;
      const seed = t.seeds[t.next++];
      going++;
      fight(t.plan, seed).then(r => { going--; t.got(r); pump(); },
                                err => { going--; failed = err; for (const x of tries) if (!x.done) { x.done = true; x.reject(err); } });
    }
  };
  // → { prio, promise of { wins, runs (fought), ok } }
  const add = (plan, seeds, need) => {
    const t = { plan, seeds, need, next: 0, wins: 0, runs: 0, done: false, prio: Infinity };
    t.promise = new Promise((resolve, reject) => Object.assign(t, { resolve, reject }));
    t.promise.catch(() => {});  // (one tried ahead and never waited on: its giving up is no error)
    t.got = r => {
      if (t.done) return;
      t.runs++;
      if (!r.wiped) t.wins++;
      if (t.wins >= need || t.runs - t.wins > seeds.length - need) { t.done = true; t.resolve({ wins: t.wins, runs: t.runs, ok: t.wins >= need }); }
    };
    if (failed) { t.done = true; t.reject(failed); }
    tries.push(t);
    return t;
  };
  return { add, pump };
}
// The size of map shape (SHAPES) of theme for the party to win `win` of its fights (the pool's: pool), its
// monsters spread by spike over o.waves waves (the shape's own when not given): the most N (k 1) that does,
// doubling from the fewest (nMinOf) and then by halves (as N grows the party wins less: a guess the search goes by); past
// either end, k for it at that end, by halves on a 0.05 grid. Each N (or k) tried is fought from seeds 1…runs.
// While one is fought, the ones the search could want next (down both ways, as many as the pool fights at once)
// are fought too with what is spare: what the search goes by is only ever the one it is at, so the plan comes out
// the same however the fights are shared out. o: DEFAULTS' to change, N or k to hold where given (the other
// tuned, or both as given), kOne (k held at 1 as a k given is, but the ladder still climbed), tried(N, k), told of each N and k the search is at, income (each try's
// drop: dropFor; none, 1) and capped (at most waveMax a wave: planMap). → a promise of { N, W, sizes
// (each wave's), k, mob (the shape's monster from its ladder, or null for its own), wins, runs (of that N and k's
// fights, as far as they were fought), ok, fits (it wins often enough and the one more monster, or 0.05 more k,
// does not; false: past an end) }
export async function size(shape, theme, win, spike, o, pl) {
  const c = { ...DEFAULTS, ...o }, sh = SHAPES[shape], W = Math.max(1, c.waves || sh.waves);
  // (the monster in the shape's own one's place: its ladder's, rung 1 on)
  const rungs = [null, ...(sh.ladder ? sh.ladder(theme) : [])];
  let rung = 0, make = sh.make(theme);
  const climb = r => { rung = r; make = sh.make(theme, rungs[r]); };
  const seeds = Array.from({ length: c.runs }, (_, i) => i + 1), need = Math.ceil(win * c.runs - 1e-9), tries = new Map();
  const at = (N, k) => {
    const key = rung + ':' + N + ':' + R2(k);
    if (!tries.has(key)) {
      const sizes = spread(N, W, spike);
      // (the fight goes by waves and lull only; the rest tells what it is: bench/chain.mjs's replay links)
      const waves = make(sizes).map(w => w.map(d => scaled(d, R2(k))));
      const plan = { waves, lull: c.lull, drop: c.income != null ? dropFor(waves, c.income) : 1, shape, theme, N, W, sizes, k: R2(k), floor: c.floor || null };
      tries.set(key, { N, W, sizes, k: R2(k), t: pl.add(plan, seeds, need) });
    }
    return tries.get(key);
  };
  // the tries wanted, most first ([[N, k], …]; the rest not)
  const want = list => {
    for (const x of tries.values()) x.t.prio = Infinity;
    list.forEach(([N, k], i) => { const x = at(N, k); x.t.prio = Math.min(x.t.prio, i); });
    pl.pump();
  };
  const result = async (N, k, fits) => {
    want([[N, k]]);
    const x = at(N, k), r = await x.t.promise;
    return { N, W, sizes: x.sizes, k: x.k, mob: rungs[rung], ...r, fits: fits ?? r.ok };
  };
  // The highest x in a…b that is ok, (pt: x → [N, k]; ok for lower x, as the search takes it), a − 1 for none:
  // a first, then doubling (dbl) or by halves. s: { lo (the highest known ok), hi (the lowest known not), dbl }
  const search = async (a, b, dbl, pt) => {
    if (b < a) return a - 1;
    const probe = s => s.hi - s.lo <= 1 ? null : s.lo < a ? a : s.dbl ? (s.lo >= b ? null : Math.min(b, 2 * s.lo)) : (s.lo + s.hi) >> 1;
    const after = (s, x, ok) => ok ? { ...s, lo: x } : { lo: s.lo, hi: x, dbl: false };
    let s = { lo: a - 1, hi: b + 1, dbl };
    for (let x; (x = probe(s)) != null;) {
      // x, then what could come after it, breadth first down both ways
      const list = [], q = [s];
      while (q.length && list.length < c.parallel) {
        const u = q.shift(), y = probe(u);
        if (y == null) continue;
        if (!list.includes(y)) list.push(y);
        q.push(after(u, y, true), after(u, y, false));
      }
      want(list.map(pt));
      const [N, k] = pt(x);
      if (o.tried) o.tried(N, R2(k));
      s = after(s, x, (await at(N, k).t.promise).ok);
    }
    return s.lo;
  };
  const g0 = Math.round(c.kMin * 20), g1 = Math.round(c.kMax * 20);
  try {
    const N0 = c.N != null ? Math.max(W, Math.round(c.N)) : null, k0 = c.k ?? (c.kOne ? 1 : null);
    if (N0 != null && k0 != null) return await result(N0, k0);
    if (N0 != null) {
      const g = await search(g0, g1, false, g => [N0, g / 20]);
      return g < g0 ? await result(N0, c.kMin, false) : g === g1 ? await result(N0, c.kMax, false) : await result(N0, g / 20, true);
    }
    const k = k0 ?? 1, nMax = Math.max(W, Math.min(c.nMax, (sh.max ?? Infinity) * W, c.capped ? c.waveMax * W : Infinity)), lo = Math.min(nMax, nMinOf(W));
    let n = await search(lo, nMax, true, N => [N, k]);
    // too few even with nMax: the next stronger monster on the ladder, while there is one and it is not too much
    // even at the fewest (then back to the one before, which goes by k below)
    while (c.k == null && n >= nMax && rung < rungs.length - 1) {
      climb(rung + 1);
      n = await search(lo, nMax, true, N => [N, k]);
      if (n < lo) { climb(rung - 1); n = nMax; break; }
    }
    if (n >= lo && n < nMax) return await result(n, k, true);
    if (k0 != null) return await result(n < lo ? lo : nMax, k, false);
    if (n < lo) {  // too much even at the fewest: weaker
      const g = await search(g0, 19, false, g => [lo, g / 20]);
      return g < g0 ? await result(lo, c.kMin, false) : await result(lo, g / 20, true);
    }
    // too little even with nMax: stronger
    const g = await search(21, g1, false, g => [nMax, g / 20]);
    return g === g1 ? await result(nMax, c.kMax, false) : await result(nMax, g < 21 ? 1 : g / 20, true);
  } finally { want([]); }
}
// The map for party at stage (0, 1, 2, …: the phase is stage % 3): the theme nearest the party's level (of those
// as near, one by chance: rnd) with what the phase's shapes need, sized (size) for the phase's win by how many
// monsters only, k held at 1 (by request: another map rather than monsters stronger or weaker than mob_db's); one
// that cannot be (the party too strong even for nMax, or too weak for the fewest), the next nearest, and so on.
// First with at most waveMax a wave (by request: a harder map from stronger monsters, not more of them): a theme
// too easy even so passes the turn to those of a higher level only; then, none fitting, as many as nMax. None at all, the nearest the same way with a plain shape (FALLBACK), the plan then marked `fallback`. Only when
// no theme fits with k at 1 does k go by size's search too, the same way round (phase's shapes, then FALLBACK),
// and if that cannot be either, the one nearest the win.
// o (all of it optional; the map panel's): rnd; phase (index into PHASES, in place of the stage's); win and
// spike (in place of the phase's); shape (one of SHAPES, in place of the phase's); theme (a theme's id: that one
// only, its plan taken whether it fits or not; a map id, as one was before: that map's nearest the party's level);
// rank (theme → a number, or null: the themes it ranks tried first, lowest first, in place of the nearest; bench/
// chain.mjs's, for a chain of many monsters), trying (told of each theme as it is tried), skip (theme ids not to
// try); income (what its loot is worth, in place of incomeOf's: the plan's drop goes by it); floorOf (theme → the
// floor it is fought on, in place of one by chance: a chain's, always the same); size's (waves, N, k,
// tried, income, DEFAULTS').
// → a promise of { stage, phase, theme, shape, spike, win, lull, N, W, sizes, k, mob, wins, runs, fits, waves (monster
//   defs, scaled), income, drop (levels.dropFor), fallback } or null
// A level chain's map (bench/chain.mjs: one of a chain.json's maps, its monsters as ids, one scaled by k as id@k)
// as a plan as planMap gives one, fought at its level: the chain's maps are fixed, sized for its base party (by
// request: the sandbox's 基準關卡 and the 關卡模擬 tab play them). wins and runs are the base party's validation,
// on the floor it keeps (m.floor: the index of one of its map's, null for flat); one from before chains kept their
// floor was made on the flat floor, and is fought on one of its map's, always the same for that level. A level's
// harder map (m.hard, variant 'hard') is one of these too: the plan's `hard`.
let byId = null;
export function chainPlan(m) {
  byId ??= new Map(db.mobs.map(d => [d.id, d]));
  const waves = m.waves.map(w => w.map(x => { const [id, k] = String(x).split('@'), d = byId.get(+id); return k ? scaled(d, +k) : d; }));
  const boss = m.shape === 'boss' ? waves[waves.length - 1][0] : null;
  return { stage: m.level - 1, phase: PHASES.find(p => p.name === m.phase) || PHASES[(m.level - 1) % PHASES.length],
    theme: { id: `${m.map}@${m.level}`, map: m.map, label: m.label, level: m.level, boss: boss && { ...boss, id: String(boss.id).split('@')[0] } },
    shape: m.shape, spike: 0, win: m.win, lull: LULL_S, drop: m.drop ?? 1, N: m.sizes.reduce((a, b) => a + b, 0), W: m.sizes.length, sizes: m.sizes, k: m.k,
    mob: null, wins: Math.round(m.val.won * m.val.runs), runs: m.val.runs, ok: true, fits: true, waves, fallback: !!m.fallback, chain: m.level,
    income: m.income, par: m.val.T, hard: m.variant === 'hard',
    floor: 'floor' in m ? m.floor != null && floors[m.map]?.[m.floor] ? { map: m.map, i: m.floor, open: floors[m.map][m.floor].open } : null
      : floorOf(m.map, fixed(m.map + '@' + m.level)) };
}
const FALLBACK = ['mixed', 'swarm'];
export async function planMap(party, stage, o, fight) {
  const { rnd = Math.random } = o, c = { ...DEFAULTS, ...o }, pl = pool(fight, Math.max(1, c.parallel));
  const phase = PHASES[o.phase ?? stage % PHASES.length], lv = party.reduce((n, c) => n + c.blv, 0) / party.length;
  const win = o.win ?? phase.win, sp = o.spike ?? phase.spike, income = o.income ?? incomeOf(Math.round(lv), PHASES.indexOf(phase));
  const luck = new Map(themes().map(t => [t, rnd()])), near = (a, b) => Math.abs(a.level - lv) - Math.abs(b.level - lv) || luck.get(a) - luck.get(b);
  const order = o.theme ? themes().filter(t => t.id === o.theme || t.map === o.theme).sort(near).slice(0, 1)
    : [...themes()].filter(t => !(o.skip && o.skip.has(t.id))).sort(near);
  // the themes in turn: o.rank's first, the lowest it ranks of those not yet tried, asked again before each (what
  // it goes by may have changed meanwhile), then the rest nearest first; o.trying is told of each
  // (floor: the level of the highest theme too easy at waveMax a wave, those up to it passed over)
  let floor = -Infinity;
  function* inTurn() {
    const left = new Set(order);
    for (;;) {
      for (const t of left) if (t.level <= floor) left.delete(t);
      let best = null, r0 = Infinity;
      if (o.rank && !o.theme) for (const t of left) { const r = o.rank(t); if (r != null && r < r0) { best = t; r0 = r; } }
      best ??= order.find(t => left.has(t));
      if (!best) return;
      left.delete(best);
      if (o.trying) o.trying(best);
      yield best;
    }
  }
  const off = r => Math.abs(r.wins / r.runs - win);
  // the first theme and shape (in order) that fits, else the one nearest the win (marked nearest); kOne: k at 1
  const look = async (shapes, kOne, capped) => {
    let best = null;
    floor = -Infinity;
    for (const theme of inTurn()) {
      const ground = o.floorOf ? o.floorOf(theme) : floorOf(theme.map, rnd);
      for (const shape of shapes) {
        if (!SHAPES[shape].make(theme)) continue;
        const s = await size(shape, theme, win, sp, { ...o, income, floor: ground, ...(kOne && { kOne }), ...(capped && { capped }) }, pl), make = SHAPES[shape].make(theme, s.mob);
        const waves = make(s.sizes).map(w => w.map(d => scaled(d, s.k)));
        const plan = { stage, phase, theme, shape, spike: sp, win, lull: c.lull, ...s, waves, income, drop: dropFor(waves, income), fallback: false, floor: ground };
        if (s.fits) return plan;
        if (capped && s.ok) { floor = Math.max(floor, theme.level); break; }  // (too easy: higher ones)
        if (!best || off(s) < off(best)) best = plan;
      }
    }
    return best && { ...best, nearest: true };
  };
  const shapes = o.shape ? [o.shape] : [...phase.shapes].sort(() => rnd() - 0.5);
  const others = o.shape ? [] : FALLBACK.filter(x => !phase.shapes.includes(x));
  let near1 = null;
  // (at waveMax a wave first, k at 1; then as many as nMax; then k free too)
  const passes = o.k != null ? [[false, false]] : [...(o.theme || o.N != null ? [] : [[true, true]]), [true, false], [false, false]];
  for (const [kOne, capped] of passes) {
    const plan = await look(shapes, kOne, capped);
    if (plan && !plan.nearest) return plan;
    // (a theme given: its plan taken, fitting or not, the phase's shape kept while it has one)
    const other = others.length && !(o.theme && plan) ? await look(others, kOne, capped) : null;
    if (other && !other.nearest) return { ...other, fallback: true };
    if (!kOne) return plan || (other && { ...other, fallback: true }) || near1;
    if (!capped) near1 = plan || (other && { ...other, fallback: true });
  }
  return near1;
}
