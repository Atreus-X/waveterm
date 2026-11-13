// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";

export interface BlockHighlightType {
    blockId: string;
    icon: string;
}

export class BlockModel {
    private static instance: BlockModel | null = null;
    private blockHighlightAtomCache = new Map<string, jotai.Atom<BlockHighlightType | null>>();

    blockHighlightAtom: jotai.PrimitiveAtom<BlockHighlightType> = jotai.atom(null) as jotai.PrimitiveAtom<BlockHighlightType>;

    private constructor() {
        // Empty for now
    }

    getBlockHighlightAtom(blockId: string): jotai.Atom<BlockHighlightType | null> {
        let atom = this.blockHighlightAtomCache.get(blockId);
        if (!atom) {
            atom = jotai.atom((get) => {
                const highlight = get(this.blockHighlightAtom);
                if (highlight?.blockId === blockId) {
                    return highlight;
                }
                return null;
            });
            this.blockHighlightAtomCache.set(blockId, atom);
        }
        return atom;
    }

    setBlockHighlight(highlight: BlockHighlightType | null) {
        globalStore.set(this.blockHighlightAtom, highlight);
    }

    // The block the mouse pointer is over, for key bindings that act on it rather than on the focused block.
    // Not an atom: nothing renders from it.
    hoveredBlockId: string = null;

    setPointerOverBlock(blockId: string) {
        this.hoveredBlockId = blockId;
    }

    clearPointerOverBlock(blockId: string) {
        if (this.hoveredBlockId === blockId) {
            this.hoveredBlockId = null;
        }
    }

    static getInstance(): BlockModel {
        if (!BlockModel.instance) {
            BlockModel.instance = new BlockModel();
        }
        return BlockModel.instance;
    }

    static resetInstance(): void {
        BlockModel.instance = null;
    }
}