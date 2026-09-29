// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    continueListOnEnter,
    normalizeChecklistPaste,
    toggleLinePrefix,
    toggleTask,
    wrapSelection,
} from "./note-format";

describe("toggleTask", () => {
    const doc = [
        "# List",
        "- [ ] one",
        "* [x] two",
        "```",
        "- [ ] in code",
        "```",
        "1. [ ] three",
        "> - [ ] quoted",
    ].join("\n");
    it("flips the Nth task, skipping fenced code", () => {
        expect(toggleTask(doc, 0).split("\n")[1]).toBe("- [x] one");
        expect(toggleTask(doc, 1).split("\n")[2]).toBe("* [ ] two");
        expect(toggleTask(doc, 2).split("\n")[6]).toBe("1. [x] three");
        expect(toggleTask(doc, 3).split("\n")[7]).toBe("> - [x] quoted");
        expect(toggleTask(doc, 2).split("\n")[4]).toBe("- [ ] in code");
    });
    it("leaves the text alone for an out-of-range index", () => {
        expect(toggleTask(doc, 9)).toBe(doc);
    });
});

describe("normalizeChecklistPaste", () => {
    it("turns pasted checklist lines into task items", () => {
        expect(normalizeChecklistPaste("[ ] milk\n[x] eggs\n  [] bread")).toBe("- [ ] milk\n- [x] eggs\n  - [ ] bread");
        expect(normalizeChecklistPaste("☐ call\n☑ done\n✓ also done")).toBe("- [ ] call\n- [x] done\n- [x] also done");
        expect(normalizeChecklistPaste("* [X] ok")).toBe("- [x] ok");
    });
    it("returns null when nothing changes", () => {
        expect(normalizeChecklistPaste("just text\nmore")).toBeNull();
        expect(normalizeChecklistPaste("- [ ] already\n- [x] fine")).toBeNull();
    });
});

describe("wrapSelection", () => {
    it("wraps and unwraps", () => {
        const r = wrapSelection("say hi now", 4, 6, "**", "**", "bold");
        expect(r.text).toBe("say **hi** now");
        expect(r.text.slice(r.selStart, r.selEnd)).toBe("hi");
        expect(wrapSelection(r.text, r.selStart, r.selEnd, "**", "**", "bold").text).toBe("say hi now");
    });
    it("inserts a selected placeholder when nothing is selected", () => {
        const r = wrapSelection("ab", 1, 1, "`", "`", "code");
        expect(r.text).toBe("a`code`b");
        expect(r.text.slice(r.selStart, r.selEnd)).toBe("code");
    });
});

describe("toggleLinePrefix", () => {
    it("adds and removes checkboxes on selected lines", () => {
        const text = "milk\neggs";
        const r = toggleLinePrefix(text, 0, text.length, "task");
        expect(r.text).toBe("- [ ] milk\n- [ ] eggs");
        expect(toggleLinePrefix(r.text, 0, r.text.length, "task").text).toBe("milk\neggs");
    });
    it("numbers lines and converts other list markers", () => {
        expect(toggleLinePrefix("- a\n- b", 0, 7, "number").text).toBe("1. a\n2. b");
        expect(toggleLinePrefix("a", 0, 0, "heading").text).toBe("## a");
    });
});

describe("continueListOnEnter", () => {
    it("continues tasks unchecked, numbers incremented, bullets", () => {
        const t1 = "- [x] done";
        expect(continueListOnEnter(t1, t1.length).text).toBe("- [x] done\n- [ ] ");
        const t2 = "3. third";
        expect(continueListOnEnter(t2, t2.length).text).toBe("3. third\n4. ");
        const t3 = "  - item";
        expect(continueListOnEnter(t3, t3.length).text).toBe("  - item\n  - ");
    });
    it("ends the list on an empty item and ignores other lines", () => {
        expect(continueListOnEnter("a\n- [ ] ", 8).text).toBe("a\n");
        expect(continueListOnEnter("plain", 5)).toBeNull();
        expect(continueListOnEnter("- item", 2)).toBeNull();
    });
});
