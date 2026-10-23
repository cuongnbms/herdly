#!/bin/sh
# main-target.sh <command...>: run a cargo command with the main checkout's target dir, so a
# fresh worktree under .worktrees/ reuses the dependencies main already built instead of
# compiling them all again. Cargo keys artifacts by crate, version and flags, so sharing is
# safe; two checkouts running cargo at once wait on its lock.
set -eu
if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  # The first worktree git lists is the main checkout. Outside git, cargo keeps its default.
  main=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
  [ -z "$main" ] || export CARGO_TARGET_DIR="$main/src-tauri/target"
fi
exec "$@"
