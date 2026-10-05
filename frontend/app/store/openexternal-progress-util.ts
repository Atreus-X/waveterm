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

const RateMinSampleMs = 250;
const RateSmoothing = 0.3;

export type RateState = { done: number; ts: number; bps: number };

/** Smoothed bytes/sec from cumulative byte counts; a count that goes backwards (next file) restarts the estimate. */
export function updateRate(prev: RateState | undefined, done: number, now: number): RateState {
    if (prev == null || done < prev.done) {
        return { done, ts: now, bps: 0 };
    }
    const dt = now - prev.ts;
    if (dt < RateMinSampleMs) {
        return prev;
    }
    const inst = ((done - prev.done) * 1000) / dt;
    const bps = prev.bps > 0 ? RateSmoothing * inst + (1 - RateSmoothing) * prev.bps : inst;
    return { done, ts: now, bps };
}

export function formatSpeed(bps: number): string {
    if (!(bps > 0)) return "";
    if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
    return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}

export function formatEta(seconds: number): string {
    const s = Math.max(1, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "1.2 MB/s · 23s left"; each part is dropped when it can't be known yet. */
export function transferDetail(done: number, total: number, bps: number): string {
    const parts: string[] = [];
    const speed = formatSpeed(bps);
    if (speed) parts.push(speed);
    if (speed && total > done) parts.push(`${formatEta((total - done) / bps)} left`);
    return parts.join(" · ");
}

export function transferLabel(done: number, total: number): string {
    if (total > 0) return `${Math.floor(Math.min(1, done / total) * 100)}% of ${fmtMB(total)}`;
    return fmtMB(done);
}
