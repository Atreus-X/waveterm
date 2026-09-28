// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package hostinfo

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Section output is framed by marker lines so one exec can return every section.
const (
	markerBegin = "@@hi-begin "
	markerEnd   = "@@hi-end "
	markerSub   = "@@hi-sub "
)

// seconds between the two /proc/stat and /proc/net/dev samples used for CPU % and network rates
const sampleSeconds = 0.5

// The script only reads: /proc, and the stock tools (ss, ps, systemctl, docker) in query mode.
// It runs as `sh -s` with the script on stdin, so the user's login shell (bash, zsh, fish...) never parses it.
const scriptPrelude = `export LC_ALL=C
PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
echo "@@hi-uid $(id -u 2>/dev/null)"
echo "@@hi-user $(id -un 2>/dev/null)"
`

const scriptSample = `echo "@@hi-begin sample"
echo "cpu1 $(head -n1 /proc/stat 2>/dev/null)"
echo "@@hi-sub net1"
cat /proc/net/dev 2>/dev/null
sleep %s
echo "@@hi-sub cpu2"
echo "cpu2 $(head -n1 /proc/stat 2>/dev/null)"
echo "@@hi-sub net2"
cat /proc/net/dev 2>/dev/null
echo "@@hi-end sample"
`

const scriptSystem = `echo "@@hi-begin system"
echo "hostname=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)"
if [ -r /etc/os-release ]; then (. /etc/os-release 2>/dev/null; echo "os=${PRETTY_NAME:-$NAME}"); fi
echo "kernel=$(uname -srm 2>/dev/null)"
echo "virt=$(systemd-detect-virt 2>/dev/null)"
echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
echo "loadavg=$(cat /proc/loadavg 2>/dev/null)"
echo "cpumodel=$(grep -m1 -E '^(model name|Model|Hardware)' /proc/cpuinfo 2>/dev/null | cut -d: -f2-)"
echo "cpucount=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
echo "users=$(who 2>/dev/null | wc -l)"
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null | sed 's/^/mem /'
echo "@@hi-sub disks"
df -PkT 2>/dev/null
echo "@@hi-end system"
`

const scriptNetwork = `echo "@@hi-begin network"
ip -o addr show 2>/dev/null
echo "@@hi-sub route"
ip route show default 2>/dev/null | head -n 3
echo "@@hi-sub dns"
grep -E '^nameserver' /etc/resolv.conf 2>/dev/null
echo "@@hi-end network"
`

const scriptPorts = `echo "@@hi-begin ports"
if command -v ss >/dev/null 2>&1; then
  echo "@@hi-sub ss"
  ss -H -tulnp 2>/dev/null
elif command -v netstat >/dev/null 2>&1; then
  echo "@@hi-sub netstat"
  netstat -tulnp 2>/dev/null
else
  echo "@@hi-sub none"
fi
echo "@@hi-end ports"
`

// ps: args last (it contains spaces); the process name is derived from it. user:32 stops procps from
// replacing long user names with the numeric uid.
const scriptProcesses = `echo "@@hi-begin processes"
echo "total=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)"
echo "@@hi-sub ps"
ps -eww -o pid=,ppid=,user:32=,pcpu=,pmem=,rss=,etimes=,stat=,args= --sort=-pcpu 2>/dev/null | head -n %d
echo "@@hi-end processes"
`

const scriptServices = `echo "@@hi-begin services"
if command -v systemctl >/dev/null 2>&1; then
  echo "@@hi-sub units"
  systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null
  echo "@@hi-sub files"
  systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null
else
  echo "@@hi-sub nosystemd"
fi
echo "@@hi-end services"
`

const scriptDocker = `echo "@@hi-begin docker"
if command -v docker >/dev/null 2>&1; then
  echo "@@hi-sub ps"
  docker ps -a --no-trunc --format '{{json .}}' 2>&1
  echo "@@hi-rc $?"
  if [ "%s" = "1" ]; then
    echo "@@hi-sub stats"
    docker stats --no-stream --no-trunc --format '{{json .}}' 2>/dev/null
  fi
else
  echo "@@hi-sub nodocker"
fi
echo "@@hi-end docker"
`

const scriptVitals = `echo "@@hi-begin vitals"
grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null | sed 's/^/mem /'
echo "loadavg=$(cat /proc/loadavg 2>/dev/null)"
echo "cpucount=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
echo "@@hi-sub disks"
df -PkT 2>/dev/null
echo "@@hi-end vitals"
`

const maxProcesses = 400

func buildScript(sections []string, dockerStats bool) string {
	want := make(map[string]bool)
	for _, s := range sections {
		want[s] = true
	}
	var sb strings.Builder
	sb.WriteString(scriptPrelude)
	if want[wshrpc.HostSection_System] || want[wshrpc.HostSection_Network] || want[wshrpc.HostSection_Vitals] {
		sb.WriteString(fmt.Sprintf(scriptSample, fmt.Sprintf("%g", sampleSeconds)))
	}
	if want[wshrpc.HostSection_System] {
		sb.WriteString(scriptSystem)
	}
	if want[wshrpc.HostSection_Network] {
		sb.WriteString(scriptNetwork)
	}
	if want[wshrpc.HostSection_Vitals] {
		sb.WriteString(scriptVitals)
	}
	if want[wshrpc.HostSection_Ports] {
		sb.WriteString(scriptPorts)
	}
	if want[wshrpc.HostSection_Processes] {
		sb.WriteString(fmt.Sprintf(scriptProcesses, maxProcesses))
	}
	if want[wshrpc.HostSection_Services] {
		sb.WriteString(scriptServices)
	}
	if want[wshrpc.HostSection_Docker] {
		statsFlag := "0"
		if dockerStats {
			statsFlag = "1"
		}
		sb.WriteString(fmt.Sprintf(scriptDocker, statsFlag))
	}
	return sb.String()
}
