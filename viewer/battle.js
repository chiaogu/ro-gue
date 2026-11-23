// Character stats and battle formulas (renewal). No DOM here, so a game engine can reuse it as is.
//
// The client has none of this: the server computes every number and the client only shows what it is
// sent (and the exe is packed). Formulas follow rAthena's renewal build (src/map/status.cpp,
// battle.cpp, pc.cpp; function names are noted on each piece) with its default battle config. Job tables
// come from viewer/jobs.json (scripts/jobdb.py). rAthena mirrors C integer maths: `/` on ints truncates,
// so every such division here is wrapped in idiv/Math.trunc.
//
// Covered so far: player with a weapon (its ATK, MATK and weapon level; no other equipment), normal (auto) attacks between a player and a monster (both
// ways), weapon and magic skills listed in SKILLS, Double Attack, monster AI types as behaviour flags, natural regen.

import { rnd as fightRnd } from './rng.js';

export const STATS = ['str', 'agi', 'vit', 'int', 'dex', 'luk'];
export const ELEMENTS = ['Neutral', 'Water', 'Earth', 'Fire', 'Wind', 'Poison', 'Holy', 'Dark', 'Ghost', 'Undead'];
export const SIZES = ['Small', 'Medium', 'Large'];

const idiv = (a, b) => Math.trunc(a / b);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- status points ----------

// points needed to raise a stat from v to v + 1 (pc.cpp PC_STATUS_POINT_COST, RENEWAL_STAT)
export function statCost(v) {
  return v < 100 ? 2 + idiv(v - 1, 10) : 16 + 4 * idiv(v - 100, 5);
}
// points spent to take every stat from 1 to its value
export function pointsSpent(base) {
  let n = 0;
  for (const s of STATS) for (let v = 1; v < base[s]; v++) n += statCost(v);
  return n;
}
// total points at a base level (statpoint.yml; transcendent and primary 4th jobs get 52 more)
export function pointsTotal(db, job, baseLv) {
  return db.statPoints[baseLv - 1] + job.extraPoints;
}

// ---------- player ----------

// weapon types that shoot or lash from afar: their base ATK swaps STR and DEX (status_base_atk) and their
// ASPD weighs DEX less (status_base_amotion_pc)
export const RANGED = new Set(['Bow', 'Musical', 'Whip', 'Revolver', 'Rifle', 'Gatling', 'Shotgun', 'Grenade']);

// ch = { job (jobs.json entry), baseLv, jobLv, base: {str, ...} (points put in, 1..maxStat),
//        weapon: { type (item_db SubType, 'Fist' bare hands), range } (optional: bare hands),
//        buffs: [{ name (a BUFF_SKILLS skill), lv }] (optional: the statuses on the character),
//        passives: { skill: level } (optional: the passive skills learned),
//        cursed (optional: SC_CURSE on it: LUK 0, status_calc_luk, and a walk 300% slower, status_calc_speed),
//        cards (optional: what the cards on it add up to, cards.js cardBonus; by request, the game's cards) }
// The cards' bonuses as rAthena's equipment ones (pc_bonus / pc_bonus2, renewal): stats with the job bonus; flat ATK as
// equipment ATK (eatk: hitDamage); MATK, DEF, MDEF, HIT, FLEE, critical, MaxHP / SP, ASPD and regen on their figures;
// the % on a race, element, size or class (cardfix) on the weapon's and equipment ATK; the % less taken with the
// passives' (subEle, subRace) and on the attacker's size and class (subSize, subClass).
const NO_CARDS = { stats: {}, eatk: 0, ematk: 0, matkRate: 0, atkRate: 0, def: 0, mdef: 0, hit: 0, flee: 0, flee2: 0, cri: 0, criRace: {},
  critAtk: 0, longAtk: 0, maxHp: 0, maxHpRate: 0, maxSp: 0, maxSpRate: 0, aspd: 0, aspdRate: 0, hpRecov: 0, spRecov: 0, varCast: 0, spCut: 0,
  delayCut: 0, addRace: {}, addEle: {}, addSize: {}, addClass: {}, magicAddRace: {}, magicAddEle: {}, magicAddSize: {}, magicAddClass: {},
  magicAtkEle: {}, skillAtk: {}, subEle: {}, subRace: {}, subSize: {}, subClass: {}, defEle: null, atkEle: null, noSizeFix: false };
const summed = (a, b) => { const o = { ...a }; for (const [k, n] of Object.entries(b)) o[k] = (o[k] || 0) + n; return o; };
const any = o => Object.keys(o).length > 0;
export function playerStatus(db, ch) {
  const q = ch.cards || NO_CARDS;
  const { job, baseLv: lv } = ch, weapon = ch.weapon || { type: 'Fist', range: 1 }, ranged = RANGED.has(weapon.type);
  const jobBonus = job.bonus[clamp(ch.jobLv, 1, job.maxJob) - 1];
  // the stats' bonus: the job's, and what passive skills add (status_calc_pc: "absolute modifiers from passive
  // skills", on the base status with the job bonus, so a status' % goes on them too)
  const bonus = Object.fromEntries(STATS.map((s, i) => [s, jobBonus[i]]));
  for (const [name, lv] of Object.entries(ch.passives || {}))
    if (lv > 0 && PASSIVE_SKILLS[name] && PASSIVE_SKILLS[name].stats)
      for (const [s, n] of Object.entries(PASSIVE_SKILLS[name].stats(lv))) bonus[s] += n;
  // (and the cards': equipment's param_bonus)
  for (const [s, n] of Object.entries(q.stats)) bonus[s] += n;
  const st = {};
  STATS.forEach(s => { st[s] = ch.base[s] + bonus[s]; });
  // a status on the character changes its stats before anything else is worked out from them
  // (status_calc_pc runs status_calc_agi and its like, then status_calc_misc)
  // in status.cpp's order (BUFF_SKILLS lists them so): Improve Concentration's % is of the stat before
  // Increase AGI or Blessing add theirs
  const buffs = Object.keys(BUFF_SKILLS).flatMap(name => (ch.buffs || []).filter(b => b.name === name));
  for (const b of buffs) Object.assign(st, BUFF_SKILLS[b.name].stats(st, b.lv, b));
  if (ch.cursed) st.luk = 0;
  // (a figure may go by the status itself as well as its level: b.self, one the user put on itself)
  const more = key => buffs.reduce((n, b) => n + (BUFF_SKILLS[b.name][key] ? BUFF_SKILLS[b.name][key](b.lv, b) : 0), 0);
  const { str, agi, vit, dex, luk } = st, int_ = st.int;
  const perfect = buffs.some(b => BUFF_SKILLS[b.name].perfect);
  const subEle = {};
  for (const [name, l] of Object.entries(ch.passives || {}))
    if (l > 0 && PASSIVE_SKILLS[name] && PASSIVE_SKILLS[name].subEle)
      for (const [e, n] of Object.entries(PASSIVE_SKILLS[name].subEle(l))) subEle[e] = (subEle[e] || 0) + n;
  for (const b of buffs) if (BUFF_SKILLS[b.name].subEle) for (const [e, n] of Object.entries(BUFF_SKILLS[b.name].subEle(b.lv))) subEle[e] = (subEle[e] || 0) + n;
  for (const [e, n] of Object.entries(q.subEle)) subEle[e] = (subEle[e] || 0) + n;
  // (the % more damage on a race and less from it, of its passives: Dragonology's addrace, magic_addrace, subrace)
  // (and of its statuses: Resistant Souls' subrace)
  const byRace = key => {
    const o = {};
    for (const [name, l] of Object.entries(ch.passives || {}))
      if (l > 0 && PASSIVE_SKILLS[name] && PASSIVE_SKILLS[name][key]) for (const [r, n] of Object.entries(PASSIVE_SKILLS[name][key](l))) o[r] = (o[r] || 0) + n;
    for (const b of buffs) if (BUFF_SKILLS[b.name][key]) for (const [r, n] of Object.entries(BUFF_SKILLS[b.name][key](b.lv))) o[r] = (o[r] || 0) + n;
    return o;
  };
  // (the cards' magic_addrace and subrace with them: the same tables)
  const addRace = byRace('addRace'), magicAddRace = summed(byRace('magicAddRace'), q.magicAddRace), subRace = summed(byRace('subRace'), q.subRace);
  // (the element's % up of its statuses: the element fields', battle_attr_fix)
  const attrUp = fieldUp(buffs);
  // (the % more magic of an element of its statuses: the endows', magic_atk_ele)
  const magicAtkEle = {};
  for (const b of buffs) if (BUFF_SKILLS[b.name].magicEle) for (const [e, n] of Object.entries(BUFF_SKILLS[b.name].magicEle(b.lv))) magicAtkEle[e] = (magicAtkEle[e] || 0) + n;
  for (const [e, n] of Object.entries(q.magicAtkEle)) magicAtkEle[e] = (magicAtkEle[e] || 0) + n;

  // status_base_atk (BL_PC; bows, instruments, whips and guns swap STR and DEX)
  const [main, sub] = ranged ? [dex, str] : [str, dex];
  // (plus the statuses' flat status ATK: status_calc_batk)
  const batk0 = idiv(main * 10 + idiv(sub * 10, 5) + idiv(luk * 10, 3) + idiv(lv * 10, 4), 10) + more('batk');
  const batk = batk0 + idiv(batk0 * more('batkRate'), 100);  // (The Ring of Nibelungen's 20%: status_calc_batk)
  // status_base_matk_min/max (equal for players)
  // (plus the statuses' flat MATK: status_calc_pseudobuff_matk, renewal)
  // (and the cards' equipment MATK: sd->bonus.ematk)
  const matk = int_ + idiv(int_, 2) + idiv(dex, 5) + idiv(luk, 3) + idiv(lv, 4) + more('matk') + q.ematk;
  // status_calc_misc
  const hit = lv + dex + idiv(luk, 3) + 175 + more('hit') + q.hit;  // status_calc_hit adds the statuses' HIT (the cards' on the base)
  // (plus Improve Dodge's FLEE: an absolute modifier from a passive skill, status_calc_pc)
  const passiveFlee = Object.entries(ch.passives || {}).reduce((n, [name, l]) => n + (l > 0 && PASSIVE_SKILLS[name] && PASSIVE_SKILLS[name].flee ? PASSIVE_SKILLS[name].flee(l, job) : 0), 0);
  const flee = lv + agi + idiv(luk, 5) + 100 + passiveFlee + more('flee') + q.flee;
  // soft DEF, plus what a status adds (Angelus: status_calc_def2)
  const def2 = Math.trunc((lv + vit) / 2 + agi / 5) + buffs.reduce((n, b) => n + (BUFF_SKILLS[b.name].def2 ? BUFF_SKILLS[b.name].def2(b.lv, st) : 0), 0);
  const mdef2 = Math.trunc(int_ + lv / 4 + (dex + vit) / 5);  // soft MDEF
  // tenths of a percent (status_calc_critical adds the statuses', Cloaking doubling them); twice that with a katar
  // (status_calc_bl_, after it)
  const cloak = (ch.buffs || []).find(b => b.name === 'AS_CLOAKING');
  // (plus a mastery's for the weapon held: Mace Mastery's, status_calc_pc)
  const passiveOf = key => Object.entries(ch.passives || {}).reduce((n, [name, l]) => n + (l > 0 && PASSIVE_SKILLS[name] && PASSIVE_SKILLS[name][key] ? PASSIVE_SKILLS[name][key](l) : 0), 0);
  const masteryCri = Object.entries(MASTERY).reduce((n, [k, m]) => n + (m.cri && m.weapons.includes(weapon.type) ? m.cri * ((ch.passives || {})[k] || 0) : 0), 0);
  // (the cards' with them: status->cri, doubled with the rest)
  const cri = (10 + luk * 3 + idiv(lv, 10) + masteryCri + passiveOf('cri') + more('cri') + q.cri) * (cloak ? 2 : 1) * (weapon.type === 'Katar' ? 2 : 1);
  const flee2 = luk + 10 + more('flee2') + q.flee2;                                      // perfect dodge, tenths of a percent

  // status_base_amotion_pc (RENEWAL_ASPD) → status_calc_bl_: the base is an ASPD value, then
  // amotion = 2000 − ASPD × 10 (ms), capped at the job's max ASPD; players attack every 2 × amotion
  // The base is the job's for the weapon type (aspd_base; a type the job cannot use counts as bare hands).
  // A weapon in the left hand as well adds a quarter of its own (the first capped at 200 with it); a shield there, the
  // job's for a shield (aspd_base[MAX_WEAPON_TYPE]).
  const aspdOf = type => job.aspd[type] ?? job.aspd.Fist;
  const base = Math.min(aspdOf(weapon.type) + (ch.shield ? job.aspd.Shield || 0 : weapon.left ? idiv(aspdOf(weapon.left), 4) : 0), 200);
  // (+ the statuses' fixed ASPD × AGI / 200: status_base_amotion_pc with status_calc_aspd(true), Impressive Riff's)
  let aspdRaw = Math.trunc(Math.fround(Math.sqrt(dex * dex / (ranged ? 7 : 5) + agi * agi * 0.5) * 0.25) + 196 + more('aspdFixed') * agi / 200) - base;
  // RE ASPD % (status_calc_bl_ with status_calc_aspd(false)): + (195 − ASPD) × % / 100, at least 2 × %
  const aspdPct = more('aspd') + passiveOf('aspd') + q.aspdRate;  // (the cards' bAspdRate: status->aspd_rate2)
  if (aspdPct) aspdRaw += idiv(Math.max(195 - aspdRaw, 2) * aspdPct, 100);
  // an attack speed potion's cut (by request, pre-renewal's, not RE's ASPD + val1 × AGI / 200: status_calc_aspd_rate,
  // SC_ASPDPOTION0 / 1 val2 100 / 150 of 1000): the motion 10% / 15% shorter, within the same bounds; a skill's
  // (Two-Hand Quicken's 300, Adrenaline Rush's 300 on its user and 200 on the party: `quick`) the largest of them, the potion's on top of it (aspd_rate −= max, then −= the potion's)
  // (Impressive Riff's not with a bow: `noBow`; Slow Grace's on top, the other way: `slowAspd`)
  const most = key => buffs.reduce((n, b) => Math.max(n, BUFF_SKILLS[b.name][key] && !(BUFF_SKILLS[b.name].noBow && weapon.type === 'Bow') ? BUFF_SKILLS[b.name][key](b.lv, b) : 0), 0);
  // (and a passive's with its weapon: Study's 5 × Lv with a book, pre-renewal's aspd_rate, the client's 0.5% a level)
  const passiveCut = Object.entries(ch.passives || {}).reduce((n, [name, l]) => n + (l > 0 && PASSIVE_SKILLS[name] && PASSIVE_SKILLS[name].cut && (PASSIVE_SKILLS[name].weapons || []).includes(weapon.type) ? PASSIVE_SKILLS[name].cut(l) : 0), 0);
  const cut = most('quick') + most('cut') - more('slowAspd') + passiveCut;
  // riding a Peco (ch.riding: Riding learned and on), the same way (pre-renewal's base aspd_rate + 500 − 100 ×
  // Cavalier Mastery: the motion half as long again, as long as on foot at Lv 5; the client's description has
  // 60%–100% of the attack speed; not renewal's ASPD − (50 − 10 × Lv) × AGI / 200)
  const ride = ch.riding ? 500 - 100 * ((ch.passives || {}).KN_CAVALIERMASTERY || 0) : 0;
  // (the cards' bAspd: sd->bonus.aspd_add, 10 a point off the motion)
  const amotion = clamp(idiv((2000 - aspdRaw * 10 - 10 * q.aspd) * (1000 - cut + ride), 1000), 2000 - job.maxAspd * 10, 4000);
  // status_calc_speed: 150 ms a cell (DEFAULT_WALK_SPEED), less the largest movement haste of the statuses
  // (Improve Dodge's for the Assassin line: status_calc_speed, max with the statuses'). Pulling a cart (Pushcart
  // learned: see PASSIVE_SKILLS) first adds (50 − 5 × Lv) % to it (GetSpeed: pc_iscarton), the haste going on that.
  // A curse adds 300% (the largest slowdown of the statuses) before the haste comes off. Riding a Peco takes 25%
  // more off besides (GetMoveHasteValue2, apart from the statuses' GetMoveHasteValue1: the two add up).
  // Cloaking by a wall hastes 3 × Lv − 3 % (25 at Lv 10), away from one slows 30 − 3 × Lv % (300 below Lv 3), the
  // slowdowns' largest as the curse's (status_calc_speed)
  const cloakHaste = cloak && cloak.wall ? (cloak.lv >= 10 ? 25 : 3 * cloak.lv - 3) : 0;
  // In hiding with Stalk learned, 120 − 6 × Lv % in place of them all (GetMoveSlowValue: SC_HIDING with RG_TUNNELDRIVE)
  const stalk = (ch.buffs || []).some(b => b.name === 'TF_HIDING') ? (ch.passives || {}).RG_TUNNELDRIVE || 0 : 0;
  const slow = stalk ? 120 - 6 * stalk : Math.max(ch.cursed ? 300 : 0, cloak && !cloak.wall ? (cloak.lv < 3 ? 300 : 30 - 3 * cloak.lv) : 0, ...buffs.map(b => { const s = BUFF_SKILLS[b.name].slow || 0; return typeof s === 'function' ? s(b.lv, b) : s; }));
  const haste = Math.max(cloakHaste, buffs.reduce((n, b) => { const h = BUFF_SKILLS[b.name].haste || 0; return Math.max(n, typeof h === 'function' ? h(b.lv, b) : h); }, 0),
    ...Object.entries(ch.passives || {}).map(([name, l]) => l > 0 && PASSIVE_SKILLS[name] && PASSIVE_SKILLS[name].haste ? PASSIVE_SKILLS[name].haste(l, job) : 0),
    q.speedRate || 0);  // (a card's: bSpeedRate, the largest with the rest, status_calc_speed)
  const cart = (ch.passives || {}).MC_PUSHCART || 0;
  // (Mental Strength's 200 in place of all of it)
  // (Defending Aura's: 200 ms a cell at the quickest, status_calc_speed's max)
  const walkSpeed = buffs.some(b => BUFF_SKILLS[b.name].steel) ? 200 : (buffs.some(b => BUFF_SKILLS[b.name].plod) ? n => Math.max(n, 200) : n => n)(idiv((150 + (cart ? idiv(150 * (50 - 5 * cart), 100) : 0)) * (100 + slow - haste - (ch.riding ? 25 : 0)), 100));
  const aspd = (2000 - amotion) / 10;
  // status_calc_misc: the damage motion (pc_damage_delay_rate 100)
  // (none under Endure: status_calc_dmotion)
  const dmotion = buffs.some(b => BUFF_SKILLS[b.name].endure) ? 0 : clamp(800 - agi * 4, 400, 800);

  // status_calc_maxhp_pc / maxsp_pc
  const mult = job.upper ? 1.25 : 1;
  // (plus the statuses' flat MaxHP: status_get_hpbonus STATUS_BONUS_FIX)
  // (and the % of both: status_get_hpbonus / spbonus STATUS_BONUS_RATE; Song of Lutie's, the lessons', Gypsy's Kiss')
  // (the cards' flat and % with them: sd->bonus.hp / sp, hprate / sprate)
  const maxHp = Math.max(1, Math.trunc((Math.trunc(job.hp[lv - 1] * (1 + vit * 0.01) * mult) + more('maxHp') + passiveOf('maxHp') + q.maxHp) * (100 + more('maxHpRate') + q.maxHpRate) / 100));
  const maxSp = Math.max(1, Math.trunc((Math.trunc(job.sp[lv - 1] * (1 + int_ * 0.01) * mult) + q.maxSp) * (100 + more('maxSpRate') + passiveOf('maxSpRate') + q.maxSpRate) / 100));
  // status_calc_regen: natural regen every natural_healhp_interval / natural_healsp_interval (player.conf)
  // (the cards' % on them: hprecov_rate / sprecov_rate)
  // (a card's bNoRegen: 1 no HP regen, 2 no SP regen)
  const hpRegen = q.noRegen & 1 ? 0 : idiv((idiv(vit, 5) + Math.max(1, idiv(maxHp, 200))) * (100 + q.hpRecov), 100);
  const spRegen = q.noRegen & 2 ? 0 : idiv((1 + idiv(int_, 6) + idiv(maxSp, 100) + (int_ >= 120 ? idiv(int_ - 120, 2) + 4 : 0)) * (100 + q.spRecov), 100);

  return {
    kind: 'pc', lv, stats: st, bonus,
    // (spRate: the % of the natural SP regen's pace, raised by a status: status_calc_regen_rate, Magnificat's)
    maxHp, maxSp, hpRegen, spRegen, spRate: 100 + more('spRate'), hpRate: 100 + more('hpRate'), batk, matk, hit, flee, flee2, cri, perfectHit: q.perfectHit || 0, crate: more('crate'), patk: 0, jobLv: ch.jobLv,
    // (the weapon's element, from a status on it: Enchant Poison's; none, neutral)
    // (else a card's: bAtkEle)
    ...buffs.some(b => BUFF_SKILLS[b.name].ele) ? { ele: BUFF_SKILLS[buffs.find(b => BUFF_SKILLS[b.name].ele).name].ele } : q.atkEle && { ele: q.atkEle },
    // the weapon: its type, range, ATK, MATK and level (none: bare hands, or a look's weapon type alone), and its
    // damage on each size (size_fix.yml: sd->right_weapon.atkmods)
    weapon: weapon.type, range: weapon.range || 1, watk: weapon.atk || 0, wmatk: weapon.matk || 0, wlv: weapon.wlv || 0,
    // (and what the statuses add to its ATK, bare hands too: status_calc_watk, the right hand's only)
    watkUp: more('watk') + (weapon.wlv === 4 ? more('watk4') : 0),  // (Harmonic Lick's with a level 4 weapon only)
    // (the % the statuses take off a cast's variable time: castTime)
    varCast: more('varCast') + q.varCast,
    // (the % off a skill's delay, its SP, a status' odds, its MATK: Magic Strings', Gypsy's Kiss', Acoustic Rhythm's, the Ring's)
    delayCut: more('delayCut') + q.delayCut, spCut: more('spCut') + q.spCut, ailResist: more('ailResist'), matkRate: more('matkRate') + q.matkRate,
    // (the one in the left hand, of a dual-wield pair: its type, damage on each size, ATK and level; a look's alone, no ATK)
    ...weapon.left && { left: { weapon: weapon.left, atkmods: perfect ? [100, 100, 100] : (db.sizeFix || {})[weapon.left] || [100, 100, 100], watk: weapon.leftAtk || 0, wlv: weapon.leftWlv || 0 } },
    // (Maximize Power on: the weapon's ATK at the top of its spread, battle_calc_base_weapon_attack)
    maximize: buffs.some(b => BUFF_SKILLS[b.name].maximize),
    // (the statuses' ATK %, which renewal adds to the skill ratio of every attack: Power Thrust's,
    // battle_calc_attack_skill_ratio; atkBy names them, for the damage's steps)
    ...more('atkRate') && { atkRate: more('atkRate'), atkBy: buffs.filter(b => BUFF_SKILLS[b.name].atkRate).map(b => `${BUFF_SKILLS[b.name].name} +${BUFF_SKILLS[b.name].atkRate(b.lv, b)}%`) },
    // (the % of the damage of each element it takes less: Skin Tempering's, sd->indexed_bonus.subele)
    subEle, addRace, magicAddRace, subRace, magicAtkEle, attrUp,
    // (the cards': equipment ATK and its %, the cardfix of a weapon's attack, the magic one's besides the race, the critical
    // rate on a race, the critical and long range damage %, a skill's %, the % less from a size or a class)
    eatk: q.eatk, eqAtkRate: q.atkRate,
    ...(any(q.addRace) || any(q.addEle) || any(q.addSize) || any(q.addClass) || any(q.addRace2 || {}) || any(q.addMob || {})) &&
      { cardfix: { race: q.addRace, ele: q.addEle, size: q.addSize, cls: q.addClass, race2: q.addRace2 || {}, mob: q.addMob || {} } },
    // (the second batch's: % less from one monster, from long range; DEF of a class ignored, a share of MDEF)
    ...q.defMob && any(q.defMob) && { defMob: q.defMob }, ...q.longDef && { longDef: q.longDef },
    ...q.ignoreDef && any(q.ignoreDef) && { ignoreDef: q.ignoreDef }, ...q.defRatio && any(q.defRatio) && { defRatio: q.defRatio },
    // (the last ones: one skill's cast cut, a bow's normal critical, magic damage taken less)
    ...q.castSkill && any(q.castSkill) && { castSkill: q.castSkill }, ...q.critLong && { critLong: q.critLong }, ...q.noMagic && { noMagic: q.noMagic },
    ...more('healIn') && { healIn: more('healIn') }, ...q.ignoreMdef && any(q.ignoreMdef) && { ignoreMdef: q.ignoreMdef },
    ...(any(q.magicAddEle) || any(q.magicAddSize) || any(q.magicAddClass)) && { magicFix: { ele: q.magicAddEle, size: q.magicAddSize, cls: q.magicAddClass } },
    ...any(q.criRace) && { criRace: q.criRace }, ...q.critAtk && { critAtk: q.critAtk }, ...q.longAtk && { longAtk: q.longAtk },
    ...any(q.skillAtk) && { skillAtk: q.skillAtk }, ...q.resEff && any(q.resEff) && { resEff: q.resEff }, ...q.healPower && { healBonus: q.healPower }, ...any(q.subSize) && { subSize: q.subSize }, ...any(q.subClass) && { subClass: q.subClass },
    // (riding with a spear: on medium as on large, status_calc_pc; under Weapon Perfection all three whole:
    // battle_calc_sizefix's weapon_perfection)
    atkmods: perfect || q.noSizeFix ? [100, 100, 100] : ridingSpear(ch, weapon) ? (m => [m[0], m[2], m[2]])((db.sizeFix || {})[weapon.type] || [100, 100, 100]) : (db.sizeFix || {})[weapon.type] || [100, 100, 100],
    // (the shield's DEF and the body armour's (ch.armor: jobs.json armors, the game's), the only equipment's here; the
    // shield's weight, Shield Boomerang's: ch.shield, sim.js SHIELDS)
    // (a card's bDefRate / bMdefRate: the hard DEF / MDEF that % more, status_calc_pc def_rate)
    def: idiv((more('def') + (ch.shield ? ch.shield.def : 0) + (ch.armor ? ch.armor.def : 0) + q.def) * (100 + (q.defRate || 0)), 100), def2,
    mdef: idiv((more('mdef') + (ch.armor ? ch.armor.mdef : 0) + q.mdef) * (100 + (q.mdefRate || 0)), 100), mdef2, res: 0, aspd, amotion, adelay: 2 * amotion, dmotion, walkSpeed,
    ...ch.shield && { shieldWeight: ch.shield.weight },
    // (a status' armour element, else a card's: bDefEle)
    size: 'Medium', element: buffs.map(b => BUFF_SKILLS[b.name].armor).find(Boolean) || q.defEle || 'Neutral', elementLv: 1,
    // (a player's race: RC_DEMIHUMAN, besides RC_PLAYER_HUMAN — what a card's on Demihuman goes by, as the rival team's
    // characters hit one another)
    race: 'Demihuman',
  };
}

