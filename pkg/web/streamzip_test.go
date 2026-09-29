// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// serves a real directory through the zip builder's file hooks, keyed by wsh:// URIs
func useLocalZipBackend(t *testing.T) {
	localPath := func(uri string) string {
		conn, err := connparse.ParseURI(uri)
		if err != nil {
			t.Fatalf("parse %q: %v", uri, err)
		}
		return conn.Path
	}
	infoFor := func(p string) (*wshrpc.FileInfo, error) {
		st, err := os.Lstat(p)
		if os.IsNotExist(err) {
			return &wshrpc.FileInfo{Path: p, NotFound: true}, nil
		}
		if err != nil {
			return nil, err
		}
		return &wshrpc.FileInfo{Path: p, Name: st.Name(), Size: st.Size(), Mode: st.Mode(), ModTime: st.ModTime().UnixMilli(), IsDir: st.IsDir()}, nil
	}
	oldStat, oldList, oldOpen := zipStat, zipListEntries, zipOpenFile
	t.Cleanup(func() { zipStat, zipListEntries, zipOpenFile = oldStat, oldList, oldOpen })
	zipStat = func(ctx context.Context, uri string) (*wshrpc.FileInfo, error) { return infoFor(localPath(uri)) }
	zipListEntries = func(ctx context.Context, uri string, opts *wshrpc.FileListOpts) ([]*wshrpc.FileInfo, error) {
		dir := localPath(uri)
		ents, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		var rtn []*wshrpc.FileInfo
		for _, e := range ents {
			fi, err := infoFor(filepath.Join(dir, e.Name()))
			if err != nil {
				return nil, err
			}
			rtn = append(rtn, fi)
		}
		return rtn, nil
	}
	zipOpenFile = func(ctx context.Context, uri string) (*wshrpc.FileInfo, io.ReadCloser, error) {
		p := localPath(uri)
		if strings.HasSuffix(p, "unreadable.txt") {
			return nil, nil, fmt.Errorf("permission denied")
		}
		fi, err := infoFor(p)
		if err != nil {
			return nil, nil, err
		}
		f, err := os.Open(p)
		return fi, f, err
	}
}

func uriFor(p string) string { return "wsh://testhost/" + p }

func fetchZip(t *testing.T, uris []string, name string) *zip.Reader {
	pathsJson, _ := json.Marshal(uris)
	req := httptest.NewRequest(http.MethodGet, "/wave/stream-zip?name="+url.QueryEscape(name)+"&paths="+url.QueryEscape(string(pathsJson)), nil)
	rec := httptest.NewRecorder()
	handleStreamZip(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, name) {
		t.Errorf("content-disposition = %q", cd)
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("not a valid zip: %v", err)
	}
	return zr
}

func readZipFile(t *testing.T, zr *zip.Reader, name string) []byte {
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				t.Fatal(err)
			}
			defer rc.Close()
			b, _ := io.ReadAll(rc)
			return b
		}
	}
	t.Fatalf("%q not in zip", name)
	return nil
}

func TestStreamZip(t *testing.T) {
	useLocalZipBackend(t)
	root := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "proj", "src", "deep"), 0o755))
	must(os.MkdirAll(filepath.Join(root, "other"), 0o755))
	must(os.WriteFile(filepath.Join(root, "proj", "README.md"), []byte("hello"), 0o644))
	must(os.WriteFile(filepath.Join(root, "proj", "src", "deep", "main.go"), []byte("package main"), 0o644))
	must(os.WriteFile(filepath.Join(root, "proj", "unreadable.txt"), []byte("x"), 0o644))
	must(os.WriteFile(filepath.Join(root, "other", "README.md"), []byte("second"), 0o644))
	big := make([]byte, 40*1024*1024) // over the 32 MB single-message transfer limit
	rand.Read(big)
	must(os.WriteFile(filepath.Join(root, "big.bin"), big, 0o644))

	zr := fetchZip(t, []string{
		uriFor(filepath.Join(root, "proj")),
		uriFor(filepath.Join(root, "big.bin")),
		uriFor(filepath.Join(root, "other", "README.md")),
		uriFor(filepath.Join(root, "proj", "README.md")),
	}, "test-4-items.zip")

	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	has := func(n string) bool {
		for _, x := range names {
			if x == n {
				return true
			}
		}
		return false
	}
	for _, n := range []string{"proj/", "proj/README.md", "proj/src/deep/main.go", "big.bin", "README.md", "README (2).md", "_download-errors.txt"} {
		if !has(n) {
			t.Errorf("missing %q; got %v", n, names)
		}
	}
	if has("proj/unreadable.txt") {
		t.Errorf("unreadable file should be reported, not included")
	}
	if got := readZipFile(t, zr, "proj/src/deep/main.go"); string(got) != "package main" {
		t.Errorf("main.go = %q", got)
	}
	if got := readZipFile(t, zr, "big.bin"); !bytes.Equal(got, big) {
		t.Errorf("big.bin content differs (len %d)", len(got))
	}
	if got := readZipFile(t, zr, "README (2).md"); string(got) != "hello" {
		t.Errorf("second README = %q", got)
	}
	errs := string(readZipFile(t, zr, "_download-errors.txt"))
	if !strings.Contains(errs, "proj/unreadable.txt") || !strings.Contains(errs, "permission denied") {
		t.Errorf("errors file = %q", errs)
	}
}

func TestStreamZipBadRequests(t *testing.T) {
	useLocalZipBackend(t)
	for _, q := range []string{"", "paths=notjson", "paths=%5B%5D", "paths=" + url.QueryEscape(`["`+uriFor("/nonexistent/zz")+`"]`)} {
		rec := httptest.NewRecorder()
		handleStreamZip(rec, httptest.NewRequest(http.MethodGet, "/wave/stream-zip?"+q, nil))
		if rec.Code == http.StatusOK {
			t.Errorf("%q: expected an error status", q)
		}
	}
}
