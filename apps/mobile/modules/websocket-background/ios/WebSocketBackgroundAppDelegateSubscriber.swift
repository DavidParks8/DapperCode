import ExpoModulesCore
import UIKit

public final class WebSocketBackgroundAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private var backgroundSession: UUID?
  private var taskIdentifier: UIBackgroundTaskIdentifier = .invalid
  private var deadline: Timer?

  public func applicationDidEnterBackground(_ application: UIApplication) {
    guard backgroundSession == nil else { return }
    let expiresAt = Date(timeIntervalSinceNow: 12)
    let session = UUID()
    backgroundSession = session
    let end = { [weak self] in
      guard let self, self.backgroundSession == session else { return }
      self.endBackgroundTask(application)
    }
    taskIdentifier = application.beginBackgroundTask(
      withName: "WebSocket disconnect grace",
      expirationHandler: end
    )
    guard taskIdentifier != .invalid else { return }
    let deadline = Timer(fire: expiresAt, interval: 0, repeats: false) { _ in end() }
    self.deadline = deadline
    // Give the JavaScript 10-second disconnect timer two seconds of scheduling headroom.
    RunLoop.main.add(deadline, forMode: .common)
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    backgroundSession = nil
    endBackgroundTask(application)
  }

  public func applicationWillTerminate(_ application: UIApplication) {
    endBackgroundTask(application)
  }

  private func endBackgroundTask(_ application: UIApplication) {
    deadline?.invalidate()
    deadline = nil
    guard taskIdentifier != .invalid else { return }
    let identifier = taskIdentifier
    taskIdentifier = .invalid
    application.endBackgroundTask(identifier)
  }
}
