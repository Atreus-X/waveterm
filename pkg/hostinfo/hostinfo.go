// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Package hostinfo inspects Linux hosts agentlessly: it runs a read-only shell script over the
// connection's existing SSH client (or locally), so it works on connections without wsh.
package hostinfo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"golang.org/x/crypto/ssh"
)

const (
	collectTimeout = 25 * time.Second
	actionTimeout  = 90 * time.Second
	maxOutputBytes = 8 * 1024 * 1024
)

var allSections = []string{
	wshrpc.HostSection_System,
	wshrpc.HostSection_Network,
	wshrpc.HostSection_Ports,
	wshrpc.HostSection_Processes,
	wshrpc.HostSection_Services,
	wshrpc.HostSection_Docker,
}

// sections a caller may request; "vitals" is excluded from the default (all) set because the full
// sections already cover it
var knownSections = append([]string{wshrpc.HostSection_Vitals}, allSections...)

type runResult struct {
	stdout   string
	stderr   string
	exitCode int
}

type runnerFn func(ctx context.Context, script string) (*runResult, error)

// cappedBuffer keeps the first maxOutputBytes and silently drops the rest, so a runaway command
// can't exhaust memory; each stream has its own buffer and a single writer.
type cappedBuffer struct {
	buf bytes.Buffer
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	room := maxOutputBytes - b.buf.Len()
	if room > 0 {
		if len(p) <= room {
			b.buf.Write(p)
		} else {
			b.buf.Write(p[:room])
		}
	}
	return len(p), nil
}

func getRunner(ctx context.Context, connName string) (runnerFn, error) {
	if conncontroller.IsLocalConnName(connName) {
		if runtime.GOOS != "linux" {
			return nil, fmt.Errorf("the host inspector supports Linux hosts; this computer runs %s", runtime.GOOS)
		}
		return runLocal, nil
	}
	if conncontroller.IsWslConnName(connName) {
		return nil, fmt.Errorf("WSL connections aren't supported by the host inspector yet")
	}
	opts, err := remote.ParseOpts(connName)
	if err != nil {
		return nil, fmt.Errorf("invalid connection %q: %w", connName, err)
	}
	if err := conncontroller.EnsureConnection(ctx, connName); err != nil {
		return nil, fmt.Errorf("connecting to %s: %w", connName, err)
	}
	conn := conncontroller.MaybeGetConn(opts)
	if conn == nil {
		return nil, fmt.Errorf("connection %s not found", connName)
	}
	client := conn.GetClient()
	if client == nil {
		return nil, fmt.Errorf("connection %s is not connected", connName)
	}
	return func(ctx context.Context, script string) (*runResult, error) {
		return runSSH(ctx, client, script)
	}, nil
}

// runSSH feeds the script to `sh -s` on stdin, so the remote login shell only parses "sh -s".
func runSSH(ctx context.Context, client *ssh.Client, script string) (*runResult, error) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("opening ssh session: %w", err)
	}
	defer sess.Close()
	var stdout, stderr cappedBuffer
	sess.Stdout = &stdout
	sess.Stderr = &stderr
	sess.Stdin = strings.NewReader(script)
	if err := sess.Start("sh -s"); err != nil {
		return nil, fmt.Errorf("starting remote shell: %w", err)
	}
	done := make(chan error, 1)
	go func() {
		done <- sess.Wait()
	}()
	var waitErr error
	select {
	case <-ctx.Done():
		sess.Close()
		return nil, fmt.Errorf("host did not answer in time: %w", ctx.Err())
	case waitErr = <-done:
	}
	res := &runResult{stdout: stdout.buf.String(), stderr: stderr.buf.String()}
	if waitErr != nil {
		var exitErr *ssh.ExitError
		var missingErr *ssh.ExitMissingError
		switch {
		case errors.As(waitErr, &exitErr):
			res.exitCode = exitErr.ExitStatus()
		case errors.As(waitErr, &missingErr):
			res.exitCode = -1
		default:
			return nil, fmt.Errorf("remote command failed: %w", waitErr)
		}
	}
	return res, nil
}

func runLocal(ctx context.Context, script string) (*runResult, error) {
	cmd := exec.CommandContext(ctx, "sh", "-s")
	var stdout, stderr cappedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.Stdin = strings.NewReader(script)
	err := cmd.Run()
	res := &runResult{stdout: stdout.buf.String(), stderr: stderr.buf.String()}
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return nil, fmt.Errorf("running local command: %w", err)
		}
		res.exitCode = exitErr.ExitCode()
	}
	return res, nil
}

func validSections(requested []string) []string {
	if len(requested) == 0 {
		return allSections
	}
	known := make(map[string]bool)
	for _, s := range knownSections {
		known[s] = true
	}
	var rtn []string
	seen := make(map[string]bool)
	for _, s := range requested {
		if known[s] && !seen[s] {
			rtn = append(rtn, s)
			seen[s] = true
		}
	}
	return rtn
}

// Collect gathers the requested sections (all when none are given) in a single exec on the host.
func Collect(ctx context.Context, data wshrpc.CommandHostInfoData) (*wshrpc.HostInfoData, error) {
	sections := validSections(data.Sections)
	if len(sections) == 0 {
		return nil, fmt.Errorf("no valid sections requested")
	}
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()
	run, err := getRunner(ctx, data.Conn)
	if err != nil {
		return nil, err
	}
	res, err := run(ctx, buildScript(sections, data.DockerStats))
	if err != nil {
		return nil, err
	}
	if !strings.Contains(res.stdout, "@@hi-uid") {
		msg := strings.TrimSpace(res.stderr)
		if msg == "" {
			msg = fmt.Sprintf("exit code %d", res.exitCode)
		}
		return nil, fmt.Errorf("the host couldn't run the inspection script: %s", msg)
	}
	info := parseOutput(res.stdout, sections)
	info.Conn = data.Conn
	info.Ts = time.Now().UnixMilli()
	return info, nil
}
