import Foundation
import Security
import X509

struct PinnedTlsIdentityEvidence {
  let identity: SecIdentity
  let spkiPin: String
  let hardwareBacked: Bool
  let privateKeyExportFailed: Bool
  let storageClass: String
  let storageClassVerified: Bool
  let accessControl: String
  let accessControlVerified: Bool

  func publicReport(wrapperRenewed: Bool = false) -> [String: Any] {
    [
      "spkiPin": spkiPin,
      "hardwareBacked": hardwareBacked,
      "simulatorSoftwareFallback": !hardwareBacked,
      "privateKeyExportFailed": privateKeyExportFailed,
      "storageClass": storageClass,
      "storageClassVerified": storageClassVerified,
      "accessControl": accessControl,
      "accessControlVerified": accessControlVerified,
      "wrapperRenewed": wrapperRenewed,
    ]
  }
}

final class PinnedTlsIdentityStore {
  private let keyTag = Data("com.dappercode.pinned-tls-proof.client-key".utf8)
  private let certificateLabel = "com.dappercode.pinned-tls-proof.client-certificate"

  func prepare(forceRenewWrapper: Bool = false) throws -> PinnedTlsIdentityEvidence {
    let privateKey = try loadOrCreatePrivateKey()
    let certificate: SecCertificate
    if forceRenewWrapper {
      certificate = try replaceCertificate(for: privateKey)
    } else if let stored = try loadCertificate(), try certificateMatchesKey(stored, privateKey: privateKey) {
      certificate = stored
    } else {
      certificate = try replaceCertificate(for: privateKey)
    }

    let identity = try resolveIdentity(for: certificate)

    let attributes = SecKeyCopyAttributes(privateKey) as? [CFString: Any] ?? [:]
    let hardwareBacked = (attributes[kSecAttrTokenID] as? String)
      == (kSecAttrTokenIDSecureEnclave as String)
    #if !targetEnvironment(simulator)
    guard hardwareBacked else {
      throw PinnedTlsProofError.security(
        "physical-device proof requires a Secure Enclave-backed private key"
      )
    }
    #endif

    var exportError: Unmanaged<CFError>?
    let exportedPrivateKey = SecKeyCopyExternalRepresentation(privateKey, &exportError)
    let privateKeyExportFailed = exportedPrivateKey == nil
    if hardwareBacked && !privateKeyExportFailed {
      throw PinnedTlsProofError.security("Secure Enclave private key was unexpectedly exportable")
    }

    try validateKeyStorage()
    try proveNonInteractiveSigning(privateKey)
    let parsedCertificate = try Certificate(certificate)
    let spkiPin = try PinnedTlsCertificatePolicy.spkiPin(parsedCertificate.publicKey)
    try PinnedTlsCertificatePolicy.validateClientWrapper(
      parsedCertificate,
      expectedSPKIPin: spkiPin
    )
    return PinnedTlsIdentityEvidence(
      identity: identity,
      spkiPin: spkiPin,
      hardwareBacked: hardwareBacked,
      privateKeyExportFailed: privateKeyExportFailed,
      storageClass: "afterFirstUnlockThisDeviceOnly",
      storageClassVerified: true,
      accessControl: "privateKeyUsage",
      accessControlVerified: true
    )
  }

