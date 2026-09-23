// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Package sftpfs serves the file browser (preview view) for SSH connections that run without
// wsh (conn:wshenabled=false, or wsh declined/failed) over SFTP, reusing the connection's
// existing *ssh.Client. It implements wshfs.AltFs; semantics mirror the wshremote
// Remote*Command implementations so the frontend sees the same FileInfo shapes and errors.
package sftpfs

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"

	"github.com/pkg/sftp"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/wshfs"
	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// session is an open SFTP client plus the remote home dir (used for "~" expansion).
type session struct {
	client *sftp.Client
	home   string
}

// Backend implements wshfs.AltFs on top of a session source.
type Backend struct {
	getSession func(ctx context.Context) (*session, error)
	// onError lets the owner drop a broken session (e.g. connection lost)
	onError func(err error)
}

var _ wshfs.AltFs = (*Backend)(nil)

func (b *Backend) sess(ctx context.Context) (*session, error) {
	return b.getSession(ctx)
}

func (b *Backend) noteErr(err error) error {
	if err != nil && b.onError != nil {
		b.onError(err)
	}
	return err
}

// ---- path helpers (remote paths are always posix) ----

func (s *session) expand(p string) string {
	switch {
	case p == "" || p == "~":
		p = s.home
	case strings.HasPrefix(p, "~/"):
		p = path.Join(s.home, p[2:])
	case !path.IsAbs(p):
		p = path.Join(s.home, p)
	}
	return path.Clean(p)
}

func (s *session) replaceHome(p string) string {
	if s.home == "" || s.home == "/" {
		return p
	}
	if p == s.home {
		return "~"
	}
	if strings.HasPrefix(p, s.home+"/") {
		return "~" + p[len(s.home):]
	}
	return p
}

func computeDirPart(fullPath string) string {
	if fullPath == "/" {
		return "/"
	}
	return path.Dir(fullPath)
}

func (s *session) toFileInfo(fullPath string, finfo fs.FileInfo) *wshrpc.FileInfo {
	rtn := &wshrpc.FileInfo{
		Path:          s.replaceHome(fullPath),
		Dir:           computeDirPart(fullPath),
		Name:          finfo.Name(),
		Size:          finfo.Size(),
		Mode:          finfo.Mode(),
		ModeStr:       finfo.Mode().String(),
		ModTime:       finfo.ModTime().UnixMilli(),
		IsDir:         finfo.IsDir(),
		MimeType:      fileutil.DetectMimeType(fullPath, finfo, false), // extended=false: never touch the local fs
		SupportsMkdir: true,
	}
	if finfo.IsDir() {
		rtn.Size = -1
	}
	return rtn
}

func isNotExist(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, os.ErrNotExist)
}

// checkIsReadOnly mirrors wshremote: probe by creating a temp file in the parent dir (for
// missing paths and dirs) or opening the file for writing.
func (s *session) checkIsReadOnly(fullPath string, finfo fs.FileInfo, exists bool) bool {
	if !exists || finfo.IsDir() {
		randHexStr, err := utilfn.RandomHexString(12)
		if err != nil {
			return false
		}
		tmpName := path.Join(path.Dir(fullPath), "wsh-tmp-"+randHexStr)
		fd, err := s.client.Create(tmpName)
		if err != nil {
			return true
		}
		fd.Close()
		s.client.Remove(tmpName)
		return false
	}
	fd, err := s.client.OpenFile(fullPath, os.O_WRONLY)
	if err != nil {
		return true
	}
	fd.Close()
	return false
}

func (s *session) fileInfo(p string, extended bool) (*wshrpc.FileInfo, error) {
	fullPath := s.expand(p)
	finfo, err := s.client.Stat(fullPath)
	if isNotExist(err) {
		return &wshrpc.FileInfo{
			Path:          s.replaceHome(fullPath),
			Dir:           computeDirPart(fullPath),
			NotFound:      true,
			ReadOnly:      s.checkIsReadOnly(fullPath, nil, false),
			SupportsMkdir: true,
		}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot stat file %q: %w", p, err)
	}
	rtn := s.toFileInfo(fullPath, finfo)
	if extended {
		rtn.ReadOnly = s.checkIsReadOnly(fullPath, finfo, true)
	}
	return rtn, nil
}

// ---- wshfs.AltFs ----

func (b *Backend) Stat(ctx context.Context, p string) (*wshrpc.FileInfo, error) {
	s, err := b.sess(ctx)
	if err != nil {
		return nil, err
	}
	rtn, err := s.fileInfo(p, true)
	return rtn, b.noteErr(err)
}

