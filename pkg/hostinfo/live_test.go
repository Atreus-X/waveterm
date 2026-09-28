// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package hostinfo

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"testing"

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
