// Sprites and sounds as the pages draw and play them (no page of its own): act.json and its images (png/, from
// spr2png.py), a frame drawn on a 2D canvas, a character's body, head and weapon together, the client's sounds
// (data/wav) on Web Audio, and a battle character's look (its sprites for its job, sex and weapon). The viewer
// (index.html) and the game (game/) both draw with these.
// init({ volume, fx, track, busy }) first: volume → the sounds' volume (0: none), fx → how a weapon's slash trail
// is drawn ('glow', 'solid' or 'off'), track(promise) counts a load in the page's loading bar, busy(±1) a sprite
// loading; then setIndex(index.json) once it is in.
let O = { volume: () => 1, fx: () => 'glow', track: p => p, busy: () => {}, headgear: () => null };
let INDEX = null, JOBS = {};
export function init(o) {
  O = { ...O, ...o };
  // (iOS lets a context start only within a tap or key: see audioCtx)
  ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown', 'change'].forEach(ev =>
    document.addEventListener(ev, () => { if (soundOn()) audioCtx(); }, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (audio) { audio.close().catch(() => {}); audio = null; } }
    else if (soundOn()) audioCtx();  // (where the browser allows it without a tap: else the next tap)
  });
}
// index.json (viewer/build_index.py): the bodies, heads, weapons and job tree a look is made of, and where the sounds are
export function setIndex(index) {
  INDEX = index;
  JOBS = Object.fromEntries(INDEX.jobs.map(n => [n.id, n]));
}

