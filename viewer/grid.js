// Cells and walking, without drawing: GAT walkability and heights, A* pathfinding, a Mover that walks a
// path cell by cell, and a Field (a floor and the movers on it) with the moves the fight needs. No DOM or
// three.js here; walker.js draws a mover as a sprite.
const S = 0.2;            // RO units -> map units (1 unit = 1 GAT cell), as in scripts/map2gltf.py
const CELL_MS = 150;      // default walk speed: 150 ms per cell, diagonals × √2
// a length, in what every browser works out the same to the last bit (Math.hypot is left to each engine, a
// shared replay's walks with it: sandbox.js)
const len = (x, y) => Math.sqrt(x * x + y * y);

// ---------- GAT ----------
// GAT: "GRAT" v1.2/1.3, width, height, then per cell 4 corner heights (f32, +Y down) + type (u32).
// Type 0 is walkable; 1 wall, 5 cliff; bit 31 marks water in 1.3.
export function parseGat(buf) {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'GRAT') throw new Error('not a GAT');
  const w = dv.getInt32(6, true), h = dv.getInt32(10, true);
  const heights = new Float32Array(w * h * 4), walk = new Uint8Array(w * h);
  for (let i = 0, p = 14; i < w * h; i++, p += 20) {
    for (let k = 0; k < 4; k++) heights[i * 4 + k] = dv.getFloat32(p + k * 4, true);
    walk[i] = (dv.getUint32(p + 16, true) & 0xff) === 0 ? 1 : 0;
  }
  return { w, h, heights, walk, wall: new Uint8Array(w * h), walls: 0 };
}
// a flat GAT of w × h cells, all walkable. wall: the cells that can be neither walked on nor shot over (a GAT's
// type 1; rAthena map_gat2cell: a gap, 5, can be shot over), walls: how many (none: every shot clear); a GAT read
// here has none, only the battle sandbox's floors (sim.js setFloor)
export const flatGat = (w, h) => ({ w, h, heights: new Float32Array(w * h * 4), walk: new Uint8Array(w * h).fill(1),
  wall: new Uint8Array(w * h), walls: 0 });

export function walkable(gat, x, y) {
  return x >= 0 && y >= 0 && x < gat.w && y < gat.h && gat.walk[y * gat.w + x] === 1;
}

