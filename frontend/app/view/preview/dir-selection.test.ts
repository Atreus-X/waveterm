// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { clickSelection, contextTargets, selectAll, zipNameFor } from "./dir-selection";

const paths = ["/srv/..", "/srv/a", "/srv/b", "/srv/c", "/srv/d"];
const none = { toggle: false, range: false };

describe("clickSelection", () => {
    it("plain click clears the multi-selection", () => {
        expect(clickSelection(paths, ["/srv/a", "/srv/b"], 1, 1, 3, none)).toEqual({ selection: [], anchor: 3 });
    });

    it("ctrl-click adds the focused row and the clicked one, in display order", () => {
        expect(clickSelection(paths, [], 3, 3, 1, { toggle: true, range: false }).selection).toEqual([
            "/srv/a",
            "/srv/c",
        ]);
    });

    it("ctrl-click toggles a selected row off", () => {
        expect(clickSelection(paths, ["/srv/a", "/srv/c"], 3, 3, 1, { toggle: true, range: false }).selection).toEqual([
            "/srv/c",
        ]);
    });

    it("shift-click selects the range from the anchor in either direction, skipping ..", () => {
        const want = ["/srv/a", "/srv/b", "/srv/c"];
        expect(clickSelection(paths, [], 1, 1, 3, { toggle: false, range: true }).selection).toEqual(want);
        expect(clickSelection(paths, [], 3, 3, 0, { toggle: false, range: true }).selection).toEqual(want);
    });
});

describe("helpers", () => {
    it("select all skips ..", () => {
        expect(selectAll(paths)).toEqual(["/srv/a", "/srv/b", "/srv/c", "/srv/d"]);
    });

    it("right-click inside the selection acts on all of it, outside on one row", () => {
        expect(contextTargets(["/srv/a", "/srv/b"], "/srv/b")).toEqual(["/srv/a", "/srv/b"]);
        expect(contextTargets(["/srv/a", "/srv/b"], "/srv/d")).toEqual(["/srv/d"]);
    });

    it("names the zip", () => {
        expect(zipNameFor(["/srv/logs/"], "/srv")).toBe("logs.zip");
        expect(zipNameFor(["/srv/a", "/srv/b", "/srv/c"], "/srv")).toBe("srv-3-items.zip");
        expect(zipNameFor(["~/a", "~/b"], "~")).toBe("files-2-items.zip");
    });
});
