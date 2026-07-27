// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "DapperCodePinnedTlsPolicy",
  platforms: [
    .iOS(.v15),
    .macOS(.v13),
  ],
  products: [
    .library(name: "DapperCodePinnedTlsPolicy", targets: ["DapperCodePinnedTlsPolicy"]),
  ],
  dependencies: [
    .package(
      url: "https://github.com/apple/swift-certificates.git",
      exact: "1.19.3"
    ),
    .package(
      url: "https://github.com/apple/swift-crypto.git",
      exact: "4.5.1"
    ),
  ],
  targets: [
    .target(
      name: "DapperCodePinnedTlsPolicy",
      dependencies: [
        .product(name: "Crypto", package: "swift-crypto"),
        .product(name: "X509", package: "swift-certificates"),
      ],
      path: "ios",
      sources: [
        "PinnedTlsCertificatePolicy.swift",
        "PinnedTlsProofError.swift",
      ]
    ),
    .testTarget(
      name: "DapperCodePinnedTlsPolicyTests",
      dependencies: [
        "DapperCodePinnedTlsPolicy",
        .product(name: "Crypto", package: "swift-crypto"),
        .product(name: "X509", package: "swift-certificates"),
      ],
      path: "Tests"
    ),
  ]
)
