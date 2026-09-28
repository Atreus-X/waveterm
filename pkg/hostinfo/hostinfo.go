// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

// Package hostinfo inspects Linux and Windows hosts agentlessly: it runs a read-only script (sh on
// Linux, PowerShell on Windows) over the connection's existing SSH client (or locally), so it works
// on connections without wsh.
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

// hostTarget runs scripts on one host: sh scripts on Linux, PowerShell scripts on Windows.
type hostTarget struct {
	os  string
	run runnerFn
}

func getTarget(ctx context.Context, connName string) (*hostTarget, error) {
	if conncontroller.IsLocalConnName(connName) {
		switch runtime.GOOS {
		case "linux":
			return &hostTarget{os: OsLinux, run: runLocal}, nil
		case "windows":
			return &hostTarget{os: OsWindows, run: runLocalPowerShell}, nil
		}
		return nil, fmt.Errorf("the host inspector supports Linux and Windows hosts; this computer runs %s", runtime.GOOS)
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
	osName, ok := getCachedOs(connName)
	if !ok {
		probe, err := runSSH(ctx, client, osProbeCommand, "")
		if err != nil {
			return nil, err
		}
		osName = OsLinux
		if isWindowsProbeOutput(probe.stdout) {
			osName = OsWindows
		}
		setCachedOs(connName, osName)
	}
	if osName == OsWindows {
		return &hostTarget{os: OsWindows, run: func(ctx context.Context, script string) (*runResult, error) {
			return runSSH(ctx, client, psCommandLine, script)
		}}, nil
	}
	return &hostTarget{os: OsLinux, run: func(ctx context.Context, script string) (*runResult, error) {
		// sh reads the script from stdin, so the remote login shell only parses "sh -s"
		return runSSH(ctx, client, "sh -s", script)
	}}, nil
}

func runSSH(ctx context.Context, client *ssh.Client, command string, stdin string) (*runResult, error) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("opening ssh session: %w", err)
	}
	defer sess.Close()
	var stdout, stderr cappedBuffer
	sess.Stdout = &stdout
	sess.Stderr = &stderr
	sess.Stdin = strings.NewReader(stdin)
	if err := sess.Start(command); err != nil {
		return nil, fmt.Errorf("starting remote command: %w", err)
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
	return runLocalCmd(exec.CommandContext(ctx, "sh", "-s"), script)
}

func runLocalPowerShell(ctx context.Context, script string) (*runResult, error) {
	cmd := exec.CommandContext(ctx, "powershell.exe", psArgs...)
	hideConsoleWindow(cmd)
	return runLocalCmd(cmd, script)
}

func runLocalCmd(cmd *exec.Cmd, script string) (*runResult, error) {
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
	target, err := getTarget(ctx, data.Conn)
	if err != nil {
		return nil, err
	}
	var info *wshrpc.HostInfoData
	if target.os == OsWindows {
		res, err := target.run(ctx, buildWinScript(sections, data.DockerStats))
		if err != nil {
			return nil, err
		}
		info, err = parseWinOutput(res.stdout, sections)
		if err != nil {
			return nil, fmt.Errorf("the host couldn't run the inspection script: %s", firstNonEmpty(strings.TrimSpace(res.stderr), err.Error()))
		}
	} else {
		res, err := target.run(ctx, buildScript(sections, data.DockerStats))
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
		info = parseOutput(res.stdout, sections)
		info.Os = OsLinux
	}
	info.Conn = data.Conn
	info.Ts = time.Now().UnixMilli()
	return info, nil
}
