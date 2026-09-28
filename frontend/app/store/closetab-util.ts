// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

const MaxListed = 6;

// the detail text of the "close a busy tab / terminal?" dialog
export function formatBusyDetail(busy: BlockBusyInfo[], what: "tab" | "terminal" = "tab"): string {
    const lines = busy.slice(0, MaxListed).map((b) => `• ${b.command}${b.conn ? ` on ${b.conn}` : ""}`);
    if (busy.length > MaxListed) {
        lines.push(`• and ${busy.length - MaxListed} more`);
    }
    lines.push("");
    lines.push(
        busy.some((b) => b.tmux)
            ? `Closing the ${what} stops these, including their tmux sessions on the remote host.`
            : `Closing the ${what} stops these.`
    );
    return lines.join("\n");
}
