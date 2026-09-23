// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package sftpfs

import (
	"context"
	"io"

	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/wshfs"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// errBackend fails every operation with a connection error, which is clearer than the
// "no route" error wsh routing would produce for a host that isn't connected.
type errBackend struct {
	err error
}

var _ wshfs.AltFs = (*errBackend)(nil)

func (e *errBackend) Stat(context.Context, string) (*wshrpc.FileInfo, error)     { return nil, e.err }
func (e *errBackend) Join(context.Context, []string) (*wshrpc.FileInfo, error)   { return nil, e.err }
func (e *errBackend) Write(context.Context, wshrpc.FileData) error               { return e.err }
func (e *errBackend) Mkdir(context.Context, string) error                        { return e.err }
func (e *errBackend) Delete(context.Context, string, bool) error                 { return e.err }
func (e *errBackend) Move(context.Context, string, string) error                 { return e.err }
func (e *errBackend) OpenRead(context.Context, string, string) (*wshrpc.FileInfo, io.ReadCloser, error) {
	return nil, nil, e.err
}
func (e *errBackend) ListEntries(context.Context, string, *wshrpc.FileListOpts) <-chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData] {
	return wshutil.SendErrCh[wshrpc.CommandRemoteListEntriesRtnData](e.err)
}
