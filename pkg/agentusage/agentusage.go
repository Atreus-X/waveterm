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
	"path"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	WeekDays            = 7
	DefaultSessionHours = 5
)

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

// FileSource is where the agent logs live: the local disk, or a remote host reached over SFTP
// when wsh is not installed there.
type FileSource interface {
	Home() string
	Exists(path string) bool
	Walk(ctx context.Context, root string, fn func(path string, size int64, mod time.Time)) error
	Open(path string) (io.ReadCloser, error)
}

type cacheEntry struct {
	size   int64
	mod    time.Time
	events []usageEvent
}

// FileCache remembers the parsed events of each log file so a poll only re-reads files that changed.
type FileCache struct {
	lock    sync.Mutex
	entries map[string]cacheEntry
}

var (
	hostCachesLock sync.Mutex
	hostCaches     = map[string]*FileCache{}
)

func MakeFileCache() *FileCache {
	return &FileCache{entries: map[string]cacheEntry{}}
}

func CacheForHost(host string) *FileCache {
	hostCachesLock.Lock()
	defer hostCachesLock.Unlock()
	c := hostCaches[host]
	if c == nil {
		c = MakeFileCache()
		hostCaches[host] = c
	}
	return c
}

func (c *FileCache) get(path string, size int64, mod time.Time) ([]usageEvent, bool) {
	if c == nil {
		return nil, false
	}
	c.lock.Lock()
	defer c.lock.Unlock()
	e, ok := c.entries[path]
	if !ok || e.size != size || !e.mod.Equal(mod) {
		return nil, false
	}
	return e.events, true
}

func (c *FileCache) put(path string, size int64, mod time.Time, events []usageEvent) {
	if c == nil {
		return
	}
	c.lock.Lock()
	defer c.lock.Unlock()
	c.entries[path] = cacheEntry{size: size, mod: mod, events: events}
}

func (c *FileCache) keepOnly(seen map[string]bool) {
	if c == nil {
		return
	}
	c.lock.Lock()
	defer c.lock.Unlock()
	for p := range c.entries {
		if !seen[p] {
			delete(c.entries, p)
		}
	}
}

type localSource struct{ home string }

func (l localSource) Home() string { return l.home }

func (l localSource) Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (l localSource) Walk(ctx context.Context, root string, fn func(path string, size int64, mod time.Time)) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		fn(p, info.Size(), info.ModTime())
		return nil
	})
}

func (l localSource) Open(path string) (io.ReadCloser, error) { return os.Open(path) }

func Collect(ctx context.Context, data wshrpc.CommandAgentUsageData) (*wshrpc.AgentUsageData, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("finding home directory: %w", err)
	}
	return CollectFrom(ctx, data, localSource{home: home}, nil)
}

