import CryptoKit
import Foundation

private struct GateError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

private func check(_ condition: Bool, _ name: String) throws {
  guard condition else { throw GateError(name) }
  print("PASS: \(name)")
}

private func rejected(_ name: String, containing: String, _ action: () async throws -> Void)
  async throws
{
  do {
    try await action()
  } catch {
    try check(error.localizedDescription.contains(containing), name)
    return
  }
  throw GateError("\(name): operation unexpectedly succeeded.")
}

private func checksum(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func runNativeGate() async throws {
  let memory = try NativeMemory.snapshot()
  guard let physical = memory["physicalBytes"] as? Double,
    let available = memory["availableBytes"] as? Double
  else {
    throw GateError("Native memory measurements are missing.")
  }
  try check(
    physical > 0 && available > 0 && available <= physical,
    "simulator memory uses measured host headroom")
  try check(
    memory["isSimulator"] as? Bool == true, "simulator memory is not presented as a phone budget")
  let store = ModelFileStore()
  for id in ["../outside", ".hidden", "path/model", "UPPERCASE", "bad\0name"] {
    try await rejected(
      "invalid model identity is rejected: \(id.debugDescription)",
      containing: "Invalid model identity"
    ) {
      _ = try await store.paths(id)
    }
  }
  let id = "native-model-test"
  let paths = try await store.paths(id)
  guard let partial = URL(string: paths.partialURI), partial.isFileURL else {
    throw GateError("The model staging path is not a file URI.")
  }
  try check(
    paths.verificationBytes == nil && paths.availableBytes > 0,
    "model staging reports real disk headroom")
  let modelRoot = partial.deletingLastPathComponent().deletingLastPathComponent()
  let resources = try modelRoot.resourceValues(forKeys: [.isExcludedFromBackupKey])
  try check(
    resources.isExcludedFromBackup == true, "downloaded weights are excluded from device backups")
  let data = Data("GGUF native test data".utf8)
  try data.write(to: partial)
  try check(try await store.downloaded(id) == nil, "unverified downloads never appear installed")
  try await rejected("incorrect model sizes are refused", containing: "size does not match") {
    _ = try await store.finalize(id, sha256: checksum(data), expectedBytes: Int64(data.count + 1))
  }
  try check(
    try await store.paths(id).verificationBytes == nil,
    "a size mismatch discards the staged download")
  try data.write(to: partial)
  try await rejected("incorrect model checksums are refused", containing: "checksum does not match")
  {
    _ = try await store.finalize(
      id, sha256: String(repeating: "0", count: 64), expectedBytes: Int64(data.count))
  }
  try check(
    try await store.downloaded(id) == nil, "failed verification cannot create a ready record")
  try check(
    try await store.paths(id).verificationBytes == nil,
    "a checksum mismatch discards the staged download instead of re-verifying it later")
  try data.write(to: partial)
  let completed = try await store.finalize(
    id, sha256: checksum(data), expectedBytes: Int64(data.count))
  guard let readyURL = URL(string: completed.1) else { throw GateError("Invalid ready model URI.") }
  try check(try Data(contentsOf: readyURL) == data, "verified model bytes are published intact")
  try check(
    completed.0.sha256 == checksum(data) && completed.0.bytes == data.count,
    "ready metadata records exact verified identity")
  try check(
    !FileManager.default.fileExists(atPath: partial.path),
    "atomic publication consumes the staging file")
  let restored = try await ModelFileStore().downloaded(id)
  try check(
    restored?.0.sha256 == checksum(data), "verified models remain ready after a new store instance")
  try await rejected(
    "installed files cannot be overwritten in place", containing: "Remove the installed model"
  ) {
    _ = try await store.finalize(id, sha256: checksum(data), expectedBytes: Int64(data.count))
  }
  let recoveryID = "native-model-recovery"
  let recoveryPaths = try await store.paths(recoveryID)
  guard let recoveryPartial = URL(string: recoveryPaths.partialURI) else {
    throw GateError("Invalid recovery URI.")
  }
  let verifying = recoveryPartial.deletingLastPathComponent().appendingPathComponent(
    "verifying", isDirectory: true)
  try FileManager.default.createDirectory(at: verifying, withIntermediateDirectories: false)
  try data.write(to: verifying.appendingPathComponent("model.gguf"))
  let afterRestart = ModelFileStore()
  try check(
    try await afterRestart.paths(recoveryID).verificationBytes == Int64(data.count),
    "interrupted verification is discoverable after restart")
  try check(
    try await afterRestart.downloaded(recoveryID) == nil,
    "interrupted publication is not treated as ready")
  _ = try await afterRestart.finalize(
    recoveryID, sha256: checksum(data), expectedBytes: Int64(data.count))
  try check(
    try await afterRestart.downloaded(recoveryID) != nil,
    "interrupted publication can finish without a new download")
  let largeID = "native-model-streaming"
  let largePaths = try await store.paths(largeID)
  guard let largePartial = URL(string: largePaths.partialURI) else {
    throw GateError("Invalid streaming URI.")
  }
  let largeData = Data(repeating: 0x35, count: 3 * 1024 * 1024 + 7)
  try largeData.write(to: largePartial)
  let largeResult = try await store.finalize(
    largeID, sha256: checksum(largeData), expectedBytes: Int64(largeData.count))
  try check(
    largeResult.0.bytes == largeData.count && largeResult.0.sha256 == checksum(largeData),
    "streaming verification spans multiple bounded chunks")
  try await verificationProgressAndCancellation(store)
  let storage = try await store.storage()
  try check(
    storage.usedBytes >= Int64(largeData.count) && storage.freeBytes > 0
      && storage.capacityBytes >= storage.freeBytes
      && storage.models.contains { $0.id == largeID && $0.bytes >= Int64(largeData.count) },
    "storage overview reports model usage and free space")
  try await store.remove(id)
  try check(try await store.downloaded(id) == nil, "model deletion removes ready metadata and data")
  try check(
    try await store.downloaded(recoveryID) != nil, "model deletion preserves other model identities"
  )
  let documents = RuntimeDocumentStore()
  try check(try await documents.read("preferences.json") == nil, "absent runtime state is explicit")
  try await documents.write("preferences.json", content: #"{"version":1,"draft":"offline"}"#)
  try await documents.write("thread-fixture.json", content: "first")
  try await documents.write("thread-fixture.json", content: "second")
  try check(
    try await RuntimeDocumentStore().read("thread-fixture.json") == "second",
    "runtime replacements are durable across store instances")
  try check(
    try await documents.names(prefix: "thread-") == ["thread-fixture.json"],
    "runtime enumeration is prefix-scoped")
  try await rejected("runtime traversal is rejected", containing: "Invalid local runtime document") {
    _ = try await documents.read("../outside")
  }
  try await rejected("oversized runtime writes are refused", containing: "exceeds 8 MiB") {
    try await documents.write("thread-fixture.json", content: String(repeating: "x", count: 8 * 1024 * 1024 + 1))
  }
  try check(try await documents.read("thread-fixture.json") == "second", "rejected writes preserve existing runtime state")
  try await documents.remove("thread-fixture.json")
  try await documents.remove("thread-fixture.json")
  try check(try await documents.read("thread-fixture.json") == nil, "runtime removal is idempotent")
  try check(try await documents.read("preferences.json") != nil, "runtime removal preserves other documents")
  print("NATIVE_MODEL_FILES_PASS")
}

private func verificationProgressAndCancellation(_ store: ModelFileStore) async throws {
  let id = "native-model-verification-cancel"
  guard let partial = URL(string: try await store.paths(id).partialURI) else {
    throw GateError("Invalid verification URI.")
  }
  let chunk = Data(repeating: 0x42, count: 8 * 1024 * 1024)
  FileManager.default.createFile(atPath: partial.path, contents: nil)
  let handle = try FileHandle(forWritingTo: partial)
  for _ in 0..<128 { try handle.write(contentsOf: chunk) }
  try handle.close()
  let bytes = Int64(chunk.count * 128)
  let verification = Task {
    try await store.finalize(id, sha256: String(repeating: "a", count: 64), expectedBytes: bytes)
  }
  var progress: [String: Any] = [:]
  for _ in 0..<5_000 {
    progress = ModelVerificationProgress.shared.snapshot(id)
    if progress["active"] as? Bool == true, (progress["completed"] as? Int64 ?? 0) > 0 { break }
    try await Task.sleep(nanoseconds: 1_000_000)
  }
  try check(
    progress["active"] as? Bool == true && progress["total"] as? Int64 == bytes
      && (progress["completed"] as? Int64 ?? 0) > 0,
    "verification reports hashed bytes while running")
  _ = try await store.paths("native-model-other")
  try check(
    ModelVerificationProgress.shared.snapshot(id)["active"] as? Bool == true,
    "other models' file operations are not blocked by hashing")
  ModelVerificationProgress.shared.cancel(id)
  do {
    _ = try await verification.value
    throw GateError("Cancelled verification unexpectedly completed.")
  } catch let error as ModelFileError {
    try check(
      error.localizedDescription.contains("cancelled"), "verification stops cooperatively on cancel")
  }
  try check(
    ModelVerificationProgress.shared.snapshot(id)["active"] as? Bool == false,
    "cancelled verification clears its progress")
  try check(
    try await store.paths(id).verificationBytes == bytes,
    "cancelled verification keeps the staged download for a later retry")
  try await store.remove(id)
}
