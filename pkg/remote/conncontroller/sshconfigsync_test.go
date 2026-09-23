// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestAddMissingConnEntries(t *testing.T) {
	custom := waveobj.MetaMapType{"term:tmux": true, "conn:wshenabled": false}
	conns := waveobj.MetaMapType{
		"me@existing": custom,
	}
	added := addMissingConnEntries(conns, []string{"me@existing", "me@new1", "me@new2"})
	if !reflect.DeepEqual(added, []string{"me@new1", "me@new2"}) {
		t.Errorf("added = %v", added)
	}
	// existing entry untouched
	if !reflect.DeepEqual(conns["me@existing"], custom) {
		t.Errorf("existing entry modified: %v", conns["me@existing"])
	}
	// new entries keep the "ask before installing wsh" prompt
	for _, name := range []string{"me@new1", "me@new2"} {
		entry, ok := conns[name].(waveobj.MetaMapType)
		if !ok || entry["conn:askbeforewshinstall"] != true {
			t.Errorf("%s: bad stub %v", name, conns[name])
		}
	}
	// idempotent
	if added := addMissingConnEntries(conns, []string{"me@new1"}); len(added) != 0 {
		t.Errorf("second pass added %v", added)
	}
}
