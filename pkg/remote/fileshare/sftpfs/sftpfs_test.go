// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package sftpfs

import (
	"context"
	"encoding/base64"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/pkg/sftp"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/wshfs"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// newTestBackend runs an in-process SFTP server rooted at a temp dir (which acts as the remote
// home directory) and returns a Backend talking to it over a pipe.
func newTestBackend(t *testing.T) (*Backend, string) {
	t.Helper()
	home := t.TempDir()
	serverConn, clientConn := net.Pipe()
	server, err := sftp.NewServer(serverConn, sftp.WithServerWorkingDirectory(home))
	if err != nil {
		t.Fatal(err)
	}
	go server.Serve()
	client, err := sftp.NewClientPipe(clientConn, clientConn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		client.Close()
		server.Close()
	})
	wd, err := client.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	sess := &session{client: client, home: wd}
	return &Backend{getSession: func(context.Context) (*session, error) { return sess, nil }}, wd
}

func mustWrite(t *testing.T, p string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestStat(t *testing.T) {
	b, home := newTestBackend(t)
	ctx := context.Background()
	mustWrite(t, filepath.Join(home, "notes.md"), "# hi\n")

	info, err := b.Stat(ctx, "~/notes.md")
	if err != nil {
		t.Fatal(err)
	}
	if info.Path != "~/notes.md" || info.Name != "notes.md" || info.Size != 5 || info.IsDir || info.NotFound {
		t.Errorf("unexpected info %+v", info)
	}
	if info.Dir != home || info.MimeType != "text/markdown" || info.ReadOnly {
		t.Errorf("dir/mime/readonly: %q %q %v", info.Dir, info.MimeType, info.ReadOnly)
	}

	info, err = b.Stat(ctx, "~")
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir || info.Path != "~" || info.Size != -1 || info.MimeType != "directory" {
		t.Errorf("home info %+v", info)
	}

	info, err = b.Stat(ctx, "~/missing.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !info.NotFound || info.Path != "~/missing.txt" || !info.SupportsMkdir {
		t.Errorf("missing info %+v", info)
	}
	// the read-only probe must clean up after itself
	entries, _ := os.ReadDir(home)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "wsh-tmp-") {
			t.Errorf("leftover probe file %s", e.Name())
		}
	}

	// absolute paths outside home are not rewritten with ~
	info, err = b.Stat(ctx, "/")
	if err != nil {
		t.Fatal(err)
	}
	if info.Path != "/" || info.Dir != "/" || !info.IsDir {
		t.Errorf("root info %+v", info)
	}
}

func collectList(t *testing.T, ch <-chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData]) ([]string, error) {
	t.Helper()
	var names []string
	for r := range ch {
		if r.Error != nil {
			return nil, r.Error
		}
		for _, fi := range r.Response.FileInfo {
			n := fi.Name
			if fi.IsDir {
				n += "/"
			}
			names = append(names, n)
		}
	}
	sort.Strings(names)
	return names, nil
}

func TestListEntries(t *testing.T) {
	b, home := newTestBackend(t)
	ctx := context.Background()
	mustWrite(t, filepath.Join(home, "proj", "a.go"), "package a")
	mustWrite(t, filepath.Join(home, "proj", "sub", "b.txt"), "b")
	mustWrite(t, filepath.Join(home, "proj", ".hidden"), "h")

	names, err := collectList(t, b.ListEntries(ctx, "~/proj", nil))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(names, ",") != ".hidden,a.go,sub/" {
		t.Errorf("got %v", names)
	}

	// many entries are chunked
	for i := 0; i < wshrpc.DirChunkSize+5; i++ {
		mustWrite(t, filepath.Join(home, "big", "f"+strconv.Itoa(i)), "")
	}
	chunks := 0
	total := 0
	for r := range b.ListEntries(ctx, "~/big", nil) {
		if r.Error != nil {
			t.Fatal(r.Error)
		}
		chunks++
		total += len(r.Response.FileInfo)
	}
	if total != wshrpc.DirChunkSize+5 || chunks < 2 {
		t.Errorf("total=%d chunks=%d", total, chunks)
	}

	if _, err := collectList(t, b.ListEntries(ctx, "~/nope", nil)); err == nil {
		t.Error("expected error listing missing dir")
	}
	if _, err := collectList(t, b.ListEntries(ctx, "~/proj", &wshrpc.FileListOpts{All: true})); err == nil {
		t.Error("expected recursive listing to be rejected")
	}
}

