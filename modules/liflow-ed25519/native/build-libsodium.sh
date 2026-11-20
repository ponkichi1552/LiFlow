#!/usr/bin/env bash
set -euo pipefail
umask 022

module_dir=$(cd "$(dirname "$0")/.." && pwd -P)
build_root=${BUILD_ROOT:-/Volumes/LiFlowValidation/liflow-ed25519-build}
source_archive="$module_dir/vendor/libsodium-1.0.22.tar.gz"
expected_sha256=adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349
actual_sha256=$(shasum -a 256 "$source_archive" | awk '{print $1}')
[[ "$actual_sha256" == "$expected_sha256" ]] || {
  echo "libsodium 1.0.22 source archive SHA-256 mismatch" >&2
  exit 1
}

mode=${1:-all}
ndk=${ANDROID_NDK_HOME:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk/27.1.12297006}
host_tag=darwin-x86_64
toolchain="$ndk/toolchains/llvm/prebuilt/$host_tag"

if [[ "$mode" == "all" || "$mode" == ios-device || "$mode" == ios-simulator ||
      "$mode" == ios-device-slice || "$mode" == ios-simulator-slices ||
      "$mode" == ios-device-publish || "$mode" == ios-assemble || "$mode" == ios-publish ]]; then
  command -v xcrun >/dev/null
fi
if [[ "$mode" == "all" || "$mode" == android ]]; then
  [[ -x "$toolchain/bin/llvm-ar" ]] || {
    echo "Android NDK r27b not found at $toolchain (set ANDROID_NDK_HOME)" >&2
    exit 1
  }
fi

require_strict_build_flags() {
  local makefile=$1
  grep -q -- '-UED25519_COMPAT' "$makefile" || {
    echo "libsodium build is missing the strict Ed25519 compatibility guard" >&2
    exit 1
  }
  if grep -Eq -- '(^|[[:space:]])-D[[:space:]]*ED25519_COMPAT([=[:space:]]|$)' "$makefile"; then
    echo "Refusing to build libsodium with ED25519_COMPAT enabled" >&2
    exit 1
  fi
}

mkdir -p "$build_root"
build_target() {
  local target=$1 host=$2 cc=$3 sdk_name=$4 arch=$5 min_flag=$6
  local target_root="$build_root/$target"
  local source_root="$target_root/source"
  local work_root="$target_root/work"
  local prefix="$target_root/install"
  local sdk sysroot flags

  rm -rf "$source_root" "$work_root" "$prefix"
  mkdir -p "$source_root" "$work_root"
  tar -xzf "$source_archive" -C "$source_root" --strip-components=1
  sdk=$(xcrun --sdk "$sdk_name" --show-sdk-path)
  sysroot="$sdk"
  flags="-O3 -fPIC -ffunction-sections -fdata-sections -UED25519_COMPAT -arch $arch -isysroot $sysroot $min_flag"

  (
    cd "$work_root"
    CC="$cc" \
    AR="$(xcrun --sdk "$sdk_name" -f ar)" \
    RANLIB="$(xcrun --sdk "$sdk_name" -f ranlib)" \
    CFLAGS="$flags" \
    LDFLAGS="-arch $arch -isysroot $sysroot $min_flag" \
      "$source_root/configure" \
        --build="$("$source_root/build-aux/config.guess")" \
        --host="$host" \
        --disable-shared \
        --enable-static \
        --enable-minimal \
        --disable-dependency-tracking \
        --prefix="$prefix"
    require_strict_build_flags Makefile
    make -j4
    make install
  ) > "$target_root/build.log" 2>&1
}

