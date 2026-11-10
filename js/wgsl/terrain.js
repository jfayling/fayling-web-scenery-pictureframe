// Procedural landscape: eroded mountains, a meandering river valley, a one-sided coastline,
// lake basins, and the vegetation / rock / snow masks that go with them. The height function is baked into
// camera-centred clipmaps (one 512² layer per level, texel doubling per level) and the
// renderer samples those instead of re-evaluating the noise per pixel.
import { FRAME_WGSL, NOISE_WGSL, CLIP_RES, CLIP_LEVELS, CLIP_TEXEL0, PROBE_N } from './common.js';

// Clipmap lookups for the render passes. The including module declares clipA, clipB (both
// texture_2d_array<f32>), sampC (linear clamp sampler) and CL (ClipLevels). rgba32float
// is only filterable with the float32-filterable feature; without it A is filtered by hand.
export function clipSampleWGSL(filterA) {
  const loadA = filterA ? /* wgsl */ `
fn clipA1(xz: vec2f, L: i32) -> vec4f { return textureSampleLevel(clipA, sampC, clipUV(xz, L), L, 0.0); }
` : /* wgsl */ `
fn clipA1(xz: vec2f, L: i32) -> vec4f {
  let tc = clipUV(xz, L) * CLIP_N - 0.5;
  let i = vec2i(floor(tc));
  let f = tc - floor(tc);
  let m = vec2i(${CLIP_RES - 1});
  let a = textureLoad(clipA, clamp(i, vec2i(0), m), L, 0);
  let b = textureLoad(clipA, clamp(i + vec2i(1, 0), vec2i(0), m), L, 0);
  let c = textureLoad(clipA, clamp(i + vec2i(0, 1), vec2i(0), m), L, 0);
  let d = textureLoad(clipA, clamp(i + vec2i(1, 1), vec2i(0), m), L, 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;
  return /* wgsl */ `
struct ClipLevels { lv: array<vec4f, ${CLIP_LEVELS}> };   // xy = world position of texel 0, z = texel (m)
const CLIP_N: f32 = ${CLIP_RES}.0;
const CLIP_L: i32 = ${CLIP_LEVELS};
const CLIP_T0: f32 = ${CLIP_TEXEL0}.0;
fn clipUV(xz: vec2f, L: i32) -> vec2f {
  let o = CL.lv[L];
  return ((xz - o.xy) / o.z + 0.5) / CLIP_N;
}
// 1 well inside level L, 0 at the edge that is still safe to sample.
fn clipInside(xz: vec2f, L: i32) -> f32 {
  let o = CL.lv[L];
  let hw = o.z * CLIP_N * 0.5;
  let c = o.xy + vec2f(hw);
  let d = max(abs(xz.x - c.x), abs(xz.y - c.y));
  return clamp((0.94 * hw - d) / (0.24 * hw), 0.0, 1.0);
}
// Finest level that holds xz, continuous so neighbouring vertices agree (no cracks).
fn clipFinest(xz: vec2f) -> f32 {
  for (var L = 0; L < CLIP_L; L++) {
    let a = clipInside(xz, L);
    if (a > 0.0) { return f32(L) + 1.0 - a; }
  }
  return f32(CLIP_L - 1);
}
` + loadA + /* wgsl */ `
fn clipB1(xz: vec2f, L: i32) -> vec4f { return textureSampleLevel(clipB, sampC, clipUV(xz, L), L, 0.0); }
fn clipA2(xz: vec2f, lf: f32) -> vec4f {
  let l0 = min(i32(floor(lf)), CLIP_L - 1);
  let t = lf - f32(l0);
  let a = clipA1(xz, l0);
  if (t < 0.002 || l0 >= CLIP_L - 1) { return a; }
  return mix(a, clipA1(xz, l0 + 1), t);
}
fn clipB2(xz: vec2f, lf: f32) -> vec4f {
  let l0 = min(i32(floor(lf)), CLIP_L - 1);
  let t = lf - f32(l0);
  let a = clipB1(xz, l0);
  if (t < 0.002 || l0 >= CLIP_L - 1) { return a; }
  return mix(a, clipB1(xz, l0 + 1), t);
}
fn clipHeight(xz: vec2f, lf: f32) -> f32 { return clipA2(xz, lf).x; }
`;
}

// Valley path, water level and the height field. Requires F (Frame) and NOISE_WGSL.
export const TERRAIN_FUNCS = /* wgsl */ `
fn seedU() -> u32 { return u32(F.mist.w) * 2654435761u; }
fn seedGrad(i: vec2i) -> vec2f {
  let h = pcgHash(u32(i.x) * 1664525u + pcgHash(u32(i.y) + 1013904223u + seedU()));
  let a = f32(h) * (6.28318530718 / 4294967296.0);
  return vec2f(cos(a), sin(a));
}
fn seedHash2(i: vec2i) -> vec2f {
  let h = pcgHash(u32(i.x) * 2246822519u + pcgHash(u32(i.y) * 3266489917u + seedU()));
  let g = pcgHash(h);
  return vec2f(f32(h & 0xFFFFu), f32(g & 0xFFFFu)) * (1.0 / 65535.0);
}
// Gradient noise with its analytic derivative: (value, d/dx, d/dy), value in about [-0.7, 0.7].
fn gnoised(p: vec2f) -> vec3f {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let ga = seedGrad(i);
  let gb = seedGrad(i + vec2i(1, 0));
  let gc = seedGrad(i + vec2i(0, 1));
  let gd = seedGrad(i + vec2i(1, 1));
  let va = dot(ga, f);
  let vb = dot(gb, f - vec2f(1.0, 0.0));
  let vc = dot(gc, f - vec2f(0.0, 1.0));
  let vd = dot(gd, f - vec2f(1.0, 1.0));
  let k = va - vb - vc + vd;
  let v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
  let d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
        + du * (u.yx * k + vec2f(vb - va, vc - va));
  return vec3f(v, d);
}
fn snoise(p: vec2f) -> f32 { return gnoised(p).x; }
fn fbm2(p: vec2f, oct: i32) -> f32 {
  var s = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < oct; i++) {
    s += a * snoise(q);
    q = mat2x2f(0.8, -0.6, 0.6, 0.8) * q * 2.03 + vec2f(17.1, 3.7);
    a *= 0.5;
  }
  return s;
}

