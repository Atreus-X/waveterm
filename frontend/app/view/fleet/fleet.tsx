// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { HostVitalsDeps, useHostVitals } from "@/app/store/hostvitals";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fmtDuration, fmtRate, pct, usageLevel } from "@/app/view/hostinfo/hostinfo-util";
import { WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { cn } from "@/util/util";
import * as jotai from "jotai";
import { memo, useState } from "react";
import { Sparkline } from "./sparkline";

export type FleetEnv = WaveEnvSubset<{
    rpc: {
        HostInfoCommand: WaveEnv["rpc"]["HostInfoCommand"];
        ConnConnectCommand: WaveEnv["rpc"]["ConnConnectCommand"];
    };
    atoms: {
        fullConfigAtom: WaveEnv["atoms"]["fullConfigAtom"];
    };
    createBlock: WaveEnv["createBlock"];
    getConnStatusAtom: WaveEnv["getConnStatusAtom"];
}>;

const LevelText = { ok: "text-success", warn: "text-warning", crit: "text-error" };

export class FleetViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    env: FleetEnv;

    viewIcon = jotai.atom<string>("tower-broadcast");
    viewName = jotai.atom<string>("Fleet");
    noPadding = jotai.atom<boolean>(true);
    connectingAtom = jotai.atom<Record<string, string>>({}) as jotai.PrimitiveAtom<Record<string, string>>;

    // SSH connections from connections.json (WSL/local and display:hidden ones left out), in display:order
    hostsAtom: jotai.Atom<string[]>;
    connectedCountAtom: jotai.Atom<number>;
    // connected hosts first, each group keeping display:order
    sortedHostsAtom: jotai.Atom<string[]>;

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.viewType = "fleet";
        this.blockId = blockId;
        this.env = waveEnv;
        this.hostsAtom = jotai.atom((get) => {
            const conns = get(this.env.atoms.fullConfigAtom)?.connections ?? {};
            return Object.keys(conns)
                .filter(
                    (name) =>
                        !name.startsWith("wsl://") && !name.startsWith("local") && !conns[name]?.["display:hidden"]
                )
                .sort((a, b) => {
                    const oa = conns[a]?.["display:order"] ?? 0;
                    const ob = conns[b]?.["display:order"] ?? 0;
                    return oa - ob || a.localeCompare(b);
                });
        });
        this.sortedHostsAtom = jotai.atom((get) => {
            const hosts = get(this.hostsAtom);
            const isUp = (h: string) => !!get(this.env.getConnStatusAtom(h))?.connected;
            return [...hosts.filter(isUp), ...hosts.filter((h) => !isUp(h))];
        });
        this.connectedCountAtom = jotai.atom(
            (get) => get(this.hostsAtom).filter((h) => get(this.env.getConnStatusAtom(h))?.connected).length
        );
    }

    get viewComponent(): ViewComponent {
        return FleetView;
    }

    inspect(conn: string) {
        this.env.createBlock({ meta: { view: "hostinfo", connection: conn } });
    }

    openTerminal(conn: string) {
        this.env.createBlock({ meta: { view: "term", controller: "shell", connection: conn } });
    }

    async connect(conn: string) {
        globalStore.set(this.connectingAtom, { ...globalStore.get(this.connectingAtom), [conn]: "" });
        try {
            await this.env.rpc.ConnConnectCommand(
                TabRpcClient,
                { host: conn, logblockid: this.blockId },
                { timeout: 60000 }
            );
            const next = { ...globalStore.get(this.connectingAtom) };
            delete next[conn];
            globalStore.set(this.connectingAtom, next);
        } catch (e) {
            globalStore.set(this.connectingAtom, {
                ...globalStore.get(this.connectingAtom),
                [conn]: String(e?.message ?? e),
            });
        }
    }
}

const Cols = "14px minmax(140px,1.4fr) 128px 128px 90px 150px 110px 70px 60px";

const Metric = memo(
    ({
        values,
        value,
        max,
        level,
    }: {
        values: number[];
        value: string;
        max?: number;
        level?: "ok" | "warn" | "crit";
    }) => (
        <div className={cn("flex items-center gap-2", level ? LevelText[level] : "text-accent")}>
            <Sparkline values={values} max={max} />
            <span className="w-10 text-right text-xs tabular-nums text-primary">{value}</span>
        </div>
    )
);
Metric.displayName = "Metric";

