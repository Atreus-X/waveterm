// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Mimetype sniffing misses many source files (".ts" is sniffed as video/mp2t, ".go" and dotfiles as
// octet-stream), so the extension list is checked first.
const TextExtensions = new Set([
    // plain text and docs
    "txt",
    "text",
    "md",
    "markdown",
    "mdx",
    "rst",
    "adoc",
    "org",
    "tex",
    "log",
    "nfo",
    "rtf",
    // data and config
    "json",
    "jsonc",
    "json5",
    "jsonl",
    "ndjson",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "config",
    "properties",
    "env",
    "xml",
    "csv",
    "tsv",
    "plist",
    "lock",
    "editorconfig",
    "gitignore",
    "gitattributes",
    "dockerignore",
    "npmrc",
    "prettierrc",
    "eslintrc",
    "babelrc",
    // web
    "html",
    "htm",
    "xhtml",
    "css",
    "scss",
    "sass",
    "less",
    "svg",
    "vue",
    "svelte",
    "astro",
    // scripting and shell
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "psm1",
    "bat",
    "cmd",
    "awk",
    "sed",
    // languages
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "mts",
    "cts",
    "tsx",
    "py",
    "pyi",
    "rb",
    "php",
    "pl",
    "pm",
    "lua",
    "r",
    "go",
    "rs",
    "c",
    "h",
    "cc",
    "cpp",
    "cxx",
    "hpp",
    "hh",
    "hxx",
    "cs",
    "java",
    "kt",
    "kts",
    "scala",
    "swift",
    "m",
    "mm",
    "dart",
    "ex",
    "exs",
    "erl",
    "hs",
    "clj",
    "cljs",
    "fs",
    "fsx",
    "vb",
    "groovy",
    "gradle",
    "zig",
    "nim",
    "jl",
    "sql",
    "graphql",
    "gql",
    "proto",
    "tf",
    "tfvars",
    "hcl",
    "nix",
    "cmake",
    "make",
    "mk",
    "dockerfile",
    "vim",
    "diff",
    "patch",
    "service",
    "timer",
    "desktop",
]);

// extensionless names that are always text
const TextFileNames = new Set([
    "makefile",
    "dockerfile",
    "readme",
    "license",
    "licence",
    "changelog",
    "authors",
    "contributing",
    "codeowners",
    "procfile",
    "gemfile",
    "rakefile",
    "vagrantfile",
    "jenkinsfile",
    "taskfile",
]);

function hasTextMimetype(mimeType: string): boolean {
    if (mimeType == null) {
        return false;
    }
    return (
        mimeType.startsWith("text/") ||
        mimeType.includes("json") ||
        mimeType.includes("yaml") ||
        mimeType.includes("toml") ||
        mimeType.includes("xml") ||
        mimeType.includes("javascript") ||
        mimeType.includes("typescript") ||
        mimeType === "application/x-sh" ||
        mimeType === "application/sql" ||
        mimeType === "application/x-python" ||
        mimeType === "application/x-ruby"
    );
}

export function isTextCapableFile(name: string, mimeType: string): boolean {
    const base = (name ?? "").split(/[\\/]/).pop().toLowerCase();
    if (TextFileNames.has(base)) {
        return true;
    }
    const dot = base.lastIndexOf(".");
    const ext = dot >= 0 ? base.slice(dot + 1) : "";
    if (ext !== "" && TextExtensions.has(ext)) {
        return true;
    }
    return hasTextMimetype(mimeType);
}
