// Region presets for the aerial tour. Each scene sets the landform, the forest, the water
// and a matching sky. sceneUniforms() packs a scene into the Frame floats 100..143 (see
// FRAME_WGSL) and returns JS mirrors of the valley path functions in wgsl/terrain.js so
// the flight follows the same valley the shaders carve.

import { createCameraRoute } from './camera-route.js';
import { LUNAR_TERRAINS } from './planet-terrain.js';

const TAU = Math.PI * 2;

export const SCENES = [
  // Earth presets retain their original order; the Moon is appended below.
  {
    id: 'pnw',
    name: 'Pacific Northwest',
    place: 'Cascade foothills, Washington',
    seed: 1207,
    relief: 950, ridge: 0.55, featureScale: 8000, gully: 1.0,
    valleyWidth: 1500, floodplain: 260, river: 15, floor: 2.5,
    path: [900, 380, 140], pathLen: [9600, 4300, 1900], meander: 140, meanderLen: 1100,
    density: 0.94, spacing: 7.5, height: 44, conifer: 0.9,
    autumn: 0.0, treeline: 1250, snowline: 1550, clearings: 0.2,
    rock: 0.8, wetland: 0.1, basin: 0.0, tropical: 0,
    mist: 0.75, mistTop: 110,
    water: 160, waterSlope: 0.003, tannin: 0.15,
    flight: { agl: 420, speed: 72, pitch: -24, fov: 52 },
    sky: { sunElev: 24, sunAzim: -128, haze: 2.4, clouds: 0.34, cloudAltitude: 2.2, veil: 0.25 },
  },
  {
    id: 'new-england',
    name: 'New England Autumn',
    place: 'White Mountains, New Hampshire',
    seed: 3301,
    relief: 420, ridge: 0.22, featureScale: 4200, gully: 0.45,
    valleyWidth: 1200, floodplain: 300, river: 11, floor: 2.0,
    path: [700, 300, 120], pathLen: [8800, 3900, 1700], meander: 110, meanderLen: 950,
    density: 0.96, spacing: 8.0, height: 24, conifer: 0.16,
    autumn: 1.0, treeline: 1400, snowline: 3000, clearings: 0.26,
    rock: 0.45, wetland: 0.3, basin: 0.06, tropical: 0,
    mist: 0.35, mistTop: 45,
    water: 230, waterSlope: 0.002, tannin: 0.6,
    flight: { agl: 300, speed: 60, pitch: -26, fov: 52 },
    sky: { sunElev: 30, sunAzim: 142, haze: 1.5, clouds: 0.26, cloudAltitude: 1.9, veil: 0.2 },
  },
  {
    id: 'boreal',
    name: 'Boreal Lakes',
    place: 'Canadian Shield, Ontario',
    seed: 5519,
    relief: 150, ridge: 0.1, featureScale: 2800, gully: 0.15,
    valleyWidth: 0, floodplain: 0, river: 0, floor: 1.0,
    path: [800, 350, 160], pathLen: [10500, 4700, 2100], meander: 0, meanderLen: 1000,
    density: 0.82, spacing: 6.0, height: 19, conifer: 0.82,
    autumn: 0.3, treeline: 2000, snowline: 3000, clearings: 0.2,
    rock: 0.55, wetland: 0.8, basin: 0.3, tropical: 0,
    mist: 0.45, mistTop: 25,
    water: 330, waterSlope: 0.0, tannin: 0.9,
    flight: { agl: 260, speed: 64, pitch: -22, fov: 54 },
    sky: { sunElev: 13, sunAzim: 24, haze: 1.3, clouds: 0.3, cloudAltitude: 2.0, veil: 0.35 },
  },
  {
    id: 'alpine',
    name: 'Alpine Valley',
    place: 'Bernese Oberland, Switzerland',
    seed: 7741,
    relief: 1550, ridge: 0.78, featureScale: 8200, gully: 1.25,
    valleyWidth: 3200, floodplain: 360, river: 12, floor: 3.0,
    path: [1100, 450, 160], pathLen: [11000, 5200, 2300], meander: 90, meanderLen: 1300,
    density: 0.86, spacing: 7.0, height: 32, conifer: 0.95,
    autumn: 0.1, treeline: 1050, snowline: 1650, clearings: 0.28,
    rock: 1.0, wetland: 0.05, basin: 0.0, tropical: 0,
    mist: 0.2, mistTop: 60,
    water: 820, waterSlope: 0.006, tannin: 0.0,
    flight: { agl: 520, speed: 78, pitch: -20, fov: 54 },
    sky: { sunElev: 36, sunAzim: 118, haze: 1.0, clouds: 0.2, cloudAltitude: 3.6, veil: 0.18 },
  },
  {
    id: 'rockies',
    name: 'Colorado Rockies',
    place: 'Front Range, Colorado',
    seed: 6409,
    // Snowline sits below the valley floor, so the ground is covered along with the
    // mountains. Steeper ribs still break through as rock. The forest stays open
    // enough that the snow shows between the spruce.
    relief: 2000, ridge: 0.74, featureScale: 9000, gully: 1.15,
    valleyWidth: 4800, floodplain: 420, river: 9, floor: 2.4,
    path: [1300, 500, 170], pathLen: [14000, 6000, 2500], meander: 80, meanderLen: 1400,
    density: 0.42, spacing: 11.0, height: 22, conifer: 0.95,
    autumn: 0.0, treeline: 340, snowline: -260, clearings: 0.42,
    rock: 1.0, wetland: 0.02, basin: 0.0, tropical: 0,
    mist: 0.08, mistTop: 28,
    water: 2300, waterSlope: 0.006, tannin: 0.0,
    flight: { agl: 520, speed: 72, pitch: -16, fov: 54 },
    sky: { sunElev: 38, sunAzim: 48, haze: 0.7, clouds: 0.12, cloudAltitude: 5.6, veil: 0.06 },
  },
  {
    id: 'tropical',
    name: 'Tropical Rainforest',
    place: 'Highlands of Borneo',
    seed: 9157,
    relief: 700, ridge: 0.6, featureScale: 3300, gully: 1.45,
    valleyWidth: 950, floodplain: 230, river: 24, floor: 2.0,
    path: [650, 300, 120], pathLen: [8200, 3600, 1600], meander: 170, meanderLen: 1300,
    density: 1.0, spacing: 11.0, height: 38, conifer: 0.0,
    autumn: 0.0, treeline: 3000, snowline: 5000, clearings: 0.08,
    rock: 0.3, wetland: 0.2, basin: 0.0, tropical: 1,
    mist: 1.0, mistTop: 140,
    water: 90, waterSlope: 0.002, tannin: 0.75,
    flight: { agl: 340, speed: 62, pitch: -24, fov: 52 },
    sky: { sunElev: 48, sunAzim: -100, haze: 3.2, clouds: 0.55, cloudAltitude: 1.5, veil: 0.3 },
  },
  {
    id: 'coast',
    name: 'Pacific Coast',
    place: 'Big Sur, California',
    seed: 4823,
    coast: 1,
    // valleyWidth is how far inland the coastal range reaches full height.
    // floodplain scales the sandy coves. Along the shore those coves, the cliff
    // height and the nearshore depth all vary.
    relief: 860, ridge: 0.58, featureScale: 6400, gully: 0.72,
    valleyWidth: 2600, floodplain: 170, river: 0, floor: 8,
    path: [2600, 1100, 340], pathLen: [26000, 9800, 3600], meander: 0, meanderLen: 1400,
    density: 0.74, spacing: 8.5, height: 26, conifer: 0.68,
    autumn: 0.04, treeline: 980, snowline: 4200, clearings: 0.36,
    rock: 0.9, wetland: 0.0, basin: 0.0, tropical: 0,
    mist: 0.22, mistTop: 36,
    water: 0, waterSlope: 0, tannin: 0.0,
    flight: { agl: 340, speed: 66, pitch: -17, fov: 58, offshore: 360 },
    sky: { sunElev: 28, sunAzim: -82, haze: 1.5, clouds: 0.18, cloudAltitude: 2.2, veil: 0.1 },
  },
  {
    id: 'canyon',
    name: 'Grand Canyon',
    place: 'Colorado Plateau, Arizona',
    seed: 2841,
    canyon: 1,
    // relief is the drop from the Kaibab rim to the river. valleyWidth scales the
    // gorge (3200 is the width this scene is drawn for). The river is the Colorado.
    relief: 1520, ridge: 0.35, featureScale: 7800, gully: 0.95,
    valleyWidth: 3200, floodplain: 180, river: 46, floor: 2.0,
    path: [2200, 860, 300], pathLen: [36000, 16000, 7000], meander: 55, meanderLen: 2600,
    density: 0.42, spacing: 13.0, height: 7, conifer: 1.0,
    autumn: 0.0, treeline: 5000, snowline: 5000, clearings: 0.46,
    rock: 1.0, wetland: 0.0, basin: 0.0, tropical: 0,
    mist: 0.02, mistTop: 24,
    water: 860, waterSlope: 0.0007, tannin: 1.0,
    flight: { agl: 480, speed: 64, pitch: -11, fov: 56 },
    sky: { sunElev: 27, sunAzim: 104, haze: 0.55, clouds: 0.06, cloudAltitude: 7.2, veil: 0.04 },
  },
  {
    id: 'falls',
    name: 'Waterfall Valley',
    place: 'Fiordland, New Zealand',
    seed: 6127,
    // The floor is one river, wall to wall. Streams and tarns on the rims spill over the cliffs.
    relief: 1500, ridge: 0.52, featureScale: 4400, gully: 0.62,
    valleyWidth: 1600, floodplain: 560, river: 18, floor: 4.2,
    path: [560, 220, 70], pathLen: [16000, 7000, 3100], meander: 45, meanderLen: 1800,
    density: 0.7, spacing: 8.5, height: 30, conifer: 0.38,
    autumn: 0.0, treeline: 640, snowline: 1280, clearings: 0.28,
    rock: 1.0, wetland: 0.05, basin: 0.0, tropical: 0,
    mist: 0.14, mistTop: 28,
    water: 420, waterSlope: 0.004, tannin: 0.12,
    falls: 0.92, fallCliff: 180, fallSpacing: 340, fallWidth: 1.05,
    flight: { agl: 340, speed: 52, pitch: -20, fov: 56 },
    sky: { sunElev: 30, sunAzim: 108, haze: 1.1, clouds: 0.34, cloudAltitude: 2.6, veil: 0.16 },
  },
];

