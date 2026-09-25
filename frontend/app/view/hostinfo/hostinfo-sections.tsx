// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { openLibraryNote } from "@/app/view/library/library";
import { NoteEditor } from "@/app/view/library/note-editor";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useMemo, useState } from "react";
import type { HostInfoViewModel } from "./hostinfo-model";
import {
    connHost,
    fmtBytes,
    fmtDuration,
    fmtRate,
    groupPorts,
    HostChanges,
    HostCommands,
    isContainerIface,
    pct,
    usageLevel,
} from "./hostinfo-util";

// ---- shared bits ----

type Tone = "ok" | "warn" | "crit" | "muted" | "accent";

const ToneClass: Record<Tone, string> = {
    ok: "text-success border-success/40 bg-success/10",
    warn: "text-warning border-warning/40 bg-warning/10",
    crit: "text-error border-error/40 bg-error/10",
    muted: "text-muted border-border bg-transparent",
    accent: "text-accent border-accent/40 bg-accent/10",
};

export const Pill = memo(({ tone, children }: { tone: Tone; children: React.ReactNode }) => (
    <span
        className={cn("inline-flex shrink-0 items-center rounded border px-1.5 text-[11px] leading-5", ToneClass[tone])}
    >
        {children}
    </span>
));
Pill.displayName = "Pill";

export const UsageBar = memo(({ percent, className }: { percent: number; className?: string }) => {
    const level = usageLevel(percent);
    return (
        <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-hoverbg", className)}>
            <div
                className={cn(
                    "h-full rounded-full",
                    level === "crit" ? "bg-error" : level === "warn" ? "bg-warning" : "bg-success"
                )}
                style={{ width: `${Math.max(1, percent)}%` }}
            />
        </div>
    );
});
UsageBar.displayName = "UsageBar";

type RowAction = { icon: string; title: string; onClick: () => void; danger?: boolean };

const RowActions = memo(({ actions }: { actions: RowAction[] }) => (
    <div className="flex shrink-0 items-center justify-end gap-0.5">
        {actions.map((a) => (
            <button
                key={a.title}
                title={a.title}
                aria-label={a.title}
                onClick={(e) => {
                    e.stopPropagation();
                    a.onClick();
                }}
                className={cn(
                    "cursor-pointer rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-hoverbg",
                    a.danger ? "hover:text-error" : "hover:text-primary"
                )}
            >
                <i className={`fa-solid fa-${a.icon} fa-fw text-xs`} />
            </button>
        ))}
    </div>
));
RowActions.displayName = "RowActions";

const SearchBox = memo(
    ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) => (
        <div className="relative">
            <i className="fa-solid fa-magnifying-glass pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[11px] text-muted" />
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-56 rounded border border-border bg-transparent py-1 pr-2 pl-7 text-xs outline-none focus:border-accent"
            />
        </div>
    )
);
SearchBox.displayName = "SearchBox";

const Toggle = memo(
    ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-secondary select-none">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="cursor-pointer"
            />
            {label}
        </label>
    )
);
Toggle.displayName = "Toggle";

const Toolbar = memo(({ children }: { children: React.ReactNode }) => (
    <div className="mb-2 flex flex-wrap items-center gap-3">{children}</div>
));
Toolbar.displayName = "Toolbar";

const Notice = memo(({ tone, children }: { tone: "warn" | "crit" | "muted"; children: React.ReactNode }) => (
    <div className={cn("mb-2 rounded border px-3 py-2 text-xs", ToneClass[tone])}>{children}</div>
));
Notice.displayName = "Notice";

const Empty = memo(({ children }: { children: React.ReactNode }) => (
    <div className="py-8 text-center text-xs text-muted">{children}</div>
));
Empty.displayName = "Empty";

// grid tables: header + rows share one template so columns line up without <table>
const Table = memo(({ cols, header, children }: { cols: string; header: string[]; children: React.ReactNode }) => (
    <div className="min-w-0 rounded border border-border">
        <div
            className="sticky top-0 z-[1] grid gap-3 border-b border-border bg-panel px-3 py-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase"
            style={{ gridTemplateColumns: cols }}
        >
            {header.map((h, i) => (
                <div key={i} className="truncate">
                    {h}
                </div>
            ))}
        </div>
        {children}
    </div>
));
Table.displayName = "Table";

