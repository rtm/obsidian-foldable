import {
	App,
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	debounce,
	setIcon,
} from "obsidian";
import { Layout, Mode, Rect, Signals, classify } from "./posture";

interface Settings {
	twoPanes: boolean;
	linksOpposite: boolean;
	tabletopControls: boolean;
}

const DEFAULTS: Settings = {
	twoPanes: true,
	linksOpposite: true,
	tabletopControls: true,
};

// The parts of the Device Posture and Viewport Segments APIs used here.
// Neither is in TypeScript's DOM library yet.
interface DevicePosture extends EventTarget {
	type: "continuous" | "folded";
}
interface FoldableNavigator {
	devicePosture?: DevicePosture;
}
interface FoldableWindow {
	viewport?: { segments?: readonly Rect[] | null };
}

// Command IDs are not part of Obsidian's typed API.
interface AppWithCommands {
	commands: { executeCommandById(id: string): boolean };
}

const MODES: readonly Mode[] = ["folded", "flat", "tabletop", "book"];

function showsTwoPanes(mode: Mode): boolean {
	return mode === "flat" || mode === "book";
}

export default class FoldablePlugin extends Plugin {
	settings: Settings = { ...DEFAULTS };
	layout: Layout | undefined;
	// The note in the second pane when the phone was last folded, reopened
	// beside the first when it is unfolded again.
	companionPath: string | undefined;
	// Set on unfolding until the second pane opens. Obsidian switches from
	// its phone layout to its tablet layout a moment after the screen
	// changes, and a split can only be made once it has.
	splitPending = false;

	async onload() {
		this.addCommand({
			id: "show-fold-state",
			name: "Show fold state",
			callback: () => new Notice(this.describe(), 15000),
		});
		// A desktop window's shape says nothing about folding, and the vault's
		// plugins sync to every device, so stay inert off mobile.
		if (!Platform.isMobile) return;

		this.settings = { ...DEFAULTS, ...(await this.loadData()) };
		this.addSettingTab(new FoldableSettingTab(this.app, this));
		this.addControls();
		this.redirectLinks();

		const update = debounce(() => this.update(), 150, true);
		this.registerDomEvent(window, "resize", update);
		this.registerDomEvent(window, "orientationchange", update);
		const posture = (navigator as FoldableNavigator).devicePosture;
		if (posture) {
			posture.addEventListener("change", update);
			this.register(() => posture.removeEventListener("change", update));
		}

		const observer = new MutationObserver(() => { if (this.splitPending) void this.trySplit(); });
		observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
		this.register(() => observer.disconnect());

		this.app.workspace.onLayoutReady(() => this.update());
	}

	onunload() {
		document.body.removeClasses(MODES.map(m => `foldable-${m}`));
		document.body.removeClasses(["foldable-hinge-vertical", "foldable-hinge-horizontal"]);
		document.body.removeClass("foldable-controls-on");
		document.body.style.removeProperty("--foldable-hinge");
	}

	readSignals(): Signals {
		const posture = (navigator as FoldableNavigator).devicePosture?.type;
		const segments = (window as FoldableWindow).viewport?.segments ?? undefined;
		return {
			posture,
			segments,
			angle: screen.orientation?.angle,
			width: screen.width,
			height: screen.height,
		};
	}

	update() {
		const previous = this.layout;
		const layout = classify(this.readSignals());
		this.layout = layout;

		const body = document.body;
		for (const m of MODES) body.toggleClass(`foldable-${m}`, m === layout.mode);
		body.toggleClass("foldable-hinge-vertical", layout.axis === "vertical");
		body.toggleClass("foldable-hinge-horizontal", layout.axis === "horizontal");
		const middle = layout.axis === "vertical" ? window.innerWidth / 2 : window.innerHeight / 2;
		body.style.setProperty("--foldable-hinge", `${layout.hingeAt ?? middle}px`);

		if (previous?.mode === layout.mode) return;
		this.splitPending = showsTwoPanes(layout.mode);
		if (this.splitPending) void this.trySplit();
		else if (!previous || showsTwoPanes(previous.mode)) this.closeSecondPane();
	}

	rootLeaves(): WorkspaceLeaf[] {
		// iterateRootLeaves reports only one leaf on Obsidian for Android, even
		// with several panes showing.
		const workspace = this.app.workspace;
		const leaves: WorkspaceLeaf[] = [];
		workspace.iterateAllLeaves(leaf => {
			if (leaf.getRoot() === workspace.rootSplit) leaves.push(leaf);
		});
		return leaves;
	}

	// On a phone-sized layout Obsidian shows one pane at a time, so a split
	// would only hide the note behind a tab.
	canSplit(): boolean {
		return !document.body.hasClass("is-phone");
	}

	async trySplit() {
		if (!this.settings.twoPanes || !this.layout) {
			this.splitPending = false;
			return;
		}
		if (!this.canSplit()) return;
		this.splitPending = false;
		await this.openSecondPane(this.layout);
	}

	async openSecondPane(layout: Layout) {
		const leaves = this.rootLeaves();
		if (leaves.length !== 1) return;
		const [first] = leaves;
		const companion = this.pickCompanion(first);
		if (!companion) return;

		const workspace = this.app.workspace;
		workspace.setActiveLeaf(first, { focus: false });
		const second = workspace.getLeaf("split", layout.axis);
		await second.openFile(companion, { active: false });
		workspace.setActiveLeaf(first, { focus: true });
	}

