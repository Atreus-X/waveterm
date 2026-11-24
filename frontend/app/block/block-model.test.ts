// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import { BlockModel } from "./block-model";

describe("pointer over block", () => {
    beforeEach(() => BlockModel.resetInstance());

    it("starts with no block under the pointer", () => {
        expect(BlockModel.getInstance().hoveredBlockId).toBeNull();
    });

    it("tracks the block the pointer entered and forgets it on leave", () => {
        const model = BlockModel.getInstance();
        model.setPointerOverBlock("a");
        expect(model.hoveredBlockId).toBe("a");
        model.clearPointerOverBlock("a");
        expect(model.hoveredBlockId).toBeNull();
    });

    it("moving from one block to the next doesn't lose the new one, whichever event comes first", () => {
        const model = BlockModel.getInstance();
        model.setPointerOverBlock("a");
        model.setPointerOverBlock("b");
        model.clearPointerOverBlock("a");
        expect(model.hoveredBlockId).toBe("b");
    });

    it("a block that unmounts while another is hovered leaves the hover alone", () => {
        const model = BlockModel.getInstance();
        model.setPointerOverBlock("b");
        model.clearPointerOverBlock("a");
        expect(model.hoveredBlockId).toBe("b");
    });
});
