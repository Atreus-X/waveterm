// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { OpenExternalProgressModel } from "@/app/store/openexternal-progress";
import { openProgressFraction, openProgressKey, openProgressLabel } from "@/app/store/openexternal-progress-util";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { checkKeyPressed, isCharacterKeyEvent } from "@/util/keyutil";
import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { addOpenMenuItems, openFileExternally, openPreviewInNewBlock } from "@/util/previewutil";
import { isTextCapableFile } from "@/util/textfiles";
import { cn, fireAndForget } from "@/util/util";
import { formatRemoteUri } from "@/util/waveutil";
import { offset, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import {
    Header,
    Row,
    RowData,
    Table,
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    useReactTable,
} from "@tanstack/react-table";
import clsx from "clsx";
import { PrimitiveAtom, atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { OverlayScrollbarsComponent, OverlayScrollbarsComponentRef } from "overlayscrollbars-react";
import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { NativeTypes } from "react-dnd-html5-backend";
import { quote as shellQuote } from "shell-quote";
import { debounce } from "throttle-debounce";
import {
    clickSelection,
    contextTargets,
    extendSelection,
    keepSelection,
    selectAll,
    toggleFocused,
    zipNameFor,
} from "./dir-selection";
import "./directorypreview.scss";
import { EntryManagerOverlay, EntryManagerOverlayProps, EntryManagerType } from "./entry-manager";
import {
    cleanMimetype,
    confirmMultiDelete,
    getBestUnit,
    getLastModifiedTime,
    getSortIcon,
    handleFileDelete,
    handleRename,
    isIconValid,
    makeDirectoryDefaultMenuItems,
    mergeError,
    overwriteError,
} from "./preview-directory-utils";
import { type PreviewModel } from "./preview-model";
import type { PreviewEnv } from "./previewenv";

const PageJumpSize = 20;

interface DirectoryTableHeaderCellProps {
    header: Header<FileInfo, unknown>;
}

function DirectoryTableHeaderCell({ header }: DirectoryTableHeaderCellProps) {
    return (
        <div
            className="dir-table-head-cell"
            key={header.id}
            style={{ width: `calc(var(--header-${header.id}-size) * 1px)` }}
        >
            <div className="dir-table-head-cell-content" onClick={() => header.column.toggleSorting()}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                {getSortIcon(header.column.getIsSorted())}
            </div>
            <div className="dir-table-head-resize-box">
                <div
                    className="dir-table-head-resize"
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                />
            </div>
        </div>
    );
}

declare module "@tanstack/react-table" {
    interface TableMeta<TData extends RowData> {
        updateName: (path: string, isDir: boolean) => void;
        newFile: () => void;
        newDirectory: () => void;
    }
}

interface DirectoryTableProps {
    model: PreviewModel;
    data: FileInfo[];
    search: string;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    setSearch: (_: string) => void;
    setSelectedPath: (_: string) => void;
    setRefreshVersion: React.Dispatch<React.SetStateAction<number>>;
    entryManagerOverlayPropsAtom: PrimitiveAtom<EntryManagerOverlayProps>;
    newFile: () => void;
    newDirectory: () => void;
}

const columnHelper = createColumnHelper<FileInfo>();

// Rendering and keyboard selection must agree on row order, so both go through this.
// Folders are partitioned after sorting (not via sortingFn) so they stay on top in either sort direction.
function getDisplayRows(table: Table<FileInfo>, dirsFirst: boolean): Row<FileInfo>[] {
    const allRows = table.getRowModel().flatRows;
    const dotdotRow = allRows.find((row) => row.original.name === "..");
    let otherRows = allRows.filter((row) => row.original.name !== "..");
    if (dirsFirst) {
        otherRows = [
            ...otherRows.filter((row) => row.original.isdir),
            ...otherRows.filter((row) => !row.original.isdir),
        ];
    }
    return dotdotRow ? [dotdotRow, ...otherRows] : otherRows;
}

function DirectoryTable({
    model,
    data,
    search,
    focusIndex,
    setFocusIndex,
    setSearch,
    setSelectedPath,
    setRefreshVersion,
    entryManagerOverlayPropsAtom,
    newFile,
    newDirectory,
}: DirectoryTableProps) {
    const env = useWaveEnv<PreviewEnv>();
    const fullConfig = useAtomValue(env.atoms.fullConfigAtom);
    const defaultSort = useAtomValue(env.getSettingsKeyAtom("preview:defaultsort")) ?? "name";
    const dirsFirst = useAtomValue(env.getSettingsKeyAtom("preview:dirsfirst")) ?? true;
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const getIconFromMimeType = useCallback(
        (mimeType: string): string => {
            while (mimeType.length > 0) {
                const icon = fullConfig.mimetypes?.[mimeType]?.icon ?? null;
                if (isIconValid(icon)) {
                    return `fa fa-solid fa-${icon} fa-fw`;
                }
                mimeType = mimeType.slice(0, -1);
            }
            return "fa fa-solid fa-file fa-fw";
        },
        [fullConfig.mimetypes]
    );
    const getIconColor = useCallback(
        (mimeType: string): string => fullConfig.mimetypes?.[mimeType]?.color ?? "inherit",
        [fullConfig.mimetypes]
    );
    const columns = useMemo(
        () => [
            columnHelper.accessor("mimetype", {
                cell: (info) => (
                    <i
                        className={getIconFromMimeType(info.getValue() ?? "")}
                        style={{ color: getIconColor(info.getValue() ?? "") }}
                    ></i>
                ),
                header: () => <span></span>,
                id: "logo",
                size: 25,
                enableSorting: false,
            }),
            columnHelper.accessor("name", {
                cell: (info) => <span className="dir-table-name ellipsis">{info.getValue()}</span>,
                header: () => <span className="dir-table-head-name">Name</span>,
                sortingFn: "alphanumeric",
                size: 200,
                minSize: 90,
            }),
            columnHelper.accessor("modestr", {
                cell: (info) => <span className="dir-table-modestr">{info.getValue()}</span>,
                header: () => <span>Perm</span>,
                size: 91,
                minSize: 90,
                sortingFn: "alphanumeric",
            }),
            columnHelper.accessor("modtime", {
                cell: (info) => <span className="dir-table-lastmod">{getLastModifiedTime(info.getValue())}</span>,
                header: () => <span>Last Modified</span>,
                size: 91,
                minSize: 65,
                sortingFn: "datetime",
            }),
            columnHelper.accessor("size", {
                cell: (info) => <span className="dir-table-size">{getBestUnit(info.getValue())}</span>,
                header: () => <span className="dir-table-head-size">Size</span>,
                size: 55,
                minSize: 50,
                sortingFn: "auto",
            }),
            columnHelper.accessor("mimetype", {
                cell: (info) => <span className="dir-table-type ellipsis">{cleanMimetype(info.getValue() ?? "")}</span>,
                header: () => <span className="dir-table-head-type">Type</span>,
                size: 97,
                minSize: 97,
                sortingFn: "alphanumeric",
            }),
            columnHelper.accessor("path", {}),
        ],
        [fullConfig]
    );

    const setEntryManagerProps = useSetAtom(entryManagerOverlayPropsAtom);

    const updateName = useCallback(
        (path: string, isDir: boolean) => {
            const fileName = path.split("/").at(-1);
            setEntryManagerProps({
                entryManagerType: EntryManagerType.EditName,
                startingValue: fileName,
                onSave: (newName: string) => {
                    let newPath: string;
                    if (newName !== fileName) {
                        const lastInstance = path.lastIndexOf(fileName);
                        newPath = path.substring(0, lastInstance) + newName;
                        console.log(`replacing ${fileName} with ${newName}: ${path}`);
                        handleRename(model, path, newPath, isDir, setErrorMsg);
                    }
                    setEntryManagerProps(undefined);
                },
            });
        },
        [model, setErrorMsg]
    );

    const initialSorting = defaultSort === "modtime" ? [{ id: "modtime", desc: true }] : [{ id: "name", desc: false }];

    const table = useReactTable({
        data,
        columns,
        columnResizeMode: "onChange",
        getSortedRowModel: getSortedRowModel(),
        getCoreRowModel: getCoreRowModel(),

        initialState: {
            sorting: initialSorting,
            columnVisibility: {
                path: false,
            },
        },
        enableMultiSort: false,
        enableSortingRemoval: false,
        meta: {
            updateName,
            newFile,
            newDirectory,
        },
    });
    const sortingState = table.getState().sorting;
    useEffect(() => {
        const rows = getDisplayRows(table, dirsFirst);
        setSelectedPath((rows[focusIndex]?.getValue("path") as string) ?? null);
    }, [focusIndex, data, setSelectedPath, sortingState, dirsFirst]);

    const columnSizeVars = useMemo(() => {
        const headers = table.getFlatHeaders();
        const colSizes: { [key: string]: number } = {};
        for (let i = 0; i < headers.length; i++) {
            const header = headers[i]!;
            colSizes[`--header-${header.id}-size`] = header.getSize();
            colSizes[`--col-${header.column.id}-size`] = header.column.getSize();
        }
        return colSizes;
    }, [table.getState().columnSizingInfo]);

    const osRef = useRef<OverlayScrollbarsComponentRef>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const [scrollHeight, setScrollHeight] = useState(0);

    const onScroll = useCallback(
        debounce(2, () => {
            setScrollHeight(osRef.current.osInstance().elements().viewport.scrollTop);
        }),
        []
    );

    const TableComponent = table.getState().columnSizingInfo.isResizingColumn ? MemoizedTableBody : TableBody;

    return (
        <OverlayScrollbarsComponent
            options={{ scrollbars: { autoHide: "leave" } }}
            events={{ scroll: onScroll }}
            className="dir-table"
            style={{ ...columnSizeVars }}
            ref={osRef}
            data-scroll-height={scrollHeight}
        >
            <div className="dir-table-head">
                {table.getHeaderGroups().map((headerGroup) => (
                    <div className="dir-table-head-row" key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                            <DirectoryTableHeaderCell key={header.id} header={header} />
                        ))}
                    </div>
                ))}
            </div>
            <TableComponent
                bodyRef={bodyRef}
                model={model}
                data={data}
                table={table}
                search={search}
                focusIndex={focusIndex}
                setFocusIndex={setFocusIndex}
                setSearch={setSearch}
                setSelectedPath={setSelectedPath}
                setRefreshVersion={setRefreshVersion}
                osRef={osRef.current}
                dirsFirst={dirsFirst}
            />
        </OverlayScrollbarsComponent>
    );
}

