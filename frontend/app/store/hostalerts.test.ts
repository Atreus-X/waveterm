// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import type { HostAlert } from "@/app/view/hostinfo/hostinfo-util";
import { expect, test } from "vitest";
import { HostAlertNotifier } from "./hostalerts";

const crit = (key: string): HostAlert => ({
    key,
    level: "crit",
    icon: "x",
    title: key,
    detail: "",
    section: "overview",
});
const warn = (key: string): HostAlert => ({ ...crit(key), level: "warn" });

function makeNotifier(opts?: { enabled?: boolean; focused?: boolean }) {
    const sent: { conn: string; keys: string[] }[] = [];
    const flags = { enabled: opts?.enabled ?? true, focused: opts?.focused ?? false };
    const n = HostAlertNotifier.makeForTest({
        enabled: () => flags.enabled,
        windowFocused: () => flags.focused,
        notify: (conn, fresh) => sent.push({ conn, keys: fresh.map((a) => a.key) }),
    });
    return { n, sent, flags };
}

test("notifies once for a new critical alert, not on every report", () => {
    const { n, sent } = makeNotifier();
    n.report("h1", "vitals", [crit("disk|/|crit")]);
    n.report("h1", "vitals", [crit("disk|/|crit")]);
    expect(sent).toEqual([{ conn: "h1", keys: ["disk|/|crit"] }]);
});

test("warnings never notify", () => {
    const { n, sent } = makeNotifier();
    n.report("h1", "vitals", [warn("mem|warn")]);
    expect(sent).toEqual([]);
});

test("an alert that clears and returns notifies again", () => {
    const { n, sent } = makeNotifier();
    n.report("h1", "vitals", [crit("a")]);
    n.report("h1", "vitals", []);
    n.report("h1", "vitals", [crit("a")]);
    expect(sent.length).toBe(2);
});

test("vitals and inspector reporting the same alert do not double up", () => {
    const { n, sent } = makeNotifier();
    n.report("h1", "vitals", [crit("disk|/|crit")]);
    n.report("h1", "inspector", [crit("disk|/|crit"), crit("svc|a.service")]);
    n.report("h1", "vitals", [crit("disk|/|crit")]);
    expect(sent.map((s) => s.keys)).toEqual([["disk|/|crit"], ["svc|a.service"]]);
});

test("batched alerts for one host make one notification", () => {
    const { n, sent } = makeNotifier();
    n.report("h1", "inspector", [crit("a"), crit("b")]);
    expect(sent).toEqual([{ conn: "h1", keys: ["a", "b"] }]);
});

test("clearing the inspector keeps alerts the vitals poll still sees", () => {
    const { n, sent } = makeNotifier();
    n.report("h1", "vitals", [crit("a")]);
    n.report("h1", "inspector", [crit("a")]);
    n.clear("h1", "inspector");
    expect(sent.length).toBe(1);
});

test("stays quiet while disabled or focused, and does not announce them later", () => {
    const off = makeNotifier({ enabled: false });
    off.n.report("h1", "vitals", [crit("a")]);
    off.flags.enabled = true;
    off.n.report("h1", "vitals", [crit("a")]);
    expect(off.sent).toEqual([]);

    const focused = makeNotifier({ focused: true });
    focused.n.report("h1", "vitals", [crit("a")]);
    focused.flags.focused = false;
    focused.n.report("h1", "vitals", [crit("a"), crit("b")]);
    expect(focused.sent).toEqual([{ conn: "h1", keys: ["b"] }]);
});

test("hosts are tracked independently", () => {
    const { n, sent } = makeNotifier();
    n.report("h1", "vitals", [crit("a")]);
    n.report("h2", "vitals", [crit("a")]);
    expect(sent.map((s) => s.conn)).toEqual(["h1", "h2"]);
});
