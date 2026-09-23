// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package sftpfs

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/wshfs"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Exercises wshfs's dispatch to AltFs (as wavesrv does after sftpfs.Init) with two
// SFTP-backed hosts, including cross-host copy/move through wavesrv.
func TestWshfsDispatchAcrossSftpHosts(t *testing.T) {
	backA, homeA := newTestBackend(t)
	backB, homeB := newTestBackend(t)
	hosts := map[string]wshfs.AltFs{"me@hosta": backA, "me@hostb": backB}
	prev := wshfs.AltFsForHost
	wshfs.AltFsForHost = func(ctx context.Context, host string) wshfs.AltFs { return hosts[host] }
	t.Cleanup(func() { wshfs.AltFsForHost = prev })
	ctx := context.Background()

	mustWrite(t, filepath.Join(homeA, "src.txt"), "payload")
	if err := os.MkdirAll(filepath.Join(homeB, "dest"), 0755); err != nil {
		t.Fatal(err)
	}

	// Stat + Read through wshfs
	info, err := wshfs.Stat(ctx, "wsh://me@hosta/~/src.txt")
	if err != nil || info.Size != 7 {
		t.Fatalf("stat: %v %+v", err, info)
	}
	fd, err := wshfs.Read(ctx, wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://me@hosta/~/src.txt"}})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := base64.StdEncoding.DecodeString(fd.Data64); string(got) != "payload" {
		t.Errorf("read got %q", got)
	}

	// copy into an existing directory on another host
	if err := wshfs.Copy(ctx, wshrpc.CommandFileCopyData{SrcUri: "wsh://me@hosta/~/src.txt", DestUri: "wsh://me@hostb/~/dest"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(homeB, "dest", "src.txt")); string(got) != "payload" {
		t.Errorf("cross-host copy got %q", got)
	}
	// copying again without overwrite fails, with overwrite succeeds
	err = wshfs.Copy(ctx, wshrpc.CommandFileCopyData{SrcUri: "wsh://me@hosta/~/src.txt", DestUri: "wsh://me@hostb/~/dest/src.txt"})
	if err == nil || !strings.Contains(err.Error(), "overwrite") {
		t.Errorf("expected overwrite-required error, got %v", err)
	}
	mustWrite(t, filepath.Join(homeA, "src.txt"), "payload v2")
	if err := wshfs.Copy(ctx, wshrpc.CommandFileCopyData{SrcUri: "wsh://me@hosta/~/src.txt", DestUri: "wsh://me@hostb/~/dest/src.txt", Opts: &wshrpc.FileCopyOpts{Overwrite: true}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(homeB, "dest", "src.txt")); string(got) != "payload v2" {
		t.Errorf("overwrite copy got %q", got)
	}
	// directories are refused (same as wsh)
	if err := wshfs.Copy(ctx, wshrpc.CommandFileCopyData{SrcUri: "wsh://me@hostb/~/dest", DestUri: "wsh://me@hosta/~/destcopy"}); err == nil {
		t.Error("expected directory copy to be refused")
	}

	// cross-host move = copy + delete source
	if err := wshfs.Move(ctx, wshrpc.CommandFileCopyData{SrcUri: "wsh://me@hosta/~/src.txt", DestUri: "wsh://me@hostb/~/moved.txt"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(homeA, "src.txt")); !os.IsNotExist(err) {
		t.Errorf("source should be gone after move: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(homeB, "moved.txt")); string(got) != "payload v2" {
		t.Errorf("moved content %q", got)
	}
	// same-host move uses rename
	if err := wshfs.Move(ctx, wshrpc.CommandFileCopyData{SrcUri: "wsh://me@hostb/~/moved.txt", DestUri: "wsh://me@hostb/~/dest/renamed.txt"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(homeB, "dest", "renamed.txt")); err != nil {
		t.Errorf("same-host move: %v", err)
	}

	// list via the streaming API the preview view uses
	entries, err := wshfs.ListEntries(ctx, "wsh://me@hostb/~/dest", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(entries))
	}

	// OpenAltStream (web stream handler) for an alt host, not handled for others
	sinfo, rdr, handled, err := wshfs.OpenAltStream(ctx, "wsh://me@hostb/~/dest/renamed.txt", "0-3")
	if err != nil || !handled || rdr == nil {
		t.Fatalf("OpenAltStream: %v handled=%v", err, handled)
	}
	buf := make([]byte, 16)
	n, _ := rdr.Read(buf)
	rdr.Close()
	if string(buf[:n]) != "payl" || sinfo.Size != 10 {
		t.Errorf("ranged stream got %q size %d", buf[:n], sinfo.Size)
	}
	if _, _, handled, _ := wshfs.OpenAltStream(ctx, "wsh://me@notalt/~/x", ""); handled {
		t.Error("non-alt host should not be handled")
	}
}
