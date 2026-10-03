// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import fs from "fs";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as path from "path";
import { RpcApi } from "../frontend/app/store/wshclientapi";
import { getWebServerEndpoint } from "../frontend/util/endpoints";
import { formatRemoteUri } from "../frontend/util/waveutil";
import { AuthKey, AuthKeyHeader } from "./authkey";
import { callWithOriginalXdgCurrentDesktopAsync } from "./emain-platform";
import { ElectronWshClient } from "./emain-wsh";

// Opening files from the file browser in native apps. Local files open in place; remote files
// (ssh/wsl connections) are downloaded to a per-file temp dir, opened, and uploaded back to the
// connection every time the local copy is saved (WinSCP-style "edit").

const RemoteEditDirName = "wave-remote-edit";
const RemoteEditMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const SyncDebounceMs = 700;
const StatPollMs = 2000;
const RemoteRpcTimeoutMs = 60000;
const UploadChunkBytes = 16 * 1024 * 1024;

type RemoteEditSession = {
    remoteUri: string;
    connName: string;
    localPath: string;
    lastSyncedHash: string;
    remoteModTime: number;
    watcher: fs.FSWatcher;
    debounceTimer: NodeJS.Timeout | null;
    uploading: boolean;
    uploadPending: boolean;
};

const remoteEditSessions = new Map<string, RemoteEditSession>();
const activeDownloads = new Map<string, AbortController>();

function downloadKey(connName: string, remotePath: string): string {
    return `${connName ?? ""}|${remotePath}`;
}

function isAbortError(err: any): boolean {
    return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

export function cancelOpenFileExternal(connName: string, remotePath: string) {
    activeDownloads.get(downloadKey(connName, remotePath))?.abort();
}

function remoteEditRoot(): string {
    return path.join(electron.app.getPath("temp"), RemoteEditDirName);
}

function isLocalConn(connName: string): boolean {
    return connName == null || connName === "" || connName === "local" || connName.startsWith("local:");
}

function hashBytes(data: Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

// remote names can contain characters Windows won't accept in a filename
function safeLocalName(remotePath: string): string {
    const base =
        remotePath
            .split("/")
            .filter((p) => p !== "")
            .pop() || "file";
    return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

function editorDisplayName(editorPath: string): string {
    const base = path.basename(editorPath).toLowerCase();
    if (base === "notepad++.exe") {
        return "Notepad++";
    }
    return path.basename(editorPath).replace(/\.exe$/i, "");
}

function expandHome(p: string): string {
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
        return path.join(electron.app.getPath("home"), p.slice(1));
    }
    return p;
}

// Resolves the external editor: the configured path (preview:externaleditor) if it exists,
// otherwise Notepad++ in its standard Windows install locations.
export function findExternalEditor(configured: string): ExternalEditorInfo | null {
    if (configured != null && configured.trim() !== "") {
        const p = expandHome(configured.trim());
        return fs.existsSync(p) ? { name: editorDisplayName(p), path: p } : null;
    }
    if (process.platform !== "win32") {
        return null;
    }
    const roots = [process.env["ProgramFiles"], process.env["ProgramW6432"], process.env["ProgramFiles(x86)"]];
    for (const root of roots) {
        if (!root) {
            continue;
        }
        const candidate = path.join(root, "Notepad++", "notepad++.exe");
        if (fs.existsSync(candidate)) {
            return { name: "Notepad++", path: candidate };
        }
    }
    return null;
}

function spawnDetached(cmd: string, args: string[]) {
    const child = child_process.spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (err) => console.error(`failed to launch ${cmd}:`, err));
    child.unref();
}

// "choose an app" dialog on Windows
function openWithPicker(localPath: string) {
    spawnDetached("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", localPath]);
}

