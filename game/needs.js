// The assets the game needs (by request: what the asset scripts make for it, and what the page checks it has):
// the Novice, the first jobs and their second jobs (the Knight's and the Crusader's on the Peco too: look.js MOUNT)
// with their weapons and shields by type, every hairstyle and colour, the headgear, the monsters of every level
// chain (chains.json's) and of the training ground and what a card's polymorph may make, the towns' NPCs, the
// loot, the icons, the cards' illustrations, the effects, the hit sounds, the minimaps, the floors of the maps, the
// towns and the job change rooms, the towns' ground (for their folk: townfolk.js), and the music of the title, the
// training ground, the towns, the rooms and every chain map (a fight plays its map's: game.js startFight).
// Not here: the townsfolk's other jobs (townfolk.js), the maps planned after a chain runs out.
// No DOM: game.js uses it, and so does game/manifest.mjs in Node.
import { TITLE_BGM, FIRST_JOBS, NOVICE, TRAIN, TOWNS, JOB_ROOM } from './places.js';

// a: { db (jobs.json), index (index.json), chains (every chain's maps, as loaded), floors (floors.json), npcs
// (npcs.json), bgm (bgm.json), sim (initialised with db: spritesOf, classChangeMobs), MOUNT, HIT_SOUND (look.js),
// secondJobsOf (builds.js), effects (effects.js effectNeeds()), stage (stage.js stageNeeds()), states (states.json) }
// → { sprites: Map of sprite folder → with its dye/ colours, files: [asset path] (the floors' map/arena/*.glb among
// them; what a file names inside — a floor's textures, an STR's, a sprite's sounds — goes with it) }
export function gameNeeds({ db, index, chains, floors, npcs, bgm, sim, MOUNT, HIT_SOUND, secondJobsOf, effects, stage, states }) {
  const sprites = new Map(), files = new Set();
  const want = (p, dyes = false) => sprites.set(p, sprites.get(p) || dyes);
  const party = new Set([NOVICE, ...FIRST_JOBS, ...FIRST_JOBS.flatMap(secondJobsOf)]);
  for (const n of index.jobs) if (party.has(n.id)) for (const [sex, name] of Object.entries(n.bodies)) {
    for (const b of index.human[sex].bodies.filter(x => x.name === name || MOUNT[n.id] && x.name === `${MOUNT[n.id]}_${sex}`)) {
      want(b.path);
      for (const w of (index.weapons[b.weapon] || {})[sex] || []) if (!/^\d+$/.test(w.type)) { want(w.path); if (w.fx) want(w.fx); }
      for (const sh of (index.shields[b.shield] || {})[sex] || []) if (!/^\d/.test(sh.type)) want(sh.path);
    }
  }
  // (the headgear a recruit brings or a BOSS map gives, for either sex: jobs.json headgear)
  for (const g of Object.values(db.headgear || {})) for (const p of Object.values(g.path || {})) want(p);
  for (const d of Object.values(index.human)) for (const h of d.heads) want(h.path, h.dyes.length > 0);
  const maps = chains.flatMap(ch => ch.maps).flatMap(m => [m, m.hard]).filter(Boolean), mobs = new Set();
  for (const m of maps) for (const id of m.waves.flat()) sim.spritesOf(db.mobs.find(x => x.id === +String(id).split('@')[0]), mobs);
  for (const [id] of TRAIN.mobs) sim.spritesOf(db.mobs.find(x => x.id === id), mobs);
  for (const d of sim.classChangeMobs()) sim.spritesOf(d, mobs);
  for (const sp of mobs) want('png/monster/' + sp);
  for (const sp of new Set(Object.values(npcs).flat().map(n => n.sprite))) want('png/npc/' + sp);
  for (const it of Object.values(db.items || {})) if (it.sprite) want(it.sprite);
  ['skel_archer_arrow', 'ragged_zombie_bullet', 'stone_shooter_bullet', 'wootan_shooter_bullet'].forEach(m => want('png/monster/' + m));
  // (stage.js's: the damage numbers, the cart, the falcon, the orc's face, ...)
  ['숫자', 'newnumber_msg', 'miss', 'msg', '축복', 'particle6', '얼음땡', 'status-stun', 'sight', 'fireball', 'emotion', '손수레', '매', 'orcface', 'torch_01', '굴뚝연기'].forEach(e => want('png/effect/' + e));
  for (const sp of effects.sprites) want(sp);
  for (const f of effects.files) files.add(f);
  const add = f => f && files.add(f);
  add('png/ui/logo.png');  // (the title's)
  [...new Set([...Object.values(HIT_SOUND), 'sword', 'fist1', 'fist2', 'fist3', 'fist4'])].forEach(c => add(index.wav + '/_hit_' + c + '.wav'));
  [1, 2, 3, 4].forEach(i => add(index.wav + '/_enemy_hit_normal' + i + '.wav'));
  (stage?.sounds || []).forEach(w => add(index.wav + '/' + w));
  (stage?.files || []).forEach(add);  // (a chat room's icon over the leader: 招募)
  // (the floors: every chain map's, the training ground's, every town's and job change room's)
  maps.filter(m => m.floor != null).forEach(m => add('map/arena/' + m.map + '_' + m.floor + '.glb'));
  for (const t of [TRAIN.map, ...TOWNS]) (floors[t] || []).forEach((_, i) => add('map/arena/' + t + '_' + i + '.glb'));
  Object.values(JOB_ROOM).forEach(r => add('map/arena/' + r.map + '_' + (r.i || 0) + '.glb'));
  Object.values(db.skills).forEach(sk => add(sk.icon));
  Object.values(db.items || {}).forEach(it => add(it.icon));
  // (the status icons over the status window in the fight: game.js stateIcons; those the game's jobs and monsters
  // can give, the items' and the ailments: states.json, those not of a skill)
  const given = new Set([...Object.values(db.jobs).filter(j => j.tier <= 2).flatMap(j => [...Object.keys(j.skills), ...Object.keys(j.female?.skills || {})]),
    ...db.mobs.flatMap(m => m.skills.map(r => r.skill))]);
  Object.entries(states?.states || {}).forEach(([k, e]) => { if (!db.skills[k] || given.has(k)) add('png/state/' + e + '.png'); });
  // (the headgear's, weapons' and armours' icons: hatIcon, gearHtml; the cards' illustrations: cardHand)
  [db.headgear, db.gear, db.armors].forEach(o => Object.keys(o || {}).forEach(id => add('png/item/' + id + '.png')));
  Object.values(db.cards || {}).forEach(x => add(x.art));
  const rooms = Object.values(JOB_ROOM);
  [...maps.map(m => m.map), TRAIN.map, ...TOWNS, ...rooms.filter(r => r.at).map(r => r.at)].forEach(m => add('png/minimap/small/' + m + '.png'));
  // (the towns' and rooms' ground, for their folk: townfolk.js)
  [...TOWNS, ...rooms.map(r => r.map)].forEach(t => add('raw/' + t + '.gat'));
  [TITLE_BGM, TRAIN.bgm, ...[...TOWNS, ...rooms.map(r => r.map), ...maps.map(m => m.map)].map(t => bgm[t])].forEach(add);
  return { sprites, files: [...files] };
}
