// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { Markdown } from "@/app/element/markdown";
import { LibraryModel } from "@/app/store/library-model";
import { cn } from "@/util/util";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import {
    continueListOnEnter,
    normalizeChecklistPaste,
    TextEdit,
    toggleLinePrefix,
    toggleTask,
    wrapSelection,
} from "./note-format";

const AutosaveMs = 800;

type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";

type NoteEditorProps = {
    noteRef: CommandLibraryNoteRefData;
    placeholder?: string;
    // smaller chrome for the Host Inspector card
    compact?: boolean;
};

function refKey(r: CommandLibraryNoteRefData): string {
    return r.host ? `host:${r.host}` : `name:${r.name}`;
}

// Applies an edit through the browser's insertText so Ctrl+Z still works: only the changed middle
// part is replaced, then the selection is set. Falls back to setting the value directly.
function applyEdit(ta: HTMLTextAreaElement, edit: TextEdit, setValue: (v: string) => void) {
    const old = ta.value;
    let p = 0;
    while (p < old.length && p < edit.text.length && old[p] === edit.text[p]) p++;
    let s = 0;
    while (
        s < old.length - p &&
        s < edit.text.length - p &&
        old[old.length - 1 - s] === edit.text[edit.text.length - 1 - s]
    ) {
        s++;
    }
    ta.focus();
    ta.setSelectionRange(p, old.length - s);
    const ok = document.execCommand("insertText", false, edit.text.slice(p, edit.text.length - s));
    if (!ok || ta.value !== edit.text) {
        setValue(edit.text);
        requestAnimationFrame(() => ta.setSelectionRange(edit.selStart, edit.selEnd));
        return;
    }
    ta.setSelectionRange(edit.selStart, edit.selEnd);
}

type FormatAction = {
    icon: string;
    title: string;
    run: (text: string, start: number, end: number) => TextEdit;
};

const FormatActions: (FormatAction | "sep")[] = [
    { icon: "bold", title: "Bold (Ctrl/Cmd+B)", run: (t, s, e) => wrapSelection(t, s, e, "**", "**", "bold") },
    { icon: "italic", title: "Italic (Ctrl/Cmd+I)", run: (t, s, e) => wrapSelection(t, s, e, "_", "_", "italic") },
    { icon: "strikethrough", title: "Strikethrough", run: (t, s, e) => wrapSelection(t, s, e, "~~", "~~", "text") },
    "sep",
    { icon: "heading", title: "Heading", run: (t, s, e) => toggleLinePrefix(t, s, e, "heading") },
    { icon: "list-ul", title: "Bulleted list", run: (t, s, e) => toggleLinePrefix(t, s, e, "bullet") },
    { icon: "list-ol", title: "Numbered list", run: (t, s, e) => toggleLinePrefix(t, s, e, "number") },
    { icon: "square-check", title: "Checklist", run: (t, s, e) => toggleLinePrefix(t, s, e, "task") },
    { icon: "quote-left", title: "Quote", run: (t, s, e) => toggleLinePrefix(t, s, e, "quote") },
    "sep",
    { icon: "code", title: "Inline code", run: (t, s, e) => wrapSelection(t, s, e, "`", "`", "code") },
    {
        icon: "file-code",
        title: "Code block",
        run: (t, s, e) => wrapSelection(t, s, e, "```\n", "\n```", "code"),
    },
    { icon: "link", title: "Link", run: (t, s, e) => wrapSelection(t, s, e, "[", "](https://)", "text") },
];

