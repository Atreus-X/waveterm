// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package wshrpc

const (
	AgentUsage_Claude = "claude"
	AgentUsage_Codex  = "codex"
)

type CommandAgentUsageData struct {
	Agent string `json:"agent"`
	// connection the agent runs on; empty or "local" scans this machine, anything else needs wsh on that host
	Conn string `json:"conn,omitempty"`
	// length of the plan's rolling session in hours (Claude Pro/Max use 5); 0 means the default
	SessionHours int `json:"sessionhours,omitempty"`
}

type AgentUsageWindow struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheWrite int64 `json:"cachewrite"`
	CacheRead  int64 `json:"cacheread"`
	// input + output + cachewrite; cache reads are excluded because they dominate agent logs without counting like fresh tokens
	Total    int64 `json:"total"`
	Messages int   `json:"messages"`
	// unix millis of the oldest counted message, 0 when there is none
	FirstTs int64 `json:"firstts"`
	// unix millis when the window next frees capacity: next local midnight for today, the oldest message aging out for the week; 0 when there is no usage to expire
	ResetAt int64 `json:"resetat"`
	// percent of the plan limit used, as reported by the agent itself; nil when unavailable, in which case resetat is only an estimate
	PlanPct *float64 `json:"planpct,omitempty"`
}

type AgentUsageData struct {
	Agent     string `json:"agent"`
	Available bool   `json:"available"`
	// the currently open plan session; empty (resetat 0) when no session is active
	Session AgentUsageWindow `json:"session"`
	Today   AgentUsageWindow `json:"today"`
	Week    AgentUsageWindow `json:"week"`
}
