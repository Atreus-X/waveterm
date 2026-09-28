// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package hostinfo

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Runs the real script on this machine: HOSTINFO_LIVE=1 go test ./pkg/hostinfo -run Live -v
func TestLiveLocalCollect(t *testing.T) {
	if os.Getenv("HOSTINFO_LIVE") != "1" || runtime.GOOS != "linux" {
		t.Skip("set HOSTINFO_LIVE=1 on a Linux machine to run")
	}
	data, err := Collect(context.Background(), wshrpc.CommandHostInfoData{Conn: "local", DockerStats: true})
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	summary := map[string]any{
		"uid":        data.Uid,
		"errors":     data.Errors,
		"hostname":   data.System.Hostname,
		"os":         data.System.Os,
		"cpupct":     data.System.CpuPct,
		"cpucount":   data.System.CpuCount,
		"disks":      len(data.System.Disks),
		"ifaces":     len(data.Network.Interfaces),
		"route":      data.Network.DefaultRoute != "",
		"portstool":  data.Ports.Tool,
		"ports":      len(data.Ports.Ports),
		"needsroot":  data.Ports.NeedsRoot,
		"procstotal": data.Processes.Total,
		"procs":      len(data.Processes.Processes),
		"services":   len(data.Services.Services),
		"failed":     data.Services.Failed,
		"docker":     data.Docker.Available,
		"dockererr":  data.Docker.Error,
		"containers": len(data.Docker.Containers),
	}
	out, _ := json.MarshalIndent(summary, "", "  ")
	t.Logf("%s", out)
	if data.System.Hostname == "" || data.System.MemTotal == 0 || len(data.Processes.Processes) == 0 {
		t.Errorf("core fields empty")
	}
}

func TestLiveLocalVitals(t *testing.T) {
	if os.Getenv("HOSTINFO_LIVE") != "1" || runtime.GOOS != "linux" {
		t.Skip("set HOSTINFO_LIVE=1 on a Linux machine to run")
	}
	start := time.Now()
	data, err := Collect(context.Background(), wshrpc.CommandHostInfoData{Conn: "local", Sections: []string{wshrpc.HostSection_Vitals}})
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	out, _ := json.Marshal(data.Vitals)
	t.Logf("took %v: %s", time.Since(start).Round(time.Millisecond), out)
	if data.Vitals == nil || data.Vitals.MemTotal == 0 || data.Vitals.CpuCount == 0 {
		t.Errorf("vitals empty: %+v", data.Vitals)
	}
}

// Harmless Windows actions (a pid that doesn't exist, starting the already-running DHCP client):
// HOSTINFO_WIN_SSH=<ssh host> go test ./pkg/hostinfo -run LiveWindowsActions -v
func TestLiveWindowsActions(t *testing.T) {
	host := os.Getenv("HOSTINFO_WIN_SSH")
	if host == "" {
		t.Skip("set HOSTINFO_WIN_SSH to an ssh host running Windows")
	}
	run := func(ctx context.Context, script string) (*runResult, error) {
		cmd := exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", host, psCommandLine)
		cmd.Stdin = strings.NewReader(script)
		var stdout, stderr strings.Builder
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		res := &runResult{stdout: stdout.String(), stderr: stderr.String()}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			res.exitCode = exitErr.ExitCode()
		} else if err != nil {
			return nil, err
		}
		return res, nil
	}
	ctx := context.Background()
	_, err := runWinAction(ctx, run, wshrpc.HostActionKind_Process, "term", "999999")
	t.Logf("term missing pid: %v", err)
	if err == nil {
		t.Errorf("expected an error for a pid that doesn't exist")
	}
	_, err = runWinAction(ctx, run, wshrpc.HostActionKind_Process, "kill", "999999")
	t.Logf("kill missing pid: %v", err)
	if err == nil {
		t.Errorf("expected an error for a pid that doesn't exist")
	}
	rtn, err := runWinAction(ctx, run, wshrpc.HostActionKind_Service, "start", "Dhcp")
	if err != nil {
		t.Errorf("start running service: %v", err)
	} else {
		t.Logf("start running service: ok %q", rtn.Output)
	}
}

// Runs the Windows script over the system ssh client against a Windows host:
// HOSTINFO_WIN_SSH=<ssh host> go test ./pkg/hostinfo -run LiveWindows -v
func TestLiveWindowsCollect(t *testing.T) {
	host := os.Getenv("HOSTINFO_WIN_SSH")
	if host == "" {
		t.Skip("set HOSTINFO_WIN_SSH to an ssh host running Windows")
	}
	probe, err := exec.Command("ssh", "-o", "BatchMode=yes", host, osProbeCommand).Output()
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if !isWindowsProbeOutput(string(probe)) {
		t.Fatalf("probe didn't detect Windows: %q", probe)
	}
	sections := append([]string{wshrpc.HostSection_Vitals}, allSections...)
	if s := os.Getenv("HOSTINFO_WIN_SECTIONS"); s != "" {
		sections = strings.Split(s, ",")
	}
	start := time.Now()
	cmd := exec.Command("ssh", "-o", "BatchMode=yes", host, psCommandLine)
	cmd.Stdin = strings.NewReader(buildWinScript(sections, false))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("run: %v\n%s", err, stderr.String())
	}
	data, err := parseWinOutput(string(out), sections)
	if err != nil {
		t.Fatalf("parse: %v\nstderr: %s", err, stderr.String())
	}
	took := time.Since(start).Round(time.Millisecond)
	if data.System == nil {
		j, _ := json.Marshal(data)
		t.Logf("took %v: %.600s", took, j)
		return
	}
	summary := map[string]any{
		"took":       took.String(),
		"uid":        data.Uid,
		"errors":     data.Errors,
		"os":         data.System.Os,
		"cpupct":     data.System.CpuPct,
		"load1":      data.System.Load1,
		"cpucount":   data.System.CpuCount,
		"memtotal":   data.System.MemTotal,
		"memavail":   data.System.MemAvail,
		"disks":      len(data.System.Disks),
		"ifaces":     len(data.Network.Interfaces),
		"route":      data.Network.DefaultRoute != "",
		"dns":        len(data.Network.Dns),
		"ports":      len(data.Ports.Ports),
		"procstotal": data.Processes.Total,
		"procs":      len(data.Processes.Processes),
		"services":   len(data.Services.Services),
		"failed":     data.Services.Failed,
		"docker":     data.Docker.Available,
		"vitals":     data.Vitals,
	}
	j, _ := json.MarshalIndent(summary, "", "  ")
	t.Logf("%s", j)
	if data.System.MemTotal == 0 || len(data.Processes.Processes) == 0 || len(data.Services.Services) == 0 {
		t.Errorf("core fields empty")
	}
}
