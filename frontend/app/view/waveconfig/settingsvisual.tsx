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
import { memo, useEffect, useMemo, useState } from "react";
import { filterSections } from "./settingsvisual-search";

type SelectOption = { value: string; label: string };

type SettingField = {
    key: keyof SettingsType;
    label: string;
    description?: string;
    tooltip: string;
    defaultValue?: any;
    // unset means the change applies immediately
    applies?: "restart" | "terminal";
} & (
    | { kind: "toggle"; invert?: boolean }
    | {
          kind: "select";
          options: SelectOption[] | ((fullConfig: FullConfigType) => SelectOption[]);
          // for a bool setting with an unset state: saves true / false instead of the strings
          boolean?: boolean;
      }
    | { kind: "number"; min?: number; max?: number; step?: number; integer?: boolean; placeholder?: string }
    | { kind: "text"; placeholder?: string }
);

type SettingSection = { title: string; fields: SettingField[] };

const AppliesText: Record<NonNullable<SettingField["applies"]>, { badge: string; detail: string }> = {
    restart: { badge: "Restart required", detail: "Takes effect after you restart Wave." },
    terminal: { badge: "Reopen terminals", detail: "Only terminals opened after the change use it." },
};

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
                key: "app:scrollbarsize",
                tooltip:
                    "How thick scrollbars are in pixels: the width of vertical ones and the height of horizontal ones, terminals included. Larger is easier to grab.",
                label: "Scrollbar size",
                description: "Pixels, 2 to 24.",
                kind: "number",
                min: 2,
                max: 24,
                step: 1,
                placeholder: "4",
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
                applies: "restart",
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
                applies: "restart",
                kind: "toggle",
            },
            {
                key: "window:showversion",
                tooltip: "Shows the app version in the tab bar, to the left of the usage meter.",
                label: "Show version in tab bar",
                kind: "select",
                defaultValue: "always",
                options: [
                    { value: "always", label: "Always" },
                    { value: "test", label: "Test builds only" },
                    { value: "off", label: "Off" },
                ],
            },
            {
                key: "window:blur",
                tooltip:
                    "Blurs whatever is behind the window. macOS and Windows only. It can't be combined with Transparent window, which wins if both are on.",
                label: "Blurred window background",
                description: "macOS and Windows only. Not used with Transparent window.",
                applies: "restart",
                kind: "toggle",
            },
            {
                key: "window:bgcolor",
                tooltip: "The window's background color, as a hex value such as #1e1e1e.",
                label: "Window background color",
                kind: "text",
                placeholder: "#rrggbb",
            },
            {
                key: "window:reducedmotion",
                tooltip: "Turns off most animations.",
                label: "Reduce motion",
                kind: "toggle",
            },
            {
                key: "window:tilegapsize",
                tooltip: "The space between blocks in a tab, in pixels.",
                label: "Gap between blocks (px)",
                kind: "number",
                min: 0,
                step: 1,
                integer: true,
                placeholder: "3",
            },
        ],
    },
    {
        title: "Window",
        fields: [
            {
                key: "window:nativetitlebar",
                tooltip:
                    "Uses the operating system's own title bar instead of Wave's overlay. Windows and Linux only. On by default.",
                label: "Native title bar",
                description: "Windows and Linux only.",
                applies: "restart",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "window:fullscreenonlaunch",
                tooltip: "Opens the main window in fullscreen. It applies the next time Wave opens a window.",
                label: "Fullscreen on launch",
                kind: "toggle",
                defaultValue: false,
            },
            {
                key: "window:savelastwindow",
                tooltip:
                    "Keeps the last window you close and reopens it the next time Wave starts. When off, closing the last window starts fresh next time.",
                label: "Restore last window",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "window:maxtabcachesize",
                tooltip: "How many tabs Wave keeps loaded, so switching to one of them is instant.",
                label: "Tabs kept loaded",
                applies: "restart",
                kind: "number",
                min: 1,
                step: 1,
                integer: true,
                placeholder: "10",
            },
            {
                key: "window:disablehardwareacceleration",
                tooltip:
                    "Turns off graphics-card acceleration for the whole app. Try it only if the window shows glitches or stays blank.",
                label: "Disable hardware acceleration",
                applies: "restart",
                kind: "toggle",
            },
        ],
    },
    {
        title: "Magnified blocks",
        fields: [
            {
                key: "window:magnifiedblocksize",
                tooltip: "How large a magnified block is, as a fraction of its tab, from 0 to 1.",
                label: "Size",
                kind: "number",
                min: 0,
                max: 1,
                step: 0.05,
                placeholder: "0.95",
            },
            {
                key: "window:magnifiedblockopacity",
                tooltip: "The opacity of a magnified block, from 0 (invisible) to 1 (solid).",
                label: "Opacity",
                kind: "number",
                min: 0,
                max: 1,
                step: 0.05,
                placeholder: "0.6",
            },
            {
                key: "window:magnifiedblockblurprimarypx",
                tooltip: "The blur applied directly behind a magnified block, in pixels.",
                label: "Blur behind it (px)",
                kind: "number",
                min: 0,
                step: 1,
                integer: true,
                placeholder: "10",
            },
            {
                key: "window:magnifiedblockblursecondarypx",
                tooltip: "The blur applied to the other blocks you can still see while one is magnified, in pixels.",
                label: "Blur on the other blocks (px)",
                kind: "number",
                min: 0,
                step: 1,
                integer: true,
                placeholder: "2",
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
                applies: "terminal",
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
                applies: "terminal",
                kind: "toggle",
            },
            {
                key: "term:tmux",
                tooltip:
                    "For SSH hosts (with or without wsh), runs each terminal inside its own tmux session on the host, so it survives restarting Wave or losing the network and re-attaches to the same session. Closing the block ends the session. The host needs tmux installed.",
                label: "Keep SSH terminals in tmux",
                description: "Sessions survive restarts and disconnects. Needs tmux on the host.",
                applies: "terminal",
                kind: "toggle",
                defaultValue: false,
            },
            {
                key: "term:durable",
                tooltip:
                    "Makes remote terminal sessions durable across network disconnects. Needs wsh on the host; a host without wsh can use the tmux option instead.",
                label: "Durable remote sessions",
                applies: "terminal",
                kind: "toggle",
                defaultValue: false,
            },
            {
                key: "term:reconnectcmd",
                tooltip:
                    "A command typed into each new SSH terminal after it connects. With tmux sessions it runs only when the tmux session is created. It is usually set per connection instead of here.",
                label: "Command on connect",
                description: "Typed into each new SSH terminal. Usually set per connection.",
                applies: "terminal",
                kind: "text",
                placeholder: "none",
            },
            {
                key: "term:localshellpath",
                tooltip: "The shell that local terminals start. When empty, Wave uses your system's default shell.",
                label: "Local shell",
                description: "Full path to the shell program.",
                applies: "terminal",
                kind: "text",
                placeholder: "System default",
            },
            {
                key: "term:gitbashpath",
                tooltip:
                    "Windows only. Where Git Bash is installed. When empty, Wave looks for it in the standard install folders.",
                label: "Git Bash path",
                description: "Windows only. Empty finds Git Bash automatically.",
                applies: "terminal",
                kind: "text",
                placeholder: "Automatic",
            },
            {
                key: "term:shiftenternewline",
                tooltip:
                    "Makes Shift+Enter insert a new line without running the command (it sends Escape then newline). Useful in Claude Code and other tools that take multi-line input.",
                label: "Shift+Enter inserts a newline",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "term:trimtrailingwhitespace",
                tooltip: "Removes spaces at the end of each line when you copy terminal text.",
                label: "Trim trailing spaces when copying",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "term:osc52",
                tooltip:
                    "Lets programs in the terminal write to your clipboard. Always allows it at any time. Focused only allows it while the window and that terminal are focused.",
                label: "Terminal clipboard access",
                kind: "select",
                defaultValue: "always",
                options: [
                    { value: "always", label: "Always" },
                    { value: "focus", label: "Focused terminal only" },
                ],
            },
            {
                key: "term:transparency",
                tooltip: "How see-through the terminal background is, from 0 (solid) to 1 (fully transparent).",
                label: "Terminal transparency",
                kind: "number",
                min: 0,
                max: 1,
                step: 0.05,
                placeholder: "0.5",
            },
            {
                key: "term:showsplitbuttons",
                tooltip: "Shows split-horizontal and split-vertical buttons in each terminal block's header.",
                label: "Split buttons in header",
                kind: "toggle",
                defaultValue: false,
            },
            {
                key: "term:macoptionismeta",
                tooltip:
                    "macOS only. Treats the Option key as Meta, so Option+key sends the escape-key combinations terminal programs expect.",
                label: "Option is Meta (macOS)",
                kind: "toggle",
                defaultValue: false,
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
            {
                key: "editor:stickyscrollenabled",
                tooltip:
                    "Pins the heading of the code you are in, such as a class or function name, to the top of the editor while you scroll.",
                label: "Sticky scroll",
                kind: "toggle",
                defaultValue: false,
            },
            {
                key: "editor:inlinediff",
                tooltip:
                    "How file differences are shown. Inline puts removed and added lines in one column. Side by side shows the two versions next to each other. Automatic switches by window width.",
                label: "Diff layout",
                kind: "select",
                boolean: true,
                options: [
                    { value: UnsetValue, label: "Automatic" },
                    { value: "true", label: "Inline" },
                    { value: "false", label: "Side by side" },
                ],
            },
        ],
    },
    {
        title: "File browser",
        fields: [
            {
                key: "preview:showhiddenfiles",
                tooltip: "Shows files and folders whose names start with a dot in the file browser.",
                label: "Show hidden files",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "preview:dirsfirst",
                tooltip: "Lists folders before files, whichever column or direction the list is sorted by.",
                label: "Folders first",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "preview:defaultsort",
                tooltip:
                    "How a folder is sorted when you open it. Name sorts A to Z. Last modified puts the newest first. You can still click a column header to change it.",
                label: "Sort folders by",
                kind: "select",
                defaultValue: "name",
                options: [
                    { value: "name", label: "Name" },
                    { value: "modtime", label: "Last modified" },
                ],
            },
            {
                key: "preview:doubleclickopen",
                tooltip:
                    "What double-clicking a file does. Automatic opens text files in a Wave preview and everything else in the system's default app. Default app always uses the system app (Windows shows the Open with picker if nothing is associated). Wave preview always opens it inside Wave. Remote files are downloaded, opened, and uploaded back each time you save.",
                label: "Double-click a file",
                kind: "select",
                defaultValue: "auto",
                options: [
                    { value: "auto", label: "Automatic" },
                    { value: "external", label: "Default app" },
                    { value: "preview", label: "Wave preview" },
                ],
            },
            {
                key: "preview:externaleditor",
                tooltip:
                    "The program used by the Open in... item in a file's menu, for example C:\\Program Files\\Notepad++\\notepad++.exe. When empty, Wave looks for Notepad++ in its standard Windows install folder.",
                label: "External editor",
                description: "Full path to the program. Empty uses Notepad++ if it is installed.",
                kind: "text",
                placeholder: "Notepad++ if installed",
            },
            {
                key: "preview:autorefresh",
                tooltip:
                    "How often an open folder re-reads itself, in seconds, so files created or removed elsewhere (a terminal, another program) show up. Only the focused window refreshes, never during a transfer or while a remote host is disconnected. 0 turns it off; 1 to 4 count as 5.",
                label: "Refresh listing (seconds)",
                description: "0 turns automatic refresh off.",
                kind: "number",
                min: 0,
                step: 1,
                integer: true,
                placeholder: "10",
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
                key: "tab:confirmcloserunning",
                tooltip:
                    "Warns before a tab closes while one of its terminals is running a command (including inside a tmux session), and lists what would stop. Cancel is the default button.",
                label: "Warn when closing a busy tab",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "tab:confirmclose",
                tooltip: "Asks for confirmation before every tab close, even when nothing is running.",
                label: "Confirm every tab close",
                kind: "toggle",
                defaultValue: false,
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
            {
                key: "app:ctrlvpaste",
                tooltip:
                    "Whether Ctrl+V pastes in terminals on Windows and Linux. Automatic pastes on Windows only. Off leaves Ctrl+V to the program in the terminal. Ctrl+Shift+V always pastes, and macOS always uses Cmd+V.",
                label: "Ctrl+V pastes",
                kind: "select",
                boolean: true,
                options: [
                    { value: UnsetValue, label: "Automatic (Windows only)" },
                    { value: "true", label: "On" },
                    { value: "false", label: "Off" },
                ],
            },
            {
                key: "app:defaultnewblock",
                tooltip: "Which block the new-block shortcuts open: a terminal, or the launcher.",
                label: "New block opens",
                kind: "select",
                defaultValue: "term",
                options: [
                    { value: "term", label: "Terminal" },
                    { value: "launcher", label: "Launcher" },
                ],
            },
            {
                key: "app:globalhotkey",
                tooltip:
                    "A system-wide shortcut that opens your most recent Wave window from any app. Write key names separated by colons, for example F5 or Ctrl:Option:e. Names: Ctrl, Cmd, Shift, Alt, Option, Meta, Super, letters a to z, F1 to F20. Empty turns it off.",
                label: "Global hotkey",
                kind: "text",
                placeholder: "none",
            },
            {
                key: "app:showoverlayblocknums",
                tooltip: "Shows a number on each block while you hold Ctrl+Shift.",
                label: "Block numbers on Ctrl+Shift",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "app:disablectrlshiftdisplay",
                tooltip: "Shows the visual indicator that appears while you hold Ctrl+Shift.",
                label: "Ctrl+Shift indicator",
                kind: "toggle",
                invert: true,
                defaultValue: false,
            },
            {
                key: "app:disablectrlshiftarrows",
                tooltip: "Lets Ctrl+Shift with the arrow keys or h, j, k, l move between blocks.",
                label: "Ctrl+Shift block navigation",
                kind: "toggle",
                invert: true,
                defaultValue: false,
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
                applies: "restart",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "conn:disconnectonsleep",
                tooltip:
                    "Closes SSH connections when the computer sleeps or hibernates, so they don't come back frozen. On wake, a bar offers to reconnect them; tmux sessions are re-attached.",
                label: "Disconnect on sleep",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "conn:disconnectonlock",
                tooltip:
                    "Closes SSH connections when the screen locks (Windows and macOS). On unlock, a bar offers to reconnect them; tmux sessions are re-attached.",
                label: "Disconnect on screen lock",
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
            {
                key: "conn:showvitals",
                tooltip:
                    "Shows small CPU and memory meters in each block's connection chip for connected SSH hosts. They're read every few seconds over the existing connection; nothing is installed on the host.",
                label: "Live host meters on connection chips",
                kind: "toggle",
                defaultValue: true,
            },
            {
                key: "conn:notifyalerts",
                tooltip:
                    "Shows a desktop notification when a connected SSH host raises a new critical alert (disk or memory nearly full, very high load, a failed service) while Wave isn't the focused window. An alert that stays active doesn't repeat.",
                label: "Desktop notifications for host alerts",
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
                key: "autoupdate:channel",
                tooltip:
                    "Which release stream to follow. Only Official Wave has more than one; the Atreus fork only publishes Stable, so it ignores this. Applies on the next check.",
                label: "Update channel",
                description: "Only used with Official Wave.",
                kind: "select",
                defaultValue: "latest",
                options: [
                    { value: "latest", label: "Stable" },
                    { value: "beta", label: "Beta" },
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
                key: "autoupdate:intervalms",
                tooltip:
                    "How often Wave checks for a new version while it's running, in milliseconds. Wave looks at the clock every 10 minutes, so shorter values still check at most that often.",
                label: "Check interval (ms)",
                description: "3600000 is one hour.",
                kind: "number",
                min: 60000,
                step: 60000,
                placeholder: "3600000",
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
        {field.applies && <div>{AppliesText[field.applies].detail}</div>}
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
                const baseOptions = typeof field.options === "function" ? field.options(fullConfig) : field.options;
                const value = rawValue == null ? UnsetValue : String(rawValue);
                // a value set by hand in settings.json may not be one we list; show it rather than silently displaying the first option
                const options = baseOptions.some((opt) => opt.value === value)
                    ? baseOptions
                    : [...baseOptions, { value, label: `${value} (unrecognized)` }];
                control = (
                    <select
                        value={value}
                        onChange={(e) => {
                            if (e.target.value === UnsetValue) {
                                onSet(field.key, null);
                                return;
                            }
                            onSet(field.key, field.boolean ? e.target.value === "true" : e.target.value);
                        }}
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
                            if (v.trim() === "" || isNaN(num)) {
                                onSet(field.key, null);
                                return;
                            }
                            onSet(field.key, field.integer ? Math.round(num) : num);
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
                        {field.applies && (
                            <span className="rounded border border-border px-1.5 text-xs text-muted">
                                {AppliesText[field.applies].badge}
                            </span>
                        )}
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
    const [query, setQuery] = useState("");

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

    const visibleSections = useMemo(() => filterSections(SettingSections, query), [query]);

    return (
        <div className="h-full overflow-y-auto">
            <div className="sticky top-0 z-10 border-b border-border/50 bg-background">
                <div className="mx-auto max-w-2xl px-6 py-3">
                    <div className="relative">
                        <i className="fa-solid fa-magnifying-glass pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted" />
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Escape") setQuery("");
                            }}
                            placeholder="Search settings"
                            aria-label="Search settings"
                            className="w-full rounded border border-border bg-transparent py-1.5 pl-8 pr-8 text-sm outline-none focus:border-accent"
                        />
                        {query !== "" && (
                            <button
                                onClick={() => setQuery("")}
                                aria-label="Clear search"
                                className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted hover:text-secondary"
                            >
                                <i className="fa-solid fa-xmark text-xs" />
                            </button>
                        )}
                    </div>
                </div>
            </div>
            <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
                {saveError && <div className="rounded bg-error px-3 py-2 text-sm text-primary">{saveError}</div>}
                {visibleSections.length === 0 && (
                    <div className="text-sm text-muted">
                        No settings match "{query}". Less common ones are in the{" "}
                        <span className="text-secondary">Advanced Options (JSON)</span> tab.
                    </div>
                )}
                {visibleSections.map((section) => (
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
