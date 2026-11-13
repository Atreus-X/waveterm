// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { newLayoutNode } from "../lib/layoutNode";
import {
    adjustInsertForPinned,
    applyPinnedSizes,
    fixedPx,
    isShownMinimized,
    minimizeChild,
    MinimizedBarPx,
    MinimizedStripPx,
    restoreChild,
} from "../lib/layoutPin";
import { insertNode, insertNodeAtIndex } from "../lib/layoutTree";
import { FlexDirection, LayoutNode, LayoutTreeActionType, LayoutTreeState } from "../lib/types";

function leaf(id: string, size: number, pinnedPx?: number): LayoutNode {
    return { id, size, flexDirection: FlexDirection.Row, pinnedPx };
}

// pixels each child gets for the given parent size, as updateTreeHelper computes them
function pixels(children: LayoutNode[], parentPx: number): number[] {
    const total = children.reduce((a, c) => a + c.size, 0);
    return children.map((c) => Math.round((c.size / total) * parentPx));
}

describe("applyPinnedSizes", () => {
    it("keeps a pinned sidebar's pixels when the window grows or shrinks", () => {
        const kids = [leaf("main", 60), leaf("side", 40, 400)];
        applyPinnedSizes(kids, 1000, 40);
        expect(pixels(kids, 1000)).toEqual([600, 400]);
        applyPinnedSizes(kids, 2000, 40);
        expect(pixels(kids, 2000)).toEqual([1600, 400]);
        applyPinnedSizes(kids, 700, 40);
        expect(pixels(kids, 700)).toEqual([300, 400]);
    });

    it("keeps the parent's total size, so the rest of the layout is unaffected", () => {
        const kids = [leaf("a", 30), leaf("b", 20), leaf("side", 50, 250)];
        applyPinnedSizes(kids, 1200, 40);
        expect(kids.reduce((a, c) => a + c.size, 0)).toBeCloseTo(100);
    });

    it("unpinned siblings keep their proportions between themselves", () => {
        const kids = [leaf("a", 30), leaf("b", 10), leaf("side", 60, 200)];
        applyPinnedSizes(kids, 1000, 40);
        expect(pixels(kids, 1000)).toEqual([600, 200, 200]);
    });

    it("never squeezes unpinned siblings below the minimum", () => {
        const kids = [leaf("main", 50), leaf("side", 50, 900)];
        applyPinnedSizes(kids, 500, 40);
        expect(pixels(kids, 500)).toEqual([40, 460]);
    });

    it("does nothing when none or all are pinned, or the parent has no size", () => {
        const none = [leaf("a", 50), leaf("b", 50)];
        expect(applyPinnedSizes(none, 1000, 40)).toBe(false);
        const all = [leaf("a", 50, 300), leaf("b", 50, 300)];
        expect(applyPinnedSizes(all, 1000, 40)).toBe(false);
        expect(applyPinnedSizes([leaf("a", 50), leaf("b", 50, 300)], 0, 40)).toBe(false);
    });
});

function block(id: string, pinnedPx?: number): LayoutNode {
    const n = newLayoutNode(FlexDirection.Column, 50, undefined, { blockId: id });
    n.id = id;
    if (pinnedPx) n.pinnedPx = pinnedPx;
    return n;
}

function order(root: LayoutNode): string[] {
    return (root.children ?? []).map((c) => c.data?.blockId ?? `[${order(c).join(",")}]`);
}

function insert(state: LayoutTreeState, id: string) {
    insertNode(state, { type: LayoutTreeActionType.InsertNode, node: block(id), magnified: false, focused: false });
}

