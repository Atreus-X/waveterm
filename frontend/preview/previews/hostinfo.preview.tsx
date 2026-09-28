// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { HostInfoView } from "@/app/view/hostinfo/hostinfo";
import { HostInfoViewModel } from "@/app/view/hostinfo/hostinfo-model";
import type { HostSectionId } from "@/app/view/hostinfo/hostinfo-util";
import { atom } from "jotai";
import { useEffect, useRef } from "react";

const GiB = 1024 ** 3;

const baseData: HostInfoData = {
    conn: "admin@server.example.com",
    ts: Date.now(),
    uid: 1000,
    user: "admin",
    system: {
        hostname: "server",
        os: "Ubuntu 24.04.3 LTS",
        kernel: "Linux 6.8.0-48-generic x86_64",
        virt: "kvm",
        uptimesec: 5 * 86400 + 3 * 3600,
        load1: 1.42,
        load5: 1.1,
        load15: 0.96,
        cpumodel: "Example 8-Core Processor",
        cpucount: 8,
        cpupct: 23.4,
        memtotal: 32 * GiB,
        memavail: 9.5 * GiB,
        swaptotal: 4 * GiB,
        swapfree: 3.6 * GiB,
        users: 2,
        disks: [
            { mount: "/", device: "/dev/vda2", fstype: "ext4", total: 480 * GiB, used: 212 * GiB, avail: 244 * GiB },
            {
                mount: "/boot/efi",
                device: "/dev/vda1",
                fstype: "vfat",
                total: 0.5 * GiB,
                used: 0.01 * GiB,
                avail: 0.49 * GiB,
            },
            {
                mount: "/srv/data",
                device: "/dev/vdb1",
                fstype: "xfs",
                total: 2000 * GiB,
                used: 1850 * GiB,
                avail: 150 * GiB,
            },
        ],
    },
    network: {
        interfaces: [
            {
                name: "eth0",
                addrs: ["192.0.2.10/24", "fe80::1/64"],
                rxbytes: 812 * GiB,
                txbytes: 95 * GiB,
                rxrate: 1.2e6,
                txrate: 180e3,
            },
            {
                name: "lo",
                addrs: ["127.0.0.1/8", "::1/128"],
                rxbytes: 3 * GiB,
                txbytes: 3 * GiB,
                rxrate: 4e3,
                txrate: 4e3,
            },
            { name: "docker0", addrs: ["198.51.100.1/24"], rxbytes: 2 * GiB, txbytes: 9 * GiB, rxrate: 0, txrate: 0 },
            { name: "veth1a2b", rxbytes: 1 * GiB, txbytes: 2 * GiB, rxrate: 900, txrate: 2000 },
        ],
        defaultroute: "default via 192.0.2.1 dev eth0 proto static",
        dns: ["192.0.2.53", "9.9.9.9"],
    },
    ports: {
        tool: "ss",
        needsroot: true,
        ports: [
            { proto: "tcp", addr: "0.0.0.0", port: 22, process: "sshd", pid: 812 },
            { proto: "tcp6", addr: "::", port: 22, process: "sshd", pid: 812 },
            { proto: "tcp", addr: "0.0.0.0", port: 443, process: "nginx", pid: 1201 },
            { proto: "tcp", addr: "0.0.0.0", port: 80, process: "nginx", pid: 1201 },
            { proto: "tcp", addr: "127.0.0.1", port: 5432 },
            { proto: "udp", addr: "127.0.0.53%lo", port: 53, process: "systemd-resolve", pid: 600 },
        ],
    },
    processes: {
        total: 214,
        processes: [
            {
                pid: 2211,
                ppid: 1,
                user: "postgres",
                cpupct: 12.4,
                mempct: 6.1,
                rss: 1.9 * GiB,
                elapsedsec: 400000,
                state: "Ss",
                name: "postgres",
                args: "/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main",
            },
            {
                pid: 1201,
                ppid: 1,
                user: "root",
                cpupct: 3.2,
                mempct: 0.4,
                rss: 0.12 * GiB,
                elapsedsec: 450000,
                state: "Ss",
                name: "nginx",
                args: "nginx: master process /usr/sbin/nginx",
            },
            {
                pid: 3890,
                ppid: 3001,
                user: "app",
                cpupct: 2.8,
                mempct: 4.4,
                rss: 1.4 * GiB,
                elapsedsec: 90000,
                state: "Sl",
                name: "node",
                args: "node /srv/app/server.js",
            },
            {
                pid: 812,
                ppid: 1,
                user: "root",
                cpupct: 0.0,
                mempct: 0.0,
                rss: 0.008 * GiB,
                elapsedsec: 460000,
                state: "Ss",
                name: "sshd",
                args: "sshd: /usr/sbin/sshd -D [listener]",
            },
        ],
    },
    services: {
        available: true,
        failed: 0,
        services: [
            {
                unit: "nginx.service",
                load: "loaded",
                active: "active",
                sub: "running",
                enabled: "enabled",
                description: "A high performance web server and a reverse proxy server",
            },
            {
                unit: "postgresql@16-main.service",
                load: "loaded",
                active: "active",
                sub: "running",
                enabled: "enabled",
                description: "PostgreSQL Cluster 16-main",
            },
            {
                unit: "backup.service",
                load: "loaded",
                active: "inactive",
                sub: "dead",
                enabled: "static",
                description: "Nightly backup",
            },
            {
                unit: "ssh.service",
                load: "loaded",
                active: "active",
                sub: "running",
                enabled: "enabled",
                description: "OpenBSD Secure Shell server",
            },
        ],
    },
    docker: {
        available: true,
        containers: [
            {
                id: "c1",
                name: "webapp-web-1",
                image: "example/webapp:2.4",
                state: "running",
                status: "Up 3 days (healthy)",
                ports: "0.0.0.0:8000->8000/tcp",
                project: "webapp",
                mounts: "/srv/webapp/data",
            },
            {
                id: "c2",
                name: "webapp-worker-1",
                image: "example/webapp:2.4",
                state: "running",
                status: "Up 3 days",
                project: "webapp",
            },
            {
                id: "c3",
                name: "webapp-redis-1",
                image: "redis:7",
                state: "running",
                status: "Up 3 days",
                ports: "6379/tcp",
                project: "webapp",
            },
            {
                id: "c4",
                name: "grafana",
                image: "grafana/grafana:11.2.0",
                state: "running",
                status: "Up 26 hours",
                ports: "0.0.0.0:3000->3000/tcp",
            },
            {
                id: "c5",
                name: "old-migration",
                image: "example/migrate:1",
                state: "exited",
                status: "Exited (0) 2 weeks ago",
            },
        ],
    },
};

