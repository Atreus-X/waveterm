// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const MaxSuggestions = 50;

export type PathSuggestion = {
    name: string;
    isdir: boolean;
};

// Splits what the user typed into the directory to list and the partial name to match inside it.
// Returns null when there is no directory part to list (e.g. an empty or relative draft).
export function splitPathInput(draft: string): { dir: string; prefix: string } | null {
    const text = draft.replace(/^‎/, "");
    if (text == "~") {
        return { dir: "~", prefix: "" };
    }
    const idx = text.lastIndexOf("/");
    if (idx < 0) {
        return null;
    }
    const dir = idx == 0 ? "/" : text.slice(0, idx);
    return { dir, prefix: text.slice(idx + 1) };
}

export function filterSuggestions(entries: PathSuggestion[], prefix: string, showHidden: boolean): PathSuggestion[] {
    const lower = prefix.toLowerCase();
    const wantHidden = showHidden || prefix.startsWith(".");
    return entries
        .filter((e) => e.name != null && e.name != ".." && e.name != ".")
        .filter((e) => wantHidden || !e.name.startsWith("."))
        .filter((e) => e.name.toLowerCase().startsWith(lower))
        .sort((a, b) => {
            if (a.isdir != b.isdir) {
                return a.isdir ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        })
        .slice(0, MaxSuggestions);
}

export function applySuggestion(draft: string, suggestion: PathSuggestion): string {
    const parts = splitPathInput(draft);
    if (parts == null) {
        return draft;
    }
    const base = parts.dir == "/" ? "/" : parts.dir + "/";
    return base + suggestion.name + (suggestion.isdir ? "/" : "");
}

// Longest shared prefix (case-insensitive match, first entry's casing) used for Tab when nothing is highlighted.
export function commonPrefix(names: string[]): string {
    if (names.length == 0) {
        return "";
    }
    let prefix = names[0];
    for (const name of names.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < name.length && prefix[i].toLowerCase() == name[i].toLowerCase()) {
            i++;
        }
        prefix = prefix.slice(0, i);
    }
    return prefix;
}
