// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package wshfs

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/fspath"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Streaming copy through wavesrv for copies between hosts and for anything touching a no-wsh
// (SFTP) host: the source is streamed (SFTP read or wsh stream) and written in pieces (a truncating
// write, then appends), so file size isn't bounded by the single-message transfer limit and the
// same code serves both kinds of host. Folders are copied recursively.

// small enough that progress (and cancel) update every few seconds even on a slow link
const StreamCopyChunkBytes = 4 * 1024 * 1024

const CopyProgressInterval = 200 * time.Millisecond
const CopyCleanupTimeout = 15 * time.Second

var ErrCopyCanceled = errors.New("copy canceled")

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

// copyProgress publishes byte progress for one streamCopy; a nil *copyProgress does nothing.
type copyProgress struct {
	xferId  string
	name    string
	total   int64
	done    int64
	lastPub time.Time
}

func makeCopyProgress(xferId string, name string, total int64) *copyProgress {
	if xferId == "" {
		return nil
	}
	return &copyProgress{xferId: xferId, name: name, total: total}
}

func (p *copyProgress) publish(finished bool) {
	p.lastPub = time.Now()
	wps.Broker.Publish(wps.WaveEvent{
		Event: wps.Event_FileCopyProgress,
		Data: wshrpc.FileCopyProgressData{
			XferId:   p.xferId,
			Name:     p.name,
			Done:     p.done,
			Total:    p.total,
			Finished: finished,
		},
	})
}

func (p *copyProgress) add(n int64) {
	if p == nil {
		return
	}
	p.done += n
	if time.Since(p.lastPub) >= CopyProgressInterval {
		p.publish(false)
	}
}

func (p *copyProgress) finish() {
	if p == nil {
		return
	}
	p.publish(true)
}

// the requestor's cancel only flags the handler (it doesn't cancel ctx), so poll both
func copyCanceled(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if wshutil.GetIsCanceledFromContext(ctx) {
		return ErrCopyCanceled
	}
	return nil
}

// streamCopyFile copies one file's contents to destUri (created or truncated).
func streamCopyFile(ctx context.Context, srcUri, destUri string, mode uint32, prog *copyProgress) error {
	_, reader, err := scOpen(ctx, srcUri)
	if err != nil {
		return fmt.Errorf("cannot read %q: %w", srcUri, err)
	}
	defer reader.Close()
	buf := make([]byte, StreamCopyChunkBytes)
	first := true
	for {
		if err := copyCanceled(ctx); err != nil {
			return err
		}
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
			prog.add(int64(n))
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
	cleanupUri, prog, err := streamCopyInner(ctx, srcUri, destUri, opts)
	if err == nil {
		prog.finish()
		return nil
	}
	if cleanupUri != "" && (errors.Is(err, ErrCopyCanceled) || errors.Is(err, context.Canceled)) {
		// a canceled copy shouldn't leave a truncated file (or half a folder) behind
		cleanupCtx, cancelFn := context.WithTimeout(context.Background(), CopyCleanupTimeout)
		defer cancelFn()
		if delErr := scDelete(cleanupCtx, cleanupUri); delErr != nil {
			log.Printf("streamCopy: cleanup of %q after cancel failed: %v", cleanupUri, delErr)
		}
	}
	prog.finish()
	return err
}

// returns the destination to remove if the copy is canceled ("" when nothing of ours is there to remove),
// and the progress tracker (nil when none was requested)
func streamCopyInner(ctx context.Context, srcUri, destUri string, opts *wshrpc.FileCopyOpts) (string, *copyProgress, error) {
	if opts.Overwrite && opts.Merge {
		return "", nil, fmt.Errorf("cannot specify both overwrite and merge")
	}
	srcInfo, err := scStat(ctx, srcUri)
	if err != nil {
		return "", nil, fmt.Errorf("cannot get info for source %q: %w", srcUri, err)
	}
	if srcInfo.NotFound {
		return "", nil, fmt.Errorf("source %q not found", srcUri)
	}
	if srcInfo.IsDir && !opts.Recursive {
		return "", nil, fmt.Errorf("copying a folder requires the recursive flag")
	}
	finalUri := destUri
	destInfo, err := scStat(ctx, destUri)
	if err != nil {
		return "", nil, fmt.Errorf("cannot stat destination %q: %w", destUri, err)
	}
	if strings.HasSuffix(destUri, "/") || (!destInfo.NotFound && destInfo.IsDir) {
		srcConn, err := connparse.ParseURIAndReplaceCurrentHost(ctx, srcUri)
		if err != nil {
			return "", nil, err
		}
		finalUri, err = scChildURI(ctx, strings.TrimSuffix(destUri, "/"), fspath.Base(srcConn.Path))
		if err != nil {
			return "", nil, err
		}
		if destInfo, err = scStat(ctx, finalUri); err != nil {
			return "", nil, fmt.Errorf("cannot stat destination %q: %w", finalUri, err)
		}
	}
	if !srcInfo.IsDir {
		if !destInfo.NotFound {
			if destInfo.IsDir {
				return "", nil, fmt.Errorf("cannot overwrite folder %q with a file", finalUri)
			}
			if !opts.Overwrite && !opts.Merge {
				return "", nil, fmt.Errorf(OverwriteRequiredError, finalUri)
			}
		}
		prog := makeCopyProgress(opts.XferId, fspath.Base(finalUri), srcInfo.Size)
		return finalUri, prog, streamCopyFile(ctx, srcUri, finalUri, uint32(srcInfo.Mode.Perm()), prog)
	}
	if !destInfo.NotFound {
		switch {
		case !destInfo.IsDir && !opts.Overwrite:
			return "", nil, fmt.Errorf(OverwriteRequiredError, finalUri)
		case destInfo.IsDir && !opts.Overwrite && !opts.Merge:
			return "", nil, fmt.Errorf(MergeRequiredError, finalUri)
		case opts.Overwrite:
			if err := scDelete(ctx, finalUri); err != nil {
				return "", nil, fmt.Errorf("cannot remove %q: %w", finalUri, err)
			}
		}
	}
	prog := makeCopyProgress(opts.XferId, fspath.Base(finalUri), 0)
	// when merging into an existing folder, what was already there isn't ours to remove
	cleanupUri := finalUri
	if !destInfo.NotFound && !opts.Overwrite {
		cleanupUri = ""
	}
	return cleanupUri, prog, streamCopyDir(ctx, srcUri, finalUri, 0, prog)
}

func streamCopyDir(ctx context.Context, srcUri, destUri string, depth int, prog *copyProgress) error {
	if depth > 64 {
		return fmt.Errorf("folders nested too deep at %q", srcUri)
	}
	if err := copyCanceled(ctx); err != nil {
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
		if err := copyCanceled(ctx); err != nil {
			return err
		}
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
			if err := streamCopyDir(ctx, childSrc, childDest, depth+1, prog); err != nil {
				return err
			}
			continue
		}
		if err := streamCopyFile(ctx, childSrc, childDest, uint32(child.Mode.Perm()), prog); err != nil {
			return err
		}
	}
	return nil
}
