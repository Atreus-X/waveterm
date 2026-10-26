# What's different in the Atreus fork

This is [Atreus-X/waveterm](https://github.com/Atreus-X/waveterm), an unofficial fork of [Wave Terminal](https://github.com/wavetermdev/waveterm). It is not endorsed by Command Line Inc. This page lists what the fork changes, fixes or adds compared with upstream. For the full per-release history see the [release notes](./docs/docs/releasenotes.mdx).

Current as of v0.17.6 (2026-10-19).

**Base:** upstream v0.14.5 plus later upstream fixes. The fork is caught up with upstream `main` (`9f1c9670`) as of v0.17.6; upstream has not tagged a release since v0.14.5. Fork releases are tagged `atreus-vX.Y.Z`.

**Direction:** use the SSH hosts in `~/.ssh/config` **without installing `wsh`** on them. Every remote-host feature works over plain SSH (SFTP, tmux, exec) and, where a host has it, over `wsh`. A host without `wsh` keeps working.

Each entry is tagged with the release it first appeared in, as _(vX.Y)_.

## Remote hosts without `wsh`

- **tmux-backed sessions** _(v0.15)_ - `term:tmux` runs each remote terminal in its own tmux session on the host, so restarting Wave or losing the network re-attaches to the same session. Closing the block ends the session. Applies to `wsh` connections too _(v0.16)_
- **Reconnect command** _(v0.15)_ - `term:reconnectcmd` types a command into each fresh session
- **Auto-connect on launch** _(v0.15)_ - `conn:autoconnect` connects and starts remote terminals in all tabs at startup and retries unreachable hosts with backoff
- **SFTP file backend** _(v0.15)_ - the file browser, previews and file operations work over the existing SSH connection with nothing installed on the remote. Uploads and cross-host copies stream, with no size limit and folders on SFTP _(v0.16)_
- **`~/.ssh/config` sync** _(v0.15)_ - hosts from `~/.ssh/config`, including `Include`d files, are added to `connections.json` automatically (`conn:syncsshconfig`); existing entries are never modified
- **`cmd` blocks and the agent usage meter** work on hosts without `wsh` _(v0.17)_
- **Fixes** _(v0.15.1)_ - connections without `wsh` no longer stick on "Connection Degraded", no longer start durable sessions that could never start, and now appear in the file browser's connection picker

## Host Inspector, Fleet and monitoring

All of it read-only and agentless: one script over the connection's own SSH client, `sh` on Linux and PowerShell on Windows hosts.

- **Host Inspector** _(v0.15.5)_ - a block per connection with System, Network, Ports, Processes, Services and Docker tabs. Rows open related Wave blocks, allow-listed service, container and process actions ask for confirmation, and a "what changed" view compares against a saved baseline. Linux and Windows hosts
- **Fleet block and live vitals** _(v0.15.5)_ - every SSH host with live CPU, memory, load, network, fullest disk and uptime, connect/disconnect per row, and small meters on connection chips (`conn:showvitals`)
- **Layout** _(v0.17)_ - collapsible icon-only sidebar with a resizable divider; tables shrink to the block's width _(v0.17.1)_; a compact Overview that summarizes the other tabs and fits the block _(v0.17.5)_
- **Alerts** _(v0.17.4)_ - a bell for full disks and memory, high load, failed services and unhealthy containers; also on connection chips and Fleet rows; dismiss an alert or ignore it permanently; desktop notifications for new critical alerts (`conn:notifyalerts`)
- **Sortable tables** _(v0.17.4)_ - click a column header in the Network, Ports, Processes, Services and Docker tabs

## Library: snippets and notes

- **Snippets** _(v0.15.5)_ - terminal snippets with `{{name=default}}` fill-in fields, limited to matching hosts, inserted with Cmd/Alt+Shift+L or the terminal menu
- **Notes** _(v0.15.5)_ - Markdown notes, general and per host, stored as plain files in the config folder; a host's note shows in its Host Inspector and as an icon on its connection chip
- Swappable tabs, resizable dividers, checkboxes and a formatting toolbar _(v0.16)_; rename titles and descriptions, list fixes _(v0.17)_; hide the list pane _(v0.17.3)_

## File browser and previews

- **Open in your own apps** _(v0.15.2)_ - double-click opens a file in the OS default application (`preview:doubleclickopen`); text files open in a preview by default _(v0.17.1)_. "Open in Notepad++" (`preview:externaleditor`) and "Open With..." on Windows
- **Edit remote files locally** _(v0.15.2)_ - remote files are downloaded, opened locally and uploaded back on every save, with a conflict prompt if the remote changed
- **Drag and drop upload** and **folders first** _(v0.15.3)_ - `preview:dirsfirst`
- **Download as Zip**, multi-select _(v0.16)_
- **Progress and cancel** _(v0.17, v0.17.3)_ - uploads, downloads, zips and copies show a progress card with speed and time remaining, and can be cancelled
- **Editable path with autocomplete** _(v0.17.3)_, an **open chooser** for files with no preview, and the Edit/Save/Preview buttons on their own row
- **Clickable task-list checkboxes** in Markdown previews, written back to the file _(v0.17.4)_

## Connections and tabs

- **Disconnect on sleep and lock** _(v0.15.5)_ - SSH connections close cleanly (`conn:disconnectonsleep`, `conn:disconnectonlock`), with a **Reconnect all** bar on return
- **Safer tab closing** _(v0.16)_ - closing a tab with running terminals asks first (`tab:confirmcloserunning`)
- **Pin block size** _(v0.16)_, **block header icons wrap** instead of clipping _(v0.17.3)_, the app version in the tab bar _(v0.17.3)_

## Settings and appearance

- **Visual settings editor** _(v0.15.4)_ - Settings opens on a tab of dropdowns and toggles with a tooltip per setting; the raw editor is "Advanced Options (JSON)". Update channel and check interval are in it _(v0.17.2)_ and apply without a restart
- **App-wide theme** _(v0.15.4)_ - `app:theme` themes the whole app from a terminal theme
- **Scrollbars** _(v0.16, v0.17)_ - visible scrollbars in the fork's blocks and terminals, `app:scrollbarsize`
- Settings that need a restart say so _(v0.17.2)_

## Privacy, identity and updates

- **Telemetry off by default** _(v0.15)_ - `telemetry:enabled` defaults to false; the daily ping to Wave's servers is skipped, and Wave's hosted cloud AI modes are hidden (`waveai:showcloudmodes`). Changing the setting no longer reports to Wave's servers, and links carry no `?ref=` tags _(v0.15.3)_
- **Turn off Wave AI** _(v0.15.3)_ - `waveai:disabled` hides the AI panel and makes the backend refuse chat requests
- **Own identity** _(v0.15)_ - app ID `com.atreusproject.waveterm`, upstream's `LICENSE` and `NOTICE` shipped, and About says this is an unofficial build
- **Update source** _(v0.15, v0.15.3)_ - `autoupdate:source` picks this fork's builds (`atreus`, the default) or upstream's (`official`); About shows which fork you run and switches the feed live
- **Release binaries** carry no builder paths _(v0.17.1)_

## Fixes to upstream behaviour

- The system SSH config is read from `/etc/ssh/ssh_config` _(v0.15)_ and connections list in a stable order _(v0.15)_
- Enter in the file browser could open the wrong entry when the ".." row wasn't first _(v0.15.3)_
- A CSV with an empty header cell no longer crashes the block _(v0.17.3)_
- Remote files edited externally upload on save more reliably, and reopening shows the latest remote content _(v0.17.3)_
- A beta install can switch to the `latest` update channel without restarting _(v0.17.1)_

## Build, platforms and dependencies

- **Installers:** Windows x64 (NSIS) and Linux x64 (AppImage and deb). macOS builds are not published; build from source with [BUILD.md](./BUILD.md). Installers are unsigned
- **Local builds only:** releases are built on the maintainer's machine with `scripts/atreus-release-local.sh`, gated by `scripts/atreus-check.sh`. The only GitHub Action is CodeQL
- **Upstream gate:** a release stops when upstream has commits the fork lacks, until they have been reviewed (`scripts/upstream-review.sh`)
- **Dependencies:** kept current with Dependabot. Security overrides force patched versions of `dompurify`, `sharp`, `tinypool` and `postcss-selector-parser` _(v0.17.6)_

## Keeping this page current

Every release updates this page. The release script refuses to publish a version unless the "Current as of" line above names it. When you release:

1. Add each user-visible change to the section it belongs in, tagged _(vX.Y)_ with the version it first shipped in. Fixes to upstream behaviour go in their own section.
2. Update "Current as of" with the new version and date, and the upstream commit if a sync happened.
3. Keep entries to a line or two. Detail belongs in the release notes.
