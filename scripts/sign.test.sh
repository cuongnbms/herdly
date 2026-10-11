#!/bin/sh
# Tests for sign-setup.sh and sign-app.sh against a throwaway keychain and a tiny bundle,
# never the login keychain or /Applications. Run by `mise run test:sign`.
set -u
[ "$(uname)" = Darwin ] || { echo "sign tests: macOS only, skipped"; exit 0; }

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
export HERDR_SIGN_KEYCHAIN="$tmp/test.keychain-db"
export HERDR_SIGN_KEYCHAIN_PASSWORD=test
export HERDR_SIGN_IDENTITY="Herdr Sign Test $$"
# codesign only finds an identity in a keychain on the user search list (`--keychain` alone
# is not enough), so the throwaway keychain joins it for the run and the list is put back.
search=$(security list-keychains -d user) # quoted paths, one per line
cleanup() {
  eval "security list-keychains -d user -s $search"
  security delete-keychain "$HERDR_SIGN_KEYCHAIN" >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
security create-keychain -p test "$HERDR_SIGN_KEYCHAIN" || exit 1
security unlock-keychain -p test "$HERDR_SIGN_KEYCHAIN" || exit 1
eval "security list-keychains -d user -s $search \"\$HERDR_SIGN_KEYCHAIN\"" || exit 1

fails=0
check() { # check <name> <command...>
  name=$1; shift
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; fails=$((fails + 1)); fi
}

bundle() { # bundle [binary]: a minimal app bundle with a real Mach-O to sign
  rm -rf "$tmp/Test.app"
  mkdir -p "$tmp/Test.app/Contents/MacOS"
  cp "${1:-/usr/bin/true}" "$tmp/Test.app/Contents/MacOS/test"
  cat >"$tmp/Test.app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.cuongnb.herdrapp.signtest</string>
<key>CFBundleExecutable</key><string>test</string>
</dict></plist>
EOF
  codesign --force -s - "$tmp/Test.app" 2>/dev/null
}
requirement() { codesign -d -r- "$tmp/Test.app" 2>&1 | sed -n 's/^#* *designated => //p'; } # ad-hoc output starts with '# '

has() { printf %s "$1" | grep -q -- "$2"; }

# Without the identity: the bundle keeps its ad-hoc signature and the install still succeeds.
bundle
out=$("$here/sign-app.sh" "$tmp/Test.app" 2>&1); rc=$?
check "no identity: exit 0" [ "$rc" -eq 0 ]
check "no identity: warns and names sign:setup" has "$out" "mise run sign:setup"
check "no identity: stays ad-hoc" has "$(requirement)" cdhash

# Setup creates the identity once; a second run leaves it alone.
"$here/sign-setup.sh" >"$tmp/setup1.log" 2>&1; rc=$?
check "setup: exit 0" [ "$rc" -eq 0 ]
check "setup: identity in keychain" sh -c 'security find-identity -p codesigning "$HERDR_SIGN_KEYCHAIN" | grep -q "\"$HERDR_SIGN_IDENTITY\""'
"$here/sign-setup.sh" >"$tmp/setup2.log" 2>&1; rc=$?
check "setup again: exit 0" [ "$rc" -eq 0 ]
check "setup again: still one identity" [ "$(security find-identity -p codesigning "$HERDR_SIGN_KEYCHAIN" | grep -c "\"$HERDR_SIGN_IDENTITY\"")" -eq 1 ]

# With the identity: the requirement names the certificate, not the build's hash, and two
# builds with different content get the same requirement (what TCC grants are keyed on).
bundle
"$here/sign-app.sh" "$tmp/Test.app" >"$tmp/sign1.log" 2>&1; rc=$?
first=$(requirement)
check "sign: exit 0" [ "$rc" -eq 0 ]
check "sign: requirement is the certificate" has "$first" "certificate leaf"
check "sign: verifies strictly" codesign --verify --deep --strict "$tmp/Test.app"
check "sign: hardened runtime" has "$(codesign -dv "$tmp/Test.app" 2>&1)" "flags=.*runtime"
bundle /usr/bin/false # a different executable, so an ad-hoc cdhash would change
"$here/sign-app.sh" "$tmp/Test.app" >"$tmp/sign2.log" 2>&1
check "sign: next build keeps the requirement" [ "$(requirement)" = "$first" ]

[ "$fails" -eq 0 ] && echo "sign tests: all passed" || echo "sign tests: $fails failed"
[ "$fails" -eq 0 ]
