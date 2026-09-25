// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { assert, expect, test } from "vitest";
import {
    connHostPart,
    fillPlaceholders,
    hostMatches,
    parsePlaceholders,
    rankSnippets,
    splitList,
} from "./library-util";

test("parsePlaceholders finds names and defaults once each, skipping escaped ones", () => {
    const body =
        "docker logs -f {{container}} --since {{since=10m}} | grep {{ pattern }} # {{container}} \\{{literal}}";
    expect(parsePlaceholders(body)).toEqual([
        { name: "container", defaultValue: "" },
        { name: "since", defaultValue: "10m" },
        { name: "pattern", defaultValue: "" },
    ]);
    expect(parsePlaceholders("no placeholders here")).toEqual([]);
});

test("fillPlaceholders substitutes values, falls back to defaults and keeps escaped braces", () => {
    const body = "journalctl -u {{unit}} -n {{lines=200}} \\{{kept}}";
    expect(fillPlaceholders(body, { unit: "nginx.service" })).toBe("journalctl -u nginx.service -n 200 {{kept}}");
    expect(fillPlaceholders(body, { unit: "x", lines: "5" })).toBe("journalctl -u x -n 5 {{kept}}");
});

test("host patterns match the connection or just its host part", () => {
    expect(connHostPart("admin@db1.example.com:2222")).toBe("db1.example.com");
    assert(hostMatches(["*.example.com"], "admin@db1.example.com"));
    assert(hostMatches(["db*"], "admin@db1.example.com:22"));
    assert(hostMatches(["admin@db1*"], "admin@db1.example.com"));
    assert(!hostMatches(["web*"], "admin@db1.example.com"));
    assert(!hostMatches([], "admin@db1.example.com"));
    assert(!hostMatches(["*"], ""));
});

test("rankSnippets filters by every word and puts host matches and title hits first", () => {
    const snippets: LibrarySnippet[] = [
        { id: "1", title: "Disk usage", body: "df -h", tags: ["disk"] },
        { id: "2", title: "Postgres size", body: "du -sh /var/lib/postgresql", hosts: ["db*"] },
        { id: "3", title: "Tail logs", body: "journalctl -f -n 200 # disk pressure" },
    ];
    expect(rankSnippets(snippets, "", "").map((s) => s.id)).toEqual(["1", "2", "3"]);
    expect(rankSnippets(snippets, "", "admin@db1").map((s) => s.id)).toEqual(["2", "1", "3"]);
    expect(rankSnippets(snippets, "disk", "").map((s) => s.id)).toEqual(["1", "3"]);
    expect(rankSnippets(snippets, "disk nope", "").map((s) => s.id)).toEqual([]);
});

test("splitList", () => {
    expect(splitList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(splitList("")).toEqual([]);
});
