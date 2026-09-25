// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Friendly editor for the common settings.json keys. Every change is written immediately with SetConfigCommand;
// anything not listed here is still editable in the "Advanced Options (JSON)" tab.

import { Tooltip } from "@/app/element/tooltip";
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
    tooltip: string;
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
                tooltip:
                    "Colors the whole app (tab bar, blocks, menus) from a terminal color scheme. Terminals use it too unless Terminal theme is set. Wave Default keeps the standard look.",
                label: "App theme",
                description: "Colors the whole app in every window. Terminals use it unless they have their own theme.",
                kind: "select",
                options: (fc) => themeOptions(fc, "Wave Default"),
            },
            {
                key: "term:theme",
                tooltip:
                    "Gives terminals their own color scheme, separate from the app theme. Follow app theme uses the app theme.",
                label: "Terminal theme",
                description: "Overrides the app theme for terminals only.",
                kind: "select",
                options: (fc) => themeOptions(fc, "Follow app theme"),
            },
            {
                key: "app:tabbar",
                tooltip: "Shows the tabs across the top of the window or down its left side.",
                label: "Tab bar position",
                kind: "select",
                defaultValue: "top",
                options: [
                    { value: "top", label: "Top" },
                    { value: "left", label: "Left" },
                ],
            },
            {
                key: "window:transparent",
                tooltip:
                    "Makes the window background see-through, as solid as Window opacity says. It may only apply to windows opened after the change.",
                label: "Transparent window",
                kind: "toggle",
            },
            {
                key: "window:opacity",
                tooltip:
                    "How solid the window is while Transparent window is on, from 0 (fully see-through) to 1 (solid).",
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
                tooltip:
                    "Shows the File / Edit / View menu bar in each window. Windows and Linux only; macOS always shows its menu bar.",
                label: "Show menu bar",
                description: "Windows and Linux only.",
                kind: "toggle",
            },
        ],
    },
    {
        title: "Terminal",
        fields: [
            {
                key: "term:fontsize",
                tooltip: "Text size in terminals, from 6 to 64.",
                label: "Font size",
                kind: "number",
                min: 6,
                max: 64,
                step: 1,
                placeholder: "12",
            },
            {
                key: "term:fontfamily",
                tooltip:
                    "Font used in terminals. It has to be installed on this computer, and a monospaced font works best.",
                label: "Font family",
                kind: "text",
                placeholder: "Hack",
            },
            {
                key: "term:cursor",
                tooltip: "Shape of the terminal cursor: a solid block, a thin bar or an underline.",
                label: "Cursor style",
                kind: "select",
                defaultValue: "block",
                options: [
                    { value: "block", label: "Block" },
                    { value: "bar", label: "Bar" },
                    { value: "underline", label: "Underline" },
                ],
            },
            {
                key: "term:cursorblink",
                tooltip: "Makes the terminal cursor blink.",
                label: "Blinking cursor",
                kind: "toggle",
            },
            {
                key: "term:copyonselect",
                tooltip:
                    "Copies text to the clipboard as soon as you select it in a terminal, without pressing Ctrl+C.",
                label: "Copy on select",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "term:scrollback",
                tooltip:
                    "How many lines of output each terminal keeps for scrolling back, up to 50,000. More lines use more memory.",
                label: "Scrollback lines",
                kind: "number",
                min: 0,
                max: 50000,
                step: 500,
                placeholder: "1000",
            },
            {
                key: "term:bellsound",
                tooltip: "Plays a sound when a program rings the terminal bell.",
                label: "Bell sound",
                kind: "toggle",
            },
            {
                key: "term:bellindicator",
                tooltip:
                    "Marks a tab when one of its terminals rings the bell, so you notice activity in tabs you aren't looking at.",
                label: "Bell indicator on tab",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "term:disablewebgl",
                tooltip:
                    "Draws terminals without graphics-card acceleration. Turn this on only if terminals flicker, show glitches or stay blank.",
                label: "Disable WebGL rendering",
                kind: "toggle",
            },
        ],
    },
    {
        title: "Editor",
        fields: [
            {
                key: "editor:fontsize",
                tooltip:
                    "Text size in Wave's built-in editor, used when you open or edit files inside Wave. From 6 to 64.",
                label: "Font size",
                kind: "number",
                min: 6,
                max: 64,
                step: 1,
                placeholder: "12",
            },
            {
                key: "editor:minimapenabled",
                tooltip: "Shows a zoomed-out overview of the whole file along the editor's right edge.",
                label: "Minimap",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "editor:wordwrap",
                tooltip: "Wraps long lines to the editor's width instead of scrolling sideways.",
                label: "Word wrap",
                kind: "toggle",
            },
        ],
    },
    {
        title: "Wave AI",
        fields: [
            {
                key: "waveai:disabled",
                tooltip:
                    "When off, the Wave AI panel and its buttons are hidden and Wave refuses AI chat requests, so nothing is sent to an AI provider.",
                label: "Wave AI",
                description: "Turns Wave AI off entirely.",
                kind: "toggle",
                invert: true,
            },
            {
                key: "app:hideaibutton",
                tooltip: "Hides only the AI button. Wave AI itself stays turned on.",
                label: "Hide AI button",
                kind: "toggle",
            },
        ],
    },
    {
        title: "Behavior",
        fields: [
            {
                key: "app:confirmquit",
                tooltip: "Asks for confirmation before Wave quits.",
                label: "Confirm before quitting",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "window:confirmclose",
                tooltip: "Asks for confirmation before a window closes, so its tabs aren't lost by accident.",
                label: "Confirm before closing a window",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "app:focusfollowscursor",
                tooltip:
                    "Moves keyboard focus to the block under the mouse pointer without clicking: in every block, or only in terminals.",
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
            {
                key: "conn:autoconnect",
                tooltip:
                    "When Wave starts, connects the SSH connections used in your tabs and starts their terminals, re-attaching tmux sessions. Retries if the network isn't up yet.",
                label: "Reconnect automatically",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "conn:syncsshconfig",
                tooltip:
                    "Adds the hosts in ~/.ssh/config to connections.json so they show up in the connection picker. Your SSH config itself isn't changed.",
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
                tooltip:
                    "Where updates come from. Atreus fork installs this fork's releases. Official Wave installs upstream releases, which replace this fork's changes.",
                label: "Updates from",
                description: "Official Wave builds don't include this fork's changes; installing one replaces them.",
                kind: "select",
                defaultValue: "atreus",
                options: [
                    { value: "atreus", label: "Atreus fork" },
                    { value: "official", label: "Official Wave" },
                ],
            },
            {
                key: "autoupdate:enabled",
                tooltip: "Checks for a new version when Wave starts and then every hour.",
                label: "Check for updates",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "autoupdate:installonquit",
                tooltip:
                    "Installs a downloaded update when you quit Wave. When off, you install it yourself from the update prompt.",
                label: "Install updates on quit",
                kind: "toggle",
                defaultValue: true,
            },
        ],
    },
];

