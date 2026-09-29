// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { getApi } from "@/store/global";
import * as jotai from "jotai";
import { openProgressKey } from "./openexternal-progress-util";

const ErrorShowMs = 5000;

// Progress of remote files being downloaded to open in an external app (sent by emain-openexternal).
export class OpenExternalProgressModel {
    private static instance: OpenExternalProgressModel | null = null;

    progressAtom = jotai.atom({}) as jotai.PrimitiveAtom<Record<string, OpenFileExternalProgress>>;
    clearTimers = new Map<string, ReturnType<typeof setTimeout>>();

    private constructor() {
        try {
            getApi().onOpenFileExternalProgress((p) => this.update(p));
        } catch (e) {
            console.log("open-external progress not available", e);
        }
    }

    static getInstance(): OpenExternalProgressModel {
        if (!OpenExternalProgressModel.instance) {
            OpenExternalProgressModel.instance = new OpenExternalProgressModel();
        }
        return OpenExternalProgressModel.instance;
    }

    update(p: OpenFileExternalProgress) {
        const key = openProgressKey(p.connection, p.path);
        const timer = this.clearTimers.get(key);
        if (timer != null) {
            clearTimeout(timer);
            this.clearTimers.delete(key);
        }
        if (p.phase === "done") {
            this.remove(key);
            return;
        }
        globalStore.set(this.progressAtom, { ...globalStore.get(this.progressAtom), [key]: p });
        if (p.phase === "error") {
            this.clearTimers.set(
                key,
                setTimeout(() => this.remove(key), ErrorShowMs)
            );
        }
    }

    remove(key: string) {
        this.clearTimers.delete(key);
        const next = { ...globalStore.get(this.progressAtom) };
        delete next[key];
        globalStore.set(this.progressAtom, next);
    }
}