const ridingSpear = (ch, weapon) => ch.riding && (weapon.type === '1hSpear' || weapon.type === '2hSpear');

// ---------- monster ----------

// Monster behaviour bits (rAthena e_mode, doc/mob_db_mode_list.txt)
export const MD = {
  CANMOVE: 0x1, LOOTER: 0x2, AGGRESSIVE: 0x4, ASSIST: 0x8, CASTSENSORIDLE: 0x10, NORANDOMWALK: 0x20,
  NOCAST: 0x40, CANATTACK: 0x80, CASTSENSORCHASE: 0x200, CHANGECHASE: 0x400, ANGRY: 0x800,
  CHANGETARGETMELEE: 0x1000, CHANGETARGETCHASE: 0x2000, TARGETWEAK: 0x4000, RANDOMTARGET: 0x8000,
  DETECTOR: 0x2000000,  // sees units in hiding (status_check_visibility)
};
// Aegis AI type (mob_db Ai) → mode bits (e_aegis_monstertype in mob.hpp)
export const AI_MODES = {
  '01': 0x0081, '02': 0x0083, '03': 0x1089, '04': 0x3885, '05': 0x2085, '06': 0x0000, '07': 0x108B, '08': 0x7085,
  '09': 0x3095, '10': 0x0084, '11': 0x0084, '12': 0x2085, '13': 0x308D, '17': 0x0091, '19': 0x3095, '20': 0x3295,
  '21': 0x3695, '24': 0x00A1, '25': 0x0001, '26': 0xB695, '27': 0x8084, 'Abr_Passive': 0x0021, 'Abr_Offensive': 0x00A5,
};
const MODE_NAMES = { CanMove: MD.CANMOVE, Looter: MD.LOOTER, Aggressive: MD.AGGRESSIVE, Assist: MD.ASSIST,
  CastSensorIdle: MD.CASTSENSORIDLE, NoRandomWalk: MD.NORANDOMWALK, NoCast: MD.NOCAST, CanAttack: MD.CANATTACK,
  CastSensorChase: MD.CASTSENSORCHASE, ChangeChase: MD.CHANGECHASE, Angry: MD.ANGRY,
  ChangeTargetMelee: MD.CHANGETARGETMELEE, ChangeTargetChase: MD.CHANGETARGETCHASE, TargetWeak: MD.TARGETWEAK,
  RandomTarget: MD.RANDOMTARGET, Detector: MD.DETECTOR };
// what the AI type and the extra Modes (mob_db 'Modes', which add to the type) switch on
export const mobMode = m => (AI_MODES[m.ai] ?? 0) | (m.modes || []).reduce((b, k) => b | (MODE_NAMES[k] || 0), 0);

// m = a mob_db.yml entry (jobs.json 'mobs': level, hp, atk, def, str.., size, element, walkSpeed, ai ...)
export function mobStatus(m) {
  const lv = m.level, st = Object.fromEntries(STATS.map(s => [s, m[s] || 0]));
  return {
    kind: 'mob', lv, stats: st,
    maxHp: m.hp || 1,
    // renewal (status_calc_bl_ → status_base_atk_min/max, status_base_atk): mob_db Attack varies from 80%
    // to 120%, and base ATK is STR + level (enable_baseatk_renewal includes monsters)
    atkMin: Math.trunc((m.atk || 0) * 80 / 100), atkMax: Math.trunc((m.atk || 0) * 120 / 100), batk: st.str + lv,
    // renewal status_base_matk_min / max: INT + level + mob_db Attack2 (its weapon MATK) × 70% to 130%; what
    // reads MATK through status_base_matk (Heal's part) adds that weapon MATK once more (no variance: weapon level 0)
    matkMin: st.int + lv + idiv((m.matk || 0) * 70, 100), matkMax: st.int + lv + idiv((m.matk || 0) * 130, 100), wmatk: m.matk || 0,
    hit: lv + st.dex + 150,
    flee: lv + st.agi + 100,
    cri: 0,  // enable_critical: players and mercenaries only
    def: m.def || 0, def2: Math.trunc((lv + st.vit) / 2),
    mdef: m.mdef || 0, mdef2: Math.trunc((st.int + lv) / 4),
    res: m.res || 0,
    flee2: 0,  // enable_perfect_flee: players only
    size: m.size || 'Medium', element: m.element || 'Neutral', elementLv: m.elementLv || 1, race: m.race || 'Formless',
    race2: m.race2 || null, mobId: m.id != null ? +String(m.id).split('@')[0] : null,  // (its race groups and its id: the cards')
    mode: mobMode(m),
    // Boss class (not MVPs alone): immune to statuses and knockback (MobDatabase::loadingFinished)
    boss: m.class === 'Boss',
    range: m.range || 0, viewRange: m.range2 || 0, chaseRange: m.chase || 0,
    walkSpeed: m.walkSpeed || 150, adelay: m.attackDelay || 0, amotion: m.attackMotion || 0, dmotion: m.damageMotion || 0,
  };
}

// A homunculus h (jobs.json homuns) at level lv, as rAthena renewal works it out (status_calc_homunculus_,
// status_calc_misc and status_base_atk / _matk for BL_HOM), in mobStatus' shape (its attack as a monster's: kind 'mob').
// Its stats: homunculus_db Base, then each level up one more growth between GrowthMinimum and GrowthMaximum, in
// tenths (hom_levelup; HP and SP whole) — here the middle of the two each level (by choice: no level-up dice). Each
// counts lv / 10 more for what is worked out of it (HOMUN_LEVEL_STATWEIGHT, status_get_homstr…), not HIT's DEX.
// Not critical (enable_critical), MATK's least its most (hom_setting 0x20), its attack delay its motion
// (AttackDelay − AttackDelay × DEX / 1000 − AGI × AttackDelay / 250, RENEWAL_ASPD), damage motion 800 − 4 × AGI
// (400 to 800), its range 1 + size, walking as its master does (hom_setting 0x08: walkSpeed, given).
// o: evolved (hom_evolution: once, each stat + the middle of its EvolutionMinimum–Maximum, by choice: no dice, as its
// growth), its skills' levels (`levels`: the passives, status_calc_homunculus_ — Adamantium Skin DEF + 4 × Lv and
// MaxHP + 2 × Lv %, Instruction Change INT and STR up, Brain Surgery MaxSP + Lv %, and Heal + 2 × Lv %,
// skill_calc_heal's hp_bonus) and the statuses on it (`sc`, [{ name, lv }]: its own skills', HOMUN_BUFFS)
const INSTRUCT_INT = [1, 2, 2, 4, 5], INSTRUCT_STR = [1, 1, 3, 4, 4];
export function homunStatus(h, lv, walkSpeed = 150, o = {}) {
  const grown = ([base, lo, hi], whole) => whole ? base + idiv((lv - 1) * (lo + hi), 2) : idiv(base * 10 + idiv((lv - 1) * (lo + hi), 2), 10);
  const evo = k => o.evolved && h.evoStats && h.evoStats[k] ? idiv(h.evoStats[k][0] + h.evoStats[k][1], 2) : 0;
  const key = k => k[0].toUpperCase() + k.slice(1);
  const st = Object.fromEntries(STATS.map(k => [k, grown(h.stats[key(k)] || [1, 0, 0]) + evo(key(k))]));
  const has = n => (o.levels || {})[n] || 0, on = n => (o.sc || []).find(x => x.name === n);
  if (has('HVAN_INSTRUCT')) { st.int += INSTRUCT_INT[has('HVAN_INSTRUCT') - 1]; st.str += INSTRUCT_STR[has('HVAN_INSTRUCT') - 1]; }
  // (Mental Change: VIT + 30 × Lv, INT + 20 × Lv, status_calc_vit / int_)
  const change = on('HLIF_CHANGE');
  if (change) { st.vit += 30 * change.lv; st.int += 20 * change.lv; }
  const w = idiv(lv, 10), [str, agi, vit, int, dex, luk] = STATS.map(k => st[k] + w);
  // (Flitting: its attack motion 30 × Lv of 1000 shorter, status_calc_aspd_rate, and ATK + 5 + 5 × Lv %; Bloodlust's
  // ATK + 20 + 10 × Lv %: battle_get_atkpercent)
  const fleet = on('HFLI_FLEET'), lust = on('HAMI_BLOODLUST');
  const amotion = clamp(idiv((h.aspd - idiv(h.aspd * dex, 1000) - idiv(agi * h.aspd, 250)) * (1000 - (fleet ? 30 * fleet.lv : 0)), 1000), 100, 8000);
  const matk = int + lv + idiv(luk + int + dex, 3);
  const atkBy = [...fleet ? [`急速飛行 +${5 + 5 * fleet.lv}%`] : [], ...lust ? [`嗜血 +${20 + 10 * lust.lv}%`] : []];
  const atkRate = (fleet ? 5 + 5 * fleet.lv : 0) + (lust ? 20 + 10 * lust.lv : 0);
  // (Amistr Bulwark on it: DEF + 5 + 5 × Lv, renewal, status_calc_def; Accelerated Flight: FLEE + 10 + 10 × Lv; Urgent
  // Escape: walking 40 × Lv % faster, status_calc_speed, MIN_WALK_SPEED at the quickest)
  const bulwark = on('HAMI_DEFENCE'), speed = on('HFLI_SPEED'), avoid = on('HLIF_AVOID');
  const maxHp = grown(h.stats.Hp, true) + evo('Hp'), maxSp = grown(h.stats.Sp, true) + evo('Sp');
  return {
    kind: 'mob', lv, stats: st, homun: true,
    maxHp: maxHp + idiv(2 * has('HAMI_SKIN') * maxHp, 100), maxSp: maxSp + idiv(has('HLIF_BRAIN') * maxSp, 100),
    atkMin: idiv(str + dex, 5), atkMax: idiv(luk + str + dex, 3), batk: 2 * lv + str,
    matkMin: matk, matkMax: matk, wmatk: 0,
    hit: lv + st.dex + 150, flee: lv + agi + (speed ? 10 + 10 * speed.lv : 0), cri: 0, flee2: 0,
    def: vit + idiv(lv, 2) + 4 * has('HAMI_SKIN') + (bulwark ? 5 + 5 * bulwark.lv : 0), def2: vit + idiv(agi, 2),
    mdef: Math.trunc((vit + lv) / 4 + int / 2), mdef2: idiv(vit + int, 2), res: 0,
    size: h.size, element: h.element, elementLv: 1, race: h.race,
    mode: MD.CANMOVE | MD.CANATTACK, boss: false,
    range: 1 + SIZES.indexOf(h.size), viewRange: 14, chaseRange: 14,  // (AREA_SIZE)
    walkSpeed: avoid ? Math.max(20, idiv(walkSpeed * (100 - 40 * avoid.lv), 100)) : walkSpeed,
    adelay: amotion, amotion, dmotion: clamp(800 - 4 * st.agi, 400, 800),
    // (natural regen as status_calc_regen's: 1 + VIT / 5 + MaxHP / 200 HP, 1 + INT / 6 + MaxSP / 100 SP, Adamantium
    // Skin's + 5 × Lv % and Brain Surgery's + 3 × Lv % on them: see sim.js homunRegen)
    hpRegen: idiv((1 + idiv(vit, 5) + idiv(maxHp, 200)) * (100 + 5 * has('HAMI_SKIN')), 100),
    spRegen: idiv((1 + idiv(int, 6) + idiv(maxSp, 100)) * (100 + 3 * has('HLIF_BRAIN')), 100),
    healBonus: 2 * has('HLIF_BRAIN'),
    // (Mental Change: its normal attack from its MATK, as magic: battle_calc_base_damage BDMG_MAGIC)
    ...change && { magicHit: true },
    ...atkRate && { atkRate, atkBy },
  };
}
// the statuses a homunculus's own skills put on it, worked into homunStatus (sim.js homunRecalc)
export const HOMUN_BUFFS = ['HLIF_AVOID', 'HLIF_CHANGE', 'HAMI_DEFENCE', 'HAMI_BLOODLUST', 'HFLI_FLEET', 'HFLI_SPEED'];

// A monster's own buffs (status_calc_bl_ for a mob; sc: the statuses on it, [{ name, lv }]) on its figures b
// (amotion, adelay, walkSpeed, hit, flee, def, as mobStatus gives them):
// - ASPD (status_calc_aspd_rate): its aspd_rate (1000) less the largest cut of its statuses — Two-Hand Quicken's
//   300 (+20 a level over 10), Adrenaline Rush's 300 (on itself) — on its attack motion; its attack delay the same
//   but never above 1000 nor below the motion (cap_value with AMOTION_DIVIDER_NOPC 1, MIN_ASPD 8000)
// - HIT: Two-Hand Quicken + 2 × Lv, Adrenaline Rush + 3 × Lv + 5 (status_calc_hit)
// - Agility Up (NPC_AGIUP: sc_start2 val1 50, val2 100): walks 50% faster (status_calc_speed: speed × (100 − 50)
//   / 100), FLEE + 100% (status_calc_flee)
// - Keeping (NPC_KEEPING): hard DEF 90 (status_calc_def)
const FIELD_UP = [10, 14, 17, 19, 20];
// the element fields' attrUp of statuses `sc` (a character's or a monster's)
export function fieldUp(sc) {
  const up = {};
  for (const b of sc) if (BUFF_SKILLS[b.name] && BUFF_SKILLS[b.name].attrUp) for (const [e, n] of Object.entries(BUFF_SKILLS[b.name].attrUp(b.lv))) up[e] = (up[e] || 0) + n;
  return up;
}
export const MOB_BUFFS = ['KN_TWOHANDQUICKEN', 'BS_ADRENALINE', 'NPC_AGIUP', 'NPC_KEEPING', 'DC_DONTFORGETME', 'SA_VOLCANO', 'SA_VIOLENTGALE'];
export function mobBuffed(b, sc) {
  const on = n => sc.find(x => x.name === n), quick = on('KN_TWOHANDQUICKEN'), adr = on('BS_ADRENALINE');
  const rate = 1000 - Math.max(quick ? 300 + (quick.lv > 10 ? 20 * (quick.lv - 10) : 0) : 0, adr ? 300 : 0);
  const amotion = clamp(idiv(b.amotion * rate, 1000), 100, 8000);
  const adelay = clamp(idiv(b.adelay * Math.min(rate, 1000), 1000), amotion, 8000);
  const hit = b.hit + (quick ? 2 * quick.lv : 0) + (adr ? 3 * adr.lv + 5 : 0);
  const agi = on('NPC_AGIUP');
  // (Slow Grace: walks its v2 % slower, status_calc_speed, pre-renewal: see BUFF_SKILLS; its ASPD cut is for players only,
  // status_calc_aspd_rate)
  const grace = on('DC_DONTFORGETME');
  // (a monster in Volcano: base ATK + 5 + 5 × Lv, status_calc_batk; in Violent Gale FLEE + 3 × Lv; Deluge's MaxHP not
  // given a monster here)
  const vol = on('SA_VOLCANO'), gale = on('SA_VIOLENTGALE');
  return { amotion, adelay, hit, flee: (agi ? b.flee * 2 : b.flee) + (gale ? 3 * gale.lv : 0), batk: b.batk + (vol ? 5 + 5 * vol.lv : 0), walkSpeed: grace ? idiv(b.walkSpeed * (100 + (grace.v2 || 0)), 100) : agi ? idiv(b.walkSpeed * 50, 100) : b.walkSpeed,
           def: on('NPC_KEEPING') ? 90 : b.def };
}
// Auto Guard (SC_AUTOGUARD, battle_calc_damage): the % of weapon attacks it blocks at level lv — 5 for each of
// the first two levels, 4 for the next two, 3, 2, then 1 (val2 = Σ max(5 − i / 2, 1))
export const guardRate = lv => Array.from({ length: lv }, (_, i) => Math.max(5 - idiv(i, 2), 1)).reduce((a, b) => a + b, 0);
// Reflect Shield (SC_REFLECTSHIELD): the % of a short-range weapon attack's damage sent back (10 + 3 × Lv)
export const reflectRate = lv => 10 + 3 * lv;

// ---------- normal attack ----------

// element table (attr_fix.yml): damage % of attack element against defence element at a level
export function attrRatio(db, atkEle, defEle, defLv) {
  return db.attr[defLv][atkEle][defEle];
}
// the element table's % for an attack of element atkEle on status dst, with what a status on it adds
// (battle_attr_fix, renewal): fire on one held by Fiber Lock's web + 100
// (and the attacker's element fields', src.attrUp: Volcano's fire, Deluge's water, Violent Gale's wind, renewal's ratio
// + val3 in battle_attr_fix)
export const attrOf = (db, atkEle, dst, src = null) => attrRatio(db, atkEle, dst.element, dst.elementLv) + (atkEle === 'Fire' && dst.webbed ? 100 : 0)
  + (((src && src.attrUp) || {})[atkEle] || 0);

// natural regen intervals (player.conf); HP does not regen while walking (status_natural_heal)
export const HP_REGEN_MS = 6000, SP_REGEN_MS = 8000;

// ---------- skills ----------

