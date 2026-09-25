// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package library

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func useTempConfig(t *testing.T) string {
	t.Helper()
	old := wavebase.ConfigHome_VarCache
	dir := t.TempDir()
	wavebase.ConfigHome_VarCache = dir
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	return dir
}

func TestLibraryRoundTrip(t *testing.T) {
	dir := useTempConfig(t)
	empty, err := ReadLibrary()
	if err != nil || empty.Snippets == nil || len(empty.Snippets) != 0 {
		t.Fatalf("missing file should read as empty: %+v, %v", empty, err)
	}
	err = WriteLibrary(wshrpc.LibraryData{Snippets: []wshrpc.LibrarySnippet{
		{Title: "  disk usage  ", Body: "df -h {{path=/}}"},
		{Id: "fixed", Title: "logs", Body: "docker logs -f {{container}}", Hosts: []string{"*.example.com"}, Run: true},
		{Id: "fixed", Title: "dup id", Body: "echo"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "library.json")); err != nil {
		t.Fatalf("library.json not written: %v", err)
	}
	got, err := ReadLibrary()
	if err != nil || len(got.Snippets) != 3 {
		t.Fatalf("read back: %+v %v", got, err)
	}
	if got.Snippets[0].Id == "" || got.Snippets[0].Title != "disk usage" || got.Snippets[0].Tags == nil {
		t.Errorf("snippet 0 not normalized: %+v", got.Snippets[0])
	}
	if got.Snippets[1].Id != "fixed" || got.Snippets[2].Id == "fixed" {
		t.Errorf("duplicate id not replaced: %q %q", got.Snippets[1].Id, got.Snippets[2].Id)
	}
	if !got.Snippets[1].Run || got.Snippets[1].Hosts[0] != "*.example.com" {
		t.Errorf("fields lost: %+v", got.Snippets[1])
	}
}

func TestLibraryInvalidJSON(t *testing.T) {
	dir := useTempConfig(t)
	os.WriteFile(filepath.Join(dir, "library.json"), []byte("{not json"), 0600)
	if _, err := ReadLibrary(); err == nil || !strings.Contains(err.Error(), "isn't valid JSON") {
		t.Errorf("want a clear JSON error, got %v", err)
	}
}

func TestNotesGeneralAndHost(t *testing.T) {
	dir := useTempConfig(t)
	if n, err := ReadNote(wshrpc.CommandLibraryNoteRefData{Name: "todo"}); err != nil || n.Exists {
		t.Fatalf("missing note: %+v %v", n, err)
	}
	w, err := WriteNote(wshrpc.CommandLibraryNoteWriteData{Name: "todo", Content: "# Server chores\n- rotate keys\n"})
	if err != nil || !w.Exists || w.ModTs == 0 {
		t.Fatalf("write: %+v %v", w, err)
	}
	host := "admin@server.example.com:2222"
	if _, err := WriteNote(wshrpc.CommandLibraryNoteWriteData{Host: host, Content: "backups run at 02:00"}); err != nil {
		t.Fatal(err)
	}
	// the colon and anything else unsafe for Windows file names is encoded
	entries, _ := os.ReadDir(filepath.Join(dir, "notes", "hosts"))
	if len(entries) != 1 || strings.ContainsAny(entries[0].Name(), `:/\*?"<>|`) {
		t.Fatalf("host note file name: %v", entries)
	}
	list, err := ListNotes()
	if err != nil || len(list) != 2 {
		t.Fatalf("list: %+v %v", list, err)
	}
	var gotHost, gotGeneral bool
	for _, n := range list {
		if n.Host == host && n.Name == "" && n.Header == "backups run at 02:00" {
			gotHost = true
		}
		if n.Name == "todo" && n.Host == "" && n.Header == "Server chores" {
			gotGeneral = true
		}
	}
	if !gotHost || !gotGeneral {
		t.Errorf("list entries: %+v", list)
	}
	r, err := ReadNote(wshrpc.CommandLibraryNoteRefData{Host: host})
	if err != nil || r.Content != "backups run at 02:00" {
		t.Errorf("read host note: %+v %v", r, err)
	}
	if err := DeleteNote(wshrpc.CommandLibraryNoteRefData{Name: "todo"}); err != nil {
		t.Fatal(err)
	}
	if err := DeleteNote(wshrpc.CommandLibraryNoteRefData{Name: "todo"}); err != nil {
		t.Errorf("deleting a missing note should be a no-op: %v", err)
	}
}

func TestNoteConflictDetection(t *testing.T) {
	dir := useTempConfig(t)
	first, err := WriteNote(wshrpc.CommandLibraryNoteWriteData{Name: "plan", Content: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	// someone edits the file outside Wave
	path := filepath.Join(dir, "notes", "plan.md")
	os.WriteFile(path, []byte("edited elsewhere"), 0600)
	later := time.UnixMilli(first.ModTs).Add(5 * time.Second)
	os.Chtimes(path, later, later)
	_, err = WriteNote(wshrpc.CommandLibraryNoteWriteData{Name: "plan", Content: "v2", BaseModTs: first.ModTs})
	if !errors.Is(err, ErrNoteChanged) {
		t.Fatalf("want ErrNoteChanged, got %v", err)
	}
	cur, _ := ReadNote(wshrpc.CommandLibraryNoteRefData{Name: "plan"})
	if cur.Content != "edited elsewhere" {
		t.Errorf("outside edit was overwritten: %q", cur.Content)
	}
	if _, err := WriteNote(wshrpc.CommandLibraryNoteWriteData{Name: "plan", Content: "v2", BaseModTs: cur.ModTs}); err != nil {
		t.Errorf("save from the current version should work: %v", err)
	}
}

func TestNoteNameValidation(t *testing.T) {
	useTempConfig(t)
	bad := []string{"", "../escape", `a\b`, "a/b", "what?", ".hidden", "trailing.", "x:y", strings.Repeat("n", 121)}
	for _, name := range bad {
		if _, err := WriteNote(wshrpc.CommandLibraryNoteWriteData{Name: name, Content: "x"}); err == nil {
			t.Errorf("name %q should be rejected", name)
		}
	}
	if _, err := WriteNote(wshrpc.CommandLibraryNoteWriteData{Name: "Nginx notes (prod) 2026", Content: "x"}); err != nil {
		t.Errorf("ordinary name rejected: %v", err)
	}
	if _, err := WriteNote(wshrpc.CommandLibraryNoteWriteData{Name: "x", Host: "h", Content: "x"}); err == nil {
		t.Errorf("name+host should be rejected")
	}
}
