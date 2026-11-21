Pod::Spec.new do |s|
  s.name           = 'LiFlowDeviceCheck'
  s.version        = '1.0.0'
  s.summary        = 'Apple-owned device enrollment marker for LiFlow appliance analysis.'
  s.license        = { :type => 'MIT' }
  s.author         = 'LiFlow'
  s.homepage       = 'https://github.com/ponkichi1552/LiFlow'
  s.source         = { :git => 'https://github.com/ponkichi1552/LiFlow.git' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'DeviceCheck'
  s.source_files   = 'ios/*.swift'
end
