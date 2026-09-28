// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package hostinfo

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Windows hosts (OpenSSH for Windows with cmd.exe or PowerShell as the shell, or Cygwin/MSYS sshd)
// are inspected with a Windows PowerShell 5.1 script that prints the result as one JSON line, using
// the same field names as HostInfoData; docker output is passed through raw so parseDocker is shared.

const (
	OsLinux   = "linux"
	OsWindows = "windows"
)

const winJsonMarker = "@@hi-json "

// prints Windows_NT under cmd.exe (%OS%), PowerShell ($env:OS) and Cygwin/MSYS shells ($OS), and
// none of it under a Unix shell. No "@" or quotes: each shell has to parse it as a plain word.
const osProbeCommand = "echo HIOS=%OS%$env:OS$OS"

// the script arrives on stdin, so the command line stays short (cmd.exe caps it at 8191 chars) and
// the remote shell, whatever it is, only parses this one command
const psBootstrap = "$s=[Console]::In.ReadToEnd();& ([scriptblock]::Create($s))"

var (
	// Windows service names; single-quoted in PowerShell, so no quotes allowed
	winServiceNameRe = regexp.MustCompile(`^[A-Za-z0-9 _.$@#{}~-]{1,256}$`)
	winPermissionRe  = regexp.MustCompile(`(?i)(access is denied|access denied|permissiondenied|requires elevation|cannot open .* service)`)
	osCache          = make(map[string]string)
	osCacheLock      = &sync.Mutex{}
)

func getCachedOs(connName string) (string, bool) {
	osCacheLock.Lock()
	defer osCacheLock.Unlock()
	osName, ok := osCache[connName]
	return osName, ok
}

func setCachedOs(connName string, osName string) {
	osCacheLock.Lock()
	defer osCacheLock.Unlock()
	osCache[connName] = osName
}

func isWindowsProbeOutput(out string) bool {
	return strings.Contains(out, "Windows_NT")
}

// psCommandLine runs a script fed on stdin with Windows PowerShell.
var psCommandLine = "powershell.exe " + strings.Join(psArgs, " ")

var psArgs = []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(psBootstrap)}

