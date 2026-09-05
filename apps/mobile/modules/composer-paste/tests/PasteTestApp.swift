import UIKit

@main
final class PasteTestApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    let controller = UIViewController()
    window.rootViewController = controller
    window.makeKeyAndVisible()
    self.window = window
    Task { @MainActor in
      do {
        try await test(in: controller.view)
        print("COMPOSER_PASTE_NATIVE_PASS")
        exit(0)
      } catch {
        print("COMPOSER_PASTE_NATIVE_FAIL: \(error)")
        exit(1)
      }
    }
    return true
  }

  func check(_ condition: Bool, _ message: String) throws {
    guard condition else { throw NSError(domain: message, code: 1) }
    print("PASS: \(message)")
  }

  @MainActor
  func waitFor(_ condition: () -> Bool) async throws {
    for _ in 0..<100 {
      if condition() { return }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    throw NSError(domain: "Timed out waiting for paste", code: 1)
  }

  @MainActor
  func test(in parent: UIView) async throws {
    let input = UITextView(frame: CGRect(x: 20, y: 100, width: 300, height: 100))
    parent.addSubview(input)
    input.becomeFirstResponder()
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 8), format: format).image { context in
      UIColor.red.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 12, height: 8))
    }
    UIPasteboard.general.image = image
    try check(!input.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil), "stock plain input cannot paste image")
    let handler = ComposerImagePasteHandler()
    handler.enabled = true
    handler.scopeKey = "thread-a"
    handler.attach(to: input)
    var images: [[String: Any]] = []
    var states: [Bool] = []
    var errors: [String] = []
    handler.onImage = { images.append($0) }
    handler.onBusy = { states.append($0["busy"] as! Bool) }
    handler.onError = { errors.append($0["message"] as! String) }
    try check(input.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil), "image-only Paste action available")
    input.text = "keep this draft"
    input.selectedRange = NSRange(location: 5, length: 4)
    input.paste(nil)
    try await waitFor { states.last == false || !errors.isEmpty }
    try check(errors.isEmpty, "image extraction succeeds: \(errors)")
    try check(images.count == 1 && states == [true, false], "one image with busy-to-settled events")
    try check(input.text == "keep this draft", "photo paste preserves selected draft")
    try check(images[0]["width"] as? Int == 12 && images[0]["height"] as? Int == 8, "image metadata preserved")
    let url = URL(string: images[0]["uri"] as! String)!
    try check(FileManager.default.fileExists(atPath: url.path), "image cache file available for upload")
    try FileManager.default.removeItem(at: url)
    UIPasteboard.general.string = "new"
    input.selectedRange = NSRange(location: 5, length: 4)
    input.paste(nil)
    try await waitFor { input.text == "keep new draft" }
    try check(images.count == 1, "ordinary text paste replaces selection without image callback")
    handler.enabled = false
    UIPasteboard.general.image = image
    input.paste(nil)
    try await Task.sleep(nanoseconds: 200_000_000)
    try check(images.count == 1 && input.text == "keep new draft", "disabled photo paste leaves draft alone")
    handler.enabled = true
    states = []
    input.paste(nil)
    handler.scopeKey = "thread-b"
    try await Task.sleep(nanoseconds: 500_000_000)
    try check(images.count == 1, "navigation discards in-flight image")
    handler.detach()
    try check(input.pasteDelegate == nil, "detach restores input delegate")
    try check(!input.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil), "detach restores text-only paste policy")
  }
}
