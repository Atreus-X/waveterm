// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as jotai from "jotai";

export class SleepReconnectModel {
    private static instance: SleepReconnectModel | null = null;

    pendingAtom = jotai.atom(null) as jotai.PrimitiveAtom<ConnSleepDisconnectData>;
    reconnectingAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;

    private constructor() {}

    static getInstance(): SleepReconnectModel {
        if (!SleepReconnectModel.instance) {
            SleepReconnectModel.instance = new SleepReconnectModel();
        }
        return SleepReconnectModel.instance;
    }

    handleEvent(data: ConnSleepDisconnectData) {
        if (data?.conns == null || data.conns.length == 0) {
            return;
        }
        const prev = globalStore.get(this.pendingAtom);
        if (prev == null) {
            globalStore.set(this.pendingAtom, data);
            return;
        }
        const conns = Array.from(new Set([...prev.conns, ...data.conns])).sort();
        const reason = prev.reason == "sleep" || data.reason == "sleep" ? "sleep" : data.reason;
        globalStore.set(this.pendingAtom, { reason, conns });
    }

    dismiss() {
        globalStore.set(this.pendingAtom, null);
    }

    async reconnectAll(connNames: string[]) {
        globalStore.set(this.reconnectingAtom, true);
        try {
            await Promise.allSettled(
                connNames.map((host) =>
                    RpcApi.ConnConnectCommand(TabRpcClient, { host }, { timeout: 60000 }).catch((e) => {
                        console.log("error reconnecting", host, e);
                        throw e;
                    })
                )
            );
        } finally {
            globalStore.set(this.reconnectingAtom, false);
        }
    }
}