const HostRow = memo(({ model, conn }: { model: FleetViewModel; conn: string }) => {
    const env = model.env;
    const status = jotai.useAtomValue(env.getConnStatusAtom(conn));
    const connecting = jotai.useAtomValue(model.connectingAtom);
    const connected = !!status?.connected;
    const series = useHostVitals(conn, connected, env as HostVitalsDeps);
    const v = series?.latest;
    const connectErr = connecting[conn];
    const isConnecting = status?.status === "connecting" || connectErr === "";

    const dotClass = connected
        ? series?.error
            ? "bg-warning"
            : "bg-success"
        : status?.status === "error"
          ? "bg-error"
          : "bg-muted/60";

    return (
        <div
            onClick={() => connected && model.inspect(conn)}
            className={cn(
                "grid items-center gap-3 border-b border-border/50 px-3 py-1.5 text-xs last:border-b-0",
                connected ? "cursor-pointer hover:bg-hoverbg" : "text-muted"
            )}
            style={{ gridTemplateColumns: Cols }}
            title={connected ? `Open the Host Inspector for ${conn}` : undefined}
        >
            <span className={cn("h-2 w-2 rounded-full", dotClass)} />
            <div className="min-w-0">
                <div className={cn("truncate font-medium", connected && "text-primary")} title={conn}>
                    {conn}
                </div>
                {series?.error && <div className="truncate text-[11px] text-warning">{series.error}</div>}
                {connectErr && <div className="truncate text-[11px] text-error">{connectErr}</div>}
            </div>
            {connected && v ? (
                <>
                    <Metric
                        values={series.cpu}
                        max={100}
                        value={`${v.cpupct.toFixed(0)}%`}
                        level={usageLevel(v.cpupct)}
                    />
                    <Metric
                        values={series.mem}
                        max={100}
                        value={`${pct(v.memtotal - v.memavail, v.memtotal).toFixed(0)}%`}
                        level={usageLevel(pct(v.memtotal - v.memavail, v.memtotal))}
                    />
                    <div
                        className={cn(
                            "tabular-nums",
                            v.cpucount && v.load1 / v.cpucount >= 1 ? "text-warning" : "text-secondary"
                        )}
                    >
                        {v.load1.toFixed(2)} <span className="text-muted">/ {v.cpucount}</span>
                    </div>
                    <div className="flex items-center gap-2 text-accent">
                        <Sparkline values={series.rx} />
                        <div className="flex flex-col text-[11px] leading-tight tabular-nums text-secondary">
                            <span>↓ {fmtRate(v.rxrate)}</span>
                            <span>↑ {fmtRate(v.txrate)}</span>
                        </div>
                    </div>
                    <div className="min-w-0" title={v.diskmaxmount}>
                        <div className={cn("tabular-nums", LevelText[usageLevel(v.diskmaxpct)])}>
                            {v.diskmaxpct.toFixed(0)}%
                        </div>
                        <div className="truncate text-[11px] text-muted">{v.diskmaxmount}</div>
                    </div>
                    <div className="tabular-nums text-secondary">{fmtDuration(v.uptimesec)}</div>
                </>
            ) : (
                <div className="col-span-6 text-[11px]">
                    {connected ? (
                        "Reading vitals…"
                    ) : isConnecting ? (
                        "Connecting…"
                    ) : status?.status === "error" ? (
                        <span className="text-error" title={status?.error}>
                            Couldn't connect{status?.error ? `: ${status.error}` : ""}
                        </span>
                    ) : (
                        "Not connected"
                    )}
                </div>
            )}
            <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                {connected ? (
                    <>
                        <button
                            title="Open the Host Inspector"
                            aria-label="Open the Host Inspector"
                            onClick={() => model.inspect(conn)}
                            className="cursor-pointer rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-hoverbg hover:text-primary"
                        >
                            <i className="fa-solid fa-server fa-fw text-xs" />
                        </button>
                        <button
                            title="Open a terminal"
                            aria-label="Open a terminal"
                            onClick={() => model.openTerminal(conn)}
                            className="cursor-pointer rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-hoverbg hover:text-primary"
                        >
                            <i className="fa-solid fa-terminal fa-fw text-xs" />
                        </button>
                    </>
                ) : (
                    <button
                        disabled={isConnecting}
                        onClick={() => model.connect(conn)}
                        className="cursor-pointer rounded border border-border px-2 py-0.5 text-[11px] text-secondary transition-colors hover:bg-hoverbg hover:text-primary disabled:opacity-50"
                    >
                        Connect
                    </button>
                )}
            </div>
        </div>
    );
});
HostRow.displayName = "HostRow";

export const FleetView = memo(({ model }: ViewComponentProps<FleetViewModel>) => {
    const hosts = jotai.useAtomValue(model.sortedHostsAtom);
    const connectedCount = jotai.useAtomValue(model.connectedCountAtom);
    const [query, setQuery] = useState("");
    const shown = hosts.filter((h) => !query || h.toLowerCase().includes(query.toLowerCase()));
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
                <div className="relative">
                    <i className="fa-solid fa-magnifying-glass pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[11px] text-muted" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter hosts"
                        className="w-48 rounded border border-border bg-transparent py-1 pr-2 pl-7 text-xs outline-none focus:border-accent"
                    />
                </div>
                <span className="text-xs text-muted">
                    {connectedCount} of {hosts.length} hosts connected · live every 5 seconds · click a host to inspect
                    it
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
                {hosts.length === 0 ? (
                    <div className="py-10 text-center text-xs text-muted">
                        No SSH connections yet. Add hosts to ~/.ssh/config or connections.json and they'll appear here.
                    </div>
                ) : (
                    <div className="min-w-[860px]">
                        <div
                            className="sticky top-0 z-[1] grid gap-3 border-b border-border bg-panel px-3 py-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase"
                            style={{ gridTemplateColumns: Cols }}
                        >
                            <span />
                            <span>Host</span>
                            <span>CPU</span>
                            <span>Memory</span>
                            <span>Load</span>
                            <span>Network</span>
                            <span>Fullest disk</span>
                            <span>Up for</span>
                            <span />
                        </div>
                        {shown.map((h) => (
                            <HostRow key={h} model={model} conn={h} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});
FleetView.displayName = "FleetView";
