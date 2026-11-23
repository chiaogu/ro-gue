// The stat builds a character's points can go into on their own (by request): for each second job, the stats
// it has at base level 10, 30, 50, 70 and 99. Each level's are what its points buy (to within a few), so a
// character on a build at one of those levels has those stats (sim.autoStats); in between, it is on its way to
// the next.
// A first job takes its second jobs' builds, a transcendent, third or fourth job its second job's.
const LEVELS = [10, 30, 50, 70, 99];
const WIZARD = 'INT 28 | INT 44 DEX 20 | INT 60 DEX 40 VIT 11 | INT 80 DEX 55 VIT 20 | INT 99 DEX 88 VIT 40';
const FIGHT_SMITH = 'AGI 20 DEX 15 | AGI 35 DEX 25 STR 15 | AGI 53 STR 40 DEX 25 | AGI 74 STR 60 DEX 25 | AGI 85 STR 80 DEX 40 VIT 40 LUK 30';  // (a blacksmith's and an alchemist's alike)
const TABLE = [
  ['기사', '騎士・敏騎', 'AGI 20 DEX 15 | AGI 35 DEX 25 STR 15 | AGI 60 DEX 30 STR 26 | AGI 80 DEX 30 STR 49 | AGI 91 STR 80 VIT 45 DEX 40'],
  ['기사', '騎士・互擊騎', 'STR 20 DEX 15 | STR 37 DEX 30 | STR 60 DEX 43 | STR 80 DEX 45 VIT 36 | STR 99 VIT 74 DEX 60'],
  ['크루세이더', '十字軍・聖十', 'VIT 20 DEX 15 | VIT 35 DEX 21 INT 20 | VIT 53 INT 40 DEX 25 | VIT 74 INT 60 DEX 25 | VIT 85 INT 88 DEX 50 STR 30'],
  ['크루세이더', '十字軍・坦十', 'VIT 20 DEX 15 | VIT 35 DEX 21 STR 20 | VIT 60 DEX 25 STR 20 INT 19 | VIT 83 STR 40 DEX 25 INT 20 | VIT 99 STR 60 INT 61 DEX 35'],
  ['위저드', '巫師', WIZARD],
  ['세이지', '賢者・戰鬥賢者', 'INT 20 DEX 15 | DEX 25 INT 21 AGI 20 STR 20 | INT 40 AGI 40 STR 29 DEX 25 | INT 60 AGI 57 STR 40 DEX 25 | INT 70 AGI 70 STR 70 DEX 57'],
  ['세이지', '賢者・輔助賢者', 'INT 28 | INT 44 DEX 20 | INT 60 DEX 43 | INT 80 DEX 55 VIT 20 | INT 99 DEX 88 VIT 40'],
  ['헌터', '獵人・陷阱獵', 'DEX 28 | DEX 44 INT 20 | DEX 62 INT 40 | DEX 89 INT 40 AGI 20 | DEX 99 INT 60 VIT 50 AGI 49'],
  ['헌터', '獵人・敏獵', 'DEX 28 | DEX 44 AGI 20 | DEX 62 AGI 40 | DEX 81 AGI 60 | DEX 99 AGI 90 LUK 36'],
  ['바드/무희', '詩人／舞孃・攻擊型', 'DEX 28 | DEX 44 AGI 20 | DEX 62 AGI 40 | DEX 81 AGI 60 | DEX 99 AGI 84 VIT 30 LUK 30'],
  ['바드/무희', '詩人／舞孃・輔助型', 'INT 28 | INT 36 VIT 20 DEX 20 | INT 50 VIT 40 DEX 31 | INT 70 VIT 55 DEX 40 | INT 95 VIT 70 DEX 70'],
  ['프리스트', '祭司・輔助祭', 'INT 28 | INT 52 | INT 78 | INT 99 DEX 29 | INT 99 DEX 99 VIT 9'],
  null,  // (祭司・戰祭, b12, removed by request: its place kept so the ids after it stay theirs; one kept on it goes on 輔助祭, REPLACED)
  ['프리스트', '祭司・驅魔祭', WIZARD],
  ['몽크', '武僧・連段', 'AGI 20 STR 15 | AGI 32 STR 25 DEX 20 | AGI 60 STR 31 DEX 25 | AGI 80 STR 45 DEX 36 | AGI 99 STR 82 DEX 50'],
  ['몽크', '武僧・阿修羅', 'STR 20 DEX 15 | STR 35 DEX 25 INT 15 | STR 60 INT 31 DEX 25 | STR 80 INT 52 DEX 25 | STR 99 INT 82 DEX 50'],
  ['어세신', '刺客・爆刺', 'AGI 20 DEX 15 | AGI 32 STR 20 DEX 25 | AGI 65 STR 20 DEX 25 | AGI 90 STR 25 DEX 25 LUK 20 | AGI 99 STR 80 LUK 40 DEX 28'],
  ['어세신', '刺客・音速刺', 'AGI 20 DEX 15 | AGI 32 STR 20 DEX 25 | AGI 65 STR 20 DEX 25 | AGI 94 STR 25 DEX 25 | AGI 99 STR 80 DEX 38 VIT 30'],
  ['로그', '流氓・弓流氓', 'DEX 28 | DEX 44 AGI 20 | DEX 62 AGI 40 | DEX 81 AGI 60 | DEX 99 AGI 84 VIT 30 LUK 30'],
  ['로그', '流氓・敏流氓', 'AGI 20 DEX 15 | AGI 35 DEX 25 STR 15 | AGI 60 STR 31 DEX 25 | AGI 80 STR 52 DEX 25 | AGI 91 STR 80 VIT 45 DEX 40'],
  ['제철공', '鐵匠・戰鬥鐵匠', FIGHT_SMITH],
  ['제철공', '鐵匠・鍛造鐵匠', 'DEX 28 | DEX 44 LUK 20 | DEX 62 LUK 40 | DEX 81 LUK 60 | DEX 99 LUK 92 STR 30'],
  ['연금술사', '鍊金術師・戰鬥型', FIGHT_SMITH],
  // (in the pharmacist's place, by request, so its id: the homunculus build's, whose skills go by none of the
  // alchemist's stats but their casts: DEX, then INT (cast time, SP), VIT; no LUK, there being no making yet)
  ['연금술사', '鍊金術師・生命體型', 'DEX 28 | DEX 44 INT 20 | DEX 60 INT 40 VIT 10 | DEX 75 INT 56 VIT 30 | DEX 99 INT 72 VIT 63'],
  // (added after the rest, so their ids stay theirs) a spear knight: STR, then VIT, some DEX
  ['기사', '騎士・槍騎', 'STR 20 VIT 15 | STR 37 VIT 22 DEX 15 | STR 60 VIT 34 DEX 20 | STR 80 VIT 50 DEX 30 | STR 99 VIT 80 DEX 50 AGI 10'],
  // an assassin with two weapons (by request): AGI, then DEX over LUK (each hand to hit), STR
  ['어세신', '刺客・雙刀刺', 'AGI 20 DEX 15 | AGI 32 DEX 25 STR 20 | AGI 60 DEX 35 STR 20 | AGI 80 DEX 45 STR 36 | AGI 99 STR 82 DEX 50'],
  // a monk to stand in front (by request): VIT, then STR, INT for its SP
  ['몽크', '武僧・坦', 'VIT 20 STR 15 | VIT 35 STR 25 INT 15 | VIT 55 STR 36 INT 27 | VIT 75 STR 51 INT 37 | VIT 99 STR 68 INT 55 DEX 30'],
  // a crusader on a spear (by request): the spear knight's, AGI in VIT's place (Spear Quicken's attack speed)
  ['크루세이더', '十字軍・矛十', 'STR 20 AGI 15 | STR 37 AGI 22 DEX 15 | STR 60 AGI 34 DEX 20 | STR 80 AGI 50 DEX 30 | STR 99 AGI 80 DEX 50 VIT 10'],
];
// the second jobs each first job goes on to, and the jobs that come after each second job
const FIRST = { 검사: ['기사', '크루세이더'], 마법사: ['위저드', '세이지'], 궁수: ['헌터', '바드/무희'],
  성직자: ['프리스트', '몽크'], 상인: ['제철공', '연금술사'], 도둑: ['어세신', '로그'] };
