// Skill and hit effects in the battle arena. The client's effect table (which effect a skill shows and
// how each one is drawn) is compiled into the packed exe; the parameters below follow what roBrowser
// (github.com/MrAntares/roBrowserLegacy, src/DB/Effects/EffectTable.js and Renderer/Effects/) worked out
// for the few effects used here, rewritten for three.js. Textures are read straight from the client's
// data/texture/effect/ (TGA decoded here; BMP magenta made transparent). Times are the sandbox clock.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as A from './arena.js';
import { DEPTH_BIAS, spriteQuad, FLOOR_DEPTH_OUT, FLOOR_DEPTH_IN } from './walker.js';

// Effect layers. Units: cells (world) and sprite pixels (2D sizes); times in ms.
//   ring  — a disc or wedges of it facing the camera and spinning (roBrowser 'CYLINDER' with height 0 and
//           fixedPerspective): inner radius `inner`, outer radius growing to `outer` over the first second
//           (animation 2), `slices` of `sides` wedges (a full disc when slices = sides), at `up` cells above
//           the feet, alpha up to `alpha` fading in and out over the first and last quarter. `behind`: that
//           many cells behind the unit (away from the camera) and depth-tested, so the unit stands in front of it
//   flash — a streak drawn on top of everything (roBrowser '2D', overlay): starts `inner` cells from the
//           unit's middle (`up` cells above the feet) in the screen plane at angle `angle` (random in the
//           range, clockwise from up) and moves out to `outer`, pointing outward and stretching from `from`
//           to `to` sprite px (width, height), fading out over the last quarter. (roBrowser spreads them
//           on the ground; in the client they lie flat to the camera.)
//   speed — speed lines (not in roBrowser; Blitz Beat's, by request): thin white streaks drawn over everything
//           (additively), parallel to the way the one it comes from (play's `from`, its worldPosition, `up` cells up too) moved to the
//           unit's middle (`up` cells above the feet), as seen on screen, shooting that way as Increase AGI's do; each up
//           to `spread` cells to either side of that line, starting `back` cells before the middle (random in the range)
//           and running on `travel` cells over its duration (random), `len` sprite px long and `width` px wide (random),
//           brightest at its head, fading in over its first fifth and out over its last two; `count` of them, or with
//           `perSec`, that many a second (at least `count`) set off at random over the caller's duration; `travel` may be
//           a range; `color`: a tint; `radial`: each its own way out from the unit's middle at random, as seen on screen,
//           no `from` needed (roBrowser 3D streaks with posxEndRand and rotateToTarget: Raging Quadruple Blow's)
//   spike — thin tapered spikes in the scene (additive; depth-tested at the ground under their base, groundDepth), `count`
//           of them, each from a point on the unit's middle (`up` cells up) pointing away from where play's `from` struck
//           it, up to `cone` degrees off that way (sideways, and half that up or down; 180: any way at all), turned flat to
//           the camera about its own line: its base `width` cells across (random) in `color` [base, tip], tapering to its
//           tip `len` cells out (random), shooting out to full length within its first `grow` share of its duration and
//           shrinking to `shrink` of it after, its base moving out `travel` cells, fast and slowing (ease-out); alpha
//           `alpha`, fading out over its last half (not in roBrowser: Occult Impaction's burst, after 침투경_.spr)
//   qi — soft round glows in the scene (additive, `color`; depth-tested at the ground under each, groundDepth), `count` of
//           them `every` ms apart, each blown out of the unit's middle (`up` cells up) away from where play's `from` struck
//           it, up to `cone` degrees off that way (sideways, and half that up or down), `dist` cells over its duration (random
//           in the ranges), very fast at first and slowing (ease-out), swelling from `size` [first, last] cells across,
//           alpha `alpha` in over its first tenth and out over the rest (not in roBrowser: Occult Impaction's gust)
//   bounce — thin lines in the scene (additively; depth-tested, see groundDepth), each the trail of a spark thrown up from the unit's feet
//           (`up` cells above them, where the unit stood as it started) out along the ground its own way at random: `out`
//           cells a second along the ground and `rise` cells a second up (random in the ranges), falling `gravity` cells
//           a second², bouncing off the ground with `bounce` of its speed up (and along the ground) left, its trail the
//           last `trail` ms of its way, `width` sprite px wide, brightest at its head; `color` a tint, fading out over
//           the last third of its duration (not in roBrowser: Raging Thrust's, by a recording of the game)
//   cylinder — an upright open cylinder (or cone) around the unit's feet (roBrowser 'CYLINDER' with a
//           height): radius `bottom` at the ground and `top` at `height` cells up, both growing from 0 over
//           the whole effect (animation 4) — or, with `fixed`, at full size all along (animation 0) — or, with
//           `rise`, at full width while the height grows over the
//           first second (animation 1), or, with `widen`, the top opening from nothing over the first second
//           (animation 2) — spinning about the vertical (unless `still`), alpha up to `alpha` fading in and
//           out over the first and last quarter (or over `fadeMs`); `color`: a tint, `add`: additive blending (blendMode 2);
//           `bob`: its top rising and sinking by that share of its height, once every `bobMs` (each at its own phase;
//           not in roBrowser);
//           `land`: around where the effect's `fall` lands instead of the feet; `swell`: at full width, the height
//           growing to `height` over the first half and sinking back over the second (animation 5); `z`: that many
//           cells off the ground (posZ); `fadeOut`: fading out over the last quarter only; `cycle`: each copy
//           (`copies`, `every` ms apart) plays that many ms over and over, once every `every` × copies ms, for
//           the caller's duration (roBrowser repeat with a negative repeatDelay: a new one before the last ends);
//           `fadeTop`: the picture's top that share of it fading out to nothing at the top edge (not in roBrowser);
//           `sides`: that many flat sides all round (roBrowser circleSides = totalCircleSides), `angleY`: turned that many
//           degrees about the vertical (with `still`);
//           `facets`/`of`: only that many flat sides of an `of`-sided one (roBrowser circleSides / totalCircleSides),
//           the picture `repeat` times across them (repeatTextureX) and `repeatV` times up, the open side away from the one it comes from
//           (play's `from`; else the way the unit faces: rotateWithSource);
//           `sideways`: lying on its side, its bottom on the unit and opening toward the one it comes from (play's `from`),
//           its bottom `back` cells that way from the unit, `across` to either side and `z` up (random in the ranges, the
//           same for all the effect's copies), depth-tested as groundDepth (not in roBrowser)
//   shell — part of a sphere `radius` cells round a point `z` cells up (`radiusY` cells up and down: a spheroid): `arc` of the way round (its middle toward
//           the one it comes from, play's `from`, else where the unit faces) and from `lat` [low, high] degrees
//           of latitude, the picture `repeat` times round and `repeatV` times up; still, alpha up to `alpha`
//           fading in and out over the first and last quarter (or over `fadeMs`); `color`, `add` as a cylinder's (not in roBrowser:
//           Auto Guard's shields, by request)
//   lockon — roBrowser's LockOnTarget: `file` (or the canvas texture `paint` returns) flat on the ground under the unit, shrinking into place,
//           spinning and flashing red
//   dome  — a half sphere over the unit's feet, `radius` cells across the ground and `height` cells high,
//           growing from nothing over the whole effect, spinning about the vertical, alpha up to `alpha`
//           fading in and out over the first and last quarter (the picture's top row at the top)
//   link  — a line from the one it comes from (play's `from`) to the unit, `up` cells above both feet, `width` sprite px wide,
//           `color` at alpha `alpha`, brightest along its middle (`streak`, `pulse`, `near`, `far`, `outro`: see
//           drawLink), added on over everything (roBrowser '3D' with fromSrc and rotateToTarget: Sacrifice's
//           EF_LINELINK), for the caller's duration
//   str   — a client STR animation (data/texture/effect/<file>), played at the unit's feet (one picked at
//           random when `file` is a list); with `loop`, played over and over (picking again each time, as
//           roBrowser spams a persistent effect anew) for the caller's duration or until stopped; `scale`:
//           drawn that much smaller or larger around the feet; `alpha`: its colours times that (fainter); `max`:
//           its additive layers do not add up over each other or the scene, the brightest wins (not in roBrowser);
//           `jitter`: played up to that many cells off the feet either way; `flip`: mirrored, half the time;
//           `normal`: its additive layers laid over the scene instead, their brightness as their opacity;
//           `soft`: those of its pictures faded to nothing toward their square's edge (a glow the picture cuts off,
//           whose straight edges would show: softTexture; not in roBrowser)
//   ground — `file` flat on the ground under the unit, `size` cells across (or play's `size`), turning `spin` degrees a second
//           (roBrowser's MagicTarget), for the caller's duration; `keep`: only its pixels whose r, g and b are all at
//           least that (0–1) are drawn, at opacity `alpha`, whatever the texture's alpha (roBrowser's SpiderWeb)
//   quad  — a camera-facing picture (roBrowser '3D') `up` cells above the feet, growing from `from` to `to`
//           sprite px (or shrinking), fading out over the last quarter; `add`: additive blending; `fadeIn`:
//           fading in over the first quarter too; `smooth`: sizing fast at first and slowing (roBrowser
//           sizeSmooth: log10(1 + 9 × the share of the effect gone by)); `files`: converted sprite frames (png/…)
//           cycled one every `delay` ms instead of `file`; `depth`: depth-tested among the units; `round`: fading out
//           toward its edge in a circle (roundEdge: a picture whose square's edge is not black, by request)
//   sparks — `count` small camera-facing pictures (roBrowser '3D' with duplicate), one every `every` ms, each
//           `size` sprite px (`h` px tall if given, else square) at a random spot up to `spread` cells off the
//           feet either way (`spreadY` along the view, if different), moving from `z0` to `z1` cells up over its
//           `duration`; alpha up to `alpha`, fading in (unless `fadeIn` is false) and out over the first and
//           last quarter, and with `sparkle` flickering `sparkle` times a second or so in between (roBrowser
//           sparkling / sparkNumber); `color`: a tint; drawn additively unless `normal`; `soft`: fading
//           toward its top and bottom ends (not in roBrowser; Increase AGI's streaks, by eye); depth-tested
//           among the units unless `overlay` (roBrowser's overlay: over everything). Ranges are
//           [min, max]. `file` may be a converted sprite frame under png/ instead of a texture/effect/ file.
//           `out`: each also moves out to a random spot up to that many cells off either way (posxEndRand);
//           `size1`: it ends that many px across instead (sizeStart → sizeEnd); `repeat`: each plays over and over,
//           once every `every` × count ms, for as long as the effect lasts; `files`: pictures cycled one every
//           `delay` ms instead of `file`
//   fall  — a camera-facing picture (roBrowser '3D' with fileList) flying in a straight line from `x` cells
//           right, `y` cells away (as the camera looks; random in the ranges) and `z` cells up to the unit's
//           feet over its `duration` (the caller's when null), gone as it gets there; with `jitter`, it lands
//           up to that many cells off the feet either way (within the unit's cell) and starts as far off again
//           (the landing is the effect's, shared with its `land` layers), cycling through `files` one every `delay` ms, `size` sprite px (width,
//           height), its right end (the head) pointing where it flies and the one that follows that line, so
//           it ends as the head reaches the feet (roBrowser moves its middle there); drawn over the units,
//           additively unless `normal`
//   shot  — (`arc`: thrown, a parabola that many cells high half way, not fading in; the alchemist's bottles, by request)
//           a camera-facing picture `size` sprite px across flying from the one it comes from (play's `from`),
//           `z0` cells up (random in the range), to the unit, `z1` cells up, over the caller's duration, gone as
//           it gets there; fading in over the first quarter, drawn additively, and fading out toward its edge
//           in a circle (roundEdge). With `back`, it homes in: it sets off away from the unit, `back` cells
//           behind where it starts, up to `side` cells to either side and `lift` cells higher (the curve's
//           pull; random in the ranges), and swings round in an arc onto the unit (a quadratic Bézier). `tail`:
//           that many copies trailing it along its path, each `tailStep` of the flight behind the one before,
//           tapering to nothing in size and brightness — or with `tailAlpha`, as large as it and each that much
//           fainter than the one before. `files`: converted sprite frames (png/…) cycled one every `delay` ms instead
//           of `file`, drawn as they are (alpha blending, no round edge); `point`: the picture's top points the way it
//           flies, on screen (roBrowser rotateToTarget); `roll`: it turns that many degrees over its flight
//           (`normal`: alpha blending for a `file` too; `add`: additive for `files`, and with the round edge then);
//           `angle`: the picture turned that many degrees first (a
//           sprite layer's own angle); `size` [w, h] for one not square
//   trail — roBrowser's TRAIL of QuadHorns: spikes of `file` (four-sided pyramids) springing up along the
//           ground from the one it comes from (play's `from`) toward the unit, one every `every` ms at `speed`
//           cells a second, up to `overshoot` cells past it, each `spread` cells off the line; a spike stands
//           `height` cells (half its tip-to-base length), `bottom` cells across (half), tilted up to `tilt`°,
//           its middle `up` heights above the ground (roBrowser's QuadHorn: 0.9),
//           rises out of the ground from `sink` cells down over `rise` ms (easing out), lasts `life` ms and
//           fades over the last `fade`; depth-tested among the units
//   horns — `count` of roBrowser's QuadHorns standing at the unit, each up to `spread` cells off its feet either
//           way and leaning up to `tilt`° any way (random): `height`, `bottom` (each a [min, max] too), `up`, `sink`,
//           `rise`, `life` and `fade` as a trail's spikes. `off` [[x0, x1], [y0, y1]]: each that many cells east and
//           north of the feet instead (roBrowser's offsetX / offsetY less half a cell); `pop`: it goes up a further
//           `pop` of its height over `rise` ms, then drops back (roBrowser animation 3); `grid` g: one on each cell
//           of the (2g + 1)² round the feet in place of `count`
//   spr   — a client sprite converted with spr2png.py (roBrowser 'SPR'): action `action` of `sprite`
//           (png/effect/<name>; 'play': play's `action`), a frame every `delay` ms (else the act's), looping for
//           `duration` (with `once`: once through, as long as its frames take; `hold`: once through, its last frame
//           then held, roBrowser's stopAtEnd; `scale`: drawn that much bigger or smaller, from the feet), drawn `up` sprite px above
//           the unit's feet on the overlay (`'head'`: at the head height play is given); `fadeOut`: fading over the last quarter;
//           `alpha`: its opacity (roBrowser's attachment opacity); `depth`: in the scene
//           instead, depth-tested as the unit's own sprite is (things in front of the unit hide it too)
//   ripple — `count` camera-facing puffs of `file` evenly round the unit's feet (a little jitter; `vary`: each one's
//           reach and size that share either way at random; play's `scale` on both), `up` cells up,
//           moving out from `r0` to `r1` cells (fast at first) and growing from `from` to `to` sprite px, alpha up
//           to `alpha` over the first fifth and fading out over the rest; additive, depth-tested (not in roBrowser)
//   spray — `count` camera-facing puffs of `file` thrown onto the unit from the one it comes from (play's `from`):
//           each sets off `back` cells short of the unit on the line from that one, `spread` degrees off it at
//           most, `up` cells up (random in the range), and flies `dist` cells on along its way, growing from
//           `from` to `to` px, alpha up to `alpha` over its first fifth and fading out over the rest; additive,
//           depth-tested (not in roBrowser)
//   model — a client model (RSM) converted to glTF (scripts/map2gltf.py --models: `file`, under the repo, at the
//           maps' size), standing on the unit's cell `scale` times that size, unlit, for the caller's duration
//           (roBrowser 'RSM': its model drawn at 0.075 of the model's units, the maps' 0.2)
// Any layer may start `at` ms after the effect does.
//   orbit — `n` copies of a picture going round the unit (roBrowser '3D' with duplicate and rotatePosX/Y),
//           `radius` cells out and `up` cells above the feet, clockwise as seen from above at `spin` degrees a
//           ms, for the caller's duration; copy i is `lag` + i × `lagStep` quarter turns behind (rotateLate,
//           rotateLateDelta), `size` + i × `sizeStep` px across and alpha `alpha` + i × `alphaStep`; cycling
//           through `files` one every `delay` ms (playSprite); depth-tested among the units. `shadow`: each
//           copy also has a shadow on the ground under it ({ size, sizeStep, alpha }: roBrowser shadowTexture).
//           `add`: drawn additively (roBrowser blendMode 2); `color`: tinted [r, g, b] (roBrowser red/green/blue).
//           `intro`: ms over which the copies spin out from the body to `radius`, turning `introSpin` degrees more
//           than the spin alone, fast at first and slowing; `outro`: ms after the effect's end (stop) over which
//           they go on turning and shrink to nothing (neither in roBrowser: by request). `dynamic`: only as many copies
//           shown as setOrbs says, evenly round (360° / that many apart), a new one growing from nothing over ORB_GROW_MS
//           where it goes as it floats up from the ground to `up` over ORB_RISE_MS, one gone shrinking to nothing, and the rest gliding to their new places over ORB_GLIDE_MS
//           (not in roBrowser: the spirit spheres, by request); `lag` as ever, `lagStep` unused
//   burst — copies of a picture flying straight out from the unit `ways` ways (evenly round, as roBrowser's eight
//           layers of posxEnd/posyEnd), `reach` cells over `life` ms at `up` cells, `copies` of each `every` ms
//           apart (duplicate, timeBetweenDupli), growing from `from` to `to` px, alpha `alpha` + copy × `alphaStep`
//           fading in and out over the first and last quarter, cycling through `files` one every `delay` ms
//           (playSprite); `shadow` ({ from, to, alpha }): each with a shadow on the ground under it, faded the same.
//           Its duration is its own (the last copy's end).
// a warp portal's rings widening on the ground over and over (roBrowser effects 316 and 317's first layer)
// (by request a shallow cone, its outer edge 0.5 up, as a cast aura's; roBrowser's lie flat, 0.1 high)
const portalRing = () => ({ type: 'cylinder', file: 'ring_blue.tga', duration: null, cycle: 500, every: 200, copies: 3,
  bottom: 2.4, top: 3.9, height: 0.5, z: 0.1, fadeOut: true, alpha: 0.4, color: [0.6, 0.6, 1], add: true });
// The cast auras, after roBrowser's EffectTable (their `duration` is left to the caller: the cast time).
function castAuras() {
  const cyl = o => ({ type: 'cylinder', duration: null, bottom: 1, add: true, ...o });
  // a wide cone opening upward over its first second (animation 2). Its rings' faint upper half (alpha 10 / 255, up to
  // the top) would end in a hard rim, the cone's top edge showing: it fades out toward the top instead (by request,
  // fadeTop; roBrowser draws the texture as it is), as does the pillars' cone
  const cone = (file, alpha, still) => [cyl({ file, alpha, top: 5, height: 4, widen: true, still, fadeTop: 0.6 })];
  // a tall faint pillar and a low ring rising (animation 1), and a cone opening (animation 2), all spinning
  const pillar = (file, color, [a1, a2, a3], [h2, b2, t2]) => [
    cyl({ file, color, alpha: a1, top: 1, height: 30, rise: true }),
    cyl({ file, color, alpha: a2, bottom: b2, top: t2, height: h2, rise: true }),
    cyl({ file, color, alpha: a3, top: 4, height: 3, widen: true, fadeTop: 0.6 }),
  ];
  const aura = layers => ({ wav: 'effect/ef_beginspell.wav', layers });
  return {
    EF_BEGINSPELL: aura(cone('ring_yellow.tga', 0.8, true)),                                           // 12 neutral
    EF_BEGINSPELL2: aura(pillar('ring_blue.tga', [0.5, 0.5, 1], [0.2, 0.2, 0.6], [1, 1, 1.3])),         // 54 water
    EF_BEGINSPELL3: aura(pillar('ring_red.tga', [1, 0.4, 0.4], [0.3, 0.7, 0.7], [2, 1, 1.3])),          // 55 fire
    EF_BEGINSPELL4: aura(pillar('ring_white.tga', [0.6, 1, 0.6], [0.3, 0.6, 0.6], [2, 1, 1.3])),        // 56 wind
    EF_BEGINSPELL5: aura(pillar('ring_yellow.tga', [1, 1, 1], [0.5, 1, 1], [3, 1.1, 1.2])),             // 57 earth
    EF_BEGINSPELL6: aura(cone('ring_white.tga', 0.8, false)),                                          // 58 holy, ghost
    EF_BEGINSPELL7: aura(pillar('ring_purple.tga', [0.8, 0.8, 0.8], [0.3, 0.7, 0.7], [3, 1, 1.3])),     // 59 poison
    EF_DARKCASTING: aura(cone('ring_black.tga', 0.8, false)),                                          // 454 dark, undead
  };
}
// the cast aura for a skill element (skill_db Element; 'Weapon' and anything else count as neutral, as
// clif_skillcasting sends them), as roBrowser's onEntityCastSkill picks it
const CAST_AURA = { Water: 'EF_BEGINSPELL2', Earth: 'EF_BEGINSPELL5', Fire: 'EF_BEGINSPELL3', Wind: 'EF_BEGINSPELL4',
  Poison: 'EF_BEGINSPELL7', Holy: 'EF_BEGINSPELL6', Dark: 'EF_DARKCASTING', Ghost: 'EF_BEGINSPELL6', Undead: 'EF_DARKCASTING' };
export const castAura = element => CAST_AURA[element] || 'EF_BEGINSPELL';
// An effect's `wav` may be a list: one of them plays, picked at random (roBrowser's '%d' with `rand`);
// `wavDelay`: it plays that many ms after the effect starts (on the sandbox clock). `sounds`: more of them,
// [ms after the start, file] each.
const lens = (file, a0, a1) => ({ type: 'flash', file, angle: [a0, a1], duration: [200, 350], up: 1, inner: 2.2, outer: [5, 6],
                                  from: [[25, 40], 10], to: [1, [250, 300]] });
// Sight's and Ruwach's orbs come out spinning from the body over 400 ms (half a turn more than their own spin, fast
// at first) and, as the status ends, go on turning and shrink away over 600 ms (by request; roBrowser shows and
// drops them at once)
const ORBIT_INOUT = { intro: 400, introSpin: 180, outro: 600 };
// how long Sight's fireballs take to spiral in to the user as Sightrasher goes off (by request), its burst after
export const SIGHT_COLLAPSE = 300;
const BASH_GLOW = [
  { type: 'ring', file: 'alpha_down.tga', duration: 700, up: 1.5, inner: 0.1, outer: 2, sides: 20, slices: 20, alpha: 0.6, behind: 0.3 },
  { type: 'ring', file: 'alpha_center.tga', duration: 700, up: 1.5, inner: 0.01, outer: 2.5, sides: 30, slices: 1, alpha: 0.6, copies: 10, behind: 0.3 },
  { type: 'ring', file: 'alpha_center.tga', duration: 700, up: 1.5, inner: 0.01, outer: 4, sides: 30, slices: 1, alpha: 0.6, copies: 8, behind: 0.3 },
];
// (Bash's burst, see EF_BASH)
// the RSW effect ids a floor carries (scripts/map2gltf.py MAP_EFFECTS) → the effect drawn
export const MAP_EFFECTS = { 44: 'EF_SMOKE', 47: 'EF_TORCH', 109: 'EF_BUBBLE', 110: 'EF_GASPUSH' };
const SPHERE_TURN_MS = 4000, SPHERE_ALPHA = 0.6;  // spirit spheres (EF_SPHERES), by eye
const ORB_GROW_MS = 300, ORB_GLIDE_MS = 400, ORB_RISE_MS = 500;     // a `dynamic` orbit's copies coming, going and moving round (by eye)
// Fury's rings (EF_GUMGANG2), Mental Strength's too
const FURY_RINGS = [0, 100, 200, 300].map(at => ({ type: 'cylinder', file: 'ring_yellow.tga', at, duration: 1500, bottom: 2, top: 5, height: 2, alpha: 0.5 }));
// Fury's lightning (EF_FURY_ZAPS), Mental Strength's too
const FURY_ZAP = { type: 'zap', duration: null, every: [250, 800], bolts: [1, 2], life: [90, 160], up: [0.4, 1.9],
                   side: 0.45, reach: [0.6, 1.2], segs: [5, 8], forks: [1, 3], width: 1, alpha: 0.9,
                   color: [0.35, 0.4, 0.95], core: [0.6, 0.65, 1] };
// a lens's streak on a song's cells (EF_SONG_*): 32 × 128 px at 0.5, 2.6 times as wide and 3.5 times as high (1 cell by
// 5.6 at most, half of it under the ground), four on each cell (by eye against Slow Grace's screenshot, then smaller and
// more of them, then wider and a few less, by request)
const LENS = { size: 0.5, wide: 2.6, tall: 3.5, alpha: 0.21, ground: true, planes: 4 };
// the alchemist's bottles (by request, by eye): how high a throw arcs half way (cells), and the shards a bottle breaks
// into: of the three shapes drawn here (gen:shard0～2) BOTTLE_SHARD_N each, all at once, bursting out up to a cell
// from half a cell up and dropping to the ground as they shrink, gone in under half a second
const BOTTLE_ARC = 1.5, BOTTLE_SHARD_N = 4;
const BOTTLE_SHARDS = [0, 1, 2].map(i => ({ type: 'sparks', file: `gen:shard${i}`, count: BOTTLE_SHARD_N, every: 0, duration: [300, 450],
  spread: 0.15, z0: [0.3, 0.6], z1: 0, out: 1, size: [6, 10], size1: 3, alpha: 1, normal: true, fadeIn: false }));
