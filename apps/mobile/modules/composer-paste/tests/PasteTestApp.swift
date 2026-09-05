import UIKit
import UniformTypeIdentifiers

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
        try await testTextJoining(in: controller.view)
        try await testBatches(in: controller.view)
        try await testLifecycle(in: controller.view)
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

  @MainActor
  func testTextJoining(in parent: UIView) async throws {
    let stock = UITextView(frame: CGRect(x: 20, y: 220, width: 300, height: 100))
    let wrapped = UITextView(frame: CGRect(x: 20, y: 340, width: 300, height: 100))
    parent.addSubview(stock)
    parent.addSubview(wrapped)
    let handler = ComposerImagePasteHandler()
    handler.enabled = true
    handler.scopeKey = "text-joining"
    handler.attach(to: wrapped)
    var images: [[String: Any]] = []
    var states: [Bool] = []
    var errors: [String] = []
    handler.onImage = { images.append($0) }
    handler.onBusy = { states.append($0["busy"] as! Bool) }
    handler.onError = { errors.append($0["message"] as! String) }
    defer {
      handler.detach()
      stock.removeFromSuperview()
      wrapped.removeFromSuperview()
      for image in images {
        try? FileManager.default.removeItem(at: URL(string: image["uri"] as! String)!)
      }
    }
    let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
      UIColor.red.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
    }
    let cases = [
      ("adjacent", ["alpha", "beta"]),
      ("spaces", ["alpha ", " beta"]),
      ("newlines", ["alpha\n", "\nbeta"]),
      ("three-items", ["alpha", "middle", "beta"]),
      ("multiline", ["alpha\nline", "beta"]),
      ("empty-item", ["alpha", "", "beta"]),
      ("punctuation", ["alpha,", "beta"]),
      ("tabs", ["alpha\t", "\tbeta"])
    ]
    var mismatches: [String] = []
    for (name, strings) in cases {
      for imageCount in [0, 1, 9] {
        let label = "\(name) with \(imageCount) images"
        var items: [[String: Any]] = strings.map { [UTType.utf8PlainText.identifier: $0] }
        items.insert(contentsOf: Array(repeating: [UTType.png.identifier: image.pngData()!], count: imageCount), at: 1)
        UIPasteboard.general.items = items
        states = []
        errors = []
        let previousImages = images.count
        for input in [stock, wrapped] {
          input.text = "prefix selected suffix"
          input.selectedRange = NSRange(location: 7, length: 8)
          input.becomeFirstResponder()
          input.paste(nil)
          try await waitFor { input.text != "prefix selected suffix" }
        }
        if imageCount > 0 {
          try await waitFor { states.last == false || !errors.isEmpty }
        }
        try check(stock.text.contains("alpha") && stock.text.contains("beta"), "stock pastes multiple text items: \(label)")
        if wrapped.text != stock.text || wrapped.selectedRange != stock.selectedRange {
          mismatches.append("\(label): stock=\(stock.text.debugDescription), wrapped=\(wrapped.text.debugDescription), stock selection=\(stock.selectedRange), wrapped selection=\(wrapped.selectedRange)")
        }
        try check(images.count == previousImages + (imageCount == 1 ? 1 : 0), "multi-item text paste handles only admitted photos: \(label)")
        try check(
          imageCount == 9
            ? errors == ["Paste no more than 8 photos at a time"] && states.isEmpty
            : errors.isEmpty && states == (imageCount == 1 ? [true, false] : []),
          "multi-item text paste preserves expected busy and error state: \(label)"
        )
      }
    }
    try check(mismatches.isEmpty, "multi-item text and selection match stock UIKit: \(mismatches)")
  }

  @MainActor
  func testBatches(in parent: UIView) async throws {
    let input = UITextView(frame: CGRect(x: 20, y: 220, width: 300, height: 100))
    parent.addSubview(input)
    input.becomeFirstResponder()
    let handler = ComposerImagePasteHandler()
    handler.enabled = true
    handler.scopeKey = "batch"
    handler.attach(to: input)
    defer { handler.detach() }
    let image = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 8)).image { context in
      UIColor.blue.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 12, height: 8))
    }
    var images: [[String: Any]] = []
    var states: [Bool] = []
    var errors: [String] = []
    handler.onImage = { images.append($0) }
    handler.onBusy = { states.append($0["busy"] as! Bool) }
    handler.onError = { errors.append($0["message"] as! String) }
    defer {
      for image in images {
        try? FileManager.default.removeItem(at: URL(string: image["uri"] as! String)!)
      }
    }

    input.text = "keep this draft"
    input.selectedRange = NSRange(location: 5, length: 4)
    UIPasteboard.general.images = Array(repeating: image, count: 9)
    input.paste(nil)
    try await waitFor { !errors.isEmpty || states.last == false }
    try check(errors == ["Paste no more than 8 photos at a time"], "nine-image paste reports one visible overflow error")
    try check(images.isEmpty && states.isEmpty, "overflow rejects the whole batch before extraction")
    try check(input.text == "keep this draft", "overflow leaves selected draft unchanged")

    errors = []
    UIPasteboard.general.images = Array(repeating: image, count: 8)
    input.paste(nil)
    try await waitFor { states.last == false || !errors.isEmpty }
    try check(errors.isEmpty && images.count == 8, "eight-image recovery accepts every photo")
    try check(states == [true, false], "batch emits one busy-to-settled transition")
    try check(input.text == "keep this draft", "eight-image recovery preserves selection text")

    errors = []
    states = []
    UIPasteboard.general.items = Array(repeating: [UTType.png.identifier: image.pngData()!], count: 9)
      + [[UTType.utf8PlainText.identifier: "new"]]
    input.selectedRange = NSRange(location: 5, length: 4)
    input.paste(nil)
    try await waitFor { input.text == "keep new draft" && (!errors.isEmpty || states.last == false) }
    try check(errors == ["Paste no more than 8 photos at a time"] && images.count == 8, "mixed overflow rejects photos but still pastes ordinary text")
    try check(states.isEmpty, "mixed overflow leaves no busy work")
    UIPasteboard.general.string = "other"
    input.selectedRange = NSRange(location: 5, length: 3)
    input.paste(nil)
    try await waitFor { input.text == "keep other draft" }
    try check(images.count == 8, "ordinary text still replaces selection after overflow")
  }

  @MainActor
  func testLifecycle(in parent: UIView) async throws {
    let input = UITextView(frame: CGRect(x: 20, y: 340, width: 300, height: 100))
    parent.addSubview(input)
    input.becomeFirstResponder()
    input.text = "selected draft"
    input.selectedRange = NSRange(location: 0, length: 8)
    let handler = ComposerImagePasteHandler()
    handler.enabled = true
    handler.scopeKey = "lifecycle"
    handler.attach(to: input)
    var images: [[String: Any]] = []
    var states: [Bool] = []
    var errors: [String] = []
    handler.onImage = { images.append($0) }
    handler.onBusy = { states.append($0["busy"] as! Bool) }
    handler.onError = { errors.append($0["message"] as! String) }
    let source = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("fixture.png")
    let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
      UIColor.green.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
    }
    try image.pngData()!.write(to: source)
    defer {
      handler.detach()
      try? FileManager.default.removeItem(at: source)
      for image in images {
        try? FileManager.default.removeItem(at: URL(string: image["uri"] as! String)!)
      }
    }

    let first = ControlledImageProvider()
    input.paste(itemProviders: [first.provider])
    try await waitFor { first.isRequested }
    try check(states == [true] && images.isEmpty, "slow provider holds extraction busy")
    let overlap = ControlledImageProvider()
    input.paste(itemProviders: [overlap.provider])
    try await waitFor { !errors.isEmpty }
    try check(errors == ["Wait for the current photo paste to finish"] && !overlap.isRequested, "overlapping paste visibly rejected before loading")
    try check(states == [true], "overlap does not settle accepted work")
    handler.enabled = false
    first.complete(with: source)
    try await waitFor { states.last == false }
    try check(images.count == 1 && states == [true, false], "disabling admission does not drop already accepted photos")

    states = []
    errors = []
    let disabled = ControlledImageProvider()
    input.paste(itemProviders: [disabled.provider])
    try await waitFor { !errors.isEmpty }
    try check(errors == ["Photo paste is unavailable right now"] && !disabled.isRequested, "disabled paste visibly rejected without extraction")
    try check(states.isEmpty && input.text == "selected draft", "disabled rejection leaves busy state and selection unchanged")

    handler.enabled = true
    errors = []
    let stale = ControlledImageProvider()
    input.paste(itemProviders: [stale.provider])
    try await waitFor { stale.isRequested }
    handler.scopeKey = "lifecycle-next"
    try check(states == [true, false], "scope cancellation settles extraction immediately")
    let filesBefore = try nativeFiles()
    let nextScope = ControlledImageProvider()
    input.paste(itemProviders: [nextScope.provider])
    try await waitFor { nextScope.isRequested }
    stale.complete(with: source)
    try await waitFor { stale.didComplete }
    // Completion returns only after the production file callback; its main-queue cleanup runs next.
    try await waitFor { (try? nativeFiles()) == filesBefore }
    try check(images.count == 1 && errors.isEmpty && states == [true, false, true], "stale scope completion cannot settle newer extraction")
    try check(try nativeFiles() == filesBefore, "stale scope completion deletes its cache file")
    nextScope.complete(with: source)
    try await waitFor { states.last == false }
    try check(images.count == 2 && images.last?["scopeKey"] as? String == "lifecycle-next", "new scope owns its image and settled state")
    let filesAfterScope = try nativeFiles()

    states = []
    let detached = ControlledImageProvider()
    input.paste(itemProviders: [detached.provider])
    try await waitFor { detached.isRequested }
    handler.detach()
    input.removeFromSuperview()
    try check(states == [true, false] && input.pasteDelegate == nil, "detach settles busy and restores delegate")
    detached.complete(with: source)
    try await waitFor { detached.didComplete }
    try await waitFor { (try? nativeFiles()) == filesAfterScope }
    try check(images.count == 2 && errors.isEmpty && states == [true, false], "completion after detach stays silent without reattachment")
    try check(try nativeFiles() == filesAfterScope, "completion after detach deletes its cache file")

    parent.addSubview(input)
    handler.attach(to: input)
    states = []
    let failed = ControlledImageProvider()
    input.paste(itemProviders: [failed.provider])
    try await waitFor { failed.isRequested }
    failed.complete(with: nil)
    try await waitFor { states.last == false }
    try check(errors.count == 1 && images.count == 2 && states == [true, false], "provider failure emits error and settles after reattach")
    states = []
    errors = []
    let recovery = ControlledImageProvider()
    input.paste(itemProviders: [recovery.provider])
    try await waitFor { recovery.isRequested }
    recovery.complete(with: source)
    try await waitFor { states.last == false }
    try check(images.count == 3 && errors.isEmpty && states == [true, false], "fresh paste recovers after cancellation detach and provider failure")
    try check(input.text == "selected draft", "all lifecycle transitions preserve the selected draft")
  }

  func nativeFiles() throws -> Set<String> {
    Set(try FileManager.default.contentsOfDirectory(atPath: NSTemporaryDirectory())
      .filter { $0.hasPrefix("pasted-photo-") })
  }
}

// Real NSItemProvider, with its external file callback held until the test drives the next transition.
@MainActor
private final class ControlledImageProvider {
  let provider = ObservedItemProvider()
  var isRequested: Bool { completion != nil }
  var didComplete = false
  private var completion: ((URL?, Bool, Error?) -> Void)?

  init() {
    provider.onComplete = { [weak self] in self?.didComplete = true }
    provider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all) { [weak self] completion in
      DispatchQueue.main.async { self?.completion = completion }
      return Progress(totalUnitCount: 1)
    }
  }

  func complete(with source: URL?) {
    let callback = completion!
    completion = nil
    DispatchQueue.global().async {
      callback(source, false, source == nil ? NSError(domain: "test provider failure", code: 1) : nil)
    }
  }
}

private final class ObservedItemProvider: NSItemProvider, @unchecked Sendable {
  var onComplete: () -> Void = {}

  override func loadFileRepresentation(
    forTypeIdentifier typeIdentifier: String,
    completionHandler: @escaping (URL?, Error?) -> Void
  ) -> Progress {
    super.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
      completionHandler(url, error)
      DispatchQueue.main.async { self.onComplete() }
    }
  }
}