// Skills with their damage worked out: rAthena src/map/skills/<class>/<skill>.cpp (renewal branch).
// ratio(lv, dst, dist) → skill ratio in % (dist: cells from the user, for area skills); hit(rate, lv) → hit
// rate after the skill's bonus (modifyHitRate). Everything else (SP, range, cast, delay, element, hits,
// splash area, knockback) comes from skill_db via jobs.json 'skills'.
const elementAttack = { ratio: lv => 100 + 100 * (lv - 1), hit: r => r + idiv(r * 20, 100) };
export const SKILLS = {
  // Bash: at Lv 6 and up, a player with Fatal Blow (src.fatalBlow) stuns what it deals damage to at
  // (Lv − 5) × BaseLv × 10 in hundredths of a percent (skills/swordman/bash.cpp applyAdditionalEffects), for
  // Duration2 (see stunOdds)
  SM_BASH: { ratio: lv => 100 + 30 * lv, hit: (r, lv) => r + idiv(r * 5 * lv, 100),
    stun: (lv, src) => lv > 5 && src.fatalBlow ? (lv - 5) * src.lv * 10 : 0 },
  // Magnum Break: the inner 3×3 takes 100 + 20×Lv %, the rest of the 5×5 100 + 10×Lv % (a player's
  // distance to the target goes into the attack's flag). Its fire element goes on weapon ATK, and the
  // 20% fire bonus for 10 s after it (SC_SUB_WEAPONPROPERTY) is 20% of weapon ATK: bare hands have none,
  // so neither is here yet.
  // Mammonite (skills/merchant/mammonite.cpp): 100 + 50×Lv %. Its zeny: sim.js ZENY_COST.
  MC_MAMMONITE: { ratio: lv => 100 + 50 * lv },
  // Cart Revolution (skills/merchant/cartrevolution.cpp): 150 %, + 1 % for every 1 % of the cart's weight limit
  // its load comes to (none: the sandbox has no items yet). Forced to neutral (battle_calc_element_damage): its
  // damage, after DEF, goes through the element table again as neutral (`neutral`).
  MC_CARTREVOLUTION: { ratio: () => 150, neutral: true },
  SM_MAGNUM: { ratio: (lv, dst, dist) => 100 + (dist <= 1 ? 20 : 10) * lv, hit: (r, lv) => r + idiv(r * 10 * lv, 100) },
  // Double Strafe (skills/archer/doublestrafe.cpp): the ratio is one shot's and the skill hits twice
  // (skill_db HitCount 2, DAMAGE_DIV_FIX), so Lv 10 deals 2 × 190%. It needs a bow and an arrow
  // (skill_db Requires, jobs.json 'weapon'); arrows are not counted anywhere here.
  AC_DOUBLE: { ratio: lv => 100 + 10 * (lv - 1) },
  // Melody Strike, Slinging Arrow (skills/archer/melodystrike.cpp, slingingarrow.cpp, pre-renewal: by request): 60 + 40 × Lv
  // %, an arrow flying (`arrow`; the arrows it takes are not counted, as a bow skill's)
  BA_MUSICALSTRIKE: { ratio: lv => 60 + 40 * lv, arrow: true },
  DC_THROWARROW: { ratio: lv => 60 + 40 * lv, arrow: true },
  // Unchained Serenade (pre-renewal, by request: battle_calc_misc_attack): 30 + 10 × Lv + Lv × Musical Lesson's level, as
  // it is, on each enemy on its ground every 3 s (sim.js songTurn)
  BA_DISSONANCE: { misc: (src, lv) => 30 + 10 * lv + lv * (src.lesson || 0), miscText: (src, lv) => `30 + 10×${lv} + ${lv}×樂器練習 ${src.lesson || 0}` },
  // Arrow Repel (skills/archer/chargearrow.cpp): 150%, one arrow; it knocks the target back 6 cells (skill_db
  // Knockback), and damage does not cut its cast off (CastCancel false). It needs a bow.
  AC_CHARGEARROW: { ratio: () => 150 },
  // Arrow Shower (skills/archer/arrowshower.cpp, renewal): 150 + 10×Lv % on every enemy in its splash square
  // around the target cell (see sim.js 'rain'), each knocked back 2 cells. It needs a bow.
  AC_SHOWER: { ratio: lv => 150 + 10 * lv },
  // Phantasmic Arrow (skills/archer/phantasmicarrow.cpp, renewal): 500%, wind (skill_db Element), from range; it knocks the
  // target back 3 cells, not one it kills (skill_blown: issue #1378). It needs a bow but no arrow (skill_isammotype).
  HT_PHANTASMIC: { ratio: () => 500 },
  // Sonic Blow (skills/thief/sonicblow.cpp, renewal): 200 + 100 × Lv %, half as much again on one below half its
  // HP, split into 8 hits; a hit tries to stun the target at 2 × Lv + 10 % for Duration2 (4.5 s). With Sonic
  // Acceleration (src.sonicAccel) its hit rate is 90% higher and its damage, at the end, too (battle_calc_weapon_final_atk_modifiers)
  // Venom Splasher (skills/thief/venomsplasher.cpp, renewal): its blast, 500 + 100 × Lv %, + 20 % for each level of
  // Poison React the user has (src.poisonReact), on each it reaches in full (no split); it always hits
  // (is_attack_hitting: AS_SPLASHER), and tries to poison each at 100% against its VIT for Duration2 (18 s; see
  // poisonOdds). See sim.js DOES.splasher.
  AS_SPLASHER: { ratio: (lv, dst, dist, src) => 500 + 100 * lv + 20 * (src.poisonReact || 0), sure: true,
    ails: () => [{ kind: 'poison', rate: () => 100 }] },
  // Throw Venom Knife (skills/thief/throwvenomknife.cpp, renewal): 500%, a ranged attack; a hit tries to poison the
  // target at 100% against its VIT for Duration2 (18 s; see poisonOdds). The Venom Knife it throws (Ammo, its ATK 30)
  // is not counted, as arrows are not.
  AS_VENOMKNIFE: { ratio: () => 500, ails: () => [{ kind: 'poison', rate: () => 100 }] },
  // Grimtooth (skills/thief/grimtooth.cpp): 120 + 20 × Lv %
  AS_GRIMTOOTH: { ratio: lv => 120 + 20 * lv },
  // The rogue's (skills/thief/*.cpp, renewal; Back Stab pre-renewal's, by request). Back Stab (backstab.cpp): 300 + 40 ×
  // Lv %, with a bow 100 + (200 + 40 × Lv) / 2 (backstab_bow_penalty), never missing (pre-re skill_db IgnoreFlee); one
  // hit whatever the weapon, no stun (renewal's dagger div_ 2, hit + Lv and stun not here). Sightless Mind
  // (sightlessmind.cpp): 50 + 150 × Lv %; a hit stuns at 10 + 3 × Lv % for Duration1 (5 s) and blinds at as much for
  // Duration2 (20 s), and puts SC_RAID on it (sim.js raided). Snatch (snatch.cpp): 100 + 30 × Lv %.
  RG_BACKSTAP: { ratio: (lv, dst, dist, src) => src && src.weapon === 'Bow' ? 100 + idiv(200 + 40 * lv, 2) : 300 + 40 * lv, sure: true },
  RG_RAID: { ratio: lv => 50 + 150 * lv,
    ails: () => [{ kind: 'stun', rate: lv => 10 + 3 * lv, dur: 'duration' }, { kind: 'blind', rate: lv => 10 + 3 * lv }] },
  RG_INTIMIDATE: { ratio: lv => 100 + 30 * lv },
  // The monk's (skills/acolyte/*.cpp, renewal). Raging Trifecta Blow (ragingtrifectablow.cpp): 100 + 20 × Lv %, split
  // into 3 hits (HitCount −3), in place of a normal attack (sim.js triple). Occult Impaction (occultimpaction.cpp): 100 ×
  // Lv %, never missing (IgnoreFlee); it goes through DEF (is_attack_piercing: neither DEF cuts it) and adds the target's
  // DEF × the ratio / 200 instead (battle_calc_defense: `pierce`), gets no mastery ATK at all — weapon masteries,
  // spheres, Hilt Binding (battle_skill_stacks_masteries_vvs: `noMastery`) — and is forced to neutral as Cart
  // Revolution (battle_calc_element_damage). Throw Spirit Sphere (throwspiritsphere.cpp): 700 + 200 × Lv %, split
  // into 5 hits, from range; its sphere ATK counts the sphere it threw (battle_get_spiritball_damage: spiritball_old
  // + spiritball, src.spheres as it was). Raging Quadruple Blow (ragingquadrupleblow.cpp): 250 + 50 × Lv %, split into
  // 4 hits; with a knuckle twice that, in 6. Raging Thrust (ragingthrust.cpp): 550 + 50 × Lv % + the user's STR.
  MO_TRIPLEATTACK: { ratio: lv => 100 + 20 * lv },
  MO_INVESTIGATE: { ratio: lv => 100 * lv, sure: true, pierce: true, noMastery: true, neutral: true },
  MO_FINGEROFFENSIVE: { ratio: lv => 700 + 200 * lv },
  MO_CHAINCOMBO: { ratio: (lv, dst, dist, src) => (250 + 50 * lv) * (src.weapon === 'Knuckle' ? 2 : 1), div: src => src.weapon === 'Knuckle' ? -6 : -4 },
  MO_COMBOFINISH: { ratio: (lv, dst, dist, src) => 550 + 50 * lv + src.stats.str },
  // Asura Strike (asurastrike.cpp, renewal): 800 + 10 × the user's SP % (its SP as it goes off, the 1 it costs paid;
  // 500000 at most), then 250 + 150 × Lv more (battle_calc_skill_constant_addition: `add`); never missing (IgnoreFlee),
  // no mastery ATK (as Occult Impaction), forced to neutral, and its DEF a flat cut of hard and soft DEF, no RES
  // (SimpleDefense: `flatDef`). (×2 with over 5 spheres before it, a Champion's: not here.)
  // Ki Explosion (kiexplosion.cpp, renewal): 800 %; its target not knocked back (blewcount 0: those round it are, sim.js)
  MO_BALKYOUNG: { ratio: () => 800 },
  MO_EXTREMITYFIST: { ratio: (lv, dst, dist, src) => Math.min(500000, 800 + 10 * (src.sp || 0)), add: lv => 250 + 150 * lv, sure: true,
    noMastery: true, neutral: true, flatDef: true },
  AS_SONICBLOW: { ratio: (lv, dst) => { const r = 200 + 100 * lv; return dst.hp < dst.maxHp / 2 ? r + idiv(r, 2) : r; },
    hit: (r, lv, src) => src.sonicAccel ? r + idiv(r * 90, 100) : r, more: src => src.sonicAccel ? ['超音速投擲', 90] : null,
    ails: () => [{ kind: 'stun', rate: lv => 2 * lv + 10 }] },
  // Envenom (skills/thief/envenom.cpp, renewal): 100%, + 15 × Lv mastery ATK (non-elemental), poison
  // element; a hit then tries to poison the target at 4 × Lv + 10 % for Duration2 (18 s; see poisonOdds), the
  // skill failing for a player when it does not take
  TF_POISON: { ratio: () => 100, mastery: lv => 15 * lv, ails: () => [{ kind: 'poison', rate: lv => 4 * lv + 10, fails: true }] },
  // Sand Attack (skills/thief/sandattack.cpp): 130%, earth; a hit tries to blind the target at 20% (a
  // player's; 15 a monster's) for Duration2 (18 s; see blindOdds)
  TF_SPRINKLESAND: { ratio: () => 130, ails: src => [{ kind: 'blind', rate: () => src.kind === 'pc' ? 20 : 15 }] },
  // Stone Fling (skills/thief/stonefling.cpp, battle_calc_misc_attack): a flat 50 (30 from a monster), never
  // missing (IgnoreFlee), then only the element table (neutral); a player's hit tries to stun the target at 3%
  // for Duration1 (4.5 s), and only if that fails to blind it at 3% for Duration2 (20 s); a monster's only stuns, at 5%
  TF_THROWSTONE: { misc: src => src.kind === 'pc' ? 50 : 30,
    ails: src => src.kind === 'pc' ? [{ kind: 'stun', rate: () => 3, dur: 'duration' }, { kind: 'blind', rate: () => 3, orElse: true }]
      : [{ kind: 'stun', rate: () => 5, dur: 'duration' }] },
  // Blitz Beat (skills/archer/blitzbeat.cpp, battle_calc_misc_attack, renewal): the falcon's 20 × Lv + 6 × Steel Crow's
  // Lv (src.steelCrow) + AGI / 2 × 2 + DEX / 10 × 2, never missing (IgnoreFlee), then the element table (neutral: skill_db
  // has none), × Lv hits (HitCount, DAMAGE_DIV_FIX), on the target and every enemy in the 3×3 round it (sim.js DOES.blitz)
  HT_BLITZBEAT: { misc: (src, lv) => 20 * lv + 6 * (src.steelCrow || 0) + idiv(src.stats.agi, 2) * 2 + idiv(src.stats.dex, 10) * 2,
    miscText: (src, lv) => `20×${lv} + 鋼製喙 6×${src.steelCrow || 0} + AGI ${src.stats.agi}/2×2 + DEX ${src.stats.dex}/10×2` },
  // Freezing Trap (skills/archer/freezingtrap.cpp, renewal): a weapon attack at 100%, water (skill_db Element), never
  // missing (IgnoreFlee), on every enemy in the 3×3 round the one that set it off (sim.js springTrap); each hit freezes
  // at 100% against its resistance for Duration2 (3 s a level; Research Trap's ATK is a third job's)
  HT_FREEZINGTRAP: { ratio: () => 100, sure: true },
  // Land Mine (skills/archer/landmine.cpp, battle_calc_misc_attack, renewal): Lv × DEX × (3 + BaseLv / 100) × (1 + INT / 35),
  // then ±10% at random (rnd() % 20 − 10 %), never missing (IgnoreFlee), then the element table (earth); on the one that
  // set it off, stunning it at 10% for Duration2 (4.5 s)
  HT_LANDMINE: { misc: (src, lv, rnd) => trapMisc(src, lv, rnd), miscText: (src, lv) => trapMiscText(src, lv), ails: () => [{ kind: 'stun', rate: () => 10 }] },
  // Blast Mine (skills/archer/blastmine.cpp): the same, wind, shared among the enemies in the 3×3 round the trap (SplashSplit)
  HT_BLASTMINE: { misc: (src, lv, rnd) => trapMisc(src, lv, rnd), miscText: (src, lv) => trapMiscText(src, lv) },
  // Claymore Trap (skills/archer/claymoretrap.cpp): the same, fire, shared among the enemies in the 5×5 round the trap
  HT_CLAYMORETRAP: { misc: (src, lv, rnd) => trapMisc(src, lv, rnd), miscText: (src, lv) => trapMiscText(src, lv) },
  NPC_WATERATTACK: elementAttack, NPC_GROUNDATTACK: elementAttack, NPC_FIREATTACK: elementAttack,
  NPC_UNDEADATTACK: elementAttack, NPC_WINDATTACK: elementAttack,
  // Poison and Shadow Attribute Attack (skills/npc/poisonattributeattack.cpp, shadowattributeattack.cpp): the same,
  // poison and dark
  NPC_POISONATTACK: elementAttack, NPC_DARKNESSATTACK: elementAttack,
  // Ghost Attribute Attack (skills/npc/ghostattributeattack.cpp): the same, ghost
  NPC_TELEKINESISATTACK: elementAttack,
  // Critical Slash (NPC_CRITICALSLASH, a plain WeaponSkillImpl): always critical (is_attack_critical), so it never
  // misses, and a monster's critical does 1.4 times as much (battle_calc_weapon_attack, renewal); it ignores DEF
  // (skill_db IgnoreDefense)
  NPC_CRITICALSLASH: { ratio: () => 100, crit: true, ignoreDef: true },
  // Piercing Attack (skills/npc/piercingattack.cpp): 75%, ignoring DEF
  NPC_PIERCINGATT: { ratio: () => 75, ignoreDef: true },
  // Multi-stage Attack (skills/npc/multistageattack.cpp): 100 + 25 × Lv %, split into Lv + 1 hits (skill_db HitCount −2…)
  NPC_COMBOATTACK: { ratio: lv => 100 + 25 * lv },
  // Guided Attack (NPC_GUIDEDATTACK): 100%, never missing (skill_db IgnoreFlee)
  NPC_GUIDEDATTACK: { ratio: () => 100, sure: true },
  // Splash Attack (skills/npc/splashattack.cpp): 100% on every enemy within its splash (3 cells: 7 × 7) of the
  // target; Stand-off Attack (NPC_RANGEATTACK): 100%, neutral, from up to 7 cells
  NPC_SPLASHATTACK: { ratio: () => 100 }, NPC_RANGEATTACK: { ratio: () => 100 },
  // Pierce (skills/swordman/pierce.cpp): 100 + 10 × Lv %, Lv × 5 % more hit, and it hits once for every size step
  // of the target (modifyDamageData: div = size + 1: small 1, medium 2, large 3)
  KN_PIERCE: { ratio: lv => 100 + 10 * lv, hit: (r, lv) => r + idiv(r * 5 * lv, 100), bySize: true },
  // Spear Boomerang (skills/swordman/spearboomerang.cpp): 100 + 50 × Lv %, from 3, 5, 7, 9 or 11 cells (skill_db
  // Range); from Lv 2 on (5 cells and more) a long-range attack (sim.js longAttack)
  KN_SPEARBOOMERANG: { ratio: lv => 100 + 50 * lv },
  // Spear Stab (skills/swordman/spearstab.cpp): 100 + 20 × Lv % on the target and the enemies on the 3 cells from it
  // toward the user (sim.js 'line'), each knocked back 6 cells (skill_db Knockback)
  KN_SPEARSTAB: { ratio: lv => 100 + 20 * lv },
  // Counter Attack (skills/swordman/counterattack.cpp): the counter it strikes back with (sim.js autoCounter) is
  // always critical (is_attack_critical: auto_counter_type 15), so it never misses, at 100%
  KN_AUTOCOUNTER: { ratio: () => 100, crit: true },
  // Brandish Spear (skills/swordman/brandishspear.cpp, renewal; as the client's description has it): 400 + 100 ×
  // Lv + 3 × STR %, in 3 hits (HitCount −3) on each enemy in the area (sim.js DOES.brandish)
  KN_BRANDISHSPEAR: { ratio: (lv, dst, dist, src) => 400 + 100 * lv + 3 * src.stats.str },
  // Charge Attack (skills/swordman/chargeattack.cpp, renewal; the client's description: 700%): 100 + 600 %
  KN_CHARGEATK: { ratio: () => 700 },
  // Bowling Bash (skills/swordman/bowlingbash.cpp, renewal): 100 + 40 × Lv % a hit on every enemy in the 5×5 round the
  // target (sim.js 'splash'), 2 hits (skill_db HitCount), with a two-handed sword 3 when 2 or more enemies are
  // there and 4 when 4 or more (modifyDamageData: the count, skill_area_sub_count, as miscflag); each one hit is
  // knocked back 1–5 cells (skill_db Knockback, renewal: not zeroed)
  KN_BOWLINGBASH: { ratio: lv => 100 + 40 * lv, div: (src, n) => src.weapon === '2hSword' && n >= 2 ? (n >= 4 ? 4 : 3) : 2 },
  // Jupitel Thunder (skills/mage/jupitelthunder.cpp): magic at 100% a hit, Lv + 2 hits, wind; it knocks the target
  // back 2–7 cells (skill_db Knockback)
  WZ_JUPITEL: { magic: true, ratio: () => 100 },
  // Earth Spike (skills/mage/earthspike.cpp): magic at 200% a hit, Lv hits, earth, on the target (Earth Care, a third
  // job's elemental's, not here)
  WZ_EARTHSPIKE: { magic: true, ratio: () => 200 },
  // Heaven's Drive (skills/mage/heavensdrive.cpp): magic at 125% a hit, Lv hits, earth, on every enemy in its 5×5
  // (sim.js 'rain')
  WZ_HEAVENDRIVE: { magic: true, ratio: () => 125 },
  // Sightrasher (skills/mage/sightrasher.cpp): magic at 100 + 20 × Lv %, fire, one hit on each enemy round the user
  // (sim.js DOES.area), knocking it back 5 cells
  WZ_SIGHTRASHER: { magic: true, ratio: lv => 100 + 20 * lv },
  // Meteor Storm (skills/mage/meteorstorm.cpp, renewal): magic at 100 + 25 = 125% a hit, fire, HitCount hits (2–7) on
  // each enemy round where a meteor falls (sim.js DOES.meteor), each one hit with damage stunned at 3 × Lv % against
  // its VIT for Duration2, 4.5 s (applyAdditionalEffects: sc_start SC_STUN; see stunOdds)
  WZ_METEOR: { magic: true, ratio: () => 125, ails: () => [{ kind: 'stun', rate: lv => 3 * lv }] },
  // Lord of Vermilion (skills/mage/lordofvermilion.cpp, renewal): magic at 400 + 100 × Lv % for a character, the old
  // 80 + 20 × Lv % for a monster, wind, once, shown in 20 hits (HitCount −20); each one hit with damage blinded at
  // 10 + 5 × Lv % against its resistance for Duration2, 18 s (applyAdditionalEffects: sc_start SC_BLIND; see blindOdds)
  WZ_VERMILION: { magic: true, ratio: (lv, dst, dist, src) => src.kind === 'mob' ? 80 + 20 * lv : 400 + 100 * lv,
                  ails: () => [{ kind: 'blind', rate: lv => 10 + 5 * lv }] },
  // Fire Pillar (skills/mage/firepillar.cpp, renewal): magic, the user's MATK + 100 + 50 × Lv (battle.cpp MATK_ADD) at
  // 40 + 20 × Lv % a hit, through MDEF (IgnoreDefense), fire, Lv + 2 hits; a character's is that once, shown in that
  // many hits (modifyDamageData: div_ × −1), a monster's that many times. Each one hit cannot walk for Duration2
  // (applyAdditionalEffects: unit_set_walkdelay). See sim.js springTrap.
  // Water Ball (skills/mage/waterball.cpp): magic at 100 + 30 × Lv % a ball, water, one hit each (sim.js DOES.waterball)
  WZ_WATERBALL: { magic: true, ratio: lv => 100 + 30 * lv },
  // Frost Nova (skills/mage/frostnova.cpp, renewal): magic at 100 + 10 × Lv % (Frost Diver's), water, one hit on each
  // enemy round the user (sim.js DOES.area); each one hit freezes at 5 × Lv + 33 % for a character's, 3 × Lv + 35 %
  // for a monster's (applyAdditionalEffects: sc_start SC_FREEZE) for Duration2 (see freezeOdds)
  // Storm Gust (skills/mage/stormgust.cpp, renewal): magic at 70 + 50 × Lv % a hit, water, up to 10 hits while it lasts
  // (sim.js placeStorm); each one hit freezes at 65 − 5 × Lv % (applyAdditionalEffects; renewal has no third-hit count)
  WZ_STORMGUST: { magic: true, ratio: lv => 70 + 50 * lv, freeze: lv => 65 - 5 * lv },
  WZ_FROSTNOVA: { magic: true, ratio: lv => 100 + 10 * lv, freeze: (lv, src) => src.kind === 'pc' ? 5 * lv + 33 : 3 * lv + 35 },
  WZ_FIREPILLAR: { magic: true, ignoreDef: true, plus: lv => 100 + 50 * lv, ratio: lv => 40 + 20 * lv, pcSplit: true },
  // Poison Attack, Stun Attack, Petrify Attack (skills/npc/poisonattack.cpp, stunattack.cpp, petrifyattack.cpp): the
  // monster's normal attack at 100% with 20% more hit, the weapon's element; a hit tries to poison (stun) the
  // target at 20 × Lv % for Duration2 (18 s; 4.5 s: see poisonOdds, stunOdds), or to petrify it (SC_STONEWAIT: a
  // Duration1 wait, 100 ms, then stone for the rest of Duration2, 17 s: see petrifyOdds)
  NPC_POISON: { ratio: () => 100, hit: r => r + idiv(r * 20, 100), ails: () => [{ kind: 'poison', rate: lv => 20 * lv }] },
  NPC_STUNATTACK: { ratio: () => 100, hit: r => r + idiv(r * 20, 100), ails: () => [{ kind: 'stun', rate: lv => 20 * lv }] },
  NPC_PETRIFYATTACK: { ratio: () => 100, hit: r => r + idiv(r * 20, 100), ails: () => [{ kind: 'stone', rate: lv => 20 * lv }] },
  // Silence Attack, Blind Attack (skills/npc/silenceattack.cpp, blindattack.cpp): the monster's normal attack at
  // 100% with 20% more hit, the weapon's element; a hit tries to silence (blind) the target at 20 × Lv % for
  // Duration2 (18 s; see silenceOdds, blindOdds)
  NPC_SILENCEATTACK: { ratio: () => 100, hit: r => r + idiv(r * 20, 100), ails: () => [{ kind: 'silence', rate: lv => 20 * lv }] },
  NPC_BLINDATTACK: { ratio: () => 100, hit: r => r + idiv(r * 20, 100), ails: () => [{ kind: 'blind', rate: lv => 20 * lv }] },
  // Curse Attack, Sleep Attack (skills/npc/curseattack.cpp, sleepattack.cpp): the same, dark (the weapon's
  // element); a hit tries to curse the target for Duration2 (28 s; see curseOdds) or put it to sleep (18 s; see
  // sleepOdds) at 20 × Lv %
  NPC_CURSEATTACK: { ratio: () => 100, hit: r => r + idiv(r * 20, 100), ails: () => [{ kind: 'curse', rate: lv => 20 * lv }] },
  NPC_SLEEPATTACK: { ratio: () => 100, hit: r => r + idiv(r * 20, 100), ails: () => [{ kind: 'sleep', rate: lv => 20 * lv }] },
  // Sucking Blood (skills/npc/suckingblood.cpp): 100 + 100 × (Lv − 1) %, dark, never missing (skill_db
  // IgnoreFlee); the monster heals by the damage it deals (sim.js: drain)
  NPC_BLOODDRAIN: { ratio: lv => 100 + 100 * (lv - 1), sure: true, drain: true },
  // Shield Charge (Smite, skills/swordman/smite.cpp): 100 + 20 × Lv %, a hit stunning at 15 + 5 × Lv % for Duration2
  // (4.5 s), knocking back 5 + Lv… cells (skill_db Knockback)
  CR_SHIELDCHARGE: { ratio: lv => 100 + 20 * lv, ails: () => [{ kind: 'stun', rate: lv => 15 + 5 * lv }] },
  // Shield Boomerang (skills/swordman/shieldboomerang.cpp, renewal): 80 × Lv % of status ATK and the shield's weight
  // (`shieldBase`), no masteries (battle_skill_stacks_masteries_vvs), neutral (its element)
  CR_SHIELDBOOMERANG: { ratio: lv => 80 * lv, shieldBase: true, noMastery: true },
  // The alchemist's (skills/merchant/*.cpp, renewal). Acid Terror (acidterror.cpp): 200 × Lv %, + 100 with Potion
  // Research learned (src.potionResearch), neutral (skill_db has no element), never missing (IgnoreFlee), no mastery ATK
  // (battle_skill_stacks_masteries_vvs), and only hard DEF cuts it (battle_calc_defense: def2 = 0, `softDefFree`); a hit
  // tries to make the target bleed at 3 × Lv % for Duration2 (108 s; see bleedOdds), and to break its armour at
  // (1000 × Lv − 500) / 100 % (renewal; `breaks`: see MOB_STRIPS). Bomb (bomb.cpp): each hit of its fire 100 + 20 × Lv %,
  // fire (its element), breaking the weapon at 3 × Lv %.
  AM_ACIDTERROR: { ratio: (lv, dst, dist, src) => 200 * lv + (src.potionResearch ? 100 : 0), sure: true, noMastery: true, softDefFree: true,
    ails: () => [{ kind: 'bleed', rate: lv => 3 * lv }], breaks: { part: 'RG_STRIPARMOR', rate: lv => 1000 * lv - 500 } },
  // Self Destruction (NPC_SELFDESTRUCTION, battle_calc_misc_attack): the HP its user has, fire (sim.js selfDestruct)
  NPC_SELFDESTRUCTION: { misc: src => src.hp, miscText: () => '自身 HP' },
  // the homunculi's (skills/homunculus/*.cpp): Moonlight 110 + 110 × Lv % (moonlight.cpp); S.B.R.44 its intimacy, here
  // always Loyal's top 100000 (by request: no intimacy), × Lv (sbr44.cpp, battle_calc_skill_base_damage), the
  // weapon's (neutral) element on it, never missing; Bio Explosion its MaxHP × (50 + 50 × Lv) % (battle_calc_misc_attack),
  // no element (IgnoreElement)
  HFLI_MOON: { ratio: lv => 110 + 110 * lv },
  HFLI_SBR44: { misc: (src, lv) => 100000 * lv, miscText: (src, lv) => `親密度 100000 × ${lv}` },
  HVAN_EXPLOSION: { misc: (src, lv) => idiv(src.maxHp * (50 + 50 * lv), 100), miscText: (src, lv) => `MaxHP ${src.maxHp} × ${50 + 50 * lv}%`, noElement: true },
  AM_DEMONSTRATION: { ratio: lv => 100 + 20 * lv, breaks: { part: 'RG_STRIPWEAPON', rate: lv => 300 * lv } },
  // Holy Cross (skills/swordman/holycross.cpp, renewal): 100 + 35 × Lv %, with a two-handed spear 100 + 70 × Lv %; holy (its
  // element); 2 hits shown, the damage split between them (HitCount −2); a hit blinds at 3 × Lv % for Duration2 (18 s)
  CR_HOLYCROSS: { ratio: (lv, dst, dist, src) => 100 + (src && src.weapon === '2hSpear' ? 70 : 35) * lv, ails: () => [{ kind: 'blind', rate: lv => 3 * lv }] },
  // Grand Cross (battle_calc_magic_attack, renewal; `gx`, see magicDamage): (ATK + MATK) / 2 × (100 + 40 × Lv) %, then DEF as
  // a weapon attack's and MDEF taken off whole, holy against the target's element twice
  CR_GRANDCROSS: { magic: true, gx: true, ratio: lv => 100 + 40 * lv },
  // Dark Breath (skills/npc/darkbreath.cpp → battle_calc_magic_attack): magic, dark, its damage not from MATK but a
  // share of the target's HP as it is (100 / (2 × (6 − Lv)) %: Lv 4, 25%; 50% from Lv 6), then MDEF and the element
  NPC_DARKBREATH: { magic: true, ratio: () => 100, base: (dst, lv) => idiv((dst.hp || 0) * (lv <= 5 ? idiv(100, 2 * (6 - lv)) : 50), 100),
                    baseText: lv => `目前 HP 的 ${lv <= 5 ? idiv(100, 2 * (6 - lv)) : 50}%` },
  // Napalm Beat (skills/mage/napalmbeat.cpp): magic at 70 + 10×Lv %, ghost, on every enemy in the 3×3 around
  // the target (SplashArea 1); the MATK is split among them (SplashSplit: ÷ the enemies there, before the ratio)
  MG_NAPALMBEAT: { magic: true, ratio: lv => 70 + 10 * lv },
  // Fire Ball (skills/mage/fireball.cpp, renewal): magic at 140 + 20×Lv %, fire, on every enemy in the 5×5
  // around the target (SplashArea 2); from a player, one at the edge (2 cells from the target) takes 75% of it
  // (splashDamage passes that distance on: miscflag 2)
  MG_FIREBALL: { magic: true, ratio: (lv, dst, dist) => { const r = 140 + 20 * lv; return dist === 2 ? idiv(r * 3, 4) : r; } },
  // Soul Strike (skills/mage/soulstrike.cpp): magic at 100% a hit (skill_db HitCount 1, 1, 2, 2 … 5), ghost;
  // on an undead target (battle_check_undead) 5×Lv % more
  MG_SOULSTRIKE: { magic: true, ratio: (lv, dst) => 100 + (isUndead(dst) ? 5 * lv : 0) },
  // Holy Light (skills/acolyte/holylight.cpp): magic at 125%, holy
  AL_HOLYLIGHT: { magic: true, ratio: () => 125 },
  // Turn Undead (skills/acolyte/turnundead.cpp; battle_calc_magic_attack, renewal): on an undead only (sim.js
  // targetFail), holy and through MDEF (IgnoreDefense). At `turn` ‰ — 10 × Lv + LUK + INT + Base Lv + 300 − 300 ×
  // HP / MaxHP, at most 700 — it does the target's HP (a boss: never, MD_STATUSIMMUNE); else MATK × Lv %.
  PR_TURNUNDEAD: { magic: true, ignoreDef: true, ratio: lv => lv,
                   turn: (src, dst, lv) => dst.boss ? 0 : Math.min(700, 10 * lv + src.stats.luk + src.stats.int + src.lv + 300 - idiv(300 * dst.hp, dst.maxHp)) },
  // Ruwach (skills/acolyte/ruwach.cpp): magic at 145%, holy, on each enemy its status brings out of hiding
  // (status_change_timer_sub → skill_attack)
  AL_RUWACH: { magic: true, ratio: () => 145 },
  // Magnus Exorcismus (skills/acolyte/magnusexorcismus.cpp, renewal): magic at 100% a hit, 130% on an unholy one
  // (undead or a demon), Lv hits (HitCount), holy
  PR_MAGNUS: { magic: true, ratio: (lv, dst) => 100 + (unholy(dst) ? 30 : 0) },
  // Aspersio on an undead enemy (a player's: skill_castend_nodamage_id turns it into skill_attack, BF_MAGIC): 40,
  // through MDEF and whatever the element (IgnoreDefense, IgnoreElement)
  PR_ASPERSIO: { magic: true, ignoreDef: true, noElement: true, ratio: () => 100, base: () => 40, baseText: () => '40' },
  // B.S. Sacramenti on an unholy enemy in its 3×3 (castendDamageId → skill_attack, BF_MAGIC): Heal's amount at its
  // level (skill_calc_heal's default: (BaseLv + INT) / 5 × 30 × Lv / 10), halved (heal = false), plus MATK, through MDEF
  // (IgnoreDefense); neutral, skill_db giving it no element (the client's description says holy)
  PR_BENEDICTIO: { magic: true, ignoreDef: true, matk: true, ratio: () => 100,
                   base: (dst, lv, src) => idiv(HEAL_SKILLS.AL_HEAL.amount(src, lv), 2),
                   baseText: (lv, src) => `(Lv ${src.lv} + INT ${src.stats.int}) / 5 × 30 × ${lv} / 10 ÷ 2` },
  // Sanctuary (UNT_SANCTUARY → skill_attack, BF_MAGIC) on an unholy enemy standing in it: its heal (sanctuaryHeal),
  // halved as skill_calc_heal does with heal = false and no MATK added (renewal leaves Sanctuary out of the MATK part),
  // holy and through MDEF (IgnoreDefense)
  PR_SANCTUARY: { magic: true, ignoreDef: true, ratio: () => 100, base: (dst, lv) => idiv(sanctuaryHeal(lv), 2), baseText: lv => `${sanctuaryHeal(lv)} ÷ 2` },
  // Fire Bolt (skills/mage/firebolt.cpp): magic (see magicDamage) at the default 100% a bolt, one bolt a
  // level (skill_db HitCount = Lv, DAMAGE_DIV_FIX), fire element
  MG_FIREBOLT: { magic: true, ratio: () => 100 },
  // Fire Wall (skills/mage/firewall.cpp): magic at 100 − 50 = 50% a hit, fire element; each hit comes from
  // one cell of the wall (see the sandbox's fire walls)
  MG_FIREWALL: { magic: true, ratio: () => 50 },
  // Cold Bolt (skills/mage/coldbolt.cpp): as Fire Bolt, water element
  MG_COLDBOLT: { magic: true, ratio: () => 100 },
  // Lightning Bolt (skills/mage/lightningbolt.cpp): as Fire Bolt, wind element
  MG_LIGHTNINGBOLT: { magic: true, ratio: () => 100 },
  // Thunderstorm (skills/mage/thunderstorm.cpp, renewal): magic at 100% a hit, Lv hits, wind element, on every
  // enemy in the 5×5 around the target cell (see sim.js 'rain')
  MG_THUNDERSTORM: { magic: true, ratio: () => 100 },
  // Frost Diver (skills/mage/frostdiver.cpp): 100 + 10×Lv %, water; a hit that deals damage then tries to
  // freeze the target at min(3×Lv + 35, Lv + 60) % for Duration2 (see freezeOdds)
  MG_FROSTDIVER: { magic: true, ratio: lv => 100 + 10 * lv, freeze: lv => Math.min(3 * lv + 35, lv + 60) },
};
// Resurrection on an undead monster (skills/acolyte/resurrection.cpp → skill_attack): Turn Undead's, at its own level
// (battle_calc_magic_attack takes both alike)
SKILLS.ALL_RESURRECTION = SKILLS.PR_TURNUNDEAD;
// HP % Resurrection brings a character back with, by level (status_revive; SP as it was)
export const resurrectHp = lv => [10, 30, 50, 80][lv - 1] || 80;
// Skills that put a status on the target instead of dealing damage (castendNoDamageId). chance(src, dst, lv)
// → success in % (0: immune); status(lv) → what the status does, for withStatus.
export const STATUS_SKILLS = {
  // Provoke (skills/swordman/provoke.cpp, SC_PROVOKE): 70 + 3×Lv + user level − target level %; status
  // immune (Boss class) and undead-element targets (undead_detect_type 0) are not affected. For the
  // skill's Duration1 the target's DEF and soft DEF drop 5 + 5×Lv % (hard DEF: monsters only) and its
  // ATK rises 2 + 3×Lv %; a monster turns on the one who provoked it.
  SM_PROVOKE: {
    chance: (src, dst, lv) => dst.boss || dst.element === 'Undead' ? 0 : 70 + 3 * lv + src.lv - dst.lv,
    status: lv => ({ name: '挑釁', def: 5 + 5 * lv, atk: 2 + 3 * lv }),
  },
};
// Skills that put a status on the user instead of doing damage (skill_castend_nodamage_id →
// status_change_start). stats(st, lv) → the stats the status changes (status_db CalcFlags says which),
// worked out from the ones the character already has; name: what the sandbox calls it.
export const BUFF_SKILLS = {
  // the attack speed potions (sim.js drink; not skills, under the status' name): Concentration Potion
  // (SC_ASPDPOTION0) and Awakening Potion (SC_ASPDPOTION1), their cut as above; rAthena's 30 minutes, which
  // here is the rest of the map (each map starts with no statuses). A stronger one replaces a weaker, a weaker
  // one does nothing while a stronger is on (status_change_start: the higher SC_ASPDPOTION blocks the lower).
  ASPDPOTION0: { name: '集中藥水', stats: () => ({}), cut: () => 100 },
  ASPDPOTION1: { name: '覺醒藥水', stats: () => ({}), cut: () => 150 },
  // (and Berserk Potion's, SC_ASPDPOTION2, 200: as the alchemist's Aid Berserk Potion throws it, sim.js pitchBerserk)
  ASPDPOTION2: { name: '菠色克藥水', stats: () => ({}), cut: () => 200 },
  // the boxes' (sim.js openBox; by request, used as soon as picked up; `item`: no level shown): Box of Thunder's
  // SC_SPEEDUP0 (bSpeedRate 25: movement haste 25 %, the largest counting, as Increase AGI's), Box of Grudge's
  // SC_ATKPOTION (bBaseAtk 20: status_calc_batk) and Sleepy Box's SC_MATKPOTION (bMatk2 20: status_calc_matk),
  // Box of Storm's SC_ENCHANTARMS (ITEM_ENCHANTARMS Lv 2: the weapon's element water, as an endow's, without its
  // magic % — status_calc_attack_element only) and Box of Sunlight's SC_INTRAVISION (sim.js clairvoyant)
  SPEEDUP0: { name: '移動加速', item: true, stats: () => ({}), haste: 25 },
  ATKPOTION: { name: 'ATK 增加', item: true, stats: () => ({}), batk: () => 20 },
  MATKPOTION: { name: 'MATK 增加', item: true, stats: () => ({}), matk: () => 20 },
  ITEM_ENCHANTARMS: { name: '水屬性附加', item: true, stats: () => ({}), ele: 'Water' },
  INTRAVISION: { name: '看穿隱身', item: true, stats: () => ({}) },
  // Improve Concentration (SC_CONCENTRATE, status_calc_agi / status_calc_dex): AGI and DEX + 2 + Lv % for
  // the skill's Duration1 (1 min at Lv 1, 4 min at Lv 10). The % is of the stat without what equipment
  // adds (val3 / val4), which is all of it here: no equipment yet. Not done, for want of anything to do
  // it to: it reveals hiding within its splash area and fails under Quagmire (status_db Fail). Sitting
  // goes on through it — the status has no SetStand flag.
  AC_CONCENTRATION: {
    name: '心神凝聚',
    stats: (st, lv) => ({ agi: st.agi + idiv(st.agi * (2 + lv), 100), dex: st.dex + idiv(st.dex * (2 + lv), 100) }),
  },
  // Increase AGI (skills/acolyte/incagi.cpp, SC_INCREASEAGI): AGI + 2 + Lv (status_calc_agi, after
  // Concentration's %), movement haste 25% (status_calc_speed: 150 → 112 ms a cell) and, renewal, ASPD + Lv %
  // (status_calc_aspd). Costs 15 HP besides the SP (skill_db HpCost); lasts Duration1 (1–4 min). It ends
  // Decrease AGI (status_db EndOnStart), which only monsters get here: it never meets Increase AGI.
  // Enchant Poison (skills/thief/enchantpoison.cpp, SC_ENCPOISON): on the user or one of the party, for Duration1
  // (15 s a level, + 15 s): the weapon's element poison (status_calc_attack_element, both hands; weapon ATK only,
  // status ATK staying neutral: battle_calc_damage_parts), and a weapon hit that does damage tries to poison what it
  // hits at 2.5 + 0.5 × Lv % for Duration2 (10 s a level; skill_additional_effect: val2 in 1/10000; see sim.js
  // coatPoison). (Its ending on changing weapons: there is no changing them in a fight here.)
  AS_ENCHANTPOISON: {
    name: '塗毒',
    stats: () => ({}),
    ele: 'Poison',
    poison: lv => 2.5 + 0.5 * lv,
  },
  // Aspersio (skills/acolyte/aspersio.cpp, SC_ASPERSIO): on a character, for Duration1 (30 s a level, + 30 s): the
  // weapon's element holy, as Enchant Poison's poison (status_calc_attack_element; each ends the other: status.yml
  // EndOnStart)
  PR_ASPERSIO: {
    name: '撒水祈福',
    stats: () => ({}),
    ele: 'Holy',
  },
  // the sage's Endow Blaze, Tsunami, Tornado and Quake (skills/mage/endow*.cpp, SC_FIREWEAPON and the others): on a
  // character for Duration1 (10–30 min), the weapon's element as Enchant Poison's, and by the client's description (as
  // renewal) its magic of that element Lv % more (magic_atk_ele: `magicEle`); each ends the others, Enchant Poison and
  // Aspersio (status.yml EndOnStart)
  SA_FLAMELAUNCHER: { name: '火屬性附加', stats: () => ({}), ele: 'Fire', magicEle: lv => ({ Fire: lv }) },
  SA_FROSTWEAPON: { name: '水屬性附加', stats: () => ({}), ele: 'Water', magicEle: lv => ({ Water: lv }) },
  SA_LIGHTNINGLOADER: { name: '風屬性附加', stats: () => ({}), ele: 'Wind', magicEle: lv => ({ Wind: lv }) },
  SA_SEISMICWEAPON: { name: '地屬性附加', stats: () => ({}), ele: 'Earth', magicEle: lv => ({ Earth: lv }) },
  // the sage's element fields (skills/mage/volcano.cpp, deluge.cpp, whirlwind.cpp; SC_VOLCANO, SC_DELUGE, SC_VIOLENTGALE),
  // on whoever stands in one (sim.js placeField), renewal's: each its element's attacks + 10, 14, 17, 19, 20 on the
  // element's % (battle_attr_fix val3: `attrUp`), and Volcano ATK and MATK + 5 + 5 × Lv (status_calc_batk / _matk),
  // Deluge MaxHP + 5, 9, 12, 14, 15 %, Violent Gale FLEE + 3 × Lv (before renewal only for one of the element)
  SA_VOLCANO: { name: '火元素領域', stats: () => ({}), batk: lv => 5 + 5 * lv, matk: lv => 5 + 5 * lv, attrUp: lv => ({ Fire: FIELD_UP[lv - 1] }) },
  SA_DELUGE: { name: '水元素領域', stats: () => ({}), maxHpRate: lv => [5, 9, 12, 14, 15][lv - 1], attrUp: lv => ({ Water: FIELD_UP[lv - 1] }) },
  SA_VIOLENTGALE: { name: '風元素領域', stats: () => ({}), flee: lv => 3 * lv, attrUp: lv => ({ Wind: FIELD_UP[lv - 1] }) },
  // Hindsight (SC_AUTOSPELL): nothing to the figures (sim.js autoSpell)
  SA_AUTOSPELL: { name: '自動念咒', stats: () => ({}) },
  // B.S. Sacramenti (skills/acolyte/bssacramenti.cpp, SC_BENEDICTIO): on a character, for Duration1 (40 s a level):
  // its armor's element holy, level 1 (status_calc_element / _element_lv; freezing and stone come before it)
  PR_BENEDICTIO: {
    name: '聖之祈福',
    stats: () => ({}),
    armor: 'Holy',
  },
  // Slow Poison (SC_SLOWPOISON): on a character, for Duration1 (10 s a level): its poison takes no HP and the natural
  // regen goes on (status_change_timer SC_POISON, status_calc_regen); the poison's time runs on all the same. Its working
  // is in sim.js (ailTick, regen)
  PR_SLOWPOISON: {
    name: '緩毒術',
    stats: () => ({}),
  },
  // Poison React (SC_POISONREACT, status.cpp): its working is all in sim.js (poisonReact); nothing to the stats
  AS_POISONREACT: {
    name: '毒性反彈',
    stats: () => ({}),
  },
  AL_INCAGI: {
    name: '加速術',
    stats: (st, lv) => ({ agi: st.agi + 2 + lv }),
    aspd: lv => lv,
    haste: 25,
  },
  // a homunculus's on its master: Urgent Escape (SC_AVOID) walking 10 × Lv % faster; Amistr Bulwark (SC_DEFENCE) VIT
  // + 5 + 5 × Lv (renewal, status_calc_vit: a player's)
  HLIF_AVOID: { name: '緊急迴避', stats: () => ({}), haste: lv => 10 * lv },
  HAMI_DEFENCE: { name: '防禦', stats: (st, lv) => ({ vit: st.vit + 5 + 5 * lv }) },
  // Blessing (skills/acolyte/blessing.cpp, SC_BLESSING): STR, INT and DEX + Lv, and renewal HIT + 2 × Lv
  // (status_calc_hit). On a cursed or petrified player it only cures that; on an undead or demon monster
  // it halves those stats instead (val2 0) — the sandbox has no curse, and uses it on characters only.
  // Auto Berserk (skills/swordman/autoberserk.cpp, SC_AUTOBERSERK): used again it ends. While it is on, HP at
  // a quarter or less brings on a Provoke Lv 10 of the user's own that lasts as long (ATK + 32%, soft DEF − 55%;
  // it checks every 100 ms: status_change_timer), and HP above a quarter ends that. Nothing of its own to the
  // stats; death ends it, as any status (it has no NoRemoveOnDead).
  SM_AUTOBERSERK: {
    name: '狂暴狀態',
    stats: () => ({}),
    toggle: true,
  },
  // Two-Hand Quicken (SC_TWOHANDQUICKEN; a player's: a monster's is MOB_BUFFS'): with a two-handed sword (skill_db
  // Requires), for Duration1 (30 s a level), as the client's description has it (by request): attack speed + 30%,
  // the attack speed potions' way (pre-renewal's aspd_rate cut of 300, not renewal's ASPD + 7 × AGI / 200; a potion's
  // adds to it), HIT + 2 × Lv (status_calc_hit), critical + 2 + Lv % (status_calc_critical)
  // Counter Attack's wait (SC_AUTOCOUNTER, sim.js DOES.counter): no status of its own, only its name for the HP line
  KN_AUTOCOUNTER: { name: '反擊', stats: () => ({}) },
  // Close Confine on its user (SC_CLOSECONFINE, sim.js confine): FLEE + 50 (renewal), held where it stands
  RG_CLOSECONFINE: { name: '緊密的約束', stats: () => ({}), flee: () => 50 },
  KN_TWOHANDQUICKEN: {
    name: '雙手劍攻擊速度增加',
    stats: () => ({}),
    quick: () => 300,
    hit: lv => 2 * lv,
    cri: lv => (2 + lv) * 10,
  },
  // The blacksmith's (a player's; a monster's Adrenaline Rush is MOB_BUFFS'): each put on its user (`self`, sc_start2's
  // val2) and on every party member on the map (splash −1: see sim.js partyBuff), for Duration1, a tenth longer when
  // its user has Hilt Binding (status_change_start); a weaker one does not take the place of a stronger.
  // Adrenaline Rush (SC_ADRENALINE): with an axe or a mace (skill_db Requires; the party's too: RequireWeapon), attack
  // speed + 30% on the user, + 20% on the party (val3 300 / 200, the attack speed potions' way as Two-Hand Quicken's:
  // the largest of the two counts), HIT + 3 × Lv + 5 (status_calc_hit, renewal)
  BS_ADRENALINE: {
    name: '速度激發',
    stats: () => ({}),
    quick: (lv, b) => b.self ? 300 : 200,
    hit: lv => 3 * lv + 5,
  },
  // Weapon Perfection (SC_WEAPONPERFECTION): the weapon's ATK whole on every size (battle_calc_sizefix)
  BS_WEAPONPERFECT: {
    name: '無視體型攻擊',
    stats: () => ({}),
    perfect: true,
  },
  // Power Thrust (SC_OVERTHRUST, renewal): ATK + 5 × Lv % on the user, + 5 / 10 / 15 % (Lv 1–2 / 3–4 / 5) on the party
  // (val3, added to the skill ratio of every attack: battle_calc_attack_skill_ratio); with any weapon, the party's too
  // (skill_db Requires: bare hands get none). Renewal breaks no weapon with it.
  BS_OVERTHRUST: {
    name: '凶砍',
    stats: () => ({}),
    atkRate: (lv, b) => b.self ? 5 * lv : lv > 4 ? 15 : lv > 2 ? 10 : 5,
  },
  // Fury (MO_EXPLOSIONSPIRITS, a StatusSkillImpl: SC_EXPLOSIONSPIRITS): critical + 75 + 25 × Lv tenths of a percent
  // (status_calc_critical, val2) for Duration1 (3 min), 5 spirit spheres used up; meanwhile, renewal, the monk's natural
  // SP regen ticks half as often (status_natural_heal) and Snap uses no sphere (skill_get_requirement): see sim.js
  MO_EXPLOSIONSPIRITS: {
    name: '爆氣',
    stats: () => ({}),
    cri: lv => 75 + 25 * lv,
  },
  // after Asura Strike (SC_EXTREMITYFIST, Duration1 3 s): no natural SP regen (status_calc_regen, renewal); see sim.js
  MO_EXTREMITYFIST: {
    name: '阿修羅霸凰拳',
    stats: () => ({}),
  },
  // Mental Strength (MO_STEELBODY, a StatusSkillImpl: SC_STEELBODY), for Duration1 (30 s a level), renewal: every hit
  // on its user a tenth as much (battle_calc_damage, see sim.js guard), its walk 200 ms a cell whatever else
  // (status_calc_speed), ASPD − 25 % (status_calc_aspd), and no skill at all meanwhile (NoCast: sim.js skillFail).
  // (Pre-renewal's DEF and MDEF 90: not renewal.)
  // The crusader's (a player's; a monster's Auto Guard and Reflect Shield go by sim.js too, these names for the HP line).
  // Auto Guard (SC_AUTOGUARD): a weapon attack blocked at guardRate % (sim.js autoGuard), its user held a moment
  // after; Reflect Shield (SC_REFLECTSHIELD): reflectRate % of a short-range one back (sim.js reflect); Shrink
  // (SC_SHRINK): a block stuns the attacker at 50 % (renewal; sim.js autoGuard)
  CR_AUTOGUARD: { name: '自動防禦', stats: () => ({}) },
  CR_REFLECTSHIELD: { name: '反射盾', stats: () => ({}) },
  CR_SHRINK: { name: '退縮', stats: () => ({}) },
  // Defending Aura (SC_DEFENDER): a long-range weapon attack 5 + 15 × Lv % less (battle_calc_damage: sim.js
  // defender), attacking 250 − 50 × Lv of 1000 slower (aspd_rate val4: the client's 80–100 % of the attack speed;
  // `slowAspd`), walking 200 ms a cell at the quickest (status_calc_speed: `plod`)
  CR_DEFENDER: { name: '光之盾', stats: () => ({}), slowAspd: lv => 250 - 50 * lv, plod: true, rangedCut: lv => 5 + 15 * lv },
  // Spear Quicken (SC_SPEARQUICKEN): with a spear (RequireWeapon), attack speed 200 + 10 × Lv of 1000 up (pre-renewal's
  // aspd_rate val2, the attack speed potions' way as Two-Hand Quicken's: the largest counts; not renewal's ASPD + 7 ×
  // AGI / 200), critical + 3 × Lv % (status_calc_critical, renewal), FLEE + 2 × Lv (status_calc_flee): the client's
  // Resistant Souls (skills/swordman/resistantsouls.cpp, SC_PROVIDENCE): holy damage and a demon's 5 × Lv % less
  // (status_calc_pc subele, subrace) for Duration1 (3 min)
  CR_PROVIDENCE: { name: '神祐之光', stats: () => ({}), subEle: lv => ({ Holy: 5 * lv }), subRace: lv => ({ Demon: 5 * lv }) },
  // Sacrifice (SC_DEVOTION): nothing of its own on the one under it (sim.js devotion: its damage goes to the crusader)
  CR_DEVOTION: { name: '犧牲', stats: () => ({}) },
  // The alchemist's Chemical Protection (SC_CP_WEAPON / SHIELD / ARMOR / HELM, Duration1 2 min a level): that part
  // can be neither broken nor taken off (skill_break_equip / skill_strip_equip scdef), nothing more. Nothing breaks or
  // takes off a character's equipment in the sandbox yet: the statuses are there for when something does (sim.js).
  AM_CP_WEAPON: { name: '化學武器保護', stats: () => ({}) },
  AM_CP_SHIELD: { name: '化學盾牌保護', stats: () => ({}) },
  AM_CP_ARMOR: { name: '化學鎧甲保護', stats: () => ({}) },
  AM_CP_HELM: { name: '化學頭盔保護', stats: () => ({}) },
  CR_SPEARQUICKEN: { name: '長矛加速術', stats: () => ({}), quick: lv => 200 + 10 * lv, cri: lv => 30 * lv, flee: lv => 2 * lv },
  MO_STEELBODY: {
    name: '金剛不壞',
    stats: () => ({}),
    aspd: () => -25,
    steel: true,
  },
  // Maximize Power (SC_MAXIMIZEPOWER, a StatusSkillImpl ending if on): until used again, the weapon's ATK at the top
  // of its spread (battle_calc_base_weapon_attack), no natural SP regen (status_calc_regen) and 1 SP every Duration1
  // (Lv s), ending when that is not there (status_change_timer); see sim.js maximizeDrain
  BS_MAXIMIZE: {
    name: '武器值最大化',
    stats: () => ({}),
    toggle: true,
    maximize: true,
  },
  AL_BLESSING: {
    name: '天使之賜福',
    stats: (st, lv) => ({ str: st.str + lv, int: st.int + lv, dex: st.dex + lv }),
    hit: lv => 2 * lv,
  },
  // Crazy Uproar (skills/merchant/crazyuproar.cpp, SC_LOUD): STR + 4 (status_calc_str) and, renewal, status ATK
  // + 30 (status_calc_batk) for Duration1 (5 min); renewal puts it on every party member within its splash (-1:
  // AREA_SIZE, 14 cells) of the user, as Angelus. Cooldown 30 s.
  MC_LOUD: {
    name: '大聲吶喊',
    stats: st => ({ str: st.str + 4 }),
    batk: () => 30,
  },
  // Endure (skills/swordman/endure.cpp, SC_ENDURE): MDEF + Lv (status_calc_mdef) and no damage motion
  // (status_calc_dmotion 0: hits neither stop it nor show the hurt motion) for Duration1 (10 s + 3 s a level),
  // or until `hits` attacks that deal damage have landed on it (val2 7, counted in battle_calc_damage for
  // attackers that are not players). It does not keep a cast from being cut off.
  // Angelus (skills/acolyte/angelus.cpp, SC_ANGELUS): on every party member within its splash (18 cells) of
  // the user, or only the user out of a party; renewal: soft DEF + VIT / 2 × 5×Lv % (status_calc_def2) and
  // MaxHP + 50 × Lv (status_get_hpbonus), for Duration1 (30 s a level). Cooldown 30 s.
  AL_ANGELUS: {
    name: '天使之障壁',
    stats: () => ({}),
    def2: (lv, st) => idiv(idiv(st.vit, 2) * 5 * lv, 100),
    maxHp: lv => 50 * lv,
  },
  // Impositio Manus (skills/acolyte/impositiomanus.cpp, SC_IMPOSITIO): renewal, as Angelus on every party member
  // within its splash (18 cells) of the user, or only the user out of a party: weapon ATK + 5 × Lv (status_calc_watk)
  // and MATK + 5 × Lv (status_calc_pseudobuff_matk) for Duration1 (2 min). Cooldown 30 s. (A lower level's takes
  // the place of a higher one's: status_change_start, as any later one does here.)
  PR_IMPOSITIO: {
    name: '神威祈福',
    stats: () => ({}),
    watk: lv => 5 * lv,
    matk: lv => 5 * lv,
  },
  // Suffragium (skills/acolyte/suffragium.cpp, SC_SUFFRAGIUM): renewal, as Angelus on the party within its splash (18
  // cells), the variable cast time of every skill cast 5 + 5 × Lv % shorter (skill_vfcastfix) for Duration1 (1 min);
  // renewal does not end it on the first cast, as pre-renewal does. Cooldown 30 s.
  PR_SUFFRAGIUM: {
    name: '犧牲祈福',
    stats: () => ({}),
    varCast: lv => 5 + 5 * lv,
  },
  // Gloria (skills/acolyte/gloria.cpp, SC_GLORIA): as Angelus on the party within its splash (18 cells), LUK + 30
  // (status_calc_luk; a curse still makes it 0) for Duration1 (5 s a level + 5 s).
  // Assumptio (HP_ASSUMPTIO, SC_ASSUMPTIO; here only from a card's autospell): renewal, DEF + 50 × Lv (status_calc_def)
  // and heals on it 2 × Lv % more (skill_calc_heal), for Duration1 (20 s a level)
  HP_ASSUMPTIO: {
    name: '聖母之祈福',
    stats: () => ({}),
    def: lv => 50 * lv,
    healIn: lv => 2 * lv,
  },
  PR_GLORIA: {
    name: '幸運之頌歌',
    stats: st => ({ luk: st.luk + 30 }),
  },
  // Kyrie Eleison (skills/acolyte/kyrieeleison.cpp, SC_KYRIE): on a character (a monster: it fails, status_change_start)
  // for Duration1 (2 min), a barrier of `shield` % of its MaxHP as it goes on and `hits` attacks (status.cpp val2,
  // val3); its working is in sim.js (kyrie)
  PR_KYRIE: {
    name: '霸邪之陣',
    stats: () => ({}),
    shield: lv => 10 + 2 * lv,
    barrier: lv => idiv(lv, 2) + 5,
  },
  // Magnificat (skills/acolyte/magnificat.cpp, SC_MAGNIFICAT): as Angelus on the party within its splash (18 cells),
  // the natural SP regen twice as fast (status_calc_regen_rate: rate.sp + 100; not Increase SP Recovery's) for
  // Duration1 (15 s a level + 15 s).
  PR_MAGNIFICAT: {
    name: '聖母之頌歌',
    stats: () => ({}),
    spRate: () => 100,
  },
  // the bard's and the dancer's songs, as before renewal (by request): each one's figures (b.v1, b.v2) worked out from the
  // player's stats and lesson as it starts playing (skill_unitsetting: sim.js songValues), status_change_start taking them
  // as they are (val2, val3). Perfect Tablature, FLEE + v1 and perfect dodge + v2; Impressive Riff, attack speed + v1 / 10 %
  // (aspd_rate, the largest of the skills' as Two-Hand Quicken's; not with a bow); Magic Strings, variable cast − v1 %,
  // skill delay − v2 %; Song of Lutie, MaxHP + v1 % (and HP every 6 s: sim.js songTurn); Focus Ballet, HIT + v1; Lady Luck,
  // critical + v1 / 10; Gypsy's Kiss, MaxSP + v1 %, SP cost − v2 %; Slow Grace (on enemies), attack speed − v1 / 10 % and
  // walking v2 % slower
  BA_WHISTLE: { name: '吹口哨', stats: () => ({}), flee: (lv, b) => b.v1 || 0, flee2: (lv, b) => (b.v2 || 0) * 10 },
  BA_ASSASSINCROSS: { name: '刺客的黃昏', stats: () => ({}), quick: (lv, b) => b.v1 || 0, noBow: true },
  BA_POEMBRAGI: { name: '布萊奇之詩', stats: () => ({}), varCast: (lv, b) => b.v1 || 0, delayCut: (lv, b) => b.v2 || 0 },
  BA_APPLEIDUN: { name: '伊登的蘋果', stats: () => ({}), maxHpRate: (lv, b) => b.v1 || 0 },
  DC_HUMMING: { name: '哼唱之音', stats: () => ({}), hit: (lv, b) => b.v1 || 0 },
  DC_FORTUNEKISS: { name: '女神之吻', stats: () => ({}), cri: (lv, b) => b.v1 || 0 },
  // (Magic Rod: nothing to the figures, see sim.js guard)
  SA_MAGICROD: { name: '魔法懲罰', stats: () => ({}) },
  DC_SERVICEFORYOU: { name: '為您服務', stats: () => ({}), maxSpRate: (lv, b) => b.v1 || 0, spCut: (lv, b) => b.v2 || 0 },
  DC_DONTFORGETME: { name: '勿忘我', stats: () => ({}), slowAspd: (lv, b) => b.v1 || 0, slow: (lv, b) => b.v2 || 0 },
  // Amp (skills/archer/amp.cpp, pre-renewal): no status, it only ends the user's playing (sim.js)
  BD_ADAPTATION: { name: '臨機應變', stats: () => ({}) },
  // the ensembles (pre-renewal: skill_unitsetting, status_calc_*): Battle Theme, weapon ATK + 25 × (Lv + 1), hard DEF + 2 ×
  // (Lv + 1); Harmonic Lick (The Ring of Nibelungen), weapon ATK + 25 × (Lv + 2) with a level 4 weapon; Acoustic Rhythm,
  // 55 + 5 × Lv % less damage of every element but neutral, 10 × Lv % resisting most statuses (status_get_sc_def); Mental
  // Sensing, EXP + 25 + 11 × Lv % (sim.js giveExp); Power Chord, no gemstones (sim.js)
  BD_DRUMBATTLEFIELD: { name: '戰鼓震天', stats: () => ({}), watk: lv => 25 * (lv + 1), def: lv => 2 * (lv + 1) },
  BD_RINGNIBELUNGEN: { name: '尼貝隆根之戒指', stats: () => ({}), watk4: lv => 25 * (lv + 2) },
  BD_SIEGFRIED: { name: '不死神齊格弗里德', stats: () => ({}),
    subEle: lv => Object.fromEntries(['Water', 'Earth', 'Fire', 'Wind', 'Poison', 'Holy', 'Dark', 'Ghost', 'Undead'].map(e => [e, 55 + 5 * lv])), ailResist: lv => 10 * lv },
  BD_RICHMANKIM: { name: '經驗值倍增', stats: () => ({}) },
  BD_INTOABYSS: { name: '觸媒之所', stats: () => ({}) },
  // playing (status_calc_speed, SC_DANCING): 500 − 40 × the lesson's level % slower, the level as its own here
  BD_PERFORMING: { name: '演奏中', stats: () => ({}), slow: lv => 500 - 40 * lv },
  // Sight (skills/mage/sight.cpp, SC_SIGHT): for Duration1 (10 s), every 250 ms (status_change_timer) it ends
  // hiding and cloaking on enemies within its splash (3 cells: 7×7) of the user. Nothing to the stats; nothing
  // in the sandbox hides yet, so only its fireballs show.
  MG_SIGHT: {
    name: '火狩',
    stats: () => ({}),
  },
  // Ruwach (skills/acolyte/ruwach.cpp, SC_RUWACH): Sight's like, 2 cells (5×5) round the user for Duration1
  // (10 s), and each enemy it brings out takes a holy hit (SKILLS.AL_RUWACH; see sim.js step)
  AL_RUWACH: {
    name: '光獵',
    stats: () => ({}),
  },
  // Energy Coat (skills/mage/energycoat.cpp, SC_ENERGYCOAT): for Duration1 (5 min) every weapon or magic attack
  // that lands on the user takes SP and is cut by how much SP it has left (battle_calc_damage, renewal): see
  // energyCoat. Nothing to the stats.
  MG_ENERGYCOAT: {
    name: '能量外套',
    stats: () => ({}),
  },
  // Hiding (SC_HIDING): nothing to the stats; what it does is in sim.js (DOES.hide)
  TF_HIDING: {
    name: '隱匿',
    stats: () => ({}),
  },
  // Cloaking (SC_CLOAKING): its walk and critical rate are playerStatus' own; the rest is in sim.js (DOES.cloak)
  AS_CLOAKING: {
    name: '偽裝',
    stats: () => ({}),
  },
  SM_ENDURE: {
    name: '霸體',
    stats: () => ({}),
    mdef: lv => lv,
    endure: true,
    hits: 7,
  },
};
// Passive skills worked out (learned levels change the character; nothing to use). The attacker's status
// carries what applies: doubleAttack = the Double Attack level when a dagger is held (see attack);
// hitBonus = Vulture's Eye's level, added to the hit rate of every attack (renewal is_attack_hitting: not
// in the status window's HIT); vulture = its level again, which adds to a bow's range (status_calc_pc,
// already counted into the status' range) and to the range of the bow skills (see skillRange);
// mastery = the flat ATK of the weapon masteries for the weapon held (MASTERY); fatalBlow = Fatal Blow
// learned (see SM_BASH). HP Recovery, Moving HP Recovery and Increase SP Recovery change the character's regen
// (sim.js regen).
// stats(lv): what a passive skill adds to the stats (playerStatus). Owl's Eye: DEX + Lv.
// flee(lv, job), haste(lv, job): FLEE it adds, movement haste % it gives. Improve Dodge (status_calc_pc): FLEE
// + 3 × Lv, + 4 × Lv for the Thief's second jobs on (JOBL_2, MAPID_THIEF); for the Assassin line also
// movement haste Lv % (status_calc_speed, MAPID_ASSASSIN).
// Enlarge Weight Limit, Discount and Overcharge: learned, but nothing yet (the sandbox has no items, weight or
// zeny: by request).
// Sonic Acceleration (AS_SONICACCEL, a quest skill): Sonic Blow hits more often and harder (SKILLS).
// Righthand / Lefthand Mastery (AS_RIGHT / AS_LEFT): the shares of a dual-wield attack's two hands (sim.js hands).
// Riding (KN_RIDING): a Knight that has learned it rides a Peco when its toggle is on (sim.js ride; `toggle`: on the
// hotbar, though passive); Cavalier Mastery (KN_CAVALIERMASTERY): its attack speed back while riding (playerStatus).
// Hilt Binding (BS_HILTBINDING): STR + 1 (status_calc_pc), 4 mastery ATK on every attack but Cart Revolution's
// (battle_calc_attack_masteries, renewal: src.hilt), and the blacksmith's party buffs a tenth longer (sim.js
// partyBuff). Weaponry Research (BS_WEAPONRESEARCH): 2 × Lv mastery ATK with any weapon, bare hands too
// (battle_addmastery, renewal: in src.mastery), and its hidden hit, the hit rate 2 × Lv % of itself more
// (is_attack_hitting: src.hitPct). Skin Tempering (BS_SKINTEMPER): neutral damage Lv % less, fire 5 × Lv % less
// (status_calc_pc subele: `subEle`, see resisted).
// Faith (CR_TRUST): MaxHP + 200 × Lv, holy damage 5 × Lv % less.
// Iron Fists (MO_IRONHAND): a weapon mastery (MASTERY). Dodge (MO_DODGE): FLEE + 3 × Lv / 2 (status_calc_pc).
// Spiritual Cadence (MO_SPIRITSRECOVERY): regen while sitting (sim.js regen). Raging Trifecta Blow (MO_TRIPLEATTACK):
// at 30% a normal attack is the skill instead (sim.js triple).
// Pushcart: a character that has learned it pulls a cart (the sandbox has no Kafra to rent one from), walking
// slower the lower its level (see playerStatus' walkSpeed).
const THIEF_2ND = /^(Assassin|Assassin_Cross|Guillotine_Cross|Shadow_Cross|Rogue|Stalker|Shadow_Chaser|Abyss_Chaser)/;
const ASSASSIN = /^(Assassin|Assassin_Cross|Guillotine_Cross|Shadow_Cross)/;
// (Music Lessons: ASPD + Lv %, whatever the weapon, status_calc_aspd; Dance Lessons: critical + Lv %, status_calc_pc,
// renewal; both MaxSP + Lv %, status_get_spbonus; their ATK with the weapon: MASTERY)
export const PASSIVE_SKILLS = { BA_MUSICALLESSON: { aspd: lv => lv, maxSpRate: lv => lv }, DC_DANCINGLESSON: { cri: lv => 10 * lv, maxSpRate: lv => lv }, TF_DOUBLE: {}, AC_VULTURE: {}, SM_SWORD: {}, SM_TWOHAND: {}, SM_RECOVERY: {},
  AS_RIGHT: {}, AS_LEFT: {}, AS_KATAR: {}, AS_SONICACCEL: {}, PR_MACEMASTERY: {}, KN_SPEARMASTERY: {}, KN_RIDING: { toggle: true }, KN_CAVALIERMASTERY: {}, SM_MOVINGRECOVERY: {}, SM_FATALBLOW: {}, MC_PUSHCART: {}, MC_INCCARRY: {}, MC_DISCOUNT: {}, MC_OVERCHARGE: {}, AC_OWL: { stats: lv => ({ dex: lv }) }, MG_SRECOVERY: {}, AL_DP: {}, AL_DEMONBANE: {}, HT_BEASTBANE: {}, HT_FALCON: { toggle: true }, HT_STEELCROW: {},
  BS_HILTBINDING: { stats: () => ({ str: 1 }) }, BS_WEAPONRESEARCH: {}, BS_SKINTEMPER: { subEle: lv => ({ Neutral: lv, Fire: 5 * lv }) },
  // (Faith: MaxHP + 200 × Lv, status_get_hpbonus; holy damage 5 × Lv % less, status_calc_pc subele)
  CR_TRUST: { maxHp: lv => 200 * lv, subEle: lv => ({ Holy: 5 * lv }) },
  MO_IRONHAND: {}, MO_SPIRITSRECOVERY: {}, MO_TRIPLEATTACK: {}, MO_DODGE: { flee: lv => idiv(3 * lv, 2) },
  // (Axe Mastery: MASTERY; Potion Research: the potions' HP and SP 5 × Lv % more, drunk or thrown, sim.js potionHeal and
  // pitchPotion; Acid Terror's 100 % more, SKILLS)
  AM_AXEMASTERY: {}, AM_LEARNINGPOTION: {}, AM_BIOETHICS: {},
  // (Stalk: walking in hiding, slower: playerStatus' walkSpeed, sim.js stuck; Gank: a steal with a normal attack, sim.js
  // gank; Slyness: monsters leave sitting rogues be, sim.js slyOff; Haggle: the weapon shop cheaper, levels.js buyOff.)
  // Plagiarism: its ASPD + Lv % (status_calc_aspd, renewal: as Musical Lesson's); the skill it copies is not here
  RG_TUNNELDRIVE: {}, RG_SNATCHER: {}, RG_GANGSTER: {}, RG_COMPULSION: {}, RG_PLAGIARISM: { aspd: lv => lv },
  // (Study: its ATK with a book, MASTERY; Dragonology: INT + (Lv + 1) / 2, on dragons physical damage 4 × Lv % more,
  // magic 2 × Lv %, and theirs 4 × Lv % less: status_calc_pc)
  SA_ADVANCEDBOOK: { cut: lv => 5 * lv, weapons: ['Book'] }, SA_FREECAST: {},
  SA_DRAGONOLOGY: { stats: lv => ({ int: idiv(lv + 1, 2) }), addRace: lv => ({ Dragon: 4 * lv }), magicAddRace: lv => ({ Dragon: 2 * lv }), subRace: lv => ({ Dragon: 4 * lv }) },
  TF_MISS: { flee: (lv, job) => lv * (THIEF_2ND.test(job.name) ? 4 : 3), haste: (lv, job) => ASSASSIN.test(job.name) ? lv : 0 } };
