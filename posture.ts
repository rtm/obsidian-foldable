// Deciding how a foldable phone is being held, from whatever the WebView
// reports. Kept free of Obsidian and the DOM so it can be tested in Node.

export type Mode = "folded" | "flat" | "tabletop" | "book";
export type Axis = "vertical" | "horizontal";

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Signals {
	// navigator.devicePosture.type, when the Device Posture API exists.
	posture?: "continuous" | "folded";
	// window.viewport.segments, when the Viewport Segments API exists.
	segments?: readonly Rect[];
	// screen.orientation.angle: 0 or 180 in the device's natural orientation.
	angle?: number;
	// The physical screen in CSS pixels. Not the window: the on-screen
	// keyboard shrinks the window, and must not read as folding the phone.
	width: number;
	height: number;
}

export interface Layout {
	mode: Mode;
	axis: Axis;
	// Where the hinge is, in viewport pixels along the axis it crosses.
	// Undefined when the WebView reports no segments: the middle is assumed.
	hingeAt?: number;
}

// The Pixel 10 Pro Fold's inner screen is nearly square (about 1.04:1) and
// its outer screen is phone-shaped (about 2.3:1). Anything squarer than this
// is taken to be the inner screen.
const UNFOLDED_MAX_ASPECT = 1.5;

export function classify(s: Signals): Layout {
	const halfOpen = s.posture === "folded";
	const segs = s.segments;
	if (segs && segs.length === 2) {
		const [a, b] = segs;
		const sideBySide = a.left + a.width <= b.left;
		const axis: Axis = sideBySide ? "vertical" : "horizontal";
		const hingeAt = sideBySide
			? (a.left + a.width + b.left) / 2
			: (a.top + a.height + b.top) / 2;
		return { mode: halfOpen ? halfOpenMode(axis) : "flat", axis, hingeAt };
	}

	// Book-style foldables like the Pixel folds have a vertical hinge in
	// their natural orientation, so a quarter turn makes it horizontal.
	const quarterTurned = s.angle !== undefined
		? s.angle % 180 !== 0
		: s.width > s.height;
	const axis: Axis = quarterTurned ? "horizontal" : "vertical";

	const long = Math.max(s.width, s.height);
	const short = Math.min(s.width, s.height);
	const unfolded = short > 0 && long / short <= UNFOLDED_MAX_ASPECT;
	if (!unfolded) return { mode: "folded", axis };
	return { mode: halfOpen ? halfOpenMode(axis) : "flat", axis };
}

function halfOpenMode(axis: Axis): Mode {
	return axis === "vertical" ? "book" : "tabletop";
}

