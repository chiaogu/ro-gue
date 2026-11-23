// The fight's dice (sim.js, battle.js, grid.js's floor): one stream from a seed (mulberry32), so a fight started
// from the same seed, the same party and the same commands at the same steps comes out the same, on the page
// and in mapsim.js's runs alike. What is only shown (effects, hair picked at random) keeps to Math.random and
// leaves the stream alone; so do the averages of levels.js (healOf), which pass their own dice.
let s = (Math.random() * 2 ** 32) >>> 0;
export function seed(n) { s = n >>> 0; }
// where the stream is (a shared replay's check that it came out the same: sandbox.js)
export const state = () => s;
// a seed for a fight of its own
export const newSeed = () => (Math.random() * 2 ** 32) >>> 0;
// → [0, 1)
export function random() {
  s = (s + 0x6D2B79F5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
// → an integer in [0, n)
export const rnd = n => Math.floor(random() * n);
