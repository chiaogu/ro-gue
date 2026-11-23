// A mover (grid.js) drawn as a camera-facing sprite (Figure), and a character walking on the map tab
// (Walker: a mover with its figure, that can also cross over to a neighbouring map). The sprite image comes
// from the 人類 tab (drawCharacter paints body/head/equipment onto a 2D canvas).
import * as THREE from 'three';
import { Mover } from './grid.js';

const PX = 1 / 35;        // sprite pixel size in cells (roBrowser: sprite width × 5 / 175)
export const CANVAS = 256, FEET = 200;  // sprite canvas size and the feet row inside it
export const DEPTH_BIAS = 1.5;   // cells: the sprite's depth is taken this far in front of the feet (effects.js matches it)

// (OVER_FLOOR: a quad the floor does not cut but walls and models before it still do — a dying monster's, whose death
// throws things out over the floor, an Elder Willow's branches, and Lightning Bolt's STR: by request, they showed
// through walls with no depth test at all. Each pixel's depth is the nearer of the quad's own and that of the point
// on the ground plane under its feet the eye sees through the pixel, pulled FLOOR_EPS cells toward the camera: what
// is drawn over the floor in front of the feet lies on it, so a wall standing between it and the camera is nearer.)
const FLOOR_EPS = 0.5;
export const FLOOR_DEPTH_OUT = `
uniform mat4 viewMatrix;
out vec3 vView, vFeet, vUp;
void floorDepthVert(vec4 feet, vec3 view) {
  vView = view; vFeet = feet.xyz; vUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
}`;
export const FLOOR_DEPTH_IN = `
in vec3 vView, vFeet, vUp;
uniform mat4 projectionMatrix;
void floorDepth() {
  float d = gl_FragCoord.z, down = dot(vView, vUp);
  if (down < 0.0) {  // (looking down past the ground plane: the camera, at the origin, is above it)
    vec3 hit = vView * (dot(vFeet, vUp) / down);
    hit.z += ${FLOOR_EPS.toFixed(3)};  // view space looks down -z
    vec4 c = projectionMatrix * vec4(hit, 1.0);
    d = min(d, clamp(c.z / c.w * 0.5 + 0.5, 0.0, 1.0));
  }
  gl_FragDepth = d;
}`;
// Camera-facing quad whose every pixel gets the depth of the feet (pulled DEPTH_BIAS toward the camera).
// Things in front of the character (a house it walks behind, a cliff edge) still hide it, but the
// ground slope, walls or tree trunks behind it can no longer cut through the upright sprite.
const SPRITE_VERT = `
in vec3 position; in vec2 uv;
uniform mat4 modelViewMatrix, projectionMatrix;
uniform vec2 size, center;
uniform float bias;
out vec2 vUv;
#ifdef OVER_FLOOR
${FLOOR_DEPTH_OUT}
#endif
void main() {
  vUv = uv;
  vec4 feet = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * (feet + vec4((position.xy + 0.5 - center) * size, 0.0, 0.0));
#ifdef OVER_FLOOR
  floorDepthVert(feet, feet.xyz + vec3((position.xy + 0.5 - center) * size, 0.0));
#endif
  vec4 d = projectionMatrix * (feet + vec4(0.0, 0.0, bias, 0.0));  // view space looks down -z
  gl_Position.z = d.z / d.w * gl_Position.w;
}`;
// (glow: an outline GLOW_PX sprite px wide round the picture and a tint over it in that colour: what a gamepad aims at,
// drawn as the sprite is so that what stands in front of it still hides it. Only that sprite's shader has it (GLOW
// defined: setGlow); in every sprite's, its texture reads in a per-pixel branch ran for all their pixels on a phone's
// GPU, which ran hot)
const GLOW_PX = 2;
const SPRITE_FRAG = `
precision highp float;
in vec2 vUv;
uniform sampler2D map;
uniform float cut, alpha;
uniform vec3 glow;
uniform vec2 texel;
out vec4 fragColor;
#ifdef OVER_FLOOR
${FLOOR_DEPTH_IN}
#endif
void main() {
#ifdef OVER_FLOOR
  floorDepth();
#endif
  vec4 c = texture(map, vUv);
#ifdef GLOW
  if (c.a < cut) {
    float near = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      for (float r = 1.0; r <= ${GLOW_PX.toFixed(1)}; r += 1.0) near = max(near, texture(map, vUv + vec2(cos(a), sin(a)) * r * texel).a);
    }
    if (near < cut) discard;
    fragColor = vec4(glow, alpha);
    return;
  }
  fragColor = vec4(mix(c.rgb, glow, 0.25), c.a * alpha);
#else
  if (c.a < cut) discard;
  fragColor = vec4(c.rgb, c.a * alpha);
#endif
}`;
// a camera-facing quad showing `texture` (a canvas `size` px wide and `height` px tall, square unless given;
// 1 px = one sprite px) with the feet at row `feet` (the middle column), placed at its position and given the
// feet's depth as a sprite is; pixels under `cut` alpha are left out
export function spriteQuad(texture, size, feet, cut = 0.3, height = size) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: SPRITE_VERT, fragmentShader: SPRITE_FRAG, transparent: true,
    uniforms: {
      map: { value: texture }, bias: { value: DEPTH_BIAS }, cut: { value: cut }, alpha: { value: 1 },
      glow: { value: new THREE.Color() }, texel: { value: new THREE.Vector2(1 / size, 1 / height) },
      size: { value: new THREE.Vector2(size * PX, height * PX) }, center: { value: new THREE.Vector2(0.5, 1 - feet / height) },
    },
  }));
  mesh.frustumCulled = false;  // the quad is placed in the shader
  return mesh;
}


