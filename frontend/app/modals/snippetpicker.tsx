// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { LibraryModel } from "@/app/store/library-model";
import { modalsModel } from "@/app/store/modalmodel";
import { targetLabel } from "@/app/view/library/library";
import { hostMatches, parsePlaceholders, rankSnippets } from "@/app/view/library/library-util";
import { SnippetFill } from "@/app/view/library/snippet-fill";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useRef, useState } from "react";

const PickerName = "SnippetPickerModal";

// opens the picker for a terminal block (the one the shortcut or context menu came from)
export function openSnippetPicker(termBlockId: string) {
    LibraryModel.getInstance().load();
    modalsModel.pushModal(PickerName, { termBlockId });
}

export const SnippetPickerModal = memo(({ termBlockId }: { termBlockId: string }) => {
    const lib = LibraryModel.getInstance();
    const snippets = useAtomValue(lib.snippetsAtom);
    const loaded = useAtomValue(lib.loadedAtom);
    const [query, setQuery] = useState("");
    const [idx, setIdx] = useState(0);
    const [filling, setFilling] = useState<LibrarySnippet>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const target = lib.isTerminal(termBlockId) ? termBlockId : lib.targetTerminal();
    const conn = lib.terminalConnection(target);
    const label = target ? targetLabel(lib, target) : null;
    const shown = rankSnippets(snippets, query, conn);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);
    useEffect(() => {
        setIdx(0);
    }, [query]);
    useEffect(() => {
        listRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
    }, [idx]);

    const close = () => modalsModel.popModal();
    const insert = (text: string, run: boolean) => {
        close();
        lib.insert(text, run, target);
    };
    const choose = (s: LibrarySnippet, forceRun: boolean) => {
        if (s == null || !target) return;
        if (parsePlaceholders(s.body).length > 0) {
            setFilling(forceRun ? { ...s, run: true } : s);
            return;
        }
        insert(s.body, forceRun || !!s.run);
    };

    return (
        <div
            className="fixed inset-0 z-[500] flex items-start justify-center bg-black/40 pt-[12vh]"
            onMouseDown={close}
        >
            <div
                className="flex max-h-[70vh] w-[600px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl"
                onMouseDown={(e) => e.stopPropagation()}
            >
                {filling ? (
                    <div className="p-4">
                        <SnippetFill
                            snippet={filling}
                            targetLabel={label}
                            onCancel={() => {
                                setFilling(null);
                                setTimeout(() => inputRef.current?.focus(), 0);
                            }}
                            onInsert={insert}
                        />
                    </div>
                ) : (
                    <>
                        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                            <i className="fa-solid fa-code text-muted" />
                            <input
                                ref={inputRef}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        close();
                                    } else if (e.key === "ArrowDown") {
                                        e.preventDefault();
                                        setIdx((i) => Math.min(i + 1, shown.length - 1));
                                    } else if (e.key === "ArrowUp") {
                                        e.preventDefault();
                                        setIdx((i) => Math.max(i - 1, 0));
                                    } else if (e.key === "Enter") {
                                        e.preventDefault();
                                        choose(shown[idx], e.ctrlKey || e.metaKey);
                                    }
                                }}
                                placeholder={
                                    label ? `Insert a snippet into the ${label}` : "Click into a terminal first"
                                }
                                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                            />
                        </div>
                        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
                            {!loaded && <div className="px-3 py-4 text-xs text-muted">Loading…</div>}
                            {loaded && snippets.length === 0 && (
                                <div className="px-3 py-4 text-xs text-muted">
                                    No snippets yet. Add some from the Library widget in the sidebar.
                                </div>
                            )}
                            {loaded && snippets.length > 0 && shown.length === 0 && (
                                <div className="px-3 py-4 text-xs text-muted">No snippet matches "{query}".</div>
                            )}
                            {shown.map((s, i) => (
                                <button
                                    key={s.id}
                                    data-idx={i}
                                    onMouseEnter={() => setIdx(i)}
                                    onClick={(e) => choose(s, e.ctrlKey || e.metaKey)}
                                    className={cn(
                                        "flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left",
                                        i === idx ? "bg-accent/20" : ""
                                    )}
                                >
                                    <span className="flex items-center gap-1.5 text-xs font-medium">
                                        <span className="truncate">{s.title || "Untitled"}</span>
                                        {hostMatches(s.hosts, conn) && (
                                            <i className="fa-solid fa-location-dot text-[10px] text-accent" />
                                        )}
                                        {s.run && <i className="fa-solid fa-bolt text-[10px] text-warning" />}
                                        {parsePlaceholders(s.body).length > 0 && (
                                            <span className="text-[10px] text-muted">fill-in</span>
                                        )}
                                    </span>
                                    <span className="truncate font-mono text-[11px] text-muted">
                                        {s.body.split("\n")[0]}
                                    </span>
                                </button>
                            ))}
                        </div>
                        <div className="flex gap-4 border-t border-border px-3 py-1.5 text-[11px] text-muted">
                            <span>↑↓ choose</span>
                            <span>Enter insert</span>
                            <span>Ctrl/Cmd+Enter insert and run</span>
                            <span>Esc close</span>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
});
SnippetPickerModal.displayName = PickerName;
