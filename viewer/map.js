// Map tab: loads the assets' map/<name>.glb (scripts/map2gltf.py) and draws it with RO-style shading.
// Ground: texture × tile colour × (ambient + diffuse·N·L) × lightmap shadow + lightmap colour
// (roBrowser Renderer/Map/Ground.fs); models: texture × (ambient + diffuse·N·L); water: animated frames.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Walker } from './walker.js';
import { parseGat, walkable, findPath, nearestWalkable } from './grid.js';

const MAP_DIR = '../assets/map/';

const VERT = `
in vec3 position; in vec3 normal; in vec2 uv;
#ifdef GROUND
in vec2 uv1; in vec3 color;
out vec2 vUv1; out vec3 vColor;
#endif
uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix;
#ifdef WATER
uniform float waveHeight, wavePitch, waveOffset;
#endif
out vec2 vUv; out vec3 vNormal; out vec3 vWorld;
void main() {
  vUv = uv;
#ifdef UP
  vNormal = vec3(0.0, 1.0, 0.0);  // (a model without shading whose nodes turn: its normals stay up, as when baked)
#else
  vNormal = normalize(mat3(modelMatrix) * normal);
#endif
  vec3 p = position;
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
#ifdef GROUND
  vUv1 = uv1; vColor = color;
#endif
#ifdef WATER
  vec4 w = modelMatrix * vec4(p, 1.0);
  p.y += sin(radians(waveOffset + 0.5 * wavePitch * (w.x - w.z))) * waveHeight;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = `
