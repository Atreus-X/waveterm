// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Package library stores terminal snippets (library.json) and Markdown notes (notes/, notes/hosts/)
// as plain files in the Wave config directory, so they're easy to edit, back up and sync.
package library

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	libraryFileName = "library.json"
	notesDirName    = "notes"
	hostNotesDir    = "hosts"
	noteExt         = ".md"
	maxNoteBytes    = 4 * 1024 * 1024
	maxHeaderLen    = 100
)

var (
	lock sync.Mutex
	// general note names become file names: no path separators or characters Windows forbids
	noteNameRe = regexp.MustCompile(`^[^/\\:*?"<>|\x00-\x1f]{1,120}$`)
	// characters kept as-is in host note file names; everything else is %-encoded (":" in "host:22", "/"...)
	hostSafeRe = regexp.MustCompile(`^[A-Za-z0-9._@-]$`)
)

var ErrNoteChanged = errors.New("the note changed on disk since you opened it (edited outside Wave?); reload it before saving")

func configDir() string {
	return wavebase.GetWaveConfigDir()
}

func libraryPath() string {
	return filepath.Join(configDir(), libraryFileName)
}

func notesPath() string {
	return filepath.Join(configDir(), notesDirName)
}

// atomicWrite writes to a temp file in the same directory and renames it into place.
func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-"+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// ---- snippets ----

func normalize(data *wshrpc.LibraryData) {
	if data.Snippets == nil {
		data.Snippets = []wshrpc.LibrarySnippet{}
	}
	seen := make(map[string]bool)
	for i := range data.Snippets {
		s := &data.Snippets[i]
		if s.Id == "" || seen[s.Id] {
			s.Id = uuid.NewString()
		}
		seen[s.Id] = true
		s.Title = strings.TrimSpace(s.Title)
		if s.Tags == nil {
			s.Tags = []string{}
		}
		if s.Hosts == nil {
			s.Hosts = []string{}
		}
	}
}

func readLibrary() (*wshrpc.LibraryData, error) {
	data := &wshrpc.LibraryData{}
	raw, err := os.ReadFile(libraryPath())
	if errors.Is(err, fs.ErrNotExist) {
		normalize(data)
		return data, nil
	}
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(raw))) > 0 {
		if err := json.Unmarshal(raw, data); err != nil {
			return nil, fmt.Errorf("%s isn't valid JSON: %w", libraryPath(), err)
		}
	}
	normalize(data)
	return data, nil
}

func ReadLibrary() (*wshrpc.LibraryData, error) {
	lock.Lock()
	defer lock.Unlock()
	return readLibrary()
}

func WriteLibrary(data wshrpc.LibraryData) error {
	lock.Lock()
	defer lock.Unlock()
	normalize(&data)
	out, err := json.MarshalIndent(data, "", "    ")
	if err != nil {
		return err
	}
	return atomicWrite(libraryPath(), append(out, '\n'))
}

// ---- notes ----

// encodeHost %-encodes every byte outside the safe set, so any connection name is a valid file name.
func encodeHost(conn string) string {
	var sb strings.Builder
	for i := 0; i < len(conn); i++ {
		b := conn[i]
		if hostSafeRe.MatchString(string(b)) {
			sb.WriteByte(b)
		} else {
			sb.WriteString(fmt.Sprintf("%%%02X", b))
		}
	}
	return sb.String()
}

func decodeHost(fileBase string) string {
	if v, err := url.PathUnescape(fileBase); err == nil {
		return v
	}
	return fileBase
}

func notePath(ref wshrpc.CommandLibraryNoteRefData) (string, error) {
	if ref.Host != "" {
		if ref.Name != "" {
			return "", fmt.Errorf("a note is either a host note or a named note, not both")
		}
		return filepath.Join(notesPath(), hostNotesDir, encodeHost(ref.Host)+noteExt), nil
	}
	name := strings.TrimSpace(ref.Name)
	if !noteNameRe.MatchString(name) || strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".") {
		return "", fmt.Errorf("invalid note name %q (avoid / \\ : * ? \" < > | and leading or trailing dots)", ref.Name)
	}
	return filepath.Join(notesPath(), name+noteExt), nil
}

func noteHeader(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#"))
		if line == "" {
			continue
		}
		if len(line) > maxHeaderLen {
			line = line[:maxHeaderLen]
		}
		return line
	}
	return ""
}

func listDir(dir string, isHost bool) ([]wshrpc.LibraryNoteInfo, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rtn []wshrpc.LibraryNoteInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), noteExt) || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		base := strings.TrimSuffix(e.Name(), noteExt)
		note := wshrpc.LibraryNoteInfo{ModTs: info.ModTime().UnixMilli(), Size: info.Size()}
		if isHost {
			note.Host = decodeHost(base)
		} else {
			note.Name = base
		}
		if info.Size() <= maxNoteBytes {
			if raw, err := os.ReadFile(filepath.Join(dir, e.Name())); err == nil {
				note.Header = noteHeader(string(raw))
			}
		}
		rtn = append(rtn, note)
	}
	return rtn, nil
}

func ListNotes() ([]wshrpc.LibraryNoteInfo, error) {
	lock.Lock()
	defer lock.Unlock()
	general, err := listDir(notesPath(), false)
	if err != nil {
		return nil, err
	}
	hosts, err := listDir(filepath.Join(notesPath(), hostNotesDir), true)
	if err != nil {
		return nil, err
	}
	rtn := append(general, hosts...)
	if rtn == nil {
		rtn = []wshrpc.LibraryNoteInfo{}
	}
	sort.SliceStable(rtn, func(i, j int) bool { return rtn[i].ModTs > rtn[j].ModTs })
	return rtn, nil
}

func readNote(path string) (*wshrpc.LibraryNoteData, error) {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return &wshrpc.LibraryNoteData{}, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Size() > maxNoteBytes {
		return nil, fmt.Errorf("note is larger than %d bytes", maxNoteBytes)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return &wshrpc.LibraryNoteData{Content: string(raw), ModTs: info.ModTime().UnixMilli(), Exists: true}, nil
}

func ReadNote(ref wshrpc.CommandLibraryNoteRefData) (*wshrpc.LibraryNoteData, error) {
	path, err := notePath(ref)
	if err != nil {
		return nil, err
	}
	lock.Lock()
	defer lock.Unlock()
	return readNote(path)
}

func WriteNote(data wshrpc.CommandLibraryNoteWriteData) (*wshrpc.LibraryNoteData, error) {
	path, err := notePath(wshrpc.CommandLibraryNoteRefData{Name: data.Name, Host: data.Host})
	if err != nil {
		return nil, err
	}
	if len(data.Content) > maxNoteBytes {
		return nil, fmt.Errorf("note is larger than %d bytes", maxNoteBytes)
	}
	lock.Lock()
	defer lock.Unlock()
	if data.BaseModTs != 0 {
		cur, err := readNote(path)
		if err != nil {
			return nil, err
		}
		if cur.Exists && cur.ModTs != data.BaseModTs {
			return nil, ErrNoteChanged
		}
	}
	if err := atomicWrite(path, []byte(data.Content)); err != nil {
		return nil, err
	}
	return readNote(path)
}

func DeleteNote(ref wshrpc.CommandLibraryNoteRefData) error {
	path, err := notePath(ref)
	if err != nil {
		return err
	}
	lock.Lock()
	defer lock.Unlock()
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