async function openLocalFile(localPath: string, mode: OpenExternalMode, editorPath: string): Promise<string> {
    if (mode === "editor") {
        const editor = findExternalEditor(editorPath);
        if (editor == null) {
            return "no external editor found (set preview:externaleditor)";
        }
        spawnDetached(editor.path, [localPath]);
        return "";
    }
    if (mode === "openwith" && process.platform === "win32") {
        openWithPicker(localPath);
        return "";
    }
    const excuse = await openPathWithRetry(localPath);
    if (!excuse) {
        return "";
    }
    console.log(`no default application for ${localPath}: ${excuse}`);
    // no associated app: let the user pick one (Windows), otherwise show the file
    if (process.platform === "win32") {
        openWithPicker(localPath);
    } else {
        electron.shell.showItemInFolder(localPath);
    }
    return "";
}

function notify(title: string, body: string) {
    if (!electron.Notification.isSupported()) {
        return;
    }
    new electron.Notification({ title, body, silent: true }).show();
}

export type OpenProgressFn = (phase: "download" | "opening", received: number, total: number) => void;

const ProgressIntervalMs = 150;

async function downloadRemote(
    remoteUri: string,
    localPath: string,
    onProgress?: OpenProgressFn,
    signal?: AbortSignal
): Promise<{ hash: string; modTime: number }> {
    const info = await RpcApi.FileInfoCommand(
        ElectronWshClient,
        { info: { path: remoteUri } },
        { timeout: RemoteRpcTimeoutMs }
    );
    if (info == null || info.notfound) {
        throw new Error("file not found on remote");
    }
    if (info.isdir) {
        throw new Error("cannot open a directory in an external application");
    }
    // streamed from wavesrv's stream-file endpoint rather than FileReadCommand, which returns the
    // whole file in one base64 RPC message and so refuses anything over the 32 MB transfer limit
    const url = `${getWebServerEndpoint()}/wave/stream-file?path=${encodeURIComponent(remoteUri)}`;
    const res = await fetch(url, { headers: { [AuthKeyHeader]: AuthKey }, signal });
    if (!res.ok || res.body == null) {
        throw new Error(`download failed (HTTP ${res.status})`);
    }
    const hash = crypto.createHash("sha256");
    const total = info.size ?? 0;
    let received = 0;
    let lastReport = 0;
    onProgress?.("download", 0, total);
    const hashing = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            received += chunk.length;
            const now = Date.now();
            if (onProgress != null && now - lastReport >= ProgressIntervalMs) {
                lastReport = now;
                onProgress("download", received, total);
            }
            cb(null, chunk);
        },
    });
    // written beside the real file and renamed on success, so a canceled or failed download never leaves
    // a truncated copy where the save-back watcher would upload it
    const partPath = localPath + ".part";
    const out = fs.createWriteStream(partPath);
    // "finish" can fire before the handle is closed; opening a file Windows still sees as open for
    // writing fails ("another program is using this file"), so wait for "close" too
    const closed = new Promise<void>((resolve) => out.once("close", () => resolve()));
    try {
        await pipeline(Readable.fromWeb(res.body as any), hashing, out, { signal });
        await closed;
        await fs.promises.rename(partPath, localPath);
    } catch (err) {
        await closed.catch(() => {});
        await fs.promises.rm(partPath, { force: true }).catch(() => {});
        throw err;
    }
    onProgress?.("opening", received, total);
    return { hash: hash.digest("hex"), modTime: info.modtime ?? 0 };
}

// run-once files: opening them executes or installs, so there's nothing to edit or sync back, and a
// copy may still be running from the last open
const RunOnceExtensions = new Set([
    ".exe",
    ".msi",
    ".msix",
    ".appx",
    ".bat",
    ".cmd",
    ".com",
    ".ps1",
    ".vbs",
    ".scr",
    ".appimage",
    ".deb",
    ".rpm",
    ".dmg",
    ".pkg",
    ".run",
]);

export function isRunOnceFile(name: string): boolean {
    return RunOnceExtensions.has(path.extname(name).toLowerCase());
}

const SharingViolationRe = /another program|being used by another|used by another process|sharing violation/i;