// ---- valley path --------------------------------------------------------------------
// The valley centre line is x = valleyX(z). The river meanders inside the valley floor and
// the flight follows the valley, so the camera code (scenes.js) mirrors these functions.
fn valleyX(z: f32) -> f32 {
  return F.pathA.x * sin(F.pathK.x * z + F.pathPh.x)
       + F.pathA.y * sin(F.pathK.y * z + F.pathPh.y)
       + F.pathA.z * sin(F.pathK.z * z + F.pathPh.z);
}
fn valleyDX(z: f32) -> f32 {
  return F.pathA.x * F.pathK.x * cos(F.pathK.x * z + F.pathPh.x)
       + F.pathA.y * F.pathK.y * cos(F.pathK.y * z + F.pathPh.y)
       + F.pathA.z * F.pathK.z * cos(F.pathK.z * z + F.pathPh.z);
}
fn riverX(z: f32) -> f32 {
  let k = F.pathK.w;
  return valleyX(z) + F.pathA.w * (sin(k * z + F.pathPh.w) + 0.35 * sin(2.3 * k * z + 1.7 + F.pathPh.w));
}
fn riverDX(z: f32) -> f32 {
  let k = F.pathK.w;
  return valleyDX(z) + F.pathA.w * k * (cos(k * z + F.pathPh.w) + 0.805 * cos(2.3 * k * z + 1.7 + F.pathPh.w));
}
// The flight runs towards -z, upstream, so the water climbs gently ahead of the camera.
fn waterLevel(z: f32) -> f32 { return F.water.x - F.water.y * z; }
// Signed distance across the river, and its local half-width.
fn riverOffset(xz: vec2f) -> f32 {
  let s = riverDX(xz.y);
  return (xz.x - riverX(xz.y)) * inverseSqrt(1.0 + s * s);
}
fn riverHalfWidth(z: f32) -> f32 {
  return F.valley.z * (1.0 + 0.28 * snoise(vec2f(z * 0.0021, 4.7)) + 0.12 * snoise(vec2f(z * 0.011, 9.1)));
}

