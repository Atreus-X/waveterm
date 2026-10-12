// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Desktop notifications for host alerts. The vitals poller and the Host Inspector both report what they
// see for a connection; a notification fires only when a critical alert appears that neither of them had
// reported before, so an alert that stays active never repeats.

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { HostAlert } from "@/app/view/hostinfo/hostinfo-util";

const MaxBodyLines = 4;

export type HostAlertNotifierDeps = {
    enabled: () => boolean;
    windowFocused: () => boolean;
    notify: (conn: string, fresh: HostAlert[]) => void;
};

function showDesktopNotification(conn: string, fresh: HostAlert[]) {
    if (typeof Notification === "undefined") return;
    try {
        const lines = fresh.slice(0, MaxBodyLines).map((a) => a.title);
        if (fresh.length > MaxBodyLines) {
            lines.push(`and ${fresh.length - MaxBodyLines} more`);
        }
        const n = new Notification(`${conn}: ${fresh.length} critical alert${fresh.length === 1 ? "" : "s"}`, {
            body: lines.join("\n"),
            tag: `hostalert|${conn}`,
        });
        n.onclick = () => window.focus();
    } catch (_) {}
}

export class HostAlertNotifier {
    private static instance: HostAlertNotifier | null = null;

    deps: HostAlertNotifierDeps;
    // conn -> source ("vitals" | "inspector") -> alerts that source currently sees
    sources = new Map<string, Map<string, HostAlert[]>>();
    // conn -> alert keys that were active the last time anything was reported
    live = new Map<string, Set<string>>();

    private constructor(deps: HostAlertNotifierDeps) {
        this.deps = deps;
    }

    static getInstance(): HostAlertNotifier {
        if (!HostAlertNotifier.instance) {
            HostAlertNotifier.instance = new HostAlertNotifier({
                enabled: () => globalStore.get(getSettingsKeyAtom("conn:notifyalerts")) ?? true,
                windowFocused: () => typeof document !== "undefined" && document.hasFocus(),
                notify: showDesktopNotification,
            });
        }
        return HostAlertNotifier.instance;
    }

    static makeForTest(deps: HostAlertNotifierDeps): HostAlertNotifier {
        return new HostAlertNotifier(deps);
    }

    report(conn: string, source: string, alerts: HostAlert[]) {
        let bySource = this.sources.get(conn);
        if (bySource == null) {
            bySource = new Map();
            this.sources.set(conn, bySource);
        }
        bySource.set(source, alerts);
        this.evaluate(conn);
    }

    clear(conn: string, source: string) {
        if (!this.sources.get(conn)?.delete(source)) return;
        this.evaluate(conn);
    }

    evaluate(conn: string) {
        const merged = new Map<string, HostAlert>();
        for (const alerts of this.sources.get(conn)?.values() ?? []) {
            for (const a of alerts) merged.set(a.key, a);
        }
        const before = this.live.get(conn) ?? new Set<string>();
        this.live.set(conn, new Set(merged.keys()));
        // tracked even when notifications are off or the window is focused, so turning them on or
        // switching away later doesn't announce alerts that were already showing
        const fresh = [...merged.values()].filter((a) => a.level === "crit" && !before.has(a.key));
        if (fresh.length === 0 || !this.deps.enabled() || this.deps.windowFocused()) return;
        this.deps.notify(conn, fresh);
    }
}
