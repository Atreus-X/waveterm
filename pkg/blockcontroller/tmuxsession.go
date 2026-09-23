// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// tmux-backed sessions give no-wsh ssh terminals persistence across Wave restarts
// and network drops: each block gets its own tmux session on the remote host, and
// (re)starting the block re-attaches to it.

const tmuxKillTimeout = 5 * time.Second

func tmuxSessionName(blockId string) string {
	if len(blockId) > 8 {
		blockId = blockId[:8]
	}
	return "wave-" + blockId
}

// resolution order: block meta -> connection config -> global settings
func getTermTmux(blockMeta waveobj.MetaMapType, connName string) bool {
	if val, ok := blockMeta[waveobj.MetaKey_TermTmux].(bool); ok {
		return val
	}
	fullConfig := wconfig.GetWatcher().GetFullConfig()
	if connConfig, ok := fullConfig.Connections[connName]; ok && connConfig.TermTmux != nil {
		return *connConfig.TermTmux
	}
	return fullConfig.Settings.TermTmux
}

func getTermReconnectCmd(blockMeta waveobj.MetaMapType, connName string) string {
	if val := blockMeta.GetString(waveobj.MetaKey_TermReconnectCmd, ""); val != "" {
		return val
	}
	fullConfig := wconfig.GetWatcher().GetFullConfig()
	if connConfig, ok := fullConfig.Connections[connName]; ok && connConfig.TermReconnectCmd != "" {
		return connConfig.TermReconnectCmd
	}
	return fullConfig.Settings.TermReconnectCmd
}

// posix single-quoting (also valid in fish)
func shSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// wraps a posix script so it runs the same regardless of the remote login shell
func wrapInSh(script string) string {
	return "sh -c " + shSingleQuote(script)
}

// makeTmuxAttachCmd returns a remote command that attaches to the block's tmux
// session, creating it (and typing reconnectCmd into it) if it does not exist.
// Falls back to a plain login shell when tmux is not installed.
func makeTmuxAttachCmd(sessionName string, reconnectCmd string, termSize waveobj.TermSize) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "S=%s\n", shSingleQuote(sessionName))
	sb.WriteString(`if ! command -v tmux >/dev/null 2>&1; then echo "[wave] tmux not found on remote host, starting a plain shell"; exec "${SHELL:-/bin/sh}" -l; fi` + "\n")
	sb.WriteString(`if tmux has-session -t "=$S" 2>/dev/null; then exec tmux attach-session -t "=$S"; fi` + "\n")
	sizeArgs := ""
	if termSize.Rows > 0 && termSize.Cols > 0 {
		sizeArgs = fmt.Sprintf(" -x %d -y %d", termSize.Cols, termSize.Rows)
	}
	fmt.Fprintf(&sb, `tmux new-session -d -s "$S"%s || exec "${SHELL:-/bin/sh}" -l`+"\n", sizeArgs)
	if reconnectCmd != "" {
		fmt.Fprintf(&sb, `tmux send-keys -t "=$S:" -l %s && tmux send-keys -t "=$S:" Enter`+"\n", shSingleQuote(reconnectCmd))
	}
	sb.WriteString(`exec tmux attach-session -t "=$S"` + "\n")
	return wrapInSh(sb.String())
}

func makeTmuxKillCmd(sessionName string) string {
	return wrapInSh(fmt.Sprintf(`tmux kill-session -t "=%s" 2>/dev/null; true`, sessionName))
}

// killTmuxSession ends a block's tmux session on the remote host (used when the
// block is closed, so sessions don't accumulate). Best effort.
func killTmuxSession(conn *conncontroller.SSHConn, sessionName string) {
	client := conn.GetClient()
	if client == nil {
		log.Printf("[tmux] cannot kill session %s on %s: not connected\n", sessionName, conn.GetName())
		return
	}
	session, err := client.NewSession()
	if err != nil {
		log.Printf("[tmux] cannot kill session %s on %s: %v\n", sessionName, conn.GetName(), err)
		return
	}
	defer session.Close()
	ctx, cancelFn := context.WithTimeout(context.Background(), tmuxKillTimeout)
	defer cancelFn()
	errCh := make(chan error, 1)
	go func() { errCh <- session.Run(makeTmuxKillCmd(sessionName)) }()
	select {
	case err = <-errCh:
		if err != nil {
			log.Printf("[tmux] error killing session %s on %s: %v\n", sessionName, conn.GetName(), err)
		}
	case <-ctx.Done():
		log.Printf("[tmux] timeout killing session %s on %s\n", sessionName, conn.GetName())
	}
}
