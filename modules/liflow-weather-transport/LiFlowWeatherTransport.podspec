Pod::Spec.new do |s|
  s.name           = 'LiFlowWeatherTransport'
  s.version        = '1.0.0'
  s.summary        = 'Certificate-scoped HTTPS for the self-hosted LiFlow weather API.'
  s.license        = { :type => 'MIT' }
  s.author         = 'LiFlow'
  s.homepage       = 'https://github.com/ponkichi1552/LiFlow'
  s.source         = { :git => 'https://github.com/ponkichi1552/LiFlow.git' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'Security'
  s.source_files   = 'ios/*.swift'
end
