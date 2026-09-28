#!/bin/bash
# Summarize what upstream (wavetermdev/waveterm) has that this fork doesn't, and flag the changes that
# touch areas the fork customized, so they get reviewed before a sync. Read-only: it fetches upstream
# and prints a report; merging is a separate, deliberate step (sync branch + PR).
#
# Usage:
#   scripts/upstream-review.sh           # compare against HEAD
#   scripts/upstream-review.sh <ref>     # compare against another ref (e.g. origin/main)
#   scripts/upstream-review.sh --diff    # also print the full upstream diff at the end
#
# Remote/branch: UPSTREAM_REMOTE (default "upstream"), UPSTREAM_BRANCH (default "main").

set -euo pipefail
# comm needs sort's byte order
export LC_ALL=C

UPSTREAM_REMOTE=${UPSTREAM_REMOTE:-upstream}
UPSTREAM_BRANCH=${UPSTREAM_BRANCH:-main}
BASE=HEAD
SHOW_DIFF=0
for arg in "$@"; do
    case "$arg" in
        --diff) SHOW_DIFF=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        -*) echo "unknown argument: $arg" >&2; exit 2 ;;
        *) BASE=$arg ;;
    esac
done

cd "$(dirname "$0")/.."

git fetch --quiet --no-tags "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
UP=$(git rev-parse FETCH_HEAD)
MB=$(git merge-base "$BASE" "$UP")
COUNT=$(git rev-list --count "$BASE..$UP")
if [ "$COUNT" = 0 ]; then
    echo "up to date with $UPSTREAM_REMOTE/$UPSTREAM_BRANCH (${UP:0:8})"
    exit 0
fi

FLAGS=0
flag() {
    FLAGS=$((FLAGS + 1))
    echo
    echo "!! $1"
}

echo "== $COUNT upstream commit(s) not in $BASE ($UPSTREAM_REMOTE/$UPSTREAM_BRANCH ${UP:0:8}, last common ${MB:0:8})"
git log --oneline --no-decorate --no-merges "$BASE..$UP"

echo
echo "== files changed upstream since the last common commit"
git diff --stat=120 --stat-graph-width=20 "$MB" "$UP" | tail -n 60

echo
echo "== review flags"

# new upstream workflow files start active on the fork; only CodeQL is meant to run
WF=$(git diff --name-status "$MB" "$UP" -- .github/workflows || true)
if [ -n "$WF" ]; then
    flag "workflow files changed upstream (a NEW workflow starts active on GitHub: disable it after the sync; only CodeQL runs):"
    echo "$WF" | sed 's/^/   /'
fi

# go.mod's go directive drives the Go version CodeQL must install
UP_GO=$(git show "$UP:go.mod" | awk '/^go /{print $2; exit}')
BASE_GO=$(git show "$BASE:go.mod" | awk '/^go /{print $2; exit}')
CODEQL_GO=$(git show "$BASE:.github/workflows/codeql.yml" 2>/dev/null | sed -n 's/^ *GO_VERSION: *"\{0,1\}\([0-9.]*\)"\{0,1\}.*/\1/p' | head -n 1)
if [ "$UP_GO" != "$BASE_GO" ]; then
    flag "go.mod Go version changes $BASE_GO -> $UP_GO: check GO_VERSION in .github/workflows/codeql.yml (now ${CODEQL_GO:-unset}) and the local toolchain"
fi

# the fork removed telemetry reporting, ?ref= link tags and Wave-cloud defaults
PHONE=$(git diff -U0 "$MB" "$UP" -- . ':!*.lock' ':!package-lock.json' ':!go.sum' ':!docs/**' \
    | grep -E '^\+[^+]' \
    | grep -Ei 'waveterm\.dev|api\.waveterm|telemetry|posthog|sentry|analytics|segment\.io|mixpanel|\?ref=|sendtelemetry|recordtevent' || true)
if [ -n "$PHONE" ]; then
    flag "added lines mention telemetry / Wave's servers / tracking (the fork strips these; check each):"
    echo "$PHONE" | head -n 40 | cut -c1-160 | sed 's/^/   /'
fi

check_paths() {
    local msg=$1
    shift
    local files
    files=$(git diff --name-only "$MB" "$UP" -- "$@" || true)
    if [ -n "$files" ]; then
        flag "$msg"
        echo "$files" | sed 's/^/   /'
    fi
}
check_paths "updater / packaging changed (the fork uses its own feed, app ID and branding):" \
    emain/updater.ts electron-builder.config.cjs package.json LICENSE NOTICE
check_paths "connection / wsh code changed (the fork runs SSH hosts without wsh: re-test no-wsh connect, tmux, SFTP):" \
    pkg/remote pkg/shellexec pkg/wshutil pkg/blockcontroller cmd/wsh pkg/util/shellutil
check_paths "AI / cloud code changed (the fork gates Wave AI and cloud features off by default):" \
    pkg/aiusechat pkg/waveai pkg/wcloud pkg/telemetry frontend/app/aipanel

PKG=$(git diff -U0 "$MB" "$UP" -- package.json | grep -E '^\+\s*"(pre|post)?(install|prepare|build|dev|start)[^"]*"\s*:' || true)
if [ -n "$PKG" ]; then
    flag "package.json scripts changed (install/build hooks run on this machine):"
    echo "$PKG" | sed 's/^/   /'
fi

# files both sides changed: where the merge can conflict or silently undo fork behavior
FORK_FILES=$(git diff --name-only "$MB" "$BASE" | sort)
UP_FILES=$(git diff --name-only "$MB" "$UP" | sort)
BOTH=$(comm -12 <(echo "$FORK_FILES") <(echo "$UP_FILES") | grep -v -E '^(package-lock\.json|go\.sum)$' || true)
if [ -n "$BOTH" ]; then
    flag "changed by both upstream and the fork (conflict risk, or upstream may undo a fork change):"
    echo "$BOTH" | sed 's/^/   /'
fi

echo
if [ "$FLAGS" = 0 ]; then
    echo "== no review flags; still read the commit list above before syncing"
else
    echo "== $FLAGS review flag(s) above"
fi

if [ "$SHOW_DIFF" = 1 ]; then
    echo
    echo "== full upstream diff"
    git diff "$MB" "$UP"
fi
