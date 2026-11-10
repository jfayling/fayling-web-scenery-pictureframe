// Landscape surface + sky background rendering.
import { FRAME_WGSL, ATMO_CORE_WGSL, AP_RES, AP_MAX_KM, TREE_RANGE } from './common.js';
import { SKY_RENDER_FUNCS, SKY_CLOUD_FUNCS } from './sky.js';
import { TERRAIN_FUNCS, clipSampleWGSL } from './terrain.js';
import { FOREST_FUNCS } from './forest.js';
import { RAIN_STRUCT, RAIN_FUNCS } from './rain.js';

const RENDER_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var starMap: texture_2d<f32>;
`;

// Full-resolution sky + clouds. Cloud silhouettes are anti-aliased analytically: the
// screen-space derivative of each layer's edge function sets the width of its opacity edge.
export const SKY_BG = FRAME_WGSL + ATMO_CORE_WGSL + RENDER_BINDINGS + RAIN_STRUCT + /* wgsl */ `
@group(0) @binding(5) var<uniform> Rain: RainU;
` + SKY_RENDER_FUNCS + SKY_CLOUD_FUNCS + RAIN_FUNCS + /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VO;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let dir = normalize(F.camFwd.xyz + in.ndc.x * F.camRight.xyz + in.ndc.y * F.camUp.xyz);
  let pixAng = 2.0 * length(F.camUp.xyz) * F.screen.w;
  var d2 = dir;
  d2.y = max(d2.y, 0.0005);
  d2 = normalize(d2);
  // edge functions at this pixel (uniform control flow, so fwidth is valid)
  let hl = hitLayer(d2, F.cloudP.x);
  let el = lowEdge(hl.q, hl.t * pixAng / hl.mu, 7);
  let hh = hitLayer(d2, F.cloudShape.y);
  let eh = highEdge(hh.q, hh.t * pixAng / hh.mu, 6);
  let aa = vec2f(fwidth(el), fwidth(eh));
  var sunT = 1.0;
  let cl = cloudLayers(d2, pixAng, aa, &sunT);
  let L = skyAtmo(d2) * (1.0 - cl.a) + nightSky(d2, pixAng, cl.a, true) + cl.rgb + sunDisk(dir) * sunT;
  return vec4f(applyRainSky(d2, L), 1.0);
}
`;

export function landWGSL(filterA) {
  return FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var apTex: texture_3d<f32>;
@group(0) @binding(5) var clipA: texture_2d_array<f32>;
@group(0) @binding(6) var clipB: texture_2d_array<f32>;
@group(0) @binding(7) var<uniform> CL: ClipLevels;
` + RAIN_STRUCT + /* wgsl */ `
@group(0) @binding(8) var<uniform> Rain: RainU;
struct ShadowMap { origin: vec2f, texel: f32, span: f32 };
@group(0) @binding(9) var cloudShadowTex: texture_2d<f32>;
@group(0) @binding(10) var<uniform> SH: ShadowMap;
@group(0) @binding(11) var reflTex: texture_2d<f32>;
@group(0) @binding(12) var sampR: sampler;
` + SKY_RENDER_FUNCS + RAIN_FUNCS + TERRAIN_FUNCS + clipSampleWGSL(filterA) + FOREST_FUNCS + /* wgsl */ `
const AP_N: f32 = ${AP_RES}.0;
const AP_MAX: f32 = ${AP_MAX_KM}.0;
const EARTH_R: f32 = 6371000.0;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,     // surface position relative to the camera (with Earth curvature)
  @location(1) xz: vec2f,      // world ground position
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) inst: vec4f) -> VSOut {
  let n = u32(F.lodP.y);
  let g = vec2f(f32(vi % (n + 1u)), f32(vi / (n + 1u)));
  let spacing = inst.z / f32(n);
  var xz = inst.xy + g * spacing;
  // CDLOD morph towards the next coarser level
  let R = F.lodP.x * exp2(inst.w);
  let d = distance(vec3f(xz.x, F.lodP.z, xz.y), F.camPos.xyz);
  let mk = clamp((d - 0.8 * R) / (0.2 * R), 0.0, 1.0);
  xz -= fract(g * 0.5) * 2.0 * spacing * mk;
  let eff = spacing * (1.0 + mk);
  let lv = clamp(max(clipFinest(xz), log2(eff / CLIP_T0)), 0.0, f32(CLIP_L - 1));
  let h = clipHeight(xz, lv);
  let wl = waterLevel(xz.y);
  var y = max(h, wl);
  var shift = vec2f(0.0);
  if (F.water.w > 0.5 && h < wl) {
    let sea = seaState(xz, F.camPos.w, eff * 3.6, wl - h, false);
    let wet = smoothstep(0.2, 2.6, wl - h);
    y = mix(max(h, wl), wl + sea.height, wet);
    shift = sea.chop * wet;
  }
  var o: VSOut;
  var rel = vec3f(xz.x + shift.x, y, xz.y + shift.y) - F.camPos.xyz;
  rel.y -= dot(rel.xz, rel.xz) / (2.0 * EARTH_R);
  o.rel = rel;
  o.pos = F.viewProj * vec4f(rel, 1.0);
  o.xz = xz;
  return o;
}

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

