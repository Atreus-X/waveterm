// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { LibraryModel } from "@/app/store/library-model";
import { WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { cn } from "@/util/util";
import * as jotai from "jotai";
import { memo, useEffect, useMemo, useState } from "react";
import { hostMatches, newSnippet, parsePlaceholders, rankSnippets, splitList } from "./library-util";
import { NoteEditor } from "./note-editor";
import { SnippetFill } from "./snippet-fill";

export type LibraryEnv = WaveEnvSubset<{
    atoms: { fullConfigAtom: WaveEnv["atoms"]["fullConfigAtom"] };
    createBlock: WaveEnv["createBlock"];
}>;

type LibraryTab = "snippets" | "notes";

// set by openLibraryNote() just before creating a Library block, consumed by that block's model
const PendingNoteAtom = jotai.atom<CommandLibraryNoteRefData>(null) as jotai.PrimitiveAtom<CommandLibraryNoteRefData>;

export function openLibraryNote(createBlock: WaveEnv["createBlock"], ref: CommandLibraryNoteRefData) {
    globalStore.set(PendingNoteAtom, ref);
    createBlock({ meta: { view: "library" } });
}

export function targetLabel(lib: LibraryModel, blockId: string): string {
    if (!blockId) return null;
    const conn = lib.terminalConnection(blockId);
    return conn ? `${conn} terminal` : "local terminal";
}

export class LibraryViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    env: LibraryEnv;
    lib = LibraryModel.getInstance();

    viewIcon = jotai.atom<string>("book-bookmark");
    viewName = jotai.atom<string>("Library");
    noPadding = jotai.atom<boolean>(true);

    tabAtom = jotai.atom<LibraryTab>("snippets") as jotai.PrimitiveAtom<LibraryTab>;
    selectedSnippetAtom = jotai.atom<string>(null) as jotai.PrimitiveAtom<string>;
    selectedNoteAtom = jotai.atom<CommandLibraryNoteRefData>(null) as jotai.PrimitiveAtom<CommandLibraryNoteRefData>;
    fillingAtom = jotai.atom<LibrarySnippet>(null) as jotai.PrimitiveAtom<LibrarySnippet>;
    flashAtom = jotai.atom<string>(null) as jotai.PrimitiveAtom<string>;
    endIconButtons: jotai.Atom<IconButtonDecl[]>;

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.viewType = "library";
        this.blockId = blockId;
        this.env = waveEnv;
        this.lib.load();
        const pending = globalStore.get(PendingNoteAtom);
        if (pending != null) {
            globalStore.set(PendingNoteAtom, null);
            globalStore.set(this.tabAtom, "notes");
            globalStore.set(this.selectedNoteAtom, pending);
        }
        this.endIconButtons = jotai.atom(
            () =>
                [
                    {
                        elemtype: "iconbutton",
                        icon: "arrows-rotate",
                        title: "Reload from disk (after editing library.json or notes outside Wave)",
                        click: () => this.lib.load(true),
                    },
                ] as IconButtonDecl[]
        );
    }

    get viewComponent(): ViewComponent {
        return LibraryView;
    }

    flash(msg: string) {
        globalStore.set(this.flashAtom, msg);
        setTimeout(() => {
            if (globalStore.get(this.flashAtom) === msg) globalStore.set(this.flashAtom, null);
        }, 4000);
    }

    updateSnippet(id: string, patch: Partial<LibrarySnippet>) {
        const list = globalStore.get(this.lib.snippetsAtom).map((s) => (s.id === id ? { ...s, ...patch } : s));
        this.lib.setSnippets(list);
    }

    addSnippet(base?: LibrarySnippet) {
        const s = base ? { ...base, id: crypto.randomUUID(), title: `${base.title} (copy)` } : newSnippet();
        this.lib.setSnippets([...globalStore.get(this.lib.snippetsAtom), s]);
        globalStore.set(this.selectedSnippetAtom, s.id);
    }

    deleteSnippet(id: string) {
        this.lib.setSnippets(globalStore.get(this.lib.snippetsAtom).filter((s) => s.id !== id));
        globalStore.set(this.selectedSnippetAtom, null);
    }

    // with placeholders this opens the fill-in form; otherwise inserts right away
    startInsert(s: LibrarySnippet) {
        if (parsePlaceholders(s.body).length > 0) {
            globalStore.set(this.fillingAtom, s);
            return;
        }
        this.finishInsert(s.body, !!s.run);
    }

    finishInsert(text: string, run: boolean) {
        globalStore.set(this.fillingAtom, null);
        const target = this.lib.targetTerminal();
        if (!this.lib.insert(text, run, target)) {
            this.flash("Click into a terminal first, then insert again.");
        }
    }

    runInNewTerminal(s: LibrarySnippet, conn: string) {
        if (parsePlaceholders(s.body).length > 0) {
            this.flash("Fill-in fields need a terminal to insert into; use Insert instead.");
            return;
        }
        const connMeta = conn && conn !== "local" ? { connection: conn } : {};
        this.env.createBlock({
            meta: { view: "term", controller: "cmd", cmd: s.body, "cmd:shell": true, ...connMeta },
        });
    }
}

