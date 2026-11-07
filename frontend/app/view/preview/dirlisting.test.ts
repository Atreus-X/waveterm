// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { listingSignature } from "./dirlisting";

const file = (name: string, size: number, modtime: number): FileInfo =>
    ({ name, path: `/srv/drop/${name}`, size, modtime, isdir: false }) as FileInfo;
const parent = (modtime: number): FileInfo =>
    ({ name: "..", path: "/srv", isdir: true, modtime, mimetype: "directory" }) as FileInfo;

describe("listingSignature", () => {
    it("ignores the parent row, whose modtime changes on every listing", () => {
        const a = [parent(1), file("a.txt", 10, 100)];
        const b = [parent(2), file("a.txt", 10, 100)];
        expect(listingSignature(a)).toBe(listingSignature(b));
    });

    it("changes when a file is added, removed, resized or touched", () => {
        const base = [file("a.txt", 10, 100)];
        const sig = listingSignature(base);
        expect(listingSignature([...base, file("b.txt", 1, 1)])).not.toBe(sig);
        expect(listingSignature([])).not.toBe(sig);
        expect(listingSignature([file("a.txt", 11, 100)])).not.toBe(sig);
        expect(listingSignature([file("a.txt", 10, 101)])).not.toBe(sig);
    });

    it("is the same for an empty listing every time", () => {
        expect(listingSignature([])).toBe(listingSignature([parent(5)]));
    });
});
