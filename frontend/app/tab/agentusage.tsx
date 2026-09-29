// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getSettingsKeyAtom } from "@/store/global";
import { cn } from "@/util/util";
import { autoUpdate, FloatingPortal, offset, useClick, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useState } from "react";

const PollIntervalMs = 60000;
const AgentLabels: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

function formatTokens(n: number): string {
    if (n >= 1e9) {
        return (n / 1e9).toFixed(2) + "B";
    }
    if (n >= 1e6) {
        return (n / 1e6).toFixed(1) + "M";
    }
    if (n >= 1e3) {
        return (n / 1e3).toFixed(1) + "K";
    }
    return String(n);
}

function usageColor(ratio: number): string {
    if (ratio >= 1) {
        return "bg-red-500";
    }
    if (ratio >= 0.8) {
        return "bg-yellow-500";
    }
    return "bg-accent";
}

function parseTokens(text: string): number {
    const m = text.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmb]?)$/);
    if (m == null) {
        return NaN;
    }
    const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]];
    return Math.round(parseFloat(m[1]) * mult);
}

const UsageBar = memo(({ used, limit }: { used: number; limit: number }) => {
    const ratio = limit > 0 ? used / limit : 0;
    return (
        <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div className={cn("h-full", usageColor(ratio))} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
        </div>
    );
});
UsageBar.displayName = "UsageBar";

const WindowRow = memo(({ label, win, limit }: { label: string; win: AgentUsageWindow; limit: number }) => {
    const pct = limit > 0 ? Math.round((win.total / limit) * 100) : null;
    return (
        <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs">
                <span className="font-medium">{label}</span>
                <span className="text-secondary">
                    {formatTokens(win.total)}
                    {limit > 0 ? ` / ${formatTokens(limit)} (${pct}%)` : ""}
                </span>
            </div>
            {limit > 0 && <UsageBar used={win.total} limit={limit} />}
            <div className="text-[11px] text-muted">
                in {formatTokens(win.input)} · out {formatTokens(win.output)} · cache write{" "}
                {formatTokens(win.cachewrite)} · cache read {formatTokens(win.cacheread)} · {win.messages} msgs
            </div>
        </div>
    );
});
WindowRow.displayName = "WindowRow";

const LimitInput = memo(({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) => {
    const [text, setText] = useState(value > 0 ? String(value) : "");
    useEffect(() => {
        setText(value > 0 ? String(value) : "");
    }, [value]);
    const commit = () => {
        if (text.trim() === "") {
            onCommit(0);
            return;
        }
        const n = parseTokens(text);
        if (isNaN(n)) {
            setText(value > 0 ? String(value) : "");
            return;
        }
        onCommit(n);
    };
    return (
        <label className="flex items-center justify-between gap-2 text-xs">
            {label}
            <input
                className="w-28 px-1.5 py-0.5 rounded bg-black/30 border border-border text-right"
                value={text}
                placeholder="e.g. 5M"
                onChange={(e) => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                    }
                }}
            />
        </label>
    );
});
LimitInput.displayName = "LimitInput";

