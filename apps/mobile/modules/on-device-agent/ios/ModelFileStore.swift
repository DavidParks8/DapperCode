import CryptoKit
import Foundation

struct NativeModelFile: Codable, Sendable {
  let id: String
  let sha256: String
  let bytes: Int64

  func payload(uri: String) -> [String: Any] {
    ["id": id, "sha256": sha256, "bytes": bytes, "uri": uri]
  }
}

struct NativeModelPaths: Sendable {
  let partialURI: String
  let resumeURI: String
  let verificationBytes: Int64?
  let availableBytes: Int64

  var payload: [String: Any] {
    [
      "partialUri": partialURI, "resumeUri": resumeURI, "availableBytes": availableBytes,
      "verificationBytes": verificationBytes.map { $0 as Any } ?? NSNull(),
    ]
  }
}

struct NativeModelStorage: Sendable {
  let usedBytes: Int64
  let freeBytes: Int64
  let capacityBytes: Int64
  let models: [(id: String, bytes: Int64)]

  var payload: [String: Any] {
    [
      "usedBytes": usedBytes, "freeBytes": freeBytes, "capacityBytes": capacityBytes,
      "models": models.map { ["id": $0.id, "bytes": $0.bytes] as [String: Any] },
    ]
  }
}

struct ModelFileError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

/// Shared on-disk layout for model files, staged downloads, and transfer checkpoints.
enum ModelStorage {
  static func root() throws -> URL {
    let fileManager = FileManager.default
    guard
      let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    else {
      throw ModelFileError("Application support storage is unavailable.")
    }
    var root = support.appendingPathComponent("OnDeviceAgent/models", isDirectory: true)
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    var resources = URLResourceValues()
    resources.isExcludedFromBackup = true
    try root.setResourceValues(resources)
    return root
  }

  static func container(_ id: String) throws -> URL {
    guard id.range(of: #"^[a-z0-9][a-z0-9._-]{0,127}$"#, options: .regularExpression) != nil else {
      throw ModelFileError("Invalid model identity.")
    }
    let container = try root().appendingPathComponent(id, isDirectory: true)
    try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    return container
  }

  /// Free space for user-requested downloads, which may include purgeable system storage.
  static func freeBytes(at url: URL) throws -> Int64 {
    let values = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    if let important = values.volumeAvailableCapacityForImportantUsage, important > 0 {
      return important
    }
    let attributes = try FileManager.default.attributesOfFileSystem(forPath: url.path)
    guard let free = attributes[.systemFreeSize] as? NSNumber else {
      throw ModelFileError("Available model storage could not be determined.")
    }
    return free.int64Value
  }

  static func size(_ url: URL) throws -> Int64? {
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular,
        let bytes = attributes[.size] as? NSNumber
      else {
        throw ModelFileError("Model data must be a regular file.")
      }
      return bytes.int64Value
    } catch let error as CocoaError
      where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile
    {
      return nil
    }
  }
}

/// Cooperative progress and cancellation for one model's SHA-256 verification.
final class ModelVerificationToken: @unchecked Sendable {
  let total: Int64
  private let lock = NSLock()
  private var completedBytes: Int64 = 0
  private var cancelled = false

  init(total: Int64) { self.total = total }

  var completed: Int64 { lock.withLock { completedBytes } }
  var isCancelled: Bool { lock.withLock { cancelled } }

  func advance(_ bytes: Int) { lock.withLock { completedBytes += Int64(bytes) } }
  func cancel() { lock.withLock { cancelled = true } }
}

final class ModelVerificationProgress: @unchecked Sendable {
  static let shared = ModelVerificationProgress()

  private let lock = NSLock()
  private var tokens: [String: ModelVerificationToken] = [:]

  func begin(_ id: String, total: Int64) throws -> ModelVerificationToken {
    try lock.withLock {
      guard tokens[id] == nil else {
        throw ModelFileError("This model is already being verified.")
      }
      let token = ModelVerificationToken(total: total)
      tokens[id] = token
      return token
    }
  }

  func end(_ id: String, _ token: ModelVerificationToken) {
    lock.withLock {
      if tokens[id] === token { tokens.removeValue(forKey: id) }
    }
  }

  func cancel(_ id: String) {
    lock.withLock { tokens[id] }?.cancel()
  }

  func snapshot(_ id: String) -> [String: Any] {
    guard let token = lock.withLock({ tokens[id] }) else {
      return ["active": false, "completed": 0, "total": 0]
    }
    return ["active": true, "completed": token.completed, "total": token.total]
  }
}

