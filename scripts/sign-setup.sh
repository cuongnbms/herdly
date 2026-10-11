#!/bin/sh
# One-time: create the self-signed code signing identity `app:install` signs Herdr.app with.
# An ad-hoc signature's designated requirement is the build's cdhash, so every install looks
# like a new app to macOS privacy (TCC) and it asks again for every permission (network
# volumes, Desktop, ...). Signed with one certificate, the requirement is
# `identifier "dev.cuongnb.herdrapp" and certificate leaf = H"..."`, the same on every build.
# The certificate needs no trust setting: codesign signs with it and TCC matches its hash.
#
# Env (tests point these at a throwaway keychain):
#   HERDR_SIGN_IDENTITY           common name (default "Herdr Local Signing")
#   HERDR_SIGN_KEYCHAIN           keychain (default the login keychain)
#   HERDR_SIGN_KEYCHAIN_PASSWORD  when set, lets codesign use the key without a prompt;
#                                 otherwise macOS asks once on the first signing: "Always Allow"
set -eu
identity=${HERDR_SIGN_IDENTITY:-Herdr Local Signing}
keychain=${HERDR_SIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}

if security find-identity -p codesigning "$keychain" | grep -qF "\"$identity\""; then
  echo "sign:setup: \"$identity\" is already in $keychain"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat >"$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $identity
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/cert.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
# OpenSSL 3+ defaults to a PKCS#12 cipher `security import` cannot read; -legacy picks the old
# one. LibreSSL (/usr/bin/openssl) has no -legacy and already writes the old format.
p12() { openssl pkcs12 -export "$@" -inkey "$work/key.pem" -in "$work/cert.pem" \
  -name "$identity" -passout pass:herdr -out "$work/id.p12" 2>/dev/null; }
p12 -legacy || p12
security import "$work/id.p12" -k "$keychain" -P herdr -T /usr/bin/codesign >/dev/null
if [ -n "${HERDR_SIGN_KEYCHAIN_PASSWORD:-}" ]; then
  security set-key-partition-list -S apple-tool:,apple: -s -k "$HERDR_SIGN_KEYCHAIN_PASSWORD" \
    "$keychain" >/dev/null
fi
echo "sign:setup: created \"$identity\" in $keychain"
