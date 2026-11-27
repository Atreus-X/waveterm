// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { headerTextParts, lastPathSegment, minimizedDetail, minimizedLabel } from "./minimizedlabel";

describe("lastPathSegment", () => {
    it("takes the last folder name", () => {
        expect(lastPathSegment("/srv/projects/app")).toBe("app");
        expect(lastPathSegment("/srv/projects/app/")).toBe("app");
        expect(lastPathSegment("D:\\work\\code")).toBe("code");
        expect(lastPathSegment("~")).toBe("~");
        expect(lastPathSegment("/")).toBe("/");
    });

    it("is empty for nothing", () => {
        expect(lastPathSegment("")).toBe("");
        expect(lastPathSegment(undefined)).toBe("");
        expect(lastPathSegment("  ")).toBe("");
    });
});

describe("headerTextParts", () => {
    it("takes a plain string", () => {
        expect(headerTextParts("  build log ")).toEqual(["build log"]);
        expect(headerTextParts("   ")).toEqual([]);
    });

    it("takes text elements, also inside divs, and skips buttons and blanks", () => {
        const elems = [
            { elemtype: "iconbutton", icon: "bolt" },
            { elemtype: "text", text: "npm run dev" },
            { elemtype: "text", text: "  " },
            { elemtype: "div", children: [{ elemtype: "textbutton", text: "main" }] },
            null,
        ] as unknown as HeaderElem[];
        expect(headerTextParts(elems)).toEqual(["npm run dev", "main"]);
    });

    it("copes with nothing", () => {
        expect(headerTextParts(undefined)).toEqual([]);
        expect(headerTextParts(null)).toEqual([]);
    });
});

describe("minimizedDetail", () => {
    it("adds the host, the header text and the folder", () => {
        expect(
            minimizedDetail({
                viewName: "Terminal",
                connection: "dev-host",
                cwd: "/srv/app",
                headerText: ["npm run dev"],
            })
        ).toEqual(["dev-host", "npm run dev", "app"]);
    });

    it("leaves out a local connection", () => {
        expect(minimizedDetail({ viewName: "Terminal", connection: "local", cwd: "/tmp/x" })).toEqual(["x"]);
        expect(minimizedDetail({ viewName: "Terminal", connection: "local:gitbash", cwd: "/tmp/x" })).toEqual(["x"]);
        expect(minimizedDetail({ viewName: "Terminal", connection: "", cwd: "/tmp/x" })).toEqual(["x"]);
    });

    it("drops parts that repeat the name or each other", () => {
        expect(
            minimizedDetail({ viewName: "Terminal", connection: "app", cwd: "/srv/app", headerText: ["Terminal"] })
        ).toEqual(["app"]);
    });

    it("is empty when there is nothing to add", () => {
        expect(minimizedDetail({ viewName: "Host Inspector" })).toEqual([]);
    });
});

describe("minimizedLabel", () => {
    it("joins the name and the details", () => {
        expect(minimizedLabel({ viewName: "Terminal", connection: "dev-host", cwd: "/srv/app" })).toBe(
            "Terminal \u00b7 dev-host \u00b7 app"
        );
        expect(minimizedLabel({ viewName: "Host Inspector" })).toBe("Host Inspector");
    });
});
