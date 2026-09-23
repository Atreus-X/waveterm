// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/remote"
)

// discovered aliases are normalized to user@host connection names
func normalizeAll(aliases ...string) []string {
	var rtn []string
	for _, a := range aliases {
		rtn = append(rtn, remote.NormalizeConfigPattern(a))
	}
	return rtn
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestResolveSshConfigPatternsFollowsIncludes(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config"), `Include config.d/*
Host alpha
    HostName alpha.example.com

Host *.wild
    User nobody

Host beta beta-alias
    HostName beta.example.com
    Include extra/nested.conf
`)
	writeFile(t, filepath.Join(dir, "config.d", "10-work"), `Host gamma
    HostName gamma.example.com
`)
	writeFile(t, filepath.Join(dir, "config.d", "20-home"), `Host delta
    HostName delta.example.com
Host alpha
    Port 2222
`)
	writeFile(t, filepath.Join(dir, "extra", "nested.conf"), `Host epsilon
    HostName epsilon.example.com
`)

	got, err := resolveSshConfigPatterns([]string{filepath.Join(dir, "config"), filepath.Join(dir, "does-not-exist")})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := normalizeAll("gamma", "delta", "alpha", "beta", "epsilon")
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestResolveSshConfigPatternsIncludeLoop(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config"), `Include config
Host loopy
`)
	got, err := resolveSshConfigPatterns([]string{filepath.Join(dir, "config")})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(got, normalizeAll("loopy")) {
		t.Errorf("got %v", got)
	}
}

func TestExpandSshConfigInclude(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.conf"), "")
	writeFile(t, filepath.Join(dir, "b.conf"), "")
	got := expandSshConfigInclude("Include *.conf missing.conf # comment", dir)
	want := []string{filepath.Join(dir, "a.conf"), filepath.Join(dir, "b.conf")}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	got = expandSshConfigInclude("Include="+filepath.Join(dir, "a.conf"), "/nonexistent")
	if !reflect.DeepEqual(got, []string{filepath.Join(dir, "a.conf")}) {
		t.Errorf("Include= form: got %v", got)
	}
}
