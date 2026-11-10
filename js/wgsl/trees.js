// Instanced trees. A compute pass walks the jittered tree grid around the camera, keeps the
// trees that can be on screen and appends them to a near list (full crown) and a far list
// (cheap crown) that two indirect draws consume. Every tree is real geometry at every distance,
// so flying forward never grows or inserts a tree; a crown that shrinks below a pixel is only
// recoloured towards the stand colour the ground already carries.
import { FRAME_WGSL, ATMO_CORE_WGSL, NOISE_WGSL, AP_RES, AP_MAX_KM,
  TREE_RANGE, TREE_NEAR_DIST, TREE_MAX, TREE_NEAR_MAX } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { TERRAIN_FUNCS, clipSampleWGSL } from './terrain.js';
import { FOREST_FUNCS } from './forest.js';
import { RAIN_STRUCT } from './rain.js';

export const TREE_INST_BYTES = 80;
export const TREE_GEN_GROUP = 8;
export const TREE_SEGS_NEAR = 12;
export const TREE_SEGS_FAR = 6;
// vertices per crown: an apex fan and a shoulder-to-base band near, a single fan far
export const TREE_VERTS_NEAR = TREE_SEGS_NEAR * 9;
export const TREE_VERTS_FAR = TREE_SEGS_FAR * 3;

const TREE_CONSTS = /* wgsl */ `
const TREE_RANGE: f32 = ${TREE_RANGE}.0;
const TREE_NEAR_DIST: f32 = ${TREE_NEAR_DIST}.0;
const TREE_MAX: u32 = ${TREE_MAX}u;
const TREE_NEAR_MAX: u32 = ${TREE_NEAR_MAX}u;
const EARTH_R: f32 = 6371000.0;
const TREE_SEGS_NEAR: u32 = ${TREE_SEGS_NEAR}u;
const TREE_SEGS_FAR: u32 = ${TREE_SEGS_FAR}u;
struct TreeInst {
  a: vec4f,   // xyz = ground position of the trunk, w = crown radius
  b: vec4f,   // x = apex height, y = lowest crown edge, z = texture seed, w = 1 for conifers
  c: vec4f,   // x = sun visibility, y = cloud shade * sun up, z = stand density, w = conifer share
  d: vec4f,   // lit stand colour (radiance / pi), what a sub-pixel crown shows
  e: vec4f,   // this tree's foliage albedo
};
struct Light { sun: vec3f, moon: vec3f, zen: vec3f, hor: vec3f, L: vec3f, M: vec3f };
@group(0) @binding(10) var<storage, read> LB: array<vec4f, 8>;
fn readLight() -> Light {
  var lt: Light;
  lt.sun = LB[0].xyz; lt.moon = LB[1].xyz; lt.zen = LB[2].xyz;
  lt.hor = LB[3].xyz; lt.L = LB[4].xyz; lt.M = LB[5].xyz;
  return lt;
}
fn ggx(nh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
fn ambient(lt: Light, n: vec3f) -> vec3f {
  return mix(lt.hor, lt.zen, 0.5 + 0.5 * n.y) * (0.55 + 0.45 * n.y) * PI;
}
fn direct(lt: Light, n: vec3f, sunVis: f32) -> vec3f {
  return lt.sun * sunVis * max(dot(n, lt.L), 0.0) + lt.moon * max(dot(n, lt.M), 0.0);
}
`;

