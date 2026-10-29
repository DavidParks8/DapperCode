import Foundation
import Security

struct StoredGitCredential: Codable {
  let host: String
  let port: Int
  let accountId: String
  let username: String
  let token: String
}

enum GitCredentialStore {
  private static let service = "com.dappercode.on-device.git"

  static func save(host: String, accountId: String, username: String, token: String) throws
    -> String
  {
    guard let url = URL(string: "https://\(host)"),
      url.host == host, url.path.isEmpty, url.port == nil,
      url.user == nil, url.password == nil,
      !accountId.isEmpty, !username.isEmpty, !token.isEmpty,
      token.utf8.count <= 16_384,
      !username.contains(":"),
      !username.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
      !token.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    else {
      throw CredentialError("Invalid Git credential parameters.")
    }
    let reference = UUID().uuidString
    let credential = StoredGitCredential(
      host: host, port: 443, accountId: accountId, username: username, token: token)
    let data = try JSONEncoder().encode(credential)
    var query = key(reference)
    query[kSecValueData] = data
    query[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw CredentialError("Could not store Git credentials (Keychain status \(status)).")
    }
    return reference
  }

  static func read(_ reference: String, host: String) throws -> StoredGitCredential {
    var query = try validatedKey(reference)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
      throw CredentialError(
        "Git credentials are unavailable. Sign in again (Keychain status \(status)).")
    }
    let credential = try JSONDecoder().decode(StoredGitCredential.self, from: data)
    guard credential.host == host else {
      throw CredentialError("Git credentials cannot be used with a different host.")
    }
    return credential
  }

  static func remove(_ reference: String) throws {
    let status = SecItemDelete(try validatedKey(reference) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw CredentialError("Could not remove Git credentials (Keychain status \(status)).")
    }
  }

  private static func validatedKey(_ reference: String) throws -> [CFString: Any] {
    guard UUID(uuidString: reference) != nil else {
      throw CredentialError("Invalid Git credential reference.")
    }
    return key(reference)
  }

  private static func key(_ reference: String) -> [CFString: Any] {
    [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: reference,
    ]
  }
}

private struct CredentialError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