function lunarBody(id) {
  const { dem, spanX, spanZ, offset } = LUNAR_TERRAINS[id];
  return { airless: true, radius: dem.radius, min: dem.min, max: dem.max,
    halfWidth: spanX / 2, halfHeight: spanZ / 2, demSize: dem.width, demOffset: offset };
}

SCENES.push({
  id: 'moon', name: 'Moon · Copernicus',
  place: 'Copernicus crater · measured NASA/SELENE terrain',
  body: lunarBody('moon'),
  seed: 0, relief: 7000, ridge: 0, featureScale: 8000, gully: 0,
  valleyWidth: 0, floodplain: 0, river: 0, floor: 0,
  path: [0, 0, 0], pathLen: [10000, 10000, 10000], meander: 0, meanderLen: 10000,
  density: 0, spacing: 15, height: 0, conifer: 0,
  autumn: 0, treeline: 0, snowline: 100000, clearings: 0,
  rock: 1, wetland: 0, basin: 0, tropical: 0, mist: 0, mistTop: 0,
  water: -20000, waterSlope: 0, tannin: 0,
  flight: { agl: 5500, speed: 180, pitch: -22, fov: 58, startZ: 52000, endZ: -52000,
    route: createCameraRoute([
      { x: 14000, z: 52000, agl: 5500, pitch: -20 }, // southern rim approach
      { x: 5000, z: 38000, agl: 3800, pitch: -25 }, // descend onto the floor
      { x: -10000, z: 21000, agl: 2400, pitch: -18 }, // western approach to central peaks
      { x: -9000, z: 6000, agl: 2800, pitch: -18 }, // pass beside the peak cluster
      { x: 4000, z: -16000, agl: 3400, pitch: -16 }, // cross the northern floor
      { x: 12000, z: -34000, agl: 5200, pitch: -20 }, // climb over the northern rim
      { x: 14000, z: -52000, agl: 5500, pitch: -20 }, // exit over the ejecta
    ]),
  },
  sky: { sunElev: 18, sunAzim: 110, haze: 0, clouds: 0, cloudAltitude: 2, veil: 0 },
});

