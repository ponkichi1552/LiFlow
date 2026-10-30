require 'xcodeproj'
require 'fileutils'
root = File.expand_path(ARGV.fetch(0))
FileUtils.mkdir_p(root)
project = Xcodeproj::Project.new(File.join(root, 'CalendarAudit.xcodeproj'))
host = project.new_target(:application, 'CalendarAuditHost', :ios, '16.4')
test = project.new_target(:ui_test_bundle, 'CalendarUITests', :ios, '16.4')
host.source_build_phase.add_file_reference(project.main_group.new_file(File.join(__dir__, 'Host.swift')))
test.source_build_phase.add_file_reference(project.main_group.new_file(File.join(__dir__, 'CalendarUITests.swift')))
test.add_dependency(host)
[host, test].each do |target|
  target.build_configurations.each do |config|
    config.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
    config.build_settings['SWIFT_VERSION'] = '5.0'
    config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'jp.liflow.audit.' + target.name.downcase
    config.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2'
    config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
  end
end
test.build_configurations.each { |config| config.build_settings['TEST_TARGET_NAME'] = 'CalendarAuditHost' }
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(host)
scheme.add_build_target(test)
scheme.add_test_target(test)
scheme.set_launch_target(host)
scheme.save_as(project.path, 'CalendarAudit')
puts project.path
