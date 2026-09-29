// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Markdown editing helpers for Library notes: task-list checkboxes, checklist paste detection,
// and the formatting toolbar. All pure (text in, text + selection out).

export type TextEdit = { text: string; selStart: number; selEnd: number };

// a GFM task item: optional blockquote markers, a list marker, then [ ] / [x]
const TaskLineRe = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/;
const FenceRe = /^\s*(```|~~~)/;

/** Flips the Nth task item (document order, skipping fenced code), or returns the text unchanged. */
export function toggleTask(text: string, taskIndex: number): string {
    const lines = text.split("\n");
    let inFence = false;
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
        if (FenceRe.test(lines[i])) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const m = TaskLineRe.exec(lines[i]);
        if (!m) continue;
        if (n === taskIndex) {
            const mark = m[2] === " " ? "x" : " ";
            lines[i] = m[1] + "[" + mark + "]" + lines[i].slice(m[0].length);
            return lines.join("\n");
        }
        n++;
    }
    return text;
}

// "[ ] x", "[x] x", "- [ ] x", "* [X] x", "☐ x", "☑ x", "✓ x" …
const PasteCheckRe = /^(\s*)(?:[-*+•]\s+)?(\[\s?\]|\[[xX✓✔]\]|☐|☑|☒|✓|✔|✅)\s*(.*)$/;

/** Pasted checklist lines become GFM task items; null when nothing in the text looks like one. */
export function normalizeChecklistPaste(text: string): string {
    let changed = false;
    const out = text.split(/\r?\n/).map((line) => {
        const m = PasteCheckRe.exec(line);
        if (!m) return line;
        const checked = !/^\[\s?\]$|^☐$/.test(m[2]);
        const normalized = `${m[1]}- [${checked ? "x" : " "}] ${m[3]}`.replace(/\s+$/, " ");
        if (normalized.trimEnd() !== line.trimEnd()) changed = true;
        return normalized.trimEnd() === `${m[1]}- [${checked ? "x" : " "}]` ? normalized : normalized.trimEnd();
    });
    return changed ? out.join("\n") : null;
}

/** Wraps the selection (or a placeholder) in before/after, e.g. ** for bold; unwraps if already wrapped. */
export function wrapSelection(
    text: string,
    start: number,
    end: number,
    before: string,
    after: string,
    placeholder: string
): TextEdit {
    const sel = text.slice(start, end);
    if (
        start >= before.length &&
        text.slice(start - before.length, start) === before &&
        text.slice(end, end + after.length) === after
    ) {
        const t = text.slice(0, start - before.length) + sel + text.slice(end + after.length);
        return { text: t, selStart: start - before.length, selEnd: end - before.length };
    }
    const inner = sel || placeholder;
    const t = text.slice(0, start) + before + inner + after + text.slice(end);
    return { text: t, selStart: start + before.length, selEnd: start + before.length + inner.length };
}

function lineBounds(text: string, start: number, end: number): [number, number] {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = text.indexOf("\n", end > start && text[end - 1] === "\n" ? end - 1 : end);
    if (lineEnd < 0) lineEnd = text.length;
    return [lineStart, lineEnd];
}

export type LinePrefixKind = "bullet" | "number" | "task" | "quote" | "heading";

const ListPrefixRe = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?|#{1,6}\s+)?/;

function prefixFor(kind: LinePrefixKind, i: number): string {
    switch (kind) {
        case "bullet":
            return "- ";
        case "number":
            return `${i + 1}. `;
        case "task":
            return "- [ ] ";
        case "quote":
            return "> ";
        case "heading":
            return "## ";
    }
}

/** Applies a line prefix to every selected line; if they all already have it, removes it. */
export function toggleLinePrefix(text: string, start: number, end: number, kind: LinePrefixKind): TextEdit {
    const [ls, le] = lineBounds(text, start, end);
    const lines = text.slice(ls, le).split("\n");
    const has = (line: string, i: number) => {
        const body = line.replace(/^\s*/, "");
        if (kind === "number") return /^\d+[.)]\s/.test(body);
        if (kind === "task") return /^[-*+]\s+\[[ xX]\]\s/.test(body) || /^[-*+]\s+\[[ xX]\]$/.test(body);
        if (kind === "bullet") return /^[-*+]\s/.test(body) && !/^[-*+]\s+\[[ xX]\]/.test(body);
        return body.startsWith(prefixFor(kind, i).trimEnd());
    };
    const allHave = lines.every((l, i) => l.trim() === "" || has(l, i));
    const out = lines.map((line, i) => {
        if (line.trim() === "" && lines.length > 1) return line;
        const m = ListPrefixRe.exec(line);
        const indent = m[1];
        const body = line.slice(m[0].length);
        return allHave ? indent + body : indent + prefixFor(kind, i) + body;
    });
    const replaced = out.join("\n");
    const t = text.slice(0, ls) + replaced + text.slice(le);
    if (start === end) {
        const caret = Math.max(ls, Math.min(ls + replaced.length, start + (replaced.length - (le - ls))));
        return { text: t, selStart: caret, selEnd: caret };
    }
    return { text: t, selStart: ls, selEnd: ls + replaced.length };
}

const ContinueRe = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|(\d+)([.)])\s+|>\s?)(.*)$/;

/** Enter at the end of a list/task/quote line continues it; on an empty item it ends the list. null = default Enter. */
export function continueListOnEnter(text: string, caret: number): TextEdit {
    const ls = text.lastIndexOf("\n", caret - 1) + 1;
    let le = text.indexOf("\n", caret);
    if (le < 0) le = text.length;
    if (caret !== le) return null;
    const line = text.slice(ls, le);
    const m = ContinueRe.exec(line);
    if (!m) return null;
    const [, indent, marker, num, delim, rest] = m;
    if (rest.trim() === "") {
        const t = text.slice(0, ls) + text.slice(le);
        return { text: t, selStart: ls, selEnd: ls };
    }
    let next = marker;
    if (num != null) next = `${Number(num) + 1}${delim} `;
    else if (/\[[ xX]\]/.test(marker)) next = marker.replace(/\[[xX]\]/, "[ ]");
    const insert = "\n" + indent + next;
    const t = text.slice(0, caret) + insert + text.slice(caret);
    return { text: t, selStart: caret + insert.length, selEnd: caret + insert.length };
}
