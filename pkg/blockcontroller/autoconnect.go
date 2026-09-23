// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Startup auto-connect (conn:autoconnect, default true).
//
// Only the active tab's view is created at launch, so remote terminals in other tabs used to
// stay unconnected (and unstarted) until the tab was opened. This pass connects every SSH
// host used by a shell block in an open window's tabs and starts those shells in the
// background, retrying network failures with backoff. Combined with term:tmux, this
// re-attaches every remote session on launch.

const (
	autoConnectStartupDelay = 3 * time.Second // let the UI come up first, in case a connection needs a prompt
	autoConnectFirstBackoff = 5 * time.Second
	autoConnectMaxBackoff   = 5 * time.Minute
	autoConnectGiveUpAfter  = 30 * time.Minute
	autoConnectAttemptLimit = 2 * time.Minute // per connect attempt
)

type autoConnectBlock struct {
	TabId   string
	BlockId string
}

func isAutoConnectShellBlock(block *waveobj.Block) (string, bool) {
	if block == nil {
		return "", false
	}
	if block.Meta.GetString(waveobj.MetaKey_View, "") != "term" || block.Meta.GetString(waveobj.MetaKey_Controller, "") != BlockController_Shell {
		return "", false
	}
	connName := block.Meta.GetString(waveobj.MetaKey_Connection, "")
	if conncontroller.IsLocalConnName(connName) || conncontroller.IsWslConnName(connName) {
		return "", false
	}
	return connName, true
}

// findAutoConnectBlocks returns remote shell blocks in the tabs of all open windows, grouped by connection.
func findAutoConnectBlocks(ctx context.Context) (map[string][]autoConnectBlock, error) {
	windows, err := wstore.DBGetAllObjsByType[*waveobj.Window](ctx, waveobj.OType_Window)
	if err != nil {
		return nil, err
	}
	rtn := make(map[string][]autoConnectBlock)
	seenWorkspaces := make(map[string]bool)
	for _, window := range windows {
		if window.WorkspaceId == "" || seenWorkspaces[window.WorkspaceId] {
			continue
		}
		seenWorkspaces[window.WorkspaceId] = true
		ws, err := wstore.DBGet[*waveobj.Workspace](ctx, window.WorkspaceId)
		if err != nil || ws == nil {
			continue
		}
		for _, tabId := range ws.TabIds {
			tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
			if err != nil || tab == nil {
				continue
			}
			for _, blockId := range tab.BlockIds {
				block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
				if err != nil {
					continue
				}
				if connName, ok := isAutoConnectShellBlock(block); ok {
					rtn[connName] = append(rtn[connName], autoConnectBlock{TabId: tabId, BlockId: blockId})
				}
			}
		}
	}
	return rtn, nil
}

func nextAutoConnectBackoff(cur time.Duration) time.Duration {
	next := cur * 2
	if next > autoConnectMaxBackoff {
		return autoConnectMaxBackoff
	}
	return next
}

// connectWithRetry connects connName, retrying network failures with exponential backoff.
func connectWithRetry(connName string) bool {
	backoff := autoConnectFirstBackoff
	deadline := time.Now().Add(autoConnectGiveUpAfter)
	for {
		ctx, cancelFn := context.WithTimeout(context.Background(), autoConnectAttemptLimit)
		retryable, err := conncontroller.ConnectUnattended(ctx, connName)
		cancelFn()
		if err == nil {
			return true
		}
		if !retryable {
			log.Printf("[autoconnect] %s: not retrying: %v\n", connName, err)
			return false
		}
		if time.Now().Add(backoff).After(deadline) {
			log.Printf("[autoconnect] %s: giving up after %v: %v\n", connName, autoConnectGiveUpAfter, err)
			return false
		}
		log.Printf("[autoconnect] %s: %v (retrying in %v)\n", connName, err, backoff)
		time.Sleep(backoff)
		backoff = nextAutoConnectBackoff(backoff)
	}
}

func autoConnectAndStart(connName string, blocks []autoConnectBlock) {
	defer func() {
		panichandler.PanicHandler("blockcontroller:autoconnect", recover())
	}()
	if !connectWithRetry(connName) {
		return
	}
	for _, b := range blocks {
		ctx, cancelFn := context.WithTimeout(context.Background(), autoConnectAttemptLimit)
		// no-op if the block's shell is already running (e.g. its tab was opened meanwhile)
		err := ResyncController(ctx, b.TabId, b.BlockId, nil, false)
		cancelFn()
		if err != nil {
			log.Printf("[autoconnect] %s: error starting block %s: %v\n", connName, b.BlockId, err)
		}
	}
	log.Printf("[autoconnect] %s: connected, started %d block(s)\n", connName, len(blocks))
}

// StartupAutoConnect runs the startup pass in the background.
func StartupAutoConnect() {
	go func() {
		defer func() {
			panichandler.PanicHandler("blockcontroller:startup-autoconnect", recover())
		}()
		time.Sleep(autoConnectStartupDelay)
		ctx, cancelFn := context.WithTimeout(context.Background(), 10*time.Second)
		byConn, err := findAutoConnectBlocks(ctx)
		cancelFn()
		if err != nil {
			log.Printf("[autoconnect] error finding blocks: %v\n", err)
			return
		}
		for connName, blocks := range byConn {
			if !conncontroller.IsAutoConnectEnabled(connName) {
				continue
			}
			go autoConnectAndStart(connName, blocks)
		}
	}()
}