export const EFFECTS = {
  // a monster hit by a normal attack (and by each punch of the monk's combo skills): a cast aura's white ring on its
  // side, its narrow end on the monster at a random spot and opening toward the attacker like a ripple, fading, two of
  // them 40 ms apart, each over 200 ms (by request, after a recording of the game: by eye; first 60 ms apart over 250
  // ms, then 150, at 0.4 cells toward the attacker 1 up, 0.3 → 1.2 cells across 0.4 long; roBrowser's effect 0, its
  // EF_HIT1, draws four white sparkles of pok3.tga instead)
  EF_HIT: { layers: [0, 40].map(at => ({ type: 'cylinder', file: 'ring_white.tga', at, duration: 200, bottom: 0.4, top: 1.6, height: 0.5,
    sideways: true, back: [0.1, 0.4], across: 0.3, z: [0.6, 1.3], alpha: 0.6, add: true })) },
  // roBrowser effect 1: the light streaks around a unit that is hit
  EF_HIT1: { wav: 'effect/ef_hit2.wav', layers: [
    lens('lens1.tga', 0, 35), lens('lens2.tga', 50, 85), lens('lens1.tga', 100, 135), lens('lens2.tga', 150, 185),
    lens('lens1.tga', 200, 235), lens('lens2.tga', 255, 290), lens('lens1.tga', 300, 335), lens('lens2.tga', 340, 360),
  ] },
  // roBrowser effect 121: Sonic Blow on the user, a flash ring and the high "zing" (roBrowser changed its
  // sound from assasin_sonicblow.wav, a run of blade sounds, to ef_stonecurse.wav)
  EF_SONICBLOW: { wav: 'effect/ef_stonecurse.wav', layers: [
    { type: 'quad', file: 'ring2.bmp', duration: 400, up: 1, from: 100, to: 300, add: true },
  ] },
  // roBrowser effect 143: Sonic Blow on the target (the 滅 / 멸 "myul" characters of sonicblow.str)
  EF_SONICBLOW2: { layers: [{ type: 'str', file: 'sonicblow.str' }] },
  // roBrowser effect 17: Magnum Break's blast, a low yellow ring and a fiery shape around the user. roBrowser
  // makes the fire a tall cone (bottom 4, top 1, 4 high); a dome of the same width is tried here instead.
  // (roBrowser also shakes the camera for 50 ms: 'quake_magnum', not done here.)
  EF_MAGNUMBREAK: { wav: 'effect/ef_magnumbreak.wav', layers: [
    { type: 'cylinder', file: 'ring_yellow.tga', duration: 300, bottom: 4, top: 6, height: 1, alpha: 0.7 },
    { type: 'dome', file: '대폭발.tga', duration: 300, radius: 4, height: 3, alpha: 0.6 },
  ] },
  // roBrowser effect 153: Improve Concentration on the user (the client's concentration.str; the client
  // also ships a near-identical ac_concentration.str, which roBrowser does not use)
  EF_CONCENTRATION: { wav: 'effect/ac_concentration.wav', layers: [{ type: 'str', file: 'concentration.str' }] },
  // roBrowser effect 11: Endure on the user, the client's endure.tga 2 cells up, shrinking from 200 to 70 px
  // (fast at first) as it fades in and out over a second
  EF_ENDURE: { wav: 'effect/ef_endure.wav', layers: [
    { type: 'quad', file: 'endure.tga', duration: 1000, up: 2, from: 200, to: 70, smooth: true, fadeIn: true },
  ] },
  // roBrowser effect 67: Provoke taking hold on the target (the client's provoke.str)
  EF_PROVOKE: { wav: 'effect/swordman_provoke.wav', layers: [{ type: 'str', file: 'provoke.str' }] },
  // roBrowser effect 10 (EF_COIN): Mammonite's coins on the target (the client's maemor.str; roBrowser's `min`
  // memor_min.str is its lighter stand-in). roBrowser plays one ef_coin2.wav as it starts; here nothing then (by
  // request), and the STR starts 50 ms in (by request: a touch later than the skill going off). The coins burst
  // out at the STR's frame 14 (230 ms) and hit the ground about frames 33–35 (550–580 ms), so the client's coin
  // clinks (ef_coin, ef_coin3, ef_coin1, ef_coin2, ef_coin) follow there, scattered, as they land (by request:
  // coins spilling on the ground; times by ear)
  EF_COIN: { layers: [{ type: 'str', file: 'maemor.str', at: 50 }],
    sounds: [[590, 'effect/ef_coin.wav'], [625, 'effect/ef_coin3.wav'], [660, 'effect/ef_coin1.wav'], [710, 'effect/ef_coin2.wav'], [770, 'effect/ef_coin.wav']] },
  // roBrowser effect 170 (EF_CARTREVOLUTION): Cart Revolution on the user as it goes off and on each one it hits
  // (the client's cartrevolution.str, with Magnum Break's sound)
  EF_CARTREVOLUTION: { wav: 'effect/ef_magnumbreak.wav', layers: [{ type: 'str', file: 'cartrevolution.str' }] },
  // roBrowser effect 311 (EF_LOUD): Crazy Uproar on each one it takes hold of (the client's loud.str, 고성방가.wav)
  EF_LOUD: { wav: 'effect/고성방가.wav', layers: [{ type: 'str', file: 'loud.str' }] },
  // roBrowser effect 66: Cure on the target (the client's cure.str)
  EF_CURE: { wav: 'effect/acolyte_cure.wav', layers: [{ type: 'str', file: 'cure.str' }] },
  // roBrowser effects 371 and 158: base and job level up (rAthena NOTIFYEFFECT_BASE_LEVEL_UP / _JOB_LEVEL_UP;
  // the client's angel.str with levelup.wav, joblvup.str)
  EF_ANGEL: { wav: 'levelup.wav', layers: [{ type: 'str', file: 'angel.str' }] },
  EF_JOBLVUP: { layers: [{ type: 'str', file: 'joblvup.str' }] },
  // roBrowser effect 372 (EF_DEVIL): one's own character down (onEntityVanish), the client's devil.str
  EF_DEVIL: { layers: [{ type: 'str', file: 'devil.str' }] },
  // roBrowser effect 312: Heal on the one healed, two pale green pillars of light rising around it and white
  // sparks drifting up (the client's _heal_effect.wav)
  // roBrowser effects 204–207: a red, orange, yellow or white potion drunk (ItemEffect 501–504)
  EF_POTION1: { layers: [{ type: 'str', file: '빨간포션.str' }] },
  EF_POTION2: { layers: [{ type: 'str', file: '주홍포션.str' }] },
  EF_POTION3: { layers: [{ type: 'str', file: '노란포션.str' }] },
  EF_POTION4: { layers: [{ type: 'str', file: '하얀포션.str' }] },
  // roBrowser effects 208, 218 and 219: a blue potion (ItemEffect 505, with 흡기.wav), a Concentration Potion
  // (645) and an Awakening Potion (656) drunk, these two with ac_concentration.wav
  EF_POTION5: { wav: 'effect/흡기.wav', layers: [{ type: 'str', file: '파란포션.str' }] },
  EF_POTION_CON: { wav: 'effect/ac_concentration.wav', layers: [{ type: 'str', file: '집중.str' }] },
  EF_POTION_AWAKENING: { wav: 'effect/ac_concentration.wav', layers: [{ type: 'str', file: '각성.str' }] },
  EF_HEAL: { wav: '_heal_effect.wav', layers: [
    { type: 'cylinder', file: 'ring_white.tga', duration: 1500, bottom: 0.95, top: 0.95, height: 8, rise: true, alpha: 0.2, color: [0.7, 1, 0.7], add: true },
    { type: 'cylinder', file: 'ring_white.tga', duration: 1500, bottom: 1, top: 1, height: 8, rise: true, alpha: 0.2, color: [0.7, 1, 0.7], add: true },
    { type: 'sparks', file: 'pok3.tga', duration: 1300, count: 15, every: 10, spread: 1.5, z0: 0, z1: [4, 8], size: [7, 11], alpha: 0.6 },
    { type: 'sparks', file: 'pok3.tga', duration: 1100, count: 7, every: 50, spread: 1, z0: [-1, 1], z1: 5, size: [7, 11], alpha: 0.6 },
  ] },
  // roBrowser effect 320: Heal hurting an undead target, the same in white, shorter, with flickering sparks
  EF_HEAL3: { wav: '_heal_effect.wav', layers: [
    { type: 'cylinder', file: 'ring_white.tga', duration: 1000, bottom: 0.95, top: 0.95, height: 10, rise: true, alpha: 0.2, add: true },
    { type: 'cylinder', file: 'ring_white.tga', duration: 1000, bottom: 1, top: 1, height: 9, rise: true, alpha: 0.2, add: true },
    { type: 'sparks', file: 'pok3.tga', duration: 1000, count: 10, every: 10, spread: 1.5, z0: 0, z1: [3, 9], size: [7, 11], alpha: 0.8, sparkle: 2 },
    { type: 'sparks', file: 'pok3.tga', duration: 900, count: 5, every: 50, spread: 1, z0: [-1, 1], z1: 6, size: [7, 11], alpha: 0.8, sparkle: 2 },
  ] },
  // roBrowser effect 37: Increase AGI on its target, thin streaks shooting up around it (three batches, 120 ms
  // apart) and the "AGI UP" picture rising. All of it is tighter, lower and shorter than roBrowser's, by eye:
  // its streaks spread ±1.5 × ±1 cells, one batch every 200 ms (its default timeBetweenDupli), rising from
  // 0–2 to 5–7 cells in 1 s, and its picture rises from 0.4 to 3 cells in 1 s.
  EF_INCAGILITY: { wav: 'effect/ef_incagility.wav', layers: [
    ...[[7, 1], [3, 0.75], [10, 1]].map(([count, alpha]) => ({ type: 'sparks', file: 'ac_center2.tga', duration: 500, count, every: 120,
      spread: 1.1, spreadY: 0.8, z0: [0, 1.5], z1: [2.5, 4], size: 2.5, h: [30, 60], alpha, fadeIn: false, normal: true, soft: true })),
    { type: 'sparks', file: 'agi_up.bmp', duration: 700, count: 1, every: 0, spread: 0, z0: 0.4, z1: 1.8, size: 100, h: 45, alpha: 1, normal: true, overlay: true },
  ] },
  // roBrowser effect 38: Decrease AGI on its target, Increase AGI's turned around: thin streaks falling around
  // it and the client's slow.bmp sinking (roBrowser: 20 streaks from 5–7 cells down to 0–2, the picture from 2.8
  // to 0.4 cells, with ef_decagility.wav). Tightened as Increase AGI's was, by eye.
  EF_DECAGILITY: { wav: 'effect/ef_decagility.wav', layers: [
    { type: 'sparks', file: 'ac_center2.tga', duration: 500, count: 20, every: 25, spread: 1.1, spreadY: 0.8, z0: [2.5, 4], z1: [0, 1.5],
      size: 2.5, h: [30, 60], alpha: 1, fadeIn: false, normal: true, soft: true },
    { type: 'sparks', file: 'slow.bmp', duration: 700, count: 1, every: 0, spread: 0, z0: 1.8, z1: 0.4, size: 100, h: 45, alpha: 1, normal: true },
  ] },
  // roBrowser effect 42: Blessing on its target, the client's 축복 ("blessing") sprite over its head, two
  // batches of twinkling particles sinking around it and a soft blue glow at its feet. The particles are
  // smaller (24 px, not 50) and the glow shorter (1.2 s, not 2.5) than roBrowser's, by eye, and the sprite
  // fades out at its end (roBrowser just stops drawing it).
  EF_BLESSING: { wav: 'effect/ef_blessing.wav', layers: [
    { type: 'spr', sprite: 'png/effect/축복', action: 0, delay: 30, duration: 1500, up: 120, fadeOut: true },
    { type: 'sparks', file: 'png/effect/particle6/frames/000.png', duration: 1200, count: 6, every: 0, spread: 1.2, spreadY: 1,
      z0: [3.5, 7.5], z1: [0.5, 1.5], size: 24, alpha: 1, sparkle: 2, normal: true },
    { type: 'sparks', file: 'png/effect/particle6/frames/000.png', duration: 1200, count: 6, every: 0, spread: 1.4, spreadY: 1.1,
      z0: [3.5, 7.5], z1: [0.5, 1.5], size: 24, alpha: 1, normal: true },
    { type: 'sparks', file: 'pok2.tga', duration: 1200, count: 1, every: 0, spread: 0, z0: 0, z1: 0, size: 140, alpha: 0.3, color: [0.1, 0.75, 1], overlay: true },
  ] },
  // Cast auras (roBrowser onEntityCastSkill → effects 12, 54–59, 454): under the caster for as long as the cast
  // (their duration is the caller's), each with ef_beginspell.wav. The client picks one by the skill's element
  // (castAura). The neutral one is a yellow cone opening upward; the elemental ones add a tall faint pillar
  // and a low ring in the element's colour; dark and undead a black cone.
  ...castAuras(),
  // roBrowser effect 60 (LockOnTarget): on the one a cast is aimed at, for as long as the cast. Drawn here as a
  // circle with two squares in it, an eight-pointed star, as the official client's (by request; roBrowser's is the
  // client's lockon128.tga: file 'lockon128.tga')
  EF_LOCKON: { layers: [{ type: 'lockon', paint: starTexture, duration: null }] },
  // roBrowser 'ef_firebolt': Fire Bolt's bolt falling onto its target from high up on the right, one for
  // every hit (the client's 불화살 "fire arrow" pictures; the 7th and 8th are not used), with one of three
  // ef_firearrow sounds. Each lands somewhere in the target's cell and starts as far off again (jitter; by
  // eye, roBrowser brings every one down on the feet).
  EF_FIREBOLT: { wav: [1, 2, 3].map(i => `effect/ef_firearrow${i}.wav`), layers: [
    { type: 'fall', files: [1, 2, 3, 4, 5, 6].map(i => `불화살${i}.tga`), delay: 30, duration: null, size: [100, 50],
      x: [4, 6], y: [1, 3], z: 20, jitter: 0.4 },
  ] },
  // roBrowser effect 49 (EF_FIREHIT): a fire bolt (or Fire Wall) hitting, one of the client's three firehit STRs
  EF_FIREHIT: { wav: 'effect/ef_firehit.wav', layers: [{ type: 'str', file: ['firehit1.str', 'firehit2.str', 'firehit3.str'] }] },
  // roBrowser effect 25 (EF_FIREWALL): one cell of a Fire Wall, the client's firewall1 or firewall2 STR
  // burning over and over for as long as the cell lasts (the caller's duration, or until stopped)
  EF_FIREWALL: { wav: 'effect/ef_firewall.wav', layers: [{ type: 'str', file: ['firewall1.str', 'firewall2.str'], loop: true, duration: null }] },
  // roBrowser effect 513 (EF_GROUNDSAMPLE, its MagicTarget): the cell a ground skill is being cast on, for
  // as long as the cast (Fire Wall's is one cell across)
  EF_GROUNDSAMPLE: { layers: [{ type: 'ground', file: 'magic_target.tga', size: 1, spin: 40, duration: null }] },
  // A map's own effects (RSW effect objects, by request: scripts/map2gltf.py MAP_EFFECTS), going on as long as the
  // floor is shown. roBrowser effect 47 (EF_TORCH): the client's torch_01.spr over and over: its flame (pictures
  // 2～7, 100 ms each) over a faint yellow glow (picture 0, scaled up 8 times, alpha 35/255), on the cup of the torch
  // stand the map puts there (내부소품/대기실횃불.rsm, 2 cells tall, its foot a third of a cell above the effect's
  // place); drawn at 3/8 of the sprite's size; heights and sizes by eye (roBrowser: 0.8 up)
  EF_TORCH: { layers: [
    { type: 'quad', file: 'png/effect/torch_01/frames/000.png', from: 180, to: 180, up: 2.5, add: true, color: [1 * 0.14, 0.95 * 0.14, 0.3 * 0.14], depth: true, duration: null },
    { type: 'quad', files: [2, 3, 4, 5, 6, 7].map(i => `png/effect/torch_01/frames/00${i}.png`), delay: 100,
      from: 48, to: 48, up: 2.6, depth: true, duration: null }] },
  // roBrowser effect 109 (EF_BUBBLE): one of the client's bubble1～4.str at random, over and over (under the sea)
  EF_BUBBLE: { layers: [{ type: 'str', file: ['bubble1.str', 'bubble2.str', 'bubble3.str', 'bubble4.str'], loop: true, duration: null }] },
  // roBrowser effect 110 (EF_GASPUSH): the ant hell's gas, the client's gaspush.str over and over
  EF_GASPUSH: { layers: [{ type: 'str', file: 'gaspush.str', loop: true, duration: null }] },
  // roBrowser effect 44 (EF_SMOKE): a chimney's smoke, the client's 굴뚝연기.spr, a puff every second rising for
  // 10 s, drifting off, growing from 70 to 300 px and fading out (roBrowser's posz 0 → 20, posxEndRand 3: here 6
  // cells up and 1.5 cells off, by eye)
  EF_SMOKE: { layers: [{ type: 'sparks', file: 'png/effect/굴뚝연기/frames/000.png', count: 10, every: 1000, duration: 10000,
                         size: 70, size1: 300, spread: 0, z0: 0, z1: 6, out: 1.5, alpha: 0.8, fadeIn: false, normal: true, repeat: true }] },
  // roBrowser 'ef_coldbolt': Cold Bolt's bolt, the client's icearrow.tga (50 px, not additive) falling as Fire
  // Bolt's does, with one of three ef_icearrow sounds, and a blue ring widening flat on the ground under the
  // target (roBrowser delays it by delayLate 500, which applies to repeats only). Each bolt lands somewhere in
  // the target's cell, as Fire Bolt's do, and its ring widens around where it lands (land; by eye, roBrowser
  // centres every ring on the feet). The ring is half roBrowser's
  // size, by eye (its radius grows from 3 to 5 cells there).
  EF_COLDBOLT: { wav: [1, 2, 3].map(i => `effect/ef_icearrow${i}.wav`), layers: [
    { type: 'fall', files: ['icearrow.tga'], delay: 1000, duration: null, size: [50, 50], x: [4, 6], y: [1, 3], z: 20, jitter: 0.4, normal: true },
    { type: 'cylinder', file: 'ring_blue.tga', duration: 1000, bottom: 1.5, top: 2.5, height: 0.1, alpha: 0.7, land: true },
  ] },
  // A Cold Bolt hitting: roBrowser effect 51 (EF_COLDHIT) is only a sound, one of the client's _hit_fist3/4
  // (its ice.tga burst is commented out: that picture is a square of frosty cloud, not shards). The client's
  // icecrash.str (roBrowser effect 135, EF_ICECRASH) bursts on the target here at half its size and half its
  // brightness (five of them overlap), by eye.
  EF_COLDHIT: { wav: ['_hit_fist3.wav', '_hit_fist4.wav'], layers: [{ type: 'str', file: 'icecrash.str', scale: 0.5, alpha: 0.5 }] },
  // roBrowser effect 29 (EF_LIGHTBOLT): Lightning Bolt's bolt, the client's lightning.str (rings gathering
  // from 580 ms in, the strike about 880 ms in, 2150 ms in all) on the target, with one of the client's
  // ef_lightbolt sounds (roBrowser gives it none, and a wind burst too, which here comes with the hit)
  // Each bolt strikes somewhere in the target's cell and half of them are mirrored, so they do not all come
  // down alike (jitter, flip; by eye, roBrowser plays one on the feet). They add up where they overlap, each
  // at 0.5 of its brightness (by eye; roBrowser 1).
  // (`ground`: depth-tested, walls and models before it hide it, the floor not: by request, strMesh)
  EF_LIGHTNINGBOLT: { wav: [1, 2, 3].map(i => `effect/ef_lightbolt${i}.wav`), layers: [
    { type: 'str', file: 'lightning.str', jitter: 0.2, flip: true, alpha: 0.5, ground: true },
  ] },
  // roBrowser effect 30 (EF_THUNDERSTORM): one of Thunderstorm's bolts, the client's thunderstorm.str on the
  // ground (the strike about 250 ms in), with magician_thunderstorm.wav; its bolts add up where they overlap,
  // each at 0.7 of its brightness (by eye; roBrowser 1)
  EF_THUNDERSTORM: { wav: 'effect/magician_thunderstorm.wav', layers: [{ type: 'str', file: 'thunderstorm.str', alpha: 0.7 }] },
  // roBrowser effect 52 (EF_WINDHIT): a wind spell hitting, one of the client's three windhit STRs with one of
  // _hit_fist1–3; overlapping ones (a burst for every hit) do not add up in brightness (max; by eye)
  EF_WINDHIT: { wav: [1, 2, 3].map(i => `_hit_fist${i}.wav`), layers: [{ type: 'str', file: ['windhit1.str', 'windhit2.str', 'windhit3.str'], max: true }] },
  // roBrowser effect 41 (EF_ANGELUS): Angelus taking hold on each one, the client's angelus.str (a bell ringing
  // over it, then feathers) with ef_angelus.wav. roBrowser plays it at the head; here at the feet, as the STR
  // puts the bell well above them. The sound's ding comes 1.65 s into it and the bell starts to glow at the
  // STR's frame 117 (1.95 s), its ring and feathers bursting out about 2.1 s in; the sound starts 500 ms late
  // so the ding comes with that burst (by eye; roBrowser: with the STR).
  EF_ANGELUS: { wav: 'effect/ef_angelus.wav', wavDelay: 500, layers: [{ type: 'str', file: 'angelus.str' }] },
  // roBrowser effect 84 (EF_IMPOSITIO): Impositio Manus taking hold on each one, the client's impositio.str with
  // priest_impositio.wav
  EF_IMPOSITIO: { wav: 'effect/priest_impositio.wav', layers: [{ type: 'str', file: 'impositio.str' }] },
  // roBrowser effect 88 (EF_SUFFRAGIUM): Suffragium taking hold on each one, the client's suffragium.str with
  // priest_suffragium.wav
  EF_SUFFRAGIUM: { wav: 'effect/priest_suffragium.wav', layers: [{ type: 'str', file: 'suffragium.str' }] },
  // roBrowser effect 75 (EF_GLORIA): Gloria taking hold on each one, the client's gloria.str with priest_gloria.wav
  EF_GLORIA: { wav: 'effect/priest_gloria.wav', layers: [{ type: 'str', file: 'gloria.str' }] },
  // roBrowser effect 112 (EF_KYRIE): Kyrie Eleison going on, the client's kyrie.str with priest_kyrie_eleison_a.wav
  // (roBrowser's note: _b on the target; one sound here, on the one it goes on)
  EF_KYRIE: { wav: 'effect/priest_kyrie_eleison_a.wav', layers: [{ type: 'str', file: 'kyrie.str' }] },
  // roBrowser effects 606, 607: Pang Voice's and Wink of Charm's sprites on whom they are used on
  EF_FVOICE: { wav: 'amon_ra_die01.wav', layers: [{ type: 'spr', sprite: 'png/effect/fvoice', action: 0, duration: 800, up: 100 }] },
  EF_WINK: { layers: [{ type: 'spr', sprite: 'png/effect/wink', action: 0, duration: 800, up: 100 }] },
  // the bard's and the dancer's songs on the ground while they play, following the player cell by cell (roBrowser
  // Songs.js: on each cell of it a HoveringTexture, alpha 0.7, and a FlatColorTile of its colour, left out here by request;
  // 278–294 otherwise only their sound); 7×7, or 9×9 for an ensemble. Each cell's picture rises a little fading in as it
  // comes into reach and sinks a little fading out as it leaves, gone before it reaches the ground (by request), all of
  // them so as it starts and ends. The picture stands facing the camera, added on, as big as its pixels (TILE_PX a cell),
  // as in the client's screenshots (by request; roBrowser lays it flat, 1 cell across, 2 for the apple): TILE_PX by eye, a
  // note against a figure as big as there; the bigger pictures smaller by eye (by request): the heart 0.6, zz 0.42, pocket
  // and twirl 0.35, the apple 0.55, safeline 0.27 (its squiggle a cell and a half across, as in its screenshot). A lens
  // (LENS) as in Slow Grace's screenshot: four on each cell standing upright each turned its own way, not facing the camera
  // (`planes`), anywhere in the cell, a cell across and up to 2.8 cells high, its white middle a little under the ground
  // (PLANE_SINK) and the rest of its lower half too, squashed down and up from there instead of hovering (`ground`; by
  // request), alpha 0.21 (by request fainter)
  ...Object.fromEntries(Object.entries({
    BA_DISSONANCE: [null, ['lens_w'], [1, 1, 1], LENS], DC_UGLYDANCE: [null, ['lens_w'], [1, 1, 1], LENS], BA_WHISTLE: ['달빛세레나데', ['melody_b'], [1, 0.75, 0.8]], BA_ASSASSINCROSS: ['석양의 어쌔신', ['lens_r'], [1, 0.8, 0.85], LENS],
    BA_POEMBRAGI: ['브라기의 시', [1, 2, 3, 4, 5, 6, 7, 8].map(i => 'spell_0' + i), [0.61, 0.61, 1], { alpha: 0.61, color: [0.61, 0.61, 1] }], BA_APPLEIDUN: ['이둔의 사과', ['idun_apple'], [1, 1, 0], { size: 0.55 }],
    DC_HUMMING: ['흥얼거림', ['melody_a'], [0.9, 0.82, 0.82]], DC_DONTFORGETME: ['나를잊지말아요', ['lens_g'], [0.11, 1, 0.45], LENS], DC_FORTUNEKISS: ['행운의', ['heart_2'], [0.99, 0.44, 0.4], { size: 0.6 }], DC_SERVICEFORYOU: ['당신을 위한 서비스', ['safeline'], [1, 0.5, 0.72], { size: 0.27 }],
    BD_LULLABY: ['자장가', ['zz'], [0.93, 0.62, 1], { size: 0.42 }], BD_RICHMANKIM: ['김서방돈', ['pocket'], [0.99, 0.78, 0.78], { size: 0.35 }], BD_ETERNALCHAOS: ['영원의 혼돈', ['lens_g'], [0.5, 1, 0.76], LENS], BD_DRUMBATTLEFIELD: ['전장의', ['melody_b'], [0.93, 0.4, 0.99]],
    BD_RINGNIBELUNGEN: ['니벨룽겐의 반지', ['twirl'], [0.11, 0.93, 1], { size: 0.35 }], BD_ROKISWEIL: ['로키', ['safeline'], [0.86, 0.4, 0.99], { size: 0.27 }], BD_INTOABYSS: ['심연속으로', ['레드젬스톤', '옐로우젬스톤', '블루젬스톤'], [1, 1, 1]], BD_SIEGFRIED: ['불사신', ['lens_b'], [0.28, 0.23, 1], LENS],
  }).map(([name, [wav, files, , o = {}]]) => {  // (the third: the ground's colour, roBrowser's, not shown)
    const radius = name.startsWith('BD_') ? 4 : 3;
    // (its music, `music`, not played with it: one at a time, stage.js songMusic)
    return ['EF_SONG_' + name, { ...wav && { music: `effect/${wav}.wav` }, layers: [
      // (the odd and the even ones hover opposite ways, each cell its file of the list)
      ...files.flatMap((f, k) => [0, 1].map(odd => ({ type: 'tiles', radius, file: f + '.bmp', odd, of: [k, files.length], alpha: 0.7, ...o }))),
      // (a song's or a dance's cells where another of its kind is too: Unchained Serenade's or Hip Shaker's streaks there
      // instead, both lens_w, as the client shows the unit turned into one: sim.js songClash, `fx.clash`)
      ...!name.startsWith('BD_') && name !== 'BA_DISSONANCE' && name !== 'DC_UGLYDANCE'
        ? [0, 1].map(odd => ({ type: 'tiles', radius, file: 'lens_w.bmp', odd, ...LENS, clash: true })) : [],
    ] }];
  })),
  // roBrowser effect 76 (EF_MAGNIFICAT): Magnificat taking hold on each one, the client's magnificat.str with
  // priest_magnificat.wav
  EF_MAGNIFICAT: { wav: 'effect/priest_magnificat.wav', layers: [{ type: 'str', file: 'magnificat.str' }] },
  // roBrowser effect 85 (EF_LEXAETERNA): Lex Aeterna on its target, the client's lexaeterna.str with
  // priest_lexaeterna.wav
  EF_LEXAETERNA: { wav: 'effect/priest_lexaeterna.wav', layers: [{ type: 'str', file: 'lexaeterna.str' }] },
  // roBrowser effect 78 (EF_RECOVERY): Status Recovery on its target, the client's recovery.str with priest_recovery.wav
  EF_RECOVERY: { wav: 'effect/priest_recovery.wav', layers: [{ type: 'str', file: 'recovery.str' }] },
  // roBrowser effect 136 (EF_SLOWPOISON): Slow Poison on its target, the client's slowp.str with priest_slowpoison.wav; its
  // glow rings (ring_b.bmp) run past their picture's edges, which showed as squares: faded out toward them (by request,
  // soft; as Counter Attack's)
  EF_SLOWPOISON: { wav: 'effect/priest_slowpoison.wav', layers: [{ type: 'str', file: 'slowp.str', soft: ['ring_b.bmp'] }] },
  // roBrowser effect 77 (EF_RESURRECTION): Resurrection on its target, the client's resurrection.str with
  // priest_resurrection.wav
  EF_RESURRECTION: { wav: 'effect/priest_resurrection.wav', layers: [{ type: 'str', file: 'resurrection.str' }] },
  // roBrowser effect 91 (EF_BENEDICTIO): B.S. Sacramenti on each one it takes hold of, the client's benedictio.str with
  // priest_benedictio.wav
  EF_BENEDICTIO: { wav: 'effect/priest_benedictio.wav', layers: [{ type: 'str', file: 'benedictio.str' }] },
  // roBrowser effect 86 (EF_ASPERSIO): Aspersio on its target, the client's aspersio.str with priest_aspersio.wav
  EF_ASPERSIO: { wav: 'effect/priest_aspersio.wav', layers: [{ type: 'str', file: 'aspersio.str' }] },
  // roBrowser effect 83 (EF_SANCTUARY): Sanctuary going down, the client's sanctuary.str where it is cast, with
  // priest_sanctuary.wav
  EF_SANCTUARY: { wav: 'effect/priest_sanctuary.wav', layers: [{ type: 'str', file: 'sanctuary.str' }] },
  // roBrowser effect 113 (EF_MAGNUS): Magnus Exorcismus going down, the client's magnus.str where it is cast, with
  // priest_magnus.wav
  EF_MAGNUS: { wav: 'effect/priest_magnus.wav', layers: [{ type: 'str', file: 'magnus.str' }] },
  // roBrowser effect 318 (EF_BOTTOM_MAG, each Magnus Exorcismus cell): as Sanctuary's (below), of ring_red.tga untinted,
  // 5 high, at alpha 0.2 and 0.1
  EF_BOTTOM_MAG: { layers: [
    { type: 'cylinder', file: 'ring_red.tga', duration: null, sides: 4, angleY: 45, still: true, bottom: 0.7, top: 0.7, height: 5,
      fixed: true, fadeMs: 300, alpha: 0.2, add: true },
    { type: 'cylinder', file: 'ring_red.tga', duration: null, cycle: 2000, every: 2000, copies: 1, sides: 4, angleY: 45, still: true,
      bottom: 0.7, top: 0.7, height: 5, rise: true, alpha: 0.1, add: true },
  ] },
  // roBrowser effect 319 (EF_BOTTOM_SANC, each Sanctuary cell): a square column of magic_green.tga (4 sides, turned
  // 45°: the cell's edges) 0.7 cells out and 2 high, pale green, additive, not spinning — one at alpha 0.3 while it lies
  // there (popping on and off in roBrowser; fading over 300 ms here, as Safety Wall's), and one at 0.1 rising over its
  // first second, fading in and out, over again every 2 s
  EF_BOTTOM_SANC: { layers: [
    { type: 'cylinder', file: 'magic_green.tga', duration: null, sides: 4, angleY: 45, still: true, bottom: 0.7, top: 0.7, height: 2,
      fixed: true, fadeMs: 300, color: [0.5, 0.9, 0.5], alpha: 0.3, add: true },
    { type: 'cylinder', file: 'magic_green.tga', duration: null, cycle: 2000, every: 2000, copies: 1, sides: 4, angleY: 45, still: true,
      bottom: 0.7, top: 0.7, height: 2, rise: true, color: [0.5, 0.9, 0.5], alpha: 0.1, add: true },
  ] },
  // roBrowser effect 22 (EF_SIGHT): Sight's fireballs, ten copies of the client's 이팩트/sight.spr (its frames
  // every 96 ms, converted with spr2png.py) going round the user 3 cells out and 2 up (by eye; roBrowser 4),
  // clockwise, 10 turns in its 12.2 s (here at that speed for as long as the status lasts), each with a shadow on
  // the ground, with ef_sight.wav. Copy i lags 0.9 − 0.1 × i quarter turns, so the last leads and the first
  // trails; roBrowser sizes them 60 + 20 × i (shadows 30 + 10 × i), its sprite px times the frame's 64 — here
  // the leader is drawn at 1.5 × the sprite's own 64 px and the rest scaled down with it (sizes × 96 / 240; by
  // eye, first × 64 / 240). Alpha 123/255 + 3/255 × i, shadows 0.5, blendMode 8 (alpha blending).
  EF_SIGHT: { wav: 'effect/ef_sight.wav', layers: [{ type: 'orbit', files: [0, 1, 2, 3, 4].map(i => `png/effect/sight/frames/00${i}.png`),
    delay: 96, duration: null, n: 10, radius: 3, up: 2, spin: 3.5 * 10 * 100 / 12200, lag: 0.9, lagStep: -0.1,
    size: 60 * 96 / 240, sizeStep: 20 * 96 / 240, alpha: 123 / 255, alphaStep: 3 / 255,
    shadow: { size: 30 * 96 / 240, sizeStep: 10 * 96 / 240, alpha: 0.5 }, ...ORBIT_INOUT }] },
  // roBrowser effect 62 (EF_SIGHTRASHER): Sightrasher's fireballs, the client's 이팩트/sight.spr (its frames every 96 ms)
  // flying out from the user eight ways, 8 cells in 800 ms, 4 of each 100 ms apart, growing 20 → 260 (shadows 60 → 160),
  // alpha 123/255 + 3/255 a copy (shadows 0.5), fading in and out; sized and raised as Sight's are (× 96 / 240, posZ 2 → 1).
  // roBrowser gives it no sound: the client's wizard_sightrasher.wav (by ear)
  // (by request, it sets off once Sight's fireballs have spiralled in to the user: SIGHT_COLLAPSE ms, stage.js)
  EF_SIGHTRASHER: { wav: 'effect/wizard_sightrasher.wav', layers: [{ type: 'burst', files: [0, 1, 2, 3, 4].map(i => `png/effect/sight/frames/00${i}.png`),
    at: SIGHT_COLLAPSE, delay: 96, ways: 8, reach: 8, life: 800, copies: 4, every: 100, up: 1, from: 20 * 96 / 240, to: 260 * 96 / 240,
    alpha: 123 / 255, alphaStep: 3 / 255, shadow: { from: 60 * 96 / 240, to: 160 * 96 / 240, alpha: 0.5 } }] },
  // roBrowser effect 92 (EF_METEORSTORM): a meteor falling, one of the client's meteor1–4.str at random with
  // wizard_meteor.wav (and a camera quake 600 ms in, not done here)
  EF_METEOR: { wav: 'effect/wizard_meteor.wav', layers: [{ type: 'str', file: ['meteor1.str', 'meteor2.str', 'meteor3.str', 'meteor4.str'] }] },
  // roBrowser effect 90 (EF_LORD): Lord of Vermilion, the client's lord.str where it is cast, with wizard_fire_ivy.wav
  // roBrowser effect 89 (EF_STORMGUST): Storm Gust, the client's stormgust.str (4.2 s) where it is cast, with
  // wizard_stormgust.wav (roBrowser's `min`, storm_min.str, is its low-detail one)
  EF_STORMGUST: { wav: 'effect/wizard_stormgust.wav', layers: [{ type: 'str', file: 'stormgust.str' }] },
  EF_LORD: { wav: 'effect/wizard_fire_ivy.wav', layers: [{ type: 'str', file: 'lord.str' }] },
  // roBrowser effect 33 (EF_RUWACH): Ruwach's orbs, ten copies of the client's 이팩트/particle2.spr (a pale blue
  // star; converted with spr2png.py) tinted cyan (red 0) and drawn additively, going round the user 3 cells out
  // and 1 up (roBrowser 2; halved as Sight's is), clockwise, 8 turns in 12.2 s (here at that speed for as long as
  // the status lasts), with Soul Strike's ef_soulstrike.wav (roBrowser's ef_ruwach.wav sounds electric: by
  // request; su_svg_spirit.wav before it). Copy i lags 0.7 − 0.1 × i quarter turns; roBrowser sizes them
  // 80 + 30 × i, alpha 0.07 + 0.07 × i — here the leader is drawn at 1.2 × the sprite's own 64 px and the rest
  // scaled down with it (sizes × 1.2 × 64 / 350), each 1.2 × as bright (by eye; at first × 64 / 350 and roBrowser's
  // alpha). roBrowser's shadows for them (0.4 + 0.15 × i px) are too small to see: none.
  EF_RUWACH: { wav: 'effect/ef_soulstrike.wav', layers: [{ type: 'orbit', files: ['png/effect/particle2/frames/000.png'],
    delay: 1000, duration: null, n: 10, radius: 3, up: 1, spin: 3.5 * 8 * 100 / 12200, lag: 0.7, lagStep: -0.1,
    size: 1.2 * 80 * 64 / 350, sizeStep: 1.2 * 30 * 64 / 350, alpha: 1.2 * 0.07, alphaStep: 1.2 * 0.07, add: true, color: [0, 1, 1], ...ORBIT_INOUT }] },
  // roBrowser effect 40 (EF_SIGNUM): Signum Crucis on its user, the client's cross.str with ef_signum.wav
  EF_SIGNUM: { wav: 'effect/ef_signum.wav', layers: [{ type: 'str', file: 'cross.str' }] },
  // an emote over the unit's head (clif_emotion): the client's emotion.spr, the action play is given (EMOTE_ACTION),
  // once through its frames at the act's own delay (roBrowser's emotion attachment)
  EF_EMOTE: { layers: [{ type: 'spr', sprite: 'png/effect/emotion', action: 'play', once: true, duration: 60000, up: 'head' }] },
  // (one that stays: played over and over until it is stopped; game.js's leader with points to spend, by request)
  EF_EMOTE_LOOP: { layers: [{ type: 'spr', sprite: 'png/effect/emotion', action: 'play', duration: Infinity, up: 'head' }] },
  // Hiding and coming out of it (not in roBrowser, which only stops drawing the unit; by request): the client's
  // ef_hiding.wav (at full volume; it was 30% at first), a few faint thin streaks shooting down (going in) or up (coming
  // out; the other way round at first), and a faint ring of dust puffs spreading on the ground (dust1.bmp) — as the
  // unit sinks out of sight, or comes back up. The unit's own sinking, rising and fade are sandbox.js' (HIDE_MS,
  // UNHIDE_MS); the dust of coming out waits for it.
  EF_HIDE: { wav: 'effect/ef_hiding.wav', layers: [
    { type: 'sparks', file: 'ac_center2.tga', duration: 300, count: 5, every: 30, spread: 0.6, spreadY: 0.4, z0: [1.8, 2.6], z1: [0, 0.8],
      size: 2, h: [25, 45], alpha: 0.35, fadeIn: false, normal: true, soft: true },
    { type: 'ripple', file: 'dust1.bmp', duration: 500, count: 8, r0: 0.2, r1: 0.9, up: 0.15, from: 18, to: 34, alpha: 0.3 },
  ] },
  EF_UNHIDE: { wav: 'effect/ef_hiding.wav', layers: [
    { type: 'sparks', file: 'ac_center2.tga', duration: 250, count: 5, every: 20, spread: 0.6, spreadY: 0.4, z0: [0, 0.8], z1: [1.8, 2.6],
      size: 2, h: [25, 45], alpha: 0.35, fadeIn: false, normal: true, soft: true },
    { type: 'ripple', file: 'dust1.bmp', at: 200, duration: 500, count: 8, r0: 0.2, r1: 0.9, up: 0.15, from: 18, to: 34, alpha: 0.3 },
  ] },
  // roBrowser effect 152 (EF_HOLYHIT): Holy Light hitting, the client's holyhit.str. roBrowser gives it no
  // sound and the client has none named for it; here a critical hit's "pa", ef_hit2.wav (by ear)
  EF_HOLYHIT: { wav: 'effect/ef_hit2.wav', layers: [{ type: 'str', file: 'holyhit.str' }] },
  // Turn Undead hitting: roBrowser's hitEffectId 152, Holy Light's holyhit.str, with the client's own
  // priest_turn_undead.wav (roBrowser has no sound for it)
  EF_TURNUNDEAD: { wav: 'effect/priest_turn_undead.wav', layers: [{ type: 'str', file: 'holyhit.str' }] },
  // roBrowser effect 15 (EF_SOULSTRIKE): one of Soul Strike's spirits, the client's pok3.tga (50 px) flying from
  // the caster to the target, one for every hit, with ef_soulstrike.wav. roBrowser starts each 5–11 cells up
  // over the caster and adds particle1 sprites arcing around it (retreat 3, arc 4); here each leaves from
  // about the caster's chest and homes in like a missile: off backward and outward at random, then round in
  // an arc onto the target, a tapering tail behind it (by eye), without the sprites.
  EF_SOULSTRIKE: { wav: 'effect/ef_soulstrike.wav', layers: [
    { type: 'shot', file: 'pok3.tga', size: 50, z0: [0.8, 1.6], z1: 0.8, back: [7, 10], side: 8, lift: [0, 3],
      tail: 10, tailStep: 0.02, duration: null },
  ] },
  // roBrowser effect 24 (EF_FIREBALL): Fire Ball's ball of fire, the client's 이팩트/fireball.spr (its six frames
  // every 96 ms, converted with spr2png.py), flying from the caster to the target, turned to point the way it
  // flies, with ef_fireball.wav; roBrowser sends five copies 40 ms apart, each 0.2 fainter than the one ahead
  // (alphaMax 0.2 + 0.2 × i), each in 250 ms (the sandbox's flight: SKILL_EFFECTS' fly). Its size 200 is drawn
  // here as 1.5 × the sprite's own 64 px (by eye, as Sight's), from 1.2 cells up to 0.8 on the target.
  EF_FIREBALL: { wav: 'effect/ef_fireball.wav', layers: [
    { type: 'shot', files: [0, 1, 2, 3, 4, 5].map(i => `png/effect/fireball/frames/00${i}.png`), delay: 96, size: 96,
      z0: 1.2, z1: 0.8, point: true, tail: 4, tailStep: 0.16, tailAlpha: 0.2, duration: null },
  ] },
  // roBrowser effect 18 (EF_STEAL): a successful Steal, seven pok1.tga sparks bursting from the target's middle
  // (3 cells up) out to random spots up to 3.5 cells off and 1 up or down, shrinking from 200 px to 10 and
  // fading out over 500 ms, tinted 1, 1, 0.85, with ef_steal.wav
  EF_STEAL: { wav: 'effect/ef_steal.wav', layers: [
    { type: 'sparks', file: 'pok1.tga', duration: 500, count: 7, every: 0, spread: 0, z0: 3, z1: [2, 4], out: 3.5, size: 200, size1: 10,
      alpha: 1, fadeIn: false, color: [1, 1, 0.85] },
  ] },
  // roBrowser effects 20 (EF_PATTACK) and 21 (EF_DETOXICATION): Envenom's hit and Detoxify, ten pok1.tga sparks
  // rising from the feet to 5 cells up over 1 s, one every 200 ms (the default timeBetweenDupli), up to a cell off
  // either way, 80–120 px, fading in and out; pink (1, 0.7, 1) for Envenom, cyan (0.7, 1, 1) for Detoxify; both
  // with ef_detoxication.wav
  ...Object.fromEntries([['EF_PATTACK', [1, 0.7, 1]], ['EF_DETOXICATION', [0.7, 1, 1]]].map(([name, color]) => [name, {
    wav: 'effect/ef_detoxication.wav', layers: [{ type: 'sparks', file: 'pok1.tga', duration: 1000, count: 10, every: 200, spread: 1,
      z0: 0, z1: 5, size: [80, 120], alpha: 1, color }] }])),
  // Enchant Poison: roBrowser's effect 20 as Envenom's (EF_PATTACK), but with the skill's own sound, which roBrowser
  // leaves commented out (assasin_enchantpoison.wav, the client's)
  EF_ENCHANTPOISON: { wav: 'effect/assasin_enchantpoison.wav', layers: [{ type: 'sparks', file: 'pok1.tga', duration: 1000, count: 10,
    every: 200, spread: 1, z0: 0, z1: 5, size: [80, 120], alpha: 1, color: [1, 0.7, 1] }] },
  // Sand Attack's hit: roBrowser has nothing for its effect 310 (EF_SPRINKLESAND); here a spray of faint dust
  // puffs (dust1.bmp, as Hiding's) thrown onto the target from the attacker's side (by request; first dust.str)
  EF_SANDATTACK: { layers: [
    { type: 'spray', file: 'dust1.bmp', duration: 450, count: 9, back: [0.6, 1], spread: 35, dist: [1.2, 1.8], up: [0.3, 1.2],
      from: 16, to: 34, alpha: 0.35 },
  ] },
  // roBrowser effect 308 (EF_THROWITEM3): Stone Fling's stone, the client's item picture of a Stone (돌.bmp),
  // 20 px, flying from the user to the target in 200 ms (the sandbox's flight), turning half a turn on the way
  EF_THROWSTONE: { layers: [
    { type: 'shot', file: '../유저인터페이스/item/돌.bmp', size: 20, z0: 1, z1: 1, roll: 180, normal: true, duration: null },
  ] },
  // roBrowser effect 600 (EF_THROWITEM6): Throw Venom Knife's knife, the client's item picture of a Venom Knife
  // (베넘나이프.bmp), 30 px, flying from the user to the target in 200 ms, turning a whole turn on the way
  EF_THROWITEM6: { layers: [
    { type: 'shot', file: '../유저인터페이스/item/베넘나이프.bmp', size: 30, z0: 1, z1: 1, roll: 360, normal: true, duration: null },
  ] },
  // roBrowser effects 151 (EF_SPEARBMRSELF), ef_spear_projectile and 80 (EF_SPEARBMR): Spear Boomerang going off,
  // the client's spearboomerang.str on the user with knight_spear_boomerang.wav; its spear, the client's 이팩트/창.spr
  // (converted with spr2png.py; the sprite's own 180° turn, its head foremost), flying from the user to the
  // target (the sandbox's flight: 140 ms, roBrowser's) 1 cell up, drawn as its 10 × 108 px; its hit
  // ef_fireball.wav alone (roBrowser's 80 has nothing else)
  EF_SPEARBMRSELF: { wav: 'effect/knight_spear_boomerang.wav', layers: [{ type: 'str', file: 'spearboomerang.str' }] },
  EF_SPEARBOOMERANG: { layers: [
    { type: 'shot', files: ['png/effect/창/frames/000.png'], delay: 1000, size: [10, 108], angle: 180, z0: 1, z1: 1, point: true, duration: null },
  ] },
  EF_SPEARBMR: { wav: 'effect/ef_fireball.wav', layers: [] },
  // roBrowser's ef_shield_projectile and effect 249 (EF_SHIELDBOOMERANG): Shield Boomerang's shield, the client's
  // shield_boomerang.bmp 50 px, flying from the user to the target in 140 ms 1 cell up, turning a whole turn on the way;
  // its hit cru_shield boomerang.wav alone
  EF_SHIELD_PROJECTILE: { layers: [
    { type: 'shot', file: 'shield_boomerang.bmp', size: 50, z0: 1, z1: 1, roll: 360, normal: true, duration: null },
  ] },
  EF_SHIELDBOOMERANG: { wav: 'effect/cru_shield boomerang.wav', layers: [] },
  // roBrowser effect 298 (EF_THROWITEM): Acid Terror's bottle, the client's item picture of an Acid Bottle (염산병.bmp),
  // 30 px, flying from the user to the target in 300 ms (roBrowser's duration, the sandbox's flight) turning half a turn
  // (by request: thrown in an arc, BOTTLE_ARC cells high, breaking on the one hit: EF_ACIDBOTTLE_HIT)
  EF_THROWITEM: { layers: [
    { type: 'shot', file: '../유저인터페이스/item/염산병.bmp', size: 30, z0: 1, z1: 1, arc: BOTTLE_ARC, roll: 180, normal: true, duration: null },
  ] },
  // roBrowser effect 302 (EF_DEMONSTRATION): Bomb's fire, the client's 이팩트/데몬스트레이션.spr (converted with
  // spr2png.py), its one action looping on the cell for as long as the fire lasts, in the scene (by request on each cell
  // of its 3×3, smaller: stage.js bomb; roBrowser one on its cell)
  EF_DEMONSTRATION: { layers: [{ type: 'spr', sprite: 'png/effect/데몬스트레이션', action: 0, duration: null, depth: true }] },
  // the same on each cell of the 3×3 (stage.js bomb): without the sprite's first layer, the tall flame stood on top of
  // the other three (by request: on nine cells it looked like fire stacked on fire)
  EF_DEMONSTRATION_CELL: { layers: [{ type: 'spr', sprite: 'png/effect/데몬스트레이션', action: 0, duration: null, depth: true, skip: [0] }] },
  // the alchemist's other bottles (by request; roBrowser throws none of them), thrown as Acid Terror's, from the user in
  // 300 ms (sim.js flight): Bomb's Fire Bottle (화염병.bmp), Bio Cannibalize's Plant Bottle (식인식물병.bmp) and Sphere
  // Mine's Marine Sphere Bottle (기뢰병.bmp) to the ground of the cell, Aid Potion's potion of its level (빨간포션 to
  // 파란포션.bmp) to the one of the party (the client's item pictures)
  ...Object.fromEntries([['화염병', 'EF_THROWFIREBOTTLE', 0.1], ['식인식물병', 'EF_THROWPLANTBOTTLE', 0.1], ['기뢰병', 'EF_THROWMINEBOTTLE', 0.1],
    ...['빨간포션', '주홍포션', '노란포션', '하얀포션', '파란포션'].map((pic, i) => [pic, `EF_THROWPOTION${i + 1}`, 1])].map(([pic, name, z1]) => [name,
    { layers: [{ type: 'shot', file: `../유저인터페이스/item/${pic}.bmp`, size: 30, z0: 1, z1, arc: BOTTLE_ARC, roll: 180, normal: true, duration: null }] }])),
  // and where each breaks (by request; none in the client, the shards drawn here): the glass breaking (the client's
  // wav/glass.wav), BOTTLE_SHARDS bursting out and dropping; Bomb's with the fire going up (Fire Wall's ef_firewall.wav,
  // 150 ms on), Acid Terror's with poison.str splashing on the one hit (the green of Envenom's), Aid Potion's with the
  // potion's own effect as one drunk (EF_POTION1～5, stage.js)
  EF_BOTTLE_BREAK: { wav: '_frozen_explosion.wav', layers: BOTTLE_SHARDS },
  EF_FIREBOTTLE_LAND: { wav: '_frozen_explosion.wav', sounds: [[150, 'effect/ef_firewall.wav']], layers: BOTTLE_SHARDS },
  EF_ACIDBOTTLE_HIT: { wav: '_frozen_explosion.wav', layers: [...BOTTLE_SHARDS, { type: 'str', file: 'poison.str' }] },
  // roBrowser effect 183 (EF_SUI_EXPLOSION): Self Destruction, sui_explosion.str with ef_hit2.wav (its camera quake not done)
  EF_SUI_EXPLOSION: { wav: 'effect/ef_hit2.wav', layers: [{ type: 'str', file: 'sui_explosion.str' }] },
  // roBrowser effect 300 (EF_CHEMICALPROTECTION): Chemical Protection's, only its sound (apocalips_attack.wav)
  EF_CHEMICALPROTECTION: { wav: 'apocalips_attack.wav', layers: [] },
  // roBrowser effect 220 (EF_POTION_BERSERK): a Berserk Potion, 버서크.str with ac_concentration.wav (its camera quake
  // 200 ms in not done)
  EF_POTION_BERSERK: { wav: 'effect/ac_concentration.wav', layers: [{ type: 'str', file: '버서크.str' }] },
  // roBrowser effect 115 (EF_BLITZBEAT): only its sound, on the target as Blitz Beat hits
  EF_BLITZBEAT: { wav: 'effect/hunter_blitzbeat.wav', layers: [] },
  // roBrowser effect 119 (EF_DETECTING): only its sound, on the user as Detect goes off
  EF_DETECTING: { wav: 'effect/hunter_detecting.wav', layers: [] },
  // Detect's falcon passing behind the cell (stage.js scout; not roBrowser's, by request): the wind of its wings blowing
  // dust1.bmp puffs (as Hiding's) out over the 7×7 in two rings, the second a little after and nearer
  EF_DETECTWIND: { layers: [
    { type: 'ripple', file: 'dust1.bmp', duration: 1000, count: 18, r0: 0.4, r1: 3.5, up: 0.2, from: 30, to: 70, alpha: 0.2, vary: 0.25 },
    { type: 'ripple', file: 'dust1.bmp', at: 200, duration: 900, count: 12, r0: 0.2, r1: 2.2, up: 0.2, from: 24, to: 55, alpha: 0.17, vary: 0.3 }] },
  // Blitz Beat's speed lines on the one hit, along the falcon's dive (play's `from`: the falcon; by request, by eye)
  EF_BLITZLINES: { layers: [{ type: 'speed', count: 8, perSec: 35, duration: [100, 160], up: 1, spread: 0.8, back: [1.8, 2.5], travel: 3.5,
                              len: [35, 65], width: [0.6, 1.2], alpha: 0.9 }] },
  // roBrowser effect 150 (EF_SPEARSTABSELF): Spear Stab going off, the client's spearstab.str on the user with
  // _enemy_hit_normal1.wav
  EF_SPEARSTABSELF: { wav: '_enemy_hit_normal1.wav', layers: [{ type: 'str', file: 'spearstab.str' }] },
  // roBrowser effect 149 (EF_BOWLINGSELF): Bowling Bash going off, the client's bowling.str on the user with
  // _enemy_hit_normal1.wav (roBrowser's; the client also has a knight_bowling_bash.wav, which it marks fake)
  EF_BOWLINGSELF: { wav: '_enemy_hit_normal1.wav', layers: [{ type: 'str', file: 'bowling.str' }] },
  // a dash's dust (Charge Attack's, by request, as Hiding's: not in roBrowser): a small ring of dust1.bmp puffs
  // spreading on the ground where the user passes, fading
  EF_DASHDUST: { layers: [
    { type: 'ripple', file: 'dust1.bmp', duration: 450, count: 5, r0: 0.1, r1: 0.5, up: 0.15, from: 14, to: 28, alpha: 0.3, vary: 0.35 },
  ] },
  // roBrowser effects 144 (EF_BRANDISH2) and 70 (EF_BRANDISHSPEAR): Brandish Spear going off, the client's
  // brandish2.str on the user and brandish.str at the target's feet; both carry knight_brandish_spear.wav in
  // roBrowser, played once here (with the one on the user) rather than twice at once
  EF_BRANDISH2: { wav: 'effect/knight_brandish_spear.wav', layers: [{ type: 'str', file: 'brandish2.str' }] },
  EF_BRANDISHSPEAR: { layers: [{ type: 'str', file: 'brandish.str' }] },
  // roBrowser effect 131 (EF_AUTOCOUNTER): Counter Attack countering, the client's autocounter.str on the one
  // countering with knight_autocounter.wav; its glow rings (ring_b.bmp) run past their picture's edges, which
  // showed as a square (by report), so they fade out before the edges
  EF_AUTOCOUNTER: { wav: 'effect/knight_autocounter.wav', layers: [{ type: 'str', file: 'autocounter.str', soft: ['ring_b.bmp'] }] },
  // roBrowser effect 23 (EF_STONECURSE): Stone Curse taking hold, the client's stonecurse.str on the target;
  // roBrowser gives it no sound, the client's own ef_stonecurse.wav plays with it here
  EF_STONECURSE: { wav: 'effect/ef_stonecurse.wav', layers: [{ type: 'str', file: 'stonecurse.str' }] },
  // roBrowser effects 192, 194, 195 (EF_POISONATTACK, EF_STUNATTACK, EF_PETRIFYATTACK): a monster's Poison, Stun
  // and Petrify Attack (effectId: on the target as the damage lands), the client's poison.str, stun.str and
  // stonecurse.str, no sound of their own
  EF_POISONATTACK: { layers: [{ type: 'str', file: 'poison.str' }] },
  EF_STUNATTACK: { layers: [{ type: 'str', file: 'stun.str' }] },
  EF_PETRIFYATTACK: { layers: [{ type: 'str', file: 'stonecurse.str' }] },
  // roBrowser effect 53 (EF_POISONHIT): Poison Attribute Attack hitting, the client's 이팩트/poisonhit.spr (its 12
  // frames, 72 ms each) with ef_poisonattack.wav
  // roBrowser effects 148 (EF_PIERCESELF) and 147 (EF_EARTHHIT): Pierce (and Piercing Attack) going off, the client's
  // pierce.str on the user; Pierce hitting, earthhit.str on the target
  EF_PIERCESELF: { layers: [{ type: 'str', file: 'pierce.str' }] },
  EF_EARTHHIT: { layers: [{ type: 'str', file: 'earthhit.str' }] },
  // roBrowser effect 191 (EF_GUIDEDATTACK): Guided Attack, the client's homing.str on the target
  EF_GUIDEDATTACK: { layers: [{ type: 'str', file: 'homing.str' }] },
  // roBrowser effect 93 (EF_YUFITEL): Jupitel Thunder's ball, flying from the caster to the target (toSrc): the
  // client's thunder_ball_a–f.bmp cycled every 10 ms, 45 px, over thunder_center.bmp, 35 px at 2/3 (additive: as dim), both
  // additive and faded out toward their edge in a circle (by report: the balls' square showed), with hunter_shockwavetrap.wav
  EF_JUPITEL: { wav: 'effect/hunter_shockwavetrap.wav', layers: [
    { type: 'shot', file: 'thunder_center.bmp', size: 35, z0: 1, z1: 1, color: [0.66, 0.66, 0.66], duration: null },
    { type: 'shot', files: ['a', 'b', 'c', 'd', 'e', 'f'].map(x => `thunder_ball_${x}.bmp`), delay: 10, size: 45, z0: 1, z1: 1, add: true, duration: null },
  ] },
  // roBrowser effect 116 (EF_WATERBALL): a Water Ball leaving, water_out_a–c.bmp cycled every 10 ms, 30.5 px, at a
  // random spot up to 1.5 cells off the user, rising from its feet to 3 cells up and fading out over 500 ms,
  // additive, with wizard_waterball_chulung.wav (roBrowser's 117 plays it too, at the same time: once here)
  EF_WATERBALL: { wav: 'effect/wizard_waterball_chulung.wav', layers: [
    { type: 'sparks', files: ['a', 'b', 'c'].map(x => `water_out_${x}.bmp`), delay: 10, duration: 500, count: 1, every: 0,
      spread: 1.5, z0: 0, z1: 3, size: [30.5, 30.5], alpha: 1, fadeIn: false, overlay: true },
  ] },
  // roBrowser effect 117 (EF_WATERBALL2): the ball, the client's 이팩트/waterball.spr (three pictures, 192 ms each:
  // converted with spr2png.py), flying from the user to the target turned the way it flies (rotateToTarget), drawn
  // at its own 64 px (roBrowser size 50; by eye). roBrowser sends it off backward (retreat 5) and round in an arc
  // (arc 7.5), from 5 up down to the target, as 20 copies 50 ms apart; here one a ball, homing in as Soul Strike's
  // spirits do (by request): from about the user's chest off backward and outward at random, then round in an arc
  // onto the target, a tapering tail behind it as theirs (by request)
  EF_WATERBALL2: { layers: [
    { type: 'shot', files: [0, 1, 2].map(i => `png/effect/waterball/frames/00${i}.png`), delay: 192, size: 64,
      z0: [0.8, 1.6], z1: 0.8, back: [7, 10], side: 8, lift: [0, 3], point: true, tail: 10, tailStep: 0.02, duration: null },
  ] },
  // roBrowser effect 94 (EF_YUFITELHIT): each of its hits, thunder_pang.bmp growing from nothing to 25 px over
  // 100 ms and fading, and a 75 px plasma burst for 300 ms, thunder_plazma_blast_a, _b and thunder_ball_d–f.bmp cycled
  // every 10 ms (by request: it had the first alone), both additive (the flash faded out toward its edge in a circle:
  // its square showed)
  EF_JUPITELHIT: { layers: [
    { type: 'quad', file: 'thunder_pang.bmp', up: 1, from: 0, to: 25, duration: 100, add: true, round: true },
    { type: 'quad', files: ['thunder_plazma_blast_a.bmp', 'thunder_plazma_blast_b.bmp', 'thunder_ball_d.bmp', 'thunder_ball_e.bmp', 'thunder_ball_f.bmp'],
      delay: 10, up: 1, from: 75, to: 75, duration: 300, add: true },
  ] },
  // roBrowser effect 197 (EF_SLEEPATTACK): a monster's Sleep Attack (effectId: on the target as the damage lands),
  // the client's sleep.str, no sound; Curse Attack's (196) is empty
  EF_SLEEPATTACK: { layers: [{ type: 'str', file: 'sleep.str' }] },
  // roBrowser effect 453 (EF_NPC_STOP): Stop taking hold, the client's 이팩트/스톱.spr on the one held (its 16 frames,
  // 192 ms each, once), no sound; 50 px up (by eye: roBrowser draws it at the feet, 0)
  EF_NPC_STOP: { layers: [{ type: 'spr', sprite: 'png/effect/스톱', action: 0, delay: 192, duration: 16 * 192, up: 50 }] },
  // roBrowser effect 216 (EF_BLOODDRAIN, effectIdOnCaster): Sucking Blood, five of the client's 이팩트/particle1.spr
  // tinted blood red (1, 0.4, 0.4) flying from the one bitten back to the monster in 600 ms, arcing out (arc 3,
  // retreat 3: here the shot's pull, 3 cells back and up to 3 to either side) — play it on the monster, `from` the
  // one bitten. roBrowser's 150 px is drawn 40 here (by eye, as Fire Ball's sprite)
  EF_BLOODDRAIN: { layers: Array.from({ length: 5 }, () => ({ type: 'shot', files: ['png/effect/particle1/frames/000.png'], delay: 96, size: 40,
    z0: [0.6, 1.2], z1: 1, back: [2, 3], side: 3, lift: [0, 1], color: [1, 0.4, 0.4], add: true, duration: 600 })) },
  // roBrowser effect 235 (EF_DISPELL): Dispell on its target, the client's 디스펠.str, no sound
  EF_DISPELL: { layers: [{ type: 'str', file: '디스펠.str' }] },
  // roBrowser effect 234 (EF_SPELLBREAKER): Spell Breaker on its target, spell.str with sage_spell breake.wav
  EF_SPELLBREAKER: { wav: 'effect/sage_spell breake.wav', layers: [{ type: 'str', file: 'spell.str' }] },
  // roBrowser effects 239–241 (EF_BOTTOM_VO, _DE, _VI: each cell of Volcano, Deluge, Violent Gale): PropertyGround, a ring
  // flaring from 1 cell out at the ground to 3 at 2 up, of ring_red / ring_blue / ring_yellow.tga, only its pixels whose
  // r, g and b are all at least half (the rest discarded) at alpha 0.42, 20 sides, turning tick / 8 degrees each from its
  // own angle, its size swelling and shrinking (`pulse`); fading in and out over 300 ms here (roBrowser pops it). By
  // request smaller (roBrowser's 1 → 3 cells, 2 high: 0.5 → 1.5, 1.5 high) and its kept pixels' edge soft (`soft` 0.15:
  // roBrowser's hard cut showed jagged)
  ...Object.fromEntries([['VO', 'ring_red'], ['DE', 'ring_blue'], ['VI', 'ring_yellow']].map(([k, f]) => ['EF_BOTTOM_' + k, { layers: [
    { type: 'cylinder', file: f + '.tga', duration: null, fixed: true, sides: 20, bottom: 0.5, top: 1.5, height: 1.5, keep: 0.5, soft: 0.15, alpha: 0.42,
      pulse: true, spinDiv: 8, fadeMs: 300 }] }])),
  // roBrowser effect 242 (EF_BOTTOM_LA, each cell of Land Protector): LPEffect, the client's aaa copy.bmp flat on the
  // ground 1.6 cells across (0.8 ± 0.05 each way, its odd and even ones opposite, sin(tick / 540π)), its pixels with r, g
  // and b all at least half at alpha 0.7; by request smaller, 1.2 across (roBrowser's 1.6), its edge soft as the rings'
  EF_BOTTOM_LA: { layers: [{ type: 'ground', file: 'aaa copy.bmp', size: 1.2, spin: 0, keep: 0.5, soft: 0.15, alpha: 0.7, duration: null, pulse: [0.05 / 0.8, 540 * Math.PI] }] },
  // roBrowser ef_sa_instantdeath (Hocus-Pocus's Suicide): the client's suicide.str on the user, no sound
  EF_SA_INSTANTDEATH: { layers: [{ type: 'str', file: 'suicide.str' }] },
  // roBrowser effects 255–258 (EF_FLAMELAUNCHER, EF_FROSTWEAPON, EF_LIGHTNINGLOADER, EF_SEISMICWEAPON): the endows on
  // their target, enc_fire / enc_ice / enc_wind / enc_earth.str with _enemy_hit_wind1.wav (in wav/, not wav/effect/ as
  // roBrowser has it for the wind's)
  EF_FLAMELAUNCHER: { wav: '_enemy_hit_wind1.wav', layers: [{ type: 'str', file: 'enc_fire.str' }] },
  EF_FROSTWEAPON: { wav: '_enemy_hit_wind1.wav', layers: [{ type: 'str', file: 'enc_ice.str' }] },
  EF_LIGHTNINGLOADER: { wav: '_enemy_hit_wind1.wav', layers: [{ type: 'str', file: 'enc_wind.str' }] },
  EF_SEISMICWEAPON: { wav: '_enemy_hit_wind1.wav', layers: [{ type: 'str', file: 'enc_earth.str' }] },
  // roBrowser effect 244 (EF_MAGICROD): Magic Rod on its user as it takes a spell in, the client's 매직로드.str with sage_magic rod.wav
  EF_MAGICROD: { wav: 'effect/sage_magic rod.wav', layers: [{ type: 'str', file: '매직로드.str' }] },
  // roBrowser effect 87 (EF_LEXDIVINA): Lex Divina on its target, lexdivina.str with priest_lexdivina.wav
  EF_LEXDIVINA: { wav: 'effect/priest_lexdivina.wav', layers: [{ type: 'str', file: 'lexdivina.str' }] },
  // roBrowser effect 246 (EF_SHIELDCHARGE): Shield Charge, shield_charge.str (here on the target as it is hit)
  EF_SHIELDCHARGE: { layers: [{ type: 'str', file: 'shield_charge.str' }] },
  // roBrowser effect 245 (EF_HOLYCROSS): Holy Cross, holy_cross.str with cru_holy cross.wav (here on the target as it is hit)
  EF_HOLYCROSS: { wav: 'effect/cru_holy cross.wav', layers: [{ type: 'str', file: 'holy_cross.str' }] },
  // roBrowser effect 248 (EF_PROVIDENCE): Resistant Souls, providence.str, no sound
  EF_PROVIDENCE: { layers: [{ type: 'str', file: 'providence.str' }] },
  // roBrowser effect 251 (EF_DEVOTION): Sacrifice, devotion.str on the one it is put on, no sound
  EF_DEVOTION: { layers: [{ type: 'str', file: 'devotion.str' }] },
  // Grand Cross (EF_GRANDCROSS, 226): the client's cross.str (cross1.bmp, a cross of light) at the user's feet with each of
  // its 3 turns (sim.js GX_MS), and cru_grand cross.wav. (roBrowser's 226 is ring_red.tga columns over the user and two cells
  // west with 매직로드.str and sage_magic rod.wav, Magic Rod's: seemingly mixed up, so not that)
  EF_GRANDCROSS: { wav: 'effect/cru_grand cross.wav', layers: [0, 300, 600].map(at => ({ type: 'str', file: 'cross.str', at })) },
  // roBrowser effect 232 (EF_LINELINK): Sacrifice's line from the crusader (play's `from`) to the one under it, 1 cell up at
  // both ends, for as long as it lasts. roBrowser's is alpha_center.tga 5 px wide tinted (0.1, 0.1, 0.9) at alpha 0.5,
  // added on; by request a translucent white light instead, drawn as Raging Trifecta Blow's streak (EF_TRIPLELINES),
  // fading out toward both, 8 px across (by request a little wider than the 5; the songs' lens_w.bmp tried first, by
  // request not), breathing down to 70 % and back over 1.5 s; fading out over 400 ms as it ends, and fainter from 4
  // cells apart to nothing at 11 (Sacrifice's reach at Lv 5) (by request; by eye)
  EF_LINELINK: { layers: [{ type: 'link', duration: null, up: 1, streak: true, width: 8, color: [1, 1, 1], alpha: 0.9, pulse: 0.3,
    period: 1500, outro: 400, near: 4, far: 11 }] },
  // the traps on the ground (roBrowser SkillUnit: UNT_SANDMAN ef_trap_03_4, UNT_SKIDTRAP ef_trap_02 — 'RSM' effects of
  // the client's model/외부소품/트랩03_4.rsm and 트랩02.rsm), with the client's hun_trap_install.wav as one is set
  // (not in roBrowser, which has no sound for it; by ear)
  EF_TRAP_SANDMAN: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩03_4.glb', scale: 0.375, duration: null }] },
  EF_TRAP_SKID: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩02.glb', scale: 0.375, duration: null }] },
  // the same for the characters' other traps: UNT_LANDMINE ef_trap_03 (트랩03.rsm)…
  EF_TRAP_LANDMINE: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩03.glb', scale: 0.375, duration: null }] },
  // …UNT_ANKLESNARE ef_trap_01 (트랩01.rsm)
  EF_TRAP_ANKLESNARE: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩01.glb', scale: 0.375, duration: null }] },
  // Ankle Snare catching one: roBrowser's groundEffectId ef_anklesnare is not in its table; the client's
  // hunter_anklesnare.wav (by ear)
  EF_ANKLESNARE: { wav: 'effect/hunter_anklesnare.wav', layers: [] },
  // …UNT_SHOCKWAVE ef_trap_03_6 (트랩03_6.rsm)
  EF_TRAP_SHOCKWAVE: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩03_6.glb', scale: 0.375, duration: null }] },
  // Shockwave Trap going off: its hitEffectId 146 (shockwavehit.str), here where the trap was, with hunter_shockwavetrap.wav
  // (roBrowser's on its effectId 145, a sprite of the client's that is the item's: not drawn)
  EF_SHOCKWAVEHIT: { wav: 'effect/hunter_shockwavetrap.wav', layers: [{ type: 'str', file: 'shockwavehit.str' }] },
  // …UNT_FLASHER ef_trap_03_5 (트랩03_5.rsm)
  EF_TRAP_FLASHER: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩03_5.glb', scale: 0.375, duration: null }] },
  // Flasher going off: roBrowser's hitEffectId 99 (EF_FLASHER) is only its sound, hunter_flasher.wav (its flash, a
  // 'FUNC', not done there), here where the trap was
  EF_FLASHER: { wav: 'effect/hunter_flasher.wav', layers: [] },
  // …UNT_FREEZINGTRAP ef_trap_03_2 (트랩03_2.rsm)
  EF_TRAP_FREEZING: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩03_2.glb', scale: 0.375, duration: null }] },
  // roBrowser effect 108 (EF_FREEZING, Freezing Trap's hitEffectId): freezing.str with hunter_freezingtrap.wav
  EF_FREEZING: { wav: 'effect/hunter_freezingtrap.wav', layers: [{ type: 'str', file: 'freezing.str' }] },
  // …UNT_BLASTMINE ef_trap_03_3 (트랩03_3.rsm)
  EF_TRAP_BLASTMINE: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩03_3.glb', scale: 0.375, duration: null }] },
  // roBrowser effect 106 (EF_BLASTMINEBOMB, Blast Mine's hitEffectId): blastmine.str with hunter_blastmine.wav, here once
  // where the trap was as it goes off
  EF_BLASTMINEBOMB: { wav: 'effect/hunter_blastmine.wav', layers: [{ type: 'str', file: 'blastmine.str' }] },
  // …UNT_CLAYMORETRAP ef_trap_04 (트랩04.rsm)
  EF_TRAP_CLAYMORE: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩04.glb', scale: 0.375, duration: null }] },
  // roBrowser effect 107 (EF_CLAYMORE, Claymore Trap's hitEffectId): claymore.str with hunter_claymoretrap.wav, here once
  // where the trap was as it goes off
  EF_CLAYMORE: { wav: 'effect/hunter_claymoretrap.wav', layers: [{ type: 'str', file: 'claymore.str' }] },
  // …UNT_TALKIEBOX ef_trap_05 (트랩05.rsm); roBrowser has no effect of its own for it going off (SkillEffect {})
  EF_TRAP_TALKIEBOX: { wav: 'effect/hun_trap_install.wav', layers: [{ type: 'model', file: 'map/model/트랩05.glb', scale: 0.375, duration: null }] },
  // roBrowser effect 138 (EF_FIREPILLARON, Fire Pillar's unit while it waits: SkillUnit UNT_FIREPILLAR_WAITING): three
  // cones of magic_red.tga, 1 → 2 cells across 3 high, 0.7 → 1.5 across 5, 0.5 → 1 across 7, spinning (roBrowser: at full
  // size and alpha, popping on a second after it is set, delayOffset). Here, by request: on at once, the height growing
  // from nothing over the first second (rise), at alpha 0.5, fading out over 300 ms; Fire Wall's sound as it is set
  EF_FIREPILLARON: { wav: 'effect/ef_firewall.wav', layers: [[1, 2, 3], [0.7, 1.5, 5], [0.5, 1, 7]].map(([bottom, top, height]) =>
    ({ type: 'cylinder', file: 'magic_red.tga', duration: null, bottom, top, height, rise: true, fadeMs: 300, alpha: 0.5 })) },
  // roBrowser effect 96 (EF_FIREPILLAR, Fire Pillar's effectId): firepillar.str with wizard_fire_pillar_a.wav, here
  // where the pillar stood as it goes off; 97 (EF_FIREPILLARBOMB, its hitEffectId): firepillarbomb.str with
  // wizard_fire_pillar_b.wav on each one it hits
  EF_FIREPILLAR: { wav: 'effect/wizard_fire_pillar_a.wav', layers: [{ type: 'str', file: 'firepillar.str' }] },
  EF_FIREPILLARBOMB: { wav: 'effect/wizard_fire_pillar_b.wav', layers: [{ type: 'str', file: 'firepillarbomb.str' }] },
  // roBrowser effect 100 (EF_REMOVETRAP): only its sound, hunter_removetrap.wav (its fountain of yellow balls a 'FUNC',
  // not done there); 111 (EF_SPRINGTRAP): spring.str with hunter_springtrap.wav
  EF_REMOVETRAP: { wav: 'effect/hunter_removetrap.wav', layers: [] },
  EF_SPRINGTRAP: { wav: 'effect/hunter_springtrap.wav', layers: [{ type: 'str', file: 'spring.str' }] },
  // Land Mine's effectId (roBrowser ef_ht_landmine: the client's landmine.str, no sound), here where the trap was as it
  // goes off, with the client's hunter_landmine.wav (by ear)
  EF_LANDMINE: { wav: 'effect/hunter_landmine.wav', layers: [{ type: 'str', file: 'landmine.str' }] },
  // roBrowser effect 139 (EF_SANDMAN, Sandman's hitEffectId): sandman.str with hunter_sandman.wav, here where the trap
  // was as it is set off (rAthena sends no hit for it)
  EF_SANDMAN: { wav: 'effect/hunter_sandman.wav', layers: [{ type: 'str', file: 'sandman.str' }] },
  // roBrowser effect 69 (EF_SKIDTRAP, Skid Trap's effectId, which roBrowser plays as the trap is set): skidtrap.str with
  // hunter_skidtrap.wav, here where the trap was as it is set off (by eye: the slide is when something happens)
  EF_SKIDTRAP: { wav: 'effect/hunter_skidtrap.wav', layers: [{ type: 'str', file: 'skidtrap.str' }] },
  // roBrowser effect 124 (EF_VENOMDUST, Venom Dust's effectId): venomdust.str where it is cast, with the client's
  // assasin_venomdust.wav (roBrowser has assasin_poisonreact.wav, noting the other)
  EF_VENOMDUST: { wav: 'effect/assasin_venomdust.wav', layers: [{ type: 'str', file: 'venomdust.str' }] },
  // roBrowser effect 171 (EF_VENOMDUST2, each Venom Dust cell): the client's 이팩트/particle3.spr (a pink star), 80 px,
  // rising from the ground to half a cell over 100 ms, again and again while it lies there (repeat: one every 100 ms;
  // here 50 of them, the 5 s of Lv 1, the one monsters use, cut off as it goes)
  EF_VENOMDUST2: { layers: [{ type: 'sparks', file: 'png/effect/particle3/frames/000.png', duration: 100, count: 50, every: 100,
    size: 80, spread: 0, z0: 0, z1: 0.5, alpha: 1, normal: true }] },
  // roBrowser effect 404 (EF_BOTTOM_SPIDER, the Fiber Lock unit): spiderweb.tga flat on the ground, 3 cells across (its
  // SpiderWeb: a −1…1 quad × 1.5; swelling and shrinking by 0.05 of that, not done), only its white threads drawn, at
  // alpha 0.7 (its shader: a pixel with any of r, g, b under 0.5 is dropped, the texture's alpha not used); no sound
  EF_SPIDERWEB: { layers: [{ type: 'ground', file: 'spiderweb.tga', size: 3, spin: 0, keep: 0.5, alpha: 0.7, duration: null }] },
  // roBrowser effect 212 (EF_DARKBREATH): Dark Breath, the client's 이팩트/darkbreath.spr — the digits 0 to 9 rolling,
  // 65 frames of 24 ms — over the target's head (here as it is hit)
  EF_DARKBREATH: { layers: [{ type: 'spr', sprite: 'png/effect/darkbreath', action: 0, delay: 24, duration: 65 * 24, up: 'head' }] },
  // roBrowser effect 214 (EF_KEEPING): a monster's Keeping, the client's keeping.str on it, no sound
  EF_KEEPING: { layers: [{ type: 'str', file: 'keeping.str' }] },
  // roBrowser effects 126 and 127 (EF_POISONREACT, EF_POISONREACT2): Poison React, the client's poisonreact_1st.str and
  // poisonreact.str on the user, with assasin_poisonreact.wav
  EF_POISONREACT: { wav: 'effect/assasin_poisonreact.wav', layers: [{ type: 'str', file: 'poisonreact_1st.str' }] },
  EF_POISONREACT2: { wav: 'effect/assasin_poisonreact.wav', layers: [{ type: 'str', file: 'poisonreact.str' }] },
  // roBrowser effect 129 (EF_SPLASHER): Venom Splasher, the client's venomsplasher.str with assasin_venomsplasher.wav
  EF_SPLASHER: { wav: 'effect/assasin_venomsplasher.wav', layers: [{ type: 'str', file: 'venomsplasher.str' }] },
  // roBrowser effect 130 (EF_TWOHANDQUICKEN): Two-Hand Quicken, the client's twohand.str on the user with
  // knight_twohandquicken.wav
  EF_TWOHANDQUICKEN: { wav: 'effect/knight_twohandquicken.wav', layers: [{ type: 'str', file: 'twohand.str' }] },
  // roBrowser effect 250 (EF_SPEARQUICKEN): Spear Quicken, the same as Two-Hand Quicken's
  EF_SPEARQUICKEN: { wav: 'effect/knight_twohandquicken.wav', layers: [{ type: 'str', file: 'twohand.str' }] },
  // roBrowser effects 98 and '98_beforecast' (EF_HASTEUP): Adrenaline Rush, black_adrenalinerush_a.wav as its
  // cast starts and _b.wav as it goes off; roBrowser leaves the client's picture out, here the client's own
  // adrenaline.str on the user as it goes off (by request)
  EF_ADRENALINE_CAST: { wav: 'effect/black_adrenalinerush_a.wav', layers: [] },
  EF_ADRENALINE: { wav: 'effect/black_adrenalinerush_b.wav', layers: [{ type: 'str', file: 'adrenaline.str' }] },
  // roBrowser effect 103 (EF_PERFECTION): Weapon Perfection, the client's weaponperfection.str on each one it is put on,
  // with black_weapon_perfection.wav
  EF_PERFECTION: { wav: 'effect/black_weapon_perfection.wav', layers: [{ type: 'str', file: 'weaponperfection.str' }] },
  // roBrowser effect 128 (EF_OVERTHRUST): Power Thrust, only black_overthrust.wav on each one (its afterimage, OPT3
  // OVERTHRUST's trail, not done)
  EF_OVERTHRUST: { wav: 'effect/black_overthrust.wav', layers: [] },
  // roBrowser effects 104 and 'maximize_power_sounds' (EF_MAXPOWER): Maximize Power, the client's maximizepower.str on
  // the user as it goes on; as it is used black_maximize_power_circle.wav, _sword.wav at 550 and 700 ms, _sword_bic.wav
  // at 950
  EF_MAXPOWER_SOUNDS: { layers: [], sounds: [[1, 'effect/black_maximize_power_circle.wav'], [550, 'effect/black_maximize_power_sword.wav'],
    [700, 'effect/black_maximize_power_sword.wav'], [950, 'effect/black_maximize_power_sword_bic.wav']] },
  EF_MAXPOWER: { layers: [{ type: 'str', file: 'maximizepower.str' }] },
  // roBrowser effect 102 (EF_CRASHEARTH): Hammer Fall, the client's crashearth.str where it strikes, with
  // black_hammerfall.wav (its camera quake 350 ms on not done)
  EF_CRASHEARTH: { wav: 'effect/black_hammerfall.wav', layers: [{ type: 'str', file: 'crashearth.str' }] },
  // The monk's. Its spirit spheres (roBrowser effect 504, EF_CHOOKGI2: Renderer/Effects/SpiritSphere.js), n of them
  // going round it for as long as it has them (stage.js spheres): the client's thunder_center.bmp drawn additively,
  // 0.5 cell across in blue with a 0.3 cell pale blue core, 1 cell out and 1 up (roBrowser 2; halved as Sight's is),
  // evenly round however many there are (roBrowser: each in its slot of five, 72° apart; by request), coming and going
  // as they are summoned and used (`dynamic`, setOrbs: stage.js spheres), going round the other way from Sight's a turn
  // every SPHERE_TURN_MS (roBrowser's 1/64° a ms, a turn every 23 s, too slow; by request) at SPHERE_ALPHA (roBrowser 1;
  // fainter by request)
  EF_SPHERES: { layers: [[17.5, [0, 0, 1]], [10.5, [0.8, 0.8, 1]]].map(([size, color]) => ({
    type: 'orbit', files: ['thunder_center.bmp'], delay: 1000, duration: null, n: 5, dynamic: true, radius: 1, up: 1, spin: -360 / SPHERE_TURN_MS,
    lag: 0.8, lagStep: 0, size, sizeStep: 0, alpha: SPHERE_ALPHA, alphaStep: 0, add: true, color })) },
  // roBrowser effect 253 (EF_ABSORBSPIRITS): Absorb Spirit Sphere on its user, Heal's pillars and sparks in blue
  // (0.3, 0.3, 1), with 흡기.wav: two pillars 15 and 13 cells high and a low cone, rising over 1.5 s, the sparks
  // drifting up
  EF_ABSORBSPIRITS: { wav: 'effect/흡기.wav', layers: [
    { type: 'cylinder', file: 'ring_blue.tga', duration: 1500, bottom: 1.1, top: 1.1, height: 15, rise: true, alpha: 0.3, color: [0.3, 0.3, 1], add: true },
    { type: 'cylinder', file: 'ring_blue.tga', duration: 1500, bottom: 1, top: 1, height: 13, rise: true, alpha: 0.3, color: [0.3, 0.3, 1], add: true },
    { type: 'cylinder', file: 'ring_blue.tga', duration: 1500, bottom: 1.1, top: 3, height: 2, rise: true, alpha: 0.3, color: [0.3, 0.3, 1], add: true },
    { type: 'sparks', file: 'pok3.tga', duration: 1500, count: 4, every: 10, spread: 1.2, z0: 0, z1: [7, 9], size: [7, 11], alpha: 0.8, sparkle: 2, color: [0.3, 0.3, 1] },
    { type: 'sparks', file: 'pok3.tga', duration: 1300, count: 20, every: 10, spread: 1.5, z0: 0, z1: [3, 9], size: [7, 11], alpha: 0.8, sparkle: 2, color: [0.3, 0.3, 1] },
    { type: 'sparks', file: 'pok3.tga', duration: 1100, count: 10, every: 50, spread: 1, z0: [-1, 1], z1: 6, size: [7, 11], alpha: 0.8, sparkle: 2, color: [0.3, 0.3, 1] },
  ] },
  // Raging Trifecta Blow's light on the one hit with each hit, along the punch (play's `from`: the monk): a long pale
  // streak shooting through it and a few short ones (not in roBrowser; as a recording of the game shows them, by report:
  // by eye)
  EF_TRIPLELINES: { layers: [
    { type: 'speed', count: 1, duration: [180, 220], up: 1, spread: 0.3, back: [2.5, 3], travel: 5, len: [130, 160], width: [2, 3], alpha: 0.9, color: [1, 0.95, 0.75] },
    { type: 'speed', count: 4, duration: [90, 140], up: 1, spread: 0.5, back: [1.5, 2], travel: 3, len: [30, 50], width: [0.6, 1.2], alpha: 0.9 },
  ] },
  // roBrowser effect 267 (EF_CHIMTO): Occult Impaction on its target, only mon_침투경.wav
  EF_CHIMTO: { wav: 'effect/mon_침투경.wav', layers: [] },
  // and as it hits, a spiky yellow burst out of the target's back, away from the one who struck it, as the client's
  // 침투경_.spr draws it (a starburst with one long spike) but made in 3D: a flash, a star of short spikes all round where
  // it comes out and long ones shooting out the back, out very fast then shrinking as they fade (by request; the sprite's
  // picture itself, scaled, and a gust of soft glows were tried first)
  EF_CHIMTO_HIT: { layers: [
    { type: 'qi', count: 1, every: 0, duration: 320, up: 1.8, cone: 0, dist: 0.5, size: [2.4, 3], alpha: 0.9, color: [1, 0.9, 0.55] },
    { type: 'qi', count: 1, every: 0, duration: 280, up: 1.8, cone: 0, dist: 0.4, size: [1.2, 1.5], alpha: 0.8, color: [1, 1, 0.85] },
    { type: 'spike', count: 22, duration: [250, 350], up: 1.8, cone: 180, len: [1, 2.2], width: [0.35, 0.7], travel: 0.3,
      grow: 0.12, shrink: 0.4, alpha: 0.7, color: [[1, 0.75, 0.15], [1, 0.5, 0]] },
    { type: 'spike', count: 7, duration: [350, 480], up: 1.8, cone: 22, len: [3, 6.5], width: [0.4, 0.8], travel: 0.4,
      grow: 0.1, shrink: 0.35, alpha: 0.6, color: [[1, 0.75, 0.15], [1, 0.5, 0]] },
  ] },
  // roBrowser effect 265 (EF_TANJI): Throw Spirit Sphere, the client's blue_ivy.bmp (50 px) flying between the user and
  // its target over 150 ms, with mon_탄지신통.wav (here from the user to the target, landing with the first hit: by eye)
  EF_TANJI: { wav: 'effect/mon_탄지신통.wav', layers: [{ type: 'shot', file: 'blue_ivy.bmp', size: 50, z0: 1, z1: 1, duration: null }] },
  // roBrowser effects 262 (EF_TEIHIT1) and 273 (EF_CHAINCOMBO): Raging Quadruple Blow on its target, mon_폭기.wav with
  // 262's twelve streaks (alpha_center.tga, 10 × 150 px, additive, over everything) shooting out from it every which way
  // 250 ms on, over 550 ms (roBrowser: to ±40 cells; here 8–20 cells on screen and yellow, as a recording of the game
  // shows them, by report: by eye), and the client's 연환.str with mon_연환.wav; on the user 263 (EF_GUMGANG3), four
  // yellow rings 100 ms apart widening from 3 to 6 cells round it over 1 s, 2 high
  EF_TEIHIT1: { wav: 'effect/mon_폭기.wav', layers: [
    { type: 'speed', radial: true, count: 12, at: 250, duration: 550, up: 1, spread: 0, back: 0, travel: [8, 20], len: [110, 150],
      width: [3, 5], alpha: 0.8, color: [1, 0.9, 0.45] },
  ] },
  EF_CHAINCOMBO: { wav: 'effect/mon_연환.wav', layers: [{ type: 'str', file: '연환.str' }] },
  // roBrowser effect 261 (EF_GUMGANG2): Fury on its user, four yellow rings 100 ms apart widening from 2 to 5 cells
  // round it over 1.5 s, 2 high, with mon_폭기.wav (its camera quake not done)
  EF_GUMGANG2: { wav: 'effect/mon_폭기.wav', layers: FURY_RINGS },
  // roBrowser effects 328 (EF_BEGINASURA) and 266 (EF_TEIHIT1X): Asura Strike. On its target as it goes off, two white
  // cones opening to 4.5 and 2.5 cells over 0.8 s (roBrowser's go 4 down, under the floor here: up instead), and the client's asura1–6.tga (阿 修 羅 霸 凰 拳) in a row
  // 4 cells up, black (by request; roBrowser's dark, × 0.1), 100 ms one after the other: each three times 150 ms apart (fainter each), fading in as
  // it shrinks from 250 to 120 px over 1.2 s, then growing to 200 px as it fades out over 0.4 s. As it strikes,
  // 266's 24 white streaks (lens1.tga) shooting out every which way 100 ms on, with mon_아수라 패황권.wav. (Its camera
  // quake not done; a Champion's own 510 not here.)
  EF_BEGINASURA: { layers: [
    { type: 'cylinder', file: 'ring_white.tga', duration: 800, bottom: 1, top: 4.5, height: 4, widen: true, add: true },
    { type: 'cylinder', file: 'ring_white.tga', duration: 800, bottom: 1, top: 2.5, height: 4, widen: true, add: true },
    ...[-6, -3.6, -1.2, 1.2, 3.6, 6].flatMap((side, i) => [
      ...[0, 1, 2].map(d => ({ type: 'quad', file: `asura${i + 1}.tga`, at: 100 * i + 150 * d, duration: 1200, side, up: 4,
                               from: 250, to: 120, smooth: true, fadeIn: true, hold: true, alpha: 1 - 0.25 * d, color: [0, 0, 0] })),
      { type: 'quad', file: `asura${i + 1}.tga`, at: 1200 + 100 * i, duration: 400, side, up: 4, from: 120, to: 200, color: [0, 0, 0] },
    ]),
  ] },
  EF_TEIHIT1X: { wav: 'effect/mon_아수라 패황권.wav', layers: [
    { type: 'speed', radial: true, count: 24, at: 100, duration: 550, up: 1, spread: 0, back: 0, travel: [8, 20], len: [110, 150], width: [3, 5], alpha: 0.8 },
  ] },
  // roBrowser effect 254: Mental Strength on its user, mon_금강불괴.wav (and a camera quake, not done); with Fury's
  // rings as its fist strikes the ground (by request; roBrowser none)
  EF_STEELBODY: { wav: 'effect/mon_금강불괴.wav', layers: FURY_RINGS },
  // roBrowser effect 514 (EF_GI_EXPLOSION, "Really Big Circle"): Ki Explosion. roBrowser draws nothing for it and the
  // client has no sound of its own; here a white ring widening low round the target over 0.5 s, from the name (a guess)
  EF_GI_EXPLOSION: { wav: 'effect/ef_hit2.wav', layers: [
    { type: 'cylinder', file: 'ring_white.tga', duration: 500, bottom: 0.5, top: 3, height: 0.6, alpha: 0.7, add: true },
  ] },
  // Fury, while it lasts: thin forked blue-violet lightning flickering on the user now and then (by request, after a
  // recording of the official client's; roBrowser none)
  EF_FURY_ZAPS: { layers: [FURY_ZAP] },
  // Mental Strength, while it lasts: Fury's lightning, more often (by request; roBrowser none)
  EF_STEELBODY_ZAPS: { layers: [{ ...FURY_ZAP, every: [80, 250] }] },
  EF_GUMGANG3: { layers: [0, 100, 200, 300].map(at => ({ type: 'cylinder', file: 'ring_yellow.tga', at, duration: 1000, bottom: 3, top: 6, height: 2, alpha: 0.3 })) },
  // Raging Thrust (roBrowser effect 330, which its EffectTable lacks): the client's mon_맹룡과강.wav (by ear; its camera
  // quake not done); and as its fist strikes the ground, thin yellow lines thrown up from the user every which way,
  // arcing out and bouncing along the ground (by request, after a recording of the game: by eye; first from the target
  // 250 ms after it went off; then out 3–6 cells a second, up 9–12, over 1.3 s)
  EF_COMBOFINISH: { wav: 'effect/mon_맹룡과강.wav', layers: [] },
  EF_COMBOFINISH_LINES: { layers: [
    // (and one of Raging Quadruple Blow's yellow rings round the user, EF_GUMGANG3's, once: by request)
    { type: 'cylinder', file: 'ring_yellow.tga', duration: 1000, bottom: 3, top: 6, height: 2, alpha: 0.3 },
    { type: 'bounce', count: 16, duration: 1500, up: 0.3, out: [3, 11], rise: [7, 14], gravity: 28, bounce: 0.4, trail: 250,
      width: 1.2, alpha: 0.9, color: [1, 0.9, 0.35] },
  ] },
  // roBrowser effect 120 (EF_CLOAKING): Cloaking, only assasin_cloaking.wav
  EF_CLOAKING: { wav: 'effect/assasin_cloaking.wav', layers: [] },
  // The rogue's. roBrowser effect 275 (EF_BACKSTAP): Back Stab's hit, only rog_back stap.wav. 276 (EF_TEIHIT3): Sightless
  // Mind on its user, 20 blue streaks (lens1.tga, 10 × 150 px, additive) shooting out every which way 100 ms on, over
  // 550 ms (as Raging Quadruple Blow's, EF_TEIHIT1: 8–20 cells on screen, by eye); no sound. 269–272: the Divests on
  // the one they take hold on, the client's strip_weapon / _shield / _armor / _helm.str with t_벽튕김.wav. 227
  // (EF_INTIMIDATE): Snatch, only rog_intimidate.wav.
  EF_BACKSTAP: { wav: 'effect/rog_back stap.wav', layers: [] },
  EF_TEIHIT3: { layers: [
    { type: 'speed', radial: true, count: 20, at: 100, duration: 550, up: 1, spread: 0, back: 0, travel: [8, 20], len: [110, 150],
      width: [3, 5], alpha: 0.8, color: [0.1, 0.1, 1] },
  ] },
  ...Object.fromEntries(['weapon', 'shield', 'armor', 'helm'].map(p => [`EF_STRIP${p.toUpperCase()}`,
    { wav: 'effect/t_벽튕김.wav', layers: [{ type: 'str', file: `strip_${p}.str` }] }])),
  EF_INTIMIDATE: { wav: 'effect/rog_intimidate.wav', layers: [] },
  // 268 (EF_STEALCOIN) and 274 (EF_RG_COIN): Mug taking hold, the client's steal_coin.str on the monster, and 30
  // coin_a.bmp coins 20 ms apart from 2 cells up out to random spots up to 2.5 cells off and 0.5–3.5 up, 20 px, fading
  // out over 0.7 s, with rog_steal coin.wav (by request shorter and wider: roBrowser's 50 ms apart, each 1.5 s, out to
  // posxEndRand 10, a cell here by eye, 1–3 up)
  EF_STEALCOIN: { layers: [{ type: 'str', file: 'steal_coin.str' }] },
  EF_RG_COIN: { wav: 'effect/rog_steal coin.wav', layers: [
    { type: 'sparks', file: 'coin_a.bmp', duration: 700, count: 30, every: 20, spread: 0, z0: 2, z1: [0.5, 3.5], out: 2.5, size: 20,
      alpha: 0.8, fadeIn: false, overlay: true },
  ] },
  // 604 (EF_NPC_STOP2): Close Confine, the client's 이팩트/cconfine.spr (a cage of hands rising round the one held, 12
  // frames, the last five the same) on both while it holds, its last frame held (stopAtEnd), with ef_hit6.wav as it
  // takes hold (602, its effectId, is not in roBrowser's table)
  // (by request half its size, round the feet only: roBrowser draws it as it is, the cage as tall as a character)
  EF_CCONFINE: { wav: 'effect/ef_hit6.wav', layers: [{ type: 'spr', sprite: 'png/effect/cconfine', action: 0, duration: null, hold: true, up: 0, depth: true, scale: 0.5 }] },
  // roBrowser effect 336 (EF_GUARD): Auto Guard as it is put on and as it blocks, kyrie_guard.wav and guardk.tga (an
  // octagonal shield) in a grid toward the attacker, additive, tinted 0.91, 1, 0.9, fading in and out over 600 ms.
  // roBrowser stacks three bands of 5 of an octagon's 8 sides (225°), one shield a side: 1.5 → 1 cells 0.7 high
  // at 2.14 up, 1.5 high 1.14 at 1, 1 → 1.5 high 0.7 at 0.3. Here one rounded shell over the same span instead
  // (by request: half a sphere, not boxy): 1.5 cells round and 2 up and down from a point 1.4 up, 225° round,
  // from 40° below to 45° above (going nearer the top squeezed the shields round it into wedges), so from
  // about the ground to 2.8 up; 5 shields round and 3 up; alpha 0.4 (by request; roBrowser 0.6)
  EF_GUARD: { wav: 'effect/kyrie_guard.wav', layers: [{ type: 'shell', file: 'guardk.tga', duration: 600, radius: 1.5, radiusY: 2, z: 1.4,
    arc: 5 / 8, lat: [-40, 45], repeat: 5, repeatV: 3, alpha: 0.4, color: [0.91, 1, 0.9], add: true }] },
  // roBrowser effect 252 (EF_REFLECTSHIELD): Reflect Shield, a ring_yellow.tga column 1.5 cells across rising to 10
  // high over its first second (animation 1), turning, alpha 0.6 fading in and out over 3 s; no sound in roBrowser nor
  // the client, so Reflect Damage's lg_reflectdamage.wav (by request: it had none)
  EF_REFLECTSHIELD: { wav: 'effect/lg_reflectdamage.wav', layers: [{ type: 'cylinder', file: 'ring_yellow.tga', duration: 3000, rise: true, bottom: 1.5, top: 1.5, height: 10, alpha: 0.6, add: true }] },
  // roBrowser effect 222 (EF_DEFENDER): Defending Aura, Reflect Shield's column in ring_black.tga; no sound in roBrowser
  // nor the client, so the Imperial Guard's Guard Stance's ig_guard_stance.wav (by request: it had none)
  EF_DEFENDER: { wav: 'effect/ig_guard_stance.wav', layers: [{ type: 'cylinder', file: 'ring_black.tga', duration: 3000, rise: true, bottom: 1.5, top: 1.5, height: 10, alpha: 0.6, add: true }] },
  EF_POISONHIT: { wav: 'effect/ef_poisonattack.wav', layers: [{ type: 'spr', sprite: 'png/effect/poisonhit', action: 0, delay: 72, duration: 12 * 72, up: 0 }] },
  // roBrowser effect 315 (EF_GLASSWALL2, the safety wall unit): the client's safetywall.str once, with
  // ef_glasswall.wav, and three tall purple glows of alpha_down.tga turning round the cell (CYLINDER animation 0:
  // full size from the start; radius 0.6 / 0.65 / 0.7, 7 / 6 / 7 cells high, the last two 50 / 100 ms later,
  // colour 0.5, 0.1, 0.5, alpha 0.4, additive) for as long as the wall stands. roBrowser fades them in and out
  // over a quarter of a fixed 50 s; here over 300 ms (by eye). Their tops rise and sink a little (3%, every 1.6 s:
  // by request), and sandbox.js fades them as the wall wears down.
  EF_SAFETYWALL: { wav: 'effect/ef_glasswall.wav', layers: [
    { type: 'str', file: 'safetywall.str' },
    ...[[0.6, 7, 0], [0.65, 6, 50], [0.7, 7, 100]].map(([r, height, at]) => ({ type: 'cylinder', file: 'alpha_down.tga', duration: null,
      bottom: r, top: r, height, at, fixed: true, fadeMs: 300, color: [0.5, 0.1, 0.5], alpha: 0.4, add: true, bob: 0.03, bobMs: 1600 })),
  ] },
  // roBrowser effect 141 (EF_PNEUMA, the pneuma unit): one of the client's pneuma1–3.str (10.3 s, about the
  // pneuma's 10) at its middle cell, cut off as it goes. Neither roBrowser nor the client has a sound for it.
  EF_PNEUMA: { layers: [{ type: 'str', file: ['pneuma1.str', 'pneuma2.str', 'pneuma3.str'] }] },
  // roBrowser effect 304 (EF_TELEPORTATION2): where a unit was as it teleports away, four pale blue columns of
  // ring_blue.tga (radius 0.3 / 0.6–0.8 / 0.8–1 / 1–1.3 at the bottom–top) rising to their height and sinking
  // back (animation 5), additive, with ef_teleportation.wav. By request the tallest a little over the character's
  // head at its peak (7 / 5 / 2.6 / 1 cells; roBrowser 35 / 25 / 13 / 5; by eye 3 / 2.1 / 1.1 / 0.45 and
  // 4.5 / 3.2 / 1.65 / 0.7 on the way), half as bright (alpha 0.25; roBrowser 0.5) and over 800 ms (roBrowser 1.5 s).
  EF_TELEPORT: { wav: 'effect/ef_teleportation.wav', layers: [[0.3, 0.3, 7], [0.6, 0.8, 5], [0.8, 1, 2.6], [1, 1.3, 1]].map(([bottom, top, height]) =>
    ({ type: 'cylinder', file: 'ring_blue.tga', duration: 800, bottom, top, height, swell: true, alpha: 0.25, color: [0.6, 0.6, 1], add: true })) },
  // landing from a teleport (not in roBrowser, which has none: by request): roBrowser effect 6 (EF_ENTRY, a unit
  // coming into a map), a column of ring_blue.tga rising round it (animation 1); here radius 0.6 and 0.55 (roBrowser
  // 0.9 / 0.85), 3 cells high (roBrowser 7.5 / 8), alpha 0.3 (roBrowser 0.62), rising over 700 ms (roBrowser 500).
  // It starts before the unit shows and fades out in TP_LAND_FADE_MS as it touches down (see sandbox.js
  // teleporting); ef_portal.wav plays then, 550 ms in (the sound roBrowser
  // plays as a character comes into sight: EF_ENTRY / EF_ENTRY2 on NOTIFY_NEWENTRY; without EF_ENTRY's ef_ruwach).
  EF_TELEPORT_LAND: { wav: 'effect/ef_portal.wav', wavDelay: 550, layers: [[0.6, 3], [0.55, 3.2]].map(([r, height]) =>
    ({ type: 'cylinder', file: 'ring_blue.tga', duration: 700, bottom: r, top: r, height, rise: true, alpha: 0.3, add: true })) },
  // roBrowser effect 316 (EF_READYPORTAL2, the warp portal before it opens): a flat ring of ring_blue.tga
  // widening on the ground (radius 2.4 → 3.9 from nothing over 500 ms, animation 4, 0.1 high and 0.1 off the
  // ground), fading out, a new one every 200 ms (repeatDelay −300), alpha 0.4, additive; ef_readyportal.wav
  EF_READYPORTAL: { wav: 'effect/ef_readyportal.wav', layers: [portalRing()] },
  // roBrowser effect 317 (EF_PORTAL2, the open warp portal): the same rings and two pale blue columns of
  // ring_blue.tga (radius 0.6 and 0.8), at full size (animation 0), fading in and out over 300 ms (roBrowser: a
  // quarter of a fixed 25 s), with ef_portal.wav. By request half as bright (alpha 0.15; roBrowser 0.3) and 8 and
  // 7 cells high (roBrowser 15 and 13; by eye 5 and 4.3 on the way), and without roBrowser's band of alpha1.tga
  // 1 cell high 2 cells up (radius 1, alpha 0.5).
  EF_PORTAL: { wav: 'effect/ef_portal.wav', layers: [
    portalRing(),
    ...[[0.6, 8], [0.8, 7]].map(([r, height]) =>
      ({ type: 'cylinder', file: 'ring_blue.tga', duration: null, bottom: r, top: r, height, fixed: true, fadeMs: 300, alpha: 0.15, color: [0.6, 0.6, 1], add: true })),
  ] },
  // roBrowser effect 169 (EF_ENERGYCOAT): Energy Coat going on, the client's energycoat.str. roBrowser gives it no
  // sound, nor has the client one of its own; abc_chasing_break.wav plays with it here (picked by the user; at
  // first Kyrie Eleison's kyrie_guard.wav)
  EF_ENERGYCOAT: { wav: 'effect/abc_chasing_break.wav', layers: [{ type: 'str', file: 'energycoat.str' }] },
  // roBrowser effect 27 (EF_FROSTDIVER): Frost Diver's ice spikes springing up along the ground from the caster
  // to the target (the client's ice.tga). roBrowser gives it no sound; the client's own ef_frostdiver.wav
  // plays with it here. By eye, the spikes stop at the target (roBrowser: overshoot 2 cells past it) and
  // stand with their middle on the ground, half as tall out of it (roBrowser: 0.9 of their height up).
  EF_FROSTDIVER: { wav: 'effect/ef_frostdiver.wav', layers: [
    { type: 'trail', file: 'ice.tga', duration: 2500, every: 17, speed: 24, overshoot: 0, spread: [0.1, 0.3],
      height: [0.2, 1.8], bottom: [0.06, 0.22], tilt: 15, up: 0, sink: 2, rise: 330, life: 670, fade: 170 },
  ] },
  // roBrowser effect 123 (EF_GRIMTOOTH): Grimtooth's stone spikes (the client's stone.bmp) springing up along the
  // ground from the user to the target and 3 cells past it, with ef_frostdiver.wav, as roBrowser has them (its
  // QuadHorn offsetZ 0: `up` 0)
  EF_GRIMTOOTH: { wav: 'effect/ef_frostdiver.wav', layers: [
    { type: 'trail', file: 'stone.bmp', duration: 2500, every: 50, speed: 24, overshoot: 3, spread: [0, 0],
      height: [0.6, 1.0], bottom: [0.05, 0.1], tilt: 15, up: 0, sink: 0.8, rise: 330, life: 670, fade: 170 },
  ] },
  // roBrowser effect 132 (EF_GRIMTOOTHATK): three big stone spikes standing at the one Grimtooth hits, rising out of
  // the ground (its 15 s, as roBrowser has it); where each stands and how it leans at random (by request: roBrowser's
  // are set, up to half a cell off and 15° over)
  EF_GRIMTOOTHATK: { layers: [
    { type: 'horns', file: 'stone.bmp', count: 3, spread: 0.5, tilt: 15,
      height: 2.5, bottom: 0.15, up: 0, sink: 2.5, rise: 150, life: 15000, fade: 300 },
  ] },
  // roBrowser effect 79 (EF_EARTHSPIKE): Earth Spike on its target, one big spike of the client's stone.bmp near the
  // middle of the cell (0.95–1.5 high, 0.5–0.6 across, leaning up to 8°) jumping up out of the ground (animation 3:
  // half its height more over 120 ms a unit, then back), and four small ones (0.2–0.4 high, 0.1–0.2 across, up to 15°)
  // round the cell's edge already up (animation 2 to an offsetZ below 0: at once); their bases 0.1 below the ground
  // (offsetZ −0.1: `up` 0.9 less that over their height), standing 5 s, with wizard_earthspike.wav. (Its 200 ms
  // camera quake is not done.)
  EF_EARTHSPIKE: { wav: 'effect/wizard_earthspike.wav', layers: [
    { type: 'horns', file: 'stone.bmp', count: 1, off: [[-0.1, 0.1], [-0.1, 0.1]], tilt: 8, height: [0.95, 1.5], bottom: [0.5, 0.6],
      up: 0.82, sink: 0, pop: 0.5, rise: 70, life: 5000, fade: 200 },
    ...[[[-0.5, -0.5], [0, 0]], [[-0.5, 0], [0, 0.5]], [[0.5, 0.7], [0, 0.3]], [[0, 0.2], [-0.5, -0.7]]].map(off => (
      { type: 'horns', file: 'stone.bmp', count: 1, off, tilt: 15, height: [0.2, 0.4], bottom: [0.1, 0.2],
        up: 0.57, sink: 0, rise: 1, life: 5000, fade: 200 })),
  ] },
  // roBrowser effect 142 (EF_HEAVENDRIVE): Heaven's Drive, a spike of stone.bmp on each cell of its 5×5 (`grid` 2),
  // 0.3 cells south-west of the cell's middle (offsetX / offsetY 0.2), 0.75–1.2 high, 0.4–0.7 across, leaning up to 8°,
  // jumping up out of the ground (animation 3, 250 ms a unit: half its height more over about 120 ms), standing 1 s.
  // roBrowser gives it no sound; the client's wizard_earthspike.wav here (by ear)
  EF_HEAVENDRIVE: { wav: 'effect/wizard_earthspike.wav', layers: [
    { type: 'horns', file: 'stone.bmp', grid: 2, off: [[-0.3, -0.3], [-0.3, -0.3]], tilt: 8, height: [0.75, 1.2], bottom: [0.4, 0.7],
      up: 0.8, sink: 0, pop: 0.5, rise: 120, life: 1000, fade: 200 },
  ] },
  // roBrowser effect 95 (EF_QUAGMIRE): a Quagmire cell, the client's quagmire.str (2 s) over and over while it lies there,
  // with wizard_quagmire.wav
  EF_QUAGMIRE: { wav: 'effect/wizard_quagmire.wav', layers: [{ type: 'str', file: 'quagmire.str', loop: true }] },
  // roBrowser effect 147 (EF_EARTHHIT): an earth spell's hit, the client's earthhit.str on the one hit
  EF_EARTHHIT: { layers: [{ type: 'str', file: 'earthhit.str' }] },
  // roBrowser effect 74 (EF_ICEWALL): an Ice Wall's cell, three of roBrowser's QuadHorns of the client's ice.tga up to a
  // quarter cell off its middle, turned at random, 2.8–3.3, 2.3–2.8 and 2.5–2.9 high (half their length) and 0.3–0.5
  // across, their base a tenth of that below the ground (up 0.9), alpha-blended (blendMode 8), growing up out of it
  // over 150 ms (animation 1: their height from nothing, 50 ms a unit), standing till the cell is gone, with
  // wizard_icewall.wav (once for the wall)
  EF_ICEWALL: { wav: 'effect/wizard_icewall.wav', layers: [[2.8, 3.3], [2.3, 2.8], [2.5, 2.9]].map(height => (
    { type: 'horns', file: 'ice.tga', count: 1, spread: 0.25, tilt: 0, height, bottom: [0.3, 0.5], up: 0.9, sink: 3, rise: 150,
      life: Infinity, fade: 1 })) },
  // roBrowser effect 28 (EF_FROSTDIVER2): Frost Diver hitting, the client's freeze.str
  EF_FROSTDIVER2: { wav: 'effect/ef_frostdiver2.wav', layers: [{ type: 'str', file: 'freeze.str' }] },
  // roBrowser's body state STUN: the client's status-stun sprite (stars going round) over the unit's head, looping
  // for as long as the stun (the caller's duration; `up: 'head'`: the height play is given), with _stun.wav
  EF_STUN: { wav: '_stun.wav', layers: [{ type: 'spr', sprite: 'png/effect/status-stun', action: 0, delay: 96, duration: null, up: 'head' }] },
  // roBrowser's body state SLEEP: the client's status-sleep sprite over the unit's head, looping for as long as the
  // sleep, without a sound; its health state CURSE: status-curse at half opacity the same way, with _curse.wav
  EF_SLEEP: { layers: [{ type: 'spr', sprite: 'png/effect/status-sleep', action: 0, delay: 96, duration: null, up: 'head' }] },
  EF_CURSE: { wav: '_curse.wav', layers: [{ type: 'spr', sprite: 'png/effect/status-curse', action: 0, delay: 96, duration: null, up: 'head', alpha: 0.5 }] },
  // roBrowser's health state SILENCE: the client's emotion sprite, action 10 (ET_THINK, the "…"), over the unit's
  // head, looping for as long as the silence (the caller's duration), with _silence.wav. Blind and confusion
  // the same way with action 16 (ET_KEK) and 52 (ET_CONFUSE) and their own sounds (not in roBrowser, which
  // shows neither: by request).
  EF_SILENCE: { wav: '_silence.wav', layers: [{ type: 'spr', sprite: 'png/effect/emotion', action: 10, delay: 48, duration: null, up: 'head' }] },
  EF_BLIND: { wav: '_blind.wav', layers: [{ type: 'spr', sprite: 'png/effect/emotion', action: 16, delay: 48, duration: null, up: 'head' }] },
  EF_CONFUSE: { wav: '_confusion.wav', layers: [{ type: 'spr', sprite: 'png/effect/emotion', action: 52, delay: 48, duration: null, up: 'head' }] },
  // a frozen unit's ice block (roBrowser's body state FREEZE: the client's 이팩트/얼음땡 "ice tag" sprite,
  // action 0, over the unit), for as long as the freeze. It and its shattering are depth-tested as the unit's
  // own sprite (depth), so a unit standing in front of the frozen one covers them.
  EF_ICEBLOCK: { layers: [{ type: 'spr', sprite: 'png/effect/얼음땡', action: 0, delay: 1000, duration: null, up: 0, depth: true }] },
  // the freeze ending: the block shattering (action 1, 22 frames of 24 ms) with _frozen_explosion.wav
  EF_ICEBREAK: { wav: '_frozen_explosion.wav', layers: [{ type: 'spr', sprite: 'png/effect/얼음땡', action: 1, delay: 24, duration: 22 * 24, up: 0, depth: true }] },
  // roBrowser effect 16: Bash's burst on the user, a spinning halo and two sets of rays; behind the user and
  // 700 ms (by request; roBrowser over everything, 1000 ms). EF_BASH_SOUND: its sound alone (Mammonite's)
  EF_BASH: { wav: 'effect/ef_bash.wav', layers: BASH_GLOW },
  EF_BASH_SOUND: { wav: 'effect/ef_bash.wav', layers: [] },
};

