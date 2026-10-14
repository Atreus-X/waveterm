// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Host alert conditions the user has chosen to ignore for good, per connection. Kept in localStorage so
// every block and window shares them and they survive restarts.

import { globalStore } from "@/app/store/jotaiStore";
import type { HostAlert } from "@/app/view/hostinfo/hostinfo-util";
import * as jotai from "jotai";
import { useMemo } from "react";

const StorageKey = "hostalerts:ignored";

export type IgnoredRule = { key: string; label: string };
export type IgnoreMap = Record<string, IgnoredRule[]>;

// localStorage can hold junk or be edited by hand, so anything malformed is dropped rather than trusted
export function parseIgnores(raw: string): IgnoreMap {
    const out: IgnoreMap = {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
        for (const [conn, rules] of Object.entries(parsed)) {
            if (!Array.isArray(rules)) continue;
            const clean = rules
                .filter((r: any) => typeof r?.key === "string" && typeof r?.label === "string")
                .map((r: any) => ({ key: r.key, label: r.label }));
            if (clean.length > 0) out[conn] = clean;
        }
    } catch (_) {}
    return out;
}

export function withIgnored(map: IgnoreMap, conn: string, rule: IgnoredRule): IgnoreMap {
    const existing = map[conn] ?? [];
    if (existing.some((r) => r.key === rule.key)) return map;
    return { ...map, [conn]: [...existing, rule] };
}

export function withoutIgnored(map: IgnoreMap, conn: string, key: string): IgnoreMap {
    const existing = map[conn];
    if (existing == null || !existing.some((r) => r.key === key)) return map;
    const next = { ...map };
    const rules = existing.filter((r) => r.key !== key);
    if (rules.length > 0) {
        next[conn] = rules;
    } else {
        delete next[conn];
    }
    return next;
}

export function isIgnoredIn(map: IgnoreMap, conn: string, ignoreKey: string): boolean {
    return map[conn]?.some((r) => r.key === ignoreKey) ?? false;
}

export function filterIgnored(map: IgnoreMap, conn: string, alerts: HostAlert[]): HostAlert[] {
    const rules = map[conn];
    if (rules == null) return alerts;
    return alerts.filter((a) => !rules.some((r) => r.key === a.ignoreKey));
}

export class HostAlertIgnores {
    private static instance: HostAlertIgnores | null = null;

    mapAtom = jotai.atom<IgnoreMap>({}) as jotai.PrimitiveAtom<IgnoreMap>;

    private constructor() {
        this.load();
        if (typeof window !== "undefined") {
            window.addEventListener("storage", (e) => {
                if (e.key === StorageKey) this.load();
            });
        }
    }

    static getInstance(): HostAlertIgnores {
        if (!HostAlertIgnores.instance) {
            HostAlertIgnores.instance = new HostAlertIgnores();
        }
        return HostAlertIgnores.instance;
    }

    load() {
        try {
            globalStore.set(this.mapAtom, parseIgnores(localStorage.getItem(StorageKey)));
        } catch (_) {}
    }

    save(map: IgnoreMap) {
        globalStore.set(this.mapAtom, map);
        try {
            localStorage.setItem(StorageKey, JSON.stringify(map));
        } catch (_) {}
    }

    isIgnored(conn: string, ignoreKey: string): boolean {
        return isIgnoredIn(globalStore.get(this.mapAtom), conn, ignoreKey);
    }

    ignore(conn: string, alert: HostAlert) {
        this.save(withIgnored(globalStore.get(this.mapAtom), conn, { key: alert.ignoreKey, label: alert.ignoreLabel }));
    }

    restore(conn: string, ignoreKey: string) {
        this.save(withoutIgnored(globalStore.get(this.mapAtom), conn, ignoreKey));
    }
}

export function useVisibleAlerts(conn: string, alerts: HostAlert[]): HostAlert[] {
    const map = jotai.useAtomValue(HostAlertIgnores.getInstance().mapAtom);
    return useMemo(() => filterIgnored(map, conn, alerts ?? []), [map, conn, alerts]);
}