// ---- eroded mountains ---------------------------------------------------------------
// Gully filter after Clay John's "Eroded Terrain Noise": overlapping cosine stripes aligned
// with the local downhill direction carve branching ravines into the base relief.
fn gullyCells(p: vec2f, dir: vec2f) -> vec3f {
  let ip = vec2i(floor(p));
  let fp = p - floor(p);
  var va = vec3f(0.0);
  var wt = 0.0;
  for (var j = -2; j <= 1; j++) {
    for (var i = -2; i <= 1; i++) {
      let o = vec2i(i, j);
      let h = seedHash2(ip - o) * 0.5;
      let pp = fp + vec2f(o) - h;
      let d = dot(pp, pp);
      let w = exp(-d * 2.0);
      wt += w;
      let mag = dot(pp, dir) * 6.28318530718;
      va += vec3f(cos(mag), -sin(mag) * dir) * w;
    }
  }
  return va / wt;
}

// Normalised mountain field, about 0 (valley bottoms) to 1 (summits). Octaves shorter
// than about two texels are faded out so every clipmap level is its own prefiltered copy.
fn mountainField(xz: vec2f, texel: f32) -> f32 {
  let S = F.relief.z;
  var p = xz / S;
  let warp = vec2f(snoise(p * 0.31 + vec2f(5.2, 1.3)), snoise(p * 0.31 + vec2f(1.7, 9.2)));
  p += warp * 0.7;
  // Low octaves keep their analytic gradient (no rotation) to steer the gullies downhill.
  var h = 0.0;
  var a = 0.5;
  var f = 1.0;
  var d = vec2f(0.0);
  var g = vec2f(0.0);
  let ridge = F.relief.y;
  var q = p;
  for (var i = 0; i < 11; i++) {
    let wl = S / f;
    let keep = smoothstep(2.0 * texel, 4.0 * texel, wl);
    if (keep <= 0.0) { break; }
    let n = gnoised(q);
    // ridged noise with a rounded crest: broad octaves get broad shoulders, not knife edges
    let kr = 0.16 * (1.3 - ridge) * pow(0.62, f32(i));
    let sa = sqrt(n.x * n.x + kr * kr);
    let v = mix(n.x, 0.42 + kr - sa, ridge);
    let dv = mix(n.yz, -(n.x / sa) * n.yz, ridge);
    d += dv;
    // derivative damping: steep parts of coarse octaves get less fine detail (IQ)
    let damp = 1.0 / (1.0 + dot(d, d) * 0.18);
    h += a * v * damp * keep;
    if (i < 3) { g += a * f * dv; }
    a *= 0.5;
    f *= 2.0;
    if (i < 2) { q = q * 2.0 + vec2f(1.3, 7.1); }
    else { q = mat2x2f(0.8, -0.6, 0.6, 0.8) * q * 2.0 + vec2f(3.1, 1.7); }
  }
  // valley bottoms flatten out, summits keep rising (no mesa tops)
  let x = max((h + 0.5) / 1.1, 0.0);
  var m = 1.25 * x * x / (x + 0.25);
  // gullies: strongest on mid and upper slopes, absent on the valley floors
  let gs = F.relief.w * smoothstep(0.12, 0.45, m);
  if (gs > 0.0) {
    let dir = vec2f(g.y, -g.x);
    var e = vec3f(0.0);
    var ga = 1.0;
    var gf = 3.0;
    for (var i = 0; i < 5; i++) {
      let wl = S / gf;
      let keep = smoothstep(2.0 * texel, 4.0 * texel, wl);
      if (keep <= 0.0) { break; }
      e += gullyCells(p * gf, dir + e.zy * vec2f(1.0, -1.0)) * ga * keep * vec3f(1.0, gf, gf);
      ga *= 0.4;
      gf *= 2.0;
    }
    m += e.x * 0.055 * gs;
  }
  return m;
}

// Signed metres from the coast path: positive is inland (+x, on the right as the
// flight runs toward -z), negative is open water.
fn coastOffset(xz: vec2f) -> f32 {
  let s = valleyDX(xz.y);
  return (xz.x - valleyX(xz.y)) * inverseSqrt(1.0 + s * s);
}

