// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Friendly editor for the common settings.json keys. Every change is written immediately with SetConfigCommand;
// anything not listed here is still editable in the "Advanced Options (JSON)" tab.

import { getApi } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useState } from "react";

type SelectOption = { value: string; label: string };

type SettingField = {
    key: keyof SettingsType;
    label: string;
    description?: string;
    defaultValue?: any;
} & (
    | { kind: "toggle"; invert?: boolean }
    | { kind: "select"; options: SelectOption[] | ((fullConfig: FullConfigType) => SelectOption[]) }
    | { kind: "number"; min?: number; max?: number; step?: number; placeholder?: string }
    | { kind: "text"; placeholder?: string }
);

type SettingSection = { title: string; fields: SettingField[] };

// select value used for "key not set" (the empty string can't round-trip through the settings file)
const UnsetValue = "";

function themeOptions(fullConfig: FullConfigType, unsetLabel: string): SelectOption[] {
    const termThemes = fullConfig?.termthemes ?? {};
    const names = Object.keys(termThemes).sort(
        (a, b) => (termThemes[a]["display:order"] ?? 0) - (termThemes[b]["display:order"] ?? 0)
    );
    return [
        { value: UnsetValue, label: unsetLabel },
        ...names.map((name) => ({ value: name, label: termThemes[name]["display:name"] ?? name })),
    ];
}

const SettingSections: SettingSection[] = [
    {
        title: "Appearance",
        fields: [
            {
                key: "app:theme",
                label: "App theme",
                description: "Colors the whole app in every window. Terminals use it unless they have their own theme.",
                kind: "select",
                options: (fc) => themeOptions(fc, "Wave Default"),
            },
            {
                key: "term:theme",
                label: "Terminal theme",
                description: "Overrides the app theme for terminals only.",
                kind: "select",
                options: (fc) => themeOptions(fc, "Follow app theme"),
            },
            {
                key: "app:tabbar",
                label: "Tab bar position",
                kind: "select",
                defaultValue: "top",
                options: [
                    { value: "top", label: "Top" },
                    { value: "left", label: "Left" },
                ],
            },
            { key: "window:transparent", label: "Transparent window", kind: "toggle" },
            {
                key: "window:opacity",
                label: "Window opacity",
                description: "0 to 1, used when the window is transparent.",
                kind: "number",
                min: 0,
                max: 1,
                step: 0.05,
                placeholder: "0.8",
            },
            {
                key: "window:showmenubar",
                label: "Show menu bar",
                description: "Windows and Linux only.",
                kind: "toggle",
            },
        ],
    },
    {
        title: "Terminal",
        fields: [
            { key: "term:fontsize", label: "Font size", kind: "number", min: 6, max: 64, step: 1, placeholder: "12" },
            { key: "term:fontfamily", label: "Font family", kind: "text", placeholder: "Hack" },
            {
                key: "term:cursor",
                label: "Cursor style",
                kind: "select",
                defaultValue: "block",
                options: [
                    { value: "block", label: "Block" },
                    { value: "bar", label: "Bar" },
                    { value: "underline", label: "Underline" },
                ],
            },
            { key: "term:cursorblink", label: "Blinking cursor", kind: "toggle" },
            { key: "term:copyonselect", label: "Copy on select", kind: "toggle", defaultValue: true },
            {
                key: "term:scrollback",
                label: "Scrollback lines",
                kind: "number",
                min: 0,
                max: 50000,
                step: 500,
                placeholder: "1000",
            },
            { key: "term:bellsound", label: "Bell sound", kind: "toggle" },
            { key: "term:bellindicator", label: "Bell indicator on tab", kind: "toggle", defaultValue: true },
            { key: "term:disablewebgl", label: "Disable WebGL rendering", kind: "toggle" },
        ],
    },
    {
        title: "Editor",
        fields: [
            { key: "editor:fontsize", label: "Font size", kind: "number", min: 6, max: 64, step: 1, placeholder: "12" },
            { key: "editor:minimapenabled", label: "Minimap", kind: "toggle", defaultValue: true },
            { key: "editor:wordwrap", label: "Word wrap", kind: "toggle" },
        ],
    },
    {
        title: "Wave AI",
        fields: [
            {
                key: "waveai:disabled",
                label: "Wave AI",
                description: "Turns Wave AI off entirely.",
                kind: "toggle",
                invert: true,
            },
            { key: "app:hideaibutton", label: "Hide AI button", kind: "toggle" },
        ],
    },
    {
        title: "Behavior",
        fields: [
            { key: "app:confirmquit", label: "Confirm before quitting", kind: "toggle", defaultValue: true },
            {
                key: "window:confirmclose",
                label: "Confirm before closing a window",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "app:focusfollowscursor",
                label: "Focus follows mouse",
                kind: "select",
                defaultValue: "off",
                options: [
                    { value: "off", label: "Off" },
                    { value: "on", label: "All blocks" },
                    { value: "term", label: "Terminals only" },
                ],
            },
        ],
    },
    {
        title: "Connections",
        fields: [
            { key: "conn:autoconnect", label: "Reconnect automatically", kind: "toggle", defaultValue: true },
            {
                key: "conn:syncsshconfig",
                label: "Sync hosts from ~/.ssh/config",
                kind: "toggle",
                defaultValue: true,
            },
        ],
    },
    {
        title: "Updates",
        fields: [
            {
                key: "autoupdate:source",
                label: "Updates from",
                description: "Official Wave builds don't include this fork's changes; installing one replaces them.",
                kind: "select",
                defaultValue: "atreus",
                options: [
                    { value: "atreus", label: "Atreus fork" },
                    { value: "official", label: "Official Wave" },
                ],
            },
            { key: "autoupdate:enabled", label: "Check for updates", kind: "toggle", defaultValue: true },
            { key: "autoupdate:installonquit", label: "Install updates on quit", kind: "toggle", defaultValue: true },
        ],
    },
];

