// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package wshfs

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// runs streamCopy against real local directories through its hooks; also counts write calls
func useLocalCopyBackend(t *testing.T) *int {
	writes := 0
	local := func(uri string) string {
		conn, err := connparse.ParseURI(uri)
		if err != nil {
			t.Fatalf("parse %q: %v", uri, err)
		}
		return conn.Path
	}
	info := func(p string) (*wshrpc.FileInfo, error) {
		st, err := os.Lstat(p)
		if os.IsNotExist(err) {
			return &wshrpc.FileInfo{Path: p, NotFound: true}, nil
		}
		if err != nil {
			return nil, err
		}
		return &wshrpc.FileInfo{Path: p, Name: st.Name(), Size: st.Size(), Mode: st.Mode(), IsDir: st.IsDir()}, nil
	}
	decode := func(d wshrpc.FileData) []byte {
		b, err := base64.StdEncoding.DecodeString(d.Data64)
		if err != nil {
			t.Fatal(err)
		}
		if len(b) > 32*1024*1024 {
			t.Fatalf("a single write carried %d bytes (over the 32 MB transfer limit)", len(b))
		}
		return b
	}
	old := []any{scStat, scList, scOpen, scPutFile, scAppend, scMkdir, scDelete, scChildURI}
	t.Cleanup(func() {
		scStat = old[0].(func(context.Context, string) (*wshrpc.FileInfo, error))
		scList = old[1].(func(context.Context, string, *wshrpc.FileListOpts) ([]*wshrpc.FileInfo, error))
		scOpen = old[2].(func(context.Context, string) (*wshrpc.FileInfo, io.ReadCloser, error))
		scPutFile = old[3].(func(context.Context, wshrpc.FileData) error)
		scAppend = old[4].(func(context.Context, wshrpc.FileData) error)
		scMkdir = old[5].(func(context.Context, string) error)
		scDelete = old[6].(func(context.Context, string) error)
		scChildURI = old[7].(func(context.Context, string, string) (string, error))
	})
	scStat = func(ctx context.Context, uri string) (*wshrpc.FileInfo, error) { return info(local(uri)) }
	scList = func(ctx context.Context, uri string, _ *wshrpc.FileListOpts) ([]*wshrpc.FileInfo, error) {
		ents, err := os.ReadDir(local(uri))
		if err != nil {
			return nil, err
		}
		var rtn []*wshrpc.FileInfo
		for _, e := range ents {
			fi, _ := info(filepath.Join(local(uri), e.Name()))
			rtn = append(rtn, fi)
		}
		return rtn, nil
	}
	scOpen = func(ctx context.Context, uri string) (*wshrpc.FileInfo, io.ReadCloser, error) {
		fi, _ := info(local(uri))
		f, err := os.Open(local(uri))
		return fi, f, err
	}
	scPutFile = func(ctx context.Context, d wshrpc.FileData) error {
		writes++
		return os.WriteFile(local(d.Info.Path), decode(d), 0o644)
	}
	scAppend = func(ctx context.Context, d wshrpc.FileData) error {
		writes++
		f, err := os.OpenFile(local(d.Info.Path), os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.Write(decode(d))
		return err
	}
	scMkdir = func(ctx context.Context, uri string) error { return os.Mkdir(local(uri), 0o755) }
	scDelete = func(ctx context.Context, uri string) error { return os.RemoveAll(local(uri)) }
	scChildURI = func(ctx context.Context, parent, name string) (string, error) {
		return uriOf(filepath.Join(local(parent), name)), nil
	}
	return &writes
}

func uriOf(p string) string { return "wsh://desthost/" + p }

func TestStreamCopy(t *testing.T) {
	writes := useLocalCopyBackend(t)
	ctx := context.Background()
	src, dst := t.TempDir(), t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Helper()
			t.Fatal(err)
		}
	}
	big := make([]byte, 40*1024*1024)
	rand.Read(big)
	must(os.WriteFile(filepath.Join(src, "big.bin"), big, 0o640))
	must(os.MkdirAll(filepath.Join(src, "proj", "a", "b"), 0o755))
	must(os.WriteFile(filepath.Join(src, "proj", "top.txt"), []byte("top"), 0o644))
	must(os.WriteFile(filepath.Join(src, "proj", "a", "b", "deep.txt"), []byte("deep"), 0o644))
	must(os.WriteFile(filepath.Join(src, "empty.txt"), nil, 0o644))

	// 40 MB file into a folder (trailing slash): 3 pieces, none over the limit
	must(streamCopy(ctx, uriOf(filepath.Join(src, "big.bin")), uriOf(dst)+"/", &wshrpc.FileCopyOpts{}))
	got, _ := os.ReadFile(filepath.Join(dst, "big.bin"))
	if !bytes.Equal(got, big) {
		t.Fatalf("big.bin differs (len %d)", len(got))
	}
	if *writes != 3 {
		t.Errorf("40 MB copy used %d writes, want 3", *writes)
	}

	// empty file still gets created
	must(streamCopy(ctx, uriOf(filepath.Join(src, "empty.txt")), uriOf(dst), &wshrpc.FileCopyOpts{}))
	if st, err := os.Stat(filepath.Join(dst, "empty.txt")); err != nil || st.Size() != 0 {
		t.Errorf("empty file: %v", err)
	}

	// same file again: overwrite required, then allowed
	err := streamCopy(ctx, uriOf(filepath.Join(src, "big.bin")), uriOf(dst), &wshrpc.FileCopyOpts{})
	if err == nil || !strings.Contains(err.Error(), "set overwrite flag to delete the existing file") {
		t.Errorf("want overwrite-required error, got %v", err)
	}
	must(streamCopy(ctx, uriOf(filepath.Join(src, "big.bin")), uriOf(dst), &wshrpc.FileCopyOpts{Overwrite: true}))

	// folder needs recursive
	if err := streamCopy(ctx, uriOf(filepath.Join(src, "proj")), uriOf(dst), &wshrpc.FileCopyOpts{}); err == nil {
		t.Errorf("folder copy without recursive should fail")
	}
	must(streamCopy(ctx, uriOf(filepath.Join(src, "proj")), uriOf(dst), &wshrpc.FileCopyOpts{Recursive: true}))
	if b, _ := os.ReadFile(filepath.Join(dst, "proj", "a", "b", "deep.txt")); string(b) != "deep" {
		t.Errorf("deep.txt = %q", b)
	}

	// existing folder: merge required; merge keeps extra files and refreshes copied ones
	must(os.WriteFile(filepath.Join(dst, "proj", "extra.txt"), []byte("keep"), 0o644))
	must(os.WriteFile(filepath.Join(src, "proj", "top.txt"), []byte("top v2"), 0o644))
	err = streamCopy(ctx, uriOf(filepath.Join(src, "proj")), uriOf(dst), &wshrpc.FileCopyOpts{Recursive: true})
	if err == nil || !strings.Contains(err.Error(), "set merge flag to merge the contents") {
		t.Errorf("want merge-required error, got %v", err)
	}
	must(streamCopy(ctx, uriOf(filepath.Join(src, "proj")), uriOf(dst), &wshrpc.FileCopyOpts{Recursive: true, Merge: true}))
	if b, _ := os.ReadFile(filepath.Join(dst, "proj", "top.txt")); string(b) != "top v2" {
		t.Errorf("merge didn't refresh top.txt: %q", b)
	}
	if _, err := os.Stat(filepath.Join(dst, "proj", "extra.txt")); err != nil {
		t.Errorf("merge removed extra.txt")
	}

	// overwrite replaces the folder
	must(streamCopy(ctx, uriOf(filepath.Join(src, "proj")), uriOf(dst), &wshrpc.FileCopyOpts{Recursive: true, Overwrite: true}))
	if _, err := os.Stat(filepath.Join(dst, "proj", "extra.txt")); !os.IsNotExist(err) {
		t.Errorf("overwrite kept extra.txt")
	}

	if err := streamCopy(ctx, uriOf(filepath.Join(src, "missing")), uriOf(dst), &wshrpc.FileCopyOpts{}); err == nil {
		t.Errorf("missing source should fail")
	}
}