const LATER = {
  기사: ['로드나이트', '룬나이트', 'dragon_knight'], 크루세이더: ['팔라딘', '가드', 'imperial_guard'],
  위저드: ['하이위저드', '워록', 'arch_mage'], 세이지: ['프로페서', '소서러', 'elemetal_master'],
  헌터: ['스나이퍼', '레인져', 'windhawk'], '바드/무희': ['클라운/집시', '민스트럴/원더러', 'troubadour/trouvere'],
  프리스트: ['하이프리', '아크비숍', 'cardinal'], 몽크: ['챔피온', '슈라', 'inquisitor'],
  제철공: ['화이트스미스', '미케닉', 'meister'], 연금술사: ['크리에이터', '제네릭', 'biolo'],
  어세신: ['어쌔신크로스', '길로틴크로스', 'shadow_cross'], 로그: ['스토커', '쉐도우체이서', 'abyss_chaser'],
};
// (by request, for changing jobs) the two second jobs first job `job` can change to ([] for none), and the first
// job second job `job` changed from (null for none)
export const secondJobsOf = job => FIRST[job] || [];
export const firstJobOf = job => Object.keys(FIRST).find(f => FIRST[f].includes(job)) || null;
// the second job a build (stat or skill: its job) is of, null for none
export const secondOfBuild = job => Object.values(FIRST).some(s => s.includes(job)) ? job : null;
// 'STR 44 DEX 20' → { str: 44, dex: 20 } (in the order given: the first is raised first on a tie)
const parse = text => Object.fromEntries(text.trim().split(/\s+/).reduce((a, w, i, all) => i % 2 ? a : [...a, [w.toLowerCase(), +all[i + 1]]], []));
// At base level 1 (by request) a build has its three most important stats at 9, the 48 points level 1 has: the
// first three it raises, in the order its steps name them (as a new character's are made, 9 at most each).
const withStart = steps => {
  const top = [...new Set(steps.flatMap(([, st]) => Object.keys(st)))].slice(0, 3);
  return [[1, Object.fromEntries(top.map(s => [s, 9]))], ...steps];
};
// every build: { id, label, job (the second job's), steps: [[base level, stats], ...] }
export const BUILDS = [
  // a novice's, in the proportions a new team's novice had before (STR 4 : VIT 3 : DEX 3)
  { id: 'novice', label: '初學者・基本', job: '초보자', steps: withStart([[10, { str: 14, vit: 12, dex: 12 }]]) },
  ...TABLE.flatMap((row, i) => row ? [{ id: 'b' + i, label: row[1], job: row[0],
    steps: withStart(row[2].split('|').map((t, k) => [LEVELS[k], parse(t)])) }] : []),
];
const byId = Object.fromEntries(BUILDS.map(b => [b.id, b]));
// (by request) a build taken out: the one a character kept on it goes on instead
const REPLACED = { b12: 'b11' };
export const liveBuild = id => REPLACED[id] || id;
// the builds job `job` can be on (none: only 自訂)
export function buildsFor(job) {
  const second = FIRST[job] || [Object.keys(LATER).find(j => j === job || LATER[j].includes(job)) || job];
  return BUILDS.filter(b => second.includes(b.job));
}
// a build's steps: from its id, or steps given as they are (the bench's); null for none (自訂)
export const stepsOf = build => Array.isArray(build) ? build : build && byId[build] ? byId[build].steps : null;
export const buildLabel = id => byId[id] ? byId[id].label : '';