// ---------- still sprites, all in one draw ----------
// Many pictures that never change (loot on the ground), each painted once into a cell of one atlas (`cell` sprite
// px square, `cols` across, as many rows as it needs) and all drawn as one instanced mesh: each instance a
// camera-facing quad at its world position, given the depth of that point as a sprite is (SPRITE_VERT), showing the
// atlas cell `slot`. A Figure each instead painted its canvas again and sent it to the GPU every frame, one draw
// call apiece: tens of loot made a phone lag (by report). Each frame: begin(), add() each, end().
const BATCH_VERT = `
in vec3 position; in vec2 uv; in vec3 offset; in float slot;
uniform mat4 modelViewMatrix, projectionMatrix;
uniform float size, bias;
uniform vec2 grid;
out vec2 vUv;
void main() {
  float col = mod(slot, grid.x), row = floor(slot / grid.x);
  vUv = vec2((col + uv.x) / grid.x, (grid.y - 1.0 - row + uv.y) / grid.y);  // (the canvas's first row at the top)
  vec4 feet = modelViewMatrix * vec4(offset, 1.0);
  gl_Position = projectionMatrix * (feet + vec4(position.xy * size, 0.0, 0.0));
  vec4 d = projectionMatrix * (feet + vec4(0.0, 0.0, bias, 0.0));
  gl_Position.z = d.z / d.w * gl_Position.w;
}`;
const BATCH_FRAG = `
precision highp float;
in vec2 vUv;
uniform sampler2D map;
uniform float cut;
out vec4 fragColor;
void main() {
  vec4 c = texture(map, vUv);
  if (c.a < cut) discard;
  fragColor = c;
}`;
export class SpriteBatch {
  constructor(scene, cell = 128, cols = 8) {
    this.scene = scene;
    this.cell = cell;
    this.cols = cols;
    this.rows = 0;
    this.slots = new Map();  // key → its cell
    this.canvas = null;
    this.texture = null;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: BATCH_VERT, fragmentShader: BATCH_FRAG, transparent: true,
      uniforms: { map: { value: null }, size: { value: cell * PX }, bias: { value: DEPTH_BIAS }, cut: { value: 0.3 },
                  grid: { value: new THREE.Vector2(cols, 1) } },
    });
    this.grow(4);
    this.cap = 0;
    this.n = 0;
    this.mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.material);
    this.mesh.frustumCulled = false;  // (placed in the shader)
    this.mesh.renderOrder = 12;  // (as a figure)
    this.mesh.visible = false;
    this.reserve(64);
    scene.add(this.mesh);
    this.v = new THREE.Vector3();  // (scratch, for the caller's positions)
  }

  // the atlas `rows` cells tall, what is painted on it kept
  grow(rows) {
    const cv = document.createElement('canvas');
    cv.width = this.cell * this.cols;
    cv.height = this.cell * rows;
    if (this.canvas) cv.getContext('2d').drawImage(this.canvas, 0, 0);
    this.canvas = cv;
    this.rows = rows;
    if (this.texture) this.texture.dispose();
    this.texture = new THREE.CanvasTexture(cv);
    this.texture.colorSpace = THREE.NoColorSpace;  // (as a figure's)
    this.material.uniforms.map.value = this.texture;
    this.material.uniforms.grid.value.set(this.cols, rows);
  }

  // room for `cap` instances, those added this frame kept
  reserve(cap) {
    if (cap <= this.cap) return;
    const quad = new THREE.PlaneGeometry(1, 1), g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    g.setAttribute('uv', quad.attributes.uv);
    const offset = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const slot = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    if (this.cap) { offset.array.set(this.offset.array.subarray(0, this.n * 3)); slot.array.set(this.slotAttr.array.subarray(0, this.n)); }
    g.setAttribute('offset', this.offset = offset);
    g.setAttribute('slot', this.slotAttr = slot);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.cap = cap;
  }

  // the cell holding picture `key`, painted by paint(ctx2d) (with (0, 0) the point it stands on, the cell's middle)
  // the first time it is asked for
  slot(key, paint) {
    let i = this.slots.get(key);
    if (i != null) return i;
    i = this.slots.size;
    if (i >= this.cols * this.rows) this.grow(this.rows * 2);
    const g = this.canvas.getContext('2d'), c = this.cell, x = (i % this.cols) * c, y = Math.floor(i / this.cols) * c;
    g.save();
    g.beginPath(); g.rect(x, y, c, c); g.clip();  // (nothing spilt into the next cell)
    g.translate(x + c / 2, y + c / 2);
    g.imageSmoothingEnabled = false;
    paint(g);
    g.restore();
    this.texture.needsUpdate = true;
    this.slots.set(key, i);
    return i;
  }

  begin() { this.n = 0; }
  // one instance this frame: cell `slot` standing at world point p
  add(p, slot) {
    if (this.n >= this.cap) this.reserve(this.cap * 2);
    this.offset.array.set([p.x, p.y, p.z], this.n * 3);
    this.slotAttr.array[this.n++] = slot;
  }
  end() {
    this.mesh.geometry.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (!this.n) return;
    this.offset.needsUpdate = this.slotAttr.needsUpdate = true;
    this.offset.updateRanges.length = this.slotAttr.updateRanges.length = 0;
    this.offset.addUpdateRange(0, this.n * 3);
    this.slotAttr.addUpdateRange(0, this.n);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

// ---------- a figure ----------
// the sprite of a mover (or anything with pos, heading, moving, clock and worldPosition), its shadow, and the
// marker on the cell it was told to walk to. The mover's `alpha` (if set) fades the sprite and shadow: 0 hides
// them (and the sprite can no longer be clicked); its `lift` (cells) raises the sprite off its shadow. `flat`: it has no
// shadow. `trail`: after-images of it, whatever it is doing — walking, attacking, casting (by request; roBrowser's
// EF_MAKEBLUR, renderSecondBody, only as it walks): a copy of the sprite as it was every TRAIL_MS, TRAIL_N at most, each at 0.4 alpha fading out over TRAIL_LIFE ms, behind it).
const TRAIL_MS = 80, TRAIL_N = 5, TRAIL_LIFE = 400, TRAIL_ALPHA = 0.4;
// a figure's draw that paints only when what it paints changes (Figure update: same(key), by report: a phone ran hot):
// key, the frame and every sprite and tint it is painted with; sprites told apart by an id of their own (spriteId; a
// character's, lookKey: look.js's ch)
export const keyed = f => { f.keyed = true; return f; };
const sprIds = new WeakMap();
let sprN = 0;
export const spriteId = s => { if (!s) return 0; let i = sprIds.get(s); if (i == null) sprIds.set(s, i = ++sprN); return i; };
export const lookKey = ch => [ch.body, ch.head, ch.weapon, ch.fx, ch.shield, ch.hatMid, ch.hatTop, ch.hatLow].map(spriteId).join(',');
export class Figure {
  // drawCharacter(ctx2d, actionGroup, dir, clockMs) paints the character with its feet at (0, 0); box: the
  // canvas it paints on, { w, h, feet (the feet's row) } in sprite px (CANVAS square, feet at FEET if not
  // given), wide enough for all it draws (a monster's death throws pieces far out)
  constructor(scene, drawCharacter, mover, box = null) {
    this.draw = drawCharacter;
    this.mover = mover;
    this.box = box || { w: CANVAS, h: CANVAS, feet: FEET };
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.box.w;
    this.canvas.height = this.box.h;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;  // written out unconverted, like the map shaders
    this.sprite = spriteQuad(this.texture, this.box.w, this.box.feet, 0.3, this.box.h);
    this.sprite.renderOrder = 12;
    const shadow = document.createElement('canvas');
    shadow.width = shadow.height = 64;
    const sg = shadow.getContext('2d'), grad = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,.45)'); grad.addColorStop(0.7, 'rgba(0,0,0,.3)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = grad; sg.fillRect(0, 0, 64, 64);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadow), transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    this.shadow.renderOrder = 11;
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.45, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x6aa9ff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    this.group = new THREE.Group();
    this.group.add(this.sprite, this.shadow, this.marker);
    this.group.visible = false;
    scene.add(this.group);
    this.scene = scene;
    this.ghosts = null;  // the after-images (made with the first: see trail)
    this.glowing = null;  // the colour it glows in (setGlow), or null
  }

  // the after-images' copies (a ring of TRAIL_N): each its own canvas, texture and quad, left in the scene
  trail(p) {
    const now = performance.now();
    if (!this.ghosts) {
      if (!this.mover.trail) return;
      this.ghosts = Array.from({ length: TRAIL_N }, () => {
        const canvas = document.createElement('canvas');
        canvas.width = this.box.w; canvas.height = this.box.h;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.NoColorSpace;
        const sprite = spriteQuad(texture, this.box.w, this.box.feet, 0.3, this.box.h);
        sprite.renderOrder = 11.5;  // (behind the figure)
        sprite.material.depthWrite = false;
        sprite.visible = false;
        this.scene.add(sprite);
        return { canvas, texture, sprite, at: -Infinity };
      });
      this.ghostAt = -Infinity;
      this.ghostI = 0;
    }
    if (this.mover.trail && this.sprite.visible && now - this.ghostAt >= TRAIL_MS) {
      const gh = this.ghosts[this.ghostI = (this.ghostI + 1) % TRAIL_N], g = gh.canvas.getContext('2d');
      g.clearRect(0, 0, this.box.w, this.box.h);
      g.drawImage(this.canvas, 0, 0);
      gh.texture.needsUpdate = true;
      gh.sprite.position.copy(p);
      gh.at = this.ghostAt = now;
    }
    for (const gh of this.ghosts) {
      const k = (now - gh.at) / TRAIL_LIFE;
      gh.sprite.visible = k < 1 && !!this.mover.pos;
      if (gh.sprite.visible) gh.sprite.material.uniforms.alpha.value = TRAIL_ALPHA * (1 - k);
    }
  }

  // the figure glowing in colour `color` (a CSS colour or a number; null: not)
  setGlow(color) {
    if (color === this.glowing) return;
    const on = color != null;
    if (on !== (this.glowing != null)) this.setDefines(on, this.overFloor);
    const m = this.sprite.material;
    if (on) m.uniforms.glow.value.set(color);
    this.glowing = color;
  }
  // the sprite's shader variant: GLOW (setGlow), OVER_FLOOR (update: a dying monster's)
  setDefines(glow, overFloor) {
    const m = this.sprite.material;
    m.defines = { ...glow ? { GLOW: '' } : {}, ...overFloor ? { OVER_FLOOR: '' } : {} };
    m.needsUpdate = true;
  }

  // the marker on cell (x, y) of a map, until the mover gets there
  showMarker(map, x, y) {
    this.marker.visible = true;
    Mover.world(map, x + 0.5, y + 0.5, this.marker.position).y += 0.03;
  }

  // the canvas cleared, (0, 0) at the feet
  blank() {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.box.w, this.box.h);
    g.translate(this.box.w / 2, this.box.feet);
    g.imageSmoothingEnabled = false;
  }
  // (see update) true: the canvas holds what `key` paints; false: it is cleared for it
  same = key => {
    if (key === this.key) return true;
    this.key = key;
    this.blank();
    this.painted = true;
    return false;
  };

  // draw the mover as it is now, facing the way it heads as seen from the camera
  update(camera) {
    const m = this.mover;
    this.group.visible = !!m.pos;
    if (!m.pos) { for (const gh of this.ghosts || []) gh.sprite.visible = false; return; }
    const walking = m.moving || !!m.transit;
    if (!walking && !m.path.length) this.marker.visible = false;  // arrived (or stopped)

    // RO sprite direction is relative to the camera: 0 = toward the viewer, counting through left (2), away (4), right (6)
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const fx = fwd.x, fz = fwd.z, fl = Math.hypot(fx, fz) || 1;
    const mx = m.heading[0], mz = -m.heading[1];  // heading in world x/z
    const away = (mx * fx + mz * fz) / fl, right = (mx * -fz + mz * fx) / fl;
    // (spin: steps it is shown turned on top of its heading, set by the stage alone: Sonic Blow's hits)
    const dir = ((Math.round(Math.atan2(-right, -away) / (Math.PI / 4)) + (m.spin || 0)) % 8 + 8) % 8;

    // a keyed draw (draw.keyed: stage.js's characters and monsters) calls same(key) before it paints, key all that
    // what it paints depends on: true, the canvas holds that already, so it paints nothing and the texture is not
    // sent again (by report: a phone ran hot; a frame lasts 100 ms or more, every figure was painted and sent 60
    // times a second). An image not loaded yet (look.js drawFrame: g.missing) has it painted again the next time.
    const g = this.ctx, keyed = !!this.draw.keyed;
    this.painted = !keyed;
    if (!keyed) this.blank();
    g.missing = false;
    const ok = this.draw(g, walking ? 1 : 0, dir, m.clock, this.same), alpha = m.alpha ?? 1;
    if (g.missing) this.key = null;
    this.sprite.visible = ok && alpha > 0;
    this.sprite.material.uniforms.alpha.value = alpha;
    // (overFloor: a dying monster's, so the floor cuts none of what its death throws out (OVER_FLOOR's depth), walls
    // and models before it still do (by request: with no depth test it showed through them). Pulling its whole
    // picture's depth toward the camera instead had it over the figures in front of it too: by report)
    if (!!m.overFloor !== !!this.overFloor) { this.overFloor = !!m.overFloor; this.setDefines(this.glowing != null, this.overFloor); }
    this.shadow.visible = alpha > 0 && !m.flat;  // (flat: no shadow, as loot on the ground)
    this.shadow.material.opacity = alpha;
    if (this.painted) this.texture.needsUpdate = true;

    const p = m.worldPosition(new THREE.Vector3());
    this.sprite.position.copy(p);
    this.sprite.position.y += m.lift || 0;
    this.trail(this.sprite.position);
    this.shadow.position.set(p.x, p.y + 0.03, p.z);
    // its long axis along the screen's left–right, whichever way the camera looks (the camera's right on the
    // ground: (−fz, fx)); fixed to the world's x it lay askew under a turned camera
    this.shadow.rotation.y = Math.atan2(-fx / fl, -fz / fl);
  }

  // take the figure off the scene and free what it holds
  dispose() {
    for (const gh of this.ghosts || []) { gh.sprite.removeFromParent(); gh.sprite.geometry.dispose(); gh.sprite.material.dispose(); gh.texture.dispose(); }
    this.group.removeFromParent();
    this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
    this.texture.dispose();
  }
}

