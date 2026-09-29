// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { toggleTask } from "../view/library/note-format";
import { rehypeTaskIndex } from "./markdown-tasks";

function checkboxes(md: string): { index: number; checked: boolean }[] {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeTaskIndex);
    const tree = processor.runSync(processor.parse(md));
    const out: { index: number; checked: boolean }[] = [];
    visit(tree as any, "element", (node: any) => {
        if (node.tagName === "input")
            out.push({ index: node.properties.dataTaskIndex, checked: !!node.properties.checked });
    });
    return out;
}

describe("rehypeTaskIndex", () => {
    const md = "- [ ] one\n- [x] two\n\n```\n- [ ] not a task\n```\n\n1. [ ] three\n";

    it("numbers rendered checkboxes in source order, ignoring code blocks", () => {
        expect(checkboxes(md)).toEqual([
            { index: 0, checked: false },
            { index: 1, checked: true },
            { index: 2, checked: false },
        ]);
    });

    it("the rendered index toggles the matching source line", () => {
        const flipped = toggleTask(md, 2);
        expect(flipped).toContain("1. [x] three");
        expect(checkboxes(flipped).map((c) => c.checked)).toEqual([false, true, true]);
    });
});