// Weapon masteries (battle_addmastery, renewal): ATK per level with the weapon types each goes with. Sword
// Mastery: daggers and one-handed swords; Two-Handed Sword Mastery: two-handed swords; Spear Mastery: spears of
// either hand (`ride`: 5 a level riding a Peco); Katar Mastery: katars; Mace Mastery: maces of either hand, 3 a
// level, and critical + Lv % with one (`cri`, tenths of a percent: status_calc_pc, renewal); Iron Fists: bare hands and
// knuckles, 3 a level.
export const MASTERY = { SM_SWORD: { atk: 4, weapons: ['Dagger', '1hSword'] }, SM_TWOHAND: { atk: 4, weapons: ['2hSword'] },
  KN_SPEARMASTERY: { atk: 4, ride: 5, weapons: ['1hSpear', '2hSpear'] }, AS_KATAR: { atk: 3, weapons: ['Katar'] },
  BA_MUSICALLESSON: { atk: 3, weapons: ['Musical'] }, DC_DANCINGLESSON: { atk: 3, weapons: ['Whip'] },
  PR_MACEMASTERY: { atk: 3, cri: 10, weapons: ['Mace', '2hMace'] }, MO_IRONHAND: { atk: 3, weapons: ['Fist', 'Knuckle'] },
  SA_ADVANCEDBOOK: { atk: 3, weapons: ['Book'] },
  // (Axe Mastery: axes of either hand, and in renewal one-handed swords too, 3 a level)
  AM_AXEMASTERY: { atk: 3, weapons: ['1hAxe', '2hAxe', '1hSword'] } };