// ground height (map units, +Y up) at a position in cells; corners are (x,y) (x+1,y) (x,y+1) (x+1,y+1)
export function groundY(gat, x, y) {
  const ix = Math.min(Math.max(Math.floor(x), 0), gat.w - 1), iy = Math.min(Math.max(Math.floor(y), 0), gat.h - 1);
  const fx = Math.min(Math.max(x - ix, 0), 1), fy = Math.min(Math.max(y - iy, 0), 1);
  const c = gat.heights.subarray((iy * gat.w + ix) * 4);
  const hh = (c[0] * (1 - fx) + c[1] * fx) * (1 - fy) + (c[2] * (1 - fx) + c[3] * fx) * fy;
  return -hh * S;
}
// Nothing in the way of a shot from cell (x0, y0) to (x1, y1) (rAthena path_search_long, CELL_CHKWALL): the
// cells of the line between them (not the first, not the last) are none of them a wall. The line is walked the
// server's way, from the western end.
export function clearShot(gat, x0, y0, x1, y1) {
  if (!gat.walls) return true;
  let dx = x1 - x0;
  if (dx < 0) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; dx = -dx; }
  const dy = y1 - y0, weight = dx > Math.abs(dy) ? dx : Math.abs(dy);
  let wx = 0, wy = 0, guard = 0;
  while (x0 !== x1 || y0 !== y1) {
    // (by request, a page hung in a chase: a line longer than it can be is a bug to hear of, not to loop on)
    if (++guard > weight + 2) throw new Error(`clearShot looped: ${[x0, y0, x1, y1, dx, dy, weight]}`);
    wx += dx; wy += dy;
    if (wx >= weight) { wx -= weight; x0++; }
    if (wy >= weight) { wy -= weight; y0++; }
    else if (wy < 0) { wy += weight; y0--; }
    if ((x0 !== x1 || y0 !== y1) && (x0 < 0 || y0 < 0 || x0 >= gat.w || y0 >= gat.h || gat.wall[y0 * gat.w + x0])) return false;
  }
  return true;
}
// A* over 8 neighbours; a diagonal step needs both adjacent orthogonal cells free (no corner cutting). The cell it
// starts on need not be walkable (rAthena path_search does not check it: one left on an Ice Wall's cell walks off).
// cost(x, y): what stepping onto that cell costs on top of the step (none: nothing; by request, a way round the
// areas a character would rather not walk through, which it still walks through when there is no other way)
export function findPath(gat, sx, sy, tx, ty, cost = null) {
  if (!walkable(gat, tx, ty) || sx < 0 || sy < 0 || sx >= gat.w || sy >= gat.h) return null;
  if (sx === tx && sy === ty) return [];
  const w = gat.w, n = w * gat.h;
  const g = new Float32Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
  const heap = [];  // [f, index]
  const push = (f, i) => {
    heap.push([f, i]);
    for (let c = heap.length - 1; c > 0;) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]]; c = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let c = 0; ;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]]; c = m;
      }
    }
    return top;
  };
  const hcost = (x, y) => { const dx = Math.abs(x - tx), dy = Math.abs(y - ty); return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy); };
  const start = sy * w + sx, goal = ty * w + tx;
  g[start] = 0; push(hcost(sx, sy), start);
  while (heap.length) {
    const [, i] = pop();
    if (closed[i]) continue;
    if (i === goal) break;
    closed[i] = 1;
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (!walkable(gat, nx, ny)) continue;
      if (dx && dy && !(walkable(gat, x + dx, y) && walkable(gat, x, y + dy))) continue;
      const j = ny * w + nx, k = g[i] + (dx && dy ? Math.SQRT2 : 1) + (cost ? cost(nx, ny) : 0);
      if (k < g[j]) { g[j] = k; from[j] = i; push(k + hcost(nx, ny), j); }
    }
  }
  if (from[goal] < 0) return null;
  return unwind(w, from, start, goal);
}
const unwind = (w, from, start, goal) => {
  const path = [];
  for (let i = goal; i !== start; i = from[i]) {
    // (a way back longer than the floor has cells: a bug to hear of, not to loop on)
    if (path.length > from.length || !(i >= 0)) throw new Error(`unwind looped: start ${start} goal ${goal} at ${i} after ${path.length} (w ${w}, cells ${from.length})`);
    path.push([i % w, (i / w) | 0]);
  }
  return path.reverse();
};
// The ways from cell (sx, sy) to the cells round it, nearest first (Dijkstra, as findPath steps: 8 neighbours, no
// corner cutting, cost as findPath's): visit(i, g, steps, extra) is called once on each cell it gets to (by index
// y × w + x: how far, as findPath counts it, the cells walked, and what cost added of it), and the search stops when
// it returns true. → path(i): the cells walked to one visited, as findPath gives them (before the next search: the
// searches share their buffers, so that a chase may look again each cell at little cost; Field.approach).
let WAY = null;
// (debugging, by request: a page hung in a chase) gridDebug.mark(label, data) at the parts of Field.approach and every
// 50 pops of waysFrom; null: none (sim.js's debug.mark, set by the page)
export const gridDebug = { mark: null };
export function waysFrom(gat, sx, sy, cost, visit) {
  const w = gat.w, n = w * gat.h;
  if (!WAY || WAY.n < n) WAY = { n, gen: 0, seen: new Uint32Array(n), done: new Uint32Array(n), g: new Float64Array(n), from: new Int32Array(n),
    steps: new Uint16Array(n), extra: new Float64Array(n), hf: new Float64Array(8 * n + 8), hi: new Int32Array(8 * n + 8) };
  const B = WAY, gen = ++B.gen, { seen, done, g, from, steps, extra, hf, hi } = B, start = sy * w + sx;
  let size = 0;
  const push = (f, i) => {
    let c = size++;
    while (c > 0) { const p = (c - 1) >> 1; if (hf[p] <= f) break; hf[c] = hf[p]; hi[c] = hi[p]; c = p; }
    hf[c] = f; hi[c] = i;
  };
  const pop = () => {
    const top = hi[0], f = hf[--size], i = hi[size];
    let c = 0;
    for (;;) {
      const l = c * 2 + 1, r = l + 1;
      let m = -1, mf = f;
      if (l < size && hf[l] < mf) { m = l; mf = hf[l]; }
      if (r < size && hf[r] < mf) m = r;
      if (m < 0) break;
      hf[c] = hf[m]; hi[c] = hi[m]; c = m;
    }
    hf[c] = f; hi[c] = i;
    return top;
  };
  if (sx >= 0 && sy >= 0 && sx < w && sy < gat.h) { seen[start] = gen; g[start] = 0; from[start] = -1; steps[start] = 0; extra[start] = 0; push(0, start); }
  let pops = 0;
  while (size) {
    // (more pops than pushes can be: a bug to hear of, not to loop on)
    if (++pops > 8 * n + 8) throw new Error(`waysFrom looped: from ${sx},${sy} size ${size} pops ${pops} n ${n} gen ${gen} buf ${B.n}`);
    if (gridDebug.mark && pops % 50 === 0) gridDebug.mark('ways', { pops, size });
    const i = pop();
    if (done[i] === gen) continue;
    done[i] = gen;
    if (visit(i, g[i], steps[i], extra[i])) break;
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (!walkable(gat, nx, ny)) continue;
      if (dx && dy && !(walkable(gat, x + dx, y) && walkable(gat, x, y + dy))) continue;
      const j = ny * w + nx, e = cost ? cost(nx, ny) : 0, k = g[i] + (dx && dy ? Math.SQRT2 : 1) + e;
      if (seen[j] !== gen || k < g[j]) { seen[j] = gen; g[j] = k; from[j] = i; steps[j] = steps[i] + 1; extra[j] = extra[i] + e; push(k, j); }
    }
  }
  return { path: i => i === start ? [] : seen[i] !== gen ? null : unwind(w, from, start, i) };
}

