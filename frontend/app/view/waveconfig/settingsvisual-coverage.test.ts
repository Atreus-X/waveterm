// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readRepoFile = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const SettingsKeys: string[] = Object.keys(
    JSON.parse(readRepoFile("../../../../schema/settings.json")).$defs.SettingsType.properties
)
    .filter((k) => !k.endsWith("*"))
    .sort();
const EditorKeys = new Set(
    Array.from(readRepoFile("./settingsvisual.tsx").matchAll(/key: "([a-z0-9:]+)"/g), (m) => m[1])
);
const Exclusions: { internal: Record<string, string>; pending: string[] } = JSON.parse(
    readRepoFile("./settings-not-in-editor.json")
);
const Listed = new Set([...Object.keys(Exclusions.internal), ...Exclusions.pending]);

describe("graphical settings editor coverage", () => {
    it("has a field for every setting, unless it is explicitly excluded", () => {
        const missing = SettingsKeys.filter((k) => !EditorKeys.has(k) && !Listed.has(k));
        expect(
            missing,
            "Add these to the settings editor (frontend/app/view/waveconfig/settingsvisual.tsx), in a new section if none fits. " +
                "Only a setting that is not a user preference goes in settings-not-in-editor.json, under internal, with a reason."
        ).toEqual([]);
    });

    it("only has editor fields for settings that exist", () => {
        expect([...EditorKeys].filter((k) => !SettingsKeys.includes(k))).toEqual([]);
    });

    it("drops a setting from the exclusion list once the editor has a field for it", () => {
        expect([...Listed].filter((k) => EditorKeys.has(k)).sort()).toEqual([]);
    });

    it("lists no setting that no longer exists", () => {
        expect([...Listed].filter((k) => !SettingsKeys.includes(k)).sort()).toEqual([]);
    });

    it("gives every internal setting a reason", () => {
        expect(Object.entries(Exclusions.internal).filter(([, reason]) => !reason?.trim())).toEqual([]);
    });
});