func (b *Backend) Join(ctx context.Context, paths []string) (*wshrpc.FileInfo, error) {
	s, err := b.sess(ctx)
	if err != nil {
		return nil, err
	}
	rtnPath := "~"
	if len(paths) > 0 {
		rtnPath = s.expand(paths[0])
		for _, p := range paths[1:] {
			if p == "~" || strings.HasPrefix(p, "~/") || path.IsAbs(p) {
				rtnPath = s.expand(p)
				continue
			}
			rtnPath = path.Join(rtnPath, p)
		}
	}
	rtn, err := s.fileInfo(rtnPath, true)
	return rtn, b.noteErr(err)
}

func (b *Backend) ListEntries(ctx context.Context, p string, opts *wshrpc.FileListOpts) <-chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData] {
	ch := make(chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData], 16)
	sendErr := func(err error) {
		ch <- wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData]{Error: err}
	}
	go func() {
		defer func() {
			panichandler.PanicHandler("sftpfs:ListEntries", recover())
		}()
		defer close(ch)
		if opts != nil && opts.All {
			// matches wshremote (DisableRecursiveFileOpts)
			sendErr(fmt.Errorf("recursive directory listings are not supported"))
			return
		}
		s, err := b.sess(ctx)
		if err != nil {
			sendErr(err)
			return
		}
		dirPath := s.expand(p)
		entries, err := s.client.ReadDir(dirPath)
		if err != nil {
			sendErr(b.noteErr(fmt.Errorf("cannot open dir %q: %w", dirPath, err)))
			return
		}
		var chunk []*wshrpc.FileInfo
		for _, entry := range entries {
			if ctx.Err() != nil {
				sendErr(ctx.Err())
				return
			}
			chunk = append(chunk, s.toFileInfo(path.Join(dirPath, entry.Name()), entry))
			if len(chunk) >= wshrpc.DirChunkSize {
				ch <- wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData]{Response: wshrpc.CommandRemoteListEntriesRtnData{FileInfo: chunk}}
				chunk = nil
			}
		}
		if len(chunk) > 0 {
			ch <- wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData]{Response: wshrpc.CommandRemoteListEntriesRtnData{FileInfo: chunk}}
		}
	}()
	return ch
}

type rangeReadCloser struct {
	io.Reader
	file *sftp.File
}

func (r *rangeReadCloser) Close() error {
	return r.file.Close()
}

func (b *Backend) OpenRead(ctx context.Context, p string, byteRangeStr string) (*wshrpc.FileInfo, io.ReadCloser, error) {
	s, err := b.sess(ctx)
	if err != nil {
		return nil, nil, err
	}
	fullPath := s.expand(p)
	finfo, err := s.client.Stat(fullPath)
	if isNotExist(err) {
		return &wshrpc.FileInfo{Path: s.replaceHome(fullPath), Dir: computeDirPart(fullPath), NotFound: true}, nil, nil
	}
	if err != nil {
		return nil, nil, b.noteErr(fmt.Errorf("cannot stat file %q: %w", p, err))
	}
	if finfo.IsDir() {
		return nil, nil, fmt.Errorf("cannot stream directory %q", p)
	}
	byteRange, err := fileutil.ParseByteRange(byteRangeStr)
	if err != nil {
		return nil, nil, err
	}
	fileInfo := s.toFileInfo(fullPath, finfo)
	fileInfo.Path = p
	file, err := s.client.Open(fullPath)
	if err != nil {
		return nil, nil, b.noteErr(fmt.Errorf("cannot open file %q: %w", p, err))
	}
	if !byteRange.All && byteRange.Start > 0 {
		if _, err := file.Seek(byteRange.Start, io.SeekStart); err != nil {
			file.Close()
			return nil, nil, fmt.Errorf("cannot seek in file %q: %w", p, err)
		}
	}
	var src io.Reader = file
	if !byteRange.All && !byteRange.OpenEnd {
		src = io.LimitReader(file, byteRange.End-byteRange.Start+1)
	}
	return fileInfo, &rangeReadCloser{Reader: src, file: file}, nil
}

