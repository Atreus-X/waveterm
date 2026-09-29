// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo } from "react";
import type { HostInfoViewModel } from "./hostinfo-model";
import {
    DockerSection,
    NetworkSection,
    OverviewSection,
    PortsSection,
    ProcessesSection,
    ServicesSection,
    UsageBar,
} from "./hostinfo-sections";
import { changeCount, fmtDuration, groupPorts, HostChanges, HostSectionId, HostSections, pct } from "./hostinfo-util";

type Badge = { text: string; tone: "muted" | "crit" | "warn" };

function sectionBadge(id: HostSectionId, data: HostInfoData): Badge {
    switch (id) {
        case "ports":
            return data.ports ? { text: String(groupPorts(data.ports.ports).length), tone: "muted" } : null;
        case "processes":
            return data.processes ? { text: String(data.processes.total), tone: "muted" } : null;
        case "services":
            if (!data.services?.available) return null;
            return data.services.failed > 0
                ? { text: `${data.services.failed} failed`, tone: "crit" }
                : { text: String(data.services.services.length), tone: "muted" };
        case "docker": {
            if (!data.docker?.available || data.docker.error) return null;
            const all = data.docker.containers.length;
            const up = data.docker.containers.filter((c) => c.state === "running").length;
            return { text: `${up}/${all}`, tone: up < all ? "warn" : "muted" };
        }
    }
    return null;
}

function sectionChanged(id: HostSectionId, ch: HostChanges): boolean {
    if (id === "ports") return ch.ports.size + ch.portsGone > 0;
    if (id === "services") return ch.services.size > 0;
    if (id === "docker") return ch.containers.size + ch.containersGone > 0;
    return false;
}

