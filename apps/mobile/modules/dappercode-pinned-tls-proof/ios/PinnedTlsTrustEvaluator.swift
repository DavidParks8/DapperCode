import Foundation
import Security
import X509

struct PinnedTlsTrustEvaluator {
  let expectedHostname: String
  let expectedSPKIPin: String

  func evaluate(_ trust: SecTrust) throws {
    guard SecTrustGetCertificateCount(trust) == 1,
      let leaf = SecTrustGetCertificateAtIndex(trust, 0)
    else {
      throw PinnedTlsProofError.trust("server must present one self-signed leaf certificate")
    }

    let certificate: Certificate
    do {
      certificate = try Certificate(leaf)
    } catch {
      throw PinnedTlsProofError.trust(
        "server wrapper parse failed: \(String(reflecting: error))"
      )
    }
    try PinnedTlsCertificatePolicy.validateServerWrapper(
      certificate,
      expectedSPKIPin: expectedSPKIPin
    )

    let policy = SecPolicyCreateSSL(true, expectedHostname as CFString)
    let policyStatus = SecTrustSetPolicies(trust, policy)
    guard policyStatus == errSecSuccess else {
      throw PinnedTlsProofError.keychain("set server hostname policy", policyStatus)
    }
    let anchorStatus = SecTrustSetAnchorCertificates(trust, [leaf] as CFArray)
    guard anchorStatus == errSecSuccess else {
      throw PinnedTlsProofError.keychain("set self-signed server anchor", anchorStatus)
    }
    let anchorOnlyStatus = SecTrustSetAnchorCertificatesOnly(trust, true)
    guard anchorOnlyStatus == errSecSuccess else {
      throw PinnedTlsProofError.keychain("restrict server anchors", anchorOnlyStatus)
    }
    var trustError: CFError?
    guard SecTrustEvaluateWithError(trust, &trustError) else {
      throw PinnedTlsProofError.trust(
        "server hostname/SAN/validity evaluation failed: \(String(describing: trustError))"
      )
    }
  }
}