// a song's picture standing on its cells: this many of its pixels a cell (EF_SONG_*)
const TILE_PX = 40;
// how long a cell of a song's ground takes to rise and fade in, or to sink and fade out, and how far (cells)
export const TILE_FADE_MS = 600;
const TILE_RISE = 0.18;
// a `planes` song picture's put off its cell's middle as much as this (cells) either way: anywhere in the cell, so they
// are spread evenly over the whole area, not bunched on the cells' middles (by request); and how far it is sunk under the
// ground, its share of its height (by request: less of its white middle showing)
const PLANE_SPREAD = 0.5, PLANE_SINK = 0.13;
// a number in [0, 1) for cell (x, y), the k-th thing on it, its `salt`-th draw: the same every time
const cellRand = (x, y, k, salt) => { const v = Math.sin(x * 127.1 + y * 311.7 + k * 74.7 + salt * 19.3) * 43758.5453; return v - Math.floor(v); };
let api = null, dir = '';
const live = [];  // effects playing: { layers: [{ def, start, end, ...state }], w }
export function init(opts) {
  api = opts;
  dir = opts.dataDir + '/texture/effect/';
}

// ---------- textures ----------
const images = new Map();  // file → Promise of a canvas (null: it could not be read)
// pictures drawn here, as `gen:<name>` (none in the client): shards of a broken bottle (by request), three shapes of
// pale glass with a bright edge
const SHARDS = [[[2, 1], [14, 5], [6, 15]], [[1, 6], [15, 2], [11, 13], [4, 14]], [[8, 0], [15, 12], [1, 10]]];
const GEN = Object.fromEntries(SHARDS.map((pts, i) => [`shard${i}`, () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 16;
  const g = cv.getContext('2d');
  g.beginPath(); pts.forEach(([x, y], j) => j ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath();
  g.fillStyle = 'rgba(205, 235, 255, 0.75)'; g.fill();
  g.strokeStyle = 'rgba(255, 255, 255, 1)'; g.lineWidth = 1.2; g.stroke();
  return cv;
}]));
export function image(file) {
  if (file.startsWith('gen:')) { if (!images.has(file)) images.set(file, Promise.resolve(GEN[file.slice(4)]?.() || null)); return images.get(file); }
  const png = file.startsWith('png/');  // a converted sprite frame (already transparent)
  if (!images.has(file)) images.set(file, fetch(encodeURI('../assets/' + (png ? '' : dir) + file)).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status))
    .then(b => /\.tga$/i.test(file) ? decodeTga(b) : png ? decodePng(b) : decodeBmp(b)).catch(() => null));
  return images.get(file);
}
// what an effect layer's material shows until its own picture is there (a texture comes a tick after the layer starts,
// even one loaded already): nothing — with no map at all a material draws a white square (by report: Jupitel Thunder's
// hits flashed so)
let blankTex = null;
function blank() {
  if (!blankTex) { blankTex = new THREE.DataTexture(new Uint8Array(4), 1, 1); blankTex.needsUpdate = true; }
  return blankTex;
}
// textures are not flipped (as roBrowser uploads them): v = 0 is the image's top row. raw: for the STR
// shader, which writes colours out unconverted (like the sprites); otherwise sRGB for MeshBasicMaterial.
const textures = new Map();
function texture(file, raw = false) {
  const key = (raw ? 'raw:' : '') + file;
  if (!textures.has(key)) textures.set(key, image(file).then(cv => {
    if (!cv) return null;
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = raw ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.flipY = false;
    return t;
  }));
  return textures.get(key);
}
// STR texture `file` faded out toward its edges: × 1 within 0.75 of the way from its middle to the nearest edge, down
// to 0 at the circle touching the edges (and outside it)
const softened = new Map();
function softTexture(file) {
  if (!softened.has(file)) softened.set(file, image(file).then(cv => {
    if (!cv) return null;
    const out = document.createElement('canvas');
    out.width = cv.width; out.height = cv.height;
    const g = out.getContext('2d');
    g.drawImage(cv, 0, 0);
    const im = g.getImageData(0, 0, out.width, out.height), d = im.data, hw = out.width / 2, hh = out.height / 2;
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      const r = Math.hypot((x + 0.5 - hw) / hw, (y + 0.5 - hh) / hh), k = Math.max(0, Math.min(1, (1 - r) / 0.25)), i = (y * out.width + x) * 4;
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
    g.putImageData(im, 0, 0);
    const t = new THREE.CanvasTexture(out);
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = false;
    return t;
  }));
  return softened.get(file);
}
// texture `file` fading out toward its top row (a cylinder's top edge): the top `share` of it, its alpha going
// down to nothing at the top (`fadeTop`)
const topFaded = new Map();
function topFadedTexture(file, share) {
  const key = file + '@' + share;
  if (!topFaded.has(key)) topFaded.set(key, image(file).then(cv => {
    if (!cv) return null;
    const out = document.createElement('canvas');
    out.width = cv.width; out.height = cv.height;
    const g = out.getContext('2d');
    g.drawImage(cv, 0, 0);
    const im = g.getImageData(0, 0, out.width, out.height), d = im.data, n = out.height * share;
    for (let y = 0; y < out.height; y++) {
      const k = Math.min(1, (y + 0.5) / n);
      for (let x = 0; x < out.width; x++) d[(y * out.width + x) * 4 + 3] *= k;
    }
    g.putImageData(im, 0, 0);
    const t = new THREE.CanvasTexture(out);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    return t;
  }));
  return topFaded.get(key);
}
// texture `file` with only the pixels whose r, g and b are all at least `min` (0–1), opaque, the rest clear (`keep`)
const keyed = new Map();
// (`soft`: not cut at `min` but fading in from min − soft to min + soft, so its edge is not jagged)
function keyedTexture(file, min, soft = 0) {
  const key = file + '@' + min + '~' + soft;
  if (!keyed.has(key)) keyed.set(key, image(file).then(cv => {
    if (!cv) return null;
    const out = document.createElement('canvas');
    out.width = cv.width; out.height = cv.height;
    const g = out.getContext('2d');
    g.drawImage(cv, 0, 0);
    const im = g.getImageData(0, 0, out.width, out.height), d = im.data, k = min * 255;
    const lo = (min - soft) * 255, span = 2 * soft * 255;
    for (let i = 0; i < d.length; i += 4) {
      if (!soft) { d[i + 3] = d[i] >= k && d[i + 1] >= k && d[i + 2] >= k ? 255 : 0; continue; }
      const v = Math.min(d[i], d[i + 1], d[i + 2]);
      d[i + 3] = Math.round(255 * Math.max(0, Math.min(1, (v - lo) / span)));
    }
    g.putImageData(im, 0, 0);
    const t = new THREE.CanvasTexture(out);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    return t;
  }));
  return keyed.get(key);
}
// a converted model (`model` layers): its scene, loaded once and copied for each use (sharing its geometry and
// materials), drawn unlit (the arena has no lights) with its textures as they are
const models = new Map();  // file → Promise of a THREE.Object3D (null: it could not be read)
function model(file) {
  if (!models.has(file)) models.set(file, new GLTFLoader().loadAsync('../assets/' + file.split('/').map(encodeURIComponent).join('/')).then(g => {
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      const m = o.material;
      o.material = new THREE.MeshBasicMaterial({ map: m.map, transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest, side: THREE.DoubleSide });
    });
    return g.scene;
  }).catch(() => null));
  return models.get(file);
}
// TGA: uncompressed (2) or RLE (10) true colour, 24 or 32 bits, BGR(A); bit 5 of the descriptor = top-down
function decodeTga(buf) {
  const d = new Uint8Array(buf), dv = new DataView(buf);
  const type = d[2], w = dv.getUint16(12, true), h = dv.getUint16(14, true), bpp = d[16] >> 3, topDown = d[17] & 0x20;
  if ((type !== 2 && type !== 10) || (bpp !== 3 && bpp !== 4)) throw new Error('unsupported TGA');
  const px = new Uint8ClampedArray(w * h * 4);
  let p = 18 + d[0], i = 0;
  const put = () => { px[i] = d[p + 2]; px[i + 1] = d[p + 1]; px[i + 2] = d[p]; px[i + 3] = bpp === 4 ? d[p + 3] : 255; i += 4; };
  if (type === 2) while (i < px.length) { put(); p += bpp; }
  else while (i < px.length) {
    const c = d[p++], n = (c & 0x7f) + 1;
    if (c & 0x80) { for (let k = 0; k < n; k++) put(); p += bpp; }
    else for (let k = 0; k < n; k++) { put(); p += bpp; }
  }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const img = new ImageData(px, w, h), g = cv.getContext('2d');
  if (topDown) g.putImageData(img, 0, 0);
  else {  // rows are stored bottom-up
    const flip = new ImageData(w, h);
    for (let y = 0; y < h; y++) flip.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    g.putImageData(flip, 0, 0);
  }
  return cv;
}
async function decodePng(buf) {
  const im = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
  const cv = document.createElement('canvas');
  cv.width = im.width; cv.height = im.height;
  cv.getContext('2d').drawImage(im, 0, 0);
  return cv;
}
async function decodeBmp(buf) {
  const im = await createImageBitmap(new Blob([buf], { type: 'image/bmp' }));
  const cv = document.createElement('canvas');
  cv.width = im.width; cv.height = im.height;
  const g = cv.getContext('2d');
  g.drawImage(im, 0, 0);
  const id = g.getImageData(0, 0, cv.width, cv.height), a = id.data;
  for (let k = 0; k < a.length; k += 4) if (a[k] > 250 && a[k + 1] < 5 && a[k + 2] > 250) a[k + 3] = 0;
  g.putImageData(id, 0, 0);
  return cv;
}