interface TableBodyProps {
    bodyRef: React.RefObject<HTMLDivElement>;
    model: PreviewModel;
    data: Array<FileInfo>;
    table: Table<FileInfo>;
    search: string;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    setSearch: (_: string) => void;
    setSelectedPath: (_: string) => void;
    setRefreshVersion: React.Dispatch<React.SetStateAction<number>>;
    osRef: OverlayScrollbarsComponentRef;
    dirsFirst: boolean;
}

function TableBody({
    bodyRef,
    model,
    table,
    search,
    focusIndex,
    setFocusIndex,
    setSearch,
    setRefreshVersion,
    osRef,
    dirsFirst,
}: TableBodyProps) {
    const searchActive = useAtomValue(model.directorySearchActive);
    const dummyLineRef = useRef<HTMLDivElement>(null);
    const warningBoxRef = useRef<HTMLDivElement>(null);
    const conn = useAtomValue(model.connection);
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const env = useWaveEnv<PreviewEnv>();
    const selection = useAtomValue(model.dirSelectionAtom);
    const dirPath = useAtomValue(model.statFilePath);
    const displayRows = getDisplayRows(table, dirsFirst);
    useEffect(() => {
        model.dirDisplayPaths = displayRows.map((r) => r.getValue("path") as string);
    });

    const onRowClick = useCallback(
        (e: React.MouseEvent, idx: number) => {
            const paths = displayRows.map((r) => r.getValue("path") as string);
            const r = clickSelection(
                paths,
                globalStore.get(model.dirSelectionAtom),
                focusIndex,
                model.dirSelectionAnchor,
                idx,
                { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey }
            );
            model.dirSelectionAnchor = r.anchor;
            globalStore.set(model.dirSelectionAtom, r.selection);
            setFocusIndex(idx);
        },
        [displayRows, focusIndex, model, setFocusIndex]
    );

    const downloadZip = useCallback(
        (targets: string[]) => {
            const uris = targets.map((p) => formatRemoteUri(p, conn || "local"));
            env.electron.downloadZip(uris, zipNameFor(targets, dirPath));
        },
        [conn, dirPath, env]
    );

    useEffect(() => {
        if (focusIndex === null || !bodyRef.current || !osRef) {
            return;
        }

        const rowElement = bodyRef.current.querySelector(`[data-rowindex="${focusIndex}"]`) as HTMLDivElement;
        if (!rowElement) {
            return;
        }

        const viewport = osRef.osInstance().elements().viewport;
        const viewportHeight = viewport.offsetHeight;
        const rowRect = rowElement.getBoundingClientRect();
        const parentRect = viewport.getBoundingClientRect();
        const viewportScrollTop = viewport.scrollTop;
        const rowTopRelativeToViewport = rowRect.top - parentRect.top + viewport.scrollTop;
        const rowBottomRelativeToViewport = rowRect.bottom - parentRect.top + viewport.scrollTop;

        if (rowTopRelativeToViewport - 30 < viewportScrollTop) {
            // Row is above the visible area
            let topVal = rowTopRelativeToViewport - 30;
            if (topVal < 0) {
                topVal = 0;
            }
            viewport.scrollTo({ top: topVal });
        } else if (rowBottomRelativeToViewport + 5 > viewportScrollTop + viewportHeight) {
            // Row is below the visible area
            const topVal = rowBottomRelativeToViewport - viewportHeight + 5;
            viewport.scrollTo({ top: topVal });
        }
    }, [focusIndex]);

    const handleFileContextMenu = useCallback(
        async (e: any, finfo: FileInfo) => {
            e.preventDefault();
            e.stopPropagation();
            if (finfo == null) {
                return;
            }
            const currentSelection = globalStore.get(model.dirSelectionAtom);
            const targets = contextTargets(currentSelection, finfo.path);
            if (targets.length > 1) {
                const names = targets.map((p) => p.split("/").pop());
                ContextMenuModel.getInstance().showContextMenu(
                    [
                        { label: `Download ${targets.length} Items as Zip`, click: () => downloadZip(targets) },
                        { type: "separator" },
                        {
                            label: "Copy File Names",
                            click: () => fireAndForget(() => navigator.clipboard.writeText(names.join("\n"))),
                        },
                        {
                            label: "Copy Full File Names",
                            click: () => fireAndForget(() => navigator.clipboard.writeText(targets.join("\n"))),
                        },
                        {
                            label: "Copy File Names (Shell Quoted)",
                            click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote(names))),
                        },
                        { type: "separator" },
                        {
                            label: `Delete ${targets.length} Items…`,
                            click: () => confirmMultiDelete(model, targets, setErrorMsg),
                        },
                    ],
                    e
                );
                return;
            }
            if (currentSelection.length > 0 && !currentSelection.includes(finfo.path)) {
                globalStore.set(model.dirSelectionAtom, []);
            }
            const fileName = finfo.path.split("/").pop();
            const menu: ContextMenuItem[] = [
                {
                    label: "New File",
                    click: () => {
                        table.options.meta.newFile();
                    },
                },
                {
                    label: "New Folder",
                    click: () => {
                        table.options.meta.newDirectory();
                    },
                },
                {
                    label: "Rename",
                    click: () => {
                        table.options.meta.updateName(finfo.path, finfo.isdir);
                    },
                },
                {
                    type: "separator",
                },
                {
                    label: "Copy File Name",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(fileName)),
                },
                {
                    label: "Copy Full File Name",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(finfo.path)),
                },
                {
                    label: "Copy File Name (Shell Quoted)",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([fileName]))),
                },
                {
                    label: "Copy Full File Name (Shell Quoted)",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([finfo.path]))),
                },
            ];
            addOpenMenuItems(menu, conn, finfo);
            if (finfo.name !== "..") {
                menu.push({ label: "Download as Zip", click: () => downloadZip([finfo.path]) });
            }
            menu.push(
                {
                    type: "separator",
                },
                {
                    label: "Default Settings",
                    submenu: makeDirectoryDefaultMenuItems(model),
                },
                {
                    type: "separator",
                },
                {
                    label: "Delete",
                    click: () => handleFileDelete(model, finfo.path, false, setErrorMsg),
                }
            );
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        [setRefreshVersion, conn, downloadZip]
    );

    return (
        <div className="dir-table-body" ref={bodyRef}>
            {(searchActive || search !== "") && (
                <div className="flex rounded-[3px] py-1 px-2 bg-warning text-black" ref={warningBoxRef}>
                    <span>{search === "" ? "Type to search (Esc to cancel)" : `Searching for "${search}"`}</span>
                    <div
                        className="ml-auto bg-transparent flex justify-center items-center flex-col p-0.5 rounded-md hover:bg-hoverbg focus:bg-hoverbg focus-within:bg-hoverbg cursor-pointer"
                        onClick={() => {
                            setSearch("");
                            globalStore.set(model.directorySearchActive, false);
                        }}
                    >
                        <i className="fa-solid fa-xmark" />
                        <input
                            type="text"
                            value={search}
                            onChange={() => {}}
                            className="w-0 h-0 opacity-0 p-0 border-none pointer-events-none"
                        />
                    </div>
                </div>
            )}
            <div className="dir-table-body-scroll-box">
                <div className="dummy dir-table-body-row" ref={dummyLineRef}>
                    <div className="dir-table-body-cell">dummy-data</div>
                </div>
                {displayRows.map((row, idx) => (
                    <TableRow
                        model={model}
                        row={row}
                        focusIndex={focusIndex}
                        setFocusIndex={setFocusIndex}
                        setSearch={setSearch}
                        idx={idx}
                        selected={selection.includes(row.getValue("path") as string)}
                        onRowClick={onRowClick}
                        handleFileContextMenu={handleFileContextMenu}
                        key={row.original.name === ".." ? "dotdot" : idx}
                    />
                ))}
            </div>
        </div>
    );
}

