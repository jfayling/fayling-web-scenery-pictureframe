// WebGPU aerial scenery — custom renderer.
// Procedural eroded terrain in camera-centred clipmaps + CDLOD mesh with individual trees +
// physically based sky with an aerial-perspective volume + HDR post. All per-frame data
// lives in preallocated typed arrays / descriptors (no per-frame garbage apart from the
// unavoidable swap-chain view and command buffer objects).
import { SKY_W, SKY_H, AP_RES, CLIP_RES, CLIP_LEVELS, CLIP_TEXEL0, PROBE_N } from './wgsl/common.js';
import { TRANS_LUT, MS_LUT, SKYVIEW_LUT, AP_LUT } from './wgsl/sky.js';
import { CLIP_HEIGHT, CLIP_DERIVE, HEIGHT_PROBE } from './wgsl/terrain.js';
import { SKY_BG, landWGSL } from './wgsl/land.js';
import { BLOOM_DOWN, BLOOM_UP, COMPOSITE } from './wgsl/post.js';
import { SCENES, sceneUniforms } from './scenes.js';
import { celestialState } from './astronomy.js';
import { createStarMapData, STAR_MAP_WIDTH, STAR_MAP_HEIGHT } from './star-catalog.js';
import { createWeatherWidget } from './weather.js';
import { acceptedPlace, rememberChoice, resolvePlace, suggestPlaces } from './place.js';

const qs = new URLSearchParams(location.search);
const DBG = Number(qs.get('dbg')) || 0;
const D2R = Math.PI / 180;
const GU = GPUBufferUsage;
const TU = GPUTextureUsage;

// ----------------------------------------------------------------------------------------
// Tunable parameters (UI panel edits these)
// ----------------------------------------------------------------------------------------
export const P = {
  sceneMode: 'tour',
  scene: 'pnw',
  tourOrder: 'sequence',
  tourMinutes: 4,
  sceneLabel: true,
  sceneSky: true,
  autopilot: true,
  flightSpeed: 1,
  flightAltitude: 1,
  cameraTilt: 0,
  fov: 52,
  forestDensity: 1,
  treeHeight: 1,
  mist: 1,
  renderScale: 1,
  skyMode: 'static',
  zipCode: '98101',
  skyWhen: '',
  skyLapseStart: '2026-01-01T00:00',
  lapsePace: 20,
  sunElev: 24,         // deg
  sunAzim: -128,       // deg (0 = the direction the flight starts out in)
  moon: true,
  moonElev: 28,
  moonAzim: -42,
  moonPhase: 0.78,
  moonSize: 2.5,
  moonBrightness: 4,
  stars: true,
  starMode: 'dynamic',
  starDensity: 0.55,
  starBrightness: 1.4,
  starTwinkle: 1,
  starSeed: 137,
  nightBrightness: 1,
  cloudMode: 'static',
  exposure: 1.4,
  haze: 2.4,
  cloudMotion: true,
  cloudWindSpeed: 8,
  cloudWindDir: 118,
  cloudEvolution: 0.35,
  cloudScale: 1,
  cloudAltitude: 2.2,
  clouds: 0.34,
  cloudDensity: 2.2,
  cloudSoftness: 1,
  cloudShadows: 0.85,
  highCloudWindSpeed: 22,
  highCloudWindDir: 145,
  highCloudScale: 1,
  highCloudAltitude: 7,
  veil: 0.25,
  highCloudDensity: 0.9,
  cloudSilver: 1,
  cloudAmbient: 1,
  bloom: 0.06,
  showButtons: true,
  showInfo: false,
  clock: true,
  clock24h: false,
  clockSeconds: false,
  clockDate: true,
  clockStyle: 'modern',
  clockSize: 72,
  clockColor: '#ffffff',
  clockPosition: 'top-center',
  clockOpacity: 0.9,
  clockBackground: 0.18,
  weather: true,
  weatherZip: '98101',
  weatherRefresh: 15,
  weatherUnit: 'fahrenheit',
  weatherPosition: 'bottom-left',
  weatherTemp: true,
  weatherFeels: true,
  weatherPrecip: true,
  weatherHumidity: true,
  weatherWind: true,
  weatherForecast: true,
  weatherAlerts: true,
};
const DEFAULTS = { ...P };

function fail(msg) {
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = msg;
  log('FATAL ' + msg);
  throw new Error(msg);
}
function log(msg) {
  console.log(msg);
  // The dev server records this. Anywhere else the POST is rejected and only adds console noise.
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  try { fetch('/__log', { method: 'POST', body: String(msg) }).catch(() => {}); } catch (e) { /* offline */ }
}

// ----------------------------------------------------------------------------------------
// Small math helpers writing into preallocated arrays
// ----------------------------------------------------------------------------------------
function mat4Mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}
function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