// One thread: the light every tree shares this frame (sun and moon illuminance, sky colour).
export function treeLightWGSL() {
  return FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
` + RAIN_STRUCT + /* wgsl */ `
@group(0) @binding(4) var<uniform> Rain: RainU;
@group(0) @binding(5) var<storage, read_write> outL: array<vec4f, 8>;
` + SKY_RENDER_FUNCS + /* wgsl */ `
fn moonIlluminance() -> vec3f {
  if (F.moonDir.w <= 0.0 || F.moonDir.y <= 0.0 || F.sunDir.y >= 0.2) { return vec3f(0.0); }
  let moon = normalize(F.moonDir.xyz);
  let lite = normalize(F.moonLight.xyz);
  let deg = acos(clamp(dot(lite, -moon), -1.0, 1.0)) * (180.0 / PI);
  let deg2 = deg * deg;
  let phase = exp(-0.921034037 * (0.026 * deg + 4e-9 * deg2 * deg2));
  let night = 1.0 - smoothstep(-0.05, 0.18, F.sunDir.y);
  let size = max(F.moonLight.w, 0.0) / 2.5;
  let E = F.moonDir.w * phase * night * 0.028 * size * size;
  return vec3f(1.0, 0.96, 0.9) * sampleTrans(camR(), moon.y) * E;
}
@compute @workgroup_size(1)
fn main() {
  let L = F.sunDir.xyz;
  let sunScale = mix(1.0, Rain.atmo.y, step(0.001, Rain.wind.w));
  let sun = sampleTrans(RG + F.lodP.z * 0.001, L.y) * F.sunDir.w * sunScale;
  var zen = skyAtmo(vec3f(0.0, 1.0, 0.0));
  var hor = (skyAtmo(normalize(vec3f(1.0, 0.25, 0.0))) + skyAtmo(normalize(vec3f(-1.0, 0.25, 0.0)))
          + skyAtmo(normalize(vec3f(0.0, 0.25, 1.0))) + skyAtmo(normalize(vec3f(0.0, 0.25, -1.0)))) * 0.25;
  let cover = clamp(F.cloudP.y * 0.8 + F.atmo.z * 0.3, 0.0, 1.0);
  let skyDim = 1.0 - 0.35 * cover;
  let glow = vec3f(0.002, 0.003, 0.005) * F.nightP.w;
  zen = zen * skyDim * sunScale + glow;
  hor = hor * skyDim * sunScale + glow;
  let nl = nightLandscape();
  zen += nl.zen;
  hor += nl.hor;
  outL[0] = vec4f(sun, 0.0);
  outL[1] = vec4f(moonIlluminance() + nl.key, 0.0);
  outL[2] = vec4f(zen, 0.0);
  outL[3] = vec4f(hor, 0.0);
  outL[4] = vec4f(L, 0.0);
  outL[5] = vec4f(select(normalize(F.moonDir.xyz), nl.dir, nl.on > 0.5), 0.0);
}
`;
}

// Walks the cells in a square around the camera. Writes the trees that survive the range,
// water, frustum and stand tests, with their lighting already folded in.
export function treeGenWGSL(filterA) {
  return FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var sampC: sampler;
@group(0) @binding(2) var clipA: texture_2d_array<f32>;
@group(0) @binding(3) var clipB: texture_2d_array<f32>;
@group(0) @binding(4) var<uniform> CL: ClipLevels;
struct ShadowMap { origin: vec2f, texel: f32, span: f32 };
@group(0) @binding(5) var cloudShadowTex: texture_2d<f32>;
@group(0) @binding(6) var<uniform> SH: ShadowMap;
struct GenU { cell0: vec2i, dim: u32, pad: u32 };
@group(0) @binding(7) var<uniform> G: GenU;
@group(0) @binding(8) var<storage, read_write> trees: array<TreeInst>;
@group(0) @binding(9) var<storage, read_write> args: array<atomic<u32>, 8>;
` + NOISE_WGSL + TERRAIN_FUNCS + clipSampleWGSL(filterA) + FOREST_FUNCS + TREE_CONSTS + /* wgsl */ `
fn terrainShadow(p: vec3f, L: vec3f) -> f32 {
  if (L.y > 0.8) { return 1.0; }
  let ceiling = waterLevel(p.z) + F.valley.w + F.relief.x * (1.5 - F.biome.z) + 40.0;
  var t = 30.0;
  var res = 1.0;
  for (var i = 0; i < 8; i++) {
    let q = p + L * t;
    if (q.y > ceiling) { break; }
    let texel = max(t * 0.22, 24.0);
    let lf = clamp(log2(texel / CLIP_T0), 0.0, f32(CLIP_L - 1));
    let h = clipHeight(q.xz, ceil(lf));
    let gap = q.y - h;
    res = min(res, gap / (t * 0.05) + 0.5);
    if (res <= 0.0) { return 0.0; }
    t *= 1.72;
  }
  return smoothstep(0.0, 1.0, res);
}
fn cloudShade(world: vec3f) -> f32 {
  if (F.cloudP.w <= 0.001 || F.sunDir.y <= 0.0) { return 1.0; }
  let uv = (world.xz - SH.origin) / SH.span;
  let edge = smoothstep(0.0, 0.03, uv.x) * smoothstep(0.0, 0.03, uv.y)
           * smoothstep(0.0, 0.03, 1.0 - uv.x) * smoothstep(0.0, 0.03, 1.0 - uv.y);
  let s = textureSampleLevel(cloudShadowTex, sampC, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0).r;
  return mix(1.0, s, edge);
}

@compute @workgroup_size(${TREE_GEN_GROUP}, ${TREE_GEN_GROUP}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= G.dim || id.y >= G.dim) { return; }
  if (F.forest.x <= 0.0) { return; }
  let cell = G.cell0 + vec2i(id.xy);
  let sp = F.forest.y;
  // trunk position and the cheap range test first: most cells stop here
  let h0 = pcgHash((u32(cell.x) * 73856093u) ^ (u32(cell.y) * 19349663u + seedU() + 0x5bd1e995u));
  let pos = (vec2f(cell) + 0.5 + (vec2f(unit16(h0), unit16(h0 >> 16u)) - 0.5) * 0.8) * sp;
  let relH = pos - F.camPos.xz;
  let d2 = dot(relH, relH);
  if (d2 > TREE_RANGE * TREE_RANGE) { return; }
  let dist = sqrt(d2);
  // stand mask first, it is one texture read
  let m = treeMasks(pos);
  if (m.x < 0.02) { return; }
  let t = treeCell(cell, false, m.x, m.y);
  if (!t.ok) { return; }
  // Ground under the trunk, at the same continuous level the terrain mesh uses. A stepped
  // level made every tree grow or sink as the level boundary swept past it.
  let d3 = distance(vec3f(pos.x, F.lodP.z, pos.y), F.camPos.xyz);
  let lod = clamp(ceil(log2(max(d3, 1.0) / F.lodP.x)), 0.0, 9.0);
  let range = F.lodP.x * exp2(lod);
  let spacing = (F.lodP.x / (16.0 * F.lodP.y)) * exp2(lod);
  let morph = clamp((d3 - 0.8 * range) / (0.2 * range), 0.0, 1.0);
  let lv = clamp(max(clipFinest(pos), log2(spacing * (1.0 + morph) / CLIP_T0)), 0.0, f32(CLIP_L - 1));
  let gy = clipHeight(pos, lv);
  if (gy <= waterLevel(pos.y) + 0.2) { return; }
  // frustum, padded by the size of the crown
  let R = max(t.r * 1.3, 2.0) + t.top * 0.5;
  let rel = vec3f(pos.x - F.camPos.x, gy + t.top * 0.5 - F.camPos.y, pos.y - F.camPos.z);
  let z = dot(rel, F.camFwd.xyz);
  if (z < -R) { return; }
  if (z > R) {
    let tx = length(F.camRight.xyz);
    let ty = length(F.camUp.xyz);
    let nx = abs(dot(rel, F.camRight.xyz)) / (tx * tx * z);
    let ny = abs(dot(rel, F.camUp.xyz)) / (ty * ty * z);
    if (nx > 1.05 + R / (z * tx) || ny > 1.05 + R / (z * ty)) { return; }
  }

  // light this tree sees
  var lt = readLight();
  let ground = vec3f(pos.x, gy, pos.y);
  let sunUp = smoothstep(-0.015, 0.02, lt.L.y);
  var sunVis = 0.0;
  var cloudSh = 1.0;
  if (sunUp > 0.0) {
    cloudSh = cloudShade(ground);
    sunVis = terrainShadow(ground + vec3f(0.0, 2.0, 0.0), lt.L) * cloudSh * sunUp;
  }
  // the stand this tree belongs to, lit the way the far ground is lit
  let V = normalize(F.camPos.xyz - vec3f(pos.x, gy + t.top * 0.6, pos.y));
  let g = acos(clamp(dot(V, lt.L), -1.0, 1.0));
  let litBase = clamp(0.22 + 0.5 * lt.L.y + 0.22 * V.y, 0.0, 1.0);
  let lit = mix(litBase, 1.0, exp(-g * 3.5));
  let side = sqrt(max(1.0 - lt.L.y * lt.L.y, 0.0)) * smoothstep(-0.02, 0.1, lt.L.y);
  let crownCos = max(lt.L.y, 0.0) * 0.75 + side * mix(0.3, 0.4, m.y);
  let up = vec3f(0.0, 1.0, 0.0);
  let stand = standAlbedoAt(pos, m.y) * (lt.sun * sunVis * lit * crownCos
            + lt.moon * max(dot(up, lt.M), 0.0) + ambient(lt, up) * 0.7) * (1.0 / PI);
  let alb = treeAlbedo(t);

  var inst: TreeInst;
  inst.a = vec4f(pos.x, gy, pos.y, t.r);
  inst.b = vec4f(t.top, t.base, t.seed, select(0.0, 1.0, t.conifer));
  inst.c = vec4f(sunVis, cloudSh * sunUp, m.x, m.y);
  inst.d = vec4f(stand, 0.0);
  inst.e = vec4f(alb, 0.0);
  if (dist < TREE_NEAR_DIST) {
    let i = atomicAdd(&args[1], 1u);
    if (i < TREE_NEAR_MAX) { trees[i] = inst; }
  } else {
    let j = atomicAdd(&args[5], 1u);
    if (j < TREE_MAX - TREE_NEAR_MAX) { trees[TREE_MAX - 1u - j] = inst; }
  }
}
`;
}