// HP Recovery (status_calc_regen: sregen): every natural_heal_skill_interval, while not walking and short of
// full HP, 5 × Lv + Lv × MaxHP / 500 HP, shown
export const SKILL_REGEN_MS = 10000;
export const recoveryHp = (lv, maxHp) => lv * 5 + idiv(lv * maxHp, 500);
// Increase SP Recovery (the same sregen): 3 × Lv + Lv × MaxSP / 500 SP, on the same terms
export const recoverySp = (lv, maxSp) => lv * 3 + idiv(lv * maxSp, 500);
// Spiritual Cadence (status_calc_regen: ssregen, sitting only): 4 × Lv + Lv × MaxHP / 500 HP and 2 × Lv + Lv × MaxSP
// / 500 SP every natural_heal_skill_interval
export const cadenceHp = (lv, maxHp) => lv * 4 + idiv(lv * maxHp, 500);
export const cadenceSp = (lv, maxSp) => lv * 2 + idiv(lv * maxSp, 500);
// Skills that restore HP (TargetType Support): amount(src, lv) → the heal before MATK (skill_calc_heal).
export const HEAL_SKILLS = {
  // Heal (skills/acolyte/heal.cpp → skill_calc_heal, renewal): (BaseLv + INT) / 5 × 30 × Lv / 10, in C's
  // integer steps; Lv 11 and up would be max_heal (9999). No Meditatio or heal-power bonuses here.
  // (a character's cards' bHealPower: that % more, skill_calc_heal's add_heal_rate)
  AL_HEAL: { amount: (src, lv) => idiv(idiv(idiv(src.lv + src.stats.int, 5) * 30 * lv, 10) * (100 + (src.kind === 'pc' ? src.healBonus || 0 : 0)), 100) },
  // the homunculi's Healing Hands and Chaotic Blessings (skill_calc_heal's default, the same as Heal's), Brain Surgery's
  // + 2 × Lv % on it (renewal hp_bonus, before the MATK)
  HLIF_HEAL: { amount: (src, lv) => HEAL_SKILLS.AL_HEAL.amount(src, lv) * (100 + (src.healBonus || 0)) / 100 | 0 },
  HVAN_CHAOTIC: { amount: (src, lv) => HEAL_SKILLS.AL_HEAL.amount(src, lv) * (100 + (src.healBonus || 0)) / 100 | 0 },
};
// Sanctuary's heal (skill_calc_heal): 100 × Lv, 777 from Lv 7, a second (no MATK, renewal; no heal bonuses here)
export const sanctuaryHeal = lv => lv > 6 ? 777 : 100 * lv;
// A monster's Aid Potion (skills/merchant/aidpotion.cpp, not a player's): 45, 105, 175 or 325 (Lv 4 on) plus
// 0…Lv × 20 at random, × (150 + 10 × Lv) %, × (100 + 2 × the target's VIT) % (on a player, Increase HP Recovery
// would add 10% a level: not in the sandbox)
export function mobPotion(lv, dst, rnd = fightRnd) {
  const base = [45, 105, 175][lv - 1] ?? 325;
  const hp = idiv((base + rnd(lv * 20 + 1)) * (150 + lv * 10), 100);
  return idiv(hp * (100 + dst.stats.vit * 2), 100);
}
// undead_detect_type 0 (battle.conf): undead means the undead element, whatever the race
export const isUndead = st => st.element === 'Undead';
// what Divine Protection and Demon Bane work against: a monster that is undead (battle_check_undead) or of the
// demon race
export const unholy = st => st.kind === 'mob' && (isUndead(st) || st.race === 'Demon');
// Demon Bane (battle_addmastery, renewal): Lv × (BaseLv / 20 + 3) mastery ATK, truncated, on a monster that is
// unholy (src.demonBane: its level)
const demonBaneAtk = (src, dst) => src.demonBane && unholy(dst) ? Math.trunc(src.demonBane * (src.lv / 20 + 3)) : 0;
// Beast Bane (battle_addmastery): 4 × Lv mastery ATK on a brute or an insect (src.beastBane: its level; the Hunter Spirit's
// STR on top is not in the sandbox)
const beastBaneAtk = (src, dst) => src.beastBane && (dst.race === 'Brute' || dst.race === 'Insect') ? 4 * src.beastBane : 0;
// Divine Protection (battle_calc_defense_reduction, renewal): a player's soft DEF + (BaseLv / 25 + 3) × Lv,
// rounded, against an unholy monster's physical attacks (dst.divine: its level)
const divineDef = (src, dst) => dst.divine && unholy(src) ? Math.trunc((dst.lv / 25 + 3) * dst.divine + 0.5) : 0;
// A status started on dst by src at `rate` % for `ms` (status_change_start → status_get_sc_def, renewal):
// `stat` × 100 of the target's (hard MDEF for a freeze, VIT for a stun), less the caster's level advantage
// ((its excess over the target's)² / 5 × 100), resists it in hundredths of a percent: the rate drops by that
// share (rounded up to the next 0.1%) and so does the time, which then gets -tickDef2 ms more. Result:
// { chance (%), ms }.
// (+ `dst.ailResist` %, Acoustic Rhythm's, on blindness, stone, freezing, stunning, curses, sleep and silence: status_get_sc_def)
// (`kind`: the status, for a character's cards' resistance to it, dst.resEff: that much (1/10000) of the rate off after
// the natural resistance, and of the time — renewal — after its share)
function scOdds(src, dst, rate, ms, stat, tickDef2, resist = true, kind = null) {
  const up = Math.max(0, src.lv - dst.lv), adv = idiv(up * up, 5) * 100, def = clamp((stat + (resist ? dst.ailResist || 0 : 0)) * 100 - adv, 0, 10000);
  const res = kind && dst.resEff ? dst.resEff[kind] || 0 : 0;
  let r = rate * 100;
  r -= idiv(r * def, 10000);
  r -= idiv(r * res, 10000);
  if (r > 0 && r % 10) r += 10 - r % 10;
  let t = ms - idiv(ms * def, 10000);
  t -= idiv(t * res, 10000);
  return { chance: Math.max(0, r) / 100, ms: t - tickDef2 };
}
// SC_FREEZE: Boss class resists it (BossResist), and the undead element or race cannot be frozen; hard MDEF
// resists it, and it lasts 3 s more (tick_def2 −3000). Chance 0 when immune.
export function freezeOdds(src, dst, rate, ms) {
  if (dst.boss || isUndead(dst) || dst.race === 'Undead') return { chance: 0, ms: 0 };
  return scOdds(src, dst, rate, ms, dst.mdef, -3000, true, 'freeze');
}
// SC_STUN: Boss class resists it (BossResist); VIT resists it, and it lasts 0.5 s more (tick_def2 −500).
export function stunOdds(src, dst, rate, ms) {
  if (dst.boss) return { chance: 0, ms: 0 };
  return scOdds(src, dst, rate, ms, dst.stats.vit, -500, true, 'stun');
}
// SC_STONEWAIT at `rate` % (Stone Curse: skills/mage/stonecurse.cpp, 4 × Lv + 20 %; Petrify Attack): Boss class
// resists it (BossResist; Stone Curse fails on a status-immune target), the undead element or race cannot be
// petrified; hard MDEF resists it, and the time (Duration2: 17 s) is cut as a freeze's and gets 3 s more (tick_def2
// −3000). Of that time the first `wait` (Duration1: Stone Curse's 5 s, Petrify Attack's 0.1 s) is the stone wait and
// the rest the stone (status_change_start: val3 = tick − delay). Result: { chance (%), wait (ms), ms (the stone's) }.
export function petrifyOdds(src, dst, rate, wait, ms) {
  if (dst.boss || isUndead(dst) || dst.race === 'Undead') return { chance: 0, wait, ms: 0 };
  const o = scOdds(src, dst, rate, ms, dst.mdef, -3000, true, 'stone');
  return { chance: o.chance, wait, ms: Math.max(1, o.ms - wait) };
}
export const stoneOdds = (src, dst, lv, wait, ms) => petrifyOdds(src, dst, 4 * lv + 20, wait, ms);
// Energy Coat on an attack landing on a unit with sp of maxSp: the SP it takes (1% + 0.5% of MaxSP for every
// 20% of SP it has, a full one counted as 80–99%) and the % the damage is cut by (6% + 6% for every 20%)
export function energyCoat(sp, maxSp) {
  const per = idiv(idiv(100 * sp, maxSp) - 1, 20);
  return { cost: idiv((10 + 5 * per) * maxSp, 1000), cut: 6 * (1 + per) };
}
// SC_POISON (renewal status_get_sc_def): Boss class resists it (BossResist); VIT resists it, and it lasts 2 s
// more (tick_def2 −2000). SC_BLIND: the same with INT.
export function poisonOdds(src, dst, rate, ms) {
  if (dst.boss) return { chance: 0, ms: 0 };
  return scOdds(src, dst, rate, ms, dst.stats.vit, -2000, false, 'poison');
}
// A monster's equipment broken (skill_break_equip, with break_mob_equip on: by request, so the rogue's Divest skills will
// do something too) is a Divest status on it instead (sc_start SC_STRIP…, for RG_STRIP…'s Lv 1 Duration1, 75 s; a boss
// resists it, BossResist), keyed by the rogue's skill (sim.js stripMob); on a monster (status_change_start val2,
// status_calc_*): its weapon, the ATK % of its attacks 25 less (battle_get_atkpercent); its shield, hard DEF 15 % less;
// its armour, VIT 40 % less; its helm, INT 40 % less — and what goes by them with them: soft DEF, soft MDEF, the INT
// in its MATK, its resistances.
export const MOB_STRIPS = { RG_STRIPWEAPON: 25, RG_STRIPSHIELD: 15, RG_STRIPARMOR: 40, RG_STRIPHELM: 40 };
export function stripped(st, names) {
  const on = n => names.includes(n), cut = (v, n) => v - idiv(v * MOB_STRIPS[n], 100);
  const vit = on('RG_STRIPARMOR') ? cut(st.stats.vit, 'RG_STRIPARMOR') : st.stats.vit;
  const int_ = on('RG_STRIPHELM') ? cut(st.stats.int, 'RG_STRIPHELM') : st.stats.int, dInt = st.stats.int - int_;
  return { ...st, stats: { ...st.stats, vit, int: int_ },
           def: on('RG_STRIPSHIELD') ? cut(st.def, 'RG_STRIPSHIELD') : st.def,
           def2: st.def2 - (Math.trunc((st.lv + st.stats.vit) / 2) - Math.trunc((st.lv + vit) / 2)),
           mdef2: st.mdef2 - (Math.trunc((st.stats.int + st.lv) / 4) - Math.trunc((int_ + st.lv) / 4)),
           matkMin: st.matkMin - dInt, matkMax: st.matkMax - dInt,
           ...on('RG_STRIPWEAPON') && { atkRate: (st.atkRate || 0) - MOB_STRIPS.RG_STRIPWEAPON, atkBy: [...st.atkBy || [], `卸除武器 −${MOB_STRIPS.RG_STRIPWEAPON}%`] } };
}
// SC_BLEEDING (renewal status_get_sc_def): Boss class resists it (BossResist); AGI resists it, and it lasts 12 s more
// (tick_def2 −12000)
export function bleedOdds(src, dst, rate, ms) {
  if (dst.boss) return { chance: 0, ms: 0 };
  return scOdds(src, dst, rate, ms, dst.stats.agi, -12000, false, 'bleed');
}
export function blindOdds(src, dst, rate, ms) {
  if (dst.boss) return { chance: 0, ms: 0 };
  return scOdds(src, dst, rate, ms, dst.stats.int, -2000, true, 'blind');
}
// SC_SILENCE: the same as SC_BLIND (INT). SC_CONFUSION: the same with LUK.
export function silenceOdds(src, dst, rate, ms) {
  if (dst.boss) return { chance: 0, ms: 0 };
  return scOdds(src, dst, rate, ms, dst.stats.int, -2000, true, 'silence');
}
export function confuseOdds(src, dst, rate, ms) {
  dst = { ...dst, ailResist: 0 };
  if (dst.boss) return { chance: 0, ms: 0 };
  return scOdds(src, dst, rate, ms, dst.stats.luk, -2000, true, 'confuse');
}
// SC_CURSE: Boss class resists it (BossResist), and one with no LUK cannot be cursed; LUK resists it, and it
// lasts 2 s more (tick_def2 −2000). SC_SLEEP: Boss class resists it; AGI resists it, 2 s more.
export function curseOdds(src, dst, rate, ms) {
  if (dst.boss || dst.stats.luk === 0) return { chance: 0, ms: 0 };
  return scOdds(src, dst, rate, ms, dst.stats.luk, -2000, true, 'curse');
}
export function sleepOdds(src, dst, rate, ms) {
  if (dst.boss) return { chance: 0, ms: 0 };
  return scOdds(src, dst, rate, ms, dst.stats.agi, -2000, true, 'sleep');
}
// a cursed unit's status: its attacks do 25% less (battle_get_atkpercent; its LUK at 0 and its slower walk are
// playerStatus' `cursed`: only characters are cursed here)
export const cursed = st => ({ ...st, atkRate: (st.atkRate || 0) - 25, atkBy: [...st.atkBy || [], '詛咒 −25%'] });
// SC_DECREASEAGI (Decrease AGI: skills/acolyte/decagi.cpp): 50 + 3 × Lv + (BaseLv + INT) / 5 % of the caster's;
// Boss class resists it (BossResist). Renewal status_get_sc_def takes the target's hard MDEF off that in whole
// percents (sc_def2 = MDEF × 100, capped at mob_max_sc_def 100%), rounded up to the next 0.1%; its time
// (Duration1) is not cut, only halved on a player. Result: { chance (%), ms }.
export function decAgiOdds(src, dst, lv, ms) {
  if (dst.boss) return { chance: 0, ms: 0 };
  let r = (50 + 3 * lv + idiv(src.lv + src.stats.int, 5)) * 100 - clamp(dst.mdef, 0, 100) * 100;
  if (r > 0 && r % 10) r += 10 - r % 10;
  return { chance: Math.max(0, r) / 100, ms: dst.kind === 'pc' ? idiv(ms, 2) : ms };
}
// a unit under Decrease AGI Lv lv: AGI − (2 + Lv), down to 0 (status_calc_agi), and with it the FLEE it gave
// (status_calc_flee: Lv + AGI + …). Its slower pace is sim.js' (SLOW).
// a unit under Quagmire Lv lv (SC_QUAGMIRE: status_calc_agi / _dex): AGI and DEX − 5 × Lv for a character, 10 × Lv for
// a monster (val2), and FLEE and HIT down with them (as slowed: the rest worked out from them is not)
export function quagmired(st, lv) {
  const k = (st.kind === 'pc' ? 5 : 10) * lv, agi = Math.max(0, st.stats.agi - k), dex = Math.max(0, st.stats.dex - k);
  return { ...st, stats: { ...st.stats, agi, dex }, flee: st.flee - (st.stats.agi - agi), hit: st.hit - (st.stats.dex - dex) };
}
export function slowed(st, lv) {
  const agi = Math.max(0, st.stats.agi - (2 + lv));
  return { ...st, stats: { ...st.stats, agi }, flee: st.flee - (st.stats.agi - agi) };
}
// SC_SIGNUMCRUCIS (Signum Crucis: skills/acolyte/crucis.cpp): 25 + 4 × Lv + the caster's BaseLv − the target's
// % (sc_start; nothing resists it in status_get_sc_def), on an unholy monster only (status_change_start: undead
// or demon, never a player). Result: the chance in %.
export const crucisOdds = (src, dst, lv) => unholy(dst) ? Math.max(0, 25 + 4 * lv + src.lv - dst.lv) : 0;
// a monster under Signum Crucis Lv lv: hard DEF − (10 + 4 × Lv) % of it, truncated (status_calc_def, after
// poison's); crucis: that %, for the damage's steps
export const crossed = (st, lv) => ({ ...st, def: st.def - idiv(st.def * (10 + 4 * lv), 100), crucis: 10 + 4 * lv });
// a poisoned unit's status: a monster's hard DEF and anyone's soft DEF × 75% (status_calc_def / def2); a
// blinded one's HIT and FLEE × 75% (status_calc_hit / flee)
export const poisoned = st => ({ ...st, def: st.kind === 'mob' ? idiv(st.def * 75, 100) : st.def, def2: idiv(st.def2 * 75, 100) });
export const blinded = st => ({ ...st, hit: st.hit - idiv(st.hit * 25, 100), flee: st.flee - idiv(st.flee * 25, 100) });
// one held by Fiber Lock's web (SC_SPIDERWEB): FLEE × 50% (status_calc_flee, before blindness'), and fire does double
// on it (attrOf)
export const webbed = st => ({ ...st, flee: st.flee - idiv(st.flee * 50, 100), webbed: true });
// poison's HP loss a second (status_change_timer SC_POISON): 2 + 1.5% of MaxHP for a player, 2 + 0.5% for a
// monster, while that leaves more than a quarter
export const poisonDamage = st => 2 + (st.kind === 'pc' ? idiv(st.maxHp * 3, 200) : idiv(st.maxHp, 200));
// a petrified unit's status (status_calc_element / _element_lv / _def / _mdef): Earth 1, hard DEF halved,
// hard MDEF + 25%
export const stoned = st => ({ ...st, element: 'Earth', elementLv: 1, def: idiv(st.def, 2), mdef: st.mdef + idiv(25 * st.mdef, 100), stone: true });
// a frozen monster's status (status_calc_element / _element_lv / _def / _mdef): Water 1, hard DEF halved,
// hard MDEF + 25%
export const frozen = st => ({ ...st, element: 'Water', elementLv: 1, def: idiv(st.def, 2), mdef: st.mdef + idiv(25 * st.mdef, 100), frozen: true });
// A heal skill used on dst. It restores its amount plus the user's MATK (a player's base MATK has no
// spread: status_base_matk_min = max), shown in full even when the target's HP tops out (clif_skill_nodamage).
// On an undead target a player's Heal hurts instead (skill_castend_nodamage_id → skill_attack, BF_MAGIC):
// battle_calc_magic_attack takes skill_calc_heal with heal = false, which halves the amount before the
// MATK goes on, then the skill's element against the target's (Holy on Undead); IgnoreDefense skips MDEF.
// Magic always hits. Result: { type: 'heal' | 'hit', damage (the amount either way), steps, skill }.
// A monster's Heal (Smokie's, the dummies'): its MATK somewhere from min to max, plus its weapon MATK; at level
// max_heal_lv (11) or above, max_heal (9999) and nothing more (skill_calc_heal).
// A player's MATK for one cast (status_get_matk, renewal): its base MATK (no spread) plus its weapon's MATK ± weapon
// level × 10 % of it (status_calc_pc's variance: rnd_value between min and max)
export function pcMatk(src, rnd = fightRnd) {
  const rated = m => m + idiv(m * (src.matkRate || 0), 100);  // (the Ring of Nibelungen's: SP_MATK_RATE)
  if (!src.wmatk) return rated(src.matk);
  const v = idiv(src.wmatk * src.wlv, 10);
  return rated(src.matk + src.wmatk - v + rnd(2 * v + 1));
}
export function heal(db, src, dst, sk, lv, rnd = fightRnd) {
  const s = { ...sk, lv };
  if (src.kind === 'mob' && lv >= 11) return { type: 'heal', damage: 9999, steps: [['Lv 11 以上：max_heal', 9999]], skill: s };
  const amount = HEAL_SKILLS[sk.name].amount(src, lv);
  const steps = [[`(Lv ${src.lv} + INT ${src.stats.int}) / 5 × 30 × ${lv} / 10${src.healBonus ? ` × ${100 + src.healBonus}%` : ''}`, amount]];
  if (!(src.kind === 'pc' && dst.kind === 'mob' && isUndead(dst))) {
    const matk = src.kind === 'mob' ? src.matkMin + rnd(src.matkMax - src.matkMin + 1) + src.wmatk : pcMatk(src, rnd);
    steps.push([`+ MATK ${matk}`, amount + matk]);
    // (Assumptio on the one healed: skill_calc_heal's hp_bonus)
    const more = dst.healIn ? Math.trunc((amount + matk) * dst.healIn / 100) : 0;
    if (more) steps.push([`聖母之祈福 +${dst.healIn}%`, amount + matk + more]);
    return { type: 'heal', damage: amount + matk + more, steps, skill: s };
  }
  let dmg = idiv(amount, 2);
  steps.push(['攻擊不死：÷ 2', dmg]);
  const matk = pcMatk(src, rnd);
  dmg += matk;
  steps.push([`+ MATK ${matk}`, dmg]);
  const ratio = attrOf(db, sk.element, dst, src);
  dmg = Math.trunc(dmg * ratio / 100);
  steps.push([`${ELEMENT_ZH[sk.element]}屬性對${ELEMENT_ZH[dst.element]} ${dst.elementLv} ${ratio}%`, dmg]);
  return { type: 'hit', damage: Math.max(0, dmg), steps, skill: s, hits: 1 };
}
// Double Attack chance in % (battle_calc_multi_attack, renewal: 7×Lv; pre-renewal 5×Lv)
export const doubleRate = lv => 7 * lv;
// a status with a status change on it (sc: from STATUS_SKILLS, or null): DEF cut by sc.def % (status_calc_def
// / def2, truncated), sc.atk % added to the ratio of its attacks (renewal battle_get_atkpercent; atkBy: what
// made up that %, for the damage's steps)
export function withStatus(st, sc) {
  if (!sc) return st;
  const cut = v => v - Math.trunc(v * sc.def / 100);
  return { ...st, def: st.kind === 'mob' ? cut(st.def) : st.def, def2: cut(st.def2), sc,
           ...sc.atk && { atkRate: (st.atkRate || 0) + sc.atk, atkBy: [...st.atkBy || [], `${sc.name} +${sc.atk}%`] } };
}
// skill_get_range2: a negative range in skill_db is the skill's own range, negated (the weapon's range is
// used instead only with skillrange_from_weapon, 0 by default). Vulture's Eye adds its level to the skills
// flagged for it (AlterRangeVulture, jobs.json 'vultureRange': the bow ones), src.vulture being its level.
export const skillRange = (sk, lv, src) => Math.abs(sk.range[lv - 1]) + (sk.vultureRange ? src.vulture || 0 : 0);
// Renewal cast time (skill_vfcastfix): the fixed part is FixedCastTime, or default_fixed_castrate (20%) of
// the cast time when the skill has none; the variable rest shrinks with DEX×2 + INT, gone at 530.
// The statuses' % (src.varCast: Suffragium's, VARCAST_REDUCTION) comes off the variable part before that.
// Monsters cast for the time mob_skill_db gives, unreduced.
export function castTime(sk, lv, src) {
  const base = sk.cast[lv - 1] || 0, fx = sk.fixedCast[lv - 1];
  const fixed = fx >= 0 ? fx : Math.trunc(base * 20 / 100), variable = fx >= 0 ? base : base - fixed;
  const k = Math.max(0, 1 - Math.sqrt((src.stats.dex * 2 + src.stats.int) / 530));
  // (a card's on this skill alone too: bonus2 bVariableCastrate, skill_vfcastfix's pc_bonus' skillcastrate)
  const cut = (src.varCast || 0) + ((src.castSkill || {})[sk.name] || 0);
  return Math.trunc(variable * (1 - Math.min(cut, 100) / 100) * k) + fixed;
}
// skill_delayfix: the skill's delay (negative adds to the attack motion), at least min_skill_delay_limit,
// from the moment it goes off (the delays that start with the cast: see castDelays)
export function skillDelay(sk, lv, src) {
  const d = sk.delay[lv - 1] || 0;
  if (COMBO_DELAY.has(sk.name)) return Math.max((d || 1000) - 4 * src.stats.agi - 2 * src.stats.dex, 100);
  // (less the statuses' %: Magic Strings')
  return Math.max(Math.trunc((d < 0 ? -d + src.amotion : d) * (1 - Math.min(src.delayCut || 0, 100) / 100)), 100);
}
// the monk's combo skills: their delay (none set: 1000 ms) less 4 × AGI and 2 × DEX (skill_delayfix), which is also
// how long the next one in the chain has to follow (sim.js combo)
const COMBO_DELAY = new Set(['MO_TRIPLEATTACK', 'MO_CHAINCOMBO', 'MO_COMBOFINISH']);
// unit_set_attackdelay (DELAY_EVENT_CASTBEGIN, players): as a skill starts (its cast, or it goes off at once)
// the next normal attack waits the whole attack delay (attackabletime: tick + adelay), and the next skill the
// attack motion plus half the shortest attack motion the job can reach (canact_tick: tick + amotion +
// pc_maxaspd / AMOTION_DIVIDER_PC, which evens the two out at top ASPD). ms from the start.
export const castDelays = (src, maxAspd) => ({ attack: src.adelay, act: src.amotion + (2000 - maxAspd * 10) / 2 });