// Derived from the field definition (not written into each tooltip) so the shown default can't drift from it.
function defaultText(field: SettingField, fullConfig: FullConfigType): string {
    switch (field.kind) {
        case "toggle": {
            const on = !!field.defaultValue;
            return (field.invert ? !on : on) ? "On" : "Off";
        }
        case "select": {
            const options = typeof field.options === "function" ? field.options(fullConfig) : field.options;
            const value = field.defaultValue == null ? UnsetValue : String(field.defaultValue);
            return options.find((opt) => opt.value === value)?.label ?? value;
        }
        case "number":
        case "text":
            return field.placeholder ?? "none";
    }
}

const SettingTooltip = memo(({ field, fullConfig }: { field: SettingField; fullConfig: FullConfigType }) => (
    <div className="flex max-w-xs flex-col gap-1 py-0.5">
        <div>{field.tooltip}</div>
        <div className="text-muted">Default: {defaultText(field, fullConfig)}</div>
        <div className="font-mono text-muted">settings.json: {field.key}</div>
    </div>
));
SettingTooltip.displayName = "SettingTooltip";

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
                    <div className="flex items-center gap-1.5 text-sm">
                        {field.label}
                        <Tooltip
                            content={<SettingTooltip field={field} fullConfig={fullConfig} />}
                            placement="right"
                            divClassName="flex items-center text-muted hover:text-secondary"
                        >
                            <i className="fa-solid fa-circle-info text-xs" aria-label={`About ${field.label}`} />
                        </Tooltip>
                    </div>
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
