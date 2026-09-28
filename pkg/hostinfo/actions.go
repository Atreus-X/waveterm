// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package hostinfo

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Actions are an allow-list of (kind, action) pairs with validated targets; nothing here ever runs a
// command string supplied by the caller.
var (
	// systemd unit names (letters, digits, and :-_.\@ incl. escapes like \x2d)
	serviceNameRe = regexp.MustCompile(`^[A-Za-z0-9:_.\\@-]+\.service$`)
	// docker container IDs and names
	containerNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)
	permissionRe    = regexp.MustCompile(`(?i)(permission denied|operation not permitted|access denied|interactive authentication|authentication is required|must be root|not privileged)`)
	passwordNeedRe  = regexp.MustCompile(`(?i)(a password is required|a terminal is required|no tty present|askpass)`)
)

var allowedActions = map[string]map[string]bool{
	wshrpc.HostActionKind_Service:   {"start": true, "stop": true, "restart": true},
	wshrpc.HostActionKind_Container: {"start": true, "stop": true, "restart": true},
	wshrpc.HostActionKind_Process:   {"term": true, "kill": true},
}

// actionCommand builds the shell command for an action from the allow-list and a validated target.
func actionCommand(kind, action, target string) (string, error) {
	if !allowedActions[kind][action] {
		return "", fmt.Errorf("unsupported action %q for %q", action, kind)
	}
	switch kind {
	case wshrpc.HostActionKind_Service:
		if !serviceNameRe.MatchString(target) {
			return "", fmt.Errorf("invalid service name %q", target)
		}
		return "systemctl " + action + " " + utilfn.ShellQuote(target, false, -1), nil
	case wshrpc.HostActionKind_Container:
		if !containerNameRe.MatchString(target) {
			return "", fmt.Errorf("invalid container name %q", target)
		}
		return "docker " + action + " " + utilfn.ShellQuote(target, false, -1), nil
	case wshrpc.HostActionKind_Process:
		pid, err := strconv.Atoi(target)
		if err != nil || pid <= 1 {
			return "", fmt.Errorf("invalid pid %q", target)
		}
		signal := "TERM"
		if action == "kill" {
			signal = "KILL"
		}
		return fmt.Sprintf("kill -%s %d", signal, pid), nil
	}
	return "", fmt.Errorf("unknown action kind %q", kind)
}

func outputOf(res *runResult) string {
	return strings.TrimSpace(strings.TrimSpace(res.stdout) + "\n" + strings.TrimSpace(res.stderr))
}

// RunAction runs the action as the connection's user; if that's refused for lack of privileges it
// retries with `sudo -n` (passwordless sudo). When sudo wants a password it reports NeedsAuth with
// the command to run interactively instead of prompting.
func RunAction(ctx context.Context, data wshrpc.CommandHostActionData) (*wshrpc.HostActionRtnData, error) {
	cmd, err := actionCommand(data.Kind, data.Action, data.Target)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, actionTimeout)
	defer cancel()
	run, err := getRunner(ctx, data.Conn)
	if err != nil {
		return nil, err
	}
	res, err := run(ctx, cmd+"\n")
	if err != nil {
		return nil, err
	}
	if res.exitCode == 0 {
		return &wshrpc.HostActionRtnData{Output: outputOf(res)}, nil
	}
	if !permissionRe.MatchString(res.stderr) {
		return nil, fmt.Errorf("%s", firstNonEmpty(outputOf(res), fmt.Sprintf("%s exited with code %d", cmd, res.exitCode)))
	}
	sudoRes, err := run(ctx, "sudo -n "+cmd+"\n")
	if err != nil {
		return nil, err
	}
	if sudoRes.exitCode == 0 {
		return &wshrpc.HostActionRtnData{Output: outputOf(sudoRes)}, nil
	}
	if passwordNeedRe.MatchString(sudoRes.stderr) {
		return &wshrpc.HostActionRtnData{
			NeedsAuth: true,
			Command:   "sudo " + cmd,
			Output:    "This needs root and sudo asks for a password.",
		}, nil
	}
	return nil, fmt.Errorf("%s", firstNonEmpty(outputOf(sudoRes), outputOf(res)))
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
