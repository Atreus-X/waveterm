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
//   - tmux-backed terminals are asked which command each pane is running
//   - plain no-wsh ssh shells are started with PlainShellMarkerVar=<blockid> in their environment
//     (an SSH env request; LC_* names pass the common "AcceptEnv LANG LC_*" sshd default, and an
//     unknown LC_ name doesn't affect the locale). Everything the shell starts inherits it, so the
//     host's /proc shows which processes belong to the terminal. Hosts that refuse the variable
//     or have no /proc count as idle.

const tmuxBusyTimeout = 3 * time.Second

const PlainShellMarkerVar = "LC_WAVETERM_BLOCK"

var plainShells = make(map[string]*conncontroller.SSHConn)
var plainShellsLock = &sync.Mutex{}

func registerPlainShell(blockId string, conn *conncontroller.SSHConn) {
	plainShellsLock.Lock()
	defer plainShellsLock.Unlock()
	plainShells[blockId] = conn
}

func getPlainShell(blockId string) *conncontroller.SSHConn {
	plainShellsLock.Lock()
	defer plainShellsLock.Unlock()
	return plainShells[blockId]
}

func takePlainShell(blockId string) {
	plainShellsLock.Lock()
	defer plainShellsLock.Unlock()
	delete(plainShells, blockId)
}

// makePlainShellBusyCmd prints the command name of every process tagged with the block's marker
// (the shell itself and anything it started). grep -a -l -F behaves the same in GNU grep, busybox
// and ugrep (unlike -z).
func makePlainShellBusyCmd(blockId string) string {
	marker := PlainShellMarkerVar + "=" + blockId
	return wrapInSh(fmt.Sprintf(`for f in $(grep -a -l -F %s /proc/[0-9]*/environ 2>/dev/null); do cat "${f%%/environ}/comm" 2>/dev/null; done; true`, shSingleQuote(marker)))
}

// runRemoteOutput runs cmd in a new session on conn, bounded by ctx.
func runRemoteOutput(ctx context.Context, conn *conncontroller.SSHConn, cmd string) (string, error) {
	client := conn.GetClient()
	if client == nil {
		return "", fmt.Errorf("not connected")
	}
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()
	type result struct {
		out []byte
		err error
	}
	resCh := make(chan result, 1)
	go func() {
		out, err := session.Output(cmd)
		resCh <- result{out, err}
	}()
	select {
	case res := <-resCh:
		return string(res.out), res.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

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
	out, err := runRemoteOutput(ctx, conn, makeTmuxListPanesCmd(sessionName))
	if err != nil {
		return nil, err
	}
	return parseTmuxBusyCommands(out), nil
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
	ctx, cancelFn := context.WithTimeout(ctx, tmuxBusyTimeout)
	defer cancelFn()
	if ref, ok := getTmuxSession(block.OID); ok && ref.Conn != nil {
		cmds, err := tmuxBusyCommands(ctx, ref.Conn, ref.Name)
		if err != nil || len(cmds) == 0 {
			return nil
		}
		info.Command = strings.Join(cmds, ", ")
		info.Tmux = true
		return info
	}
	if conn := getPlainShell(block.OID); conn != nil {
		out, err := runRemoteOutput(ctx, conn, makePlainShellBusyCmd(block.OID))
		if err != nil {
			return nil
		}
		cmds := parseTmuxBusyCommands(out)
		if len(cmds) == 0 {
			return nil
		}
		info.Command = strings.Join(cmds, ", ")
		return info
	}
	return nil
}

// GetBlockBusyInfo reports what one terminal is running, or nil when it's idle or not a terminal.
func GetBlockBusyInfo(ctx context.Context, blockId string) (*wshrpc.BlockBusyInfo, error) {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return nil, fmt.Errorf("error getting block: %w", err)
	}
	if block == nil {
		return nil, nil
	}
	return blockBusyInfo(ctx, block), nil
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
