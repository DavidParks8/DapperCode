import BackgroundTasks
import Security
import UIKit

private func check(_ condition: Bool, _ message: String) {
  guard condition else {
    print("LOCAL_RUN_NATIVE_FAIL: \(message)")
    exit(1)
  }
  print("PASS: \(message)")
}

// Observe the real UIApplication budget, with controlled denial and expiration fault injection.
final class ObservedApplication: UIApplication {
  var attempts = 0
  var endings = 0
  var tasks: [UIBackgroundTaskIdentifier: @MainActor @Sendable () -> Void] = [:]
  var denyNext = false

  override func beginBackgroundTask(
    withName taskName: String?,
    expirationHandler handler: (@MainActor @Sendable () -> Void)? = nil
  ) -> UIBackgroundTaskIdentifier {
    guard taskName == LocalRunActivity.backgroundTaskName else {
      return super.beginBackgroundTask(withName: taskName, expirationHandler: handler)
    }
    attempts += 1
    if denyNext {
      denyNext = false
      return .invalid
    }
    let identifier = super.beginBackgroundTask(withName: taskName, expirationHandler: handler)
    check(identifier != .invalid, "simulator grants the fallback background task")
    tasks[identifier] = handler
    return identifier
  }

  override func endBackgroundTask(_ identifier: UIBackgroundTaskIdentifier) {
    if tasks.removeValue(forKey: identifier) != nil { endings += 1 }
    super.endBackgroundTask(identifier)
  }
}

