import ExpoModulesCore

public class ComposerPasteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ComposerPaste")
    View(ComposerPasteView.self) {
      Events("onPasteImage", "onPasteBusy", "onPasteError")
      Prop("enabled") { (view: ComposerPasteView, enabled: Bool) in
        view.pasteHandler.enabled = enabled
      }
      Prop("scopeKey") { (view: ComposerPasteView, scopeKey: String) in
        view.pasteHandler.scopeKey = scopeKey
      }
    }
  }
}

final class ComposerPasteView: ExpoView {
  let onPasteImage = EventDispatcher()
  let onPasteBusy = EventDispatcher()
  let onPasteError = EventDispatcher()
  let pasteHandler = ComposerImagePasteHandler()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    pasteHandler.onImage = { [weak self] in self?.onPasteImage($0) }
    pasteHandler.onBusy = { [weak self] in self?.onPasteBusy($0) }
    pasteHandler.onError = { [weak self] in self?.onPasteError($0) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if let input = findTextView(in: self) {
      pasteHandler.attach(to: input)
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { pasteHandler.detach() }
  }

  private func findTextView(in view: UIView) -> UITextView? {
    if let input = view as? UITextView { return input }
    return view.subviews.lazy.compactMap { findTextView(in: $0) }.first
  }
}