// nearest walkable cell to (x, y), searching outward in rings
export function nearestWalkable(gat, x, y, maxR = 60) {
  x = Math.round(x); y = Math.round(y);
  for (let r = 0; r <= maxR; r++)
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
      if (Math.max(Math.abs(dx), Math.abs(dy)) === r && walkable(gat, x + dx, y + dy)) return [x + dx, y + dy];
  return null;
}

// ---------- a mover ----------
// Something that stands on a map's cells and walks from cell to cell, like the client's units: its cell is
// the one it stands on or is walking into, its pos where it is between cell centres.
// a slide's easing unless it has its own (a knockback's): fast at first, slowing to a stop
export const easeOutQuart = k => 1 - (1 - k) ** 4;
export class Mover {
  constructor() {
    this.map = null;       // map we stand on: { gat, pos: { x, y, h } } (pos = the map's origin in world cells / height)
    this.pos = null;       // [x, y] in that map's cells (cell centre = integer + 0.5)
    this.cell = null;      // cell we stand on or are walking to
    this.path = [];
    this.onArrive = null;  // called once the current path is finished
    this.heading = [0, -1];  // last move direction in cells (+y = north); starts facing south
    this.clock = 0;        // ms walked since this walk started (the walk animation's clock)
    this.random = Math.random;  // its dice (a confused walk's way): its field's
    this.moving = false;
    this.cellMs = CELL_MS;  // walk speed: ms per cell (monsters: mob_db WalkSpeed)
    this.pace = 1;          // how fast it goes for now, walking and its walk animation (1: as cellMs says; less is slower)
    this.slideMs = 0;       // while knocked back: ms per cell of the slide (no walking motion)
    this.slide = null;      // the knockback's slide: { from, to (positions), t, dur (ms) }
    this.confused = false;  // every walk goes somewhere random instead (see walkTo)
    this.rooted = false;    // it cannot walk (rAthena's NoMove: Stop); a knockback still moves it
    this.steer = null;      // walking freely this way ([x, y], unit length; see steerTo) instead of cell to cell
    this.onCell = null;     // called on each cell's middle it walks through with more of its walk to go (it may halt
                            // the walk there, or give it another way: by request, a chase that keeps up with its target)
  }

