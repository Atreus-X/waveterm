// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { memo } from "react";

const W = 72;
const H = 18;

// values are plotted against `max` (100 for percentages); the stroke takes the text color of `className`
export const Sparkline = memo(({ values, max, className }: { values: number[]; max?: number; className?: string }) => {
    if (values == null || values.length < 2) {
        return <svg width={W} height={H} className={cn("shrink-0", className)} />;
    }
    const top = max ?? Math.max(1, ...values);
    const step = W / (values.length - 1);
    const pts = values.map((v, i) => {
        const y = H - 1 - (Math.max(0, Math.min(top, v)) / top) * (H - 2);
        return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
    });
    const line = pts.join(" ");
    const area = `0,${H} ${line} ${W},${H}`;
    const last = pts[pts.length - 1].split(",");
    return (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className={cn("shrink-0 overflow-visible", className)}>
            <polygon points={area} fill="currentColor" opacity={0.15} />
            <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" />
            <circle cx={last[0]} cy={last[1]} r={1.75} fill="currentColor" />
        </svg>
    );
});
Sparkline.displayName = "Sparkline";