// Crowding (is_attack_hitting, battle.conf agi_penalty_*): a player attacked by `n` units at once
// (unit_counttargeted) with n ≥ AGI_PENALTY_COUNT loses AGI_PENALTY_NUM % of its FLEE for each one from the
// AGI_PENALTY_COUNT-th on (type 1, a percentage), keeping at least 1. Perfect dodge is not touched.
export const AGI_PENALTY_COUNT = 3, AGI_PENALTY_NUM = 10;
export const crowdedFlee = (flee, n) => n < AGI_PENALTY_COUNT ? flee
  : Math.max(1, Math.trunc(flee * (100 - (n - (AGI_PENALTY_COUNT - 1)) * AGI_PENALTY_NUM) / 100));
// critical: is_attack_critical (tenths of a percent; the target's LUK lowers it, and it is twice as likely on
// one asleep)
// (a card's on the target's race too: critaddrace, after the katar's doubling)
// (and a card's on a bow's normal attack: critical_rangeatk, is_skill_using_arrow)
const critRate = (src, dst) => (src.cri + (src.criRace ? (src.criRace[dst.race] || 0) + (src.criRace.All || 0) : 0) + (src.weapon === 'Bow' ? src.critLong || 0 : 0) -
  dst.stats.luk * (src.kind === 'mob' && dst.kind === 'pc' ? 3 : 2)) * (dst.asleep ? 2 : 1);
