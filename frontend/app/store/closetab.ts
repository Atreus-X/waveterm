// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { deleteLayoutModelForTab } from "@/layout/index";
import { getApi, getSettingsKeyAtom } from "@/store/global";
import { formatBusyDetail } from "./closetab-util";

// returns null when nothing is running, the check is turned off, or the check fails (never blocks a close)
async function getTabBusyDetail(tabId: string): Promise<string> {
    const enabled = globalStore.get(getSettingsKeyAtom("tab:confirmcloserunning")) ?? true;
    if (!enabled) {
        return null;
    }
    try {
        const busy = await RpcApi.TabBusyCommand(TabRpcClient, tabId, { timeout: 5000 });
        if (busy == null || busy.length === 0) {
            return null;
        }
        return formatBusyDetail(busy);
    } catch (e) {
        console.log("error checking tab for running commands", tabId, e);
        return null;
    }
}

// Closes a tab, asking first when its terminals are running something (tab:confirmcloserunning)
// or on every close (tab:confirmclose). Resolves true when the tab was closed.
export async function closeTabWithConfirm(workspaceId: string, tabId: string): Promise<boolean> {
    const confirmClose = globalStore.get(getSettingsKeyAtom("tab:confirmclose")) ?? false;
    const busyDetail = await getTabBusyDetail(tabId);
    const didClose = await getApi().closeTab(workspaceId, tabId, confirmClose, busyDetail);
    if (didClose) {
        deleteLayoutModelForTab(tabId);
    }
    return didClose;
}
