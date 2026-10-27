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

struct ModelFileError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

actor ModelFileStore {
  private let fileManager = FileManager.default

  func paths(_ id: String) throws -> NativeModelPaths {
    let container = try container(id)
    let attributes = try fileManager.attributesOfFileSystem(forPath: container.path)
    guard let free = attributes[.systemFreeSize] as? NSNumber else {
      throw ModelFileError("Available model storage could not be determined.")
    }
    let verification = container.appendingPathComponent("verifying/model.gguf")
    let partial = container.appendingPathComponent("partial.gguf")
    let bytes = try size(verification) ?? size(partial)
    return NativeModelPaths(
      partialURI: partial.absoluteString,
      resumeURI: container.appendingPathComponent("resume.json").absoluteString,
      verificationBytes: bytes, availableBytes: free.int64Value
    )
  }

  func downloaded(_ id: String) throws -> (NativeModelFile, String)? {
    let ready = try container(id).appendingPathComponent("ready", isDirectory: true)
    guard fileManager.fileExists(atPath: ready.path) else { return nil }
    let record = try JSONDecoder().decode(
      NativeModelFile.self, from: Data(contentsOf: ready.appendingPathComponent("model.json"))
    )
    let model = ready.appendingPathComponent("model.gguf")
    guard record.id == id, record.bytes > 0, try size(model) == record.bytes else {
      throw ModelFileError("The downloaded model is incomplete. Remove it and download it again.")
    }
    return (record, model.absoluteString)
  }

  func finalize(_ id: String, sha256: String, expectedBytes: Int64) throws -> (
    NativeModelFile, String
  ) {
    guard expectedBytes > 0, expectedBytes <= 8 * 1024 * 1024 * 1024,
      sha256.utf8.count == 64,
      sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
    else {
      throw ModelFileError("Model verification requires a positive size and a SHA-256 checksum.")
    }
    let container = try container(id)
    let ready = container.appendingPathComponent("ready", isDirectory: true)
    guard !fileManager.fileExists(atPath: ready.path) else {
      throw ModelFileError("Remove the installed model before replacing it.")
    }
    let verifying = container.appendingPathComponent("verifying", isDirectory: true)
    let verifyingFile = verifying.appendingPathComponent("model.gguf")
    let partial = container.appendingPathComponent("partial.gguf")
    let source = fileManager.fileExists(atPath: verifyingFile.path) ? verifyingFile : partial
    guard try size(source) == expectedBytes else {
      throw ModelFileError(
        "The model download size does not match the catalog. Restart the download.")
    }
    guard try checksum(source) == sha256 else {
      throw ModelFileError("The model checksum does not match the catalog. Restart the download.")
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
    let container = try container(id)
    try fileManager.removeItem(at: container)
  }

  private func container(_ id: String) throws -> URL {
    guard id.range(of: #"^[a-z0-9][a-z0-9._-]{0,127}$"#, options: .regularExpression) != nil else {
      throw ModelFileError("Invalid model identity.")
    }
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
    let container = root.appendingPathComponent(id, isDirectory: true)
    try fileManager.createDirectory(at: container, withIntermediateDirectories: true)
    return container
  }

  private func size(_ url: URL) throws -> Int64? {
    do {
      let attributes = try fileManager.attributesOfItem(atPath: url.path)
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

  private func checksum(_ url: URL) throws -> String {
    guard let stream = InputStream(url: url) else {
      throw ModelFileError("The model file could not be opened for verification.")
    }
    stream.open()
    defer { stream.close() }
    var hash = SHA256()
    var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
    while true {
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count >= 0 else {
        throw ModelFileError("The model file could not be read during verification.")
      }
      if count == 0 { break }
      hash.update(data: Data(buffer.prefix(count)))
    }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
