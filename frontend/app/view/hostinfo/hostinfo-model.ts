// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MetaKeyAtomFnType, WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { isBlank } from "@/util/util";
import * as jotai from "jotai";
import * as React from "react";
import { HostInfoView } from "./hostinfo";
import {
    computeAlerts,
    diffHost,
    emptyChanges,
    HostAlert,
    HostChanges,
    HostSectionId,
    HostSections,
} from "./hostinfo-util";

export type HostInfoEnv = WaveEnvSubset<{
    rpc: {
        HostInfoCommand: WaveEnv["rpc"]["HostInfoCommand"];
        HostActionCommand: WaveEnv["rpc"]["HostActionCommand"];
    };
    createBlock: WaveEnv["createBlock"];
    getConnStatusAtom: WaveEnv["getConnStatusAtom"];
    getBlockMetaKeyAtom: MetaKeyAtomFnType<"connection">;
}>;

export const RailDefaultWidth = 192;
export const RailMinWidth = 120;
export const RailMaxWidth = 360;
const RailPrefsKey = "hostinfo:rail";

type RailPrefs = { collapsed: boolean; width: number };

// shared by every Host Inspector block; localStorage can be unavailable or hold junk, so fall back to defaults
function loadRailPrefs(): RailPrefs {
    const prefs = { collapsed: false, width: RailDefaultWidth };
    try {
        const raw = JSON.parse(localStorage.getItem(RailPrefsKey));
        if (typeof raw?.collapsed === "boolean") prefs.collapsed = raw.collapsed;
        if (typeof raw?.width === "number") prefs.width = Math.min(RailMaxWidth, Math.max(RailMinWidth, raw.width));
    } catch (_) {}
    return prefs;
}

function saveRailPrefs(prefs: RailPrefs) {
    try {
        localStorage.setItem(RailPrefsKey, JSON.stringify(prefs));
    } catch (_) {}
}

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
// alerts watch these no matter which section is on screen
const AlertSections = ["system", "services", "docker"];

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

function alertBellIcon(count: number, crit: boolean): React.ReactNode {
    if (count === 0) {
        return React.createElement("i", { className: "fa-solid fa-bell" });
    }
    return React.createElement(
        "span",
        { className: "relative inline-flex" },
        React.createElement("i", { className: `fa-solid fa-bell ${crit ? "text-error" : "text-warning"}` }),
        React.createElement(
            "span",
            {
                className: `absolute -right-1.5 -top-1.5 min-w-[13px] rounded-full px-[3px] text-center text-[9px] font-bold leading-[13px] text-black ${crit ? "bg-error" : "bg-warning"}`,
            },
            count > 9 ? "9+" : String(count)
        )
    );
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
    railCollapsedAtom: jotai.PrimitiveAtom<boolean>;
    railWidthAtom: jotai.PrimitiveAtom<number>;
    dockerStatsAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
    updatedAtAtom = jotai.atom<Record<string, number>>({}) as jotai.PrimitiveAtom<Record<string, number>>;
    actionAtom = jotai.atom<HostActionState>(null) as jotai.PrimitiveAtom<HostActionState>;
    alertsOpenAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
    dismissedAlertsAtom = jotai.atom(new Set<string>()) as jotai.PrimitiveAtom<Set<string>>;

    connection: jotai.Atom<string>;
    connStatus: jotai.Atom<ConnStatus>;
    changesAtom: jotai.Atom<HostChanges>;
    alertsAtom: jotai.Atom<HostAlert[]>;
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
        const railPrefs = loadRailPrefs();
        this.railCollapsedAtom = jotai.atom(railPrefs.collapsed) as jotai.PrimitiveAtom<boolean>;
        this.railWidthAtom = jotai.atom(railPrefs.width) as jotai.PrimitiveAtom<number>;

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
        this.alertsAtom = jotai.atom((get) => {
            const dismissed = get(this.dismissedAlertsAtom);
            return computeAlerts(get(this.dataAtom)).filter((a) => !dismissed.has(a.key));
        });
        this.endIconButtons = jotai.atom((get) => {
            const paused = get(this.pausedAtom);
            const alerts = get(this.alertsAtom);
            const hasCrit = alerts.some((a) => a.level === "crit");
            return [
                {
                    elemtype: "iconbutton",
                    icon: alertBellIcon(alerts.length, hasCrit),
                    title: alerts.length > 0 ? `${alerts.length} alert${alerts.length === 1 ? "" : "s"}` : "No alerts",
                    click: () => globalStore.set(this.alertsOpenAtom, !globalStore.get(this.alertsOpenAtom)),
                },
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
        const wanted = new Set([...AlertSections, backendSection(globalStore.get(this.sectionAtom))]);
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
        globalStore.set(this.alertsOpenAtom, false);
        globalStore.set(this.dismissedAlertsAtom, new Set());
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
        this.pruneDismissedAlerts(next);
        const updated = { ...globalStore.get(this.updatedAtAtom) };
        sections.forEach((s) => (updated[s] = resp.ts));
        globalStore.set(this.updatedAtAtom, updated);
    }

    refreshNow(section?: HostSectionId) {
        const sec = section ?? globalStore.get(this.sectionAtom);
        this.fetch(["system", backendSection(sec)], false);
    }

    setRailCollapsed(collapsed: boolean) {
        globalStore.set(this.railCollapsedAtom, collapsed);
        saveRailPrefs({ collapsed, width: globalStore.get(this.railWidthAtom) });
    }

    setRailWidth(width: number) {
        const next = Math.min(RailMaxWidth, Math.max(RailMinWidth, width));
        globalStore.set(this.railWidthAtom, next);
        saveRailPrefs({ collapsed: globalStore.get(this.railCollapsedAtom), width: next });
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

    // a dismissed alert comes back if its condition clears and later returns
    pruneDismissedAlerts(data: HostInfoData) {
        const dismissed = globalStore.get(this.dismissedAlertsAtom);
        if (dismissed.size === 0) return;
        const live = new Set(computeAlerts(data).map((a) => a.key));
        const kept = new Set([...dismissed].filter((k) => live.has(k)));
        if (kept.size !== dismissed.size) {
            globalStore.set(this.dismissedAlertsAtom, kept);
        }
    }

    dismissAlert(key: string) {
        globalStore.set(this.dismissedAlertsAtom, new Set([...globalStore.get(this.dismissedAlertsAtom), key]));
    }

    dismissAllAlerts() {
        const keys = globalStore.get(this.alertsAtom).map((a) => a.key);
        globalStore.set(this.dismissedAlertsAtom, new Set([...globalStore.get(this.dismissedAlertsAtom), ...keys]));
    }

    openAlert(alert: HostAlert) {
        this.setSection(alert.section);
        globalStore.set(this.alertsOpenAtom, false);
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