// ---------- STR ----------
// "STRM", version 0x94, fps, frame count, layer count, 16 unknown bytes; per layer its texture names
// (128 bytes, CP949, relative to texture/effect/) and keyframes of 124 bytes (roBrowser Loaders/Str.js)
const strs = new Map();  // file → Promise of { fps, maxKey, layers: [{ textures: [Promise], keys }] }
function loadStr(file) {
  if (!strs.has(file)) strs.set(file, fetch(encodeURI('../assets/' + dir + file)).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status))
    .then(parseStr).catch(() => null));
  return strs.get(file);
}
const cp949 = new TextDecoder('euc-kr');
function parseStr(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'STRM') throw new Error('not an STR');
  const fps = dv.getUint32(8, true), maxKey = dv.getUint32(12, true), n = dv.getUint32(16, true);
  let p = 36;
  const f = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const layers = [];
  for (let l = 0; l < n; l++) {
    const names = [];
    for (let k = i32(); k > 0; k--) {
      const b = u8.subarray(p, p + 128);
      names.push(cp949.decode(b.subarray(0, b.indexOf(0) < 0 ? 128 : b.indexOf(0))));
      p += 128;
    }
    const keys = [];
    for (let k = i32(); k > 0; k--) {
      const key = { frame: i32(), type: i32(), pos: [f(), f()], uv: [f(), f(), f(), f(), f(), f(), f(), f()],
                    xy: [f(), f(), f(), f(), f(), f(), f(), f()], aniframe: f(), anitype: i32(), delay: f(),
                    angle: f() * 360 / 1024, color: [f() / 255, f() / 255, f() / 255, f() / 255] };
      key.src = i32(); key.dst = i32(); p += 4;  // mtpreset
      keys.push(key);
    }
    keys.sort((a, b) => a.frame - b.frame);  // stable: a source key stays before its delta key
    layers.push({ names, keys, textures: names.map(nm => texture(nm, true)) });
  }
  return { fps, maxKey, layers };
}
// A layer at frame k (roBrowser StrEffect calculateAnimation): the last source key (type 0) at or before
// k, plus the following delta key (type 1, per-frame increments) times the frames since; null when the
// layer shows nothing then.
function strFrame(layer, k) {
  const keys = layer.keys;
  let from = -1, to = -1, last = 0, lastSource = 0;
  keys.forEach((a, i) => {
    if (a.frame <= k) { if (a.type === 0) from = i; if (a.type === 1) to = i; }
    last = Math.max(last, a.frame);
    if (a.type === 0) lastSource = Math.max(lastSource, a.frame);
  });
  if (from < 0 || (to < 0 && last < k)) return null;
  const a = keys[from], b = keys[to], d = k - a.frame;
  if (to !== from + 1 || b.frame !== a.frame) {  // a static key
    if (b && lastSource <= a.frame) return null;
    return { ...a, tex: a.aniframe };
  }
  const add = (x, y) => x.map((v, i) => v + y[i] * d);
  let tex = 0;
  const count = layer.names.length;
  if (b.anitype === 1) tex = a.aniframe + b.aniframe * d;
  else if (b.anitype === 2) tex = Math.min(a.aniframe + b.delay * d, count - 1);
  else if (b.anitype === 3) tex = (a.aniframe + b.delay * d) % count;
  else if (b.anitype === 4) tex = (a.aniframe - b.delay * d) % count;
  return { pos: add(a.pos, b.pos), xy: add(a.xy, b.xy), color: add(a.color, b.color), angle: a.angle + b.angle * d,
           src: a.src, dst: a.dst, tex };
}
// D3DBLEND codes → three.js blend factors
const D3DBLEND = { 1: THREE.ZeroFactor, 2: THREE.OneFactor, 3: THREE.SrcColorFactor, 4: THREE.OneMinusSrcColorFactor,
  5: THREE.SrcAlphaFactor, 6: THREE.OneMinusSrcAlphaFactor, 7: THREE.DstAlphaFactor, 8: THREE.OneMinusDstAlphaFactor,
  9: THREE.DstColorFactor, 10: THREE.OneMinusDstColorFactor, 11: THREE.SrcAlphaSaturateFactor };