// CollectFrom scans the agent's logs through src. cache may be nil.
func CollectFrom(ctx context.Context, data wshrpc.CommandAgentUsageData, src FileSource, cache *FileCache) (*wshrpc.AgentUsageData, error) {
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	weekWindow := WeekDays * 24 * time.Hour
	weekStart := now.Add(-weekWindow)
	var root string
	var scan func(r io.Reader) []usageEvent
	switch data.Agent {
	case wshrpc.AgentUsage_Claude:
		root = path.Join(filepath.ToSlash(src.Home()), ".claude", "projects")
		scan = scanClaude
	case wshrpc.AgentUsage_Codex:
		root = path.Join(filepath.ToSlash(src.Home()), ".codex", "sessions")
		scan = scanCodex
	default:
		return nil, fmt.Errorf("unknown agent %q", data.Agent)
	}
	if _, isLocal := src.(localSource); isLocal {
		root = filepath.FromSlash(root)
	}
	rtn := &wshrpc.AgentUsageData{Agent: data.Agent}
	if !src.Exists(root) {
		return rtn, nil
	}
	rtn.Available = true
	var events []usageEvent
	seen := map[string]bool{}
	walkErr := src.Walk(ctx, root, func(p string, size int64, mod time.Time) {
		if filepath.Ext(p) != ".jsonl" || mod.Before(weekStart) || ctx.Err() != nil {
			return
		}
		seen[p] = true
		evs, ok := cache.get(p, size, mod)
		if !ok {
			// an unreadable or half-written log must not hide the totals from the others
			f, err := src.Open(p)
			if err != nil {
				return
			}
			evs = scan(f)
			f.Close()
			cache.put(p, size, mod, evs)
		}
		events = append(events, evs...)
	})
	if walkErr != nil {
		return nil, walkErr
	}
	cache.keepOnly(seen)
	kept := make([]usageEvent, 0, len(events))
	for _, ev := range events {
		if ev.ts.Before(weekStart) {
			continue
		}
		kept = append(kept, ev)
		addToWindow(&rtn.Week, ev)
		if !ev.ts.Before(dayStart) {
			addToWindow(&rtn.Today, ev)
		}
	}
	rtn.Today.ResetAt = dayStart.AddDate(0, 0, 1).UnixMilli()
	if rtn.Week.FirstTs != 0 {
		rtn.Week.ResetAt = rtn.Week.FirstTs + weekWindow.Milliseconds()
	}
	sessionHours := data.SessionHours
	if sessionHours <= 0 {
		sessionHours = DefaultSessionHours
	}
	rtn.Session = currentSession(kept, now, time.Duration(sessionHours)*time.Hour)
	return rtn, nil
}

// currentSession mirrors how Claude's plan sessions work: a session opens with the first message
// (floored to the hour) and lasts a fixed span; the next message after it ends opens a new one.
func currentSession(events []usageEvent, now time.Time, span time.Duration) wshrpc.AgentUsageWindow {
	sort.Slice(events, func(i, j int) bool { return events[i].ts.Before(events[j].ts) })
	var win wshrpc.AgentUsageWindow
	var end time.Time
	for _, ev := range events {
		if end.IsZero() || !ev.ts.Before(end) {
			win = wshrpc.AgentUsageWindow{}
			end = ev.ts.Truncate(time.Hour).Add(span)
		}
		addToWindow(&win, ev)
	}
	if end.IsZero() || !now.Before(end) {
		return wshrpc.AgentUsageWindow{}
	}
	win.ResetAt = end.UnixMilli()
	return win
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

func forEachLine(r io.Reader, marker []byte, fn func(line []byte)) {
	// bufio.Scanner would give up on the multi-megabyte lines agents write for tool results
	br := bufio.NewReaderSize(r, 256*1024)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 && bytes.Contains(line, marker) {
			fn(line)
		}
		if err != nil {
			return
		}
	}
}

func scanClaude(r io.Reader) []usageEvent {
	// a streamed response is logged once per content block with the same message and request id, so only the last counts
	last := map[string]usageEvent{}
	order := []string{}
	forEachLine(r, usageMarker, func(line []byte) {
		var cl claudeLine
		if json.Unmarshal(line, &cl) != nil || cl.Type != "assistant" {
			return
		}
		ts, err := time.Parse(time.RFC3339Nano, cl.Timestamp)
		if err != nil {
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
	events := make([]usageEvent, 0, len(order))
	for _, key := range order {
		events = append(events, last[key])
	}
	return events
}

func scanCodex(r io.Reader) []usageEvent {
	// Codex repeats token_count events without new usage, so only a changed running total counts
	var prevTotal int64
	var events []usageEvent
	forEachLine(r, tokenMarker, func(line []byte) {
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
		if err != nil {
			return
		}
		events = append(events, usageEvent{
			ts:        ts,
			input:     info.Last.Input - info.Last.CachedInput,
			output:    info.Last.Output,
			cacheRead: info.Last.CachedInput,
		})
	})
	return events
}