  // world position of a cell-space point on a placed map (out: a THREE.Vector3 or anything with set(x, y, z))
  static world(map, x, y, out) {
    return out.set(map.pos.x + x, groundY(map.gat, x, y) + map.pos.h, -(map.pos.y + y));
  }
  // world position of the feet
  worldPosition(out) {
    return Mover.world(this.map, this.pos[0], this.pos[1], out);
  }

  // stand on the walkable cell nearest (x, y) of a map; false if there is none
  spawn(map, x, y) {
    const c = map && map.gat && nearestWalkable(map.gat, x, y);
    if (!c) return false;
    this.map = map;
    this.cell = c;
    this.pos = [c[0] + 0.5, c[1] + 0.5];
    this.path = [];
    this.onArrive = null;
    this.moving = false;
    this.slide = null;
    this.slideMs = 0;
    this.steer = null;
    return true;
  }

  // walk to a cell of the current map; keeps finishing the current step first, like the client.
  // onArrive runs when we get there (not if another walk replaces this one)
  walkTo(x, y, onArrive = null) {
    if (!this.pos || this.rooted) return false;
    if (this.confused) [x, y] = this.randomDir(x, y);
    return this.setOff(findPath(this.map.gat, this.cell[0], this.cell[1], x, y), onArrive);
  }
  // walk a way found already (findPath's, waysFrom's: from the cell it is on); false with none. Confused, to where a
  // walk to its end goes instead (walkTo)
  walkPath(path, onArrive = null) {
    if (!path || !this.pos || this.rooted) return false;
    if (this.confused) return this.walkTo(...(path.length ? path[path.length - 1] : this.cell), onArrive);
    return this.setOff(path, onArrive);
  }
  // (by report: walkTo through walkPath, confused, sent it back to walkTo without end — the page hung in a 對戰 where
  // a confused character chased)
  setOff(path, onArrive) {
    if (!path) return false;
    this.steer = null;
    this.path = path;
    this.onArrive = onArrive;
    return true;
  }

