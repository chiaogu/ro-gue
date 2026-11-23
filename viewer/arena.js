// 3D arena for the battle sandbox: the fight's field (sim.js, a grid.js Field) drawn as a checkerboard floor, or
// on a patch of a real map (loadFloor, showFloor), a wall of light at its edge where a unit stands there, with the characters and any
// monsters on it (walker.js figures of their movers), seen through an isometric (orthographic) camera that turns
// about the floor. sim.js moves the units and sandbox.js draws their sprites; this module owns the scene, clicks,
// screen positions, and a 2D overlay canvas for numbers and bars.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Figure } from './walker.js';
import { Mover } from './grid.js';
import { shaderFor, dispose } from './map.js';

const PX = 1 / 35;        // sprite pixel size in cells (as walker.js)
const ISO_POLAR = THREE.MathUtils.degToRad(90 - 40);  // from straight up (50°): looking down 40°
// at zoom 1 the floor turned square to the screen just fits: its SIZE cells fill the width, or (a wide screen)
// its depth seen at 40° (sin 40° of it) with FIT_TOP cells over it for the figures at the far edge fills the
// height. Turned 45° its corners go off the sides (by request).
const FIT_TOP = 3;

let renderer, controls, canvas, overlay, octx, floorMesh, edge = null, ui, ring, marked = null, aimRing, aimed = null, SIZE = 0;
export let scene = null, camera = null;  // for effects.js
const pcs = new Map();     // characters: mover → figure
const others = new Map();  // monsters: mover → figure
const props = new Map();   // things that are drawn but not clicked (a character's cart): mover → figure

// opts: { canvas, overlay, field (the fight's grid.js Field), onClick(mover | { x, y } | null) }
export function init(opts) {
  ui = opts;
  SIZE = opts.field.w;  // (square)
  canvas = opts.canvas;
  overlay = opts.overlay;
  octx = overlay.getContext('2d');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * scale);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1014);
  // orthographic, looking down 40° from 45° off the grid; a drag (either button) turns it about the party
  // at that fixed pitch, the wheel zooms (at zoom 1 the floor fits: see resize; the zoom follows the party: render)
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;  // a left click (no drag) walks / attacks
  controls.minPolarAngle = controls.maxPolarAngle = ISO_POLAR;
  controls.minZoom = 0.5; controls.maxZoom = 4;  // (minZoom: zoomLimit)
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
  const c = new THREE.Vector3(SIZE / 2, 0, -SIZE / 2), d = 100;  // from the south-east
  camera.position.set(c.x + d * Math.sin(ISO_POLAR) * Math.SQRT1_2, c.y + d * Math.cos(ISO_POLAR), c.z + d * Math.sin(ISO_POLAR) * Math.SQRT1_2);
  controls.target.copy(c);
  controls.update();

  floorMesh = cellGrid(false);
  scene.add(floorMesh);
  // the ring under the character being controlled (mark)
  ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.46, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffd75a, transparent: true, opacity: 0.75, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  ring.renderOrder = 10;
  ring.visible = false;
  scene.add(ring);
  // and one under the unit (or the cell) a gamepad is aiming at, in a colour of its own (markAim)
  aimRing = new THREE.Mesh(ring.geometry, ring.material.clone());
  aimRing.renderOrder = ABOVE_DIM;
  aimRing.visible = false;
  scene.add(aimRing);
  // the dark over the whole scene (setLit), drawn after all but what is to stay bright (ABOVE_DIM)
  dimQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { k: { value: 0 } }, transparent: true, depthTest: false, depthWrite: false,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform float k; void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, k); }' }));
  dimQuad.frustumCulled = false;
  dimQuad.renderOrder = ABOVE_DIM - 1;
  dimQuad.visible = false;
  scene.add(dimQuad);

  new ResizeObserver(resize).observe(canvas);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  // a click (press and release without dragging): a monster or a character, a floor cell, or nothing
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = e.button === 0 ? [e.clientX, e.clientY] : null; });
  canvas.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    down = null;
    ui.onClick(pick(e) || cellAt(e));
  });
}