// Shoreline country. The coast path is the waterline. Coves run out as sand; headlands
// stand up as cliffs. Seaward of the line the bed drops through a shelf into open ocean,
// with a few stacks where a ridge fails to quite reach shore.
fn coastHeight(xz: vec2f, texel: f32, m: f32, wl: f32) -> f32 {
  let z = xz.y;
  let wig = snoise(vec2f(z * 0.00035, 3.1)) * 260.0
          + snoise(vec2f(z * 0.0013, 8.4)) * 70.0
          + snoise(vec2f(z * 0.006, 1.8)) * 16.0;
  let d = coastOffset(xz) + wig;
  let cliff = smoothstep(-0.12, 0.38, snoise(vec2f(z * 0.00028, 5.7)));
  var micro = 0.0;
  if (texel < 24.0) {
    micro = snoise(xz * (1.0 / 61.0) + vec2f(3.3, 8.1)) * 1.3;
    if (texel < 6.0) { micro += snoise(xz * (1.0 / 17.0) + vec2f(9.4, 2.2)) * 0.4; }
  }
  if (d < 0.0) {
    let depth = -d;
    let near = 1.0 - exp(-depth / 70.0);
    let shelf = smoothstep(180.0, 2800.0, depth);
    let abyss = smoothstep(1600.0, 12000.0, depth);
    var h = wl - 0.35 - near * 5.5 - shelf * 18.0 - abyss * 55.0;
    if (texel < 24.0 && depth < 500.0) {
      h += snoise(xz * 0.015 + vec2f(1.0, 4.0)) * 0.4 * (1.0 - shelf);
    }
    let stackN = smoothstep(0.58, 0.82, snoise(xz * (1.0 / 420.0) + vec2f(4.2, 1.1)) * 0.5 + 0.5);
    let stack = smoothstep(0.5, 0.84, m) * stackN * (0.3 + 0.7 * cliff) * (1.0 - smoothstep(40.0, 560.0, depth));
    let stackH = wl + 5.0 + max(m - 0.35, 0.0) * 80.0;
    return mix(h, stackH, stack);
  }
  let beachW = mix(max(F.valley.y, 30.0), 18.0, cliff);
  let bluff = mix(5.0, 34.0 + 100.0 * smoothstep(0.22, 0.78, m), cliff);
  let face = smoothstep(0.0, mix(beachW, 12.0, cliff), d);
  let terrace = mix(0.35, bluff, face);
  let reach = max(F.valley.x, beachW + 500.0);
  let rise = smoothstep(beachW * 0.55, reach, d);
  let peaks = max(m - 0.04, 0.0) * F.relief.x;
  var hLand = mix(terrace, max(terrace * 0.22, peaks), rise);
  if (cliff < 0.5 && texel < 48.0) {
    hLand += snoise(xz * (1.0 / 95.0) + vec2f(2.0, 6.0)) * 0.7 * (1.0 - rise) * smoothstep(1.2, 3.5, terrace);
  }
  return wl + hLand + micro * mix(0.2, 1.0, rise);
}

// Terrain height in metres.
fn terrainHeight(xz: vec2f, texel: f32) -> f32 {
  let m = mountainField(xz, texel);
  let z = xz.y;
  let wl = waterLevel(z);
  if (F.water.w > 0.5) { return coastHeight(xz, texel, m, wl); }
  var shape = 1.0;
  if (F.valley.x > 0.0) {
    let s = valleyDX(z);
    let ad = abs(xz.x - valleyX(z)) * inverseSqrt(1.0 + s * s);
    let wall = smoothstep(F.valley.y, F.valley.y + F.valley.x, ad);
    shape = wall * wall * (1.6 - 0.6 * wall);
  }
  // fine ground relief: hummocks, terraces and old channels on every floor
  var micro = 0.0;
  if (texel < 24.0) {
    micro = snoise(xz * (1.0 / 61.0) + vec2f(3.3, 8.1)) * 2.2;
    if (texel < 6.0) { micro += snoise(xz * (1.0 / 17.0) + vec2f(9.4, 2.2)) * 0.7; }
  }
  let base = (m - F.biome.z) * F.relief.x;
  var h = wl + F.valley.w + base + micro;
  if (F.valley.x > 0.0) {
    // The valley is a trough cut out of the full mountain field, so its walls keep every
    // ridge and gully; a smooth max holds the floor (with a gentle rise towards the walls).
    let cut = base - (1.0 - shape) * F.relief.x * 0.85;
    let floorRise = (1.0 - shape) * max(m - F.biome.z, 0.0) * 14.0;
    let a = cut - floorRise;
    h = wl + F.valley.w + floorRise + 0.5 * (a + sqrt(a * a + 900.0)) + micro;
  }
  // river channel
  if (F.valley.z > 0.0) {
    let rw = riverHalfWidth(z);
    let ar = abs(riverOffset(xz));
    let x = ar / rw;
    let bed = wl - 0.6 - 2.8 * max(1.0 - x * x, 0.0);
    // gravel bars come and go along each bank; elsewhere the wooded bank meets the water
    let side = select(0.0, 17.0, riverOffset(xz) > 0.0);
    let barK = smoothstep(0.05, 0.45, snoise(vec2f(z * (1.0 / 420.0), side + 2.3)));
    let bankH = wl + mix(2.8, 0.45, barK) + 1.8 * smoothstep(1.0, 3.2, x);
    h = mix(h, min(h, bankH), 1.0 - smoothstep(2.2, 5.5, x));
    h = mix(min(h, bed), h, smoothstep(0.8, 1.12, x));
  }
  return h;
}

