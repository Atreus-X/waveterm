// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package hostinfo

import (
	"encoding/json"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// pseudo / container filesystems that would only clutter the disk list
var skipFsTypes = map[string]bool{
	"tmpfs": true, "devtmpfs": true, "overlay": true, "squashfs": true, "proc": true, "sysfs": true,
	"cgroup": true, "cgroup2": true, "devpts": true, "efivarfs": true, "fuse.lxcfs": true, "nsfs": true,
	"tracefs": true, "debugfs": true, "securityfs": true, "pstore": true, "bpf": true, "autofs": true,
	"mqueue": true, "hugetlbfs": true, "configfs": true, "fusectl": true, "ramfs": true, "binfmt_misc": true,
}

type section struct {
	lines []string
	subs  map[string][]string
	rc    *int
}

type rawOutput struct {
	uid      int
	user     string
	sections map[string]*section
}

// splitOutput cuts the script output into sections; lines before the first sub-marker of a
// section belong to section.lines, the rest to section.subs[name].
func splitOutput(out string) *rawOutput {
	raw := &rawOutput{uid: -1, sections: make(map[string]*section)}
	var cur *section
	curSub := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		switch {
		case strings.HasPrefix(line, "@@hi-uid "):
			if v, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "@@hi-uid "))); err == nil {
				raw.uid = v
			}
		case strings.HasPrefix(line, "@@hi-user "):
			raw.user = strings.TrimSpace(strings.TrimPrefix(line, "@@hi-user "))
		case strings.HasPrefix(line, markerBegin):
			cur = &section{subs: make(map[string][]string)}
			raw.sections[strings.TrimSpace(strings.TrimPrefix(line, markerBegin))] = cur
			curSub = ""
		case strings.HasPrefix(line, markerEnd):
			cur = nil
		case cur == nil:
			continue
		case strings.HasPrefix(line, markerSub):
			curSub = strings.TrimSpace(strings.TrimPrefix(line, markerSub))
			if _, ok := cur.subs[curSub]; !ok {
				cur.subs[curSub] = []string{}
			}
		case strings.HasPrefix(line, "@@hi-rc "):
			if v, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "@@hi-rc "))); err == nil {
				cur.rc = &v
			}
		case curSub == "":
			cur.lines = append(cur.lines, line)
		default:
			cur.subs[curSub] = append(cur.subs[curSub], line)
		}
	}
	return raw
}

func nonEmpty(lines []string) []string {
	var rtn []string
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			rtn = append(rtn, l)
		}
	}
	return rtn
}

// ---- sample (CPU % and network rates) ----

type sample struct {
	cpu1, cpu2 string
	net1, net2 map[string][2]uint64
}

func parseSample(sec *section) *sample {
	if sec == nil {
		return nil
	}
	s := &sample{}
	for _, l := range sec.lines {
		if strings.HasPrefix(l, "cpu1 ") {
			s.cpu1 = strings.TrimPrefix(l, "cpu1 ")
		}
	}
	for _, l := range sec.subs["cpu2"] {
		if strings.HasPrefix(l, "cpu2 ") {
			s.cpu2 = strings.TrimPrefix(l, "cpu2 ")
		}
	}
	s.net1 = parseNetDev(sec.subs["net1"])
	s.net2 = parseNetDev(sec.subs["net2"])
	return s
}

// cpuPercent compares two "cpu  user nice system idle iowait irq softirq steal ..." lines.
func cpuPercent(line1, line2 string) float64 {
	parse := func(line string) (total, idle uint64, ok bool) {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "cpu" {
			return 0, 0, false
		}
		for i, f := range fields[1:] {
			if i >= 8 { // guest/guest_nice are already counted in user/nice
				break
			}
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				return 0, 0, false
			}
			total += v
			if i == 3 || i == 4 { // idle, iowait
				idle += v
			}
		}
		return total, idle, true
	}
	t1, i1, ok1 := parse(line1)
	t2, i2, ok2 := parse(line2)
	if !ok1 || !ok2 || t2 <= t1 {
		return 0
	}
	dTotal := float64(t2 - t1)
	dIdle := float64(i2 - i1)
	pct := (dTotal - dIdle) / dTotal * 100
	if pct < 0 {
		return 0
	}
	return pct
}

// parseNetDev returns iface -> [rxBytes, txBytes] from /proc/net/dev.
func parseNetDev(lines []string) map[string][2]uint64 {
	rtn := make(map[string][2]uint64)
	for _, l := range lines {
		name, rest, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		fields := strings.Fields(rest)
		if name == "" || len(fields) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(fields[0], 10, 64)
		tx, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		rtn[name] = [2]uint64{rx, tx}
	}
	return rtn
}

