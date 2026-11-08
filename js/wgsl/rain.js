// Rain, snow, and lightning for an aerial camera.
// The ocean frame stamps ripples into the sea. Here the aircraft is inside the
// weather, so drops fill a column around the camera, a screen veil covers the
// valley, and lightning lights the sky and the land. The uniform block matches
// the Float32Array written in main.js.
import { FRAME_WGSL } from './common.js';

export const MAX_DROPS = 8192;

export const RAIN_STRUCT = /* wgsl */ `
struct RainU {
  cam: vec4f,     // xyz metres, w = time (s)
  wind: vec4f,    // xy direction, z speed (m/s), w intensity
  amt: vec4f,     // wetness, snow (0 or 1), lightning flash, style (0 rain, 1 storm, 2 snow)
  bolt: vec4f,    // xy direction, z seed, w enabled
  sim: vec4f,     // -, dt, active drops, slant
  pad0: vec4f,
  atmo: vec4f,    // extra fog, sun scale, sky darken, gust
  dropP: vec4f,   // fall speed, box radius, column depth, -
};
`;

export const RAIN_FUNCS = /* wgsl */ `
fn rainBolt(dir: vec3f) -> vec3f {
  if (Rain.bolt.w < 0.5 || Rain.amt.z < 0.015) { return vec3f(0.0); }
  let horiz = normalize(dir.xz + vec2f(1e-5, 0.0));
  let aim = normalize(Rain.bolt.xy + vec2f(1e-5, 0.0));
  let ang = acos(clamp(dot(horiz, aim), -1.0, 1.0));
  let yq = floor(dir.y * 46.0 + Rain.bolt.z);
  let jag = (fract(sin(yq * 91.73) * 43758.5453) - 0.5) * 0.10;
  let above = smoothstep(-0.08, 0.02, dir.y) * smoothstep(0.94, 0.22, dir.y);
  let d = abs(ang - jag);
  let core = exp(-d * d / 0.00028) * above;
  let glow = exp(-d * d / 0.009) * above;
  let branch = exp(-abs(ang - jag - 0.11) * 26.0) * smoothstep(0.02, 0.16, dir.y) * smoothstep(0.62, 0.18, dir.y);
  return vec3f(0.75, 0.84, 1.0) * (core * 22.0 + glow * 1.15 + branch * 3.2) * Rain.amt.z;
}

fn applyRainSky(dir: vec3f, L: vec3f) -> vec3f {
  let storm = select(0.0, 1.0, Rain.amt.w > 0.5 && Rain.amt.w < 1.5);
  var o = L * mix(1.0, Rain.atmo.z, 0.85) * mix(1.0, Rain.atmo.y, 0.8);
  o += rainBolt(dir);
  o += vec3f(0.55, 0.68, 1.0) * Rain.amt.z * (0.34 + 0.16 * storm);
  return o;
}
`;

export const RAIN_DROP_INIT = RAIN_STRUCT + /* wgsl */ `
struct Drop { pos: vec4f, vel: vec4f }
@group(0) @binding(0) var<uniform> Rain: RainU;
@group(0) @binding(1) var<storage, read_write> drops: array<Drop>;

fn h01(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${MAX_DROPS}u) { return; }
  let a = h01(id.x * 17u + 3u);
  let b = h01(id.x * 29u + 11u);
  let c = h01(id.x * 47u + 19u);
  let ang = a * 6.2831853;
  let rad = sqrt(b) * Rain.dropP.y;
  let y = Rain.cam.y + Rain.dropP.z * (0.28 - c);
  let pos = vec3f(Rain.cam.x + cos(ang) * rad, y, Rain.cam.z + sin(ang) * rad);
  let gust = 0.85 + 0.15 * a;
  let horiz = Rain.wind.xy * Rain.wind.z * Rain.sim.w * gust;
  drops[id.x].pos = vec4f(pos, a);
  drops[id.x].vel = vec4f(horiz.x, -Rain.dropP.x, horiz.y, 2.0);
}
`;

