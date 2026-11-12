// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { countFields, filterSections } from "./settingsvisual-search";

const Sections = [
    {
        title: "Terminal",
        fields: [
            { key: "term:fontsize", label: "Font size", tooltip: "Text size in terminals." },
            { key: "term:cursor", label: "Cursor style", tooltip: "Block, underline or bar." },
        ],
    },
    {
        title: "Editor",
        fields: [
            {
                key: "editor:fontsize",
                label: "Font size",
                description: "In the built-in editor.",
                tooltip: "Text size.",
            },
            { key: "editor:wordwrap", label: "Word wrap", tooltip: "Wraps long lines." },
        ],
    },
    {
        title: "Appearance",
        fields: [{ key: "window:opacity", label: "Window opacity", tooltip: "How transparent the window is." }],
    },
];

describe("filterSections", () => {
    it("returns everything for an empty or blank query", () => {
        expect(filterSections(Sections, "")).toBe(Sections);
        expect(filterSections(Sections, "   ")).toBe(Sections);
    });

    it("matches the label, ignoring case", () => {
        const res = filterSections(Sections, "WORD wrap");
        expect(res.map((s) => s.title)).toEqual(["Editor"]);
        expect(res[0].fields.map((f) => f.key)).toEqual(["editor:wordwrap"]);
    });

    it("matches the settings.json key", () => {
        expect(countFields(filterSections(Sections, "term:cursor"))).toBe(1);
    });

    it("matches the tooltip and the description", () => {
        expect(filterSections(Sections, "transparent")[0].fields[0].key).toBe("window:opacity");
        expect(filterSections(Sections, "built-in")[0].fields[0].key).toBe("editor:fontsize");
    });

    it("needs every word to match, and a word can come from the section title", () => {
        const res = filterSections(Sections, "terminal font");
        expect(res).toHaveLength(1);
        expect(res[0].fields.map((f) => f.key)).toEqual(["term:fontsize"]);
    });

    it("drops sections with no match and returns nothing for a miss", () => {
        expect(filterSections(Sections, "font").map((s) => s.title)).toEqual(["Terminal", "Editor"]);
        expect(filterSections(Sections, "nonexistent")).toEqual([]);
    });

    it("does not change the original sections", () => {
        filterSections(Sections, "font");
        expect(countFields(Sections)).toBe(5);
    });
});
