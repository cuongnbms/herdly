#!/bin/sh
# sign-app.sh <bundle>: re-sign an installed bundle with the identity from sign-setup.sh, so
# macOS privacy grants survive the next install. Without the identity the bundle keeps its
# ad-hoc signature: the install still works, it just asks for permissions again.
# Same env as sign-setup.sh (HERDR_SIGN_IDENTITY, HERDR_SIGN_KEYCHAIN).
set -eu
app=$1
identity=${HERDR_SIGN_IDENTITY:-Herdr Local Signing}
keychain=${HERDR_SIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}

if ! security find-identity -p codesigning "$keychain" | grep -qF "\"$identity\""; then
  echo "sign: no \"$identity\" identity, $app stays ad-hoc and macOS will ask for its permissions again." >&2
  echo "sign: run \`mise run sign:setup\` once to keep them across installs." >&2
  exit 0
fi
# -o runtime keeps the hardened runtime the Tauri bundle was built with.
codesign --force --deep -o runtime --keychain "$keychain" -s "$identity" "$app"
codesign --verify --deep --strict "$app"
echo "sign: $app signed with \"$identity\""
