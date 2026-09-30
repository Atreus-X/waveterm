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

func TestCurrentSession(t *testing.T) {
	base := time.Date(2026, 1, 1, 10, 20, 0, 0, time.UTC)
	span := 5 * time.Hour
	ev := func(ts time.Time, out int64) usageEvent { return usageEvent{ts: ts, output: out} }
	events := []usageEvent{
		ev(base.Add(3*time.Hour), 7), // out of order on purpose
		ev(base, 10),
		ev(base.Add(30*time.Minute), 5),
		ev(base.Add(6*time.Hour), 100), // past 15:00 end: opens a second session ending 21:00
	}
	got := currentSession(events, base.Add(7*time.Hour), span)
	if got.Total != 100 || got.Messages != 1 {
		t.Errorf("second session = %+v", got)
	}
	if want := time.Date(2026, 1, 1, 21, 0, 0, 0, time.UTC).UnixMilli(); got.ResetAt != want {
		t.Errorf("resetat = %d, want %d", got.ResetAt, want)
	}
	first := currentSession(events[:3], base.Add(4*time.Hour), span)
	if first.Total != 22 || first.Messages != 3 {
		t.Errorf("first session = %+v", first)
	}
	if expired := currentSession(events[:3], base.Add(6*time.Hour), span); expired.ResetAt != 0 || expired.Total != 0 {
		t.Errorf("expired session = %+v", expired)
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
