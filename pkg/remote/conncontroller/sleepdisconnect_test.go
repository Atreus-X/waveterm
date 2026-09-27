// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"reflect"
	"testing"
)

func TestSleepDisconnectedBookkeeping(t *testing.T) {
	TakeSleepDisconnected()
	recordSleepDisconnected(PowerReason_Lock, []string{"user@beta"})
	recordSleepDisconnected(PowerReason_Sleep, nil)
	recordSleepDisconnected(PowerReason_Sleep, []string{"user@alpha", "user@beta"})
	recordSleepDisconnected(PowerReason_Lock, nil)

	reason, names := TakeSleepDisconnected()
	if reason != PowerReason_Sleep {
		t.Errorf("reason = %q, want %q", reason, PowerReason_Sleep)
	}
	if want := []string{"user@alpha", "user@beta"}; !reflect.DeepEqual(names, want) {
		t.Errorf("names = %v, want %v", names, want)
	}

	reason, names = TakeSleepDisconnected()
	if reason != "" || len(names) != 0 {
		t.Errorf("second take = %q %v, want empty", reason, names)
	}
}
