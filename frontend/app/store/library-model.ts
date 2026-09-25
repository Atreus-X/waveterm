// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Shared state for the Library (snippets + notes). The data lives in plain files in the Wave config
// directory (library.json, notes/); this model caches it and inserts snippets into terminals.

import { getBlockComponentModel, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { stringToBase64 } from "@/util/util";
import * as jotai from "jotai";

const SaveDelayMs = 400;

type TermLike = {
    viewType: string;
    termRef?: { current?: { terminal?: { paste: (text: string) => void } } };
    giveFocus?: () => boolean;
};

export class LibraryModel {
    private static instance: LibraryModel | null = null;

    snippetsAtom = jotai.atom<LibrarySnippet[]>([]) as jotai.PrimitiveAtom<LibrarySnippet[]>;
    notesAtom = jotai.atom<LibraryNoteInfo[]>([]) as jotai.PrimitiveAtom<LibraryNoteInfo[]>;
    loadedAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
    errorAtom = jotai.atom<string>(null) as jotai.PrimitiveAtom<string>;
    savingAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
    // the terminal that last had focus, so buttons in other blocks know where to insert
    lastTermBlockIdAtom = jotai.atom<string>(null) as jotai.PrimitiveAtom<string>;
    hostsWithNotesAtom: jotai.Atom<Set<string>>;

    saveTimer: ReturnType<typeof setTimeout> = null;
    loading: Promise<void> = null;

    private constructor() {
        this.hostsWithNotesAtom = jotai.atom(
            (get) =>
                new Set(
                    get(this.notesAtom)
                        .filter((n) => n.host)
                        .map((n) => n.host)
                )
        );
        if (typeof document !== "undefined") {
            document.addEventListener("focusin", (e) => this.onFocusIn(e), true);
        }
    }

    static getInstance(): LibraryModel {
        if (!LibraryModel.instance) {
            LibraryModel.instance = new LibraryModel();
        }
        return LibraryModel.instance;
    }

    onFocusIn(e: FocusEvent) {
        const el = (e.target as HTMLElement)?.closest?.("[data-blockid]") as HTMLElement;
        const blockId = el?.dataset?.blockid;
        if (blockId && this.isTerminal(blockId)) {
            globalStore.set(this.lastTermBlockIdAtom, blockId);
        }
    }

    isTerminal(blockId: string): boolean {
        const vm = getBlockComponentModel(blockId)?.viewModel as unknown as TermLike;
        return vm?.viewType === "term" && vm.termRef?.current?.terminal != null;
    }

    // the terminal to insert into: the last one used, if it's still open
    targetTerminal(): string {
        const id = globalStore.get(this.lastTermBlockIdAtom);
        return id && this.isTerminal(id) ? id : null;
    }

    terminalConnection(blockId: string): string {
        if (!blockId) return "";
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(`block:${blockId}`));
        return block?.meta?.connection ?? "";
    }

    load(force = false): Promise<void> {
        if (this.loading && !force) return this.loading;
        this.loading = (async () => {
            try {
                const [lib, notes] = await Promise.all([
                    RpcApi.LibraryReadCommand(TabRpcClient),
                    RpcApi.LibraryNoteListCommand(TabRpcClient),
                ]);
                globalStore.set(this.snippetsAtom, lib?.snippets ?? []);
                globalStore.set(this.notesAtom, notes ?? []);
                globalStore.set(this.errorAtom, null);
            } catch (e) {
                globalStore.set(this.errorAtom, String(e?.message ?? e));
            } finally {
                globalStore.set(this.loadedAtom, true);
            }
        })();
        return this.loading;
    }

    setSnippets(list: LibrarySnippet[]) {
        globalStore.set(this.snippetsAtom, list);
        if (this.saveTimer != null) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), SaveDelayMs);
    }

    async flush() {
        if (this.saveTimer != null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        globalStore.set(this.savingAtom, true);
        try {
            await RpcApi.LibraryWriteCommand(TabRpcClient, { snippets: globalStore.get(this.snippetsAtom) });
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            globalStore.set(this.errorAtom, `Couldn't save library.json: ${e?.message ?? e}`);
        } finally {
            globalStore.set(this.savingAtom, false);
        }
    }

    async refreshNotes() {
        try {
            globalStore.set(this.notesAtom, (await RpcApi.LibraryNoteListCommand(TabRpcClient)) ?? []);
        } catch (e) {
            globalStore.set(this.errorAtom, String(e?.message ?? e));
        }
    }

    readNote(ref: CommandLibraryNoteRefData): Promise<LibraryNoteData> {
        return RpcApi.LibraryNoteReadCommand(TabRpcClient, ref);
    }

    async writeNote(data: CommandLibraryNoteWriteData): Promise<LibraryNoteData> {
        const rtn = await RpcApi.LibraryNoteWriteCommand(TabRpcClient, data);
        await this.refreshNotes();
        return rtn;
    }

    async deleteNote(ref: CommandLibraryNoteRefData) {
        await RpcApi.LibraryNoteDeleteCommand(TabRpcClient, ref);
        await this.refreshNotes();
    }

    // pastes through xterm (bracketed paste, so a multi-line snippet doesn't execute line by line)
    // and only presses Enter when asked; returns false when there's no terminal to insert into
    insert(text: string, run: boolean, blockId?: string): boolean {
        const target = blockId ?? this.targetTerminal();
        if (!target || !this.isTerminal(target)) return false;
        const vm = getBlockComponentModel(target).viewModel as unknown as TermLike;
        vm.termRef.current.terminal.paste(text);
        if (run) {
            RpcApi.ControllerInputCommand(TabRpcClient, { blockid: target, inputdata64: stringToBase64("\r") });
        }
        globalStore.set(this.lastTermBlockIdAtom, target);
        vm.giveFocus?.();
        return true;
    }
}
