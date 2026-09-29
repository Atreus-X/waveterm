// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { newLayoutNode } from "../lib/layoutNode";
import { adjustInsertForPinned, applyPinnedSizes } from "../lib/layoutPin";
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
});