build_android_target() {
  local abi=$1 host=$2 cc=$3 target=$4
  local target_root="$build_root/android-$abi"
  local source_root="$target_root/source"
  local work_root="$target_root/work"
  local prefix="$target_root/install"
  local flags="-O3 -fPIC -ffunction-sections -fdata-sections -UED25519_COMPAT"

  rm -rf "$source_root" "$work_root" "$prefix"
  mkdir -p "$source_root" "$work_root"
  tar -xzf "$source_archive" -C "$source_root" --strip-components=1
  (
    cd "$work_root"
    CC="$cc" \
    AR="$toolchain/bin/llvm-ar" \
    RANLIB="$toolchain/bin/llvm-ranlib" \
    STRIP="$toolchain/bin/llvm-strip" \
    CFLAGS="$flags" \
    LDFLAGS="-Wl,-z,max-page-size=16384" \
      "$source_root/configure" \
        --build="$("$source_root/build-aux/config.guess")" \
        --host="$host" \
        --with-sysroot="$toolchain/sysroot" \
        --disable-pie \
        --disable-shared \
        --enable-static \
        --enable-minimal \
        --disable-dependency-tracking \
        --prefix="$prefix"
    require_strict_build_flags Makefile
    make -j4
    make install
  ) > "$target_root/build.log" 2>&1

  local output_dir="$module_dir/android/src/main/jniLibs/$abi"
  mkdir -p "$output_dir"
  "$cc" \
    -shared -fPIC -O3 -ffunction-sections -fdata-sections \
    -I "$module_dir/native" \
    -I "$prefix/include" \
    "$module_dir/android/src/main/cpp/jni_bridge.c" \
    "$module_dir/native/liflow_ed25519.c" \
    "$prefix/lib/libsodium.a" \
    -UED25519_COMPAT \
    -Wl,--gc-sections \
    -Wl,--exclude-libs,ALL \
    -Wl,-z,max-page-size=16384 \
    -ldl -lm \
    -o "$output_dir/libliflow_ed25519.so"
  "$toolchain/bin/llvm-strip" --strip-unneeded "$output_dir/libliflow_ed25519.so"
}

build_apple_device() {
  local cc
  cc=$(xcrun --sdk iphoneos -f clang)
  build_target ios-device-arm64 aarch64-apple-darwin "$cc" iphoneos arm64 -mios-version-min=16.4
  local staging="$build_root/libsodium-device.xcframework"
  rm -rf "$staging"
  xcodebuild -create-xcframework \
    -library "$build_root/ios-device-arm64/install/lib/libsodium.a" \
    -headers "$build_root/ios-device-arm64/install/include" \
    -output "$staging" \
    > "$build_root/ios-xcframework.log" 2>&1
}

build_apple_device_slice() {
  local cc
  cc=$(xcrun --sdk iphoneos -f clang)
  build_target ios-device-arm64 aarch64-apple-darwin "$cc" iphoneos arm64 -mios-version-min=16.4
}

build_apple_simulator_slices() {
  local cc_sim
  local simulator_archive="$build_root/ios-simulator-universal/libsodium.a"
  cc_sim=$(xcrun --sdk iphonesimulator -f clang)
  build_target ios-simulator-arm64 aarch64-apple-darwin "$cc_sim" iphonesimulator arm64 -mios-simulator-version-min=16.4
  build_target ios-simulator-x86_64 x86_64-apple-darwin "$cc_sim" iphonesimulator x86_64 -mios-simulator-version-min=16.4
  mkdir -p "$(dirname "$simulator_archive")"
  lipo -create \
    "$build_root/ios-simulator-arm64/install/lib/libsodium.a" \
    "$build_root/ios-simulator-x86_64/install/lib/libsodium.a" \
    -output "$simulator_archive"
}

assemble_apple_xcframework() {
  local staging="$build_root/libsodium-combined.xcframework"
  rm -rf "$staging"
  xcodebuild -create-xcframework \
    -library "$build_root/ios-device-arm64/install/lib/libsodium.a" \
    -headers "$build_root/ios-device-arm64/install/include" \
    -library "$build_root/ios-simulator-universal/libsodium.a" \
    -headers "$build_root/ios-device-arm64/install/include" \
    -output "$staging" \
    > "$build_root/ios-xcframework.log" 2>&1
}