export const NoteEditor = memo(({ noteRef, placeholder, compact }: NoteEditorProps) => {
    const lib = LibraryModel.getInstance();
    const [content, setContent] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [mode, setMode] = useState<"edit" | "preview">("edit");
    const [state, setState] = useState<SaveState>("idle");
    const [error, setError] = useState<string>(null);
    // latest values for the debounced save and the unmount flush
    const cur = useRef({ content: "", baseModTs: 0, exists: false, dirty: false, key: "" });
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    const taRef = useRef<HTMLTextAreaElement>(null);

    const save = useCallback(
        async (force: boolean) => {
            if (timer.current != null) {
                clearTimeout(timer.current);
                timer.current = null;
            }
            const c = cur.current;
            if (!c.dirty && !force) return;
            const ref = noteRef;
            setState("saving");
            try {
                if (ref.host && c.content.trim() === "") {
                    // an empty host note just goes away instead of leaving an empty file behind
                    await lib.deleteNote(ref);
                    Object.assign(c, { baseModTs: 0, exists: false, dirty: false });
                } else {
                    const rtn = await lib.writeNote({
                        ...ref,
                        content: c.content,
                        basemodts: force ? 0 : c.baseModTs,
                    });
                    Object.assign(c, { baseModTs: rtn.modts, exists: true, dirty: false });
                }
                setState("saved");
                setError(null);
            } catch (e) {
                const msg = String(e?.message ?? e);
                setState(/changed on disk/.test(msg) ? "conflict" : "error");
                setError(msg);
            }
        },
        [noteRef.host, noteRef.name]
    );

    const load = useCallback(async () => {
        setLoaded(false);
        try {
            const n = await lib.readNote(noteRef);
            cur.current = {
                content: n.content ?? "",
                baseModTs: n.modts ?? 0,
                exists: !!n.exists,
                dirty: false,
                key: refKey(noteRef),
            };
            setContent(n.content ?? "");
            setState("idle");
            setError(null);
            setMode(n.exists && !compact ? "preview" : "edit");
        } catch (e) {
            setError(String(e?.message ?? e));
            setState("error");
        } finally {
            setLoaded(true);
        }
    }, [noteRef.host, noteRef.name]);

    useEffect(() => {
        load();
        return () => {
            if (cur.current.dirty) save(false);
        };
    }, [load]);

    const onChange = (v: string) => {
        setContent(v);
        cur.current.content = v;
        cur.current.dirty = true;
        setState("idle");
        if (timer.current != null) clearTimeout(timer.current);
        timer.current = setTimeout(() => save(false), AutosaveMs);
    };

    const runFormat = (action: FormatAction) => {
        const ta = taRef.current;
        if (ta == null) return;
        applyEdit(ta, action.run(ta.value, ta.selectionStart, ta.selectionEnd), onChange);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const ta = e.currentTarget;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === "s") {
            e.preventDefault();
            save(false);
            return;
        }
        if (mod && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === "b" || e.key.toLowerCase() === "i")) {
            e.preventDefault();
            const [before, placeholder] = e.key.toLowerCase() === "b" ? ["**", "bold"] : ["_", "italic"];
            applyEdit(
                ta,
                wrapSelection(ta.value, ta.selectionStart, ta.selectionEnd, before, before, placeholder),
                onChange
            );
            return;
        }
        if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
            if (ta.selectionStart !== ta.selectionEnd) return;
            const edit = continueListOnEnter(ta.value, ta.selectionStart);
            if (edit == null) return;
            e.preventDefault();
            applyEdit(ta, edit, onChange);
        }
    };

    // checklist lines pasted from elsewhere ("[ ] milk", "☐ call") become checkboxes
    const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const normalized = normalizeChecklistPaste(e.clipboardData.getData("text/plain"));
        if (normalized == null) return;
        e.preventDefault();
        const ta = e.currentTarget;
        const { selectionStart: s, selectionEnd: en, value } = ta;
        const text = value.slice(0, s) + normalized + value.slice(en);
        const caret = s + normalized.length;
        applyEdit(ta, { text, selStart: caret, selEnd: caret }, onChange);
    };

    const onTaskToggle = (taskIndex: number) => {
        const next = toggleTask(cur.current.content, taskIndex);
        if (next !== cur.current.content) onChange(next);
    };

    const status =
        state === "saving"
            ? "Saving…"
            : state === "saved"
              ? "Saved"
              : cur.current.dirty
                ? "Unsaved changes"
                : cur.current.exists
                  ? ""
                  : "Not saved yet";

    return (
        <div className={cn("flex min-h-0 flex-col gap-2", compact ? "" : "h-full")}>
            <div className="flex items-center gap-2 text-xs">
                {(["edit", "preview"] as const).map((m) => (
                    <button
                        key={m}
                        onClick={() => {
                            if (m === "preview") save(false);
                            setMode(m);
                        }}
                        className={cn(
                            "cursor-pointer rounded px-2 py-0.5",
                            mode === m ? "bg-accent/20 text-primary" : "text-secondary hover:bg-hoverbg"
                        )}
                    >
                        {m === "edit" ? "Edit" : "Preview"}
                    </button>
                ))}
                <span className="ml-auto text-[11px] text-muted">{status}</span>
            </div>
            {state === "conflict" && (
                <div className="flex flex-wrap items-center gap-2 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning">
                    <span className="flex-1">This note was changed outside Wave after you opened it.</span>
                    <button onClick={() => load()} className="cursor-pointer rounded px-2 py-0.5 hover:bg-hoverbg">
                        Reload theirs
                    </button>
                    <button onClick={() => save(true)} className="cursor-pointer rounded px-2 py-0.5 hover:bg-hoverbg">
                        Keep mine
                    </button>
                </div>
            )}
            {state === "error" && error && <div className="text-xs text-error">{error}</div>}
            {!loaded ? (
                <div className="py-4 text-center text-xs text-muted">Loading…</div>
            ) : mode === "edit" ? (
                <>
                    <div className="flex flex-wrap items-center gap-0.5">
                        {FormatActions.map((a, i) =>
                            a === "sep" ? (
                                <span key={`sep${i}`} className="mx-1 h-4 w-px bg-border" />
                            ) : (
                                <button
                                    key={a.icon}
                                    title={a.title}
                                    aria-label={a.title}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => runFormat(a)}
                                    className="cursor-pointer rounded px-1.5 py-0.5 text-secondary transition-colors hover:bg-hoverbg hover:text-primary"
                                >
                                    <i className={`fa-solid fa-${a.icon} fa-fw text-[11px]`} />
                                </button>
                            )
                        )}
                    </div>
                    <textarea
                        ref={taRef}
                        value={content}
                        onChange={(e) => onChange(e.target.value)}
                        onBlur={() => save(false)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        placeholder={placeholder ?? "Write in Markdown… (- [ ] makes a checkbox)"}
                        spellCheck={false}
                        className={cn(
                            "w-full resize-none rounded border border-border bg-transparent p-2 font-mono text-xs leading-relaxed outline-none focus:border-accent",
                            compact ? "h-32" : "min-h-0 flex-1"
                        )}
                    />
                </>
            ) : (
                <div
                    className={cn(
                        "overflow-auto rounded border border-border p-2",
                        compact ? "max-h-48" : "min-h-0 flex-1"
                    )}
                >
                    {content.trim() ? (
                        <Markdown text={content} className="text-sm" onTaskToggle={onTaskToggle} />
                    ) : (
                        <div className="text-xs text-muted">Nothing here yet.</div>
                    )}
                </div>
            )}
        </div>
    );
});
NoteEditor.displayName = "NoteEditor";
