// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import Logo from "@/app/asset/logo.svg";
import { OnboardingGradientBg } from "@/app/onboarding/onboarding-common";
import { atoms, getApi } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { isDev } from "@/util/isdev";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { Modal } from "./modal";

const ForkRepoUrl = "https://github.com/Atreus-X/waveterm";

const UpdateSourceOptions: { value: string; label: string }[] = [
    { value: "atreus", label: "Atreus fork" },
    { value: "official", label: "Official Wave" },
];

interface AboutModalVProps {
    versionString: string;
    updaterChannel: string;
    updateSource: string;
    onUpdateSourceChange?: (source: string) => void;
    onClose: () => void;
}

const AboutModalV = ({
    versionString,
    updaterChannel,
    updateSource,
    onUpdateSourceChange,
    onClose,
}: AboutModalVProps) => {
    const currentDate = new Date();

    return (
        <Modal className="pt-[34px] pb-[34px] overflow-hidden w-[450px]" onClose={onClose}>
            <OnboardingGradientBg />
            <div className="flex flex-col gap-[26px] w-full relative z-10">
                <div className="flex flex-col items-center justify-center gap-4 self-stretch w-full text-center">
                    <Logo />
                    <div className="text-[25px]">Wave Terminal</div>
                    <div className="leading-5">
                        Open-Source AI-Integrated Terminal
                        <br />
                        Built for Seamless Workflows
                    </div>
                </div>
                <div className="items-center gap-4 self-stretch w-full text-center">
                    Client Version {versionString}
                    <br />
                    Update Channel: {updaterChannel}
                    <br />
                    Fork:{" "}
                    <a href={ForkRepoUrl} target="_blank" rel="noopener" className="underline cursor-pointer">
                        Atreus-X/waveterm
                    </a>
                </div>
                <div className="flex flex-col items-center gap-2 self-stretch w-full text-center">
                    <div className="flex items-center gap-2">
                        <span>Updates from:</span>
                        <div className="inline-flex rounded border border-border overflow-hidden">
                            {UpdateSourceOptions.map((opt) => (
                                <button
                                    key={opt.value}
                                    className={cn(
                                        "px-3 py-1 cursor-pointer transition-colors",
                                        updateSource === opt.value
                                            ? "bg-accent/80 text-primary hover:bg-accent"
                                            : "hover:bg-hoverbg"
                                    )}
                                    onClick={() => onUpdateSourceChange?.(opt.value)}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    {updateSource === "official" && (
                        <div className="text-xs text-warning">
                            Official Wave builds don't include this fork's changes — installing one replaces them.
                        </div>
                    )}
                </div>
                <div className="grid grid-cols-2 gap-[10px] self-stretch w-full">
                    <a
                        href="https://github.com/wavetermdev/waveterm"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-brands fa-github mr-2"></i>GitHub
                    </a>
                    <a
                        href="https://www.waveterm.dev/"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-sharp fa-light fa-globe mr-2"></i>Website
                    </a>
                    <a
                        href="https://github.com/wavetermdev/waveterm/blob/main/ACKNOWLEDGEMENTS.md"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-sharp fa-light fa-book mr-2"></i>Open Source
                    </a>
                    <a
                        href="https://github.com/sponsors/wavetermdev"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-sharp fa-light fa-heart mr-2"></i>Sponsor
                    </a>
                </div>
                <div className="items-center gap-4 self-stretch w-full text-center">
                    &copy; {currentDate.getFullYear()} Command Line Inc.
                    <br />
                    Unofficial build by{" "}
                    <a
                        href="https://github.com/Atreus-X/waveterm"
                        target="_blank"
                        rel="noopener"
                        className="underline cursor-pointer"
                    >
                        Atreus-X
                    </a>
                    , not endorsed by Command Line Inc.
                </div>
            </div>
        </Modal>
    );
};

AboutModalV.displayName = "AboutModalV";

const AboutModal = () => {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const versionString = `${fullConfig?.version ?? ""} (${isDev() ? "dev-" : ""}${fullConfig?.buildtime ?? ""})`;
    const updaterChannel = fullConfig?.settings?.["autoupdate:channel"] ?? "latest";
    const updateSource = fullConfig?.settings?.["autoupdate:source"] ?? "atreus";

    const handleUpdateSourceChange = (source: string) => {
        if (source === updateSource) {
            return;
        }
        fireAndForget(async () => {
            await RpcApi.SetConfigCommand(TabRpcClient, { "autoupdate:source": source });
            getApi().setUpdateSource(source);
        });
    };

    useEffect(() => {
        fireAndForget(async () => {
            RpcApi.RecordTEventCommand(
                TabRpcClient,
                { event: "action:other", props: { "action:type": "about" } },
                { noresponse: true }
            );
        });
    }, []);

    return (
        <AboutModalV
            versionString={versionString}
            updaterChannel={updaterChannel}
            updateSource={updateSource}
            onUpdateSourceChange={handleUpdateSourceChange}
            onClose={() => modalsModel.popModal()}
        />
    );
};

AboutModal.displayName = "AboutModal";

export { AboutModal, AboutModalV };
