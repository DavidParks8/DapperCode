Pod::Spec.new do |s|
  s.name = 'OnDeviceAgent'
  s.version = '1.0.0'
  s.summary = 'Native services for the DapperCode on-device agent'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'DapperCode'
  s.homepage = 'https://github.com/DavidParks8/DapperCode'
  s.source = { :git => s.homepage }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{swift,h,m}'
  s.vendored_frameworks = 'build/git/libgit2.xcframework'
  s.resource_bundles = { 'OnDeviceAgentNotices' => ['build/git/THIRD_PARTY_NOTICES.txt'] }
  s.frameworks = 'Security', 'CoreFoundation'
  s.libraries = 'iconv', 'z'
end
