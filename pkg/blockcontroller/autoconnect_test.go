// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestIsAutoConnectShellBlock(t *testing.T) {
	mk := func(meta waveobj.MetaMapType) *waveobj.Block { return &waveobj.Block{Meta: meta} }
	cases := []struct {
		name  string
		block *waveobj.Block
		conn  string
		ok    bool
	}{
		{"nil", nil, "", false},
		{"ssh shell", mk(waveobj.MetaMapType{"view": "term", "controller": "shell", "connection": "me@host"}), "me@host", true},
		{"local shell", mk(waveobj.MetaMapType{"view": "term", "controller": "shell"}), "", false},
		{"explicit local", mk(waveobj.MetaMapType{"view": "term", "controller": "shell", "connection": "local"}), "", false},
		{"wsl shell", mk(waveobj.MetaMapType{"view": "term", "controller": "shell", "connection": "wsl://Ubuntu"}), "", false},
		{"cmd block", mk(waveobj.MetaMapType{"view": "term", "controller": "cmd", "connection": "me@host"}), "", false},
		{"preview", mk(waveobj.MetaMapType{"view": "preview", "connection": "me@host"}), "", false},
	}
	for _, c := range cases {
		conn, ok := isAutoConnectShellBlock(c.block)
		if conn != c.conn || ok != c.ok {
			t.Errorf("%s: got (%q, %v) want (%q, %v)", c.name, conn, ok, c.conn, c.ok)
		}
	}
}

func TestNextAutoConnectBackoff(t *testing.T) {
	b := autoConnectFirstBackoff
	var seq []time.Duration
	for i := 0; i < 8; i++ {
		seq = append(seq, b)
		b = nextAutoConnectBackoff(b)
	}
	if seq[0] != 5*time.Second || seq[1] != 10*time.Second || seq[len(seq)-1] != autoConnectMaxBackoff {
		t.Errorf("unexpected backoff sequence %v", seq)
	}
}
