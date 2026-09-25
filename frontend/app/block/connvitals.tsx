// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { useHostVitals } from "@/app/store/hostvitals";
import { LibraryModel } from "@/app/store/library-model";
import { fmtBytes, fmtRate, usageLevel } from "@/app/view/hostinfo/hostinfo-util";
import { openLibraryNote } from "@/app/view/library/library";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect } from "react";
import { BlockEnv } from "./blockenv";

const LevelClass = { ok: "bg-success", warn: "bg-warning", crit: "bg-error" };

const MiniBar = memo(({ percent }: { percent: number }) => (
    <div className="relative h-3 w-[3px] overflow-hidden rounded-sm bg-hoverbg">
        <div
            className={cn("absolute bottom-0 w-full", LevelClass[usageLevel(percent)])}
            style={{ height: `${Math.max(8, Math.min(100, percent))}%` }}
        />
    </div>
));
MiniBar.displayName = "MiniBar";

// CPU and memory meters shown inside a block's connection chip
export const ConnVitalsMeter = memo(({ connection }: { connection: string }) => {
    const waveEnv = useWaveEnv<BlockEnv>();
    const series = useHostVitals(connection, true, waveEnv);
    const v = series?.latest;
    if (v == null) return null;
    const memUsed = v.memtotal - v.memavail;
    const memPct = v.memtotal ? (memUsed / v.memtotal) * 100 : 0;
    const lines = [
        `CPU ${v.cpupct.toFixed(0)}% · load ${v.load1.toFixed(2)} on ${v.cpucount} cores`,
        `Memory ${memPct.toFixed(0)}% (${fmtBytes(memUsed)} of ${fmtBytes(v.memtotal)})`,
        v.diskmaxmount ? `Fullest disk ${v.diskmaxpct.toFixed(0)}% (${v.diskmaxmount})` : null,
        `Network in ${fmtRate(v.rxrate)} · out ${fmtRate(v.txrate)}`,
        series.error ? `Last update failed: ${series.error}` : null,
    ].filter(Boolean);
    return (
        <div
            className={cn(
                "flex shrink-0 items-end gap-[2px] pr-1.5",
                series.error ? "opacity-40" : "opacity-80 group-hover:opacity-100"
            )}
            title={lines.join("\n")}
        >
            <MiniBar percent={v.cpupct} />
            <MiniBar percent={memPct} />
        </div>
    );
});
ConnVitalsMeter.displayName = "ConnVitalsMeter";

// shown in the connection chip when the host has a note in the Library
export const ConnNoteBadge = memo(({ connection }: { connection: string }) => {
    const waveEnv = useWaveEnv<BlockEnv>();
    const lib = LibraryModel.getInstance();
    const hostsWithNotes = useAtomValue(lib.hostsWithNotesAtom);
    useEffect(() => {
        lib.load();
    }, []);
    if (!hostsWithNotes.has(connection)) return null;
    return (
        <i
            className="fa-solid fa-note-sticky shrink-0 pr-1.5 text-[11px] text-muted hover:text-primary"
            title="Open the note for this host"
            onClick={(e) => {
                e.stopPropagation();
                openLibraryNote(waveEnv.createBlock, { host: connection });
            }}
        />
    );
});
ConnNoteBadge.displayName = "ConnNoteBadge";
