// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package sftpfs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"

	"github.com/pkg/sftp"
	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/wshfs"
	"golang.org/x/crypto/ssh"
)

type cachedSession struct {
	sshClient *ssh.Client // the ssh client the sftp session was opened on
	sess      *session
}

var (
	cacheLock sync.Mutex
	cache     = make(map[string]*cachedSession) // keyed by connection name
)

// Init registers the SFTP backend with wshfs. Call once from wavesrv.
func Init() {
	wshfs.AltFsForHost = altFsForHost
}

// altFsForHost returns an SFTP backend for SSH connections that are running without wsh,
// nil for everything else (local, wsl, wsh-enabled ssh) so normal wsh routing is used.
func altFsForHost(ctx context.Context, host string) wshfs.AltFs {
	if conncontroller.IsLocalConnName(host) || conncontroller.IsWslConnName(host) {
		return nil
	}
	opts, err := remote.ParseOpts(host)
	if err != nil {
		return nil
	}
	// the preview view calls ConnEnsure before file ops, but make sure (cheap when connected)
	if err := conncontroller.EnsureConnection(ctx, host); err != nil {
		return &errBackend{err: fmt.Errorf("connection %s: %w", host, err)}
	}
	conn := conncontroller.MaybeGetConn(opts)
	if conn == nil || conn.WshEnabled.Load() {
		return nil
	}
	return &Backend{
		getSession: func(ctx context.Context) (*session, error) { return getSession(host, conn) },
		onError:    func(err error) { maybeDropSession(host, err) },
	}
}

func getSession(host string, conn *conncontroller.SSHConn) (*session, error) {
	sshClient := conn.GetClient()
	if sshClient == nil {
		return nil, fmt.Errorf("connection %s is not connected", host)
	}
	cacheLock.Lock()
	defer cacheLock.Unlock()
	if cs := cache[host]; cs != nil {
		if cs.sshClient == sshClient {
			return cs.sess, nil
		}
		// connection was re-established; the old sftp session is dead
		cs.sess.client.Close()
		delete(cache, host)
	}
	client, err := sftp.NewClient(sshClient)
	if err != nil {
		return nil, fmt.Errorf("cannot start SFTP session on %s (is the sftp subsystem enabled in sshd?): %w", host, err)
	}
	home, err := client.Getwd()
	if err != nil || home == "" {
		home = "/"
	}
	log.Printf("[sftpfs] opened SFTP session on %s (home %s)\n", host, home)
	sess := &session{client: client, home: home}
	cache[host] = &cachedSession{sshClient: sshClient, sess: sess}
	return sess, nil
}

// drop the cached session when the transport is gone so the next call reconnects
func maybeDropSession(host string, err error) {
	if !errors.Is(err, sftp.ErrSSHFxConnectionLost) && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrClosedPipe) {
		return
	}
	cacheLock.Lock()
	defer cacheLock.Unlock()
	if cs := cache[host]; cs != nil {
		cs.sess.client.Close()
		delete(cache, host)
		log.Printf("[sftpfs] dropped SFTP session on %s: %v\n", host, err)
	}
}
