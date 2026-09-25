// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { Markdown } from "@/app/element/markdown";
import { LibraryModel } from "@/app/store/library-model";
import { cn } from "@/util/util";
import { memo, useCallback, useEffect, useRef, useState } from "react";

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
                <textarea
                    value={content}
                    onChange={(e) => onChange(e.target.value)}
                    onBlur={() => save(false)}
                    onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                            e.preventDefault();
                            save(false);
                        }
                    }}
                    placeholder={placeholder ?? "Write in Markdown…"}
                    spellCheck={false}
                    className={cn(
                        "w-full resize-none rounded border border-border bg-transparent p-2 font-mono text-xs leading-relaxed outline-none focus:border-accent",
                        compact ? "h-32" : "min-h-0 flex-1"
                    )}
                />
            ) : (
                <div
                    className={cn(
                        "overflow-auto rounded border border-border p-2",
                        compact ? "max-h-48" : "min-h-0 flex-1"
                    )}
                >
                    {content.trim() ? (
                        <Markdown text={content} className="text-sm" />
                    ) : (
                        <div className="text-xs text-muted">Nothing here yet.</div>
                    )}
                </div>
            )}
        </div>
    );
});
NoteEditor.displayName = "NoteEditor";
