// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// app:theme -- one setting that themes the whole app. It names an entry in termthemes; the UI colors are
// derived from that terminal theme, and every terminal without its own term:theme uses it too.

const AnsiVarKeys: [string, keyof TermThemeType][] = [
    ["black", "black"],
    ["red", "red"],
    ["green", "green"],
    ["yellow", "yellow"],
    ["blue", "blue"],
    ["magenta", "magenta"],
    ["cyan", "cyan"],
    ["white", "white"],
    ["brightblack", "brightBlack"],
    ["brightred", "brightRed"],
    ["brightgreen", "brightGreen"],
    ["brightyellow", "brightYellow"],
    ["brightblue", "brightBlue"],
    ["brightmagenta", "brightMagenta"],
    ["brightcyan", "brightCyan"],
    ["brightwhite", "brightWhite"],
];

function mix(color: string, pct: number, other: string = "transparent"): string {
    return `color-mix(in srgb, ${color} ${pct}%, ${other})`;
}

function computeAppThemeVars(theme: TermThemeType): Record<string, string> {
    const bg = theme.background;
    const fg = theme.foreground;
    if (!bg || !fg) {
        return {};
    }
    const accent = theme.green || theme.blue || fg;
    const secondary = mix(fg, 75, bg);
    const muted = mix(fg, 55, bg);
    const vars: Record<string, string> = {
        "--main-bg-color": bg,
        "--color-background": bg,
        "--main-text-color": fg,
        "--color-foreground": fg,
        "--color-primary": fg,
        "--secondary-text-color": secondary,
        "--color-secondary": secondary,
        "--color-muted-foreground": secondary,
        "--color-muted": muted,
        "--grey-text-color": muted,
        "--accent-color": accent,
        "--color-accent": accent,
        "--color-accent-400": accent,
        "--tab-green": accent,
        "--color-accenthover": mix(accent, 80, fg),
        "--color-accentbg": mix(accent, 50),
        "--border-color": mix(fg, 16),
        "--color-border": mix(fg, 16),
        "--hover-bg-color": mix(fg, 10),
        "--color-hover": mix(fg, 10),
        "--highlight-bg-color": mix(fg, 20),
        "--color-highlightbg": mix(fg, 20),
        "--color-hoverbg": mix(fg, 20),
        "--panel-bg-color": mix(bg, 50),
        "--color-panel": mix(bg, 50),
        "--color-modalbg": mix(bg, 92, fg),
        "--block-bg-color": mix(bg, 60),
        "--block-bg-solid-color": bg,
        "--scrollbar-thumb-color": mix(fg, 15),
        "--scrollbar-thumb-hover-color": mix(fg, 50),
        "--scrollbar-thumb-active-color": mix(fg, 60),
    };
    for (const [varName, themeKey] of AnsiVarKeys) {
        const color = theme[themeKey];
        if (typeof color === "string" && color) {
            vars[`--ansi-${varName}`] = color;
        }
    }
    return vars;
}

let appliedVarNames: string[] = [];

// sets the derived CSS variables on <body> (null theme restores the built-in look)
export function applyAppTheme(theme: TermThemeType | null) {
    const style = document.body.style;
    for (const name of appliedVarNames) {
        style.removeProperty(name);
    }
    const vars = theme ? computeAppThemeVars(theme) : {};
    for (const [name, value] of Object.entries(vars)) {
        style.setProperty(name, value);
    }
    appliedVarNames = Object.keys(vars);
}

// menu for picking app:theme; picking one also clears a global term:theme so every terminal follows it
export function buildAppThemeSubmenu(
    fullConfig: FullConfigType,
    setConfig: (settings: SettingsType) => Promise<void>
): ContextMenuItem[] {
    const termThemes = fullConfig?.termthemes ?? {};
    const curAppTheme = fullConfig?.settings?.["app:theme"];
    const themeNames = Object.keys(termThemes).sort(
        (a, b) => (termThemes[a]["display:order"] ?? 0) - (termThemes[b]["display:order"] ?? 0)
    );
    const setAppTheme = (themeName: string) => {
        setConfig({ "app:theme": themeName, "term:theme": null }).catch((e) =>
            console.error("error setting app:theme", e)
        );
    };
    const submenu: ContextMenuItem[] = themeNames.map((themeName) => ({
        label: termThemes[themeName]["display:name"] ?? themeName,
        type: "checkbox",
        checked: curAppTheme == themeName,
        click: () => setAppTheme(themeName),
    }));
    submenu.unshift({ type: "separator" });
    submenu.unshift({
        label: "Wave Default",
        type: "checkbox",
        checked: curAppTheme == null,
        click: () => setAppTheme(null),
    });
    return submenu;
}
