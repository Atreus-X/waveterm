// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { toggleTask } from "@/app/view/library/note-format";

export type TaskTogglePlan =
    { kind: "stale"; onDisk: string } | { kind: "unchanged" } | { kind: "write"; next: string };

// A checkbox click is mapped to the Nth task item of the text that was on screen. If the file has
// changed on disk since it was loaded, that index may point at a different line, so the click is
// dropped and the newer text shown instead of overwriting someone else's edit.
export function planTaskToggle(shown: string, onDisk: string, taskIndex: number): TaskTogglePlan {
    if (onDisk !== shown) return { kind: "stale", onDisk };
    const next = toggleTask(shown, taskIndex);
    if (next === shown) return { kind: "unchanged" };
    return { kind: "write", next };
}
