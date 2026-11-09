// Shared constants and WGSL snippets.
export const SKY_W = 256;      // sky-view LUT size
export const SKY_H = 144;
export const AP_RES = 32;      // aerial-perspective froxel volume (x, y, depth slices)
export const AP_MAX_KM = 96;   // distance covered by the last depth slice
export const CLIP_RES = 512;   // terrain clipmap texels per side and level
export const CLIP_LEVELS = 9;  // texel doubles per level: 2 m ... 512 m
export const CLIP_TEXEL0 = 2;  // finest clipmap texel (m)
export const PROBE_N = 32;     // terrain height probes for the flight controller
// Trees are real instanced crowns out to TREE_RANGE. The near list uses the full cone,
// the far list a cheaper one. Past the range the ground carries the stand colour.
export const TREE_RANGE = 6000;
export const TREE_NEAR_DIST = 1800;
export const TREE_MAX = 900000;
export const TREE_NEAR_MAX = 160000;

// Per-frame uniform block shared by every render / sky / terrain shader.
// Layout must match the Float32Array offsets in main.js (writeFrame).
export const FRAME_WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,   // camera-relative view-projection (reverse-Z, infinite)
  camPos:   vec4f,     // xyz metres, w = time (s)
  camRight: vec4f,     // xyz * tan(fovX/2)
  camUp:    vec4f,     // xyz * tan(fovY/2)
  camFwd:   vec4f,     // xyz
  sunDir:   vec4f,     // xyz towards sun, w = solar illuminance scale
  screen:   vec4f,     // w, h, 1/w, 1/h
  lodP:     vec4f,     // CDLOD base range, grid quads per node, -, -
  post:     vec4f,     // exposure, bloom strength, frame index, debug view
  atmo:     vec4f,     // haze (mie multiplier), camera altitude km, high cloud cover, -
  cloudP:   vec4f,     // low altitude km, coverage, edge softness, cloud shadow strength
  moonDir:  vec4f,     // xyz towards moon, w = moon brightness
  moonLight: vec4f,    // xyz from moon towards sun, w = moon angular-radius multiplier
  nightP:   vec4f,     // star density, brightness, twinkle, night-sky brightness
  moonUp:   vec4f,     // xyz towards the celestial north pole (orients the lunar face)
  cloudWind: vec4f,    // low scroll fraction xz (km, 0-1), -, shape-evolution generations
  cloudHigh: vec4f,    // high scroll fraction xz (km, 0-1), -, horizontal scale
  cloudShape: vec4f,   // low scale, high altitude km, edge softness, -
  cloudLight: vec4f,   // low/high optical density, silver lining, ambient light
  starX: vec4f,        // J2000 equatorial x axis in world space
  starY: vec4f,        // J2000 equatorial y axis in world space
  cloudKm: vec4i,      // integer km of the scroll: low x, low z, high x, high z
  relief:  vec4f,      // relief (m), ridge sharpness, feature scale (m), gully strength
  valley:  vec4f,      // valley half-width (m), floodplain half-width (m), river half-width (m), floor height above water (m)
  pathA:   vec4f,      // valley path amplitudes (m) x3, river meander amplitude (m)
  pathK:   vec4f,      // valley path wavenumbers (rad/m) x3, meander wavenumber
  pathPh:  vec4f,      // phases
  forest:  vec4f,      // tree density, tree spacing (m), tree height (m), conifer share
  forest2: vec4f,      // autumn colour, treeline (m above water), snowline (m above water), clearings
  biome:   vec4f,      // rock exposure, wetland, basin depth (lakes), broadleaf style (0 temperate, 1 tropical)
  mist:    vec4f,      // valley mist density, mist top (m above water), -, terrain seed
  water:   vec4f,      // water level at z = 0 (m), downstream slope, water tint (0 clear, 1 tannin), coast (0 inland, 1 shoreline)
};
`;

export const ATMO_CORE_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265358979;
const RG: f32 = 6360.0;
const RT: f32 = 6460.0;
const RAY_S: vec3f = vec3f(5.802e-3, 13.558e-3, 33.1e-3);
const MIE_S: f32 = 3.996e-3;
const MIE_E: f32 = 4.40e-3;
const OZO_A: vec3f = vec3f(0.650e-3, 1.881e-3, 0.085e-3);
const SUN_ANG_R: f32 = 0.004675;
const TRANS_W: f32 = 256.0;
const TRANS_H: f32 = 64.0;
const MS_SIZE: f32 = 32.0;

struct Medium { ext: vec3f, rayS: vec3f, mieS: f32 };

fn medium(h: f32, haze: f32) -> Medium {
  let hh = max(h, 0.0);
  let dR = exp(-hh / 8.0);
  // aerosols: a continental boundary layer about 1.2 km deep
  let dM = exp(-hh / 1.2);
  let dO = max(0.0, 1.0 - abs(hh - 25.0) / 15.0);
  var m: Medium;
  m.rayS = RAY_S * dR;
  m.mieS = MIE_S * dM * haze;
  m.ext = m.rayS + vec3f(MIE_E * dM * haze) + OZO_A * dO;
  return m;
}

fn raySphere(ro: vec3f, rd: vec3f, R: f32) -> vec2f {
  let l = length(ro);
  let b = dot(ro, rd);
  let c = (l - R) * (l + R);
  let d = b * b - c;
  if (d < 0.0) { return vec2f(-1.0, -1.0); }
  let s = sqrt(d);
  return vec2f(-b - s, -b + s);
}

fn rhoOf(r: f32) -> f32 { return sqrt(max(0.0, (r - RG) * (r + RG))); }

fn transRMuToUV(r: f32, mu: f32) -> vec2f {
  let H = sqrt(RT * RT - RG * RG);
  let rho = rhoOf(r);
  let disc = r * r * (mu * mu - 1.0) + RT * RT;
  let d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  let dMin = RT - r;
  let dMax = rho + H;
  let x = (d - dMin) / (dMax - dMin);
  let y = rho / H;
  return vec2f(x, y);
}

fn transUVToRMu(uv: vec2f) -> vec2f {
  let H = sqrt(RT * RT - RG * RG);
  let rho = H * uv.y;
  let r = sqrt(rho * rho + RG * RG);
  let dMin = RT - r;
  let dMax = rho + H;
  let d = dMin + uv.x * (dMax - dMin);
  var mu = 1.0;
  if (d > 0.0) { mu = (H * H - rho * rho - d * d) / (2.0 * r * d); }
  return vec2f(r, clamp(mu, -1.0, 1.0));
}

fn fromUnitToSubUvs(u: f32, res: f32) -> f32 { return (u + 0.5 / res) * (res / (res + 1.0)); }
fn fromSubUvsToUnit(u: f32, res: f32) -> f32 { return (u - 0.5 / res) * (res / (res - 1.0)); }

fn phaseRayleigh(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
fn phaseMie(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
fn phaseHG(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// true when the sun is below the geometric horizon of a point at radius r
fn sunBelowHorizon(r: f32, mu: f32) -> bool {
  return mu < -rhoOf(r) / r;
}
`;

// Hashing helpers used by the procedural generators.
export const NOISE_WGSL = /* wgsl */ `
fn pcgHash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hashGrad(i: vec2i) -> vec2f {
  let h = pcgHash(u32(i.x) * 1664525u + pcgHash(u32(i.y) + 1013904223u));
  let a = f32(h) * (6.28318530718 / 4294967296.0);
  return vec2f(cos(a), sin(a));
}
fn gnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(hashGrad(i), f);
  let b = dot(hashGrad(i + vec2i(1, 0)), f - vec2f(1.0, 0.0));
  let c = dot(hashGrad(i + vec2i(0, 1)), f - vec2f(0.0, 1.0));
  let d = dot(hashGrad(i + vec2i(1, 1)), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;
