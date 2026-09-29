// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package agentusage

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
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

type memFile struct {
	data string
	mod  time.Time
}

type memSource struct {
	home  string
	files map[string]memFile
	opens int
}

func (m *memSource) Home() string { return m.home }

func (m *memSource) Exists(p string) bool {
	for name := range m.files {
		if strings.HasPrefix(name, p+"/") {
			return true
		}
	}
	return false
}

func (m *memSource) Walk(ctx context.Context, root string, fn func(string, int64, time.Time)) error {
	for name, f := range m.files {
		if strings.HasPrefix(name, root+"/") {
			fn(name, int64(len(f.data)), f.mod)
		}
	}
	return nil
}

func (m *memSource) Open(p string) (io.ReadCloser, error) {
	f, ok := m.files[p]
	if !ok {
		return nil, fs.ErrNotExist
	}
	m.opens++
	return io.NopCloser(strings.NewReader(f.data)), nil
}

func TestCollectFromRemoteSourceCaches(t *testing.T) {
	now := time.Now()
	const logPath = "/srv/example/.claude/projects/p/a.jsonl"
	src := &memSource{home: "/srv/example", files: map[string]memFile{
		logPath: {claudeRow(now.Add(-time.Minute), "a", 1, 10, 100, 0), now},
		"/srv/example/.claude/projects/p/old.jsonl": {claudeRow(now.AddDate(0, 0, -30), "o", 9, 9, 9, 9), now.AddDate(0, 0, -30)},
		"/srv/example/.claude/projects/p/notes.txt": {"ignored", now},
	}}
	cache := MakeFileCache()
	data := wshrpc.CommandAgentUsageData{Agent: wshrpc.AgentUsage_Claude}
	got, err := CollectFrom(context.Background(), data, src, cache)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Available || got.Week.Total != 111 || got.Today.Messages != 1 || got.Session.Total != 111 {
		t.Fatalf("got %+v", got)
	}
	if src.opens != 1 {
		t.Errorf("opens = %d, want 1 (old and non-jsonl files must be skipped)", src.opens)
	}
	if _, err := CollectFrom(context.Background(), data, src, cache); err != nil {
		t.Fatal(err)
	}
	if src.opens != 1 {
		t.Errorf("unchanged file was re-read: opens = %d", src.opens)
	}
	f := src.files[logPath]
	f.data += claudeRow(now, "b", 0, 5, 0, 0)
	src.files[logPath] = f
	got, err = CollectFrom(context.Background(), data, src, cache)
	if err != nil {
		t.Fatal(err)
	}
	if src.opens != 2 || got.Week.Total != 116 {
		t.Errorf("changed file: opens = %d, week = %+v", src.opens, got.Week)
	}
	delete(src.files, logPath)
	if _, err := CollectFrom(context.Background(), data, src, cache); err != nil {
		t.Fatal(err)
	}
	if len(cache.entries) != 0 {
		t.Errorf("cache kept entries for deleted files: %d", len(cache.entries))
	}
}

func TestScanCodex(t *testing.T) {
	ts := time.Now().UTC().Format(time.RFC3339Nano)
	row := func(total, in, cached, out int64) string {
		return fmt.Sprintf(`{"type":"event_msg","timestamp":%q,"payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":%d},"last_token_usage":{"input_tokens":%d,"cached_input_tokens":%d,"output_tokens":%d}}}}`+"\n", ts, total, in, cached, out)
	}
	evs := scanCodex(strings.NewReader(row(100, 90, 40, 10) + row(100, 90, 40, 10) + row(250, 120, 20, 30)))
	if len(evs) != 2 || evs[0].input != 50 || evs[0].cacheRead != 40 || evs[1].output != 30 {
		t.Errorf("events = %+v", evs)
	}
}

func TestCollectFromPlanLimits(t *testing.T) {
	now := time.Now()
	fiveReset := now.Add(4 * time.Hour).Unix()
	staleReset := now.Add(-time.Hour).Unix()
	limits := fmt.Sprintf(`{"five_hour":{"used_percentage":2.4,"resets_at":%d},"seven_day":{"used_percentage":19,"resets_at":%d}}`, fiveReset, staleReset)
	src := &memSource{home: "/srv/example", files: map[string]memFile{
		"/srv/example/.claude/projects/p/a.jsonl": {claudeRow(now.Add(-time.Minute), "a", 1, 10, 100, 0), now},
		"/srv/example/.claude/rate-limits.json":   {limits, now},
	}}
	got, err := CollectFrom(context.Background(), wshrpc.CommandAgentUsageData{Agent: wshrpc.AgentUsage_Claude}, src, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Session.PlanPct == nil || *got.Session.PlanPct != 2.4 || got.Session.ResetAt != fiveReset*1000 {
		t.Errorf("session = %+v", got.Session)
	}
	if got.Week.PlanPct != nil {
		t.Errorf("a window past its reset must fall back to the estimate: %+v", got.Week)
	}
	if got.Week.Total != 111 {
		t.Errorf("week total = %d", got.Week.Total)
	}
}