// Geographic waypoints keep each flight tied to its measured landmarks.
// Latitude increases along a route; local +x is east and +z is south.
function addLunarScene(id, name, place, speed, sunElev, sunAzim, waypoints) {
  const { dem } = LUNAR_TERRAINS[id];
  const scale = dem.radius * Math.PI / 180;
  const points = waypoints.map(([latitude, longitude, agl, pitch]) => ({
    x: (longitude - dem.centerLongitude) * scale * Math.cos(dem.centerLatitude * Math.PI / 180),
    z: (dem.centerLatitude - latitude) * scale, agl, pitch,
  }));
  const route = createCameraRoute(points);
  const base = SCENES.find((scene) => scene.id === 'moon');
  SCENES.push({ ...base, id, name: `Moon · ${name}`,
    place: `${place} · measured NASA/SELENE terrain`, body: lunarBody(id),
    flight: { agl: points[0].agl, speed, pitch: points[0].pitch, fov: 58,
      startZ: route.startZ, endZ: route.endZ, route },
    sky: { ...base.sky, sunElev, sunAzim },
  });
}

addLunarScene('moon-aristarchus', 'Aristarchus Plateau', 'Vallis Schröteri and Aristarchus crater', 170, 20, 105, [
  [22.4, 312.5, 4200, -22], // approach Aristarchus from the southern plain
  [23.7, 312.0, 3000, -24], // western crater wall
  [24.5, 311.0, 2200, -20], // plateau toward the valley mouth
  [25.2, 310.4, 1800, -22], // Cobra Head region
  [26.0, 309.0, 2300, -20], // sweep west over the winding valley
  [27.4, 309.5, 3500, -18], // northern plateau
]);