// one textured quad of an STR layer, in the camera plane (sprite px, y down) around the unit's feet
// (GROUND: an STR in the scene, `ground` (Lightning Bolt's: by request, it showed through walls): depth-tested, its
// depth a sprite's at the unit's feet (pulled DEPTH_BIAS, a hair more so it is over the unit it strikes), and over the
// floor in front of them as a dying monster is (walker.js OVER_FLOOR): the floor cuts none of it, walls and models do,
// as does a unit standing in front)
const STR_VERT = `
in vec3 position; in vec2 uv;
uniform mat4 modelViewMatrix, projectionMatrix;
out vec2 vUv;
#ifdef GROUND
${FLOOR_DEPTH_OUT}
#endif
void main() {
  vUv = uv;
  vec4 feet = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * (feet + vec4(position.xy, 0.0, 0.0));
#ifdef GROUND
  floorDepthVert(feet, feet.xyz + vec3(position.xy, 0.0));
  vec4 d = projectionMatrix * (feet + vec4(0.0, 0.0, ${(DEPTH_BIAS + 0.05).toFixed(3)}, 0.0));
  gl_Position.z = d.z / d.w * gl_Position.w;
#else
  gl_Position.z -= 0.1 * gl_Position.w / 100.0;  // a little in front, as roBrowser pulls it toward the camera
#endif
}`;
const STR_FRAG = `
precision highp float;
in vec2 vUv;
uniform sampler2D map;
uniform vec4 color;
uniform bool premul, lum;
out vec4 fragColor;
#ifdef GROUND
${FLOOR_DEPTH_IN}
#endif
void main() {
#ifdef GROUND
  floorDepth();
#endif
  vec4 c = texture(map, vUv) * color;
  if (c.a == 0.0 || c.rgb == vec3(0.0)) discard;
  // lum: a black-backed picture drawn over what is under it, its brightness as its opacity
  float m = max(c.r, max(c.g, c.b));
  fragColor = premul ? vec4(c.rgb * c.a, c.a) : lum ? vec4(c.rgb / m, c.a * m) : c;
}`;
// Effects are drawn after the sprites (renderOrder 12). Flat ones that belong in the camera plane — STR
// animations like Sonic Blow's 滅, the critical streaks, flashes and pictures over a unit — go over the
// units with the depth test off (OVER_UNITS). Ones standing in the scene — cast auras, Heal's pillars,
// Magnum Break's ring and dome, particles around a unit — are depth-tested (inDepth), so their back half
// goes behind the unit. A sprite gives its whole picture one depth, its feet pulled DEPTH_BIAS (1.5 cells)
// toward the camera (walker.js SPRITE_VERT); such an effect is pulled the same way, so it is compared with
// each unit as if the unit stood upright at its feet (without that, all of a ring around the feet would be
// behind the body). None of them write depth, so they add up over each other as before.
const OVER_UNITS = { depthWrite: false, depthTest: false };
// `lift`: cells the thing is drawn above the ground where it stands (an orbit's `up`): its depth is taken
// at that ground point, as a sprite's is at its feet — taken where it is drawn, being higher would count as
// being nearer under the tilted camera, and Sight's fireballs passing behind a unit were drawn over it
function inDepth(material, lift = 0) {
  Object.assign(material, { depthTest: true, depthWrite: false });
  material.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  vec4 ground = mvPosition - viewMatrix * vec4(0.0, ${lift.toFixed(3)}, 0.0, 0.0);
  ground.z += ${DEPTH_BIAS.toFixed(3)};  // view space looks down -z
  vec4 d = projectionMatrix * ground;
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = d.z / d.w * gl_Position.w;`);
  };
  material.customProgramCacheKey = () => 'effect-depth-bias-' + lift;
  return material;
}
// a spike's part under the ground at height y (world units) not drawn: its depth being pulled toward the camera
// (centerDepth), the floor would not hide it (by report: Grimtooth's spikes showed whole). A spike's depth is that of
// the ground under its middle, where it comes out of it, as a sprite's is at its feet: taken at each point, its tip
// would count as nearer than a unit standing in front of its foot (the tilted camera) and show through it (by
// report); taken at its middle, high up for a tall one (Ice Wall's, up 0.9), it showed over a unit before it (by report)
// the same for a thing spread out in the air (a `bounce` layer's trails, a `sideways` ring): each point's depth that of
// the ground under it (at height floorY, set in material.userData.floorY.value), as a sprite's is at its feet, so a
// unit standing before it hides it
// (`center`: all of it at the depth of the ground under its middle, the mesh's origin, as a sprite's is)
function groundDepth(material, center = false) {
  const floorY = { value: 0 };
  Object.assign(material, { depthTest: true, depthWrite: false });
  material.userData.floorY = floorY;
  material.onBeforeCompile = sh => {
    sh.uniforms.floorY = floorY;
    sh.vertexShader = 'uniform float floorY;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  vec4 wp = modelMatrix * vec4(${center ? 'vec3(0.0)' : 'transformed'}, 1.0);
  vec4 ground = viewMatrix * vec4(wp.x, floorY, wp.z, 1.0);
  ground.z += ${DEPTH_BIAS.toFixed(3)};
  vec4 d = projectionMatrix * ground;
  gl_Position.z = d.z / d.w * gl_Position.w;`);
  };
  material.customProgramCacheKey = () => 'effect-ground-depth' + (center ? '-center' : '');
  return material;
}
function cutBelow(material, y) {
  const prev = material.onBeforeCompile, key = material.customProgramCacheKey;
  material.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.floorY = { value: y };
    sh.vertexShader = 'uniform float floorY;\nvarying float vWorldY;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  vWorldY = (modelMatrix * vec4(transformed, 1.0)).y;`).replace(/}\s*$/, `  vec4 foot = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 under = viewMatrix * vec4(foot.x, floorY, foot.z, 1.0);
  under.z += ${DEPTH_BIAS.toFixed(3)};
  vec4 du = projectionMatrix * under;
  gl_Position.z = du.z / du.w * gl_Position.w;
}`);
    sh.fragmentShader = 'uniform float floorY;\nvarying float vWorldY;\n' + sh.fragmentShader.replace('void main() {', 'void main() {\n  if (vWorldY < floorY) discard;');
  };
  material.customProgramCacheKey = () => key() + '-cut';
  return material;
}
// the same for a flat thing facing the camera (a `behind` ring): all of it at the depth of its centre's ground
// point (`lift` cells under it), as a sprite's quad is at its feet, so the floor does not cut its lower half
function centerDepth(material, lift = 0) {
  Object.assign(material, { depthTest: true, depthWrite: false });
  material.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  vec4 ground = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0) - viewMatrix * vec4(0.0, ${lift.toFixed(3)}, 0.0, 0.0);
  ground.z += ${DEPTH_BIAS.toFixed(3)};
  vec4 d = projectionMatrix * ground;
  gl_Position.z = d.z / d.w * gl_Position.w;`);
  };
  material.customProgramCacheKey = () => 'effect-center-depth-' + lift;
  return material;
}
function strMesh(ground = false) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  const mesh = new THREE.Mesh(geo, new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: STR_VERT, fragmentShader: STR_FRAG, transparent: true,
    ...ground ? { depthTest: true, depthWrite: false, defines: { GROUND: '' } } : OVER_UNITS,
    side: THREE.DoubleSide, blending: THREE.CustomBlending,
    uniforms: { map: { value: null }, color: { value: new THREE.Vector4(1, 1, 1, 1) }, premul: { value: false }, lum: { value: false } },
  }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  mesh.visible = false;
  return mesh;
}
const PX = 1 / 35;  // sprite pixel in cells
// place layer quad `mesh` for frame state `a`: corners xy (px) rotated by the angle, moved by pos − 320,
// all of it `scale` times as large (flip −1: mirrored left to right). `max`: an additive layer (D3DBLEND dst
// One, or DstAlpha: the canvas is opaque) is drawn keeping the brighter of it and what is under it
// (MaxEquation, its colour times its alpha) instead of adding up. `normal`: an additive layer is laid over
// what is under it instead (alpha blending, its brightness as its opacity).
async function strPose(mesh, layer, a, scale = 1, alpha = 1, max = false, flip = 1, normal = false, soft = null) {
  // roBrowser flips y (px run down) and then rotates by −angle, which comes to this with θ = angle
  const pos = mesh.geometry.attributes.position, r = a.angle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const k = PX * scale, corner = (i, x, y) => pos.setXYZ(i, (x * c - y * s + a.pos[0] - 320) * k * flip, -(x * s + y * c + a.pos[1] - 320) * k, 0);
  corner(0, a.xy[0], a.xy[4]); corner(1, a.xy[1], a.xy[5]); corner(2, a.xy[3], a.xy[7]); corner(3, a.xy[2], a.xy[6]);
  pos.needsUpdate = true;
  const m = mesh.material;
  m.uniforms.color.value.fromArray(a.color).multiplyScalar(alpha);
  m.blendSrc = D3DBLEND[a.src] || THREE.SrcAlphaFactor;
  m.blendDst = D3DBLEND[a.dst] || THREE.OneMinusSrcAlphaFactor;
  const add = m.blendDst === THREE.OneFactor || m.blendDst === THREE.DstAlphaFactor, keep = max && add;
  m.uniforms.lum.value = normal && add;
  if (normal && add) [m.blendSrc, m.blendDst] = [THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor];
  m.blendEquation = keep ? THREE.MaxEquation : THREE.AddEquation;
  m.uniforms.premul.value = keep;
  const ti = Math.floor(a.tex) || 0, tex = await (soft && soft.includes(layer.names[ti]) ? softTexture(layer.names[ti]) : layer.textures[ti]);
  m.uniforms.map.value = tex;
  mesh.visible = !!tex;
}

