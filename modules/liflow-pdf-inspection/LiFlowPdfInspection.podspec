Pod::Spec.new do |s|
  s.name           = 'LiFlowPdfInspection'
  s.version        = '1.0.0'
  s.summary        = 'Preflight inspection of selected PDF manuals.'
  s.license        = { :type => 'MIT' }
  s.author         = 'LiFlow'
  s.homepage       = 'https://github.com/ponkichi1552/LiFlow'
  s.source         = { :git => 'https://github.com/ponkichi1552/LiFlow.git' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'PDFKit'
  s.source_files   = 'ios/*.swift'
end
