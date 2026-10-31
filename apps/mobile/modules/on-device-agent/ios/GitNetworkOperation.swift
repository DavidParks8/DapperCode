import Foundation
import DapperGit

final class GitNetworkOperation {
  static let shared = GitNetworkOperation()
  /// libgit2 reports transfer progress per object; JavaScript only needs a few updates a second.
  static let progressInterval: UInt64 = 100_000_000
  private let lock = NSLock()
  private var active = false
  private var cancelled = false
  private var completed = 0
  private var total = 0
  private var observer: (([String: Any]) -> Void)?
  private var lastPublished: UInt64 = 0

  func begin() throws {
    let snapshot: [String: Any]
    lock.lock()
    guard !active else {
      lock.unlock()
      throw GitOperationError(.gitTransferBusy, "Another native Git transfer is running.")
    }
    active = true
    cancelled = false
    completed = 0
    total = 0
    snapshot = lockedSnapshot()
    lock.unlock()
    publish(snapshot)
  }

  func finish() {
    lock.lock()
    active = false
    let snapshot = lockedSnapshot()
    lock.unlock()
    publish(snapshot)
  }

  func cancel() {
    lock.lock()
    let changed = active && !cancelled
    if active { cancelled = true }
    let snapshot = lockedSnapshot()
    lock.unlock()
    if changed { publish(snapshot) }
  }

  func progress(completed: Int? = nil, total: Int? = nil) -> Int32 {
    lock.lock()
    let changed =
      (completed.map { $0 != self.completed } ?? false) || (total.map { $0 != self.total } ?? false)
    if let completed { self.completed = completed }
    if let total { self.total = total }
    let now = DispatchTime.now().uptimeNanoseconds
    let finalObject = self.total > 0 && self.completed >= self.total
    let due = changed && (finalObject || now &- lastPublished >= Self.progressInterval)
    let snapshot = due ? lockedSnapshot() : nil
    let result = cancelled ? GIT_EUSER.rawValue : 0
    lock.unlock()
    if let snapshot { publish(snapshot) }
    return result
  }

  func snapshot() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return lockedSnapshot()
  }

  /// Receives throttled progress snapshots while JavaScript observes them; `nil` stops delivery.
  func setObserver(_ observer: (([String: Any]) -> Void)?) {
    lock.lock()
    self.observer = observer
    lock.unlock()
  }

  private func lockedSnapshot() -> [String: Any] {
    ["active": active, "cancelled": cancelled, "completed": completed, "total": total]
  }

  private func publish(_ snapshot: [String: Any]) {
    lock.lock()
    lastPublished = DispatchTime.now().uptimeNanoseconds
    let observer = self.observer
    lock.unlock()
    observer?(snapshot)
  }
}
