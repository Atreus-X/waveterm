#!/bin/bash
# Local checks for the Atreus fork (there is no CI beyond CodeQL). Exits non-zero if any check fails.
# atreus-release-local.sh runs this before building, so test builds and releases are both gated on it.
#
# Usage:
#   scripts/atreus-check.sh                   # everything (privacy, tsc, vitest, go, codegen drift)
#   scripts/atreus-check.sh --fast            # privacy, vitest, go only (~30s); skips tsc and codegen
#   scripts/atreus-check.sh --update-baseline # rewrite scripts/tsc-baseline.txt from the current tsc output
#
# tsc has pre-existing errors, so it fails only on errors that are not in scripts/tsc-baseline.txt
# (compared without line numbers, so unrelated edits don't shift them). Go checks run on the packages
# touched since origin/main. The codegen check runs `task generate` and fails if it changes anything,
# so the working tree must be clean when it starts.

set -uo pipefail

FAST=0
UPDATE_BASELINE=0
BASE_REF=${CHECK_BASE_REF:-origin/main}
for arg in "$@"; do
    case "$arg" in
        --fast) FAST=1 ;;
        --update-baseline) UPDATE_BASELINE=1 ;;
        -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
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

BASELINE=scripts/tsc-baseline.txt
LOGDIR=$(mktemp -d)
trap 'rm -rf "$LOGDIR"' EXIT
FAILED=0

# tsc errors without line/column, one per line, sorted; repeats are kept so a new copy of an
# existing error still counts as new
tsc_errors() {
    node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep 'error TS' | sed -E 's/\([0-9]+,[0-9]+\)//' | sort
}

run() {
    local name=$1
    shift
    local start=$SECONDS
    if "$@" >"$LOGDIR/$name.log" 2>&1; then
        echo "ok    $name ($((SECONDS - start))s)"
        return
    fi
    FAILED=1
    echo "FAIL  $name ($((SECONDS - start))s)"
    tail -n 25 "$LOGDIR/$name.log" | sed 's/^/      /'
}

if [ "$UPDATE_BASELINE" = 1 ]; then
    tsc_errors >"$BASELINE"
    echo "wrote $(wc -l <"$BASELINE") error(s) to $BASELINE"
    exit 0
fi

check_privacy() {
    command -v privacy-scan >/dev/null || { echo "privacy-scan not installed; skipped"; return 0; }
    git diff "$BASE_REF"...HEAD | privacy-scan --text - || return 1
    git log --format=%B "$BASE_REF"..HEAD | privacy-scan --text -
}

check_tsc() {
    [ -f "$BASELINE" ] || { echo "$BASELINE missing; run scripts/atreus-check.sh --update-baseline on main"; return 1; }
    local new
    new=$(tsc_errors | comm -13 "$BASELINE" -)
    [ -z "$new" ] && return 0
    echo "new tsc errors (not in $BASELINE):"
    echo "$new"
    return 1
}

check_vitest() {
    node node_modules/vitest/vitest.mjs run
}

go_pkgs() {
    git diff --name-only "$BASE_REF"...HEAD -- '*.go' | xargs -r -n1 dirname | sort -u | while read -r d; do
        [ -d "$d" ] && echo "./$d"
    done
}

check_go() {
    local pkgs
    pkgs=$(go_pkgs)
    [ -z "$pkgs" ] && { echo "no Go changes"; return 0; }
    # shellcheck disable=SC2086
    go vet $pkgs && go test $pkgs
}

check_codegen() {
    [ -z "$(git status --porcelain)" ] || { echo "working tree must be clean for the codegen check"; return 1; }
    task generate || return 1
    [ -z "$(git status --porcelain)" ] && return 0
    echo "task generate changed files (commit the regenerated output):"
    git status --porcelain
    return 1
}

run privacy check_privacy
run vitest check_vitest
run go check_go
if [ "$FAST" = 0 ]; then
    run tsc check_tsc
    run codegen check_codegen
fi

if [ "$FAILED" = 1 ]; then
    echo "checks failed"
    exit 1
fi
echo "all checks passed"
