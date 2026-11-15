import { MOON_DEM, MOON_DEM_GZIP } from './moon-data.js';
import { ARISTARCHUS_DEM, ARISTARCHUS_DEM_GZIP } from './moon-aristarchus-data.js';
import { HADLEY_DEM, HADLEY_DEM_GZIP } from './moon-hadley-data.js';
import { TYCHO_DEM, TYCHO_DEM_GZIP } from './moon-tycho-data.js';
import { ORIENTALE_DEM, ORIENTALE_DEM_GZIP } from './moon-orientale-data.js';

// Square crops share one storage buffer. Offsets are sample indices, not bytes.
export const LUNAR_TERRAINS = {};
let lunarSampleCount = 0;
for (const [id, dem, gzip] of [
  ['moon', MOON_DEM, MOON_DEM_GZIP],
  ['moon-aristarchus', ARISTARCHUS_DEM, ARISTARCHUS_DEM_GZIP],
  ['moon-hadley', HADLEY_DEM, HADLEY_DEM_GZIP],
  ['moon-tycho', TYCHO_DEM, TYCHO_DEM_GZIP],
  ['moon-orientale', ORIENTALE_DEM, ORIENTALE_DEM_GZIP],
]) {
  if (dem.width !== dem.height) throw new Error('Lunar crops must be square');
  const metresPerDegree = dem.radius * Math.PI / 180;
  LUNAR_TERRAINS[id] = { dem, gzip, offset: lunarSampleCount,
    spanX: (dem.east - dem.west) * metresPerDegree * Math.cos(dem.centerLatitude * Math.PI / 180),
    spanZ: (dem.north - dem.south) * metresPerDegree };
  lunarSampleCount += dem.width * dem.height;
}
// The offset travels through a float32 uniform and must remain an exact integer.
if (lunarSampleCount > 2 ** 24) throw new Error('Lunar terrain atlas exceeds exact offset range');

// Local equirectangular tangent approximation: east is +x, south is +z.
export const MOON_METRES_PER_DEGREE = MOON_DEM.radius * Math.PI / 180;
export const MOON_SPAN_Z = (MOON_DEM.north - MOON_DEM.south) * MOON_METRES_PER_DEGREE;
export const MOON_SPAN_X = (MOON_DEM.east - MOON_DEM.west) * MOON_METRES_PER_DEGREE * Math.cos(MOON_DEM.centerLatitude * Math.PI / 180);

export async function decodeMoonTerrain(id = 'moon') {
  const terrain = LUNAR_TERRAINS[id];
  if (!terrain) throw new Error(`Unknown lunar terrain: ${id}`);
  const { dem, gzip } = terrain;
  if (dem.codec !== 'gradient-zigzag-planar-gzip-v1') throw new Error('Unsupported Moon elevation encoding');
  const packed = Uint8Array.from(atob(gzip), (c) => c.charCodeAt(0));
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const raw = await new Response(stream).arrayBuffer();
  if (raw.byteLength !== dem.width * dem.height * 2) throw new Error('Invalid Moon elevation asset');
  const source = new Uint8Array(raw);
  const heights = new Float32Array(dem.width * dem.height);
  // Undo the byte planes and zigzag mapping, then reconstruct north-to-south.
  // All intermediate integer sums are exact, including signed 16-bit wrapping.
  for (let i = 0; i < heights.length; i++) {
    const zigzag = source[i] | (source[heights.length + i] << 8);
    const delta = (zigzag >>> 1) ^ -(zigzag & 1);
    const left = i % dem.width ? heights[i - 1] : 0;
    const up = i >= dem.width ? heights[i - dem.width] : 0;
    const corner = i >= dem.width && i % dem.width ? heights[i - dem.width - 1] : 0;
    heights[i] = (left + up - corner + delta) << 16 >> 16;
  }
  return heights;
}

export async function decodeLunarAtlas() {
  const heights = new Float32Array(lunarSampleCount);
  for (const [id, terrain] of Object.entries(LUNAR_TERRAINS)) {
    heights.set(await decodeMoonTerrain(id), terrain.offset);
  }
  return heights;
}

// Only the height bake and flight probe pipelines bind the source DEM.
export const PLANET_HEIGHT_WGSL = /* wgsl */ `
@group(0) @binding(3) var<storage, read> planetHeights: array<f32>;
// Cubic B-spline reconstruction: positive weights sum to one, so the surface
// stays inside the neighbourhood's elevation range. Unlike bilinear sampling,
// its first and second derivatives remain continuous at source-cell boundaries.
fn planetSplineWeights(t: f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  let s = 1.0 - t;
  return vec4f(s * s * s, 3.0 * t3 - 6.0 * t2 + 4.0,
    -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) / 6.0;
}
fn planetHeight(xz: vec2f) -> f32 {
  let size = vec2i(i32(F.extent.z));
  let offset = i32(F.extent.w);
  let uv = xz / (2.0 * F.extent.xy) + 0.5;
  let p = clamp(uv * vec2f(size) - 0.5, vec2f(0.0), vec2f(size - 1));
  let a = vec2i(floor(p));
  let wx = planetSplineWeights(fract(p.x));
  let wz = planetSplineWeights(fract(p.y));
  var height = 0.0;
  for (var z = 0; z < 4; z++) {
    let row = clamp(a.y + z - 1, 0, size.y - 1) * size.x;
    var line = 0.0;
    for (var x = 0; x < 4; x++) {
      let col = clamp(a.x + x - 1, 0, size.x - 1);
      line += planetHeights[offset + row + col] * wx[x];
    }
    height += line * wz[z];
  }
  return height;
}
`;
