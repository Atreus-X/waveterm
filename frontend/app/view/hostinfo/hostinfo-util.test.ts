// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { assert, expect, test } from "vitest";
import {
    changeCount,
    computeAlerts,
    connHost,
    diffHost,
    fmtBytes,
    fmtDuration,
    groupPorts,
    HostCommands,
    isContainerIface,
    usageLevel,
} from "./hostinfo-util";

test("fmtBytes and fmtDuration", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KiB");
    expect(fmtBytes(32 * 1024 ** 3)).toBe("32.0 GiB");
    expect(fmtDuration(45)).toBe("45s");
    expect(fmtDuration(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(fmtDuration(2 * 3600 + 5 * 60)).toBe("2h 5m");
});

test("usageLevel thresholds", () => {
    expect(usageLevel(50)).toBe("ok");
    expect(usageLevel(80)).toBe("warn");
    expect(usageLevel(95)).toBe("crit");
});

test("groupPorts merges IPv4/IPv6 listeners and flags local-only ones", () => {
    const rows = groupPorts([
        { proto: "tcp", addr: "0.0.0.0", port: 22, process: "sshd", pid: 812 },
        { proto: "tcp6", addr: "::", port: 22, process: "sshd", pid: 812 },
        { proto: "udp", addr: "127.0.0.53%lo", port: 53, process: "systemd-resolve", pid: 600 },
        { proto: "tcp", addr: "::1", port: 631 },
    ]);
    expect(rows.map((r) => r.port)).toEqual([22, 53, 631]);
    expect(rows[0].addrs).toEqual(["0.0.0.0", "::"]);
    assert(!rows[0].localOnly);
    assert(rows[1].localOnly);
    assert(rows[2].localOnly && rows[2].process === "");
});

test("connHost extracts the host from connection names", () => {
    expect(connHost("admin@server.example.com")).toBe("server.example.com");
    expect(connHost("admin@server.example.com:2222")).toBe("server.example.com");
    expect(connHost("server")).toBe("server");
    expect(connHost("root@[2001:db8::1]:22")).toBe("2001:db8::1");
    expect(connHost("local")).toBe("localhost");
    expect(connHost("")).toBe("localhost");
});

test("isContainerIface", () => {
    assert(isContainerIface("veth12ab"));
    assert(isContainerIface("br-0f3c"));
    assert(isContainerIface("docker0"));
    assert(!isContainerIface("eth0"));
    assert(!isContainerIface("wlan0"));
});

test("diffHost reports new ports, changed services and containers", () => {
    const base: HostInfoData = {
        conn: "x",
        ts: 1,
        uid: 1000,
        ports: { ports: [{ proto: "tcp", addr: "0.0.0.0", port: 22, process: "sshd" }] },
        services: {
            available: true,
            failed: 0,
            services: [{ unit: "nginx.service", load: "loaded", active: "active", sub: "running" }],
        },
        docker: {
            available: true,
            containers: [
                { id: "a", name: "web", image: "i", state: "running", status: "Up" },
                { id: "b", name: "old", image: "i", state: "running", status: "Up" },
            ],
        },
    };
    const cur: HostInfoData = {
        ...base,
        ports: {
            ports: [
                { proto: "tcp", addr: "0.0.0.0", port: 22, process: "sshd" },
                { proto: "tcp", addr: "0.0.0.0", port: 8080, process: "java" },
            ],
        },
        services: {
            available: true,
            failed: 1,
            services: [{ unit: "nginx.service", load: "loaded", active: "failed", sub: "failed" }],
        },
        docker: {
            available: true,
            containers: [
                { id: "a", name: "web", image: "i", state: "exited", status: "Exited (1)" },
                { id: "c", name: "new", image: "i", state: "running", status: "Up" },
            ],
        },
    };
    const ch = diffHost(base, cur);
    assert(ch.ports.has("tcp|8080|java") && ch.ports.size === 1);
    assert(ch.services.has("nginx.service"));
    assert(ch.containers.has("a") && ch.containers.has("c") && ch.containers.size === 2);
    expect(ch.containersGone).toBe(1);
    expect(changeCount(ch)).toBe(5);
    expect(changeCount(diffHost(base, base))).toBe(0);
});

test("HostCommands quote their arguments", () => {
    expect(HostCommands.serviceJournal("nginx.service")).toBe("journalctl -u nginx.service -n 200 -f");
    expect(HostCommands.containerLogs("a b;rm -rf /")).toBe("docker logs -f --tail 200 'a b;rm -rf /'");
    expect(HostCommands.processTop(42.9)).toBe("top -p 42");
});

test("computeAlerts flags disks, memory, failed services and unhealthy containers", () => {
    const GiB = 1024 ** 3;
    const data = {
        system: {
            cpucount: 4,
            load1: 1,
            memtotal: 10 * GiB,
            memavail: 0.5 * GiB,
            disks: [
                { mount: "/", total: 100 * GiB, used: 95 * GiB, avail: 5 * GiB },
                { mount: "/data", total: 100 * GiB, used: 50 * GiB, avail: 50 * GiB },
            ],
        },
        services: {
            available: true,
            failed: 1,
            services: [
                { unit: "a.service", active: "failed", sub: "failed" },
                { unit: "b.service", active: "active", sub: "running" },
            ],
        },
        docker: {
            available: true,
            containers: [
                { id: "1", name: "web", state: "running", status: "Up 2 hours (unhealthy)", image: "x" },
                { id: "2", name: "job", state: "exited", status: "Exited (0) 1 hour ago", image: "x" },
                { id: "3", name: "bad", state: "exited", status: "Exited (137) 1 hour ago", image: "x" },
            ],
        },
    } as HostInfoData;
    const alerts = computeAlerts(data);
    const titles = alerts.map((a) => a.title);
    expect(titles).toContain("Disk 95% full: /");
    expect(titles).toContain("Memory 95% used");
    expect(titles).toContain("Service failed: a.service");
    expect(titles).toContain("Container unhealthy: web");
    expect(titles).toContain("Container exited with code 137: bad");
    expect(titles.some((t) => t.includes("/data") || t.includes("job") || t.includes("b.service"))).toBe(false);
    expect(alerts[alerts.length - 1].level).toBe("warn");
    expect(alerts[0].level).toBe("crit");
});

test("computeAlerts is empty for a healthy or missing host", () => {
    expect(computeAlerts(null)).toEqual([]);
    expect(
        computeAlerts({ system: { cpucount: 2, load1: 0.1, memtotal: 100, memavail: 80, disks: [] } } as HostInfoData)
    ).toEqual([]);
});