const Row = memo(
    ({
        cols,
        changed,
        children,
        title,
    }: {
        cols: string;
        changed?: boolean;
        children: React.ReactNode;
        title?: string;
    }) => (
        <div
            title={title}
            className={cn(
                "grid items-center gap-3 border-b border-border/50 px-3 py-1 text-xs last:border-b-0 hover:bg-hoverbg",
                changed && "bg-accent/5 shadow-[inset_2px_0_0_var(--color-accent)]"
            )}
            style={{ gridTemplateColumns: cols }}
        >
            {children}
        </div>
    )
);
Row.displayName = "Row";

function matches(q: string, ...fields: (string | number)[]): boolean {
    if (!q) return true;
    const needle = q.toLowerCase();
    return fields.some((f) =>
        String(f ?? "")
            .toLowerCase()
            .includes(needle)
    );
}

type SectionProps = { model: HostInfoViewModel; data: HostInfoData; changes: HostChanges };

// ---- overview ----

const Card = memo(
    ({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) => (
        <div className={cn("rounded border border-border p-3", className)}>
            <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</div>
            {children}
        </div>
    )
);
Card.displayName = "Card";

const KV = memo(({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex justify-between gap-3 text-xs">
        <span className="text-muted">{k}</span>
        <span className="truncate text-right">{v}</span>
    </div>
));
KV.displayName = "KV";

export const OverviewSection = memo(({ model, data }: SectionProps) => {
    const conn = useAtomValue(model.connection);
    const sys = data.system;
    if (sys == null) return <Empty>No system information yet.</Empty>;
    const memUsed = sys.memtotal - sys.memavail;
    const memPct = pct(memUsed, sys.memtotal);
    const swapUsed = sys.swaptotal - sys.swapfree;
    const loadPerCore = sys.cpucount ? sys.load1 / sys.cpucount : 0;
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
                <button
                    onClick={() => model.openTerminal()}
                    className="cursor-pointer rounded bg-accent/80 px-3 py-1 text-xs text-primary transition-colors hover:bg-accent"
                >
                    <i className="fa-solid fa-terminal mr-1.5" />
                    Open terminal
                </button>
                <button
                    onClick={() => model.openFiles("/")}
                    className="cursor-pointer rounded border border-border px-3 py-1 text-xs transition-colors hover:bg-hoverbg"
                >
                    <i className="fa-solid fa-folder-open mr-1.5" />
                    Browse files
                </button>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
                <Card title="Processor">
                    <div className="mb-1 flex items-baseline gap-2">
                        <span className="text-2xl font-semibold tabular-nums">{sys.cpupct.toFixed(0)}%</span>
                        <span className="text-xs text-muted">{sys.cpucount} cores</span>
                    </div>
                    <UsageBar percent={sys.cpupct} className="mb-2" />
                    <KV k="Model" v={<span title={sys.cpumodel}>{sys.cpumodel || "-"}</span>} />
                    <KV
                        k="Load 1 / 5 / 15"
                        v={
                            <span className={cn("tabular-nums", loadPerCore >= 1 && "text-warning")}>
                                {sys.load1.toFixed(2)} / {sys.load5.toFixed(2)} / {sys.load15.toFixed(2)}
                            </span>
                        }
                    />
                </Card>
                <Card title="Memory">
                    <div className="mb-1 flex items-baseline gap-2">
                        <span className="text-2xl font-semibold tabular-nums">{memPct.toFixed(0)}%</span>
                        <span className="text-xs text-muted">
                            {fmtBytes(memUsed)} of {fmtBytes(sys.memtotal)}
                        </span>
                    </div>
                    <UsageBar percent={memPct} className="mb-2" />
                    <KV k="Available" v={fmtBytes(sys.memavail)} />
                    <KV k="Swap" v={sys.swaptotal ? `${fmtBytes(swapUsed)} of ${fmtBytes(sys.swaptotal)}` : "none"} />
                </Card>
                <Card title="System">
                    <KV k="Host" v={sys.hostname} />
                    <KV k="OS" v={sys.os || "-"} />
                    <KV k="Kernel" v={sys.kernel || "-"} />
                    {sys.virt && <KV k="Runs on" v={sys.virt} />}
                    <KV k="Up for" v={fmtDuration(sys.uptimesec)} />
                    <KV k="Logged-in sessions" v={sys.users} />
                    <KV k="Inspecting as" v={`${data.user || "?"} (uid ${data.uid})`} />
                </Card>
            </div>
            <Card title="Disks">
                {sys.disks.length === 0 && <Empty>No disks reported.</Empty>}
                <div className="flex flex-col gap-2">
                    {sys.disks.map((d) => {
                        const used = pct(d.used, d.total);
                        return (
                            <div
                                key={d.mount}
                                className="grid items-center gap-3 text-xs"
                                style={{ gridTemplateColumns: "minmax(120px,1.2fr) 2fr 150px 28px" }}
                            >
                                <div className="min-w-0">
                                    <div className="truncate" title={d.mount}>
                                        {d.mount}
                                    </div>
                                    <div className="truncate text-[11px] text-muted" title={d.device}>
                                        {d.device} · {d.fstype}
                                    </div>
                                </div>
                                <UsageBar percent={used} />
                                <div className="text-right tabular-nums text-secondary">
                                    {fmtBytes(d.used)} / {fmtBytes(d.total)}
                                </div>
                                <RowActions
                                    actions={[
                                        {
                                            icon: "folder-open",
                                            title: `Browse ${d.mount}`,
                                            onClick: () => model.openFiles(d.mount),
                                        },
                                    ]}
                                />
                            </div>
                        );
                    })}
                </div>
            </Card>
            <Card title="Host note">
                <NoteEditor
                    key={conn}
                    noteRef={{ host: conn }}
                    compact
                    placeholder={`Anything worth remembering about ${conn}: what runs here, quirks, contacts. Saved as Markdown in your Wave config folder.`}
                />
                <button
                    onClick={() => openLibraryNote(model.env.createBlock, { host: conn })}
                    className="mt-2 cursor-pointer text-xs text-secondary hover:text-primary"
                >
                    <i className="fa-solid fa-book-bookmark mr-1.5" />
                    Open in Library
                </button>
            </Card>
        </div>
    );
});
OverviewSection.displayName = "OverviewSection";

// ---- network ----

const NetCols = "minmax(90px,0.8fr) minmax(160px,2fr) 90px 90px 90px 90px";

export const NetworkSection = memo(({ data }: SectionProps) => {
    const [showAll, setShowAll] = useState(false);
    const net = data.network;
    if (net == null) return <Empty>No network information yet.</Empty>;
    const hidden = net.interfaces.filter((i) => isContainerIface(i.name));
    const rows = showAll ? net.interfaces : net.interfaces.filter((i) => !isContainerIface(i.name));
    return (
        <div className="flex flex-col gap-3">
            <Toolbar>
                {hidden.length > 0 && (
                    <Toggle
                        checked={showAll}
                        onChange={setShowAll}
                        label={`Show container and virtual interfaces (${hidden.length})`}
                    />
                )}
            </Toolbar>
            <Table cols={NetCols} header={["Interface", "Addresses", "In", "Out", "Received", "Sent"]}>
                {rows.map((i) => (
                    <Row key={i.name} cols={NetCols}>
                        <div className="truncate font-medium">{i.name}</div>
                        <div className="min-w-0 truncate text-secondary" title={(i.addrs ?? []).join("\n")}>
                            {(i.addrs ?? []).join(", ") || "-"}
                        </div>
                        <div className="tabular-nums">{fmtRate(i.rxrate)}</div>
                        <div className="tabular-nums">{fmtRate(i.txrate)}</div>
                        <div className="tabular-nums text-muted">{fmtBytes(i.rxbytes)}</div>
                        <div className="tabular-nums text-muted">{fmtBytes(i.txbytes)}</div>
                    </Row>
                ))}
            </Table>
            <div className="grid gap-3 md:grid-cols-2">
                <Card title="Default route">
                    <div className="font-mono text-xs break-all">{net.defaultroute || "none"}</div>
                </Card>
                <Card title="DNS servers">
                    <div className="font-mono text-xs">{(net.dns ?? []).join(", ") || "none"}</div>
                </Card>
            </div>
        </div>
    );
});
NetworkSection.displayName = "NetworkSection";

// ---- ports ----

const PortCols = "70px 60px minmax(140px,1.5fr) minmax(120px,1.5fr) 70px";

export const PortsSection = memo(({ model, data, changes }: SectionProps) => {
    const [query, setQuery] = useState("");
    const [hideLocal, setHideLocal] = useState(false);
    const conn = useAtomValue(model.connection);
    const ports = data.ports;
    const rows = useMemo(() => groupPorts(ports?.ports), [ports]);
    if (ports == null) return <Empty>No port information yet.</Empty>;
    if (ports.tool === "none") return <Empty>Neither ss nor netstat is installed on this host.</Empty>;
    const host = connHost(conn);
    const shown = rows.filter(
        (r) => (!hideLocal || !r.localOnly) && matches(query, r.port, r.process, r.proto, r.addrs.join(" "))
    );
    return (
        <div className="flex flex-col">
            {ports.needsroot && (
                <Notice tone="muted">
                    Some listeners belong to other users, so their process isn't shown. Connect as root to see them.
                </Notice>
            )}
            <Toolbar>
                <SearchBox value={query} onChange={setQuery} placeholder="Filter by port, process, address" />
                <Toggle checked={hideLocal} onChange={setHideLocal} label="Hide local-only" />
                <span className="text-xs text-muted">
                    {shown.length} of {rows.length}
                    {changes.portsGone > 0 && ` · ${changes.portsGone} closed since baseline`}
                </span>
            </Toolbar>
            <Table cols={PortCols} header={["Port", "Proto", "Listening on", "Process", ""]}>
                {shown.map((r) => {
                    const isNew = changes.ports.has(r.key);
                    const actions: RowAction[] = [
                        {
                            icon: "copy",
                            title: `Copy ${host}:${r.port}`,
                            onClick: () => navigator.clipboard.writeText(`${host}:${r.port}`).catch(() => {}),
                        },
                    ];
                    if (r.proto === "tcp" && !r.localOnly) {
                        const scheme = r.port === 443 || r.port === 8443 ? "https" : "http";
                        actions.unshift({
                            icon: "globe",
                            title: `Open ${scheme}://${host}:${r.port} in a web block`,
                            onClick: () => model.openUrl(`${scheme}://${host}:${r.port}`),
                        });
                    }
                    return (
                        <Row key={r.key} cols={PortCols} changed={isNew}>
                            <div className="flex items-center gap-1.5 font-medium tabular-nums">
                                {r.port}
                                {isNew && <Pill tone="accent">new</Pill>}
                            </div>
                            <div className="text-secondary">{r.proto}</div>
                            <div className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate text-secondary" title={r.addrs.join("\n")}>
                                    {r.addrs.join(", ")}
                                </span>
                                {r.localOnly && <Pill tone="muted">local only</Pill>}
                            </div>
                            <div className="truncate">
                                {r.process ? (
                                    <>
                                        {r.process}
                                        {r.pid > 0 && <span className="text-muted"> · {r.pid}</span>}
                                    </>
                                ) : (
                                    <span className="text-muted">unknown</span>
                                )}
                            </div>
                            <RowActions actions={actions} />
                        </Row>
                    );
                })}
            </Table>
        </div>
    );
});
PortsSection.displayName = "PortsSection";

// ---- processes ----

const ProcCols = "64px minmax(110px,1fr) 90px 64px 64px 80px 80px 84px";
type ProcSort = "cpu" | "mem";

export const ProcessesSection = memo(({ model, data }: SectionProps) => {
    const [query, setQuery] = useState("");
    const [sortBy, setSortBy] = useState<ProcSort>("cpu");
    const procs = data.processes;
    if (procs == null) return <Empty>No process information yet.</Empty>;
    const shown = procs.processes
        .filter((p) => matches(query, p.pid, p.name, p.user, p.args))
        .sort((a, b) => (sortBy === "cpu" ? b.cpupct - a.cpupct : b.rss - a.rss));
    const ask = (p: HostProcessInfo, action: string, verb: string) =>
        model.askAction({ kind: "process", target: String(p.pid), action, label: `${verb} ${p.name} (pid ${p.pid})` });
    return (
        <div className="flex flex-col">
            <Toolbar>
                <SearchBox value={query} onChange={setQuery} placeholder="Filter by name, user, pid, command" />
                <div className="flex items-center gap-1 text-xs">
                    <span className="text-muted">Sort</span>
                    {(["cpu", "mem"] as ProcSort[]).map((s) => (
                        <button
                            key={s}
                            onClick={() => setSortBy(s)}
                            className={cn(
                                "cursor-pointer rounded px-2 py-0.5",
                                sortBy === s ? "bg-accent/20 text-primary" : "text-secondary hover:bg-hoverbg"
                            )}
                        >
                            {s === "cpu" ? "CPU" : "Memory"}
                        </button>
                    ))}
                </div>
                <span className="text-xs text-muted">
                    busiest {procs.processes.length} of {procs.total} processes · CPU is the average since each started
                </span>
            </Toolbar>
            <Table cols={ProcCols} header={["PID", "Name", "User", "CPU", "Mem", "Memory", "Running", ""]}>
                {shown.map((p) => (
                    <Row key={p.pid} cols={ProcCols} title={p.args}>
                        <div className="tabular-nums text-secondary">{p.pid}</div>
                        <div className="truncate font-medium">{p.name}</div>
                        <div className="truncate text-secondary">{p.user}</div>
                        <div className="tabular-nums">{p.cpupct.toFixed(1)}%</div>
                        <div className="tabular-nums">{p.mempct.toFixed(1)}%</div>
                        <div className="tabular-nums text-secondary">{fmtBytes(p.rss)}</div>
                        <div className="tabular-nums text-secondary">{fmtDuration(p.elapsedsec)}</div>
                        <RowActions
                            actions={[
                                {
                                    icon: "chart-line",
                                    title: "Watch in top",
                                    onClick: () => model.openCommand(HostCommands.processTop(p.pid)),
                                },
                                {
                                    icon: "hand",
                                    title: "Terminate (SIGTERM)",
                                    onClick: () => ask(p, "term", "Terminate"),
                                    danger: true,
                                },
                                {
                                    icon: "skull",
                                    title: "Kill (SIGKILL)",
                                    onClick: () => ask(p, "kill", "Kill"),
                                    danger: true,
                                },
                            ]}
                        />
                    </Row>
                ))}
            </Table>
        </div>
    );
});
ProcessesSection.displayName = "ProcessesSection";

// ---- services ----

const SvcCols = "minmax(140px,1.2fr) 150px 80px minmax(160px,2fr) 124px";
type SvcFilter = "all" | "running" | "failed" | "inactive";

function serviceTone(s: HostServiceInfo): Tone {
    if (s.active === "failed") return "crit";
    if (s.active === "active") return s.sub === "running" ? "ok" : "accent";
    if (s.active === "activating" || s.active === "deactivating" || s.active === "reloading") return "warn";
    return "muted";
}

export const ServicesSection = memo(({ model, data, changes }: SectionProps) => {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<SvcFilter>(() => ((data.services?.failed ?? 0) > 0 ? "failed" : "all"));
    const svcs = data.services;
    if (svcs == null) return <Empty>No service information yet.</Empty>;
    if (!svcs.available) return <Empty>This host doesn't use systemd, so there are no services to list.</Empty>;
    const counts = {
        all: svcs.services.length,
        running: svcs.services.filter((s) => s.sub === "running").length,
        failed: svcs.failed,
        inactive: svcs.services.filter((s) => s.active === "inactive").length,
    };
    const shown = svcs.services.filter((s) => {
        if (filter === "running" && s.sub !== "running") return false;
        if (filter === "failed" && s.active !== "failed") return false;
        if (filter === "inactive" && s.active !== "inactive") return false;
        return matches(query, s.unit, s.description);
    });
    const ask = (s: HostServiceInfo, action: string, verb: string) =>
        model.askAction({ kind: "service", target: s.unit, action, label: `${verb} ${s.unit}` });
    const filterLabels: Record<SvcFilter, string> = {
        all: "All",
        running: "Running",
        failed: "Failed",
        inactive: "Inactive",
    };
    return (
        <div className="flex flex-col">
            <Toolbar>
                <div className="flex items-center gap-1 text-xs">
                    {(Object.keys(filterLabels) as SvcFilter[]).map((f) => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={cn(
                                "cursor-pointer rounded px-2 py-0.5",
                                filter === f ? "bg-accent/20 text-primary" : "text-secondary hover:bg-hoverbg",
                                f === "failed" && counts.failed > 0 && filter !== f && "text-error"
                            )}
                        >
                            {filterLabels[f]} <span className="tabular-nums text-muted">{counts[f]}</span>
                        </button>
                    ))}
                </div>
                <SearchBox value={query} onChange={setQuery} placeholder="Filter by name or description" />
            </Toolbar>
            <Table cols={SvcCols} header={["Service", "State", "At boot", "Description", ""]}>
                {shown.length === 0 && <Empty>No services match.</Empty>}
                {shown.map((s) => {
                    const running = s.active === "active" || s.active === "reloading";
                    const changed = changes.services.has(s.unit);
                    const actions: RowAction[] = [
                        {
                            icon: "circle-info",
                            title: "Show status",
                            onClick: () => model.openCommand(HostCommands.serviceStatus(s.unit)),
                        },
                        {
                            icon: "scroll",
                            title: "Follow journal",
                            onClick: () => model.openCommand(HostCommands.serviceJournal(s.unit)),
                        },
                    ];
                    if (running) {
                        actions.push(
                            {
                                icon: "rotate-right",
                                title: "Restart",
                                onClick: () => ask(s, "restart", "Restart"),
                                danger: true,
                            },
                            { icon: "stop", title: "Stop", onClick: () => ask(s, "stop", "Stop"), danger: true }
                        );
                    } else {
                        actions.push({
                            icon: "play",
                            title: "Start",
                            onClick: () => ask(s, "start", "Start"),
                            danger: true,
                        });
                    }
                    return (
                        <Row key={s.unit} cols={SvcCols} changed={changed}>
                            <div className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate font-medium" title={s.unit}>
                                    {s.unit.replace(/\.service$/, "")}
                                </span>
                                {changed && <Pill tone="accent">changed</Pill>}
                            </div>
                            <div>
                                <Pill tone={serviceTone(s)}>
                                    {s.active}
                                    {s.sub && s.sub !== s.active ? ` · ${s.sub}` : ""}
                                </Pill>
                            </div>
                            <div className="truncate text-secondary">{s.enabled || "-"}</div>
                            <div className="truncate text-secondary" title={s.description}>
                                {s.description}
                            </div>
                            <RowActions actions={actions} />
                        </Row>
                    );
                })}
            </Table>
        </div>
    );
});
ServicesSection.displayName = "ServicesSection";

