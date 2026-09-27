// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getSleepReconnectMessage } from "./sleepreconnectbanner";

describe("getSleepReconnectMessage", () => {
    it("names the reason and hosts", () => {
        expect(getSleepReconnectMessage("sleep", ["alpha", "beta"])).toBe(
            "Disconnected while the computer was asleep: alpha, beta"
        );
        expect(getSleepReconnectMessage("lock", ["alpha"])).toBe("Disconnected while the screen was locked: alpha");
    });

    it("truncates long host lists", () => {
        expect(getSleepReconnectMessage("sleep", ["a", "b", "c", "d", "e"])).toBe(
            "Disconnected while the computer was asleep: a, b, c and 2 more"
        );
    });
});
