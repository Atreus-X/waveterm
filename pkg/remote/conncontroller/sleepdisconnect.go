// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"log"
	"sort"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Disconnect on sleep / lock (conn:disconnectonsleep, conn:disconnectonlock, default true).
//
// An SSH session that is left open across a sleep usually comes back half-dead: the socket
// still looks open, keepalives take minutes to notice, and terminals hang until then. Closing
// connections cleanly before the machine sleeps (or the screen locks) and offering an explicit
// reconnect on return is more predictable. Remote tmux sessions survive and are re-attached.

const (
	PowerReason_Sleep = "sleep"
	PowerReason_Lock  = "lock"
)

var sleepLock = &sync.Mutex{}
var sleepDisconnected = make(map[string]bool)
var sleepReason string

func isDisconnectOnPowerEnabled(connName string, reason string) bool {
	fullConfig := wconfig.GetWatcher().GetFullConfig()
	connConfig, hasConnConfig := fullConfig.Connections[connName]
	if reason == PowerReason_Lock {
		if hasConnConfig && connConfig.ConnDisconnectOnLock != nil {
			return *connConfig.ConnDisconnectOnLock
		}
		return wconfig.DefaultBoolPtr(fullConfig.Settings.ConnDisconnectOnLock, true)
	}
	if hasConnConfig && connConfig.ConnDisconnectOnSleep != nil {
		return *connConfig.ConnDisconnectOnSleep
	}
	return wconfig.DefaultBoolPtr(fullConfig.Settings.ConnDisconnectOnSleep, true)
}

func getLiveConns() []*SSHConn {
	globalLock.Lock()
	defer globalLock.Unlock()
	var rtn []*SSHConn
	for _, conn := range clientControllerMap {
		status := conn.GetStatus()
		if status == Status_Connected || status == Status_Connecting {
			rtn = append(rtn, conn)
		}
	}
	return rtn
}

func recordSleepDisconnected(reason string, connNames []string) {
	sleepLock.Lock()
	defer sleepLock.Unlock()
	if len(connNames) == 0 {
		return
	}
	for _, name := range connNames {
		sleepDisconnected[name] = true
	}
	// lock usually precedes sleep; report the stronger reason
	if sleepReason != PowerReason_Sleep {
		sleepReason = reason
	}
}

// DisconnectForPowerEvent closes the live SSH connections that have the matching setting enabled
// and remembers them until TakeSleepDisconnected is called on resume/unlock.
func DisconnectForPowerEvent(reason string) []string {
	var closed []string
	for _, conn := range getLiveConns() {
		connName := conn.GetName()
		if !isDisconnectOnPowerEnabled(connName, reason) {
			continue
		}
		conn.Close()
		closed = append(closed, connName)
	}
	if len(closed) > 0 {
		log.Printf("[conncontroller] %s: disconnected %d connection(s)\n", reason, len(closed))
	}
	recordSleepDisconnected(reason, closed)
	return closed
}

// TakeSleepDisconnected returns (and clears) the connections closed since the last call.
func TakeSleepDisconnected() (string, []string) {
	sleepLock.Lock()
	defer sleepLock.Unlock()
	reason := sleepReason
	var connNames []string
	for name := range sleepDisconnected {
		connNames = append(connNames, name)
	}
	sort.Strings(connNames)
	sleepDisconnected = make(map[string]bool)
	sleepReason = ""
	return reason, connNames
}
