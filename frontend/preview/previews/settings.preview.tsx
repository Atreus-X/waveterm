// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { applyAppTheme } from "@/app/store/apptheme";
import { globalStore } from "@/app/store/jotaiStore";
import { SettingsVisualContent } from "@/app/view/waveconfig/settingsvisual";
import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { atom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { DefaultFullConfig } from "../mock/defaultconfig";

const fullConfigAtom = atom<FullConfigType>(DefaultFullConfig);

const mockModel = {
    env: {
        atoms: { fullConfigAtom },
        rpc: {
            SetConfigCommand: async (_client: unknown, settings: SettingsType) => {
                const cur = globalStore.get(fullConfigAtom);
                const next = { ...cur.settings, ...settings };
                for (const [k, v] of Object.entries(settings)) {
                    if (v == null) delete next[k];
                }
                globalStore.set(fullConfigAtom, { ...cur, settings: next });
            },
        },
    },
} as unknown as WaveConfigViewModel;

export function SettingsPreview() {
    const fullConfig = useAtomValue(fullConfigAtom);
    const themeName = fullConfig.settings?.["app:theme"];
    useEffect(() => {
        applyAppTheme(themeName ? fullConfig.termthemes?.[themeName] : null);
    }, [themeName, fullConfig]);
    return (
        <div className="h-[700px] w-[640px] bg-background text-foreground">
            <SettingsVisualContent model={mockModel} />
        </div>
    );
}
