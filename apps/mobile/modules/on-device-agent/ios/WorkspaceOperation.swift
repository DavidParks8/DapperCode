import Foundation

/// Synchronous cancellation must not queue behind the workspace actor doing the scan.
final class WorkspaceOperation: @unchecked Sendable {
  static let shared = WorkspaceOperation()
  private let lock = NSLock()
  private var tokens: [String: Bool] = [:]

  func begin(_ token: String) throws {
    lock.lock()
    defer { lock.unlock() }
    guard tokens.count < 64, tokens[token] == nil else {
      throw WorkspaceError(.invalidArgument, "Too many workspace operations or a duplicate token.")
    }
    tokens[token] = false
  }

  func cancel(_ token: String) {
    lock.lock()
    defer { lock.unlock() }
    if tokens[token] != nil { tokens[token] = true }
  }

  func finish(_ token: String) {
    lock.lock()
    defer { lock.unlock() }
    tokens.removeValue(forKey: token)
  }

  func check(_ token: String) throws {
    lock.lock()
    let active = tokens[token] == false
    lock.unlock()
    guard active else {
      throw WorkspaceError(.operationCancelled, "Workspace operation cancelled.")
    }
  }
}