type TableRowProps = {
    model: PreviewModel;
    row: Row<FileInfo>;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    setSearch: (_: string) => void;
    idx: number;
    selected: boolean;
    onRowClick: (e: React.MouseEvent, idx: number) => void;
    handleFileContextMenu: (e: any, finfo: FileInfo) => Promise<void>;
};

function TableRow({
    model,
    row,
    focusIndex,
    setSearch,
    idx,
    selected,
    onRowClick,
    handleFileContextMenu,
}: TableRowProps) {
    const env = useWaveEnv<PreviewEnv>();
    const dirPath = useAtomValue(model.statFilePath);
    const connection = useAtomValue(model.connection);
    const doubleClickOpen = useAtomValue(env.getSettingsKeyAtom("preview:doubleclickopen")) ?? "auto";

    const dragItem: DraggedFile = {
        relName: row.getValue("name") as string,
        absParent: dirPath,
        uri: formatRemoteUri(row.getValue("path") as string, connection),
        isDir: row.original.isdir,
    };
    const [_, drag] = useDrag(
        () => ({
            type: "FILE_ITEM",
            canDrag: true,
            item: () => dragItem,
        }),
        [dragItem]
    );

    const dragRef = useCallback(
        (node: HTMLDivElement | null) => {
            drag(node);
        },
        [drag]
    );

    return (
        <div
            className={clsx("dir-table-body-row relative", { focused: focusIndex === idx, selected })}
            data-rowindex={idx}
            onDoubleClick={() => {
                const newFileName = row.getValue("path") as string;
                if (!row.original.isdir && doubleClickOpen === "auto") {
                    if (isTextCapableFile(row.original.name, row.original.mimetype)) {
                        openPreviewInNewBlock(newFileName, connection);
                        return;
                    }
                    openFileExternally(newFileName, connection, "default");
                    return;
                }
                if (!row.original.isdir && doubleClickOpen === "external") {
                    openFileExternally(newFileName, connection, "default");
                    return;
                }
                model.goHistory(newFileName);
                setSearch("");
                globalStore.set(model.directorySearchActive, false);
            }}
            onMouseDown={(e) => {
                // shift-click would otherwise select the row text
                if (e.shiftKey) e.preventDefault();
            }}
            onClick={(e) => onRowClick(e, idx)}
            onContextMenu={(e) => handleFileContextMenu(e, row.original)}
            ref={dragRef}
        >
            {row.getVisibleCells().map((cell) => (
                <div
                    className={clsx("dir-table-body-cell", "col-" + cell.column.id)}
                    key={cell.id}
                    style={{ width: `calc(var(--col-${cell.column.id}-size) * 1px)` }}
                >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
            ))}
        </div>
    );
}

