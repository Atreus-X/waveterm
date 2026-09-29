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
}

type AgentUsageData struct {
	Agent     string           `json:"agent"`
	Available bool             `json:"available"`
	Today     AgentUsageWindow `json:"today"`
	Week      AgentUsageWindow `json:"week"`
}
