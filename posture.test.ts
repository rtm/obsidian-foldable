import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./posture.ts";

// CSS pixel sizes of a Pixel 10 Pro Fold's screens, roughly.
const OUTER = { width: 412, height: 950 };
const INNER = { width: 857, height: 885 };
const INNER_TURNED = { width: 885, height: 857 };

test("outer screen is folded", () => {
	assert.equal(classify(OUTER).mode, "folded");
	assert.equal(classify({ width: 950, height: 412 }).mode, "folded");
});

test("inner screen with no posture or segment data is flat, hinge in the middle", () => {
	assert.deepEqual(classify(INNER), { mode: "flat", axis: "vertical" });
});

test("a quarter turn makes the hinge horizontal", () => {
	assert.equal(classify(INNER_TURNED).axis, "horizontal");
	assert.equal(classify({ ...INNER_TURNED, angle: 90 }).axis, "horizontal");
});

test("rotation angle wins over screen shape when both are known", () => {
	assert.equal(classify({ ...INNER, angle: 270 }).axis, "horizontal");
	assert.equal(classify({ ...INNER_TURNED, angle: 0 }).axis, "vertical");
	assert.equal(classify({ ...INNER_TURNED, angle: 180 }).axis, "vertical");
});

test("side-by-side segments give a vertical hinge between them", () => {
	const layout = classify({
		...INNER,
		posture: "continuous",
		segments: [
			{ left: 0, top: 0, width: 428, height: 885 },
			{ left: 429, top: 0, width: 428, height: 885 },
		],
	});
	assert.deepEqual(layout, { mode: "flat", axis: "vertical", hingeAt: 428.5 });
});

test("half-open with side-by-side segments is book", () => {
	const layout = classify({
		...INNER,
		posture: "folded",
		segments: [
			{ left: 0, top: 0, width: 428, height: 885 },
			{ left: 428, top: 0, width: 429, height: 885 },
		],
	});
	assert.deepEqual(layout, { mode: "book", axis: "vertical", hingeAt: 428 });
});

test("half-open with stacked segments is tabletop", () => {
	const layout = classify({
		...INNER_TURNED,
		posture: "folded",
		segments: [
			{ left: 0, top: 0, width: 885, height: 428 },
			{ left: 0, top: 429, width: 885, height: 428 },
		],
	});
	assert.deepEqual(layout, { mode: "tabletop", axis: "horizontal", hingeAt: 428.5 });
});

test("half-open without segments falls back on rotation", () => {
	assert.equal(classify({ ...INNER, posture: "folded" }).mode, "book");
	assert.equal(classify({ ...INNER_TURNED, posture: "folded" }).mode, "tabletop");
});

test("half-open posture on the outer screen is still folded", () => {
	assert.equal(classify({ ...OUTER, posture: "folded" }).mode, "folded");
});

test("a single segment is treated like no segments", () => {
	const layout = classify({ ...OUTER, segments: [{ left: 0, top: 0, ...OUTER }] });
	assert.equal(layout.mode, "folded");
});