  // where a confused walk to (x, y) goes instead (rAthena map_random_dir): as far (√ of the squared distance,
  // rounded down; at least 1), toward a random diagonal — a random share of it along x, the rest along y —
  // on a cell it can get to; tried 100 times, else (x, y) after all
  randomDir(x, y) {
    const [cx, cy] = this.cell, d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy), d = Math.max(1, Math.floor(Math.sqrt(d2)));
    for (let i = 0; i < 100; i++) {
      const sx = this.random() < 0.5 ? -1 : 1, sy = this.random() < 0.5 ? -1 : 1;
      const a = 1 + Math.floor(this.random() * d), b = Math.floor(Math.sqrt(Math.max(0, d2 - a * a)));
      const tx = cx + a * sx, ty = cy + b * sy;
      if (walkable(this.map.gat, tx, ty) && findPath(this.map.gat, cx, cy, tx, ty)) return [tx, ty];
    }
    return [x, y];
  }

  // stop on the cell being walked into (unit_stop_walking USW_MOVE_FULL_CELL): the walk and its onArrive are dropped
  stop() {
    this.steer = null;
    this.path = [];
    this.onArrive = null;
  }

  // knocked back to a cell of the current map: slide there, standing, dropping any walk. The slide takes
  // msPerCell a cell of the way and slows to a stop (easeOutQuart).
  knock(cell, msPerCell, ease = null) {
    this.steer = null;
    this.path = [];
    this.onArrive = null;
    this.cell = cell;
    this.slideMs = msPerCell;
    const to = [cell[0] + 0.5, cell[1] + 0.5];
    this.slide = { from: [...this.pos], to, t: 0, dur: len(to[0] - this.pos[0], to[1] - this.pos[1]) * msPerCell, ease: ease || easeOutQuart };
    this.moving = false;
  }

  // the walk's steps dropped (its onArrive kept: it runs on the cell it stands on), a free walk's too
  halt() {
    this.path = [];
    this.steer = null;
  }

  // walk freely the way [x, y] points (a gamepad's stick: by request, turning at once, not at the next cell's middle),
  // at walking speed, along a wall that stands in the way; its cell the one it is on. null: it walks on into that
  // cell's middle and stands there. The walk it was on is dropped.
  steerTo(dir) {
    if (dir && (!this.pos || this.rooted)) return false;
    if (dir) { this.path = []; this.onArrive = null; }
    this.steer = dir && [...dir];
    return true;
  }

  // walk on for dt ms: toward this.cell, and when it is reached, the next step of the path
  advance(dt) {
    if (!this.pos) return;
    let left = dt;
    const s = this.slide;
    if (s) {
      s.t += dt;
      // (its `ease`: k → share of the way)
      const k = s.dur > 0 ? Math.min(1, s.t / s.dur) : 1, e = s.ease(k);
      this.pos = [s.from[0] + (s.to[0] - s.from[0]) * e, s.from[1] + (s.to[1] - s.from[1]) * e];
      if (k < 1) { this.clock = 0; return; }
      this.slide = null;
      left = s.t - s.dur;  // (what is left of dt goes on to a walk queued meanwhile)
    }
    if (this.steer && !this.rooted && left > 0) {
      const step = left / (this.cellMs / this.pace), [dx, dy] = this.steer, [x, y] = this.pos;
      const free = (px, py) => walkable(this.map.gat, Math.floor(px), Math.floor(py));
      const to = free(x + dx * step, y + dy * step) ? [x + dx * step, y + dy * step]
        : dx && free(x + dx * step, y) ? [x + dx * step, y] : dy && free(x, y + dy * step) ? [x, y + dy * step] : null;
      this.heading = [dx, dy];
      this.moving = true;
      if (to) { this.pos = to; this.cell = [Math.floor(to[0]), Math.floor(to[1])]; }
      this.clock += dt * this.pace;
      return;
    }
    while (left > 0) {
      const tx = this.cell[0] + 0.5, ty = this.cell[1] + 0.5;
      const dx = tx - this.pos[0], dy = ty - this.pos[1], dist = len(dx, dy);
      if (dist < 1e-6) {
        // a knockback's slide ends on its cell: a walk queued meanwhile goes on at walking speed
        this.slideMs = 0;
        if (!this.path.length) {
          this.moving = false;
          const done = this.onArrive;
          this.onArrive = null;
          if (done) done();
          break;
        }
        // a step onto a cell that can no longer be walked on (an Ice Wall's, gone up since): the way there found
        // again from here, or the walk given up (unit_walktoxy_timer: CELL_CHKNOPASS)
        if (!walkable(this.map.gat, ...this.path[0])) {
          const end = this.path[this.path.length - 1], again = findPath(this.map.gat, this.cell[0], this.cell[1], end[0], end[1]);
          if (!again || !again.length) { this.path = []; this.onArrive = null; this.moving = false; break; }
          this.path = again;
        }
        this.cell = this.path.shift();
        this.heading = [this.cell[0] + 0.5 - this.pos[0], this.cell[1] + 0.5 - this.pos[1]];
        this.moving = true;
        continue;
      }
      const ms = this.slideMs || this.cellMs / this.pace;
      const step = left / ms;  // cells per ms along the segment (diagonals take √2 as long)
      if (step >= dist) { this.pos = [tx, ty]; left -= dist * ms; if (this.onCell && this.path.length && !this.slideMs) this.onCell(); }
      else { this.pos = [this.pos[0] + dx / dist * step, this.pos[1] + dy / dist * step]; left = 0; }
    }
    this.clock = this.moving ? this.clock + dt * this.pace : 0;
  }
}

