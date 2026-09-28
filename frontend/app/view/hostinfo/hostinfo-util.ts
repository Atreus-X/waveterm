// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { quote } from "shell-quote";

export type HostSectionId = "overview" | "network" | "ports" | "processes" | "services" | "docker";

export const HostSections: { id: HostSectionId; label: string; icon: string; backend: string }[] = [
    { id: "overview", label: "Overview", icon: "gauge-high", backend: "system" },
    { id: "network", label: "Network", icon: "network-wired", backend: "network" },
    { id: "ports", label: "Ports", icon: "plug", backend: "ports" },
    { id: "processes", label: "Processes", icon: "microchip", backend: "processes" },
    { id: "services", label: "Services", icon: "gears", backend: "services" },
    { id: "docker", label: "Docker", icon: "cubes", backend: "docker" },
];

// ---- formatting ----

export function fmtBytes(n: number): string {
    if (n == null || !Number.isFinite(n)) return "-";
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtRate(bytesPerSec: number): string {
    if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "-";
    if (bytesPerSec < 1) return "0 B/s";
    return `${fmtBytes(bytesPerSec)}/s`;
}

export function fmtDuration(sec: number): string {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return "-";
    const s = Math.floor(sec);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

export function pct(part: number, whole: number): number {
    if (!whole) return 0;
    return Math.max(0, Math.min(100, (part / whole) * 100));
}

// ok / warn / crit thresholds shared by every usage bar
export function usageLevel(percent: number): "ok" | "warn" | "crit" {
    if (percent >= 90) return "crit";
    if (percent >= 75) return "warn";
    return "ok";
}

// ---- network ----

const ContainerIfacePrefixes = ["veth", "br-", "docker", "virbr", "cni", "flannel", "cali", "vnet", "tun", "tap"];

export function isContainerIface(name: string): boolean {
    return ContainerIfacePrefixes.some((p) => name.startsWith(p));
}

// ---- ports ----

export type PortRow = {
    key: string;
    proto: string;
    port: number;
    addrs: string[];
    process: string;
    pid: number;
    localOnly: boolean;
};

export function isLoopbackAddr(addr: string): boolean {
    const a = addr.split("%")[0];
    return a.startsWith("127.") || a === "::1" || a === "localhost";
}

// ss/netstat list IPv4 and IPv6 listeners separately; show one row per proto+port+process
export function groupPorts(ports: HostPortInfo[]): PortRow[] {
    const rows = new Map<string, PortRow>();
    for (const p of ports ?? []) {
        const proto = p.proto.replace(/6$/, "");
        const key = `${proto}|${p.port}|${p.process ?? ""}`;
        let row = rows.get(key);
        if (row == null) {
            row = { key, proto, port: p.port, addrs: [], process: p.process ?? "", pid: p.pid ?? 0, localOnly: true };
            rows.set(key, row);
        }
        if (!row.addrs.includes(p.addr)) {
            row.addrs.push(p.addr);
        }
        if (!isLoopbackAddr(p.addr)) {
            row.localOnly = false;
        }
        if (!row.pid && p.pid) {
            row.pid = p.pid;
        }
    }
    return [...rows.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

// the host part of a connection name like "user@host:2222" or "user@[::1]:22"
export function connHost(conn: string): string {
    if (conn == null || conn === "" || conn === "local" || conn.startsWith("local:")) {
        return "localhost";
    }
    let rest = conn.includes("@") ? conn.slice(conn.lastIndexOf("@") + 1) : conn;
    if (rest.startsWith("[")) {
        const end = rest.indexOf("]");
        return end > 0 ? rest.slice(1, end) : rest;
    }
    const colon = rest.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
        rest = rest.slice(0, colon);
    }
    return rest;
}

// ---- change tracking ----

// keys of rows that are new or changed compared with the baseline snapshot
export type HostChanges = {
    ports: Set<string>;
    portsGone: number;
    services: Set<string>;
    containers: Set<string>;
    containersGone: number;
};

export function emptyChanges(): HostChanges {
    return { ports: new Set(), portsGone: 0, services: new Set(), containers: new Set(), containersGone: 0 };
}

export function diffHost(base: HostInfoData, cur: HostInfoData): HostChanges {
    const ch = emptyChanges();
    if (base == null || cur == null) return ch;
    if (base.ports && cur.ports) {
        const before = new Set(groupPorts(base.ports.ports).map((r) => r.key));
        const now = groupPorts(cur.ports.ports);
        for (const r of now) {
            if (!before.has(r.key)) ch.ports.add(r.key);
        }
        const nowKeys = new Set(now.map((r) => r.key));
        ch.portsGone = [...before].filter((k) => !nowKeys.has(k)).length;
    }
    if (base.services?.available && cur.services?.available) {
        const before = new Map(base.services.services.map((s) => [s.unit, `${s.active}/${s.sub}`]));
        for (const s of cur.services.services) {
            const prev = before.get(s.unit);
            if (prev != null && prev !== `${s.active}/${s.sub}`) ch.services.add(s.unit);
        }
    }
    if (base.docker?.available && cur.docker?.available) {
        const before = new Map(base.docker.containers.map((c) => [c.id, c.state]));
        for (const c of cur.docker.containers) {
            if (!before.has(c.id) || before.get(c.id) !== c.state) ch.containers.add(c.id);
        }
        const nowIds = new Set(cur.docker.containers.map((c) => c.id));
        ch.containersGone = [...before.keys()].filter((id) => !nowIds.has(id)).length;
    }
    return ch;
}

export function changeCount(ch: HostChanges): number {
    return ch.ports.size + ch.portsGone + ch.services.size + ch.containers.size + ch.containersGone;
}

// ---- commands opened in terminal blocks (every argument is shell-quoted) ----

const q = (s: string) => quote([s]);

export const HostCommands = {
    serviceJournal: (unit: string) => `journalctl -u ${q(unit)} -n 200 -f`,
    serviceStatus: (unit: string) => `systemctl status ${q(unit)} --no-pager -l`,
    containerShell: (name: string) =>
        `docker exec -it ${q(name)} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`,
    containerLogs: (name: string) => `docker logs -f --tail 200 ${q(name)}`,
    containerInspect: (name: string) => `docker inspect ${q(name)} | less`,
    processTop: (pid: number) => `top -p ${Math.trunc(pid)}`,
};