describe("new blocks and pinned blocks", () => {
    it("a new block lands left of a pinned block on the right edge", () => {
        const state: LayoutTreeState = {
            rootNode: newLayoutNode(FlexDirection.Row, 100, [block("main"), block("side", 400)]),
        } as LayoutTreeState;
        insert(state, "new1");
        expect(order(state.rootNode)).toEqual(["main", "new1", "side"]);
        insert(state, "new2");
        expect(order(state.rootNode)).toEqual(["main", "new1", "new2", "side"]);
    });

    it("stays left of several pinned blocks at the edge", () => {
        const state: LayoutTreeState = {
            rootNode: newLayoutNode(FlexDirection.Row, 100, [block("main"), block("p1", 300), block("p2", 300)]),
        } as LayoutTreeState;
        insert(state, "new");
        expect(order(state.rootNode)).toEqual(["main", "new", "p1", "p2"]);
    });

    it("a pinned block on the left edge doesn't change where new blocks go", () => {
        const state: LayoutTreeState = {
            rootNode: newLayoutNode(FlexDirection.Row, 100, [block("side", 300), block("main")]),
        } as LayoutTreeState;
        insert(state, "new");
        expect(order(state.rootNode)).toEqual(["side", "main", "new"]);
    });

    it("splitting from a pinned block on the right edge lands left of it", () => {
        const state: LayoutTreeState = {
            rootNode: newLayoutNode(FlexDirection.Row, 100, [block("main"), block("side", 400)]),
        } as LayoutTreeState;
        insertNodeAtIndex(state, {
            type: LayoutTreeActionType.InsertNodeAtIndex,
            node: block("new"),
            indexArr: [1],
            magnified: false,
            focused: false,
        });
        expect(order(state.rootNode)).toEqual(["main", "new", "side"]);
    });

    it("never splits a pinned block to make room", () => {
        const pinned = block("side", 400);
        const root = newLayoutNode(FlexDirection.Row, 100, [block("main"), pinned]);
        expect(adjustInsertForPinned(root, { node: pinned, index: 1 })).toEqual({ node: root, index: 1 });
    });

    it("lands left of a right-edge column that holds a pinned block", () => {
        const column = newLayoutNode(FlexDirection.Column, 100, [block("inspector", 400), block("files")]);
        const state: LayoutTreeState = {
            rootNode: newLayoutNode(FlexDirection.Row, 100, [block("main"), column]),
        } as LayoutTreeState;
        insert(state, "new");
        expect(order(state.rootNode)).toEqual(["main", "new", "[inspector,files]"]);
    });

    it("a column without a pinned block is unaffected", () => {
        const column = newLayoutNode(FlexDirection.Column, 100, [block("a"), block("b")]);
        const state: LayoutTreeState = {
            rootNode: newLayoutNode(FlexDirection.Row, 100, [block("main"), column]),
        } as LayoutTreeState;
        insert(state, "new");
        expect(order(state.rootNode)).not.toEqual(["main", "new", "[a,b]"]);
    });
});

