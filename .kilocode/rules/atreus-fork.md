# Atreus-X fork rules

Fork-specific. Where these conflict with the generic Wave rules imported above, these win.

## Standing rules

- **Privacy.** Never put personal or infra details in commits, PRs, logs, installers or test data: no git identity, hostnames, IPs, ports, usernames, key names. Test data uses `192.0.2.x`, `198.51.100.x`, `example.com`. Run `privacy-scan --text -` on every PR body and release note; commit and push hooks scan the rest. If something could leak, ask first.
- **SSH and wsh, always both.** Every remote-host feature or fix must work over the plain-SSH route (SFTP / tmux / exec) and the wsh route. Implement, test and list both in the PR body.
- **No wsh dependency.** A remote host without wsh installed must keep working.
- **Local builds only.** The only GitHub Action is CodeQL. Releases are built locally with `scripts/atreus-release-local.sh`.
- **Test builds are Windows-only** (`--windows-only`); only the `.exe` is kept. Releases build all platforms.
- **Upstream gate.** Releases stop when `upstream/main` is ahead. Run `scripts/upstream-review.sh`, report what changed, and wait for the user's go-ahead before syncing.
- **Releases and merges are the user's call.** Release only when asked, never deploy unprompted, and do not run `gh pr merge` here. Creating PRs is fine.

## Completion format

The generic "Done:" / `attempt_completion` rules and the Kilo tool names (`write_to_file`, `replace_in_file`, `append_file`) do not apply. Use Edit / Write. Background sessions end with a short report and a `result:` line.

## Codegen and Go

- `task generate` = `go run ./cmd/generateschema`, `go run ./cmd/generatego`, `go run ./cmd/generatets`.
- "Never run `go build`" covers ad-hoc compile checks. Use `go vet`. `scripts/atreus-release-local.sh` builds as part of a release.

## Dev environment

- Node and Go are not on `PATH`: `~/.nvm/versions/node/<version>/bin` and `~/.local/go/bin`.
- Checks before a PR: `npx tsc --noEmit` (16 pre-existing errors at the time of writing; compare against `origin/main`, don't assume), `npx vitest run`, `go vet` on touched packages. Prettier: never `--write` a whole upstream file, only format your own lines.
- Builds modify `package-lock.json`. `git checkout -- package-lock.json` before switching branches.
- Don't interrupt `npm ci`; it leaves `node_modules` broken.
- Worktree-isolated sessions reject `npm version`, heredocs containing "git", and complex compound commands. Edit `package.json` / `package-lock.json` directly, and put multi-step shell in a script file under `$CLAUDE_JOB_DIR/tmp` (not `/tmp`).

## Workflow and glossary

- One feature per branch from `main`. Avoid stacking; when a PR must stack, say so, give the merge order and known conflicts in the PR body. On conflicts between features, keep both sides and regenerate codegen output.
- **"test build [beta N] with everything"**: local `test/<next-patch>-beta.N` branch from `main` plus every open feature PR branch, version bumped, `--windows-only` build, leak-scan the installer, copy the `.exe` to `~/wave-test-builds`, and give the user the scp command. Never push a test branch or publish it.
- **"release"**: only on request, with `--publish`, after the upstream review and a changelog.
- **Bug reports** ("X doesn't work"): before diagnosing, establish which build the user is on, which host, and whether that host is wsh or plain SSH.
- **Vault notes** (`Notes/waveterm.md` in the Obsidian vault) must stay current. Worktree-isolated sessions cannot run git in the vault; finish by telling the user to run `! vault-note-pr Notes/waveterm.md -m "<message>"`.
