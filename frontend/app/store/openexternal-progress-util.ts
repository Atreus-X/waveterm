// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

export function openProgressKey(connection: string, path: string): string {
    return `${connection ?? ""}|${path}`;
}

function fmtMB(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** 0..1, or null when the size is unknown (show an indeterminate bar). */
export function openProgressFraction(p: OpenFileExternalProgress): number | null {
    if (p.phase === "opening") return 1;
    if (p.phase !== "download" || !p.total) return null;
    return Math.max(0, Math.min(1, p.received / p.total));
}

export function openProgressLabel(p: OpenFileExternalProgress): string {
    switch (p.phase) {
        case "download": {
            const frac = openProgressFraction(p);
            if (frac == null) return `Downloading ${fmtMB(p.received)}`;
            return `Downloading ${Math.floor(frac * 100)}% of ${fmtMB(p.total)}`;
        }
        case "opening":
            return "Opening…";
        case "error":
            return `Couldn't open${p.error ? `: ${p.error}` : ""}`;
        default:
            return "";
    }
}
