// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// the wsh path passes the integrated shell command (with env assignments) for new sessions
func TestMakeTmuxAttachCmdShellCmd(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	dir := t.TempDir()
	env := append(os.Environ(), "TMUX_TMPDIR="+dir, "TMUX=")
	out := filepath.Join(dir, "out.txt")
	shellCmd := "WAVE_TEST_VAR=from-wrap sh -c 'echo $WAVE_TEST_VAR > " + out + "; sleep 30'"

	cmd := exec.Command("sh", "-c", makeTmuxAttachCmd("wave-wraptest", "", waveobj.TermSize{Rows: 24, Cols: 80}, shellCmd))
	cmd.Env = env
	cmd.Run() // the final attach fails without a terminal; the session is created before it
	defer func() {
		kill := exec.Command("tmux", "kill-server")
		kill.Env = env
		kill.Run()
	}()
	has := exec.Command("tmux", "has-session", "-t", "=wave-wraptest")
	has.Env = env
	if err := has.Run(); err != nil {
		t.Fatalf("session not created: %v", err)
	}
	var got []byte
	for i := 0; i < 40; i++ {
		if got, _ = os.ReadFile(out); len(got) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if strings.TrimSpace(string(got)) != "from-wrap" {
		t.Errorf("session shell ran with %q, want the env assignment applied", got)
	}
}

// without tmux on the host the wsh shell command runs directly
func TestMakeTmuxAttachCmdNoTmuxFallback(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "fallback.txt")
	shellCmd := "WAVE_TEST_VAR=direct sh -c 'echo $WAVE_TEST_VAR > " + out + "'"
	cmd := exec.Command("/bin/sh", "-c", makeTmuxAttachCmd("wave-x", "", waveobj.TermSize{}, shellCmd))
	// a PATH with sh but no tmux
	binDir := t.TempDir()
	if err := os.Symlink("/bin/sh", filepath.Join(binDir, "sh")); err != nil {
		t.Fatal(err)
	}
	cmd.Env = []string{"PATH=" + binDir, "HOME=" + dir}
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		t.Logf("fallback: %v %s", err, outBytes)
	}
	if b, _ := os.ReadFile(out); strings.TrimSpace(string(b)) != "direct" {
		t.Errorf("fallback didn't run the shell command: %q", b)
	}
}
