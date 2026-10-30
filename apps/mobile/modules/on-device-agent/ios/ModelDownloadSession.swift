import Foundation

struct NativeModelTransfer: Sendable {
  enum State: String, Sendable {
    case idle, running, paused, completed, failed
  }

  let id: String
  let state: State
  let bytesWritten: Int64
  let totalBytes: Int64
  let resumable: Bool
  let interrupted: Bool
  let error: String?

  var payload: [String: Any] {
    [
      "id": id, "state": state.rawValue, "bytesWritten": bytesWritten, "totalBytes": totalBytes,
      "resumable": resumable, "interrupted": interrupted,
      "error": error.map { $0 as Any } ?? NSNull(),
    ]
  }
}

private struct TransferCheckpoint: Codable {
  var url: String
  var bytesWritten: Int64
  var totalBytes: Int64
  var interrupted: Bool
  var error: String?
}

/// Owns one background URLSession so multi-GB model transfers continue while the app is suspended
/// and can be re-attached after relaunch. Each task's `taskDescription` is its model identity.
///
/// Container layout: `partial.gguf` is a completed transfer awaiting verification,
/// `resume.data` is a paused checkpoint, and `transfer.json` describes the last transfer.
final class ModelDownloadSession: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  static let shared = ModelDownloadSession()
  static let identifier =
    "\(Bundle.main.bundleIdentifier ?? "dev.dappercode.app").on-device-agent.model-downloads"

  private struct Record {
    var task: URLSessionDownloadTask?
    var bytesWritten: Int64
    var totalBytes: Int64
  }

  private let lock = NSLock()
  private var records: [String: Record] = [:]
  // Tasks this process paused or cancelled deliberately; their completion is not an interruption.
  // A paused task may still finish first, so only cancelled tasks discard a completed file.
  private var pausedTasks = Set<Int>()
  private var cancelledTasks = Set<Int>()
  private var completionHandlers: [() -> Void] = []
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
    configuration.isDiscretionary = false
    configuration.sessionSendsLaunchEvents = true
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }()
  private let sessionLock = NSLock()

  private var activeSession: URLSession { sessionLock.withLock { session } }

  func handleBackgroundEvents(_ completion: @escaping () -> Void) {
    lock.withLock { completionHandlers.append(completion) }
    _ = activeSession
  }

  /// Adopts tasks that kept running in the background session while this process was not alive.
  func attach() async -> [NativeModelTransfer] {
    let session = activeSession
    let tasks = await session.allTasks
    // Let already-queued delegate callbacks (for example force-quit cancellations) settle first.
    await withCheckedContinuation { continuation in
      session.delegateQueue.addOperation { continuation.resume() }
    }
    var adopted: [String] = []
    lock.withLock {
      for case let task as URLSessionDownloadTask in tasks {
        guard let id = task.taskDescription,
          task.state == .running || task.state == .suspended,
          !isSettled(task)
        else { continue }
        if let existing = records[id]?.task, existing !== task {
          cancelledTasks.insert(task.taskIdentifier)
          task.cancel()
          continue
        }
        let checkpoint = try? Self.checkpoint(id)
        records[id] = Record(
          task: task, bytesWritten: task.countOfBytesReceived,
          totalBytes: max(task.countOfBytesExpectedToReceive, checkpoint?.totalBytes ?? 0))
        if task.state == .suspended { task.resume() }
        adopted.append(id)
      }
    }
    return adopted.compactMap { try? snapshot($0) }
  }

  func start(_ id: String, url: String, expectedBytes: Int64) throws -> NativeModelTransfer {
    guard let remote = URL(string: url), remote.scheme == "https", remote.host != nil else {
      throw ModelFileError("Model downloads require an HTTPS URL.")
    }
    guard expectedBytes > 0 else {
      throw ModelFileError("Model downloads require a positive size.")
    }
    let container = try ModelStorage.container(id)
    try lock.withLock {
      guard records[id] == nil else {
        throw ModelFileError("This model is already downloading.")
      }
      records[id] = Record(task: nil, bytesWritten: 0, totalBytes: expectedBytes)
    }
    var created: URLSessionDownloadTask?
    do {
      let manager = FileManager.default
      if manager.fileExists(atPath: container.appendingPathComponent("ready").path) {
        throw ModelFileError("This model is already installed. Remove it before downloading again.")
      }
      if manager.fileExists(atPath: container.appendingPathComponent("partial.gguf").path)
        || manager.fileExists(atPath: container.appendingPathComponent("verifying").path)
      {
        throw ModelFileError(
          "Verify the pending model file or remove it before restarting its download.")
      }
      let saved = try Self.resumeData(container, url: url)
      let session = activeSession
      let task: URLSessionDownloadTask
      if let saved {
        task = session.downloadTask(withResumeData: saved.data)
        let origin = task.originalRequest?.url ?? task.currentRequest?.url
        guard origin?.absoluteString == url else {
          task.cancel()
          Self.removeCheckpoint(container)
          throw ModelFileError("Paused download origin is invalid. Restart this download.")
        }
      } else {
        task = session.downloadTask(with: URLRequest(url: remote))
      }
      created = task
      let received = saved?.bytesWritten ?? 0
      task.taskDescription = id
      task.countOfBytesClientExpectsToReceive = max(expectedBytes - received, 0)
      Self.removeCheckpoint(container)
      try Self.writeCheckpoint(
        container,
        TransferCheckpoint(
          url: url, bytesWritten: received, totalBytes: expectedBytes, interrupted: false,
          error: nil))
      lock.withLock {
        records[id] = Record(task: task, bytesWritten: received, totalBytes: expectedBytes)
      }
      task.resume()
      return try snapshot(id)
    } catch {
      lock.withLock {
        if let created { cancelledTasks.insert(created.taskIdentifier) }
        _ = records.removeValue(forKey: id)
      }
      created?.cancel()
      throw error
    }
  }

  func pause(_ id: String) async throws -> NativeModelTransfer {
    let container = try ModelStorage.container(id)
    guard
      let task = lock.withLock({ () -> URLSessionDownloadTask? in
        guard let task = records[id]?.task else { return nil }
        pausedTasks.insert(task.taskIdentifier)
        return task
      })
    else {
      return try snapshot(id)
    }
    let data = await task.cancelByProducingResumeData()
    let record = lock.withLock { records[id] }
    if let data, var checkpoint = try Self.checkpoint(id) {
      checkpoint.bytesWritten = record?.bytesWritten ?? checkpoint.bytesWritten
      checkpoint.interrupted = false
      checkpoint.error = nil
      try data.write(to: container.appendingPathComponent("resume.data"), options: .atomic)
      try Self.writeCheckpoint(container, checkpoint)
    } else if data == nil {
      try? FileManager.default.removeItem(at: container.appendingPathComponent("transfer.json"))
    }
    lock.withLock {
      if records[id]?.task === task { records.removeValue(forKey: id) }
    }
    return try snapshot(id)
  }

  func cancel(_ id: String) async throws {
    let container = try ModelStorage.container(id)
    let session = activeSession
    let tasks = await session.allTasks
    lock.withLock {
      if let task = records.removeValue(forKey: id)?.task {
        cancelledTasks.insert(task.taskIdentifier)
        task.cancel()
      }
      for task in tasks where task.taskDescription == id {
        cancelledTasks.insert(task.taskIdentifier)
        task.cancel()
      }
    }
    Self.removeCheckpoint(container)
    try? FileManager.default.removeItem(at: container.appendingPathComponent("transfer.json"))
  }

  func snapshot(_ id: String) throws -> NativeModelTransfer {
    let container = try ModelStorage.container(id)
    if let record = lock.withLock({ records[id] }) {
      return NativeModelTransfer(
        id: id, state: .running, bytesWritten: record.bytesWritten,
        totalBytes: record.totalBytes, resumable: false, interrupted: false, error: nil)
    }
    let checkpoint = try? Self.checkpoint(id)
    if let bytes = try ModelStorage.size(container.appendingPathComponent("partial.gguf")) {
      return NativeModelTransfer(
        id: id, state: .completed, bytesWritten: bytes, totalBytes: bytes, resumable: false,
        interrupted: false, error: nil)
    }
    let manager = FileManager.default
    if manager.fileExists(atPath: container.appendingPathComponent("resume.data").path) {
      return NativeModelTransfer(
        id: id, state: .paused, bytesWritten: checkpoint?.bytesWritten ?? 0,
        totalBytes: checkpoint?.totalBytes ?? 0, resumable: true,
        interrupted: checkpoint?.interrupted ?? false, error: checkpoint?.error)
    }
    if let legacy = try? Self.legacyResume(container) {
      return NativeModelTransfer(
        id: id, state: .paused, bytesWritten: legacy.bytesWritten, totalBytes: 0, resumable: true,
        interrupted: false, error: nil)
    }
    if let checkpoint {
      return NativeModelTransfer(
        id: id, state: .failed, bytesWritten: checkpoint.bytesWritten,
        totalBytes: checkpoint.totalBytes, resumable: false, interrupted: true,
        error: checkpoint.error ?? "The model download stopped unexpectedly. Restart it.")
    }
    return NativeModelTransfer(
      id: id, state: .idle, bytesWritten: 0, totalBytes: 0, resumable: false, interrupted: false,
      error: nil)
  }

  // MARK: - URLSessionDownloadDelegate

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    guard let id = downloadTask.taskDescription else { return }
    let oversized = lock.withLock { () -> Bool in
      guard !isSettled(downloadTask) else { return false }
      var record =
        records[id]
        ?? Record(task: downloadTask, bytesWritten: 0, totalBytes: totalBytesExpectedToWrite)
      guard record.task == nil || record.task === downloadTask else { return false }
      record.task = downloadTask
      record.bytesWritten = totalBytesWritten
      if totalBytesExpectedToWrite > 0 && record.totalBytes <= 0 {
        record.totalBytes = totalBytesExpectedToWrite
      }
      records[id] = record
      return record.totalBytes > 0 && totalBytesWritten > record.totalBytes
    }
    if oversized {
      fail(downloadTask, id, "The model transfer size does not match the catalog.")
    }
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    guard let id = downloadTask.taskDescription,
      !lock.withLock({ cancelledTasks.contains(downloadTask.taskIdentifier) })
    else { return }
    do {
      if let response = downloadTask.response as? HTTPURLResponse,
        !(200...299).contains(response.statusCode)
      {
        throw ModelFileError("The model server returned HTTP \(response.statusCode).")
      }
      let container = try ModelStorage.container(id)
      let partial = container.appendingPathComponent("partial.gguf")
      try? FileManager.default.removeItem(at: partial)
      try FileManager.default.moveItem(at: location, to: partial)
      Self.removeCheckpoint(container)
      try? FileManager.default.removeItem(at: container.appendingPathComponent("transfer.json"))
    } catch {
      record(failure: error.localizedDescription, for: id)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = task.taskDescription else { return }
    let settled = lock.withLock { () -> Bool in
      let paused = pausedTasks.remove(task.taskIdentifier) != nil
      let settled = cancelledTasks.remove(task.taskIdentifier) != nil || paused
      if records[id]?.task === task && !settled { records.removeValue(forKey: id) }
      return settled
    }
    guard !settled, let error else { return }
    let failure = error as NSError
    if let data = failure.userInfo[NSURLSessionDownloadTaskResumeData] as? Data,
      let container = try? ModelStorage.container(id),
      var checkpoint = try? Self.checkpoint(id)
    {
      checkpoint.bytesWritten = (task as? URLSessionDownloadTask)?.countOfBytesReceived ?? 0
      checkpoint.interrupted = true
      checkpoint.error = failure.localizedDescription
      do {
        try data.write(to: container.appendingPathComponent("resume.data"), options: .atomic)
        try Self.writeCheckpoint(container, checkpoint)
        return
      } catch {}
    }
    record(failure: failure.localizedDescription, for: id)
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let handlers = lock.withLock {
      defer { completionHandlers.removeAll() }
      return completionHandlers
    }
    DispatchQueue.main.async { handlers.forEach { $0() } }
  }

  // MARK: - Checkpoints

  private func isSettled(_ task: URLSessionTask) -> Bool {
    pausedTasks.contains(task.taskIdentifier) || cancelledTasks.contains(task.taskIdentifier)
  }

  private func fail(_ task: URLSessionDownloadTask, _ id: String, _ message: String) {
    lock.withLock {
      cancelledTasks.insert(task.taskIdentifier)
      if records[id]?.task === task { records.removeValue(forKey: id) }
    }
    task.cancel()
    record(failure: message, for: id)
  }

  private func record(failure message: String, for id: String) {
    guard let container = try? ModelStorage.container(id) else { return }
    Self.removeCheckpoint(container)
    var checkpoint =
      (try? Self.checkpoint(id))
      ?? TransferCheckpoint(url: "", bytesWritten: 0, totalBytes: 0, interrupted: false, error: nil)
    checkpoint.error = message
    checkpoint.interrupted = false
    try? Self.writeCheckpoint(container, checkpoint)
  }

  private static func checkpoint(_ id: String) throws -> TransferCheckpoint? {
    let url = try ModelStorage.container(id).appendingPathComponent("transfer.json")
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try JSONDecoder().decode(TransferCheckpoint.self, from: Data(contentsOf: url))
  }

  private static func writeCheckpoint(_ container: URL, _ checkpoint: TransferCheckpoint) throws {
    try JSONEncoder().encode(checkpoint).write(
      to: container.appendingPathComponent("transfer.json"), options: .atomic)
  }

  private static func removeCheckpoint(_ container: URL) {
    for name in ["resume.data", "resume.json"] {
      try? FileManager.default.removeItem(at: container.appendingPathComponent(name))
    }
  }

  private static func resumeData(_ container: URL, url: String) throws -> (
    data: Data, bytesWritten: Int64
  )? {
    let file = container.appendingPathComponent("resume.data")
    if FileManager.default.fileExists(atPath: file.path) {
      let checkpoint = try? JSONDecoder().decode(
        TransferCheckpoint.self,
        from: Data(contentsOf: container.appendingPathComponent("transfer.json")))
      guard checkpoint == nil || checkpoint?.url == url else {
        removeCheckpoint(container)
        throw ModelFileError("Paused download origin is invalid. Restart this download.")
      }
      return (try Data(contentsOf: file), checkpoint?.bytesWritten ?? 0)
    }
    guard let legacy = try legacyResume(container) else { return nil }
    guard legacy.url == url else {
      removeCheckpoint(container)
      throw ModelFileError("Paused download origin is invalid. Restart this download.")
    }
    return (legacy.data, legacy.bytesWritten)
  }

  /// Reads a checkpoint written by the earlier JavaScript transfer implementation.
  private static func legacyResume(_ container: URL) throws -> (
    url: String, data: Data, bytesWritten: Int64
  )? {
    let file = container.appendingPathComponent("resume.json")
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    guard
      let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
      let task = saved["task"] as? [String: Any],
      let url = task["url"] as? String,
      task["isDirectory"] as? Bool == false,
      (task["headers"] as? [String: Any])?.isEmpty ?? true,
      let encoded = task["resumeData"] as? String,
      let data = Data(base64Encoded: encoded),
      let bytes = saved["bytesWritten"] as? NSNumber
    else {
      throw ModelFileError("Paused download data is damaged. Restart this model download.")
    }
    return (url, data, bytes.int64Value)
  }
}