// hit: is_attack_hitting (renewal base hit rate is 0; a skill's bonus goes on before the min_hitrate 5 /
// max_hitrate 100 caps)
// src.hitBonus goes on first (before a skill's bonus, which is a share of the rate); bonus is added after
// (a double attack's +Lv); then the caps
// One frozen, stunned, asleep or stone (opt1, not the stone wait: dst.opt1) is always hit.
// (src.hitPct: that % of the rate more, after them: Weaponry Research's)
const hitRate = (src, dst, skill, lv, bonus = 0) => {
  if (dst.opt1) return 100;
  const r = src.hit - dst.flee + (src.hitBonus || 0), h = (skill && skill.hit ? skill.hit(r, lv, src) : r) + bonus;
  return clamp(h + idiv(h * (src.hitPct || 0), 100), 5, 100);
};
// chances in percent, for display (double: Double Attack's chance and its hit rate)
export function odds(src, dst) {
  const dbl = src.doubleAttack || 0;
  return { lucky: dst.flee2 / 10, crit: clamp(critRate(src, dst), 0, 1000) / 10, hit: hitRate(src, dst),
           double: dbl ? doubleRate(dbl) : 0, doubleHit: hitRate(src, dst, null, 0, dbl) };
}

// DEF reduction (battle_calc_defense_reduction, renewal): × (4000 + DEF) / (4000 + 10 × DEF), minus
// soft DEF, at least 1. Against players soft DEF is used as is (no random part in renewal).
// `more`: soft DEF a passive adds against this attacker (Divine Protection)
function defReduce(dmg, dst, steps, more = 0) {
  if (!dmg) return dmg;
  const def1 = dst.def === -400 ? -399 : dst.def;
  dmg = Math.trunc(dmg * (4000 + def1) / (4000 + 10 * def1)) - dst.def2 - more;
  steps.push([`DEF ${dst.def}${dst.crucis ? `（天使之光 −${dst.crucis}%）` : ''}＋${dst.def2}${more ? `＋${more}（天使之護）` : ''}${dst.sc ?`（${dst.sc.name} −${dst.sc.def}%）` : ''}`, dmg]);
  return Math.max(1, dmg);
}

// a player's resistance to the element of an attack on it (battle_calc_cardfix on the target, after DEF or MDEF: the
// subele of its passives, dst.subEle — Skin Tempering's): the damage that % less
export function resisted(dmg, ele, dst, steps) {
  const n = ((dst.subEle || {})[ele] || 0) + ((dst.subEle || {}).All || 0);
  if (!n || !dmg) return dmg;
  dmg -= Math.trunc(dmg * n / 100);
  steps.push([`${ELEMENT_ZH[ele]}屬性抗性 −${n}%`, dmg]);
  return dmg;
}
// a race's share (battle_calc_cardfix): the attacker's % more on the target's race (a player's addrace, or with magic
// magic_addrace: Dragonology's), the target's % less from the attacker's (subrace); `magic`: a spell's element (the endows' magic_atk_ele too)
const RACE_ZH = { Dragon: '龍族', Demon: '惡魔型', Formless: '無形', Undead: '不死', Brute: '動物', Plant: '植物', Insect: '昆蟲', Fish: '魚貝', Demihuman: '人形', Angel: '天使' };
const SIZE_ZH = { Small: '小型', Medium: '中型', Large: '大型' };
// a card's % on a weapon attack (battle_calc_cardfix BF_WEAPON, renewal: on the weapon's and the equipment ATK only):
// the target's race, element, size and class each a factor of its own, in tenths of a percent (cardfix 1000), or null
export function cardfixOf(src, dst) {
  const f = src.cardfix;
  if (!f) return null;
  const of = (o, k) => (o[k] || 0) + (o.All || 0);
  let n = 1000;
  for (const x of [of(f.race, dst.race), of(f.ele, dst.element), of(f.size, dst.size), of(f.cls, dst.boss ? 'Boss' : 'Normal')]) n = idiv(n * (100 + x), 100);
  // (its race groups', each a factor of its own: addrace2; and one monster's, add_dmg)
  for (const g of dst.race2 || []) if (f.race2 && f.race2[g]) n = idiv(n * (100 + f.race2[g]), 100);
  if (f.mob && dst.mobId && f.mob[dst.mobId]) n = idiv(n * (100 + f.mob[dst.mobId]), 100);
  return n === 1000 ? null : n;
}
// (APPLY_CARDFIX: the damage less its share of 1000 − cardfix)
const applyFix = (dmg, n) => dmg - Math.trunc(dmg * (1000 - n) / 1000);
export function raced(dmg, src, dst, steps, magic = false) {
  if (!dmg || !src || !dst) return dmg;
  const of = (o, k) => o ? (o[k] || 0) + (o.All || 0) : 0;
  const up = of(magic ? src.magicAddRace : src.addRace, dst.race), down = of(dst.subRace, src.race);
  if (up) { dmg = Math.trunc(dmg * (100 + up) / 100); steps.push([`對${RACE_ZH[dst.race] || dst.race} +${up}%`, dmg]); }
  // (and with magic of an element, its magic_atk_ele: the endows')
  const ele = magic && magic !== true ? of(src.magicAtkEle, magic) : 0;
  if (ele) { dmg = Math.trunc(dmg * (100 + ele) / 100); steps.push([`${ELEMENT_ZH[magic]}屬性魔法 +${ele}%`, dmg]); }
  // (a card's on magic besides: the target's element, size and class, each a factor of its own: battle_calc_cardfix BF_MAGIC)
  if (magic && src.magicFix) for (const [k, n] of [['屬性', of(src.magicFix.ele, dst.element)], ['體型', of(src.magicFix.size, dst.size)], ['', of(src.magicFix.cls, dst.boss ? 'Boss' : 'Normal')]])
    if (n) { dmg = Math.trunc(dmg * (100 + n) / 100); steps.push([`卡片魔法對${k === '屬性' ? ELEMENT_ZH[dst.element] + '屬性' : k === '體型' ? SIZE_ZH[dst.size] : dst.boss ? 'BOSS' : '一般怪物'} +${n}%`, dmg]); }
  if (down) { dmg -= Math.trunc(dmg * down / 100); steps.push([`${RACE_ZH[src.race] || src.race}抗性 −${down}%`, dmg]); }
  // (and a card's less from the attacker's size and class: subsize, subclass)
  const lessSize = of(dst.subSize, src.size), lessCls = of(dst.subClass, src.boss ? 'Boss' : 'Normal');
  if (lessSize) { dmg -= Math.trunc(dmg * lessSize / 100); steps.push([`${SIZE_ZH[src.size]}抗性 −${lessSize}%`, dmg]); }
  if (lessCls) { dmg -= Math.trunc(dmg * lessCls / 100); steps.push([`${src.boss ? 'BOSS' : '一般怪物'}抗性 −${lessCls}%`, dmg]); }
  return dmg;
}
// A monster's normal attack on a player (battle_calc_base_damage for non-players): random weapon ATK in
// [atkMin, atkMax) (atkMax under Maximize Power) plus base ATK, neutral element (monsters' rhw.ele is never set), then the target's DEF.
// A skill (sk: jobs.json skill with lv and its SKILLS formula) uses its element and ratio.
export function mobHitDamage(db, src, dst, rnd = fightRnd, sk = null) {
  // (under Maximize Power its top ATK: battle_calc_base_damage, atkmin = atkmax)
  // (a homunculus under Mental Change: its MATK, normal attacks only, battle_calc_base_damage BDMG_MAGIC)
  const [lo, hi] = src.magicHit && !sk ? [src.matkMin, src.matkMax] : [src.atkMin, src.atkMax];
  const base = (src.maximize ? hi : (hi > lo ? rnd(hi - lo) : 0) + lo) + (src.magicHit && !sk ? 0 : src.batk);
  const ele = sk && sk.element !== 'Weapon' ? sk.element : 'Neutral';
  const ratio = attrOf(db, ele, dst, src);
  let dmg = Math.trunc(base * ratio / 100);
  const steps = [[src.magicHit && !sk ? `精神轉換 MATK ${lo}～${hi}（${ELEMENT_ZH[ele]}屬性 ${ratio}%）` : `ATK ${src.atkMin}～${src.atkMax} + ${src.batk}（${ELEMENT_ZH[ele]}屬性 ${ratio}%）`, dmg]];
  // renewal: the ATK % of the attacker's statuses is the base of the skill ratio (a normal attack's is 100)
  const bonus = src.atkRate || 0;
  if (sk || bonus) {
    const r = (sk ? SKILLS[sk.name].ratio(sk.lv, dst, sk.dist, src) : 100) + bonus;
    dmg = Math.trunc(dmg * r / 100);
    steps.push([`${sk ? sk.zh || sk.en : '攻擊'} ${r}%${bonus ? `（${src.atkBy.join('、')}）` : ''}`, dmg]);
  }
  if (sk && SKILLS[sk.name].ignoreDef) steps.push(['無視 DEF', dmg]);
  else dmg = defReduce(dmg, dst, steps, divineDef(src, dst));
  dmg = raced(dmg, src, dst, steps);
  // (a character's cards: less from this monster, add_def; less from long range, long_attack_def_rate)
  const less = dst.defMob && src.mobId ? dst.defMob[src.mobId] || 0 : 0;
  if (less) { dmg -= Math.trunc(dmg * less / 100); steps.push([`對這種怪物 ${less > 0 ? '−' : '+'}${Math.abs(less)}%（卡片）`, dmg]); }
  if (dst.longDef && longOf(src, sk)) { dmg -= Math.trunc(dmg * dst.longDef / 100); steps.push([`遠距離 −${dst.longDef}%（卡片）`, dmg]); }
  return { damage: resisted(dmg, ele, dst, steps), steps };
}
export const ELEMENT_ZH = { Neutral: '無', Water: '水', Earth: '地', Fire: '火', Wind: '風', Poison: '毒', Holy: '聖', Dark: '暗', Ghost: '念', Undead: '不死' };

