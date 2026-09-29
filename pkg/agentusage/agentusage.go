// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package agentusage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const WeekDays = 7

var (
	usageMarker = []byte(`"usage"`)
	tokenMarker = []byte(`"token_count"`)
)

type usageEvent struct {
	ts         time.Time
	input      int64
	output     int64
	cacheWrite int64
	cacheRead  int64
}

type claudeLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	RequestId string `json:"requestId"`
	Message   struct {
		Id    string `json:"id"`
		Usage struct {
			Input      int64 `json:"input_tokens"`
			Output     int64 `json:"output_tokens"`
			CacheWrite int64 `json:"cache_creation_input_tokens"`
			CacheRead  int64 `json:"cache_read_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

type codexTokens struct {
	Input       int64 `json:"input_tokens"`
	CachedInput int64 `json:"cached_input_tokens"`
	Output      int64 `json:"output_tokens"`
	Total       int64 `json:"total_tokens"`
}

type codexLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Payload   struct {
		Type string `json:"type"`
		Info *struct {
			Total codexTokens `json:"total_token_usage"`
			Last  codexTokens `json:"last_token_usage"`
		} `json:"info"`
	} `json:"payload"`
}

func Collect(ctx context.Context, data wshrpc.CommandAgentUsageData) (*wshrpc.AgentUsageData, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("finding home directory: %w", err)
	}
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	weekStart := dayStart.AddDate(0, 0, -(WeekDays - 1))
	var root string
	var scan func(ctx context.Context, path string, since time.Time, emit func(usageEvent)) error
	switch data.Agent {
	case wshrpc.AgentUsage_Claude:
		root = filepath.Join(home, ".claude", "projects")
		scan = scanClaudeFile
	case wshrpc.AgentUsage_Codex:
		root = filepath.Join(home, ".codex", "sessions")
		scan = scanCodexFile
	default:
		return nil, fmt.Errorf("unknown agent %q", data.Agent)
	}
	rtn := &wshrpc.AgentUsageData{Agent: data.Agent}
	if _, err := os.Stat(root); err != nil {
		return rtn, nil
	}
	rtn.Available = true
	emit := func(ev usageEvent) {
		addToWindow(&rtn.Week, ev)
		if !ev.ts.Before(dayStart) {
			addToWindow(&rtn.Today, ev)
		}
	}
	walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil || d.IsDir() || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.ModTime().Before(weekStart) {
			return nil
		}
		// an unreadable or half-written log must not hide the totals from the others
		_ = scan(ctx, path, weekStart, emit)
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	return rtn, nil
}

func addToWindow(w *wshrpc.AgentUsageWindow, ev usageEvent) {
	w.Input += ev.input
	w.Output += ev.output
	w.CacheWrite += ev.cacheWrite
	w.CacheRead += ev.cacheRead
	w.Total += ev.input + ev.output + ev.cacheWrite
	w.Messages++
	ms := ev.ts.UnixMilli()
	if w.FirstTs == 0 || ms < w.FirstTs {
		w.FirstTs = ms
	}
}

func forEachLine(path string, marker []byte, fn func(line []byte)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	// bufio.Scanner would give up on the multi-megabyte lines agents write for tool results
	r := bufio.NewReaderSize(f, 256*1024)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 && bytes.Contains(line, marker) {
			fn(line)
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func scanClaudeFile(ctx context.Context, path string, since time.Time, emit func(usageEvent)) error {
	// a streamed response is logged once per content block with the same message and request id, so only the last counts
	last := map[string]usageEvent{}
	order := []string{}
	err := forEachLine(path, usageMarker, func(line []byte) {
		var cl claudeLine
		if json.Unmarshal(line, &cl) != nil || cl.Type != "assistant" {
			return
		}
		ts, err := time.Parse(time.RFC3339Nano, cl.Timestamp)
		if err != nil || ts.Before(since) {
			return
		}
		u := cl.Message.Usage
		key := cl.Message.Id + "|" + cl.RequestId
		if cl.Message.Id == "" {
			key = cl.Timestamp
		}
		if _, ok := last[key]; !ok {
			order = append(order, key)
		}
		last[key] = usageEvent{ts: ts, input: u.Input, output: u.Output, cacheWrite: u.CacheWrite, cacheRead: u.CacheRead}
	})
	for _, key := range order {
		emit(last[key])
	}
	return err
}

func scanCodexFile(ctx context.Context, path string, since time.Time, emit func(usageEvent)) error {
	// Codex repeats token_count events without new usage, so only a changed running total counts
	var prevTotal int64
	return forEachLine(path, tokenMarker, func(line []byte) {
		var cl codexLine
		if json.Unmarshal(line, &cl) != nil || cl.Type != "event_msg" || cl.Payload.Type != "token_count" || cl.Payload.Info == nil {
			return
		}
		info := cl.Payload.Info
		if info.Total.Total == prevTotal {
			return
		}
		prevTotal = info.Total.Total
		ts, err := time.Parse(time.RFC3339Nano, cl.Timestamp)
		if err != nil || ts.Before(since) {
			return
		}
		emit(usageEvent{
			ts:        ts,
			input:     info.Last.Input - info.Last.CachedInput,
			output:    info.Last.Output,
			cacheRead: info.Last.CachedInput,
		})
	})
}