// the field's cells that can be stood on, a quad each at its corners' heights (grid.js GAT, as the units stand),
// in two shades by turns: the floor itself, or (onMap) not drawn over a map's ground (by request); clicks find
// cells on it either way
function cellGrid(onMap) {
  const gat = ui.field.map.gat, pos = [], col = [], idx = [];
  const shade = [new THREE.Color(0x3a4150), new THREE.Color(0x2b303b)];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (!ui.field.open(x, y)) continue;  // off the floor: nothing
    const h = gat.heights.subarray((y * gat.w + x) * 4), n = pos.length / 3, c = shade[(x + y) % 2];
    pos.push(x, -h[0] * GAT_S, -y, x + 1, -h[1] * GAT_S, -y, x, -h[2] * GAT_S, -(y + 1), x + 1, -h[3] * GAT_S, -(y + 1));
    for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
    idx.push(n, n + 1, n + 3, n, n + 3, n + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m.visible = !onMap;  // (the raycaster still finds it)
  return m;
}
// the field's edge (by request, no line along it): a wall of light standing on it, seen only where a character or
// a monster is on a cell at the edge, glowing there (and fading off over the cells beside it), see-through, brightest
// at the ground and gone at WALL_H; it comes and goes over WALL_RATE (1/s)
const WALL_H = 1.6, WALL_COLOR = 0x9fd8ff, WALL_OPACITY = 0.55, WALL_RATE = 8;
let wallLit = null, wallAt = 0;  // each side's cells' glow (0 to 1), SIZE a side (as lightWall's want); the last frame's time
function edgeWall() {
  const gat = ui.field.map && ui.field.map.gat, pos = [], up = [], idx = [];
  // the ground's height at corner (x, y) of the field (flat: 0)
  const at = (x, y) => {
    if (!gat || !gat.heights) return 0;
    const cx = Math.min(x, SIZE - 1), cy = Math.min(y, SIZE - 1);
    return -gat.heights[(cy * gat.w + cx) * 4 + (x > cx ? 1 : 0) + (y > cy ? 2 : 0)] * GAT_S;
  };
  // each side from corner (x, y) along (dx, dy)
  for (const [x0, y0, dx, dy] of [[0, 0, 1, 0], [SIZE, 0, 0, 1], [SIZE, SIZE, -1, 0], [0, SIZE, 0, -1]]) {
    for (let i = 0; i < SIZE; i++) {
      const n = pos.length / 3, ax = x0 + dx * i, ay = y0 + dy * i, bx = ax + dx, by = ay + dy, ha = at(ax, ay), hb = at(bx, by);
      pos.push(ax, ha, -ay, bx, hb, -by, bx, hb + WALL_H, -by, ax, ha + WALL_H, -ay);
      up.push(0, 0, 1, 1);
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('up', new THREE.Float32BufferAttribute(up, 1));
  g.setAttribute('glow', new THREE.Float32BufferAttribute(new Float32Array(up.length), 1));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(WALL_COLOR) }, opacity: { value: WALL_OPACITY } },
    vertexShader: `attribute float up; attribute float glow; varying float vUp; varying float vGlow;
      void main() { vUp = up; vGlow = glow; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 color; uniform float opacity; varying float vUp; varying float vGlow;
      void main() { float a = vGlow * pow(1.0 - vUp, 1.6) * opacity; if (a < 0.003) discard; gl_FragColor = vec4(color, a); }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  m.renderOrder = 9;
  wallLit = new Float32Array(4 * SIZE);
  wallAt = performance.now();
  return m;
}
// the wall lit where units stand at the edge (each frame: render)
function lightWall(units) {
  if (!edge) return;
  const now = performance.now(), k = 1 - Math.exp(-WALL_RATE * Math.min(0.1, (now - wallAt) / 1000));
  wallAt = now;
  const want = new Uint8Array(4 * SIZE);
  for (const w of units) {
    if (!w.pos) continue;
    const x = Math.floor(w.pos[0]), y = Math.floor(w.pos[1]);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
    if (y === 0) want[x] = 1;                              // side 0: y = 0, along +x
    if (x === SIZE - 1) want[SIZE + y] = 1;                // side 1: x = SIZE, along +y
    if (y === SIZE - 1) want[2 * SIZE + SIZE - 1 - x] = 1; // side 2: y = SIZE, along -x
    if (x === 0) want[3 * SIZE + SIZE - 1 - y] = 1;        // side 3: x = 0, along -y
  }
  let any = false;
  for (let i = 0; i < want.length; i++) { wallLit[i] += (want[i] - wallLit[i]) * k; if (wallLit[i] < 0.002) wallLit[i] = 0; else any = true; }
  edge.visible = any;
  if (!any) return;
  // a quad's corners lit as the brighter of the two cells meeting there: full over the cell, fading over its neighbours
  const glow = edge.geometry.getAttribute('glow'), a = glow.array;
  for (let s = 0; s < 4; s++) for (let i = 0; i < SIZE; i++) {
    const c = s * SIZE + i, prev = i ? wallLit[c - 1] : 0, next = i < SIZE - 1 ? wallLit[c + 1] : 0;
    const l = Math.max(wallLit[c], prev), r = Math.max(wallLit[c], next);
    a.set([l, r, r, l], c * 4);
  }
  glow.needsUpdate = true;
}

// ---------- a map's floor ----------
// A map plan's floor (levels.js floorOf; sim.setFloor) is one of the patches scripts/map2gltf.py --arena cut out of
// its map, the assets' map/arena/<map>_<i>.glb (the field's south-west corner at the origin), drawn as the map tab draws
// maps (map.js shaderFor), what is around the field DIM darker (0: not; by request, not for now). Its heights (in
// its extras) go to sim.setFloor; its margin (the cells cut about the field) to zoomLimit.
const GAT_S = 0.2, DIM = 0;
let loader = null, shown = null;  // shown: the floor on the arena (loadFloor's), or null (flat)
const floors = new Map();         // its key → a promise of { key, root, heights, water } (or null)
// a promise of the floor's patch, loaded (null: none, or it cannot be): { key, root, heights, margin, water, mixer, effects }
export function loadFloor(floor) {
  if (!floor) return Promise.resolve(null);
  const key = floor.map + '_' + floor.i;
  if (!floors.has(key)) {
    loader ??= new GLTFLoader();
    floors.set(key, loader.loadAsync('../assets/map/arena/' + encodeURIComponent(key) + '.glb').then(gltf => {
      const ro = gltf.scene.userData.ro || {}, L = ro.light || {};
      const light = {
        lightDir: { value: new THREE.Vector3().fromArray(L.direction || [0, 1, 0]).normalize() },
        diffuse: { value: new THREE.Color().fromArray(L.diffuse || [1, 1, 1]) },
        ambient: { value: new THREE.Color().fromArray(L.ambient || [0.3, 0.3, 0.3]) },
        bounds: { value: new THREE.Vector4(0, 0, SIZE, SIZE) }, dimOutside: { value: DIM },
      };
      const cache = new Map(), water = [];
      gltf.scene.traverse(o => {
        if (!o.isMesh) return;
        const kind = o.userData.kind = (o.material.userData || {}).ro || 'model';
        o.material = shaderFor(o.material, kind, cache, light);
        if (kind === 'water') { o.renderOrder = 1; if (!water.includes(o.material)) water.push(o.material); }
      });
      // its models that move (the client's turning RSM nodes, by request: map2gltf.py Models.rig), each its own loop
      const mixer = gltf.animations.length ? new THREE.AnimationMixer(gltf.scene) : null;
      for (const clip of gltf.animations) mixer.clipAction(clip).play();
      return { key, root: gltf.scene, heights: Float32Array.from(ro.heights || []), margin: ro.margin || 0, water, mixer,
               effects: ro.effects || [] };
    }).catch(err => { console.warn('floor', key, err); floors.delete(key); return null; }));
  }
  return floors.get(key);
}
// the arena on floor (loadFloor's, or null: flat), the field's gat already set to it (sim.setFloor)
export function showFloor(floor) {
  if (shown !== floor && shown) {
    scene.remove(shown.root);
    dispose(shown.root);
    floors.delete(shown.key);
  }
  if (floor && shown !== floor) scene.add(floor.root);
  shown = floor;
  scene.remove(floorMesh);
  floorMesh.geometry.dispose();
  floorMesh.material.dispose();
  floorMesh = cellGrid(!!floor);
  scene.add(floorMesh);
  if (edge) { scene.remove(edge); edge.geometry.dispose(); edge.material.dispose(); edge = null; }
  scene.add(edge = edgeWall());
  zoomLimit();
}
// How far out the wheel zooms (by request): with the camera on a corner of the field, turned any way, REACH of the
// field (from that corner, a square REACH × SIZE on a side: by request, half) still in view (√2 × REACH × SIZE
// cells from the corner, across the screen and down it: the ground seen at 40°); on a map's floor, no farther than
// the screen's corners stay on what was cut of the map (its margin about the field: scripts/map2gltf.py MARGIN).
const REACH = 0.5;
function zoomLimit() {
  if (!camera) return;
  const across = (camera.right - camera.left) / 2, down = (camera.top - camera.bottom) / 2 / Math.cos(ISO_POLAR);
  let z = Math.min(across, down) / (Math.SQRT2 * REACH * SIZE);
  if (shown && shown.margin) z = Math.max(z, Math.hypot(across, down) / shown.margin);
  controls.minZoom = Math.min(z, controls.maxZoom);
  if (camera.zoom < controls.minZoom) { camera.zoom = controls.minZoom; camera.updateProjectionMatrix(); }
}
// the floor on the arena (loadFloor's), or null: its `effects` are the map's (RSW effect objects: stage.js plays them)
export const floorShown = () => shown;
// the floor's water, its frames and waves going as in the client (map.js), and its models that move (on the
// page's clock, as roBrowser's tick)
function animateWater() {
  if (!shown) return;
  if (shown.mixer) shown.mixer.setTime(performance.now() / 1000);
  const tick = performance.now() / (1000 / 60);
  for (const m of shown.water) {
    const x = m.userData.ro, frames = m.userData.frameTextures;
    if (frames && frames.length) {
      const f = frames[Math.floor(tick / Math.max(1, x.animSpeed)) % frames.length];
      if (f.image) m.uniforms.map.value = f;
    }
    m.uniforms.waveOffset.value = ((tick * x.waveSpeed) % 360) - 180;
  }
}

// the arena drawn at k times its resolution (the game's 解析度 setting: 0.5, 0.25 for a slow device), the overlay too
let scale = 1;
export function setResolution(k) {
  scale = k;
  if (!renderer) return;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * scale);
  resize();
}
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  const a = w / h, view = Math.max(SIZE * Math.cos(ISO_POLAR) + FIT_TOP, SIZE / a);
  Object.assign(camera, { left: -view * a / 2, right: view * a / 2, top: view / 2, bottom: -view / 2 });
  camera.updateProjectionMatrix();
  zoomLimit();
  overlay.width = canvas.width;
  overlay.height = canvas.height;
}

// ---------- units ----------
// a unit's mover gets a figure (draw: its walker.js callback); pc: a character (a monster wins a click over it);
// box: the canvas it draws on (walker.js Figure; the default if not given)
// pc: 'prop' for something that cannot be clicked
export function show(w, draw, pc, box = null) {
  (pc === 'prop' ? props : pc ? pcs : others).set(w, new Figure(scene, draw, w, box));
}
// the character being controlled gets a ring under its feet
export function mark(w) { marked = w; }
export function markAim(w, color = 0xff4a3c) { aimed = w; if (w) aimRing.material.color.set(color); }
// unit w's figure glowing in colour `color` (a CSS colour; what a gamepad aims at; null: none), the scene darkened by k
// (the opacity of black over it) but for that figure, the aim's ring and whatever else is drawn ABOVE_DIM (a ground
// skill's aim: sandbox.js). The glow is the sprite's own (walker.js setGlow), and the figure is drawn over the dark as
// a sprite is, so what stands in front of it still hides it.
export const ABOVE_DIM = 60;  // (renderOrder: the dark is drawn just before this)
let lit = null, glowing = null, dimQuad = null;
export function setLit(w, color = '#ff5a3c', k = 0) {
  lit = w || null;
  const f = lit && (others.get(lit) || pcs.get(lit));
  if (glowing && glowing !== f) { glowing.setGlow(null); glowing.sprite.renderOrder = 12; }
  if (f) { f.setGlow(color); f.sprite.renderOrder = ABOVE_DIM; }
  glowing = f || null;
  dimQuad.visible = k > 0.005;
  dimQuad.material.uniforms.k.value = k;
}
export function remove(w) {
  const f = pcs.get(w) || others.get(w) || props.get(w);
  pcs.delete(w);
  others.delete(w);
  props.delete(w);
  if (marked === w) marked = null;
  if (aimed === w) aimed = null;
  if (lit === w) { lit = null; glowing = null; }
  if (f) f.dispose();
}
// the marker on the floor cell a unit was told to walk to, until it gets there
export function showMarker(w, x, y) {
  const f = pcs.get(w) || others.get(w);
  if (f) f.showMarker(ui.field.map, x, y);
}

// The camera follows the party, the monsters attacking it and what the characters attack and aim skills at (by
// request): aimed at the middle of the box on screen about their feet, with FOLLOW_HEAD cells over the feet for
// the figures (half of it at the bottom, for the bars), zoomed so that all of it fits with FOLLOW_PAD cells about
// the characters, FOE_PAD more about the monsters and the targets (and a ground target's area), and
// FOLLOW_MARGIN of the screen left over on each side (no closer than followMax), gliding there at FOLLOW_RATE;
// zooming in, slower, at ZOOM_IN_RATE (by request). A zoom by hand (the wheel, a pinch) holds until the zoom
// that fits them changes by FOLLOW_REFIT of what it was then: they spread out or drew together.
// With following off (setFollow; by request, a toggle), it glides to the middle of the field instead, turns
// about it, and zooms only by hand.
const FOLLOW_PAD = 1.5, FOE_PAD = 0.5, FOLLOW_MARGIN = 0.1, FOLLOW_HEAD = 3, FOLLOW_REFIT = 0.2;
// how close it zooms on its own (by request): FOLLOW_LONG cells at least along the screen's longer side, so a squarish
// screen is not as close as a phone's; upright (a phone), FOLLOW_LONG_UP cells down it, no closer than FOLLOW_MAX
// (a phone: 2.3; a 16:9 screen about 1.66, a square one 1)
const FOLLOW_MAX = 2.3, FOLLOW_LONG = 18, FOLLOW_LONG_UP = 15;
const followMax = () => { const w = camera.right - camera.left, h = camera.top - camera.bottom; return Math.min(FOLLOW_MAX, h > w ? h / FOLLOW_LONG_UP : w / FOLLOW_LONG); };
const FOLLOW_RATE = 4, ZOOM_IN_RATE = 1;  // (per second)
let handZoom = null, setZoom = null, lastFrame = 0;  // handZoom: the zoom that fitted them when zoomed by hand
let following = true;
export function setFollow(on) { following = on; handZoom = null; }
// the part of the screen the followed box is fitted into and centred on: top and bottom, the shares of the screen's
// height covered there (the game's windows at its foot: the party shown in what is left above them)
const view = { top: 0, bottom: 0 };
export function setView(top = 0, bottom = 0) { view.top = top; view.bottom = bottom; }
// followed instead of the party: these movers (null: the party again); cellPx, a cell drawn that many CSS px
// across whatever room is left (a set size, not fitted to it)
let focus = null, focusPx = null;
export function setFocus(ws, { cellPx = null } = {}) { focus = ws; focusPx = cellPx; }
// The camera turned (gliding at FOLLOW_RATE) about what it looks at to azimuth az (OrbitControls': 0 looks north
// from the south, π/2 west from the east), then left to the hand again; alignedAzimuth: the nearest at 45° to the
// grid (its cells' corners straight up the screen, as the camera starts)
let wantAz = null;
export function turnTo(az, now = false) {
  wantAz = az;
  if (!now) return;
  turn(Infinity);  // (all the way at once: the screen black meanwhile)
  controls.update();
}
// turned by d (radians, as the drag turns it) about what it looks at, at once (a gamepad's right stick)
export function turnBy(d) {
  wantAz = null;
  camera.position.sub(controls.target).applyAxisAngle(UP, d).add(controls.target);
  camera.lookAt(controls.target);
}
// zoomed by k (times the zoom now; more than 1: in) at once, within the wheel's limits (a gamepad's right stick); held as
// a zoom by the wheel is (follow: handZoom)
export function zoomBy(k) {
  camera.zoom = THREE.MathUtils.clamp(camera.zoom * k, controls.minZoom, controls.maxZoom);
  camera.updateProjectionMatrix();
}
// the ground's directions as the camera looks, in cells: forward (up the screen) and right
export function groundAxes() {
  camera.getWorldDirection(vf); vf.y = 0; vf.normalize();
  return { fwd: [vf.x, -vf.z], right: [-vf.z, -vf.x] };
}
export function alignedAzimuth() { const q = Math.PI / 2; return Math.round((controls.getAzimuthalAngle() - q / 2) / q) * q + q / 2; }
// Of the four azimuths at 45° to the grid, the one from which the floor's models (its buildings, trees) stand in the
// way of the fewest looks from about these cells to the camera (by request: the town's, not hiding the party): rays
// from CLEAR_UPS over each cell's middle toward the camera; on a tie the nearest to alignedAzimuth's. With `azimuths`,
// of those instead, on a tie the first; `walls`: the ground's walls in the way too (a room's: game.js jobRoom).
const CLEAR_UPS = [0.3, 1.3, 2.3];  // (cells: a figure is about 2.7 tall)
const clearRay = new THREE.Raycaster(), clearP = new THREE.Vector3();
export const turnsAbout = () => { const now = alignedAzimuth(), q = Math.PI / 2; return [0, 1, -1, 2].map(k => now + k * q); };
export function clearAzimuth(cells, azimuths = null, walls = false) {
  const list = azimuths || turnsAbout();
  let best = list[0], fewest = Infinity;
  for (const az of list) {
    const hits = hiddenFrom(cells, az, walls);
    if (hits < fewest) { fewest = hits; best = az; }
  }
  return best;
}
// how many of the looks from about these cells to a camera at azimuth az the floor's models stand in the way of
// (clearAzimuth's count; 0 with no floor or models)
export function hiddenFrom(cells, az, walls = false) {
  if (!shown) return 0;
  const models = [];
  shown.root.updateMatrixWorld(true);
  shown.root.traverse(o => { if (o.isMesh && (o.userData.kind === 'model' || walls && o.userData.kind === 'ground')) models.push(o); });
  if (!models.length) return 0;
  const dir = new THREE.Vector3(Math.sin(ISO_POLAR) * Math.sin(az), Math.cos(ISO_POLAR), Math.sin(ISO_POLAR) * Math.cos(az));
  let hits = 0;
  for (const [x, y] of cells) for (const up of CLEAR_UPS) {
    Mover.world(ui.field.map, x + 0.5, y + 0.5, clearP).y += up;
    clearRay.set(clearP, dir);
    if (clearRay.intersectObjects(models, false).length) hits++;
  }
  return hits;
}
const UP = new THREE.Vector3(0, 1, 0);
function turn(dt) {
  if (wantAz == null) return;
  let d = wantAz - controls.getAzimuthalAngle();
  d = Math.atan2(Math.sin(d), Math.cos(d));
  if (Math.abs(d) < 1e-3 || dt === Infinity) wantAz = null;
  if (dt !== Infinity) d *= 1 - Math.exp(-FOLLOW_RATE * dt);
  camera.position.sub(controls.target).applyAxisAngle(UP, d).add(controls.target);
  camera.lookAt(controls.target);
}
const fc = new THREE.Vector3(), fp = new THREE.Vector3();
function follow(party, foes, aims) {
  const now = performance.now(), dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  turn(dt);
  if (!following) {
    fc.set(SIZE / 2, 0, -SIZE / 2);
    fp.subVectors(fc, controls.target).multiplyScalar(1 - Math.exp(-FOLLOW_RATE * dt));
    controls.target.add(fp);
    camera.position.add(fp);
    return;
  }
  const ws = (focus || party).filter(w => w && w.pos);
  if (focus) foes = aims = [];
  if (!ws.length) return;
  vr.set(1, 0, 0).applyQuaternion(camera.quaternion);
  vu.set(0, 1, 0).applyQuaternion(camera.quaternion);
  ws[0].worldPosition(fc);
  // the box (cells across and up the screen from the first character) about each, padded
  let l = Infinity, r = -Infinity, lo = Infinity, hi = -Infinity;
  const add = (w, pad) => {
    w.worldPosition(fp).sub(fc);
    const x = fp.dot(vr), u = fp.dot(vu);
    l = Math.min(l, x - pad); r = Math.max(r, x + pad);
    lo = Math.min(lo, u - FOLLOW_HEAD / 2 - pad); hi = Math.max(hi, u + FOLLOW_HEAD + pad);
  };
  for (const w of ws) add(w, FOLLOW_PAD);
  for (const w of foes) if (w && w.pos) add(w, FOLLOW_PAD + FOE_PAD);
  for (const a of aims) if (a.w && a.w.pos) add(a.w, FOLLOW_PAD + FOE_PAD + (a.area || 0));
  const fit = focus && focusPx ? focusPx * (camera.top - camera.bottom) / canvas.clientHeight : THREE.MathUtils.clamp((1 - 2 * FOLLOW_MARGIN) *
    Math.min((camera.right - camera.left) / (r - l), (camera.top - camera.bottom) * (1 - view.top - view.bottom) / (hi - lo)), controls.minZoom, Math.max(controls.minZoom, followMax()));
  if (setZoom != null && camera.zoom !== setZoom) handZoom = fit;  // OrbitControls zoomed it since the last frame
  if (handZoom != null && Math.abs(fit / handZoom - 1) > FOLLOW_REFIT) handZoom = null;
  const k = 1 - Math.exp(-FOLLOW_RATE * dt);
  fc.addScaledVector(vr, (l + r) / 2).addScaledVector(vu, (lo + hi) / 2 - (view.bottom - view.top) / 2 * (camera.top - camera.bottom) / camera.zoom);
  fp.subVectors(fc, controls.target).multiplyScalar(k);
  controls.target.add(fp);
  camera.position.add(fp);
  if (handZoom == null) {
    camera.zoom += (fit - camera.zoom) * (fit > camera.zoom ? 1 - Math.exp(-ZOOM_IN_RATE * dt) : k);
    camera.updateProjectionMatrix();
  }
}

// draw the scene (each unit where its mover is now); for the camera to follow: party, the characters' movers;
// foes, the monsters attacking them; aims, what they attack and their skills are aimed at ({ w: a mover or a floor spot, area:
// the cells about a ground spot it reaches })
export function render(party = [], foes = [], aims = []) {
  for (const f of pcs.values()) f.update(camera);
  for (const f of others.values()) f.update(camera);
  for (const f of props.values()) f.update(camera);
  lightWall([...pcs.keys(), ...others.keys()]);
  ring.visible = !!(marked && marked.pos);
  if (ring.visible) marked.worldPosition(ring.position).y += 0.03;
  aimRing.visible = !!(aimed && aimed.pos);
  if (aimRing.visible) aimed.worldPosition(aimRing.position).y += 0.03;
  follow(party, foes, aims);
  animateWater();
  controls.update();
  setZoom = camera.zoom;
  renderer.render(scene, camera);
  keepPrograms();
}
// Every shader program three.js has compiled is kept (by report: a phone ran hot), not let go as the last material
// using it is disposed: an effect's material goes as the effect ends, so each next one of its kind (a hit's sparks
// every few hits) compiled its program again, a stall of tens of ms on a phone. The kinds are few (renderer.info.programs).
const keptPrograms = new Set();
function keepPrograms() {
  for (const p of renderer.info.programs || []) if (!keptPrograms.has(p)) { keptPrograms.add(p); p.usedTimes++; }
}

// the overlay's 2D context, cleared, for drawing on top of the scene in its device pixels
export function overlayContext() {
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.imageSmoothingEnabled = false;
  return octx;
}

// where a walker's feet are on the overlay (device px) and how many device px one sprite pixel covers
const va = new THREE.Vector3(), vb = new THREE.Vector3(), up = new THREE.Vector3();
export function anchor(w) {
  return project(w.worldPosition(va));
}
// the same for a world point (a THREE.Vector3, left unchanged)
const vp = new THREE.Vector3();
export function project(p) {
  up.set(0, 1, 0).applyQuaternion(camera.quaternion);  // sprites are offset in view space, i.e. along camera up
  vb.copy(p).addScaledVector(up, 100 * PX).project(camera);
  vp.copy(p).project(camera);
  const W = overlay.width, H = overlay.height;
  const x = (vp.x + 1) / 2 * W, y = (1 - vp.y) / 2 * H;
  return { x, y, z: vp.z, s: Math.hypot((vb.x + 1) / 2 * W - x, (1 - vb.y) / 2 * H - y) / 100 };
}
// a world point in the plane facing the camera through a walker's feet: right / up on screen (cells)
const vu = new THREE.Vector3();
export function onScreen(w, right, upward, out = new THREE.Vector3()) {
  vr.set(1, 0, 0).applyQuaternion(camera.quaternion);
  vu.set(0, 1, 0).applyQuaternion(camera.quaternion);
  return w.worldPosition(out).addScaledVector(vr, right).addScaledVector(vu, upward);
}
// a world point beside a walker: right / away along the ground as the camera looks (cells), up (cells)
const vr = new THREE.Vector3(), vf = new THREE.Vector3();
export function around(w, right, away, upward, out = new THREE.Vector3()) {
  camera.getWorldDirection(vf); vf.y = 0; vf.normalize();
  vr.set(-vf.z, 0, vf.x);  // camera right, on the ground
  return w.worldPosition(out).addScaledVector(vr, right).addScaledVector(vf, away).setY(out.y + upward);
}

// the unit whose drawn sprite covers the clicked point (a few pixels of slack), nearest first; a monster
// wins over a character (one standing in front of the monster it fights does not take the click)
function pick(ev) {
  return pickFrom(others, ev) || pickFrom(pcs, ev);
}
function pickFrom(units, ev) {
  const r = canvas.getBoundingClientRect();
  const px = (ev.clientX - r.left) * overlay.width / r.width, py = (ev.clientY - r.top) * overlay.height / r.height;
  let best = null;
  for (const [w, f] of units) {
    if (!f.sprite.visible) continue;
    const a = anchor(w);
    const b = f.box, cx = Math.round((px - a.x) / a.s + b.w / 2), cy = Math.round((py - a.y) / a.s + b.feet);
    if (cx < -3 || cy < -3 || cx > b.w + 3 || cy > b.h + 3) continue;
    const d = f.ctx.getImageData(cx - 3, cy - 3, 7, 7).data;
    let hit = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) { hit = true; break; }
    if (hit && (!best || a.z < best.z)) best = { w, z: a.z };
  }
  return best && best.w;
}
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function cellAt(ev) {
  const r = canvas.getBoundingClientRect();
  return cellAtNdc((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
}
// the open cell of the floor under overlay point (x, y) (device px), or null
export const cellAtPx = (x, y) => cellAtNdc(x / overlay.width * 2 - 1, -y / overlay.height * 2 + 1);
function cellAtNdc(nx, ny) {
  ndc.set(nx, ny);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(floorMesh, false)[0];
  if (!hit) return null;
  const x = Math.floor(hit.point.x), y = Math.floor(-hit.point.z);
  return ui.field.open(x, y) ? { x, y } : null;
}
