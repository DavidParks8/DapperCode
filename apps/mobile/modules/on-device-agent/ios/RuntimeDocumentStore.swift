import Foundation

private struct RuntimeDocumentError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

actor RuntimeDocumentStore {
  private let fileManager = FileManager.default

  func read(_ name: String) throws -> String? {
    let url = try document(name)
    do {
      let attributes = try fileManager.attributesOfItem(atPath: url.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular,
        let bytes = attributes[.size] as? NSNumber, bytes.int64Value <= 8 * 1024 * 1024
      else {
        throw RuntimeDocumentError("Local runtime documents must be regular files no larger than 8 MiB.")
      }
      return try String(contentsOf: url, encoding: .utf8)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
      return nil
    }
  }

  func write(_ name: String, content: String) throws {
    guard content.utf8.count <= 8 * 1024 * 1024 else {
      throw RuntimeDocumentError("The local runtime document exceeds 8 MiB.")
    }
    try Data(content.utf8).write(to: document(name), options: .atomic)
  }

  func names(prefix: String) throws -> [String] {
    try validate(prefix)
    return try fileManager.contentsOfDirectory(atPath: root().path)
      .filter { !$0.hasPrefix(".") && $0.hasPrefix(prefix) }
      .sorted()
  }

  func remove(_ name: String) throws {
    let url = try document(name)
    do {
      try fileManager.removeItem(at: url)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
      return
    }
  }

  private func document(_ name: String) throws -> URL {
    try validate(name)
    return try root().appendingPathComponent(name)
  }

  private func validate(_ name: String) throws {
    guard name.range(of: #"^[a-z0-9][a-z0-9._-]{0,159}$"#, options: .regularExpression) != nil else {
      throw RuntimeDocumentError("Invalid local runtime document name.")
    }
  }

  private func root() throws -> URL {
    guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      throw RuntimeDocumentError("Application support storage is unavailable.")
    }
    let root = support.appendingPathComponent("OnDeviceAgent/state", isDirectory: true)
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }
}
