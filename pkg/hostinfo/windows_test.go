// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package hostinfo

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestWindowsProbe(t *testing.T) {
	cases := map[string]bool{
		"HIOS=Windows_NT$env:OS$OS\r\n": true,  // cmd.exe
		"HIOS=%OS%Windows_NT\r\n":        true,  // PowerShell
		"HIOS=%OS%:OSWindows_NT\n":       true,  // Cygwin / MSYS
		"HIOS=%OS%:OS\n":                 false, // Linux sh
		"\n":                             false, // fish drops the word
	}
	for out, want := range cases {
		if got := isWindowsProbeOutput(out); got != want {
			t.Errorf("isWindowsProbeOutput(%q) = %v, want %v", out, got, want)
		}
	}
}

func TestEncodePowerShell(t *testing.T) {
	b, err := base64.StdEncoding.DecodeString(encodePowerShell("ab"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "a\x00b\x00" {
		t.Errorf("not UTF-16LE: %q", b)
	}
	if !strings.HasPrefix(psCommandLine, "powershell.exe ") || len(psCommandLine) > 1000 {
		t.Errorf("unexpected command line: %q", psCommandLine)
	}
}

func TestWinScriptIsAscii(t *testing.T) {
	script := buildWinScript(append([]string{wshrpc.HostSection_Vitals}, allSections...), true)
	for i, r := range script {
		if r > 127 {
			t.Fatalf("non-ASCII %q at %d", r, i)
		}
	}
	if strings.Contains(script, "__") {
		t.Errorf("unreplaced placeholder in script")
	}
}

const winFixture = `#< CLIXML noise
@@hi-json {"os":"windows","uid":0,"user":"HOST\\admin","errors":{"ports":"boom"},` +
	`"system":{"hostname":"HOST","os":"Microsoft Windows 11 Pro","cpucount":8,"cpupct":12.5,"memtotal":17179869184,"memavail":8589934592,"disks":[{"mount":"C:","device":"OS","fstype":"NTFS","total":100,"used":40,"avail":60}]},` +
	`"network":{"interfaces":[{"name":"Ethernet","addrs":["192.0.2.10/24"],"rxbytes":10,"txbytes":20,"rxrate":1,"txrate":2}],"defaultroute":"default via 192.0.2.1 dev Ethernet","dns":["198.51.100.53"]},` +
	`"processes":{"total":2,"processes":[{"pid":100,"ppid":4,"user":"HOST\\admin","cpupct":3.5,"mempct":1.2,"rss":1024,"elapsedsec":60,"state":"running","name":"app","args":"app.exe --flag"}]},` +
	`"services":{"available":true,"failed":1,"services":[{"unit":"Spooler","load":"loaded","active":"failed","sub":"stopped","enabled":"enabled","description":"Print Spooler"}]},` +
	`"docker":{"available":true,"rc":0,"ps":["{\"ID\":\"abc\",\"Names\":\"web\",\"Image\":\"nginx\",\"State\":\"running\",\"Status\":\"Up 2 hours\",\"Labels\":\"com.docker.compose.project=site\"}"],"stats":null},` +
	`"vitals":null}
`

func TestParseWinOutput(t *testing.T) {
	sections := []string{
		wshrpc.HostSection_System, wshrpc.HostSection_Network, wshrpc.HostSection_Ports,
		wshrpc.HostSection_Processes, wshrpc.HostSection_Services, wshrpc.HostSection_Docker,
		wshrpc.HostSection_Vitals,
	}
	data, err := parseWinOutput(winFixture, sections)
	if err != nil {
		t.Fatal(err)
	}
	if data.Os != OsWindows || data.Uid != 0 || data.User != `HOST\admin` {
		t.Errorf("identity: %+v", data)
	}
	if data.System == nil || data.System.CpuCount != 8 || len(data.System.Disks) != 1 || data.System.Disks[0].Mount != "C:" {
		t.Errorf("system: %+v", data.System)
	}
	if data.Network == nil || data.Network.Interfaces[0].Addrs[0] != "192.0.2.10/24" || data.Network.Dns[0] != "198.51.100.53" {
		t.Errorf("network: %+v", data.Network)
	}
	if data.Processes == nil || data.Processes.Processes[0].Args != "app.exe --flag" {
		t.Errorf("processes: %+v", data.Processes)
	}
	if data.Services == nil || data.Services.Failed != 1 || data.Services.Services[0].Unit != "Spooler" {
		t.Errorf("services: %+v", data.Services)
	}
	if data.Docker == nil || !data.Docker.Available || len(data.Docker.Containers) != 1 || data.Docker.Containers[0].Project != "site" {
		t.Errorf("docker: %+v", data.Docker)
	}
	if data.Errors["ports"] != "boom" {
		t.Errorf("ports error not kept: %v", data.Errors)
	}
	if data.Errors["vitals"] == "" {
		t.Errorf("missing vitals section not reported: %v", data.Errors)
	}
	if _, err := parseWinOutput("no marker here", sections); err == nil {
		t.Errorf("expected an error without the result line")
	}
}

func TestParseWinOutputNoDocker(t *testing.T) {
	data, err := parseWinOutput(`@@hi-json {"os":"windows","docker":{"available":false,"rc":0,"ps":[],"stats":[]}}`, []string{wshrpc.HostSection_Docker})
	if err != nil {
		t.Fatal(err)
	}
	if data.Docker == nil || data.Docker.Available || data.Docker.Containers == nil {
		t.Errorf("docker: %+v", data.Docker)
	}
}

func TestWinActionScript(t *testing.T) {
	ok := []struct{ kind, action, target, want string }{
		{wshrpc.HostActionKind_Service, "restart", "Spooler", "Restart-Service -Force -Name 'Spooler'"},
		{wshrpc.HostActionKind_Service, "stop", "MSSQL$SQLEXPRESS", "Stop-Service -Force -Name 'MSSQL$SQLEXPRESS'"},
		{wshrpc.HostActionKind_Container, "stop", "web-1", "docker stop 'web-1'"},
		{wshrpc.HostActionKind_Process, "term", "1234", "taskkill.exe /PID 1234"},
		{wshrpc.HostActionKind_Process, "kill", "1234", "Stop-Process -Id 1234 -Force"},
	}
	for _, c := range ok {
		script, err := winActionScript(c.kind, c.action, c.target)
		if err != nil || !strings.Contains(script, c.want) {
			t.Errorf("%s %s %s: err=%v, script lacks %q", c.kind, c.action, c.target, err, c.want)
		}
	}
	bad := []struct{ kind, action, target string }{
		{wshrpc.HostActionKind_Service, "restart", "a'; Remove-Item C:\\ -Recurse; '"},
		{wshrpc.HostActionKind_Service, "delete", "Spooler"},
		{wshrpc.HostActionKind_Process, "kill", "4"},
		{wshrpc.HostActionKind_Process, "kill", "12; calc"},
		{wshrpc.HostActionKind_Container, "stop", "web; calc"},
	}
	for _, c := range bad {
		if _, err := winActionScript(c.kind, c.action, c.target); err == nil {
			t.Errorf("%s %s %q should be rejected", c.kind, c.action, c.target)
		}
	}
}
