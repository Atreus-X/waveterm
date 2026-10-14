// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { Markdown } from "@/element/markdown";
import { getOverrideConfigAtom } from "@/store/global";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import type { SpecializedViewProps } from "./preview";

function MarkdownPreview({ model }: SpecializedViewProps) {
    useEffect(() => {
        model.refreshCallback = () => {
            globalStore.set(model.refreshVersion, (v) => v + 1);
        };
        return () => {
            model.refreshCallback = null;
        };
    }, []);
    const connName = useAtomValue(model.connection);
    const fileInfo = useAtomValue(model.statFile);
    const fontSizeOverride = useAtomValue(getOverrideConfigAtom(model.blockId, "markdown:fontsize"));
    const fixedFontSizeOverride = useAtomValue(getOverrideConfigAtom(model.blockId, "markdown:fixedfontsize"));
    const resolveOpts: MarkdownResolveOpts = useMemo<MarkdownResolveOpts>(() => {
        return {
            connName: connName,
            baseDir: fileInfo.dir,
        };
    }, [connName, fileInfo.dir]);
    const onTaskToggle = useCallback(
        (taskIndex: number) => fireAndForget(() => model.toggleMarkdownTask(taskIndex)),
        [model]
    );
    return (
        <div className="flex flex-row h-full overflow-auto items-start justify-start">
            <Markdown
                textAtom={model.fileContent}
                showTocAtom={model.markdownShowToc}
                resolveOpts={resolveOpts}
                onTaskToggle={onTaskToggle}
                fontSizeOverride={fontSizeOverride}
                fixedFontSizeOverride={fixedFontSizeOverride}
                contentClassName="pt-[5px] pr-[15px] pb-[10px] pl-[15px]"
            />
        </div>
    );
}

export { MarkdownPreview };
