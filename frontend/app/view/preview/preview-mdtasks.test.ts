// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import { planTaskToggle } from "./preview-mdtasks";

const Doc = "# Plan\n\n- [ ] first\n- [x] second\n\n```\n- [ ] not a task\n```\n- [ ] third\n";

test("writes the flipped text when the file is unchanged", () => {
    expect(planTaskToggle(Doc, Doc, 0)).toEqual({ kind: "write", next: Doc.replace("- [ ] first", "- [x] first") });
    expect(planTaskToggle(Doc, Doc, 1)).toEqual({ kind: "write", next: Doc.replace("- [x] second", "- [ ] second") });
});

test("skips fenced code when counting tasks", () => {
    const plan = planTaskToggle(Doc, Doc, 2);
    expect(plan).toEqual({ kind: "write", next: Doc.replace("- [ ] third", "- [x] third") });
});

test("a file changed on disk is not overwritten", () => {
    const changed = "- [ ] inserted above\n" + Doc;
    expect(planTaskToggle(Doc, changed, 0)).toEqual({ kind: "stale", onDisk: changed });
});

test("an out-of-range index changes nothing", () => {
    expect(planTaskToggle(Doc, Doc, 9)).toEqual({ kind: "unchanged" });
    expect(planTaskToggle("no tasks here", "no tasks here", 0)).toEqual({ kind: "unchanged" });
});