async function main() {
  if (!navigator.gpu) fail('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) fail('No WebGPU adapter found.');
  const hasTS = adapter.features.has('timestamp-query');
  // rgba32float clipmaps are hardware filtered when the adapter allows it
  const hasF32Filter = adapter.features.has('float32-filterable');
  const features = [];
  if (hasTS) features.push('timestamp-query');
  if (hasF32Filter) features.push('float32-filterable');
  const device = await adapter.requestDevice({ requiredFeatures: features });
  device.lost.then((i) => log('device lost: ' + i.message));
  device.onuncapturederror = (e) => log('GPU error: ' + e.error.message);

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('webgpu');
  const swapFormat = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: swapFormat, alphaMode: 'opaque', usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC });

  async function shader(code, label) {
    const m = device.createShaderModule({ code, label });
    const info = await m.getCompilationInfo();
    let bad = false;
    for (const msg of info.messages) {
      if (msg.type === 'error') bad = true;
      if (msg.type !== 'info') {
        const line = code.split('\n')[msg.lineNum - 1];
        log(`[${label}] ${msg.type} ${msg.lineNum}:${msg.linePos} ${msg.message}\n    ${line}`);
      }
    }
    if (bad) fail('Shader compile error in ' + label + ' (see console)');
    return m;
  }
  async function computePipe(code, label) {
    const module = await shader(code, label);
    return device.createComputePipelineAsync({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
  }
  const mkBuf = (size, usage, label) => device.createBuffer({ size, usage, label });
  const bg = (pipe, entries, label) => device.createBindGroup({
    label, layout: pipe.getBindGroupLayout(0),
    entries: entries.map((r, i) => ({ binding: i, resource: r })),
  });

  const [transPipe, msPipe, skyViewPipe, apPipe, clipHeightPipe, clipDerivePipe, probePipe] = await Promise.all([
    computePipe(TRANS_LUT, 'transmittance'),
    computePipe(MS_LUT, 'multiscatter'),
    computePipe(SKYVIEW_LUT, 'skyview'),
    computePipe(AP_LUT, 'aerial perspective'),
    computePipe(CLIP_HEIGHT, 'clip height'),
    computePipe(CLIP_DERIVE, 'clip derive'),
    computePipe(HEIGHT_PROBE, 'height probe'),
  ]);

  // --------------------------------------------------------------------------------------
  // Atmosphere resources
  // --------------------------------------------------------------------------------------
  const atmoUBO = mkBuf(16, GU.UNIFORM | GU.COPY_DST, 'atmo ubo');
  const mkLut = (w, h, label) => device.createTexture({
    label, size: [w, h], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const transLUT = mkLut(256, 64, 'transmittance');
  const msLUT = mkLut(32, 32, 'multiscatter');
  const skyLUT = mkLut(SKY_W, SKY_H, 'skyview');
  const apTex = device.createTexture({
    label: 'aerial perspective', size: [AP_RES, AP_RES, AP_RES], dimension: '3d', format: 'rgba16float',
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const apView = apTex.createView({ dimension: '3d' });
  const sampClamp = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
  });
  const frameUBO = mkBuf(560, GU.UNIFORM | GU.COPY_DST, 'frame ubo');
  const transView = transLUT.createView();
  const msView = msLUT.createView();
  const skyView = skyLUT.createView();
  const starMap = device.createTexture({
    label: 'Yale bright star catalogue',
    size: [STAR_MAP_WIDTH, STAR_MAP_HEIGHT],
    format: 'rgba8unorm',
    usage: TU.TEXTURE_BINDING | TU.COPY_DST,
  });
  {
    const pixels = createStarMapData();
    device.queue.writeTexture(
      { texture: starMap },
      pixels,
      { bytesPerRow: STAR_MAP_WIDTH * 4, rowsPerImage: STAR_MAP_HEIGHT },
      [STAR_MAP_WIDTH, STAR_MAP_HEIGHT],
    );
  }
  const starView = starMap.createView();

  const bgTrans = bg(transPipe, [{ buffer: atmoUBO }, transView], 'trans');
  const bgMS = bg(msPipe, [{ buffer: atmoUBO }, transView, sampClamp, msView], 'ms');
  const bgSkyView = bg(skyViewPipe, [{ buffer: frameUBO }, transView, msView, sampClamp, skyView], 'skyview');
  const bgAP = bg(apPipe, [{ buffer: frameUBO }, transView, msView, sampClamp, apView], 'aerial perspective');

  // --------------------------------------------------------------------------------------
  // Terrain clipmaps: one 512² layer per level, texel doubling per level. Height is baked
  // first, then gradient / curvature / land-cover masks are derived from it.
  // --------------------------------------------------------------------------------------
  const mkClip = (format, label) => device.createTexture({
    label, size: [CLIP_RES, CLIP_RES, CLIP_LEVELS], format, usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const clipH = mkClip('r32float', 'clip height');
  const clipA = mkClip('rgba32float', 'clip A');
  const clipB = mkClip('rgba16float', 'clip B');
  const arr = (t) => t.createView({ dimension: '2d-array' });
  const clipUBO = mkBuf(CLIP_LEVELS * 16, GU.UNIFORM | GU.COPY_DST, 'clip levels');
  const clipF = new Float32Array(CLIP_LEVELS * 4);
  const bakeUBOs = [], bgClipHeight = [], bgClipDerive = [];
  for (let l = 0; l < CLIP_LEVELS; l++) {
    const ubo = mkBuf(16, GU.UNIFORM | GU.COPY_DST, 'bake ' + l);
    bakeUBOs.push(ubo);
    bgClipHeight.push(bg(clipHeightPipe, [{ buffer: frameUBO }, { buffer: ubo }, arr(clipH)], 'clip height ' + l));
    bgClipDerive.push(bg(clipDerivePipe, [{ buffer: frameUBO }, { buffer: ubo }, arr(clipH), arr(clipA), arr(clipB)], 'clip derive ' + l));
  }
  const bakeF = new Float32Array(4);
  const clipOrigin = new Float64Array(CLIP_LEVELS * 2);
  const clipValid = new Uint8Array(CLIP_LEVELS);
  const clipTexel = (l) => CLIP_TEXEL0 * Math.pow(2, l);

  // Terrain heights for the flight controller (async readback, a few frames of latency).
  const probeUBO = mkBuf(PROBE_N * 16, GU.UNIFORM | GU.COPY_DST, 'probe points');
  const probeOut = mkBuf(PROBE_N * 4, GU.STORAGE | GU.COPY_SRC, 'probe out');
  const probeRead = mkBuf(PROBE_N * 4, GU.MAP_READ | GU.COPY_DST, 'probe read');
  const bgProbe = bg(probePipe, [{ buffer: frameUBO }, { buffer: probeUBO }, { buffer: probeOut }], 'probe');
  const probeQ = new Float32Array(PROBE_N * 4);
  const probeSentXZ = new Float32Array(PROBE_N * 2);
  const probeXZ = new Float32Array(PROBE_N * 2);
  const probeH = new Float32Array(PROBE_N);
  let probePending = false, probeSentGen = -1, probeGen = -1;
  const onProbe = () => {
    probeH.set(new Float32Array(probeRead.getMappedRange(0, PROBE_N * 4)));
    probeRead.unmap();
    probeXZ.set(probeSentXZ);
    probeGen = probeSentGen;
    probePending = false;
  };
  const onProbeFail = () => { probePending = false; };

  // --------------------------------------------------------------------------------------
  // Render pipelines
  // --------------------------------------------------------------------------------------
  const MSAA = 4;
  const HDR = 'rgba16float';
  const [landMod, skyMod, downMod, upMod, compMod] = await Promise.all([
    shader(landWGSL(hasF32Filter), 'land'), shader(SKY_BG, 'sky'), shader(BLOOM_DOWN, 'bloom down'),
    shader(BLOOM_UP, 'bloom up'), shader(COMPOSITE, 'composite'),
  ]);
  const landPipe = await device.createRenderPipelineAsync({
    label: 'land', layout: 'auto',
    vertex: {
      module: landMod, entryPoint: 'vs',
      buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
    },
    fragment: { module: landMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    multisample: { count: MSAA },
  });
  const skyPipe = await device.createRenderPipelineAsync({
    label: 'sky', layout: 'auto',
    vertex: { module: skyMod, entryPoint: 'vs' },
    fragment: { module: skyMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
    multisample: { count: MSAA },
  });
  const downPipe = await device.createRenderPipelineAsync({
    label: 'bloom down', layout: 'auto',
    vertex: { module: downMod, entryPoint: 'vs' },
    fragment: { module: downMod, entryPoint: 'fs', targets: [{ format: HDR }] },
  });
  const upPipe = await device.createRenderPipelineAsync({
    label: 'bloom up', layout: 'auto',
    vertex: { module: upMod, entryPoint: 'vs' },
    fragment: {
      module: upMod, entryPoint: 'fs',
      targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }],
    },
  });
  const compPipe = await device.createRenderPipelineAsync({
    label: 'composite', layout: 'auto',
    vertex: { module: compMod, entryPoint: 'vs' },
    fragment: { module: compMod, entryPoint: 'fs', targets: [{ format: swapFormat }] },
  });

  const bgLand = bg(landPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, starView, apView,
    arr(clipA), arr(clipB), { buffer: clipUBO }], 'land');
  const bgSky = bg(skyPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, starView], 'sky');

  // CDLOD grid mesh
  const GRID = 32;
  const LEAF = 16.0;          // finest node size (m) -> 0.5 m vertex spacing
  const R0 = 16 * LEAF;       // LOD 0 range
  const LODS = 10;
  const MAX_DIST = 110000;
  const MAX_NODES = 8192;
  const idx = new Uint16Array(GRID * GRID * 6);
  {
    let k = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = i + j * (GRID + 1), b = a + 1, c = a + GRID + 1, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
  }
  const idxBuf = mkBuf(idx.byteLength, GU.INDEX | GU.COPY_DST, 'grid idx');
  device.queue.writeBuffer(idxBuf, 0, idx);
  const instData = new Float32Array(MAX_NODES * 4);
  const instBuf = mkBuf(instData.byteLength, GU.VERTEX | GU.COPY_DST, 'instances');

  // --------------------------------------------------------------------------------------
  // Screen-size dependent targets
  // --------------------------------------------------------------------------------------
  const BLOOM_LEVELS = 8;
  const linSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const compUBO = mkBuf(32, GU.UNIFORM | GU.COPY_DST, 'composite ubo');
  const compData = new Float32Array(8);
  const bloomUBOs = [];
  for (let i = 0; i < BLOOM_LEVELS * 2; i++) bloomUBOs.push(mkBuf(16, GU.UNIFORM | GU.COPY_DST, 'bloom ubo'));

  let W = 0, H = 0;
  let colorMS, depthMS, hdrTex, bloomTex;
  const mainPass = {
    colorAttachments: [{ view: null, resolveTarget: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
    depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  };
  const compPass = {
    colorAttachments: [{ view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    timestampWrites: undefined,
  };
  let downPasses = [], upPasses = [], downBGs = [], upBGs = [], bgComp = null;

  function resize() {
    const fw = Number(qs.get('w')) || 0, fh = Number(qs.get('h')) || 0;
    const dpr = (window.devicePixelRatio || 1) * P.renderScale;
    const w = fw || Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = fh || Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = W; canvas.height = H;
    for (const t of [colorMS, depthMS, hdrTex, bloomTex]) t && t.destroy();
    colorMS = device.createTexture({ size: [W, H], format: HDR, sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT });
    depthMS = device.createTexture({ size: [W, H], format: 'depth32float', sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT });
    hdrTex = device.createTexture({ size: [W, H], format: HDR, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    const bw = Math.max(1, W >> 1), bh = Math.max(1, H >> 1);
    bloomTex = device.createTexture({ size: [bw, bh], format: HDR, mipLevelCount: BLOOM_LEVELS, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    mainPass.colorAttachments[0].view = colorMS.createView();
    mainPass.colorAttachments[0].resolveTarget = hdrTex.createView();
    mainPass.depthStencilAttachment.view = depthMS.createView();
    const hdrView = hdrTex.createView();
    const bv = [];
    for (let m = 0; m < BLOOM_LEVELS; m++) bv.push(bloomTex.createView({ baseMipLevel: m, mipLevelCount: 1 }));
    downPasses = []; upPasses = []; downBGs = []; upBGs = [];
    const tmp = new Float32Array(4);
    for (let m = 0; m < BLOOM_LEVELS; m++) {
      const srcW = m === 0 ? W : Math.max(1, bw >> (m - 1));
      const srcH = m === 0 ? H : Math.max(1, bh >> (m - 1));
      tmp[0] = 1 / srcW; tmp[1] = 1 / srcH; tmp[2] = m === 0 ? 1 : 0; tmp[3] = 0;
      device.queue.writeBuffer(bloomUBOs[m], 0, tmp);
      downBGs.push(bg(downPipe, [m === 0 ? hdrView : bv[m - 1], linSamp, { buffer: bloomUBOs[m] }]));
      downPasses.push({ colorAttachments: [{ view: bv[m], clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    }
    for (let m = BLOOM_LEVELS - 1; m > 0; m--) {
      const sw = Math.max(1, bw >> m), sh = Math.max(1, bh >> m);
      tmp[0] = 1 / sw; tmp[1] = 1 / sh; tmp[2] = 1.0; tmp[3] = 1.0;
      const ubo = bloomUBOs[BLOOM_LEVELS + m];
      device.queue.writeBuffer(ubo, 0, tmp);
      upBGs.push(bg(upPipe, [bv[m], linSamp, { buffer: ubo }]));
      upPasses.push({ colorAttachments: [{ view: bv[m - 1], loadOp: 'load', storeOp: 'store' }] });
    }
    bgComp = bg(compPipe, [hdrView, bv[0], linSamp, { buffer: compUBO }]);
  }

  // --------------------------------------------------------------------------------------
  // GPU timing
  // --------------------------------------------------------------------------------------
  let tsQuery = null, tsResolve = null, tsRead = null, tsPending = false, gpuMs = 0;
  let firstPassTS = undefined;
  if (hasTS) {
    tsQuery = device.createQuerySet({ type: 'timestamp', count: 2 });
    tsResolve = mkBuf(16, GU.QUERY_RESOLVE | GU.COPY_SRC, 'ts resolve');
    tsRead = mkBuf(16, GU.MAP_READ | GU.COPY_DST, 'ts read');
    firstPassTS = { querySet: tsQuery, beginningOfPassWriteIndex: 0 };
    compPass.timestampWrites = { querySet: tsQuery, endOfPassWriteIndex: 1 };
  }
  const computeDesc = { timestampWrites: firstPassTS };
  const onTsMapped = () => {
    const t = new BigUint64Array(tsRead.getMappedRange());
    const ms = Number(t[1] - t[0]) / 1e6;
    if (ms > 0 && ms < 1000) gpuMs = gpuMs ? gpuMs * 0.8 + ms * 0.2 : ms;
    tsRead.unmap();
    tsPending = false;
  };
  const onTsFail = () => { tsPending = false; };

  // --------------------------------------------------------------------------------------
  // Uniform data
  // --------------------------------------------------------------------------------------
  const frameF = new Float32Array(140);
  const frameI = new Int32Array(frameF.buffer);
  const atmoF = new Float32Array(4);
  const proj = new Float32Array(16), view = new Float32Array(16), viewProj = new Float32Array(16);
  let needLUT = true;

  // --------------------------------------------------------------------------------------
  // Scenes and the tour
  // --------------------------------------------------------------------------------------
  // fade: 0 black ... 1 full picture. wait: the new scene is baked and the camera waits
  // for the first terrain probes before fading in.
  const tour = { idx: 0, scene: SCENES[0], visit: 0, gen: 0, t: 0, fade: 0, state: 'wait', next: -1, labelT: 0 };
  const visits = new Array(SCENES.length).fill(0);
  let path = null;
  const shuffleBag = [];
  function sceneIndex(id) {
    const i = SCENES.findIndex((s) => s.id === id);
    return i < 0 ? 0 : i;
  }
  function forestMul() {
    return { density: P.forestDensity, height: P.treeHeight, mist: P.mist };
  }
  function nextTourIndex(step = 1) {
    if (P.sceneMode !== 'tour') return sceneIndex(P.scene);
    if (P.tourOrder === 'shuffle' && step > 0) {
      if (!shuffleBag.length) {
        for (let i = 0; i < SCENES.length; i++) if (i !== tour.idx) shuffleBag.push(i);
        for (let i = shuffleBag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffleBag[i], shuffleBag[j]] = [shuffleBag[j], shuffleBag[i]];
        }
      }
      return shuffleBag.pop();
    }
    return (tour.idx + step + SCENES.length) % SCENES.length;
  }
  function invalidateClips() {
    clipValid.fill(0);
  }
  function writeSceneUniforms() {
    path = sceneUniforms(frameF, tour.scene, tour.visit, forestMul());
  }
  function startScene(index) {
    tour.idx = index;
    tour.scene = SCENES[index];
    tour.visit = visits[index]++;
    tour.gen++;
    tour.t = 0;
    tour.state = 'wait';
    tour.fade = 0;
    writeSceneUniforms();
    invalidateClips();
    flight.z = Number(qs.get('z')) || 0;
    flight.off = 0;
    flight.yaw = flightTargetYaw();
    flight.bank = 0;
    flight.yawRate = 0;
    flight.vy = 0;
    flight.y = path.waterLevel(flight.z) + tour.scene.relief * 0.8 + tour.scene.flight.agl;
    cam.x = flightLineX(flight.z);
    cam.z = flight.z;
    cam.y = flight.y;
    groundRef = path.waterLevel(flight.z);
    applySceneSky();
    updateHudScene();
  }
  function requestScene(index) {
    tour.next = index;
    if (tour.state !== 'out') tour.state = 'out';
  }
  const sceneLabel = document.getElementById('scene-label');
  function showSceneLabel() {
    if (!P.sceneLabel) return;
    sceneLabel.replaceChildren(document.createTextNode(tour.scene.name));
    const small = document.createElement('small');
    small.textContent = tour.scene.place;
    sceneLabel.append(small);
    sceneLabel.classList.add('shown');
    tour.labelT = 7;
  }
  function hideSceneLabel() {
    sceneLabel.classList.remove('shown');
    tour.labelT = 0;
  }
  function updateTour(dt) {
    if (tour.state === 'wait') {
      tour.fade = 0;
      if (probeGen === tour.gen) {
        settleFlightAltitude();
        tour.state = shotName ? 'run' : 'in';
        if (shotName) tour.fade = 1;
        showSceneLabel();
      }
    } else if (tour.state === 'in') {
      tour.fade = Math.min(1, tour.fade + dt / 2.5);
      if (tour.fade >= 1) tour.state = 'run';
    } else if (tour.state === 'run') {
      if (P.autopilot) tour.t += dt;
      if (tour.t > P.tourMinutes * 60) requestScene(nextTourIndex());
    } else if (tour.state === 'out') {
      tour.fade = Math.max(0, tour.fade - dt / 1.8);
      if (tour.labelT > 0) hideSceneLabel();
      if (tour.fade <= 0) {
        const next = tour.next >= 0 ? tour.next : nextTourIndex();
        tour.next = -1;
        startScene(next);
      }
    }
    if (tour.labelT > 0) {
      tour.labelT -= dt;
      if (tour.labelT <= 0) hideSceneLabel();
    }
  }

  // --------------------------------------------------------------------------------------
  // Camera & flight
  // --------------------------------------------------------------------------------------
  const cam = { x: 0, y: 500, z: 0, yaw: 0, pitch: -24 * D2R, roll: 0 };
  // Autopilot state: z along the valley, lateral offset from the flight line (eases back to
  // zero after free flight), smoothed heading / bank / altitude, and look-drag offsets.
  const flight = { z: 0, off: 0, yaw: 0, bank: 0, yawRate: 0, y: 500, vy: 0, yTarget: 500, lookYaw: 0, lookPitch: 0 };
  let groundRef = 0;
  let groundUnder = 0;
  const shotName = qs.get('shot');

  function flightLineX(z) {
    const s = tour.scene;
    // a slow sway across the valley keeps one wall, then the other, in the picture
    const sway = (s.floodplain + s.valleyWidth * 0.25) * 0.35 * Math.sin(z * (Math.PI * 2 / 7300) + path.seed * 0.37);
    return path.valleyX(z) + sway;
  }
  function flightTargetYaw() {
    const ahead = 700;
    const za = flight.z - ahead;
    const xa = flightLineX(za) + flight.off * Math.exp(-ahead / 1500);
    const x = flightLineX(flight.z) + flight.off;
    return Math.atan2(xa - x, ahead);
  }
  function flightAgl() {
    return tour.scene.flight.agl * P.flightAltitude * (1 + 0.16 * Math.sin(flight.z * (Math.PI * 2 / 9000) + 1.3));
  }
  // Highest height the camera must hold now so that it clears every probed point ahead with
  // its target clearance by the time it gets there, climbing no steeper than about 1 in 8.
  function requiredAltitude(agl) {
    let need = -Infinity;
    let under = -Infinity, best = Infinity;
    const fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
    for (let i = 0; i < PROBE_N; i++) {
      const dx = probeXZ[i * 2] - cam.x, dz = probeXZ[i * 2 + 1] - cam.z;
      const along = dx * fx + dz * fz;
      const r = Math.hypot(dx, dz);
      if (r < best) { best = r; under = probeH[i]; }
      need = Math.max(need, probeH[i] + agl - Math.max(0, along - 250) * 0.12);
    }
    groundUnder = under;
    return Math.max(need, under + agl * 0.55);
  }
  function settleFlightAltitude() {
    const need = requiredAltitude(flightAgl());
    flight.y = flight.yTarget = need;
    flight.vy = 0;
    cam.y = need;
    groundRef = groundUnder;
  }
  function writeProbes() {
    const fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
    const rx = Math.cos(cam.yaw), rz = Math.sin(cam.yaw);
    for (let i = 0; i < PROBE_N; i++) {
      let x, z;
      if (i < 24) {
        const d = (i - 1) * 130;
        if (P.autopilot && tour.state !== 'out') {
          z = flight.z - d;
          x = flightLineX(z) + flight.off * Math.exp(-d / 1500);
        } else {
          x = cam.x + fx * d; z = cam.z + fz * d;
        }
      } else {
        const k = i - 24;
        const d = [150, 600, 1200, 2000][k >> 1];
        const side = (k & 1 ? 1 : -1) * 300;
        x = cam.x + fx * d + rx * side; z = cam.z + fz * d + rz * side;
      }
      probeQ[i * 4] = x; probeQ[i * 4 + 1] = z;
      probeSentXZ[i * 2] = x; probeSentXZ[i * 2 + 1] = z;
    }
    device.queue.writeBuffer(probeUBO, 0, probeQ);
    probeSentGen = tour.gen;
  }

  const keys = Object.create(null);
  let placeDialog = null;
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.repeat) return;
    if (e.code === 'Escape' && closePlaceDialog()) return;
    if (e.code === 'Escape') setPanelOpen(false);
    if (e.code === 'F1') { e.preventDefault(); showPanel(); }
    if (e.code === 'KeyH') togglePanel();
    if (e.ctrlKey || e.metaKey || e.altKey || shortcutField(e.target)) return;
    if (e.code === 'KeyT') toggleShown('clock');
    if (e.code === 'KeyF') toggleShown('weather');
    if (e.code === 'KeyP') toggleShown('autopilot');
    if (e.code === 'BracketRight') requestScene(nextTourIndex(1));
    if (e.code === 'BracketLeft') requestScene(P.sceneMode === 'tour' ? nextTourIndex(-1) : tour.idx);
  });
  function shortcutField(target) {
    return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
  }
  function toggleShown(key) {
    if (!uiReady) return;
    commitSetting(key, !P[key]);
  }
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  // Hold the left button to look; pressing left + right together resets the view. The chord
  // stays latched until both buttons are up so releasing one of them doesn't resume looking.
  let looking = false, chord = false;
  function setLooking(on) {
    looking = on;
    canvas.classList.toggle('looking', on);
  }
  function resetView() {
    flight.lookYaw = flight.lookPitch = 0;
    if (!P.autopilot) {
      cam.pitch = (tour.scene.flight.pitch + P.cameraTilt) * D2R;
      cam.roll = 0;
    }
  }
  addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    setLooking(false);
    chord = false;
  });
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if ((e.buttons & 3) === 3) {
      chord = true;
      setLooking(false);
      resetView();
    } else if (e.button === 0 && !chord) {
      setLooking(true);
    }
  });
  addEventListener('mouseup', (e) => {
    if (!(e.buttons & 1)) setLooking(false);
    if (!(e.buttons & 3)) chord = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('mousemove', (e) => {
    if (!looking) return;
    if (!(e.buttons & 1)) { setLooking(false); return; }
    if (P.autopilot) {
      flight.lookYaw += e.movementX * 0.0022;
      flight.lookPitch = Math.max(-1.2, Math.min(1.2, flight.lookPitch - e.movementY * 0.0022));
    } else {
      cam.yaw += e.movementX * 0.0022;
      cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - e.movementY * 0.0022));
    }
  });
  addEventListener('wheel', (e) => {
    if (e.target instanceof Element && e.target.closest('#panel, .place-dialog')) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 1 : 100;
    const steps = e.deltaY / unit;
    if (!steps) return;
    const boost = e.shiftKey || keys.ShiftLeft || keys.ShiftRight ? 5 : 1;
    if (P.autopilot) {
      commitSetting('flightAltitude', Math.round((P.flightAltitude * Math.pow(1.06, -steps * boost)) * 100) / 100);
    } else {
      cam.y += -steps * 25 * boost;
    }
  }, { passive: false });

  function updateAutopilot(dt) {
    const s = tour.scene;
    const v = s.flight.speed * P.flightSpeed;
    const slope = path.valleyDX(flight.z);
    flight.z -= v * dt / Math.sqrt(1 + slope * slope);
    flight.off *= Math.exp(-dt / 8);
    const target = flightTargetYaw();
    const prevYaw = flight.yaw;
    flight.yaw += wrapAngle(target - flight.yaw) * Math.min(1, dt * 0.7);
    const rate = dt > 0 ? wrapAngle(flight.yaw - prevYaw) / dt : 0;
    flight.yawRate += (rate - flight.yawRate) * Math.min(1, dt * 1.5);
    // a gimbal-stabilised aerial camera keeps the horizon nearly level: a hint of bank only
    const bankTarget = Math.max(-0.14, Math.min(0.14, Math.atan(v * flight.yawRate / 9.81))) * 0.5;
    flight.bank += (bankTarget - flight.bank) * Math.min(1, dt * 1.2);

    if (probeGen === tour.gen) {
      const need = requiredAltitude(flightAgl());
      flight.yTarget += (need - flight.yTarget) * Math.min(1, dt / 2.5);
      const k = 0.22, c = 2 * Math.sqrt(k);
      flight.vy += ((flight.yTarget - flight.y) * k - flight.vy * c) * dt;
      flight.y += flight.vy * dt;
      // never closer to the ground under the camera than a third of the clearance
      const floor = groundUnder + flightAgl() * 0.35;
      if (flight.y < floor) { flight.y = floor; flight.vy = Math.max(flight.vy, 0); }
    }
    if (!looking) {
      const ease = Math.exp(-dt / 3.5);
      flight.lookYaw *= ease;
      flight.lookPitch *= ease;
    }
    cam.x = flightLineX(flight.z) + flight.off;
    cam.z = flight.z;
    cam.y = flight.y;
    cam.yaw = flight.yaw + flight.lookYaw;
    // gentle nose-down into descents, nose-up into climbs
    const climb = Math.max(-0.08, Math.min(0.08, flight.vy / Math.max(v, 1)));
    cam.pitch = Math.max(-1.5, Math.min(1.2, (s.flight.pitch + P.cameraTilt) * D2R + climb * 0.5 + flight.lookPitch));
    cam.roll = flight.bank;
  }
  function updateFreeFlight(dt) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const str = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const up = (keys.KeyE || keys.Space ? 1 : 0) - (keys.KeyQ || keys.KeyC ? 1 : 0);
    const mx = fwd * cp * sy + str * cy;
    const my = fwd * sp + up;
    const mz = -fwd * cp * cy + str * sy;
    const boost = keys.ShiftLeft || keys.ShiftRight ? 5 : 1;
    const v = 60 * P.flightSpeed * boost * dt;
    cam.x += mx * v; cam.y += my * v; cam.z += mz * v;
    cam.roll *= Math.exp(-dt * 2);
    if (probeGen === tour.gen) {
      requiredAltitude(0);
      if (cam.y < groundUnder + 6) cam.y += (groundUnder + 6 - cam.y) * Math.min(1, dt * 10);
    }
  }
  function enterAutopilot() {
    flight.z = cam.z;
    flight.off = cam.x - flightLineX(cam.z);
    flight.y = flight.yTarget = cam.y;
    flight.vy = 0;
    flight.yaw = cam.yaw;
    flight.lookYaw = 0;
    flight.lookPitch = cam.pitch - (tour.scene.flight.pitch + P.cameraTilt) * D2R;
  }
  function updateCamera(dt) {
    if (P.autopilot) updateAutopilot(dt);
    else updateFreeFlight(dt);
    if (probeGen === tour.gen) groundRef += (groundUnder - groundRef) * Math.min(1, dt * 0.8);
  }

  // --------------------------------------------------------------------------------------
  // Clipmap placement: each level is centred a little ahead of the camera and rebaked when
  // the camera has moved a sixteenth of its span.
  // --------------------------------------------------------------------------------------
  function encodeClips(cp) {
    const fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
    let budget = 3;
    for (let l = 0; l < CLIP_LEVELS; l++) {
      const t = clipTexel(l);
      const span = t * CLIP_RES;
      const snap = t * 16;
      const ox = Math.floor((cam.x + fx * span * 0.22 - span * 0.5) / snap) * snap;
      const oz = Math.floor((cam.z + fz * span * 0.22 - span * 0.5) / snap) * snap;
      const moved = Math.max(Math.abs(ox - clipOrigin[l * 2]), Math.abs(oz - clipOrigin[l * 2 + 1]));
      if (clipValid[l] && (moved < span / 16 || budget <= 0)) continue;
      if (clipValid[l]) budget--;
      clipOrigin[l * 2] = ox; clipOrigin[l * 2 + 1] = oz;
      clipValid[l] = 1;
      bakeF[0] = ox; bakeF[1] = oz; bakeF[2] = t; bakeF[3] = l;
      device.queue.writeBuffer(bakeUBOs[l], 0, bakeF);
      clipF[l * 4] = ox; clipF[l * 4 + 1] = oz; clipF[l * 4 + 2] = t; clipF[l * 4 + 3] = 0;
      cp.setPipeline(clipHeightPipe);
      cp.setBindGroup(0, bgClipHeight[l]);
      cp.dispatchWorkgroups(CLIP_RES / 8, CLIP_RES / 8);
      cp.setPipeline(clipDerivePipe);
      cp.setBindGroup(0, bgClipDerive[l]);
      cp.dispatchWorkgroups(CLIP_RES / 8, CLIP_RES / 8);
    }
    device.queue.writeBuffer(clipUBO, 0, clipF);
  }

  // --------------------------------------------------------------------------------------
  // CDLOD node selection (CPU, allocation free)
  // --------------------------------------------------------------------------------------
  const ranges = new Float64Array(LODS);
  for (let l = 0; l < LODS; l++) ranges[l] = R0 * Math.pow(2, l);
  const planes = new Float64Array(16);
  let nodeCount = 0, ccx = 0, ccy = 0, ccz = 0, yLo = 0, yHi = 0, XB = 0;

  // LOD distance is measured to the ground reference plane, as in the vertex shader morph.
  function sphereHit(x0, z0, size, r) {
    const dx = Math.max(x0 - ccx, 0, ccx - (x0 + size));
    const dz = Math.max(z0 - ccz, 0, ccz - (z0 + size));
    const dy = ccy - groundRef;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }
  function inFrustum(x0, z0, size) {
    const minx = x0 - XB - ccx, maxx = x0 + size + XB - ccx;
    const minz = z0 - XB - ccz, maxz = z0 + size + XB - ccz;
    const miny = yLo - ccy, maxy = yHi - ccy;
    for (let p = 0; p < 16; p += 4) {
      const a = planes[p], b = planes[p + 1], c = planes[p + 2], d = planes[p + 3];
      const px = a > 0 ? maxx : minx, py = b > 0 ? maxy : miny, pz = c > 0 ? maxz : minz;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }
  function addNode(x0, z0, size, lod) {
    if (nodeCount >= MAX_NODES) return;
    const o = nodeCount * 4;
    instData[o] = x0; instData[o + 1] = z0; instData[o + 2] = size; instData[o + 3] = lod;
    nodeCount++;
  }
  function selectNode(x0, z0, size, lod) {
    if (!sphereHit(x0, z0, size, ranges[lod])) return false;
    if (!sphereHit(x0, z0, size, MAX_DIST) || !inFrustum(x0, z0, size)) return true;
    if (lod === 0 || !sphereHit(x0, z0, size, ranges[lod - 1])) { addNode(x0, z0, size, lod); return true; }
    const h = size * 0.5;
    for (let i = 0; i < 4; i++) {
      const nx = x0 + (i & 1) * h, nz = z0 + (i >> 1) * h;
      if (!selectNode(nx, nz, h, lod - 1)) {
        if (sphereHit(nx, nz, h, MAX_DIST) && inFrustum(nx, nz, h)) addNode(nx, nz, h, lod - 1);
      }
    }
    return true;
  }
  function selectAll() {
    nodeCount = 0;
    ccx = cam.x; ccy = cam.y; ccz = cam.z;
    const s = tour.scene;
    const wl = path.waterLevel(cam.z);
    const drift = Math.abs(s.waterSlope) * MAX_DIST;
    // the Earth's curvature drops the far terrain by up to ~1 km
    yLo = wl - 30 - s.basin * s.relief - drift - 1000;
    yHi = wl + s.floor + s.relief * 1.6 + s.height * P.treeHeight * 1.6 + 60 + drift;
    XB = s.spacing;
    // side planes from the camera-relative view-projection (rows 3±0, 3±1)
    const m = viewProj;
    for (let i = 0; i < 4; i++) {
      const r = i >> 1, sg = (i & 1) ? -1 : 1;
      planes[i * 4] = m[3] + sg * m[r];
      planes[i * 4 + 1] = m[7] + sg * m[4 + r];
      planes[i * 4 + 2] = m[11] + sg * m[8 + r];
      planes[i * 4 + 3] = m[15] + sg * m[12 + r];
    }
    const top = LODS - 1;
    const ts = LEAF * Math.pow(2, top);
    const x0 = Math.floor((ccx - MAX_DIST) / ts), x1 = Math.floor((ccx + MAX_DIST) / ts);
    const z0 = Math.floor((ccz - MAX_DIST) / ts), z1 = Math.floor((ccz + MAX_DIST) / ts);
    for (let zi = z0; zi <= z1; zi++) {
      for (let xi = x0; xi <= x1; xi++) selectNode(xi * ts, zi * ts, ts, top);
    }
  }

  // --------------------------------------------------------------------------------------
  // Per-frame uniforms
  // --------------------------------------------------------------------------------------
  let simTime = Number(qs.get('t')) || 0;
  let frameIndex = 0;
  let skyLocation = null;
  let liveSky = null;
  let skyInstant = null;

  function horizonDirection(elevation, azimuth) {
    const e = elevation * D2R, a = azimuth * D2R;
    return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
  }

  // Static (Night) holds the sun below the horizon. Phase is set directly, not from that sun.
  function manualSunElev() {
    return P.skyMode === 'night' ? Math.min(P.sunElev, -12) : P.sunElev;
  }
  // Lit fraction of the disc: 0 when the moon sits on the sun, 1 when it is opposite.
  function staticMoonIllumination() {
    if (P.skyMode === 'night') return P.moonPhase;
    const sun = horizonDirection(manualSunElev(), P.sunAzim);
    const moon = horizonDirection(P.moonElev, P.moonAzim);
    return (1 - (sun[0] * moon[0] + sun[1] * moon[1] + sun[2] * moon[2])) / 2;
  }
  // A light direction whose angle from the moon matches the phase slider.
  // The spare component points toward the horizon, so a crescent's horns point up.
  function nightPhaseLight(moon) {
    const c = 1 - 2 * P.moonPhase;
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    let px = moon[0] * moon[1];
    let py = moon[1] * moon[1] - 1;
    let pz = moon[2] * moon[1];
    const len = Math.hypot(px, py, pz);
    if (len < 1e-4) { px = 1; py = 0; pz = 0; }
    else { px /= len; py /= len; pz /= len; }
    const lx = moon[0] * c + px * s;
    const ly = moon[1] * c + py * s;
    const lz = moon[2] * c + pz * s;
    const n = Math.hypot(lx, ly, lz) || 1;
    return [lx / n, ly / n, lz / n];
  }

  function skyUsesPlace() {
    return P.skyMode === 'dynamic' || P.skyMode === 'dated' || P.skyMode === 'lapse';
  }
  function localDateTimeValue(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  let lapseElapsedMs = 0;
  let lapseMinute = '';
  function parseLocalDateTime(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
    const when = new Date(value);
    return Number.isNaN(when.getTime()) ? null : when;
  }
  function lapseYearMs(start) {
    const end = new Date(start.getTime());
    end.setFullYear(end.getFullYear() + 1);
    return Math.max(60000, end.getTime() - start.getTime());
  }
  function resetTimeLapse() {
    lapseElapsedMs = 0;
    lapseMinute = '';
  }
  function lapseInstant() {
    const start = parseLocalDateTime(P.skyLapseStart);
    if (!start) return null;
    return new Date(start.getTime() + (lapseElapsedMs % lapseYearMs(start)));
  }
  function skyMoment() {
    if (P.skyMode === 'dynamic') return new Date();
    if (P.skyMode === 'lapse') return lapseInstant();
    return parseLocalDateTime(P.skyWhen);
  }
  function advanceTimeLapse(dt) {
    if (P.skyMode !== 'lapse' || dt <= 0) return;
    const pace = Math.max(1, Number(P.lapsePace) || 20);
    lapseElapsedMs += dt * 60000 * pace;
    const instant = lapseInstant();
    if (!instant) return;
    const minute = localDateTimeValue(instant);
    if (minute === lapseMinute) return;
    lapseMinute = minute;
    if (skyLocation) refreshPlacedSky();
    updateSkyReadout();
  }
  function refreshPlacedSky() {
    if (!skyUsesPlace() || !skyLocation) return false;
    const when = skyMoment();
    if (!when) {
      liveSky = skyInstant = null;
      return false;
    }
    liveSky = celestialState(when, skyLocation.latitude, skyLocation.longitude);
    skyInstant = when;
    updateSkyReadout();
    updateDrivenSun();
    updateDrivenMoon();
    return true;
  }
  function refreshDynamicSky() {
    if (P.skyMode === 'dynamic') refreshPlacedSky();
  }
  function weatherSmooth(a, b, v) {
    const x = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return x * x * (3 - 2 * x);
  }
  function showDrivenSetting(key, value) {
    const control = controls.get(key);
    if (typeof DEFAULTS[key] === 'boolean') {
      P[key] = value;
      if (control) {
        control.input.checked = value;
        control.output.textContent = value ? control.onText : control.offText;
      }
      return;
    }
    P[key] = value;
    if (!control) return;
    const step = Number(control.input.step) || 0.01;
    const shown = Math.round(value / step) * step;
    const text = String(Number(shown.toFixed(4)));
    if (control.output.textContent !== text) {
      control.input.value = text;
      control.output.textContent = text;
    }
  }
  // A deterministic, location-dependent weather pattern. Synoptic systems evolve over
  // several simulated days, so Date and time is repeatable and Time lapse advances the
  // weather with its sky instead of running a 25-minute real-time weather cycle.
  function weatherField(when) {
    const hour = when.getHours() + when.getMinutes() / 60 + when.getSeconds() / 3600;
    const sunY = skyUsesPlace() && liveSky ? liveSky.sunDirection[1] : Math.sin(manualSunElev() * D2R);
    const elev = Math.asin(Math.max(-1, Math.min(1, sunY))) / D2R;
    const daylight = weatherSmooth(-6, 10, elev);
    const afternoon = Math.exp(-((hour - 15.2) ** 2) / 12);
    const weatherHours = when.getTime() / 3600000;
    const placePhase = skyLocation
      ? (skyLocation.latitude * 0.73 + skyLocation.longitude * 0.37) * D2R
      : 1.37;
    const wave = (period, phase = 0) => Math.sin(weatherHours * Math.PI * 2 / period + placePhase + phase);
    const moisture = Math.max(0, Math.min(1, 0.48 + 0.30 * wave(92) + 0.16 * wave(37, 1.9)));
    const front = 0.5 + 0.5 * wave(137, -0.8);
    return { elev, daylight, afternoon, wave, moisture, front };
  }
  function updateDynamicClouds() {
    if (P.cloudMode !== 'dynamic') return;
    const when = skyUsesPlace() && skyInstant ? skyInstant : new Date();
    const { elev, daylight, afternoon, wave, moisture, front } = weatherField(when);
    const convection = afternoon * daylight;
    const lowDir = (225 + 65 * wave(121, 0.4) + 25 * wave(43, -1.2) + 360) % 360;
    const lowWind = 3 + 10 * front + 4 * (0.5 + 0.5 * wave(31, 2.3));
    const lowSun = Math.exp(-((elev - 6) ** 2) / 180) * weatherSmooth(-3, 4, elev);
    showDrivenSetting('cloudMotion', true);
    showDrivenSetting('clouds', Math.min(0.92, 0.04 + 0.72 * moisture + 0.16 * convection * (1 - 0.55 * moisture)));
    showDrivenSetting('cloudAltitude', 0.75 + 1.8 * (1 - moisture) + 0.35 * convection);
    showDrivenSetting('cloudScale', 0.75 + 0.65 * (1 - moisture) + 0.25 * convection);
    showDrivenSetting('cloudDensity', 0.8 + 3.4 * moisture + 0.5 * convection);
    showDrivenSetting('cloudWindSpeed', lowWind);
    showDrivenSetting('cloudWindDir', lowDir);
    showDrivenSetting('cloudEvolution', 0.15 + 0.65 * Math.min(1, lowWind / 18) + 0.35 * convection);
    showDrivenSetting('veil', Math.min(0.82, 0.03 + 0.55 * (0.55 * front + 0.45 * moisture)));
    showDrivenSetting('highCloudAltitude', 7 + 3 * (1 - front));
    showDrivenSetting('highCloudScale', 0.75 + 0.7 * (1 - front));
    showDrivenSetting('highCloudDensity', 0.3 + 1.25 * (0.55 * front + 0.45 * moisture));
    showDrivenSetting('highCloudWindSpeed', 18 + 25 * front + 8 * (0.5 + 0.5 * wave(53, 0.7)));
    showDrivenSetting('highCloudWindDir', (lowDir + 24 + 16 * wave(83, 2.5) + 360) % 360);
    showDrivenSetting('cloudSoftness', 0.75 + 0.55 * moisture + 0.15 * (1 - daylight));
    showDrivenSetting('cloudSilver', 0.15 + 1.55 * lowSun);
    showDrivenSetting('cloudAmbient', 0.85 + 0.4 * daylight);
  }
  function updateDynamicStars() {
    if (P.starMode !== 'dynamic') return;
    const sunY = skyUsesPlace() && liveSky ? liveSky.sunDirection[1] : Math.sin(manualSunElev() * D2R);
    const sunElev = Math.asin(Math.max(-1, Math.min(1, sunY))) / D2R;
    const moonY = skyUsesPlace() && liveSky ? liveSky.moonDirection[1] : Math.sin(P.moonElev * D2R);
    const moonElev = Math.asin(Math.max(-1, Math.min(1, moonY))) / D2R;
    const illumination = skyUsesPlace() && liveSky ? liveSky.moonIllumination : staticMoonIllumination();
    const moonUp = P.moon ? weatherSmooth(-1, 30, moonElev) : 0;
    const moonlight = moonUp * Math.max(0, Math.min(1, illumination));
    // A few stars remain in civil twilight; the full catalog needs astronomical darkness.
    const darkness = weatherSmooth(-5, -15, sunElev);
    const clarity = 1 - 0.55 * weatherSmooth(3, 12, P.haze);
    const cover = Math.max(0, Math.min(1, Math.max(P.clouds, P.veil * 0.65)));
    const openSky = (1 - 0.45 * cover) * clarity;
    // Scintillation follows the modeled air motion. Clear air makes it easier to see,
    // while stronger low/high winds and evolving cloud systems imply more turbulence.
    const windShear = Math.abs(P.highCloudWindSpeed - P.cloudWindSpeed);
    const turbulence = Math.max(0, Math.min(1,
      0.45 * Math.min(1, P.cloudEvolution / 1.2)
      + 0.30 * Math.min(1, P.cloudWindSpeed / 18)
      + 0.25 * Math.min(1, windShear / 35)));
    showDrivenSetting('starDensity', Math.min(1, darkness * openSky * (1 - 0.82 * moonlight)));
    showDrivenSetting('starBrightness', Math.min(5, (0.45 + 1.15 * darkness) * (1 - 0.22 * moonlight)));
    showDrivenSetting('starTwinkle', Math.min(2, (0.5 + 0.9 * turbulence) * (0.7 + 0.3 * clarity)));
    showDrivenSetting('nightBrightness', Math.min(4, (0.35 + 0.25 * darkness + 1.7 * moonlight) * (0.65 + 0.35 * clarity)));
    // In an unplaced sky there is no geographic orientation, but Dynamic should still
    // turn the catalogue at the sidereal-day rate instead of hiding a frozen manual seed.
    const when = skyUsesPlace() && skyInstant ? skyInstant : new Date();
    const longitude = skyLocation?.longitude || 0;
    const siderealTurns = when.getTime() / 86164090.5 + longitude / 360;
    showDrivenSetting('starSeed', ((siderealTurns % 1) + 1) % 1 * 1000);
  }

  function writeFrame(time) {
    const aspect = W / H;
    const tanY = Math.tan(P.fov * D2R * 0.5), tanX = tanY * aspect;
    const near = 0.5;
    proj.fill(0);
    proj[0] = 1 / tanX; proj[5] = 1 / tanY; proj[11] = -1; proj[14] = near;
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const fx = cp * sy, fy = sp, fz = -cp * cy;            // forward
    const r0x = cy, r0y = 0, r0z = sy;                       // right before roll
    const u0x = r0y * fz - r0z * fy, u0y = r0z * fx - r0x * fz, u0z = r0x * fy - r0y * fx; // up = right x fwd
    // bank: a positive roll dips the right side, as in a right turn
    const cr = Math.cos(cam.roll), sr = Math.sin(cam.roll);
    const rx = r0x * cr - u0x * sr, ry = r0y * cr - u0y * sr, rz = r0z * cr - u0z * sr;
    const ux = u0x * cr + r0x * sr, uy = u0y * cr + r0y * sr, uz = u0z * cr + r0z * sr;
    view.fill(0);
    view[0] = rx; view[4] = ry; view[8] = rz;
    view[1] = ux; view[5] = uy; view[9] = uz;
    view[2] = -fx; view[6] = -fy; view[10] = -fz;
    view[15] = 1;
    mat4Mul(viewProj, proj, view);
    const f = frameF;
    f.set(viewProj, 0);
    f[16] = cam.x; f[17] = cam.y; f[18] = cam.z; f[19] = time;
    f[20] = rx * tanX; f[21] = ry * tanX; f[22] = rz * tanX; f[23] = 0;
    f[24] = ux * tanY; f[25] = uy * tanY; f[26] = uz * tanY; f[27] = 0;
    f[28] = fx; f[29] = fy; f[30] = fz; f[31] = 0;
    const dynamic = skyUsesPlace() && liveSky;
    const sun = dynamic ? liveSky.sunDirection : horizonDirection(manualSunElev(), P.sunAzim);
    const moon = dynamic ? liveSky.moonDirection : horizonDirection(P.moonElev, P.moonAzim);
    f[32] = sun[0]; f[33] = sun[1]; f[34] = sun[2]; f[35] = 14.0;
    f[36] = W; f[37] = H; f[38] = 1 / W; f[39] = 1 / H;
    f[40] = R0; f[41] = GRID; f[42] = groundRef; f[43] = 0;
    f[44] = P.exposure; f[45] = P.bloom; f[46] = frameIndex; f[47] = DBG;
    const camKm = Math.max(cam.y, 10) * 0.001;
    f[48] = P.haze; f[49] = camKm; f[50] = P.veil; f[51] = 0;
    // the low deck always stays above the aircraft
    f[52] = Math.max(P.cloudAltitude, camKm + 0.6); f[53] = P.clouds; f[54] = P.cloudSoftness; f[55] = P.cloudShadows;
    const day = P.skyMode === 'day';
    const night = P.skyMode === 'night';
    f[56] = moon[0]; f[57] = moon[1]; f[58] = moon[2]; f[59] = !day && P.moon ? P.moonBrightness : 0;
    // Static and placed skies light the moon from the sun. Static (Night) uses the phase slider.
    const light = night && !dynamic ? nightPhaseLight(moon) : sun;
    f[60] = light[0]; f[61] = light[1]; f[62] = light[2]; f[63] = P.moonSize;
    f[64] = !day && P.stars ? P.starDensity : 0; f[65] = P.starBrightness;
    f[66] = P.starTwinkle; f[67] = day ? 0 : P.nightBrightness;
    const pole = dynamic ? liveSky.poleDirection : [0, 1, 0];
    f[68] = pole[0]; f[69] = pole[1]; f[70] = pole[2]; f[71] = 0;
    // Integer kilometres stay exact in the uniform. A single f32 scroll quantizes once a
    // time lapse has carried the clouds far enough, and the field then steps instead of gliding.
    const [lowIx, lowFx] = splitKm(cloudScroll.lowX);
    const [lowIz, lowFz] = splitKm(cloudScroll.lowZ);
    const [highIx, highFx] = splitKm(cloudScroll.highX);
    const [highIz, highFz] = splitKm(cloudScroll.highZ);
    f[72] = lowFx; f[73] = lowFz; f[74] = 0; f[75] = cloudScroll.evolve;
    f[76] = highFx; f[77] = highFz; f[78] = 0; f[79] = P.highCloudScale;
    f[80] = P.cloudScale; f[81] = P.highCloudAltitude; f[82] = P.cloudSoftness; f[83] = 0;
    f[84] = P.cloudDensity; f[85] = P.highCloudDensity;
    f[86] = P.cloudSilver; f[87] = P.cloudAmbient;
    if (dynamic) {
      f[88] = liveSky.equatorialX[0]; f[89] = liveSky.equatorialX[1]; f[90] = liveSky.equatorialX[2]; f[91] = 0;
      f[92] = liveSky.equatorialY[0]; f[93] = liveSky.equatorialY[1]; f[94] = liveSky.equatorialY[2]; f[95] = 0;
    } else {
      const rotation = P.starSeed * 0.001 * Math.PI * 2;
      f[88] = Math.cos(rotation); f[89] = 0; f[90] = Math.sin(rotation); f[91] = 0;
      f[92] = Math.sin(rotation); f[93] = 0; f[94] = -Math.cos(rotation); f[95] = 0;
    }
    frameI[96] = lowIx; frameI[97] = lowIz; frameI[98] = highIx; frameI[99] = highIz;
    // 100..139: the scene (scenes.js)
    device.queue.writeBuffer(frameUBO, 0, f);
  }

  // Integrated advection. Multiplying wind by the clock jumps the field whenever the
  // wind changes. Time lapse advances the sun, moon, and stars by `lapsePace` sky minutes
  // per real second. Cloud drift and shape evolution use that same sky clock; a real-time
  // sky keeps a scale of 1 so wind stays in wall-clock m/s.
  const cloudScroll = { lowX: 0, lowZ: 0, highX: 0, highZ: 0, evolve: 0 };
  // Must match CLOUD_MORPH_WRAP in the cloud shader. Wrapping on a generation boundary
  // keeps the crossfade seamless and the phase exact in f32 over a long time lapse.
  const CLOUD_MORPH_WRAP = 4096;
  // Sky seconds for one high-deck shape generation when cloud evolution is 1.
  // Low cumulus uses a faster integer harmonic of this clock.
  const CLOUD_HIGH_GENERATION_S = 6 * 3600;
  function cloudSkyScale() {
    if (P.skyMode !== 'lapse') return 1;
    const pace = Math.max(1, Number(P.lapsePace) || 20);
    return pace * 60;
  }
  function splitKm(v) {
    const i = Math.floor(v);
    return [i, v - i];
  }
  function advanceCloudMotion(dt) {
    if (!P.cloudMotion || dt <= 0) return;
    const skyDt = dt * cloudSkyScale();
    const low = P.cloudWindDir * D2R;
    const lowSpeed = P.cloudWindSpeed * 0.001;
    cloudScroll.lowX += Math.sin(low) * lowSpeed * skyDt;
    cloudScroll.lowZ += -Math.cos(low) * lowSpeed * skyDt;
    const high = P.highCloudWindDir * D2R;
    const highSpeed = P.highCloudWindSpeed * 0.001;
    cloudScroll.highX += Math.sin(high) * highSpeed * skyDt;
    cloudScroll.highZ += -Math.cos(high) * highSpeed * skyDt;
    cloudScroll.evolve += P.cloudEvolution * skyDt / CLOUD_HIGH_GENERATION_S;
    cloudScroll.evolve %= CLOUD_MORPH_WRAP;
    if (cloudScroll.evolve < 0) cloudScroll.evolve += CLOUD_MORPH_WRAP;
  }

  // --------------------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------------------
  const panel = document.getElementById('panel');
  const settingsBtn = document.getElementById('settings');
  function setPanelOpen(open) {
    panel.classList.toggle('hidden', !open);
    settingsBtn.setAttribute('aria-expanded', String(open));
  }
  function togglePanel() { setPanelOpen(panel.classList.contains('hidden')); }
  function showPanel() { setPanelOpen(true); }
  settingsBtn.addEventListener('click', (event) => { event.stopPropagation(); showPanel(); });
  document.getElementById('close-settings').addEventListener('click', (event) => {
    event.stopPropagation();
    setPanelOpen(false);
  });
  const autopilotBtn = document.getElementById('autopilot');
  autopilotBtn.addEventListener('click', (event) => { event.stopPropagation(); toggleShown('autopilot'); });
  document.getElementById('next-scene').addEventListener('click', (event) => {
    event.stopPropagation();
    requestScene(nextTourIndex(1));
  });
  function applyAutopilotButton() {
    autopilotBtn.setAttribute('aria-pressed', String(P.autopilot));
    autopilotBtn.textContent = P.autopilot ? 'Autopilot' : 'Free flight';
  }
  const panelBody = document.getElementById('panel-body');
  const BOOL_KEYS = new Set(['showButtons', 'showInfo', 'clock', 'clock24h', 'clockSeconds', 'clockDate',
    'weather', 'weatherTemp', 'weatherFeels', 'weatherPrecip', 'weatherHumidity', 'weatherWind', 'weatherForecast', 'weatherAlerts',
    'sceneLabel', 'sceneSky', 'autopilot', 'moon', 'stars', 'cloudMotion']);
  const STRING_KEYS = new Set(['clockStyle', 'clockColor', 'clockPosition', 'weatherZip', 'weatherUnit', 'weatherPosition',
    'sceneMode', 'scene', 'tourOrder',
    'skyMode', 'zipCode', 'skyWhen', 'skyLapseStart', 'cloudMode', 'starMode']);
  const SUN_DRIVEN = ['sunElev', 'sunAzim'];
  const CLOUD_DRIVEN = [
    'cloudMotion', 'cloudWindSpeed', 'cloudWindDir', 'cloudEvolution',
    'cloudScale', 'cloudAltitude', 'clouds', 'cloudDensity',
    'highCloudWindSpeed', 'highCloudWindDir', 'highCloudScale', 'highCloudAltitude',
    'veil', 'highCloudDensity', 'cloudSoftness', 'cloudSilver', 'cloudAmbient',
  ];
  const STAR_DRIVEN = ['starDensity', 'starBrightness', 'starTwinkle', 'starSeed', 'nightBrightness'];
  const MOON_DRIVEN = ['moon', 'moonElev', 'moonAzim', 'moonPhase', 'moonSize', 'moonBrightness'];
  // Scene presets set the sun, haze and cloud deck of each region unless the placed sky or
  // dynamic clouds already own those settings.
  const SCENE_SKY = ['sunElev', 'sunAzim', 'haze', 'clouds', 'cloudAltitude', 'veil'];
  let sunManual = null;
  let cloudManual = null;
  let starManual = null;
  let moonManual = null;
  let sceneSkyManual = null;
  let weatherWidget = null;
  let uiReady = false;
  const SETTINGS_KEY = 'web-scenery-settings-v1';
  const SECTIONS = [
    { title: 'General', groups: [
      { settings: [
        ['showButtons', 'Onscreen buttons', 'toggle', 'Show', 'Hide'],
        ['showInfo', 'Onscreen information', 'toggle', 'Show', 'Hide'],
      ] },
    ] },
    { title: 'Scenery', groups: [
      { title: 'Tour', settings: [
        ['sceneMode', 'Scenes', 'select', [
          ['tour', 'Tour all regions'],
          ['single', 'One region'],
        ]],
        ['scene', 'Region', 'select', SCENES.map((s) => [s.id, s.name])],
        ['tourOrder', 'Order', 'select', [
          ['sequence', 'In sequence'],
          ['shuffle', 'Shuffle'],
        ]],
        ['tourMinutes', 'Minutes per scene', 1, 30, 0.5, 'tour'],
        ['sceneLabel', 'Scene names', 'toggle', 'Show', 'Hide'],
        ['sceneSky', 'Scene sky', 'toggle', 'Preset', 'Manual'],
      ] },
      { title: 'Flight', settings: [
        ['autopilot', 'Autopilot', 'toggle', 'On', 'Off'],
        ['flightSpeed', 'Speed', 0.25, 3, 0.05, 'flight'],
        ['flightAltitude', 'Altitude', 0.4, 3, 0.01, 'flight'],
        ['cameraTilt', 'Camera tilt (deg)', -40, 25, 0.5, 'flight'],
        ['fov', 'Field of view (deg)', 25, 90, 0.5, 'flight'],
      ] },
      { title: 'Landscape', settings: [
        ['forestDensity', 'Forest density', 0, 1.5, 0.01, 'forest'],
        ['treeHeight', 'Tree height', 0.5, 1.6, 0.01, 'scene'],
        ['mist', 'Valley mist', 0, 2, 0.01, 'scene'],
      ] },
      { title: 'Quality', settings: [
        ['renderScale', 'Render scale', 0.5, 1.5, 0.05, 'scale'],
      ] },
    ] },
    { title: 'Widgets', groups: [
      { title: 'Clock', groups: [
        { title: 'Display', settings: [
          ['clock', 'Clock', 'toggle', 'On', 'Off'],
          ['clock24h', '24-hour time', 'toggle', 'On', 'Off'],
          ['clockSeconds', 'Show seconds', 'toggle', 'Show', 'Hide'],
          ['clockDate', 'Show date', 'toggle', 'Show', 'Hide'],
        ] },
        { title: 'Appearance', settings: [
          ['clockStyle', 'Style', 'select', [
            ['modern', 'Modern'],
            ['mono', 'Monospace'],
            ['classic', 'Classic'],
          ]],
          ['clockPosition', 'Position', 'select', [
            ['top-left', 'Top left'],
            ['top-center', 'Top center'],
            ['top-right', 'Top right'],
            ['bottom-left', 'Bottom left'],
            ['bottom-center', 'Bottom center'],
            ['bottom-right', 'Bottom right'],
          ]],
          ['clockSize', 'Size (px)', 32, 144, 1, 'clock'],
          ['clockColor', 'Color', 'color'],
          ['clockOpacity', 'Opacity', 0.2, 1, 0.01, 'clock'],
          ['clockBackground', 'Background', 0, 0.8, 0.01, 'clock'],
        ] },
      ] },
      { title: 'Weather', groups: [
        { title: 'Location and updates', settings: [
          ['weather', 'Weather widget', 'toggle', 'Show', 'Hide'],
          ['weatherZip', 'Location', 'text', 'Seattle, WA'],
          ['weatherRefresh', 'Refresh (minutes)', 5, 60, 5, 'weather'],
          ['weatherUnit', 'Units', 'select', [
            ['fahrenheit', 'Fahrenheit / mph'],
            ['celsius', 'Celsius / km/h'],
          ]],
          ['weatherPosition', 'Position', 'select', [
            ['top-left', 'Top left'],
            ['top-right', 'Top right'],
            ['bottom-left', 'Bottom left'],
            ['bottom-right', 'Bottom right'],
          ]],
        ] },
        { title: 'Information', settings: [
          ['weatherTemp', 'Current temperature', 'toggle', 'Show', 'Hide'],
          ['weatherFeels', 'Feels like', 'toggle', 'Show', 'Hide'],
          ['weatherPrecip', 'Precipitation', 'toggle', 'Show', 'Hide'],
          ['weatherHumidity', 'Humidity', 'toggle', 'Show', 'Hide'],
          ['weatherWind', 'Wind', 'toggle', 'Show', 'Hide'],
          ['weatherForecast', 'Next 3 hours', 'toggle', 'Show', 'Hide'],
          ['weatherAlerts', 'U.S. weather alerts', 'toggle', 'Show', 'Hide'],
        ] },
      ] },
    ] },
    { title: 'Sky', groups: [
      { title: 'Mode', settings: [
        ['skyMode', 'Sky behavior', 'select', [
          ['static', 'Static'],
          ['day', 'Static (Day)'],
          ['night', 'Static (Night)'],
          ['dynamic', 'Dynamic / real-time'],
          ['dated', 'Date and time'],
          ['lapse', 'Time lapse'],
        ]],
        ['zipCode', 'Location', 'text', 'Seattle, WA'],
        ['skyWhen', 'View at', 'datetime'],
        ['skyLapseStart', 'Start at', 'datetime'],
        ['lapsePace', 'Sky minutes per second', 1, 100, 1, 'lapse'],
      ] },
      { title: 'Sun', settings: [
        ['sunElev', 'Sun elevation (deg)', -18, 90, 0.1, ''],
        ['sunAzim', 'Sun azimuth (deg)', -180, 180, 0.5, ''],
      ] },
      { title: 'Moon', settings: [
        ['moon', 'Moon', 'toggle', 'Show', 'Hide'],
        ['moonElev', 'Moon elevation (deg)', -18, 90, 0.1, ''],
        ['moonAzim', 'Moon azimuth (deg)', -180, 180, 0.5, ''],
        ['moonPhase', 'Phase (0 new, 1 full)', 0, 1, 0.01, ''],
        ['moonSize', 'Size (1 = true size)', 0.5, 6, 0.05, ''],
        ['moonBrightness', 'Brightness', 0, 12, 0.1, ''],
      ] },
      { title: 'Stars', settings: [
        ['starMode', 'Star behavior', 'select', [
          ['static', 'Static'],
          ['dynamic', 'Dynamic / real-world'],
        ]],
        ['stars', 'Stars', 'toggle', 'Show', 'Hide'],
        ['starTwinkle', 'Twinkle', 0, 2, 0.01, ''],
      ], groups: [
        { title: 'Appearance', settings: [
          ['starDensity', 'Density', 0, 1, 0.01, ''],
          ['starBrightness', 'Brightness', 0, 5, 0.05, ''],
          ['starSeed', 'Random seed', 0, 9999, 1, ''],
          ['nightBrightness', 'Night sky brightness', 0, 4, 0.05, ''],
        ] },
      ] },
      { title: 'Clouds', settings: [
        ['cloudMode', 'Cloud behavior', 'select', [
          ['static', 'Static'],
          ['dynamic', 'Dynamic / real-world'],
        ]],
        ['cloudShadows', 'Cloud shadows', 0, 1, 0.01, ''],
      ], groups: [
        { title: 'Motion', settings: [
          ['cloudMotion', 'Motion', 'toggle', 'On', 'Off'],
          ['cloudWindSpeed', 'Low wind speed (m/s)', 0, 40, 0.1, ''],
          ['cloudWindDir', 'Low wind direction (deg)', 0, 360, 1, ''],
          ['highCloudWindSpeed', 'High wind speed (m/s)', 0, 80, 0.1, ''],
          ['highCloudWindDir', 'High wind direction (deg)', 0, 360, 1, ''],
          ['cloudEvolution', 'Shape evolution', 0, 2, 0.01, ''],
        ] },
        { title: 'Low clouds', settings: [
          ['clouds', 'Coverage', 0, 1, 0.01, ''],
          ['cloudAltitude', 'Altitude (km)', 0.5, 6, 0.05, ''],
          ['cloudScale', 'Feature scale', 0.4, 3, 0.01, ''],
          ['cloudDensity', 'Optical density', 0.2, 6, 0.05, ''],
        ] },
        { title: 'High clouds', settings: [
          ['veil', 'Coverage', 0, 1, 0.01, ''],
          ['highCloudAltitude', 'Altitude (km)', 4, 14, 0.1, ''],
          ['highCloudScale', 'Feature scale', 0.4, 3, 0.01, ''],
          ['highCloudDensity', 'Optical density', 0.1, 3, 0.05, ''],
        ] },
        { title: 'Lighting', settings: [
          ['cloudSoftness', 'Edge softness', 0.4, 2.5, 0.01, ''],
          ['cloudSilver', 'Silver lining', 0, 2, 0.01, ''],
          ['cloudAmbient', 'Ambient light', 0, 2, 0.01, ''],
        ] },
      ] },
      { title: 'Atmosphere', settings: [
        ['haze', 'Haze', 0.3, 12, 0.1, 'lut'],
        ['exposure', 'Exposure', 0.1, 4, 0.01, ''],
        ['bloom', 'Bloom', 0, 0.3, 0.001, ''],
      ] },
    ] },
  ];
  const RANGES = new Map();
  const CHOICES = new Map();
  function eachSetting(groups, visit) {
    for (const group of groups || []) {
      for (const setting of group.settings || []) visit(setting);
      eachSetting(group.groups, visit);
    }
  }
  for (const section of SECTIONS) eachSetting(section.groups, (setting) => {
    if (setting[2] === 'select') CHOICES.set(setting[0], new Set(setting[3].map((option) => option[0])));
    else if (typeof setting[2] === 'number') RANGES.set(setting[0], [setting[2], setting[3]]);
  });
  function coerceSetting(key, raw) {
    if (BOOL_KEYS.has(key)) return booleanSetting(raw);
    if (CHOICES.has(key)) return CHOICES.get(key).has(raw) ? raw : undefined;
    if (key === 'zipCode' || key === 'weatherZip') {
      const place = acceptedPlace(raw);
      return place || undefined;
    }
    if (key === 'skyWhen' || key === 'skyLapseStart') {
      if (typeof raw !== 'string' || raw.trim() === '') return '';
      const value = raw.trim().slice(0, 16);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
      return Number.isNaN(new Date(value).getTime()) ? undefined : value;
    }
    if (key === 'clockColor') return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : undefined;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return undefined;
    const range = RANGES.get(key);
    return range ? Math.min(range[1], Math.max(range[0], n)) : n;
  }
  function restoreSettings() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { /* unavailable */ }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    for (const key of Object.keys(P)) {
      if (!Object.hasOwn(data, key)) continue;
      const value = coerceSetting(key, data[key]);
      if (value !== undefined) P[key] = value;
    }
  }
  let shareUrlInput = null;
  // ui=0 hides the buttons for that visit only. Keep those overrides out of saved settings.
  const visitOnly = new Set();
  function storedSettingValue(key) {
    if (sceneSkyManual && Object.hasOwn(sceneSkyManual, key)) return sceneSkyManual[key];
    if (sunManual && SUN_DRIVEN.includes(key)) return sunManual[key];
    if (cloudManual && CLOUD_DRIVEN.includes(key)) return cloudManual[key];
    if (starManual && STAR_DRIVEN.includes(key)) return starManual[key];
    if (moonManual && MOON_DRIVEN.includes(key)) return moonManual[key];
    return P[key];
  }
  function settingsSnapshot() {
    const changed = {};
    for (const key of Object.keys(P)) {
      if (visitOnly.has(key)) continue;
      const stored = storedSettingValue(key);
      if (stored !== DEFAULTS[key]) changed[key] = stored;
    }
    return changed;
  }
  function encodeBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
  }
  function decodeBase64Url(value) {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function sharedSettings(raw) {
    if (!raw) return {};
    try {
      const data = JSON.parse(decodeBase64Url(raw));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }
  function shareSettingsUrl() {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    url.searchParams.set('s', encodeBase64Url(JSON.stringify(settingsSnapshot())));
    return url.href;
  }
  function rememberSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsSnapshot()));
    } catch { /* unavailable */ }
    if (shareUrlInput && !shareUrlInput.hidden) shareUrlInput.value = shareSettingsUrl();
  }
  restoreSettings();
  let sharedSettingsFailed = false;
  if (qs.has('s')) {
    const shared = sharedSettings(qs.get('s'));
    if (!shared) sharedSettingsFailed = true;
    else {
      for (const key of Object.keys(DEFAULTS)) P[key] = DEFAULTS[key];
      for (const key of Object.keys(shared)) {
        if (!Object.hasOwn(P, key)) continue;
        const value = coerceSetting(key, shared[key]);
        if (value !== undefined) P[key] = value;
      }
    }
  }
  for (const key of Object.keys(P)) {
    if (!qs.has(key)) continue;
    const value = coerceSetting(key, qs.get(key));
    if (value !== undefined) P[key] = value;
  }
  // ?scene=alpine on its own means "show that region"
  if (qs.has('scene') && !qs.has('sceneMode')) P.sceneMode = 'single';
  if (qs.get('ui') === '0') {
    visitOnly.add('showButtons');
    visitOnly.add('showInfo');
    P.showButtons = P.showInfo = false;
  }
  const controls = new Map();
  const skyReadout = document.getElementById('sky-readout');
  function updateSkyReadout() {
    const show = P.showInfo && P.skyMode === 'lapse' && skyInstant;
    skyReadout.hidden = !show;
    if (!show) return;
    const when = skyInstant.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: !P.clock24h,
    });
    const place = skyLocation?.name || P.zipCode || '';
    const text = place ? `${when} · ${place}` : when;
    if (skyReadout.textContent !== text) skyReadout.textContent = text;
  }
  let hudScene = '';
  function updateHudScene() {
    hudScene = `${tour.scene.name} #${tour.visit + 1}`;
  }
  function applyShowInfo() {
    document.getElementById('hud').style.display = P.showInfo ? '' : 'none';
    updateSkyReadout();
    document.getElementById('toolbar').style.display = P.showButtons ? '' : 'none';
    panel.style.top = P.showButtons ? '50px' : '10px';
    panel.style.maxHeight = P.showButtons ? 'calc(100vh - 60px)' : 'calc(100vh - 20px)';
    placeClock();
  }
  const clockWidget = document.getElementById('clock-widget');
  const clockTime = clockWidget.querySelector('.clock-time');
  const clockDate = clockWidget.querySelector('.clock-date');
  function updateClock() {
    const now = new Date();
    clockTime.textContent = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: P.clockSeconds ? '2-digit' : undefined,
      hour12: !P.clock24h,
    });
    clockDate.textContent = P.clockDate
      ? now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
      : '';
    clockWidget.dateTime = now.toISOString();
  }
  function applyClock() {
    clockWidget.hidden = !P.clock;
    clockWidget.dataset.style = P.clockStyle;
    clockWidget.style.fontSize = P.clockSize + 'px';
    clockWidget.style.color = P.clockColor;
    clockWidget.style.opacity = P.clockOpacity;
    clockWidget.style.backgroundColor = `rgba(11, 15, 20, ${P.clockBackground})`;
    clockWidget.style.textShadow = P.clockBackground < 0.35 ? '0 2px 8px #000c' : 'none';
    updateClock();
    updateSkyReadout();
    placeClock();
  }
  function placeClock() {
    clockWidget.style.top = clockWidget.style.right = clockWidget.style.bottom =
      clockWidget.style.left = clockWidget.style.transform = '';
    const edge = '32px';
    if (P.clockPosition.startsWith('top')) clockWidget.style.top = P.clockPosition === 'top-right' && P.showButtons ? '58px' : edge;
    else clockWidget.style.bottom = edge;
    if (P.clockPosition.endsWith('left')) clockWidget.style.left = edge;
    else if (P.clockPosition.endsWith('right')) clockWidget.style.right = edge;
    else {
      clockWidget.style.left = '50%';
      clockWidget.style.transform = 'translateX(-50%)';
    }
  }
  function setDisclosure(item, open) {
    item.querySelector(':scope > button').setAttribute('aria-expanded', String(open));
    item.querySelector(':scope > div').hidden = !open;
  }
  function addDisclosure(parent, title, kind) {
    const item = document.createElement('div');
    item.className = kind;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = kind + '-toggle';
    button.textContent = title;
    button.setAttribute('aria-expanded', 'false');
    const body = document.createElement('div');
    body.className = kind + '-body';
    body.hidden = true;
    item.append(button, body);
    parent.appendChild(item);
    button.addEventListener('click', () => {
      const willOpen = button.getAttribute('aria-expanded') !== 'true';
      for (const sibling of parent.children) {
        if (sibling.classList.contains(kind)) setDisclosure(sibling, sibling === item && willOpen);
      }
    });
    return body;
  }
  function addSlider(parent, key, label, min, max, step, kind) {
    const row = document.createElement('label');
    const name = document.createElement('span'); name.textContent = label;
    const val = document.createElement('output'); val.textContent = String(P[key]);
    const inp = document.createElement('input');
    Object.assign(inp, { type: 'range', min, max, step, value: P[key] });
    inp.addEventListener('input', () => commitSetting(key, Number(inp.value)));
    row.append(name, inp, val);
    parent.appendChild(row);
    controls.set(key, { input: inp, output: val, row, min, max, kind });
  }
  function addSelect(parent, key, label, options) {
    const row = document.createElement('label');
    row.className = 'select';
    const name = document.createElement('span'); name.textContent = label;
    const inp = document.createElement('select');
    for (const [value, text] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      inp.appendChild(option);
    }
    inp.value = P[key];
    inp.addEventListener('change', () => commitSetting(key, inp.value));
    row.append(name, inp);
    parent.appendChild(row);
    controls.set(key, { input: inp, row, kind: 'string', values: new Set(options.map((o) => o[0])) });
  }
  function addColor(parent, key, label) {
    const row = document.createElement('label');
    row.className = 'color';
    const name = document.createElement('span'); name.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = P[key];
    inp.addEventListener('input', () => commitSetting(key, inp.value));
    row.append(name, inp);
    parent.appendChild(row);
    controls.set(key, { input: inp, row, kind: 'color' });
  }
  function addPlace(parent, key, label) {
    const row = document.createElement('div');
    row.className = 'place';
    const name = document.createElement('span');
    name.textContent = label;
    const display = document.createElement('span');
    display.className = 'place-value';
    display.textContent = P[key];
    display.title = P[key];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'place-pick';
    button.textContent = '...';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-label', `Choose ${label.toLowerCase()}`);
    button.addEventListener('click', () => openPlaceDialog(key));
    let stored = P[key];
    Object.defineProperty(button, 'value', {
      configurable: true,
      get() { return stored; },
      set(next) {
        stored = String(next ?? '');
        display.textContent = stored;
        display.title = stored;
      },
    });
    row.append(name, display, button);
    parent.appendChild(row);
    controls.set(key, { input: button, display, row, kind: 'text' });
  }
  function addDateTime(parent, key, label) {
    const row = document.createElement('label');
    row.className = 'datetime';
    const name = document.createElement('span'); name.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'datetime-local';
    inp.value = P[key];
    inp.addEventListener('change', () => {
      if (!commitSetting(key, inp.value)) {
        inp.value = P[key];
        note('Choose a valid date and time');
      }
    });
    row.append(name, inp);
    parent.appendChild(row);
    controls.set(key, { input: inp, row, kind: 'datetime' });
  }
  function addToggle(parent, key, label, onText, offText) {
    const row = document.createElement('label');
    row.className = 'toggle';
    const name = document.createElement('span'); name.textContent = label;
    const val = document.createElement('output'); val.textContent = P[key] ? onText : offText;
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = P[key];
    inp.addEventListener('change', () => commitSetting(key, inp.checked));
    const choice = document.createElement('span');
    choice.className = 'choice';
    choice.append(inp, val);
    row.append(name, choice);
    parent.appendChild(row);
    controls.set(key, { input: inp, output: val, row, kind: 'bool', onText, offText });
  }
  function addSetting(host, setting) {
    if (setting[2] === 'toggle') addToggle(host, setting[0], setting[1], setting[3], setting[4]);
    else if (setting[2] === 'select') addSelect(host, setting[0], setting[1], setting[3]);
    else if (setting[2] === 'color') addColor(host, setting[0], setting[1]);
    else if (setting[2] === 'text') addPlace(host, setting[0], setting[1]);
    else if (setting[2] === 'datetime') addDateTime(host, setting[0], setting[1]);
    else addSlider(host, ...setting);
  }
  function addGroups(parent, groups, kind) {
    let firstGroup = null;
    for (const group of groups || []) {
      const host = group.title ? addDisclosure(parent, group.title, kind) : parent;
      if (group.title && !firstGroup) firstGroup = host;
      for (const setting of group.settings || []) addSetting(host, setting);
      addGroups(host, group.groups, 'subgroup');
    }
    if (firstGroup) setDisclosure(firstGroup.parentElement, true);
  }
  const sectionBodies = [];
  for (const section of SECTIONS) {
    const body = addDisclosure(panelBody, section.title, 'section');
    sectionBodies.push(body);
    addGroups(body, section.groups, 'group');
    if (section.title === 'General') addShortcuts(body);
  }
  function addShortcuts(parent) {
    const wrap = document.createElement('div');
    wrap.className = 'shortcuts';
    const heading = document.createElement('h3');
    heading.textContent = 'Shortcuts';
    const list = document.createElement('dl');
    for (const [key, action] of [
      ['F1', 'Show settings'],
      ['Esc', 'Close settings'],
      ['H', 'Show or hide settings'],
      ['P', 'Autopilot or free flight'],
      ['[ ]', 'Previous or next scene'],
      ['T', 'Show or hide the clock'],
      ['F', 'Show or hide the weather'],
      ['W A S D', 'Move (free flight)'],
      ['Space or E', 'Move up (free flight)'],
      ['Q or C', 'Move down (free flight)'],
      ['Shift', 'Move five times faster'],
      ['Mouse wheel', 'Altitude'],
      ['Left drag', 'Look around'],
      ['Left and right click', 'Reset the view'],
    ]) {
      const term = document.createElement('dt');
      term.textContent = key;
      const detail = document.createElement('dd');
      detail.textContent = action;
      list.append(term, detail);
    }
    wrap.append(heading, list);
    parent.appendChild(wrap);
  }
  setDisclosure(sectionBodies[0].parentElement, true);

  const io = document.createElement('div');
  io.className = 'io';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.id = 'export-settings';
  exportBtn.textContent = 'Export';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.id = 'import-settings';
  importBtn.textContent = 'Import';
  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.id = 'share-settings';
  shareBtn.textContent = 'Share link';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.id = 'reset-settings';
  resetBtn.textContent = 'Reset to defaults';
  shareUrlInput = document.createElement('input');
  shareUrlInput.type = 'text';
  shareUrlInput.id = 'share-url';
  shareUrlInput.className = 'share-url';
  shareUrlInput.readOnly = true;
  shareUrlInput.hidden = true;
  shareUrlInput.spellcheck = false;
  shareUrlInput.setAttribute('aria-label', 'Share URL');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'import-file';
  fileInput.accept = 'application/json,.json';
  fileInput.hidden = true;
  io.append(exportBtn, importBtn, shareBtn, resetBtn, shareUrlInput, fileInput);
  const status = document.createElement('div');
  status.className = 'status';
  status.setAttribute('role', 'status');
  panelBody.append(io, status);

  let statusToken = 0;
  function note(text) {
    status.textContent = text;
    const token = ++statusToken;
    setTimeout(() => { if (token === statusToken) status.textContent = ''; }, 4000);
  }
  weatherWidget = createWeatherWidget(document.getElementById('weather-widget'), note, () => {});
  document.getElementById('weather-widget').addEventListener('click', (event) => {
    if (event.target.closest('.weather-place')) openPlaceDialog('weatherZip');
  });
  function applyWeather(fetchNow = false) {
    weatherWidget.update(P, fetchNow);
  }
  let geoRequest = 0;
  function applyCloudMode() {
    const dynamic = P.cloudMode === 'dynamic';
    if (dynamic && !cloudManual) {
      cloudManual = {};
      for (const key of CLOUD_DRIVEN) cloudManual[key] = P[key];
    }
    if (!dynamic && cloudManual) {
      for (const key of CLOUD_DRIVEN) showDrivenSetting(key, cloudManual[key]);
      cloudManual = null;
    }
    for (const key of CLOUD_DRIVEN) setSettingLocked(key, dynamic);
    refreshModeGroups();
    if (dynamic) updateDynamicClouds();
    applySceneSky();
  }
  function refreshStarControls() {
    const day = P.skyMode === 'day';
    const manual = P.starMode !== 'dynamic';
    const keys = ['starMode', 'stars', ...STAR_DRIVEN];
    if (day) {
      for (const key of keys) setSettingVisible(key, false);
    } else {
      setSettingVisible('starMode', true);
      setSettingVisible('stars', true);
      for (const key of STAR_DRIVEN) {
        // A placed sky uses the real catalogue orientation, so a static seed has nothing to set.
        if (key === 'starSeed' && manual && skyUsesPlace()) setSettingVisible(key, false);
        else setSettingLocked(key, !manual);
      }
    }
    refreshModeGroups();
  }
  function applyStarMode() {
    const dynamic = P.starMode === 'dynamic';
    if (dynamic && !starManual) {
      starManual = {};
      for (const key of STAR_DRIVEN) starManual[key] = P[key];
    }
    if (!dynamic && starManual) {
      for (const key of STAR_DRIVEN) showDrivenSetting(key, starManual[key]);
      starManual = null;
    }
    refreshStarControls();
    if (dynamic) updateDynamicStars();
  }
  function setSettingVisible(key, visible) {
    const control = controls.get(key);
    if (!control?.row) return;
    control.row.hidden = !visible;
    control.input.disabled = !visible;
    control.row.classList.toggle('disabled', !visible);
    if (control.input.required !== undefined) control.input.required = visible;
  }
  function refreshModeGroups() {
    const items = [...panelBody.querySelectorAll('.subgroup, .group')].reverse();
    for (const item of items) {
      const body = item.querySelector(':scope > div');
      item.hidden = ![...body.children].some((child) => !child.hidden);
    }
  }
  function wrapSigned(deg) {
    return ((deg + 180) % 360 + 360) % 360 - 180;
  }
  // Placed sky modes own the sun and the moon. Position and phase follow the place and
  // time, and the disc stays at the picture-frame size and brightness.
  function updateDrivenSun() {
    if (!skyUsesPlace() || !liveSky) return;
    const latitude = skyLocation ? skyLocation.latitude : 0;
    showDrivenSetting('sunElev', liveSky.sunAltitude);
    showDrivenSetting('sunAzim', wrapSigned(liveSky.sunAzimuth + (latitude >= 0 ? 180 : 0)));
  }
  function updateDrivenMoon() {
    if (!skyUsesPlace() || !liveSky) return;
    const latitude = skyLocation ? skyLocation.latitude : 0;
    showDrivenSetting('moon', true);
    showDrivenSetting('moonElev', liveSky.moonAltitude);
    showDrivenSetting('moonAzim', wrapSigned(liveSky.moonAzimuth + (latitude >= 0 ? 180 : 0)));
    showDrivenSetting('moonPhase', liveSky.moonIllumination);
    showDrivenSetting('moonSize', DEFAULTS.moonSize);
    showDrivenSetting('moonBrightness', DEFAULTS.moonBrightness);
  }
  function setSettingLocked(key, locked) {
    const control = controls.get(key);
    if (!control?.row) return;
    control.row.hidden = false;
    control.input.disabled = locked;
    control.row.classList.toggle('disabled', locked);
  }
  // Something other than the scene preset owns this setting.
  function skyKeyOwned(key) {
    if (SUN_DRIVEN.includes(key)) return skyUsesPlace();
    if (CLOUD_DRIVEN.includes(key)) return P.cloudMode === 'dynamic';
    return false;
  }
  function applySceneSky() {
    if (!uiReady) return;
    if (P.sceneSky && !sceneSkyManual) {
      sceneSkyManual = {};
      for (const key of SCENE_SKY) sceneSkyManual[key] = storedSettingValue(key);
    }
    if (!P.sceneSky && sceneSkyManual) {
      const saved = sceneSkyManual;
      sceneSkyManual = null;
      for (const key of SCENE_SKY) if (!skyKeyOwned(key)) showDrivenSetting(key, saved[key]);
      needLUT = true;
    }
    const sky = tour.scene.sky;
    for (const key of SCENE_SKY) {
      const owned = skyKeyOwned(key);
      if (P.sceneSky && !owned && Math.abs(P[key] - sky[key]) > 1e-6) {
        showDrivenSetting(key, sky[key]);
        if (key === 'haze') needLUT = true;
      }
      if (SUN_DRIVEN.includes(key) && P.skyMode === 'night') continue;
      setSettingLocked(key, owned || P.sceneSky);
    }
    refreshModeGroups();
  }
  function applySunControls() {
    const placed = skyUsesPlace();
    if (placed && !sunManual) {
      sunManual = {};
      for (const key of SUN_DRIVEN) sunManual[key] = P[key];
    }
    if (!placed && sunManual) {
      for (const key of SUN_DRIVEN) showDrivenSetting(key, sunManual[key]);
      sunManual = null;
    }
    const night = P.skyMode === 'night';
    if (night) {
      for (const key of SUN_DRIVEN) setSettingVisible(key, false);
    } else {
      for (const key of SUN_DRIVEN) setSettingLocked(key, placed);
      if (placed) updateDrivenSun();
    }
    refreshModeGroups();
  }
  function applyMoonControls() {
    const placed = skyUsesPlace();
    if (placed && !moonManual) {
      moonManual = {};
      for (const key of MOON_DRIVEN) moonManual[key] = P[key];
    }
    if (!placed && moonManual) {
      for (const key of MOON_DRIVEN) showDrivenSetting(key, moonManual[key]);
      moonManual = null;
    }
    const day = P.skyMode === 'day';
    if (day) {
      for (const key of MOON_DRIVEN) setSettingVisible(key, false);
    } else {
      for (const key of MOON_DRIVEN) setSettingLocked(key, placed);
      // Static derives phase from the sun. Night hides the sun, so the phase slider is the control.
      if (!placed) setSettingVisible('moonPhase', P.skyMode === 'night');
      if (placed) updateDrivenMoon();
    }
    refreshModeGroups();
  }
  function applySkyMode(resolveLocation = false) {
    const placed = skyUsesPlace();
    const dated = P.skyMode === 'dated';
    const lapse = P.skyMode === 'lapse';
    applySunControls();
    applyMoonControls();
    setSettingVisible('zipCode', placed);
    setSettingVisible('skyWhen', dated);
    setSettingVisible('skyLapseStart', lapse);
    setSettingVisible('lapsePace', lapse);
    if (lapse) resetTimeLapse();
    if (dated && !P.skyWhen) {
      P.skyWhen = localDateTimeValue();
      const when = controls.get('skyWhen');
      if (when) when.input.value = P.skyWhen;
      if (resolveLocation) rememberSettings();
    }
    refreshStarControls();
    if (!placed) liveSky = skyInstant = null;
    else if (resolveLocation) resolveZipCode();
    applySceneSky();
  }
  function applySceneControls() {
    const single = P.sceneMode !== 'tour';
    setSettingVisible('scene', single);
    setSettingVisible('tourOrder', !single);
    refreshModeGroups();
  }
  async function resolveZipCode() {
    const query = P.zipCode;
    if (!skyUsesPlace()) return;
    if (P.skyMode === 'dated' && !skyMoment()) {
      skyLocation = liveSky = skyInstant = null;
      note('Choose the date and time to view');
      return;
    }
    const request = ++geoRequest;
    try {
      const location = await resolvePlace(query);
      if (request !== geoRequest || !skyUsesPlace() || P.zipCode !== query) return;
      skyLocation = location;
      if (!refreshPlacedSky()) return;
      const when = P.skyMode === 'dated' ? ` at ${P.skyWhen.replace('T', ' ')}`
        : P.skyMode === 'lapse' ? ` from ${P.skyLapseStart.replace('T', ' ')}` : '';
      note(`${location.name || query}${when}`);
    } catch (error) {
      if (request !== geoRequest) return;
      skyLocation = liveSky = skyInstant = null;
      note(error.message || 'Could not find that place');
    }
  }
  async function refreshPlaceLabel(key) {
    const control = controls.get(key);
    if (!control?.display) return;
    const query = P[key];
    try {
      const place = await resolvePlace(query);
      if (P[key] !== query) return;
      control.display.textContent = place.name || query;
      control.display.title = place.name || query;
    } catch {
      if (P[key] !== query) return;
      control.display.textContent = query;
      control.display.title = query;
    }
  }
  placeDialog = document.createElement('div');
  placeDialog.className = 'place-dialog';
  placeDialog.hidden = true;
  const placeSheet = document.createElement('div');
  placeSheet.className = 'sheet';
  placeSheet.setAttribute('role', 'dialog');
  placeSheet.setAttribute('aria-modal', 'true');
  const placeTitle = document.createElement('h2');
  placeTitle.id = 'place-dialog-title';
  placeSheet.setAttribute('aria-labelledby', placeTitle.id);
  const placeInput = document.createElement('input');
  placeInput.type = 'text';
  placeInput.maxLength = 80;
  placeInput.spellcheck = false;
  placeInput.autocomplete = 'off';
  placeInput.placeholder = 'Toledo';
  placeInput.setAttribute('aria-label', 'Location search');
  const placeChoices = document.createElement('div');
  placeChoices.className = 'choices';
  placeChoices.setAttribute('role', 'listbox');
  const placeHintLine = document.createElement('p');
  placeHintLine.className = 'hint';
  const placeActions = document.createElement('div');
  placeActions.className = 'actions';
  const placeCancel = document.createElement('button');
  placeCancel.type = 'button';
  placeCancel.textContent = 'Cancel';
  placeActions.append(placeCancel);
  const placeSearch = document.createElement('div');
  placeSearch.className = 'search';
  placeSearch.append(placeInput, placeChoices, placeHintLine, placeActions);
  const placeConfirm = document.createElement('div');
  placeConfirm.className = 'confirm';
  placeConfirm.hidden = true;
  const placeAsk = document.createElement('p');
  const placeConfirmActions = document.createElement('div');
  placeConfirmActions.className = 'actions';
  const placeNo = document.createElement('button');
  placeNo.type = 'button';
  placeNo.textContent = 'No';
  const placeYes = document.createElement('button');
  placeYes.type = 'button';
  placeYes.className = 'yes';
  placeYes.textContent = 'Yes';
  placeConfirmActions.append(placeNo, placeYes);
  placeConfirm.append(placeAsk, placeConfirmActions);
  placeSheet.append(placeTitle, placeSearch, placeConfirm);
  placeDialog.append(placeSheet);
  document.body.append(placeDialog);
  const placeKeys = ['weatherZip', 'zipCode'];
  let placeDialogKey = '';
  let suggestToken = 0;
  let suggestTimer = 0;
  let pendingChoice = null;
  let pendingOthers = [];
  function placeSettingName(key) {
    return key === 'weatherZip' ? 'the weather location' : 'the sky location';
  }
  function placeMatchesChoice(key, choice) {
    const shown = (controls.get(key)?.display?.textContent || '').trim();
    const stored = String(P[key] || '').trim();
    const names = [choice.value, choice.name, choice.label].map((item) => String(item || '').trim()).filter(Boolean);
    return names.includes(stored) || names.includes(shown);
  }
  function showPlaceSearch() {
    pendingChoice = null;
    pendingOthers = [];
    placeConfirm.hidden = true;
    placeSearch.hidden = false;
  }
  function showPlaceConfirm(choice, others) {
    pendingChoice = choice;
    pendingOthers = others;
    const placeName = choice.name || choice.value;
    const names = others.map(placeSettingName);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    placeTitle.textContent = 'Other locations';
    placeAsk.textContent = `Also use ${placeName} for ${list}?`;
    placeSearch.hidden = true;
    placeConfirm.hidden = false;
    suggestToken += 1;
    placeYes.focus();
  }
  function applyPlaceToOthers() {
    const choice = pendingChoice;
    const others = pendingOthers;
    for (const key of others) {
      if (choice && !commitSetting(key, choice.value)) note('That place could not be saved');
    }
    closePlaceDialog();
  }
  function closePlaceDialog() {
    if (!placeDialog || placeDialog.hidden) return false;
    placeDialog.hidden = true;
    suggestToken += 1;
    showPlaceSearch();
    const opener = controls.get(placeDialogKey)?.input;
    if (opener) opener.focus();
    return true;
  }
  function selectedChoice() {
    return placeChoices.querySelector('.place-choice[aria-selected="true"]');
  }
  function selectChoice(button) {
    for (const choice of placeChoices.querySelectorAll('.place-choice')) {
      choice.setAttribute('aria-selected', choice === button ? 'true' : 'false');
    }
    button?.scrollIntoView({ block: 'nearest' });
  }
  function chooseListedPlace(button) {
    const choice = button?.placeChoice;
    if (!choice || !placeDialogKey) return;
    rememberChoice(choice);
    if (!commitSetting(placeDialogKey, choice.value)) {
      note('That place could not be saved');
      return;
    }
    const others = placeKeys.filter((key) => key !== placeDialogKey && !placeMatchesChoice(key, choice));
    if (others.length) showPlaceConfirm(choice, others);
    else closePlaceDialog();
  }
  function renderPlaceChoices(choices) {
    placeChoices.replaceChildren();
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'place-choice';
      button.setAttribute('role', 'option');
      button.textContent = choice.label;
      button.placeChoice = choice;
      button.addEventListener('click', () => chooseListedPlace(button));
      placeChoices.append(button);
    }
    selectChoice(placeChoices.querySelector('.place-choice'));
  }
  async function searchPlaceDialog() {
    const query = placeInput.value.trim();
    const token = ++suggestToken;
    if (query.length < 2) {
      placeChoices.replaceChildren();
      placeHintLine.textContent = 'Type a city, such as Toledo';
      return;
    }
    placeHintLine.textContent = 'Searching…';
    placeChoices.replaceChildren();
    try {
      const choices = await suggestPlaces(query);
      if (token !== suggestToken || placeDialog.hidden) return;
      renderPlaceChoices(choices);
      placeHintLine.textContent = choices.length ? 'Choose a place' : 'No matching places';
    } catch (error) {
      if (token !== suggestToken || placeDialog.hidden) return;
      placeChoices.replaceChildren();
      placeHintLine.textContent = error.message || 'Could not search for that place';
    }
  }
  function openPlaceDialog(key) {
    placeDialogKey = key;
    placeTitle.textContent = key === 'weatherZip' ? 'Weather location' : 'Sky location';
    const shown = controls.get(key)?.display?.textContent || P[key];
    placeInput.value = shown;
    placeChoices.replaceChildren();
    placeHintLine.textContent = shown.trim().length < 2 ? 'Type a city, such as Toledo' : 'Searching…';
    showPlaceSearch();
    placeDialog.hidden = false;
    placeInput.focus();
    placeInput.select();
    searchPlaceDialog();
  }
  placeInput.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(searchPlaceDialog, 250);
  });
  placeInput.addEventListener('keydown', (event) => {
    const buttons = [...placeChoices.querySelectorAll('.place-choice')];
    const current = buttons.indexOf(selectedChoice());
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!buttons.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      selectChoice(buttons[(current + step + buttons.length) % buttons.length]);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseListedPlace(selectedChoice() || buttons[0]);
    }
  });
  placeCancel.addEventListener('click', closePlaceDialog);
  placeNo.addEventListener('click', closePlaceDialog);
  placeYes.addEventListener('click', applyPlaceToOthers);
  placeDialog.addEventListener('click', (event) => {
    if (event.target === placeDialog) closePlaceDialog();
  });
  placeDialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePlaceDialog();
  });
  function commitSetting(key, value) {
    if (!Object.hasOwn(P, key)) return false;
    visitOnly.delete(key);
    const control = controls.get(key);
    if (BOOL_KEYS.has(key)) {
      if (typeof value !== 'boolean') return false;
      P[key] = value;
      if (control) {
        control.input.checked = value;
        control.output.textContent = value ? control.onText : control.offText;
      }
      if (key === 'showInfo' || key === 'showButtons') applyShowInfo();
      if (key.startsWith('clock')) applyClock();
      if (key.startsWith('weather')) applyWeather();
      if (key === 'autopilot') {
        if (value) enterAutopilot();
        applyAutopilotButton();
      }
      if (key === 'sceneSky') applySceneSky();
      if (key === 'sceneLabel' && !value) hideSceneLabel();
      keepManualSetting(key);
      rememberSettings();
      return true;
    }
    if (STRING_KEYS.has(key)) {
      value = coerceSetting(key, value);
      if (value === undefined) return false;
      const prev = P[key];
      P[key] = value;
      if (control) control.input.value = value;
      if (key.startsWith('clock')) applyClock();
      if (key.startsWith('weather')) applyWeather(key === 'weatherZip' || key === 'weatherUnit');
      if (key === 'zipCode' || key === 'weatherZip') refreshPlaceLabel(key);
      if (key === 'skyMode') applySkyMode(true);
      if (key === 'cloudMode') applyCloudMode();
      if (key === 'starMode') applyStarMode();
      if (key === 'sceneMode') {
        applySceneControls();
        if (value === 'single' && tour.scene.id !== P.scene) requestScene(sceneIndex(P.scene));
      }
      if (key === 'scene' && value !== prev && P.sceneMode !== 'tour') requestScene(sceneIndex(value));
      if (key === 'skyLapseStart') resetTimeLapse();
      if (key === 'zipCode' || key === 'skyWhen' || key === 'skyLapseStart') resolveZipCode();
      keepManualSetting(key);
      rememberSettings();
      return true;
    }
    if (!Number.isFinite(value)) return false;
    if (control && control.kind !== 'bool') {
      value = Math.min(control.max, Math.max(control.min, value));
      control.input.value = String(value);
      value = Number(control.input.value);
      control.output.textContent = control.input.value;
    }
    P[key] = value;
    const kind = control ? control.kind : '';
    if (kind === 'lut') needLUT = true;
    if (kind === 'clock') applyClock();
    if (kind === 'weather') applyWeather();
    if (kind === 'scene' || kind === 'forest') writeSceneUniforms();
    // tree density is baked into the clipmap masks
    if (kind === 'forest') invalidateClips();
    if (kind === 'scale') resize();
    keepManualSetting(key);
    rememberSettings();
    return true;
  }
  function keepManualSetting(key) {
    if (sunManual && SUN_DRIVEN.includes(key)) sunManual[key] = P[key];
    if (cloudManual && CLOUD_DRIVEN.includes(key)) cloudManual[key] = P[key];
    if (starManual && STAR_DRIVEN.includes(key)) starManual[key] = P[key];
    if (moonManual && MOON_DRIVEN.includes(key)) moonManual[key] = P[key];
    if (skyUsesPlace() && SUN_DRIVEN.includes(key)) updateDrivenSun();
    if (skyUsesPlace() && MOON_DRIVEN.includes(key)) updateDrivenMoon();
    if (P.cloudMode === 'dynamic' && CLOUD_DRIVEN.includes(key)) updateDynamicClouds();
    if (P.starMode === 'dynamic' && STAR_DRIVEN.includes(key)) updateDynamicStars();
  }
  function booleanSetting(raw) {
    if (typeof raw === 'boolean') return raw;
    if (raw === 1 || raw === 0) return Boolean(raw);
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim().toLowerCase();
    if (value === '1' || value === 'true' || value === 'on') return true;
    if (value === '0' || value === 'false' || value === 'off') return false;
    return undefined;
  }
  function exportSettings() {
    const exported = {};
    for (const key of Object.keys(P)) exported[key] = storedSettingValue(key);
    const blob = new Blob([JSON.stringify(exported, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scenery-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    note('Exported settings');
  }
  function importSettings(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      note('Settings file must be a JSON object');
      return;
    }
    let count = 0;
    for (const key of Object.keys(P)) {
      if (!Object.hasOwn(data, key)) continue;
      const value = BOOL_KEYS.has(key) ? booleanSetting(data[key])
        : STRING_KEYS.has(key) ? data[key] : Number(data[key]);
      if (commitSetting(key, value)) count++;
    }
    note(count ? `Imported ${count} setting${count === 1 ? '' : 's'}` : 'No recognized settings');
  }
  function resetAll() {
    sunManual = null;
    cloudManual = null;
    starManual = null;
    moonManual = null;
    sceneSkyManual = null;
    for (const key of Object.keys(DEFAULTS)) commitSetting(key, DEFAULTS[key]);
    resetView();
    note('Reset to defaults');
  }
  exportBtn.addEventListener('click', exportSettings);
  importBtn.addEventListener('click', () => fileInput.click());
  shareBtn.addEventListener('click', async () => {
    const url = shareSettingsUrl();
    shareUrlInput.hidden = false;
    shareUrlInput.value = url;
    shareUrlInput.focus();
    shareUrlInput.select();
    try {
      await navigator.clipboard.writeText(url);
      note('Share link copied');
    } catch {
      note('Share link selected');
    }
  });
  shareUrlInput.addEventListener('focus', () => shareUrlInput.select());
  shareUrlInput.addEventListener('click', () => shareUrlInput.select());
  resetBtn.addEventListener('click', resetAll);
  if (sharedSettingsFailed) {
    const shareError = document.createElement('div');
    shareError.className = 'status';
    shareError.textContent = 'Could not read the shared settings';
    status.insertAdjacentElement('afterend', shareError);
  }
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      importSettings(JSON.parse(text));
    } catch {
      note('Could not read that settings file');
    } finally {
      fileInput.value = '';
    }
  });

  // first scene
  startScene(P.sceneMode === 'tour' ? (qs.has('scene') ? sceneIndex(P.scene) : 0) : sceneIndex(P.scene));
  uiReady = true;
  applyShowInfo();
  applyClock();
  applyAutopilotButton();
  applySceneControls();
  applyCloudMode();
  applyStarMode();
  applyWeather(true);
  applySkyMode();
  if (skyUsesPlace()) resolveZipCode();
  refreshPlaceLabel('zipCode');
  refreshPlaceLabel('weatherZip');
  setInterval(updateClock, 250);
  setInterval(refreshDynamicSky, 30000);

  if (qs.get('ui') === '0') {
    document.getElementById('hud').style.display = 'none';
    document.getElementById('toolbar').style.display = 'none';
    panel.classList.add('hidden');
  }

  const hudFps = document.getElementById('fps');

  // --------------------------------------------------------------------------------------
  // Frame
  // --------------------------------------------------------------------------------------
  const submitList = [null];
  const shotFrames = Number(qs.get('frames')) || 240;
  const shotSeq = Number(qs.get('seq')) || 1;
  let shotIdx = 0;
  const fixedDt = shotName ? 1 / 60 : 0;
  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, fpsT = 0;
  let shooting = false;

  function frame(now) {
    if (shooting) return;  // paused while a screenshot is read back
    requestAnimationFrame(frame);
    resize();
    let dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsAcc += dt; fpsN++; fpsT += dt;
    if (fpsT > 0.5) {
      const fps = fpsN / fpsAcc;
      hudFps.textContent = `${hudScene}  |  ${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(2)} ms` +
        (hasTS ? `  |  GPU ${gpuMs.toFixed(2)} ms` : '') + `  |  ${nodeCount} nodes  ${W}x${H}` +
        `  |  alt ${cam.y.toFixed(0)} m  agl ${(cam.y - groundUnder).toFixed(0)} m`;
      fpsAcc = 0; fpsN = 0; fpsT = 0;
    }
    advanceTimeLapse(dt);
    updateDynamicClouds();
    updateDynamicStars();
    if (fixedDt) dt = fixedDt;
    advanceCloudMotion(dt);
    updateTour(dt);
    updateCamera(dt);
    simTime += dt;
    if (simTime > 4096) simTime -= 4096;
    frameIndex++;

    writeFrame(simTime);
    selectAll();
    if (nodeCount) device.queue.writeBuffer(instBuf, 0, instData, 0, nodeCount * 4);

    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass(computeDesc);
    if (needLUT) {
      atmoF[0] = P.haze;
      device.queue.writeBuffer(atmoUBO, 0, atmoF);
      cp.setPipeline(transPipe);
      cp.setBindGroup(0, bgTrans);
      cp.dispatchWorkgroups(256 / 8, 64 / 8);
      cp.setPipeline(msPipe);
      cp.setBindGroup(0, bgMS);
      cp.dispatchWorkgroups(32 / 8, 32 / 8);
      needLUT = false;
    }
    encodeClips(cp);
    let doProbe = false;
    if (!probePending) {
      writeProbes();
      cp.setPipeline(probePipe);
      cp.setBindGroup(0, bgProbe);
      cp.dispatchWorkgroups(1);
      doProbe = true;
    }
    cp.setPipeline(skyViewPipe);
    cp.setBindGroup(0, bgSkyView);
    cp.dispatchWorkgroups(Math.ceil(SKY_W / 8), Math.ceil(SKY_H / 8));
    cp.setPipeline(apPipe);
    cp.setBindGroup(0, bgAP);
    cp.dispatchWorkgroups(Math.ceil(AP_RES / 8), Math.ceil(AP_RES / 8));
    cp.end();

    const rp = enc.beginRenderPass(mainPass);
    if (nodeCount) {
      rp.setPipeline(landPipe);
      rp.setBindGroup(0, bgLand);
      rp.setVertexBuffer(0, instBuf);
      rp.setIndexBuffer(idxBuf, 'uint16');
      rp.drawIndexed(GRID * GRID * 6, nodeCount);
    }
    rp.setPipeline(skyPipe);
    rp.setBindGroup(0, bgSky);
    rp.draw(3);
    rp.end();

    for (let m = 0; m < BLOOM_LEVELS; m++) {
      const p = enc.beginRenderPass(downPasses[m]);
      p.setPipeline(downPipe);
      p.setBindGroup(0, downBGs[m]);
      p.draw(3);
      p.end();
    }
    for (let i = 0; i < upPasses.length; i++) {
      const p = enc.beginRenderPass(upPasses[i]);
      p.setPipeline(upPipe);
      p.setBindGroup(0, upBGs[i]);
      p.draw(3);
      p.end();
    }

    const fade = tour.fade * tour.fade * (3 - 2 * tour.fade);
    compData[0] = P.exposure * fade; compData[1] = P.bloom; compData[2] = frameIndex % 64; compData[3] = 0.10;
    compData[4] = 1.04; compData[5] = 1.05; compData[6] = 0.0; compData[7] = 0;
    device.queue.writeBuffer(compUBO, 0, compData);
    const swapTex = ctx.getCurrentTexture();
    compPass.colorAttachments[0].view = swapTex.createView();
    const pc = enc.beginRenderPass(compPass);
    pc.setPipeline(compPipe);
    pc.setBindGroup(0, bgComp);
    pc.draw(3);
    pc.end();

    if (doProbe) enc.copyBufferToBuffer(probeOut, 0, probeRead, 0, PROBE_N * 4);
    let doTs = false;
    if (hasTS && !tsPending && (frameIndex & 7) === 0) {
      enc.resolveQuerySet(tsQuery, 0, 2, tsResolve, 0);
      enc.copyBufferToBuffer(tsResolve, 0, tsRead, 0, 16);
      doTs = true;
    }
    let readBuf = null;
    if (shotName && shotIdx < shotSeq && tour.state === 'run' && frameIndex >= shotFrames + shotIdx) {
      shooting = true;
      const bpr = Math.ceil(W * 4 / 256) * 256;
      readBuf = device.createBuffer({ size: bpr * H, usage: GU.MAP_READ | GU.COPY_DST });
      enc.copyTextureToBuffer({ texture: swapTex }, { buffer: readBuf, bytesPerRow: bpr }, [W, H]);
    }
    submitList[0] = enc.finish();
    device.queue.submit(submitList);
    if (doProbe) { probePending = true; probeRead.mapAsync(GPUMapMode.READ).then(onProbe, onProbeFail); }
    if (doTs) { tsPending = true; tsRead.mapAsync(GPUMapMode.READ).then(onTsMapped, onTsFail); }
    if (readBuf) saveShot(readBuf, Math.ceil(W * 4 / 256) * 256);
  }

  async function saveShot(buf, bpr) {
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const img = new ImageData(W, H);
    const bgra = swapFormat === 'bgra8unorm';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = y * bpr + x * 4, d = (y * W + x) * 4;
        img.data[d] = src[s + (bgra ? 2 : 0)];
        img.data[d + 1] = src[s + 1];
        img.data[d + 2] = src[s + (bgra ? 0 : 2)];
        img.data[d + 3] = 255;
      }
    }
    buf.unmap();
    const oc = new OffscreenCanvas(W, H);
    oc.getContext('2d').putImageData(img, 0, 0);
    const blob = await oc.convertToBlob({ type: 'image/png' });
    const nm = shotSeq > 1 ? shotName.replace('.png', `_${shotIdx}.png`) : shotName;
    await fetch('/__shot?name=' + encodeURIComponent(nm), { method: 'POST', body: blob });
    log('shot saved ' + nm + ' gpu ' + gpuMs.toFixed(2) + 'ms nodes ' + nodeCount + ' alt ' + cam.y.toFixed(0) + ' agl ' + (cam.y - groundUnder).toFixed(0));
    shotIdx++;
    shooting = false;
    if (shotIdx < shotSeq) { requestAnimationFrame(frame); return; }
    if (shotSeq > 1) await fetch('/__shot?name=' + encodeURIComponent(shotName), { method: 'POST', body: blob });
    document.title = 'SHOT DONE';
    if (qs.get('keep') === '1') requestAnimationFrame(frame);
  }

  resize();
  addEventListener('resize', resize);
  requestAnimationFrame(frame);
}

main().catch((e) => { log('init failed: ' + (e && e.stack || e)); });
