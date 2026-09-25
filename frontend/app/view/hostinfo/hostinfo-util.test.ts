// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { assert, expect, test } from "vitest";
import {
    changeCount,
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