func TestOpenRead(t *testing.T) {
	b, home := newTestBackend(t)
	ctx := context.Background()
	mustWrite(t, filepath.Join(home, "data.txt"), "0123456789")

	read := func(p, rng string) (string, *wshrpc.FileInfo) {
		t.Helper()
		info, rdr, err := b.OpenRead(ctx, p, rng)
		if err != nil {
			t.Fatalf("OpenRead(%q,%q): %v", p, rng, err)
		}
		if rdr == nil {
			return "", info
		}
		defer rdr.Close()
		data, err := io.ReadAll(rdr)
		if err != nil {
			t.Fatal(err)
		}
		return string(data), info
	}
	if got, info := read("~/data.txt", ""); got != "0123456789" || info.Size != 10 || info.Path != "~/data.txt" {
		t.Errorf("full read %q %+v", got, info)
	}
	if got, _ := read("~/data.txt", "2-4"); got != "234" {
		t.Errorf("range read %q", got)
	}
	if got, _ := read("~/data.txt", "7-"); got != "789" {
		t.Errorf("open-ended range %q", got)
	}
	if _, info := read("~/nothere", ""); !info.NotFound {
		t.Errorf("expected NotFound, got %+v", info)
	}
	if _, _, err := b.OpenRead(ctx, "~", ""); err == nil {
		t.Error("expected error streaming a directory")
	}
}

func TestWrite(t *testing.T) {
	b, home := newTestBackend(t)
	ctx := context.Background()
	target := filepath.Join(home, "out.txt")

	write := func(data wshrpc.FileData) {
		t.Helper()
		if err := b.Write(ctx, data); err != nil {
			t.Fatal(err)
		}
	}
	// create with mode
	write(wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "~/out.txt", Mode: 0600, Opts: &wshrpc.FileOpts{Truncate: true}}, Data64: b64("hello world")})
	if got, _ := os.ReadFile(target); string(got) != "hello world" {
		t.Errorf("after create: %q", got)
	}
	if st, _ := os.Stat(target); st.Mode().Perm() != 0600 {
		t.Errorf("mode %v", st.Mode().Perm())
	}
	// truncate + rewrite shorter
	write(wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "~/out.txt", Opts: &wshrpc.FileOpts{Truncate: true}}, Data64: b64("bye")})
	if got, _ := os.ReadFile(target); string(got) != "bye" {
		t.Errorf("after truncate: %q", got)
	}
	// append
	write(wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "~/out.txt", Opts: &wshrpc.FileOpts{Append: true}}, Data64: b64("!!")})
	if got, _ := os.ReadFile(target); string(got) != "bye!!" {
		t.Errorf("after append: %q", got)
	}
	// write at offset
	write(wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "~/out.txt"}, At: &wshrpc.FileDataAt{Offset: 1}, Data64: b64("YE")})
	if got, _ := os.ReadFile(target); string(got) != "bYE!!" {
		t.Errorf("after writeAt: %q", got)
	}
	// errors
	if err := b.Write(ctx, wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "~/out.txt"}, At: &wshrpc.FileDataAt{Offset: 100}, Data64: b64("x")}); err == nil {
		t.Error("expected offset past EOF error")
	}
	if err := b.Write(ctx, wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "~"}, Data64: b64("x")}); err == nil {
		t.Error("expected error writing over a directory")
	}
}

func TestMkdirDeleteMove(t *testing.T) {
	b, home := newTestBackend(t)
	ctx := context.Background()

	if err := b.Mkdir(ctx, "~/a/b/c"); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(filepath.Join(home, "a", "b", "c")); err != nil || !st.IsDir() {
		t.Fatalf("mkdir -p failed: %v", err)
	}
	if err := b.Mkdir(ctx, "~/a"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("expected already-exists error, got %v", err)
	}

	mustWrite(t, filepath.Join(home, "a", "b", "file.txt"), "x")
	// non-recursive delete of non-empty dir must be refused
	if err := b.Delete(ctx, "~/a", false); err == nil || err.Error() != wshfs.RecursiveRequiredError {
		t.Errorf("expected recursive-required error, got %v", err)
	}
	// move
	if err := b.Move(ctx, "~/a/b/file.txt", "~/moved.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "moved.txt")); err != nil {
		t.Errorf("move target missing: %v", err)
	}
	mustWrite(t, filepath.Join(home, "other.txt"), "o")
	if err := b.Move(ctx, "~/other.txt", "~/moved.txt"); err == nil {
		t.Error("expected move onto existing file to fail")
	}
	// delete file, empty dir, recursive
	if err := b.Delete(ctx, "~/moved.txt", false); err != nil {
		t.Fatal(err)
	}
	if err := b.Delete(ctx, "~/a/b/c", false); err != nil {
		t.Fatalf("delete empty dir: %v", err)
	}
	if err := b.Delete(ctx, "~/a", true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "a")); !os.IsNotExist(err) {
		t.Errorf("recursive delete left %v", err)
	}
}

func TestJoin(t *testing.T) {
	b, home := newTestBackend(t)
	ctx := context.Background()
	mustWrite(t, filepath.Join(home, "x", "y.txt"), "y")
	info, err := b.Join(ctx, []string{"~/x", "y.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if info.Path != "~/x/y.txt" || info.NotFound {
		t.Errorf("join info %+v", info)
	}
	info, err = b.Join(ctx, []string{"~/x", "/"})
	if err != nil {
		t.Fatal(err)
	}
	if info.Path != "/" {
		t.Errorf("absolute part should reset: %+v", info)
	}
}
