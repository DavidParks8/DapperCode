import AppKit

@MainActor
protocol AboutPanelApplication: AnyObject {
    func activate(ignoringOtherApps flag: Bool)
    func orderFrontStandardAboutPanel(_ sender: Any?)
}

extension NSApplication: AboutPanelApplication {}

@MainActor
enum AboutPanelPresenter {
    static func present() {
        present(application: NSApplication.shared)
    }

    static func present(application: AboutPanelApplication) {
        application.activate(ignoringOtherApps: true)
        application.orderFrontStandardAboutPanel(nil)
    }
}
