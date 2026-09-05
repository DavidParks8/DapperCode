import UIKit
import UniformTypeIdentifiers
import ImageIO

// Uses the text control's public paste delegate, leaving RN's text/selection delegate intact.
final class ComposerImagePasteHandler: NSObject, UITextPasteDelegate {
  var enabled = false
  var scopeKey = "" {
    didSet {
      if oldValue != scopeKey {
        generation += 1
        pending = 0
      }
    }
  }
  var onImage: ([String: Any]) -> Void = { _ in }
  var onBusy: ([String: Any]) -> Void = { _ in }
  var onError: ([String: Any]) -> Void = { _ in }
  private weak var input: UITextView?
  private weak var previousDelegate: UITextPasteDelegate?
  private var previousConfiguration: UIPasteConfiguration?
  private var previousAllowsEditingTextAttributes = false
  private var generation = 0
  private var pending = 0
  private let maxBytes = 20 * 1024 * 1024

  func attach(to input: UITextView) {
    guard self.input !== input else { return }
    detach()
    self.input = input
    previousDelegate = input.pasteDelegate
    previousConfiguration = input.pasteConfiguration
    previousAllowsEditingTextAttributes = input.allowsEditingTextAttributes
    input.allowsEditingTextAttributes = true
    input.pasteDelegate = self
    let types = previousConfiguration?.acceptableTypeIdentifiers ?? [UTType.utf8PlainText.identifier]
    input.pasteConfiguration = UIPasteConfiguration(
      acceptableTypeIdentifiers: types + [UTType.image.identifier]
    )
  }

  func detach() {
    generation += 1
    pending = 0
    if input?.pasteDelegate === self {
      input?.pasteDelegate = previousDelegate
      input?.pasteConfiguration = previousConfiguration
      input?.allowsEditingTextAttributes = previousAllowsEditingTextAttributes
    }
    input = nil
  }

  func textPasteConfigurationSupporting(
    _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
    transform item: UITextPasteItem
  ) {
    let provider = item.itemProvider
    guard let type = provider.registeredTypeIdentifiers.first(where: {
      UTType($0)?.conforms(to: .image) == true
    }) else {
      if let previousDelegate,
         previousDelegate.responds(to: #selector(UITextPasteDelegate.textPasteConfigurationSupporting(_:transform:))) {
        previousDelegate.textPasteConfigurationSupporting?(textPasteConfigurationSupporting, transform: item)
      } else {
        item.setDefaultResult()
      }
      return
    }

    // Never insert an attachment character or replace the selected draft with image data.
    item.setNoResult()
    guard enabled, pending < 8 else { return }
    let scope = scopeKey
    let owner = generation
    pending += 1
    if pending == 1 { onBusy(["busy": true, "scopeKey": scope]) }
    let limit = maxBytes
    provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] source, error in
      var payload: [String: Any]?
      var output: URL?
      var failure = error?.localizedDescription
      do {
        guard let source else {
          throw NSError(domain: "ComposerPaste", code: 1, userInfo: [NSLocalizedDescriptionKey: failure ?? "Unable to read pasted photo"])
        }
        let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= limit else {
          throw NSError(domain: "ComposerPaste", code: 2, userInfo: [NSLocalizedDescriptionKey: "Photo must be non-empty and no larger than 20 MB"])
        }
        guard let image = CGImageSourceCreateWithURL(source as CFURL, nil),
              let metadata = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
              let width = metadata[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = metadata[kCGImagePropertyPixelHeight] as? NSNumber,
              width.intValue > 0, height.intValue > 0 else {
          throw NSError(domain: "ComposerPaste", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unable to read pasted photo"])
        }
        let name = "pasted-photo-\(UUID().uuidString).\(UTType(type)?.preferredFilenameExtension ?? "img")"
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try FileManager.default.copyItem(at: source, to: destination)
        output = destination
        payload = ["uri": destination.absoluteString, "fileName": name, "fileSize": size,
                   "width": width, "height": height, "scopeKey": scope]
      } catch {
        failure = error.localizedDescription
      }
      DispatchQueue.main.async {
        guard let self, self.generation == owner, self.input != nil else {
          if let output { try? FileManager.default.removeItem(at: output) }
          return
        }
        if self.scopeKey == scope, let payload {
          self.onImage(payload)
        } else if let output {
          try? FileManager.default.removeItem(at: output)
        } else if self.scopeKey == scope {
          self.onError(["message": failure ?? "Unable to paste photo", "scopeKey": scope])
        }
        self.pending -= 1
        if self.pending == 0 { self.onBusy(["busy": false, "scopeKey": scope]) }
      }
    }
  }
}
