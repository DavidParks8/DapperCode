import Crypto
@testable import DapperCodePinnedTlsPolicy
import Foundation
import XCTest
import X509

final class PinnedTlsCertificatePolicyTests: XCTestCase {
  private enum ExtensionKind {
    case valid
    case certificateAuthority
    case clientAuth
    case clientValid
    case missingSubjectAlternativeName
  }

  func testValidWrapperAndStableSPKIForRenewal() throws {
    let key = Certificate.PrivateKey(P256.Signing.PrivateKey())
    let first = try makeCertificate(key: key)
    let second = try makeCertificate(key: key)
    let firstPin = try PinnedTlsCertificatePolicy.spkiPin(first.publicKey)
    let secondPin = try PinnedTlsCertificatePolicy.spkiPin(second.publicKey)

    XCTAssertEqual(firstPin, secondPin)
    XCTAssertFalse(firstPin.contains("="))
    XCTAssertNoThrow(
      try PinnedTlsCertificatePolicy.validateServerWrapper(
        first,
        expectedSPKIPin: firstPin
      )
    )
  }

  func testRejectsWrongPinValidityAndPurpose() throws {
    let valid = try makeCertificate()
    XCTAssertThrowsError(
      try PinnedTlsCertificatePolicy.validateServerWrapper(
        valid,
        expectedSPKIPin: String(repeating: "A", count: 43)
      )
    )
    XCTAssertThrowsError(
      try PinnedTlsCertificatePolicy.validateServerWrapper(
        valid,
        expectedSPKIPin: "not-a-canonical-pin"
      )
    )

    let expired = try makeCertificate(
      notValidBefore: Date(timeIntervalSince1970: 0),
      notValidAfter: Date(timeIntervalSince1970: 60)
    )
    XCTAssertThrowsError(try validateWithOwnPin(expired))

    let notYetValid = try makeCertificate(
      notValidBefore: Date().addingTimeInterval(3600),
      notValidAfter: Date().addingTimeInterval(7200)
    )
    XCTAssertThrowsError(try validateWithOwnPin(notYetValid))

    let clientAuth = try makeCertificate(extensions: .clientAuth)
    XCTAssertThrowsError(try validateWithOwnPin(clientAuth))
  }

  func testRejectsCAWrongCurveMissingSANAndInvalidSelfSignature() throws {
    let ca = try makeCertificate(extensions: .certificateAuthority)
    XCTAssertThrowsError(try validateWithOwnPin(ca))

    let p384 = try makeCertificate(
      key: Certificate.PrivateKey(P384.Signing.PrivateKey())
    )
    XCTAssertThrowsError(try validateWithOwnPin(p384))

    let missingSAN = try makeCertificate(extensions: .missingSubjectAlternativeName)
    XCTAssertThrowsError(try validateWithOwnPin(missingSAN))

    let leafKey = Certificate.PrivateKey(P256.Signing.PrivateKey())
    let wrongSigner = Certificate.PrivateKey(P256.Signing.PrivateKey())
    let invalidSelfSignature = try makeCertificate(
      key: leafKey,
      signer: wrongSigner
    )
    XCTAssertThrowsError(try validateWithOwnPin(invalidSelfSignature))
  }

  func testRejectsCASignedAndMalformedSubstitutions() throws {
    let rootKey = Certificate.PrivateKey(P256.Signing.PrivateKey())
    let rootName = try DistinguishedName {
      CommonName("Proof substitution root")
    }
    let leaf = try makeCertificate(
      signer: rootKey,
      issuer: rootName
    )
    XCTAssertThrowsError(try validateWithOwnPin(leaf))

    let valid = try makeCertificate()
    let der = Array(try valid.serializeAsPEM().derBytes.dropLast())
    XCTAssertThrowsError(try Certificate(derEncoded: der))
  }

  func testClientWrapperPolicyRequiresClientAuthAndExactKey() throws {
    let client = try makeCertificate(extensions: .clientValid)
    let clientPin = try PinnedTlsCertificatePolicy.spkiPin(client.publicKey)
    XCTAssertNoThrow(
      try PinnedTlsCertificatePolicy.validateClientWrapper(
        client,
        expectedSPKIPin: clientPin
      )
    )

    let server = try makeCertificate()
    XCTAssertThrowsError(
      try PinnedTlsCertificatePolicy.validateClientWrapper(
        server,
        expectedSPKIPin: try PinnedTlsCertificatePolicy.spkiPin(server.publicKey)
      )
    )
    XCTAssertThrowsError(
      try PinnedTlsCertificatePolicy.validateClientWrapper(
        client,
        expectedSPKIPin: String(repeating: "A", count: 43)
      )
    )
  }

  private func validateWithOwnPin(_ certificate: Certificate) throws {
    try PinnedTlsCertificatePolicy.validateServerWrapper(
      certificate,
      expectedSPKIPin: PinnedTlsCertificatePolicy.spkiPin(certificate.publicKey)
    )
  }

  private func makeCertificate(
    key: Certificate.PrivateKey = Certificate.PrivateKey(P256.Signing.PrivateKey()),
    signer: Certificate.PrivateKey? = nil,
    issuer: DistinguishedName? = nil,
    notValidBefore: Date = Date().addingTimeInterval(-300),
    notValidAfter: Date = Date().addingTimeInterval(3600),
    extensions: ExtensionKind = .valid
  ) throws -> Certificate {
    let subject = try DistinguishedName {
      CommonName("DapperCode proof server")
    }
    return try Certificate(
      version: .v3,
      serialNumber: Certificate.SerialNumber(),
      publicKey: key.publicKey,
      notValidBefore: notValidBefore,
      notValidAfter: notValidAfter,
      issuer: issuer ?? subject,
      subject: subject,
      extensions: try makeExtensions(extensions),
      issuerPrivateKey: signer ?? key
    )
  }

  private func makeExtensions(_ kind: ExtensionKind) throws -> Certificate.Extensions {
    switch kind {
    case .valid:
      return try Certificate.Extensions {
        Critical(BasicConstraints.notCertificateAuthority)
        Critical(KeyUsage(digitalSignature: true))
        try ExtendedKeyUsage([.serverAuth])
        SubjectAlternativeNames([.dnsName("localhost")])
      }
    case .certificateAuthority:
      return try Certificate.Extensions {
        Critical(BasicConstraints.isCertificateAuthority(maxPathLength: nil))
        Critical(KeyUsage(digitalSignature: true))
        try ExtendedKeyUsage([.serverAuth])
        SubjectAlternativeNames([.dnsName("localhost")])
      }
    case .clientAuth:
      return try Certificate.Extensions {
        Critical(BasicConstraints.notCertificateAuthority)
        Critical(KeyUsage(digitalSignature: true))
        try ExtendedKeyUsage([.clientAuth])
        SubjectAlternativeNames([.dnsName("localhost")])
      }
    case .clientValid:
      return try Certificate.Extensions {
        Critical(BasicConstraints.notCertificateAuthority)
        Critical(KeyUsage(digitalSignature: true))
        try ExtendedKeyUsage([.clientAuth])
      }
    case .missingSubjectAlternativeName:
      return try Certificate.Extensions {
        Critical(BasicConstraints.notCertificateAuthority)
        Critical(KeyUsage(digitalSignature: true))
        try ExtendedKeyUsage([.serverAuth])
      }
    }
  }
}