// Pacific swell for the coast scene. Wavelengths and phase speed follow the ocean
// frame: a narrow groundswell near 120 m plus a wind sea, each traveling at sqrt(g/k)
// with chop on the crests. Heights sit toward the heavy end of that frame's swell so
// the sets still read from a few hundred metres up. dir points onshore (+x).
// minL drops trains the grid or the pixel cannot resolve. depth is metres of water.
struct Sea {
  height: f32,
  chop: vec2f,
  slope: vec2f,
  crest: f32,
  jac: vec3f,
};

fn seaContrib(xz: vec2f, t: f32, dir: vec2f, length: f32, amp: f32, steep: f32, phase0: f32, minL: f32, depth: f32, sea: ptr<function, Sea>) {
  let keep = smoothstep(max(minL, 0.25) * 1.35, max(minL, 0.25) * 3.4, length);
  if (keep < 0.001) { return; }
  let k = 6.28318530718 / length;
  let phase = k * dot(dir, xz) - sqrt(9.81 * k) * t + phase0;
  let s = sin(phase);
  let c = cos(phase);
  let d = max(depth, 0.25);
  // the swell feels the bottom inside half a wavelength, stands up, then dumps
  let feel = 1.0 - smoothstep(length * 0.05, length * 0.32, d);
  let grow = mix(1.0, 1.65, feel);
  let Hb = amp * grow;
  let breakK = smoothstep(max(Hb * 2.6, 1.8), max(Hb * 0.7, 0.45), d);
  let a = Hb * (1.0 - breakK * 0.82) * keep;
  (*sea).height += a * s;
  (*sea).slope += dir * (k * a * c);
  (*sea).chop += dir * (steep * a * c);
  let qk = steep * k * a;
  (*sea).jac -= vec3f(qk * dir.x * dir.x, qk * dir.y * dir.y, qk * dir.x * dir.y) * s;
  let face = pow(max(sin(phase - 0.35), 0.0), 5.0);
  (*sea).crest += breakK * face * keep;
}