// fetch an effect's textures and sound ahead of its first use
export function preload(name) {
  const e = EFFECTS[name];
  if (!e) return;
  e.layers.forEach(l => l.type === 'str' ? [l.file].flat().forEach(loadStr) : l.type === 'spr' ? loadSpr(l.sprite)
    : l.type === 'model' ? model(l.file) : l.type === 'flash' ? image(l.file) : l.type === 'speed' || l.type === 'zap' || l.type === 'bounce' || l.type === 'qi' || l.type === 'spike' || l.type === 'link' ? null : l.files ? l.files.forEach(f => texture(f)) : l.paint ? l.paint() : texture(l.file));
  if (e.wav) [e.wav].flat().forEach(api.preloadSound);
  if (e.music) api.preloadSound(e.music);
  for (const [, file] of e.sounds || []) api.preloadSound(file);
}

// the assets effects `names` load (as preload does), as asset paths: { sprites: Set of sprite folders, files: Set }
// — a texture, an STR (raw/texture/effect/…; the textures an STR names inside are its own: the asset scripts add
// them), a model, a sound (raw/wav/…). No DOM: game/needs.js makes the game's list in Node too.
export function effectNeeds(names = Object.keys(EFFECTS)) {
  const sprites = new Set(), files = new Set(), add = files.add.bind(files);
  // (a texture named '../유저인터페이스/…' from texture/effect/: the path its URL comes to)
  files.add = f => { const out = []; for (const p of f.split('/')) p === '..' ? out.pop() : out.push(p); return add(out.join('/')); };
  const pic = f => { if (f && !f.startsWith('gen:')) files.add(f.startsWith('png/') ? f : 'raw/texture/effect/' + f); };
  const wav = f => { if (f) files.add('raw/wav/' + f.replace(/\\/g, '/')); };
  for (const name of names) {
    const e = EFFECTS[name];
    if (!e) continue;
    for (const l of e.layers) {
      if (l.type === 'str') [l.file].flat().forEach(f => files.add('raw/texture/effect/' + f));
      else if (l.type === 'spr') sprites.add(l.sprite);
      else if (l.type === 'model') files.add(l.file);
      else if (l.type === 'flash') pic(l.file);
      else if (['speed', 'zap', 'bounce', 'qi', 'spike', 'link'].includes(l.type) || l.paint) continue;
      else if (l.files) l.files.forEach(pic);
      else pic(l.file);
    }
    [e.wav].flat().forEach(wav);
    wav(e.music);
    for (const [, f] of e.sounds || []) wav(f);
  }
  return { sprites, files };
}

// ---------- playing ----------
const rand =r => Array.isArray(r) ? r[0] + Math.random() * (r[1] - r[0]) : r;
const pickOne = v => Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v;
// start effect `name` on walker w at time t (the sandbox clock); `duration` is for layers that take theirs
// from the caller (a cast aura lasts the cast). opts.silent: without its sound (one sound for several copies
// started together); opts.from: the walker it comes from (trail layers). Returns the effect, for stop.
// head: sprite px from the unit's feet to its head, for layers drawn `up: 'head'`; size: cells across, for
// `ground` layers (a ground skill's area)
// spin: its `still` cylinders turn all the same; scale: its cylinders that much smaller or larger (radii and
// height). The effect's `alpha` (1) can be changed while it plays: its cylinders' opacity is multiplied by it.
// The emotion.spr action of each emote (clif_emotion's ET_ id: roBrowser DB/Emotions.js; 1000: none drawn)
export const EMOTE_ACTION = [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 12, 11, 13, 14, 4, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 1000, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
  59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79];
