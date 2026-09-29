// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/fspath"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/wshfs"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// /wave/stream-zip?paths=<json array of wsh:// URIs>[&name=x.zip] streams a zip of the given files
// and folders (folders recursively), built on the fly. Each file is streamed the same way
// /wave/stream-file does (wsh stream or SFTP), so there's no 32 MB transfer limit and nothing
// is staged on disk. Files that can't be read are listed in _download-errors.txt in the zip,
// since the response has already started by then.

const (
	zipMaxDepth   = 64
	zipMaxEntries = 200000
	zipErrorsName = "_download-errors.txt"
)

// file access used by the zip builder; tests swap these for a local directory
var (
	zipStat        = wshfs.Stat
	zipListEntries = wshfs.ListEntries
	zipOpenFile    = openFileReader
)

type zipBuilder struct {
	ctx     context.Context
	zw      *zip.Writer
	entries int
	errors  []string
}

// openFileReader opens a remote (or local) file for streaming, like handleStreamFileFromReader.
func openFileReader(ctx context.Context, path string) (*wshrpc.FileInfo, io.ReadCloser, error) {
	altInfo, altReader, handled, err := wshfs.OpenAltStream(ctx, path, "")
	if handled {
		return altInfo, altReader, err
	}
	writerRouteId, err := wshfs.GetConnectionRouteId(ctx, path)
	if err != nil {
		return nil, nil, err
	}
	bareRpc := wshclient.GetBareRpcClient()
	readerRouteId := wshclient.GetBareRpcClientRouteId()
	reader, streamMeta := bareRpc.StreamBroker.CreateStreamReader(readerRouteId, writerRouteId, 256*1024)
	info, err := wshfs.FileStream(ctx, wshrpc.CommandFileStreamData{
		Info:       &wshrpc.FileInfo{Path: path},
		StreamMeta: *streamMeta,
	})
	if err != nil {
		reader.Close()
		return nil, nil, err
	}
	return info, reader, nil
}

func childURI(ctx context.Context, parentURI string, name string) (string, error) {
	conn, err := connparse.ParseURIAndReplaceCurrentHost(ctx, parentURI)
	if err != nil {
		return "", err
	}
	child := *conn
	child.Path = fspath.Join(conn.Path, name)
	return child.GetFullURI(), nil
}

func (zb *zipBuilder) fail(zipName string, err error) {
	zb.errors = append(zb.errors, fmt.Sprintf("%s: %v", zipName, err))
}

func (zb *zipBuilder) addFile(uri string, zipName string, info *wshrpc.FileInfo) {
	_, reader, err := zipOpenFile(zb.ctx, uri)
	if err != nil {
		zb.fail(zipName, err)
		return
	}
	defer reader.Close()
	hdr := &zip.FileHeader{Name: zipName, Method: zip.Deflate}
	if info.ModTime > 0 {
		hdr.Modified = time.UnixMilli(info.ModTime)
	}
	if info.Mode != 0 {
		hdr.SetMode(info.Mode)
	}
	w, err := zb.zw.CreateHeader(hdr)
	if err != nil {
		zb.fail(zipName, err)
		return
	}
	if _, err := io.Copy(w, reader); err != nil {
		zb.fail(zipName, fmt.Errorf("incomplete: %w", err))
	}
}

func (zb *zipBuilder) add(uri string, zipName string, info *wshrpc.FileInfo, depth int) error {
	if err := zb.ctx.Err(); err != nil {
		return err
	}
	zb.entries++
	if zb.entries > zipMaxEntries {
		return fmt.Errorf("more than %d files and folders", zipMaxEntries)
	}
	if !info.IsDir {
		zb.addFile(uri, zipName, info)
		return nil
	}
	if _, err := zb.zw.Create(zipName + "/"); err != nil {
		return err
	}
	// a symlinked folder could loop back on itself
	if info.Mode&os.ModeSymlink != 0 || depth >= zipMaxDepth {
		return nil
	}
	children, err := zipListEntries(zb.ctx, uri, &wshrpc.FileListOpts{All: true})
	if err != nil {
		zb.fail(zipName+"/", err)
		return nil
	}
	for _, child := range children {
		if child == nil || child.Name == "" || child.Name == "." || child.Name == ".." {
			continue
		}
		cURI, err := childURI(zb.ctx, uri, child.Name)
		if err != nil {
			zb.fail(zipName+"/"+child.Name, err)
			continue
		}
		if err := zb.add(cURI, zipName+"/"+child.Name, child, depth+1); err != nil {
			return err
		}
	}
	return nil
}

// zipEntryName is the name a top-level path gets inside the zip.
func zipEntryName(uri string, info *wshrpc.FileInfo) string {
	name := info.Name
	if name == "" {
		trimmed := strings.TrimRight(uri, "/")
		name = trimmed[strings.LastIndex(trimmed, "/")+1:]
	}
	if name == "" || name == "~" || name == "." {
		name = "files"
	}
	return name
}

// uniqueName keeps two selected items with the same name (e.g. from different folders) apart.
func uniqueName(name string, used map[string]bool) string {
	if !used[name] {
		used[name] = true
		return name
	}
	stem, ext := name, ""
	if dot := strings.LastIndex(name, "."); dot > 0 {
		stem, ext = name[:dot], name[dot:]
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", stem, i, ext)
		if !used[candidate] {
			used[candidate] = true
			return candidate
		}
	}
}

func handleStreamZip(w http.ResponseWriter, r *http.Request) {
	var paths []string
	if err := json.Unmarshal([]byte(r.URL.Query().Get("paths")), &paths); err != nil || len(paths) == 0 {
		http.Error(w, "paths must be a non-empty JSON array", http.StatusBadRequest)
		return
	}
	zipName := r.URL.Query().Get("name")
	if zipName == "" {
		zipName = "download.zip"
	}
	ctx := r.Context()
	type topItem struct {
		uri  string
		info *wshrpc.FileInfo
	}
	var items []topItem
	for _, p := range paths {
		info, err := zipStat(ctx, p)
		if err != nil {
			http.Error(w, fmt.Sprintf("cannot read %q: %v", p, err), http.StatusBadRequest)
			return
		}
		if info.NotFound {
			http.Error(w, fmt.Sprintf("not found: %q", p), http.StatusNotFound)
			return
		}
		items = append(items, topItem{uri: p, info: info})
	}

	w.Header().Set(ContentTypeHeaderKey, "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", zipName))
	http.NewResponseController(w).SetWriteDeadline(time.Time{})
	zw := zip.NewWriter(w)
	zb := &zipBuilder{ctx: ctx, zw: zw}
	used := make(map[string]bool)
	for _, it := range items {
		if err := zb.add(it.uri, uniqueName(zipEntryName(it.uri, it.info), used), it.info, 0); err != nil {
			zb.errors = append(zb.errors, fmt.Sprintf("stopped: %v", err))
			break
		}
	}
	if len(zb.errors) > 0 && ctx.Err() == nil {
		if ew, err := zw.Create(zipErrorsName); err == nil {
			io.WriteString(ew, "These couldn't be added to the zip:\n\n"+strings.Join(zb.errors, "\n")+"\n")
		}
		log.Printf("stream-zip %s: %d error(s)\n", zipName, len(zb.errors))
	}
	if err := zw.Close(); err != nil && ctx.Err() == nil {
		log.Printf("stream-zip %s: %v\n", zipName, err)
	}
}