publish_apple_xcframework() {
  local staging="$build_root/libsodium-combined.xcframework"
  [[ -f "$staging/Info.plist" ]] || {
    echo "Combined Apple XCFramework is not assembled at $staging" >&2
    exit 1
  }
  mkdir -p "$module_dir/ios/include"
  ditto "$build_root/ios-device-arm64/install/include/sodium.h" "$module_dir/ios/include/sodium.h"
  ditto "$build_root/ios-device-arm64/install/include/sodium" "$module_dir/ios/include/sodium"
  rm -rf "$module_dir/vendor/libsodium.xcframework"
  mv "$staging" "$module_dir/vendor/libsodium.xcframework"
}

publish_apple_device() {
  local staging="$build_root/libsodium-device.xcframework"
  [[ -f "$staging/Info.plist" ]] || {
    echo "Device Apple XCFramework is not staged at $staging" >&2
    exit 1
  }
  mkdir -p "$module_dir/ios/include"
  ditto "$build_root/ios-device-arm64/install/include/sodium.h" "$module_dir/ios/include/sodium.h"
  ditto "$build_root/ios-device-arm64/install/include/sodium" "$module_dir/ios/include/sodium"
  rm -rf "$module_dir/vendor/libsodium.xcframework"
  mv "$staging" "$module_dir/vendor/libsodium.xcframework"
}

write_artifact_manifest() {
  (
    cd "$module_dir"
    shasum -a 256 \
      vendor/libsodium-1.0.22.tar.gz \
      vendor/LICENSE.libsodium.txt \
      ios/include/sodium.h \
      ios/include/sodium/version.h \
      vendor/libsodium.xcframework/Info.plist \
      vendor/libsodium.xcframework/ios-arm64/libsodium.a \
      vendor/libsodium.xcframework/ios-arm64_x86_64-simulator/libsodium.a \
      android/src/main/jniLibs/armeabi-v7a/libliflow_ed25519.so \
      android/src/main/jniLibs/arm64-v8a/libliflow_ed25519.so \
      android/src/main/jniLibs/x86/libliflow_ed25519.so \
      android/src/main/jniLibs/x86_64/libliflow_ed25519.so
  ) > "$module_dir/SHA256SUMS"
}

build_android() {
  build_android_target armeabi-v7a armv7a-linux-androideabi "$toolchain/bin/armv7a-linux-androideabi24-clang" armv7
  build_android_target arm64-v8a aarch64-linux-android "$toolchain/bin/aarch64-linux-android24-clang" arm64
  build_android_target x86 i686-linux-android "$toolchain/bin/i686-linux-android24-clang" x86
  build_android_target x86_64 x86_64-linux-android "$toolchain/bin/x86_64-linux-android24-clang" x86_64
}

case "$mode" in
  all)
    build_apple_device
    build_apple_simulator_slices
    assemble_apple_xcframework
    build_android
    publish_apple_xcframework
    write_artifact_manifest
    ;;
  ios-device)
    build_apple_device
    ;;
  ios-device-publish)
    publish_apple_device
    ;;
  ios-device-slice)
    build_apple_device_slice
    ;;
  ios-simulator)
    build_apple_simulator_slices
    assemble_apple_xcframework
    ;;
  ios-simulator-slices)
    build_apple_simulator_slices
    ;;
  ios-assemble)
    assemble_apple_xcframework
    ;;
  ios-publish)
    publish_apple_xcframework
    ;;
  android)
    build_android
    ;;
  manifest)
    write_artifact_manifest
    ;;
  *)
    echo "Usage: $0 [all|ios-device|ios-device-slice|ios-device-publish|ios-simulator-slices|ios-simulator|ios-assemble|ios-publish|android|manifest]" >&2
    exit 2
    ;;
esac
