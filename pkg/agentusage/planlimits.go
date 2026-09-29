// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package agentusage

import (
	"encoding/json"
	"io"
	"path"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const PlanLimitsFile = "rate-limits.json"

const maxPlanLimitsBytes = 64 * 1024

type planWindow struct {
	UsedPercentage *float64 `json:"used_percentage"`
	ResetsAt       int64    `json:"resets_at"`
}

// planLimits is the rate_limits object Claude Code hands to the statusline command; the
// statusline script saves it because the server-side percentages are not in the session logs.
type planLimits struct {
	FiveHour planWindow `json:"five_hour"`
	SevenDay planWindow `json:"seven_day"`
}

func readPlanLimits(src FileSource) *planLimits {
	p := path.Join(filepath.ToSlash(src.Home()), ".claude", PlanLimitsFile)
	if _, isLocal := src.(localSource); isLocal {
		p = filepath.FromSlash(p)
	}
	f, err := src.Open(p)
	if err != nil {
		return nil
	}
	defer f.Close()
	buf, err := io.ReadAll(io.LimitReader(f, maxPlanLimitsBytes))
	if err != nil {
		return nil
	}
	var pl planLimits
	if json.Unmarshal(buf, &pl) != nil {
		return nil
	}
	return &pl
}

// applyPlanWindow overrides a window's estimate with the plan's own figures. A window whose reset
// time has passed is skipped: the saved percentage describes the previous window.
func applyPlanWindow(win *wshrpc.AgentUsageWindow, pw planWindow, now time.Time) {
	if pw.UsedPercentage == nil || pw.ResetsAt <= 0 {
		return
	}
	resetMs := pw.ResetsAt * 1000
	if resetMs <= now.UnixMilli() {
		return
	}
	pct := *pw.UsedPercentage
	win.PlanPct = &pct
	win.ResetAt = resetMs
}

func applyPlanLimits(rtn *wshrpc.AgentUsageData, src FileSource, now time.Time) {
	pl := readPlanLimits(src)
	if pl == nil {
		return
	}
	applyPlanWindow(&rtn.Session, pl.FiveHour, now)
	applyPlanWindow(&rtn.Week, pl.SevenDay, now)
}