// a freshly written executable is briefly locked by antivirus scanning; retry the open for a few seconds
async function openPathWithRetry(localPath: string): Promise<string> {
    let excuse = "";
    for (let attempt = 0; attempt < 6; attempt++) {
        await callWithOriginalXdgCurrentDesktopAsync(async () => {
            excuse = await electron.shell.openPath(localPath);
        });
        if (!excuse || !SharingViolationRe.test(excuse)) {
            return excuse;
        }
        await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
    return excuse;
}

// run-once files get a fresh copy per open (never overwriting one that may still be running) and no
// save-back session
async function openRemoteRunOnce(
    remoteUri: string,
    remotePath: string,
    onProgress?: OpenProgressFn,
    signal?: AbortSignal
): Promise<string> {
    const dir = path.join(remoteEditRoot(), "run-" + crypto.randomBytes(6).toString("hex"));
    await fs.promises.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, safeLocalName(remotePath));
    await downloadRemote(remoteUri, localPath, onProgress, signal);
    const excuse = await openPathWithRetry(localPath);
    if (excuse) {
        console.log(`could not open ${localPath}: ${excuse}`);
        electron.shell.showItemInFolder(localPath);
        return excuse;
    }
    return "";
}

// one write, then appends: each RPC message stays well under the 32 MB transfer limit
async function uploadRemote(remoteUri: string, bytes: Buffer) {
    for (let offset = 0; offset === 0 || offset < bytes.length; offset += UploadChunkBytes) {
        const chunk = bytes.subarray(offset, offset + UploadChunkBytes);
        const data = { info: { path: remoteUri }, data64: chunk.toString("base64") };
        if (offset === 0) {
            await RpcApi.FileWriteCommand(ElectronWshClient, data, { timeout: RemoteRpcTimeoutMs });
        } else {
            await RpcApi.FileAppendCommand(ElectronWshClient, data, { timeout: RemoteRpcTimeoutMs });
        }
    }
}

function scheduleSync(sess: RemoteEditSession) {
    if (sess.debounceTimer != null) {
        clearTimeout(sess.debounceTimer);
    }
    sess.debounceTimer = setTimeout(() => {
        sess.debounceTimer = null;
        syncBack(sess).catch((err) => console.error("remote edit sync error", sess.remoteUri, err));
    }, SyncDebounceMs);
}

async function confirmOverwriteChangedRemote(sess: RemoteEditSession): Promise<boolean> {
    const fileName = path.basename(sess.localPath);
    const result = await electron.dialog.showMessageBox({
        type: "warning",
        buttons: ["Overwrite remote file", "Skip this save"],
        defaultId: 1,
        cancelId: 1,
        title: "Remote file changed",
        message: `${fileName} changed on ${sess.connName} since you opened it.`,
        detail: "Saving will replace the remote version with your local copy.",
    });
    return result.response === 0;
}

async function syncBack(sess: RemoteEditSession) {
    if (sess.uploading) {
        sess.uploadPending = true;
        return;
    }
    let bytes: Buffer;
    try {
        bytes = await fs.promises.readFile(sess.localPath);
    } catch {
        // editors that save via rename can briefly leave no file; the rename event triggers another sync
        return;
    }
    const hash = hashBytes(bytes);
    if (hash === sess.lastSyncedHash) {
        return;
    }
    console.log("remote edit: local copy changed, uploading", sess.remoteUri);
    sess.uploading = true;
    const fileName = path.basename(sess.localPath);
    try {
        const info = await RpcApi.FileInfoCommand(
            ElectronWshClient,
            { info: { path: sess.remoteUri } },
            { timeout: RemoteRpcTimeoutMs }
        );
        if (info != null && !info.notfound && (info.modtime ?? 0) !== sess.remoteModTime) {
            const overwrite = await confirmOverwriteChangedRemote(sess);
            if (!overwrite) {
                sess.lastSyncedHash = hash;
                return;
            }
        }
        await uploadRemote(sess.remoteUri, bytes);
        const after = await RpcApi.FileInfoCommand(
            ElectronWshClient,
            { info: { path: sess.remoteUri } },
            { timeout: RemoteRpcTimeoutMs }
        );
        sess.remoteModTime = after?.modtime ?? 0;
        sess.lastSyncedHash = hash;
        notify("Saved to remote", `${fileName} → ${sess.connName}`);
    } catch (err) {
        console.error("remote edit upload failed", sess.remoteUri, err);
        notify("Upload failed", `${fileName} → ${sess.connName}: ${err?.message ?? err}`);
    } finally {
        sess.uploading = false;
        if (sess.uploadPending) {
            sess.uploadPending = false;
            scheduleSync(sess);
        }
    }
}

