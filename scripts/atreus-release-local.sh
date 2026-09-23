#!/bin/bash
# Build (and optionally publish) an Atreus fork release locally on Linux. This is the only release
# path — the fork doesn't build on GitHub Actions. Produces Linux AppImage + deb and a cross-built
# Windows x64 NSIS installer, plus the electron-updater feed files.
#
# Usage:
#   scripts/atreus-release-local.sh              # build only, artifacts in make/
#   scripts/atreus-release-local.sh --publish    # build, then publish to the update feed + GitHub release
#
# The version comes from package.json (bump it with `npm version X.Y.Z --no-git-tag-version`, commit,
# push). Release notes come from the "### vX.Y.Z" section of docs/docs/releasenotes.mdx.
#
# Toolchain (user-local is fine): Go 1.25+, Node 22 (nvm), Zig, Task, zip, mksquashfs, and wine
# (electron-builder calls `wine`; a `wine` -> wine64 symlink works) for the Windows installer.
#
# Publishing settings live in a private env file outside the repo (default
# ~/.config/atreus-release.env, override with ATREUS_RELEASE_CONFIG), so server details never
# land in this public repo:
#   FEED_DIR=/path/to/feed/dir        # used when it exists and is writable (building on the server)
#   SFTP_HOST=... SFTP_PORT=... SFTP_USER=... SFTP_REMOTE_PATH=... SFTP_KEY=...   # otherwise
# The GitHub release is created with `gh`.

set -euo pipefail

CONFIG=${ATREUS_RELEASE_CONFIG:-$HOME/.config/atreus-release.env}
if [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG"
fi
FEED_URL=${FEED_URL:-https://www.atreusproject.com/updater/waveterm}
GH_REPO=${GH_REPO:-Atreus-X/waveterm}

PUBLISH=0
for arg in "$@"; do
    case "$arg" in
        --publish) PUBLISH=1 ;;
        -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

cd "$(dirname "$0")/.."

if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
    . "$NVM_DIR/nvm.sh"
    nvm use 22 >/dev/null
fi
export PATH="$HOME/.local/bin:$HOME/.local/go/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=4096

need() { command -v "$1" >/dev/null || { echo "missing required tool: $1" >&2; exit 1; }; }
for t in node npm go zig task zip mksquashfs wine gh; do need "$t"; done
[[ "$(node -v)" == v22.* ]] || { echo "Node 22 required, found $(node -v)" >&2; exit 1; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "working tree has uncommitted changes; commit or stash first" >&2
    exit 1
fi
SHA=$(git rev-parse HEAD)
if [ "$PUBLISH" = 1 ] && ! git branch -r --contains "$SHA" | grep -q .; then
    echo "HEAD $SHA is not on any remote branch; push it first (the release tag points at it)" >&2
    exit 1
fi

VERSION=$(node -p 'require("./package.json").version')
TAG="atreus-v$VERSION"
if [ "$PUBLISH" = 1 ] && [ ! -w "${FEED_DIR:-/nonexistent}" ]; then
    for v in SFTP_HOST SFTP_PORT SFTP_USER SFTP_REMOTE_PATH SFTP_KEY; do
        [ -n "${!v:-}" ] || { echo "publishing needs FEED_DIR or $v (set it in $CONFIG)" >&2; exit 1; }
    done
fi
if [ "$PUBLISH" = 1 ] && gh release view "$TAG" --repo "$GH_REPO" >/dev/null 2>&1; then
    echo "release $TAG already exists on $GH_REPO; bump the version or delete it first" >&2
    exit 1
fi
echo "== building $TAG from $SHA ($(node -v), $(go version | cut -d' ' -f3), zig $(zig version))"
start=$(date +%s)

echo "== npm ci"
rm -rf node_modules
npm ci --no-audit --no-fund

echo "== linux: task package (AppImage, deb)"
WAVE_LINUX_TARGETS=AppImage,deb task package

# task package only builds wavesrv for the host OS; cross-compile the Windows one (as the
# Windows CI job does, with zig as the C compiler for sqlite's cgo)
echo "== windows: cross-compile wavesrv.x64.exe"
CGO_ENABLED=1 GOOS=windows GOARCH=amd64 CC="zig cc -target x86_64-windows-gnu" \
    go build -tags "osusergo,sqlite_omit_load_extension" \
    -ldflags "-X main.BuildTime=$(date +'%Y%m%d%H%M') -X main.WaveVersion=$VERSION" \
    -o dist/bin/wavesrv.x64.exe cmd/server/main-server.go
rm -f dist/bin/wavesrv.x64

echo "== windows: electron-builder (nsis x64)"
WAVE_WIN_TARGETS=nsis npm exec electron-builder -- -c electron-builder.config.cjs -p never --win --x64

INSTALLERS=(make/*.AppImage make/*.deb make/*.exe)
BLOCKMAPS=(make/*.blockmap)
FEEDFILES=(make/latest.yml make/latest-linux.yml)
for f in "${INSTALLERS[@]}" "${FEEDFILES[@]}"; do
    [ -f "$f" ] || { echo "expected artifact missing: $f" >&2; exit 1; }
done
echo "== built in $(( $(date +%s) - start ))s"
ls -la "${INSTALLERS[@]}" "${BLOCKMAPS[@]}" "${FEEDFILES[@]}"

if [ "$PUBLISH" = 0 ]; then
    echo "build only; rerun with --publish to release $TAG"
    exit 0
fi

# installers first, feed files last, so clients never see a feed pointing at a missing file
echo "== publishing to update feed"
if [ -n "${FEED_DIR:-}" ] && [ -d "$FEED_DIR" ] && [ -w "$FEED_DIR" ]; then
    cp "${INSTALLERS[@]}" "${BLOCKMAPS[@]}" "$FEED_DIR/"
    cp "${FEEDFILES[@]}" "$FEED_DIR/"
else
    batch=$(mktemp)
    trap 'rm -f "$batch"' EXIT
    {
        echo "-mkdir $SFTP_REMOTE_PATH"
        for f in "${INSTALLERS[@]}" "${BLOCKMAPS[@]}" "${FEEDFILES[@]}"; do
            echo "put \"$f\" \"$SFTP_REMOTE_PATH/$(basename "$f")\""
        done
    } > "$batch"
    sftp -P "$SFTP_PORT" -i "$SFTP_KEY" -b "$batch" "$SFTP_USER@$SFTP_HOST"
fi
curl -fsS "$FEED_URL/latest-linux.yml" | grep -q "^version: $VERSION$" || { echo "feed check failed: $FEED_URL/latest-linux.yml is not $VERSION" >&2; exit 1; }

echo "== GitHub release $TAG"
notes=$(mktemp)
awk -v hdr="### v$VERSION " 'index($0, hdr) == 1 {f=1; next} f && /^### v/ {exit} f' docs/docs/releasenotes.mdx > "$notes"
if [ -s "$notes" ]; then notes_args=(--notes-file "$notes"); else notes_args=(--generate-notes); fi
# push the tag with git first: the releases API can 404 when asked to create a tag on an older
# commit by SHA (seen right after pushing rewritten history), while a git-pushed tag always works
if ! git ls-remote --exit-code --tags "git@github.com:$GH_REPO.git" "refs/tags/$TAG" >/dev/null; then
    git push "git@github.com:$GH_REPO.git" "$SHA:refs/tags/$TAG"
fi
gh release create "$TAG" --repo "$GH_REPO" --verify-tag \
    --title "Wave Terminal (Atreus) v$VERSION" "${notes_args[@]}" "${INSTALLERS[@]}"
rm -f "$notes"
echo "== released $TAG"