export function play(name, w, t, duration, { silent = false, from = null, head = 0, size = 0, spin = false, scale = 1, action = 0, yaw = 0, grow = null, born = null } = {}) {
  const e = EFFECTS[name];
  if (!e) return null;
  if (e.wav && !silent && !e.wavDelay) api.playSound(pickOne(e.wav), e.wavVolume);
  // where this copy lands in the unit's cell, shared by its `fall` and `land` layers (`jitter` cells either way)
  const j = Math.max(0, ...e.layers.map(d => d.jitter || 0));
  // (`grow`: [ms, from] — a depth sprite growing from `from` of its size to all of it and fading in over ms from `born`,
  // by default t: Bomb's fire, stage.js; t may be earlier, for where in its loop it starts)
  const fx = { name, w, from, spin, scale, alpha: 1, layers: [], ex: rand([-j, j]), ey: rand([-j, j]), head, size, action, yaw, grow, born: born ?? t,
               sound: e.wav && !silent && e.wavDelay ? { at: t + e.wavDelay, file: pickOne(e.wav) } : null,
               sounds: silent ? [] : (e.sounds || []).map(([ms, file]) => ({ at: t + ms, file })) };
  for (const def of e.layers)
    for (let c = 0, n = def.perSec && duration ? Math.max(def.count || 1, Math.round(def.perSec * duration / 1000)) : def.copies || def.count || 1; c < n; c++) {
      const t0 = t + (def.at || 0), dur = rand(def.duration ?? duration), l = { def, start: t0, end: t0 + dur };
      if (def.type === 'sparks') {
        const start = t0 + c * def.every;
        const sy = def.spreadY ?? def.spread, w = rand(def.size) / 35;
        const x = rand([-def.spread, def.spread]), y = rand([-sy, sy]), o = def.out || 0;
        Object.assign(l, { start, end: def.repeat ? Infinity : start + dur, x, y, x1: x + rand([-o, o]), y1: y + rand([-o, o]),
                           z0: rand(def.z0), z1: rand(def.z1), w, h: def.h ? rand(def.h) / 35 : w });
        if (def.repeat) l.span = dur;
      }
      if (def.type === 'str') {
        if (!def.loop) l.end = Infinity;  // until the animation's last frame
        l.flip = def.flip && Math.random() < 0.5 ? -1 : 1;
        strCycle(l, t0);  // (from its `at`)
      } else if (def.type === 'model') {
        const g = l.mesh = new THREE.Group();
        model(def.file).then(src => { if (src && !l.gone) g.add(src.clone()); });
        g.rotation.y = fx.yaw;  // (`yaw`: turned about the up axis, Skid Trap's arrow)
        A.scene.add(g);
      } else if (def.type === 'tiles') {
        // a song's ground: on each cell of it round the player its picture standing on the cell's middle facing the camera,
        // each corner of it put out from there on screen (`corner`) as big as the picture is (TILE_PX of it a cell, `size`
        // times, `wide` times as wide; until it is there, none), added on, its magenta clear. Room for three areas of
        // cells, each fading in and out on its own (`fade`; see the update); what is under the ground is not drawn.
        // `planes`: that many on each cell instead, each standing upright in the world (not facing the camera) turned its
        // own way and put off the cell's middle its own way (`shape`: its way across, x and z, and its share of the height)
        const r = def.radius, cap = 3 * (2 * r + 1) ** 2 * (def.planes || 1), corner = [], uv = [], index = [];
        for (let q = 0; q < cap; q++) {
          const v = q * 4;
          corner.push(-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1);
          uv.push(0, 1, 1, 1, 1, 0, 0, 0);
          index.push(v, v + 1, v + 2, v, v + 2, v + 3);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 12), 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('fade', new THREE.BufferAttribute(new Float32Array(cap * 4), 1).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 2));
        geo.setAttribute('shape', new THREE.BufferAttribute(new Float32Array(cap * 12), 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setIndex(index);
        const mat = new THREE.MeshBasicMaterial({ map: blank(), transparent: true, side: THREE.DoubleSide, depthTest: true,
          depthWrite: false, opacity: def.alpha, blending: THREE.AdditiveBlending });
        const quad = { value: new THREE.Vector2(0, 0) }, floorY = { value: 0 };
        Object.assign(mat.userData, { floorY, quad });
        // (its depth that of the ground under it, pulled toward the camera as a figure's feet are: drawn after the figures,
        // one standing behind it is covered, one before it covers it)
        mat.onBeforeCompile = sh => {
          Object.assign(sh.uniforms, { quad, floorY });
          sh.vertexShader = 'attribute float fade;\nvarying float vFade;\nvarying float vAbove;\nattribute vec2 corner;\nattribute vec3 shape;\nuniform vec2 quad;\nuniform float floorY;\n'
            + sh.vertexShader.replace('#include <project_vertex>', def.planes ? `
  vFade = fade;
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vec3 at = wp.xyz + vec3(shape.x, 0.0, shape.y) * corner.x * quad.x + vec3(0.0, (corner.y - 0.5) * shape.z * quad.y, 0.0);
  vAbove = at.y - floorY;
  vec4 mvPosition = viewMatrix * vec4(at, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vec4 ground = viewMatrix * vec4(at.x, floorY, at.z, 1.0);
  ground.z += ${DEPTH_BIAS.toFixed(3)};
  vec4 d = projectionMatrix * ground;
  gl_Position.z = d.z / d.w * gl_Position.w;` : `
  vFade = fade;
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  vec2 off = corner * quad;
  mvPosition.xy += off;
  vAbove = wp.y - floorY + off.x * viewMatrix[1][0] + off.y * viewMatrix[1][1];
  gl_Position = projectionMatrix * mvPosition;
  vec4 ground = viewMatrix * vec4(wp.x, floorY, wp.z, 1.0);
  ground.z += ${DEPTH_BIAS.toFixed(3)};
  vec4 d = projectionMatrix * ground;
  gl_Position.z = d.z / d.w * gl_Position.w;`);
          sh.fragmentShader = 'varying float vFade;\nvarying float vAbove;\n' + sh.fragmentShader.replace('void main() {', 'void main() {\n  if (vAbove < 0.0) discard;')
            .replace('#include <opaque_fragment>', `#include <opaque_fragment>
  gl_FragColor.a *= vFade;`);
        };
        mat.customProgramCacheKey = () => 'effect-song-tiles' + (def.planes ? '-planes' : '');
        if (def.color) mat.color.setRGB(...def.color);
        const mesh = l.mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 13;
        l.cells = new Map();  // "x,y" → { x, y, a: how far in it has faded }
        texture(def.file).then(tex => {
          if (!tex) return;
          mat.map = tex; mat.needsUpdate = true;
          const s = (def.size || 1) / TILE_PX;
          quad.value.set(tex.image.width * s * (def.wide || 1), tex.image.height * s * (def.tall || 1));
          mat.userData.height = quad.value.y;  // (as tall as it gets: `ground` squashes it, see the update)
        });
        A.scene.add(mesh);
      } else if (def.type === 'ground') {
        const mesh = l.mesh = new THREE.Mesh(quadGeometry(), new THREE.MeshBasicMaterial({ map: blank(), transparent: true,
          depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
        mesh.frustumCulled = false;
        mesh.renderOrder = 10;
        if (def.keep) mesh.material.opacity = def.alpha ?? 1;
        (def.keep ? keyedTexture(def.file, def.keep, def.soft) : texture(def.file)).then(tex => { if (tex) { mesh.material.map = tex; mesh.material.needsUpdate = true; } });
        A.scene.add(mesh);
      } else if (def.type === 'quad' || def.type === 'sparks' || def.type === 'shot') {
        if (def.type === 'shot') Object.assign(l, { from: from || w, z0: rand(def.z0), back: rand(def.back || 0),
                                                    side: rand([-(def.side || 0), def.side || 0]), lift: rand(def.lift || 0) });
        const mesh = l.mesh = new THREE.Mesh(quadGeometry(), new THREE.MeshBasicMaterial({ map: blank(),
          transparent: true, ...OVER_UNITS, opacity: 0,
          blending: def.add || (def.type === 'shot' && !def.files && !def.normal) || (def.type === 'sparks' && !def.normal) ? THREE.AdditiveBlending : THREE.NormalBlending }));
        if (def.color) mesh.material.color.setRGB(...def.color);
        if (def.soft) mesh.material.alphaMap = softEnds();
        if ((def.type === 'shot' && (def.files ? def.add : !def.normal)) || (def.type === 'quad' && def.round)) mesh.material.alphaMap = roundEdge();
        if ((def.type === 'sparks' && !def.overlay) || (def.type === 'quad' && def.depth)) inDepth(mesh.material);
        mesh.frustumCulled = false;
        mesh.renderOrder = 13;
        // a shot's tail: copies of it trailing behind, each smaller and fainter
        l.tail = Array.from({ length: def.tail || 0 }, () => {
          const m = new THREE.Mesh(quadGeometry(), mesh.material.clone());
          m.frustumCulled = false;
          m.renderOrder = 13;
          A.scene.add(m);
          return m;
        });
        if (def.files) { l.texs = []; def.files.forEach((f, i) => texture(f).then(tex => { l.texs[i] = tex; })); }
        else texture(def.file).then(tex => {
          if (tex) for (const m of [mesh, ...l.tail]) { m.material.map = tex; m.material.needsUpdate = true; }
        });
        A.scene.add(mesh);
      } else if (def.type === 'fall') {
        const j = def.jitter || 0, { ex, ey } = fx;
        Object.assign(l, { ex, ey, x: ex + rand(def.x) + rand([-j, j]), y: ey + rand(def.y) + rand([-j, j]), z: rand(def.z), texs: [] });
        const mesh = l.mesh = new THREE.Mesh(quadGeometry(), new THREE.MeshBasicMaterial({ map: blank(),
          transparent: true, ...OVER_UNITS, blending: def.normal ? THREE.NormalBlending : THREE.AdditiveBlending }));
        mesh.frustumCulled = false;
        mesh.renderOrder = 13;
        mesh.visible = false;
        def.files.forEach((f, i) => texture(f).then(tex => { l.texs[i] = tex; }));
        A.scene.add(mesh);
      } else if (def.type === 'spray') {
        // the line from the one it comes from to the unit, on the ground as the camera looks (right, away)
        const a = (from || w).worldPosition(new THREE.Vector3()), b = w.worldPosition(new THREE.Vector3());
        const cv = A.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize(), cr = new THREE.Vector3(-cv.z, 0, cv.x);
        const dx = b.clone().sub(a), along = Math.atan2(dx.dot(cv), dx.dot(cr)) + rand([-def.spread, def.spread]) * Math.PI / 180;
        const ux = Math.cos(along), uy = Math.sin(along), back = rand(def.back), dist = rand(def.dist);
        Object.assign(l, { x0: -ux * back, y0: -uy * back, x1: -ux * back + ux * dist, y1: -uy * back + uy * dist, up: rand(def.up) });
        const mesh = l.mesh = new THREE.Mesh(quadGeometry(), inDepth(new THREE.MeshBasicMaterial({ map: blank(), transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending })));
        mesh.frustumCulled = false;
        mesh.renderOrder = 13;
        mesh.visible = false;
        texture(def.file).then(tex => { if (tex) { mesh.material.map = tex; mesh.material.needsUpdate = true; } });
        A.scene.add(mesh);
      } else if (def.type === 'ripple') {
        l.a = (c + rand([-0.3, 0.3])) / def.count * Math.PI * 2;
        l.v = def.vary ? [rand([1 - def.vary, 1 + def.vary]), rand([1 - def.vary, 1 + def.vary])] : [1, 1];
        const mesh = l.mesh = new THREE.Mesh(quadGeometry(), inDepth(new THREE.MeshBasicMaterial({ map: blank(), transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending })));
        mesh.frustumCulled = false;
        mesh.renderOrder = 13;
        mesh.visible = false;
        texture(def.file).then(tex => { if (tex) { mesh.material.map = tex; mesh.material.needsUpdate = true; } });
        A.scene.add(mesh);
      } else if (def.type === 'orbit' || def.type === 'burst') {
        l.texs = [];
        def.files.forEach((f, i) => texture(f).then(tex => { l.texs[i] = tex; }));
        if (def.type === 'burst') l.end = l.start + def.life + def.every * (def.copies - 1);
        l.orbs = Array.from({ length: def.type === 'burst' ? def.ways * def.copies : def.n }, () => {
          const fire = new THREE.Mesh(quadGeometry(), inDepth(new THREE.MeshBasicMaterial({ map: blank(), transparent: true, opacity: 0,
            blending: def.add ? THREE.AdditiveBlending : THREE.NormalBlending }), def.up));
          if (def.color) fire.material.color.setRGB(...def.color);
          fire.frustumCulled = false;
          fire.renderOrder = 13;
          fire.visible = false;
          A.scene.add(fire);
          let shadow = null;
          if (def.shadow) {
            shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
              map: shadowTexture(), transparent: true, opacity: def.shadow.alpha, depthWrite: false,
              polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
            shadow.frustumCulled = false;
            shadow.renderOrder = 10;
            shadow.visible = false;
            A.scene.add(shadow);
          }
          return { fire, shadow };
        });
      } else if (def.type === 'trail') {
        trailSpikes(l, from || w, w, t);
      } else if (def.type === 'horns') {
        hornSpikes(l, w, t);
      } else if (def.type === 'lockon') {  // flat on the ground, under the units (as the arena's rings)
        const mesh = l.mesh = new THREE.Mesh(quadGeometry(), new THREE.MeshBasicMaterial({ map: blank(), transparent: true, opacity: 0,
          depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
        mesh.frustumCulled = false;
        mesh.renderOrder = 10;
        (def.paint ? Promise.resolve(def.paint()) : texture(def.file)).then(tex => { if (tex) { mesh.material.map = tex; mesh.material.needsUpdate = true; } });
        A.scene.add(mesh);
      } else if (def.type === 'spr') {
        l.action = def.action === 'play' ? action : def.action || 0;
        loadSpr(def.sprite).then(spr => {
          l.spr = spr;
          const a = spr.act.actions[l.action];  // (`once`: as long as its frames take)
          if (def.once) l.end = l.start + (a ? a.frames.length * (def.delay ?? a.delay_ms) : 0);
        });
        if (def.depth) {  // its own canvas on a sprite quad at the unit's feet
          l.canvas = document.createElement('canvas');
          l.canvas.width = l.canvas.height = SPR_CANVAS;
          l.tex = new THREE.CanvasTexture(l.canvas);
          l.tex.colorSpace = THREE.NoColorSpace;
          l.mesh = spriteQuad(l.tex, SPR_CANVAS, SPR_FEET, 0.01);
          Object.assign(l.mesh.material, { depthWrite: false });
          l.mesh.renderOrder = 13;
          l.mesh.visible = false;
          A.scene.add(l.mesh);
        }
      } else if (def.type === 'speed') {
        Object.assign(l, { off: rand([-def.spread, def.spread]), back: rand(def.back), len: rand(def.len), width: rand(def.width),
                           travel: rand(def.travel), ang: Math.random() * 2 * Math.PI });
        if (def.perSec && duration) { const late = rand([0, Math.max(0, duration - dur)]); l.start += late; l.end += late; }
      } else if (def.type === 'spike') {
        const cone = Math.min(def.cone, 180) * Math.PI / 180;
        Object.assign(l, { yaw: rand([-cone, cone]), pitch: def.cone >= 180 ? Math.asin(rand([-1, 1])) : rand([-cone / 2, cone / 2]),
                           len: rand(def.len), width: rand(def.width) });
        // a triangle: its base across at x 0 (y ±0.5), its tip at x 1; brighter at the base
        const geo = new THREE.BufferGeometry(), [c0, c1] = def.color;
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -0.5, 0, 0, 0.5, 0, 1, 0, 0]), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([...c0, 1, ...c0, 1, ...c1, 0]), 4));
        l.mesh = new THREE.Mesh(geo, groundDepth(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending }), true));
        l.mesh.frustumCulled = false;
        l.mesh.renderOrder = 13;
        l.mesh.visible = false;
        A.scene.add(l.mesh);
      } else if (def.type === 'link' && def.streak) {
        // a ribbon from the one it comes from (x 0) to the unit (x 1), LINK_ACROSS across it (y), brightest along its middle
        // and fading out toward both ends and its edges; placed each frame (linkRibbon)
        const pos = [], col = [];
        for (const [x, ax] of LINK_ALONG) for (const [y, ay] of LINK_ACROSS) { pos.push(x, y, 0); col.push(...def.color, ax * ay); }
        const idx = [], n = LINK_ACROSS.length;
        for (let i = 0; i + 1 < LINK_ALONG.length; i++) for (let j = 0; j + 1 < n; j++) {
          const q = i * n + j;
          idx.push(q, q + n, q + 1, q + 1, q + n, q + n + 1);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
        geo.setAttribute('ground', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
        geo.setIndex(idx);
        l.mesh = new THREE.Mesh(geo, linkDepth(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending })));
        l.mesh.frustumCulled = false;
        l.mesh.renderOrder = 13;
        l.mesh.visible = false;
        A.scene.add(l.mesh);
      } else if (def.type === 'qi') {
        const cone = (def.cone || 0) * Math.PI / 180;
        Object.assign(l, { start: t0 + c * def.every, yaw: rand([-cone, cone]), pitch: rand([-cone / 2, cone / 2]), dist: rand(def.dist), spin: Math.random() * Math.PI * 2 });
        l.end = l.start + dur;
        l.mesh = new THREE.Mesh(quadGeometry(), groundDepth(new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending }), true));
        if (def.color) l.mesh.material.color.setRGB(...def.color);
        l.mesh.frustumCulled = false;
        l.mesh.renderOrder = 13;
        l.mesh.visible = false;
        A.scene.add(l.mesh);
      } else if (def.type === 'bounce') {
        Object.assign(l, { o: w.worldPosition(new THREE.Vector3()), ang: Math.random() * 2 * Math.PI, out: rand(def.out), rise: rand(def.rise) });
        // a ribbon facing the camera, BOUNCE_STEPS + 1 pairs of points along the trail, brighter toward its head
        const geo = new THREE.BufferGeometry(), n = BOUNCE_STEPS + 1, index = [], rgba = new Float32Array(n * 2 * 4);
        for (let k = 0; k < n; k++) {
          const c = [...(def.color || [1, 1, 1]), k / (n - 1)];
          rgba.set([...c, ...c], k * 8);
          if (k < n - 1) index.push(k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 1, k * 2 + 2, k * 2 + 3);
        }
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
        geo.setIndex(index);
        l.mesh = new THREE.Mesh(geo, groundDepth(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending })));
        l.mesh.material.userData.floorY.value = l.o.y;
        l.mesh.frustumCulled = false;
        l.mesh.renderOrder = 13;
        l.mesh.visible = false;
        A.scene.add(l.mesh);
      } else if (def.type === 'flash') {
        const a = rand(def.angle) * Math.PI / 180, out = rand(def.outer);
        Object.assign(l, { a, from: [rand(def.from[0]), rand(def.from[1])], to: [rand(def.to[0]), rand(def.to[1])],
                           p0: [Math.sin(a) * def.inner, Math.cos(a) * def.inner], p1: [Math.sin(a) * out, Math.cos(a) * out] });
        image(def.file).then(cv => { l.img = cv; });
      } else if (def.type === 'cylinder' || def.type === 'dome' || def.type === 'shell') {
        l.phase = Math.random();
        l.copy = c;
        l.mesh = def.type === 'dome' ? domeMesh() : def.type === 'shell' ? shellMesh(def)
          : cylinderMesh(def.facets || def.sides || CYLINDER_SIDES, def.repeat || 1, def.repeatV || 1);
        if (def.sideways) { l.mesh.material.dispose(); l.mesh.material = groundDepth(new THREE.MeshBasicMaterial({ map: blank(), transparent: true, side: THREE.DoubleSide, opacity: 0 })); }
        if (def.add) l.mesh.material.blending = THREE.AdditiveBlending;
        if (def.color) l.mesh.material.color.setRGB(...def.color);
        (def.keep ? keyedTexture(def.file, def.keep, def.soft) : def.fadeTop ? topFadedTexture(def.file, def.fadeTop) : texture(def.file)).then(tex => {
          if (!tex) return;
          if ((def.repeat > 1 || def.repeatV > 1) && tex.wrapS !== THREE.RepeatWrapping) {  // (`repeat` times across)
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.needsUpdate = true;
          }
          l.mesh.material.map = tex; l.mesh.material.needsUpdate = true;
        });
        A.scene.add(l.mesh);
      } else if (def.type === 'ring') {
        l.turn = Math.random() * Math.PI * 2;  // angleZRandom for the rays; also varies the halo's spin phase
        l.mesh = ringMesh(def);
        if (def.behind) centerDepth(l.mesh.material, def.up);
        texture(def.file).then(tex => { if (tex) { l.mesh.material.map = tex; l.mesh.material.needsUpdate = true; } });
        A.scene.add(l.mesh);
      }
      fx.layers.push(l);
    }
  live.push(fx);
  return fx;
}
// a trail's spikes, laid out along the ground from walker `from` to walker w as the effect starts (roBrowser:
// attachedEntity false, the line stays where it was drawn)
function trailSpikes(l, from, w, t) {
  const def = l.def, a = from.worldPosition(new THREE.Vector3()), b = w.worldPosition(new THREE.Vector3());
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), ux = d ? dx / d : 0, uz = d ? dz / d : -1;
  l.parts = [];
  for (let at = 0; at < def.duration; at += def.every) {
    const dist = at * def.speed / 1000;
    if (dist > d + def.overshoot) break;
    const ang = Math.random() * Math.PI * 2, off = rand(def.spread);
    const y = a.y + (b.y - a.y) * Math.min(1, d ? dist / d : 1);
    const mesh = new THREE.Mesh(hornGeometry(), cutBelow(centerDepth(new THREE.MeshBasicMaterial({ map: blank(), transparent: true, side: THREE.DoubleSide, alphaTest: 0.01 })), y));
    mesh.frustumCulled = false;
    mesh.renderOrder = 13;
    mesh.visible = false;
    mesh.rotation.set(rand([-def.tilt, def.tilt]) * Math.PI / 180, Math.random() * Math.PI * 2, 0, 'YXZ');
    texture(def.file).then(tex => { if (tex) { mesh.material.map = tex; mesh.material.needsUpdate = true; } });
    A.scene.add(mesh);
    l.parts.push({ mesh, start: t + at, h: rand(def.height), b: rand(def.bottom),
                   p: new THREE.Vector3(a.x + ux * dist + Math.cos(ang) * off, y, a.z + uz * dist + Math.sin(ang) * off) });
  }
  l.end = (l.parts.length ? l.parts[l.parts.length - 1].start : t) + def.life;
}
// a horns layer's spikes, standing at walker w's feet as the effect starts (`grid` g: one on each cell of the
// (2g + 1)² round them, placed in it as `off` has it)
function hornSpikes(l, w, t) {
  const def = l.def, a = w.worldPosition(new THREE.Vector3()), g = def.grid ?? -1;
  const cells = g < 0 ? Array.from({ length: def.count }, () => [0, 0]) : Array.from({ length: (2 * g + 1) ** 2 }, (_, i) => [i % (2 * g + 1) - g, Math.floor(i / (2 * g + 1)) - g]);
  l.parts = cells.map(([cx, cy]) => {
    const x = cx + rand(def.off ? def.off[0] : [-def.spread, def.spread]), y = cy + rand(def.off ? def.off[1] : [-def.spread, def.spread]);
    const gy = g >= 0 && w.groundAt ? w.groundAt(x, y, new THREE.Vector3()).y : a.y;  // (a grid's on the ground under each)
    const [rx, ry, rz] = [rand([-def.tilt, def.tilt]), Math.random() * 360, rand([-def.tilt, def.tilt])];
    const mesh = new THREE.Mesh(hornGeometry(), cutBelow(centerDepth(new THREE.MeshBasicMaterial({ map: blank(), transparent: true, side: THREE.DoubleSide, alphaTest: 0.01 })), gy));
    mesh.frustumCulled = false;
    mesh.renderOrder = 13;
    mesh.visible = false;
    mesh.rotation.set(rx * Math.PI / 180, ry * Math.PI / 180, rz * Math.PI / 180, 'YXZ');
    texture(def.file).then(tex => { if (tex) { mesh.material.map = tex; mesh.material.needsUpdate = true; } });
    A.scene.add(mesh);
    return { mesh, start: t, h: rand(def.height), b: rand(def.bottom), p: new THREE.Vector3(a.x + x, gy, a.z - y) };
  });
  l.end = t + def.life;
}
// roBrowser's QuadHorn: a four-sided pyramid, tip at y = 1 and base at y = −1 (±1 across), with its texture
// coordinates
function hornGeometry() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 1, 0, -1, -1, 1, 1, -1, 1,   0, 1, 0, 1, -1, 1, 1, -1, -1,
    0, 1, 0, 1, -1, -1, -1, -1, -1,   0, 1, 0, -1, -1, -1, -1, -1, 1]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1,   0, 0, 1, 1, 0, 1,   1, 0, 1, 1, 0, 1,   1, 0, 0, 1, 0, 0]), 2));
  return geo;
}
// (re)start an STR layer's animation at time t0, with its file (picked again when there are several)
function strCycle(l, t0) {
  l.cycle = t0;
  loadStr(pickOne(l.def.file)).then(str => {
    for (const m of l.meshes || []) { A.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    l.meshes = null;
    if (l.gone) return;
    if (!str) { l.end = Math.min(l.end, t0); return; }
    l.str = str;
    if (!l.def.loop) l.end = l.start + str.maxKey / str.fps * 1000;
    l.meshes = str.layers.map(() => { const m = strMesh(!!l.def.ground); A.scene.add(m); return m; });
  });
}
// end an effect at time t, however long it had left (a cast cut off takes its aura with it)
// collapse: ms over which an orbit's copies, instead of their outro, spiral in to the unit's middle (by request:
// Sight's fireballs as Sightrasher goes off), turning on at their speed, their radius closing ever faster; the leading
// copy first, each other following its path as far behind as it trails (by request: not all drawn in at once)
export function stop(fx, t, { collapse = null } = {}) {
  if (fx) for (const l of fx.layers) { l.end = Math.min(l.end, t); if (collapse != null && l.orbs) l.collapse = collapse; }
}
const outroOf = l => l.collapse != null ? l.collapse + trailMs(l.def, l.def.n - 1) : l.def.type === 'tiles' ? TILE_FADE_MS : l.def.outro || 0;
// a `dynamic` orbit effect fx shows n of its copies from time t on, evenly round, keeping their order round the circle
// (l.order: the copies shown, newest first): new ones come in at the front, growing in the first's place, and ones
// gone leave from the back (the oldest: the spheres used first, sim.js useSpheres), shrinking where they are; the rest
// glide to their new places, each from where it is just then and only ever forward, the way they turn (by request:
// never pushed back). With m shown before and B the first's place, the k new take B, B + 360/n, …, and the rest
// follow on 360/n apart: one j places in had B + 360j/m and gets B + 360(j + k)/n, not less as j ≤ m. With fewer,
// the rest keep B, now 360/n apart: B + 360j/n, not less than B + 360j/m.
export function setOrbs(fx, n, t) {
  if (fx) for (const l of fx.layers) if (l.orbs && l.def.dynamic) {
    const order = l.order ??= [], m = order.length;
    if (n === m) continue;
    const B = m ? order[0].off1 : 0;
    if (n > m) order.unshift(...l.orbs.filter(o => !order.includes(o)).slice(0, n - m));
    else for (const o of order.splice(n)) Object.assign(o, { sc0: orbScale(o, t), sc1: 0, scaled: t });
    order.forEach((o, j) => {
      const to = B + 360 * j / n;
      if (j < n - m) Object.assign(o, { off0: to, off1: to, moved: t, sc0: orbScale(o, t), sc1: 1, scaled: t, rose: t });
      else Object.assign(o, { off0: orbOff(o, t), off1: to, moved: t });
    });
  }
}
const ease = k => 1 - (1 - Math.min(1, Math.max(0, k))) ** 3;
const orbOff = (o, t) => o.moved == null ? 0 : o.off0 + (o.off1 - o.off0) * ease((t - o.moved) / ORB_GLIDE_MS);
const orbRise = (o, t) => o.rose == null ? 1 : ease((t - o.rose) / ORB_RISE_MS);
const orbScale = (o, t) => o.scaled == null ? 0 : o.sc0 + (o.sc1 - o.sc0) * ease((t - o.scaled) / ORB_GROW_MS);
// how many ms orbit copy i trails the leading one (the least lag) round its circle
const trailMs = (def, i) => def.spin ? 90 * (def.lag + i * def.lagStep - Math.min(def.lag, def.lag + (def.n - 1) * def.lagStep)) / def.spin : 0;
// end every effect at time t (the clock starting again: a map's start, sandbox.js)
export function stopAll(t) { for (const fx of live) stop(fx, t); }
// effect fx still showing at time t (not stopped, not over)
export const showing = (fx, t) => !!fx && live.includes(fx) && fx.layers.some(l => l.end > t);
// effect fx fades out from time t over ms and ends then; its layers go on moving as they would have (their timing
// is still over their whole duration). Cylinders only.
export function fade(fx, t, ms) {
  if (fx) for (const l of fx.layers) if (l.end > t + ms) { l.span ??= l.end - l.start; l.end = t + ms; l.cut = ms; }
}
// an alpha map that fades a quad out toward its top and bottom (clear at the ends, solid over the middle
// third), for sparks with `soft`
let softTex = null;
function softEnds() {
  if (softTex) return softTex;
  const cv = document.createElement('canvas');
  cv.width = 1; cv.height = 64;
  const g = cv.getContext('2d'), grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, '#000'); grad.addColorStop(1 / 3, '#fff'); grad.addColorStop(2 / 3, '#fff'); grad.addColorStop(1, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, 1, 64);
  return softTex = new THREE.CanvasTexture(cv);
}
// an alpha map fading a picture out toward its edge in a circle (a `shot` whose texture does not fade out
// all the way before its edge: pok3.tga)
let roundTex = null;
function roundEdge() {
  if (roundTex) return roundTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.6, '#fff'); grad.addColorStop(1, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return roundTex = new THREE.CanvasTexture(cv);
}
// a soft round glow, white in the middle fading out to nothing at its edge (a `qi` layer's)
let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,255,255,0.6)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return glowTex = new THREE.CanvasTexture(cv);
}
// a pale mint circle with two squares in it, an eight-pointed star touching it, thin and glowing (as the official client's), under the one a cast is aimed at (EF_LOCKON; by request)
let starTex = null;
function starTexture() {
  if (starTex) return starTex;
  const n = 256, c = n / 2, cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d');
  g.strokeStyle = '#dcfff6'; g.shadowColor = '#7fe6d2'; g.lineJoin = 'round';
  const ring = (r, w) => { g.lineWidth = w; g.shadowBlur = 8; g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke(); };
  ring(118, 4);
  const r = 118, square = a0 => {
    g.beginPath();
    for (let i = 0; i < 4; i++) { const a = a0 + i * Math.PI / 2; g[i ? 'lineTo' : 'moveTo'](c + r * Math.sin(a), c - r * Math.cos(a)); }
    g.closePath(); g.stroke();
  };
  g.lineWidth = 3; g.shadowBlur = 6; square(0); square(Math.PI / 4);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return starTex = t;
}
// a dark blot fading out toward its edge, for an orbit's shadows (roBrowser: the client's shadow.spr)
let shadowTex = null;
function shadowTexture() {
  if (shadowTex) return shadowTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(0.6, 'rgba(0,0,0,0.8)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return shadowTex = new THREE.CanvasTexture(cv);
}
// a unit quad facing +z whose picture is the right way up: the textures keep the image's top row at v = 0
// (flipY off, as the STR layers need), so v runs from the top down here
function quadGeometry() {
  const geo = new THREE.PlaneGeometry(1, 1), uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return geo;
}
// wedges of a disc in the XY plane; radii are set every frame (u runs around, v from outside 0 to inside 1)
function ringMesh(def) {
  const n = def.slices, pos = new Float32Array((n + 1) * 2 * 3), uv = new Float32Array((n + 1) * 2 * 2), index = [];
  for (let k = 0; k <= n; k++) {
    const u = k / def.sides * (def.sides / def.slices);
    uv.set([u, 1, u, 0], k * 4);
    if (k < n) index.push(k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 1, k * 2 + 2, k * 2 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: blank(), transparent: true, ...OVER_UNITS, side: THREE.DoubleSide, opacity: 0 }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  return mesh;
}
// the side of a cylinder, CYLINDER_SIDES around; radii and height are set every frame (u runs around,
// v from the top 0 to the ground 1)
const CYLINDER_SIDES = 20;
function cylinderMesh(n = CYLINDER_SIDES, repeat = 1, repeatV = 1) {
  const pos = new Float32Array((n + 1) * 2 * 3), uv = new Float32Array((n + 1) * 2 * 2), index = [];
  for (let k = 0; k <= n; k++) {
    uv.set([k / n * repeat, repeatV, k / n * repeat, 0], k * 4);
    if (k < n) index.push(k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 1, k * 2 + 2, k * 2 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, inDepth(new THREE.MeshBasicMaterial({ map: blank(), transparent: true, side: THREE.DoubleSide, opacity: 0 })));
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  return mesh;
}
// a shell layer's part of a sphere (see `shell`), round the origin, its arc starting at angle 0 (+z) and going
// toward +x; u round it 0 to `repeat`, v from its top 0 down to `repeatV`
function shellMesh(def) {
  const nu = 32, nv = 12, arc = def.arc * Math.PI * 2, [lo, hi] = def.lat.map(d => d * Math.PI / 180), r = def.radius, ry = def.radiusY ?? r;
  const pos = [], uv = [], index = [];
  for (let j = 0; j <= nv; j++) {
    const la = hi - (hi - lo) * j / nv, y = Math.sin(la) * ry, c = Math.cos(la) * r;
    for (let i = 0; i <= nu; i++) {
      const a = arc * i / nu;
      pos.push(Math.sin(a) * c, y, Math.cos(a) * c);
      uv.push(i / nu * (def.repeat || 1), j / nv * (def.repeatV || 1));
      if (i < nu && j < nv) { const k = j * (nu + 1) + i; index.push(k, k + nu + 1, k + 1, k + 1, k + nu + 1, k + nu + 2); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, inDepth(new THREE.MeshBasicMaterial({ map: blank(), transparent: true, side: THREE.DoubleSide, opacity: 0 })));
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  return mesh;
}
// a unit half sphere (y 0 to 1), scaled every frame; v runs from the top 0 to the ground 1
function domeMesh() {
  const geo = new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - pos.getY(i));
  const mesh = new THREE.Mesh(geo, inDepth(new THREE.MeshBasicMaterial({ map: blank(), transparent: true, side: THREE.DoubleSide, opacity: 0 })));
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  return mesh;
}
// the angle about the vertical (from +z toward +x) from effect fx's unit toward the one it comes from, or the way
// the unit faces when it comes from none
function towardFrom(fx) {
  let dx, dz;
  if (fx.from && fx.from !== fx.w) { fx.from.worldPosition(v1); fx.w.worldPosition(v2); dx = v1.x - v2.x; dz = v1.z - v2.z; }
  else [dx, dz] = [fx.w.heading[0], -fx.w.heading[1]];
  return Math.atan2(dx, dz);
}
const mBasis = new THREE.Matrix4();
const Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1), qSpin = new THREE.Quaternion();
const fadeInOut = (k, max) => (k < 0.25 ? k / 0.25 : k > 0.75 ? (1 - k) / 0.25 : 1) * max;
const q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), qi = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1), vs = new THREE.Vector3();
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), vd = new THREE.Vector3(), camDir = new THREE.Vector3();
// advance the 3D layers to time t (call before rendering the scene); finished effects are dropped
export function update(t) {
  for (let i = live.length - 1; i >= 0; i--) {
    const fx = live[i];
    if (fx.sound && t >= fx.sound.at) { api.playSound(fx.sound.file, EFFECTS[fx.name].wavVolume); fx.sound = null; }
    if (fx.sounds.length) fx.sounds = fx.sounds.filter(x => t >= x.at ? (api.playSound(x.file, EFFECTS[fx.name].wavVolume), false) : true);
    for (const l of fx.layers) {
      if (l.meshes) {
        const k = (t - l.cycle) / 1000 * l.str.fps;
        if (l.def.loop && k >= l.str.maxKey && t < l.end) {  // over: again, from where this one ended
          const next = l.cycle + l.str.maxKey / l.str.fps * 1000;
          l.meshes.forEach(m => { m.visible = false; });
          strCycle(l, next);
          continue;
        }
        l.str.layers.forEach((layer, j) => {
          const a = strFrame(layer, k), mesh = l.meshes[j];
          if (!a) { mesh.visible = false; return; }
          A.around(fx.w, l.def.jitter ? fx.ex : 0, l.def.jitter ? fx.ey : 0, 0, mesh.position);
          mesh.quaternion.copy(A.camera.quaternion);
          strPose(mesh, layer, a, l.def.scale, l.def.alpha, l.def.max, l.flip, l.def.normal, l.def.soft);
        });
        continue;
      }
      if (l.parts) {  // a trail's spikes: rising out of the ground, then fading
        const def = l.def;
        for (const s of l.parts) {
          const el = t - s.start;
          s.mesh.visible = el >= 0 && el < def.life;
          if (!s.mesh.visible) continue;
          const k = Math.min(1, el / def.rise), eased = 1 - (1 - k) * (1 - k), pop = def.pop && k < 1 ? def.pop * s.h * k : 0;
          s.mesh.position.set(s.p.x, s.p.y + s.h * (def.up ?? 0.9) - def.sink * (1 - eased) + pop, s.p.z);
          s.mesh.scale.set(s.b, s.h, s.b);
          s.mesh.material.opacity = Math.min(1, (def.life - el) / def.fade);
        }
        continue;
      }
      if (l.orbs && l.def.type === 'burst') {  // a burst's copies (and their shadows) flying out
        const def = l.def, tex = l.texs[Math.floor((t - l.start) / def.delay) % def.files.length];
        if (tex) for (const o of l.orbs) if (o.fire.material.map !== tex) { o.fire.material.map = tex; o.fire.material.needsUpdate = true; }
        A.camera.getWorldDirection(camDir);
        const yaw = Math.atan2(-camDir.x, -camDir.z);
        l.orbs.forEach((o, i) => {
          const way = i % def.ways, c = Math.floor(i / def.ways), k = (t - l.start - c * def.every) / def.life, on = k >= 0 && k < 1;
          const fade = Math.min(1, k / 0.25, (1 - k) / 0.25), a = way / def.ways * Math.PI * 2, r = def.reach * k;
          const x = r * Math.sin(a), y = -r * Math.cos(a), size = (def.from + (def.to - def.from) * k) / 35;
          A.around(fx.w, x, y, def.up, o.fire.position);
          o.fire.quaternion.copy(A.camera.quaternion);
          o.fire.scale.set(size, size, 1);
          o.fire.material.opacity = (def.alpha + c * def.alphaStep) * fade;
          o.fire.visible = on && !!tex;
          if (!o.shadow) return;
          const ss = (def.shadow.from + (def.shadow.to - def.shadow.from) * k) / 35;
          A.around(fx.w, x, y, 0.02, o.shadow.position);
          o.shadow.scale.set(ss, 1, ss * 0.6);
          o.shadow.rotation.y = yaw;
          o.shadow.material.opacity = def.shadow.alpha * fade;
          o.shadow.visible = on;
        });
        continue;
      }
      if (l.orbs) {  // an orbit's copies (and their shadows) going round the unit
        const def = l.def, on = t >= l.start && t < l.end + outroOf(l), tex = l.texs[Math.floor((t - l.start) / def.delay) % def.files.length];
        // coming out (`intro`): from the body out to its radius, with `introSpin` degrees more turn, both fast at first
        // and slowing (ease-out cubic); going (`outro`, after its end): turning on and shrinking to nothing
        const kin = def.intro ? Math.min(1, (t - l.start) / def.intro) : 1, ein = 1 - (1 - kin) ** 3;
        const shrink = l.collapse == null && def.outro && t > l.end ? Math.max(0, 1 - (t - l.end) / def.outro) : 1;
        // (`collapse`: the radius closing to nothing, ease-in quad, for each copy as long after the end as it trails the
        // leading one, so it goes where that one went; gone once in)
        const close = i => l.collapse != null && t > l.end + trailMs(def, i) ? 1 - Math.min(1, (t - l.end - trailMs(def, i)) / l.collapse) ** 2 : 1;
        A.camera.getWorldDirection(camDir);
        const yaw = Math.atan2(-camDir.x, -camDir.z);
        if (tex) for (const o of l.orbs) if (o.fire.material.map !== tex) { o.fire.material.map = tex; o.fire.material.needsUpdate = true; }
        l.orbs.forEach((o, i) => {
          // roBrowser: x = −r cos θ, y = r sin θ (rotationClockwise), θ = the spin so far − rotateLate quarter turns
          // (`dynamic`: its own place round, orbOff, and size, orbScale, as setOrbs last left them)
          const a = ((t - l.start) * def.spin + (def.introSpin || 0) * ein - 90 * (def.lag + i * def.lagStep) - (def.dynamic ? orbOff(o, t) : 0)) * Math.PI / 180;
          const ci = close(i) * (def.dynamic ? orbScale(o, t) : 1), r = def.radius * ein * close(i), x = -r * Math.cos(a), y = r * Math.sin(a);
          const size = (def.size + i * def.sizeStep) / 35 * shrink * (def.dynamic ? orbScale(o, t) : 1);
          A.around(fx.w, x, y, def.up * (def.dynamic ? orbRise(o, t) : 1), o.fire.position);
          o.fire.quaternion.copy(A.camera.quaternion);
          o.fire.scale.set(size, size, 1);
          o.fire.material.opacity = def.alpha + i * def.alphaStep;
          o.fire.visible = on && !!tex && ci > 0;
          if (!o.shadow) return;
          const ss = (def.shadow.size + i * def.shadow.sizeStep) / 35 * shrink;
          A.around(fx.w, x, y, 0.02, o.shadow.position);
          o.shadow.scale.set(ss, 1, ss * 0.6);
          o.shadow.rotation.y = yaw;  // (its long axis along the screen's left–right, as a unit's shadow)
          o.shadow.visible = on && ci > 0;
        });
        continue;
      }
      if (l.def.type === 'spr') {  // one with `depth`: its frame drawn into its canvas
        if (!l.mesh) continue;
        l.mesh.visible = !!l.spr && t >= l.start && t < l.end && t >= fx.born;
        if (!l.mesh.visible) continue;
        const gk = fx.grow ? Math.min(1, (t - fx.born) / fx.grow[0]) : 1;
        l.mesh.material.uniforms.alpha.value = gk;
        const gs = fx.scale * (fx.grow ? fx.grow[1] + (1 - fx.grow[1]) * gk : 1);
        // (drawn again and sent to the GPU only when what it shows has changed — its frame, size or fade: by report,
        // a few Bombs, 9 of these each, a 512² canvas uploaded every frame, brought the frame rate down)
        const key = sprShown(l, t) + '|' + gs.toFixed(3) + '|' + l.action + '|' + (l.def.up === 'head' ? fx.head : '');
        if (key !== l.shown) {
          l.shown = key;
          const g = l.canvas.getContext('2d');
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.clearRect(0, 0, SPR_CANVAS, SPR_CANVAS);
          g.translate(SPR_CANVAS / 2, SPR_FEET);
          if (gs !== 1) g.scale(gs, gs);  // (play's `scale` and `grow`: about the feet)
          g.imageSmoothingEnabled = false;
          drawSpr(g, l, t, fx);
          l.tex.needsUpdate = true;
        }
        fx.w.worldPosition(l.mesh.position);
        continue;
      }
      if (!l.mesh) continue;
      const def = l.def, dur = l.span ?? l.end - l.start;
      let k = Math.min(1, Math.max(0, (t - l.start) / dur));
      if (def.type === 'spike') {
        l.mesh.visible = t >= l.start && t < l.end && !!fx.from && fx.from !== fx.w;
        if (!l.mesh.visible) continue;
        fx.from.worldPosition(v1); fx.w.worldPosition(v2);
        const floor = v2.y, a = Math.atan2(v2.z - v1.z, v2.x - v1.x), ease = 1 - (1 - k) ** 3;
        const d = vd.set(Math.cos(a + l.yaw) * Math.cos(l.pitch), Math.sin(l.pitch), Math.sin(a + l.yaw) * Math.cos(l.pitch));
        const len = l.len * (k < def.grow ? k / def.grow : 1 - (1 - def.shrink) * (k - def.grow) / (1 - def.grow));
        const base = def.travel * ease;
        l.mesh.position.set(v2.x + Math.cos(a) * base, floor + def.up, v2.z + Math.sin(a) * base);
        // (its own line d along x, flat to the camera: y across it as seen from the camera)
        const ax = v1.copy(d), ay = v2.subVectors(A.camera.position, l.mesh.position).cross(ax).normalize(), az = vs.crossVectors(ax, ay);
        if (!Number.isFinite(ay.x)) continue;
        l.mesh.quaternion.setFromRotationMatrix(mBasis.makeBasis(ax, ay, az));
        l.mesh.scale.set(len || 1e-3, l.width * (1 - 0.5 * ease), 1);
        l.mesh.material.userData.floorY.value = floor;
        l.mesh.material.opacity = def.alpha * Math.min(1, (1 - k) / 0.5) * fx.alpha;
        continue;
      }
      if (def.type === 'link') { linkRibbon(fx, l, t); continue; }
      if (def.type === 'qi') {
        l.mesh.visible = t >= l.start && t < l.end && !!fx.from && fx.from !== fx.w;
        if (!l.mesh.visible) continue;
        fx.from.worldPosition(v1); fx.w.worldPosition(v2);
        const floor = v2.y, a = Math.atan2(v2.z - v1.z, v2.x - v1.x) + l.yaw, out = (1 - (1 - k) ** 3) * l.dist;
        const size = def.size[0] + (def.size[1] - def.size[0]) * (1 - (1 - k) ** 2);
        l.mesh.position.set(v2.x + Math.cos(a) * Math.cos(l.pitch) * out, floor + def.up + Math.sin(l.pitch) * out, v2.z + Math.sin(a) * Math.cos(l.pitch) * out);
        l.mesh.quaternion.copy(A.camera.quaternion).multiply(qSpin.setFromAxisAngle(Z_AXIS, l.spin));
        l.mesh.scale.set(size, size, 1);
        l.mesh.material.userData.floorY.value = floor;
        l.mesh.material.opacity = def.alpha * (k < 0.1 ? k / 0.1 : (1 - k) / 0.9) * fx.alpha;
        continue;
      }
      if (def.type === 'bounce') {
        l.mesh.visible = t >= l.start && t < l.end;
        if (!l.mesh.visible) continue;
        const s1 = (t - l.start) / 1000, s0 = Math.max(0, s1 - def.trail / 1000), dx = Math.cos(l.ang), dz = Math.sin(l.ang);
        const pos = l.mesh.geometry.attributes.position, half = def.width / 35 / 2, pts = [];
        for (let i = 0; i <= BOUNCE_STEPS; i++) {
          const [d, z] = bounceAt(l, s0 + (s1 - s0) * i / BOUNCE_STEPS);
          pts.push(new THREE.Vector3(l.o.x + dx * d, l.o.y + def.up + z, l.o.z + dz * d));
        }
        for (let i = 0; i <= BOUNCE_STEPS; i++) {  // (each pair across the trail as seen from the camera)
          const p = pts[i], tan = v1.subVectors(pts[Math.min(i + 1, BOUNCE_STEPS)], pts[Math.max(i - 1, 0)]);
          const side = v2.subVectors(A.camera.position, p).cross(tan).normalize().multiplyScalar(half);
          if (!Number.isFinite(side.x)) side.set(0, 0, 0);
          pos.setXYZ(i * 2, p.x + side.x, p.y + side.y, p.z + side.z);
          pos.setXYZ(i * 2 + 1, p.x - side.x, p.y - side.y, p.z - side.z);
        }
        pos.needsUpdate = true;
        l.mesh.material.opacity = (def.alpha ?? 1) * Math.min(1, (1 - k) / 0.33) * fx.alpha;
        continue;
      }
      if (def.type === 'sparks') {
        if (def.repeat && t >= l.start) k = Math.min(1, (t - l.start) % (def.count * def.every) / dur);
        const steps = k * 100;
        A.around(fx.w, l.x + (l.x1 - l.x) * k, l.y + (l.y1 - l.y) * k, l.z0 + (l.z1 - l.z0) * k, l.mesh.position);
        l.mesh.quaternion.copy(A.camera.quaternion);
        const g = def.size1 != null ? (l.w + (def.size1 / 35 - l.w) * k) / l.w : 1;
        l.mesh.scale.set(l.w * g, l.h * g, 1);
        if (def.files) {  // (`files`: cycled one every `delay` ms, as a quad's)
          const tex = l.texs[Math.floor(Math.max(0, t - l.start) / def.delay) % def.files.length];
          if (tex && l.mesh.material.map !== tex) { l.mesh.material.map = tex; l.mesh.material.needsUpdate = true; }
        }
        l.mesh.visible = t >= l.start;
        l.mesh.material.opacity = k < 0.25 && def.fadeIn !== false ? k / 0.25 * def.alpha : k > 0.75 ? (1 - k) / 0.25 * def.alpha
          : def.sparkle ? def.alpha * (Math.cos(steps * 11 * def.sparkle * Math.PI / 180) + 1) / 2 : def.alpha;
        continue;
      }
      if (def.type === 'spray') {
        const e = 1 - (1 - k) * (1 - k), size = (def.from + (def.to - def.from) * k) / 35;
        A.around(fx.w, l.x0 + (l.x1 - l.x0) * e, l.y0 + (l.y1 - l.y0) * e, l.up, l.mesh.position);
        l.mesh.quaternion.copy(A.camera.quaternion);
        l.mesh.scale.set(size, size, 1);
        l.mesh.material.opacity = def.alpha * (k < 0.2 ? k / 0.2 : (1 - k) / 0.8);
        l.mesh.visible = t >= l.start && t < l.end;
        continue;
      }
      if (def.type === 'ripple') {
        const r = (def.r0 + (def.r1 - def.r0) * (1 - (1 - k) * (1 - k))) * l.v[0] * fx.scale, size = (def.from + (def.to - def.from) * k) / 35 * l.v[1] * fx.scale;
        A.around(fx.w, Math.cos(l.a) * r, Math.sin(l.a) * r, def.up, l.mesh.position);
        l.mesh.quaternion.copy(A.camera.quaternion);
        l.mesh.scale.set(size, size, 1);
        l.mesh.material.opacity = def.alpha * (k < 0.2 ? k / 0.2 : (1 - k) / 0.8);
        l.mesh.visible = t >= l.start && t < l.end;
        continue;
      }
      if (def.type === 'fall') {
        // roBrowser moves it linearly from the start offset to the feet (here to where it lands, ex / ey off
        // them); it points along its path on screen (roBrowser gives it a fixed 112.5°, which is that path in
        // its default camera)
        A.around(fx.w, l.ex, l.ey, 0, vs).sub(A.around(fx.w, l.x, l.y, l.z, l.mesh.position));  // start → landing
        vs.applyQuaternion(qi.copy(A.camera.quaternion).invert());                         // on screen
        const a = Math.atan2(vs.y, vs.x), half = def.size[0] / 2 / 35;
        l.mesh.quaternion.copy(A.camera.quaternion).multiply(q.setFromAxisAngle(zAxis, a));
        // the head on the line, the middle half the picture behind it
        vs.set(Math.cos(a) * half, Math.sin(a) * half, 0).applyQuaternion(A.camera.quaternion);
        A.around(fx.w, l.ex + (l.x - l.ex) * (1 - k), l.ey + (l.y - l.ey) * (1 - k), l.z * (1 - k), l.mesh.position).sub(vs);
        l.mesh.scale.set(def.size[0] / 35, def.size[1] / 35, 1);
        const tex = l.texs[Math.floor((t - l.start) / def.delay) % def.files.length];
        if (tex && l.mesh.material.map !== tex) { l.mesh.material.map = tex; l.mesh.material.needsUpdate = true; }
        l.mesh.visible = !!tex && t >= l.start && t < l.end;  // gone as it reaches the feet
        continue;
      }
      if (def.type === 'shot') {
        A.around(l.from, 0, 0, l.z0, vs);
        A.around(fx.w, 0, 0, def.z1, v2);
        // the pull: behind the start (away from the unit, on the ground plane), to one side, and up
        vd.subVectors(v2, vs).setY(0).normalize();
        if (def.back) v1.copy(vs).addScaledVector(vd, -l.back).add(vd.set(-vd.z * l.side, l.lift, vd.x * l.side));
        else v1.addVectors(vs, v2).multiplyScalar(0.5);  // (no pull: a straight line, at an even speed)
        const on = t >= l.start && t < l.end, fade = def.arc || k >= 0.25 ? 1 : k / 0.25;
        if (def.files) {
          const tex = l.texs[Math.floor((t - l.start) / def.delay) % def.files.length];
          if (tex) for (const m of [l.mesh, ...l.tail]) if (m.material.map !== tex) { m.material.map = tex; m.material.needsUpdate = true; }
        }
        // `point`: turned so the picture's top points from start to end on screen
        const turn = def.point && q.setFromAxisAngle(zAxis,
          (vd.subVectors(v2, vs).applyQuaternion(qi.copy(A.camera.quaternion).invert()), Math.atan2(vd.y, vd.x) - Math.PI / 2));
        const fixed = def.angle && q2.setFromAxisAngle(zAxis, def.angle * Math.PI / 180), [sw, sh] = Array.isArray(def.size) ? def.size : [def.size, def.size];
        // the head at k, its tail's copies at where it was `tailStep` of the flight before, each smaller and
        // fainter down to nothing (or as large, each tailAlpha fainter)
        [l.mesh, ...l.tail].forEach((m, i) => {
          const kk = k - i * (def.tailStep || 0), n = def.tailAlpha ? 1 : 1 - i / (l.tail.length + 1);
          const a = (1 - kk) * (1 - kk), b = 2 * kk * (1 - kk), c = kk * kk;
          m.position.set(0, 0, 0).addScaledVector(vs, a).addScaledVector(v1, b).addScaledVector(v2, c);
          if (def.arc) m.position.y += def.arc * 4 * kk * (1 - kk);  // (`arc`: thrown, that many cells higher half way)
          m.quaternion.copy(A.camera.quaternion);
          if (turn) m.quaternion.multiply(turn);
          if (def.roll) m.quaternion.multiply(q.setFromAxisAngle(zAxis, def.roll * Math.max(0, kk) * Math.PI / 180));
          if (fixed) m.quaternion.multiply(fixed);
          m.scale.set(sw * n / 35, sh * n / 35, 1);
          m.visible = on && kk >= 0;
          // (the tail a little fainter: its copies overlap)
          m.material.opacity = fade * (def.tailAlpha ? 1 - i * def.tailAlpha : i ? 0.8 * n : 1);
        });
        continue;
      }
      if (def.type === 'quad') {
        if (def.files) {
          const tex = l.texs[Math.floor((t - l.start) / def.delay) % def.files.length];
          if (tex && l.mesh.material.map !== tex) { l.mesh.material.map = tex; l.mesh.material.needsUpdate = true; }
        }
        const size = (def.from + (def.to - def.from) * (def.smooth ? Math.log10(1 + 9 * k) : k)) / 35;  // px → cells
        A.around(fx.w, def.side || 0, 0, def.up, l.mesh.position);
        l.mesh.quaternion.copy(A.camera.quaternion);
        l.mesh.scale.set(size, size, 1);
        l.mesh.visible = t >= l.start;
        l.mesh.material.opacity = (def.alpha ?? 1) * (k > 0.75 && !def.hold ? (1 - k) / 0.25 : def.fadeIn && k < 0.25 ? k / 0.25 : 1);
        continue;
      }
      if (def.type === 'shell') {
        l.mesh.material.opacity = (def.fadeMs ? def.alpha * Math.max(0, Math.min(1, (t - l.start) / def.fadeMs, (l.end - t) / def.fadeMs))
          : fadeInOut(k, def.alpha)) * fx.alpha;
        l.mesh.visible = t >= l.start;
        A.around(fx.w, 0, 0, def.z || 0, l.mesh.position);
        l.mesh.rotation.y = towardFrom(fx) - def.arc * Math.PI;
        continue;
      }
      if (def.type === 'dome') {
        l.mesh.scale.set(def.radius * k || 1e-3, def.height * k || 1e-3, def.radius * k || 1e-3);
        l.mesh.material.opacity = fadeInOut(k, def.alpha);
        A.around(fx.w, 0, 0, 0, l.mesh.position);
        l.mesh.rotation.y = t / 4 * Math.PI / 180;
        continue;
      }
      if (def.type === 'cylinder') {
        let kc = k;
        if (def.cycle) {  // (a repeating copy: kc runs over its own cycle)
          const el = t - l.start - l.copy * def.every, ph = el - Math.floor(el / (def.every * def.copies)) * def.every * def.copies;
          kc = ph / def.cycle;
          l.mesh.visible = el >= 0 && kc <= 1;
          if (!l.mesh.visible) continue;
        }
        // animation 1 (rise): full width, the height grows over the first second (or the whole effect if shorter);
        // animation 2 (widen): the top opens from nothing to its size over that time; 4 (default): both radii
        // grow over the whole effect
        // (a repeating copy's over its own cycle)
        const early = def.cycle ? Math.min(1, kc * def.cycle / Math.min(def.cycle, 1000)) : Math.min(1, (t - l.start) / Math.min(dur, 1000));
        const grow = def.rise || def.widen || def.fixed ? 1 : kc;
        let h = (def.rise ? def.height * early : def.swell ? def.height * Math.min(kc, 1 - kc) * 2 : def.height) * fx.scale;
        if (def.bob) h *= 1 + def.bob * Math.sin((t / def.bobMs + l.phase) * Math.PI * 2);
        // (`pulse`: both radii swelling and shrinking, roBrowser PropertyGround's max(0.5, sin(tick / (360π) + its own phase)))
        const pulse = def.pulse ? Math.max(0.5, Math.sin(t / (360 * Math.PI) + l.phase * 10)) : 1;
        const pos = l.mesh.geometry.attributes.position, b = def.bottom * grow * fx.scale * pulse, top = def.top * (def.widen ? early : grow) * fx.scale * pulse;
        const sides = def.facets || def.sides || CYLINDER_SIDES, of = def.of || sides;
        for (let s = 0; s <= sides; s++) {
          const a = s / of * Math.PI * 2, x = Math.sin(a), z = Math.cos(a);
          pos.setXYZ(s * 2, x * b, 0, z * b);
          pos.setXYZ(s * 2 + 1, x * top, h, z * top);
        }
        pos.needsUpdate = true;
        l.mesh.material.opacity = (def.fadeMs ? def.alpha * Math.max(0, Math.min(1, (t - l.start) / def.fadeMs, (l.end - t) / def.fadeMs))
          : def.fadeOut ? def.alpha * Math.min(1, (1 - kc) / 0.25) : fadeInOut(kc, def.alpha)) * fx.alpha
          * (l.cut ? Math.max(0, Math.min(1, (l.end - t) / l.cut)) : 1);
        l.mesh.visible = t >= l.start;
        A.around(fx.w, def.land ? fx.ex : 0, def.land ? fx.ey : 0, def.z || 0, l.mesh.position);
        // roBrowser: tick / 4 degrees (`spinDiv`: tick / that, PropertyGround's 8, from its own angle)
        l.mesh.rotation.y = def.still && !fx.spin ? (def.angleY || 0) * Math.PI / 180 : def.spinDiv ? (t / def.spinDiv + l.phase * 360) * Math.PI / 180 : t / 4 * Math.PI / 180;
        if (def.facets) l.mesh.rotation.y = towardFrom(fx) - def.facets / of * Math.PI;  // (its middle that way)
        if (def.sideways && fx.from && fx.from !== fx.w) {
          // (where on the unit, the same for all its copies: `back` cells toward the one it comes from, `across` to either
          // side, `z` up, each random in its range)
          fx.spot ??= { back: rand(def.back || 0), across: rand([-(def.across || 0), def.across || 0]), z: rand(def.z || 0) };
          fx.from.worldPosition(v1); fx.w.worldPosition(v2);
          l.mesh.material.userData.floorY.value = v2.y;
          const dir = v1.sub(v2).setY(0).normalize(), spin = l.mesh.rotation.y;
          l.mesh.quaternion.setFromUnitVectors(Y_AXIS, dir).multiply(qSpin.setFromAxisAngle(Y_AXIS, spin));
          l.mesh.position.set(v2.x + dir.x * fx.spot.back - dir.z * fx.spot.across, v2.y + fx.spot.z, v2.z + dir.z * fx.spot.back + dir.x * fx.spot.across);
        }
        continue;
      }
      if (def.type === 'model') {
        A.around(fx.w, 0, 0, 0, l.mesh.position);
        l.mesh.scale.setScalar(def.scale);
        l.mesh.visible = t < l.end;
        continue;
      }
      if (def.type === 'tiles') {
        // the cells round the player's, each rising TILE_RISE and fading in over TILE_FADE_MS as it comes into reach and
        // sinking back fading out as it leaves (by request: not all of it stepping along at once), all of them so as it
        // starts and ends; on the map's cells, so the odd and the even ones and the pictures' turns stay put; a picture
        // hovers 0.4 ∓ 0.2 up, over and back in 10.7 s (Tiles.js HoveringTexture)
        A.around(fx.w, 0, 0, 0, v1);
        const bx = v1.x - fx.w.pos[0], bz = v1.z + fx.w.pos[1], y = v1.y, r = def.radius, [k, n] = def.of || [0, 1];
        const step = l.last == null ? 0 : (t - l.last) / TILE_FADE_MS, want = new Set();
        l.last = t;
        if (t >= l.start && t < l.end) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {  // (from its start, maybe later)
          const x = fx.w.cell[0] + i, z = fx.w.cell[1] + j, key = x + ',' + z;
          if (((x + z) & 1) !== def.odd) continue;
          if (fx.clash ? fx.clash(x, z) !== !!def.clash : def.clash) continue;  // (see EF_SONG_*)
          if (((x * 3 + z * 5) % n + n) % n !== k) continue;
          want.add(key);
          if (!l.cells.has(key)) l.cells.set(key, { x, y: z, a: 0 });
        }
        for (const [key, c] of l.cells) {
          c.a = want.has(key) ? Math.min(1, c.a + step) : c.a - step;
          if (c.a <= 0 && !want.has(key)) l.cells.delete(key);
        }
        const P = l.mesh.geometry.attributes.position, F = l.mesh.geometry.attributes.fade, cap = F.count / 4;
        // (sunk TILE_RISE, less than the hover's lowest, so it is gone before it reaches the ground: by request)
        // (`ground`: one standing on the ground, its bottom a little under it (cut off there), squashed down and stretched
        // back up instead of hovering, between 0.6 and all of its height, by request)
        const bob = Math.sin((def.odd ? Math.PI : 0) + t / (540 * Math.PI)), ud = l.mesh.material.userData;
        if (def.ground && ud.height) ud.quad.value.y = ud.height * (0.8 - 0.2 * bob);
        // (`mid`: its middle, a lens's white, on the ground, half of it under it, so it squashes from there: by request)
        const up = v2.set(0, 1, 0).applyQuaternion(A.camera.quaternion).y;
        const h = def.planes ? -PLANE_SINK * ud.quad.value.y : def.mid ? -ud.quad.value.y * up / 2 : def.ground ? -0.1 : 0.4 - 0.2 * bob, depth = TILE_RISE;
        const S = l.mesh.geometry.attributes.shape;
        let q = 0;
        for (const c of l.cells.values()) {
          for (let k = 0; k < (def.planes || 1) && q < cap; k++, q++) {
            // (a plane's way, place and height, the same for that cell every time: PLANE_SPREAD off its middle, 0.7 to all
            // of the height)
            const turn = cellRand(c.x, c.y, k, 1) * Math.PI, ox = (cellRand(c.x, c.y, k, 2) - 0.5) * 2 * PLANE_SPREAD,
              oz = (cellRand(c.x, c.y, k, 3) - 0.5) * 2 * PLANE_SPREAD, hk = 0.7 + 0.3 * cellRand(c.x, c.y, k, 4);
            const X = bx + c.x + 0.5 + (def.planes ? ox : 0), Z = bz - c.y - 0.5 + (def.planes ? oz : 0);
            for (let v = 0; v < 4; v++) {
              P.setXYZ(q * 4 + v, X, y + h - (1 - c.a) * depth, Z);
              S.setXYZ(q * 4 + v, Math.cos(turn), Math.sin(turn), hk);
              F.setX(q * 4 + v, c.a);
            }
          }
        }
        for (let v = q * 4; v < cap * 4; v++) F.setX(v, 0);
        P.needsUpdate = F.needsUpdate = S.needsUpdate = true;
        l.mesh.material.userData.floorY.value = y;
        l.mesh.visible = l.cells.size > 0;
        continue;
      }
      if (def.type === 'ground') {
        A.around(fx.w, 0, 0, 0.02, l.mesh.position);
        // (`pulse` [share, ms]: its size that share more and less, sin(t / ms), odd and even ones opposite: roBrowser LPEffect)
        l.odd ??= Math.random() < 0.5 ? Math.PI : 0;
        const sz = (fx.size || def.size) * (def.pulse ? 1 + def.pulse[0] * Math.sin(l.odd + t / def.pulse[1]) : 1);
        l.mesh.scale.set(sz, sz, 1);
        l.mesh.rotation.set(-Math.PI / 2, 0, t / 1000 * def.spin * Math.PI / 180);
        l.mesh.visible = t < l.end;
        continue;
      }
      if (def.type === 'lockon') {
        // roBrowser LockOnTarget: shrinks from 15 cells across to 3 over its first 250 ms, spins, and its green
        // and blue pulse down every 400 ms (so it flashes red). It also fades in and out here (by eye; roBrowser
        // pops it on and off), over 200 ms or a quarter of the cast if that is shorter.
        const el = t - l.start, size = (6 - Math.min(5, Math.max(1, el / 50))) * 3, c = (20 - Math.floor(el / 20) % 20) / 20;
        const fade = Math.min(200, dur / 4), alpha = Math.min(1, el / fade, (l.end - t) / fade);
        A.around(fx.w, 0, 0, 0.02, l.mesh.position);
        l.mesh.scale.set(size, size, 1);
        l.mesh.rotation.set(-Math.PI / 2, 0, t / 4 * Math.PI / 180);
        l.mesh.material.color.setRGB(1, c, c);
        l.mesh.material.opacity = Math.max(0, alpha);
        continue;
      }
      const outer = def.outer * Math.min(1, (t - l.start) / Math.min(dur, 1000));  // animation 2: grows over at most 1 s
      const pos = l.mesh.geometry.attributes.position;
      for (let s = 0; s <= def.slices; s++) {
        const a = s / def.sides * Math.PI * 2, x = Math.sin(a), y = Math.cos(a);
        pos.setXYZ(s * 2, x * def.inner, y * def.inner, 0);
        pos.setXYZ(s * 2 + 1, x * outer, y * outer, 0);
      }
      pos.needsUpdate = true;
      l.mesh.material.opacity = fadeInOut(k, def.alpha);
      // face the camera, spinning about the view axis (roBrowser: tick / 4 degrees)
      A.around(fx.w, 0, def.behind || 0, def.up, l.mesh.position);
      l.mesh.quaternion.copy(A.camera.quaternion).multiply(q.setFromAxisAngle(zAxis, t / 4 * Math.PI / 180 + l.turn));
    }
    // (an orbit's outro plays past its end; one with sounds still to come stays for them: Maximize Power's, all sound)
    if (!fx.sound && !fx.sounds.length && fx.layers.every(l => t >= l.end + outroOf(l))) {
      for (const l of fx.layers) {
        for (const m of l.meshes || (l.orbs ? l.orbs.flatMap(o => o.shadow ? [o.fire, o.shadow] : [o.fire]) : l.parts ? l.parts.map(s => s.mesh) : l.mesh ? [l.mesh, ...(l.tail || [])] : [])) { A.scene.remove(m); if (!m.isGroup) { m.geometry.dispose(); m.material.dispose(); } }
        if (l.tex) l.tex.dispose();
        l.gone = true;
      }
      live.splice(i, 1);
    }
  }
}
// ---------- converted client sprites (spr layers) ----------
const sprs = new Map();  // png/effect/<name> → Promise of { act, img: file → canvas }
function loadSpr(path) {
  if (!sprs.has(path)) sprs.set(path, fetch(encodeURI('../assets/' + path + '/act.json')).then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(async act => {
      const files = [...new Set(act.actions.flatMap(a => a.frames.flatMap(f => f.layers.map(l => l.file))))];
      const img = Object.fromEntries(await Promise.all(files.map(async f => [f, await image(path + '/' + f)])));
      return { act, img };
    }).catch(() => null));
  return sprs.get(path);
}
// an spr layer with `depth` is drawn into a canvas this many px square, the feet this far down (room for
// the ice block shattering)
const SPR_CANVAS = 512, SPR_FEET = 320;
// one frame of an spr layer on g, whose origin is the unit's feet in sprite px: each sprite layer at its
// offset, scale, mirror and colour (as the sprites are drawn), `up` px above the feet
// what drawSpr shows of layer l at t, as a key: its frame and its fade (in 1/64ths)
function sprShown(l, t) {
  const def = l.def, a = l.spr.act.actions[l.action];
  if (!a || !a.frames.length) return '';
  const k0 = Math.floor((t - l.start) / (def.delay ?? a.delay_ms)), i = def.hold ? Math.min(k0, a.frames.length - 1) : k0 % a.frames.length;
  const k = (t - l.start) / (l.end - l.start), fade = def.fadeOut && k > 0.75 ? (1 - k) / 0.25 : 1;
  return i + '|' + Math.round(fade * 64);
}
function drawSpr(g, l, t, fx) {
  const def = l.def, a = l.spr.act.actions[l.action], up = def.up === 'head' ? fx.head : def.up;
  if (!a || !a.frames.length) return;
  const k0 = Math.floor((t - l.start) / (def.delay ?? a.delay_ms)), f = a.frames[def.hold ? Math.min(k0, a.frames.length - 1) : k0 % a.frames.length];
  const k = (t - l.start) / (l.end - l.start), fade = def.fadeOut && k > 0.75 ? (1 - k) / 0.25 : 1;
  for (const [i, ly] of f.layers.entries()) {
    if (def.skip && def.skip.includes(i)) continue;  // (`skip`: the sprite layers of these numbers left out)
    const im = l.spr.img[ly.file];
    if (!im) continue;
    const [sx, sy] = ly.scale || [1, 1], c = ly.color || [255, 255, 255, 255];
    g.save();
    if (def.scale) g.scale(def.scale, def.scale);  // (`scale`: the whole sprite that much, from the feet)
    g.translate(ly.x, ly.y - up);
    if (ly.angle) g.rotate(ly.angle * Math.PI / 180);
    g.scale(ly.mirror ? -sx : sx, sy);
    g.globalAlpha = c[3] / 255 * fade * (def.alpha ?? 1);
    g.drawImage(im, -im.width >> 1, -im.height >> 1);  // (centred as look.js drawFrame: roBrowser's -w >> 1)
    g.restore();
  }
}

