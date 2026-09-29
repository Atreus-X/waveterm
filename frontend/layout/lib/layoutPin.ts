// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { LayoutNode } from "./types";

// Pinned blocks keep their pixel size along their parent's direction (node.pinnedPx) while the
// window or the rest of the layout changes; their unpinned siblings share whatever is left in their
// existing proportions. The layout still works in proportional sizes, so this rewrites the siblings'
// sizes to match (the parent's total is unchanged), which keeps resize handles and drag math intact.

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
        if (!isPinned(loc.node)) return loc;
        const parent = findParentNode(root, loc.node.id);
        if (!parent) return loc;
        return adjustInsertForPinned(root, { node: parent, index: parent.children.indexOf(loc.node) });
    }
    let index = Math.min(loc.index, loc.node.children.length);
    while (index > 0 && loc.node.children.slice(index - 1).every(isPinned)) {
        index--;
    }
    return { node: loc.node, index };
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

/**
 * Rewrites children's sizes so pinned children get their pinned pixels (scaled down if they wouldn't
 * leave every unpinned sibling at least minPx) and unpinned children split the rest. Returns whether
 * anything changed. No-op when none or all children are pinned, or the parent has no size yet.
 */
export function applyPinnedSizes(children: LayoutNode[], parentPx: number, minPx: number): boolean {
    if (!children?.length || !(parentPx > 0)) return false;
    const pinned = children.filter(isPinned);
    const unpinned = children.filter((c) => !isPinned(c));
    if (pinned.length === 0 || unpinned.length === 0) return false;

    const totalSize = children.reduce((acc, c) => acc + c.size, 0);
    if (!(totalSize > 0)) return false;
    const sizePerPx = totalSize / parentPx;

    const wantPinnedPx = pinned.reduce((acc, c) => acc + c.pinnedPx, 0);
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
        const px = c.pinnedPx * scale;
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