const inputCls = "rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-accent";

const SnippetEditor = memo(({ model, snippet }: { model: LibraryViewModel; snippet: LibrarySnippet }) => {
    const targetId = jotai.useAtomValue(model.lib.lastTermBlockIdAtom);
    const fullConfig = jotai.useAtomValue(model.env.atoms.fullConfigAtom);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [runConn, setRunConn] = useState("local");
    const placeholders = parsePlaceholders(snippet.body);
    const target = model.lib.isTerminal(targetId) ? targetLabel(model.lib, targetId) : null;
    const conns = useMemo(
        () => ["local", ...Object.keys(fullConfig?.connections ?? {}).filter((c) => !c.startsWith("wsl://"))],
        [fullConfig]
    );
    const set = (patch: Partial<LibrarySnippet>) => model.updateSnippet(snippet.id, patch);
    return (
        <div className="flex flex-col gap-3">
            <input
                value={snippet.title}
                onChange={(e) => set({ title: e.target.value })}
                className={cn(inputCls, "text-sm font-semibold")}
            />
            <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted">
                    Command · use <span className="font-mono">{"{{name}}"}</span> or{" "}
                    <span className="font-mono">{"{{name=default}}"}</span> for fill-in fields
                </span>
                <textarea
                    value={snippet.body}
                    onChange={(e) => set({ body: e.target.value })}
                    spellCheck={false}
                    rows={Math.min(12, Math.max(3, snippet.body.split("\n").length + 1))}
                    className={cn(inputCls, "resize-y font-mono leading-relaxed")}
                />
                {placeholders.length > 0 && (
                    <span className="text-[11px] text-muted">
                        Asks for:{" "}
                        {placeholders
                            .map((p) => (p.defaultValue ? `${p.name} (default ${p.defaultValue})` : p.name))
                            .join(", ")}
                    </span>
                )}
            </label>
            <input
                value={snippet.description ?? ""}
                onChange={(e) => set({ description: e.target.value })}
                placeholder="Description (optional)"
                className={inputCls}
            />
            <div className="grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted">Tags, comma-separated</span>
                    <input
                        value={(snippet.tags ?? []).join(", ")}
                        onChange={(e) => set({ tags: splitList(e.target.value) })}
                        className={inputCls}
                    />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted">For hosts (listed first there), e.g. *.example.com, db*</span>
                    <input
                        value={(snippet.hosts ?? []).join(", ")}
                        onChange={(e) => set({ hosts: splitList(e.target.value) })}
                        className={inputCls}
                    />
                </label>
            </div>
            <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-secondary select-none">
                <input
                    type="checkbox"
                    checked={!!snippet.run}
                    onChange={(e) => set({ run: e.target.checked })}
                    className="cursor-pointer"
                />
                Press Enter after inserting (run immediately)
            </label>
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <button
                    onClick={() => model.startInsert(snippet)}
                    disabled={!target}
                    className="cursor-pointer rounded bg-accent/80 px-3 py-1 text-xs text-primary transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50"
                >
                    <i className="fa-solid fa-arrow-right-to-bracket mr-1.5" />
                    Insert
                </button>
                <span className="text-[11px] text-muted">
                    {target ? `into the ${target}` : "click into a terminal first"}
                </span>
                <span className="mx-1 h-4 w-px bg-border" />
                <select
                    value={runConn}
                    onChange={(e) => setRunConn(e.target.value)}
                    className={cn(inputCls, "cursor-pointer bg-background")}
                >
                    {conns.map((c) => (
                        <option key={c} value={c}>
                            {c}
                        </option>
                    ))}
                </select>
                <button
                    onClick={() => model.runInNewTerminal(snippet, runConn)}
                    className="cursor-pointer rounded border border-border px-3 py-1 text-xs transition-colors hover:bg-hoverbg"
                >
                    Run in new terminal
                </button>
                <span className="flex-1" />
                <button
                    onClick={() => model.addSnippet(snippet)}
                    className="cursor-pointer rounded px-2 py-1 text-xs text-secondary hover:bg-hoverbg"
                >
                    Duplicate
                </button>
                {confirmDelete ? (
                    <>
                        <button
                            onClick={() => model.deleteSnippet(snippet.id)}
                            className="cursor-pointer rounded bg-error/20 px-2 py-1 text-xs text-error hover:bg-error/30"
                        >
                            Delete it
                        </button>
                        <button
                            onClick={() => setConfirmDelete(false)}
                            className="cursor-pointer rounded px-2 py-1 text-xs text-secondary hover:bg-hoverbg"
                        >
                            Keep
                        </button>
                    </>
                ) : (
                    <button
                        onClick={() => setConfirmDelete(true)}
                        className="cursor-pointer rounded px-2 py-1 text-xs text-secondary hover:bg-hoverbg hover:text-error"
                    >
                        Delete
                    </button>
                )}
            </div>
        </div>
    );
});
SnippetEditor.displayName = "SnippetEditor";

