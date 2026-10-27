import Foundation
import DapperGit

final class GitNetworkOperation {
  static let shared = GitNetworkOperation()
  private let lock = NSLock()
  private var active = false
  private var cancelled = false
  private var completed = 0
  private var total = 0

  func begin() throws {
    lock.lock()
    defer { lock.unlock() }
    guard !active else { throw GitOperationError("Another native Git transfer is running.") }
    active = true
    cancelled = false
    completed = 0
    total = 0
  }

  func finish() {
    lock.lock()
    defer { lock.unlock() }
    active = false
  }

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    if active { cancelled = true }
  }

  func progress(completed: Int? = nil, total: Int? = nil) -> Int32 {
    lock.lock()
    defer { lock.unlock() }
    if let completed { self.completed = completed }
    if let total { self.total = total }
    return cancelled ? GIT_EUSER.rawValue : 0
  }

  func snapshot() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return ["active": active, "cancelled": cancelled, "completed": completed, "total": total]
  }
}
