// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Busy detection for the "close tab while something is running" warning:
//   - shell integration (local and wsh shells) reports running-command directly
//   - tmux-backed no-wsh ssh terminals are asked which command each pane is running
//   - plain no-wsh ssh shells can't be inspected and are treated as idle

const tmuxBusyTimeout = 3 * time.Second

// pane_current_command values that mean "sitting at a prompt"
var idleShellNames = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "fish": true, "ksh": true, "mksh": true, "dash": true,
	"ash": true, "tcsh": true, "csh": true, "busybox": true, "login": true, "tmux": true,
}

func isIdleShellCommand(cmd string) bool {
	cmd = strings.TrimPrefix(strings.TrimSpace(cmd), "-")
	return cmd == "" || idleShellNames[cmd]
}

// tmuxBusyCommands returns the non-shell commands running in any pane of the session.
func tmuxBusyCommands(ctx context.Context, conn *conncontroller.SSHConn, sessionName string) ([]string, error) {
	client := conn.GetClient()
	if client == nil {
		return nil, fmt.Errorf("not connected")
	}
	session, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	defer session.Close()
	cmd := makeTmuxListPanesCmd(sessionName)
	type result struct {
		out []byte
		err error
	}
	resCh := make(chan result, 1)
	go func() {
		out, err := session.Output(cmd)
		resCh <- result{out, err}
	}()
	var res result
	select {
	case res = <-resCh:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if res.err != nil {
		return nil, res.err
	}
	return parseTmuxBusyCommands(string(res.out)), nil
}

// all panes of all windows in the session; a missing session prints nothing
func makeTmuxListPanesCmd(sessionName string) string {
	return wrapInSh(fmt.Sprintf(`tmux list-panes -s -t "=%s" -F '#{pane_current_command}' 2>/dev/null; true`, sessionName))
}

func parseTmuxBusyCommands(out string) []string {
	var busy []string
	for _, line := range strings.Split(out, "\n") {
		if !isIdleShellCommand(line) {
			busy = append(busy, strings.TrimSpace(line))
		}
	}
	return busy
}

func blockBusyInfo(ctx context.Context, block *waveobj.Block) *wshrpc.BlockBusyInfo {
	if block.Meta.GetString(waveobj.MetaKey_View, "") != "term" {
		return nil
	}
	connName := block.Meta.GetString(waveobj.MetaKey_Connection, "")
	info := &wshrpc.BlockBusyInfo{BlockId: block.OID, Conn: connName}
	rtInfo := wstore.GetRTInfo(waveobj.MakeORef(waveobj.OType_Block, block.OID))
	if rtInfo != nil && rtInfo.ShellIntegration && rtInfo.ShellState == "running-command" {
		info.Command = rtInfo.ShellLastCmd
		if info.Command == "" {
			info.Command = "a command"
		}
		return info
	}
	ref, ok := getTmuxSession(block.OID)
	if !ok || ref.Conn == nil {
		return nil
	}
	ctx, cancelFn := context.WithTimeout(ctx, tmuxBusyTimeout)
	defer cancelFn()
	cmds, err := tmuxBusyCommands(ctx, ref.Conn, ref.Name)
	if err != nil || len(cmds) == 0 {
		return nil
	}
	info.Command = strings.Join(cmds, ", ")
	info.Tmux = true
	return info
}

// GetTabBusyInfo lists the terminals in a tab that are running something other than an idle shell.
func GetTabBusyInfo(ctx context.Context, tabId string) ([]wshrpc.BlockBusyInfo, error) {
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return nil, fmt.Errorf("error getting tab: %w", err)
	}
	var wg sync.WaitGroup
	results := make([]*wshrpc.BlockBusyInfo, len(tab.BlockIds))
	for i, blockId := range tab.BlockIds {
		block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if err != nil || block == nil {
			continue
		}
		wg.Add(1)
		go func(i int, block *waveobj.Block) {
			defer wg.Done()
			results[i] = blockBusyInfo(ctx, block)
		}(i, block)
	}
	wg.Wait()
	rtn := []wshrpc.BlockBusyInfo{}
	for _, r := range results {
		if r != nil {
			rtn = append(rtn, *r)
		}
	}
	return rtn, nil
}

// NoteTmuxSessionsForTab records the tmux sessions of a tab's terminals before the tab is deleted,
// including terminals that were never started this run (their tab was never opened), so the
// blockclose handler can end them.
func NoteTmuxSessionsForTab(ctx context.Context, tab *waveobj.Tab) {
	for _, blockId := range tab.BlockIds {
		if _, ok := getTmuxSession(blockId); ok {
			continue
		}
		block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if err != nil || block == nil {
			continue
		}
		connName, ok := isAutoConnectShellBlock(block)
		if !ok || !getTermTmux(block.Meta, connName) {
			continue
		}
		opts, err := remote.ParseOpts(connName)
		if err != nil {
			continue
		}
		conn := conncontroller.MaybeGetConn(opts)
		if conn == nil {
			continue
		}
		registerTmuxSession(blockId, conn, tmuxSessionName(blockId))
	}
}