const SnippetsTab = memo(({ model }: { model: LibraryViewModel }) => {
    const snippets = jotai.useAtomValue(model.lib.snippetsAtom);
    const selectedId = jotai.useAtomValue(model.selectedSnippetAtom);
    const filling = jotai.useAtomValue(model.fillingAtom);
    const targetId = jotai.useAtomValue(model.lib.lastTermBlockIdAtom);
    const [query, setQuery] = useState("");
    const conn = model.lib.terminalConnection(targetId);
    const shown = rankSnippets(snippets, query, conn);
    const selected = snippets.find((s) => s.id === selectedId) ?? null;
    const target = model.lib.isTerminal(targetId) ? targetLabel(model.lib, targetId) : null;
    return (
        <div className="flex min-h-0 flex-1">
            <div className="flex w-64 shrink-0 flex-col border-r border-border">
                <div className="flex items-center gap-2 border-b border-border p-2">
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search snippets"
                        className={cn(inputCls, "min-w-0 flex-1")}
                    />
                    <button
                        onClick={() => model.addSnippet()}
                        title="New snippet"
                        aria-label="New snippet"
                        className="cursor-pointer rounded px-2 py-1 text-secondary transition-colors hover:bg-hoverbg hover:text-primary"
                    >
                        <i className="fa-solid fa-plus" />
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                    {snippets.length === 0 && (
                        <div className="p-4 text-xs text-muted">
                            No snippets yet. Add one with +, or press Cmd+Shift+L (Alt+Shift+L on Windows/Linux) in a
                            terminal to pick one.
                        </div>
                    )}
                    {shown.map((s) => (
                        <button
                            key={s.id}
                            onClick={() => globalStore.set(model.selectedSnippetAtom, s.id)}
                            onDoubleClick={() => model.startInsert(s)}
                            className={cn(
                                "flex w-full cursor-pointer flex-col gap-0.5 border-b border-border/50 px-3 py-2 text-left",
                                s.id === selectedId ? "bg-accent/15" : "hover:bg-hoverbg"
                            )}
                        >
                            <span className="flex items-center gap-1.5 text-xs font-medium">
                                <span className="truncate">{s.title || "Untitled"}</span>
                                {hostMatches(s.hosts, conn) && (
                                    <i
                                        className="fa-solid fa-location-dot text-[10px] text-accent"
                                        title="Meant for this host"
                                    />
                                )}
                                {s.run && (
                                    <i className="fa-solid fa-bolt text-[10px] text-warning" title="Runs immediately" />
                                )}
                            </span>
                            <span className="truncate font-mono text-[11px] text-muted">{s.body.split("\n")[0]}</span>
                        </button>
                    ))}
                </div>
            </div>
            <div className="min-w-0 flex-1 overflow-auto p-3">
                {filling ? (
                    <SnippetFill
                        snippet={filling}
                        targetLabel={target}
                        onCancel={() => globalStore.set(model.fillingAtom, null)}
                        onInsert={(text, run) => model.finishInsert(text, run)}
                    />
                ) : selected ? (
                    <SnippetEditor model={model} snippet={selected} />
                ) : (
                    <div className="py-10 text-center text-xs text-muted">
                        Pick a snippet to edit it, or double-click one to insert it into the{" "}
                        {target ?? "last terminal you used"}.
                    </div>
                )}
            </div>
        </div>
    );
});
SnippetsTab.displayName = "SnippetsTab";