// One hit's damage: the pieces of it, for display. battle_calc_weapon_attack → battle_calc_damage_parts,
// defense_reduction, post_defense (renewal, player). A skill (sk: jobs.json skill with lv) multiplies the lot by
// its ratio before DEF (renewal ATK_RATE in battle_calc_weapon_attack). Weapon ATK (battle_calc_base_weapon_attack):
// the weapon's ATK ± weapon level × 5 % of it, plus ATK × STR / 200 (DEX for the ranged weapons), anywhere between
// (rnd(n): [0, n); a critical the most), on the target's size (atkmods), then the weapon's element (neutral: no
// weapon here has another, but a status may give it one, src.ele: Enchant Poison) against the target's — for a
// normal attack or a skill of the weapon's element; a skill of its own element (Sand Attack's earth, Phantasmic
// Arrow's wind) puts that on it instead (battle_get_weapon_element). Bare hands have none.
// Status ATK takes the element too (by request: with no weapon ATK here, renewal's neutral status ATK left the
// endows, Enchant Poison and Aspersio doing nothing; as pre-renewal, or renewal's Mild Wind).
export function hitDamage(db, src, dst, crit, sk = null, rnd = fightRnd) {
  let weaponAtk = 0;
  const wele = sk && sk.element !== 'Weapon' ? sk.element : src.ele || 'Neutral', wratio = attrOf(db, wele, dst, src);
  const ratio = wratio;
  // (Shield Boomerang's base: status ATK + the shield's weight (+ 4 × its refine, none here), once, with no weapon ATK:
  // battle_calc_skill_base_damage, `shieldBase`)
  const shieldBase = !!(sk && SKILLS[sk.name].shieldBase);
  const statusAtk = shieldBase ? Math.trunc((src.batk + (src.shieldWeight || 0)) * ratio / 100) : Math.trunc(src.batk * ratio / 100) * 2;
  // (a status' weapon ATK, src.watkUp, goes on the weapon's before it is spread, which goes by the weapon's own:
  // status->watk against wa->atk; with bare hands it is all there is)
  const up = src.watkUp || 0;
  if ((src.watk || up) && !shieldBase) {
    const stat = RANGED.has(src.weapon) ? src.stats.dex : src.stats.str;
    const variance = 5 * src.watk * src.wlv / 100, bonus = src.watk * stat / 200;
    const lo = Math.max(0, Math.trunc(src.watk + up - variance + bonus)), hi = Math.trunc(src.watk + up + variance + bonus);
    const w = crit || src.maximize ? hi : lo + rnd(hi - lo + 1);
    const mod = (src.atkmods || [])[SIZES.indexOf(dst.size)] ?? 100;
    weaponAtk = Math.trunc(Math.trunc(w * mod / 100) * wratio / 100);
  }
  // the equipment ATK (the cards' bBaseAtk: battle_calc_equip_attack), of the weapon's element; the equipment ATK %
  // of the two (bAtkRate: percentAtk), then the cards' % on both (cardfix: renewal's on these alone)
  let equipAtk = src.eatk ? Math.trunc(src.eatk * wratio / 100) : 0;
  const percentAtk = src.eqAtkRate ? Math.trunc((weaponAtk + equipAtk) * src.eqAtkRate / 100) : 0;
  const fix = cardfixOf(src, dst);
  if (fix) { weaponAtk = applyFix(weaponAtk, fix); equipAtk = applyFix(equipAtk, fix); }
  // mastery ATK (battle_calc_attack_masteries → battle_addmastery: the weapon masteries' flat ATK, src.mastery),
  // added after P.ATK's %
  // (and a skill's own: Envenom's)
  // (and a skill's own: Envenom's; and Demon Bane's against an unholy monster, Beast Bane's against a brute or an insect)
  // (and Hilt Binding's, src.hilt, but on Cart Revolution)
  // (and the spirit spheres', 3 each the user has: battle_get_spiritball_damage; none at all on a `noMastery` skill)
  const masteryAtk = sk && SKILLS[sk.name].noMastery ? 0 : (src.mastery || 0) + (sk && sk.name === 'MC_CARTREVOLUTION' ? 0 : src.hilt || 0) + (sk && SKILLS[sk.name].mastery ? SKILLS[sk.name].mastery(sk.lv) : 0) + demonBaneAtk(src, dst) + beastBaneAtk(src, dst) + 3 * (src.spheres || 0);
  let dmg = Math.floor((statusAtk + weaponAtk + equipAtk + percentAtk) * (100 + src.patk) / 100);
  const steps = [[shieldBase ? `狀態 ATK ${src.batk} ＋ 盾牌重量 ${src.shieldWeight || 0}（${ELEMENT_ZH[wele]}屬性 ${ratio}%）`
    : `狀態 ATK × 2（${ELEMENT_ZH[wele]}屬性 ${ratio}%）` + (weaponAtk ? ` ＋ 武器 ATK ${weaponAtk}` : '') +
    (equipAtk ? ` ＋ 卡片 ATK ${equipAtk}` : '') + (percentAtk ? ` ＋ ATK ${src.eqAtkRate}% ${percentAtk}` : '') + (fix && (weaponAtk || equipAtk) ? `（卡片 ×${fix / 10}%）` : ''), dmg]];
  if (masteryAtk) {
    dmg += masteryAtk;
    steps.push([`＋ 熟練度 ATK ${masteryAtk}`, dmg]);
  }
  // the cards' critical damage % (half on a skill) and long range %, after the masteries (renewal
  // battle_calc_weapon_final_atk_modifiers' CritAtkRate and long_attack_atk_rate: a long attack, 5 cells and more)
  if (crit && src.critAtk) {
    dmg += Math.floor(dmg * src.critAtk / (sk ? 200 : 100));
    steps.push([`爆擊傷害 +${sk ? src.critAtk / 2 : src.critAtk}%`, dmg]);
  }
  if (src.longAtk && longOf(src, sk)) {
    dmg += Math.trunc(dmg * src.longAtk / 100);
    steps.push([`遠距離傷害 +${src.longAtk}%`, dmg]);
  }
  // the skill ratio (battle_calc_attack_skill_ratio, renewal): it starts from the ATK % of the attacker's
  // statuses (battle_get_atkpercent: a normal attack's is that alone, 100 without any) and goes on everything
  const bonus = src.atkRate || 0, r = (sk ? SKILLS[sk.name].ratio(sk.lv, dst, sk.dist, src) : 100) + bonus;
  if (sk || bonus) {
    dmg = Math.trunc(dmg * r / 100);
    steps.push([`${sk ? sk.zh || sk.en : '攻擊'} ${r}%${bonus ? `（${src.atkBy.join('、')}）` : ''}`, dmg]);
  }
  if (sk && SKILLS[sk.name].add) {
    dmg += SKILLS[sk.name].add(sk.lv);
    steps.push([`＋ ${SKILLS[sk.name].add(sk.lv)}`, dmg]);
  }
  if (sk && SKILLS[sk.name].flatDef) {
    dmg = Math.max(1, dmg - dst.def - dst.def2);
    steps.push([`DEF ${dst.def}＋${dst.def2}（直接扣）`, dmg]);
  } else if (dst.res > 0) {
    dmg -= Math.trunc(dst.res / (dst.res + 400) * 80 / 100 * dmg);
    steps.push(['RES', dmg]);
  }
  // (a `pierce` one: no DEF cut, the target's DEF × the ratio / 200 more instead)
  // (a card's too, on a class or all: def_ratio_atk_class, is_attack_piercing — not Grand Cross's nor Shield Chain's)
  const cardPierce = src.defRatio && (src.defRatio.All || src.defRatio[dst.boss ? 'Boss' : 'Normal']) && !(sk && ['CR_GRANDCROSS', 'PA_SACRIFICE', 'PA_SHIELDCHAIN'].includes(sk.name));
  if ((sk && SKILLS[sk.name].pierce) || cardPierce) {
    dmg += Math.trunc(dst.def * r / 200);
    steps.push([`穿透 DEF ${dst.def} × ${r}% / 2${cardPierce ? '（卡片）' : ''}`, dmg]);
  } else if (src.ignoreDef && src.ignoreDef[dst.boss ? 'Boss' : 'Normal']) steps.push(['無視 DEF（卡片）', dmg]);  // (ignore_def_by_class)
  else if (!(sk && SKILLS[sk.name].flatDef)) dmg = defReduce(dmg, sk && SKILLS[sk.name].softDefFree ? { ...dst, def2: 0 } : dst, steps);
  if (sk && SKILLS[sk.name].neutral) {
    dmg = Math.trunc(dmg * ratio / 100);
    steps.push([`無屬性對${ELEMENT_ZH[dst.element]} ${dst.elementLv} ${ratio}%`, dmg]);
  }
  dmg = raced(dmg, src, dst, steps);
  dmg = skillUp(dmg, src, sk, steps);
  if (crit) {
    dmg = Math.floor(dmg * (1.4 + 0.01 * src.crate));
    steps.push(['爆擊 ×1.4', dmg]);
  }
  return { damage: dmg, steps };
}

// an attack from 5 cells and more (battle_range_type): a skill's range, or the attacker's (a negative one goes by it)
const longOf = (src, sk) => ((sk && sk.range && sk.range[(sk.lv || 1) - 1] > 0 ? sk.range[(sk.lv || 1) - 1] : src.range) || 1) >= 5;
// a card's % on a skill (bSkillAtk: pc_skillatk_bonus, renewal after DEF / MDEF)
function skillUp(dmg, src, sk, steps) {
  const n = sk && src.skillAtk && src.skillAtk[sk.name];
  if (!n || !dmg) return dmg;
  dmg += Math.trunc(dmg * n / 100);
  steps.push([`${sk.zh || sk.en} +${n}%（卡片）`, dmg]);
  return dmg;
}

// A player's magic skill on dst, one hit of it (battle_calc_magic_attack, renewal): MATK (a player's base
// MATK has no spread, and there is no weapon MATK yet) × the skill ratio (after S.MATK, which is 0 here),
// then MDEF (× (1000 + MDEF) / (1000 + 10 × MDEF), minus soft MDEF; the target's MRes is 0 in this mob_db
// subset), at least 1 (battle_calc_magic_attack: ad.damage < 1 → 1, before the element; by report a level-99
// rogue took 0 from an Elder Willow's Fire Bolt), and the skill's element against the target's, which may still
// bring it to 0 (an element it is immune to).
// A monster's MATK is anywhere from its matkMin to matkMax (status_base_matk_min / max; the bolts it casts).
export function magicDamage(db, src, dst, sk, rnd = fightRnd) {
  const f = SKILLS[sk.name];
  // (MDEF, unless the skill goes through it: IgnoreDefense)
  const mdefCut = (dmg, steps) => {
    if (f.ignoreDef) { steps.push(['無視 MDEF', dmg]); return Math.max(1, dmg); }
    // (a card's share of a class's MDEF ignored, both: ignore_mdef_by_class)
    const cut = src.ignoreMdef ? Math.min(100, (src.ignoreMdef[dst.boss ? 'Boss' : 'Normal'] || 0) + (src.ignoreMdef.All || 0)) : 0;
    const mdef = Math.max(0, dst.mdef - Math.trunc(dst.mdef * cut / 100)), mdef2 = dst.mdef2 - Math.trunc(dst.mdef2 * cut / 100);
    dmg = Math.max(1, Math.trunc(dmg * (1000 + mdef) / (1000 + mdef * 10)) - mdef2);
    steps.push([`MDEF ${mdef}＋${mdef2}${cut ? `（無視 ${cut}%）` : ''}（至少 1）`, dmg]);
    return dmg;
  };
  // Grand Cross (`gx`): the user's ATK as a weapon attack's base (renewal: status ATK × 2 and the weapon's, rolled, on the
  // target's size; no element, no masteries) and its MATK, halved together; the ratio; DEF (battle_calc_defense_reduction)
  // and the target's MDEF and soft MDEF taken off as they are (IgnoreDefense: not the MDEF formula), at least 1; then the
  // element table twice (attr_fix, cardfix, attr_fix again)
  if (f.gx) {
    const atk = gxAtk(src, dst, rnd), matk = pcMatk(src, rnd);
    let dmg = Math.trunc((atk + matk) / 2);
    const steps = [[`（ATK ${atk} ＋ MATK ${matk}）÷ 2`, dmg]];
    const r = f.ratio(sk.lv);
    dmg = Math.trunc(dmg * r / 100);
    steps.push([`${sk.zh || sk.en} ${r}%`, dmg]);
    dmg = defReduce(dmg, dst, steps);
    dmg = Math.max(1, dmg - dst.mdef - dst.mdef2);
    steps.push([`MDEF ${dst.mdef}＋${dst.mdef2}（直接扣）`, dmg]);
    const ratio = attrOf(db, sk.element, dst, src);
    for (let i = 0; i < 2; i++) {
      dmg = Math.trunc(dmg * ratio / 100);
      steps.push([`${ELEMENT_ZH[sk.element]}屬性對${ELEMENT_ZH[dst.element]} ${dst.elementLv} ${ratio}%${i ? '（再一次）' : ''}`, dmg]);
    }
    return { damage: Math.max(0, resisted(raced(dmg, src, dst, steps, sk.element), sk.element, dst, steps)), steps };
  }
  // (Turn Undead taking: the target's HP for its base)
  const turned = f.turn && rnd(1000) < f.turn(src, dst, sk.lv);
  if (f.base || turned) {  // (a fixed base instead of MATK: Dark Breath's)
    let dmg = turned ? dst.hp : f.base(dst, sk.lv, src);
    const steps = [[`${sk.zh || sk.en}：${turned ? `成功（${f.turn(src, dst, sk.lv) / 10}%），目標的 HP` : f.baseText(sk.lv, src)}`, dmg]];
    if (f.matk) {  // (and the user's MATK on it: B.S. Sacramenti's)
      const matk = pcMatk(src, rnd);
      dmg += matk;
      steps.push([`+ MATK ${matk}`, dmg]);
    }
    dmg = mdefCut(dmg, steps);
    if (f.noElement) return { damage: Math.max(0, dmg), steps };  // (IgnoreElement)
    const ratio = attrOf(db, sk.element, dst, src);
    dmg = Math.trunc(dmg * ratio / 100);
    steps.push([`${ELEMENT_ZH[sk.element]}屬性對${ELEMENT_ZH[dst.element]} ${dst.elementLv} ${ratio}%`, dmg]);
    return { damage: Math.max(0, resisted(raced(dmg, src, dst, steps, sk.element), sk.element, dst, steps)), steps };
  }
  const matk = src.kind === 'mob' ? src.matkMin + rnd(src.matkMax - src.matkMin + 1) : pcMatk(src, rnd);
  let dmg = matk;
  const steps = [[src.kind === 'mob' ? `MATK ${src.matkMin}～${src.matkMax}：${matk}` : `MATK ${matk}`, dmg]];
  if (sk.split > 1) {
    dmg = Math.trunc(dmg / sk.split);
    steps.push([`${sk.split} 隻分攤`, dmg]);
  }
  if (f.plus) {  // (a flat amount added to the MATK before the ratio: Fire Pillar's)
    dmg += f.plus(sk.lv);
    steps.push([`+ ${f.plus(sk.lv)}`, dmg]);
  }
  const r = SKILLS[sk.name].ratio(sk.lv, dst, sk.dist, src);
  if (r !== 100) {
    dmg = Math.trunc(dmg * r / 100);
    steps.push([`${sk.zh || sk.en} ${r}%`, dmg]);
  }
  dmg = skillUp(mdefCut(dmg, steps), src, sk, steps);
  const ratio = attrOf(db, sk.element, dst, src);
  dmg = Math.trunc(dmg * ratio / 100);
  steps.push([`${ELEMENT_ZH[sk.element]}屬性對${ELEMENT_ZH[dst.element]} ${dst.elementLv} ${ratio}%`, dmg]);
  return { damage: Math.max(0, resisted(raced(dmg, src, dst, steps, sk.element), sk.element, dst, steps)), steps };
}

// a character's ATK for Grand Cross (battle_calc_skill_base_damage, renewal: statusAtk + weaponAtk + equipAtk + percentAtk):
// status ATK × 2 and the weapon's ATK spread as hitDamage's, on the target's size, with no element yet
function gxAtk(src, dst, rnd) {
  let weaponAtk = 0;
  const up = src.watkUp || 0;
  if (src.watk || up) {
    const stat = RANGED.has(src.weapon) ? src.stats.dex : src.stats.str;
    const variance = 5 * src.watk * src.wlv / 100, bonus = src.watk * stat / 200;
    const lo = Math.max(0, Math.trunc(src.watk + up - variance + bonus)), hi = Math.trunc(src.watk + up + variance + bonus);
    const w = src.maximize ? hi : lo + rnd(hi - lo + 1);
    weaponAtk = Math.trunc(w * ((src.atkmods || [])[SIZES.indexOf(dst.size)] ?? 100) / 100);
  }
  return src.batk * 2 + weaponAtk;
}

// One skill use on dst (sk: jobs.json skill entry, lv its level). Skills are never perfectly dodged or
// critical here; weapon skills hit on the skill's hit rate, magic always hits. dst.hp is used by ratios
// that depend on it; dist is the target's distance from the user in cells (area skills); split: the enemies
// a SplashSplit skill's MATK is shared among (Napalm Beat).
export function skillAttack(db, src, dst, sk, lv, rnd = fightRnd, dist = 0, split = 1, crowd = 1) {
  const s = { ...sk, lv, dist, split }, f = SKILLS[sk.name];
  if (f.misc) {  // misc damage: as it is, shared among the enemies hit (`split`: Blast Mine), then the element table (Stone Fling), × its hits (Blitz Beat)
    const whole = f.misc(src, lv, rnd), base = Math.trunc(whole / split), ratio = f.noElement ? 100 : attrOf(db, sk.element, dst, src), hits = sk.hits[lv - 1] || 1;
    const steps = [[`${sk.zh || sk.en} ${f.miscText ? f.miscText(src, lv) + ' = ' : ''}${whole}`, whole], ...split > 1 ? [[`${split} 個平分`, base]] : [],
      ...f.noElement ? [] : [[`${ELEMENT_ZH[sk.element]}屬性對${ELEMENT_ZH[dst.element]} ${dst.elementLv} ${ratio}%`, Math.trunc(base * ratio / 100)]]];
    const one = resisted(Math.trunc(base * ratio / 100), sk.element, dst, steps);
    if (hits > 1) steps.push([`× ${hits} 段`, one * hits]);
    return { type: 'hit', damage: one * hits, skill: s, hits, steps };
  }
  // (a critical, or one ignoring FLEE, never misses; nor one at a player's perfect hit rate: is_attack_hitting, its cards' sets)
  if (!f.magic && !f.crit && !f.sure && !perfectHit(src, rnd) && !(rnd(100) < hitRate(src, dst, f, lv))) return { type: 'miss', damage: 0, skill: s };
  // (a player's critical one: the weapon's top ATK and × 1.4 as a critical normal attack's; a monster's × 1.4 here)
  const r = f.magic ? magicDamage(db, src, dst, s, rnd) : src.kind === 'mob' ? mobHitDamage(db, src, dst, rnd, s) : hitDamage(db, src, dst, !!f.crit, s, rnd);
  if (f.crit && src.kind === 'mob') {
    r.damage = Math.floor(r.damage * 1.4);
    r.steps.push(['爆擊 ×1.4', r.damage]);
  }
  // (a player's cards' magic damage taken less: Golden Thief Bug's, battle_calc_damage's no_magic_damage)
  if (f.magic && dst.noMagic && r.damage > 0) {
    r.damage -= Math.trunc(r.damage * dst.noMagic / 100);
    r.steps.push([`魔法傷害 −${dst.noMagic}%（卡片）`, r.damage]);
  }
  // (a % more on the whole of it at the end, `more`: Sonic Acceleration's on Sonic Blow)
  const more = f.more && f.more(src);
  if (more && r.damage > 0) {
    r.damage += Math.trunc(r.damage * more[1] / 100);
    r.steps.push([`${more[0]} +${more[1]}%`, r.damage]);
  }
  // DAMAGE_DIV_FIX: a positive hit count deals the damage that many times; a negative one splits it into
  // that many hits (rounded down to a multiple). Each hit is at least 1, except magic that came to 0
  // (battle_apply_div_fix leaves no damage alone).
  // (`pcSplit`: a character's split, a monster's not: Fire Pillar's)
  const c0 = f.bySize ? SIZE_HITS[dst.size] || 2 : f.div ? f.div(src, crowd) : sk.hits[lv - 1] || 1, c = f.pcSplit && src.kind !== 'mob' ? -c0 : c0, hits = Math.abs(c);
  const damage = f.magic && !r.damage ? 0 : Math.max(hits, c < 0 ? Math.trunc(r.damage / hits) * hits : r.damage * hits);
  if (hits > 1) r.steps.push([c < 0 ? `分 ${hits} 段` : `× ${hits} 段`, damage]);
  return { type: f.crit ? 'crit' : 'hit', ...r, damage, skill: s, hits };
}
const SIZE_HITS = { Small: 1, Medium: 2, Large: 3 };
// the renewal misc damage of Land Mine, Blast Mine and Claymore Trap (battle_calc_misc_attack): Lv × DEX × (3 + BaseLv /
// 100) × (1 + INT / 35), ± up to 10% (Research Trap's + 40 a level is a third job's)
function trapMisc(src, lv, rnd) {
  const d = Math.trunc(lv * src.stats.dex * (3 + src.lv / 100) * (1 + src.stats.int / 35));
  return d + Math.trunc(d * (rnd(20) - 10) / 100);
}
const trapMiscText = (src, lv) => `${lv} × DEX ${src.stats.dex} × (3 + ${src.lv}/100) × (1 + INT ${src.stats.int}/35) ±10%`;
export const skillHitRate = (src, dst, sk, lv) => { const f = SKILLS[sk.name]; return f.magic || f.crit || f.sure ? 100 : hitRate(src, dst, f, lv); };

// a player's weapon attack sure to hit (is_attack_hitting: rnd() % 100 < perfect_hit, after a critical; its cards'
// bPerfectHitRate / bPerfectHitAddRate); no roll without it
const perfectHit = (src, rnd) => src.perfectHit > 0 && rnd(100) < src.perfectHit;
// One normal attack. rnd(n) → integer in [0, n). Result type: 'lucky' (perfect dodge), 'miss', 'hit', 'crit'.
// Double Attack (src.doubleAttack = its level, set only with a dagger) is rolled first
// (battle_calc_multi_attack): it hits twice for twice the damage (DAMAGE_DIV_FIX), is never critical
// (is_attack_critical) and hits Lv % more often.
export function attack(db, src, dst, rnd = fightRnd) {
  if (dst.flee2 && rnd(1000) < dst.flee2) return { type: 'lucky', damage: 0 };
  const dbl = src.doubleAttack > 0 && rnd(100) < doubleRate(src.doubleAttack);
  // a critical always hits
  const crit = !dbl && src.cri > 0 && rnd(1000) < critRate(src, dst);
  if (!crit && !perfectHit(src, rnd) && !(rnd(100) < hitRate(src, dst, null, 0, dbl ? src.doubleAttack : 0))) return { type: 'miss', damage: 0 };
  const r = src.kind === 'mob' ? mobHitDamage(db, src, dst, rnd) : hitDamage(db, src, dst, crit, null, rnd);
  const left = leftHand(db, src, dst, crit, r, rnd);
  if (dbl) {
    r.damage *= 2;
    r.steps.push(['二刀連擊 × 2', r.damage]);
  }
  const type = crit ? 'crit' : 'hit', hits = dbl ? { hits: 2 } : {};
  if (!left) return { type, ...r, ...hits };
  // (the left hand's damage comes as a hit of its own after the right's: r.left, see sim.js schedule)
  return { type, ...r, ...hits, damage: r.damage + left.damage, left: left.damage, leftSteps: left.steps };
}
// the left hand's damage of a normal attack whose right hand did r (src.hands, src.katar: see sim.js hands),
// the right's cut to its share in r; null without one, or a katar's that comes to 0
function leftHand(db, src, dst, crit, r, rnd) {
  if (src.katar != null) {
    const damage = Math.trunc(r.damage * (1 + 2 * src.katar) / 100);
    return damage > 0 ? { damage, steps: [[`拳刃第二擊 ${1 + 2 * src.katar}%`, damage]] } : null;
  }
  if (!src.hands || !src.left) return null;
  r.damage = Math.max(1, Math.trunc(r.damage * src.hands.right / 100));
  r.steps.push([`右手 ${src.hands.right}%`, r.damage]);
  const l = hitDamage(db, { ...src, watk: 0, wlv: 0, ...src.left, watkUp: 0 }, dst, crit, null, rnd);
  l.damage = Math.max(1, Math.trunc(l.damage * src.hands.left / 100));
  l.steps.push([`左手 ${src.hands.left}%`, l.damage]);
  return l;
}
