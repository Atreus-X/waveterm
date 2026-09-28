// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Multi-selection in the file browser. The selection is a list of paths in display order; an empty
// list means "just the focused row" (the single-selection behavior everything else relies on).

export type DirClickMods = { toggle: boolean; range: boolean };

export type DirSelectionResult = { selection: string[]; anchor: number };

const isSelectable = (path: string) => path != null && path !== ".." && !path.endsWith("/..");

/** New selection after clicking row `idx` of `paths` (display order) with Ctrl/Cmd (toggle) or Shift (range). */
export function clickSelection(
    paths: string[],
    prev: string[],
    focusIdx: number,
    anchorIdx: number,
    idx: number,
    mods: DirClickMods
): DirSelectionResult {
    const clicked = paths[idx];
    if (mods.range) {
        const from = anchorIdx >= 0 && anchorIdx < paths.length ? anchorIdx : focusIdx;
        const [lo, hi] = from <= idx ? [from, idx] : [idx, from];
        return { selection: paths.slice(lo, hi + 1).filter(isSelectable), anchor: from };
    }
    if (mods.toggle) {
        const base = prev.length > 0 ? prev : [paths[focusIdx]].filter(isSelectable);
        const next = base.includes(clicked) ? base.filter((p) => p !== clicked) : [...base, clicked];
        return { selection: paths.filter((p) => next.includes(p) && isSelectable(p)), anchor: idx };
    }
    return { selection: [], anchor: idx };
}

/** Shift+arrow: the selection spans from the anchor (the focused row if nothing is selected yet) to newIdx. */
export function extendSelection(
    paths: string[],
    prev: string[],
    focusIdx: number,
    anchorIdx: number,
    newIdx: number
): DirSelectionResult {
    const anchor = prev.length > 0 ? anchorIdx : focusIdx;
    return clickSelection(paths, prev, focusIdx, anchor, newIdx, { toggle: false, range: true });
}

/** Ctrl+arrow moves focus but keeps the selection; a lone focused row becomes explicitly selected so moving away keeps it. */
export function keepSelection(paths: string[], prev: string[], focusIdx: number): string[] {
    return prev.length > 0 ? prev : [paths[focusIdx]].filter(isSelectable);
}

/** Ctrl+Space adds or removes the focused row. */
export function toggleFocused(paths: string[], prev: string[], focusIdx: number): string[] {
    return clickSelection(paths, prev, focusIdx, focusIdx, focusIdx, { toggle: true, range: false }).selection;
}

export function selectAll(paths: string[]): string[] {
    return paths.filter(isSelectable);
}

/** What a right-click on `path` acts on: the whole selection if it's part of it, else just that row. */
export function contextTargets(selection: string[], path: string): string[] {
    return selection.length > 1 && selection.includes(path) ? selection : [path];
}

function baseName(p: string): string {
    return (p || "").replace(/\/+$/, "").split("/").pop() || "";
}

/** Zip name: the item's own name for one item, "<folder>-N-items" for several. */
export function zipNameFor(targets: string[], dirPath: string): string {
    if (targets.length === 1) {
        return `${baseName(targets[0]) || "files"}.zip`;
    }
    const dirName = baseName(dirPath);
    return `${dirName === "" || dirName === "~" ? "files" : dirName}-${targets.length}-items.zip`;
}