  private func loadOrCreatePrivateKey() throws -> SecKey {
    let query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrApplicationTag: keyTag,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef: true,
      kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let key = result {
      return key as! SecKey
    }
    guard status == errSecItemNotFound else {
      throw PinnedTlsProofError.keychain("load private key", status)
    }

    let accessControl = try makeAccessControl()

    var privateAttributes: [CFString: Any] = [
      kSecAttrApplicationTag: keyTag,
      kSecAttrIsPermanent: true,
      kSecAttrAccessControl: accessControl,
    ]
    #if targetEnvironment(simulator)
    privateAttributes[kSecAttrIsExtractable] = true
    #endif

    var attributes: [CFString: Any] = [
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits: 256,
      kSecPrivateKeyAttrs: privateAttributes,
    ]
    #if !targetEnvironment(simulator)
    attributes[kSecAttrTokenID] = kSecAttrTokenIDSecureEnclave
    #endif

    var keyError: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &keyError) else {
      throw PinnedTlsProofError.security(
        "create P-256 private key failed: \(String(describing: keyError?.takeRetainedValue()))"
      )
    }
    return key
  }

  private func loadCertificate() throws -> SecCertificate? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassCertificate,
      kSecAttrLabel: certificateLabel,
      kSecReturnRef: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess, let result else {
      throw PinnedTlsProofError.keychain("load client certificate", status)
    }
    return (result as! SecCertificate)
  }

  private func resolveIdentity(for certificate: SecCertificate) throws -> SecIdentity {
    let query: [CFString: Any] = [
      kSecClass: kSecClassIdentity,
      kSecMatchLimit: kSecMatchLimitAll,
      kSecReturnRef: true,
      kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else {
      throw PinnedTlsProofError.keychain("resolve SecIdentity", status)
    }
    let expectedDER = SecCertificateCopyData(certificate) as Data
    let identities: [SecIdentity]
    if let array = result as? [SecIdentity] {
      identities = array
    } else if let identity = result {
      identities = [identity as! SecIdentity]
    } else {
      identities = []
    }
    for identity in identities {
      var candidate: SecCertificate?
      guard SecIdentityCopyCertificate(identity, &candidate) == errSecSuccess,
        let candidate,
        SecCertificateCopyData(candidate) as Data == expectedDER
      else {
        continue
      }
      return identity
    }
    throw PinnedTlsProofError.security("Keychain did not associate the client certificate and key")
  }

  private func replaceCertificate(for privateKey: SecKey) throws -> SecCertificate {
    let certificate = try makeCertificate(for: privateKey)
    let deleteQuery: [CFString: Any] = [
      kSecClass: kSecClassCertificate,
      kSecAttrLabel: certificateLabel,
    ]
    let deleteStatus = SecItemDelete(deleteQuery as CFDictionary)
    guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
      throw PinnedTlsProofError.keychain("delete prior client certificate", deleteStatus)
    }

    let addQuery: [CFString: Any] = [
      kSecClass: kSecClassCertificate,
      kSecAttrLabel: certificateLabel,
      kSecValueRef: certificate,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw PinnedTlsProofError.keychain("persist client certificate", addStatus)
    }
    return certificate
  }

  private func makeCertificate(for privateKey: SecKey) throws -> SecCertificate {
    let signingKey = try Certificate.PrivateKey(privateKey)
    let subject = try DistinguishedName {
      CommonName("DapperCode pinned TLS proof client")
    }
    let now = Date()
    let extensions = try Certificate.Extensions {
      Critical(BasicConstraints.notCertificateAuthority)
      Critical(KeyUsage(digitalSignature: true))
      try ExtendedKeyUsage([.clientAuth])
    }
    let certificate = try Certificate(
      version: .v3,
      serialNumber: Certificate.SerialNumber(),
      publicKey: signingKey.publicKey,
      notValidBefore: now.addingTimeInterval(-300),
      notValidAfter: now.addingTimeInterval(30 * 24 * 60 * 60),
      issuer: subject,
      subject: subject,
      signatureAlgorithm: .ecdsaWithSHA256,
      extensions: extensions,
      issuerPrivateKey: signingKey
    )
    guard certificate.publicKey.isValidSignature(certificate.signature, for: certificate) else {
      throw PinnedTlsProofError.certificate("generated client wrapper self-signature is invalid")
    }
    return try SecCertificate.makeWithCertificate(certificate)
  }

  private func certificateMatchesKey(_ certificate: SecCertificate, privateKey: SecKey) throws -> Bool {
    let parsed = try Certificate(certificate)
    let wrappedPrivateKey = try Certificate.PrivateKey(privateKey)
    return try PinnedTlsCertificatePolicy.spkiPin(parsed.publicKey)
      == PinnedTlsCertificatePolicy.spkiPin(wrappedPrivateKey.publicKey)
      && parsed.notValidBefore <= Date()
      && parsed.notValidAfter > Date().addingTimeInterval(24 * 60 * 60)
  }

  private func proveNonInteractiveSigning(_ privateKey: SecKey) throws {
    let challenge = Data(UUID().uuidString.utf8)
    var error: Unmanaged<CFError>?
    guard SecKeyCreateSignature(
      privateKey,
      .ecdsaSignatureMessageX962SHA256,
      challenge as CFData,
      &error
    ) != nil else {
      throw PinnedTlsProofError.security(
        "non-interactive private-key signing failed: \(String(describing: error?.takeRetainedValue()))"
      )
    }
  }

  private func validateKeyStorage() throws {
    let query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrApplicationTag: keyTag,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnAttributes: true,
      kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let attributes = result as? [CFString: Any] else {
      throw PinnedTlsProofError.keychain("read private-key storage attributes", status)
    }
    guard (attributes[kSecAttrAccessible] as? String)
      == (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    else {
      throw PinnedTlsProofError.security(
        "private key did not retain AfterFirstUnlockThisDeviceOnly storage"
      )
    }
    guard let storedAccessControl = attributes[kSecAttrAccessControl] else {
      throw PinnedTlsProofError.security("private key has no persisted access control")
    }
    guard CFEqual(storedAccessControl as CFTypeRef, try makeAccessControl()) else {
      throw PinnedTlsProofError.security(
        "private key access control differs from non-interactive privateKeyUsage"
      )
    }
  }

  private func makeAccessControl() throws -> SecAccessControl {
    var accessError: Unmanaged<CFError>?
    guard let accessControl = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      .privateKeyUsage,
      &accessError
    ) else {
      throw PinnedTlsProofError.security(
        "create key access control failed: \(String(describing: accessError?.takeRetainedValue()))"
      )
    }
    return accessControl
  }

}
