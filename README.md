<p align="center">
  <a href="https://github.com/Atreus-X/waveterm">
	<picture>
		<source media="(prefers-color-scheme: dark)" srcset="./assets/wave-dark.png">
		<source media="(prefers-color-scheme: light)" srcset="./assets/wave-light.png">
		<img alt="Wave Terminal Logo" src="./assets/wave-light.png" width="240">
	</picture>
  </a>
  <br/>
</p>

# Wave Terminal (Atreus fork)

> **This is an unofficial fork of [Wave Terminal](https://github.com/wavetermdev/waveterm), maintained by Atreus-X and not endorsed by Command Line Inc.** See **[FORK.md](./FORK.md)** for everything it changes, fixes or adds compared with upstream.

<div align="center">

[English](README.md) | [한국어](README.ko.md) | [繁體中文](README.zh-TW.md)

</div>

The translations are of upstream's README.

Wave is an open-source, AI-integrated terminal for Linux, Windows, and macOS. This fork is built around working with remote hosts over plain SSH: nothing has to be installed on the servers you connect to. Remote terminals can run in tmux so they survive network interruptions and restarts, the file browser and previews work over SFTP, and a Host Inspector shows what is running on a host and how healthy it is.

![WaveTerm Screenshot](./assets/wave-screenshot.webp)

## What's different in this fork

Highlights; the complete, versioned list is in **[FORK.md](./FORK.md)**.

- **No `wsh` needed on remote hosts** - tmux-backed sessions, auto-connect on launch, an SFTP file browser, and `~/.ssh/config` sync. Hosts that do have `wsh` keep working
- **Host Inspector and Fleet** - System, Network, Ports, Processes, Services and Docker for a host, live CPU, memory and disk for every host, and alerts when something needs attention (Linux and Windows hosts)
- **Library** - terminal snippets with fill-in fields, and Markdown notes per host
- **A better file browser** - open files in your own apps, edit remote files locally and sync them back on save, drag-and-drop upload, Download as Zip, and cancellable transfers with progress
- **Disconnect on sleep and lock**, and safer tab closing
- **Privacy** - telemetry is off by default, and Wave's hosted cloud AI modes are hidden
- **A visual settings editor** and one theme for the whole app

## Key Features

- Durable remote terminal sessions that survive connection interruptions, network changes, and restarts
- Flexible drag & drop interface to organize terminal blocks, editors, web browsers, and AI assistants
- Built-in editor for editing remote files with syntax highlighting and modern editor features
- Rich file preview system for remote files (markdown, images, video, PDFs, CSVs, directories)
- Quick full-screen toggle for any block - expand terminals, editors, and previews for better visibility, then instantly return to multi-block view
- Wave AI, a chat assistant with support for multiple models (OpenAI, Claude, Azure, Perplexity, Ollama) that you connect with your own API keys
- Command Blocks for isolating and monitoring individual commands
- One-click remote connections with full terminal and file system access
- Secure secret storage using native system backends - store API keys and credentials locally, access them across SSH sessions
- Rich customization including tab themes, terminal styles, and background images
- The `wsh` command system for managing your workspace from the CLI and sharing data between terminal sessions, on hosts where you choose to install it
- Connected file management with `wsh file` - seamlessly copy and sync files between local and remote SSH hosts

## Wave AI

Wave AI is a context-aware terminal assistant with access to your workspace:

- **Terminal Context**: Reads terminal output and scrollback for debugging and analysis
- **File Operations**: Read, write, and edit files with automatic backups and user approval
- **CLI Integration**: Use `wsh ai` to pipe output or attach files directly from the command line
- **BYOK Support**: Bring your own API keys for OpenAI, Claude, Gemini, Azure, and other providers
- **Local Models**: Run local models with Ollama, LM Studio, and other OpenAI-compatible providers
- **Hosted AI is hidden**: this fork hides Wave's own cloud AI modes by default (they need telemetry, which is off), so there are no included credits; you use your own keys
- **Optional**: set `waveai:disabled` (or use the switch in Settings) to turn Wave AI off entirely

Learn more in upstream's [Wave AI documentation](https://docs.waveterm.dev/waveai) and [Wave AI Modes documentation](https://docs.waveterm.dev/waveai-modes).

## Installation

Download the latest installer from the [Releases page](https://github.com/Atreus-X/waveterm/releases) (tags look like `atreus-vX.Y.Z`).

| Platform | Installer                                    |
| -------- | -------------------------------------------- |
| Windows  | `.exe` installer (x64)                       |
| Linux    | `.AppImage` or `.deb` (x64)                  |
| macOS    | not published; [build from source](BUILD.md) |

The installers are unsigned, so Windows SmartScreen may warn before you run them.

The app updates itself from this fork's releases. In Settings, **Updates from** switches to upstream Wave's updates instead.

### Minimum requirements

The `wsh` helper, which is optional on remote hosts, runs on:

- macOS 11 or later (arm64, x64)
- Windows 10 or later (x64)
- Linux Kernel 2.6.32 or later (x64), Linux Kernel 3.1 or later (arm64)

## Documentation and changes

- [FORK.md](./FORK.md) - what this fork changes compared with upstream, kept current with every release
- [Release notes](./docs/docs/releasenotes.mdx) - the full per-release changelog, upstream's and this fork's
- [Upstream documentation](https://docs.waveterm.dev) - covers the features both share; settings the fork adds are in FORK.md and in [config.mdx](./docs/docs/config.mdx)
- [ROADMAP.md](./ROADMAP.md) is upstream's roadmap and is not maintained by this fork

## Building from Source

See [Building Wave Terminal](BUILD.md). This fork builds and publishes releases locally with `scripts/atreus-release-local.sh`, checked by `scripts/atreus-check.sh`; the only GitHub Action is CodeQL.

## Upstream

This fork tracks [wavetermdev/waveterm](https://github.com/wavetermdev/waveterm), and a release waits until any new upstream commits have been reviewed. If a change would help every Wave user, it belongs upstream: see upstream's [Contributions Guide](CONTRIBUTING.md) for how that works.

- Upstream homepage &mdash; https://www.waveterm.dev
- Upstream documentation &mdash; https://docs.waveterm.dev
- Upstream Discord &mdash; https://discord.gg/XfvZ334gwU
- Support upstream's development &mdash; https://github.com/sponsors/wavetermdev

GitHub Issues and Discussions are turned off on this fork.

## License

Wave Terminal is licensed under the Apache-2.0 License, and so is this fork. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). For more information on our dependencies, see [here](./ACKNOWLEDGEMENTS.md).
