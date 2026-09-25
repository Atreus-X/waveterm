// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { HostVitalsModel } from "@/app/store/hostvitals";
import { FleetView, FleetViewModel } from "@/app/view/fleet/fleet";
import { atom, PrimitiveAtom } from "jotai";
import { useEffect, useRef } from "react";

const GiB = 1024 ** 3;

type FakeHost = {
    conn: string;
    status: "connected" | "disconnected" | "error";
    cpu: number;
    mem: number;
    disk: number;
    mount: string;
};

const Hosts: FakeHost[] = [
    { conn: "admin@web1.example.com", status: "connected", cpu: 35, mem: 55, disk: 48, mount: "/" },
    { conn: "admin@db1.example.com", status: "connected", cpu: 72, mem: 88, disk: 91, mount: "/var/lib/postgresql" },
    { conn: "admin@build.example.com", status: "connected", cpu: 12, mem: 30, disk: 64, mount: "/srv/cache" },
    { conn: "pi@kiosk.example.com", status: "connected", cpu: 4, mem: 41, disk: 22, mount: "/" },
    { conn: "admin@backup.example.com", status: "disconnected", cpu: 0, mem: 0, disk: 0, mount: "" },
    { conn: "admin@old-nas.example.com", status: "error", cpu: 0, mem: 0, disk: 0, mount: "" },
];

const statusAtoms = new Map<string, PrimitiveAtom<ConnStatus>>();
function statusAtom(conn: string): PrimitiveAtom<ConnStatus> {
    let a = statusAtoms.get(conn);
    if (a == null) {
        const h = Hosts.find((x) => x.conn === conn);
        a = atom<ConnStatus>({
            connection: conn,
            status: h?.status ?? "disconnected",
            connected: h?.status === "connected",
            error: h?.status === "error" ? "dial tcp: connection timed out" : undefined,
        } as ConnStatus) as PrimitiveAtom<ConnStatus>;
        statusAtoms.set(conn, a);
    }
    return a;
}

function jitter(base: number, spread: number): number {
    return Math.max(0, Math.min(100, base + (Math.random() - 0.5) * spread));
}

function makeModel(): FleetViewModel {
    const connections: Record<string, ConnKeywords> = {};
    Hosts.forEach((h) => (connections[h.conn] = {}));
    const env = {
        rpc: {
            HostInfoCommand: async (_c: unknown, data: CommandHostInfoData) => {
                const h = Hosts.find((x) => x.conn === data.conn);
                const memTotal = 16 * GiB;
                return {
                    conn: data.conn,
                    ts: Date.now(),
                    uid: 1000,
                    vitals: {
                        cpupct: jitter(h.cpu, 20),
                        cpucount: 8,
                        load1: (h.cpu / 100) * 8 * (0.8 + Math.random() * 0.4),
                        memtotal: memTotal,
                        memavail: memTotal * (1 - jitter(h.mem, 4) / 100),
                        uptimesec: 12 * 86400,
                        rxrate: Math.random() * 3e6,
                        txrate: Math.random() * 4e5,
                        diskmaxpct: h.disk,
                        diskmaxmount: h.mount,
                    },
                } as HostInfoData;
            },
            ConnConnectCommand: async () => {},
        },
        atoms: { fullConfigAtom: atom({ connections } as FullConfigType) },
        createBlock: async (blockDef: BlockDef) => {
            console.log("[fleet preview] createBlock", blockDef.meta);
            return "";
        },
        getConnStatusAtom: statusAtom,
    };
    return new FleetViewModel({ blockId: "preview-fleet", waveEnv: env } as unknown as ViewModelInitType);
}

export function FleetPreview() {
    const modelRef = useRef<FleetViewModel>(null);
    if (modelRef.current == null) {
        modelRef.current = makeModel();
    }
    useEffect(() => {
        // fill the sparklines quickly instead of waiting for the 5s poll
        let n = 0;
        const t = setInterval(() => {
            HostVitalsModel.getInstance().pollAll();
            if (++n > 30) clearInterval(t);
        }, 100);
        return () => clearInterval(t);
    }, []);
    return (
        <div className="h-[420px] w-[1000px] overflow-hidden rounded border border-border bg-background text-foreground">
            <FleetView blockId="preview-fleet" model={modelRef.current} blockRef={null} contentRef={null} />
        </div>
    );
}
