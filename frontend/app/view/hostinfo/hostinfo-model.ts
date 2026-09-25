// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MetaKeyAtomFnType, WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { isBlank } from "@/util/util";
import * as jotai from "jotai";
import { HostInfoView } from "./hostinfo";
import { diffHost, emptyChanges, HostChanges, HostSectionId, HostSections } from "./hostinfo-util";

export type HostInfoEnv = WaveEnvSubset<{
    rpc: {
        HostInfoCommand: WaveEnv["rpc"]["HostInfoCommand"];
        HostActionCommand: WaveEnv["rpc"]["HostActionCommand"];
    };
    createBlock: WaveEnv["createBlock"];
    getConnStatusAtom: WaveEnv["getConnStatusAtom"];
    getBlockMetaKeyAtom: MetaKeyAtomFnType<"connection">;
}>;

// how often each backend section refreshes while its tab is on screen (system also feeds the vitals strip)
const RefreshMs: Record<string, number> = {
    system: 5000,
    network: 5000,
    processes: 5000,
    ports: 15000,
    services: 15000,
    docker: 15000,
};
const TickMs = 1000;

export type HostActionReq = {
    kind: "service" | "container" | "process";
    target: string;
    action: string;
    // what the confirmation and status line call it, e.g. "Restart nginx.service"
    label: string;
};

export type HostActionState = {
    key: string;
    phase: "confirm" | "running" | "done" | "error" | "needsauth";
    req: HostActionReq;
    message?: string;
    authCommand?: string;
};

export function actionKey(req: { kind: string; target: string; action: string }): string {
    return `${req.kind}|${req.target}|${req.action}`;
}

function backendSection(id: HostSectionId): string {
    return HostSections.find((s) => s.id === id)?.backend ?? "system";
}

