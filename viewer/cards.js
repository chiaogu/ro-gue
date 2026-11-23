// Monster cards (by request: the game's cards, each put on a character, wherever RO would slot it, as many as it
// likes): which items are cards, their 類型, and what one does on a character — its rAthena script (item_db Script)
// run by a small interpreter of the part of rAthena's script language the cards use (bonus…bonus5, skill,
// autobonus…, if / else, .@ variables, getrefine, readparam, getskilllv, isequipped, getiteminfo(getequipid(…)),
// BaseClass, BaseJob, JobLevel, BaseLevel, min / max), its conditions kept (by request: a Thief's bonus for a
// Thief only, a sword's with a sword in hand). No DOM; the viewer's 道具 tab, the game and the simulation use it.
//
// The bonuses battle.js and sim.js work out (BONUS), by request: the first batch, the flat ones (stats, ATK, MATK,
// DEF, HIT, FLEE, critical, HP, SP, attack speed, regen, cast, SP cost, delay), the % of damage (race, element, size,
// class, ATK %, MATK %, long range, critical damage, a skill's) and the % less damage taken; the second, what goes off
// as a hit lands, one is taken or a monster dies (autospells, statuses put on and resisted, drains, SP and HP from a
// kill, EXP, drops, zeny, autobonuses, weapon and armour broken, coma, damage sent back, …); the last, a splash, a
// polymorph, magic kept off and sent back, piercing, a skill's knockback and cast, … A card with any other (a skill it
// gives, one that goes by its refine — none here) is not `supported`: the game's pool leaves it out.

// a monster's card (by request: the game's card pool is these only): one with a card illustration named a card —
// not the enchantments (STR+1, MATK+1%, 鬥志1Lv: no illustration), 魔神的…精髓 nor 巴希莉名片 (illustrated, not named one)
export const isCard = x => !!x.art && (x.zh !== false && x.name ? /卡片?$/.test(x.name) : /Card$/i.test(x.en || ''));

