#!/usr/bin/env bash
# Optional release signing with an EXISTING, user-managed key. Never generates a key.
# Intended for a trusted GitHub Actions release job, not pull-request workflows.
set -euo pipefail
umask 077
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="$root/android/build"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
version="${ANDROID_BUILD_TOOLS:-36.0.0}"
for name in ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  [[ -n "${!name:-}" ]] || { echo "Missing required signing secret: $name" >&2; exit 1; }
done
[[ -f "$build/infinite-go-unsigned.apk" ]] || { echo 'Run bash android/build.sh first.' >&2; exit 1; }
[[ -n "$sdk" && -x "$sdk/build-tools/$version/apksigner" ]] || { echo 'Android apksigner is unavailable.' >&2; exit 1; }
keydir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/infinite-go-sign.XXXXXX")"
trap 'rm -rf "$keydir"' EXIT
# Never echo the secret or put passwords on command lines. No key enters the artifact directory.
printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$keydir/release.jks"
"$sdk/build-tools/$version/apksigner" sign \
  --ks "$keydir/release.jks" --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
  --out "$build/infinite-go.apk" "$build/infinite-go-unsigned.apk"
"$sdk/build-tools/$version/apksigner" verify --verbose "$build/infinite-go.apk"
(cd "$build" && sha256sum infinite-go.apk > infinite-go.apk.sha256)
echo "Signed and verified $build/infinite-go.apk with the supplied key."
