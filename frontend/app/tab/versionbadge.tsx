// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getApi, getSettingsKeyAtom } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { memo } from "react";

const VersionBadgeComponent = () => {
    const mode = useAtomValue(getSettingsKeyAtom("window:showversion")) ?? "always";
    const version = getApi().getAboutModalDetails()?.version;
    if (mode == "off" || version == null) {
        return null;
    }
    // prerelease versions (e.g. 0.17.3-beta.3) are test builds; releases have no "-" suffix
    const isTestBuild = version.includes("-");
    if (mode == "test" && !isTestBuild) {
        return null;
    }
    return (
        <div
            className="flex h-[22px] mb-1 px-1.5 items-center shrink-0 text-[11px] text-muted select-none"
            title={isTestBuild ? "Test build" : "Wave version"}
        >
            v{version}
        </div>
    );
};
VersionBadgeComponent.displayName = "VersionBadgeComponent";

export const VersionBadge = memo(VersionBadgeComponent);