// ---------- sprites ----------
// an asset's URL (served under /assets/: viewer/serve.sh, the service workers; viewer/assets.js)
export const url = p => encodeURI('../assets/' + p).replace(/#/g, '%23');
// One that failed to load is asked for again RETRY_MS after, the next time it is drawn (by report: a summon showing
// only some of its frames, or only its shadow, for good — sw.js fails what is not saved yet at once for a while once
// one request is late, as when many sprites load together, and a failed image stayed failed)
const imgCache = new Map(), imgFailed = new Map(), RETRY_MS = 3000;
export function img(p) {
  let im = imgCache.get(p);
  if (im && imgFailed.has(p) && Date.now() - imgFailed.get(p) >= RETRY_MS) { imgFailed.delete(p); im = null; }
  if (!im) {
    const one = im = new Image();
    O.track(new Promise(ok => { one.addEventListener('load', ok, { once: true }); one.addEventListener('error', ok, { once: true }); }));
    one.addEventListener('error', () => { if (imgCache.get(p) === one) imgFailed.set(p, Date.now()); }, { once: true });
    one.src = url(p);
    imgCache.set(p, one);
  }
  return im;
}
// resolve once every image the sprite can show is downloaded and decoded, so playback never shows blank frames
function preload(spr) {
  const paths = new Set();
  for (const a of spr.act.actions) for (const f of a.frames) for (const l of f.layers) {
    const p = layerPath(spr, l); if (p) paths.add(p);
  }
  return Promise.all([...paths].map(p => img(p).decode().catch(() => {})));
}
// load act.json + all images, then hand the sprite to apply() unless a newer request superseded it
const seq = {};
export async function loadSprite(slot, path, dye, apply) {
  const my = seq[slot] = (seq[slot] || 0) + 1;
  O.busy(1);
  try {
    const spr = { path, act: await loadAct(path), dye };
    await preload(spr);
    if (seq[slot] === my) apply(spr);
  } finally { O.busy(-1); }
}
const actCache = new Map();
// (one that failed is not kept: asked for again next time, as img's)
export function loadAct(path) {
  if (!actCache.has(path)) actCache.set(path, fetch(url(path + '/act.json')).then(r => r.json()).catch(e => { actCache.delete(path); throw e; }));
  return actCache.get(path);
}
// sprite = {path, act, dye}; layer image path honours the chosen dye for palette layers
export function layerPath(spr, l) {
  if (!l.file) return null;
  if (spr.dye != null && !(l.type === 1)) return spr.path + '/dye/' + spr.dye + '/' + l.file.slice('frames/'.length);
  return spr.path + '/' + l.file;
}
const tintCache = new Map();
export function tinted(im, key, c) {
  let cv = tintCache.get(key);
  if (!cv) {
    cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
    const g = cv.getContext('2d');
    g.drawImage(im, 0, 0);
    g.globalCompositeOperation = 'multiply'; g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; g.fillRect(0, 0, cv.width, cv.height);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(im, 0, 0);
    tintCache.set(key, cv);
  }
  return cv;
}

// ---------- sound ----------
// ACT frames name a sound from act.sounds (files under data/wav/). 'atk' is not a file: it marks the
// frame where an attack hits, so it is shown in the info line instead of played.
let audio = null;
const soundCache = new Map();
// Back from the background a context may stay 'suspended' or 'interrupted' (iOS Safari), or say 'running' yet
// play nothing (iOS), whatever is done to it: so it is closed as the page goes away and made anew on the next
// tap or key (iOS lets it start only within a touchend / click, not a pointerdown). The decoded sounds play on
// the new one.
const newAudio = () => audio = new (window.AudioContext || window.webkitAudioContext)();
function audioCtx() {
  if (!audio || audio.state === 'closed') newAudio();
  if (audio.state !== 'running') audio.resume().catch(() => {});
  return audio;
}
const soundOn = () => O.volume() > 0;
// decoded sound, fetched once (a context made before any click starts suspended but can still decode); one
// that failed to decode (its context closed meanwhile) is tried again next time
// An IMA ADPCM wav (format 17: the client's glass.wav, horn.wav and a few more), which browsers do not decode, as a
// 16-bit PCM wav; null for any other
const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
  107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
function imaAdpcm(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  if (buf.byteLength < 12 || v.getUint32(0) !== 0x52494646 || v.getUint32(8) !== 0x57415645) return null;  // RIFF…WAVE
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= buf.byteLength; ) {
    const id = String.fromCharCode(...u8.subarray(o, o + 4)), n = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = o + 8; else if (id === 'data') data = [o + 8, Math.min(n, buf.byteLength - o - 8)];
    o += 8 + n + (n & 1);
  }
  if (!fmt || !data || v.getUint16(fmt, true) !== 17) return null;
  const ch = v.getUint16(fmt + 2, true), rate = v.getUint32(fmt + 4, true), align = v.getUint16(fmt + 12, true);
  const per = (align - 4 * ch) * 2 / ch + 1, blocks = Math.floor(data[1] / align), out = new Int16Array(blocks * per * ch);
  for (let b = 0; b < blocks; b++) {
    const at = data[0] + b * align, base = b * per * ch;
    for (let c = 0; c < ch; c++) {
      let pred = v.getInt16(at + 4 * c, true), idx = Math.min(88, u8[at + 4 * c + 2]);
      out[base + c] = pred;
      // (after the headers, 4 bytes of each channel in turn, 8 samples each, the low nibble first)
      for (let k = 0; k < per - 1; k++) {
        const byte = u8[at + 4 * ch + Math.floor(k / 8) * 4 * ch + 4 * c + ((k % 8) >> 1)], nib = k & 1 ? byte >> 4 : byte & 15;
        const step = IMA_STEP[idx];
        let d = step >> 3;
        if (nib & 4) d += step; if (nib & 2) d += step >> 1; if (nib & 1) d += step >> 2;
        pred = Math.max(-32768, Math.min(32767, nib & 8 ? pred - d : pred + d));
        idx = Math.max(0, Math.min(88, idx + IMA_INDEX[nib & 7]));
        out[base + (k + 1) * ch + c] = pred;
      }
    }
  }
  const w = new DataView(new ArrayBuffer(44 + out.byteLength));
  [[0, 0x52494646], [8, 0x57415645], [12, 0x666d7420], [36, 0x64617461]].forEach(([o, x]) => w.setUint32(o, x));
  w.setUint32(4, 36 + out.byteLength, true); w.setUint32(16, 16, true); w.setUint16(20, 1, true); w.setUint16(22, ch, true);
  w.setUint32(24, rate, true); w.setUint32(28, rate * ch * 2, true); w.setUint16(32, ch * 2, true); w.setUint16(34, 16, true);
  w.setUint32(40, out.byteLength, true);
  new Int16Array(w.buffer, 44).set(out);
  return w.buffer;
}
function soundBuffer(name) {
  if (!audio) newAudio();
  const p = INDEX.wav + '/' + name.replace(/\\/g, '/');
  if (!soundCache.has(p))
    soundCache.set(p, fetch(url(p)).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status))
      .then(b => audio.decodeAudioData(imaAdpcm(b) || b)).catch(e => { if (typeof e !== 'number') soundCache.delete(p); return null; }));
  return soundCache.get(p);
}
// load sounds ahead so their first play is not late
export function preloadSound(name) { if (INDEX && INDEX.wav) soundBuffer(name); }
// volume: this sound's share of the volume slider (1: all of it)
export function playSound(name, volume = 1) {
  if (!soundOn() || !INDEX.wav || !audio || audio.state !== 'running') return;
  soundBuffer(name).then(buf => {
    if (!buf) return;
    const src = audio.createBufferSource(), gain = audio.createGain();
    gain.gain.value = O.volume() * volume;
    src.buffer = buf; src.connect(gain).connect(audio.destination); src.start();
  });
}
// the one song playing (a bard's or a dancer's, stage.js songMusic): `name` in place of the one before, stopped at once;
// null stops it. Played once through, at this volume share as playSound's.
let song = null;  // { name, src } (src: null until its sound is decoded, or if it could not be)
export function playSong(name, volume = 1) {
  if (song && song.src) try { song.src.stop(); } catch (e) {}
  song = null;
  if (!name || !soundOn() || !INDEX.wav || !audio || audio.state !== 'running') return;
  const mine = song = { name, src: null };
  soundBuffer(name).then(buf => {
    if (!buf || song !== mine) return;
    const src = audio.createBufferSource(), gain = audio.createGain();
    gain.gain.value = O.volume() * volume;
    src.buffer = buf; src.connect(gain).connect(audio.destination); src.start();
    mine.src = src;
    src.onended = () => { if (song === mine) song = null; };
  });
}
// The hit sound is not in ACT data: the client plays it at the 'atk' frame by weapon class.
// Files are data/wav/_hit_<class>.wav; classes for instruments, whips, books and item-appearance
// weapons (numeric types) are guesses. Monsters use _enemy_hit_normal1-4 (also a guess from the name).
// A katar's is _hit_mace (roBrowser WeaponHitSoundTable; by report: not bare hands' thud).
// (a knuckle's: the client's _hit_mace.wav, as a recording of the game has it, by report; roBrowser's
// WeaponHitSoundTable gives it _hit_fist2.wav)
export const HIT_SOUND = {
  '카타르': 'mace', '너클': 'mace',
  '검': 'sword', '양손검': 'sword', '단검': 'dagger', '도끼': 'axe', '양손도끼': 'axe',
  '클럽': 'mace', '스패너': 'mace', '해머': 'mace', '책': 'mace', '창': 'spear', '양손창': 'spear',
  '롯드': 'rod', '양손지팡이': 'rod', '캔디케인롯드': 'rod', '활': 'arrow', '악기': 'arrow', '채찍': 'arrow',
  '권총': '권총', 'handgun2': '권총', '라이플': '라이플', '샷건': '샷건', '기관총': '개틀링한발', 'gun_gatling2': '개틀링한발',
  '그레네이드': '그레네이드런쳐',
};
const pick = list => list[Math.floor(Math.random() * list.length)];
export function playHit(kind, weaponType) {
  if (kind === 'monster') return playSound('_enemy_hit_normal' + pick(['1', '2', '3', '4']) + '.wav');
  const t = (weaponType || '').split('_')[0];
  const cls = !t ? 'fist' + pick(['1', '2', '3', '4']) : HIT_SOUND[t] || 'sword';
  playSound('_hit_' + cls + '.wav');
}
// fire a frame's sound once each time playback reaches that frame (key = slot → last action:tick seen)
const lastTick = {};
export function frameSound(slot, spr, frame, action, tick) {
  const key = action + ':' + tick;
  if (lastTick[slot] === key) return false;
  lastTick[slot] = key;
  const name = frame && frame.sound != null && spr.act.sounds[frame.sound];
  if (name && name !== 'atk') playSound(name);
  return name === 'atk';  // newly reached hit frame
}
// Player ACTs carry no 'atk' marker (monsters do: swing sound, then 'atk' on the next frame).
// For player attacks (action groups 5, 10, 11) assume the same pattern: hit on the frame after the
// body's swing sound, or at 60% of the action when it has no sound. This is a guess.
export function guessedHitFrame(act, group, action) {
  if (![5, 10, 11].includes(group)) return -1;
  const frames = act.actions[action].frames;
  const s = frames.findIndex(f => f.sound != null && f.sound >= 0);
  return s >= 0 ? Math.min(s + 1, frames.length - 1) : Math.floor(frames.length * 0.6);
}
// the sounds on frame fi of a character's layers (body swing, weapon swing, ...); key tells playbacks apart
export function humanSounds(prefix, action, fi, key, ch) {
  for (const [slot, spr] of Object.entries(ch))
    if (spr && slot !== 'fx') frameSound(prefix + slot, spr, frameOf(spr, action, fi), action, key);
}

