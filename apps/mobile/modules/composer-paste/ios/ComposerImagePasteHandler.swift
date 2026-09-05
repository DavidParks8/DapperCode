import UIKit
import UniformTypeIdentifiers
import ImageIO

// Uses the text control's public paste delegate, leaving RN's text/selection delegate intact.
final class ComposerImagePasteHandler: NSObject, UITextPasteDelegate {
  var enabled = false
  var scopeKey = "" {
    didSet {
      if oldValue != scopeKey {
        cancel(scope: oldValue)
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
  private let imageKey = NSAttributedString.Key("ComposerPasteImage")

  private final class PasteImage: NSObject {
    let provider: NSItemProvider
    let type: String
    let generation: Int

    init(provider: NSItemProvider, type: String, generation: Int) {
      self.provider = provider
      self.type = type
      self.generation = generation
    }
  }

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
    cancel(scope: scopeKey)
    if input?.pasteDelegate === self {
      input?.pasteDelegate = previousDelegate
      input?.pasteConfiguration = previousConfiguration
      input?.allowsEditingTextAttributes = previousAllowsEditingTextAttributes
    }
    input = nil
  }

  private func cancel(scope: String) {
    generation += 1
    let wasBusy = pending > 0
    pending = 0
    if wasBusy { onBusy(["busy": false, "scopeKey": scope]) }
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

    // The marker is removed at UIKit's transaction boundary, before anything reaches the draft.
    item.setResult(attributedString: NSAttributedString(string: "\u{fffc}", attributes: [
      imageKey: PasteImage(provider: provider, type: type, generation: generation)
    ]))
  }

  func textPasteConfigurationSupporting(
    _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
    combineItemAttributedStrings itemStrings: [NSAttributedString],
    for textRange: UITextRange
  ) -> NSAttributedString {
    var photos: [PasteImage] = []
    let text = itemStrings.filter { string in
      guard string.length > 0,
            let photo = string.attribute(imageKey, at: 0, effectiveRange: nil) as? PasteImage else {
        return true
      }
      photos.append(photo)
      return false
    }
    if !photos.isEmpty, input === textPasteConfigurationSupporting as? UITextView,
       photos.allSatisfy({ $0.generation == generation }) {
      let failure: String?
      if !enabled {
        failure = "Photo paste is unavailable right now"
      } else if photos.count > 8 {
        failure = "Paste no more than 8 photos at a time"
      } else if pending > 0 {
        failure = "Wait for the current photo paste to finish"
      } else {
        failure = nil
      }
      if let failure {
        onError(["message": failure, "scopeKey": scopeKey])
      } else {
        pending = photos.count
        onBusy(["busy": true, "scopeKey": scopeKey])
        for photo in photos { load(photo) }
      }
    }
    if !text.isEmpty, let result = previousDelegate?.textPasteConfigurationSupporting?(
      textPasteConfigurationSupporting, combineItemAttributedStrings: text, for: textRange
    ) {
      return result
    }
    let result = NSMutableAttributedString(string: "")
    for (index, string) in text.enumerated() {
      // UIKit separates text items with a space, even beside existing whitespace or empty items.
      if index > 0 { result.append(NSAttributedString(string: " ")) }
      result.append(string)
    }
    return result
  }

  private func load(_ photo: PasteImage) {
    let scope = scopeKey
    let owner = photo.generation
    let type = photo.type
    let limit = maxBytes
    photo.provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] source, error in
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
        guard self.generation == owner else { return }
        self.pending -= 1
        if self.pending == 0 { self.onBusy(["busy": false, "scopeKey": scope]) }
      }
    }
  }
}
