// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fileWrite, fileCopy, writeTempFile } = vi.hoisted(() => ({
    fileWrite: vi.fn(async () => {}),
    fileCopy: vi.fn(async (..._args: any[]) => {}),
    writeTempFile: vi.fn(async () => "/local/tmp/waveterm-x/pasted.png"),
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { FileWriteCommand: fileWrite, FileCopyCommand: fileCopy, WriteTempFileCommand: writeTempFile },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/openexternal-progress", () => {
    const model = {
        beginTransfer: () => ({ id: "x1", signal: new AbortController().signal }),
        setTransferItem: () => {},
        endTransfer: () => {},
    };
    return { OpenExternalProgressModel: { getInstance: () => model } };
});

import { createTempFileFromBlob, isRemoteSshConnection, remoteDropPath, uploadDroppedFiles } from "./termutil";

const PngBlob = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

describe("isRemoteSshConnection", () => {
    it("is true only for a named SSH host", () => {
        expect(isRemoteSshConnection("user@host.example.com")).toBe(true);
        expect(isRemoteSshConnection("host.example.com:2222")).toBe(true);
        expect(isRemoteSshConnection("")).toBe(false);
        expect(isRemoteSshConnection(null)).toBe(false);
        expect(isRemoteSshConnection("local")).toBe(false);
        expect(isRemoteSshConnection("wsl://Ubuntu")).toBe(false);
    });
});

describe("createTempFileFromBlob", () => {
    beforeEach(() => {
        fileWrite.mockClear();
        writeTempFile.mockClear();
    });

    it("writes to /tmp on an SSH host with mode 0600 and returns the path on that host", async () => {
        const path = await createTempFileFromBlob(PngBlob(), "user@host.example.com");
        expect(path).toMatch(/^\/tmp\/waveterm_paste_\d+_[0-9a-f]{16}\.png$/);
        expect(writeTempFile).not.toHaveBeenCalled();
        expect(fileWrite).toHaveBeenCalledTimes(1);
        const arg = (fileWrite.mock.calls[0] as any[])[1];
        expect(arg.info.path).toBe(`wsh://user@host.example.com/${path}`);
        expect(arg.info.mode).toBe(0o600);
        expect(arg.data64).toBe("iVBORw==");
    });

    it("keeps writing locally for a local terminal, an empty connection and WSL", async () => {
        for (const conn of [undefined, "", "local", "wsl://Ubuntu"]) {
            const path = await createTempFileFromBlob(PngBlob(), conn);
            expect(path).toBe("/local/tmp/waveterm-x/pasted.png");
        }
        expect(fileWrite).not.toHaveBeenCalled();
        expect(writeTempFile).toHaveBeenCalledTimes(4);
    });

    it("rejects images over 5MB and non-image types before any write", async () => {
        const big = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" });
        await expect(createTempFileFromBlob(big, "user@host.example.com")).rejects.toThrow("too large");
        await expect(
            createTempFileFromBlob(new Blob(["x"], { type: "text/plain" }), "user@host.example.com")
        ).rejects.toThrow("Unsupported");
        expect(fileWrite).not.toHaveBeenCalled();
    });

    it("propagates a failed upload so the paste handler can report it", async () => {
        fileWrite.mockRejectedValueOnce(new Error("sftp: permission denied"));
        await expect(createTempFileFromBlob(PngBlob(), "user@host.example.com")).rejects.toThrow("permission denied");
    });
});

describe("remoteDropPath", () => {
    it("keeps the extension, drops unsafe characters and handles Windows paths", () => {
        expect(remoteDropPath("D:\\drop\\My Report (final).pdf")).toMatch(
            /^\/tmp\/waveterm_drop_\d+_[0-9a-f]{8}_My_Report__final_.pdf$/
        );
        expect(remoteDropPath("/srv/drop/a.txt")).toMatch(/_a\.txt$/);
    });

    it("is unique for the same file dropped twice", () => {
        expect(remoteDropPath("/x/a.txt")).not.toBe(remoteDropPath("/x/a.txt"));
    });
});

describe("uploadDroppedFiles", () => {
    beforeEach(() => fileCopy.mockClear());

    it("copies each item local to the host, recursive, and returns the host paths", async () => {
        const res = await uploadDroppedFiles(["D:\\drop\\a.png", "/srv/drop/dir"], "user@host.example.com");
        expect(res.failures).toEqual([]);
        expect(res.paths).toHaveLength(2);
        expect(fileCopy).toHaveBeenCalledTimes(2);
        const first = (fileCopy.mock.calls[0] as any[])[1];
        expect(first.srcuri).toBe("wsh://local/D:/drop/a.png");
        expect(first.desturi).toBe(`wsh://user@host.example.com/${res.paths[0]}`);
        expect(first.opts.recursive).toBe(true);
        expect(first.opts.xferid).toBe("x1");
    });

    it("reports a failed item and still uploads the rest", async () => {
        fileCopy.mockRejectedValueOnce(new Error("permission denied"));
        const res = await uploadDroppedFiles(["/a/bad.txt", "/a/good.txt"], "user@host.example.com");
        expect(res.paths).toHaveLength(1);
        expect(res.paths[0]).toMatch(/good\.txt$/);
        expect(res.failures).toEqual(["bad.txt: permission denied"]);
    });
});
