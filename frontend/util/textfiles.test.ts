// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isTextCapableFile } from "./textfiles";

describe("isTextCapableFile", () => {
    it("matches by extension even when the mimetype is wrong", () => {
        expect(isTextCapableFile("main.ts", "video/mp2t")).toBe(true);
        expect(isTextCapableFile("main.go", "application/octet-stream")).toBe(true);
        expect(isTextCapableFile("README.MD", "")).toBe(true);
    });

    it("matches dotfiles and well-known extensionless names", () => {
        expect(isTextCapableFile(".gitignore", "application/octet-stream")).toBe(true);
        expect(isTextCapableFile(".env", null)).toBe(true);
        expect(isTextCapableFile("Makefile", null)).toBe(true);
    });

    it("falls back to the mimetype", () => {
        expect(isTextCapableFile("notes.weird", "text/plain; charset=utf-8")).toBe(true);
        expect(isTextCapableFile("data.bin", "application/json")).toBe(true);
    });

    it("rejects binaries", () => {
        expect(isTextCapableFile("photo.png", "image/png")).toBe(false);
        expect(isTextCapableFile("app.exe", "application/octet-stream")).toBe(false);
        expect(isTextCapableFile("archive.zip", "application/zip")).toBe(false);
        expect(isTextCapableFile("noext", null)).toBe(false);
    });
});