// ---------- a field ----------
// cells between two units (Chebyshev, as the server's check_distance)
export const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
// knockback's slide: KNOCK_MS per cell (by eye: the server moves the unit at once, the client slides it)
const KNOCK_MS = 100;
// A floor and the movers on it (units may share cells, as in the client), with the moves units make on it.
// map: { name, pos: { x, y, h }, gat }, as Mover expects.
export class Field {
  constructor(map) {
    this.map = map;
    this.movers = new Set();
    this.random = Math.random;  // its dice, and its movers' (sim.js gives the arena the fight's: rng.js)
  }
  get w() { return this.map.gat.w; }
  get h() { return this.map.gat.h; }
  // a new mover on the field (standing nowhere yet: see placeNear / placeAway)
  add() {
    const m = new Mover();
    m.random = this.random;
    this.movers.add(m);
    return m;
  }
  remove(m) { this.movers.delete(m); }
  // cells other movers stand on or are walking to (a crowd spreads out around its target)
  taken(except) {
    const out = new Set();
    for (const w of this.movers) if (w !== except && w.pos) {
      out.add(w.cell.join());
      if (w.path.length) out.add(w.path[w.path.length - 1].join());
    }
    return out;
  }
  // put w on the free cell nearest `at`
  placeNear(w, at) {
    const busy = this.taken(w);
    let best = at, bd = Infinity;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (!this.open(x, y)) continue;
      const d = cheb([x, y], at) + (busy.has(x + ',' + y) ? 100 : 0);
      if (d < bd) { best = [x, y]; bd = d; }
    }
    w.spawn(this.map, ...best);
  }
  // put w on a random free cell at least `gap` cells from each of `away` (movers); the middle if none is found
  placeAway(w, away, gap) {
    const busy = this.taken(w);
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(this.random() * this.w), y = Math.floor(this.random() * this.h);
      if (this.open(x, y) && !busy.has(x + ',' + y) && away.every(p => cheb([x, y], p.cell) >= gap) && w.spawn(this.map, x, y)) return;
    }
    w.spawn(this.map, this.w >> 1, this.h >> 1);
  }
  // advance every mover dt ms
  advance(dt) { for (const w of this.movers) w.advance(dt); }

  distance(a, b) { return cheb(a.cell, b.cell); }
  // a is standing (not walking) within range cells of b, nothing in the way (sees)
  inRange(a, b, range) { return !a.moving && cheb(a.cell, b.cell) <= range && this.sees(a.cell, b.cell); }
  // nothing in the way of a shot from cell a to cell b (rAthena battle_check_range: not looked for under 2 cells)
  sees(a, b) { return cheb(a, b) < 2 || clearShot(this.map.gat, a[0], a[1], b[0], b[1]); }
  // a cell of the floor that can be stood on
  open(x, y) { return walkable(this.map.gat, x, y); }
  // a floor cell standing in for a mover, for what is aimed at the ground: it has a cell (ranges, knockback)
  // and a world position (effects), and that of the ground dx dy cells off it (groundAt)
  spot(x, y) {
    const map = this.map;
    return { cell: [x, y], pos: [x + 0.5, y + 0.5], heading: [0, -1], path: [], moving: false,
             worldPosition: out => Mover.world(map, x + 0.5, y + 0.5, out),
             groundAt: (dx, dy, out) => Mover.world(map, x + 0.5 + dx, y + 0.5 + dy, out) };
  }
  // cells left on the mover's current path
  pathLength(w) { return w.path.length + (w.moving ? 1 : 0); }
  // turn a mover toward another (heading: cells, +y north)
  face(w, other) {
    const dx = other.pos[0] - w.pos[0], dy = other.pos[1] - w.pos[1];
    if (dx || dy) w.heading = [dx, dy];
  }
  // walk a to the cell within range of b (and seeing it: sees) that is the shortest walk away, preferring free
  // cells; false when there is none. avoid (by request): { cost(x, y) (findPath's), shun(x, y) (cells not to stop
  // on) } — the way and the cell kept out of the areas a character dodges, as far as can be. One search from a's
  // cell (waysFrom) for all the cells in range, not a path found to each, given up once none further can be
  // shorter (a cell's walk, steps and cost, is at least its g / √2), so that a chase can look again each cell.
  approach(a, b, range, onArrive, avoid = null) {
    if (!a.pos || a.rooted) return false;
    let best = null;
    gridDebug.mark?.('fa:taken', { from: a.cell, to: b.cell, movers: this.movers.size });
    const busy = this.taken(a), gat = this.map.gat, w = gat.w, [bx, by] = b.cell;
    gridDebug.mark?.('fa:search', { busy: busy.size, w, h: gat.h, walls: gat.walls, buf: WAY?.n });
    const ways = waysFrom(gat, a.cell[0], a.cell[1], avoid && avoid.cost, (i, g, steps, extra) => {
      if (best && g > Math.SQRT2 * best.n) return true;
      const x = i % w, y = (i / w) | 0, dx = x - bx, dy = y - by;
      if (Math.abs(dx) > range || Math.abs(dy) > range || (!dx && !dy && range) || !walkable(gat, x, y)) return false;
      if ((avoid && avoid.shun(x, y)) || !this.sees([x, y], b.cell)) return false;
      const n = steps + extra + (busy.has(x + ',' + y) ? 100 : 0);
      if (!best || n < best.n) best = { i, n };
      return false;
    });
    gridDebug.mark?.('fa:found', { best });
    if (!best) return false;
    const path = ways.path(best.i);
    gridDebug.mark?.('fa:path', { path });
    const ok = a.walkPath(path, onArrive);
    gridDebug.mark?.('fa:walk', { ok });
    return ok;
  }
  // random walk (mob_randomwalk): a random reachable cell up to d cells away in each direction
  wander(w, d) {
    for (let i = 0; i < 20; i++) {
      const x = w.cell[0] + Math.floor(this.random() * (2 * d + 1)) - d, y = w.cell[1] + Math.floor(this.random() * (2 * d + 1)) - d;
      if ((x !== w.cell[0] || y !== w.cell[1]) && walkable(this.map.gat, x, y) && w.walkTo(x, y)) return true;
    }
    return false;
  }
  // knockback (skill_blown): push w up to n cells straight away from mover `from` (in its facing direction
  // when both stand on one cell; with no `from`, backward, against w's own facing, as Fire Wall pushes),
  // stopping before a cell it cannot enter; other units do not block it
  get knockMs() { return KNOCK_MS; }  // (ms a cell of a knockback's slide)
  knockback(w, from, n) {
    const [x, y] = this.knockTo(w, from, n);
    if (x !== w.cell[0] || y !== w.cell[1]) w.knock([x, y], KNOCK_MS);
  }
  // the cell such a knockback would leave w on
  knockTo(w, from, n) {
    let dx = from ? Math.sign(w.cell[0] - from.cell[0]) : 0, dy = from ? Math.sign(w.cell[1] - from.cell[1]) : 0;
    if (!dx && !dy) {
      const [hx, hy] = (from || w).heading, l = len(hx, hy) || 1, back = from ? 1 : -1;
      dx = Math.round(hx / l) * back; dy = Math.round(hy / l) * back;
      if (!dx && !dy) dy = -back;
    }
    let [x, y] = w.cell;
    for (let i = 0; i < n && walkable(this.map.gat, x + dx, y + dy); i++) { x += dx; y += dy; }
    return [x, y];
  }
  // teleport (AL_TELEPORT): w reappears on a random free cell of the floor, standing
  teleport(w) {
    const busy = this.taken(w);
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(this.random() * this.w), y = Math.floor(this.random() * this.h);
      if (this.open(x, y) && !busy.has(x + ',' + y) && (x !== w.cell[0] || y !== w.cell[1]) && w.spawn(this.map, x, y)) return;
    }
  }
}
