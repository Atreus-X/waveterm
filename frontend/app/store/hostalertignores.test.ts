// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { computeAlerts, computeVitalsAlerts } from "@/app/view/hostinfo/hostinfo-util";
import { expect, test } from "vitest";
import { filterIgnored, isIgnoredIn, parseIgnores, withIgnored, withoutIgnored } from "./hostalertignores";

const GiB = 1024 ** 3;

test("parseIgnores keeps well-formed rules and drops junk", () => {
    expect(parseIgnores(null)).toEqual({});
    expect(parseIgnores("not json")).toEqual({});
    expect(parseIgnores("[1,2]")).toEqual({});
    expect(
        parseIgnores(
            JSON.stringify({
                h1: [{ key: "mem", label: "Memory usage" }, { key: 5 }, "x"],
                h2: "nope",
                h3: [],
            })
        )
    ).toEqual({ h1: [{ key: "mem", label: "Memory usage" }] });
});

test("withIgnored and withoutIgnored are immutable, idempotent and tidy up empty hosts", () => {
    const rule = { key: "disk|/", label: "Disk usage on /" };
    const a = withIgnored({}, "h1", rule);
    expect(a).toEqual({ h1: [rule] });
    expect(withIgnored(a, "h1", rule)).toBe(a);
    expect(withoutIgnored(a, "h1", "missing")).toBe(a);
    expect(withoutIgnored(a, "h1", "disk|/")).toEqual({});
    expect(a).toEqual({ h1: [rule] });
});

test("isIgnoredIn is per host", () => {
    const map = withIgnored({}, "h1", { key: "mem", label: "Memory usage" });
    expect(isIgnoredIn(map, "h1", "mem")).toBe(true);
    expect(isIgnoredIn(map, "h2", "mem")).toBe(false);
    expect(isIgnoredIn(map, "h1", "load")).toBe(false);
});

test("an ignore rule covers the condition at every severity, for both the inspector and the vitals alerts", () => {
    const map = withIgnored({}, "h1", { key: "disk|/", label: "Disk usage on /" });
    const sys = (usedGiB: number) =>
        ({
            system: {
                cpucount: 2,
                load1: 0.1,
                memtotal: 10 * GiB,
                memavail: 9 * GiB,
                disks: [{ mount: "/", total: 100 * GiB, used: usedGiB * GiB, avail: (100 - usedGiB) * GiB }],
            },
        }) as HostInfoData;
    for (const used of [80, 95]) {
        expect(computeAlerts(sys(used)).length).toBe(1);
        expect(filterIgnored(map, "h1", computeAlerts(sys(used)))).toEqual([]);
    }
    const vitals = {
        cpucount: 2,
        load1: 0.1,
        memtotal: 100,
        memavail: 90,
        diskmaxpct: 95,
        diskmaxmount: "/",
    } as HostVitalsInfo;
    expect(filterIgnored(map, "h1", computeVitalsAlerts(vitals))).toEqual([]);
    expect(filterIgnored(map, "h2", computeVitalsAlerts(vitals)).length).toBe(1);
});

test("ignoring one mount leaves other disks, services and containers alone", () => {
    const map = withIgnored({}, "h1", { key: "disk|/", label: "Disk usage on /" });
    const data = {
        system: {
            cpucount: 2,
            load1: 0.1,
            memtotal: 100,
            memavail: 90,
            disks: [
                { mount: "/", total: 100 * GiB, used: 95 * GiB, avail: 5 * GiB },
                { mount: "/data", total: 100 * GiB, used: 95 * GiB, avail: 5 * GiB },
            ],
        },
        services: { available: true, failed: 1, services: [{ unit: "a.service", active: "failed", sub: "failed" }] },
        docker: {
            available: true,
            containers: [{ id: "1", name: "web", state: "exited", status: "Exited (1) 1 hour ago", image: "x" }],
        },
    } as HostInfoData;
    const left = filterIgnored(map, "h1", computeAlerts(data)).map((a) => a.ignoreKey);
    expect(left.sort()).toEqual(["ctr|web", "disk|/data", "svc|a.service"]);
});