// a card's types (by request), by the bonuses in its script: 平加 flat numbers (stats, ATK, DEF, HP, crit, speed);
// 乘區 the % of damage (rAthena battle_calc_cardfix: race, element, size and class each add up in themselves and
// multiply one another), 觸發 what happens on a hit, on being hit or on a kill (auto spells, statuses, drains);
// 防禦 less damage taken, resistances; 經濟 drops, EXP, zeny; 規則 what changes how one fights (a skill, no size
// penalty, splash, no cast cancel). Its drawbacks (HP / SP lost, no regen) count for none; a card with none of these
// (a set's part, mostly) is 其他.
export const CARD_TYPE = [
  ['平加', 'Str Agi Vit Int Dex Luk AllStats AgiVit AgiDexStr BaseAtk Atk Matk Def Mdef DefRate MdefRate Hit HitRate Flee Flee2 ' +
    'Critical CriticalLong CriticalAddRace PerfectHitRate MaxHP MaxHPrate MaxSP MaxSPrate Aspd AspdRate SpeedRate ' +
    'HPrecovRate SPrecovRate HPRegenRate SPRegenRate VariableCastrate FixedCastrate Delayrate SkillCooldown UseSPrate SkillUseSP ' +
    'HealPower HealPower2 AddItemHealRate AddItemGroupHealRate'],
  ['乘區', 'AtkRate MatkRate WeaponAtkRate LongAtkRate ShortAtkRate CritAtkRate SkillAtk AddRace AddRace2 AddEle AddSize AddClass ' +
    'AddDamageClass AddDefMonster MagicAddRace MagicAddRace2 MagicAddEle MagicAddSize MagicAddClass MagicAtkEle IgnoreDefClass ' +
    'IgnoreDefRace IgnoreDefRaceRate IgnoreDefClassRate IgnoreMdefClassRate IgnoreMdefRaceRate DefRatioAtkClass DefRatioAtkRace'],
  ['觸發', 'AutoSpell AutoSpellWhenHit AutoSpellOnSkill AddEff AddEff2 AddEffWhenHit AddEffOnSkill ComaClass ClassChange DoubleRate ' +
    'HPDrainRate SPDrainRate SPDrainValue HPGainValue SPGainValue SPGainRace MagicSPGainValue LongSPGainValue SPVanishRate ' +
    'BreakWeaponRate BreakArmorRate AddSkillBlow'],
  ['防禦', 'SubEle SubRace SubRace2 SubSize SubClass MagicSubRace ResEff DefEle LongAtkDef NearAtkDef NoMagicDamage AbsorbDmgMaxHP ' +
    'AbsorbDmgMaxHP2 ShortWeaponDamageReturn LongWeaponDamageReturn MagicDamageReturn NoKnockback UnbreakableWeapon UnbreakableArmor ' +
    'UnbreakableGarment UnbreakableHelm UnbreakableShield UnbreakableShoes'],
  ['經濟', 'AddMonsterDropItem AddMonsterDropItemGroup ExpAddRace ExpAddClass GetZenyNum AddGetZenyNum'],
  ['規則', 'AtkEle NoSizeFix NoCastCancel NoGemStone Intravision SplashRange NoWalkDelay RestartFullRecover'],
].map(([k, v]) => [k, new Set(v.split(' ').map(b => 'b' + b))]);
export const CARD_TYPES = [...CARD_TYPE.map(([k]) => k), '其他'];
export function cardTypes(x) {
  if (x.types) return x.types;
  const out = new Set(), script = x.script || '';
  for (const [, b] of script.matchAll(/\bbonus\d?\s+(b\w+)/g)) for (const [k, bs] of CARD_TYPE) if (bs.has(b)) out.add(k);
  if (/\bautobonus\d?\b/.test(script)) out.add('觸發');
  if (/\bskill\s+["\w]/.test(script)) out.add('規則');
  if (!out.size) out.add('其他');
  return x.types = CARD_TYPES.filter(k => out.has(k));
}

// ---------- the script ----------

// tokens: strings, numbers, names (.@ and @ variables too), operators
function tokens(src) {
  const out = [], re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"((?:\\.|[^"\\])*)"|(\d+)|([.@$]*[A-Za-z_][\w]*)|(==|!=|<=|>=|&&|\|\||[-+*\/%<>!?:(){},;=|&])/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] != null) out.push({ s: m[1].replace(/\\(.)/g, '$1') });
    else if (m[2] != null) out.push({ n: +m[2] });
    else if (m[3] != null) out.push({ id: m[3] });
    else if (m[4] != null) out.push({ op: m[4] });
  }
  if (re.lastIndex < src.length) throw new Error(`card script: cannot read "${src.slice(re.lastIndex, re.lastIndex + 20)}"`);
  return out;
}
// statements: { block }, { if, then, else }, { set, expr }, { call, args } (bonus…, skill, autobonus… and the rest)
function parse(src) {
  const t = tokens(src);
  let i = 0;
  const peek = (k = 0) => t[i + k], isOp = (op, k = 0) => peek(k) && peek(k).op === op;
  const eat = op => { if (!isOp(op)) throw new Error(`card script: ${op} expected`); i++; };
  const stmt = () => {
    if (isOp('{')) { i++; const body = []; while (!isOp('}')) body.push(stmt()); i++; return { block: body }; }
    if (isOp(';')) { i++; return { block: [] }; }
    const w = peek();
    if (w.id === 'if') { i++; eat('('); const cond = expr(); eat(')'); const then = stmt(); let other = null; if (peek() && peek().id === 'else') { i++; other = stmt(); } return { if: cond, then, else: other }; }
    if (w.id && /^[.@$]/.test(w.id) && isOp('=', 1)) { i += 2; const e = expr(); eat(';'); return { set: w.id, expr: e }; }
    i++;
    const args = [];
    if (!isOp(';')) { args.push(expr()); while (isOp(',')) { i++; args.push(expr()); } }
    eat(';');
    return { call: w.id, args };
  };
  const BIN = [['||'], ['&&'], ['|'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];
  const expr = () => { const c = bin(0); if (isOp('?')) { i++; const a = expr(); eat(':'); const b = expr(); return { tern: [c, a, b] }; } return c; };
  const bin = l => {
    if (l === BIN.length) return unary();
    let a = bin(l + 1);
    while (peek() && BIN[l].includes(peek().op)) { const op = t[i++].op; a = { op, a, b: bin(l + 1) }; }
    return a;
  };
  const unary = () => {
    if (isOp('!') || isOp('-')) { const op = t[i++].op; return { un: op, a: unary() }; }
    if (isOp('(')) { i++; const e = expr(); eat(')'); return e; }
    const w = t[i++];
    if (w.n != null || w.s != null) return { v: w.n ?? w.s };
    if (isOp('(')) { i++; const args = []; if (!isOp(')')) { args.push(expr()); while (isOp(',')) { i++; args.push(expr()); } } eat(')'); return { fn: w.id, args }; }
    return { name: w.id };
  };
  const body = [];
  while (i < t.length) body.push(stmt());
  return body;
}
const parsed = new Map();
const scriptOf = src => { if (!parsed.has(src)) parsed.set(src, parse(src)); return parsed.get(src); };

// rAthena's numbered constants a card compares or ORs (the battle flags); every other name stands for itself
const NUMBERS = { BF_WEAPON: 0x1, BF_MAGIC: 0x2, BF_MISC: 0x4, BF_SHORT: 0x10, BF_LONG: 0x40, BF_SKILL: 0x100, BF_NORMAL: 0x200,
  ATF_SELF: 0x1, ATF_TARGET: 0x2, ATF_SHORT: 0x4, ATF_LONG: 0x8, ATF_WEAPON: 0x10, ATF_MAGIC: 0x20, ATF_MISC: 0x40 };
// the weapon types (sim.js / item_db SubType) as getiteminfo(…, ITEMINFO_VIEW) has them
const VIEW = { Dagger: 'W_DAGGER', '1hSword': 'W_1HSWORD', '2hSword': 'W_2HSWORD', '1hSpear': 'W_1HSPEAR', '2hSpear': 'W_2HSPEAR',
  '1hAxe': 'W_1HAXE', '2hAxe': 'W_2HAXE', Mace: 'W_MACE', Staff: 'W_STAFF', '2hStaff': 'W_2HSTAFF', Bow: 'W_BOW', Knuckle: 'W_KNUCKLE',
  Musical: 'W_MUSICAL', Whip: 'W_WHIP', Book: 'W_BOOK', Katar: 'W_KATAR', Fist: 'W_FIST' };
const STAT_PARAM = { bStr: 'str', bAgi: 'agi', bVit: 'vit', bInt: 'int', bDex: 'dex', bLuk: 'luk' };
const idiv = (a, b) => b ? Math.trunc(a / b) : 0;

// run a script for who: { baseClass, baseJob ('Job_…'), jobLv, baseLv, stats (the points put in), levels (skill → level),
// weapon (its type), cards (the ids it has) } → [{ call, args }] of what it does there; `all`: every branch, no who
// (to see what a card may do)
function run(body, who, out = [], vars = {}, all = false) {
  const ev = e => {
    if ('v' in e) return e.v;
    if (e.name) {
      if (/^[.@$]/.test(e.name)) return vars[e.name] ?? 0;
      switch (e.name) {
        case 'BaseClass': return all ? '' : who.baseClass;
        case 'BaseJob': case 'Class': return all ? '' : who.baseJob;
        case 'JobLevel': return all ? 0 : who.jobLv || 1;
        case 'BaseLevel': return all ? 0 : who.baseLv || 1;
        case 'Upper': return 0;
      }
      return NUMBERS[e.name] ?? e.name;
    }
    if (e.un) { const a = ev(e.a); return e.un === '!' ? +!a : -a; }
    if (e.tern) return ev(e.tern[0]) ? ev(e.tern[1]) : ev(e.tern[2]);
    if (e.fn) {
      const a = e.args.map(ev);
      switch (e.fn) {
        case 'getrefine': return 0;  // (a card is on a character, not on gear: no refine)
        case 'readparam': return all ? 0 : (who.stats || {})[STAT_PARAM[a[0]]] || 0;
        case 'getskilllv': return all ? 0 : (who.levels || {})[a[0]] || 0;
        case 'isequipped': return all ? 0 : +a.every(id => (who.cards || []).includes(+id));
        case 'getequipid': return a[0];
        case 'getiteminfo': return all ? '' : a[0] === 'EQI_HAND_R' && a[1] === 'ITEMINFO_VIEW' ? VIEW[who.weapon] || 'W_FIST' : 0;
        case 'min': return Math.min(...a);
        case 'max': return Math.max(...a);
      }
      out.push({ call: '?' + e.fn, args: a });
      return 0;
    }
    const a = ev(e.a);
    if (e.op === '&&') return a ? +!!ev(e.b) : 0;
    if (e.op === '||') return a ? 1 : +!!ev(e.b);
    const b = ev(e.b);
    switch (e.op) {
      case '|': return a | b; case '&': return a & b;
      case '==': return +(a === b); case '!=': return +(a !== b);
      case '<': return +(a < b); case '<=': return +(a <= b); case '>': return +(a > b); case '>=': return +(a >= b);
      case '+': return typeof a === 'string' || typeof b === 'string' ? '' + a + b : a + b;
      case '-': return a - b; case '*': return a * b; case '/': return idiv(a, b); case '%': return b ? a % b : 0;
    }
    return 0;
  };
  for (const s of body) {
    if (s.block) run(s.block, who, out, vars, all);
    else if (s.if) {
      if (all) { run([s.then], who, out, vars, all); if (s.else) run([s.else], who, out, vars, all); }
      else run([ev(s.if) ? s.then : s.else].filter(Boolean), who, out, vars, all);
    } else if (s.set) vars[s.set] = ev(s.expr);
    else out.push({ call: s.call, args: s.args.map(ev) });
  }
  return out;
}

// ---------- the bonuses ----------

// rAthena's races, elements, sizes and classes as the simulation names them (jobs.json mobs': Demihuman, not the
// constant's DemiHuman; the players' races, Player_Human and Player_Doram, never a monster's, kept as they are)
const target = a => { const k = String(a).replace(/^(RC2?|Ele|Size|Class)_/, ''); return k === 'DemiHuman' ? 'Demihuman' : k; };
const add = (o, k, n) => { o[k] = (o[k] || 0) + n; };
// what battle.js works out (by request, the first batch): bonus name → [its arity (bonus = 1, bonus2 = 2 …), what it
// adds to the sum]. rAthena pc_bonus / pc_bonus2 (renewal) for each.
const BONUS = {
  bStr: [1, (q, n) => add(q.stats, 'str', n)], bAgi: [1, (q, n) => add(q.stats, 'agi', n)], bVit: [1, (q, n) => add(q.stats, 'vit', n)],
  bInt: [1, (q, n) => add(q.stats, 'int', n)], bDex: [1, (q, n) => add(q.stats, 'dex', n)], bLuk: [1, (q, n) => add(q.stats, 'luk', n)],
  bAllStats: [1, (q, n) => { for (const s of ['str', 'agi', 'vit', 'int', 'dex', 'luk']) add(q.stats, s, n); }],
  bBaseAtk: [1, (q, n) => { q.eatk += n; }],          // equipment ATK (renewal sd->bonus.eatk)
  bMatk: [1, (q, n) => { q.ematk += n; }],            // equipment MATK (sd->bonus.ematk)
  bMatkRate: [1, (q, n) => { q.matkRate += n; }],     // MATK % (sd->matk_rate)
  bAtkRate: [1, (q, n) => { q.atkRate += n; }],       // % of weapon and equipment ATK (sd->bonus.atk_rate)
  bDef: [1, (q, n) => { q.def += n; }], bMdef: [1, (q, n) => { q.mdef += n; }],
  bHit: [1, (q, n) => { q.hit += n; }], bFlee: [1, (q, n) => { q.flee += n; }],
  bFlee2: [1, (q, n) => { q.flee2 += 10 * n; }],      // perfect dodge, tenths
  bCritical: [1, (q, n) => { q.cri += 10 * n; }],     // tenths
  bCriticalAddRace: [2, (q, r, n) => add(q.criRace, target(r), 10 * n)],
  bCritAtkRate: [1, (q, n) => { q.critAtk += n; }], bLongAtkRate: [1, (q, n) => { q.longAtk += n; }],
  bMaxHP: [1, (q, n) => { q.maxHp += n; }], bMaxHPrate: [1, (q, n) => { q.maxHpRate += n; }],
  bMaxSP: [1, (q, n) => { q.maxSp += n; }], bMaxSPrate: [1, (q, n) => { q.maxSpRate += n; }],
  bAspd: [1, (q, n) => { q.aspd += n; }], bAspdRate: [1, (q, n) => { q.aspdRate += n; }],
  bHPrecovRate: [1, (q, n) => { q.hpRecov += n; }], bSPrecovRate: [1, (q, n) => { q.spRecov += n; }],
  // (negative: faster; the simulation's varCast is the % off; bonus2: one skill's)
  bVariableCastrate: [[1, 2], (q, a, b) => { if (b === undefined) q.varCast -= a; else add(q.castSkill, a, -b); }],
  bUseSPrate: [1, (q, n) => { q.spCut -= n; }], bDelayrate: [1, (q, n) => { q.delayCut -= n; }],
  bAddRace: [2, (q, r, n) => add(q.addRace, target(r), n)], bAddEle: [2, (q, e, n) => add(q.addEle, target(e), n)],
  bAddSize: [2, (q, s, n) => add(q.addSize, target(s), n)], bAddClass: [2, (q, c, n) => add(q.addClass, target(c), n)],
  bMagicAddRace: [2, (q, r, n) => add(q.magicAddRace, target(r), n)], bMagicAddEle: [2, (q, e, n) => add(q.magicAddEle, target(e), n)],
  bMagicAddSize: [2, (q, s, n) => add(q.magicAddSize, target(s), n)], bMagicAddClass: [2, (q, c, n) => add(q.magicAddClass, target(c), n)],
  bMagicAtkEle: [2, (q, e, n) => add(q.magicAtkEle, target(e), n)],
  bSkillAtk: [2, (q, sk, n) => add(q.skillAtk, sk, n)],
  bSubEle: [2, (q, e, n) => add(q.subEle, target(e), n)], bSubRace: [2, (q, r, n) => add(q.subRace, target(r), n)],
  bSubSize: [2, (q, s, n) => add(q.subSize, target(s), n)], bSubClass: [2, (q, c, n) => add(q.subClass, target(c), n)],
  bDefEle: [1, (q, e) => { q.defEle = target(e); }], bAtkEle: [1, (q, e) => { q.atkEle = target(e); }],
  bNoSizeFix: [0, q => { q.noSizeFix = true; }],
  // (the second batch, by request: what goes off as a hit lands or a monster dies — sim.js cardsOnHit, cardsOnKill)
  // autospells (pc_bonus_autospell): [skill, level, rate ‰]; bonus4's flag &1 at the target (else on itself), &2 a
  // level at random up to it; bonus3's on itself for a support skill or one on oneself (Support, Self), else at the
  // target (sim.js works that out: self null). On one's own normal weapon attacks; when hit, by weapon attacks, normal
  // or skills, a bonus5's by its battle flags
  // (a negative rate — a set's, 流氓's 脅持 -20 — takes that much off the same skill's at the same level: rAthena merges
  // them, a negative one whatever card it came from)
  bAutoSpell: [[3, 4], (q, sk, lv, rate, flag) => {
    const same = rate < 0 && q.autoSpell.find(a => a.sk === sk && a.lv === lv);
    if (same) same.rate = Math.max(0, same.rate + rate);
    else if (rate > 0) q.autoSpell.push({ sk, lv, rate, bf: bfOf(0), self: flag == null ? null : !(flag & 1), random: !!(flag & 2) });
  }],
  bAutoSpellWhenHit: [[3, 4, 5], (q, sk, lv, rate, a, b) => {
    const five = b !== undefined, flag = five ? b : a;
    q.autoSpellHit.push({ sk, lv, rate, bf: bfOf(five ? a : NUMBERS.BF_NORMAL | NUMBERS.BF_SKILL), self: flag == null ? null : !(flag & 1), random: !!(flag & 2) });
  }],
  // statuses (pc_bonus_addeff): [Eff_…, rate (1/10000), ATF flags]; on one's weapon attacks (bAddEff2: on oneself),
  // when hit (bAddEffWhenHit: ATF_TARGET the attacker, ATF_SELF oneself); bResEff: that much (1/10000) of a status'
  // chance and time off
  bAddEff: [[2, 3], (q, e, rate, flag = 0) => { q.addEff.push({ kind: effOf(e), rate, flag: atfOf(flag) }); }],
  bAddEff2: [2, (q, e, rate) => { q.addEff.push({ kind: effOf(e), rate, flag: atfOf(NUMBERS.ATF_SELF) }); }],
  bAddEffWhenHit: [[2, 3], (q, e, rate, flag = 0) => { q.addEffHit.push({ kind: effOf(e), rate, flag: atfOf(flag) }); }],
  bResEff: [2, (q, e, n) => add(q.resEff, effOf(e), n)],
  // drains (battle_drain, on weapon attacks): at rate ‰, per % of the damage; a flat SP a hit
  bHPDrainRate: [2, (q, rate, per) => { q.hpDrain.rate += rate; q.hpDrain.per += per; }],
  bSPDrainRate: [2, (q, rate, per) => { q.spDrain.rate += rate; q.spDrain.per += per; }],
  bSPDrainValue: [1, (q, n) => { q.spDrainValue += n; }],
  // a monster killed by a short-range weapon attack (skill_counter_additional_effect): SP, HP back
  bSPGainRace: [2, (q, r, n) => add(q.spGainRace, target(r), n)],
  bSPGainValue: [1, (q, n) => { q.spGain += n; }], bHPGainValue: [1, (q, n) => { q.hpGain += n; }],
  // EXP % from a race's (pc_calcexp); what a monster it kills drops besides (mob_dead: [item, race, rate /10000])
  bExpAddRace: [2, (q, r, n) => add(q.expRace, target(r), n)],
  bAddMonsterDropItem: [[2, 3], (q, item, a, b) => { q.drops.push(b === undefined ? { item: +item, race: 'All', rate: a } : { item: +item, race: target(a), rate: b }); }],
  bHealPower: [1, (q, n) => { q.healPower += n; }],
  bNoRegen: [1, (q, n) => { q.noRegen |= n; }],
  // (nothing here: food the party never eats — what drops is sold —, its equipment that never breaks, monsters
  // with no SP to take)
  bAddItemHealRate: [2, () => {}], bAddItemGroupHealRate: [2, () => {}], bUnbreakableWeapon: [0, () => {}], bUnbreakableArmor: [0, () => {}],
  bSPVanishRate: [3, () => {}],
  // (more, by request): % more on a monster's race group (RC2_Goblin …: mob_db RaceGroups) and on one monster (by its id),
  // % less from one; % less from long-range attacks; DEF of a class ignored, a share of its MDEF; no cast cut off by
  // damage; short-range weapon damage sent back; not knocked back; no walk delay when hit; the target's weapon, armour
  // broken (1/10000); a coma (its HP to 1: 1/10000); hard DEF and MDEF %; HP and SP every so often, HP lost (not to
  // death); no gemstones; back in full when raised; zeny from a kill
  bAddRace2: [2, (q, r, n) => add(q.addRace2, String(r).replace(/^RC2_/, ''), n)],
  bAddDamageClass: [2, (q, id, n) => add(q.addMob, +id, n)], bAddDefMonster: [2, (q, id, n) => add(q.defMob, +id, n)],
  bLongAtkDef: [1, (q, n) => { q.longDef += n; }],
  bIgnoreDefClass: [1, (q, c) => { q.ignoreDef[target(c)] = true; }], bIgnoreMdefClassRate: [2, (q, c, n) => add(q.ignoreMdef, target(c), n)],
  bNoCastCancel: [0, q => { q.noCastCancel = true; }], bShortWeaponDamageReturn: [1, (q, n) => { q.shortReturn += n; }],
  bNoKnockback: [0, q => { q.noKnock = true; }], bNoWalkDelay: [0, q => { q.noWalkDelay = true; }],
  bBreakWeaponRate: [1, (q, n) => { q.breakWeapon += n; }], bBreakArmorRate: [1, (q, n) => { q.breakArmor += n; }],
  bComaClass: [2, (q, c, n) => add(q.coma, target(c), n)], bComaRace: [2, (q, r, n) => add(q.comaRace, target(r), n)],
  // (the sets', by request): a normal or skill weapon attack sure to hit at n % (is_attack_hitting: bPerfectHitRate
  // the most of them, bPerfectHitAddRate added on); the cast time before renewal (bCastrate: bVariableCastrate's);
  // bUseSPRate as a set writes it (rAthena's names go by any case)
  bPerfectHitRate: [1, (q, n) => { q.perfectHit = Math.max(q.perfectHit, n); }], bPerfectHitAddRate: [1, (q, n) => { q.perfectHitAdd += n; }],
  bCastrate: [1, (q, n) => { q.varCast -= n; }], bUseSPRate: [1, (q, n) => { q.spCut -= n; }],
  bDefRate: [1, (q, n) => { q.defRate += n; }], bMdefRate: [1, (q, n) => { q.mdefRate += n; }],
  bHPRegenRate: [2, (q, n, ms) => { q.hpEvery.push({ n, ms }); }], bSPRegenRate: [2, (q, n, ms) => { q.spEvery.push({ n, ms }); }],
  bHPLossRate: [2, (q, n, ms) => { q.hpEvery.push({ n: -n, ms }); }],
  bNoGemStone: [0, q => { q.noGem = true; }], bRestartFullRecover: [0, q => { q.fullRecover = true; }],
  bGetZenyNum: [2, (q, max, rate) => { q.zeny.push({ max, rate }); }],
  // (the last of them, by request): a skill's knockback cells more (by its name or id); critical + n on a bow's normal
  // attack (tenths); walking faster (the most of them, not added); magic damage taken n % less, and at 50 % and more
  // no magic aimed at one at all, nor its statuses and heals (status_isimmune: Golden Thief Bug's); single-target magic sent back at
  // n %; a normal attack's splash on those round its target; the hidden and cloaked seen and hit; a
  // monster hit by a weapon turned into another at n /10000; the target's DEF turned to damage (piercing); a group's
  // item from a kill
  bAddSkillBlow: [2, (q, sk, n) => add(q.skillBlow, sk, n)],
  bCriticalLong: [1, (q, n) => { q.critLong += 10 * n; }],
  bSpeedRate: [1, (q, n) => { q.speedRate = Math.max(q.speedRate, n); }],
  bNoMagicDamage: [1, (q, n) => { q.noMagic = Math.min(100, q.noMagic + n); }],
  bMagicDamageReturn: [1, (q, n) => { q.magicReturn += n; }],
  bSplashRange: [1, (q, n) => { q.splash = Math.max(q.splash, n); }],
  bIntravision: [0, q => { q.intravision = true; }],  // (by request: the hidden and cloaked seen, gone for and hit)
  bClassChange: [1, (q, n) => { q.classChange += n; }],
  bDefRatioAtkClass: [1, (q, c) => { q.defRatio[target(c)] = true; }],
  bAddMonsterDropItemGroup: [[2, 3], (q, g, a, b) => { q.groupDrops.push({ group: String(g).replace(/^IG_/, ''), race: b === undefined ? 'All' : target(a), rate: b ?? a }); }],
};
// a status as the simulation names it (Eff_Stun → stun)
const EFF = { Stun: 'stun', Freeze: 'freeze', Stone: 'stone', Sleep: 'sleep', Poison: 'poison', Curse: 'curse', Silence: 'silence',
  Confusion: 'confuse', Blind: 'blind', Bleeding: 'bleed' };
const effOf = e => EFF[String(e).replace(/^Eff_/, '')] || String(e);
// the battle flags an autospell goes by (pc_bonus_autospell: both ranges, a weapon's, normal attacks, unless said)
const BF_RANGE = NUMBERS.BF_SHORT | NUMBERS.BF_LONG, BF_TYPE = NUMBERS.BF_WEAPON | NUMBERS.BF_MAGIC | NUMBERS.BF_MISC, BF_HOW = NUMBERS.BF_SKILL | NUMBERS.BF_NORMAL;
function bfOf(bf) {
  if (!(bf & BF_RANGE)) bf |= BF_RANGE;
  if (!(bf & BF_TYPE)) bf |= NUMBERS.BF_WEAPON;
  if (!(bf & BF_HOW)) { if (bf & (NUMBERS.BF_MAGIC | NUMBERS.BF_MISC)) bf |= NUMBERS.BF_SKILL; if (bf & NUMBERS.BF_WEAPON) bf |= NUMBERS.BF_NORMAL; }
  return bf;
}
// an add effect's flags (pc_bonus_addeff: both ranges, at the target, weapon attacks, unless said)
function atfOf(f) {
  if (!(f & (NUMBERS.ATF_SHORT | NUMBERS.ATF_LONG))) f |= NUMBERS.ATF_SHORT | NUMBERS.ATF_LONG;
  if (!(f & (NUMBERS.ATF_TARGET | NUMBERS.ATF_SELF))) f |= NUMBERS.ATF_TARGET;
  if (!(f & (NUMBERS.ATF_WEAPON | NUMBERS.ATF_MAGIC | NUMBERS.ATF_MISC))) f |= NUMBERS.ATF_WEAPON;
  return f;
}
export const BF = { WEAPON: NUMBERS.BF_WEAPON, MAGIC: NUMBERS.BF_MAGIC, MISC: NUMBERS.BF_MISC, SHORT: NUMBERS.BF_SHORT, LONG: NUMBERS.BF_LONG,
  SKILL: NUMBERS.BF_SKILL, NORMAL: NUMBERS.BF_NORMAL, RANGE: BF_RANGE, TYPE: BF_TYPE, HOW: BF_HOW };
export const ATF = { SELF: NUMBERS.ATF_SELF, TARGET: NUMBERS.ATF_TARGET, SHORT: NUMBERS.ATF_SHORT, LONG: NUMBERS.ATF_LONG, WEAPON: NUMBERS.ATF_WEAPON,
  MAGIC: NUMBERS.ATF_MAGIC, MISC: NUMBERS.ATF_MISC };
// what the simulation has (sim.js init: the skills it can use, the items it knows, the statuses it puts on): a card
// whose autospell, drop or status is not among them is left out of the pool (supported)
let has = { skill: () => true, item: () => true, eff: () => true, group: () => true };
export function setKnown(o) { has = { ...has, ...o }; okOf.clear(); }
const argsOk = c => {
  const [n, a, , , ] = c.args;
  if (n === 'bAutoSpell' || n === 'bAutoSpellWhenHit') return has.skill(a);
  if (n === 'bAddEff' || n === 'bAddEff2' || n === 'bAddEffWhenHit' || n === 'bResEff') return has.eff(effOf(a));
  if (n === 'bAddMonsterDropItem') return has.item(+a);
  if (n === 'bAddMonsterDropItemGroup') return has.group(String(a).replace(/^IG_/, ''));
  return true;
};
const ARITY = { bonus: 1, bonus2: 2, bonus3: 3, bonus4: 4, bonus5: 5 };
const empty = () => ({ intravision: false, castSkill: {}, skillBlow: {}, critLong: 0, speedRate: 0, noMagic: 0, magicReturn: 0, splash: 0, classChange: 0, defRatio: {}, groupDrops: [], autoBonus: [], addRace2: {}, addMob: {}, defMob: {}, longDef: 0, ignoreDef: {}, ignoreMdef: {}, noCastCancel: false, shortReturn: 0,
  noKnock: false, noWalkDelay: false, breakWeapon: 0, breakArmor: 0, coma: {}, comaRace: {}, perfectHit: 0, perfectHitAdd: 0, defRate: 0, mdefRate: 0, hpEvery: [], spEvery: [], noGem: false,
  fullRecover: false, zeny: [], autoSpell: [], autoSpellHit: [], addEff: [], addEffHit: [], resEff: {}, hpDrain: { rate: 0, per: 0 }, spDrain: { rate: 0, per: 0 },
  spDrainValue: 0, spGainRace: {}, spGain: 0, hpGain: 0, expRace: {}, drops: [], healPower: 0, noRegen: 0, stats: {}, eatk: 0, ematk: 0, matkRate: 0, atkRate: 0, def: 0, mdef: 0, hit: 0, flee: 0, flee2: 0, cri: 0, criRace: {},
  critAtk: 0, longAtk: 0, maxHp: 0, maxHpRate: 0, maxSp: 0, maxSpRate: 0, aspd: 0, aspdRate: 0, hpRecov: 0, spRecov: 0, varCast: 0, spCut: 0,
  delayCut: 0, addRace: {}, addEle: {}, addSize: {}, addClass: {}, magicAddRace: {}, magicAddEle: {}, magicAddSize: {}, magicAddClass: {},
  magicAtkEle: {}, skillAtk: {}, subEle: {}, subRace: {}, subSize: {}, subClass: {}, defEle: null, atkEle: null, noSizeFix: false });
// a call the simulation does (a bonus of BONUS with its arity — bonus bNoSizeFix has none; bAutoSpell's bonus3 or
// bonus4 —, of a skill, item and status it has)
const arities = n => [BONUS[n][0]].flat();
const known = c => AUTOBONUS[c.call] ? typeof c.args[0] === 'string' && run(scriptOf(c.args[0]), {}, [], {}, true).every(known)
  : c.call in ARITY && !!BONUS[c.args[0]] && arities(c.args[0]).some(a => (a || 1) === ARITY[c.call] && c.args.length === a + 1) && argsOk(c);
// autobonus <script>,<rate ‰>,<ms>,<battle flags>,<…>: for that long after one of its attacks lands at that rate its
// script's bonuses are on too (autobonus2: after an attack lands on it) — pc_addautobonus' flags: both ranges, a
// weapon's, normal attacks and skills, unless said; sim.js cardsOnHit, cardBuffs
const AUTOBONUS = { autobonus: 'on', autobonus2: 'hit' };
function autoBfOf(bf) {
  if (!(bf & BF_RANGE)) bf |= BF_RANGE;
  if (!(bf & BF_TYPE)) bf |= NUMBERS.BF_WEAPON;
  if (!(bf & BF_HOW)) { if (bf & (NUMBERS.BF_MAGIC | NUMBERS.BF_MISC)) bf |= NUMBERS.BF_SKILL; if (bf & NUMBERS.BF_WEAPON) bf |= BF_HOW; }
  return bf;
}

// what card x may do, every branch of it: [{ call, args }] (args unworked where they hang on who)
export const cardCalls = x => run(scriptOf(x.script || ''), {}, [], {}, true);
// card x has nothing the simulation leaves out (by request: the game's pool is these, for now)
const okOf = new Map();
export function supported(x) {
  if (!okOf.has(x.id)) {
    let ok;
    // (one that goes by its refine, none here — a card is on a character — is left out too: 小青's LUK − 5)
    try { ok = !!(x.script || '').trim() && !/\bgetrefine\b/.test(x.script) && cardCalls(x).every(known); } catch (e) { ok = false; }
    okOf.set(x.id, ok);
  }
  return okOf.get(x.id);
}
// the sum of what cards (card items, as many of one as it has) do on who (see run) → the shape of `empty`, for
// battle.js playerStatus' ch.cards; null for none
export function cardBonus(cards, who) {
  if (!cards || !cards.length) return null;
  const q = empty(), ids = new Set();
  const put = script => {
    for (const c of run(scriptOf(script), who)) {
      if (!known(c)) continue;
      if (AUTOBONUS[c.call]) q.autoBonus.push({ script: c.args[0], rate: c.args[1], ms: c.args[2], bf: autoBfOf(c.args[3] || 0), hit: c.call === 'autobonus2' });
      else BONUS[c.args[0]][1](q, ...c.args.slice(1));
    }
  };
  for (const x of cards) {
    if (!x || !supported(x)) continue;
    ids.add(+x.id);
    put(x.script);
  }
  // (and each set it has every card of, once however many of them: setCombos; what of a set's script the simulation
  // does not work out — a skill it has not, 塔羅牌命運 — left out)
  for (const k of COMBOS) if (k.cards.every(id => ids.has(id))) put(k.script);
  q.perfectHit += q.perfectHitAdd;
  return q;
}
// The cards' sets (by request: jobs.json combos, rAthena item_combos — those of cards only): [{ cards: [item id],
// script }]; a character with every card of one has its script's bonuses too (cardBonus). sim.js init sets them.
let COMBOS = [];
export function setCombos(list) { COMBOS = (list || []).map(k => ({ cards: k.cards.map(Number), script: k.script || '' })); }

// a character's place in the job lines for the scripts' BaseClass / BaseJob: job (jobs.json's: its rAthena name),
// first (its first job's), sex ('여': a bard's node is a Dancer)
export function jobConsts(job, first, sex) {
  const name = j => j ? 'Job_' + (j.female && sex === '여' ? j.female.name : j.name).replace(/^Super_Novice$/, 'SuperNovice') : 'Job_Novice';
  return { baseJob: name(job), baseClass: name(first || job) };
}

// what card x does on who (see run): the calls of it the simulation works out ([] where its conditions leave it
// nothing: a sword's card on one without a sword, a Thief's on another job)
export function activeCalls(x, who) {
  if (!supported(x)) return [];
  return run(scriptOf(x.script), who).filter(known).filter(c => AUTOBONUS[c.call] || c.args.slice(1).every(a => a !== 0) || c.args.length === 1);
}
// what kinds of thing card x does, as keys (by request: a hard map offers one or two cards like those the party has):
// the bonus, and what it is on for a race's, an element's … ('bCritical', 'bAddRace:Demihuman'); every branch of it
export function cardKeys(x) {
  if (x.keys) return x.keys;
  let calls = [];
  try { calls = cardCalls(x); } catch (e) {}
  return x.keys = [...new Set(calls.filter(known).map(c => AUTOBONUS[c.call] ? c.call : c.args.length > 2 && typeof c.args[1] === 'string' ? `${c.args[0]}:${target(c.args[1])}` : c.args[0]))];
}
// the client's description as HTML (esc: the page's escaping): its ^RRGGBB colours (^000000 back to the text's), a
// dark one lightened (the viewer's 道具 tab's, the game's), its lines kept
export function descHtml(text, esc, lift = 110) {
  let open = false;
  const html = esc(text || '').replace(/\^([0-9a-fA-F]{6})/g, (_, c) => {
    const close = open ? '</span>' : '';
    open = c !== '000000';
    if (!open) return close;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16));
    const up = 0.2126 * r + 0.7152 * g + 0.0722 * b < lift ? 0.5 : 0, mix = v => Math.round(v + (255 - v) * up);
    return `${close}<span style="color: rgb(${mix(r)}, ${mix(g)}, ${mix(b)})">`;
  });
  return html + (open ? '</span>' : '');
}
