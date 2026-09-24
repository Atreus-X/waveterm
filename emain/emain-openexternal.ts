// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import fs from "fs";
import * as path from "path";
import { RpcApi } from "../frontend/app/store/wshclientapi";
import { formatRemoteUri } from "../frontend/util/waveutil";
import { callWithOriginalXdgCurrentDesktopAsync } from "./emain-platform";
import { ElectronWshClient } from "./emain-wsh";

// Opening files from the file browser in native apps. Local files open in place; remote files
// (ssh/wsl connections) are downloaded to a per-file temp dir, opened, and uploaded back to the
// connection every time the local copy is saved (WinSCP-style "edit").

const RemoteEditDirName = "wave-remote-edit";
const RemoteEditMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const SyncDebounceMs = 700;
const RemoteRpcTimeoutMs = 60000;

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
    const base = remotePath.split("/").filter((p) => p !== "").pop() || "file";
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
    let excuse = "";
    await callWithOriginalXdgCurrentDesktopAsync(async () => {
        excuse = await electron.shell.openPath(localPath);
    });
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

async function downloadRemote(remoteUri: string, localPath: string): Promise<{ hash: string; modTime: number }> {
    const info = await RpcApi.FileInfoCommand(ElectronWshClient, { info: { path: remoteUri } }, { timeout: RemoteRpcTimeoutMs });
    if (info == null || info.notfound) {
        throw new Error("file not found on remote");
    }
    if (info.isdir) {
        throw new Error("cannot open a directory in an external application");
    }
    const fileData = await RpcApi.FileReadCommand(ElectronWshClient, { info: { path: remoteUri } }, { timeout: RemoteRpcTimeoutMs });
    const bytes = Buffer.from(fileData?.data64 ?? "", "base64");
    await fs.promises.writeFile(localPath, bytes);
    return { hash: hashBytes(bytes), modTime: info.modtime ?? 0 };
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
    sess.uploading = true;
    const fileName = path.basename(sess.localPath);
    try {
        const info = await RpcApi.FileInfoCommand(ElectronWshClient, { info: { path: sess.remoteUri } }, { timeout: RemoteRpcTimeoutMs });
        if (info != null && !info.notfound && (info.modtime ?? 0) !== sess.remoteModTime) {
            const overwrite = await confirmOverwriteChangedRemote(sess);
            if (!overwrite) {
                sess.lastSyncedHash = hash;
                return;
            }
        }
        await RpcApi.FileWriteCommand(
            ElectronWshClient,
            { info: { path: sess.remoteUri }, data64: bytes.toString("base64") },
            { timeout: RemoteRpcTimeoutMs }
        );
        const after = await RpcApi.FileInfoCommand(ElectronWshClient, { info: { path: sess.remoteUri } }, { timeout: RemoteRpcTimeoutMs });
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

async function openRemoteFile(connName: string, remotePath: string, mode: OpenExternalMode, editorPath: string): Promise<string> {
    const remoteUri = formatRemoteUri(remotePath, connName);
    let sess = remoteEditSessions.get(remoteUri);
    if (sess != null) {
        // reuse the local copy; refresh it from the remote only if there are no unsynced local edits
        const localBytes = await fs.promises.readFile(sess.localPath).catch(() => null);
        const clean = localBytes != null && hashBytes(localBytes) === sess.lastSyncedHash && !sess.uploading;
        if (clean) {
            const { hash, modTime } = await downloadRemote(remoteUri, sess.localPath);
            sess.lastSyncedHash = hash;
            sess.remoteModTime = modTime;
        }
        return openLocalFile(sess.localPath, mode, editorPath);
    }
    const dir = path.join(remoteEditRoot(), crypto.createHash("sha256").update(remoteUri).digest("hex").slice(0, 16));
    await fs.promises.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, safeLocalName(remotePath));
    const { hash, modTime } = await downloadRemote(remoteUri, localPath);
    const localName = path.basename(localPath);
    // watch the directory, not the file, so editors that save by writing a temp file and renaming it still sync
    const watcher = fs.watch(dir, (_event, changed) => {
        if (changed == null || changed.toString() === localName) {
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

export async function openFileExternal(opts: OpenFileExternalOpts): Promise<string> {
    try {
        if (isLocalConn(opts.connection)) {
            return await openLocalFile(expandHome(opts.path), opts.mode, opts.editorPath);
        }
        return await openRemoteFile(opts.connection, opts.path, opts.mode, opts.editorPath);
    } catch (err) {
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
    }
    remoteEditSessions.clear();
}