precision highp float;
in vec2 vUv; in vec3 vNormal; in vec3 vWorld;
#ifdef GROUND
in vec2 vUv1; in vec3 vColor;
uniform sampler2D shadowMap, lightColorMap;
uniform bool useLightmap;
#endif
uniform sampler2D map;
uniform bool hasMap;
uniform vec3 lightDir, diffuse, ambient;
uniform float opacity, alphaTest;
// (the battle sandbox's arena: outside the field, x bounds.x…z and north bounds.y…w, darker by dimOutside)
uniform vec4 bounds;
uniform float dimOutside;
out vec4 fragColor;
void main() {
  vec4 c = hasMap ? texture(map, vUv) : vec4(1.0);
  if (c.a < alphaTest) discard;
  if (dimOutside > 0.0 && (vWorld.x < bounds.x || vWorld.x > bounds.z || -vWorld.z < bounds.y || -vWorld.z > bounds.w))
    c.rgb *= 1.0 - dimOutside;
#ifdef WATER
  fragColor = vec4(c.rgb, opacity);
#else
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float lw = max(dot(n, lightDir), 0.0);
  c.rgb *= clamp(lw * diffuse + ambient, 0.0, 1.0);
#ifdef GROUND
  c.rgb *= vColor;
  if (useLightmap) {
    c.rgb *= texture(shadowMap, vUv1).r;
    c.rgb += texture(lightColorMap, vUv1).rgb;
  }
#endif
  fragColor = vec4(c.rgb, c.a * opacity);
#endif
}`;

let renderer, scene, camera, controls, canvas, loader, ui;
// camera is persp or ortho (setOrtho). The orthographic view is orthoH cells tall at zoom 1; view changes
// that place the camera by distance (overview, close-up, focus) set orthoH to what the perspective camera
// would show at that distance, so both cameras frame the same.
let persp, ortho, orthoH = 100, aspect = 1;
const FOV = 30;
let active = false;
let walker = null, charOn = false, follow = true, neighboursOn = true;
// Several maps can be on screen: the centre map (the one under the middle of the screen) plus the
// neighbours (links.json, scripts/navi.py) on the side of it we are looking at. Every map sits
// at its absolute position from links.json (origin in world cells, x east / y north, height h) and
// is never moved, so maps stay put however the centre changes.
// entry: { name, pos, root, info, gat, ground, models, water, light, ready, dead }
const maps = new Map();
let centre = null;
let side = [1, 1];  // which half of the centre map the screen centre is on: x -1 west / 1 east, y -1 south / 1 north
let links = {}, positions = {};
let linksReady = null;
const absPos = name => { const p = positions[name]; return p ? { x: p[0], y: p[1], h: p[2] } : { x: 0, y: 0, h: 0 }; };
// edge links of a map that fit the layout (scripts/navi.py leaves a few non-geographic ones out)
const edgeLinks = name => (links[name] || []).filter(n => n.placed !== false);

export function init(opts) {
  ui = opts;
  canvas = opts.canvas;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1014);
  camera = persp = new THREE.PerspectiveCamera(FOV, 1, 0.5, 5000);
  ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 10000);
  controls = new OrbitControls(camera, canvas);
  controls.minZoom = 0.05; controls.maxZoom = 40;  // orthographic zoom (the wheel)
  controls.enableDamping = true;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = Math.PI * 0.49;  // until a view sets and fixes the pitch (lockPitch)
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  loader = new GLTFLoader();
  new ResizeObserver(resize).observe(canvas);
  canvas.addEventListener('pointermove', hover);
  canvas.addEventListener('pointerleave', () => ui.onHover(null));
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  // a click (press and release without dragging) on the ground walks the character there
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = e.button === 0 ? [e.clientX, e.clientY] : null; });
  canvas.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    down = null;
    const c = cellAt(e);
    if (c) clickCell(c);
  });
  walker = new Walker(scene, opts.drawCharacter);
  linksReady = fetch('links.json').then(r => r.ok ? r.json() : {})
    .then(j => { links = j.links || {}; positions = j.pos || {}; }).catch(() => {});
  requestAnimationFrame(frame);
}

export function setActive(on) { active = on; if (on) resize(); }

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  aspect = persp.aspect = w / h;
  persp.updateProjectionMatrix();
  orthoFrustum();
}
function orthoFrustum() {
  Object.assign(ortho, { left: -orthoH * aspect / 2, right: orthoH * aspect / 2, top: orthoH / 2, bottom: -orthoH / 2 });
  ortho.updateProjectionMatrix();
}
const viewHeight = d => 2 * d * Math.tan(THREE.MathUtils.degToRad(FOV / 2));  // cells the perspective camera shows at distance d
// the pitch stays as the last view (overview, top-down, ...) set it: dragging only turns the camera
function lockPitch() {
  const off = camera.position.clone().sub(controls.target);
  controls.minPolarAngle = controls.maxPolarAngle = Math.acos(Math.min(1, Math.max(-1, off.y / off.length())));
}
// after moving the camera by distance: make the orthographic view match it
function syncOrtho() {
  if (camera !== ortho) return;
  orthoH = viewHeight(camera.position.distanceTo(controls.target));
  ortho.zoom = 1;
  orthoFrustum();
}
// switch between the perspective and the orthographic camera, keeping the view
export function setOrtho(on) {
  if ((camera === ortho) === on) return;
  const from = camera, to = on ? ortho : persp;
  const dir = from.position.clone().sub(controls.target).normalize();
  if (on) {
    orthoH = viewHeight(from.position.distanceTo(controls.target));
    ortho.zoom = 1;
    ortho.position.copy(from.position);
    orthoFrustum();
  } else {  // the distance at which the perspective camera shows what the orthographic one did
    const d = orthoH / ortho.zoom / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    persp.position.copy(controls.target).addScaledVector(dir, d);
  }
  to.quaternion.copy(from.quaternion);
  camera = controls.object = to;
  lockPitch();
  controls.update();
}

const t0 = performance.now();
let last = t0, lastFocus = 0;
const followPos = new THREE.Vector3(), followPrev = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(now - last, 100);
  last = now;
  if (!active) return;
  if (charOn && walker.pos) {
    walker.update(dt, camera);
    if (follow) {
      // move camera and target together so the character stays put on screen
      walker.worldPosition(followPos);
      camera.position.add(followPrev.subVectors(followPos, controls.target));
      controls.target.copy(followPos);
    }
  }
  controls.update();
  if (now - lastFocus > 200) { lastFocus = now; updateFocus(); }
  const tick = (now - t0) / (1000 / 60);  // 60 fps ticks, as the client
  for (const e of maps.values()) for (const m of e.water) {
    const x = m.userData.ro;
    const frames = m.userData.frameTextures;
    if (frames && frames.length) {
      const f = frames[Math.floor(tick / Math.max(1, x.animSpeed)) % frames.length];
      if (f.image) m.uniforms.map.value = f;
    }
    m.uniforms.waveOffset.value = ((tick * x.waveSpeed) % 360) - 180;
  }
  renderer.render(scene, camera);
}

// ---------- loading ----------
// pick a map from the list: it becomes the centre at the world origin, everything else is dropped
export async function load(name) {
  for (const e of [...maps.values()]) unload(e);
  walker.hide();
  await linksReady;
  const e = entry(name);
  ui.onStatus('載入中…');
  await e.ready;
  if (e.dead) return;
  ui.onStatus(e.root ? '' : '讀取失敗');
  centre = e;
  overview();
  ui.onLoaded(e.info);
  setCentre(e, sideOf(e, controls.target) || side);
  if (charOn) spawnAtTarget();
}

function entry(name) {
  let e = maps.get(name);
  if (!e) {
    e = { name, pos: absPos(name), root: null, info: {}, gat: null, ground: [], models: [], water: [], dead: false };
    maps.set(name, e);
    e.ready = loadEntry(e);
  }
  return e;
}

async function loadEntry(e) {
  const gatUrl = '../assets/' + ui.dataDir + '/' + encodeURIComponent(e.name) + '.gat';
  const [gltf, gat] = await Promise.all([
    loader.loadAsync(MAP_DIR + encodeURIComponent(e.name) + '.glb').catch(err => { console.warn('glb', e.name, err); return null; }),
    fetch(gatUrl).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status)).then(parseGat)
      .catch(err => { console.warn('GAT', e.name, err); return null; }),
  ]);
  if (!gltf) return e;
  if (e.dead) { dispose(gltf.scene); return e; }
  e.info = gltf.scene.userData.ro || {};
  e.gat = gat;
  const L = e.info.light || {};
  e.light = {
    lightDir: { value: new THREE.Vector3().fromArray(L.direction || [0, 1, 0]).normalize() },
    diffuse: { value: new THREE.Color().fromArray(L.diffuse || [1, 1, 1]) },
    ambient: { value: new THREE.Color().fromArray(L.ambient || [0.3, 0.3, 0.3]) },
  };
  const matCache = new Map();
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    const kind = (o.material.userData || {}).ro || 'model';
    o.material = shaderFor(o.material, kind, matCache, e.light);
    if (kind === 'ground') { e.ground.push(o); o.userData.entry = e; }
    else if (kind === 'water') { o.renderOrder = 1; if (!e.water.includes(o.material)) e.water.push(o.material); }
    else e.models.push(o);
  });
  e.root = gltf.scene;
  place(e);
  scene.add(e.root);
  applyToggles(e);
  return e;
}

function place(e) { if (e.root) e.root.position.set(e.pos.x, e.pos.h, -e.pos.y); }

function unload(e) {
  e.dead = true;
  maps.delete(e.name);
  if (e.root) { scene.remove(e.root); dispose(e.root); e.root = null; }
}

// maps next to c on the side we look at: every east or west neighbour, every north or south one
// (a side can have two, e.g. moc_fild02's north: moc_fild01 and pay_fild04), and the diagonal maps
// reached through them
function layout(c, [sx, sy]) {
  const out = new Set([c.name]);
  if (!neighboursOn) return out;
  const on = (name, dx, dy) => edgeLinks(name).filter(n => n.dir[0] === dx && n.dir[1] === dy).map(n => n.map);
  const ex = on(c.name, sx, 0), ey = on(c.name, 0, sy);
  for (const m of [...ex, ...ey]) out.add(m);
  for (const m of ex) for (const d of on(m, 0, sy)) out.add(d);
  for (const m of ey) for (const d of on(m, sx, 0)) out.add(d);
  return out;
}

// make e the centre and s the side we look at: keep/move the maps still wanted, load the missing ones,
// drop the rest. The character's map (and the map it is walking into) always stays.
function setCentre(e, s) {
  const changed = centre !== e;
  centre = e;
  side = s;
  const want = layout(e, s);
  const keep = new Set([walker.map, walker.transit && walker.transit.map].filter(Boolean));
  for (const x of [...maps.values()]) if (!want.has(x.name) && !keep.has(x)) unload(x);
  for (const name of want) entry(name);
  if (changed) e.ready.then(() => { if (centre === e && !e.dead) ui.onLoaded(e.info); });
}

// which half of map e a world point is in (x -1/1, y -1/1), or null when it is outside the map;
// within 5% of the middle line the previous choice is kept so the neighbours don't flip back and forth
function sideOf(e, p) {
  const w = e.info.width, h = e.info.height;
  if (!w || !h) return null;
  const fx = (p.x - e.pos.x) / w, fy = (-p.z - e.pos.y) / h;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const keep = e === centre;
  const sx = keep && Math.abs(fx - 0.5) < 0.05 ? side[0] : fx < 0.5 ? -1 : 1;
  const sy = keep && Math.abs(fy - 0.5) < 0.05 ? side[1] : fy < 0.5 ? -1 : 1;
  return [sx, sy];
}

// ground point under the middle of the screen decides the centre map and the side to load
const screenMid = new THREE.Vector2(0, 0);
function updateFocus() {
  if (!centre) return;
  const grounds = [];
  for (const e of maps.values()) grounds.push(...e.ground);
  ray.setFromCamera(screenMid, camera);
  const hit = grounds.length && ray.intersectObjects(grounds, false)[0];
  const p = hit ? hit.point : controls.target;
  // prefer the current centre where maps overlap
  const order = [centre, ...[...maps.values()].filter(e => e !== centre)];
  for (const e of order) {
    if (!e.root) continue;
    const s = sideOf(e, p);
    if (!s) continue;
    if (e !== centre || s[0] !== side[0] || s[1] !== side[1]) setCentre(e, s);
    return;
  }
}

export function setNeighbours(on) { neighboursOn = on; if (centre) setCentre(centre, side); }

function tex(t, repeat) {
  if (!t) return null;
  t.colorSpace = THREE.NoColorSpace;  // the RO shading math is done on the stored values
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

// the RO-shaded material in place of a glTF one of kind ground, water or model; light: uniforms every material
// shares (lightDir, diffuse, ambient; the arena's bounds and dimOutside)
export function shaderFor(src, kind, cache, light) {
  if (cache.has(src)) return cache.get(src);
  const defines = {};
  if (kind === 'ground') defines.GROUND = '';
  if (kind === 'water') defines.WATER = '';
  if ((src.userData || {}).up) defines.UP = '';  // (map2gltf.py Models.rig: an unshaded model's turning nodes)
  const blend = src.transparent;
  const uniforms = Object.assign({}, light, {
    map: { value: tex(src.map, kind === 'water') }, hasMap: { value: !!src.map },
    opacity: { value: src.opacity ?? 1 },
    alphaTest: { value: src.alphaTest > 0 ? src.alphaTest : blend ? 0.01 : 0.0 },
  });
  if (kind === 'ground') {
    uniforms.shadowMap = { value: tex(src.aoMap) };
    uniforms.lightColorMap = { value: tex(src.emissiveMap) };
    uniforms.useLightmap = { value: true };
    if (src.aoMap) src.aoMap.minFilter = src.emissiveMap.minFilter = THREE.LinearFilter;
  }
  if (kind === 'water') Object.assign(uniforms, { waveHeight: { value: 0 }, wavePitch: { value: 0 }, waveOffset: { value: 0 } });
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, defines, uniforms,
    side: THREE.DoubleSide, transparent: blend, depthWrite: !blend,
  });
  m.name = src.name;
  m.userData = src.userData;
  if (kind === 'water') {
    const x = src.userData.ro === 'water' ? src.userData : {};
    m.userData = { ro: x };
    uniforms.waveHeight.value = x.waveHeight || 0;
    uniforms.wavePitch.value = x.wavePitch || 0;
    const tl = new THREE.TextureLoader();
    m.userData.frameTextures = (x.frames || []).map((p, i) => i === 0 && src.map ? src.map
      : tex(tl.load(MAP_DIR + p.split('/').map(encodeURIComponent).join('/')), true));
  }
  src.dispose();
  cache.set(src, m);
  return m;
}

export function dispose(root) {
  const seen = new Set();
  root.traverse(o => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    const m = o.material;
    if (seen.has(m)) return;
    seen.add(m);
    for (const u of Object.values(m.uniforms || {})) if (u.value && u.value.isTexture) u.value.dispose();
    for (const t of (m.userData && m.userData.frameTextures) || []) t.dispose();
    m.dispose();
  });
}

// ---------- view ----------
const toggles = { models: true, water: true, lightmap: true };
export function setToggle(k, on) { toggles[k] = on; for (const e of maps.values()) applyToggles(e); }
function applyToggles(e) {
  if (!e.root) return;
  for (const o of e.models) o.visible = toggles.models;
  e.root.traverse(o => { if (o.isMesh && o.material.defines && 'WATER' in o.material.defines) o.visible = toggles.water; });
  for (const o of e.ground) o.material.uniforms.useLightmap.value = toggles.lightmap;
}

// centre map's middle and size in world cells
function mapFrame() {
  const i = centre ? centre.info : {}, p = centre ? centre.pos : { x: 0, y: 0, h: 0 };
  const w = i.width || 100, h = i.height || 100;
  return { c: new THREE.Vector3(p.x + w / 2, p.h, -(p.y + h / 2)), w, h };
}
// whole map from the south, looking down 40° (as the battle sandbox)
export function overview() {
  const { c, w, h } = mapFrame();
  const d = Math.max(w, h) / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * 1.05;
  const pitch = THREE.MathUtils.degToRad(40);
  camera.position.set(c.x, c.y + d * Math.sin(pitch), c.z + d * Math.cos(pitch));
  controls.target.copy(c);
  syncOrtho();
  lockPitch();
  controls.update();
}
export function topDown() {
  const { c, w, h } = mapFrame();
  const d = Math.max(w, h * aspect) / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / aspect * 1.02;
  camera.position.set(c.x, c.y + d, c.z + 0.001);
  controls.target.copy(c);
  syncOrtho();
  lockPitch();
  controls.update();
}
// close-up like the in-game camera (about 30 cells wide)
export function closeUp() {
  const t = controls.target.clone();
  const dir = camera.position.clone().sub(t).normalize();
  camera.position.copy(t).addScaledVector(dir, 60);
  syncOrtho();
  lockPitch();
  controls.update();
}

// ---------- character ----------
function spawnAtTarget() {
  if (!centre || !centre.gat) return;
  const t = controls.target;
  if (!walker.spawn(centre, Math.floor(t.x - centre.pos.x), Math.floor(-t.z - centre.pos.y))) ui.onStatus('找不到可走的格子');
}
export function setCharacter(on) {
  charOn = on;
  if (!on) walker.hide();
  else if (centre) centre.ready.then(() => { if (charOn && !walker.pos) spawnAtTarget(); });
}
export function setFollow(on) { follow = on; }

// click on the ground: walk there; on a neighbouring map, walk to the best edge warp first,
// cross the gap between the maps, and continue from the warp's destination
function clickCell(c) {
  if (!charOn || !walker.pos || walker.transit) return;
  const cur = walker.map, fail = () => ui.onStatus(`${c.entry === cur ? '' : c.entry.name + ' '}(${c.x}, ${c.y}) 走不到`);
  if (c.entry === cur) {
    if (!walker.walkTo(c.x, c.y, warpIfOnEdge)) fail();
    return;
  }
  const link = edgeLinks(cur.name).find(n => n.map === c.entry.name);
  const dest = c.entry.gat;
  if (!link || !dest || !walkable(dest, c.x, c.y)) return fail();
  let best = null;
  for (const w of link.warps) {
    // some warps (NPC ones) stand on an unwalkable cell: step next to them instead
    const at = nearestWalkable(cur.gat, w[0], w[1], 3), land = nearestWalkable(dest, w[2], w[3], 5);
    const there = at && land && findPath(dest, land[0], land[1], c.x, c.y);
    const here = there && findPath(cur.gat, walker.cell[0], walker.cell[1], at[0], at[1]);
    if (here && (!best || here.length + there.length < best.cost)) best = { at, land, cost: here.length + there.length };
  }
  if (!best) return fail();
  walker.walkTo(best.at[0], best.at[1], () => crossTo(c.entry, best.land, () => walker.walkTo(c.x, c.y, warpIfOnEdge)), false);
  walker.showMarker(c.entry, c.x, c.y);
}

// stepping onto an edge warp of the current map (within 2 cells of it) takes you to the neighbour
function warpIfOnEdge() {
  const cur = walker.map;
  for (const n of edgeLinks(cur.name)) {
    const e = maps.get(n.map);
    if (!e || !e.gat) continue;
    for (const w of n.warps) {
      if (Math.max(Math.abs(walker.cell[0] - w[0]), Math.abs(walker.cell[1] - w[1])) > 2) continue;
      const land = nearestWalkable(e.gat, w[2], w[3], 5);
      if (land) return crossTo(e, land);
    }
  }
}

function crossTo(e, cell, then) {
  walker.cross(e, cell[0], cell[1], then);
}

// ---------- hover: GAT cell under the cursor ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function cellAt(ev) {
  const grounds = [];
  for (const e of maps.values()) grounds.push(...e.ground);
  if (!grounds.length) return null;
  const r = canvas.getBoundingClientRect();
  ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(grounds, false)[0];
  if (!hit) return null;
  const e = hit.object.userData.entry;
  return { entry: e, x: Math.floor(hit.point.x - e.pos.x), y: Math.floor(-hit.point.z - e.pos.y) };
}
let hoverPending = false;
function hover(ev) {
  if (hoverPending) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    const c = cellAt(ev);
    ui.onHover(c && { x: c.x, y: c.y, map: c.entry === centre ? null : c.entry.name,
                      walkable: c.entry.gat ? walkable(c.entry.gat, c.x, c.y) : undefined });
  });
}
// centre the view on GAT cell (x, y) of the centre map, keeping the viewing angle; dist = camera distance in cells
export function focus(x, y, dist = 60) {
  const p = centre ? centre.pos : { x: 0, y: 0 };
  const t = new THREE.Vector3(p.x + x + 0.5, controls.target.y, -(p.y + y + 0.5));
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(t);
  camera.position.copy(t).addScaledVector(dir, dist);
  syncOrtho();
  lockPitch();
  controls.update();
}
// character map, cell and remaining path length, or null
export function characterState() {
  return charOn && walker.pos ? { map: walker.map.name, x: walker.cell[0], y: walker.cell[1], steps: walker.path.length,
                                  moving: walker.moving || !!walker.transit } : null;
}
// maps currently placed: name → world origin
export function placedMaps() {
  return [...maps.values()].map(e => ({ name: e.name, pos: e.pos, loaded: !!e.root }));
}
// same as clicking cell (x, y) of a placed map
export function walkTo(name, x, y) {
  const e = maps.get(name);
  if (e) clickCell({ entry: e, x, y });
}