async function openRemoteFile(
    connName: string,
    remotePath: string,
    mode: OpenExternalMode,
    editorPath: string,
    onProgress?: OpenProgressFn,
    signal?: AbortSignal
): Promise<string> {
    const remoteUri = formatRemoteUri(remotePath, connName);
    if (mode === "default" && isRunOnceFile(remotePath)) {
        return openRemoteRunOnce(remoteUri, remotePath, onProgress, signal);
    }
    let sess = remoteEditSessions.get(remoteUri);
    if (sess != null) {
        // the remote is the source of truth on every open: unsynced local edits are discarded, and a pending
        // upload of them is cancelled so it can't overwrite the remote with stale content
        if (sess.debounceTimer != null) {
            clearTimeout(sess.debounceTimer);
            sess.debounceTimer = null;
        }
        sess.uploadPending = false;
        const { hash, modTime } = await downloadRemote(remoteUri, sess.localPath, onProgress, signal);
        sess.lastSyncedHash = hash;
        sess.remoteModTime = modTime;
        return openLocalFile(sess.localPath, mode, editorPath);
    }
    const dir = path.join(remoteEditRoot(), crypto.createHash("sha256").update(remoteUri).digest("hex").slice(0, 16));
    await fs.promises.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, safeLocalName(remotePath));
    const { hash, modTime } = await downloadRemote(remoteUri, localPath, onProgress, signal);
    // watch the directory, not the file, so editors that save by writing a temp file and renaming it still sync.
    // Events aren't filtered by name: Windows can report a different case or an 8.3 short name, and syncBack
    // is hash-gated so extra triggers are harmless.
    const watcher = fs.watch(dir, () => scheduleSync(sess));
    // fs.watch is unreliable for some editors and filesystems; polling the file's stat catches what it misses
    fs.watchFile(localPath, { interval: StatPollMs }, (cur, prev) => {
        if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) {
            scheduleSync(sess);
        }
    });
    sess = {
        remoteUri,
        connName,
        localPath,
        lastSyncedHash: hash,
        remoteModTime: modTime,
        watcher,
        debounceTimer: null,
        uploading: false,
        uploadPending: false,
    };
    remoteEditSessions.set(remoteUri, sess);
    return openLocalFile(localPath, mode, editorPath);
}

export async function openFileExternal(opts: OpenFileExternalOpts, onProgress?: OpenProgressFn): Promise<string> {
    try {
        if (isLocalConn(opts.connection)) {
            return await openLocalFile(expandHome(opts.path), opts.mode, opts.editorPath);
        }
        const key = downloadKey(opts.connection, opts.path);
        const controller = new AbortController();
        activeDownloads.set(key, controller);
        try {
            return await openRemoteFile(
                opts.connection,
                opts.path,
                opts.mode,
                opts.editorPath,
                onProgress,
                controller.signal
            );
        } finally {
            activeDownloads.delete(key);
        }
    } catch (err) {
        if (isAbortError(err)) {
            return "";
        }
        const msg = `${err?.message ?? err}`;
        console.error("openFileExternal failed", opts, err);
        notify("Couldn't open file", `${path.basename(opts.path)}: ${msg}`);
        return msg;
    }
}

// remove temp copies left from earlier runs (sessions don't survive a restart)
export function cleanupOldRemoteEdits() {
    const root = remoteEditRoot();
    fs.promises
        .readdir(root, { withFileTypes: true })
        .then(async (entries) => {
            const now = Date.now();
            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const dir = path.join(root, entry.name);
                const stat = await fs.promises.stat(dir).catch(() => null);
                if (stat != null && now - stat.mtimeMs > RemoteEditMaxAgeMs) {
                    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
                }
            }
        })
        .catch(() => {});
}

export function closeRemoteEditSessions() {
    for (const sess of remoteEditSessions.values()) {
        sess.watcher.close();
        fs.unwatchFile(sess.localPath);
    }
    remoteEditSessions.clear();
}
