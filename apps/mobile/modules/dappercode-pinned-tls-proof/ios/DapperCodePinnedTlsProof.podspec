require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'DapperCodePinnedTlsProof'
  s.version = package['version']
  s.summary = 'Debug-only native iOS pinned TLS feasibility proof'
  s.description = 'Exercises Secure Enclave client authentication and exact SPKI server pinning.'
  s.license = 'MIT'
  s.author = 'DapperCode'
  s.homepage = 'https://github.com/DavidParks8/DapperCode'
  s.platform = :ios, '15.1'
  s.swift_version = '5.9'
  s.source = { git: 'https://github.com/DavidParks8/DapperCode.git' }
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'

  unless defined?(install_modules_dependencies)
    require File.join(
      File.dirname(`node --print "require.resolve('react-native/package.json')"`),
      'scripts/react_native_pods'
    )
  end
  install_modules_dependencies(s)

  spm_dependency(
    s,
    url: 'https://github.com/apple/swift-certificates.git',
    requirement: {
      kind: 'exactVersion',
      version: '1.19.3'
    },
    products: ['X509']
  )
  spm_dependency(
    s,
    url: 'https://github.com/apple/swift-crypto.git',
    requirement: {
      kind: 'exactVersion',
      version: '4.5.1'
    },
    products: ['Crypto']
  )
  spm_dependency(
    s,
    url: 'https://github.com/apple/swift-asn1.git',
    requirement: {
      kind: 'exactVersion',
      version: '1.7.1'
    },
    products: ['SwiftASN1']
  )
end
