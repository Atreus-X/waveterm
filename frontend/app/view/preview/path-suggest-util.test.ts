// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { applySuggestion, commonPrefix, filterSuggestions, splitPathInput } from "./path-suggest-util";

describe("splitPathInput", () => {
    it("splits dir and prefix", () => {
        expect(splitPathInput("/srv/data/do")).toEqual({ dir: "/srv/data", prefix: "do" });
        expect(splitPathInput("/srv/data/")).toEqual({ dir: "/srv/data", prefix: "" });
        expect(splitPathInput("/et")).toEqual({ dir: "/", prefix: "et" });
        expect(splitPathInput("~/pro")).toEqual({ dir: "~", prefix: "pro" });
        expect(splitPathInput("~")).toEqual({ dir: "~", prefix: "" });
    });
    it("ignores the leading LRM", () => {
        expect(splitPathInput("‎/var/lo")).toEqual({ dir: "/var", prefix: "lo" });
    });
    it("returns null with no directory part", () => {
        expect(splitPathInput("")).toBeNull();
        expect(splitPathInput("foo")).toBeNull();
    });
});

describe("filterSuggestions", () => {
    const entries = [
        { name: "zeta.txt", isdir: false },
        { name: "alpha", isdir: true },
        { name: ".hidden", isdir: true },
        { name: "Alpine.md", isdir: false },
        { name: "..", isdir: true },
    ];
    it("filters by case-insensitive prefix, dirs first", () => {
        expect(filterSuggestions(entries, "al", true).map((e) => e.name)).toEqual(["alpha", "Alpine.md"]);
        expect(filterSuggestions(entries, "", true).map((e) => e.name)).toEqual([
            ".hidden",
            "alpha",
            "Alpine.md",
            "zeta.txt",
        ]);
    });
    it("hides dotfiles unless enabled or typed", () => {
        expect(filterSuggestions(entries, "", false).map((e) => e.name)).toEqual(["alpha", "Alpine.md", "zeta.txt"]);
        expect(filterSuggestions(entries, ".", false).map((e) => e.name)).toEqual([".hidden"]);
    });
});

describe("applySuggestion", () => {
    it("appends a slash for directories", () => {
        expect(applySuggestion("/srv/da", { name: "data", isdir: true })).toBe("/srv/data/");
        expect(applySuggestion("/e", { name: "etc", isdir: true })).toBe("/etc/");
        expect(applySuggestion("~/a", { name: "a.txt", isdir: false })).toBe("~/a.txt");
    });
});

describe("commonPrefix", () => {
    it("finds the shared prefix", () => {
        expect(commonPrefix(["config", "config.bak", "Configs"])).toBe("config");
        expect(commonPrefix(["a"])).toBe("a");
        expect(commonPrefix([])).toBe("");
    });
});
