// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

export type Placeholder = { name: string; defaultValue: string };

// {{name}} or {{name=default}}; names are letters, digits, _ and -. A backslash before {{ keeps it literal.
const PlaceholderRe = /(\\?)\{\{\s*([A-Za-z_][\w-]*)\s*(?:=([^}]*))?\}\}/g;

export function parsePlaceholders(body: string): Placeholder[] {
    const rtn: Placeholder[] = [];
    const seen = new Set<string>();
    for (const m of (body ?? "").matchAll(PlaceholderRe)) {
        if (m[1] === "\\") continue;
        const name = m[2];
        if (seen.has(name)) continue;
        seen.add(name);
        rtn.push({ name, defaultValue: m[3] ?? "" });
    }
    return rtn;
}

// values are inserted as typed (not shell-quoted), exactly like editing the command by hand
export function fillPlaceholders(body: string, values: Record<string, string>): string {
    return (body ?? "").replace(PlaceholderRe, (whole, esc, name, def) => {
        if (esc === "\\") return whole.slice(1);
        return values[name] ?? def ?? "";
    });
}

// the host part of a connection ("user@host:22" -> "host") so patterns don't need the user or port
export function connHostPart(conn: string): string {
    if (!conn) return "";
    let rest = conn.includes("@") ? conn.slice(conn.lastIndexOf("@") + 1) : conn;
    const colon = rest.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) rest = rest.slice(0, colon);
    return rest;
}

function globToRegExp(glob: string): RegExp {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
}

// a pattern matches the full connection name ("admin@db1:22") or just its host ("db1")
export function hostMatches(patterns: string[], conn: string): boolean {
    if (!conn || !patterns?.length) return false;
    const host = connHostPart(conn);
    return patterns.some((p) => {
        const pat = p.trim();
        if (!pat) return false;
        const re = globToRegExp(pat);
        return re.test(conn) || re.test(host);
    });
}

// every whitespace-separated word must appear in the title, body, description or tags; snippets for
// the current host come first, then title matches before body-only matches
export function rankSnippets(snippets: LibrarySnippet[], query: string, conn: string): LibrarySnippet[] {
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const scored: { s: LibrarySnippet; score: number; idx: number }[] = [];
    snippets.forEach((s, idx) => {
        const title = (s.title ?? "").toLowerCase();
        const hay = [title, s.body, s.description, ...(s.tags ?? [])].join("\n").toLowerCase();
        if (!words.every((w) => hay.includes(w))) return;
        let score = 0;
        if (hostMatches(s.hosts, conn)) score += 100;
        score += words.filter((w) => title.includes(w)).length * 10;
        if (words.length > 0 && title.startsWith(words[0])) score += 5;
        scored.push({ s, score, idx });
    });
    return scored.sort((a, b) => b.score - a.score || a.idx - b.idx).map((x) => x.s);
}

export function newSnippet(): LibrarySnippet {
    return { id: crypto.randomUUID(), title: "New snippet", body: "", tags: [], hosts: [] };
}

export function splitList(text: string): string[] {
    return (text ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
}
