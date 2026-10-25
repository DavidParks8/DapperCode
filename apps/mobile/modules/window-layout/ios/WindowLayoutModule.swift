import ExpoModulesCore
import UIKit

public class WindowLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WindowLayout")
    View(WindowLayoutObserverView.self) {
      Events("onWindowLayoutChange")
    }
  }
}

/// A full-window, non-interactive view that reports the traits React Native cannot observe: size
/// classes, where the system places vertical bars, and the reserved regions that divide or cover
/// the window, such as a fold or a camera.
final class WindowLayoutObserverView: ExpoView {
  let onWindowLayoutChange = EventDispatcher()
  private var lastPayload: NSDictionary?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      lastPayload = nil
    } else {
      setNeedsLayout()
    }
  }

  // UIKit tracks traits and reserved regions read here and lays the view out again when they change.
  override func layoutSubviews() {
    super.layoutSubviews()
    guard window != nil else { return }
    var payload: [String: Any] = [
      "horizontalSizeClass": Self.name(of: traitCollection.horizontalSizeClass),
      "verticalSizeClass": Self.name(of: traitCollection.verticalSizeClass),
      "verticalBarEdge": verticalBarEdge(),
      "divisions": regions(division: true).map(Self.dictionary(from:)),
      "occlusions": regions(division: false).map(Self.dictionary(from:)),
    ]
    if let statusBar = window?.windowScene?.statusBarManager?.statusBarFrame, !statusBar.isEmpty {
      payload["statusBar"] = Self.dictionary(from: convert(statusBar, from: nil))
    }
    let next = payload as NSDictionary
    if lastPayload?.isEqual(next) == true { return }
    lastPayload = next
    onWindowLayoutChange(payload)
  }

  // Vertical bars and reserved regions ship in the iOS 27.1 SDK (UIKit 9127.0.85); older SDKs
  // report none, which keeps every bar horizontal.
  private func verticalBarEdge() -> String {
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      switch traitCollection.verticalBarEdge {
      case .leading: return "leading"
      case .trailing: return "trailing"
      default: return "unspecified"
      }
    }
    #endif
    return "unspecified"
  }

  private func regions(division: Bool) -> [CGRect] {
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      return reservedRegions(kind: division ? .division : .occlusion).map(\.frame)
    }
    #endif
    return []
  }

  private static func name(of sizeClass: UIUserInterfaceSizeClass) -> String {
    switch sizeClass {
    case .compact: return "compact"
    case .regular: return "regular"
    default: return "unspecified"
    }
  }

  private static func dictionary(from rect: CGRect) -> [String: Double] {
    [
      "x": Double(rect.minX),
      "y": Double(rect.minY),
      "width": Double(rect.width),
      "height": Double(rect.height),
    ]
  }
}
