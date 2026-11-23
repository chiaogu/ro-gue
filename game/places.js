// The game's places and starting points (game.js), apart so the list of the assets the game needs (needs.js) can be
// made in Node too (no DOM here).

// the login screen's music (the client's BGM 01, as roBrowser's LoginEngine plays it), on the title
export const TITLE_BGM = 'bgm/01.mp3';
export const FIRST_JOBS = ['검사', '마법사', '궁수', '성직자', '상인', '도둑'];
// A new game's start (by request): one Novice at level 1 on the training ground (TRAIN: the client's new_zone03, the
// field of its novice grounds, under new_1-x's music), nine of the plain Poring, Lunatic and Fabre there (by
// request: the last one takes it to TRAIN.top), a wave of each in that order (by request; in place of rAthena's new_1-3 Little Porings), their HP and ATK times TRAIN.k (by request: over sooner), that do not
// come for it, the Novice there unable to die (by request: sim.js undying, as renewal's base ATK, STR + level, is
// not scaled); each one down a level up to TRAIN.top, then the job menu, the Novice off to that job's town (HOME_TOWN:
// where it changes jobs in RO), where two recruits walk up and join, and on to the level chain
export const NOVICE = '초보자';
export const TRAIN = { map: 'new_zone03', label: '初心者訓練場', mobs: [[1002, 3], [1063, 3], [1007, 3]], k: 0.1, top: 10, bgm: 'bgm/30.mp3' };
export const HOME_TOWN = { 검사: 'izlude', 마법사: 'geffen', 궁수: 'payon', 성직자: 'prontera', 상인: 'alberta', 도둑: 'morocc' };
export const TOWN_ZH = { prontera: '普隆德拉', izlude: '伊斯魯德', geffen: '吉芬', morocc: '夢羅克', payon: '斐揚', alberta: '艾爾貝塔' };

export const TOWNS = ['prontera', 'izlude', 'geffen', 'morocc', 'payon', 'alberta'];  // 普隆德拉, 伊斯魯德, 吉芬, 夢羅克, 斐揚, 艾爾貝塔

// Each job's job change room (by request): the map its NPC stands in (scripts/map2gltf.py JOB_ROOMS: one patch,
// the NPC in its middle; rAthena npc/re/jobs/1-1/*.txt), in its town (HOME_TOWN); `door`, where one comes in by the
// warp nearest it (rAthena npc/re/warps, npc/warps: the warp's destination), and `out`, the warp out there (by
// request: it walks in from that way, from ROOM_IN cells off its place on the way from the door, and back out toward
// it). Geffen's way out of the guild is not among the warps: its door.
export const JOB_ROOM = {
  검사: { map: 'izlude_in', door: [74, 161], out: [74, 158] },    // from izlude (iz04)
  마법사: { map: 'geffen_in', door: [162, 97], out: [162, 97] },  // from geffen (gef05)
  궁수: { map: 'payon_in02', door: [64, 60], out: [64, 56] },     // from pay_arche (payonwarp051)
  성직자: { map: 'prt_church', door: [172, 19], out: [168, 19] }, // from the church's hall (prtch01)
  상인: { map: 'alberta_in', door: [74, 44], out: [78, 44] },     // from alberta (alb06)
  도둑: { map: 'moc_prydb1', door: [56, 115], out: [59, 115] },   // from the pyramid's hall (mocp12-1)
  // the second jobs' (by request: the leader walks there from the town to change, secondJobScene), the NPC that calls
  // Job_Change (rAthena npc/jobs/2-1, 2-2; npc/re/jobs/2-2 for the Crusader's); `i`, its patch's in floors.json
  // when the map has more than one (the church's: the Acolyte's first). Sage's and the Bard's have no warp near:
  // they walk in from across the hall (Juno's academy) or the street (Comodo). `at`, the map whose minimap the 轉職
// tab shows for it (the town or field it is in: the rooms have none), `zh` the place's name there; the priest's
// NPC to the upper right on the screen (`npc`, by request: its room like the acolyte's, seen another way)
  기사: { map: 'prt_in', door: [80, 110], out: [80, 113], at: 'prontera', zh: '普隆德拉 騎士團' },        // from prontera (prt11)
  크루세이더: { map: 'prt_cas', door: [247, 107], out: [247, 107],  // (out: the warp's own cell cannot be walked to)
    at: 'prontera', zh: '普隆德拉中央宮' }, // from the castle's crusaders' room (cruroom_in)
  위저드: { map: 'gef_tower', door: [116, 28], out: [116, 31], at: 'geffen', zh: '吉芬 中央塔' },   // from the tower below (geft03)
  세이지: { map: 'yuno_in02', door: [68, 61], out: [68, 61], at: 'yuno', zh: '朱諾 賢者城堡' },
  // (the hunter's NPC to the upper left, by report, issue 12: from the other side the room's east wall, its black
  // top, hid half the screen beside the NPC; `stand` a cell east, not behind the post at the counter's end)
  헌터: { map: 'hu_in01', door: [381, 368], out: [381, 363], npc: 'left', stand: [387, 369], at: 'hugel', zh: '毀葛 獵人公會' },     // from hugel (hugel41)
  바드: { map: 'comodo', door: [256, 123], out: [256, 123], at: 'comodo', zh: '克魔島' },
  // (the dancer's from the hall south of the stage, by report: unseen, as where Comodo's door NPC warps one in, (105,
  // 109), is walled off from it)
  무희: { map: 'job_duncer', door: [95, 70], out: [95, 70], at: 'comodo', zh: '克魔島小劇場' },
  프리스트: { map: 'prt_church', i: 1, door: [27, 19], out: [31, 19], npc: 'right', at: 'prontera', zh: '普隆德拉 大聖堂' }, // from the church's hall (prtch02-1)
  몽크: { map: 'monk_in', door: [98, 30], out: [98, 27], at: 'prt_fild03', zh: '聖卡畢利那修道院' },         // from the monastery's yard (monk01)
  제철공: { map: 'ein_in01', door: [14, 17], out: [14, 14], at: 'einbroch', zh: '艾音布羅克 鐵匠公會' },      // from einbroch (ein_jb01)
  연금술사: { map: 'alde_alche', door: [113, 178], out: [114, 183], at: 'aldebaran', zh: '艾爾帕蘭 鍊金術師公會' }, // from the floor above (alche#1F_2F)
  어세신: { map: 'in_moc_16', door: [18, 11], out: [18, 8], at: 'moc_fild16', zh: '蘇克拉特沙漠 刺客公會' },      // from the desert (16_to_guild)
  // (the rogue's `stand`, where one stands before the NPC, by report: the cells it faces 2 off are behind its
  // counter, y 118-119; across it)
  로그: { map: 'in_rogue', door: [380, 125], out: [375, 125], stand: [363, 117], at: 'cmd_fild07', zh: '燈塔島 流氓公會' },    // from the hall beyond (rogue01-02)
};