actor ModelFileStore {
  private let fileManager = FileManager.default

  func paths(_ id: String) throws -> NativeModelPaths {
    let container = try ModelStorage.container(id)
    let verification = container.appendingPathComponent("verifying/model.gguf")
    let partial = container.appendingPathComponent("partial.gguf")
    let bytes = try ModelStorage.size(verification) ?? ModelStorage.size(partial)
    return NativeModelPaths(
      partialURI: partial.absoluteString,
      resumeURI: container.appendingPathComponent("resume.json").absoluteString,
      verificationBytes: bytes, availableBytes: try ModelStorage.freeBytes(at: container)
    )
  }

  func downloaded(_ id: String) throws -> (NativeModelFile, String)? {
    let ready = try ModelStorage.container(id).appendingPathComponent("ready", isDirectory: true)
    guard fileManager.fileExists(atPath: ready.path) else { return nil }
    let record = try JSONDecoder().decode(
      NativeModelFile.self, from: Data(contentsOf: ready.appendingPathComponent("model.json"))
    )
    let model = ready.appendingPathComponent("model.gguf")
    guard record.id == id, record.bytes > 0, try ModelStorage.size(model) == record.bytes else {
      throw ModelFileError("The downloaded model is incomplete. Remove it and download it again.")
    }
    return (record, model.absoluteString)
  }

  func finalize(_ id: String, sha256: String, expectedBytes: Int64) async throws -> (
    NativeModelFile, String
  ) {
    guard expectedBytes > 0, expectedBytes <= 8 * 1024 * 1024 * 1024,
      sha256.utf8.count == 64,
      sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
    else {
      throw ModelFileError("Model verification requires a positive size and a SHA-256 checksum.")
    }
    let container = try ModelStorage.container(id)
    let ready = container.appendingPathComponent("ready", isDirectory: true)
    guard !fileManager.fileExists(atPath: ready.path) else {
      throw ModelFileError("Remove the installed model before replacing it.")
    }
    let verifying = container.appendingPathComponent("verifying", isDirectory: true)
    let verifyingFile = verifying.appendingPathComponent("model.gguf")
    let partial = container.appendingPathComponent("partial.gguf")
    let source = fileManager.fileExists(atPath: verifyingFile.path) ? verifyingFile : partial
    guard try ModelStorage.size(source) == expectedBytes else {
      throw ModelFileError(
        "The model download size does not match the catalog. Restart the download.")
    }
    let token = try ModelVerificationProgress.shared.begin(id, total: expectedBytes)
    defer { ModelVerificationProgress.shared.end(id, token) }
    // Hash off the actor so other models' file operations are not blocked by multi-GB reads.
    let digest = try await Task.detached(priority: .utility) {
      try ModelFileStore.checksum(source, token: token)
    }.value
    guard digest == sha256 else {
      throw ModelFileError("The model checksum does not match the catalog. Restart the download.")
    }
    guard !fileManager.fileExists(atPath: ready.path) else {
      throw ModelFileError("Remove the installed model before replacing it.")
    }
    if source == partial {
      try fileManager.createDirectory(at: verifying, withIntermediateDirectories: true)
      try fileManager.moveItem(at: partial, to: verifyingFile)
    }
    let record = NativeModelFile(id: id, sha256: sha256, bytes: expectedBytes)
    try JSONEncoder().encode(record).write(
      to: verifying.appendingPathComponent("model.json"), options: .atomic)
    try fileManager.moveItem(at: verifying, to: ready)
    return (record, ready.appendingPathComponent("model.gguf").absoluteString)
  }

  func remove(_ id: String) throws {
    let container = try ModelStorage.container(id)
    ModelVerificationProgress.shared.cancel(id)
    try fileManager.removeItem(at: container)
  }

  func storage() throws -> NativeModelStorage {
    let root = try ModelStorage.root()
    let keys: Set<URLResourceKey> = [
      .isDirectoryKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey, .fileSizeKey,
    ]
    var models: [(id: String, bytes: Int64)] = []
    for entry in try fileManager.contentsOfDirectory(
      at: root, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles])
    {
      guard try entry.resourceValues(forKeys: keys).isDirectory == true else { continue }
      var bytes: Int64 = 0
      let files = fileManager.enumerator(
        at: entry, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles])
      while let file = files?.nextObject() as? URL {
        let values = try file.resourceValues(forKeys: keys)
        guard values.isDirectory != true else { continue }
        let size = values.totalFileAllocatedSize ?? values.fileAllocatedSize ?? values.fileSize ?? 0
        bytes += Int64(size)
      }
      if bytes > 0 { models.append((entry.lastPathComponent, bytes)) }
    }
    let capacity = try root.resourceValues(forKeys: [.volumeTotalCapacityKey]).volumeTotalCapacity
    return NativeModelStorage(
      usedBytes: models.reduce(0) { $0 + $1.bytes },
      freeBytes: try ModelStorage.freeBytes(at: root),
      capacityBytes: Int64(capacity ?? 0),
      models: models.sorted { $0.id < $1.id }
    )
  }

  private static func checksum(_ url: URL, token: ModelVerificationToken) throws -> String {
    guard let stream = InputStream(url: url) else {
      throw ModelFileError("The model file could not be opened for verification.")
    }
    stream.open()
    defer { stream.close() }
    var hash = SHA256()
    var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
    while true {
      if token.isCancelled {
        throw ModelFileError("Model verification was cancelled.")
      }
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count >= 0 else {
        throw ModelFileError("The model file could not be read during verification.")
      }
      if count == 0 { break }
      buffer.withUnsafeBytes { hash.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0[..<count])) }
      token.advance(count)
    }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