@MainActor
final class LocalRunTestApp: UIResponder, UIApplicationDelegate {
  let isBackgroundHost = CommandLine.arguments.contains("--background-host")
  var ready = false
  var held: String?
  var heldKind = ""
  var backgroundStart: TimeInterval?
  var warnedAt: TimeInterval?
  var ticker: Timer?
  var released = false

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    setbuf(stdout, nil)
    return true
  }

  func application(
    _ application: UIApplication,
    configurationForConnecting session: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default", sessionRole: session.role)
    configuration.delegateClass = LocalRunTestScene.self
    return configuration
  }

  func sceneDidBecomeActive() {
    guard !isBackgroundHost else { return }
    if !ready {
      ready = true
      Task { await self.runForegroundChecks() }
      return
    }
    guard backgroundStart != nil else { return }
    ticker?.invalidate()
    check(released, "the held run is released before the app returns")
    check(LocalRunActivity.shared.activeCount == 0, "no activity outlives its run")
    print("LOCAL_RUN_NATIVE_PASS")
    exit(0)
  }

  func sceneDidEnterBackground() {
    guard !isBackgroundHost, held != nil, backgroundStart == nil else { return }
    let start = ProcessInfo.processInfo.systemUptime
    backgroundStart = start
    print("NATIVE_BACKGROUND kind=\(heldKind)")
    // Simulates the JavaScript agent loop: keep working while backgrounded, then settle.
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
      Task { @MainActor in self.tick(start: start) }
    }
  }

  /// A continued run settles on its own; a run on the short budget works until it is warned, then
  /// takes a moment to stop, unload, and save, as JavaScript does.
  private func tick(start: TimeInterval) {
    let elapsed = ProcessInfo.processInfo.systemUptime - start
    let state = UIApplication.shared.applicationState
    print("NATIVE_TICK elapsed=\(Int(elapsed)) background=\(state == .background)")
    guard !released, let id = held else { return }
    let release: TimeInterval
    if heldKind == "continued" {
      release = 45
    } else if let warnedAt {
      release = warnedAt + 2
    } else {
      return
    }
    guard elapsed >= release else { return }
    check(state == .background, "the run kept executing in the background until it settled")
    check(LocalRunActivity.shared.activeCount == 1, "the run still held its activity when it settled")
    LocalRunActivity.shared.end(id, success: heldKind == "continued")
    released = true
    check(LocalRunActivity.shared.activeCount == 0, "ending the settled run releases the activity")
    print("NATIVE_RELEASED elapsed=\(Int(elapsed))")
  }

  private func warned(_ id: String) {
    guard id == held, warnedAt == nil else { return }
    check(backgroundStart != nil, "no run is warned while the app is active")
    let elapsed = ProcessInfo.processInfo.systemUptime - (backgroundStart ?? 0)
    let remaining = UIApplication.shared.backgroundTimeRemaining
    warnedAt = elapsed
    print("NATIVE_DEADLINE elapsed=\(Int(elapsed)) remaining=\(Int(remaining))")
    check(heldKind == "background", "only a run on the short budget is warned before its deadline")
    check(
      UIApplication.shared.applicationState == .background && remaining > 5,
      "the short budget warns the run while background time remains")
  }

  private func runForegroundChecks() async {
    let app = UIApplication.shared as! ObservedApplication

    check(LocalRunActivity.progress(steps: 0) == 0, "progress starts empty")
    check(
      LocalRunActivity.progress(steps: LocalRunActivity.progressHalfSteps)
        == LocalRunActivity.progressUnits / 2,
      "progress reaches its midpoint at the configured step count")
    check(
      LocalRunActivity.progress(steps: 10_000) < LocalRunActivity.progressUnits
        && LocalRunActivity.progress(steps: 10_000) > LocalRunActivity.progress(steps: 9_999),
      "progress keeps advancing without ever reporting completion")

    let locked = GitCredentialStore.unavailable(errSecInteractionNotAllowed).localizedDescription
    check(
      locked == "[ondevice:CREDENTIAL_UNAVAILABLE] Unlock this iPhone to use your saved Git credentials.",
      "a locked Keychain asks the user to unlock instead of signing in again")
    let missing = GitCredentialStore.unavailable(errSecItemNotFound).localizedDescription
    check(
      missing.hasPrefix("[ondevice:CREDENTIAL_UNAVAILABLE] Git credentials are unavailable. Sign in again"),
      "a missing Keychain item still asks the user to sign in again")

    // Without a scheduler identifier the run falls back to the short background budget.
    let fallback = LocalRunActivity(bundleIdentifier: nil)
    var expired: [String] = []
    fallback.onExpired = { expired.append($0) }
    let first = await fallback.begin(title: "Local agent", subtitle: "Preparing")
    check(first["kind"] == "background" && app.tasks.count == 1, "fallback holds one background task")
    fallback.update(first["id"]!, subtitle: "Generating")
    fallback.end(first["id"]!, success: true)
    check(app.tasks.isEmpty && app.endings == 1, "ending the run releases the background task")
    fallback.end(first["id"]!, success: true)
    check(app.endings == 1 && fallback.activeCount == 0, "a stale end is ignored")

    app.denyNext = true
    let denied = await fallback.begin(title: "Local agent", subtitle: "Preparing")
    check(denied["kind"] == "none" && fallback.activeCount == 0, "a denied budget holds nothing")
    fallback.end(denied["id"]!, success: false)
    check(app.endings == 1, "ending a run that holds nothing does not touch UIKit")

    let expiring = await fallback.begin(title: "Local agent", subtitle: "Preparing")
    let handler = app.tasks.values.first
    check(expiring["kind"] == "background" && handler != nil, "a second run acquires a new task")
    handler?()
    check(expired == [expiring["id"]!], "expiration is reported with the run's activity id")
    check(
      app.tasks.isEmpty && app.endings == 2 && fallback.activeCount == 0,
      "an expired background task is released before the system terminates the app")
    fallback.end(expiring["id"]!, success: false)
    check(app.endings == 2, "the late end after expiration is ignored")

    // A run on the short budget is warned before iOS would suspend the app, and keeps its task
    // until JavaScript has stopped the turn and unloaded the model.
    var remaining = TimeInterval.greatestFiniteMagnitude
    let timed = LocalRunActivity(bundleIdentifier: nil, backgroundTimeRemaining: { remaining })
    var warned: [String] = []
    timed.onExpired = { warned.append($0) }
    let timedRun = await timed.begin(title: "Local agent", subtitle: "Preparing")
    timed.checkBackgroundDeadline()
    remaining = LocalRunActivity.backgroundReserve + 1
    timed.checkBackgroundDeadline()
    check(warned.isEmpty, "a run is not warned while the app is active or enough time remains")
    remaining = LocalRunActivity.backgroundReserve - 1
    timed.checkBackgroundDeadline()
    timed.checkBackgroundDeadline()
    check(warned == [timedRun["id"]!], "a run nearing the end of the short budget is warned once")
    check(
      app.tasks.count == 1 && timed.activeCount == 1,
      "the warned run keeps its task so JavaScript can unload the model")
    timed.end(timedRun["id"]!, success: false)
    check(app.tasks.isEmpty && app.endings == 3, "JavaScript's release ends the warned task")
    let late = await timed.begin(title: "Local agent", subtitle: "Preparing")
    timed.checkBackgroundDeadline()
    app.tasks.values.first?()
    check(
      warned == [timedRun["id"]!, late["id"]!] && app.tasks.isEmpty && timed.activeCount == 0,
      "the system's expiration after a warning releases the task without warning again")

    // A destroyed module can never hear from its JavaScript runtime again.
    let abandoned = LocalRunActivity(bundleIdentifier: nil)
    _ = await abandoned.begin(title: "Local agent", subtitle: "Preparing")
    _ = await abandoned.begin(title: "Local agent", subtitle: "Preparing")
    abandoned.endAll()
    check(
      app.tasks.isEmpty && abandoned.activeCount == 0, "a destroyed module releases every run it held")

    if #available(iOS 26.0, *) {
      // An identifier outside BGTaskSchedulerPermittedIdentifiers is refused, never queued.
      let unpermitted = LocalRunActivity(bundleIdentifier: "dev.dappercode.unpermitted")
      let refused = await unpermitted.begin(title: "Local agent", subtitle: "Preparing")
      check(refused["kind"] == "background", "an unpermitted identifier falls back to a background task")
      unpermitted.end(refused["id"]!, success: false)
      let again = await unpermitted.begin(title: "Local agent", subtitle: "Preparing")
      check(again["kind"] == "background", "a refused scheduler is not retried")
      unpermitted.end(again["id"]!, success: false)
      check(app.tasks.isEmpty, "refused runs release their fallback tasks")
    }

    // The production path: permitted identifier from the bundle, reused across runs.
    let attempts = app.attempts
    let warmup = await LocalRunActivity.shared.begin(title: "Local agent", subtitle: "Preparing")
    LocalRunActivity.shared.end(warmup["id"]!, success: true)
    let run = await LocalRunActivity.shared.begin(title: "Local agent", subtitle: "Preparing")
    let kind = run["kind"] ?? ""
    var scheduler = "unsupported"
    if #available(iOS 26.0, *) {
      let available = await continuedProcessingAvailable()
      scheduler = available ? "available" : "unavailable"
      if available {
        check(kind == "continued", "iOS 26 holds a continued-processing task for the run")
        check(app.attempts == attempts, "continued processing does not consume the short budget")
      } else {
        check(kind == "background", "without a scheduler the run holds the short background budget")
        check(app.attempts == attempts + 2, "each run fell back to its own background task")
      }
    } else {
      check(kind == "background", "older systems hold the short background budget")
    }
    check(LocalRunActivity.shared.activeCount == 1, "exactly one activity is held for the run")
    for step in 1...5 { LocalRunActivity.shared.update(run["id"]!, subtitle: "Generating \(step)") }
    LocalRunActivity.shared.onExpired = { [weak self] id in self?.warned(id) }
    held = run["id"]
    heldKind = kind
    print("NATIVE_READY kind=\(kind) scheduler=\(scheduler)")
  }
}

