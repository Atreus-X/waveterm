// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { formatBusyDetail } from "./closetab-util";

describe("formatBusyDetail", () => {
    it("lists commands with their connection", () => {
        const text = formatBusyDetail([
            { blockid: "a", command: "npm run build" },
            { blockid: "b", command: "htop", conn: "user@example.com", tmux: true },
        ]);
        expect(text).toContain("• npm run build\n");
        expect(text).toContain("• htop on user@example.com");
        expect(text).toContain("tmux sessions on the remote host");
    });

    it("caps the list", () => {
        const busy = Array.from({ length: 9 }, (_, i) => ({ blockid: String(i), command: `job${i}` }));
        const text = formatBusyDetail(busy);
        expect(text).toContain("• job5");
        expect(text).not.toContain("• job6");
        expect(text).toContain("• and 3 more");
        expect(text).not.toContain("tmux");
    });
});
