Pod::Spec.new do |s|
  s.name           = 'LiFlowEd25519'
  s.version        = '1.0.0'
  s.summary        = 'Native Ed25519 verification for LiFlow.'
  s.description    = 'Uses the pinned libsodium 1.0.22 verifier on Apple platforms.'
  s.license        = { :type => 'ISC', :file => 'vendor/LICENSE.libsodium.txt' }
  s.author         = 'LiFlow'
  s.homepage       = 'https://github.com/ponkichi1552/LiFlow'
  s.source         = { :git => 'https://github.com/ponkichi1552/LiFlow.git' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.vendored_frameworks = 'vendor/libsodium.xcframework'
  s.source_files = [
    'ios/*.swift',
    'native/liflow_ed25519.{c,h}'
  ]
  s.public_header_files = 'native/liflow_ed25519.h'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'HEADER_SEARCH_PATHS' => '"${PODS_TARGET_SRCROOT}/ios/include" $(inherited)'
  }
end
