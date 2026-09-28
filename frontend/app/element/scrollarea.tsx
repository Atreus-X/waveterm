// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import React from "react";

// A scroll container with Wave's themed overlay scrollbars (like the file browser), instead of the
// app's near-invisible 4px native ones. They show while the pointer is over the area and can be
// grabbed and dragged. Put padding on a child, not on the ScrollArea itself.
export function ScrollArea({
    className,
    horizontal,
    children,
}: {
    className?: string;
    horizontal?: boolean;
    children: React.ReactNode;
}) {
    return (
        <OverlayScrollbarsComponent
            className={cn("min-h-0", className)}
            options={{
                overflow: { x: horizontal ? "scroll" : "hidden", y: "scroll" },
                scrollbars: { autoHide: "leave", autoHideDelay: 800, clickScroll: true },
            }}
            defer
        >
            {children}
        </OverlayScrollbarsComponent>
    );
}
