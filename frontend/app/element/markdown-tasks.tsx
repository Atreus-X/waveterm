// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { visit } from "unist-util-visit";

export const TaskIndexAttr = "data-task-index";

// Numbers GFM task-list checkboxes in document order (added after sanitizing, so the attribute
// survives). The Nth checkbox is the Nth task item in the source, which is how a click is mapped
// back to the text.
export function rehypeTaskIndex() {
    return (tree: any) => {
        let idx = 0;
        visit(tree, "element", (node: any) => {
            if (node.tagName === "input" && node.properties?.type === "checkbox") {
                node.properties.dataTaskIndex = idx++;
            }
        });
    };
}

// A clickable replacement for GFM's disabled task checkbox.
export function makeTaskInput(onTaskToggle: (taskIndex: number) => void) {
    const TaskInput = (props: any) => {
        if (props.type !== "checkbox") {
            const { node: _node, ...rest } = props;
            return <input {...rest} />;
        }
        const idx = Number(props[TaskIndexAttr]);
        return (
            <input
                type="checkbox"
                checked={!!props.checked}
                onChange={() => onTaskToggle(idx)}
                onClick={(e) => e.stopPropagation()}
                className="mr-1.5 cursor-pointer align-middle"
            />
        );
    };
    return TaskInput;
}