export const RAIN_DROP_UPDATE = RAIN_STRUCT + FRAME_WGSL + /* wgsl */ `
struct Drop { pos: vec4f, vel: vec4f }
@group(0) @binding(0) var<uniform> Rain: RainU;
@group(0) @binding(1) var<uniform> F: Frame;
@group(0) @binding(2) var<storage, read_write> drops: array<Drop>;

fn h01(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

fn respawn(id: u32, seed: f32) -> vec4f {
  let n = h01(f32(id) * 0.17 + Rain.cam.w * 1.7 + seed * 9.1);
  let m = h01(f32(id) * 0.93 + seed * 4.2 + 2.3);
  let k = h01(f32(id) * 1.7 + Rain.cam.w * 0.37 + 5.5);
  let ang = n * 6.2831853;
  let rad = sqrt(m) * Rain.dropP.y;
  let xz = F.camPos.xz + vec2f(cos(ang), sin(ang)) * rad;
  let y = F.camPos.y + Rain.dropP.z * (0.28 - k);
  return vec4f(xz.x, y, xz.y, seed);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let live = u32(Rain.sim.z);
  if (id.x >= live) { return; }
  var d = drops[id.x];
  let snow = Rain.amt.y > 0.5;
  let gust = 0.78 + 0.22 * sin(Rain.cam.w * (0.7 + Rain.atmo.w) + d.pos.w * 6.2831853);
  let drift = select(0.0, sin(Rain.cam.w * 1.15 + d.pos.w * 6.2831853) * 0.9, snow);
  let horiz = Rain.wind.xy * Rain.wind.z * Rain.sim.w * gust + vec2f(drift, drift * 0.35);
  let fall = Rain.dropP.x * (0.82 + 0.36 * d.pos.w);
  d.vel = vec4f(horiz.x, -fall, horiz.y, 2.0);
  let dt = min(Rain.sim.y, 0.05);
  d.pos = vec4f(d.pos.xyz + d.vel.xyz * dt, d.pos.w);
  let away = length(d.pos.xz - F.camPos.xz);
  let below = F.camPos.y - d.pos.y;
  let above = d.pos.y - F.camPos.y;
  if (away > Rain.dropP.y * 1.25 || below > Rain.dropP.z * 1.05 || above > Rain.dropP.z * 0.45) {
    d.pos = respawn(id.x, d.pos.w);
    d.vel = vec4f(horiz.x, -Rain.dropP.x, horiz.y, 2.0);
  }
  drops[id.x] = d;
}
`;

const RAIN_VS = /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VO;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}
`;

export const RAIN_DRAW = RAIN_STRUCT + FRAME_WGSL + /* wgsl */ `
struct Drop { pos: vec4f, vel: vec4f }
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) across: f32,
  @location(1) along: f32,
  @location(2) flake: f32,
  @location(3) fade: f32,
}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> Rain: RainU;
@group(0) @binding(2) var<storage, read> drops: array<Drop>;

