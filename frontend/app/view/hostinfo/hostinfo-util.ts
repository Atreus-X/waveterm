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

// ---- column sorting ----

export type SortState = { key: string; dir: "asc" | "desc" };

// first click sorts in firstDir, the second flips it, the third clears (back to the tab's default order)
export function nextSort(cur: SortState, key: string, firstDir: "asc" | "desc"): SortState {
    if (cur?.key !== key) return { key, dir: firstDir };
    if (cur.dir === firstDir) return { key, dir: firstDir === "asc" ? "desc" : "asc" };
    return null;
}

type SortValue = string | number;

function compareValues(a: SortValue, b: SortValue): number {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function isEmptySortValue(v: SortValue): boolean {
    return v == null || v === "" || (typeof v === "number" && Number.isNaN(v));
}

// empty values sort last in either direction; ties keep their incoming order
export function sortRows<T>(rows: T[], sort: SortState, getters: Record<string, (row: T) => SortValue>): T[] {
    const get = sort != null ? getters[sort.key] : null;
    if (get == null) return rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
        const va = get(a);
        const vb = get(b);
        const ea = isEmptySortValue(va);
        const eb = isEmptySortValue(vb);
        if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
        return sign * compareValues(va, vb);
    });
}

// ---- alerts ----

export type HostAlert = {
    // stable per condition; includes the severity so an escalation re-alerts after a dismissal
    key: string;
    // the condition itself, the same at every severity; what "ignore permanently" is stored against
    ignoreKey: string;
    ignoreLabel: string;
    level: "warn" | "crit";
    icon: string;
    title: string;
    detail: string;
    section: HostSectionId;
};

const LoadWarnPerCore = 1.5;
const LoadCritPerCore = 3;
const MaxListedAlerts = 20;

function containerProblem(c: HostContainerInfo): string {
    if (c.state === "restarting") return "restarting";
    if (c.state === "dead") return "dead";
    if (/unhealthy/i.test(c.status ?? "")) return "unhealthy";
    const exit = /^Exited \((\d+)\)/.exec(c.status ?? "");
    if (c.state === "exited" && exit != null && exit[1] !== "0") return `exited with code ${exit[1]}`;
    return null;
}

function diskAlert(mount: string, usedPct: number, detail: string): HostAlert {
    const level = usageLevel(usedPct);
    if (level === "ok") return null;
    return {
        key: `disk|${mount}|${level}`,
        ignoreKey: `disk|${mount}`,
        ignoreLabel: `Disk usage on ${mount}`,
        level,
        icon: "hard-drive",
        title: `Disk ${usedPct.toFixed(0)}% full: ${mount}`,
        detail,
        section: "overview",
    };
}

function memAlert(total: number, avail: number): HostAlert {
    const used = pct(total - avail, total);
    const level = usageLevel(used);
    if (total <= 0 || level === "ok") return null;
    return {
        key: `mem|${level}`,
        ignoreKey: "mem",
        ignoreLabel: "Memory usage",
        level,
        icon: "memory",
        title: `Memory ${used.toFixed(0)}% used`,
        detail: `${fmtBytes(avail)} available of ${fmtBytes(total)}`,
        section: "processes",
    };
}

function loadAlert(load1: number, cpucount: number): HostAlert {
    const perCore = cpucount > 0 ? load1 / cpucount : 0;
    if (perCore < LoadWarnPerCore) return null;
    const level = perCore >= LoadCritPerCore ? "crit" : "warn";
    return {
        key: `load|${level}`,
        ignoreKey: "load",
        ignoreLabel: "High load",
        level,
        icon: "gauge-high",
        title: `High load: ${load1.toFixed(2)}`,
        detail: `${perCore.toFixed(1)}x the ${cpucount} cores`,
        section: "processes",
    };
}

function sortAlerts(alerts: HostAlert[]): HostAlert[] {
    return alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === "crit" ? -1 : 1));
}

// the subset of alerts the lightweight vitals poll can raise (no service or container data)
export function computeVitalsAlerts(v: HostVitalsInfo): HostAlert[] {
    if (v == null) return [];
    const found = [
        v.diskmaxmount
            ? diskAlert(v.diskmaxmount, v.diskmaxpct, `Fullest disk on this host (${v.diskmaxpct.toFixed(0)}%)`)
            : null,
        memAlert(v.memtotal, v.memavail),
        loadAlert(v.load1, v.cpucount),
    ];
    return sortAlerts(found.filter((a) => a != null));
}

export function computeAlerts(data: HostInfoData): HostAlert[] {
    const alerts: HostAlert[] = [];
    const sys = data?.system;
    if (sys) {
        for (const d of sys.disks ?? []) {
            if (d.total <= 0) continue;
            const a = diskAlert(d.mount, pct(d.used, d.total), `${fmtBytes(d.avail)} free of ${fmtBytes(d.total)}`);
            if (a != null) alerts.push(a);
        }
        const mem = memAlert(sys.memtotal, sys.memavail);
        if (mem != null) alerts.push(mem);
        const load = loadAlert(sys.load1, sys.cpucount);
        if (load != null) alerts.push(load);
    }
    const failed = (data?.services?.available ? data.services.services : []).filter((s) => s.active === "failed");
    for (const s of failed) {
        alerts.push({
            key: `svc|${s.unit}`,
            ignoreKey: `svc|${s.unit}`,
            ignoreLabel: `Service ${s.unit}`,
            level: "crit",
            icon: "gears",
            title: `Service failed: ${s.unit}`,
            detail: s.description || `${s.active}/${s.sub}`,
            section: "services",
        });
    }
    const containers = data?.docker?.available && !data.docker.error ? data.docker.containers : [];
    for (const c of containers) {
        const problem = containerProblem(c);
        if (problem == null) continue;
        alerts.push({
            key: `ctr|${c.name}|${problem}`,
            ignoreKey: `ctr|${c.name}`,
            ignoreLabel: `Container ${c.name}`,
            level: "warn",
            icon: "cubes",
            title: `Container ${problem}: ${c.name}`,
            detail: c.status || c.image,
            section: "docker",
        });
    }
    return sortAlerts(alerts).slice(0, MaxListedAlerts);
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

export type HostCommandSet = {
    serviceJournal?: (unit: string) => string;
    serviceStatus?: (unit: string) => string;
    containerShell: (name: string) => string;
    containerLogs: (name: string) => string;
    containerInspect: (name: string) => string;
    processTop?: (pid: number) => string;
};

// The remote shell may be cmd.exe, PowerShell or a Cygwin/MSYS bash, which quote differently, so only
// names that need no escaping in any of them get a command (double quotes, no "$" for bash).
const WinSafeNameRe = /^[A-Za-z0-9 _.@#{}~-]+$/;

const WindowsCommands: HostCommandSet = {
    serviceStatus: (unit: string) =>
        WinSafeNameRe.test(unit)
            ? `powershell.exe -NoProfile -Command "Get-Service -Name '${unit}' | Format-List *"`
            : null,
    containerShell: (name: string) => `docker exec -it "${name}" sh`,
    containerLogs: (name: string) => `docker logs -f --tail 200 "${name}"`,
    containerInspect: (name: string) => `docker inspect "${name}"`,
};

export function getHostCommands(os: string): HostCommandSet {
    return os === "windows" ? WindowsCommands : HostCommands;
}
