// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"fmt"
	"log"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// SSH config -> connections.json sync (conn:syncsshconfig, default true).
//
// Every usable Host alias in ~/.ssh/config (and /etc/ssh/ssh_config, following Include) gets
// an entry in connections.json so per-host options (term:tmux, term:reconnectcmd,
// conn:wshenabled, display:order, ...) have a place to live. Entries are stubs: HostName,
// User, keys etc. stay in ssh config and are read live. The sync only ever adds entries; it
// never edits or removes existing ones, so hand edits are preserved.

var sshConfigSyncLock sync.Mutex

func isSshConfigSyncEnabled() bool {
	return wconfig.DefaultBoolPtr(wconfig.GetWatcher().GetFullConfig().Settings.ConnSyncSshConfig, true)
}

// makeSyncedConnEntry is the stub written for a newly discovered host.
// conn:askbeforewshinstall is set explicitly because an existing connections.json entry
// without it is treated as "user already approved installing wsh" (see getConnWshSettings).
func makeSyncedConnEntry() waveobj.MetaMapType {
	return waveobj.MetaMapType{
		wconfig.ConfigKey_ConnAskBeforeWshInstall: true,
	}
}

// addMissingConnEntries adds a stub for each name not already in conns; returns the names added.
func addMissingConnEntries(conns waveobj.MetaMapType, names []string) []string {
	var added []string
	for _, name := range names {
		if _, exists := conns[name]; exists {
			continue
		}
		conns[name] = makeSyncedConnEntry()
		added = append(added, name)
	}
	return added
}

// SyncSshConfigToConnections adds connections.json entries for ssh config hosts that don't have one.
func SyncSshConfigToConnections() error {
	if !isSshConfigSyncEnabled() {
		return nil
	}
	sshConfigSyncLock.Lock()
	defer sshConfigSyncLock.Unlock()

	hosts, err := GetConnectionsFromConfig()
	if err != nil || len(hosts) == 0 {
		// no ssh config (or no usable hosts) is not an error for syncing
		return nil
	}
	m, cerrs := wconfig.ReadWaveHomeConfigFile(wconfig.ConnectionsFile)
	if len(cerrs) > 0 {
		// don't overwrite a connections.json we couldn't parse
		return fmt.Errorf("not syncing ssh config, error reading %s: %v", wconfig.ConnectionsFile, cerrs[0])
	}
	if m == nil {
		m = make(waveobj.MetaMapType)
	}
	added := addMissingConnEntries(m, hosts)
	if len(added) == 0 {
		return nil
	}
	if err := wconfig.WriteWaveHomeConfigFile(wconfig.ConnectionsFile, m); err != nil {
		return fmt.Errorf("error writing %s: %w", wconfig.ConnectionsFile, err)
	}
	log.Printf("ssh config sync: added %d connection(s) to %s: %v\n", len(added), wconfig.ConnectionsFile, added)
	return nil
}

func SyncSshConfigToConnectionsAsync() {
	go func() {
		if err := SyncSshConfigToConnections(); err != nil {
			log.Printf("warning: %v\n", err)
		}
	}()
}
