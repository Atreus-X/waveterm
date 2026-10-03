// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    formatEta,
    formatSpeed,
    openProgressFraction,
    openProgressKey,
    openProgressLabel,
    transferDetail,
    transferLabel,
    updateRate,
} from "./openexternal-progress-util";

const base = { path: "/srv/big.bin", connection: "user@host", received: 0, total: 0 };
const MB = 1024 * 1024;

describe("open-external progress", () => {
    it("labels download progress with percent and size", () => {
        const p = { ...base, phase: "download" as const, received: 45 * MB, total: 100 * MB };
        expect(openProgressFraction(p)).toBeCloseTo(0.45);
        expect(openProgressLabel(p)).toBe("Downloading 45% of 100 MB");
    });

    it("falls back to bytes when the size is unknown", () => {
        const p = { ...base, phase: "download" as const, received: 12.34 * MB };
        expect(openProgressFraction(p)).toBeNull();
        expect(openProgressLabel(p)).toBe("Downloading 12.3 MB");
    });

    it("labels opening and errors", () => {
        expect(openProgressLabel({ ...base, phase: "opening" })).toBe("Opening…");
        expect(openProgressFraction({ ...base, phase: "opening" })).toBe(1);
        expect(openProgressLabel({ ...base, phase: "error", error: "boom" })).toBe("Couldn't open: boom");
        expect(openProgressLabel({ ...base, phase: "done" })).toBe("");
    });

    it("keys by connection and path", () => {
        expect(openProgressKey("user@host", "/a")).toBe("user@host|/a");
        expect(openProgressKey(null, "/a")).toBe("|/a");
    });
});

describe("transfer speed and eta", () => {
    it("formats speed and eta", () => {
        expect(formatSpeed(0)).toBe("");
        expect(formatSpeed(512)).toBe("1 KB/s");
        expect(formatSpeed(2.5 * MB)).toBe("2.5 MB/s");
        expect(formatEta(0.2)).toBe("1s");
        expect(formatEta(75)).toBe("1m 15s");
        expect(formatEta(3720)).toBe("1h 02m");
    });

    it("smooths the rate and restarts when the count goes backwards", () => {
        let r = updateRate(undefined, 0, 0);
        expect(r.bps).toBe(0);
        r = updateRate(r, 1 * MB, 1000);
        expect(r.bps).toBeCloseTo(1 * MB);
        expect(updateRate(r, 1.1 * MB, 1100)).toBe(r);
        r = updateRate(r, 3 * MB, 2000);
        expect(r.bps).toBeCloseTo(0.3 * 2 * MB + 0.7 * 1 * MB);
        expect(updateRate(r, 0, 3000).bps).toBe(0);
    });

    it("builds the detail string", () => {
        expect(transferDetail(10 * MB, 100 * MB, 0)).toBe("");
        expect(transferDetail(10 * MB, 100 * MB, 1 * MB)).toBe("1.0 MB/s · 1m 30s left");
        expect(transferDetail(10 * MB, 0, 1 * MB)).toBe("1.0 MB/s");
        expect(transferLabel(25 * MB, 100 * MB)).toBe("25% of 100 MB");
        expect(transferLabel(2.5 * MB, 0)).toBe("2.5 MB");
    });
});