// ---------- a walker (the map tab's character) ----------
export class Walker extends Mover {
  constructor(scene, drawCharacter) {
    super();
    this.transit = null;   // straight walk across the gap between two maps: { from, to, t, len, map, cell, then }
    this.figure = new Figure(scene, drawCharacter, this);
  }

  spawn(map, x, y) {
    if (!super.spawn(map, x, y)) return false;
    this.transit = null;
    this.figure.marker.visible = false;
    return true;
  }

  hide() { this.pos = this.map = null; this.figure.group.visible = false; }

  // as Mover's, showing the marker on the cell unless `marker` is false; not while crossing between maps
  walkTo(x, y, onArrive = null, marker = true) {
    if (this.transit || !super.walkTo(x, y, onArrive)) return false;
    if (marker) this.showMarker(this.map, x, y);
    return true;
  }

  showMarker(map, x, y) { this.figure.showMarker(map, x, y); }

  // leave the current map from where we stand and walk straight to (x, y) on another placed map
  cross(map, x, y, then) {
    const from = this.worldPosition(new THREE.Vector3()), to = Mover.world(map, x + 0.5, y + 0.5, new THREE.Vector3());
    this.path = [];
    this.transit = { from, to, t: 0, len: Math.max(from.distanceTo(to), 1e-3), map, cell: [x, y], then };
    this.heading = [to.x - from.x, -(to.z - from.z)];
    this.moving = true;
  }

  // world position of the feet (for camera follow)
  worldPosition(out) {
    if (this.transit) return out.lerpVectors(this.transit.from, this.transit.to, Math.min(this.transit.t / this.transit.len, 1));
    return super.worldPosition(out);
  }

  update(dt, camera) {
    if (!this.pos) return;
    if (this.transit) {
      const tr = this.transit;
      tr.t += dt / this.cellMs;
      this.clock += dt;
      if (tr.t >= tr.len) {
        this.transit = null;
        this.map = tr.map;
        this.cell = tr.cell;
        this.pos = [tr.cell[0] + 0.5, tr.cell[1] + 0.5];
        this.moving = false;
        this.clock = 0;
        if (tr.then) tr.then();
      }
    } else this.advance(dt);
    this.figure.update(camera);
  }
}
