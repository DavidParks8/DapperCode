import Foundation

enum PinnedTlsProofError: LocalizedError {
  case invalidInput(String)
  case keychain(String, OSStatus)
  case security(String)
  case certificate(String)
  case trust(String)
  case transport(String)

  var errorDescription: String? {
    switch self {
    case .invalidInput(let message),
      .security(let message),
      .certificate(let message),
      .trust(let message),
      .transport(let message):
      return message
    case .keychain(let operation, let status):
      return "\(operation) failed with OSStatus \(status)"
    }
  }
}
