import BackgroundTasks
import Foundation
import UIKit

/// Keeps the process running while a local agent turn is in flight, so locking the phone or
/// switching apps does not freeze generation (API 12).
///
/// iOS 26 and later submit a user-visible continued-processing task, which the system presents
/// as a Live Activity the user can cancel. Older systems, and requests the scheduler refuses, fall
/// back to the short `beginBackgroundTask` budget. GPU background execution is never requested:
/// JavaScript moves inference to the CPU while the app is in the background.
@MainActor
final class LocalRunActivity {
  static let shared = LocalRunActivity()

  enum Kind: String {
    case continued
    case background
    case unavailable = "none"
  }

  /// Time JavaScript has to stop the run and release the activity after a continued-processing
  /// task expires or the user cancels it, before the task is completed natively.
  nonisolated static let expirationGrace: TimeInterval = 3
  /// A run holding only the short background budget is told to stop this long before iOS would
  /// suspend the app, so JavaScript can still stop the turn, unload the model, and save.
  nonisolated static let backgroundReserve: TimeInterval = 10
  nonisolated static let backgroundTaskName = "Local agent run"
  nonisolated static let progressUnits: Int64 = 1_000_000_000
  /// Progress approaches completion asymptotically; this many reported steps reach the midpoint.
  nonisolated static let progressHalfSteps: Int64 = 50

  private final class Entry {
    let id: String
    let kind: Kind
    var subtitle: String
    var steps: Int64 = 0
    var identifier: String?
    var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    var task: AnyObject?
    /// The run ended before the scheduler launched the task; complete it on launch.
    var endedBeforeLaunch = false
    var succeeded = false
    var expired = false
    var grace: Timer?

    init(id: String, kind: Kind, subtitle: String) {
      self.id = id
      self.kind = kind
      self.subtitle = subtitle
    }
  }

  var onExpired: ((String) -> Void)?

  private let bundleIdentifier: String?
  private var entries: [String: Entry] = [:]
  /// Scheduler identifiers registered by this process. Registration cannot be undone and a second
  /// registration of the same identifier terminates the app, so identifiers are pooled and reused.
  private var registered: [String] = []
  private var assignments: [String: String] = [:]
  private var continuedUnavailable = false
  private let backgroundTimeRemaining: (() -> TimeInterval)?
  private var deadline: Timer?

  init(
    bundleIdentifier: String? = Bundle.main.bundleIdentifier,
    backgroundTimeRemaining: (() -> TimeInterval)? = nil
  ) {
    self.bundleIdentifier = bundleIdentifier
    self.backgroundTimeRemaining = backgroundTimeRemaining
  }

  var activeCount: Int { entries.count }

