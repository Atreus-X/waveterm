// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package hostinfo

import "os/exec"

func hideConsoleWindow(cmd *exec.Cmd) {}
