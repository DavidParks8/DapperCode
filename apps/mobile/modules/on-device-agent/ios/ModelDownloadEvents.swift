import Foundation
import os

/// Entry point for the app delegate when iOS relaunches the app to deliver model-transfer events.
///
/// The `withOnDeviceAgentNative` config plugin calls this from `AppDelegate` before Expo's
/// aggregated subscriber callback. Expo only calls the system completion handler after every
/// responding subscriber completes, and in Expo SDK 57 neither expo-file-system's
/// `FileSystemBackgroundSessionHandler` (it keeps handlers for identifiers it does not own) nor
/// `EXLegacyAppDelegateWrapper` (it never completes with zero legacy delegates) ever does for this
/// session. Taking the system handler directly guarantees iOS learns that event handling finished.
public enum ModelDownloadEvents {
  private static let log = Logger(subsystem: "dev.dappercode.on-device-agent", category: "downloads")

  /// Returns false when `identifier` belongs to another session, which Expo should handle.
  public static func handle(_ identifier: String, completionHandler: @escaping () -> Void) -> Bool {
    guard identifier == ModelDownloadSession.identifier else { return false }
    ModelDownloadSession.shared.handleBackgroundEvents {
      completionHandler()
      log.notice("MODEL_DOWNLOAD_EVENTS_COMPLETED system completion handler called")
    }
    return true
  }
}
