// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

/**
 * The text of a block header that tells blocks of the same kind apart: strings and the text of text elements,
 * including those nested in divs. Buttons, inputs and icons are skipped.
 */
export function headerTextParts(text: string | HeaderElem[]): string[] {
    if (typeof text === "string") {
        return text.trim() === "" ? [] : [text.trim()];
    }
    if (!Array.isArray(text)) {
        return [];
    }
    return text.flatMap((elem) => {
        if (elem == null) return [];
        if (elem.elemtype === "text" || elem.elemtype === "textbutton") {
            return elem.text?.trim() ? [elem.text.trim()] : [];
        }
        if (elem.elemtype === "div") {
            return headerTextParts(elem.children);
        }
        return [];
    });
}

export function lastPathSegment(path: string): string {
    if (path == null || path.trim() === "") return "";
    const trimmed = path.trim().replace(/[\\/]+$/, "");
    if (trimmed === "") return "/";
    const segment = trimmed.split(/[\\/]/).pop();
    return segment === "" ? trimmed : segment;
}

export type MinimizedLabelInput = {
    viewName: string;
    connection?: string;
    cwd?: string;
    headerText?: string[];
};

/**
 * What a minimized block shows beside its name, so two blocks of the same kind can be told apart: the host it
 * is connected to (not "local"), the header text, and the folder name for a terminal. Parts that repeat the
 * name or each other are dropped.
 */
export function minimizedDetail(input: MinimizedLabelInput): string[] {
    const isLocal = input.connection == null || input.connection.trim() === "" || input.connection.startsWith("local");
    const parts = [isLocal ? "" : input.connection.trim(), ...(input.headerText ?? []), lastPathSegment(input.cwd)];
    const seen = new Set<string>([input.viewName]);
    return parts.filter((part) => {
        if (!part || seen.has(part)) return false;
        seen.add(part);
        return true;
    });
}

export function minimizedLabel(input: MinimizedLabelInput): string {
    return [input.viewName, ...minimizedDetail(input)].filter((part) => part).join(" · ");
}
