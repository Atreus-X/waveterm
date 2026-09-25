// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { fillPlaceholders, parsePlaceholders } from "./library-util";

type SnippetFillProps = {
    snippet: LibrarySnippet;
    // where the text will go, e.g. "admin@server terminal"; null when there's no terminal to insert into
    targetLabel: string;
    onCancel: () => void;
    onInsert: (text: string, run: boolean) => void;
};

// the {{placeholder}} form: one field per placeholder, a live preview, Insert / Insert and run
export const SnippetFill = memo(({ snippet, targetLabel, onCancel, onInsert }: SnippetFillProps) => {
    const placeholders = useMemo(() => parsePlaceholders(snippet.body), [snippet.body]);
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(placeholders.map((p) => [p.name, p.defaultValue]))
    );
    const firstRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        firstRef.current?.focus();
        firstRef.current?.select();
    }, []);
    const text = fillPlaceholders(snippet.body, values);
    const btn =
        "cursor-pointer rounded px-3 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-50";
    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
                e.preventDefault();
                if (targetLabel) onInsert(text, !!snippet.run);
            }}
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancel();
                }
            }}
        >
            <div className="text-sm font-semibold">{snippet.title}</div>
            {placeholders.map((p, i) => (
                <label key={p.name} className="flex flex-col gap-1 text-xs">
                    <span className="text-secondary">{p.name}</span>
                    <input
                        ref={i === 0 ? firstRef : undefined}
                        value={values[p.name] ?? ""}
                        placeholder={p.defaultValue || p.name}
                        onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
                        className="rounded border border-border bg-transparent px-2 py-1 font-mono text-xs outline-none focus:border-accent"
                    />
                </label>
            ))}
            <div className="flex flex-col gap-1 text-xs">
                <span className="text-muted">Will insert</span>
                <pre className="max-h-40 overflow-auto rounded border border-border bg-panel px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap">
                    {text}
                </pre>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    disabled={!targetLabel}
                    onClick={() => onInsert(text, false)}
                    className={cn(
                        btn,
                        !snippet.run
                            ? "bg-accent/80 text-primary hover:bg-accent"
                            : "border border-border hover:bg-hoverbg"
                    )}
                >
                    Insert
                </button>
                <button
                    type="button"
                    disabled={!targetLabel}
                    onClick={() => onInsert(text, true)}
                    className={cn(
                        btn,
                        snippet.run
                            ? "bg-accent/80 text-primary hover:bg-accent"
                            : "border border-border hover:bg-hoverbg"
                    )}
                >
                    Insert and run
                </button>
                <button type="button" onClick={onCancel} className={cn(btn, "text-secondary hover:bg-hoverbg")}>
                    Cancel
                </button>
                <span className="text-[11px] text-muted">
                    {targetLabel ? `into the ${targetLabel}` : "Click into a terminal first"}
                </span>
            </div>
        </form>
    );
});
SnippetFill.displayName = "SnippetFill";
