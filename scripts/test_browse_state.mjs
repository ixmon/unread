// Root-cause regression for the browse ring: a non-finite ?t= used to throw in
// blend() after the canvas was cleared, and the selection dot had no position
// until that draw, so it sat outside the circle on an empty view.
// Run: node scripts/test_browse_state.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../web/js/browse-state.js", import.meta.url)), "utf8");
const sandbox = createContext({});
runInContext(src, sandbox);
const { sanitizeNavT, sanitizeView, clampCamera, blendFromNav, handleCenter, ZMAX } = sandbox.BrowseState;

const MAPS = [
  { x: 0, y: 1 },
  { x: 0, y: 2 },
  { x: 2, y: 3 },
  { x: 2, y: 4 },
  { x: 3, y: 4 },
];
const N = MAPS.length;
const CX = 150, CY = 150, R = 112, CIRCLE = 150, DOT = 9;

function dist(p) { return Math.hypot(p.x - CX, p.y - CY); }

const badT = [NaN, Infinity, -Infinity, "NaN", "Infinity", "foo", "  ", "+", "undefined", "null", "", null, undefined, "1e309"];
for (const raw of badT) {
  const t = sanitizeNavT(raw, N);
  assert.equal(t, 0, `bad t ${JSON.stringify(raw)} falls back to Geography`);
  const b = blendFromNav(raw, MAPS);
  assert.equal(b.i, 0);
  assert.ok(MAPS[b.i] && MAPS[b.j], "blend indexes a real map");
  assert.ok(b.wx.every(Number.isFinite) && b.wy.every(Number.isFinite));
  const sx = b.wx.reduce((a, c) => a + c, 0);
  const sy = b.wy.reduce((a, c) => a + c, 0);
  assert.ok(Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9, "weights still form a view");
  const p = handleCenter(raw, N, CX, CY, R, CIRCLE);
  assert.ok(dist(p) + DOT < CIRCLE, `dot for t=${JSON.stringify(raw)} stays inside the circle (dist ${dist(p)})`);
}

// Finite values wrap onto the ring instead of being rejected.
assert.equal(sanitizeNavT(0, N), 0);
assert.equal(sanitizeNavT(1.5, N), 1.5);
assert.ok(Math.abs(sanitizeNavT(5, N)) < 1e-9);
assert.equal(sanitizeNavT(-1, N), 4);
assert.ok(Math.abs(sanitizeNavT(99, N) - 4) < 1e-9);

for (const raw of [0, 0.4, 1, 2.2, 4.999, 7, -0.2, 99]) {
  const p = handleCenter(raw, N, CX, CY, R, CIRCLE);
  assert.ok(dist(p) + DOT < CIRCLE, `in-range dot dist ${dist(p)} for ${raw}`);
  assert.ok(Math.abs(dist(p) - R) < 1e-6, "sits on the design arc");
}

// Default stop is the top of the ring (the CSS initial position).
const top = handleCenter(0, N, CX, CY, R, CIRCLE);
assert.ok(Math.abs(top.x - 150) < 1e-6);
assert.ok(Math.abs(top.y - 38) < 1e-6);

// Radius read as 0 / NaN before layout: dot goes to the center, which is inside,
// never to NaN (that would leave the static top-left position outside the ring).
for (const radius of [0, NaN, -5]) {
  const p = handleCenter(2, N, CX, CY, radius, 0);
  assert.equal(p.x, CX);
  assert.equal(p.y, CY);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
}
const scaled = handleCenter(0, N, CX, CY, 0, CIRCLE);
assert.ok(dist(scaled) + DOT < CIRCLE && dist(scaled) > 0);

// Objects come back from the vm, so compare fields rather than prototypes.
const view = (z, x, y) => { const v = sanitizeView(z, x, y, ZMAX); return { cx: v.cx, cy: v.cy, z: v.z }; };
// Saved view. The old code turned z=Infinity into a 400x zoom that draws no dots.
const full = { cx: 0.5, cy: 0.5, z: 1 };
for (const z of [NaN, Infinity, "foo", "1e309", 0, 1, 99999, ZMAX + 0.01]) {
  assert.deepEqual(view(z, 0.5, 0.5), full, `z ${z} falls back to the full view`);
}
assert.deepEqual(view(2, "NaN", 50), { cx: 0.5, cy: 0.5, z: 2 });
assert.deepEqual(view(2, 1e9, -1e9), { cx: 0.5, cy: 0.5, z: 2 });
// A real zoom is kept, with the window clamped inside the plot.
const zoomed = sanitizeView(2, 0, 0, ZMAX);
assert.equal(zoomed.z, 2);
assert.ok(zoomed.cx >= 0.25 && zoomed.cy >= 0.25);
const maxZ = sanitizeView(ZMAX, 0.5, 0.5, ZMAX);
assert.equal(maxZ.z, ZMAX);
assert.equal(maxZ.cx, 0.5);

// Interaction clamp never yields NaN, even if a 0-size plot produced one.
const recovered = clampCamera(NaN, NaN, NaN, ZMAX);
assert.deepEqual({ cx: recovered.cx, cy: recovered.cy, z: recovered.z }, full);
const edge = clampCamera(2, 5, -4, ZMAX);
assert.ok(edge.cx >= 0.25 && edge.cx <= 0.75 && edge.cy >= 0.25 && edge.cy <= 0.75);

console.log("browse-state: ok");