// encodePowerShell returns base64 of the UTF-16LE text, as -EncodedCommand expects.
func encodePowerShell(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[i*2] = byte(c)
		b[i*2+1] = byte(c >> 8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// ---- collection ----

func buildWinScript(sections []string, dockerStats bool) string {
	var want []string
	for _, s := range sections {
		want = append(want, psQuote(s))
	}
	stats := "$false"
	if dockerStats {
		stats = "$true"
	}
	r := strings.NewReplacer(
		"__WANT__", strings.Join(want, ","),
		"__DOCKERSTATS__", stats,
		"__MAXPROC__", strconv.Itoa(maxProcesses),
		"__SAMPLEMS__", strconv.Itoa(int(sampleSeconds*1000)),
	)
	return r.Replace(winScript)
}

type winDockerOutput struct {
	Available bool     `json:"available"`
	Rc        int      `json:"rc"`
	Ps        []string `json:"ps"`
	Stats     []string `json:"stats"`
}

type winOutput struct {
	wshrpc.HostInfoData
	// shadows HostInfoData.Docker (the shallower field wins in encoding/json)
	Docker *winDockerOutput `json:"docker"`
}

func parseWinOutput(out string, sections []string) (*wshrpc.HostInfoData, error) {
	var line string
	for _, l := range strings.Split(out, "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimRight(l, "\r"), winJsonMarker); ok {
			line = rest
		}
	}
	if line == "" {
		return nil, fmt.Errorf("no result from the PowerShell script")
	}
	var wo winOutput
	if err := json.Unmarshal([]byte(line), &wo); err != nil {
		return nil, fmt.Errorf("reading the PowerShell result: %w", err)
	}
	data := wo.HostInfoData
	data.Os = OsWindows
	if wo.Docker != nil {
		sec := &section{subs: make(map[string][]string)}
		if !wo.Docker.Available {
			sec.subs["nodocker"] = []string{}
		} else {
			rc := wo.Docker.Rc
			sec.rc = &rc
			sec.subs["ps"] = wo.Docker.Ps
			sec.subs["stats"] = wo.Docker.Stats
		}
		data.Docker = parseDocker(sec)
	}
	normalizeWinData(&data)
	for _, name := range sections {
		if data.Errors[name] != "" || hasSection(&data, name) {
			continue
		}
		if data.Errors == nil {
			data.Errors = make(map[string]string)
		}
		data.Errors[name] = "no output from the host for this section"
	}
	return &data, nil
}

func hasSection(data *wshrpc.HostInfoData, name string) bool {
	switch name {
	case wshrpc.HostSection_System:
		return data.System != nil
	case wshrpc.HostSection_Network:
		return data.Network != nil
	case wshrpc.HostSection_Ports:
		return data.Ports != nil
	case wshrpc.HostSection_Processes:
		return data.Processes != nil
	case wshrpc.HostSection_Services:
		return data.Services != nil
	case wshrpc.HostSection_Docker:
		return data.Docker != nil
	case wshrpc.HostSection_Vitals:
		return data.Vitals != nil
	}
	return false
}

// the UI iterates these lists, so a JSON null (PowerShell's empty result) becomes an empty list
func normalizeWinData(data *wshrpc.HostInfoData) {
	if data.System != nil && data.System.Disks == nil {
		data.System.Disks = []wshrpc.HostDiskInfo{}
	}
	if data.Network != nil && data.Network.Interfaces == nil {
		data.Network.Interfaces = []wshrpc.HostIfaceInfo{}
	}
	if data.Ports != nil && data.Ports.Ports == nil {
		data.Ports.Ports = []wshrpc.HostPortInfo{}
	}
	if data.Processes != nil && data.Processes.Processes == nil {
		data.Processes.Processes = []wshrpc.HostProcessInfo{}
	}
	if data.Services != nil && data.Services.Services == nil {
		data.Services.Services = []wshrpc.HostServiceInfo{}
	}
	if len(data.Errors) == 0 {
		data.Errors = nil
	}
}

// ---- actions ----

// winActionScript builds the PowerShell for an action from the allow-list and a validated target.
func winActionScript(kind, action, target string) (string, error) {
	if !allowedActions[kind][action] {
		return "", fmt.Errorf("unsupported action %q for %q", action, kind)
	}
	switch kind {
	case wshrpc.HostActionKind_Service:
		if !winServiceNameRe.MatchString(target) {
			return "", fmt.Errorf("invalid service name %q", target)
		}
		verb := map[string]string{"start": "Start-Service", "stop": "Stop-Service -Force", "restart": "Restart-Service -Force"}[action]
		return fmt.Sprintf(winCmdletAction, verb+" -Name "+psQuote(target)), nil
	case wshrpc.HostActionKind_Container:
		if !containerNameRe.MatchString(target) {
			return "", fmt.Errorf("invalid container name %q", target)
		}
		return fmt.Sprintf(winNativeAction, "docker "+action+" "+psQuote(target)), nil
	case wshrpc.HostActionKind_Process:
		pid, err := strconv.Atoi(target)
		if err != nil || pid <= 4 {
			return "", fmt.Errorf("invalid pid %q", target)
		}
		if action == "kill" {
			return fmt.Sprintf(winCmdletAction, fmt.Sprintf("Stop-Process -Id %d -Force", pid)), nil
		}
		// taskkill without /F asks the process to close, the closest thing to SIGTERM
		return fmt.Sprintf(winNativeAction, fmt.Sprintf("taskkill.exe /PID %d", pid)), nil
	}
	return "", fmt.Errorf("unknown action kind %q", kind)
}

func runWinAction(ctx context.Context, run runnerFn, kind, action, target string) (*wshrpc.HostActionRtnData, error) {
	script, err := winActionScript(kind, action, target)
	if err != nil {
		return nil, err
	}
	res, err := run(ctx, script)
	if err != nil {
		return nil, err
	}
	if res.exitCode == 0 {
		return &wshrpc.HostActionRtnData{Output: outputOf(res)}, nil
	}
	msg := firstNonEmpty(outputOf(res), fmt.Sprintf("exited with code %d", res.exitCode))
	if winPermissionRe.MatchString(msg) {
		return nil, fmt.Errorf("%s\nWindows only allows this for an administrator. Connect as a user in the Administrators group (OpenSSH gives administrators an elevated session)", msg)
	}
	return nil, fmt.Errorf("%s", msg)
}

const winCmdletAction = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    %s | Out-String | Write-Output
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`

const winNativeAction = `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$out = & %s 2>&1 | ForEach-Object { [string]$_ } | Out-String
$code = $LASTEXITCODE
if ($code -eq 0) {
    Write-Output $out
    exit 0
}
[Console]::Error.WriteLine($out.Trim())
exit $code
`

// winScript must stay plain ASCII: stdin reaches PowerShell in the console's OEM code page.
const winScript = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$want = @(__WANT__)
$dockerStats = __DOCKERSTATS__
$maxProc = __MAXPROC__
$sampleMs = __SAMPLEMS__
$r = @{ os = 'windows'; errors = @{} }
function W([string]$n) { return $want -contains $n }
function Err([string]$n, $e) { $r.errors[$n] = [string]$e.Exception.Message }

$ident = [Security.Principal.WindowsIdentity]::GetCurrent()
$r.user = [string]$ident.Name
$isAdmin = (New-Object Security.Principal.WindowsPrincipal $ident).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$r.uid = if ($isAdmin) { 0 } else { 1000 }

$cpuCount = [Environment]::ProcessorCount
$ci = $null
try { Add-Type -AssemblyName Microsoft.VisualBasic; $ci = New-Object Microsoft.VisualBasic.Devices.ComputerInfo } catch {}
function MemTotal { if ($ci) { return [uint64]$ci.TotalPhysicalMemory } else { return [uint64]0 } }
function MemAvail { if ($ci) { return [uint64]$ci.AvailablePhysicalMemory } else { return [uint64]0 } }

# .NET instead of the Get-Net* cmdlets: same data, a fraction of the time
function Nics {
    $l = @()
    try {
        foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            if ($n.NetworkInterfaceType -eq 'Loopback') { continue }
            $l += $n
        }
    } catch {}
    return ,$l
}
function IsPhysicalNic($n) {
    if ($n.NetworkInterfaceType -ne 'Ethernet' -and $n.NetworkInterfaceType -ne 'Wireless80211' -and $n.NetworkInterfaceType -ne 'GigabitEthernet') { return $false }
    return -not ($n.Description -match 'Virtual|Hyper-V|VPN|TAP-|Loopback|Pseudo|WAN Miniport|Bluetooth' -or $n.Name -like 'vEthernet*')
}
function NetRaw {
    $h = @{}
    foreach ($n in (Nics)) { try { $st = $n.GetIPStatistics(); $h[[string]$n.Name] = @([double]$st.BytesReceived, [double]$st.BytesSent) } catch {} }
    return $h
}
function Disks {
    $l = @()
    foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
        try {
            if ($d.DriveType -ne 'Fixed' -or -not $d.IsReady) { continue }
            $mount = ([string]$d.Name).TrimEnd('\')
            $dev = $mount
            if ($d.VolumeLabel) { $dev = [string]$d.VolumeLabel }
            $l += @{ mount = $mount; device = $dev; fstype = [string]$d.DriveFormat; total = [uint64]$d.TotalSize; avail = [uint64]$d.TotalFreeSpace; used = [uint64]($d.TotalSize - $d.TotalFreeSpace) }
        } catch {}
    }
    return ,$l
}
function CpuRaw { Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'" }
function ProcCpu {
    $h = @{}
    foreach ($p in @(Get-Process)) { try { if ($p.TotalProcessorTime) { $h[[int]$p.Id] = $p.TotalProcessorTime.TotalSeconds } } catch {} }
    return $h
}

$cpuPct = 0.0; $net1 = @{}; $net2 = @{}; $pc1 = @{}; $pc2 = @{}; $sampleSec = $sampleMs / 1000.0
if ((W 'system') -or (W 'network') -or (W 'vitals') -or (W 'processes')) {
    $c1 = $null
    try { $c1 = CpuRaw } catch {}
    $net1 = NetRaw
    if (W 'processes') { $pc1 = ProcCpu }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Milliseconds $sampleMs
    try {
        $c2 = CpuRaw
        $dt = [double]$c2.Timestamp_Sys100NS - [double]$c1.Timestamp_Sys100NS
        if ($c1 -and $dt -gt 0) {
            $idle = ([double]$c2.PercentProcessorTime - [double]$c1.PercentProcessorTime) / $dt
            $cpuPct = [Math]::Max(0.0, [Math]::Min(100.0, 100.0 * (1.0 - $idle)))
        }
    } catch {}
    $net2 = NetRaw
    if (W 'processes') { $pc2 = ProcCpu }
    $sampleSec = $sw.Elapsed.TotalSeconds
}
function Rate($n, [int]$i) {
    if (-not $net1.ContainsKey($n) -or -not $net2.ContainsKey($n) -or $sampleSec -le 0) { return 0.0 }
    return [Math]::Max(0.0, ($net2[$n][$i] - $net1[$n][$i]) / $sampleSec)
}

# one counter query gives uptime and the run queue. Windows has no load average; busy cores plus
# the run queue is the closest equivalent
$uptime = 0.0; $load = [Math]::Round($cpuPct / 100.0 * $cpuCount, 2)
try {
    $ps = Get-CimInstance Win32_PerfRawData_PerfOS_System
    if ($ps.Frequency_Object -gt 0) { $uptime = [Math]::Round(([double]$ps.Timestamp_Object - [double]$ps.SystemUpTime) / [double]$ps.Frequency_Object) }
    $load = [Math]::Round($cpuPct / 100.0 * $cpuCount + [double]$ps.ProcessorQueueLength, 2)
} catch {}

if (W 'system') {
    try {
        $osi = Get-CimInstance Win32_OperatingSystem
        $cs = Get-CimInstance Win32_ComputerSystem
        $cpu = @(Get-CimInstance Win32_Processor)
        $virt = ''
        if ($cs.Model -match 'Virtual|VMware|KVM|QEMU|HVM|Xen|Parallels') { $virt = [string]$cs.Model }
        $r.system = @{
            hostname  = [string]$env:COMPUTERNAME
            os        = [string]$osi.Caption
            kernel    = 'Windows NT ' + $osi.Version + ' ' + $osi.OSArchitecture
            virt      = $virt
            uptimesec = $uptime
            load1     = $load; load5 = $load; load15 = $load
            cpumodel  = ([string]$cpu[0].Name).Trim()
            cpucount  = $cpuCount
            cpupct    = [Math]::Round($cpuPct, 1)
            memtotal  = MemTotal
            memavail  = MemAvail
            swaptotal = [uint64]$osi.SizeStoredInPagingFiles * 1024
            swapfree  = [uint64]$osi.FreeSpaceInPagingFiles * 1024
            users     = @(Get-Process -Name explorer -ErrorAction SilentlyContinue).Count
            disks     = Disks
        }
    } catch { Err 'system' $_ }
}

if (W 'network') {
    try {
        $list = @(); $dr = ''; $dns = New-Object System.Collections.ArrayList
        foreach ($n in (Nics)) {
            $name = [string]$n.Name
            $addrs = @()
            $props = $null
            try { $props = $n.GetIPProperties() } catch {}
            if ($props) {
                foreach ($u in $props.UnicastAddresses) { $addrs += ((([string]$u.Address) -replace '%.*$', '') + '/' + $u.PrefixLength) }
                if (-not $dr -and $n.OperationalStatus -eq 'Up') {
                    foreach ($g in $props.GatewayAddresses) {
                        if ($g.Address.AddressFamily -eq 'InterNetwork' -and [string]$g.Address -ne '0.0.0.0') { $dr = 'default via ' + $g.Address + ' dev ' + $name; break }
                    }
                }
                foreach ($d in $props.DnsAddresses) {
                    $a = [string]$d
                    if ($d.AddressFamily -eq 'InterNetwork' -and -not $dns.Contains($a)) { [void]$dns.Add($a) }
                }
            }
            if ($addrs.Count -eq 0 -and $n.OperationalStatus -ne 'Up') { continue }
            $rx = 0.0; $tx = 0.0
            if ($net2.ContainsKey($name)) { $rx = $net2[$name][0]; $tx = $net2[$name][1] }
            $list += @{ name = $name; addrs = $addrs; rxbytes = [uint64]$rx; txbytes = [uint64]$tx; rxrate = (Rate $name 0); txrate = (Rate $name 1) }
        }
        $r.network = @{ interfaces = $list; defaultroute = $dr; dns = @($dns) }
    } catch { Err 'network' $_ }
}

if (W 'vitals') {
    try {
        $rr = 0.0; $tr = 0.0
        foreach ($n in (Nics)) {
            if (-not (IsPhysicalNic $n)) { continue }
            $rr += (Rate ([string]$n.Name) 0); $tr += (Rate ([string]$n.Name) 1)
        }
        $mx = 0.0; $mxm = ''
        foreach ($d in (Disks)) {
            if ($d.total -gt 0) {
                $p = 100.0 * $d.used / $d.total
                if ($p -gt $mx) { $mx = $p; $mxm = $d.mount }
            }
        }
        $r.vitals = @{ cpupct = [Math]::Round($cpuPct, 1); cpucount = $cpuCount; load1 = $load; memtotal = MemTotal; memavail = MemAvail; uptimesec = $uptime; rxrate = $rr; txrate = $tr; diskmaxpct = [Math]::Round($mx, 1); diskmaxmount = $mxm }
    } catch { Err 'vitals' $_ }
}

if (W 'ports') {
    try {
        $pn = @{}
        foreach ($p in @(Get-Process)) { $pn[[int]$p.Id] = [string]$p.ProcessName }
        $seen = @{}; $l = @()
        # netstat -ano is much faster than Get-NetTCPConnection / Get-NetUDPEndpoint
        foreach ($line in @(& netstat.exe -ano)) {
            $f = -split [string]$line
            if ($f.Count -lt 4) { continue }
            $proto = $f[0].ToLower()
            if ($proto -eq 'tcp') {
                if ($f.Count -lt 5 -or $f[3] -ne 'LISTENING') { continue }
                $procId = $f[4]
            } elseif ($proto -eq 'udp') {
                $procId = $f[3]
            } else { continue }
            $i = $f[1].LastIndexOf(':')
            if ($i -lt 1) { continue }
            $addr = $f[1].Substring(0, $i).Trim('[', ']') -replace '%.*$', ''
            $port = 0
            if (-not [int]::TryParse($f[1].Substring($i + 1), [ref]$port)) { continue }
            $k = $proto + ' ' + $addr + ' ' + $port
            if ($seen.ContainsKey($k)) { continue }; $seen[$k] = $true
            $id = 0; [void][int]::TryParse($procId, [ref]$id)
            $l += @{ proto = $proto; addr = $addr; port = $port; pid = $id; process = [string]$pn[$id] }
        }
        $r.ports = @{ tool = 'netstat'; ports = $l }
    } catch { Err 'ports' $_ }
}

if (W 'processes') {
    try {
        $wmi = @{}
        foreach ($w in @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CommandLine)) { $wmi[[int]$w.ProcessId] = $w }
        $procs = $null
        try { $procs = @(Get-Process -IncludeUserName) } catch { $procs = @(Get-Process) }
        $memT = [double](MemTotal)
        $now = Get-Date
        $rows = @(foreach ($p in $procs) {
            $id = [int]$p.Id
            $cpu = 0.0
            if ($pc1.ContainsKey($id) -and $pc2.ContainsKey($id) -and $sampleSec -gt 0) { $cpu = [Math]::Max(0.0, 100.0 * ($pc2[$id] - $pc1[$id]) / $sampleSec) }
            $el = 0
            try { if ($p.StartTime) { $el = [int64]($now - $p.StartTime).TotalSeconds } } catch {}
            $cmdline = ''; $ppid = 0
            $w = $wmi[$id]
            if ($w) { $cmdline = [string]$w.CommandLine; $ppid = [int]$w.ParentProcessId }
            if (-not $cmdline) { $cmdline = [string]$p.ProcessName }
            $u = ''
            try { if ($p.UserName) { $u = [string]$p.UserName } } catch {}
            $mp = 0.0
            if ($memT -gt 0) { $mp = [Math]::Round(100.0 * $p.WorkingSet64 / $memT, 1) }
            $state = 'running'
            try { if ($p.Responding -eq $false) { $state = 'not responding' } } catch {}
            [pscustomobject]@{ pid = $id; ppid = $ppid; user = $u; cpupct = [Math]::Round($cpu, 1); mempct = $mp; rss = [uint64]$p.WorkingSet64; elapsedsec = $el; state = $state; name = [string]$p.ProcessName; args = $cmdline }
        })
        $top = @($rows | Sort-Object -Property @{ Expression = 'cpupct'; Descending = $true }, @{ Expression = 'rss'; Descending = $true } | Select-Object -First $maxProc)
        $r.processes = @{ total = $procs.Count; processes = $top }
    } catch { Err 'processes' $_ }
}

if (W 'services') {
    try {
        $l = @(); $failed = 0
        foreach ($s in @(Get-CimInstance Win32_Service)) {
            $state = [string]$s.State; $mode = [string]$s.StartMode
            $active = switch ($state) { 'Running' { 'active' } 'Stopped' { 'inactive' } 'Start Pending' { 'activating' } 'Stop Pending' { 'deactivating' } 'Paused' { 'inactive' } default { $state.ToLower() } }
            # an automatic service that stopped with an error (1077 = never started since boot)
            if ($state -eq 'Stopped' -and $mode -eq 'Auto' -and $s.ExitCode -ne 0 -and $s.ExitCode -ne 1077) { $active = 'failed'; $failed++ }
            $en = switch ($mode) { 'Auto' { 'enabled' } 'Manual' { 'manual' } 'Disabled' { 'disabled' } default { $mode.ToLower() } }
            $l += @{ unit = [string]$s.Name; load = 'loaded'; active = $active; sub = $state.ToLower(); enabled = $en; description = [string]$s.DisplayName }
        }
        $r.services = @{ available = $true; services = $l; failed = $failed }
    } catch { Err 'services' $_ }
}

if (W 'docker') {
    $ErrorActionPreference = 'Continue'
    $d = @{ available = $false; rc = 0; ps = @(); stats = @() }
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $d.available = $true
        $d.ps = @(& docker ps -a --no-trunc --format '{{json .}}' 2>&1 | ForEach-Object { [string]$_ })
        $d.rc = $LASTEXITCODE
        if ($dockerStats -and $d.rc -eq 0) {
            $d.stats = @(& docker stats --no-stream --no-trunc --format '{{json .}}' 2>$null | ForEach-Object { [string]$_ })
        }
    }
    $r.docker = $d
    $ErrorActionPreference = 'Stop'
}

[Console]::Out.Write("@@hi-json " + (ConvertTo-Json -InputObject $r -Depth 8 -Compress) + "` + "`" + `n")
`
