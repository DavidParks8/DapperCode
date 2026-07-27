import Crypto
import Foundation
import X509

enum PinnedTlsCertificatePolicy {
  static func validateServerWrapper(
    _ certificate: Certificate,
    expectedSPKIPin: String,
    now: Date = Date()
  ) throws {
    guard certificate.version == .v3 else {
      throw PinnedTlsProofError.trust("server wrapper must be X.509 v3")
    }
    guard certificate.subject == certificate.issuer else {
      throw PinnedTlsProofError.trust("server wrapper must be self-issued")
    }
    guard certificate.signatureAlgorithm == .ecdsaWithSHA256 else {
      throw PinnedTlsProofError.trust("server wrapper must use ECDSA with SHA-256")
    }
    guard P256.Signing.PublicKey(certificate.publicKey) != nil else {
      throw PinnedTlsProofError.trust("server wrapper must contain a P-256 key")
    }
    guard certificate.notValidBefore <= now, certificate.notValidAfter >= now else {
      throw PinnedTlsProofError.trust("server wrapper is not currently valid")
    }
    guard certificate.extensions.count == 4 else {
      throw PinnedTlsProofError.trust(
        "server wrapper must contain only basicConstraints, keyUsage, extendedKeyUsage, and SAN"
      )
    }
    do {
      guard certificate.extensions[oid: .X509ExtensionID.basicConstraints]?.critical == true,
        certificate.extensions[oid: .X509ExtensionID.keyUsage]?.critical == true
      else {
        throw PinnedTlsProofError.trust(
          "server basic constraints and key usage must be critical"
        )
      }
      guard try certificate.extensions.basicConstraints == .notCertificateAuthority else {
        throw PinnedTlsProofError.trust("server wrapper must assert CA=false")
      }
      guard try certificate.extensions.keyUsage == KeyUsage(digitalSignature: true) else {
        throw PinnedTlsProofError.trust("server wrapper must be digitalSignature-only")
      }
      guard let extendedKeyUsage = try certificate.extensions.extendedKeyUsage,
        Array(extendedKeyUsage) == [.serverAuth]
      else {
        throw PinnedTlsProofError.trust("server wrapper must be serverAuth-only")
      }
      guard try certificate.extensions.subjectAlternativeNames != nil else {
        throw PinnedTlsProofError.trust("server wrapper must contain a subjectAltName")
      }
    } catch let error as PinnedTlsProofError {
      throw error
    } catch {
      throw PinnedTlsProofError.trust(
        "server wrapper extension parse failed: \(String(reflecting: error))"
      )
    }
    guard certificate.publicKey.isValidSignature(certificate.signature, for: certificate) else {
      throw PinnedTlsProofError.trust("server wrapper self-signature is invalid")
    }
    guard try matchesSPKIPin(certificate.publicKey, expectedSPKIPin: expectedSPKIPin) else {
      throw PinnedTlsProofError.trust("server SPKI pin mismatch")
    }
  }

  static func validateClientWrapper(
    _ certificate: Certificate,
    expectedSPKIPin: String,
    now: Date = Date()
  ) throws {
    guard certificate.version == .v3 else {
      throw PinnedTlsProofError.certificate("client wrapper must be X.509 v3")
    }
    guard certificate.subject == certificate.issuer else {
      throw PinnedTlsProofError.certificate("client wrapper must be self-issued")
    }
    guard certificate.signatureAlgorithm == .ecdsaWithSHA256 else {
      throw PinnedTlsProofError.certificate("client wrapper must use ECDSA with SHA-256")
    }
    guard P256.Signing.PublicKey(certificate.publicKey) != nil else {
      throw PinnedTlsProofError.certificate("client wrapper must contain a P-256 key")
    }
    guard certificate.notValidBefore <= now, certificate.notValidAfter >= now else {
      throw PinnedTlsProofError.certificate("client wrapper is not currently valid")
    }
    guard certificate.extensions.count == 3 else {
      throw PinnedTlsProofError.certificate(
        "client wrapper must contain only basicConstraints, keyUsage, and extendedKeyUsage"
      )
    }
    do {
      guard certificate.extensions[oid: .X509ExtensionID.basicConstraints]?.critical == true,
        certificate.extensions[oid: .X509ExtensionID.keyUsage]?.critical == true
      else {
        throw PinnedTlsProofError.certificate(
          "client basic constraints and key usage must be critical"
        )
      }
      guard try certificate.extensions.basicConstraints == .notCertificateAuthority else {
        throw PinnedTlsProofError.certificate("client wrapper must assert CA=false")
      }
      guard try certificate.extensions.keyUsage == KeyUsage(digitalSignature: true) else {
        throw PinnedTlsProofError.certificate("client wrapper must be digitalSignature-only")
      }
      guard let extendedKeyUsage = try certificate.extensions.extendedKeyUsage,
        Array(extendedKeyUsage) == [.clientAuth]
      else {
        throw PinnedTlsProofError.certificate("client wrapper must be clientAuth-only")
      }
    } catch let error as PinnedTlsProofError {
      throw error
    } catch {
      throw PinnedTlsProofError.certificate(
        "client wrapper extension parse failed: \(String(reflecting: error))"
      )
    }
    guard certificate.publicKey.isValidSignature(certificate.signature, for: certificate) else {
      throw PinnedTlsProofError.certificate("client wrapper self-signature is invalid")
    }
    guard try matchesSPKIPin(certificate.publicKey, expectedSPKIPin: expectedSPKIPin) else {
      throw PinnedTlsProofError.certificate("client wrapper SPKI does not match its private key")
    }
  }

  static func spkiPin(_ publicKey: Certificate.PublicKey) throws -> String {
    let digest = try spkiDigest(publicKey)
    return digest.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func matchesSPKIPin(
    _ publicKey: Certificate.PublicKey,
    expectedSPKIPin: String
  ) throws -> Bool {
    let actual = try spkiDigest(publicKey)
    let expected = try decodeSPKIPin(expectedSPKIPin)
    return zip(actual, expected).reduce(UInt8(0)) { difference, pair in
      difference | (pair.0 ^ pair.1)
    } == 0
  }

  private static func spkiDigest(_ publicKey: Certificate.PublicKey) throws -> Data {
    let spkiDER = Data(try publicKey.serializeAsPEM().derBytes)
    return Data(SHA256.hash(data: spkiDER))
  }

  private static func decodeSPKIPin(_ value: String) throws -> Data {
    guard value.utf8.count == 43,
      value.utf8.allSatisfy({
        (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
          || $0 == 45 || $0 == 95
      })
    else {
      throw PinnedTlsProofError.trust(
        "SPKI pin must be base64url-without-padding SHA-256"
      )
    }
    var base64 = value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let remainder = base64.utf8.count % 4
    if remainder != 0 {
      base64 += String(repeating: "=", count: 4 - remainder)
    }
    guard let decoded = Data(base64Encoded: base64), decoded.count == 32 else {
      throw PinnedTlsProofError.trust(
        "SPKI pin must be base64url-without-padding SHA-256"
      )
    }
    return decoded
  }
}
