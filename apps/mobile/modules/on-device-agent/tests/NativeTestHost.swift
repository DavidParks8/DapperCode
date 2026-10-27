import Foundation
import UIKit

final class NativeTestApp: UIResponder, UIApplicationDelegate {
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
    configuration.delegateClass = NativeTestScene.self
    return configuration
  }
}

final class NativeTestScene: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions
  ) {
    guard let scene = scene as? UIWindowScene else {
      print("NATIVE_TEST_FAIL: Expected a window scene.")
      exit(1)
    }
    window = UIWindow(windowScene: scene)
    window?.rootViewController = UIViewController()
    window?.makeKeyAndVisible()
    Task {
      do {
        try await runNativeGate()
        exit(0)
      } catch {
        print("NATIVE_TEST_FAIL: \(error.localizedDescription)")
        exit(1)
      }
    }
  }
}

@main
enum NativeTestMain {
  @MainActor static func main() {
    UIApplicationMain(
      CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(NativeTestApp.self))
  }
}