describe("minimized blocks", () => {
    function minimizedLeaf(id: string, size: number): LayoutNode {
        return { id, size, flexDirection: FlexDirection.Row, minimized: true };
    }

    it("holds a bar's height in a column and a strip's width in a row", () => {
        expect(fixedPx(minimizedLeaf("a", 50), false)).toBe(MinimizedBarPx);
        expect(fixedPx(minimizedLeaf("a", 50), true)).toBe(MinimizedStripPx);
        expect(fixedPx(leaf("a", 50), true)).toBe(0);
        expect(fixedPx(leaf("a", 50, 300), true)).toBe(300);
    });

    it("collapses to a bar in a column and gives its siblings the space", () => {
        const kids = [minimizedLeaf("a", 50), leaf("b", 25), leaf("c", 25)];
        applyPinnedSizes(kids, 800, 40, false);
        expect(pixels(kids, 800)).toEqual([MinimizedBarPx, 383, 383]);
    });

    it("collapses to a strip in a row", () => {
        const kids = [leaf("a", 50), minimizedLeaf("b", 50)];
        applyPinnedSizes(kids, 1000, 40, true);
        expect(pixels(kids, 1000)).toEqual([1000 - MinimizedStripPx, MinimizedStripPx]);
    });

    it("keeps the parent's total size", () => {
        const kids = [minimizedLeaf("a", 40), leaf("b", 30), leaf("c", 30)];
        applyPinnedSizes(kids, 900, 40, false);
        expect(kids.reduce((a, c) => a + c.size, 0)).toBeCloseTo(100);
    });

    it("works next to a pinned block", () => {
        const kids = [leaf("main", 50), leaf("side", 25, 300), minimizedLeaf("min", 25)];
        applyPinnedSizes(kids, 1000, 40, true);
        expect(pixels(kids, 1000)).toEqual([1000 - 300 - MinimizedStripPx, 300, MinimizedStripPx]);
    });

    it("is only shown minimized while a sibling can take the space", () => {
        const min = minimizedLeaf("a", 50);
        const free = leaf("b", 50);
        const parent = newLayoutNode(FlexDirection.Row, 100, [min, free]);
        expect(isShownMinimized(parent, min)).toBe(true);
        expect(isShownMinimized(parent, free)).toBe(false);
        const pinnedOnly = newLayoutNode(FlexDirection.Row, 100, [min, leaf("p", 50, 300)]);
        expect(isShownMinimized(pinnedOnly, min)).toBe(false);
        expect(isShownMinimized(newLayoutNode(FlexDirection.Row, 100, [min]), min)).toBe(false);
    });

    it("a new block lands left of a minimized block on the right edge and never splits it", () => {
        const min = block("side");
        min.minimized = true;
        const root = newLayoutNode(FlexDirection.Row, 100, [block("main"), min]);
        expect(adjustInsertForPinned(root, { node: min, index: 1 })).toEqual({ node: root, index: 1 });
        const state: LayoutTreeState = { rootNode: root } as LayoutTreeState;
        insert(state, "new");
        expect(order(state.rootNode)).toEqual(["main", "new", "side"]);
    });

    it("restores to the share of the parent it had before", () => {
        const kids = [leaf("a", 30), leaf("b", 50), leaf("c", 20)];
        const parent = newLayoutNode(FlexDirection.Column, 100, kids);
        minimizeChild(parent, kids[1]);
        expect(kids[1].minimized).toBe(true);
        expect(kids[1].minimizedFrac).toBeCloseTo(0.5);
        applyPinnedSizes(kids, 800, 40, false);
        restoreChild(parent, kids[1]);
        expect(kids[1].minimized).toBeUndefined();
        expect(kids[1].minimizedFrac).toBeUndefined();
        const total = kids.reduce((a, c) => a + c.size, 0);
        expect(kids[1].size / total).toBeCloseTo(0.5);
        expect(kids[0].size / kids[2].size).toBeCloseTo(1.5);
    });

    it("restores sensibly after the siblings were resized while it was minimized", () => {
        const kids = [leaf("a", 50), leaf("b", 50)];
        const parent = newLayoutNode(FlexDirection.Row, 100, kids);
        minimizeChild(parent, kids[1]);
        kids[0].size = 200;
        restoreChild(parent, kids[1]);
        expect(kids[1].size / (kids[0].size + kids[1].size)).toBeCloseTo(0.5);
    });

    it("clamps a missing or extreme remembered share", () => {
        const kids = [leaf("a", 50), { ...leaf("b", 50), minimized: true, minimizedFrac: 1 }];
        const parent = newLayoutNode(FlexDirection.Row, 100, kids);
        restoreChild(parent, kids[1]);
        expect(kids[1].size / (kids[0].size + kids[1].size)).toBeCloseTo(0.9);
        const noFrac = [leaf("a", 50), { ...leaf("b", 50), minimized: true }];
        restoreChild(newLayoutNode(FlexDirection.Row, 100, noFrac), noFrac[1]);
        expect(noFrac[1].size).toBeCloseTo(50);
    });
});