function sameNote(a: CommandLibraryNoteRefData, b: CommandLibraryNoteRefData): boolean {
    return a != null && b != null && (a.host ?? "") === (b.host ?? "") && (a.name ?? "") === (b.name ?? "");
}

const NotesTab = memo(({ model }: { model: LibraryViewModel }) => {
    const notes = jotai.useAtomValue(model.lib.notesAtom);
    const selected = jotai.useAtomValue(model.selectedNoteAtom);
    const [newName, setNewName] = useState<string>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [error, setError] = useState<string>(null);
    const general = notes.filter((n) => !n.host);
    const hosts = notes.filter((n) => n.host);
    const createNote = async () => {
        const name = (newName ?? "").trim();
        if (!name) return;
        try {
            await model.lib.writeNote({ name, content: `# ${name}\n\n` });
            globalStore.set(model.selectedNoteAtom, { name });
            setNewName(null);
            setError(null);
        } catch (e) {
            setError(String(e?.message ?? e));
        }
    };
    const renderItem = (n: LibraryNoteInfo) => {
        const ref = n.host ? { host: n.host } : { name: n.name };
        return (
            <button
                key={n.host ? `h:${n.host}` : `n:${n.name}`}
                onClick={() => {
                    setConfirmDelete(false);
                    globalStore.set(model.selectedNoteAtom, ref);
                }}
                className={cn(
                    "flex w-full cursor-pointer flex-col gap-0.5 border-b border-border/50 px-3 py-2 text-left",
                    sameNote(selected, ref) ? "bg-accent/15" : "hover:bg-hoverbg"
                )}
            >
                <span className="truncate text-xs font-medium">{n.host ?? n.name}</span>
                {n.header && n.header !== (n.host ?? n.name) && (
                    <span className="truncate text-[11px] text-muted">{n.header}</span>
                )}
            </button>
        );
    };
    return (
        <div className="flex min-h-0 flex-1">
            <div className="flex w-64 shrink-0 flex-col border-r border-border">
                <div className="flex items-center gap-2 border-b border-border p-2">
                    {newName == null ? (
                        <button
                            onClick={() => setNewName("")}
                            className="flex-1 cursor-pointer rounded border border-border px-2 py-1 text-xs text-secondary transition-colors hover:bg-hoverbg hover:text-primary"
                        >
                            <i className="fa-solid fa-plus mr-1.5" />
                            New note
                        </button>
                    ) : (
                        <input
                            autoFocus
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") createNote();
                                if (e.key === "Escape") setNewName(null);
                            }}
                            onBlur={() => !newName && setNewName(null)}
                            placeholder="Note name, then Enter"
                            className={cn(inputCls, "min-w-0 flex-1")}
                        />
                    )}
                </div>
                {error && <div className="px-3 py-1 text-[11px] text-error">{error}</div>}
                <div className="min-h-0 flex-1 overflow-auto">
                    <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                        Notes
                    </div>
                    {general.length === 0 && <div className="px-3 pb-2 text-[11px] text-muted">None yet.</div>}
                    {general.map((n) => renderItem(n))}
                    <div className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                        Host notes
                    </div>
                    {hosts.length === 0 && (
                        <div className="px-3 pb-2 text-[11px] text-muted">
                            Write one from a host's Host Inspector or its connection chip.
                        </div>
                    )}
                    {hosts.map((n) => renderItem(n))}
                </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
                {selected ? (
                    <>
                        <div className="flex items-center gap-2">
                            <i className={cn("fa-solid text-muted", selected.host ? "fa-server" : "fa-note-sticky")} />
                            <span className="truncate text-sm font-semibold">{selected.host ?? selected.name}</span>
                            <span className="flex-1" />
                            {confirmDelete ? (
                                <>
                                    <button
                                        onClick={async () => {
                                            await model.lib.deleteNote(selected);
                                            globalStore.set(model.selectedNoteAtom, null);
                                            setConfirmDelete(false);
                                        }}
                                        className="cursor-pointer rounded bg-error/20 px-2 py-0.5 text-xs text-error hover:bg-error/30"
                                    >
                                        Delete it
                                    </button>
                                    <button
                                        onClick={() => setConfirmDelete(false)}
                                        className="cursor-pointer rounded px-2 py-0.5 text-xs text-secondary hover:bg-hoverbg"
                                    >
                                        Keep
                                    </button>
                                </>
                            ) : (
                                <button
                                    onClick={() => setConfirmDelete(true)}
                                    className="cursor-pointer rounded px-2 py-0.5 text-xs text-secondary hover:bg-hoverbg hover:text-error"
                                >
                                    Delete
                                </button>
                            )}
                        </div>
                        <NoteEditor key={selected.host ?? `n:${selected.name}`} noteRef={selected} />
                    </>
                ) : (
                    <div className="py-10 text-center text-xs text-muted">
                        Pick a note, or start a new one. Notes are Markdown files in your Wave config folder (notes/),
                        so you can also edit them in any editor.
                    </div>
                )}
            </div>
        </div>
    );
});
NotesTab.displayName = "NotesTab";