// The skill builds (by request): the skills a job line's points go into, in order, each step raising one skill
// to the level it lists, a point a job level (Job 2 on: 49 points by Job 50, a second job's 49 more after the first
// job's). A second job's (by request) name its first job's skills too, all 98 points: its first job takes them, as
// far as its own skills go (the second job's are passed over); a line whose second jobs have none yet has its
// first job's, which its later jobs take too. Each has its id for good, so a character's stays its own.
const SKILL_TABLE = [
  // a knight with a two-handed sword: Two-Hand Quicken and the skills Bowling Bash needs (Sword Mastery 1 is
  // what Two-Handed Sword Mastery needs); the 敏騎 rides first, the 互擊騎 goes for Bowling Bash first. With
  // the sword they have nothing left to go to: HP Recovery, Endure and Spear Mastery (Bowling Bash with a spear)
  ['s9', '기사', '騎士・敏騎', 'SM_BASH 10 | SM_SWORD 1 | SM_TWOHAND 10 | SM_MAGNUM 10 | SM_PROVOKE 10 | SM_ENDURE 8 | KN_TWOHANDQUICKEN 10 | KN_RIDING 1 | KN_CAVALIERMASTERY 5 | KN_AUTOCOUNTER 5 | KN_BOWLINGBASH 10 | SM_RECOVERY 10 | SM_ENDURE 10 | KN_SPEARMASTERY 6'],
  ['s10', '기사', '騎士・互擊騎', 'SM_BASH 10 | SM_SWORD 1 | SM_TWOHAND 10 | SM_MAGNUM 10 | SM_PROVOKE 10 | SM_ENDURE 8 | KN_TWOHANDQUICKEN 10 | KN_AUTOCOUNTER 5 | KN_BOWLINGBASH 10 | KN_RIDING 1 | KN_CAVALIERMASTERY 5 | SM_RECOVERY 10 | SM_ENDURE 10 | KN_SPEARMASTERY 6'],
  // a knight with a spear: Pierce for one, Brandish Spear (riding) for a crowd, Spear Boomerang from afar; no
  // sword skills
  ['s11', '기사', '騎士・槍騎', 'SM_BASH 10 | SM_MAGNUM 10 | SM_PROVOKE 10 | SM_ENDURE 10 | SM_RECOVERY 9 | KN_SPEARMASTERY 10 | KN_PIERCE 10 | KN_RIDING 1 | KN_CAVALIERMASTERY 5 | KN_SPEARSTAB 3 | KN_BRANDISHSPEAR 10 | KN_SPEARBOOMERANG 5 | KN_SPEARSTAB 8'],
  // a crusader's three (by request), their swordsman's 49 points the spear knight's: 聖十, Grand Cross (the Faith and Holy
  // Cross 6 it needs), Auto Guard, then Heal (the Cure, Divine Protection 3 and Demon Bane 5 it needs); 坦十, a shield's,
  // Auto Guard, Shield Charge and Shield Boomerang 3, Reflect Shield 5, then Sacrifice (the Faith, Holy Cross 6 and Grand
  // Cross 4 it needs), its last 3 in Defending Aura; 矛十, riding with a two-handed spear (no shield, so none of its
  // skills): Spear Mastery and Spear Quicken, Riding and Cavalry Mastery, Faith and Holy Cross 10, Cure and Divine
  // Protection 2
  ['s23', '크루세이더', '十字軍・聖十', 'SM_BASH 10 | SM_MAGNUM 10 | SM_PROVOKE 10 | SM_ENDURE 10 | SM_RECOVERY 9 | CR_TRUST 10 | CR_HOLYCROSS 6 | CR_GRANDCROSS 10 | CR_AUTOGUARD 10 | AL_CURE 1 | AL_DP 3 | AL_DEMONBANE 5 | AL_HEAL 4'],
  ['s24', '크루세이더', '十字軍・坦十', 'SM_BASH 10 | SM_MAGNUM 10 | SM_PROVOKE 10 | SM_ENDURE 10 | SM_RECOVERY 9 | CR_AUTOGUARD 10 | CR_SHIELDCHARGE 3 | CR_SHIELDBOOMERANG 3 | CR_REFLECTSHIELD 5 | CR_TRUST 10 | CR_HOLYCROSS 6 | CR_GRANDCROSS 4 | CR_DEVOTION 5 | CR_DEFENDER 3'],
  ['s25', '크루세이더', '十字軍・矛十', 'SM_BASH 10 | SM_MAGNUM 10 | SM_PROVOKE 10 | SM_ENDURE 10 | SM_RECOVERY 9 | KN_SPEARMASTERY 10 | CR_SPEARQUICKEN 10 | KN_RIDING 1 | KN_CAVALIERMASTERY 5 | CR_TRUST 10 | CR_HOLYCROSS 10 | AL_CURE 1 | AL_DP 2'],
  // a wizard's two (by request, the mage's taken on: their first 49 points are the mage's as they were, so they
  // keep its ids): fire, with Fire Wall, Meteor Storm, Lord of Vermilion and Quagmire (the Lightning Bolt,
  // Thunderstorm, Sightrasher 2, Stone Curse, Earth Spike and Heaven's Drive they need come with the wizard's points;
  // Sightrasher no higher, by request); ice, with Frost Diver, Storm Gust, Lord of Vermilion, Ice Wall, then Water
  // Ball (by request; Stone Curse the one Ice Wall needs; no Frost Nova, by request)
  ['s3', '위저드', '巫師・火法', 'MG_FIREBOLT 4 | MG_FIREBALL 5 | MG_SIGHT 1 | MG_FIREWALL 10 | MG_NAPALMBEAT 4 | MG_SOULSTRIKE 10 | MG_FIREBOLT 10 | MG_SRECOVERY 9 | MG_LIGHTNINGBOLT 1 | WZ_SIGHTRASHER 2 | MG_LIGHTNINGBOLT 4 | MG_THUNDERSTORM 1 | WZ_METEOR 10 | WZ_JUPITEL 10 | WZ_VERMILION 10 | MG_STONECURSE 1 | WZ_EARTHSPIKE 3 | WZ_HEAVENDRIVE 1 | WZ_QUAGMIRE 5 | MG_SRECOVERY 10 | MG_LIGHTNINGBOLT 5'],
  ['s4', '위저드', '巫師・冰法', 'MG_COLDBOLT 5 | MG_FROSTDIVER 10 | MG_NAPALMBEAT 4 | MG_SOULSTRIKE 10 | MG_LIGHTNINGBOLT 10 | MG_SRECOVERY 10 | WZ_JUPITEL 3 | WZ_STORMGUST 10 | WZ_JUPITEL 10 | MG_THUNDERSTORM 1 | WZ_VERMILION 10 | MG_COLDBOLT 10 | MG_STONECURSE 1 | WZ_ICEWALL 7 | WZ_WATERBALL 5'],
  // a sage's two (by request; their first 49 points their own mage's, not the wizards'): casting, Fire Ball and Thunderstorm
  // to 10, the bolts 5 (Hindsight casts them at half its level) and Soul Strike for Hindsight's list, Study 10 (a book in
  // hand), Free Cast, Hindsight 10, Magic Rod 1, Spell Breaker 5, Heaven's Drive 5 (the Endow Quake, Earth Spike 1 and
  // Stone Curse 1 it needs), the other endows 1, its last 2 in Soul Strike; no Dragonology (by request). Fields, Hocus-
  // Pocus 10 with what it needs (the fields 3, Land Protector, Dispell 1, Hindsight 5), the endows no higher than the 2
  // the fields need, the fields to 4 after; its mage's the ice wizard's first 49 with Fire Bolt 1 (Endow Blaze's) from
  // Increase SP Recovery
  ['s21', '세이지', '賢者・施法', 'MG_FIREBOLT 4 | MG_FIREBALL 5 | MG_LIGHTNINGBOLT 4 | MG_THUNDERSTORM 5 | MG_NAPALMBEAT 4 | MG_SOULSTRIKE 5 | MG_FIREBALL 10 | MG_THUNDERSTORM 10 | MG_FIREBOLT 5 | MG_LIGHTNINGBOLT 5 | MG_COLDBOLT 5 | MG_STONECURSE 1 | MG_SRECOVERY 4 | SA_ADVANCEDBOOK 10 | SA_CASTCANCEL 1 | SA_FREECAST 4 | SA_AUTOSPELL 10 | SA_SEISMICWEAPON 1 | WZ_EARTHSPIKE 1 | WZ_HEAVENDRIVE 5 | SA_MAGICROD 1 | SA_SPELLBREAKER 5 | SA_FREECAST 10 | SA_FLAMELAUNCHER 1 | SA_FROSTWEAPON 1 | SA_LIGHTNINGLOADER 1 | MG_SOULSTRIKE 7'],
  ['s22', '세이지', '賢者・領域', 'MG_COLDBOLT 5 | MG_FROSTDIVER 10 | MG_NAPALMBEAT 4 | MG_SOULSTRIKE 10 | MG_LIGHTNINGBOLT 10 | MG_FIREBOLT 1 | MG_SRECOVERY 9 | SA_ADVANCEDBOOK 5 | SA_FLAMELAUNCHER 2 | SA_FROSTWEAPON 2 | SA_LIGHTNINGLOADER 2 | SA_VOLCANO 3 | SA_DELUGE 3 | SA_VIOLENTGALE 3 | SA_LANDPROTECTOR 1 | SA_MAGICROD 1 | SA_SPELLBREAKER 3 | SA_DISPELL 1 | SA_CASTCANCEL 1 | SA_FREECAST 4 | SA_AUTOSPELL 5 | SA_ABRACADABRA 10 | SA_VOLCANO 4 | SA_DELUGE 4 | SA_VIOLENTGALE 4'],
  // a hunter's two (by request, the archer's taken on: their first 49 points are the archer's as they were, so the
  // falcon one keeps its id): traps, Ankle Snare first,
  // Flasher to 5 (by request), then Blast Mine and Claymore Trap (the traps they need), every trap to 5 but Talkie
  // Box and Shockwave Trap (a monster has no SP), the falcon with Blitz Beat 5; falcon, Blitz Beat with Steel
  // Crow for the Blitz Beat its normal attack sets off, Ankle Snare, Flasher to 5, Freezing Trap and Claymore Trap,
  // the rest in traps (Beast Bane only the 1 the falcon needs, by request)
  ['s13', '헌터', '獵人・陷阱獵', 'AC_DOUBLE 10 | AC_OWL 3 | AC_VULTURE 10 | AC_OWL 10 | AC_CONCENTRATION 10 | AC_SHOWER 9 | HT_SKIDTRAP 1 | HT_ANKLESNARE 5 | HT_FLASHER 5 | HT_LANDMINE 1 | HT_FREEZINGTRAP 1 | HT_SANDMAN 1 | HT_BLASTMINE 5 | HT_SHOCKWAVE 1 | HT_CLAYMORETRAP 5 | HT_FREEZINGTRAP 5 | HT_SANDMAN 5 | HT_REMOVETRAP 1 | HT_BEASTBANE 1 | HT_FALCON 1 | HT_BLITZBEAT 5 | HT_SKIDTRAP 5 | HT_LANDMINE 5'],
  ['s5', '헌터', '獵人・敏獵', 'AC_DOUBLE 10 | AC_OWL 3 | AC_VULTURE 10 | AC_OWL 10 | AC_CONCENTRATION 10 | AC_SHOWER 9 | HT_BEASTBANE 1 | HT_FALCON 1 | HT_BLITZBEAT 5 | HT_STEELCROW 10 | HT_SKIDTRAP 1 | HT_ANKLESNARE 5 | HT_FLASHER 5 | HT_FREEZINGTRAP 5 | HT_LANDMINE 1 | HT_SANDMAN 1 | HT_BLASTMINE 3 | HT_SHOCKWAVE 1 | HT_CLAYMORETRAP 5 | HT_SANDMAN 5 | HT_BLASTMINE 4'],
  // a bard's and a dancer's three (by request), each step a bard's skill and the dancer's in its place (each passes over
  // the other's): attack, Musical Strike and Assassin Cross / Don't Forget Me, Whistle / Humming; support one,
  // Assassin Cross / Don't Forget Me and Apple of Idun / Service for You, with Loki's Veil, Eternal Chaos, Drum on
  // the Battlefield and Ring of Nibelungen; support two, Poem of Bragi / Fortune's Kiss and Whistle / Humming, with
  // Siegfried, Lullaby, Into the Abyss, Frost Joke / Scream, Musical Strike and Pang Voice / Wink of Charm.
  // The two supports between them have every skill of theirs but Mr. Kim (by request: neither has it)
  ['s18', '바드/무희', '詩人／舞孃・攻擊型', 'AC_DOUBLE 10 | AC_OWL 3 | AC_VULTURE 10 | AC_OWL 10 | AC_CONCENTRATION 10 | AC_SHOWER 9 | BA_MUSICALLESSON 3 | DC_DANCINGLESSON 3 | BA_MUSICALSTRIKE 5 | DC_THROWARROW 5 | BD_ADAPTATION 1 | BA_DISSONANCE 3 | DC_UGLYDANCE 3 | BA_MUSICALLESSON 10 | DC_DANCINGLESSON 10 | BA_ASSASSINCROSS 10 | DC_DONTFORGETME 10 | BA_WHISTLE 10 | DC_HUMMING 10 | BD_ENCORE 1 | BA_FROSTJOKER 5 | DC_SCREAM 5 | BA_PANGVOICE 1 | DC_WINKCHARM 1 | BD_ROKISWEIL 1 | BD_ETERNALCHAOS 1 | BD_LULLABY 1'],
  ['s19', '바드/무희', '詩人／舞孃・輔助一', 'AC_DOUBLE 10 | AC_OWL 3 | AC_VULTURE 10 | AC_OWL 10 | AC_CONCENTRATION 10 | AC_SHOWER 9 | BA_MUSICALLESSON 3 | DC_DANCINGLESSON 3 | BD_ADAPTATION 1 | BA_DISSONANCE 3 | DC_UGLYDANCE 3 | BA_ASSASSINCROSS 10 | DC_DONTFORGETME 10 | BA_MUSICALLESSON 10 | DC_DANCINGLESSON 10 | BA_APPLEIDUN 10 | DC_SERVICEFORYOU 10 | BD_ROKISWEIL 1 | BD_ETERNALCHAOS 1 | BD_DRUMBATTLEFIELD 5 | BD_RINGNIBELUNGEN 5 | BA_DISSONANCE 5 | DC_UGLYDANCE 5 | BD_ENCORE 1'],
  ['s20', '바드/무희', '詩人／舞孃・輔助二', 'AC_DOUBLE 10 | AC_OWL 3 | AC_VULTURE 10 | AC_OWL 10 | AC_CONCENTRATION 10 | AC_SHOWER 9 | BA_MUSICALLESSON 3 | DC_DANCINGLESSON 3 | BD_ADAPTATION 1 | BA_DISSONANCE 3 | DC_UGLYDANCE 3 | BA_POEMBRAGI 10 | DC_FORTUNEKISS 10 | BA_MUSICALLESSON 10 | DC_DANCINGLESSON 10 | BA_WHISTLE 10 | DC_HUMMING 10 | BD_SIEGFRIED 5 | BD_LULLABY 1 | BD_INTOABYSS 1 | BD_ENCORE 1 | BA_FROSTJOKER 5 | DC_SCREAM 5 | BA_MUSICALSTRIKE 1 | DC_THROWARROW 1 | BA_PANGVOICE 1 | DC_WINKCHARM 1'],
  // a priest's two (by request, the acolyte's taken on: their first 49 points are the acolyte's as they were, so the
  // support one keeps its id): support, with Sanctuary, Kyrie Eleison, Magnificat, Gloria, Impositio Manus,
  // Suffragium and Resurrection (the Status Recovery and Increase SP Recovery 4 it needs), its last 2 in Aspersio;
  // exorcist, with Magnus Exorcismus (Safety Wall, Lex Aeterna and Turn Undead 3 it needs, no higher), then Kyrie
  // Eleison to 10 and Magnificat 3
  ['s6', '프리스트', '祭司・輔助祭', 'AL_HEAL 3 | AL_INCAGI 10 | AL_DP 5 | AL_BLESSING 10 | AL_HEAL 10 | AL_CURE 1 | AL_RUWACH 1 | AL_TELEPORT 2 | AL_WARP 4 | AL_PNEUMA 1 | AL_HOLYWATER 1 | AL_DP 7 | AL_ANGELUS 2 | PR_KYRIE 10 | PR_MAGNIFICAT 5 | PR_SANCTUARY 10 | PR_IMPOSITIO 5 | PR_SUFFRAGIUM 3 | PR_GLORIA 5 | PR_STRECOVERY 1 | MG_SRECOVERY 4 | ALL_RESURRECTION 4 | PR_ASPERSIO 2'],
  ['s12', '프리스트', '祭司・驅魔祭', 'AL_HEAL 3 | AL_INCAGI 10 | AL_DP 5 | AL_BLESSING 10 | AL_HEAL 10 | AL_CURE 1 | AL_RUWACH 1 | AL_TELEPORT 2 | AL_WARP 4 | AL_PNEUMA 1 | AL_HOLYWATER 1 | AL_DP 7 | AL_ANGELUS 2 | PR_IMPOSITIO 3 | PR_ASPERSIO 4 | PR_SANCTUARY 3 | MG_SAFETYWALL 1 | PR_LEXDIVINA 5 | PR_LEXAETERNA 1 | PR_STRECOVERY 1 | MG_SRECOVERY 4 | ALL_RESURRECTION 1 | PR_TURNUNDEAD 3 | PR_MAGNUS 10 | PR_KYRIE 10 | PR_MAGNIFICAT 3'],
  // an assassin's two (by request, the thief's taken on: their first 49 points are the thief's as they were, so the
  // katar one keeps its id): katar, for the 爆刺 and the 音速刺 alike,
  // Sonic Blow and Grimtooth to their top (the Katar Mastery 4 and Cloaking 2 they need), Katar Mastery 10,
  // Enchant Poison and Cloaking 10, no Poison React (by request), its last 4 in Venom Dust; dual wield, Righthand and
  // Lefthand Mastery, Enchant Poison, Poison React, Cloaking, then Venom Dust 5 and Venom Splasher 4
  ['s7', '어세신', '刺客・拳刃刺', 'TF_DOUBLE 10 | TF_MISS 10 | TF_POISON 10 | TF_DETOXIFY 1 | TF_STEAL 10 | TF_HIDING 8 | AS_KATAR 4 | AS_SONICBLOW 10 | AS_CLOAKING 2 | AS_GRIMTOOTH 5 | AS_KATAR 10 | AS_ENCHANTPOISON 10 | AS_CLOAKING 10 | AS_VENOMDUST 4'],
  // a rogue's two (by request; their first 49 points the assassins' thief ones): a bow, Vulture's Eye and Double
  // Strafe, the four Divests (the Gank 4 and Mug 2 the Divest Helm needs; Divest Weapon 3, by request, for Tunnel
  // Drive 5: hidden, it walks off to shoot), no Slyness, Remove Trap nor more Mug (by request);
  // a dagger, Back Stab and Sightless Mind (Gank 4, Mug 4 and Tunnel Drive 2 they need), Snatch 5, Back Stab 10, Gank 10,
  // Plagiarism 10 (its ASPD and the copy), its last 3 in Tunnel Drive
  ['s28', '로그', '流氓・弓流氓', 'TF_DOUBLE 10 | TF_MISS 10 | TF_POISON 10 | TF_DETOXIFY 1 | TF_STEAL 10 | TF_HIDING 8 | AC_VULTURE 10 | AC_DOUBLE 10 | RG_SNATCHER 4 | RG_STEALCOIN 2 | RG_STRIPHELM 5 | RG_STRIPSHIELD 5 | RG_STRIPARMOR 5 | RG_STRIPWEAPON 3 | RG_TUNNELDRIVE 5'],
  ['s29', '로그', '流氓・敏流氓', 'TF_DOUBLE 10 | TF_MISS 10 | TF_POISON 10 | TF_DETOXIFY 1 | TF_STEAL 10 | TF_HIDING 8 | RG_SNATCHER 4 | RG_STEALCOIN 4 | RG_BACKSTAP 4 | RG_TUNNELDRIVE 2 | RG_RAID 5 | RG_INTIMIDATE 5 | RG_BACKSTAP 10 | RG_SNATCHER 10 | RG_PLAGIARISM 10 | RG_TUNNELDRIVE 5'],
  ['s14', '어세신', '刺客・雙刀刺', 'TF_DOUBLE 10 | TF_MISS 10 | TF_POISON 10 | TF_DETOXIFY 1 | TF_STEAL 10 | TF_HIDING 8 | AS_RIGHT 5 | AS_LEFT 5 | AS_ENCHANTPOISON 10 | AS_POISONREACT 10 | AS_CLOAKING 10 | AS_VENOMDUST 5 | AS_SPLASHER 4'],
  // a monk's three (by request): their acolyte's points their own, not the priests' (Iron Hand needs Divine Protection
  // and Demon Bane 10): Heal 3, Increase AGI and Blessing, the rest in Ruwach, Teleport 2, Cure and Angelus 2 (the
  // tank's Heal 10, Blessing and Angelus 9). Combo, Raging Trifecta Blow 5 only (its rate 30 − Lv: with the combo
  // after it, the likelier it goes off the more it deals), Chain Combo and Combo Finish 5, Iron Hand and Dodge 10,
  // Fury 5, its last 3 in Investigate; Asura Strike, with Fury, Investigate, Finger Offensive, Blade Stop 2 and
  // Spirits Recovery 5, Triple Attack 5 and Dodge 6; the tank, Steel Body 5 and Snap (the Asura Strike 3, Blade
  // Stop 2 and Spirits Recovery 2 it needs), with exactly the 49
  ['s15', '몽크', '武僧・連段', 'AL_DP 3 | AL_HEAL 3 | AL_INCAGI 10 | AL_DP 5 | AL_BLESSING 10 | AL_DEMONBANE 10 | AL_DP 10 | AL_RUWACH 1 | AL_TELEPORT 2 | AL_CURE 1 | AL_ANGELUS 2 | MO_IRONHAND 5 | MO_CALLSPIRITS 5 | MO_DODGE 5 | MO_TRIPLEATTACK 5 | MO_CHAINCOMBO 5 | MO_COMBOFINISH 5 | MO_ABSORBSPIRITS 1 | MO_EXPLOSIONSPIRITS 5 | MO_IRONHAND 10 | MO_DODGE 10 | MO_INVESTIGATE 3'],
  ['s16', '몽크', '武僧・阿修羅', 'AL_DP 3 | AL_HEAL 3 | AL_INCAGI 10 | AL_DP 5 | AL_BLESSING 10 | AL_DEMONBANE 10 | AL_DP 10 | AL_RUWACH 1 | AL_TELEPORT 2 | AL_CURE 1 | AL_ANGELUS 2 | MO_IRONHAND 2 | MO_CALLSPIRITS 5 | MO_ABSORBSPIRITS 1 | MO_EXPLOSIONSPIRITS 3 | MO_INVESTIGATE 3 | MO_FINGEROFFENSIVE 3 | MO_EXTREMITYFIST 5 | MO_EXPLOSIONSPIRITS 5 | MO_IRONHAND 5 | MO_DODGE 5 | MO_BLADESTOP 2 | MO_SPIRITSRECOVERY 5 | MO_INVESTIGATE 5 | MO_FINGEROFFENSIVE 5 | MO_TRIPLEATTACK 5 | MO_DODGE 6'],
  ['s17', '몽크', '武僧・坦', 'AL_HEAL 10 | AL_DP 5 | AL_BLESSING 10 | AL_DEMONBANE 10 | AL_DP 10 | AL_ANGELUS 9 | MO_IRONHAND 5 | MO_CALLSPIRITS 5 | MO_DODGE 5 | MO_TRIPLEATTACK 5 | MO_CHAINCOMBO 3 | MO_COMBOFINISH 3 | MO_STEELBODY 5 | MO_ABSORBSPIRITS 1 | MO_EXPLOSIONSPIRITS 3 | MO_INVESTIGATE 3 | MO_FINGEROFFENSIVE 3 | MO_EXTREMITYFIST 3 | MO_BLADESTOP 2 | MO_SPIRITSRECOVERY 2 | MO_BODYRELOCATION 1'],
  // a blacksmith's (by request, the merchant's taken on: its first 49 points are the merchant's as they were, so it
  // keeps its id): one, its making skills not worked out yet: Adrenaline
  // Rush first (the Hammer Fall 2 it needs), Power Thrust, Hilt Binding and Weaponry Research, Weapon Perfection 3 and
  // Maximize Power, then Weapon Perfection 5, Skin Tempering and Hammer Fall 5; the last 8 in what is left (Ore
  // Discovery with the Iron and Steel Tempering it needs, Weapon Repair, Iron Tempering 5; no Advanced Adrenaline
  // Rush, a Soul Linker's spirit's to give: jobdb.py spirit_skills)
  ['s8', '제철공', '鐵匠・戰鬥鐵匠', 'MC_MAMMONITE 10 | MC_INCCARRY 5 | MC_PUSHCART 10 | MC_VENDING 3 | MC_INCCARRY 10 | MC_DISCOUNT 10 | MC_OVERCHARGE 5 | MC_IDENTIFY 1 | BS_HAMMERFALL 2 | BS_ADRENALINE 5 | BS_OVERTHRUST 5 | BS_HILTBINDING 1 | BS_WEAPONRESEARCH 10 | BS_WEAPONPERFECT 3 | BS_MAXIMIZE 5 | BS_WEAPONPERFECT 5 | BS_SKINTEMPER 5 | BS_HAMMERFALL 5 | BS_IRON 1 | BS_STEEL 1 | BS_FINDINGORE 1 | BS_REPAIRWEAPON 1 | BS_IRON 5'],
  // an alchemist's two (by request; their first 49 points the blacksmith's merchant ones), neither with the Chemical
  // Protections (by request) nor Pharmacy past what its skills need: fighting, Axe Mastery 10, Acid Terror (the
  // Learning Potion 5 and Pharmacy 5 it needs), Bio Cannibalize 3 (the Pharmacy 6 it needs; no homunculus, by request:
  // its points in the plants and spheres), Demonstration, Potion Pitcher, Sphere Mine 5, Learning Potion 10 (no Aid
  // Berserk Potion: only a Soul Linker's Alchemist Spirit gives it, jobdb.py spirit_skills); homunculus, Pharmacy 6,
  // Potion Pitcher, Bio Cannibalize, Sphere Mine, Acid Terror, Learning Potion 10 and Demonstration 3, then the
  // homunculus (Bioethics, which Rest needs, is a quest skill, free from job level 40, sim.js QUEST_JLV: so its first
  // point is the 40th, at job level 41), Resurrect Homunculus 5, Demonstration 5, its last point in Axe Mastery
  ['s26', '연금술사', '鍊金術師・戰鬥型', 'MC_MAMMONITE 10 | MC_INCCARRY 5 | MC_PUSHCART 10 | MC_VENDING 3 | MC_INCCARRY 10 | MC_DISCOUNT 10 | MC_OVERCHARGE 5 | MC_IDENTIFY 1 | AM_AXEMASTERY 10 | AM_LEARNINGPOTION 5 | AM_PHARMACY 5 | AM_ACIDTERROR 5 | AM_PHARMACY 6 | AM_CANNIBALIZE 3 | AM_DEMONSTRATION 5 | AM_POTIONPITCHER 5 | AM_SPHEREMINE 5 | AM_LEARNINGPOTION 10'],
  ['s27', '연금술사', '鍊金術師・生命體型', 'MC_MAMMONITE 10 | MC_INCCARRY 5 | MC_PUSHCART 10 | MC_VENDING 3 | MC_INCCARRY 10 | MC_DISCOUNT 10 | MC_OVERCHARGE 5 | MC_IDENTIFY 1 | AM_LEARNINGPOTION 5 | AM_PHARMACY 6 | AM_POTIONPITCHER 5 | AM_CANNIBALIZE 5 | AM_SPHEREMINE 5 | AM_ACIDTERROR 5 | AM_LEARNINGPOTION 10 | AM_DEMONSTRATION 3 | AM_REST 1 | AM_CALLHOMUN 1 | AM_RESURRECTHOMUN 5 | AM_DEMONSTRATION 5 | AM_AXEMASTERY 1'],
];
// every skill build: { id, label, job (the first or second job's), steps: [[skill, level], ...] }
export const SKILL_BUILDS = SKILL_TABLE.map(([id, job, label, text]) => ({ id, label, job,
  steps: text.split('|').map(t => { const [name, lv] = t.trim().split(/\s+/); return [name, +lv]; }) }));
