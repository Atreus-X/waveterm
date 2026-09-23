// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshfs

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/fspath"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// AltFs is a file backend for connections that have no wsh connserver to route file RPCs to
// (e.g. SSH connections with conn:wshenabled=false, served over SFTP). Paths are the
// connection-relative paths from the URI (may start with "~"). Semantics mirror the
// corresponding wshremote Remote*Command implementations.
type AltFs interface {
	Stat(ctx context.Context, path string) (*wshrpc.FileInfo, error)
	Join(ctx context.Context, paths []string) (*wshrpc.FileInfo, error)
	ListEntries(ctx context.Context, path string, opts *wshrpc.FileListOpts) <-chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData]
	// OpenRead returns info and a reader for the (optionally ranged) file contents.
	// reader is nil when the file is not found (info.NotFound is set).
	OpenRead(ctx context.Context, path string, byteRange string) (*wshrpc.FileInfo, io.ReadCloser, error)
	Write(ctx context.Context, data wshrpc.FileData) error
	Mkdir(ctx context.Context, path string) error
	Delete(ctx context.Context, path string, recursive bool) error
	Move(ctx context.Context, srcPath string, destPath string) error
}

// AltFsForHost returns the AltFs to use for a connection host, or nil to use normal wsh routing.
// Only set in wavesrv (the wsh connserver leaves it nil).
var AltFsForHost func(ctx context.Context, host string) AltFs

func getAltFs(ctx context.Context, host string) AltFs {
	if AltFsForHost == nil {
		return nil
	}
	return AltFsForHost(ctx, host)
}

// OpenAltStream serves streaming reads (the /wave/stream-file handler) for alt-backed hosts.
// handled is false when path is not on an alt-backed host (caller should use FileStream).
func OpenAltStream(ctx context.Context, path string, byteRange string) (info *wshrpc.FileInfo, reader io.ReadCloser, handled bool, err error) {
	conn, err := parseConnection(ctx, path)
	if err != nil {
		return nil, nil, false, err
	}
	alt := getAltFs(ctx, conn.Host)
	if alt == nil {
		return nil, nil, false, nil
	}
	info, reader, err = alt.OpenRead(ctx, conn.Path, byteRange)
	return info, reader, true, err
}

func altRead(ctx context.Context, alt AltFs, conn *connparse.Connection, data wshrpc.FileData) (*wshrpc.FileData, error) {
	byteRange := ""
	if data.At != nil && data.At.Size > 0 {
		byteRange = fmt.Sprintf("%d-%d", data.At.Offset, data.At.Offset+int64(data.At.Size)-1)
	}
	info, reader, err := alt.OpenRead(ctx, conn.Path, byteRange)
	if err != nil {
		return nil, err
	}
	rtn := &wshrpc.FileData{Info: info}
	if reader == nil {
		return rtn, nil
	}
	defer reader.Close()
	if byteRange == "" && info.Size > RemoteFileTransferSizeLimit {
		return nil, fmt.Errorf("file %q size %d exceeds transfer limit of %d bytes", data.Info.Path, info.Size, RemoteFileTransferSizeLimit)
	}
	rawData, err := io.ReadAll(io.LimitReader(reader, RemoteFileTransferSizeLimit+1))
	if err != nil {
		return nil, fmt.Errorf("reading file: %w", err)
	}
	if len(rawData) > RemoteFileTransferSizeLimit {
		return nil, fmt.Errorf("file %q exceeds transfer limit of %d bytes", data.Info.Path, RemoteFileTransferSizeLimit)
	}
	if len(rawData) > 0 {
		rtn.Data64 = base64.StdEncoding.EncodeToString(rawData)
	}
	return rtn, nil
}

// copyViaServer copies a single file between any two hosts (at least one alt-backed) by reading
// it into wavesrv and writing it out. Mirrors wshremote's RemoteFileCopyCommand semantics:
// files only, size-limited, dest dir or trailing slash means "copy into", overwrite required
// to replace an existing file.
func copyViaServer(ctx context.Context, srcUri, destUri string, opts *wshrpc.FileCopyOpts) error {
	if opts.Overwrite && opts.Merge {
		return fmt.Errorf("cannot specify both overwrite and merge")
	}
	srcInfo, err := Stat(ctx, srcUri)
	if err != nil {
		return fmt.Errorf("cannot get info for source file %q: %w", srcUri, err)
	}
	if srcInfo.NotFound {
		return fmt.Errorf("source file %q not found", srcUri)
	}
	if srcInfo.IsDir {
		return fmt.Errorf("copying directories is not supported")
	}
	if srcInfo.Size > RemoteFileTransferSizeLimit {
		return fmt.Errorf("file %q size %d exceeds transfer limit of %d bytes", srcUri, srcInfo.Size, RemoteFileTransferSizeLimit)
	}
	destConn, err := parseConnection(ctx, destUri)
	if err != nil {
		return err
	}
	srcConn, err := parseConnection(ctx, srcUri)
	if err != nil {
		return err
	}
	finalDestUri := destUri
	destInfo, err := Stat(ctx, destUri)
	if err != nil {
		return fmt.Errorf("cannot stat destination %q: %w", destUri, err)
	}
	if strings.HasSuffix(destUri, "/") || (!destInfo.NotFound && destInfo.IsDir) {
		intoDir := *destConn
		intoDir.Path = fspath.Join(destConn.Path, fspath.Base(srcConn.Path))
		finalDestUri = intoDir.GetFullURI()
		destInfo, err = Stat(ctx, finalDestUri)
		if err != nil {
			return fmt.Errorf("cannot stat destination %q: %w", finalDestUri, err)
		}
	}
	if !destInfo.NotFound {
		if !opts.Overwrite {
			return fmt.Errorf(OverwriteRequiredError, finalDestUri)
		}
		if destInfo.IsDir {
			return fmt.Errorf("cannot overwrite directory %q with a file", finalDestUri)
		}
	}
	fileData, err := Read(ctx, wshrpc.FileData{Info: &wshrpc.FileInfo{Path: srcUri}})
	if err != nil {
		return fmt.Errorf("cannot read %q: %w", srcUri, err)
	}
	return PutFile(ctx, wshrpc.FileData{
		Info:   &wshrpc.FileInfo{Path: finalDestUri, Mode: srcInfo.Mode.Perm()},
		Data64: fileData.Data64,
	})
}