// Crowns. The near list is a twelve-sided cone in three rings (apex, shoulder, base), the far
// list a single six-triangle fan. Both are shaded from the same analytic cone or dome the old
// per-pixel crowns used.
export function treeDrawWGSL() {
  return FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(2) var<storage, read> trees: array<TreeInst>;
@group(0) @binding(3) var apTex: texture_3d<f32>;
@group(0) @binding(4) var sampC: sampler;
` + RAIN_STRUCT + /* wgsl */ `
@group(0) @binding(5) var<uniform> Rain: RainU;
` + NOISE_WGSL + TERRAIN_FUNCS + TREE_CONSTS + /* wgsl */ `
const AP_N: f32 = ${AP_RES}.0;
const AP_MAX: f32 = ${AP_MAX_KM}.0;
override FAR: bool = false;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,
  @location(1) dv: vec2f,
  @location(2) @interpolate(flat) ti: u32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);   // outside the clip volume: the triangle is discarded
  o.rel = vec3f(0.0);
  o.dv = vec2f(0.0);
  o.ti = 0u;
  var ti = ii;
  if (FAR) {
    if (ii >= TREE_MAX - TREE_NEAR_MAX) { return o; }
    ti = TREE_MAX - 1u - ii;
  } else if (ii >= TREE_NEAR_MAX) {
    return o;
  }
  let I = trees[ti];
  let top = I.b.x;
  let base = I.b.y;
  let conifer = I.b.w > 0.5;
  let span = max(top - base, 0.5);
  let centre = vec3f(I.a.x, I.a.y, I.a.z);
  // True crown radius at every distance. Enlarging small crowns to a minimum pixel size
  // made them shrink back to their real width as the camera approached, a ripple of
  // growing and shrinking that travelled through the forest.
  let r = I.a.w;

  let tri = vi / 3u;
  let k = vi % 3u;
  var ring = 0u;     // 0 apex, 1 shoulder, 2 base
  var si = 0u;
  let segs = select(TREE_SEGS_NEAR, TREE_SEGS_FAR, FAR);
  if (FAR) {
    if (k > 0u) { ring = 2u; si = tri + k - 1u; }
  } else if (tri < segs) {
    if (k > 0u) { ring = 1u; si = tri + k - 1u; }
  } else {
    let q = tri - segs;
    let i = q >> 1u;
    if ((q & 1u) == 0u) {
      if (k == 0u) { ring = 1u; si = i; } else { ring = 2u; si = i + select(0u, 1u, k == 2u); }
    } else {
      if (k == 0u) { ring = 1u; si = i; } else if (k == 1u) { ring = 2u; si = i + 1u; } else { ring = 1u; si = i + 1u; }
    }
  }
  // normalised radius and the crown height there
  var u = 0.0;
  if (ring == 1u) { u = select(0.62, 0.5, conifer); }
  if (ring == 2u) { u = 1.0; }
  var y = top;
  if (ring > 0u) {
    y = select(base + span * (1.0 - u * u), top - span * pow(u, 0.85), conifer);
  }
  let seed = I.b.z;
  let a = f32(si % segs) * (6.2831853 / f32(segs)) + seed * 0.37;
  // A polygon with the area of the round crown. Trimming a larger one to the circle in the
  // fragment shader (discard) turned off early depth testing, and every crown hidden behind
  // the first one was shaded as well.
  let rad = u * r * select(1.023, 1.0996, FAR);
  let dv = vec2f(cos(a), sin(a)) * rad;
  var rel = vec3f(centre.x + dv.x, centre.y + y, centre.z + dv.y) - F.camPos.xyz;
  rel.y -= dot(rel.xz, rel.xz) / (2.0 * EARTH_R);
  o.rel = rel;
  o.pos = F.viewProj * vec4f(rel, 1.0);
  o.dv = dv;
  o.ti = ti;
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let I = trees[in.ti];
  let fp = max(length(dpdx(in.dv)), length(dpdy(in.dv)));
  let dist = length(in.rel);
  let V = -in.rel / dist;
  let conifer = I.b.w > 0.5;
  let top = I.b.x;
  let base = I.b.y;
  let r = I.a.w;
  let span = max(top - base, 0.5);
  let sunVis = I.c.x;
  let cloudSu = I.c.y;
  let dens = I.c.z;
  var lt = readLight();

  // how much of this crown is still a crown: below a pixel it is the stand colour
  let kS = smoothstep(0.6, 2.2, fp / max(r, 0.1));
  var col = I.d.xyz;
  let d = max(length(in.dv), 1e-3);
  if (kS < 0.999) {
    let x = clamp(d / r, 0.02, 1.0);
    var yc: f32;
    var dydd: f32;
    if (conifer) {
      let px = pow(x, 0.85);
      yc = top - span * px;
      dydd = -span * 0.85 * px / (x * r);
    } else {
      yc = base + span * (1.0 - x * x);
      dydd = -span * 2.0 * x / r;
    }
    let cg = in.dv / d * dydd;
    // crown texture: branch tufts on conifers, lumpy foliage clusters on broadleaves
    let kd = 1.0 - smoothstep(0.08 * r, 0.45 * r, fp);
    let bf = 1.0 / (r * select(0.3, 0.22, conifer));
    let arc = d + max(top - yc, 0.0) * 0.8;
    let q = in.dv * (arc / d) * bf + vec2f(I.b.z * 1.37, I.b.z * 0.71);
    var b1 = vec3f(0.0);
    var b2 = vec3f(0.0);
    if (kd > 0.01) {
      b1 = gnoised(q);
      b2 = gnoised(q * 2.3 + vec2f(5.1, 2.7));
    }
    let amp = span * select(0.16, 0.10, conifer) * kd;
    let bump = (b1.yz + b2.yz * 2.3 * 0.5) * bf * amp;
    let gw = cg + bump;
    let nC = normalize(vec3f(-gw.x, 1.0, -gw.y));
    let yb = yc + (b1.x + b2.x * 0.5) * amp;
    let depthK = clamp((yb - base) / max(span, 1.0), 0.0, 1.0);
    let ao = (0.45 + 0.55 * depthK) * clamp(1.0 + (b1.x + 0.5 * b2.x) * 0.8 * kd, 0.5, 1.2);
    // a closed stand shades its lower crowns
    let sunk = smoothstep(-0.02, 0.35, lt.L.y);
    let shDepth = smoothstep(max(F.forest.z, 1.0) * 0.95, max(F.forest.z, 1.0) * 0.2, yb) * smoothstep(0.05, 0.5, dens);
    let sh = select(1.0, clamp(1.0 - shDepth * mix(0.78, 0.34, sunk), 0.0, 1.0), dens > 0.004);
    let alb = I.e.xyz;
    let trans = select(0.35, 0.18, conifer) * max(-dot(nC, lt.L), 0.0) * (1.0 - depthK * 0.6);
    let Hs = normalize(V + lt.L);
    let spec = select(0.010, 0.005, conifer) * ggx(max(dot(nC, Hs), 0.0), 0.5) * max(dot(nC, lt.L), 0.0)
             / max(dot(nC, V), 0.2);
    let own = (alb * (direct(lt, nC, sh * sunVis) + lt.sun * sh * sunVis * trans + ambient(lt, nC) * ao)
             + lt.sun * sh * sunVis * spec * PI) * (1.0 / PI);
    col = mix(own, col, kS);
  }
  col *= mix(1.0, 0.72, Rain.amt.x);

  // valley mist, precipitation and aerial perspective, as for the ground
  let xz = vec2f(I.a.x, I.a.z) + in.dv;
  let wl = waterLevel(xz.y);
  if (F.mist.x > 0.0) {
    let topM = wl + F.mist.y;
    let py = F.camPos.y + in.rel.y;
    let below = max(topM - py, 0.0);
    if (below > 0.0) {
      let pn = fbm2(xz * (1.0 / 520.0) + vec2f(F.camPos.w * 0.004, 1.0), 2) * 0.5 + 0.5;
      let thick = F.mist.x * 0.0022 * smoothstep(0.5, 0.85, pn) * smoothstep(0.0, F.mist.y * 0.6, below);
      let camIn = max(topM - F.camPos.y, 0.0);
      let path = min((below - camIn) / max(V.y, 0.04), dist);
      let Tm = exp(-thick * max(path, 0.0));
      let cosT = dot(-V, lt.L);
      let ph = mix(phaseHG(cosT, 0.6), phaseHG(cosT, -0.1), 0.5) * 4.0 * PI;
      let mistCol = lt.sun * cloudSu * ph * 0.16 + (lt.zen * 0.6 + lt.hor * 0.4) * 0.9 + lt.moon * 0.3;
      col = col * Tm + mistCol * (1.0 - Tm);
    }
  }
  if (Rain.wind.w > 0.004) {
    let snow = Rain.amt.y;
    let thick = Rain.wind.w * mix(0.00042, 0.00018, snow);
    let Tm = exp(-thick * dist);
    let fogCol = mix(vec3f(0.58, 0.63, 0.7), vec3f(0.86, 0.89, 0.93), snow);
    var litFog = (lt.zen * 0.62 + lt.hor * 0.38) * mix(0.5, 0.85, snow);
    litFog += vec3f(0.62, 0.72, 0.95) * Rain.amt.z * 0.9;
    col = col * Tm + fogCol * litFog * (1.0 - Tm);
    if (Rain.bolt.w > 0.5) { col += vec3f(0.42, 0.52, 0.78) * Rain.amt.z * 0.6; }
  }
  let uv = in.pos.xy * F.screen.zw;
  let zc = sqrt(dist * 0.001 / AP_MAX) * AP_N - 1.0;
  let w = clamp(zc + 1.0, 0.0, 1.0);
  let ap = textureSampleLevel(apTex, sampC, vec3f(uv, (max(zc, 0.0) + 0.5) / AP_N), 0.0);
  let T = mix(1.0, ap.a, w);
  col = col * T + ap.rgb * F.sunDir.w * w;
  return vec4f(col, 1.0);
}
`;
}