// ---------- drawing ----------
export function frameOf(spr, action, fi) {
  const a = spr && spr.act.actions[action];
  if (!a || !a.frames.length) return null;
  return a.frames[fi % a.frames.length];
}
// blend: optional canvas composite mode for the whole sprite (used for weapon slash effects); g: target 2D context
export function drawFrame(spr, frame, ox, oy, blend, g) {
  if (!frame) return;
  for (const l of frame.layers) {
    const p = layerPath(spr, l); if (!p) continue;
    const im = img(p); if (!im.complete || !im.naturalWidth) { g.missing = true; continue; }  // (walker.js Figure: painted again)
    const [sx, sy] = l.scale || [1, 1], c = l.color || [255, 255, 255, 255];
    const src = (c[0] < 255 || c[1] < 255 || c[2] < 255) ? tinted(im, p + c.join(), c) : im;
    g.save();
    g.translate(ox + l.x, oy + l.y);
    if (l.angle) g.rotate(l.angle * Math.PI / 180);
    g.scale(l.mirror ? -sx : sx, sy);
    g.globalAlpha = c[3] / 255 * (blend ? blend.alpha : 1);
    if (blend) g.globalCompositeOperation = blend.op;
    // (centred as roBrowser's SpriteRenderer does: -w >> 1, an odd width's extra pixel on the left (mirrored: the right);
    // by report: -(w >> 1) put an odd-width head a pixel off an even-width body and the other way round)
    g.drawImage(src, -im.width >> 1, -im.height >> 1);
    g.restore();
  }
}
// body with the head attached at the body's anchor point, and the headgear (hats: sprites, in drawing order) the
// same way, each at its own anchor (roBrowser's EntityRender: the head, then the middle, top and lower headgear)
export function drawBodyHead(g, body, head, action, fi, hats = []) {
  const bf = frameOf(body, action, fi);
  drawFrame(body, bf, 0, 0, null, g);
  const b0 = bf && bf.anchors && bf.anchors[0];
  for (const spr of [head, ...hats]) {
    if (!spr) continue;
    const f = frameOf(spr, action, fi), a = f && f.anchors && f.anchors[0];
    drawFrame(spr, f, b0 && a ? b0.x - a.x : 0, b0 && a ? b0.y - a.y : 0, null, g);
  }
}
// a character's headgear sprites in drawing order (look.js loadLook: ch.hatMid, ch.hatTop, ch.hatLow)
const hatsOf = ch => [ch.hatMid, ch.hatTop, ch.hatLow];
// a character (ch: its sprites, { head, body, weapon, fx, shield }), feet at (0, 0) of g
export function drawHuman(g, action, fi, ch) {
  const dir = action % 8;
  // draw order (as in roBrowser): shield behind the body when facing away (directions 2-5),
  // then body, head, weapon, weapon slash effect, shield in front otherwise
  const shieldBehind = dir >= 2 && dir <= 5;
  if (ch.shield && shieldBehind) drawFrame(ch.shield, frameOf(ch.shield, action, fi), 0, 0, null, g);
  drawBodyHead(g, ch.body, ch.head, action, fi, hatsOf(ch));
  if (ch.weapon) drawFrame(ch.weapon, frameOf(ch.weapon, action, fi), 0, 0, null, g);
  // slash trail (_검광): ACT has no blend mode; 'glow' (screen at 90%) is a guess at the in-game look
  const fxMode = O.fx();
  if (ch.fx && fxMode !== 'off')
    drawFrame(ch.fx, frameOf(ch.fx, action, fi), 0, 0, fxMode === 'glow' ? { op: 'screen', alpha: 0.9 } : null, g);
  if (ch.shield && !shieldBehind) drawFrame(ch.shield, frameOf(ch.shield, action, fi), 0, 0, null, g);
}
// weapons are only drawn in some actions (battle stance and the attack that suits the weapon type)
export function weaponDrawn(group, ch) {
  const a = ch.weapon && ch.weapon.act.actions[group * 8];
  return !!(a && a.frames.some(f => f.layers.length));
}
// the attack action for the held weapon: the one its sprite is drawn in (attack 2 or 3);
// bare hands, and the few weapon sprites drawn in neither, use attack 1 — but the monk line's bare hands and
// knuckle punch (ch.punch: attack 3, its jabs then the lunge; roBrowser WeaponAction gives the knuckle attack 3,
// bare hands attack 1, its low lunge; both attack 3 by request)
export function attackGroup(ch) {
  return ch.punch ? 11 : [10, 11].find(g => weaponDrawn(g, ch)) || 5;
}
// the bodies whose bare hands and knuckle punch (attackGroup), and the punch's hit frame: the lunge's first, the fist
// out (by eye; the 60% guess, guessedHitFrame, falls on the last jab, the fist still in)
export const PUNCH_BODIES = new Set(['몽크', '슈라']);
export const PUNCH_HIT_FRAME = 5;

