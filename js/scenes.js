// Region presets for the aerial tour. Each scene sets the landform, the forest, the water
// and a matching sky. sceneUniforms() packs a scene into the Frame floats 100..139 (see
// FRAME_WGSL) and returns JS mirrors of the valley path functions in wgsl/terrain.js so
// the flight follows the same valley the shaders carve.

const TAU = Math.PI * 2;

export const SCENES = [
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
];

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

// f: Float32Array of the Frame, written at offsets 100..139. visit varies the terrain
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
  f[132] = scene.mist * mul.mist; f[133] = scene.mistTop; f[134] = 0; f[135] = seed;
  f[136] = scene.water; f[137] = scene.waterSlope; f[138] = scene.tannin; f[139] = scene.coast ? 1 : 0;

  const A = scene.path, M = scene.meander;
  const valleyX = (z) => A[0] * Math.sin(k[0] * z + ph[0]) + A[1] * Math.sin(k[1] * z + ph[1]) + A[2] * Math.sin(k[2] * z + ph[2]);
  const valleyDX = (z) => A[0] * k[0] * Math.cos(k[0] * z + ph[0]) + A[1] * k[1] * Math.cos(k[1] * z + ph[1])
    + A[2] * k[2] * Math.cos(k[2] * z + ph[2]);
  const riverX = (z) => valleyX(z) + M * (Math.sin(mk * z + ph[3]) + 0.35 * Math.sin(2.3 * mk * z + 1.7 + ph[3]));
  const waterLevel = (z) => scene.water - scene.waterSlope * z;
  return { seed, valleyX, valleyDX, riverX, waterLevel };
}