// ---- system ----

func parseSystem(sec *section, smp *sample) *wshrpc.HostSystemInfo {
	info := &wshrpc.HostSystemInfo{Disks: []wshrpc.HostDiskInfo{}}
	for _, l := range sec.lines {
		if strings.HasPrefix(l, "mem ") {
			fields := strings.Fields(strings.TrimPrefix(l, "mem "))
			if len(fields) < 2 {
				continue
			}
			kb, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				continue
			}
			switch strings.TrimSuffix(fields[0], ":") {
			case "MemTotal":
				info.MemTotal = kb * 1024
			case "MemAvailable":
				info.MemAvail = kb * 1024
			case "SwapTotal":
				info.SwapTotal = kb * 1024
			case "SwapFree":
				info.SwapFree = kb * 1024
			}
			continue
		}
		key, val, ok := strings.Cut(l, "=")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch key {
		case "hostname":
			info.Hostname = val
		case "os":
			info.Os = val
		case "kernel":
			info.Kernel = val
		case "virt":
			if val != "none" {
				info.Virt = val
			}
		case "uptime":
			info.UptimeSec, _ = strconv.ParseFloat(val, 64)
		case "loadavg":
			fields := strings.Fields(val)
			if len(fields) >= 3 {
				info.Load1, _ = strconv.ParseFloat(fields[0], 64)
				info.Load5, _ = strconv.ParseFloat(fields[1], 64)
				info.Load15, _ = strconv.ParseFloat(fields[2], 64)
			}
		case "cpumodel":
			info.CpuModel = val
		case "cpucount":
			info.CpuCount, _ = strconv.Atoi(val)
		case "users":
			info.Users, _ = strconv.Atoi(val)
		}
	}
	if smp != nil {
		info.CpuPct = cpuPercent(smp.cpu1, smp.cpu2)
	}
	info.Disks = parseDf(sec.subs["disks"])
	return info
}