// ---------- a battle character's look ----------
export const eqOpts = (table, job, sex) => [['', '無']].concat(((table[job] || {})[sex] || []).map(i => [i.type, i.label]));
export function equipItem(table, job, type, sex) {
  return ((table[job] || {})[sex] || []).find(i => i.type === type);
}
export function loadEquip(slot, item, apply) {
  if (!item) { seq[slot] = (seq[slot] || 0) + 1; apply(null); return; }
  return loadSprite(slot, item, null, apply);
}
// A battle character's look is its job, sex, weapon, hairstyle and hair colour (the clothes in default colours).
// The weapon changes the look, the attack action and the hit sound; its ATK is not in the battle formulas yet.
// A look without a hairstyle (a new character), or with one its sex does not have, gets one at random, in a
// random colour. loadLook fills in the rest of a look — label, body (index entry), weapons (the job's), held (the
// weapon shown: the remembered one when the job can hold it) and ch (the sprites) — and calls onChange as each
// sprite comes in.
// look.mount: riding (the sandbox's Riding toggle), on its job's mounted body (MOUNT), which has weapons of its own
// (the crusader's on its Grand Peco: roBrowser's CRUSADER2, 신페코크루세이더)
export const MOUNT = { 기사: '페코페코_기사', 크루세이더: '신페코크루세이더' };
// the weapon sprite types held in both hands (rAthena's Both_Hand: two-handed swords, spears, axes and staves, bows, katars,
// Huuma shuriken and the guns but the revolver): nothing in the left hand then (the panel's 左手)
const BOTH_HANDS = new Set(['활', '카타르', '수리검', '라이플', '기관총', 'gun', '샷건', '그레네이드', '투핸드엑스']);
export const bothHands = v => !!v && (v.startsWith('양손') || BOTH_HANDS.has(v.split('_')[0]));
// look's body is not the one its mount asks for (sim.calc put the character on the Peco or took it off): load it again
export const mountStale = look => !!look.body && !!MOUNT[look.job] && !!look.mount !== look.body.name.startsWith(MOUNT[look.job]);
export function loadLook(look, onChange) {
  const node = JOBS[look.job] || JOBS['초보자'];
  if (!node.bodies[look.sex]) look.sex = Object.keys(node.bodies)[0];
  look.job = node.id;
  look.label = node.label;
  const d = INDEX.human[look.sex], slot = 'b' + look.id + '-';
  const body = look.body = (look.mount && MOUNT[node.id] && d.bodies.find(b => b.name === `${MOUNT[node.id]}_${look.sex}`)) ||
    d.bodies.find(b => b.name === node.bodies[look.sex]);
  // (the weapon types only: not the item-appearance weapons, whose types are item ids)
  look.weapons = eqOpts(INDEX.weapons, body.weapon, look.sex).filter(([v]) => !/^\d+$/.test(v));
  look.held = look.weapons.some(([v]) => v === look.weapon) ? look.weapon : '';
  // the shields its job has sprites for (types only, as the weapons), and the one shown: the one picked (look.shield)
  // with no weapon in both hands nor one in the left (as sim.heldShield has it)
  look.shields = eqOpts(INDEX.shields, body.shield, look.sex).filter(([v]) => !/^\d/.test(v));
  look.shieldShown = look.shield && look.shields.some(([v]) => v === look.shield) && !bothHands(look.held) && !look.held.includes('_') ? look.shield : '';
  let head = d.heads.find(h => h.id === look.hair);
  if (!head) {
    head = d.heads[Math.floor(Math.random() * d.heads.length)];
    const colours = [null, ...head.dyes];
    look.hair = head.id;
    look.hdye = colours[Math.floor(Math.random() * colours.length)];
  }
  const ch = look.ch = look.ch || { head: null, body: null, weapon: null, fx: null, shield: null };
  loadSprite(slot + 'body', body.path, null, spr => { ch.body = spr; onChange(); });
  loadSprite(slot + 'head', head.path, head.dyes.includes(look.hdye) ? String(look.hdye) : null, spr => { ch.head = spr; onChange(); });
  const w = equipItem(INDEX.weapons, body.weapon, look.held, look.sex);
  // (not one of its sprites: kept out of what goes through them, humanSounds)
  Object.defineProperty(ch, 'punch', { value: PUNCH_BODIES.has(body.weapon) && (!look.held || look.held === '너클'), writable: true, configurable: true });
  loadEquip(slot + 'weapon', w && w.path, spr => { ch.weapon = spr; onChange(); });
  loadEquip(slot + 'fx', w && w.fx, spr => { ch.fx = spr; });
  const sh = look.shieldShown && equipItem(INDEX.shields, body.shield, look.shieldShown, look.sex);
  loadEquip(slot + 'shield', sh && sh.path, spr => { ch.shield = spr; onChange(); });
  // the headgear (look.hats: { top, mid, low }, item ids; one over more than a slot under each of them, drawn once, as
  // roBrowser does: at the lower slot's turn, else the middle's), its sprite for the sex (O.headgear: the game's
  // jobs.json headgear)
  const hats = look.hats || {};
  for (const [k, key] of [['mid', 'hatMid'], ['top', 'hatTop'], ['low', 'hatLow']]) {
    const id = hats[k], once = id && !(k !== 'low' && id === hats.low) && !(k === 'top' && id === hats.mid);
    const g = once && O.headgear(id);
    loadEquip(slot + key, g && g.path && g.path[look.sex], spr => { ch[key] = spr; onChange(); });
  }
}
// the hairstyles of sex `sex` ({ id, path, dyes }), and a job's own hairstyle and colour for it, as in its figure in the
// job art (build_index.py JOB_HAIR: [head id, dye or null]), or null
export const heads = sex => INDEX.human[sex].heads;
export const jobHair = (job, sex) => ((JOBS[job] || {}).hair || {})[sex] || null;
// the weapon a character picks up on taking a job: its first job's usual one (the lineages without one in
// the list, and novices, keep the weapon they have)
const FIRST_JOB_WEAPON = { 검사: '검', 도둑: '단검', 성직자: '롯드', 마법사: '롯드', 상인: '도끼', 궁수: '활' };
export function defaultWeapon(job, sex) {
  for (let n = JOBS[job]; n; n = JOBS[n.parent]) {
    if (n.id === '바드/무희') return sex === '여' ? '채찍' : '악기';  // (a dancer's whip, a bard's instrument: their skills ask for them)
    if (n.id in FIRST_JOB_WEAPON) return FIRST_JOB_WEAPON[n.id];
  }
  return null;
}
// a character's head on a portrait canvas at 2×: the square below the sprite's topmost pixel, so short
// and tall bodies (and tall hair) all show hair and face
let portraitCv = null;
export function drawPortrait(cv, ch) {
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  if (!ch.body) return;
  if (!portraitCv) { portraitCv = document.createElement('canvas'); portraitCv.width = 80; portraitCv.height = 150; }
  const pg = portraitCv.getContext('2d', { willReadFrequently: true }), W = portraitCv.width, H = portraitCv.height;
  pg.setTransform(1, 0, 0, 1, 0, 0);
  pg.clearRect(0, 0, W, H);
  pg.setTransform(1, 0, 0, 1, W / 2, H - 10);
  pg.imageSmoothingEnabled = false;
  drawBodyHead(pg, ch.body, ch.head, 0, 0, hatsOf(ch));
  const px = pg.getImageData(0, 0, W, H).data;
  let top = 0;
  while (top < H && ![...Array(W).keys()].some(x => px[(top * W + x) * 4 + 3] > 0)) top++;
  const n = cv.width / 2;  // source px across
  g.imageSmoothingEnabled = false;
  g.drawImage(portraitCv, W / 2 - n / 2, Math.max(0, top - 2), n, n, 0, 0, cv.width, cv.height);
}
