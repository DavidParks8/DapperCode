import ExpoModulesCore

/// Recreates the model download session when iOS relaunches the app to deliver transfer events.
public final class ModelDownloadAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    guard identifier == ModelDownloadSession.identifier else {
      completionHandler()
      return
    }
    ModelDownloadSession.shared.handleBackgroundEvents(completionHandler)
  }
}
