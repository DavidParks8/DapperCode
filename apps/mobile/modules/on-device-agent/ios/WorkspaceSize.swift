import Foundation

struct NativeWorkspaceSize: Sendable {
  let bytes: Int64
  let files: Int
  let truncated: Bool

  var payload: [String: Any] {
    ["bytes": bytes, "files": files, "truncated": truncated]
  }
}

extension WorkspaceStore {
  static let sizeEntryLimit = 50_000
  static let sizeTimeBudget: TimeInterval = 2

  /// Allocated bytes and regular-file count of the workspace, Git metadata included. Symbolic
  /// links are counted as entries but never followed. The walk stops after `sizeEntryLimit` entries
  /// or `sizeTimeBudget` seconds and then reports a lower bound with `truncated`. It runs outside
  /// the actor, so a long walk never delays other workspace operations.
  nonisolated func workspaceSize(_ id: String) async throws -> NativeWorkspaceSize {
    let root = try await resolve(id, path: "", allowRoot: true)
    return try Self.measure(
      root, entryLimit: Self.sizeEntryLimit, timeBudget: Self.sizeTimeBudget)
  }

  static func measure(_ root: URL, entryLimit: Int, timeBudget: TimeInterval) throws
    -> NativeWorkspaceSize
  {
    let keys: [URLResourceKey] = [
      .isRegularFileKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey,
    ]
    var enumerationError: Error?
    guard
      let enumerator = FileManager().enumerator(
        at: root, includingPropertiesForKeys: keys, options: [],
        errorHandler: { _, error in
          enumerationError = error
          return false
        }
      )
    else {
      throw WorkspaceError(.storageFailure, "The workspace could not be measured.")
    }
    let deadline = ProcessInfo.processInfo.systemUptime + timeBudget
    var bytes: Int64 = 0
    var files = 0
    var visited = 0
    while let value = enumerator.nextObject() {
      guard let item = value as? URL, item.path.hasPrefix(root.path + "/") else {
        throw WorkspaceError(
          .storageFailure, "Size enumeration returned a path outside the workspace.")
      }
      if visited == entryLimit || ProcessInfo.processInfo.systemUptime >= deadline
        || Task.isCancelled
      {
        return NativeWorkspaceSize(bytes: bytes, files: files, truncated: true)
      }
      visited += 1
      // An entry removed during the walk is simply not counted.
      guard let values = try? item.resourceValues(forKeys: Set(keys)),
        values.isRegularFile == true
      else { continue }
      files += 1
      bytes += Int64(values.totalFileAllocatedSize ?? values.fileAllocatedSize ?? 0)
    }
    if enumerationError != nil {
      throw WorkspaceError(
        .storageFailure, "The workspace changed while it was measured. Try again.")
    }
    return NativeWorkspaceSize(bytes: bytes, files: files, truncated: false)
  }
}