addLunarScene('moon-hadley', 'Hadley–Apennine', 'Hadley Rille and the Apollo 15 region', 95, 24, 115, [
  [25.0, 3.5, 3000, -22], // southern mountain approach
  [25.6, 3.3, 1900, -22], // descend toward the rille
  [26.0, 3.55, 1400, -25], // Apollo 15 region
  [26.4, 3.6, 1600, -23], // rille beside the mountain front
  [26.8, 3.9, 2400, -20],
  [27.2, 4.2, 3200, -18], // climb out alongside Mons Hadley
]);

addLunarScene('moon-tycho', 'Tycho', 'Terraced walls and central peaks', 160, 17, 100, [
  [-45.4, 349.2, 5000, -20], // southern highlands
  [-44.5, 349.0, 3900, -24], // southern rim
  [-43.7, 348.5, 2600, -23], // floor west of the central peaks
  [-43.2, 348.4, 2500, -20],
  [-42.4, 349.0, 4100, -22], // northern terraces
  [-41.3, 349.2, 5000, -18],
]);

addLunarScene('moon-orientale', 'Orientale', 'Northern basin and the Rook mountain rings', 350, 16, 110, [
  [-16.5, 264.0, 5500, -20], // northern basin floor, facing the mountains
  [-15.5, 263.5, 5500, -18],
  [-14.5, 263.5, 6000, -20], // mountain approach
  [-13.5, 264.0, 6500, -22],
  [-12.5, 264.5, 7000, -22], // climb through the Rook mountains
  [-11.0, 265.5, 7500, -20],
]);

