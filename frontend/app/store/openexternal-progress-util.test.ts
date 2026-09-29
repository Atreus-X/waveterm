// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { openProgressFraction, openProgressKey, openProgressLabel } from "./openexternal-progress-util";

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
