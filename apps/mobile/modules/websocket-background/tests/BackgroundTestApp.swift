import UIKit

private func check(_ condition: Bool, _ message: String) {
  guard condition else {
    print("WEBSOCKET_BACKGROUND_NATIVE_FAIL: \(message)")
    exit(1)
  }
  print("PASS: \(message)")
}

// Observe the real UIApplication budget, with controlled denial/expiration fault injection.
final class ObservedApplication: UIApplication {
  var attempts = 0
  var endings = 0
  var tasks: [UIBackgroundTaskIdentifier: @MainActor @Sendable () -> Void] = [:]
  var denyNext = false
  var onEnd: (() -> Void)?

  override func beginBackgroundTask(
    withName taskName: String?,
    expirationHandler handler: (@MainActor @Sendable () -> Void)? = nil
  ) -> UIBackgroundTaskIdentifier {
    guard taskName == "WebSocket disconnect grace" else {
      return super.beginBackgroundTask(withName: taskName, expirationHandler: handler)
    }
    attempts += 1
    if denyNext {
      denyNext = false
      return .invalid
    }
    let identifier = super.beginBackgroundTask(withName: taskName, expirationHandler: handler)
    check(identifier != .invalid, "simulator grants the requested native background task")
    tasks[identifier] = handler
    return identifier
  }

  override func endBackgroundTask(_ identifier: UIBackgroundTaskIdentifier) {
    if tasks.removeValue(forKey: identifier) != nil {
      endings += 1
      onEnd?()
    }
    super.endBackgroundTask(identifier)
  }
}

final class BackgroundTestApp: UIResponder, UIApplicationDelegate {
  let isBackgroundHost = CommandLine.arguments.contains("--background-host")
  var window: UIWindow?
  let subscriber = WebSocketBackgroundAppDelegateSubscriber()
  var ready = false
  var cycle = 0
  var backgroundStart: TimeInterval?
  var callbacks: [Timer] = []
  var tenSecondCallbackRan = false
  var naturalExpirationRan = false

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    setbuf(stdout, nil)
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = UIViewController()
    window.makeKeyAndVisible()
    self.window = window
    return true
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    guard !isBackgroundHost else { return }
    let app = application as! ObservedApplication
    subscriber.applicationDidBecomeActive(app)
    if !ready {
      testFaults(app)
      ready = true
      print("NATIVE_READY")
      return
    }
    guard let start = backgroundStart else { return }
    callbacks.forEach { $0.invalidate() }
    callbacks.removeAll()
    app.onEnd = nil
    check(app.tasks.isEmpty, "foreground releases the native task immediately")
    let elapsed = ProcessInfo.processInfo.systemUptime - start
    if cycle == 1 {
      check(elapsed >= 6 && elapsed < 10, "rapid return occurs after 6 but before 10 seconds")
      check(!tenSecondCallbackRan, "rapid return cancels the pending ten-second test callback")
    } else {
      check(tenSecondCallbackRan && naturalExpirationRan, "long background completes callback and releases budget")
    }
    backgroundStart = nil
    print("NATIVE_FOREGROUND_\(cycle)")
    if cycle == 2 {
      testFaults(app)
      print("WEBSOCKET_BACKGROUND_NATIVE_PASS")
      exit(0)
    }
  }

  func applicationDidEnterBackground(_ application: UIApplication) {
    guard !isBackgroundHost else { return }
    let app = application as! ObservedApplication
    cycle += 1
    backgroundStart = ProcessInfo.processInfo.systemUptime
    tenSecondCallbackRan = false
    naturalExpirationRan = false
    subscriber.applicationDidEnterBackground(app)
    check(app.tasks.count == 1, "real background transition acquires exactly one task")
    let attempts = app.attempts
    print("NATIVE_BACKGROUND_\(cycle) time=\(ProcessInfo.processInfo.systemUptime)")
    schedule(after: 4) { [self] in
      subscriber.applicationDidEnterBackground(app)
      check(app.attempts == attempts && app.tasks.count == 1, "duplicate background does not reacquire or extend task")
    }
    schedule(after: 6) { [self] in
      check(app.applicationState == .background && app.tasks.count == 1, "app still executes in background at six seconds")
      print("NATIVE_SIX_SECONDS elapsed=\(ProcessInfo.processInfo.systemUptime - backgroundStart!)")
    }
    schedule(after: 10) { [self] in
      check(app.applicationState == .background && app.tasks.count == 1, "ten-second callback executes while background task is held")
      tenSecondCallbackRan = true
      print("NATIVE_TEN_SECONDS")
    }
    if cycle == 2 {
      app.onEnd = { [self] in
        let elapsed = ProcessInfo.processInfo.systemUptime - backgroundStart!
        check(elapsed >= 12 && elapsed < 13.5, "native budget ends at twelve seconds despite repeated notification")
        check(tenSecondCallbackRan, "ten-second callback precedes native budget release")
        check(app.tasks.isEmpty, "deadline releases the sole native task")
        naturalExpirationRan = true
        print("NATIVE_DEADLINE elapsed=\(elapsed)")
      }
    }
  }

  private func schedule(after seconds: Double, _ body: @escaping () -> Void) {
    let callback = Timer(timeInterval: seconds, repeats: false) { _ in body() }
    callbacks.append(callback)
    RunLoop.main.add(callback, forMode: .common)
  }

  private func testFaults(_ app: ObservedApplication) {
    let attempts = app.attempts
    let endings = app.endings
    subscriber.applicationDidBecomeActive(app)
    check(app.tasks.isEmpty && app.endings == endings, "initial foreground does not release an invalid task")
    subscriber.applicationDidEnterBackground(app)
    let staleExpiration = app.tasks.values.first!
    subscriber.applicationDidEnterBackground(app)
    check(app.attempts == attempts + 1, "repeated background notification starts no second task")
    subscriber.applicationDidBecomeActive(app)
    subscriber.applicationDidBecomeActive(app)
    check(app.tasks.isEmpty && app.endings == endings + 1, "repeated foreground releases exactly once")
    subscriber.applicationDidEnterBackground(app)
    staleExpiration()
    check(app.tasks.count == 1, "old expiration cannot release a later background session")
    let expiration = app.tasks.values.first!
    expiration()
    expiration()
    check(app.tasks.isEmpty && app.endings == endings + 2, "OS expiration releases exactly once")
    subscriber.applicationDidEnterBackground(app)
    check(app.attempts == attempts + 2, "expired budget cannot restart while still background")
    subscriber.applicationDidBecomeActive(app)
    app.denyNext = true
    subscriber.applicationDidEnterBackground(app)
    subscriber.applicationDidEnterBackground(app)
    check(app.tasks.isEmpty && app.attempts == attempts + 3, "OS denial remains best effort without retry loops")
    subscriber.applicationDidBecomeActive(app)
    check(app.endings == endings + 2, "denied budget does not end an invalid task")
    subscriber.applicationDidEnterBackground(app)
    check(app.tasks.count == 1, "new background recovers after denial")
    subscriber.applicationWillTerminate(app)
    check(app.tasks.isEmpty && app.endings == endings + 3, "termination releases an outstanding task")
    subscriber.applicationDidBecomeActive(app)
  }
}

@main
struct BackgroundTestMain {
  static func main() {
    UIApplicationMain(
      CommandLine.argc,
      CommandLine.unsafeArgv,
      NSStringFromClass(ObservedApplication.self),
      NSStringFromClass(BackgroundTestApp.self)
    )
  }
}
