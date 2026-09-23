// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestTmuxSessionName(t *testing.T) {
	if got := tmuxSessionName("0123456789abcdef"); got != "wave-01234567" {
		t.Errorf("got %q", got)
	}
	if got := tmuxSessionName("abc"); got != "wave-abc" {
		t.Errorf("got %q", got)
	}
}

func TestShSingleQuote(t *testing.T) {
	for _, s := range []string{"", "plain", "it's", `a"b$c\d`, "cd ~/repos/ && cls && claude agents"} {
		out, err := exec.Command("sh", "-c", "printf %s "+shSingleQuote(s)).Output()
		if err != nil {
			t.Fatalf("sh error for %q: %v", s, err)
		}
		if string(out) != s {
			t.Errorf("round trip failed: %q -> %q", s, out)
		}
	}
}

func TestMakeTmuxAttachCmd(t *testing.T) {
	cmd := makeTmuxAttachCmd("wave-abc", "cd ~/repos/ && echo 'hi'", waveobj.TermSize{Rows: 30, Cols: 100})
	if !strings.HasPrefix(cmd, "sh -c '") {
		t.Fatalf("expected sh -c wrapper, got %q", cmd)
	}
	// must be valid posix sh
	if out, err := exec.Command("sh", "-n", "-c", cmd).CombinedOutput(); err != nil {
		t.Fatalf("outer command does not parse: %v %s", err, out)
	}
	for _, want := range []string{"-x 100 -y 30", "send-keys", "has-session", "attach-session"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("expected %q in %q", want, cmd)
		}
	}
	noCmd := makeTmuxAttachCmd("wave-abc", "", waveobj.TermSize{})
	if strings.Contains(noCmd, "send-keys") || strings.Contains(noCmd, "-x ") {
		t.Errorf("unexpected send-keys/size in %q", noCmd)
	}
}