// parseDf reads `df -PkT`: Filesystem Type 1024-blocks Used Available Capacity Mounted-on (may contain spaces).
func parseDf(lines []string) []wshrpc.HostDiskInfo {
	rtn := []wshrpc.HostDiskInfo{}
	seen := make(map[string]bool)
	for _, l := range lines {
		fields := strings.Fields(l)
		if len(fields) < 7 || fields[0] == "Filesystem" {
			continue
		}
		fsType := fields[1]
		if skipFsTypes[fsType] {
			continue
		}
		total, err1 := strconv.ParseUint(fields[2], 10, 64)
		used, err2 := strconv.ParseUint(fields[3], 10, 64)
		avail, err3 := strconv.ParseUint(fields[4], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil || total == 0 {
			continue
		}
		mount := strings.Join(fields[6:], " ")
		// bind mounts of the same device show up repeatedly (docker, snaps); keep the first mount point
		if seen[fields[0]] && strings.HasPrefix(fields[0], "/dev/") {
			continue
		}
		seen[fields[0]] = true
		rtn = append(rtn, wshrpc.HostDiskInfo{
			Mount:  mount,
			Device: fields[0],
			FsType: fsType,
			Total:  total * 1024,
			Used:   used * 1024,
			Avail:  avail * 1024,
		})
	}
	return rtn
}

// ---- network ----

func parseNetwork(sec *section, smp *sample) *wshrpc.HostNetworkInfo {
	info := &wshrpc.HostNetworkInfo{Interfaces: []wshrpc.HostIfaceInfo{}}
	byName := make(map[string]*wshrpc.HostIfaceInfo)
	var order []string
	getIface := func(name string) *wshrpc.HostIfaceInfo {
		if iface, ok := byName[name]; ok {
			return iface
		}
		iface := &wshrpc.HostIfaceInfo{Name: name}
		byName[name] = iface
		order = append(order, name)
		return iface
	}
	// `ip -o addr show`: "2: eth0    inet 192.0.2.10/24 brd ... scope global eth0\ ..."
	for _, l := range sec.lines {
		fields := strings.Fields(l)
		if len(fields) < 4 || (fields[2] != "inet" && fields[2] != "inet6") {
			continue
		}
		name, _, _ := strings.Cut(fields[1], "@")
		iface := getIface(name)
		iface.Addrs = append(iface.Addrs, fields[3])
	}
	if smp != nil {
		for name, v2 := range smp.net2 {
			iface := getIface(name)
			iface.RxBytes = v2[0]
			iface.TxBytes = v2[1]
			if v1, ok := smp.net1[name]; ok {
				if v2[0] >= v1[0] {
					iface.RxRate = float64(v2[0]-v1[0]) / sampleSeconds
				}
				if v2[1] >= v1[1] {
					iface.TxRate = float64(v2[1]-v1[1]) / sampleSeconds
				}
			}
		}
	}
	// interfaces with an address first (in ip's order), then the rest by name
	sort.SliceStable(order, func(i, j int) bool {
		ai, aj := len(byName[order[i]].Addrs) > 0, len(byName[order[j]].Addrs) > 0
		if ai != aj {
			return ai
		}
		if !ai {
			return order[i] < order[j]
		}
		return false
	})
	for _, name := range order {
		info.Interfaces = append(info.Interfaces, *byName[name])
	}
	for _, l := range nonEmpty(sec.subs["route"]) {
		if info.DefaultRoute == "" {
			info.DefaultRoute = strings.TrimSpace(l)
		}
	}
	for _, l := range sec.subs["dns"] {
		fields := strings.Fields(l)
		if len(fields) >= 2 {
			info.Dns = append(info.Dns, fields[1])
		}
	}
	return info
}

// ---- ports ----

// splitHostPort handles "0.0.0.0:22", "[::]:22", "*:68", "127.0.0.53%lo:53", ":::22" (netstat).
func splitHostPort(s string) (string, int, bool) {
	idx := strings.LastIndex(s, ":")
	if idx < 0 {
		return "", 0, false
	}
	port, err := strconv.Atoi(s[idx+1:])
	if err != nil {
		return "", 0, false
	}
	host := strings.TrimSuffix(strings.TrimPrefix(s[:idx], "["), "]")
	if host == "" {
		host = "*"
	}
	return host, port, true
}

// ss process column: users:(("sshd",pid=812,fd=3),("sshd",pid=900,fd=3))
func parseSsProcess(s string) (string, int) {
	start := strings.Index(s, `(("`)
	if start < 0 {
		return "", 0
	}
	rest := s[start+3:]
	name, rest, ok := strings.Cut(rest, `"`)
	if !ok {
		return "", 0
	}
	pid := 0
	if i := strings.Index(rest, "pid="); i >= 0 {
		numStr := rest[i+4:]
		end := strings.IndexAny(numStr, ",)")
		if end >= 0 {
			pid, _ = strconv.Atoi(numStr[:end])
		}
	}
	return name, pid
}

func parsePorts(sec *section, uid int) *wshrpc.HostPortsInfo {
	info := &wshrpc.HostPortsInfo{Ports: []wshrpc.HostPortInfo{}}
	if lines, ok := sec.subs["ss"]; ok {
		info.Tool = "ss"
		// Netid State Recv-Q Send-Q Local Peer [Process]
		for _, l := range lines {
			fields := strings.Fields(l)
			if len(fields) < 6 {
				continue
			}
			host, port, ok := splitHostPort(fields[4])
			if !ok {
				continue
			}
			p := wshrpc.HostPortInfo{Proto: fields[0], Addr: host, Port: port}
			if len(fields) > 6 {
				p.Process, p.Pid = parseSsProcess(strings.Join(fields[6:], " "))
			}
			info.Ports = append(info.Ports, p)
		}
	} else if lines, ok := sec.subs["netstat"]; ok {
		info.Tool = "netstat"
		// tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 812/sshd  |  udp 0 0 0.0.0.0:68 0.0.0.0:* 700/dhclient
		for _, l := range lines {
			fields := strings.Fields(l)
			if len(fields) < 6 || !strings.HasPrefix(fields[0], "tcp") && !strings.HasPrefix(fields[0], "udp") {
				continue
			}
			host, port, ok := splitHostPort(fields[3])
			if !ok {
				continue
			}
			p := wshrpc.HostPortInfo{Proto: fields[0], Addr: host, Port: port}
			procField := fields[len(fields)-1]
			if pidStr, name, ok := strings.Cut(procField, "/"); ok {
				p.Pid, _ = strconv.Atoi(pidStr)
				p.Process = name
			}
			info.Ports = append(info.Ports, p)
		}
	} else {
		info.Tool = "none"
	}
	sort.SliceStable(info.Ports, func(i, j int) bool {
		if info.Ports[i].Port != info.Ports[j].Port {
			return info.Ports[i].Port < info.Ports[j].Port
		}
		return info.Ports[i].Proto < info.Ports[j].Proto
	})
	if uid != 0 {
		for _, p := range info.Ports {
			if p.Process == "" {
				info.NeedsRoot = true
				break
			}
		}
	}
	return info
}

// ---- processes ----

func processName(args string) string {
	if strings.HasPrefix(args, "[") { // kernel thread
		return args
	}
	first, _, _ := strings.Cut(args, " ")
	return path.Base(first)
}

func parseProcesses(sec *section) *wshrpc.HostProcessesInfo {
	info := &wshrpc.HostProcessesInfo{Processes: []wshrpc.HostProcessInfo{}}
	for _, l := range sec.lines {
		if v, ok := strings.CutPrefix(l, "total="); ok {
			info.Total, _ = strconv.Atoi(strings.TrimSpace(v))
		}
	}
	// pid ppid user pcpu pmem rss etimes stat args...
	for _, l := range sec.subs["ps"] {
		fields := strings.Fields(l)
		if len(fields) < 9 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		p := wshrpc.HostProcessInfo{Pid: pid, User: fields[2], State: fields[7]}
		p.Ppid, _ = strconv.Atoi(fields[1])
		p.CpuPct, _ = strconv.ParseFloat(fields[3], 64)
		p.MemPct, _ = strconv.ParseFloat(fields[4], 64)
		if rssKb, err := strconv.ParseUint(fields[5], 10, 64); err == nil {
			p.Rss = rssKb * 1024
		}
		p.ElapsedSec, _ = strconv.ParseInt(fields[6], 10, 64)
		p.Args = strings.Join(fields[8:], " ")
		p.Name = processName(p.Args)
		info.Processes = append(info.Processes, p)
	}
	if info.Total < len(info.Processes) {
		info.Total = len(info.Processes)
	}
	return info
}

// ---- services ----

func parseServices(sec *section) *wshrpc.HostServicesInfo {
	info := &wshrpc.HostServicesInfo{Services: []wshrpc.HostServiceInfo{}}
	if _, ok := sec.subs["nosystemd"]; ok {
		return info
	}
	info.Available = true
	enabled := make(map[string]string)
	for _, l := range sec.subs["files"] {
		fields := strings.Fields(l)
		if len(fields) >= 2 {
			enabled[fields[0]] = fields[1]
		}
	}
	// unit load active sub description...
	for _, l := range sec.subs["units"] {
		fields := strings.Fields(l)
		if len(fields) < 4 || !strings.HasSuffix(fields[0], ".service") {
			continue
		}
		svc := wshrpc.HostServiceInfo{
			Unit:   fields[0],
			Load:   fields[1],
			Active: fields[2],
			Sub:    fields[3],
		}
		if len(fields) > 4 {
			svc.Description = strings.Join(fields[4:], " ")
		}
		if e, ok := enabled[svc.Unit]; ok {
			svc.Enabled = e
		} else if at := strings.Index(svc.Unit, "@"); at > 0 {
			// template instances (getty@tty1.service) inherit from the template's unit file
			svc.Enabled = enabled[svc.Unit[:at+1]+".service"]
		}
		if svc.Active == "failed" {
			info.Failed++
		}
		info.Services = append(info.Services, svc)
	}
	return info
}

// ---- docker ----

type dockerPsLine struct {
	ID         string `json:"ID"`
	Names      string `json:"Names"`
	Image      string `json:"Image"`
	State      string `json:"State"`
	Status     string `json:"Status"`
	Ports      string `json:"Ports"`
	Labels     string `json:"Labels"`
	RunningFor string `json:"RunningFor"`
	Mounts     string `json:"Mounts"`
}

type dockerStatsLine struct {
	ID       string `json:"ID"`
	Name     string `json:"Name"`
	CPUPerc  string `json:"CPUPerc"`
	MemUsage string `json:"MemUsage"`
	MemPerc  string `json:"MemPerc"`
	NetIO    string `json:"NetIO"`
}

func composeProject(labels string) string {
	for _, kv := range strings.Split(labels, ",") {
		if v, ok := strings.CutPrefix(kv, "com.docker.compose.project="); ok {
			return v
		}
	}
	return ""
}

func parseDocker(sec *section) *wshrpc.HostDockerInfo {
	info := &wshrpc.HostDockerInfo{Containers: []wshrpc.HostContainerInfo{}}
	if _, ok := sec.subs["nodocker"]; ok {
		return info
	}
	info.Available = true
	lines := nonEmpty(sec.subs["ps"])
	if sec.rc != nil && *sec.rc != 0 {
		info.Error = strings.TrimSpace(strings.Join(lines, "\n"))
		if info.Error == "" {
			info.Error = "docker ps failed"
		}
		return info
	}
	stats := make(map[string]dockerStatsLine)
	for _, l := range nonEmpty(sec.subs["stats"]) {
		var st dockerStatsLine
		if json.Unmarshal([]byte(l), &st) == nil {
			stats[st.ID] = st
			stats[st.Name] = st
		}
	}
	for _, l := range lines {
		var ps dockerPsLine
		if err := json.Unmarshal([]byte(l), &ps); err != nil {
			continue
		}
		c := wshrpc.HostContainerInfo{
			Id:         ps.ID,
			Name:       ps.Names,
			Image:      ps.Image,
			State:      ps.State,
			Status:     ps.Status,
			Ports:      ps.Ports,
			Project:    composeProject(ps.Labels),
			RunningFor: ps.RunningFor,
			Mounts:     ps.Mounts,
		}
		st, ok := stats[ps.ID]
		if !ok {
			st, ok = stats[ps.Names]
		}
		if ok {
			c.CpuPct = st.CPUPerc
			c.MemUsage = st.MemUsage
			c.MemPct = st.MemPerc
			c.NetIO = st.NetIO
		}
		info.Containers = append(info.Containers, c)
	}
	return info
}

// ---- vitals ----

// loopback and container/virtual interfaces would double-count traffic that also crosses a physical NIC
var virtualIfacePrefixes = []string{"lo", "veth", "br-", "docker", "virbr", "cni", "flannel", "cali", "vnet", "tun", "tap"}

func isVirtualIface(name string) bool {
	for _, p := range virtualIfacePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func parseVitals(sec *section, smp *sample) *wshrpc.HostVitalsInfo {
	v := &wshrpc.HostVitalsInfo{}
	for _, l := range sec.lines {
		if strings.HasPrefix(l, "mem ") {
			fields := strings.Fields(strings.TrimPrefix(l, "mem "))
			if len(fields) < 2 {
				continue
			}
			kb, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				continue
			}
			switch strings.TrimSuffix(fields[0], ":") {
			case "MemTotal":
				v.MemTotal = kb * 1024
			case "MemAvailable":
				v.MemAvail = kb * 1024
			}
			continue
		}
		key, val, ok := strings.Cut(l, "=")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch key {
		case "loadavg":
			if fields := strings.Fields(val); len(fields) > 0 {
				v.Load1, _ = strconv.ParseFloat(fields[0], 64)
			}
		case "cpucount":
			v.CpuCount, _ = strconv.Atoi(val)
		case "uptime":
			v.UptimeSec, _ = strconv.ParseFloat(val, 64)
		}
	}
	if smp != nil {
		v.CpuPct = cpuPercent(smp.cpu1, smp.cpu2)
		for name, v2 := range smp.net2 {
			v1, ok := smp.net1[name]
			if !ok || isVirtualIface(name) {
				continue
			}
			if v2[0] >= v1[0] {
				v.RxRate += float64(v2[0]-v1[0]) / sampleSeconds
			}
			if v2[1] >= v1[1] {
				v.TxRate += float64(v2[1]-v1[1]) / sampleSeconds
			}
		}
	}
	for _, d := range parseDf(sec.subs["disks"]) {
		if d.Used+d.Avail == 0 {
			continue
		}
		// used/(used+avail) matches df's Capacity column (reserved blocks don't count as free)
		p := float64(d.Used) / float64(d.Used+d.Avail) * 100
		if p > v.DiskMaxPct {
			v.DiskMaxPct = p
			v.DiskMaxMount = d.Mount
		}
	}
	return v
}

// ---- assemble ----

func parseOutput(out string, sections []string) *wshrpc.HostInfoData {
	raw := splitOutput(out)
	data := &wshrpc.HostInfoData{Uid: raw.uid, User: raw.user}
	smp := parseSample(raw.sections["sample"])
	missing := func(name string) {
		if data.Errors == nil {
			data.Errors = make(map[string]string)
		}
		data.Errors[name] = "no output from the host for this section"
	}
	for _, name := range sections {
		sec := raw.sections[name]
		if sec == nil {
			missing(name)
			continue
		}
		switch name {
		case wshrpc.HostSection_System:
			data.System = parseSystem(sec, smp)
		case wshrpc.HostSection_Network:
			data.Network = parseNetwork(sec, smp)
		case wshrpc.HostSection_Ports:
			data.Ports = parsePorts(sec, raw.uid)
		case wshrpc.HostSection_Processes:
			data.Processes = parseProcesses(sec)
		case wshrpc.HostSection_Services:
			data.Services = parseServices(sec)
		case wshrpc.HostSection_Docker:
			data.Docker = parseDocker(sec)
		case wshrpc.HostSection_Vitals:
			data.Vitals = parseVitals(sec, smp)
		}
	}
	return data
}