const Toggle = memo(({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
            checked ? "bg-accent" : "bg-hoverbg"
        )}
    >
        <span
            className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-primary transition-transform",
                checked ? "translate-x-4.5" : "translate-x-0.5"
            )}
        />
    </button>
));
Toggle.displayName = "Toggle";

// commits on blur / Enter so typing doesn't write the settings file on every keystroke
const DraftInput = memo(
    ({
        value,
        type,
        onCommit,
        ...rest
    }: {
        value: string;
        type: "text" | "number";
        onCommit: (v: string) => void;
        min?: number;
        max?: number;
        step?: number;
        placeholder?: string;
    }) => {
        const [draft, setDraft] = useState(value);
        useEffect(() => setDraft(value), [value]);
        const commit = () => {
            if (draft !== value) {
                onCommit(draft);
            }
        };
        return (
            <input
                type={type}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") setDraft(value);
                }}
                className="w-40 rounded border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-accent"
                {...rest}
            />
        );
    }
);
DraftInput.displayName = "DraftInput";

const SettingRow = memo(
    ({
        field,
        fullConfig,
        onSet,
    }: {
        field: SettingField;
        fullConfig: FullConfigType;
        onSet: (key: keyof SettingsType, value: any) => void;
    }) => {
        const rawValue = fullConfig?.settings?.[field.key] ?? field.defaultValue;
        let control: React.ReactNode;
        switch (field.kind) {
            case "toggle": {
                const on = !!rawValue;
                control = (
                    <Toggle
                        checked={field.invert ? !on : on}
                        onChange={(v) => onSet(field.key, field.invert ? !v : v)}
                    />
                );
                break;
            }
            case "select": {
                const options = typeof field.options === "function" ? field.options(fullConfig) : field.options;
                const value = rawValue == null ? UnsetValue : String(rawValue);
                control = (
                    <select
                        value={value}
                        onChange={(e) => onSet(field.key, e.target.value === UnsetValue ? null : e.target.value)}
                        className="w-48 cursor-pointer rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-accent"
                    >
                        {options.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label}
                            </option>
                        ))}
                    </select>
                );
                break;
            }
            case "number":
                control = (
                    <DraftInput
                        type="number"
                        value={rawValue == null ? "" : String(rawValue)}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        placeholder={field.placeholder}
                        onCommit={(v) => {
                            const num = parseFloat(v);
                            onSet(field.key, v.trim() === "" || isNaN(num) ? null : num);
                        }}
                    />
                );
                break;
            case "text":
                control = (
                    <DraftInput
                        type="text"
                        value={rawValue == null ? "" : String(rawValue)}
                        placeholder={field.placeholder}
                        onCommit={(v) => onSet(field.key, v.trim() === "" ? null : v)}
                    />
                );
                break;
        }
        return (
            <div className="flex items-center justify-between gap-4 border-b border-border/50 py-2.5 last:border-b-0">
                <div className="min-w-0">
                    <div className="text-sm">{field.label}</div>
                    {field.description && <div className="text-xs text-muted">{field.description}</div>}
                </div>
                {control}
            </div>
        );
    }
);
SettingRow.displayName = "SettingRow";

export const SettingsVisualContent = memo(({ model }: { model: WaveConfigViewModel }) => {
    const fullConfig = useAtomValue(model.env.atoms.fullConfigAtom);
    const [saveError, setSaveError] = useState<string>(null);

    const onSet = (key: keyof SettingsType, value: any) => {
        setSaveError(null);
        model.env.rpc
            .SetConfigCommand(TabRpcClient, { [key]: value })
            .then(() => {
                if (key === "autoupdate:source") {
                    getApi().setUpdateSource(value ?? "atreus");
                }
            })
            .catch((e) => setSaveError(`Failed to save ${key}: ${e?.message ?? String(e)}`));
    };

    return (
        <div className="h-full overflow-y-auto">
            <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
                {saveError && <div className="rounded bg-error px-3 py-2 text-sm text-primary">{saveError}</div>}
                {SettingSections.map((section) => (
                    <div key={section.title}>
                        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                            {section.title}
                        </div>
                        <div className="rounded border border-border px-4">
                            {section.fields.map((field) => (
                                <SettingRow key={field.key} field={field} fullConfig={fullConfig} onSet={onSet} />
                            ))}
                        </div>
                    </div>
                ))}
                <div className="text-xs text-muted">
                    Everything else is in the <span className="text-secondary">Advanced Options (JSON)</span> tab, which
                    edits settings.json directly.
                </div>
            </div>
        </div>
    );
});

SettingsVisualContent.displayName = "SettingsVisualContent";