export function sceneById(id) {
  return SCENES.find((s) => s.id === id) || SCENES[0];
}

function hash01(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// f: Float32Array of the Frame, written at offsets 100..143. visit varies the terrain
// seed so each pass through the tour is a new stretch of country. mul scales the forest
// (density, height) from the settings panel.
export function sceneUniforms(f, scene, visit, mul) {
  const seed = (scene.seed + visit * 101) % 60000;
  const ph = [0, 1, 2, 3].map((i) => hash01(seed * 7 + i) * TAU);
  const k = scene.pathLen.map((l) => TAU / l);
  const mk = TAU / scene.meanderLen;
  f[100] = scene.relief; f[101] = scene.ridge; f[102] = scene.featureScale; f[103] = scene.gully;
  f[104] = scene.valleyWidth; f[105] = scene.floodplain; f[106] = scene.river; f[107] = scene.floor;
  f[108] = scene.path[0]; f[109] = scene.path[1]; f[110] = scene.path[2]; f[111] = scene.meander;
  f[112] = k[0]; f[113] = k[1]; f[114] = k[2]; f[115] = mk;
  f[116] = ph[0]; f[117] = ph[1]; f[118] = ph[2]; f[119] = ph[3];
  f[120] = Math.min(1, scene.density * mul.density); f[121] = scene.spacing;
  f[122] = scene.height * mul.height; f[123] = scene.conifer;
  f[124] = scene.autumn; f[125] = scene.treeline; f[126] = scene.snowline; f[127] = scene.clearings;
  f[128] = scene.rock; f[129] = scene.wetland; f[130] = scene.basin; f[131] = scene.tropical;
  f[132] = scene.mist * mul.mist; f[133] = scene.mistTop; f[134] = scene.canyon ? 1 : 0; f[135] = seed;
  f[136] = scene.water; f[137] = scene.waterSlope; f[138] = scene.tannin; f[139] = scene.coast ? 1 : 0;
  f[140] = scene.falls || 0; f[141] = scene.fallCliff || 140; f[142] = scene.fallSpacing || 320; f[143] = scene.fallWidth || 1;
  const body = scene.body;
  f[144] = body?.airless ? 1 : 0; f[145] = body?.radius ?? 6371000;
  f[146] = body?.min ?? 0; f[147] = body?.max ?? 0;
  f[148] = body?.halfWidth ?? 0; f[149] = body?.halfHeight ?? 0;
  f[150] = body?.demSize ?? 0; f[151] = body?.demOffset ?? 0;

  const A = scene.path, M = scene.meander;
  const valleyX = (z) => A[0] * Math.sin(k[0] * z + ph[0]) + A[1] * Math.sin(k[1] * z + ph[1]) + A[2] * Math.sin(k[2] * z + ph[2]);
  const valleyDX = (z) => A[0] * k[0] * Math.cos(k[0] * z + ph[0]) + A[1] * k[1] * Math.cos(k[1] * z + ph[1])
    + A[2] * k[2] * Math.cos(k[2] * z + ph[2]);
  const riverX = (z) => valleyX(z) + M * (Math.sin(mk * z + ph[3]) + 0.35 * Math.sin(2.3 * mk * z + 1.7 + ph[3]));
  const waterLevel = (z) => scene.water - scene.waterSlope * z;
  return { seed, valleyX, valleyDX, riverX, waterLevel };
}
