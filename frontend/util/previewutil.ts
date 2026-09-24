import { createBlock, getApi, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { isWindows, makeNativeLabel } from "./platformutil";
import { fireAndForget } from "./util";
import { formatRemoteUri } from "./waveutil";

function getConfiguredEditorPath(): string {
    return globalStore.get(getSettingsKeyAtom("preview:externaleditor")) ?? "";
}

// Opens a file in a native app. Remote files are edited locally and synced back on save (see emain-openexternal.ts).
export function openFileExternally(path: string, conn: string, mode: OpenExternalMode) {
    fireAndForget(() =>
        getApi().openFileExternal({ path, connection: conn ?? "", mode, editorPath: getConfiguredEditorPath() })
    );
}

function addExternalOpenItems(menu: ContextMenuItem[], conn: string, finfo: FileInfo) {
    const remoteSuffix = conn ? " (edit locally)" : "";
    menu.push({
        label: conn ? "Open in Default Application" + remoteSuffix : makeNativeLabel(false),
        click: () => openFileExternally(finfo.path, conn, "default"),
    });
    const editor = getApi().getExternalEditor(getConfiguredEditorPath());
    if (editor != null) {
        menu.push({
            label: `Open in ${editor.name}${remoteSuffix}`,
            click: () => openFileExternally(finfo.path, conn, "editor"),
        });
    }
    if (isWindows()) {
        menu.push({
            label: "Open With…" + remoteSuffix,
            click: () => openFileExternally(finfo.path, conn, "openwith"),
        });
    }
}

export function addOpenMenuItems(menu: ContextMenuItem[], conn: string, finfo: FileInfo): ContextMenuItem[] {
    if (!finfo) {
        return menu;
    }
    menu.push({
        type: "separator",
    });
    if (!conn) {
        // TODO:  resolve correct host path if connection is WSL
        // if the entry is a directory, reveal it in the file manager, if the entry is a file, reveal its parent directory
        menu.push({
            label: makeNativeLabel(true),
            click: () => {
                getApi().openNativePath(finfo.isdir ? finfo.path : finfo.dir);
            },
        });
        if (!finfo.isdir) {
            addExternalOpenItems(menu, conn, finfo);
        }
    } else {
        if (!finfo.isdir) {
            addExternalOpenItems(menu, conn, finfo);
        }
        menu.push({
            label: "Download File",
            click: () => {
                const remoteUri = formatRemoteUri(finfo.path, conn);
                getApi().downloadFile(remoteUri);
            },
        });
    }
    menu.push({
        type: "separator",
    });
    if (!finfo.isdir) {
        menu.push({
            label: "Open Preview in New Block",
            click: () =>
                fireAndForget(async () => {
                    const blockDef: BlockDef = {
                        meta: {
                            view: "preview",
                            file: finfo.path,
                            connection: conn,
                        },
                    };
                    await createBlock(blockDef);
                }),
        });
    }
    menu.push({
        label: "Open Terminal Here",
        click: () => {
            const termBlockDef: BlockDef = {
                meta: {
                    controller: "shell",
                    view: "term",
                    "cmd:cwd": finfo.isdir ? finfo.path : finfo.dir,
                    connection: conn,
                },
            };
            fireAndForget(() => createBlock(termBlockDef));
        },
    });
    return menu;
}