export class HostInfoViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    env: HostInfoEnv;

    viewIcon = jotai.atom<string>("server");
    viewName = jotai.atom<string>("Host Inspector");
    manageConnection = jotai.atom<boolean>(true);
    filterOutNowsh = jotai.atom<boolean>(false);
    noPadding = jotai.atom<boolean>(true);

    sectionAtom = jotai.atom<HostSectionId>("overview") as jotai.PrimitiveAtom<HostSectionId>;
    dataAtom = jotai.atom<HostInfoData>(null) as jotai.PrimitiveAtom<HostInfoData>;
    baselineAtom = jotai.atom<HostInfoData>(null) as jotai.PrimitiveAtom<HostInfoData>;
    errorAtom = jotai.atom<string>(null) as jotai.PrimitiveAtom<string>;
    loadingAtom = jotai.atom<boolean>(true) as jotai.PrimitiveAtom<boolean>;
    pausedAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
    dockerStatsAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
    updatedAtAtom = jotai.atom<Record<string, number>>({}) as jotai.PrimitiveAtom<Record<string, number>>;
    actionAtom = jotai.atom<HostActionState>(null) as jotai.PrimitiveAtom<HostActionState>;

    connection: jotai.Atom<string>;
    connStatus: jotai.Atom<ConnStatus>;
    changesAtom: jotai.Atom<HostChanges>;
    endIconButtons: jotai.Atom<IconButtonDecl[]>;

    disposed = false;
    timer: ReturnType<typeof setInterval> = null;
    inflight = new Set<string>();
    loadedConn: string = null;
    lastFetch: Record<string, number> = {};

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.viewType = "hostinfo";
        this.blockId = blockId;
        this.env = waveEnv;

        this.connection = jotai.atom((get) => {
            const connValue = get(this.env.getBlockMetaKeyAtom(blockId, "connection"));
            return isBlank(connValue) ? "local" : connValue;
        });
        this.connStatus = jotai.atom((get) => {
            const connName = get(this.env.getBlockMetaKeyAtom(blockId, "connection"));
            return get(this.env.getConnStatusAtom(connName));
        });
        this.changesAtom = jotai.atom((get) => {
            const base = get(this.baselineAtom);
            const cur = get(this.dataAtom);
            return base == null || cur == null ? emptyChanges() : diffHost(base, cur);
        });
        this.endIconButtons = jotai.atom((get) => {
            const paused = get(this.pausedAtom);
            return [
                {
                    elemtype: "iconbutton",
                    icon: paused ? "play" : "pause",
                    title: paused ? "Resume live updates" : "Pause live updates",
                    click: () => globalStore.set(this.pausedAtom, !paused),
                },
                {
                    elemtype: "iconbutton",
                    icon: "arrows-rotate",
                    title: "Refresh now",
                    click: () => this.refreshNow(),
                },
            ] as IconButtonDecl[];
        });

        this.timer = setInterval(() => this.tick(), TickMs);
        this.tick();
    }

    get viewComponent(): ViewComponent {
        return HostInfoView;
    }

    canPoll(): boolean {
        const conn = globalStore.get(this.connection);
        if (conn === "local") return true;
        const status = globalStore.get(this.connStatus);
        return !!status?.connected;
    }

    tick() {
        if (this.disposed) return;
        const conn = globalStore.get(this.connection);
        if (conn !== this.loadedConn) {
            this.resetForConn(conn);
        }
        if (!this.canPoll()) {
            globalStore.set(this.loadingAtom, false);
            return;
        }
        if (globalStore.get(this.dataAtom) == null) {
            this.fetch(
                HostSections.map((s) => s.backend),
                true
            );
            return;
        }
        if (globalStore.get(this.pausedAtom) || document.hidden) return;
        const now = Date.now();
        const wanted = new Set(["system", backendSection(globalStore.get(this.sectionAtom))]);
        const due = [...wanted].filter((s) => now - (this.lastFetch[s] ?? 0) >= (RefreshMs[s] ?? 15000));
        if (due.length > 0) {
            this.fetch(due, false);
        }
    }

    resetForConn(conn: string) {
        this.loadedConn = conn;
        this.lastFetch = {};
        this.inflight.clear();
        globalStore.set(this.dataAtom, null);
        globalStore.set(this.baselineAtom, null);
        globalStore.set(this.errorAtom, null);
        globalStore.set(this.actionAtom, null);
        globalStore.set(this.updatedAtAtom, {});
        globalStore.set(this.loadingAtom, true);
    }

    async fetch(sections: string[], isInitial: boolean) {
        const todo = sections.filter((s) => !this.inflight.has(s));
        if (todo.length === 0) return;
        const conn = globalStore.get(this.connection);
        const now = Date.now();
        todo.forEach((s) => {
            this.inflight.add(s);
            this.lastFetch[s] = now;
        });
        try {
            const resp = await this.env.rpc.HostInfoCommand(
                TabRpcClient,
                { conn, sections: todo, dockerstats: todo.includes("docker") && globalStore.get(this.dockerStatsAtom) },
                { timeout: 30000 }
            );
            if (this.disposed || conn !== this.loadedConn) return;
            this.mergeData(resp, todo);
            if (isInitial) {
                globalStore.set(this.baselineAtom, globalStore.get(this.dataAtom));
            }
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            if (this.disposed || conn !== this.loadedConn) return;
            globalStore.set(this.errorAtom, String(e?.message ?? e));
        } finally {
            todo.forEach((s) => this.inflight.delete(s));
            if (!this.disposed) globalStore.set(this.loadingAtom, false);
        }
    }

    mergeData(resp: HostInfoData, sections: string[]) {
        const prev = globalStore.get(this.dataAtom);
        const next: HostInfoData = { ...(prev ?? {}), ...resp, errors: { ...(prev?.errors ?? {}) } };
        for (const s of sections) {
            if (resp[s] == null && prev?.[s] != null) {
                next[s] = prev[s];
            }
            if (resp.errors?.[s]) {
                next.errors[s] = resp.errors[s];
            } else {
                delete next.errors[s];
            }
        }
        globalStore.set(this.dataAtom, next);
        const updated = { ...globalStore.get(this.updatedAtAtom) };
        sections.forEach((s) => (updated[s] = resp.ts));
        globalStore.set(this.updatedAtAtom, updated);
    }

    refreshNow(section?: HostSectionId) {
        const sec = section ?? globalStore.get(this.sectionAtom);
        this.fetch(["system", backendSection(sec)], false);
    }

    setSection(id: HostSectionId) {
        globalStore.set(this.sectionAtom, id);
        globalStore.set(this.actionAtom, null);
        this.refreshNow(id);
    }

    setDockerStats(on: boolean) {
        globalStore.set(this.dockerStatsAtom, on);
        this.fetch(["docker"], false);
    }

    // treat the current snapshot as the new "nothing changed" point
    acknowledgeChanges() {
        globalStore.set(this.baselineAtom, globalStore.get(this.dataAtom));
    }

    // ---- actions ----

    askAction(req: HostActionReq) {
        globalStore.set(this.actionAtom, { key: actionKey(req), phase: "confirm", req });
    }

    cancelAction() {
        globalStore.set(this.actionAtom, null);
    }

    async confirmAction() {
        const st = globalStore.get(this.actionAtom);
        if (st == null || st.phase !== "confirm") return;
        const { req } = st;
        const conn = globalStore.get(this.connection);
        globalStore.set(this.actionAtom, { ...st, phase: "running" });
        try {
            const rtn = await this.env.rpc.HostActionCommand(
                TabRpcClient,
                { conn, kind: req.kind, target: req.target, action: req.action },
                { timeout: 95000 }
            );
            if (this.disposed) return;
            if (rtn?.needsauth) {
                globalStore.set(this.actionAtom, {
                    ...st,
                    phase: "needsauth",
                    message: rtn.output,
                    authCommand: rtn.command,
                });
                return;
            }
            globalStore.set(this.actionAtom, { ...st, phase: "done", message: rtn?.output });
        } catch (e) {
            if (this.disposed) return;
            globalStore.set(this.actionAtom, { ...st, phase: "error", message: String(e?.message ?? e) });
        }
        this.refreshNow();
    }

    // ---- open things as Wave blocks ----

    connMeta(): MetaType {
        const conn = globalStore.get(this.connection);
        return conn === "local" ? {} : { connection: conn };
    }

    openCommand(cmd: string) {
        this.env.createBlock({
            meta: { view: "term", controller: "cmd", cmd, "cmd:shell": true, ...this.connMeta() },
        });
    }

    openTerminal() {
        this.env.createBlock({ meta: { view: "term", controller: "shell", ...this.connMeta() } });
    }

    openFiles(path: string) {
        this.env.createBlock({ meta: { view: "preview", file: path, ...this.connMeta() } });
    }

    openUrl(url: string) {
        this.env.createBlock({ meta: { view: "web", url } });
    }

    runAuthCommandInTerminal() {
        const st = globalStore.get(this.actionAtom);
        if (st?.authCommand) {
            this.openCommand(st.authCommand);
            globalStore.set(this.actionAtom, null);
        }
    }

    dispose() {
        this.disposed = true;
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
