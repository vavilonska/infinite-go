#!/usr/bin/env bash
# No Gradle/Maven dependencies or automatic signing. Run from any directory.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="$root/android/build"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
platform="${ANDROID_PLATFORM:-36}"
version="${ANDROID_BUILD_TOOLS:-36.0.0}"
if [[ -z "$sdk" ]]; then echo 'Set ANDROID_HOME to your installed Android SDK.' >&2; exit 1; fi
tools="$sdk/build-tools/$version"
jar="$sdk/platforms/android-$platform/android.jar"
for command in node javac java jar zip; do
  command -v "$command" >/dev/null || { echo "Missing required tool: $command" >&2; exit 1; }
done
for command in aapt2 d8 zipalign; do
  [[ -x "$tools/$command" ]] || { echo "Missing $tools/$command; install build-tools;$version" >&2; exit 1; }
done
[[ -f "$jar" ]] || { echo "Missing $jar; install platforms;android-$platform" >&2; exit 1; }
# This directory is generated, ignored, and never contains source or signing keys.
rm -rf "$build"
mkdir -p "$build"/{assets/web,res/drawable,generated,classes,dex,test}
node "$root/scripts/build-static.mjs" "$build/assets/web"
# APK assets are already offline. Do not install a second service-worker cache
# whose network interception differs between Android WebView versions.
rm -f "$build/assets/web/sw.js"
cp -R "$root/android/res/." "$build/res/"
cp "$root/assets/icon.png" "$build/res/drawable/icon.png"
# Framework-independent address security regression tests.
javac -encoding UTF-8 --release 8 -d "$build/test" \
  "$root/android/src/org/infinitego/app/HostAddress.java" "$root/android/test/HostAddressTest.java"
java -cp "$build/test" org.infinitego.app.HostAddressTest
"$tools/aapt2" compile --dir "$build/res" -o "$build/resources.zip"
"$tools/aapt2" link -o "$build/resources.apk" -I "$jar" \
  --manifest "$root/android/AndroidManifest.xml" --java "$build/generated" \
  -A "$build/assets" "$build/resources.zip"
find "$root/android/src" "$build/generated" -name '*.java' -print > "$build/sources.txt"
# Keep the JDK Java 8 bootstrap APIs (including LambdaMetafactory); Android
# stubs belong on the classpath. D8 below desugars lambdas for Android.
javac -encoding UTF-8 --release 8 -classpath "$jar" \
  -d "$build/classes" @"$build/sources.txt"
jar cf "$build/classes.jar" -C "$build/classes" .
"$tools/d8" --release --min-api 26 --lib "$jar" --output "$build/dex" "$build/classes.jar"
cp "$build/resources.apk" "$build/unaligned.apk"
(cd "$build/dex" && zip -q "$build/unaligned.apk" classes*.dex)
"$tools/zipalign" -f -p 4 "$build/unaligned.apk" "$build/infinite-go-unsigned.apk"
"$tools/zipalign" -c 4 "$build/infinite-go-unsigned.apk"
(cd "$build" && sha256sum infinite-go-unsigned.apk > infinite-go-unsigned.apk.sha256)
echo "Built $build/infinite-go-unsigned.apk (unsigned; not installable until signed)."
