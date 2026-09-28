// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package wshrpc

const (
	HostSection_System    = "system"
	HostSection_Network   = "network"
	HostSection_Ports     = "ports"
	HostSection_Processes = "processes"
	HostSection_Services  = "services"
	HostSection_Docker    = "docker"
)

const (
	HostActionKind_Service   = "service"
	HostActionKind_Container = "container"
	HostActionKind_Process   = "process"
)

type CommandHostInfoData struct {
	Conn     string   `json:"conn"`
	Sections []string `json:"sections"`
	// DockerStats adds per-container CPU/memory (docker stats takes ~2s, so it's opt-in)
	DockerStats bool `json:"dockerstats,omitempty"`
}

// HostInfoData is one snapshot of the requested sections; sections that weren't requested are nil.
type HostInfoData struct {
	Conn      string             `json:"conn"`
	Ts        int64              `json:"ts"`
	Uid       int                `json:"uid"`
	User      string             `json:"user,omitempty"`
	System    *HostSystemInfo    `json:"system,omitempty"`
	Network   *HostNetworkInfo   `json:"network,omitempty"`
	Ports     *HostPortsInfo     `json:"ports,omitempty"`
	Processes *HostProcessesInfo `json:"processes,omitempty"`
	Services  *HostServicesInfo  `json:"services,omitempty"`
	Docker    *HostDockerInfo    `json:"docker,omitempty"`
	// per-section errors (section -> message) for sections that couldn't be collected
	Errors map[string]string `json:"errors,omitempty"`
}

type HostSystemInfo struct {
	Hostname  string         `json:"hostname"`
	Os        string         `json:"os,omitempty"`
	Kernel    string         `json:"kernel,omitempty"`
	Virt      string         `json:"virt,omitempty"`
	UptimeSec float64        `json:"uptimesec"`
	Load1     float64        `json:"load1"`
	Load5     float64        `json:"load5"`
	Load15    float64        `json:"load15"`
	CpuModel  string         `json:"cpumodel,omitempty"`
	CpuCount  int            `json:"cpucount"`
	CpuPct    float64        `json:"cpupct"`
	MemTotal  uint64         `json:"memtotal"`
	MemAvail  uint64         `json:"memavail"`
	SwapTotal uint64         `json:"swaptotal"`
	SwapFree  uint64         `json:"swapfree"`
	Users     int            `json:"users"`
	Disks     []HostDiskInfo `json:"disks"`
}

type HostDiskInfo struct {
	Mount  string `json:"mount"`
	Device string `json:"device"`
	FsType string `json:"fstype,omitempty"`
	Total  uint64 `json:"total"`
	Used   uint64 `json:"used"`
	Avail  uint64 `json:"avail"`
}

type HostNetworkInfo struct {
	Interfaces   []HostIfaceInfo `json:"interfaces"`
	DefaultRoute string          `json:"defaultroute,omitempty"`
	Dns          []string        `json:"dns,omitempty"`
}

type HostIfaceInfo struct {
	Name    string   `json:"name"`
	Addrs   []string `json:"addrs,omitempty"`
	RxBytes uint64   `json:"rxbytes"`
	TxBytes uint64   `json:"txbytes"`
	// bytes per second over the collection's sampling window
	RxRate float64 `json:"rxrate"`
	TxRate float64 `json:"txrate"`
}

type HostPortsInfo struct {
	Tool  string         `json:"tool,omitempty"`
	Ports []HostPortInfo `json:"ports"`
	// some listeners have no process info because they belong to other users and we're not root
	NeedsRoot bool `json:"needsroot,omitempty"`
}

type HostPortInfo struct {
	Proto   string `json:"proto"`
	Addr    string `json:"addr"`
	Port    int    `json:"port"`
	Process string `json:"process,omitempty"`
	Pid     int    `json:"pid,omitempty"`
}

type HostProcessesInfo struct {
	Total     int               `json:"total"`
	Processes []HostProcessInfo `json:"processes"`
}

type HostProcessInfo struct {
	Pid        int     `json:"pid"`
	Ppid       int     `json:"ppid"`
	User       string  `json:"user"`
	CpuPct     float64 `json:"cpupct"`
	MemPct     float64 `json:"mempct"`
	Rss        uint64  `json:"rss"`
	ElapsedSec int64   `json:"elapsedsec"`
	State      string  `json:"state"`
	Name       string  `json:"name"`
	Args       string  `json:"args"`
}

type HostServicesInfo struct {
	Available bool              `json:"available"`
	Services  []HostServiceInfo `json:"services"`
	Failed    int               `json:"failed"`
}

type HostServiceInfo struct {
	Unit        string `json:"unit"`
	Load        string `json:"load"`
	Active      string `json:"active"`
	Sub         string `json:"sub"`
	Enabled     string `json:"enabled,omitempty"`
	Description string `json:"description,omitempty"`
}

type HostDockerInfo struct {
	Available  bool                `json:"available"`
	Error      string              `json:"error,omitempty"`
	Containers []HostContainerInfo `json:"containers"`
}

type HostContainerInfo struct {
	Id         string `json:"id"`
	Name       string `json:"name"`
	Image      string `json:"image"`
	State      string `json:"state"`
	Status     string `json:"status"`
	Ports      string `json:"ports,omitempty"`
	Project    string `json:"project,omitempty"`
	RunningFor string `json:"runningfor,omitempty"`
	Mounts     string `json:"mounts,omitempty"`
	CpuPct     string `json:"cpupct,omitempty"`
	MemUsage   string `json:"memusage,omitempty"`
	MemPct     string `json:"mempct,omitempty"`
	NetIO      string `json:"netio,omitempty"`
}

type CommandHostActionData struct {
	Conn   string `json:"conn"`
	Kind   string `json:"kind"`
	Target string `json:"target"`
	Action string `json:"action"`
}

type HostActionRtnData struct {
	Output string `json:"output,omitempty"`
	// the action needs a sudo password; Command is what to run interactively in a terminal instead
	NeedsAuth bool   `json:"needsauth,omitempty"`
	Command   string `json:"command,omitempty"`
}
