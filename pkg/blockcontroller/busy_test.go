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

func TestIsIdleShellCommand(t *testing.T) {
	for _, cmd := range []string{"bash", "-bash", "zsh", "fish", "sh", " dash ", "", "tmux"} {
		if !isIdleShellCommand(cmd) {
			t.Errorf("%q should count as idle", cmd)
		}
	}
	for _, cmd := range []string{"vim", "python3", "sleep", "ssh", "htop", "npm"} {
		if isIdleShellCommand(cmd) {
			t.Errorf("%q should count as busy", cmd)
		}
	}
}

func TestParseTmuxBusyCommands(t *testing.T) {
	got := parseTmuxBusyCommands("bash\nvim\n\nzsh\npython3\n")
	if want := []string{"vim", "python3"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if got := parseTmuxBusyCommands("bash\n"); len(got) != 0 {
		t.Errorf("idle session reported busy: %v", got)
	}
}

func TestTmuxSessionRegistry(t *testing.T) {
	registerTmuxSession("block-a", nil, "wave-blocka")
	if ref, ok := getTmuxSession("block-a"); !ok || ref.Name != "wave-blocka" {
		t.Fatalf("get after register: %v %v", ref, ok)
	}
	if ref, ok := takeTmuxSession("block-a"); !ok || ref.Name != "wave-blocka" {
		t.Fatalf("take: %v %v", ref, ok)
	}
	if _, ok := takeTmuxSession("block-a"); ok {
		t.Errorf("session still registered after take")
	}
}

// runs the real list-panes command against a local tmux server when tmux is installed
func TestTmuxListPanesCmdLocal(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	const session = "wave-busytest"
	// a private tmux server: its socket lives in this temp dir, never the user's
	env := append(os.Environ(), "TMUX_TMPDIR="+t.TempDir(), "TMUX=")
	run := func(args ...string) *exec.Cmd {
		c := exec.Command(args[0], args[1:]...)
		c.Env = env
		return c
	}
	if err := run("tmux", "new-session", "-d", "-s", session, "sleep 30").Run(); err != nil {
		t.Skipf("can't start tmux: %v", err)
	}
	defer run("tmux", "kill-server").Run()
	time.Sleep(200 * time.Millisecond)
	// the exact command sent to the remote host
	out, err := run("sh", "-c", makeTmuxListPanesCmd(session)).Output()
	if err != nil {
		t.Fatalf("list-panes: %v", err)
	}
	if got := parseTmuxBusyCommands(string(out)); !reflect.DeepEqual(got, []string{"sleep"}) {
		t.Errorf("busy commands = %v (raw %q), want [sleep]", got, out)
	}
	out, _ = run("sh", "-c", makeTmuxListPanesCmd("wave-missing")).Output()
	if got := parseTmuxBusyCommands(string(out)); len(got) != 0 {
		t.Errorf("missing session reported busy: %v", got)
	}
}