func (b *Backend) Write(ctx context.Context, data wshrpc.FileData) error {
	if data.Info == nil {
		return fmt.Errorf("file info is required")
	}
	var truncate, appendMode bool
	var atOffset int64
	if data.Info.Opts != nil {
		truncate = data.Info.Opts.Truncate
		appendMode = data.Info.Opts.Append
	}
	if data.At != nil {
		atOffset = data.At.Offset
	}
	if truncate && atOffset > 0 {
		return fmt.Errorf("cannot specify non-zero offset with truncate option")
	}
	if appendMode && atOffset > 0 {
		return fmt.Errorf("cannot specify non-zero offset with append option")
	}
	dataBytes, err := base64.StdEncoding.DecodeString(data.Data64)
	if err != nil {
		return fmt.Errorf("cannot decode base64 data: %w", err)
	}
	s, err := b.sess(ctx)
	if err != nil {
		return err
	}
	fullPath := s.expand(data.Info.Path)
	finfo, err := s.client.Stat(fullPath)
	if err != nil && !isNotExist(err) {
		return b.noteErr(fmt.Errorf("cannot stat file %q: %w", fullPath, err))
	}
	exists := finfo != nil
	fileSize := int64(0)
	if exists {
		if finfo.IsDir() {
			return fmt.Errorf("cannot use write file to overwrite a directory %q", fullPath)
		}
		fileSize = finfo.Size()
	}
	if atOffset > fileSize {
		return fmt.Errorf("cannot write at offset %d, file size is %d", atOffset, fileSize)
	}
	openFlags := os.O_CREATE | os.O_WRONLY
	if truncate {
		openFlags |= os.O_TRUNC
	}
	// O_APPEND is not reliably honored by sftp servers; seek to the end explicitly instead
	file, err := s.client.OpenFile(fullPath, openFlags)
	if err != nil {
		return b.noteErr(fmt.Errorf("cannot open file %q: %w", fullPath, err))
	}
	defer file.Close()
	if !exists && data.Info.Mode > 0 {
		if err := file.Chmod(data.Info.Mode.Perm()); err != nil {
			return fmt.Errorf("cannot set mode on %q: %w", fullPath, err)
		}
	}
	switch {
	case appendMode:
		if _, err := file.Seek(0, io.SeekEnd); err != nil {
			return fmt.Errorf("cannot seek to end of %q: %w", fullPath, err)
		}
		_, err = file.Write(dataBytes)
	case atOffset > 0:
		_, err = file.WriteAt(dataBytes, atOffset)
	default:
		_, err = file.Write(dataBytes)
	}
	if err != nil {
		return b.noteErr(fmt.Errorf("cannot write to file %q: %w", fullPath, err))
	}
	return nil
}

func (b *Backend) Mkdir(ctx context.Context, p string) error {
	s, err := b.sess(ctx)
	if err != nil {
		return err
	}
	fullPath := s.expand(p)
	if finfo, err := s.client.Stat(fullPath); err == nil {
		if finfo.IsDir() {
			return fmt.Errorf("directory %q already exists", p)
		}
		return fmt.Errorf("cannot create directory %q, file exists at path", p)
	}
	if err := s.client.MkdirAll(fullPath); err != nil {
		return b.noteErr(fmt.Errorf("cannot create directory %q: %w", fullPath, err))
	}
	return nil
}

func (b *Backend) Delete(ctx context.Context, p string, recursive bool) error {
	s, err := b.sess(ctx)
	if err != nil {
		return err
	}
	fullPath := s.expand(p)
	if recursive {
		if err := s.client.RemoveAll(fullPath); err != nil && !isNotExist(err) {
			return b.noteErr(fmt.Errorf("cannot delete %q: %w", p, err))
		}
		return nil
	}
	finfo, statErr := s.client.Stat(fullPath)
	if statErr == nil && finfo.IsDir() {
		// only remove empty dirs without the recursive flag (matches os.Remove)
		if err := s.client.RemoveDirectory(fullPath); err != nil {
			return fmt.Errorf(wshfs.RecursiveRequiredError)
		}
		return nil
	}
	if err := s.client.Remove(fullPath); err != nil {
		return b.noteErr(fmt.Errorf("cannot delete file %q: %w", p, err))
	}
	return nil
}

func (b *Backend) Move(ctx context.Context, srcPath string, destPath string) error {
	s, err := b.sess(ctx)
	if err != nil {
		return err
	}
	srcFull, destFull := s.expand(srcPath), s.expand(destPath)
	if _, err := s.client.Stat(destFull); err == nil {
		return fmt.Errorf("destination %q already exists", destPath)
	} else if !isNotExist(err) {
		return b.noteErr(fmt.Errorf("cannot stat destination %q: %w", destPath, err))
	}
	if err := s.client.Rename(srcFull, destFull); err != nil {
		return b.noteErr(fmt.Errorf("cannot move file %q to %q: %w", srcFull, destFull, err))
	}
	return nil
}