const AgentUsageWidgetComponent = () => {
    const agent = useAtomValue(getSettingsKeyAtom("agentusage:agent")) ?? "";
    const conn = useAtomValue(getSettingsKeyAtom("agentusage:conn")) ?? "";
    const dailyLimit = useAtomValue(getSettingsKeyAtom("agentusage:dailylimit")) ?? 0;
    const weeklyLimit = useAtomValue(getSettingsKeyAtom("agentusage:weeklylimit")) ?? 0;
    const [usage, setUsage] = useState<AgentUsageData>(null);
    const [error, setError] = useState<string>(null);
    const [connList, setConnList] = useState<string[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const { refs, floatingStyles, context } = useFloating({
        open: isOpen,
        onOpenChange: setIsOpen,
        placement: "bottom-end",
        middleware: [offset(4)],
        whileElementsMounted: autoUpdate,
    });
    const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context)]);

    useEffect(() => {
        setUsage(null);
        setError(null);
        if (agent === "") {
            return;
        }
        let cancelled = false;
        const load = async () => {
            try {
                const data = await RpcApi.AgentUsageCommand(
                    TabRpcClient,
                    { agent, conn: conn === "" ? undefined : conn },
                    { timeout: 30000 }
                );
                if (cancelled) {
                    return;
                }
                setUsage(data);
                setError(null);
            } catch (e) {
                if (!cancelled) {
                    setError(String(e?.message ?? e));
                }
            }
        };
        load();
        const timer = setInterval(load, PollIntervalMs);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [agent, conn]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }
        RpcApi.ConnListCommand(TabRpcClient, { timeout: 2000 })
            .then((list) => setConnList(list ?? []))
            .catch(() => setConnList([]));
    }, [isOpen]);

    const setSetting = useCallback((settings: Partial<SettingsType>) => {
        RpcApi.SetConfigCommand(TabRpcClient, settings as SettingsType);
    }, []);

    const dayRatio = dailyLimit > 0 && usage != null ? usage.today.total / dailyLimit : 0;
    const weekRatio = weeklyLimit > 0 && usage != null ? usage.week.total / weeklyLimit : 0;
    const connOptions = conn !== "" && !connList.includes(conn) ? [conn, ...connList] : connList;

    let meter: React.ReactNode;
    if (agent === "") {
        meter = <i className="fa fa-gauge-high" />;
    } else if (error != null) {
        meter = <i className="fa fa-triangle-exclamation text-yellow-500" />;
    } else if (usage == null) {
        meter = <span className="text-muted">…</span>;
    } else if (dailyLimit > 0 || weeklyLimit > 0) {
        meter = (
            <>
                <span className="font-medium">{Math.round(Math.max(dayRatio, weekRatio) * 100)}%</span>
                <div className="flex flex-col gap-0.5 w-10">
                    {dailyLimit > 0 && <UsageBar used={usage.today.total} limit={dailyLimit} />}
                    {weeklyLimit > 0 && <UsageBar used={usage.week.total} limit={weeklyLimit} />}
                </div>
            </>
        );
    } else {
        meter = <span className="font-medium">{formatTokens(usage.today.total)} today</span>;
    }

    return (
        <>
            <div
                ref={refs.setReference}
                {...getReferenceProps()}
                className="flex items-center gap-1.5 px-2 mb-1 h-[22px] text-xs rounded-sm cursor-pointer hover:bg-hover transition-colors"
                style={{ WebkitAppRegion: "no-drag" } as any}
                title={agent === "" ? "AI agent usage" : `${AgentLabels[agent] ?? agent} usage`}
            >
                {meter}
            </div>
            {isOpen && (
                <FloatingPortal>
                    <div
                        ref={refs.setFloating}
                        style={floatingStyles}
                        {...getFloatingProps()}
                        className="z-[1000] w-80 p-3 flex flex-col gap-3 rounded-md bg-modalbg border border-border shadow-lg text-primary"
                    >
                        {usage != null && (
                            <>
                                <WindowRow label="Today" win={usage.today} limit={dailyLimit} />
                                <WindowRow label="Last 7 days" win={usage.week} limit={weeklyLimit} />
                            </>
                        )}
                        {usage != null && !usage.available && (
                            <div className="text-xs text-yellow-500">
                                No {AgentLabels[agent] ?? agent} logs found on {conn === "" ? "this machine" : conn}.
                            </div>
                        )}
                        {error != null && <div className="text-xs text-red-400 break-words">{error}</div>}
                        <div className="text-[11px] text-muted">
                            Counts input + output + cache-write tokens read from the agent's local logs; the plan's real
                            limits aren't in them, so set your own budgets below.
                        </div>
                        <div className="flex flex-col gap-2 pt-2 border-t border-border">
                            <label className="flex items-center justify-between gap-2 text-xs">
                                Agent
                                <select
                                    className="w-40 px-1.5 py-0.5 rounded bg-black/30 border border-border"
                                    value={agent}
                                    onChange={(e) => setSetting({ "agentusage:agent": e.target.value })}
                                >
                                    <option value="">Off</option>
                                    <option value="claude">Claude Code</option>
                                    <option value="codex">Codex</option>
                                </select>
                            </label>
                            <label className="flex items-center justify-between gap-2 text-xs">
                                Runs on
                                <select
                                    className="w-40 px-1.5 py-0.5 rounded bg-black/30 border border-border"
                                    value={conn}
                                    onChange={(e) => setSetting({ "agentusage:conn": e.target.value })}
                                >
                                    <option value="">This machine</option>
                                    {connOptions.map((c) => (
                                        <option key={c} value={c}>
                                            {c}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <LimitInput
                                label="Daily limit (tokens)"
                                value={dailyLimit}
                                onCommit={(v) => setSetting({ "agentusage:dailylimit": v })}
                            />
                            <LimitInput
                                label="Weekly limit (tokens)"
                                value={weeklyLimit}
                                onCommit={(v) => setSetting({ "agentusage:weeklylimit": v })}
                            />
                            {conn !== "" && (
                                <div className="text-[11px] text-muted">
                                    Remote hosts need wsh installed on the connection.
                                </div>
                            )}
                        </div>
                    </div>
                </FloatingPortal>
            )}
        </>
    );
};
AgentUsageWidgetComponent.displayName = "AgentUsageWidgetComponent";

export const AgentUsageWidget = memo(AgentUsageWidgetComponent);