const skillById = Object.fromEntries(SKILL_BUILDS.map(b => [b.id, b]));
// the skill builds job `job` can be on: a first job's own and its second jobs', a later job's its second job's
// and its first job's; one whose line has none of those its first
// job's, for the first job's skills it has (none: only 自訂)
export function skillBuildsFor(job) {
  const second = Object.keys(LATER).find(j => j === job || LATER[j].includes(job));
  const first = job in FIRST ? job : Object.keys(FIRST).find(f => FIRST[f].includes(second));
  const jobs = job in FIRST ? [job, ...FIRST[job]] : [second, first];
  const own = SKILL_BUILDS.filter(b => jobs.includes(b.job));
  return own.length || !first ? own : SKILL_BUILDS.filter(b => [first, ...FIRST[first]].includes(b.job));
}
// (by request) the 職業預設 a skill build goes with, when the line has more than one (sim.JOB_VARIANTS): a bow rogue's
// 弓, an acolyte on a monk's build 攻擊型 (a monk's own, as a monk: it has one); any other build its line's first ('job')
const SKILL_TACTIC = { s28: 'job:bow', s15: 'job:melee', s16: 'job:melee', s17: 'job:melee' };
export const tacticOfBuild = id => SKILL_TACTIC[id] || 'job';
// (by request, issue #3) the skill builds each stat build goes with: a recruit is on one of these pairs, each pair
// as likely as another of its second job; a stat build not here (鐵匠・鍛造鐵匠, b21, by request: kept, but no
// recruit is on it) is never a recruit's
const PAIRS = {
  b0: ['s9'], b1: ['s10'], b24: ['s11'],  // 騎士: 敏騎, 互擊騎, 槍騎
  b2: ['s23'], b3: ['s24'], b27: ['s25'],  // 十字軍: 聖十, 坦十, 矛十
  b4: ['s3', 's4'],  // 巫師: 火法, 冰法
  b5: ['s21'], b6: ['s21', 's22'],  // 賢者: 戰鬥賢者 施法; 輔助賢者 施法, 領域
  b7: ['s13'], b8: ['s5'],  // 獵人: 陷阱獵, 敏獵
  b9: ['s18'], b10: ['s19', 's20'],  // 詩人／舞孃: 攻擊型; 輔助型 輔助一, 輔助二
  b11: ['s6'], b13: ['s12'],  // 祭司: 輔助祭, 驅魔祭
  b14: ['s15'], b15: ['s16'], b26: ['s17'],  // 武僧: 連段, 阿修羅, 坦
  b16: ['s7'], b17: ['s7'], b25: ['s14'],  // 刺客: 爆刺, 音速刺 拳刃刺; 雙刀刺
  b18: ['s28'], b19: ['s29'],  // 流氓: 弓流氓, 敏流氓
  b20: ['s8'],  // 鐵匠: 戰鬥鐵匠
  b22: ['s26'], b23: ['s27'],  // 鍊金術師: 戰鬥型, 生命體型
};
// the [stat build, skill build] pairs a recruit of job `job` can be on (its builds' and skill builds' pairs)
export function recruitPairs(job) {
  const skills = new Set(skillBuildsFor(job).map(b => b.id));
  return buildsFor(job).flatMap(b => (PAIRS[b.id] || []).filter(s => skills.has(s)).map(s => [b.id, s]));
}
export const skillStepsOf = build => skillById[build] ? skillById[build].steps : null;