// Mountain shadows: a short march for the nearest ridge, then long steps that still
// reach a few kilometres. The shadow only has to catch whole slopes, so samples stay
// on coarse clip levels instead of the 2 m map.
fn terrainShadow(p: vec3f, L: vec3f) -> f32 {
  if (L.y > 0.8) { return 1.0; }
  let ceiling = waterLevel(p.z) + F.valley.w + F.relief.x * (1.5 - F.biome.z) + 40.0;
  var t = 30.0;
  var res = 1.0;
  // Eight steps, stretching faster than the old twelve. The reach is the same few
  // kilometres; the dropped samples were the expensive part of every landscape pixel.
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

// Cloud shadow baked for the ground around the camera. Same shapes as the sky,
// sampled once per frame instead of rebuilt inside every landscape pixel.
fn cloudShade(world: vec3f) -> f32 {
  if (F.cloudP.w <= 0.001 || F.sunDir.y <= 0.0) { return 1.0; }
  let uv = (world.xz - SH.origin) / SH.span;
  let edge = smoothstep(0.0, 0.03, uv.x) * smoothstep(0.0, 0.03, uv.y)
           * smoothstep(0.0, 0.03, 1.0 - uv.x) * smoothstep(0.0, 0.03, 1.0 - uv.y);
  let s = textureSampleLevel(cloudShadowTex, sampC, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0).r;
  return mix(1.0, s, edge);
}

fn ggx(nh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
fn schlick(c: f32, f0: f32) -> f32 {
  let x = 1.0 - clamp(c, 0.0, 1.0);
  let x2 = x * x;
  return f0 + (1.0 - f0) * x2 * x2 * x;
}

struct Light { sun: vec3f, moon: vec3f, zen: vec3f, hor: vec3f, L: vec3f, M: vec3f };

// Sky irradiance from a direction-dependent mix of the zenith and the horizon band.
// Diffuse terms multiply albedo by irradiance; the caller applies the Lambert 1/pi.
fn ambient(lt: Light, n: vec3f) -> vec3f {
  return mix(lt.hor, lt.zen, 0.5 + 0.5 * n.y) * (0.55 + 0.45 * n.y) * PI;
}
fn direct(lt: Light, n: vec3f, sunVis: f32) -> vec3f {
  return lt.sun * sunVis * max(dot(n, lt.L), 0.0) + lt.moon * max(dot(n, lt.M), 0.0);
}

// Ground cover between and outside the trees.
fn groundAlbedo(xz: vec2f, fp: f32, above: f32, dens: f32, rock: f32, snow: f32, curv: f32) -> vec3f {
  let n1 = fbm2(xz * (1.0 / 45.0) + vec2f(2.0, 9.0), select(2, 1, fp > 6.0));
  let n2 = snoise(xz * (1.0 / 9.0) + vec2f(5.0, 1.0)) * (1.0 - smoothstep(2.0, 9.0, fp));
  let dry = F.forest2.x * 0.6 + smoothstep(-0.2, 0.4, n1) * 0.22;
  let trop = F.biome.w;
  var meadow = mix(vec3f(0.058, 0.090, 0.028), vec3f(0.150, 0.125, 0.055), dry);
  meadow = mix(meadow, vec3f(0.05, 0.095, 0.03), trop);
  meadow *= 0.85 + 0.3 * n2 + 0.2 * n1;
  let litter = mix(vec3f(0.050, 0.044, 0.030), vec3f(0.035, 0.050, 0.025), 0.5 + 0.5 * n1);
  var c = mix(meadow, litter, smoothstep(0.12, 0.55, dens));
  // bog and fen: olive sedge, rusty sphagnum, dark pools of peat
  let bog = F.biome.y * (1.0 - smoothstep(0.5, 6.0, above));
  if (bog > 0.01) {
    let fen = mix(vec3f(0.11, 0.095, 0.045), vec3f(0.15, 0.07, 0.035), smoothstep(-0.1, 0.3, n1 + n2 * 0.3));
    c = mix(c, fen * (0.8 + 0.3 * n2), bog * (1.0 - smoothstep(0.2, 0.7, dens)));
  }
  // gravel and sand bars along the water
  let bar = (1.0 - smoothstep(0.1, 0.8, above + n2 * 0.3)) * (1.0 - smoothstep(0.05, 0.3, dens));
  let barC = mix(vec3f(0.16, 0.145, 0.115), vec3f(0.07, 0.065, 0.055), smoothstep(-0.3, 0.3, n1));
  c = mix(c, barC * (0.9 + 0.2 * n2), bar);
  if (F.water.w > 0.5) {
    let beach = (1.0 - smoothstep(0.3, 8.0, above)) * (1.0 - smoothstep(0.02, 0.4, dens));
    var sand = vec3f(0.46, 0.39, 0.26);
    sand *= 0.78 + 0.32 * n2 + 0.12 * n1;
    sand *= mix(0.62, 1.0, smoothstep(0.05, 1.4, above));
    c = mix(c, sand, beach);
  }
  // rock: granite greys (dark basalt in the tropics), darker in clefts, lighter on ribs
  if (rock > 0.02 && fp < 12.0) {
  let strata = snoise(vec2f((xz.x + xz.y) * 0.004, above * 0.09)) * 0.5 + 0.5;
  var rk = mix(vec3f(0.12, 0.115, 0.10), vec3f(0.19, 0.18, 0.16), strata);
  // weathered faces carry lichen and moss
  rk = mix(rk, vec3f(0.075, 0.085, 0.05), smoothstep(0.0, 0.6, n1) * 0.5);
  rk = mix(rk, vec3f(0.075, 0.07, 0.065), trop);
  // water-stained streaks down the faces and darker bands of harder strata
  let streak = fbm2(vec2f(xz.x * (1.0 / 35.0), xz.y * (1.0 / 35.0) + above * (1.0 / 9.0)), 3);
  rk *= 0.6 + 0.5 * smoothstep(-0.5, 0.5, streak) + 0.25 * strata;
  // hillside-scale contrast that survives at distance: pale scree fans, dark cliff bands
  let face = fbm2(xz * (1.0 / 420.0) + vec2f(above * 0.0015, 6.3), 3);
  rk *= 0.55 + 0.75 * smoothstep(-0.45, 0.45, face);
  rk *= clamp(1.0 + curv * 5.0, 0.55, 1.25) * (0.85 + 0.3 * n2);
  if (F.water.w > 0.5) { rk = mix(rk, rk * vec3f(1.25, 0.92, 0.72), 0.55); }
  c = mix(c, rk, rock);
  }
  // lichen and scree tint above the treeline
  c = mix(c, vec3f(0.85, 0.87, 0.9), snow);
  return c;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let xz = in.xz;
  let dist = length(in.rel);
  let V = -in.rel / dist;
  let fp = max(length(dpdx(xz)), length(dpdy(xz)));

  let lc = clipFinest(xz);
  let lf = clamp(max(lc, log2(max(fp, 1e-3) / CLIP_T0) - 0.5), 0.0, f32(CLIP_L - 1));
  let A = clipA2(xz, lf);
  let M = clipB2(xz, lf);
  let hT = A.x;
  let grad = A.yz;
  let curv = A.w;
  let Nt = normalize(vec3f(-grad.x, 1.0, -grad.y));
  let wl = waterLevel(xz.y);
  let depth = wl - hT;
  let above = -depth;
  let dens = M.x;
  let conif = M.y;

  // ---- light ----
  var lt: Light;
  lt.L = F.sunDir.xyz;
  lt.M = normalize(F.moonDir.xyz);
  let ground = vec3f(xz.x, max(hT, wl), xz.y);
  let sunUp = smoothstep(-0.015, 0.02, lt.L.y);
  var sunVis = 0.0;
  var cloudSh = 1.0;
  if (sunUp > 0.0) {
    cloudSh = cloudShade(ground);
    sunVis = terrainShadow(ground + Nt * 2.0, lt.L) * cloudSh * sunUp;
  }
  lt.sun = sampleTrans(RG + ground.y * 0.001, lt.L.y) * F.sunDir.w;
  lt.moon = moonIlluminance();
  let wet = Rain.amt.x;
  let sunScale = mix(1.0, Rain.atmo.y, step(0.001, Rain.wind.w));
  lt.sun *= sunScale;
  lt.zen = skyAtmo(vec3f(0.0, 1.0, 0.0));
  lt.hor = (skyAtmo(normalize(vec3f(1.0, 0.25, 0.0))) + skyAtmo(normalize(vec3f(-1.0, 0.25, 0.0)))
          + skyAtmo(normalize(vec3f(0.0, 0.25, 1.0))) + skyAtmo(normalize(vec3f(0.0, 0.25, -1.0)))) * 0.25;
  // clouds overhead dim the open sky and add their own grey light
  let cover = clamp(F.cloudP.y * 0.8 + F.atmo.z * 0.3, 0.0, 1.0);
  let skyDim = 1.0 - 0.35 * cover;
  let glow = vec3f(0.002, 0.003, 0.005) * F.nightP.w;
  lt.zen = lt.zen * skyDim * sunScale + glow;
  lt.hor = lt.hor * skyDim * sunScale + glow;

  var col = vec3f(0.0);
  if (depth > 0.0) {
    // ---- water: lakes, the river, and the Pacific swell ----
    let t = F.camPos.w;
    let detail = 1.0 - smoothstep(0.6, 6.0, fp);
    let ocean = F.water.w > 0.5;
    var sl = vec2f(0.0);
    var crest = 0.0;
    var waveH = 0.0;
    if (ocean) {
      let sea = seaState(xz, t, max(fp * 1.4, 2.0), depth, true);
      sl = sea.slope;
      crest = sea.crest;
      waveH = sea.height;
      // capillary glitter on top of the resolved swell, blown onshore
      if (fp < 16.0) {
        let wind = normalize(vec2f(0.97, 0.24));
        let rip = gnoised(xz * (1.0 / 3.4) - wind * t * 0.7);
        let rip2 = gnoised(xz * (1.0 / 1.2) - wind * t * 1.35 + vec2f(2.2, 5.4));
        let det = 1.0 - smoothstep(2.5, 16.0, fp);
        sl += (rip.yz * 0.04 + rip2.yz * 0.02) * det;
      }
    } else {
      var flow = vec2f(0.0);
      if (F.valley.z > 0.0) {
        let rw = riverHalfWidth(xz.y);
        let inRiver = 1.0 - smoothstep(1.1, 2.0, abs(riverOffset(xz)) / rw);
        flow = normalize(vec2f(riverDX(xz.y), 1.0)) * 0.9 * inRiver;
      }
      let r1 = gnoised(xz * (1.0 / 7.0) - flow * t * (1.0 / 7.0) + vec2f(0.0, t * 0.02));
      let r2 = gnoised(xz * (1.0 / 2.3) - flow * t * 1.3 * (1.0 / 2.3) + vec2f(t * 0.05, 0.0));
      sl = r1.yz * 0.021 + r2.yz * 0.018 * detail;
    }
    let n = normalize(vec3f(-sl.x, 1.0, -sl.y));
    // unresolved ripples widen the sun glint with distance. The swell is a few long
    // trains, so the ocean's glitter is a little broader than a river's or it locks
    // into hard dashes on every crest.
    let rough = select(0.05, 0.1, ocean) + 0.12 * smoothstep(0.5, 30.0, fp) + wet * 0.14;
    let NdV = max(dot(n, V), 1e-3);
    let Fr = schlick(NdV, 0.02);
    var R = reflect(-V, n);
    R.y = abs(R.y);
    var refl = textureSampleLevel(reflTex, sampR, skyMapUV(R), 0.0).rgb;
    // the wooded banks darken the reflection near the shore
    let bankK = (1.0 - smoothstep(0.2, 3.5, depth)) * smoothstep(0.0, 0.4, 1.0 - R.y);
    let bankCol = standAlbedo(0.5) * (lt.sun * sunVis * 0.25 + ambient(lt, Nt)) * (0.9 / PI);
    refl = mix(refl, bankCol, bankK * select(0.75, 0.12, ocean));
    let Hs = normalize(V + lt.L);
    let NdL = max(dot(n, lt.L), 0.0);
    var glint = lt.sun * sunVis * ggx(max(dot(n, Hs), 0.0), rough) * schlick(dot(V, Hs), 0.02) * NdL / (4.0 * NdV);
    let tannin = F.water.z;
    var deep = mix(vec3f(0.006, 0.016, 0.016), vec3f(0.016, 0.010, 0.004), tannin);
    var bed = groundAlbedo(xz, fp, 0.5, 0.0, 0.0, 0.0, 0.0) * mix(vec3f(0.7, 0.85, 0.8), vec3f(0.8, 0.6, 0.35), tannin);
    var extK = mix(vec3f(0.45, 0.16, 0.12), vec3f(0.35, 0.55, 0.9), tannin);
    if (ocean) {
      deep = vec3f(0.004, 0.026, 0.052);
      let sandCol = vec3f(0.52, 0.44, 0.30) * (0.86 + 0.22 * snoise(xz * 0.03));
      let rockCol = vec3f(0.15, 0.145, 0.13) * (0.78 + 0.28 * snoise(xz * 0.017 + vec2f(2.0, 5.0)));
      let sandy = 1.0 - smoothstep(0.22, 0.78, shoreKind(xz.y));
      bed = mix(rockCol, sandCol, sandy);
      // sandy aprons stay clear enough to show the bottom; cliff water goes dark sooner
      extK = mix(vec3f(0.22, 0.07, 0.045), vec3f(0.10, 0.032, 0.022), sandy);
    }
    let path = depth * (1.0 + 1.0 / max(V.y, 0.15));
    let ext = exp(-path * extK);
    let lit = lt.sun * sunVis * max(lt.L.y, 0.0) + ambient(lt, vec3f(0.0, 1.0, 0.0));
    let body = (bed * ext + deep * (1.0 - ext)) * lit * (1.0 / PI);
    let ripple = xz * (0.45 + wet * 1.4) + vec2f(t * 2.1, -t * 0.6);
    let spark = pow(max(sin(ripple.x * 1.7) * sin(ripple.y * 1.3), 0.0), 12.0);
    glint += lt.sun * sunVis * spark * wet * 0.22;
    col = body * (1.0 - Fr) + refl * Fr + glint;
    if (ocean) { col *= 1.0 + clamp(waveH * 0.14, -0.12, 0.16); }
    if (ocean && crest > 0.02) {
      let lace = smoothstep(0.22, 0.72, snoise(xz * vec2f(0.08, 0.035) + vec2f(t * 0.15, 0.6)));
      let mask = clamp(crest * mix(0.55, 1.0, lace), 0.0, 1.0);
      let foam = vec3f(0.76, 0.82, 0.86) * (lt.hor * 0.7 + lt.zen * 0.35 + lt.sun * sunVis * 0.25);
      col = mix(col, foam, mask * 0.92);
    }
  } else {
    // ---- land ----
    let sp = F.forest.y;
    // The crowns are instanced trees (trees.js). The ground carries what is between and
    // under them; once trees are too small to tell apart it carries the stand colour that
    // the trees themselves fade to.
    let farK = max(smoothstep(0.35 * sp, 1.0 * sp, fp), smoothstep(0.8 * ${TREE_RANGE}.0, ${TREE_RANGE}.0, dist));
    let gAlb = groundAlbedo(xz, fp, above, dens, M.z, M.w, curv);
    var Ng = Nt;
    if (fp < 4.0) {
      let b = gnoised(xz * (1.0 / 5.0) + vec2f(3.0, 3.0)).yz * 0.12 * (1.0 - smoothstep(1.0, 4.0, fp));
      Ng = normalize(Nt + vec3f(-b.x, 0.0, -b.y));
    }
    // valleys and hollows collect less sky light
    let aoT = clamp(1.0 + curv * 4.0, 0.6, 1.0);
    var nearC = vec3f(0.0);
    if (farK < 1.0 && F.forest.x > 0.0) {
      let uy = understoryH(dens);
      let sh = canopyShadow(uy, lt.L, dens);
      // under and between crowns: little sky reaches the floor or the understory
      let ao = mix(1.0, 0.28, smoothstep(0.0, 0.8, dens)) * aoT;
      let uK = smoothstep(0.5, 2.0, uy);
      let under = mix(standAlbedo(1.0), standAlbedo(conif), 0.4) * 0.75;
      let alb = mix(gAlb, under, uK);
      let n = normalize(mix(Ng, vec3f(0.0, 1.0, 0.0), uK));
      nearC = alb * (direct(lt, n, sh * sunVis) + ambient(lt, n) * ao);
    }
    var farCol = vec3f(0.0);
    if (farK > 0.0 || F.forest.x <= 0.0) {
      // Statistical canopy: closure, the fraction of visible foliage that is sunlit
      // (the hotspot: with the sun behind the camera the shadows hide behind the crowns),
      // and the floor showing through the gaps.
      let closure = 1.0 - exp(-2.8 * dens);
      let g = acos(clamp(dot(V, lt.L), -1.0, 1.0));
      let litBase = clamp(0.22 + 0.5 * lt.L.y + 0.22 * V.y, 0.0, 1.0);
      let lit = mix(litBase, 1.0, exp(-g * 3.5));
      let standN = normalize(mix(Nt, vec3f(0.0, 1.0, 0.0), 0.35));
      // crowns stand up out of the ground, so a low sun still lights their sides
      let side = sqrt(max(1.0 - lt.L.y * lt.L.y, 0.0)) * smoothstep(-0.02, 0.1, lt.L.y);
      let crownCos = max(dot(standN, lt.L), 0.0) * 0.75 + side * mix(0.3, 0.4, conif);
      let stand = standAlbedoAt(xz, conif) * (lt.sun * sunVis * lit * crownCos
                + lt.moon * max(dot(standN, lt.M), 0.0) + ambient(lt, standN) * 0.7 * aoT);
      let gapLit = mix(1.0, lit * 0.35, closure);
      let floorC = gAlb * (direct(lt, Nt, sunVis * gapLit) + ambient(lt, Nt) * mix(1.0, 0.3, closure) * aoT);
      farCol = mix(floorC, stand, closure);
    }
    col = select(mix(nearC, farCol, farK), farCol, F.forest.x <= 0.0) * (1.0 / PI);
    // A water film darkens foliage and rock and lifts the leaf sheen.
    col *= mix(1.0, 0.72, wet);
    let sheen = pow(max(dot(normalize(V + lt.L), Ng), 0.0), 18.0) * wet * sunVis;
    col += lt.sun * sheen * 0.015;
  }

  // ---- valley mist ----
  if (F.mist.x > 0.0) {
    let top = wl + F.mist.y;
    let py = F.camPos.y + in.rel.y;
    let below = max(top - py, 0.0);
    if (below > 0.0) {
      // drifting banks of valley fog with clear gaps between them
      let pn = fbm2(xz * (1.0 / 520.0) + vec2f(F.camPos.w * 0.004, 1.0), 2) * 0.5 + 0.5;
      let thick = F.mist.x * 0.0022 * smoothstep(0.5, 0.85, pn) * smoothstep(0.0, F.mist.y * 0.6, below);
      let camIn = max(top - F.camPos.y, 0.0);
      let path = min((below - camIn) / max(V.y, 0.04), dist);
      let Tm = exp(-thick * max(path, 0.0));
      let cosT = dot(-V, lt.L);
      let ph = mix(phaseHG(cosT, 0.6), phaseHG(cosT, -0.1), 0.5) * 4.0 * PI;
      let mistCol = lt.sun * cloudSh * sunUp * ph * 0.16 + (lt.zen * 0.6 + lt.hor * 0.4) * 0.9 + lt.moon * 0.3;
      col = col * Tm + mistCol * (1.0 - Tm);
    }
  }

  // ---- precipitation between the camera and the valley ----
  if (Rain.wind.w > 0.004) {
    let snow = Rain.amt.y;
    let thick = Rain.wind.w * mix(0.00042, 0.00018, snow);
    let Tm = exp(-thick * dist);
    let fogCol = mix(vec3f(0.58, 0.63, 0.7), vec3f(0.86, 0.89, 0.93), snow);
    var litFog = (lt.zen * 0.62 + lt.hor * 0.38) * mix(0.5, 0.85, snow);
    litFog += vec3f(0.62, 0.72, 0.95) * Rain.amt.z * 0.9;
    col = col * Tm + fogCol * litFog * (1.0 - Tm);
    if (Rain.bolt.w > 0.5) {
      col += vec3f(0.42, 0.52, 0.78) * Rain.amt.z * (0.35 + 0.65 * max(Nt.y, 0.0));
    }
  }

  // ---- aerial perspective ----
  let uv = in.pos.xy * F.screen.zw;
  let zc = sqrt(dist * 0.001 / AP_MAX) * AP_N - 1.0;
  let w = clamp(zc + 1.0, 0.0, 1.0);
  let ap = textureSampleLevel(apTex, sampC, vec3f(uv, (max(zc, 0.0) + 0.5) / AP_N), 0.0);
  let T = mix(1.0, ap.a, w);
  col = col * T + ap.rgb * F.sunDir.w * w;

  if (F.post.w > 0.5) {
    if (F.post.w < 1.5) { return vec4f(M.xyz * 0.3, 1.0); }
    if (F.post.w < 2.5) { return vec4f(vec3f(fract(lf * 0.999), f32(i32(lf) % 2), 0.0) * 0.25, 1.0); }
    if (F.post.w < 3.5) { return vec4f(vec3f(sunVis) * 0.3, 1.0); }
    return vec4f(Nt * 0.5 + 0.5, 1.0) * 0.3;
  }
  return vec4f(col, 1.0);
}
`;
}
