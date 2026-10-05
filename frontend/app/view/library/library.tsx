// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { ScrollArea } from "@/app/element/scrollarea";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { LibraryModel } from "@/app/store/library-model";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { cn, fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import React, { memo, useEffect, useMemo, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
    hostMatches,
    LibraryTab,
    newSnippet,
    parsePlaceholders,
    parseTabOrder,
    rankSnippets,
    splitList,
    swapTabOrder,
} from "./library-util";
import { NoteEditor } from "./note-editor";
import { SnippetFill } from "./snippet-fill";

export type LibraryEnv = WaveEnvSubset<{
    atoms: { fullConfigAtom: WaveEnv["atoms"]["fullConfigAtom"] };
    rpc: { SetConfigCommand: WaveEnv["rpc"]["SetConfigCommand"] };
    createBlock: WaveEnv["createBlock"];
}>;

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
    tabOrderAtom: jotai.Atom<LibraryTab[]>;

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.viewType = "library";
        this.blockId = blockId;
        this.env = waveEnv;
        this.tabOrderAtom = jotai.atom((get) =>
            parseTabOrder(get(this.env.atoms.fullConfigAtom)?.settings?.["library:taborder"])
        );
        globalStore.set(this.tabAtom, globalStore.get(this.tabOrderAtom)[0]);
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

    // saved in settings (library:taborder), so every Library block uses the same order
    swapTabs() {
        const next = swapTabOrder(globalStore.get(this.tabOrderAtom));
        fireAndForget(() => this.env.rpc.SetConfigCommand(TabRpcClient, { "library:taborder": next }));
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

function listHiddenKey(id: string): string {
    return `wave-library-${id}-list-hidden`;
}

function useListHidden(id: string): [boolean, (hidden: boolean) => void] {
    const [hidden, setHiddenState] = useState(() => {
        try {
            return localStorage.getItem(listHiddenKey(id)) === "1";
        } catch {
            return false;
        }
    });
    const setHidden = (next: boolean) => {
        setHiddenState(next);
        try {
            localStorage.setItem(listHiddenKey(id), next ? "1" : "0");
        } catch {}
    };
    return [hidden, setHidden];
}

function ListToggleButton({ noun, onClick, icon }: { noun: string; onClick: () => void; icon: string }) {
    const label = icon === "fa-angles-left" ? `Hide ${noun} list` : `Show ${noun} list`;
    return (
        <button
            onClick={onClick}
            title={label}
            aria-label={label}
            className="cursor-pointer rounded px-2 py-1 text-secondary transition-colors hover:bg-hoverbg hover:text-primary"
        >
            <i className={cn("fa-solid", icon)} />
        </button>
    );
}

// list | draggable divider | detail; each tab remembers its own divider position (per viewer).
// When the list is hidden, the detail pane takes the full width and a thin rail brings the list back.
function LibrarySplit({
    id,
    noun,
    hidden,
    onShow,
    children,
}: {
    id: string;
    noun: string;
    hidden: boolean;
    onShow: () => void;
    children: [React.ReactNode, React.ReactNode];
}) {
    if (hidden) {
        return (
            <div className="flex min-h-0 flex-1">
                <div className="flex shrink-0 flex-col border-r border-border p-1">
                    <ListToggleButton noun={noun} onClick={onShow} icon="fa-angles-right" />
                </div>
                <div className="min-h-0 min-w-0 flex-1">{children[1]}</div>
            </div>
        );
    }
    return (
        <PanelGroup direction="horizontal" autoSaveId={`wave-library-${id}-split`} className="min-h-0 flex-1">
            <Panel defaultSize={32} minSize={15} maxSize={75} className="min-h-0">
                {children[0]}
            </Panel>
            <PanelResizeHandle
                className="w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40 data-[resize-handle-state=drag]:bg-accent/60"
                title="Drag to resize"
            />
            <Panel minSize={25} className="min-h-0 min-w-0">
                {children[1]}
            </Panel>
        </PanelGroup>
    );
}

const SnippetsTab = memo(({ model }: { model: LibraryViewModel }) => {
    const snippets = jotai.useAtomValue(model.lib.snippetsAtom);
    const selectedId = jotai.useAtomValue(model.selectedSnippetAtom);
    const filling = jotai.useAtomValue(model.fillingAtom);
    const targetId = jotai.useAtomValue(model.lib.lastTermBlockIdAtom);
    const [query, setQuery] = useState("");
    const [listHidden, setListHidden] = useListHidden("snippets");
    const conn = model.lib.terminalConnection(targetId);
    const shown = rankSnippets(snippets, query, conn);
    const selected = snippets.find((s) => s.id === selectedId) ?? null;
    const target = model.lib.isTerminal(targetId) ? targetLabel(model.lib, targetId) : null;
    return (
        <LibrarySplit id="snippets" noun="snippets" hidden={listHidden} onShow={() => setListHidden(false)}>
            <div className="flex h-full min-h-0 flex-col border-r border-border">
                <div className="flex items-center gap-2 border-b border-border p-2">
                    <ListToggleButton noun="snippets" onClick={() => setListHidden(true)} icon="fa-angles-left" />
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
                <ScrollArea className="flex-1">
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
                </ScrollArea>
            </div>
            <ScrollArea className="h-full min-w-0">
                <div className="p-3">
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
            </ScrollArea>
        </LibrarySplit>
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
    const [renameTo, setRenameTo] = useState<string>(null);
    const [editorVer, setEditorVer] = useState(0);
    const [error, setError] = useState<string>(null);
    const [listHidden, setListHidden] = useListHidden("notes");
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
    const selectedInfo = selected
        ? notes.find((n) => sameNote(selected, n.host ? { host: n.host } : { name: n.name }))
        : null;
    const commitTitle = async () => {
        const next = (renameTo ?? "").trim();
        setRenameTo(null);
        if (!selected || !next || next === selected.name) return;
        try {
            await model.lib.renameNote({ name: selected.name, newname: next });
            globalStore.set(model.selectedNoteAtom, { name: next });
            setError(null);
        } catch (e) {
            setError(String(e?.message ?? e));
        }
    };
    const commitDescription = async (value: string) => {
        const next = value.trim();
        if (!selected || !next || next === (selectedInfo?.header ?? "")) return;
        try {
            await model.lib.renameNote({ ...selected, newheader: next });
            setEditorVer((v) => v + 1);
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
                    setRenameTo(null);
                    setError(null);
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
        <LibrarySplit id="notes" noun="notes" hidden={listHidden} onShow={() => setListHidden(false)}>
            <div className="flex h-full min-h-0 flex-col border-r border-border">
                <div className="flex items-center gap-2 border-b border-border p-2">
                    <ListToggleButton noun="notes" onClick={() => setListHidden(true)} icon="fa-angles-left" />
                    {newName == null ? (
                        <button
                            onClick={() => {
                                setError(null);
                                setNewName("");
                            }}
                            className="flex-1 cursor-pointer rounded border border-border px-2 py-1 text-xs text-secondary transition-colors hover:bg-hoverbg hover:text-primary"
                        >
                            <i className="fa-solid fa-plus mr-1.5" />
                            New note
                        </button>
                    ) : (
                        <input
                            autoFocus
                            value={newName}
                            onChange={(e) => {
                                setError(null);
                                setNewName(e.target.value);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") createNote();
                                if (e.key === "Escape") {
                                    setError(null);
                                    setNewName(null);
                                }
                            }}
                            onBlur={() => !newName && setNewName(null)}
                            placeholder="Note name, then Enter"
                            className={cn(inputCls, "min-w-0 flex-1")}
                        />
                    )}
                </div>
                {error && <div className="px-3 py-1 text-[11px] text-error">{error}</div>}
                <ScrollArea className="flex-1">
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
                </ScrollArea>
            </div>
            <div className="flex h-full min-w-0 flex-col gap-2 p-3">
                {selected ? (
                    <>
                        <div className="flex items-center gap-2">
                            <i className={cn("fa-solid text-muted", selected.host ? "fa-server" : "fa-note-sticky")} />
                            {renameTo != null ? (
                                <input
                                    autoFocus
                                    value={renameTo}
                                    onChange={(e) => {
                                        setError(null);
                                        setRenameTo(e.target.value);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") commitTitle();
                                        if (e.key === "Escape") {
                                            setError(null);
                                            setRenameTo(null);
                                        }
                                    }}
                                    onBlur={commitTitle}
                                    className={cn(inputCls, "min-w-0 flex-1")}
                                />
                            ) : (
                                <>
                                    <span className="truncate text-sm font-semibold">
                                        {selected.host ?? selected.name}
                                    </span>
                                    {!selected.host && (
                                        <button
                                            title="Rename"
                                            onClick={() => {
                                                setError(null);
                                                setRenameTo(selected.name);
                                            }}
                                            className="cursor-pointer rounded px-1 text-xs text-muted hover:bg-hoverbg hover:text-primary"
                                        >
                                            <i className="fa-solid fa-pen" />
                                        </button>
                                    )}
                                </>
                            )}
                            <span className="flex-1" />
                            {confirmDelete ? (
                                <>
                                    <button
                                        onClick={async () => {
                                            await model.lib.deleteNote(selected);
                                            globalStore.set(model.selectedNoteAtom, null);
                                            setConfirmDelete(false);
                                            setError(null);
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
                        <input
                            key={`d:${selected.host ?? selected.name}:${selectedInfo?.header ?? ""}`}
                            defaultValue={selectedInfo?.header ?? ""}
                            placeholder="Description (the note's first line)"
                            onChange={() => setError(null)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
                            }}
                            onBlur={(e) => commitDescription(e.target.value)}
                            className={cn(inputCls, "w-full")}
                        />
                        <NoteEditor key={`${selected.host ?? `n:${selected.name}`}:${editorVer}`} noteRef={selected} />
                    </>
                ) : (
                    <div className="py-10 text-center text-xs text-muted">
                        Pick a note, or start a new one. Notes are Markdown files in your Wave config folder (notes/),
                        so you can also edit them in any editor.
                    </div>
                )}
            </div>
        </LibrarySplit>
    );
});
NotesTab.displayName = "NotesTab";

export const LibraryView = memo(({ model }: ViewComponentProps<LibraryViewModel>) => {
    const tab = jotai.useAtomValue(model.tabAtom);
    const tabOrder = jotai.useAtomValue(model.tabOrderAtom);
    const [dragTab, setDragTab] = useState<LibraryTab>(null);
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
            <div
                className="flex items-center gap-1 border-b border-border px-2 py-1.5"
                onContextMenu={(e) => {
                    e.preventDefault();
                    ContextMenuModel.getInstance().showContextMenu(
                        [{ label: "Swap Tab Order", click: () => model.swapTabs() }],
                        e
                    );
                }}
            >
                {tabOrder.map((t) => (
                    <button
                        key={t}
                        draggable
                        onDragStart={(e) => {
                            setDragTab(t);
                            e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => setDragTab(null)}
                        onDragOver={(e) => {
                            if (dragTab != null && dragTab !== t) e.preventDefault();
                        }}
                        onDrop={(e) => {
                            e.preventDefault();
                            if (dragTab != null && dragTab !== t) model.swapTabs();
                            setDragTab(null);
                        }}
                        onClick={() => globalStore.set(model.tabAtom, t)}
                        title="Drag to swap the tab order (or right-click)"
                        className={cn(
                            "cursor-pointer rounded px-3 py-1 text-xs",
                            tab === t ? "bg-accent/20 text-primary" : "text-secondary hover:bg-hoverbg",
                            dragTab === t && "opacity-50"
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
