// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package wshfs

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/fspath"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// Streaming copy through wavesrv for copies between hosts and for anything touching a no-wsh
// (SFTP) host: the source is streamed (SFTP read or wsh stream) and written in pieces (a truncating
// write, then appends), so file size isn't bounded by the single-message transfer limit and the
// same code serves both kinds of host. Folders are copied recursively.

const StreamCopyChunkBytes = 16 * 1024 * 1024

// hooks so tests can run the copy against local directories
var (
	scStat    = Stat
	scList    = ListEntries
	scOpen    = OpenStream
	scPutFile = PutFile
	scAppend  = Append
	scMkdir   = Mkdir
	scDelete  = func(ctx context.Context, uri string) error {
		return Delete(ctx, wshrpc.CommandDeleteFileData{Path: uri, Recursive: true})
	}
	scChildURI = childURI
)

// OpenStream opens a file on any host for streaming reads: directly over SFTP for no-wsh hosts,
// through a wsh stream otherwise.
func OpenStream(ctx context.Context, uri string) (*wshrpc.FileInfo, io.ReadCloser, error) {
	info, reader, handled, err := OpenAltStream(ctx, uri, "")
	if handled {
		return info, reader, err
	}
	writerRouteId, err := GetConnectionRouteId(ctx, uri)
	if err != nil {
		return nil, nil, err
	}
	bareRpc := wshclient.GetBareRpcClient()
	readerRouteId := wshclient.GetBareRpcClientRouteId()
	streamReader, streamMeta := bareRpc.StreamBroker.CreateStreamReader(readerRouteId, writerRouteId, 256*1024)
	info, err = FileStream(ctx, wshrpc.CommandFileStreamData{
		Info:       &wshrpc.FileInfo{Path: uri},
		StreamMeta: *streamMeta,
	})
	if err != nil {
		streamReader.Close()
		return nil, nil, err
	}
	return info, streamReader, nil
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

// streamCopyFile copies one file's contents to destUri (created or truncated).
func streamCopyFile(ctx context.Context, srcUri, destUri string, mode uint32) error {
	_, reader, err := scOpen(ctx, srcUri)
	if err != nil {
		return fmt.Errorf("cannot read %q: %w", srcUri, err)
	}
	defer reader.Close()
	buf := make([]byte, StreamCopyChunkBytes)
	first := true
	for {
		n, readErr := io.ReadFull(reader, buf)
		if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
			return fmt.Errorf("reading %q: %w", srcUri, readErr)
		}
		if n > 0 || first {
			data := wshrpc.FileData{Info: &wshrpc.FileInfo{Path: destUri}, Data64: base64.StdEncoding.EncodeToString(buf[:n])}
			if first {
				data.Info.Mode = os.FileMode(mode)
				err = scPutFile(ctx, data)
			} else {
				err = scAppend(ctx, data)
			}
			if err != nil {
				return fmt.Errorf("writing %q: %w", destUri, err)
			}
			first = false
		}
		if readErr != nil {
			return nil
		}
	}
}

// streamCopy mirrors RemoteFileCopyCommand's semantics: a destination folder (or trailing slash)
// means "copy into"; an existing file needs overwrite; an existing folder needs overwrite
// (replace) or merge (copy into it, replacing files with the same name).
func streamCopy(ctx context.Context, srcUri, destUri string, opts *wshrpc.FileCopyOpts) error {
	if opts.Overwrite && opts.Merge {
		return fmt.Errorf("cannot specify both overwrite and merge")
	}
	srcInfo, err := scStat(ctx, srcUri)
	if err != nil {
		return fmt.Errorf("cannot get info for source %q: %w", srcUri, err)
	}
	if srcInfo.NotFound {
		return fmt.Errorf("source %q not found", srcUri)
	}
	if srcInfo.IsDir && !opts.Recursive {
		return fmt.Errorf("copying a folder requires the recursive flag")
	}
	finalUri := destUri
	destInfo, err := scStat(ctx, destUri)
	if err != nil {
		return fmt.Errorf("cannot stat destination %q: %w", destUri, err)
	}
	if strings.HasSuffix(destUri, "/") || (!destInfo.NotFound && destInfo.IsDir) {
		srcConn, err := connparse.ParseURIAndReplaceCurrentHost(ctx, srcUri)
		if err != nil {
			return err
		}
		finalUri, err = scChildURI(ctx, strings.TrimSuffix(destUri, "/"), fspath.Base(srcConn.Path))
		if err != nil {
			return err
		}
		if destInfo, err = scStat(ctx, finalUri); err != nil {
			return fmt.Errorf("cannot stat destination %q: %w", finalUri, err)
		}
	}
	if !srcInfo.IsDir {
		if !destInfo.NotFound {
			if destInfo.IsDir {
				return fmt.Errorf("cannot overwrite folder %q with a file", finalUri)
			}
			if !opts.Overwrite && !opts.Merge {
				return fmt.Errorf(OverwriteRequiredError, finalUri)
			}
		}
		return streamCopyFile(ctx, srcUri, finalUri, uint32(srcInfo.Mode.Perm()))
	}
	if !destInfo.NotFound {
		switch {
		case !destInfo.IsDir && !opts.Overwrite:
			return fmt.Errorf(OverwriteRequiredError, finalUri)
		case destInfo.IsDir && !opts.Overwrite && !opts.Merge:
			return fmt.Errorf(MergeRequiredError, finalUri)
		case opts.Overwrite:
			if err := scDelete(ctx, finalUri); err != nil {
				return fmt.Errorf("cannot remove %q: %w", finalUri, err)
			}
		}
	}
	return streamCopyDir(ctx, srcUri, finalUri, 0)
}

func streamCopyDir(ctx context.Context, srcUri, destUri string, depth int) error {
	if depth > 64 {
		return fmt.Errorf("folders nested too deep at %q", srcUri)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := scMkdir(ctx, destUri); err != nil {
		// an existing folder is fine when merging
		info, statErr := scStat(ctx, destUri)
		if statErr != nil || info.NotFound || !info.IsDir {
			return fmt.Errorf("cannot create folder %q: %w", destUri, err)
		}
	}
	children, err := scList(ctx, srcUri, &wshrpc.FileListOpts{All: true})
	if err != nil {
		return fmt.Errorf("cannot list %q: %w", srcUri, err)
	}
	for _, child := range children {
		if child == nil || child.Name == "" || child.Name == "." || child.Name == ".." {
			continue
		}
		childSrc, err := scChildURI(ctx, srcUri, child.Name)
		if err != nil {
			return err
		}
		childDest, err := scChildURI(ctx, destUri, child.Name)
		if err != nil {
			return err
		}
		if child.IsDir {
			// symlinked folders could loop back on themselves
			if child.Mode&os.ModeSymlink != 0 {
				continue
			}
			if err := streamCopyDir(ctx, childSrc, childDest, depth+1); err != nil {
				return err
			}
			continue
		}
		if err := streamCopyFile(ctx, childSrc, childDest, uint32(child.Mode.Perm())); err != nil {
			return err
		}
	}
	return nil
}
