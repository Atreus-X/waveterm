// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package agentusage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func claudeRow(ts time.Time, msgId string, in, out, cw, cr int64) string {
	return fmt.Sprintf(`{"type":"assistant","timestamp":%q,"requestId":"r-%s","message":{"id":%q,"usage":{"input_tokens":%d,"output_tokens":%d,"cache_creation_input_tokens":%d,"cache_read_input_tokens":%d}}}`+"\n",
		ts.UTC().Format(time.RFC3339Nano), msgId, msgId, in, out, cw, cr)
}

func TestCollectClaude(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir := filepath.Join(home, ".claude", "projects", "proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	content := claudeRow(now.Add(-time.Minute), "a", 1, 10, 100, 5000) +
		claudeRow(now.Add(-time.Minute), "a", 2, 20, 100, 5000) + // streamed duplicate of "a": last one wins
		claudeRow(now.AddDate(0, 0, -3), "b", 3, 30, 0, 0) +
		claudeRow(now.AddDate(0, 0, -30), "c", 999, 999, 999, 999) +
		"not json but mentions \"usage\"\n"
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := Collect(context.Background(), wshrpc.CommandAgentUsageData{Agent: wshrpc.AgentUsage_Claude})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Available {
		t.Fatalf("expected available")
	}
	if got.Today.Total != 2+20+100 || got.Today.Messages != 1 || got.Today.CacheRead != 5000 {
		t.Errorf("today = %+v", got.Today)
	}
	if got.Week.Total != 2+20+100+3+30 || got.Week.Messages != 2 {
		t.Errorf("week = %+v", got.Week)
	}
	if got.Today.ResetAt <= now.UnixMilli() || got.Today.ResetAt > now.Add(24*time.Hour).UnixMilli() {
		t.Errorf("today resetat = %d", got.Today.ResetAt)
	}
	if want := got.Week.FirstTs + (WeekDays * 24 * time.Hour).Milliseconds(); got.Week.ResetAt != want {
		t.Errorf("week resetat = %d, want %d", got.Week.ResetAt, want)
	}
}

func TestCollectMissingAndUnknown(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	got, err := Collect(context.Background(), wshrpc.CommandAgentUsageData{Agent: wshrpc.AgentUsage_Codex})
	if err != nil || got.Available {
		t.Errorf("missing dir: got=%+v err=%v", got, err)
	}
	if _, err := Collect(context.Background(), wshrpc.CommandAgentUsageData{Agent: "nope"}); err == nil {
		t.Errorf("expected error for unknown agent")
	}
}