fn seaState(xz: vec2f, t: f32, minL: f32, depth: f32, foam: bool) -> Sea {
  var sea: Sea;
  // Groundswell near the ocean frame's 120 m peak, plus a crossing set and a wind sea.
  // Wavelengths are not octaves, so the crests do not lock into a repeating lattice.
  seaContrib(xz, t, normalize(vec2f(0.985, 0.17)), 137.0, 1.05, 0.85, 0.40, minL, depth, &sea);
  seaContrib(xz, t, normalize(vec2f(0.93, 0.37)), 103.0, 0.48, 0.95, 1.20, minL, depth, &sea);
  seaContrib(xz, t, normalize(vec2f(0.96, -0.28)), 79.0, 0.32, 1.0, 2.50, minL, depth, &sea);
  seaContrib(xz, t, normalize(vec2f(0.62, 0.78)), 168.0, 0.36, 0.70, 0.90, minL, depth, &sea);
  seaContrib(xz, t, normalize(vec2f(0.88, 0.47)), 54.0, 0.16, 1.1, 1.80, minL, depth, &sea);
  seaContrib(xz, t, normalize(vec2f(0.99, 0.08)), 33.0, 0.08, 1.15, 2.20, minL, depth, &sea);
  seaContrib(xz, t, normalize(vec2f(0.75, -0.66)), 19.0, 0.035, 1.15, 0.30, minL, depth, &sea);
  if (foam) {
    let broken = sea.crest;
    let jxx = 1.0 + sea.jac.x;
    let jzz = 1.0 + sea.jac.y;
    let J = jxx * jzz - sea.jac.z * sea.jac.z;
    // whitecaps only where several crests stack and a gust is overhead
    let pinch = clamp((0.90 - J) * 8.0, 0.0, 1.0);
    let gust = smoothstep(0.58, 0.84, snoise(xz * 0.0018 + vec2f(t * 0.003, 2.2)) * 0.5 + 0.5);
    sea.crest = max(broken, pinch * pinch * gust);
    // surf stays in the last few metres of water and travels with the groundswell
    let dir0 = normalize(vec2f(0.985, 0.17));
    let k0 = 6.28318530718 / 137.0;
    let face0 = pow(max(sin(k0 * dot(dir0, xz) - sqrt(9.81 * k0) * t), 0.0), 3.0);
    let along = snoise(vec2f(dot(xz, vec2f(-dir0.y, dir0.x)) * 0.008, 4.2));
    let wash = smoothstep(3.4, 0.35, depth) * smoothstep(0.15, 0.7, along * 0.5 + 0.5);
    sea.crest = max(sea.crest, wash * (0.3 + 0.7 * face0));
  }
  sea.crest = clamp(sea.crest, 0.0, 1.0);
  return sea;
}
`;

// One clipmap level, height only. B.xy is the world position of texel (0, 0).
const BAKE_UNIFORM = /* wgsl */ `
struct Bake { origin: vec2f, texel: f32, level: f32 };
@group(0) @binding(1) var<uniform> B: Bake;
`;

export const CLIP_HEIGHT = FRAME_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
` + BAKE_UNIFORM + /* wgsl */ `
@group(0) @binding(2) var dst: texture_storage_2d_array<r32float, write>;
` + NOISE_WGSL + TERRAIN_FUNCS + /* wgsl */ `
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${CLIP_RES}u || id.y >= ${CLIP_RES}u) { return; }
  let xz = B.origin + vec2f(id.xy) * B.texel;
  textureStore(dst, id.xy, u32(B.level), vec4f(terrainHeight(xz, B.texel), 0.0, 0.0, 0.0));
}
`;

