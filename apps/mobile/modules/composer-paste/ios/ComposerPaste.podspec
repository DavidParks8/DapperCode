Pod::Spec.new do |s|
  s.name = 'ComposerPaste'
  s.version = '1.0.0'
  s.summary = 'Image paste for the DapperCode composer'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'DapperCode'
  s.homepage = 'https://github.com/DavidParks8/DapperCode'
  s.source = { :git => s.homepage }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