  func begin(title: String, subtitle: String) async -> [String: String] {
    let id = UUID().uuidString
    if #available(iOS 26.0, *), await beginContinued(id: id, title: title, subtitle: subtitle) {
      return Self.payload(id, .continued)
    }
    let entry = Entry(id: id, kind: .background, subtitle: subtitle)
    entry.backgroundTask = UIApplication.shared.beginBackgroundTask(
      withName: Self.backgroundTaskName
    ) { [weak self] in
      self?.expire(id)
    }
    guard entry.backgroundTask != .invalid else { return Self.payload(id, .unavailable) }
    entries[id] = entry
    deadline = deadline ?? Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.checkBackgroundDeadline() }
    }
    return Self.payload(id, .background)
  }

  /// Warns runs on the short budget once the remaining background time drops into the reserve.
  /// The task stays held until JavaScript ends the run or the system expiration handler fires.
  func checkBackgroundDeadline() {
    let remaining = backgroundTimeRemaining?() ?? UIApplication.shared.backgroundTimeRemaining
    guard remaining < Self.backgroundReserve else { return }
    for entry in entries.values where entry.kind == .background { warn(entry) }
  }

  func update(_ id: String, subtitle: String) {
    guard let entry = entries[id], !entry.expired else { return }
    entry.steps += 1
    entry.subtitle = subtitle
    if #available(iOS 26.0, *), let task = entry.task as? BGContinuedProcessingTask {
      present(entry, on: task)
    }
  }

  func end(_ id: String, success: Bool) {
    guard let entry = entries[id] else { return }
    if entry.kind == .continued, entry.task == nil {
      // The scheduler has accepted the request but not launched it yet; complete on launch.
      entry.endedBeforeLaunch = true
      entry.succeeded = success
      return
    }
    finish(entry, success: success)
  }

  /// Ends every activity, for a JavaScript runtime that is going away with runs still held.
  func endAll() {
    for entry in Array(entries.values) { finish(entry, success: false) }
  }

  private func finish(_ entry: Entry, success: Bool) {
    entries[entry.id] = nil
    if !entries.values.contains(where: { $0.kind == .background }) {
      deadline?.invalidate()
      deadline = nil
    }
    entry.grace?.invalidate()
    entry.grace = nil
    if let identifier = entry.identifier { assignments[identifier] = nil }
    if #available(iOS 26.0, *), let task = entry.task as? BGContinuedProcessingTask {
      task.expirationHandler = nil
      task.setTaskCompleted(success: success)
    }
    entry.task = nil
    if entry.backgroundTask != .invalid {
      let backgroundTask = entry.backgroundTask
      entry.backgroundTask = .invalid
      UIApplication.shared.endBackgroundTask(backgroundTask)
    }
  }

  private func warn(_ entry: Entry) {
    guard !entry.expired else { return }
    entry.expired = true
    onExpired?(entry.id)
  }

  private func expire(_ id: String) {
    guard let entry = entries[id] else { return }
    if entry.kind == .background {
      warn(entry)
      // The system terminates an app that keeps an expired background task; release it now.
      finish(entry, success: false)
      return
    }
    guard !entry.expired else { return }
    warn(entry)
    entry.grace = Timer.scheduledTimer(withTimeInterval: Self.expirationGrace, repeats: false) {
      [weak self] _ in
      Task { @MainActor in self?.end(id, success: false) }
    }
  }

  @available(iOS 26.0, *)
  private func beginContinued(id: String, title: String, subtitle: String) async -> Bool {
    guard !continuedUnavailable, let identifier = availableIdentifier() else { return false }
    let entry = Entry(id: id, kind: .continued, subtitle: subtitle)
    entry.identifier = identifier
    entries[id] = entry
    assignments[identifier] = id
    let request = BGContinuedProcessingTaskRequest(
      identifier: identifier, title: title, subtitle: subtitle)
    // Never queue: a request that cannot start now would launch after the run has moved on.
    request.strategy = .fail
    do {
      try await Self.submit(request)
      return true
    } catch {
      if let entry = entries[id], entry.task == nil {
        entries[id] = nil
        assignments[identifier] = nil
      }
      if (error as? BGTaskScheduler.Error)?.code == .notPermitted { continuedUnavailable = true }
      return false
    }
  }

  @available(iOS 26.0, *)
  private func availableIdentifier() -> String? {
    if let free = registered.first(where: { assignments[$0] == nil }) { return free }
    guard let bundleIdentifier else { return nil }
    let identifier = "\(bundleIdentifier).localrun.\(registered.count + 1)"
    let accepted = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) {
      [weak self] task in
      Task { @MainActor in self?.launch(identifier, task) }
    }
    guard accepted else {
      // The identifier is not in BGTaskSchedulerPermittedIdentifiers; stop trying.
      continuedUnavailable = true
      return nil
    }
    registered.append(identifier)
    return identifier
  }

  @available(iOS 26.0, *)
  private func launch(_ identifier: String, _ task: BGTask) {
    guard let task = task as? BGContinuedProcessingTask,
      let id = assignments[identifier], let entry = entries[id], entry.task == nil
    else {
      task.setTaskCompleted(success: false)
      return
    }
    entry.task = task
    task.expirationHandler = { [weak self] in
      Task { @MainActor in self?.expire(id) }
    }
    task.progress.totalUnitCount = Self.progressUnits
    present(entry, on: task)
    if entry.endedBeforeLaunch { finish(entry, success: entry.succeeded) }
  }

  @available(iOS 26.0, *)
  private func present(_ entry: Entry, on task: BGContinuedProcessingTask) {
    task.progress.completedUnitCount = Self.progress(steps: entry.steps)
    task.updateTitle(task.title, subtitle: entry.subtitle)
  }

  @available(iOS 26.0, *)
  nonisolated private static func submit(_ request: BGContinuedProcessingTaskRequest) async throws {
    // The scheduler asks callers not to submit from the main thread.
    if #available(iOS 27.0, *) {
      try await BGTaskScheduler.shared.submitTaskRequest(request)
    } else {
      try BGTaskScheduler.shared.submit(request)
    }
  }

  nonisolated static func progress(steps: Int64) -> Int64 {
    let steps = max(0, steps)
    return progressUnits * steps / (steps + progressHalfSteps)
  }

  private static func payload(_ id: String, _ kind: Kind) -> [String: String] {
    ["id": id, "kind": kind.rawValue]
  }
}
