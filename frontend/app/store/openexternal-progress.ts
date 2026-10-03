// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { getApi } from "@/store/global";
import * as jotai from "jotai";
import { openProgressKey, RateState, updateRate } from "./openexternal-progress-util";

const ErrorShowMs = 5000;

export type TransferEntry = {
    id: string;
    connection: string;
    name: string;
    index: number;
    count: number;
    done: number;
    total: number;
    bps: number;
    canceling?: boolean;
};

// Progress of file transfers in the file browser: remote files being downloaded to open in an external
// app (reported by emain-openexternal) and uploads / drag-drop copies (reported by wavesrv as
// filecopy:progress events).
export class OpenExternalProgressModel {
    private static instance: OpenExternalProgressModel | null = null;

    progressAtom = jotai.atom({}) as jotai.PrimitiveAtom<Record<string, OpenFileExternalProgress>>;
    speedAtom = jotai.atom({}) as jotai.PrimitiveAtom<Record<string, number>>;
    transfersAtom = jotai.atom({}) as jotai.PrimitiveAtom<Record<string, TransferEntry>>;
    clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
    rates = new Map<string, RateState>();
    aborts = new Map<string, AbortController>();
    copyEventsSubscribed = false;

    private constructor() {
        try {
            getApi().onOpenFileExternalProgress((p) => this.update(p));
        } catch (e) {
            console.log("open-external progress not available", e);
        }
    }

    static getInstance(): OpenExternalProgressModel {
        if (!OpenExternalProgressModel.instance) {
            OpenExternalProgressModel.instance = new OpenExternalProgressModel();
        }
        return OpenExternalProgressModel.instance;
    }

    update(p: OpenFileExternalProgress) {
        const key = openProgressKey(p.connection, p.path);
        const timer = this.clearTimers.get(key);
        if (timer != null) {
            clearTimeout(timer);
            this.clearTimers.delete(key);
        }
        if (p.phase === "done") {
            this.remove(key);
            return;
        }
        if (p.phase === "download") {
            const rate = updateRate(this.rates.get(key), p.received, Date.now());
            this.rates.set(key, rate);
            globalStore.set(this.speedAtom, { ...globalStore.get(this.speedAtom), [key]: rate.bps });
        }
        globalStore.set(this.progressAtom, { ...globalStore.get(this.progressAtom), [key]: p });
        if (p.phase === "error") {
            this.clearTimers.set(
                key,
                setTimeout(() => this.remove(key), ErrorShowMs)
            );
        }
    }

    remove(key: string) {
        this.clearTimers.delete(key);
        this.rates.delete(key);
        const next = { ...globalStore.get(this.progressAtom) };
        delete next[key];
        globalStore.set(this.progressAtom, next);
        const speeds = { ...globalStore.get(this.speedAtom) };
        delete speeds[key];
        globalStore.set(this.speedAtom, speeds);
    }

    cancelDownload(p: OpenFileExternalProgress) {
        getApi().cancelOpenFileExternal(p.path, p.connection);
    }

    ensureCopyEvents() {
        if (this.copyEventsSubscribed) {
            return;
        }
        this.copyEventsSubscribed = true;
        waveEventSubscribeSingle({
            eventType: "filecopy:progress",
            handler: (event) => this.updateTransfer(event.data),
        });
    }

    updateTransfer(data: FileCopyProgressData) {
        const cur = globalStore.get(this.transfersAtom)[data.xferid];
        if (cur == null) {
            return;
        }
        const rate = updateRate(this.rates.get(data.xferid), data.done, Date.now());
        this.rates.set(data.xferid, rate);
        this.setTransfer({ ...cur, name: data.name || cur.name, done: data.done, total: data.total, bps: rate.bps });
    }

    setTransfer(entry: TransferEntry) {
        globalStore.set(this.transfersAtom, { ...globalStore.get(this.transfersAtom), [entry.id]: entry });
    }

    // One transfer card per batch; every file in the batch is copied under the batch's xferid, so the
    // byte counts restart for each file while the card stays put.
    beginTransfer(connection: string, count: number): { id: string; signal: AbortSignal } {
        this.ensureCopyEvents();
        const id = crypto.randomUUID();
        const controller = new AbortController();
        this.aborts.set(id, controller);
        this.setTransfer({ id, connection, name: "", index: 0, count, done: 0, total: 0, bps: 0 });
        return { id, signal: controller.signal };
    }

    setTransferItem(id: string, name: string, index: number) {
        const cur = globalStore.get(this.transfersAtom)[id];
        if (cur == null) {
            return;
        }
        this.rates.delete(id);
        this.setTransfer({ ...cur, name, index, done: 0, total: 0, bps: 0 });
    }

    cancelTransfer(id: string) {
        const cur = globalStore.get(this.transfersAtom)[id];
        if (cur != null) {
            this.setTransfer({ ...cur, canceling: true });
        }
        this.aborts.get(id)?.abort();
    }

    endTransfer(id: string) {
        this.aborts.delete(id);
        this.rates.delete(id);
        const next = { ...globalStore.get(this.transfersAtom) };
        delete next[id];
        globalStore.set(this.transfersAtom, next);
    }
}
