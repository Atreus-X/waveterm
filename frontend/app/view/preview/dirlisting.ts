// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The ".." row's modtime is "now", so it is left out or every poll would look like a change.
export function listingSignature(entries: FileInfo[]): string {
    return entries
        .filter((entry) => entry.name !== "..")
        .map((entry) => `${entry.path}|${entry.modtime}|${entry.size}|${entry.isdir}`)
        .join("\n");
}
