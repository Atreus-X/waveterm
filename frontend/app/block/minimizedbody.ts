// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import * as React from "react";

// Covers the terminal's resize debounce (50ms) plus a frame or two, so the view only reappears after the
// layout has finished growing.
const SettleMarginMs = 150;

/**
 * How long a restored block keeps its view hidden. The block grows back from its bar or strip with an
 * animation, and a terminal that is visible while it is still tiny gets fitted to a few columns and one
 * row, which is sent to the pty: whatever runs inside (tmux, an editor) is resized to nothing and back and
 * can come back garbled or blank. Showing the view only once the size has settled means it sees one resize.
 */
export function restoreSettleMs(animationTimeS: number, magnified: boolean): number {
    if (magnified) {
        return 0;
    }
    return Math.round(Math.max(0, animationTimeS ?? 0) * 1000) + SettleMarginMs;
}

/**
 * True while the view of a block should stay hidden: as soon as it is minimized, and for settleMs after it
 * is restored.
 */
export function useMinimizedBodyHidden(isMinimized: boolean, settleMs: number): boolean {
    const [hidden, setHidden] = React.useState(isMinimized);
    React.useEffect(() => {
        if (isMinimized) {
            setHidden(true);
            return;
        }
        const timer = setTimeout(() => setHidden(false), settleMs);
        return () => clearTimeout(timer);
    }, [isMinimized, settleMs]);
    return isMinimized || hidden;
}
