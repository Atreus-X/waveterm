// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, LayoutNode } from "./types";

// Pinned blocks keep their pixel size along their parent's direction (node.pinnedPx) while the
// window or the rest of the layout changes; their unpinned siblings share whatever is left in their
// existing proportions. The layout still works in proportional sizes, so this rewrites the siblings'
// sizes to match (the parent's total is unchanged), which keeps resize handles and drag math intact.
// Minimized blocks (node.minimized) are held the same way, at a fixed small size: a header-height bar in
// a column, a narrow vertical strip in a row.

// header (30px) + its border + the block frame's padding
export const MinimizedBarPx = 34;
export const MinimizedStripPx = 36;

export type InsertLocation = { node: LayoutNode; index: number };

/**
 * Keeps pinned blocks at their edge when a new block is added: the new block goes before any
 * pinned blocks at the end of a row/column (so it lands left of / above a pinned block on the right
 * or bottom edge), and a pinned block is never split to make room - the new block becomes its
 * sibling just before it instead.
 */
export function adjustInsertForPinned(root: LayoutNode, loc: InsertLocation): InsertLocation {
    if (!loc?.node) return loc;
    if (!loc.node.children) {
        if (!isFixedSize(loc.node)) return loc;
        const parent = findParentNode(root, loc.node.id);
        if (!parent) return loc;
        return adjustInsertForPinned(root, { node: parent, index: parent.children.indexOf(loc.node) });
    }
    let index = Math.min(loc.index, loc.node.children.length);
    while (index > 0 && loc.node.children.slice(index - 1).every(containsPinned)) {
        index--;
    }
    return hoistOutOfPinnedBranch(root, { node: loc.node, index });
}

// A pinned block often sits inside a column at the edge (e.g. an inspector above a file browser). The
// column isn't pinned itself, so climb to the outermost container whose trailing children all hold
// a pinned block and insert before that branch.
function hoistOutOfPinnedBranch(root: LayoutNode, loc: InsertLocation): InsertLocation {
    const path = findPath(root, loc.node.id);
    if (!path) return loc;
    for (let i = 0; i < path.length - 1; i++) {
        const idx = path[i].children.indexOf(path[i + 1]);
        if (path[i].children.slice(idx).every(containsPinned)) {
            return { node: path[i], index: idx };
        }
    }
    return loc;
}

function containsPinned(node: LayoutNode): boolean {
    return isFixedSize(node) || !!node.children?.some(containsPinned);
}

function findPath(node: LayoutNode, id: string): LayoutNode[] {
    if (node.id === id) return [node];
    for (const child of node.children ?? []) {
        const sub = findPath(child, id);
        if (sub) return [node, ...sub];
    }
    return undefined;
}

function findParentNode(node: LayoutNode, id: string): LayoutNode {
    if (!node?.children) return undefined;
    for (const child of node.children) {
        if (child.id === id) return node;
        const found = findParentNode(child, id);
        if (found) return found;
    }
    return undefined;
}

export function isPinned(node: LayoutNode): boolean {
    return node?.pinnedPx != null && node.pinnedPx > 0;
}

export function isMinimized(node: LayoutNode): boolean {
    return node?.minimized === true;
}

export function isFixedSize(node: LayoutNode): boolean {
    return isPinned(node) || isMinimized(node);
}

// Pixels a child holds along its parent's direction, or 0 when it takes a proportional share.
export function fixedPx(node: LayoutNode, parentIsRow: boolean): number {
    if (isMinimized(node)) return parentIsRow ? MinimizedStripPx : MinimizedBarPx;
    return isPinned(node) ? node.pinnedPx : 0;
}

/**
 * Whether the block is shown minimized. A minimized block with no sibling left to take its space (the
 * others were closed or are fixed too) is shown normally, since there's nothing to collapse into.
 */
export function isShownMinimized(parent: LayoutNode, node: LayoutNode): boolean {
    if (!isMinimized(node) || !parent?.children) return false;
    const parentIsRow = parent.flexDirection === FlexDirection.Row;
    return parent.children.some((c) => c !== node && fixedPx(c, parentIsRow) === 0);
}

/**
 * Rewrites children's sizes so pinned and minimized children get their fixed pixels (scaled down if they
 * wouldn't leave every other sibling at least minPx) and the rest split what's left. Returns whether
 * anything changed. No-op when none or all children are fixed, or the parent has no size yet.
 */
export function applyPinnedSizes(children: LayoutNode[], parentPx: number, minPx: number, parentIsRow = true): boolean {
    if (!children?.length || !(parentPx > 0)) return false;
    const pinned = children.filter((c) => fixedPx(c, parentIsRow) > 0);
    const unpinned = children.filter((c) => fixedPx(c, parentIsRow) === 0);
    if (pinned.length === 0 || unpinned.length === 0) return false;

    const totalSize = children.reduce((acc, c) => acc + c.size, 0);
    if (!(totalSize > 0)) return false;
    const sizePerPx = totalSize / parentPx;

    const wantPinnedPx = pinned.reduce((acc, c) => acc + fixedPx(c, parentIsRow), 0);
    const maxPinnedPx = Math.max(0, parentPx - unpinned.length * minPx);
    const scale = wantPinnedPx > maxPinnedPx ? maxPinnedPx / wantPinnedPx : 1;

    let changed = false;
    const setSize = (c: LayoutNode, size: number) => {
        if (Math.abs(c.size - size) > 1e-6) {
            c.size = size;
            changed = true;
        }
    };
    let usedPx = 0;
    for (const c of pinned) {
        const px = fixedPx(c, parentIsRow) * scale;
        usedPx += px;
        setSize(c, px * sizePerPx);
    }
    const restPx = parentPx - usedPx;
    const unpinnedTotal = unpinned.reduce((acc, c) => acc + c.size, 0);
    for (const c of unpinned) {
        const share = unpinnedTotal > 0 ? c.size / unpinnedTotal : 1 / unpinned.length;
        setSize(c, restPx * share * sizePerPx);
    }
    return changed;
}

/**
 * Marks a child minimized, remembering the share of its parent it had so restoreChild can give it back.
 */
export function minimizeChild(parent: LayoutNode, node: LayoutNode) {
    const total = parent.children.reduce((acc, c) => acc + c.size, 0);
    node.minimizedFrac = total > 0 ? node.size / total : 1 / parent.children.length;
    node.minimized = true;
}

/**
 * Clears a child's minimized state and sizes it to the share of its parent it had before, measured
 * against what its siblings hold now (they absorbed its space while it was minimized).
 */
export function restoreChild(parent: LayoutNode, node: LayoutNode) {
    const othersSize = parent.children.filter((c) => c !== node).reduce((acc, c) => acc + c.size, 0);
    const frac = Math.min(0.9, Math.max(0.05, node.minimizedFrac ?? 1 / parent.children.length));
    node.size = (frac / (1 - frac)) * othersSize;
    delete node.minimized;
    delete node.minimizedFrac;
}
