#!/bin/sh
# Tests for main-target.sh against a throwaway repository with one linked worktree.
# Run by `mise run test:scripts`.
set -u
unset CARGO_TARGET_DIR

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM

# Keep the user's git config (hooks, signing) out of the fixture.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
mkdir -p "$tmp/main/src-tauri"
touch "$tmp/main/src-tauri/Cargo.toml"
git -C "$tmp/main" init -q
git -C "$tmp/main" add .
git -C "$tmp/main" commit -q -m init
git -C "$tmp/main" worktree add -q "$tmp/main/.worktrees/wt" -b wt
main=$(cd "$tmp/main" && pwd -P) # git reports resolved paths (/private/var/... on macOS)

fails=0
check() { # check <name> <command...>
  name=$1; shift
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; fails=$((fails + 1)); fi
}
target_in() { # target_in <dir>: the CARGO_TARGET_DIR a command run there sees
  (cd "$1" && "$here/main-target.sh" sh -c 'printf %s "${CARGO_TARGET_DIR-unset}"')
}

check "worktree: target is the main checkout's" \
  [ "$(target_in "$tmp/main/.worktrees/wt/src-tauri")" = "$main/src-tauri/target" ]
check "main checkout: its own target, as cargo's default" \
  [ "$(target_in "$tmp/main/src-tauri")" = "$main/src-tauri/target" ]
check "worktree: a target dir already set is kept" \
  [ "$(CARGO_TARGET_DIR=/elsewhere target_in "$tmp/main/.worktrees/wt/src-tauri")" = /elsewhere ]
mkdir "$tmp/plain"
check "outside git: the command runs with no target dir set" [ "$(target_in "$tmp/plain")" = unset ]

# A failing clippy or test run has to fail the gate, with its arguments intact.
out=$(cd "$tmp/main/.worktrees/wt" && "$here/main-target.sh" sh -c 'printf "%s|" "$@"; exit 3' sh "a b" -- -D); rc=$?
check "passes the command's exit code" [ "$rc" -eq 3 ]
check "passes arguments unsplit" [ "$out" = "a b|--|-D|" ]

[ "$fails" -eq 0 ] || { echo "$fails failed"; exit 1; }
echo "all passed"
