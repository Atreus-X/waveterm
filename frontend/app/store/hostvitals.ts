// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Shared live-vitals poller for SSH hosts. Every consumer (connection-chip meters, the Fleet block)
// subscribes by connection name; each connection is polled once no matter how many blocks show it,
// only while something is subscribed, only while it's connected, and never while the window is hidden.

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { WaveEnv } from "@/app/waveenv/waveenv";
import * as jotai from "jotai";
import { useEffect } from "react";

export type HostVitalsDeps = {
    rpc: { HostInfoCommand: WaveEnv["rpc"]["HostInfoCommand"] };
    getConnStatusAtom: WaveEnv["getConnStatusAtom"];
};

export type HostVitalsSeries = {
    latest: HostVitalsInfo;
    ts: number;
    // oldest first, one point per poll
    cpu: number[];
    mem: number[];
    rx: number[];
    tx: number[];
    error: string;
};

const PollMs = 5000;
const HistoryLen = 60;

function push(arr: number[], v: number): number[] {
    const next = arr.length >= HistoryLen ? arr.slice(arr.length - HistoryLen + 1) : arr.slice();
    next.push(v);
    return next;
}

export class HostVitalsModel {
    private static instance: HostVitalsModel | null = null;

    refCounts = new Map<string, number>();
    deps = new Map<string, HostVitalsDeps>();
    seriesAtoms = new Map<string, jotai.PrimitiveAtom<HostVitalsSeries>>();
    inflight = new Set<string>();
    timer: ReturnType<typeof setInterval> = null;

    private constructor() {}

    static getInstance(): HostVitalsModel {
        if (!HostVitalsModel.instance) {
            HostVitalsModel.instance = new HostVitalsModel();
        }
        return HostVitalsModel.instance;
    }

    getSeriesAtom(conn: string): jotai.PrimitiveAtom<HostVitalsSeries> {
        let a = this.seriesAtoms.get(conn);
        if (a == null) {
            a = jotai.atom<HostVitalsSeries>(null) as jotai.PrimitiveAtom<HostVitalsSeries>;
            this.seriesAtoms.set(conn, a);
        }
        return a;
    }

    subscribe(conn: string, deps: HostVitalsDeps): () => void {
        this.refCounts.set(conn, (this.refCounts.get(conn) ?? 0) + 1);
        this.deps.set(conn, deps);
        if (this.timer == null) {
            this.timer = setInterval(() => this.pollAll(), PollMs);
        }
        this.pollOne(conn);
        return () => {
            const n = (this.refCounts.get(conn) ?? 1) - 1;
            if (n <= 0) {
                this.refCounts.delete(conn);
                this.deps.delete(conn);
            } else {
                this.refCounts.set(conn, n);
            }
            if (this.refCounts.size === 0 && this.timer != null) {
                clearInterval(this.timer);
                this.timer = null;
            }
        };
    }

    pollAll() {
        if (typeof document !== "undefined" && document.hidden) return;
        for (const conn of this.refCounts.keys()) {
            this.pollOne(conn);
        }
    }

    async pollOne(conn: string) {
        const deps = this.deps.get(conn);
        if (deps == null || this.inflight.has(conn)) return;
        if (!globalStore.get(deps.getConnStatusAtom(conn))?.connected) return;
        this.inflight.add(conn);
        const atom = this.getSeriesAtom(conn);
        try {
            const resp = await deps.rpc.HostInfoCommand(
                TabRpcClient,
                { conn, sections: ["vitals"] },
                { timeout: 15000 }
            );
            const v = resp?.vitals;
            if (v == null) {
                throw new Error(resp?.errors?.vitals ?? "no vitals returned");
            }
            const prev = globalStore.get(atom);
            const memPct = v.memtotal ? ((v.memtotal - v.memavail) / v.memtotal) * 100 : 0;
            globalStore.set(atom, {
                latest: v,
                ts: resp.ts,
                cpu: push(prev?.cpu ?? [], v.cpupct),
                mem: push(prev?.mem ?? [], memPct),
                rx: push(prev?.rx ?? [], v.rxrate),
                tx: push(prev?.tx ?? [], v.txrate),
                error: null,
            });
        } catch (e) {
            const prev = globalStore.get(atom);
            globalStore.set(atom, {
                latest: prev?.latest ?? null,
                ts: prev?.ts ?? 0,
                cpu: prev?.cpu ?? [],
                mem: prev?.mem ?? [],
                rx: prev?.rx ?? [],
                tx: prev?.tx ?? [],
                error: String(e?.message ?? e),
            });
        } finally {
            this.inflight.delete(conn);
        }
    }
}

// subscribes while mounted (and enabled); returns the latest series for the connection
export function useHostVitals(conn: string, enabled: boolean, deps: HostVitalsDeps): HostVitalsSeries {
    const model = HostVitalsModel.getInstance();
    const series = jotai.useAtomValue(model.getSeriesAtom(conn ?? ""));
    useEffect(() => {
        if (!enabled || !conn) return;
        return model.subscribe(conn, deps);
    }, [conn, enabled]);
    return enabled ? series : null;
}