// one of a `speed` layer's streaks (see the layer types) on the overlay context g
const vSpeed = new THREE.Vector3();
function drawSpeed(g, fx, l, t) {
  const def = l.def, k = (t - l.start) / (l.end - l.start);
  const mid = A.project(A.onScreen(fx.w, 0, def.up, vSpeed)), right = A.project(A.onScreen(fx.w, 1, def.up, vSpeed));
  const cell = Math.hypot(right.x - mid.x, right.y - mid.y);
  let dx, dy;
  if (def.radial) { dx = Math.cos(l.ang); dy = Math.sin(l.ang); }
  else {
    // (the one it comes from taken as high up as the unit's middle: from its feet, the lines leaned up toward the middle,
    // more so as the camera turned; by report)
    const src = A.project(A.onScreen(fx.from, 0, def.up, vSpeed));
    dx = mid.x - src.x; dy = mid.y - src.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-3) return;
    dx /= d; dy /= d;
  }
  const s = (-l.back + l.travel * k) * cell, x = mid.x + dx * s - dy * l.off * cell, y = mid.y + dy * s + dx * l.off * cell;
  const half = l.len * mid.s / 2, grad = g.createLinearGradient(x - dx * half, y - dy * half, x + dx * half, y + dy * half);
  const rgb = (def.color || [1, 1, 1]).map(v => Math.round(v * 255)).join();
  grad.addColorStop(0, `rgba(${rgb},0)`); grad.addColorStop(0.85, `rgba(${rgb},1)`); grad.addColorStop(1, `rgba(${rgb},0.2)`);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);  // (device px, whatever was drawn before it)
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = (def.alpha ?? 1) * Math.min(1, k / 0.2, (1 - k) / 0.4);
  g.strokeStyle = grad;
  g.lineWidth = l.width * mid.s;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x - dx * half, y - dy * half);
  g.lineTo(x + dx * half, y + dy * half);
  g.stroke();
  g.restore();
}
// a `link` layer (see above): a soft line, a wide faint stroke under a narrow one, drawn over everything; with `streak`,
// Raging Trifecta Blow's streak (EF_TRIPLELINES) from one to the other instead, brightest in the middle and fading out
// toward both, in the scene: depth-tested at the feet-high point under each point of it as the sprites are (linkDepth), so one
// standing in front covers it (by report: it was drawn over them). Fainter the further apart they are (`near` to `far`
// cells: from all of it to none), and fading out over `outro` ms as it ends
const LINK_ALONG = [[0, 0], [0.5, 1], [1, 0]];                                // (share of the way, brightness)
const LINK_ACROSS = [[-0.5, 0], [-0.2, 0.6], [0, 1], [0.2, 0.6], [0.5, 0]];  // (share of the width, brightness)
const linkA = new THREE.Vector3(), linkB = new THREE.Vector3(), linkD = new THREE.Vector3(), linkS = new THREE.Vector3();
const linkP = new THREE.Vector3(), linkQ = new THREE.Vector3(), linkR0 = new THREE.Vector3(), linkR1 = new THREE.Vector3();
function linkAlpha(fx, l, t) {
  const def = l.def;
  const pulse = def.pulse ? 1 - def.pulse / 2 + def.pulse / 2 * Math.sin(2 * Math.PI * (t - l.start) / (def.period || 1500)) : 1;
  const apart = fx.from.worldPosition(linkA).distanceTo(fx.w.worldPosition(linkB));
  const far = def.far ? Math.min(1, Math.max(0, (def.far - apart) / (def.far - (def.near || 0)))) : 1;
  const out = t >= l.end ? 1 - (t - l.end) / (def.outro || 1) : 1;
  return Math.max(0, def.alpha * pulse * far * out);
}
// a link ribbon's depth: each point's taken at the feet-high point it is raised from (its `ground` attribute), pulled
// DEPTH_BIAS toward the camera as a sprite's feet are, so it is compared with a unit as the unit's sprite is
function linkDepth(material) {
  Object.assign(material, { depthTest: true, depthWrite: false });
  material.onBeforeCompile = sh => {
    sh.vertexShader = 'attribute vec3 ground;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  vec4 gv = viewMatrix * vec4(ground, 1.0);
  gv.z += ${DEPTH_BIAS.toFixed(3)};  // view space looks down -z
  vec4 d = projectionMatrix * gv;
  gl_Position.z = d.z / d.w * gl_Position.w;`);
  };
  material.customProgramCacheKey = () => 'effect-link-depth';
  return material;
}
function linkRibbon(fx, l, t) {
  const def = l.def;
  l.mesh.visible = t >= l.start && t < l.end + outroOf(l) && !!fx.from && fx.from !== fx.w;
  if (!l.mesh.visible) return;
  const alpha = linkAlpha(fx, l, t) * fx.alpha;
  if (!(alpha > 0)) { l.mesh.visible = false; return; }
  // (the feet, then raised `up` cells as seen on screen, as the sprites' middles are)
  const f0 = fx.from.worldPosition(linkA), f1 = fx.w.worldPosition(linkB);
  const r0 = A.onScreen(fx.from, 0, def.up, linkR0), r1 = A.onScreen(fx.w, 0, def.up, linkR1);
  const d = linkD.subVectors(r1, r0), w = def.width / 35;  // (sprite px: 35 a cell)
  const geo = l.mesh.geometry, pos = geo.attributes.position, gnd = geo.attributes.ground, n = LINK_ACROSS.length;
  LINK_ALONG.forEach(([x], i) => {
    const p = linkP.copy(r0).addScaledVector(d, x), q = linkQ.copy(f0).lerp(f1, x);
    // (across it as seen from the camera)
    const side = linkS.subVectors(A.camera.position, p).cross(d).normalize();
    if (!Number.isFinite(side.x)) side.set(0, 0, 0);
    LINK_ACROSS.forEach(([y], j) => {
      pos.setXYZ(i * n + j, p.x + side.x * y * w, p.y + side.y * y * w, p.z + side.z * y * w);
      gnd.setXYZ(i * n + j, q.x, q.y, q.z);
    });
  });
  pos.needsUpdate = gnd.needsUpdate = true;
  l.mesh.material.opacity = Math.min(1, alpha);
}
function drawLink(g, fx, l, t) {
  const def = l.def, a = A.project(A.onScreen(fx.from, 0, def.up, vSpeed)), b = A.project(A.onScreen(fx.w, 0, def.up, vSpeed));
  const s = (a.s + b.s) / 2, alpha = linkAlpha(fx, l, t);
  if (alpha <= 0) return;
  const rgb = def.color.map(v => Math.round(v * 255)).join();
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  for (const [w, k] of [[1, 0.5], [0.4, 1]]) {
    g.strokeStyle = `rgba(${rgb},${alpha * k})`;
    g.lineWidth = Math.max(1, def.width * w * s);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  }
  g.restore();
}
// a `zap` layer: every `every` ms `bolts` bolts (not `count`, which would make that many copies of the layer: play), each a jagged line of `segs` pieces `reach` cells long from a spot on the
// unit (`side` cells either way, `up` high) in any direction on screen, with `forks` short branches off it, for `life`
// ms, flickering, a thin `core` over a faint glow of `color`; added on (lighter). Drawn over everything, as `speed`.
function zapLine(x, y, a, reach, n) {
  const pts = [];
  for (let j = 0; j <= n; j++) {
    const jit = j && j < n ? rand([-0.18, 0.18]) * reach : 0;
    pts.push([x - Math.sin(a) * jit, y + Math.cos(a) * jit]);
    x += Math.cos(a) * reach / n; y += Math.sin(a) * reach / n;
  }
  return pts;
}
function drawZaps(g, fx, l, t) {
  const def = l.def;
  l.bolts ??= [];
  l.next ??= t;
  if (t >= l.next) {
    for (let i = Math.round(rand(def.bolts)); i > 0; i--) {
      const n = Math.round(rand(def.segs)), reach = rand(def.reach), a = Math.random() * 2 * Math.PI;
      const main = zapLine(rand([-def.side, def.side]), rand(def.up), a, reach, n), lines = [main];
      // (a branch off one of its bends, turned 25–50° either way, a third of it long or so)
      for (let k = Math.round(rand(def.forks || 0)); k > 0; k--) {
        const [x, y] = main[1 + Math.floor(Math.random() * (n - 1))];
        lines.push(zapLine(x, y, a + (Math.random() < 0.5 ? -1 : 1) * rand([0.45, 0.9]), reach * rand([0.25, 0.45]), 3));
      }
      l.bolts.push({ lines, end: t + rand(def.life) });
    }
    l.next = t + rand(def.every);
  }
  l.bolts = l.bolts.filter(b => t < b.end);
  if (!l.bolts.length) return;
  const rgb = c => c.map(v => Math.round(v * 255)).join();
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'lighter';
  g.lineCap = g.lineJoin = 'round';
  for (const b of l.bolts) {
    const flick = (def.alpha ?? 1) * (Math.random() < 0.25 ? 0.4 : 1);
    b.lines.forEach((line, i) => {
      const ps = line.map(([x, y]) => A.project(A.onScreen(fx.w, x, y, vSpeed)));
      for (const [c, w, a] of [[def.color, 2.5, 0.3], [def.core, 1, 0.9]]) {
        g.globalAlpha = flick * a;
        g.strokeStyle = `rgb(${rgb(c)})`;
        g.lineWidth = def.width * w * (i ? 0.7 : 1) * ps[0].s;  // (a branch thinner)
        g.beginPath();
        ps.forEach((p, j) => j ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y));
        g.stroke();
      }
    });
  }
  g.restore();
}
const BOUNCE_STEPS = 12;
// where one of a `bounce` layer's sparks is s seconds on: along the ground, up
function bounceAt(l, s) {
  const def = l.def;
  let out = l.out, rise = l.rise, d = 0;
  for (let n = 0; n < 8; n++) {
    const T = 2 * rise / def.gravity;
    if (s < T) return [d + out * s, rise * s - def.gravity * s * s / 2];
    d += out * T; s -= T; out *= def.bounce; rise *= def.bounce;
  }
  return [d + out * s, 0];
}
// draw the 2D layers on the arena's overlay context g (device px)
const vw = new THREE.Vector3();
export function draw(g, t) {
  for (const fx of live) for (const l of fx.layers) {
    if (l.def.type === 'spr') {
      if (l.def.depth || !l.spr || t < l.start || t >= l.end) continue;
      const at = A.anchor(fx.w);
      g.save();
      g.setTransform(at.s, 0, 0, at.s, at.x, at.y);
      drawSpr(g, l, t, fx);
      g.restore();
      continue;
    }
    if (l.def.type === 'speed') { if (t >= l.start && t < l.end && (fx.from || l.def.radial)) drawSpeed(g, fx, l, t); continue; }
    if (l.def.type === 'zap') { if (t >= l.start && t < l.end) drawZaps(g, fx, l, t); continue; }
    if (l.def.type === 'link') { if (!l.def.streak && t >= l.start && t < l.end + outroOf(l) && fx.from) drawLink(g, fx, l, t); continue; }
    if (l.def.type !== 'flash' || !l.img || t < l.start || t >= l.end) continue;
    const k = (t - l.start) / (l.end - l.start);
    const x = l.p0[0] + (l.p1[0] - l.p0[0]) * k, y = l.p0[1] + (l.p1[1] - l.p0[1]) * k;
    const at = A.project(A.onScreen(fx.w, x, y + l.def.up, vw));
    const sw = l.from[0] + (l.to[0] - l.from[0]) * k, sh = l.from[1] + (l.to[1] - l.from[1]) * k;
    g.save();
    g.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
    g.setTransform(at.s, 0, 0, at.s, at.x, at.y);
    g.rotate(l.a);
    g.drawImage(l.img, -sw / 2, -sh / 2, sw, sh);
    g.restore();
  }
}