fn corner(i: u32) -> vec2f {
  switch i {
    case 0u: { return vec2f(-1.0, -1.0); }
    case 1u: { return vec2f(1.0, -1.0); }
    case 2u: { return vec2f(1.0, 1.0); }
    case 3u: { return vec2f(-1.0, -1.0); }
    case 4u: { return vec2f(1.0, 1.0); }
    default: { return vec2f(-1.0, 1.0); }
  }
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let drop = vi / 6u;
  let q = corner(vi % 6u);
  let d = drops[drop];
  let snow = Rain.amt.y > 0.5;
  var dir = d.vel.xyz;
  let speed = length(dir);
  dir = select(vec3f(0.0, -1.0, 0.0), dir / max(speed, 0.001), speed > 0.05);
  let toCam = F.camPos.xyz - d.pos.xyz;
  let dist = max(length(toCam), 0.2);
  var side = cross(dir, toCam / dist);
  let sl = length(side);
  side = select(normalize(cross(dir, vec3f(0.0, 0.0, 1.0))), side / max(sl, 1e-4), sl > 1e-3);
  let pixel = dist * 2.0 * length(F.camUp.xyz) * max(F.screen.w, 1e-6);
  var len = (0.45 + speed * 0.04) * select(1.0, 0.18, snow);
  var width = (0.010 + d.pos.w * 0.008) * select(1.0, 2.6, snow);
  len = max(len, pixel * select(7.0, 2.4, snow));
  width = max(width, pixel * select(0.65, 2.2, snow));
  let world = d.pos.xyz + dir * q.y * len + side * q.x * width;
  var o: VO;
  o.pos = F.viewProj * vec4f(world - F.camPos.xyz, 1.0);
  o.across = q.x;
  o.along = q.y;
  o.flake = select(0.0, 1.0, snow);
  let box = length(d.pos.xz - Rain.cam.xz) / max(Rain.dropP.y, 1.0);
  let below = (Rain.cam.y - d.pos.y) / max(Rain.dropP.z, 1.0);
  let above = (d.pos.y - Rain.cam.y) / max(Rain.dropP.z * 0.45, 1.0);
  let edge = smoothstep(1.15, 0.4, max(box, max(below, above)));
  o.fade = edge * smoothstep(0.3, 1.8, dist) * Rain.wind.w;
  return o;
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let streak = smoothstep(1.0, 0.15, abs(in.across))
    * smoothstep(-1.0, -0.35, in.along) * smoothstep(1.0, 0.2, in.along);
  let disc = smoothstep(1.05, 0.15, length(vec2f(in.across, in.along)));
  let body = mix(streak, disc, in.flake);
  let a = body * in.fade * mix(0.62, 0.8, in.flake);
  let rgb = mix(vec3f(0.62, 0.7, 0.78), vec3f(0.9, 0.93, 0.97), in.flake) * a;
  return vec4f(rgb, a);
}
`;

export const RAIN_MIST = RAIN_STRUCT + FRAME_WGSL + RAIN_VS + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> Rain: RainU;

fn hash21(p: vec2f) -> f32 {
  let q = fract(p * vec2f(123.34, 345.45));
  let r = q + dot(q, q.yx + 34.345);
  return fract(r.x * r.y);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x),
    u.y);
}

fn streaks(uv: vec2f, cols: f32, rows: f32, speed: f32, sx: f32, keep: f32, phase: f32, round: f32) -> f32 {
  let dir = normalize(vec2f(sx * Rain.sim.w, -1.0));
  let tangent = vec2f(dir.y, -dir.x);
  var p = vec2f(dot(uv, tangent) * cols, dot(uv, dir) * rows - phase);
  p.y -= Rain.cam.w * speed;
  let id = floor(p);
  let f = fract(p);
  let n = hash21(id);
  let m = hash21(id.yx + vec2f(4.2, 8.7));
  let alive = smoothstep(keep, keep + 0.08, n);
  let halfW = mix(0.008 + m * 0.018, 0.04 + m * 0.05, round);
  let line = smoothstep(halfW, 0.0, abs(f.x - mix(0.18, 0.82, m)));
  let len = mix(0.72 + m * 0.22, 0.16 + m * 0.12, round);
  let y0 = (1.0 - len) * fract(n * 7.13);
  let along = smoothstep(y0, y0 + 0.08, f.y) * (1.0 - smoothstep(y0 + len - 0.12, y0 + len, f.y));
  return line * along * alive * (0.35 + m * 0.65);
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let intensity = Rain.wind.w;
  if (intensity < 0.004) { return vec4f(0.0); }
  let snow = Rain.amt.y > 0.5;
  let ray = normalize(F.camFwd.xyz + in.ndc.x * F.camRight.xyz + in.ndc.y * F.camUp.xyz);
  let up = ray.y;
  // The flight looks down the valley, so the veil covers that view and only
  // thins when the camera is aimed up into the cloud deck.
  let cover = mix(1.0, 0.4, smoothstep(0.42, 0.9, up));
  let veilMask = exp(-up * up * 5.0);
  let right = normalize(F.camRight.xyz);
  let wind = vec3f(Rain.wind.x, 0.0, Rain.wind.y);
  let sx = dot(wind, right);
  let uv = in.ndc * vec2f(F.screen.x * F.screen.w, 1.0);
  let round = select(0.0, 1.0, snow);
  let keep = mix(select(0.62, 0.48, snow), select(0.36, 0.22, snow), intensity);
  let speed = select(0.85 + intensity, 0.22 + intensity * 0.15, snow);
  let a = streaks(uv, select(120.0, 70.0, snow), select(16.0, 9.0, snow), speed, sx, keep, 0.0, round);
  let b = streaks(uv + vec2f(2.7, 1.1), select(200.0, 110.0, snow), select(24.0, 13.0, snow), speed * 1.35, sx * 0.8, keep + 0.04, 9.0, round);
  let threads = (a * 0.55 + b * 0.45) * cover;
  let dir = normalize(vec2f(sx * Rain.sim.w, -1.0));
  let along = dot(uv, dir);
  let across = dot(uv, vec2f(dir.y, -dir.x));
  let drift = vec2f(across * 3.2, along * 1.2 - Rain.cam.w * select(0.4 + intensity * 0.35, 0.12, snow));
  let haze = noise(drift) * 0.65 + noise(drift * 2.2 + 4.0) * 0.35;
  let veil = veilMask * (0.4 + 0.6 * haze) * select(1.0, 0.55, snow);
  let alpha = clamp((threads * select(0.32, 0.42, snow) + veil * 0.16) * intensity, 0.0, select(0.34, 0.28, snow));
  let rgb = mix(vec3f(0.62, 0.7, 0.78), vec3f(0.92, 0.94, 0.97), round) * alpha;
  return vec4f(rgb, alpha);
}
`;