// Gradient, curvature and the land-cover masks for one level.
//   A = (height, dh/dx, dh/dz, curvature)
//   B = (tree density, conifer share, rock exposure, snow)
export const CLIP_DERIVE = FRAME_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
` + BAKE_UNIFORM + /* wgsl */ `
@group(0) @binding(2) var src: texture_2d_array<f32>;
@group(0) @binding(3) var dstA: texture_storage_2d_array<rgba32float, write>;
@group(0) @binding(4) var dstB: texture_storage_2d_array<rgba16float, write>;
` + NOISE_WGSL + TERRAIN_FUNCS + /* wgsl */ `
fn hAt(c: vec2i) -> f32 {
  let q = clamp(c, vec2i(0), vec2i(${CLIP_RES - 1}));
  return textureLoad(src, q, i32(B.level), 0).r;
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${CLIP_RES}u || id.y >= ${CLIP_RES}u) { return; }
  let c = vec2i(id.xy);
  let h = hAt(c);
  let hl = hAt(c - vec2i(1, 0));
  let hr = hAt(c + vec2i(1, 0));
  let hd = hAt(c - vec2i(0, 1));
  let hu = hAt(c + vec2i(0, 1));
  let tx = B.texel;
  // one-sided at the border, so the edge texels keep a sensible slope
  let ex = select(2.0, 1.0, c.x == 0 || c.x == ${CLIP_RES - 1});
  let ez = select(2.0, 1.0, c.y == 0 || c.y == ${CLIP_RES - 1});
  let grad = vec2f((hr - hl) / (ex * tx), (hu - hd) / (ez * tx));
  // curvature over at least 8 m, so it describes landforms rather than texel noise
  let k = max(1, i32(ceil(8.0 / tx)));
  let lap = (hAt(c - vec2i(k, 0)) + hAt(c + vec2i(k, 0)) + hAt(c - vec2i(0, k)) + hAt(c + vec2i(0, k)) - 4.0 * h)
          / (f32(k * k) * tx * tx);

  let xz = B.origin + vec2f(id.xy) * tx;
  let wl = waterLevel(xz.y);
  let above = h - wl;
  let slope = length(grad);

  // stands, glades and clearings
  let stand = fbm2(xz * (1.0 / 420.0) + vec2f(7.0, 2.0), 3) * 0.5 + 0.5;
  let patchy = fbm2(xz * (1.0 / 95.0) + vec2f(1.0, 11.0), 2);
  let clear = F.forest2.w;
  let open = smoothstep(clear - 0.08, clear + 0.08, stand + patchy * 0.18);
  let lineNoise = fbm2(xz * (1.0 / 160.0) + vec2f(4.0, 6.0), 3);
  let treeline = F.forest2.y + lineNoise * 90.0;
  let alpine = 1.0 - smoothstep(treeline - 160.0, treeline + 30.0, above);
  // forest clings to slopes up to about 50 degrees; ledges break up steeper walls
  let steep = 1.0 - smoothstep(1.15, 1.8, slope + patchy * 0.4);
  var shore = smoothstep(0.15, 1.0, above + patchy * 0.6);
  if (F.water.w > 0.5) {
    // open sand and scrub along the beach; the stand closes up the slope
    shore = smoothstep(3.5, 22.0, above + patchy * 3.0);
  }
  // open bog and fen on the flats just above the water
  let bog = F.biome.y * (1.0 - smoothstep(0.5, 6.0, above)) * smoothstep(-0.1, 0.25, fbm2(xz * (1.0 / 140.0), 2));
  // clearings are never bare: scattered regrowth and saplings
  let regrow = mix(0.18, 1.0, open);
  var dens = F.forest.x * regrow * alpine * steep * shore * (1.0 - 0.85 * bog);
  // stunted, thinning trees near the treeline
  dens *= mix(1.0, 0.35, smoothstep(treeline - 260.0, treeline - 60.0, above));

  let conif = clamp(F.forest.w + (above / max(F.forest2.y, 1.0)) * 0.3 + lineNoise * 0.3 + patchy * 0.18, 0.0, 1.0);

  // rock on steep and convex ground, and everywhere well above the treeline
  let rockN = fbm2(xz * (1.0 / 55.0) + vec2f(2.0, 5.0), 3);
  var rock = smoothstep(1.2, 1.85, slope + rockN * 0.35 - lap * 1.5);
  // above the treeline: alpine meadow on the gentler ground, rock and scree on the rest
  rock = max(rock, (1.0 - alpine) * smoothstep(-0.2, 0.3, rockN + slope * 0.7 - 0.42));
  rock *= F.biome.x;

  let snowN = fbm2(xz * (1.0 / 130.0) + vec2f(8.0, 3.0), 3);
  var snow = smoothstep(F.forest2.z - 40.0, F.forest2.z + 90.0, above + snowN * 140.0 + lap * 400.0);
  // snow slides off steep faces, leaving dark rock ribs between the snowfields
  snow *= 1.0 - smoothstep(0.55, 0.95, slope + snowN * 0.25);

  textureStore(dstA, id.xy, u32(B.level), vec4f(h, grad, lap));
  textureStore(dstB, id.xy, u32(B.level), vec4f(clamp(dens, 0.0, 1.0), conif, clamp(rock, 0.0, 1.0), clamp(snow, 0.0, 1.0)));
}
`;

// Terrain heights at the points the flight controller asks about (async readback).
export const HEIGHT_PROBE = FRAME_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
struct Probe { p: array<vec4f, ${PROBE_N}> };
@group(0) @binding(1) var<uniform> Q: Probe;
@group(0) @binding(2) var<storage, read_write> outH: array<f32, ${PROBE_N}>;
` + NOISE_WGSL + TERRAIN_FUNCS + /* wgsl */ `
@compute @workgroup_size(${PROBE_N})
fn main(@builtin(local_invocation_index) k: u32) {
  let xz = Q.p[k].xy;
  outH[k] = max(terrainHeight(xz, 4.0), waterLevel(xz.y));
}
`;