/// The simulator has no BGTaskScheduler, so every submission fails there. Probe the platform with an
/// identifier under the same permitted wildcard, so a missing Info.plist entry still fails the test.
@available(iOS 26.0, *)
@MainActor
private func continuedProcessingAvailable() async -> Bool {
  let identifier = "\(Bundle.main.bundleIdentifier!).localrun.probe"
  let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) {
    task in task.setTaskCompleted(success: true)
  }
  check(registered, "BGTaskSchedulerPermittedIdentifiers permits the run identifiers")
  let request = BGContinuedProcessingTaskRequest(
    identifier: identifier, title: "Local agent", subtitle: "Checking")
  request.strategy = .fail
  do {
    if #available(iOS 27.0, *) {
      try await BGTaskScheduler.shared.submitTaskRequest(request)
    } else {
      try BGTaskScheduler.shared.submit(request)
    }
    return true
  } catch {
    check(
      (error as? BGTaskScheduler.Error)?.code == .unavailable,
      "the scheduler refuses continued processing only because this platform lacks it")
    return false
  }
}

final class LocalRunTestScene: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions
  ) {
    guard let scene = scene as? UIWindowScene else { return }
    window = UIWindow(windowScene: scene)
    window?.rootViewController = UIViewController()
    window?.makeKeyAndVisible()
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? LocalRunTestApp)?.sceneDidBecomeActive()
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? LocalRunTestApp)?.sceneDidEnterBackground()
  }
}

@main
enum LocalRunTestMain {
  @MainActor static func main() {
    UIApplicationMain(
      CommandLine.argc, CommandLine.unsafeArgv,
      NSStringFromClass(ObservedApplication.self), NSStringFromClass(LocalRunTestApp.self))
  }
}