export const LibraryView = memo(({ model }: ViewComponentProps<LibraryViewModel>) => {
    const tab = jotai.useAtomValue(model.tabAtom);
    const loaded = jotai.useAtomValue(model.lib.loadedAtom);
    const error = jotai.useAtomValue(model.lib.errorAtom);
    const flash = jotai.useAtomValue(model.flashAtom);
    const saving = jotai.useAtomValue(model.lib.savingAtom);
    useEffect(() => {
        // write any pending snippet edits when the block closes
        return () => {
            model.lib.flush();
        };
    }, []);
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
                {(["snippets", "notes"] as LibraryTab[]).map((t) => (
                    <button
                        key={t}
                        onClick={() => globalStore.set(model.tabAtom, t)}
                        className={cn(
                            "cursor-pointer rounded px-3 py-1 text-xs",
                            tab === t ? "bg-accent/20 text-primary" : "text-secondary hover:bg-hoverbg"
                        )}
                    >
                        <i className={cn("fa-solid mr-1.5", t === "snippets" ? "fa-code" : "fa-note-sticky")} />
                        {t === "snippets" ? "Snippets" : "Notes"}
                    </button>
                ))}
                <span className="ml-auto text-[11px] text-muted">{saving ? "Saving…" : ""}</span>
            </div>
            {(error || flash) && (
                <div className={cn("border-b border-border px-3 py-1 text-xs", error ? "text-error" : "text-warning")}>
                    {error ?? flash}
                </div>
            )}
            {!loaded ? (
                <div className="py-10 text-center text-xs text-muted">Loading…</div>
            ) : tab === "snippets" ? (
                <SnippetsTab model={model} />
            ) : (
                <NotesTab model={model} />
            )}
        </div>
    );
});
LibraryView.displayName = "LibraryView";
