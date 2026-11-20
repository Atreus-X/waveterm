// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { restoreSettleMs } from "./minimizedbody";

describe("restoreSettleMs", () => {
    it("waits for the layout animation plus a margin for the terminal's resize debounce", () => {
        expect(restoreSettleMs(0.2, false)).toBe(350);
        expect(restoreSettleMs(0.5, false)).toBe(650);
    });

    it("still waits the margin when animations are off, so the view appears after the size jump", () => {
        expect(restoreSettleMs(0, false)).toBe(150);
    });

    it("copes with a missing or negative animation time", () => {
        expect(restoreSettleMs(undefined, false)).toBe(150);
        expect(restoreSettleMs(null, false)).toBe(150);
        expect(restoreSettleMs(-1, false)).toBe(150);
    });

    it("doesn't delay a magnified block, which is drawn at full size straight away", () => {
        expect(restoreSettleMs(0.2, true)).toBe(0);
    });
});
