// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Drives the real LayoutModel with the store mocked out, to check that a dragged divider keeps its width.

import { atom, createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

const layoutObjAtomHolder: { atom: any } = { atom: null };

vi.mock("@/app/store/global", () => ({
    getSettingsKeyAtom: () => atom(undefined),
    WOS: {
        makeORef: (t: string, id: string) => `${t}:${id}`,
        getWaveObjectAtom: () => layoutObjAtomHolder.atom,
    },
}));
vi.mock("@/app/store/wos", () => ({ setObjectValue: () => {}, makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/services", () => ({ BlockService: {} }));
vi.mock("@/app/store/focusManager", () => ({
    FocusManager: { getInstance: () => ({ focusType: atom("node") }) },
}));

import { LayoutModel } from "../lib/layoutModel";
import { FlexDirection } from "../lib/types";

function makeModel(rootnode: any) {
    const store = createStore();
    layoutObjAtomHolder.atom = atom({ rootnode, leaforder: undefined } as any);
    const tabAtom = atom({ layoutstate: "ls", blockids: [] } as any);
    const model = new LayoutModel(tabAtom as any, store.get, store.set);
    (model as any).displayContainerRef = {
        current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1500, height: 800 }) },
    };
    model.updateTree();
    return { model, store };
}

function leaf(id: string, size: number, extra: any = {}) {
    return { id, size, flexDirection: FlexDirection.Row, data: { blockId: "b-" + id }, ...extra };
}

describe("dragging a divider in the real layout model", () => {
    for (const [name, kids] of [
        ["three plain blocks", () => [leaf("a", 34), leaf("b", 33), leaf("c", 33)]],
        ["a pinned last block", () => [leaf("a", 34), leaf("b", 33), leaf("c", 33, { pinnedPx: 400 })]],
        ["a pinned first block", () => [leaf("a", 34, { pinnedPx: 400 }), leaf("b", 33), leaf("c", 33)]],
    ] as const) {
        it(`keeps the new width: ${name}`, () => {
            const root = { id: "root", size: 100, flexDirection: FlexDirection.Row, children: kids() };
            const { model, store } = makeModel(root);
            const widths = () => {
                const props = store.get((model as any).additionalProps);
                return ["a", "b", "c"].map((id) => Math.round(props[id].rect.width));
            };
            const start = widths();
            const handles = store.get((model as any).additionalProps)["root"].resizeHandles;
            expect(handles.length).toBe(2);
            const h = handles[0];
            model.onResizeMove(h, h.centerPx - 150, 100);
            const during = widths();
            model.onResizeEnd();
            const after = widths();
            expect(after).toEqual(during);
            expect(after).not.toEqual(start);
        });
    }
});

describe("sizes that have grown past 100", () => {
    it("keeps a dragged width after minimizing and restoring blocks many times", () => {
        const root = {
            id: "root",
            size: 100,
            flexDirection: FlexDirection.Row,
            children: [leaf("a", 10), leaf("b", 10), leaf("c", 10)],
        };
        const { model, store } = makeModel(root);
        for (let i = 0; i < 6; i++) {
            model.setNodeMinimized("a", true);
            model.setNodeMinimized("a", false);
        }
        const props = () => store.get((model as any).additionalProps);
        const widths = () => ["a", "b", "c"].map((id) => Math.round(props()[id].rect.width));
        const h = props()["root"].resizeHandles[0];
        model.onResizeMove(h, h.centerPx - 100, 100);
        const during = widths();
        model.onResizeEnd();
        expect(widths()).toEqual(during);
    });

    it("keeps a dragged width in a layout saved with sizes already past 100", () => {
        const root = {
            id: "root",
            size: 100,
            flexDirection: FlexDirection.Row,
            children: [leaf("a", 150), leaf("b", 120), leaf("c", 30)],
        };
        const { model, store } = makeModel(root);
        const props = () => store.get((model as any).additionalProps);
        const widths = () => ["a", "b", "c"].map((id) => Math.round(props()[id].rect.width));
        const start = widths();
        const h = props()["root"].resizeHandles[0];
        model.onResizeMove(h, h.centerPx - 100, 100);
        const during = widths();
        model.onResizeEnd();
        expect(widths()).toEqual(during);
        expect(during).not.toEqual(start);
    });
});

describe("nested layouts", () => {
    function setup(root: any) {
        const { model, store } = makeModel(root);
        const props = () => store.get((model as any).additionalProps);
        const rects = () =>
            Object.fromEntries(
                ["a", "b", "c"].map((id) => [
                    id,
                    [Math.round(props()[id].rect.width), Math.round(props()[id].rect.height)],
                ])
            );
        return { model, props, rects };
    }
    const colRow = () => ({
        id: "root",
        size: 100,
        flexDirection: FlexDirection.Row,
        children: [
            {
                id: "col",
                size: 60,
                flexDirection: FlexDirection.Column,
                children: [leaf("a", 50), leaf("b", 50)],
            },
            leaf("c", 40),
        ],
    });

    it("keeps a width dragged between a column of two terminals and a third block", () => {
        const { model, props, rects } = setup(colRow());
        const h = props()["root"].resizeHandles[0];
        const start = rects();
        for (const dx of [-20, -60, -120, -180]) model.onResizeMove(h, h.centerPx + dx, 100);
        const during = rects();
        model.onResizeEnd();
        const after = rects();
        expect(after).toEqual(during);
        expect(after).not.toEqual(start);
    });

    it("keeps a height dragged between the two stacked terminals", () => {
        const { model, props, rects } = setup(colRow());
        const h = props()["col"].resizeHandles[0];
        const start = rects();
        model.onResizeMove(h, 300, h.centerPx - 100);
        const during = rects();
        model.onResizeEnd();
        const after = rects();
        expect(after).toEqual(during);
        expect(after).not.toEqual(start);
    });

    it("keeps a width after two drags in a row", () => {
        const { model, props, rects } = setup(colRow());
        let h = props()["root"].resizeHandles[0];
        model.onResizeMove(h, h.centerPx - 100, 100);
        model.onResizeEnd();
        const mid = rects();
        h = props()["root"].resizeHandles[0];
        model.onResizeMove(h, h.centerPx - 100, 100);
        model.onResizeEnd();
        expect(rects().a[0]).toBeLessThan(mid.a[0]);
    });
});