// ---- docker ----

function containerTone(c: HostContainerInfo): Tone {
    if (c.state === "running") return /unhealthy/i.test(c.status) ? "warn" : "ok";
    if (c.state === "restarting" || c.state === "paused") return "warn";
    if (c.state === "exited" && !/Exited \(0\)/.test(c.status)) return "crit";
    return "muted";
}

export const DockerSection = memo(({ model, data, changes }: SectionProps) => {
    const [query, setQuery] = useState("");
    const liveStats = useAtomValue(model.dockerStatsAtom);
    const dk = data.docker;
    const groups = useMemo(() => {
        const m = new Map<string, HostContainerInfo[]>();
        for (const c of dk?.containers ?? []) {
            const key = c.project || "";
            if (!m.has(key)) m.set(key, []);
            m.get(key).push(c);
        }
        return [...m.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
    }, [dk]);
    if (dk == null) return <Empty>No Docker information yet.</Empty>;
    if (!dk.available) return <Empty>Docker isn't installed on this host.</Empty>;
    if (dk.error) {
        return (
            <Notice tone="warn">
                <div className="mb-1 font-medium">Docker didn't answer</div>
                <div className="mb-1 font-mono break-all">{dk.error}</div>
                {/permission denied/i.test(dk.error) && (
                    <div>
                        Your user can't reach the Docker daemon. Add it to the docker group (
                        <span className="font-mono">sudo usermod -aG docker $USER</span>) and reconnect.
                    </div>
                )}
            </Notice>
        );
    }
    const cols = liveStats
        ? "minmax(120px,1.2fr) minmax(120px,1.2fr) 150px 70px 130px 140px"
        : "minmax(120px,1.2fr) minmax(120px,1.4fr) 150px minmax(100px,1fr) 140px";
    const header = liveStats
        ? ["Container", "Image", "State", "CPU", "Memory", ""]
        : ["Container", "Image", "State", "Ports", ""];
    const ask = (c: HostContainerInfo, action: string, verb: string) =>
        model.askAction({ kind: "container", target: c.name, action, label: `${verb} container ${c.name}` });
    const running = dk.containers.filter((c) => c.state === "running").length;
    return (
        <div className="flex flex-col gap-3">
            <Toolbar>
                <SearchBox value={query} onChange={setQuery} placeholder="Filter by name, image, project" />
                <Toggle
                    checked={liveStats}
                    onChange={(v) => model.setDockerStats(v)}
                    label="Live CPU and memory (slower)"
                />
                <span className="text-xs text-muted">
                    {running} of {dk.containers.length} running
                    {changes.containersGone > 0 && ` · ${changes.containersGone} removed since baseline`}
                </span>
            </Toolbar>
            {dk.containers.length === 0 && <Empty>No containers on this host.</Empty>}
            {groups.map(([project, list]) => {
                const shown = list.filter((c) => matches(query, c.name, c.image, c.project, c.ports));
                if (shown.length === 0) return null;
                const up = list.filter((c) => c.state === "running").length;
                return (
                    <div key={project || "_standalone"}>
                        <div className="mb-1 flex items-center gap-2 text-xs">
                            <i className={cn("fa-solid text-muted", project ? "fa-layer-group" : "fa-cube")} />
                            <span className="font-semibold">{project || "Standalone containers"}</span>
                            <span className={cn("tabular-nums", up < list.length ? "text-warning" : "text-muted")}>
                                {up}/{list.length} running
                            </span>
                        </div>
                        <Table cols={cols} header={header}>
                            {shown.map((c) => {
                                const isRunning = c.state === "running";
                                const changed = changes.containers.has(c.id);
                                const firstMount = (c.mounts ?? "").split(",")[0]?.trim();
                                const actions: RowAction[] = [];
                                if (isRunning) {
                                    actions.push({
                                        icon: "terminal",
                                        title: "Open a shell inside",
                                        onClick: () => model.openCommand(HostCommands.containerShell(c.name)),
                                    });
                                }
                                actions.push({
                                    icon: "scroll",
                                    title: "Follow logs",
                                    onClick: () => model.openCommand(HostCommands.containerLogs(c.name)),
                                });
                                if (firstMount?.startsWith("/")) {
                                    actions.push({
                                        icon: "folder-open",
                                        title: `Browse ${firstMount}`,
                                        onClick: () => model.openFiles(firstMount),
                                    });
                                }
                                if (isRunning) {
                                    actions.push(
                                        {
                                            icon: "rotate-right",
                                            title: "Restart",
                                            onClick: () => ask(c, "restart", "Restart"),
                                            danger: true,
                                        },
                                        {
                                            icon: "stop",
                                            title: "Stop",
                                            onClick: () => ask(c, "stop", "Stop"),
                                            danger: true,
                                        }
                                    );
                                } else {
                                    actions.push({
                                        icon: "play",
                                        title: "Start",
                                        onClick: () => ask(c, "start", "Start"),
                                        danger: true,
                                    });
                                }
                                return (
                                    <Row key={c.id} cols={cols} changed={changed}>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            <span className="truncate font-medium" title={c.name}>
                                                {c.name}
                                            </span>
                                            {changed && <Pill tone="accent">changed</Pill>}
                                        </div>
                                        <div className="truncate text-secondary" title={c.image}>
                                            {c.image}
                                        </div>
                                        <div className="min-w-0">
                                            <Pill tone={containerTone(c)}>
                                                <span className="truncate" title={c.status}>
                                                    {c.status}
                                                </span>
                                            </Pill>
                                        </div>
                                        {liveStats ? (
                                            <>
                                                <div className="tabular-nums">{c.cpupct || "-"}</div>
                                                <div
                                                    className="truncate tabular-nums text-secondary"
                                                    title={c.memusage}
                                                >
                                                    {c.mempct
                                                        ? `${c.mempct} · ${(c.memusage ?? "").split("/")[0]}`
                                                        : "-"}
                                                </div>
                                            </>
                                        ) : (
                                            <div className="truncate text-secondary" title={c.ports}>
                                                {c.ports || "-"}
                                            </div>
                                        )}
                                        <RowActions actions={actions} />
                                    </Row>
                                );
                            })}
                        </Table>
                    </div>
                );
            })}
        </div>
    );
});
DockerSection.displayName = "DockerSection";
