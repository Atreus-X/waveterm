// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package hostinfo

import (
	"math"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const sampleOutput = `@@hi-uid 1000
@@hi-user admin
@@hi-begin sample
cpu1 cpu  1000 0 500 8000 100 0 0 0 0 0
@@hi-sub net1
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    5000      50    0    0    0     0          0         0     5000      50    0    0    0     0       0          0
  eth0: 1000000    900    0    0    0     0          0         0   500000    400    0    0    0     0       0          0
@@hi-sub cpu2
cpu2 cpu  1100 0 550 8300 150 0 0 0 0 0
@@hi-sub net2
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    5000      50    0    0    0     0          0         0     5000      50    0    0    0     0       0          0
  eth0: 1500000    990    0    0    0     0          0         0   600000    450    0    0    0     0       0          0
@@hi-end sample
@@hi-begin system
hostname=server1
os=Ubuntu 26.04.1 LTS
kernel=Linux 7.0.0-34-generic x86_64
virt=none
uptime=86400.50
loadavg=0.52 0.40 0.31 2/812 4242
cpumodel= Example 8-Core Processor
cpucount=12
users=2
mem MemTotal:       32768000 kB
mem MemAvailable:   16384000 kB
mem SwapTotal:       8388604 kB
mem SwapFree:        8000000 kB
@@hi-sub disks
Filesystem     Type     1024-blocks      Used Available Capacity Mounted on
/dev/nvme0n1p2 ext4       960000000 400000000 510000000      44% /
tmpfs          tmpfs        3200000      2000   3198000       1% /run
/dev/nvme0n1p1 vfat          523248      6220    517028       2% /boot/efi
overlay        overlay    960000000 400000000 510000000      44% /var/lib/docker/overlay2/abc/merged
/dev/sdf1      ext4      1921724676 900000000 923000000      50% /media/my backup
@@hi-end system
@@hi-begin network
1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever
2: eth0    inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\       valid_lft forever preferred_lft forever
2: eth0    inet6 fe80::1/64 scope link \       valid_lft forever preferred_lft forever
7: veth12@if6    inet6 fe80::2/64 scope link \       valid_lft forever preferred_lft forever
@@hi-sub route
default via 192.0.2.1 dev eth0 proto static
@@hi-sub dns
nameserver 1.1.1.1
nameserver 1.0.0.1
@@hi-end network
@@hi-begin ports
@@hi-sub ss
tcp   LISTEN 0      4096       0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=812,fd=3))
tcp   LISTEN 0      4096          [::]:443          [::]:*
udp   UNCONN 0      0    127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=600,fd=13))
tcp   LISTEN 0      511              *:80              *:*    users:(("apache2",pid=1200,fd=4),("apache2",pid=1201,fd=4))
@@hi-end ports
@@hi-begin processes
total=812
@@hi-sub ps
   4242       1 www-data                   12.5  1.2 204800  3600 Sl   /usr/sbin/apache2 -k start
      2       0 root                        0.0  0.0     0 86400 S    [kthreadd]
   1200    1100 postgres                    3.0  4.0 409600  7200 Ss   postgres: checkpointer
@@hi-end processes
@@hi-begin services
@@hi-sub units
ssh.service loaded active running OpenBSD Secure Shell server
nginx.service loaded failed failed A high performance web server
getty@tty1.service loaded active running Getty on tty1
some.mount loaded active mounted Not a service
@@hi-sub files
ssh.service enabled enabled
nginx.service enabled enabled
getty@.service enabled enabled
@@hi-end services
@@hi-begin docker
@@hi-sub ps
{"ID":"aaa111","Names":"webapp","Image":"example/webapp:latest","State":"running","Status":"Up 2 hours (healthy)","Ports":"80/tcp","Labels":"com.docker.compose.project=webapp,maintainer=x","RunningFor":"2 hours ago","Mounts":"/srv/webapp/data"}
{"ID":"bbb222","Names":"old","Image":"alpine","State":"exited","Status":"Exited (0) 3 days ago","Ports":"","Labels":"","RunningFor":"3 days ago","Mounts":""}
@@hi-rc 0
@@hi-sub stats
{"ID":"aaa111","Name":"webapp","CPUPerc":"0.12%","MemUsage":"20MiB / 31GiB","MemPerc":"0.06%","NetIO":"1kB / 2kB"}
@@hi-end docker
`

func near(a, b float64) bool {
	return math.Abs(a-b) < 0.01
}

func TestParseOutputAllSections(t *testing.T) {
	data := parseOutput(sampleOutput, allSections)
	if data.Uid != 1000 || data.User != "admin" {
		t.Fatalf("uid/user = %d/%q", data.Uid, data.User)
	}
	if len(data.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", data.Errors)
	}

	sys := data.System
	if sys.Hostname != "server1" || sys.Os != "Ubuntu 26.04.1 LTS" || sys.CpuCount != 12 || sys.Users != 2 {
		t.Errorf("system basics: %+v", sys)
	}
	if sys.Virt != "" {
		t.Errorf("virt 'none' should be blank, got %q", sys.Virt)
	}
	if sys.CpuModel != "Example 8-Core Processor" {
		t.Errorf("cpumodel %q", sys.CpuModel)
	}
	if !near(sys.Load1, 0.52) || !near(sys.Load15, 0.31) || !near(sys.UptimeSec, 86400.5) {
		t.Errorf("load/uptime: %v %v %v", sys.Load1, sys.Load15, sys.UptimeSec)
	}
	// busy = (100+50) of total 500 (100+50+300+50) -> 30%
	if !near(sys.CpuPct, 30) {
		t.Errorf("cpupct = %v, want 30", sys.CpuPct)
	}
	if sys.MemTotal != 32768000*1024 || sys.MemAvail != 16384000*1024 || sys.SwapFree != 8000000*1024 {
		t.Errorf("mem: %+v", sys)
	}
	if len(sys.Disks) != 3 {
		t.Fatalf("disks = %+v", sys.Disks)
	}
	if sys.Disks[2].Mount != "/media/my backup" || sys.Disks[2].Total != 1921724676*1024 {
		t.Errorf("disk with space in mount: %+v", sys.Disks[2])
	}

	net := data.Network
	if net.DefaultRoute != "default via 192.0.2.1 dev eth0 proto static" || len(net.Dns) != 2 {
		t.Errorf("route/dns: %q %v", net.DefaultRoute, net.Dns)
	}
	var eth0 *wshrpc.HostIfaceInfo
	for i := range net.Interfaces {
		if net.Interfaces[i].Name == "eth0" {
			eth0 = &net.Interfaces[i]
		}
		if strings.Contains(net.Interfaces[i].Name, "@") {
			t.Errorf("interface name kept its @peer suffix: %q", net.Interfaces[i].Name)
		}
	}
	if eth0 == nil || len(eth0.Addrs) != 2 || eth0.RxBytes != 1500000 {
		t.Fatalf("eth0: %+v", eth0)
	}
	if !near(eth0.RxRate, 500000/sampleSeconds) || !near(eth0.TxRate, 100000/sampleSeconds) {
		t.Errorf("eth0 rates: rx %v tx %v", eth0.RxRate, eth0.TxRate)
	}

	ports := data.Ports
	if ports.Tool != "ss" || len(ports.Ports) != 4 {
		t.Fatalf("ports: %+v", ports)
	}
	if !ports.NeedsRoot {
		t.Errorf("port 443 has no process and uid is 1000: NeedsRoot should be set")
	}
	byPort := map[int]wshrpc.HostPortInfo{}
	for _, p := range ports.Ports {
		byPort[p.Port] = p
	}
	if p := byPort[22]; p.Addr != "0.0.0.0" || p.Process != "sshd" || p.Pid != 812 {
		t.Errorf("port 22: %+v", p)
	}
	if p := byPort[443]; p.Addr != "::" || p.Process != "" {
		t.Errorf("port 443: %+v", p)
	}
	if p := byPort[53]; p.Addr != "127.0.0.53%lo" || p.Proto != "udp" || p.Process != "systemd-resolve" {
		t.Errorf("port 53: %+v", p)
	}
	if p := byPort[80]; p.Addr != "*" || p.Pid != 1200 {
		t.Errorf("port 80: %+v", p)
	}

	procs := data.Processes
	if procs.Total != 812 || len(procs.Processes) != 3 {
		t.Fatalf("processes: total %d, %d rows", procs.Total, len(procs.Processes))
	}
	if p := procs.Processes[0]; p.Name != "apache2" || p.User != "www-data" || !near(p.CpuPct, 12.5) || p.Rss != 204800*1024 || p.ElapsedSec != 3600 {
		t.Errorf("proc 0: %+v", p)
	}
	if p := procs.Processes[1]; p.Name != "[kthreadd]" {
		t.Errorf("kernel thread name: %q", p.Name)
	}

	svcs := data.Services
	if !svcs.Available || len(svcs.Services) != 3 || svcs.Failed != 1 {
		t.Fatalf("services: %+v", svcs)
	}
	for _, s := range svcs.Services {
		if s.Unit == "getty@tty1.service" && s.Enabled != "enabled" {
			t.Errorf("template instance should inherit enabled state: %+v", s)
		}
		if s.Unit == "ssh.service" && s.Description != "OpenBSD Secure Shell server" {
			t.Errorf("description: %q", s.Description)
		}
	}

	dk := data.Docker
	if !dk.Available || dk.Error != "" || len(dk.Containers) != 2 {
		t.Fatalf("docker: %+v", dk)
	}
	if c := dk.Containers[0]; c.Project != "webapp" || c.CpuPct != "0.12%" || c.MemUsage != "20MiB / 31GiB" {
		t.Errorf("container 0: %+v", c)
	}
	if c := dk.Containers[1]; c.State != "exited" || c.CpuPct != "" {
		t.Errorf("container 1: %+v", c)
	}
}

func TestParseDockerPermissionDenied(t *testing.T) {
	out := "@@hi-uid 1000\n@@hi-begin docker\n@@hi-sub ps\npermission denied while trying to connect to the Docker daemon socket\n@@hi-rc 1\n@@hi-end docker\n"
	data := parseOutput(out, []string{wshrpc.HostSection_Docker})
	if !data.Docker.Available || !strings.Contains(data.Docker.Error, "permission denied") || len(data.Docker.Containers) != 0 {
		t.Errorf("docker: %+v", data.Docker)
	}
}

func TestParseMissingToolsAndSections(t *testing.T) {
	out := "@@hi-uid 0\n@@hi-begin services\n@@hi-sub nosystemd\n@@hi-end services\n@@hi-begin docker\n@@hi-sub nodocker\n@@hi-end docker\n@@hi-begin ports\n@@hi-sub none\n@@hi-end ports\n"
	data := parseOutput(out, []string{wshrpc.HostSection_Services, wshrpc.HostSection_Docker, wshrpc.HostSection_Ports, wshrpc.HostSection_System})
	if data.Services.Available || data.Docker.Available || data.Ports.Tool != "none" {
		t.Errorf("unavailable tools: %+v %+v %+v", data.Services, data.Docker, data.Ports)
	}
	if data.System != nil || data.Errors[wshrpc.HostSection_System] == "" {
		t.Errorf("missing system section should be reported: %+v", data.Errors)
	}
}

func TestParseNetstatPorts(t *testing.T) {
	sec := &section{subs: map[string][]string{"netstat": {
		"Active Internet connections (only servers)",
		"Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name",
		"tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      812/sshd",
		"tcp6       0      0 :::8080                 :::*                    LISTEN      -",
		"udp        0      0 0.0.0.0:68              0.0.0.0:*                           700/dhclient",
	}}}
	info := parsePorts(sec, 0)
	if info.Tool != "netstat" || len(info.Ports) != 3 || info.NeedsRoot {
		t.Fatalf("netstat: %+v", info)
	}
	if p := info.Ports[0]; p.Port != 22 || p.Process != "sshd" || p.Pid != 812 {
		t.Errorf("22: %+v", p)
	}
	if p := info.Ports[1]; p.Port != 68 || p.Process != "dhclient" {
		t.Errorf("68: %+v", p)
	}
	if p := info.Ports[2]; p.Port != 8080 || p.Addr != "::" || p.Process != "" {
		t.Errorf("8080: %+v", p)
	}
}

func TestBuildScriptSelectsSections(t *testing.T) {
	s := buildScript([]string{wshrpc.HostSection_Ports}, false)
	if strings.Contains(s, "@@hi-begin sample") || strings.Contains(s, "@@hi-begin docker") || !strings.Contains(s, "@@hi-begin ports") {
		t.Errorf("ports-only script included other sections")
	}
	s = buildScript([]string{wshrpc.HostSection_Docker}, true)
	if !strings.Contains(s, `[ "1" = "1" ]`) {
		t.Errorf("docker stats flag not set")
	}
}

func TestActionCommandValidation(t *testing.T) {
	good := []struct{ kind, action, target, want string }{
		{wshrpc.HostActionKind_Service, "restart", "nginx.service", "systemctl restart nginx.service"},
		{wshrpc.HostActionKind_Service, "stop", "getty@tty1.service", "systemctl stop getty@tty1.service"},
		{wshrpc.HostActionKind_Container, "stop", "webapp", "docker stop webapp"},
		{wshrpc.HostActionKind_Process, "kill", "4242", "kill -KILL 4242"},
		{wshrpc.HostActionKind_Process, "term", "4242", "kill -TERM 4242"},
	}
	for _, tc := range good {
		got, err := actionCommand(tc.kind, tc.action, tc.target)
		if err != nil || got != tc.want {
			t.Errorf("%s %s %s: got %q, %v; want %q", tc.kind, tc.action, tc.target, got, err, tc.want)
		}
	}
	bad := []struct{ kind, action, target string }{
		{wshrpc.HostActionKind_Service, "restart", "nginx.service; rm -rf /"},
		{wshrpc.HostActionKind_Service, "restart", "$(reboot).service"},
		{wshrpc.HostActionKind_Service, "mask", "nginx.service"},
		{wshrpc.HostActionKind_Service, "restart", "nginx"},
		{wshrpc.HostActionKind_Container, "rm", "webapp"},
		{wshrpc.HostActionKind_Container, "stop", "-rf"},
		{wshrpc.HostActionKind_Container, "stop", "a b"},
		{wshrpc.HostActionKind_Process, "kill", "1"},
		{wshrpc.HostActionKind_Process, "kill", "12;reboot"},
		{"file", "delete", "/etc/passwd"},
	}
	for _, tc := range bad {
		if got, err := actionCommand(tc.kind, tc.action, tc.target); err == nil {
			t.Errorf("%s %s %q should be rejected, got %q", tc.kind, tc.action, tc.target, got)
		}
	}
}

func TestPermissionAndPasswordPatterns(t *testing.T) {
	if !permissionRe.MatchString("Failed to restart nginx.service: Interactive authentication required.") {
		t.Error("systemctl polkit refusal not recognized")
	}
	if !permissionRe.MatchString("kill: (4242): Operation not permitted") {
		t.Error("kill EPERM not recognized")
	}
	if !passwordNeedRe.MatchString("sudo: a password is required") {
		t.Error("sudo password prompt not recognized")
	}
	if permissionRe.MatchString("Unit nginx.service not found.") {
		t.Error("a missing unit isn't a permission problem")
	}
}

func TestParseVitals(t *testing.T) {
	out := `@@hi-uid 1000
@@hi-begin sample
cpu1 cpu  1000 0 500 8000 100 0 0 0 0 0
@@hi-sub net1
    lo:  5000 50 0 0 0 0 0 0  5000 50 0 0 0 0 0 0
  eth0: 1000000 900 0 0 0 0 0 0 500000 400 0 0 0 0 0 0
veth9a:  2000000 900 0 0 0 0 0 0 900000 400 0 0 0 0 0 0
@@hi-sub cpu2
cpu2 cpu  1100 0 550 8300 150 0 0 0 0 0
@@hi-sub net2
    lo:  9000 50 0 0 0 0 0 0  9000 50 0 0 0 0 0 0
  eth0: 1500000 990 0 0 0 0 0 0 600000 450 0 0 0 0 0 0
veth9a:  9000000 900 0 0 0 0 0 0 999000 400 0 0 0 0 0 0
@@hi-end sample
@@hi-begin vitals
mem MemTotal:  1000 kB
mem MemAvailable: 250 kB
loadavg=2.50 1.00 0.50 1/100 999
cpucount=4
uptime=120.5
@@hi-sub disks
Filesystem Type 1024-blocks Used Available Capacity Mounted on
/dev/vda1 ext4 1000 400 600 40% /
/dev/vdb1 xfs 1000 900 100 90% /srv/data
tmpfs tmpfs 1000 1000 0 100% /run
@@hi-end vitals
`
	data := parseOutput(out, []string{wshrpc.HostSection_Vitals})
	v := data.Vitals
	if v == nil {
		t.Fatalf("no vitals: %+v", data.Errors)
	}
	if !near(v.CpuPct, 30) || v.CpuCount != 4 || !near(v.Load1, 2.5) || !near(v.UptimeSec, 120.5) {
		t.Errorf("cpu/load/uptime: %+v", v)
	}
	if v.MemTotal != 1000*1024 || v.MemAvail != 250*1024 {
		t.Errorf("mem: %+v", v)
	}
	// only eth0 counts: loopback and veth are excluded
	if !near(v.RxRate, 500000/sampleSeconds) || !near(v.TxRate, 100000/sampleSeconds) {
		t.Errorf("rates: rx %v tx %v", v.RxRate, v.TxRate)
	}
	if !near(v.DiskMaxPct, 90) || v.DiskMaxMount != "/srv/data" {
		t.Errorf("disk max: %v %q (tmpfs must be ignored)", v.DiskMaxPct, v.DiskMaxMount)
	}
}

func TestVitalsNotInDefaultSections(t *testing.T) {
	for _, s := range validSections(nil) {
		if s == wshrpc.HostSection_Vitals {
			t.Errorf("vitals should only be collected when asked for")
		}
	}
	if got := validSections([]string{"vitals", "bogus", "vitals"}); len(got) != 1 || got[0] != "vitals" {
		t.Errorf("validSections: %v", got)
	}
}
