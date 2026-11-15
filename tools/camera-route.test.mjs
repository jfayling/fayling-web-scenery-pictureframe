import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraRoute } from '../js/camera-route.js';
import { SCENES } from '../js/scenes.js';

const moon = SCENES.find((s) => s.id === 'moon');
const route = moon.flight.route;

test('lunar route stays inside the measured crop with positive target clearance', () => {
  for (let z = route.startZ; z >= route.endZ; z -= 50) {
    assert(Math.abs(route.x(z)) < moon.body.halfWidth - 10000);
    assert(Math.abs(z) < moon.body.halfHeight - 10000);
    assert(route.agl(z) >= 2400 && route.agl(z) <= 5500);
    assert(Number.isFinite(route.slope(z)));
    assert(route.pitch(z) >= -25 && route.pitch(z) <= -16);
  }
  assert(route.agl(21000) < route.agl(route.startZ));
  assert(route.agl(-34000) > route.agl(21000));
  assert(route.length > route.startZ - route.endZ);
});

test('waypoint joins have continuous position, heading, clearance and framing', () => {
  for (const z of [38000, 21000, 6000, -16000, -34000]) {
    for (const fn of [route.x, route.agl, route.pitch]) assert(Math.abs(fn(z - 0.1) - fn(z + 0.1)) < 0.001);
    assert(Math.abs(route.slope(z - 0.1) - route.slope(z + 0.1)) < 0.00001);
  }
});

test('slope correction traverses the complete route at the requested speed', () => {
  for (const seconds of [60, 240, 1800]) {
    let z = route.startZ, elapsed = 0;
    const speed = route.length / seconds, dt = 1 / 60;
    while (z > route.endZ && elapsed < seconds + 2) {
      z -= speed * dt / Math.hypot(1, route.slope(z));
      elapsed += dt;
    }
    assert(Math.abs(elapsed - seconds) < 0.1);
  }
});

test('look-ahead clamps outside endpoints and Earth retains its existing flight model', () => {
  assert.equal(route.x(route.startZ + 10000), route.x(route.startZ));
  assert.equal(route.agl(route.endZ - 10000), route.agl(route.endZ));
  assert(Math.abs(route.slope(route.endZ - 10000)) === 0);
  for (const scene of SCENES.filter((s) => !s.body)) assert.equal(scene.flight.route, undefined);
  assert.throws(() => createCameraRoute([]));
  assert.throws(() => createCameraRoute([{ x: 0, z: 0, agl: 1, pitch: 0 }, { x: 0, z: 1, agl: 1, pitch: 0 }]));
});

test('every lunar route stays within its own terrain and completes a four-minute tour', () => {
  const lunar = SCENES.filter((s) => s.body);
  assert.equal(lunar.length, 5);
  assert.equal(new Set(lunar.map((s) => s.body.demOffset)).size, 5);
  for (const scene of lunar) {
    const r = scene.flight.route;
    assert.equal(scene.flight.startZ, r.startZ);
    assert.equal(scene.flight.endZ, r.endZ);
    let z = r.startZ, elapsed = 0;
    while (z > r.endZ && elapsed < 242) {
      assert(Math.abs(r.x(z)) < scene.body.halfWidth - 10000, scene.id);
      assert(Math.abs(z) < scene.body.halfHeight - 10000, scene.id);
      assert(r.agl(z) >= 1000 && r.agl(z) <= 10000, scene.id);
      assert(r.pitch(z) < 0 && Number.isFinite(r.slope(z)), scene.id);
      z -= (r.length / 240) / 60 / Math.hypot(1, r.slope(z));
      elapsed += 1 / 60;
    }
    assert(Math.abs(elapsed - 240) < 0.1, scene.id);
  }
});
