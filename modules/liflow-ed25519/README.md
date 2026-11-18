# LiFlowEd25519 native module

This local Expo module exposes synchronous Ed25519 verification backed by libsodium 1.0.22. It accepts `Uint8Array` values without text or base64 conversion. The native verifier returns `false` unless the signature is 64 bytes and the public key is 32 bytes. Android reads the typed-array view directly through its byte offset; empty messages are supported.

The Apple module returns the linked `sodium_version_string()` through the `version` constant. Android returns the same value through JNI. A native `true` therefore identifies a strict result from libsodium 1.0.22; callers may fall back to the app's existing verifier for `false`.

The upstream release archive is stored at `vendor/libsodium-1.0.22.tar.gz`. `native/build-libsodium.sh` verifies its pinned SHA-256 before building. The build uses static, minimal libsodium for Apple device/simulator and Android `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64`; no Rust is used in the app.

Run on arm64 macOS with Xcode and Android NDK r27b:

```sh
BUILD_ROOT=/Volumes/LiFlowValidation/liflow-ed25519-build bash modules/liflow-ed25519/native/build-libsodium.sh ios-device
BUILD_ROOT=/Volumes/LiFlowValidation/liflow-ed25519-build bash modules/liflow-ed25519/native/build-libsodium.sh ios-device-publish
BUILD_ROOT=/Volumes/LiFlowValidation/liflow-ed25519-build bash modules/liflow-ed25519/native/build-libsodium.sh ios-simulator-slices
BUILD_ROOT=/Volumes/LiFlowValidation/liflow-ed25519-build bash modules/liflow-ed25519/native/build-libsodium.sh ios-assemble
BUILD_ROOT=/Volumes/LiFlowValidation/liflow-ed25519-build bash modules/liflow-ed25519/native/build-libsodium.sh ios-publish
BUILD_ROOT=/Volumes/LiFlowValidation/liflow-ed25519-build bash modules/liflow-ed25519/native/build-libsodium.sh android
BUILD_ROOT=/Volumes/LiFlowValidation/liflow-ed25519-build bash modules/liflow-ed25519/native/build-libsodium.sh manifest
```

`ios-device` stages the iPad device slice under `BUILD_ROOT`; `ios-device-publish` copies it into the module for a device-only CocoaPods link. The simulator build and assembly modes only write under `BUILD_ROOT`; run `ios-publish` after CocoaPods has finished consuming the device-only XCFramework. The `all` mode builds every target and publishes the final device+simulator XCFramework with a fresh `SHA256SUMS`. `manifest` regenerates that checksum list after platform-specific build steps. No simulator is launched. Generated native libraries in `vendor/libsodium.xcframework` and `android/src/main/jniLibs` are shipped build inputs; intermediate configure/build trees stay under `BUILD_ROOT`.
