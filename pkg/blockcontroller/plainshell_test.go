// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"os"
	"os/exec"
	"reflect"
	"testing"
	"time"
)

// runs the real plain-shell query against a local process tree tagged with the marker
func TestPlainShellBusyCmdLocal(t *testing.T) {
	if _, err := os.Stat("/proc/self/environ"); err != nil {
		t.Skip("no /proc")
	}
	const blockId = "0f8e2a4c-test-busy-plain-shell"
	shell := exec.Command("sh", "-c", "sleep 30; true")
	shell.Env = append(os.Environ(), PlainShellMarkerVar+"="+blockId)
	if err := shell.Start(); err != nil {
		t.Fatal(err)
	}
	defer shell.Process.Kill()
	time.Sleep(200 * time.Millisecond)

	out, err := exec.Command("sh", "-c", makePlainShellBusyCmd(blockId)).Output()
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if got := parseTmuxBusyCommands(string(out)); !reflect.DeepEqual(got, []string{"sleep"}) {
		t.Errorf("busy = %v (raw %q), want [sleep]", got, out)
	}
	out, _ = exec.Command("sh", "-c", makePlainShellBusyCmd("some-other-block")).Output()
	if got := parseTmuxBusyCommands(string(out)); len(got) != 0 {
		t.Errorf("other block reported busy: %v", got)
	}
}

func TestPlainShellRegistry(t *testing.T) {
	registerPlainShell("block-p", nil)
	if _, ok := plainShells["block-p"]; !ok {
		t.Fatal("not registered")
	}
	takePlainShell("block-p")
	if _, ok := plainShells["block-p"]; ok {
		t.Error("still registered after take")
	}
}