// later refreshes show a few changes so the "what changed" highlighting is visible
function laterData(): HostInfoData {
    const d: HostInfoData = JSON.parse(JSON.stringify(baseData));
    d.ts = Date.now();
    d.system.cpupct = 31.7;
    d.ports.ports.push({ proto: "tcp", addr: "0.0.0.0", port: 8080, process: "java", pid: 4411 });
    d.services.failed = 1;
    d.services.services[0] = { ...d.services.services[0], active: "failed", sub: "failed" };
    d.docker.containers[1] = { ...d.docker.containers[1], state: "exited", status: "Exited (137) 4 minutes ago" };
    return d;
}

function makeModel(section: HostSectionId): HostInfoViewModel {
    let calls = 0;
    const env = {
        rpc: {
            HostInfoCommand: async () => (calls++ === 0 ? baseData : laterData()),
            HostActionCommand: async (_c: unknown, data: CommandHostActionData) =>
                data.kind === "service"
                    ? { needsauth: true, command: `sudo systemctl ${data.action} ${data.target}` }
                    : { output: "" },
        },
        createBlock: async (blockDef: BlockDef) => {
            console.log("[hostinfo preview] createBlock", blockDef.meta);
            return "";
        },
        getConnStatusAtom: () =>
            atom<ConnStatus>({ connected: true, status: "connected", connection: baseData.conn } as ConnStatus),
        getBlockMetaKeyAtom: () => atom(baseData.conn),
    };
    const model = new HostInfoViewModel({ blockId: "preview-hostinfo", waveEnv: env } as unknown as ViewModelInitType);
    model.setSection(section);
    return model;
}

export function HostInfoPreview() {
    const section = (new URLSearchParams(window.location.search).get("section") ?? "overview") as HostSectionId;
    const modelRef = useRef<HostInfoViewModel>(null);
    if (modelRef.current == null) {
        modelRef.current = makeModel(section);
    }
    useEffect(() => {
        const model = modelRef.current;
        // pull a second snapshot right away so the preview shows change highlighting
        const t = setTimeout(() => model.fetch(["system", "ports", "services", "docker"], false), 300);
        return () => {
            clearTimeout(t);
            model.dispose();
        };
    }, []);
    return (
        <div className="h-[640px] w-[1000px] overflow-hidden rounded border border-border bg-background text-foreground">
            <HostInfoView blockId="preview-hostinfo" model={modelRef.current} blockRef={null} contentRef={null} />
        </div>
    );
}
