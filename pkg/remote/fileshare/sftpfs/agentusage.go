// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package sftpfs

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentusage"
	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
)

type usageSource struct {
	host string
	sess *session
}

func (u *usageSource) Home() string { return u.sess.home }

func (u *usageSource) Exists(path string) bool {
	_, err := u.sess.client.Stat(path)
	return err == nil
}

func (u *usageSource) Walk(ctx context.Context, root string, fn func(path string, size int64, mod time.Time)) error {
	w := u.sess.client.Walk(root)
	for w.Step() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if w.Err() != nil || w.Stat() == nil || w.Stat().IsDir() {
			continue
		}
		fn(w.Path(), w.Stat().Size(), w.Stat().ModTime())
	}
	return nil
}

func (u *usageSource) Open(path string) (io.ReadCloser, error) {
	f, err := u.sess.client.Open(path)
	if err != nil {
		maybeDropSession(u.host, err)
		return nil, err
	}
	return f, nil
}

// AgentUsageSource returns an SFTP view of the host's home directory for reading agent logs
// without wsh. The connection must already be established.
func AgentUsageSource(host string) (agentusage.FileSource, error) {
	if conncontroller.IsLocalConnName(host) || conncontroller.IsWslConnName(host) {
		return nil, fmt.Errorf("SFTP is not available for %q", host)
	}
	opts, err := remote.ParseOpts(host)
	if err != nil {
		return nil, err
	}
	conn := conncontroller.MaybeGetConn(opts)
	if conn == nil {
		return nil, fmt.Errorf("connection %s is not connected", host)
	}
	sess, err := getSession(host, conn)
	if err != nil {
		return nil, err
	}
	return &usageSource{host: host, sess: sess}, nil
}

// ConnHasWsh reports whether the connection is known to be running wsh. Unknown connections
// count as wsh so the normal route is tried first.
func ConnHasWsh(host string) bool {
	opts, err := remote.ParseOpts(host)
	if err != nil {
		return true
	}
	conn := conncontroller.MaybeGetConn(opts)
	return conn == nil || conn.WshEnabled.Load()
}
