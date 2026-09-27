// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { SleepReconnectModel } from "@/app/store/sleepreconnect";
import { atoms } from "@/store/global";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect } from "react";

const MaxNamesShown = 3;

export function getSleepReconnectMessage(reason: string, connNames: string[]): string {
    const when = reason == "lock" ? "while the screen was locked" : "while the computer was asleep";
    let names = connNames.slice(0, MaxNamesShown).join(", ");
    if (connNames.length > MaxNamesShown) {
        names += ` and ${connNames.length - MaxNamesShown} more`;
    }
    return `Disconnected ${when}: ${names}`;
}

export const SleepReconnectBanner = memo(() => {
    const model = SleepReconnectModel.getInstance();
    const pending = useAtomValue(model.pendingAtom);
    const reconnecting = useAtomValue(model.reconnectingAtom);
    const allConnStatus = useAtomValue(atoms.allConnStatus);

    // a host reconnected from its own block's overlay drops out of the list
    const remaining = (pending?.conns ?? []).filter((connName) => {
        const status = allConnStatus.find((cs) => cs.connection == connName);
        return status?.status != "connected";
    });
    const allBack = pending != null && remaining.length == 0;

    useEffect(() => {
        if (allBack) {
            model.dismiss();
        }
    }, [allBack, model]);

    if (pending == null || remaining.length == 0) {
        return null;
    }

    return (
        <div className="flex items-center gap-3 px-3 py-1.5 shrink-0 text-xs bg-warning/15 border-b border-warning/40">
            <i className="fa-solid fa-moon text-warning shrink-0" />
            <div className="flex-1 min-w-0 truncate" title={remaining.join("\n")}>
                {getSleepReconnectMessage(pending.reason, remaining)}
            </div>
            <button
                className="px-2 py-0.5 bg-accent/80 text-primary rounded hover:bg-accent transition-colors cursor-pointer disabled:opacity-60"
                disabled={reconnecting}
                onClick={() => fireAndForget(() => model.reconnectAll(remaining))}
            >
                {reconnecting ? "Reconnecting…" : remaining.length == 1 ? "Reconnect" : "Reconnect all"}
            </button>
            <button
                className="px-1 text-secondary hover:text-primary transition-colors cursor-pointer"
                title="Dismiss (each terminal still has its own Reconnect button)"
                onClick={() => model.dismiss()}
            >
                <i className="fa-solid fa-xmark" />
            </button>
        </div>
    );
});
SleepReconnectBanner.displayName = "SleepReconnectBanner";