	// The note that was beside this one before the phone was folded, or
	// failing that the note opened most recently before it.
	pickCompanion(first: WorkspaceLeaf): TFile | undefined {
		const current = first.view instanceof MarkdownView ? first.view.file?.path : undefined;
		const candidates = [this.companionPath, ...this.app.workspace.getLastOpenFiles()];
		for (const path of candidates) {
			if (!path || path === current) continue;
			const file = this.app.vault.getFileByPath(path);
			if (file) return file;
		}
		return undefined;
	}

	closeSecondPane() {
		if (!this.settings.twoPanes) return;
		const leaves = this.rootLeaves();
		if (leaves.length !== 2) return;
		const keep = this.app.workspace.getMostRecentLeaf() ?? leaves[0];
		const other = leaves.find(leaf => leaf !== keep);
		if (!other) return;
		this.companionPath = other.view instanceof MarkdownView ? other.view.file?.path : undefined;
		other.detach();
	}

	// With two panes showing, a link followed in one opens in the other, so
	// the note it came from stays in view.
	redirectLinks() {
		const workspace = this.app.workspace;
		const original = workspace.openLinkText;
		const plugin = this;
		workspace.openLinkText = function (linktext, sourcePath, newLeaf, openViewState) {
			const target = newLeaf ? undefined : plugin.oppositeLeaf();
			if (target) workspace.setActiveLeaf(target, { focus: false });
			return original.call(this, linktext, sourcePath, newLeaf, openViewState);
		};
		this.register(() => { workspace.openLinkText = original; });
	}

	oppositeLeaf(): WorkspaceLeaf | undefined {
		if (!this.settings.linksOpposite || !this.layout || !showsTwoPanes(this.layout.mode)) return undefined;
		const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
		const leaves = this.rootLeaves();
		if (!active || leaves.length !== 2 || !leaves.includes(active)) return undefined;
		return leaves.find(leaf => leaf !== active);
	}

	// Large buttons for the bottom half of the screen in tabletop mode, where
	// the top half shows the note. CSS shows them only in that mode.
	addControls() {
		const bar = document.body.createDiv({ cls: "foldable-controls" });
		this.register(() => bar.remove());
		const button = (icon: string, label: string, action: () => void) => {
			const el = bar.createEl("button", { attr: { "aria-label": label } });
			setIcon(el, icon);
			this.registerDomEvent(el, "click", action);
		};
		button("arrow-left", "Back", () => this.run("app:go-back"));
		button("chevrons-up", "Page up", () => this.page(-1));
		button("chevrons-down", "Page down", () => this.page(1));
		button("book-open", "Toggle reading view", () => this.run("markdown:toggle-preview"));
		button("arrow-right", "Forward", () => this.run("app:go-forward"));
		this.syncControls();
	}

	syncControls() {
		document.body.toggleClass("foldable-controls-on", this.settings.tabletopControls);
	}

	run(commandId: string) {
		(this.app as unknown as AppWithCommands).commands.executeCommandById(commandId);
	}

	page(direction: 1 | -1) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const scroller = view.getMode() === "preview"
			? view.containerEl.querySelector(".markdown-preview-view")
			: view.containerEl.querySelector(".cm-scroller");
		if (!(scroller instanceof HTMLElement)) return;
		scroller.scrollBy({ top: direction * scroller.clientHeight * 0.85, behavior: "smooth" });
	}

	describe(): string {
		const s = this.readSignals();
		const layout = this.layout;
		const segments = s.segments
			? s.segments.map(r => `${Math.round(r.width)}×${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`).join(" | ")
			: "not reported";
		return [
			layout ? `Mode: ${layout.mode} (hinge ${layout.axis})` : `Mode: ${Platform.isMobile ? "unknown" : "inactive on desktop"}`,
			`Posture API: ${s.posture ?? "not available"}`,
			`Segments: ${segments}`,
			`Screen: ${s.width}×${s.height}, angle ${s.angle ?? "?"}`,
			`Window: ${window.innerWidth}×${window.innerHeight}`,
			`Obsidian layout: ${document.body.hasClass("is-phone") ? "phone" : document.body.hasClass("is-tablet") ? "tablet" : "desktop"}`,
		].join("\n");
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.syncControls();
	}
}

class FoldableSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: FoldablePlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const toggle = (key: keyof Settings, name: string, desc: string) =>
			new Setting(containerEl).setName(name).setDesc(desc).addToggle(t => t
				.setValue(this.plugin.settings[key])
				.onChange(async value => {
					this.plugin.settings[key] = value;
					await this.plugin.saveSettings();
				}));

		toggle("twoPanes", "Two panes when unfolded",
			"Open a second note beside the first when the phone is unfolded, and close it when the phone is folded.");
		toggle("linksOpposite", "Open links in the other pane",
			"With two panes showing, a link followed in one opens in the other.");
		toggle("tabletopControls", "Tabletop controls",
			"When the phone is half-folded like a laptop, show the note on the top half and large buttons on the bottom half.");
	}
}
