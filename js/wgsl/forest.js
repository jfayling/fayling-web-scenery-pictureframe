// Individual trees. Every cell of a jittered grid (spacing F.forest.y) may hold one tree;
// whether it does, its species and its size come from the land-cover masks at the trunk and
// a per-cell hash, so the vertex and fragment stages always agree on the same tree.
// Conifers are cones, broadleaf crowns are domes (flatter umbrellas in the tropics). The
// canopy surface is the highest crown over a point; its gradient is analytic.
// Requires TERRAIN_FUNCS and the clipmap lookups (clipSampleWGSL).
export const FOREST_FUNCS = /* wgsl */ `
struct Tree {
  pos: vec2f,
  top: f32,      // crown apex above the ground (m)
  base: f32,     // lowest visible crown edge (m)
  r: f32,        // crown radius (m)
  conifer: bool,
  ok: bool,
  tint: f32,     // per-tree brightness variation, 0..1
  hue: f32,      // per-tree colour pick, 0..1
  seed: f32,     // decorrelates the crown texture of neighbouring trees
};

fn unit16(h: u32) -> f32 { return f32(h & 0xFFFFu) * (1.0 / 65535.0); }

// Land-cover masks at a trunk: one level, chosen from the trunk position only.
fn treeMasks(pos: vec2f) -> vec2f {
  let L = min(i32(ceil(clipFinest(pos) - 0.001)), CLIP_L - 1);
  return clipB1(pos, L).xy;
}

fn treeCell(cell: vec2i, sampleMasks: bool, dens0: f32, conif0: f32) -> Tree {
  let sp = F.forest.y;
  let h0 = pcgHash((u32(cell.x) * 73856093u) ^ (u32(cell.y) * 19349663u + seedU() + 0x5bd1e995u));
  let h1 = pcgHash(h0 ^ 0x68e31da4u);
  let h2 = pcgHash(h1 ^ 0xb5297a4du);
  var t: Tree;
  t.pos = (vec2f(cell) + 0.5 + (vec2f(unit16(h0), unit16(h0 >> 16u)) - 0.5) * 0.8) * sp;
  var m = vec2f(dens0, conif0);
  if (sampleMasks) { m = treeMasks(t.pos); }
  t.ok = unit16(h1) < m.x;
  t.conifer = unit16(h1 >> 16u) < m.y;
  let trop = F.biome.w;
  // sparse stands are younger and shorter; a few emergents tower over a tropical canopy
  var sz = (0.7 + 0.6 * unit16(h2)) * mix(0.55, 1.0, smoothstep(0.0, 0.55, m.x));
  sz *= 1.0 + trop * 0.55 * step(0.93, unit16(h2 >> 16u));
  t.top = F.forest.z * sz * select(1.0, 1.1, t.conifer);
  // broadleaf crowns about as wide as the spacing, so neighbours close into one canopy;
  // the 3x3 cell search holds radii up to 1.1 spacings
  t.r = sp * select(min(mix(0.95, 1.0, trop) * pow(sz, 0.6), 1.08), 0.52 * pow(sz, 0.65), t.conifer);
  // broadleaf domes taper down to the understory, so a closed stand has no crown walls
  t.base = select(min(understoryH(m.x), t.top * 0.7), t.top * 0.2, t.conifer);
  let h3 = pcgHash(h2 ^ 0x1b873593u);
  t.tint = unit16(h3);
  t.hue = unit16(h3 >> 16u);
  t.seed = f32(h0 & 1023u);
  if (F.mist.z > 0.5) {
    // juniper: a low rounded shrub, not a spruce cone
    t.conifer = false;
    let szj = sz * 0.72;
    t.top = F.forest.z * szj;
    t.r = min(sp * 0.46 * sqrt(szj), sp * 0.55);
    t.base = t.top * 0.22;
  }
  return t;
}

// (height above ground, d/dx, d/dz) of one crown at p, or height -1 outside it.
fn crownAt(t: Tree, p: vec2f) -> vec3f {
  let dv = p - t.pos;
  let d2 = dot(dv, dv);
  if (d2 >= t.r * t.r) { return vec3f(-1.0, 0.0, 0.0); }
  let d = max(sqrt(d2), 1e-3);
  let x = d / t.r;
  let span = t.top - t.base;
  var y: f32;
  var dydd: f32;
  if (t.conifer) {
    // slightly convex cone: a spruce or fir seen from above
    let px = pow(x, 0.85);
    y = t.top - span * px;
    dydd = -span * 0.85 * px / (x * t.r);
  } else {
    // paraboloid: a rounded top with sides that meet the neighbours at a gentle angle
    y = t.base + span * (1.0 - x * x);
    dydd = -span * 2.0 * x / t.r;
  }
  return vec3f(y, dv / d * dydd);
}

struct Canopy { y: f32, g: vec2f, x: f32, hit: bool, tree: Tree };

// Lower branches, saplings and shrubs that fill the gaps between crowns in a closed stand.
fn understoryH(dens: f32) -> f32 {
  return F.forest.z * 0.58 * smoothstep(0.35, 0.85, dens);
}

// Highest crown over p among the 3x3 neighbouring cells.
fn canopyAt(p: vec2f, sampleMasks: bool, dens0: f32, conif0: f32) -> Canopy {
  let sp = F.forest.y;
  let c0 = vec2i(floor(p / sp));
  var best: Canopy;
  best.y = 0.0;
  best.hit = false;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let t = treeCell(c0 + vec2i(i, j), sampleMasks, dens0, conif0);
      if (!t.ok) { continue; }
      let c = crownAt(t, p);
      if (c.x > best.y) {
        best.y = c.x;
        best.g = c.yz;
        best.x = length(p - t.pos) / t.r;
        best.hit = true;
        best.tree = t;
      }
    }
  }
  return best;
}

// Fraction of sunlight reaching a point y0 metres above the ground at p.
// A closed stand shades its floor and its lower crowns from density. Marching the
// neighbouring crowns as well reran the tree field several times per pixel, which
// was most of the remaining landscape cost, and from the air those shadows are
// smaller than the crown shading already drawn here.
fn canopyShadow(y0: f32, L: vec3f, dens: f32) -> f32 {
  if (dens < 0.004) { return 1.0; }
  let top = max(F.forest.z, 1.0);
  let sunk = smoothstep(-0.02, 0.35, L.y);
  let depth = smoothstep(top * 0.95, top * 0.2, y0) * smoothstep(0.05, 0.5, dens);
  return clamp(1.0 - depth * mix(0.78, 0.34, sunk), 0.0, 1.0);
}

// ---- foliage colour (linear albedo) ------------------------------------------------
fn coniferAlbedo(t: Tree) -> vec3f {
  let base = mix(vec3f(0.020, 0.036, 0.024), vec3f(0.034, 0.052, 0.030), t.hue);
  return base * (0.75 + 0.5 * t.tint);
}
fn summerAlbedo(t: Tree) -> vec3f {
  let yellow = vec3f(0.062, 0.088, 0.026);
  let blue = vec3f(0.036, 0.068, 0.032);
  return mix(blue, yellow, t.hue) * (0.78 + 0.45 * t.tint);
}
fn autumnAlbedo(t: Tree) -> vec3f {
  let k = fract(t.hue * 7.31 + t.tint * 0.37);
  var c = vec3f(0.045, 0.065, 0.026);                       // still green
  if (k < 0.12) { c = vec3f(0.17, 0.030, 0.016); }            // red maple
  else if (k < 0.20) { c = vec3f(0.19, 0.050, 0.018); }       // scarlet
  else if (k < 0.40) { c = vec3f(0.21, 0.085, 0.018); }       // sugar maple orange
  else if (k < 0.58) { c = vec3f(0.19, 0.130, 0.025); }       // birch / aspen gold
  else if (k < 0.68) { c = vec3f(0.10, 0.095, 0.028); }       // turning yellow-green
  else if (k < 0.82) { c = vec3f(0.085, 0.045, 0.020); }      // oak russet
  return c * (0.75 + 0.45 * t.tint);
}
fn tropicalAlbedo(t: Tree) -> vec3f {
  var c = mix(vec3f(0.040, 0.080, 0.026), vec3f(0.075, 0.105, 0.030), t.hue);
  // pale new flush and the odd flowering crown
  if (t.tint > 0.92) { c = vec3f(0.09, 0.115, 0.045); }
  if (t.tint > 0.985 && t.hue > 0.5) { c = vec3f(0.26, 0.20, 0.05); }
  return c * (0.8 + 0.35 * t.tint);
}
fn treeAlbedo(t: Tree) -> vec3f {
  if (F.mist.z > 0.5) {
    return mix(vec3f(0.040, 0.050, 0.018), vec3f(0.072, 0.068, 0.026), t.hue) * (0.8 + 0.4 * t.tint);
  }
  if (t.conifer) { return coniferAlbedo(t); }
  if (F.biome.w > 0.5) { return tropicalAlbedo(t); }
  // only part of a stand turns at once
  let turned = smoothstep(0.0, 0.35, F.forest2.x - fract(t.seed * 0.61803) * 0.65);
  return mix(summerAlbedo(t), autumnAlbedo(t), turned);
}
// Mean foliage albedo of a stand, for the far field.
fn standAlbedo(conif: f32) -> vec3f {
  if (F.mist.z > 0.5) { return vec3f(0.052, 0.058, 0.024); }
  let con = vec3f(0.026, 0.044, 0.027);
  var broad = vec3f(0.049, 0.078, 0.029);
  if (F.biome.w > 0.5) { broad = vec3f(0.056, 0.092, 0.029); }
  let autumn = vec3f(0.135, 0.074, 0.022);
  broad = mix(broad, autumn, smoothstep(0.0, 1.0, F.forest2.x) * 0.82);
  return mix(broad, con, conif);
}
// Stand albedo with the mosaic of stands seen from afar: patches of different species,
// ages and (in autumn) maple-red against birch-gold hillsides.
fn standAlbedoAt(xz: vec2f, conif: f32) -> vec3f {
  let n1 = fbm2(xz * (1.0 / 260.0) + vec2f(3.7, 1.9), 3);
  let n2 = snoise(xz * (1.0 / 60.0) + vec2f(8.1, 4.4));
  var a = standAlbedo(clamp(conif + n1 * 0.2, 0.0, 1.0)) * (0.82 + 0.18 * n2 + 0.2 * n1);
  let aut = smoothstep(0.0, 1.0, F.forest2.x) * (1.0 - conif);
  let tint = mix(vec3f(1.25, 0.72, 0.8), vec3f(0.92, 1.2, 1.1), smoothstep(-0.45, 0.45, n1 + n2 * 0.35));
  return a * mix(vec3f(1.0), tint, aut);
}
`;
