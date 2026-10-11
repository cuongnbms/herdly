#!/usr/bin/env bash
# Prints the release notes for a tag: the feat, fix and perf commits since the
# previous v* tag, grouped by type, followed by the install instructions.
#   .github/scripts/release-notes.sh v0.1.1
set -euo pipefail

tag=${1:?usage: release-notes.sh <tag>}
repo=${GITHUB_REPOSITORY:-cuongnbms/herdly}
prev=$(git describe --tags --abbrev=0 --match 'v*' "${tag}^" 2>/dev/null || true)
range=${prev:+${prev}..}${tag}

# "fix(chat): keep pasted images" -> "- **chat:** keep pasted images"
section() {
  local title=$1 type=$2 lines
  lines=$(git log --no-merges --format=%s "$range" |
    sed -nE "s/^${type}(\(([^)]*)\))?!?: (.*)$/- **\2:** \3/p" |
    sed 's/^- \*\*:\*\* /- /')
  [ -n "$lines" ] && printf '### %s\n%s\n\n' "$title" "$lines"
  return 0
}

echo "## What's changed"
echo
section Features feat
section Fixes fix
section Performance perf
if [ -n "$prev" ]; then
  echo "**Full changelog:** https://github.com/${repo}/compare/${prev}...${tag}"
  echo
fi
cat <<'EOF'
## Install

Download `Herdly_*_universal.dmg`, open it and drag Herdly into Applications.

This build is not notarized by Apple. Before the first launch, run:

```sh
xattr -dr com.apple.quarantine /Applications/Herdly.app
```
EOF