const Vital = memo(({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex min-w-0 flex-col">
        <span className="text-[10px] tracking-wide text-muted uppercase">{label}</span>
        <span className="truncate text-xs tabular-nums">{children}</span>
    </div>
));
Vital.displayName = "Vital";

const VitalsStrip = memo(({ model, data }: { model: HostInfoViewModel; data: HostInfoData }) => {
    const changes = useAtomValue(model.changesAtom);
    const sys = data?.system;
    const count = changeCount(changes);
    const memPct = sys ? pct(sys.memtotal - sys.memavail, sys.memtotal) : 0;
    return (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
                <i className="fa-solid fa-server text-accent" />
                <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold">{sys?.hostname ?? "…"}</span>
                    <span className="truncate text-[11px] text-muted">{sys?.os ?? ""}</span>
                </div>
            </div>
            {sys && (
                <>
                    <div className="w-24">
                        <Vital label="CPU">{sys.cpupct.toFixed(0)}%</Vital>
                        <UsageBar percent={sys.cpupct} className="mt-0.5" />
                    </div>
                    <div className="w-24">
                        <Vital label="Memory">{memPct.toFixed(0)}%</Vital>
                        <UsageBar percent={memPct} className="mt-0.5" />
                    </div>
                    <Vital label="Load">
                        {sys.load1.toFixed(2)} <span className="text-muted">/ {sys.cpucount} cores</span>
                    </Vital>
                    <Vital label="Up for">{fmtDuration(sys.uptimesec)}</Vital>
                </>
            )}
            <div className="ml-auto flex items-center gap-2">
                {count > 0 ? (
                    <>
                        <span className="rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs text-accent">
                            {count} change{count === 1 ? "" : "s"} since baseline
                        </span>
                        <button
                            onClick={() => model.acknowledgeChanges()}
                            title="Accept the current state as the new baseline"
                            className="cursor-pointer rounded px-2 py-0.5 text-xs text-secondary transition-colors hover:bg-hoverbg hover:text-primary"
                        >
                            Mark seen
                        </button>
                    </>
                ) : (
                    data && <span className="text-[11px] text-muted">No changes since baseline</span>
                )}
            </div>
        </div>
    );
});
VitalsStrip.displayName = "VitalsStrip";

const SectionRail = memo(({ model, data }: { model: HostInfoViewModel; data: HostInfoData }) => {
    const active = useAtomValue(model.sectionAtom);
    const changes = useAtomValue(model.changesAtom);
    return (
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border p-1.5">
            {HostSections.map((s) => {
                const badge = data ? sectionBadge(s.id, data) : null;
                const changed = sectionChanged(s.id, changes);
                return (
                    <button
                        key={s.id}
                        onClick={() => model.setSection(s.id)}
                        className={cn(
                            "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                            active === s.id
                                ? "bg-accent/20 text-primary"
                                : "text-secondary hover:bg-hoverbg hover:text-primary"
                        )}
                    >
                        <i className={`fa-solid fa-${s.icon} fa-fw text-muted`} />
                        <span className="flex-1 truncate">{s.label}</span>
                        {changed && (
                            <span
                                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                                title="Changed since baseline"
                            />
                        )}
                        {badge && (
                            <span
                                className={cn(
                                    "shrink-0 tabular-nums text-[11px]",
                                    badge.tone === "crit"
                                        ? "text-error"
                                        : badge.tone === "warn"
                                          ? "text-warning"
                                          : "text-muted"
                                )}
                            >
                                {badge.text}
                            </span>
                        )}
                    </button>
                );
            })}
        </nav>
    );
});
SectionRail.displayName = "SectionRail";

const ActionStrip = memo(({ model }: { model: HostInfoViewModel }) => {
    const st = useAtomValue(model.actionAtom);
    const conn = useAtomValue(model.connection);
    if (st == null) return null;
    const btn = "cursor-pointer rounded px-2.5 py-0.5 text-xs transition-colors";
    let body: React.ReactNode;
    switch (st.phase) {
        case "confirm":
            body = (
                <>
                    <i className="fa-solid fa-triangle-exclamation text-warning" />
                    <span className="flex-1">
                        {st.req.label} on <span className="font-semibold">{conn}</span>?
                    </span>
                    <button
                        onClick={() => model.confirmAction()}
                        className={cn(btn, "bg-accent/80 text-primary hover:bg-accent")}
                    >
                        Yes, do it
                    </button>
                    <button onClick={() => model.cancelAction()} className={cn(btn, "text-secondary hover:bg-hoverbg")}>
                        Cancel
                    </button>
                </>
            );
            break;
        case "running":
            body = (
                <>
                    <i className="fa-solid fa-spinner fa-spin text-muted" />
                    <span className="flex-1">{st.req.label}…</span>
                </>
            );
            break;
        case "done":
            body = (
                <>
                    <i className="fa-solid fa-circle-check text-success" />
                    <span className="flex-1 truncate" title={st.message}>
                        {st.req.label}: done{st.message ? ` · ${st.message}` : ""}
                    </span>
                    <button onClick={() => model.cancelAction()} className={cn(btn, "text-secondary hover:bg-hoverbg")}>
                        Dismiss
                    </button>
                </>
            );
            break;
        case "error":
            body = (
                <>
                    <i className="fa-solid fa-circle-xmark text-error" />
                    <span className="flex-1 break-words">
                        {st.req.label} failed: {st.message}
                    </span>
                    <button onClick={() => model.cancelAction()} className={cn(btn, "text-secondary hover:bg-hoverbg")}>
                        Dismiss
                    </button>
                </>
            );
            break;
        case "needsauth":
            body = (
                <>
                    <i className="fa-solid fa-key text-warning" />
                    <span className="flex-1">
                        {st.req.label} needs root, and sudo asks for a password here. Run{" "}
                        <span className="font-mono">{st.authCommand}</span> in a terminal instead?
                    </span>
                    <button
                        onClick={() => model.runAuthCommandInTerminal()}
                        className={cn(btn, "bg-accent/80 text-primary hover:bg-accent")}
                    >
                        Open terminal
                    </button>
                    <button onClick={() => model.cancelAction()} className={cn(btn, "text-secondary hover:bg-hoverbg")}>
                        Cancel
                    </button>
                </>
            );
            break;
    }
    return <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-xs">{body}</div>;
});
ActionStrip.displayName = "ActionStrip";

const SectionBody = memo(({ model, data }: { model: HostInfoViewModel; data: HostInfoData }) => {
    const active = useAtomValue(model.sectionAtom);
    const changes = useAtomValue(model.changesAtom);
    const backend = HostSections.find((s) => s.id === active)?.backend;
    const sectionError = data?.errors?.[backend];
    const props = { model, data, changes };
    return (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
            {sectionError && <div className="mb-2 text-xs text-error">{sectionError}</div>}
            {active === "overview" && <OverviewSection {...props} />}
            {active === "network" && <NetworkSection {...props} />}
            {active === "ports" && <PortsSection {...props} />}
            {active === "processes" && <ProcessesSection {...props} />}
            {active === "services" && <ServicesSection {...props} />}
            {active === "docker" && <DockerSection {...props} />}
        </div>
    );
});
SectionBody.displayName = "SectionBody";

export const HostInfoView = memo(({ model }: ViewComponentProps<HostInfoViewModel>) => {
    const data = useAtomValue(model.dataAtom);
    const error = useAtomValue(model.errorAtom);
    const loading = useAtomValue(model.loadingAtom);
    const connStatus = useAtomValue(model.connStatus);
    const conn = useAtomValue(model.connection);
    const paused = useAtomValue(model.pausedAtom);

    const notConnected = conn !== "local" && !connStatus?.connected;
    if (data == null) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-secondary">
                {notConnected ? (
                    <>
                        <i className="fa-solid fa-plug-circle-xmark text-2xl text-muted" />
                        <div>Not connected to {conn}.</div>
                        <div className="text-xs text-muted">
                            Connect with the connection button in this block's header.
                        </div>
                    </>
                ) : error ? (
                    <>
                        <i className="fa-solid fa-circle-exclamation text-2xl text-error" />
                        <div className="max-w-md break-words">{error}</div>
                        <button
                            onClick={() => model.refreshNow()}
                            className="cursor-pointer rounded border border-border px-3 py-1 text-xs transition-colors hover:bg-hoverbg"
                        >
                            Try again
                        </button>
                    </>
                ) : (
                    <>
                        <i className={cn("fa-solid fa-server text-2xl text-muted", loading && "animate-pulse")} />
                        <div>Inspecting {conn}…</div>
                    </>
                )}
            </div>
        );
    }
    return (
        <div className="flex h-full min-h-0 flex-col">
            <VitalsStrip model={model} data={data} />
            <ActionStrip model={model} />
            {(error || notConnected || paused) && (
                <div className="border-b border-border px-3 py-1 text-[11px] text-muted">
                    {paused
                        ? "Live updates paused."
                        : notConnected
                          ? `Disconnected from ${conn}; showing the last data received.`
                          : `Last refresh failed: ${error}`}
                </div>
            )}
            <div className="flex min-h-0 flex-1">
                <SectionRail model={model} data={data} />
                <SectionBody model={model} data={data} />
            </div>
        </div>
    );
});
HostInfoView.displayName = "HostInfoView";