type UploadProgress = { name: string; done: number; total: number };

// shown at the bottom left of the block while remote files download to open in an external app
const OpenProgressList = React.memo(({ connection, upload }: { connection: string; upload: UploadProgress }) => {
    const progressMap = useAtomValue(OpenExternalProgressModel.getInstance().progressAtom);
    // matched by connection only: the opened file's path and this block's folder path aren't always written the
    // same way (separators, "~"), which silently hid the bar
    const items = Object.values(progressMap).filter((p) => (p.connection ?? "") === (connection ?? ""));
    if (items.length === 0 && upload == null) {
        return null;
    }
    return (
        <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex max-w-[90%] flex-col gap-1">
            {upload != null && (
                <div className="rounded bg-panel/90 px-2 py-1 text-[11px]">
                    <div className="truncate text-accent" title={upload.name}>
                        Uploading {upload.name}
                        {upload.total > 1 ? ` (${upload.done + 1} of ${upload.total})` : ""}
                    </div>
                    <div className="mt-1 h-[2px] overflow-hidden rounded bg-white/10">
                        <div
                            className={clsx(
                                "h-full bg-accent transition-[width] duration-150",
                                upload.total <= 1 && "w-1/3 animate-pulse"
                            )}
                            style={upload.total > 1 ? { width: `${(upload.done / upload.total) * 100}%` } : undefined}
                        />
                    </div>
                </div>
            )}
            {items.map((p) => {
                const frac = openProgressFraction(p);
                const isError = p.phase === "error";
                const label = openProgressLabel(p);
                return (
                    <div
                        key={openProgressKey(p.connection, p.path)}
                        className="rounded bg-panel/90 px-2 py-1 text-[11px]"
                    >
                        <div className={clsx("truncate", isError ? "text-error" : "text-accent")} title={label}>
                            {p.path.split("/").pop()}: {label}
                        </div>
                        <div className="mt-1 h-[2px] overflow-hidden rounded bg-white/10">
                            <div
                                className={clsx(
                                    "h-full transition-[width] duration-150",
                                    isError ? "bg-error" : "bg-accent",
                                    frac == null && !isError && "w-1/3 animate-pulse"
                                )}
                                style={
                                    frac != null || isError ? { width: `${isError ? 100 : frac * 100}%` } : undefined
                                }
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
});
OpenProgressList.displayName = "OpenProgressList";

const MemoizedTableBody = React.memo(
    TableBody,
    (prev, next) => prev.table.options.data == next.table.options.data
) as typeof TableBody;

// editable path on its own line between the block header and the column names; the header would crowd it
// out next to a connection chip
const DirectoryPathBar = React.memo(({ model }: { model: PreviewModel }) => {
    const displayPath = useAtomValue(model.displayPath);
    const pathDraft = useAtomValue(model.pathDraft);
    const suggestions = useAtomValue(model.pathSuggestions);
    const suggestIndex = useAtomValue(model.pathSuggestIndex);
    const pathError = useAtomValue(model.pathError);
    const editing = pathDraft != null;
    return (
        <div className="relative shrink-0 border-b border-border px-2 py-[3px]">
            <input
                ref={model.pathInputRef}
                className={cn(
                    "w-full bg-transparent border-none outline-none font-mono text-[11px] rounded-sm cursor-text",
                    "hover:bg-hover focus:bg-hover",
                    editing ? "opacity-100" : "opacity-70"
                )}
                // rtl keeps the end of a long path visible; the leading LRM stops it reordering the leading "/"
                style={editing ? undefined : { direction: "rtl", textAlign: "left" }}
                value={pathDraft ?? "\u200e" + displayPath}
                onChange={(e) => model.handlePathChange(e.target.value)}
                onKeyDown={(e) => model.handlePathKeyDown(e)}
                onFocus={(e) => model.handlePathFocus(e)}
                onBlur={() => model.handlePathBlur()}
                onClick={(e) => e.stopPropagation()}
            />
            {pathError != null && <div className="px-0.5 pt-[2px] text-[11px] text-error">{pathError}</div>}
            {editing && suggestions.length > 0 && (
                <div
                    className="absolute left-2 right-2 top-full z-20 max-h-60 overflow-y-auto rounded border border-border bg-panel py-1 shadow-lg"
                    // keeps focus in the input so a click doesn't trigger the blur that closes the list
                    onMouseDown={(e) => e.preventDefault()}
                >
                    {suggestions.map((s, i) => (
                        <div
                            key={s.name}
                            ref={i == suggestIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                            className={cn(
                                "flex items-center gap-2 px-2 py-[2px] font-mono text-[11px] cursor-pointer hover:bg-hover",
                                i == suggestIndex && "bg-hover"
                            )}
                            onClick={() => model.acceptPathSuggestion(s)}
                        >
                            <i className={cn("fa-solid w-3 opacity-60", s.isdir ? "fa-folder" : "fa-file")} />
                            <span className="truncate">{s.name}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
});
DirectoryPathBar.displayName = "DirectoryPathBar";

interface DirectoryPreviewProps {
    model: PreviewModel;
}

function DirectoryPreview({ model }: DirectoryPreviewProps) {
    const env = useWaveEnv<PreviewEnv>();
    const [searchText, setSearchText] = useState("");
    const [focusIndex, setFocusIndex] = useState(0);
    const [unfilteredData, setUnfilteredData] = useState<FileInfo[]>([]);
    const showHiddenFiles = useAtomValue(model.showHiddenFiles);
    const [selectedPath, setSelectedPath] = useState("");
    const [refreshVersion, setRefreshVersion] = useAtom(model.refreshVersion);
    const conn = useAtomValue(model.connection);
    const blockData = useAtomValue(model.blockAtom);
    const finfo = useAtomValue(model.statFile);
    const dirPath = finfo?.path;
    const setErrorMsg = useSetAtom(model.errorMsgAtom);

    useEffect(() => {
        globalStore.set(model.dirSelectionAtom, []);
    }, [dirPath]);

    useEffect(() => {
        model.refreshCallback = () => {
            setRefreshVersion((refreshVersion) => refreshVersion + 1);
        };
        return () => {
            model.refreshCallback = null;
        };
    }, [setRefreshVersion]);

    useEffect(
        () =>
            fireAndForget(async () => {
                const entries: FileInfo[] = [];
                try {
                    const remotePath = await model.formatRemoteUri(dirPath, globalStore.get);
                    const stream = env.rpc.FileListStreamCommand(TabRpcClient, { path: remotePath }, null);
                    for await (const chunk of stream) {
                        if (chunk?.fileinfo) {
                            entries.push(...chunk.fileinfo);
                        }
                    }
                    if (finfo?.dir && finfo?.path !== finfo?.dir) {
                        entries.unshift({
                            name: "..",
                            path: finfo.dir,
                            isdir: true,
                            modtime: new Date().getTime(),
                            mimetype: "directory",
                        });
                    }
                } catch (e) {
                    console.error("Directory Read Error", e);
                    setErrorMsg({
                        status: "Cannot Read Directory",
                        text: `${e}`,
                    });
                }
                setUnfilteredData(entries);
            }),
        [conn, dirPath, refreshVersion]
    );

    const filteredData = useMemo(
        () =>
            unfilteredData?.filter((fileInfo) => {
                if (fileInfo.name == null) {
                    console.log("fileInfo.name is null", fileInfo);
                    return false;
                }
                if (!showHiddenFiles && fileInfo.name.startsWith(".") && fileInfo.name != "..") {
                    return false;
                }
                return fileInfo.name.toLowerCase().includes(searchText);
            }) ?? [],
        [unfilteredData, showHiddenFiles, searchText]
    );

    useEffect(() => {
        model.directoryKeyDownHandler = (waveEvent: WaveKeyboardEvent): boolean => {
            if (checkKeyPressed(waveEvent, "Cmd:f")) {
                globalStore.set(model.directorySearchActive, true);
                return true;
            }
            // Wave's "Cmd" is Alt on Windows/Linux; file selection uses Ctrl there, like other file managers
            const selMod = PLATFORM == PlatformMacOS ? "Cmd" : "Ctrl";
            if (checkKeyPressed(waveEvent, `${selMod}:a`)) {
                globalStore.set(model.dirSelectionAtom, selectAll(filteredData.map((f) => f.path)));
                return true;
            }
            const lastIdx = filteredData.length - 1;
            const moves: [string, (idx: number) => number][] = [
                ["ArrowUp", (idx) => Math.max(idx - 1, 0)],
                ["ArrowDown", (idx) => Math.min(idx + 1, lastIdx)],
                ["PageUp", (idx) => Math.max(idx - PageJumpSize, 0)],
                ["PageDown", (idx) => Math.min(idx + PageJumpSize, lastIdx)],
            ];
            for (const [key, step] of moves) {
                if (checkKeyPressed(waveEvent, `Shift:${key}`)) {
                    const newIdx = step(focusIndex);
                    const r = extendSelection(
                        model.dirDisplayPaths,
                        globalStore.get(model.dirSelectionAtom),
                        focusIndex,
                        model.dirSelectionAnchor,
                        newIdx
                    );
                    model.dirSelectionAnchor = r.anchor;
                    globalStore.set(model.dirSelectionAtom, r.selection);
                    setFocusIndex(newIdx);
                    return true;
                }
                if (checkKeyPressed(waveEvent, `${selMod}:${key}`)) {
                    globalStore.set(
                        model.dirSelectionAtom,
                        keepSelection(model.dirDisplayPaths, globalStore.get(model.dirSelectionAtom), focusIndex)
                    );
                    setFocusIndex(step(focusIndex));
                    return true;
                }
            }
            if (checkKeyPressed(waveEvent, `${selMod}:Space`)) {
                globalStore.set(
                    model.dirSelectionAtom,
                    toggleFocused(model.dirDisplayPaths, globalStore.get(model.dirSelectionAtom), focusIndex)
                );
                model.dirSelectionAnchor = focusIndex;
                return true;
            }
            if (checkKeyPressed(waveEvent, "Escape")) {
                setSearchText("");
                globalStore.set(model.directorySearchActive, false);
                globalStore.set(model.dirSelectionAtom, []);
                return;
            }
            if (checkKeyPressed(waveEvent, "ArrowUp")) {
                globalStore.set(model.dirSelectionAtom, []);
                setFocusIndex((idx) => Math.max(idx - 1, 0));
                return true;
            }
            if (checkKeyPressed(waveEvent, "ArrowDown")) {
                globalStore.set(model.dirSelectionAtom, []);
                setFocusIndex((idx) => Math.min(idx + 1, filteredData.length - 1));
                return true;
            }
            if (checkKeyPressed(waveEvent, "PageUp")) {
                setFocusIndex((idx) => Math.max(idx - PageJumpSize, 0));
                return true;
            }
            if (checkKeyPressed(waveEvent, "PageDown")) {
                setFocusIndex((idx) => Math.min(idx + PageJumpSize, filteredData.length - 1));
                return true;
            }
            if (checkKeyPressed(waveEvent, "Enter")) {
                if (filteredData.length == 0) {
                    return;
                }
                model.goHistory(selectedPath);
                setSearchText("");
                globalStore.set(model.directorySearchActive, false);
                return true;
            }
            if (checkKeyPressed(waveEvent, "Delete")) {
                const selection = globalStore.get(model.dirSelectionAtom);
                if (selection.length > 1) {
                    confirmMultiDelete(model, selection, setErrorMsg);
                    return true;
                }
            }
            if (checkKeyPressed(waveEvent, "Backspace")) {
                if (searchText.length == 0) {
                    return true;
                }
                setSearchText((current) => current.slice(0, -1));
                return true;
            }
            if (
                checkKeyPressed(waveEvent, "Space") &&
                searchText == "" &&
                PLATFORM == PlatformMacOS &&
                !blockData?.meta?.connection
            ) {
                env.electron.onQuicklook(selectedPath);
                return true;
            }
            if (isCharacterKeyEvent(waveEvent)) {
                setSearchText((current) => current + waveEvent.key);
                return true;
            }
            return false;
        };
        return () => {
            model.directoryKeyDownHandler = null;
        };
    }, [filteredData, selectedPath, searchText, focusIndex]);

    useEffect(() => {
        if (filteredData.length != 0 && focusIndex > filteredData.length - 1) {
            setFocusIndex(filteredData.length - 1);
        }
    }, [filteredData]);

    const entryManagerPropsAtom = useState(
        atom<EntryManagerOverlayProps>(null) as PrimitiveAtom<EntryManagerOverlayProps>
    )[0];
    const [entryManagerProps, setEntryManagerProps] = useAtom(entryManagerPropsAtom);

    const { refs, floatingStyles, context } = useFloating({
        open: !!entryManagerProps,
        onOpenChange: () => setEntryManagerProps(undefined),
        middleware: [offset(({ rects }) => -rects.reference.height / 2 - rects.floating.height / 2)],
    });

    const handleDropCopy = useCallback(
        async (data: CommandFileCopyData, isDir: boolean) => {
            try {
                await env.rpc.FileCopyCommand(TabRpcClient, data, { timeout: data.opts.timeout });
            } catch (e) {
                console.warn("Copy failed:", e);
                const copyError = `${e}`;
                const allowRetry = copyError.includes(overwriteError) || copyError.includes(mergeError);
                let errorMsg: ErrorMsg;
                if (allowRetry) {
                    errorMsg = {
                        status: "Confirm Overwrite File(s)",
                        text: "This copy operation will overwrite an existing file. Would you like to continue?",
                        level: "warning",
                        buttons: [
                            {
                                text: "Delete Then Copy",
                                onClick: async () => {
                                    data.opts.overwrite = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                            {
                                text: "Sync",
                                onClick: async () => {
                                    data.opts.merge = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                        ],
                    };
                } else {
                    errorMsg = {
                        status: "Copy Failed",
                        text: copyError,
                        level: "error",
                    };
                }
                setErrorMsg(errorMsg);
            }
            model.refreshCallback();
        },
        [model.refreshCallback]
    );

    const [uploadProgress, setUploadProgress] = useState<UploadProgress>(null);

    const uploadLocalFiles = useCallback(
        async (files: File[]) => {
            const localPaths = files.map((file) => env.electron.getPathForFile(file)).filter((p) => !!p);
            if (localPaths.length == 0) {
                return;
            }
            const desturi = await model.formatRemoteUri(dirPath, globalStore.get);
            const conflicts: CommandFileCopyData[] = [];
            const failures: string[] = [];
            const copyAll = async (items: CommandFileCopyData[]) => {
                try {
                    for (const [i, data] of items.entries()) {
                        setUploadProgress({ name: data.srcuri.split("/").at(-1), done: i, total: items.length });
                        try {
                            await env.rpc.FileCopyCommand(TabRpcClient, data, { timeout: data.opts.timeout });
                        } catch (e) {
                            const copyError = `${e}`;
                            const name = data.srcuri.split("/").at(-1);
                            if (copyError.includes(overwriteError) || copyError.includes(mergeError)) {
                                conflicts.push(data);
                            } else {
                                failures.push(`${name}: ${copyError}`);
                            }
                        }
                    }
                } finally {
                    setUploadProgress(null);
                }
            };
            const timeoutYear = 31536000000;
            // Backslashes break the remote side's "/"-based basename when copying into a directory;
            // Windows accepts forward slashes, so normalize.
            await copyAll(
                localPaths.map((p) => ({
                    srcuri: formatRemoteUri(p.replace(/\\/g, "/"), "local"),
                    desturi,
                    opts: { timeout: timeoutYear, recursive: true },
                }))
            );
            model.refreshCallback();
            if (failures.length > 0) {
                setErrorMsg({
                    status: failures.length == 1 ? "Upload Failed" : `${failures.length} Uploads Failed`,
                    text: failures.join("\n"),
                    level: "error",
                });
                return;
            }
            if (conflicts.length == 0) {
                return;
            }
            const names = conflicts.map((d) => d.srcuri.split("/").at(-1));
            setErrorMsg({
                status: "Confirm Overwrite",
                text: `${names.length == 1 ? `"${names[0]}" already exists` : `${names.length} items already exist`} in this folder: ${names.join(", ")}. Overwrite?`,
                level: "warning",
                buttons: [
                    {
                        text: "Overwrite",
                        onClick: () =>
                            fireAndForget(async () => {
                                const retry = conflicts.map((d) => ({ ...d, opts: { ...d.opts, overwrite: true } }));
                                conflicts.length = 0;
                                await copyAll(retry);
                                model.refreshCallback();
                                if (failures.length > 0) {
                                    setErrorMsg({ status: "Upload Failed", text: failures.join("\n"), level: "error" });
                                }
                            }),
                    },
                ],
            });
        },
        [dirPath, model.formatRemoteUri, model.refreshCallback]
    );

    const uploadInputRef = useRef<HTMLInputElement>(null);

    const [{ isNativeFileOver }, drop] = useDrop(
        () => ({
            accept: ["FILE_ITEM", NativeTypes.FILE],
            canDrop: (_, monitor) => {
                if (monitor.getItemType() === NativeTypes.FILE) {
                    return monitor.isOver({ shallow: false });
                }
                const dragItem = monitor.getItem<DraggedFile>();
                // drop if not current dir is the parent directory of the dragged item
                // requires absolute path
                if (monitor.isOver({ shallow: false }) && dragItem.absParent !== dirPath) {
                    return true;
                }
                return false;
            },
            collect: (monitor) => ({
                isNativeFileOver: monitor.isOver({ shallow: false }) && monitor.getItemType() === NativeTypes.FILE,
            }),
            drop: async (item: DraggedFile | { files: File[] }, monitor) => {
                if (monitor.getItemType() === NativeTypes.FILE) {
                    await uploadLocalFiles((item as { files: File[] }).files ?? []);
                    return;
                }
                const draggedFile = item as DraggedFile;
                if (!monitor.didDrop()) {
                    const timeoutYear = 31536000000; // one year
                    const opts: FileCopyOpts = {
                        timeout: timeoutYear,
                    };
                    const desturi = await model.formatRemoteUri(dirPath, globalStore.get);
                    const data: CommandFileCopyData = {
                        srcuri: draggedFile.uri,
                        desturi,
                        opts,
                    };
                    await handleDropCopy(data, draggedFile.isDir);
                }
            },
            // TODO: mabe add a hover option?
        }),
        [dirPath, model.formatRemoteUri, model.refreshCallback, uploadLocalFiles]
    );

    useEffect(() => {
        drop(refs.reference);
    }, [refs.reference]);

    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

    const newFile = useCallback(() => {
        setEntryManagerProps({
            entryManagerType: EntryManagerType.NewFile,
            onSave: (newName: string) => {
                console.log(`newFile: ${newName}`);
                fireAndForget(async () => {
                    await env.rpc.FileCreateCommand(
                        TabRpcClient,
                        {
                            info: {
                                path: await model.formatRemoteUri(`${dirPath}/${newName}`, globalStore.get),
                            },
                        },
                        null
                    );
                    model.refreshCallback();
                });
                setEntryManagerProps(undefined);
            },
        });
    }, [dirPath]);
    const newDirectory = useCallback(() => {
        setEntryManagerProps({
            entryManagerType: EntryManagerType.NewDirectory,
            onSave: (newName: string) => {
                console.log(`newDirectory: ${newName}`);
                fireAndForget(async () => {
                    await env.rpc.FileMkdirCommand(TabRpcClient, {
                        info: {
                            path: await model.formatRemoteUri(`${dirPath}/${newName}`, globalStore.get),
                        },
                    });
                    model.refreshCallback();
                });
                setEntryManagerProps(undefined);
            },
        });
    }, [dirPath]);

    const handleFileContextMenu = useCallback(
        (e: any) => {
            e.preventDefault();
            e.stopPropagation();
            const menu: ContextMenuItem[] = [
                {
                    label: "New File",
                    click: () => {
                        newFile();
                    },
                },
                {
                    label: "New Folder",
                    click: () => {
                        newDirectory();
                    },
                },
                {
                    label: "Upload Files...",
                    click: () => uploadInputRef.current?.click(),
                },
                {
                    type: "separator",
                },
            ];
            addOpenMenuItems(menu, conn, finfo);

            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        [setRefreshVersion, conn, newFile, newDirectory, dirPath, uploadInputRef]
    );

    return (
        <Fragment>
            <div
                ref={refs.setReference}
                className="dir-table-container relative"
                onChangeCapture={(e) => {
                    const event = e as React.ChangeEvent<HTMLInputElement>;
                    // the hidden upload picker's change event bubbles here too and isn't a search
                    if (event.target.type === "file") {
                        return;
                    }
                    if (!entryManagerProps) {
                        setSearchText(event.target.value.toLowerCase());
                    }
                }}
                {...getReferenceProps()}
                onContextMenu={(e) => handleFileContextMenu(e)}
                onClick={() => setEntryManagerProps(undefined)}
            >
                <DirectoryPathBar model={model} />
                <DirectoryTable
                    model={model}
                    data={filteredData}
                    search={searchText}
                    focusIndex={focusIndex}
                    setFocusIndex={setFocusIndex}
                    setSearch={setSearchText}
                    setSelectedPath={setSelectedPath}
                    setRefreshVersion={setRefreshVersion}
                    entryManagerOverlayPropsAtom={entryManagerPropsAtom}
                    newFile={newFile}
                    newDirectory={newDirectory}
                />
                <OpenProgressList connection={conn} upload={uploadProgress} />
                <input
                    ref={uploadInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        e.target.value = "";
                        fireAndForget(() => uploadLocalFiles(files));
                    }}
                />
                {isNativeFileOver && (
                    <div className="absolute inset-1 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-accent/10 pointer-events-none">
                        <div className="rounded bg-panel px-3 py-2 text-primary">
                            <i className="fa-solid fa-upload mr-2" />
                            Drop to upload to {dirPath}
                        </div>
                    </div>
                )}
            </div>
            {entryManagerProps && (
                <EntryManagerOverlay
                    {...entryManagerProps}
                    forwardRef={refs.setFloating}
                    style={floatingStyles}
                    getReferenceProps={getFloatingProps}
                    onCancel={() => setEntryManagerProps(undefined)}
                />
            )}
        </Fragment>
    );
}

export { DirectoryPreview };
