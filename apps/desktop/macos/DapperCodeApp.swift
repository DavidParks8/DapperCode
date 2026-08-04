import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import ServiceManagement
import SwiftUI

private struct OperatorEnvelope<Value: Decodable>: Decodable {
    let ok: Bool
    let result: Value
}

private struct OperatorFailure: Decodable {
    let ok: Bool
    let error: String
}

private struct BridgeSnapshot: Decodable, Identifiable {
    let state: String
    let headline: String
    let detail: String
    let bridgeUrl: String?
    let uptimeSec: UInt64?
    let connectedClients: Int
    let readyAgents: Int
    let totalAgents: Int
    let recentErrorCount: Int
    let managedProcess: Bool
    let autoStart: Bool
    let workspace: String
    let profileId: String
    let bridgePort: UInt16?
    let pairingPayload: String?
    let logPath: String
    let configPath: String
    let secretBackend: String?

    var id: String { profileId }

    var workspaceName: String {
        let name = (workspace as NSString).lastPathComponent
        return name.isEmpty ? workspace : name
    }

    var isRunning: Bool {
        ["running", "degraded", "unhealthy", "inaccessible"].contains(state)
    }

    static let loading = BridgeSnapshot(
        state: "loading",
        headline: "Checking bridge",
        detail: "Reading local bridge state.",
        bridgeUrl: nil,
        uptimeSec: nil,
        connectedClients: 0,
        readyAgents: 0,
        totalAgents: 0,
        recentErrorCount: 0,
        managedProcess: false,
        autoStart: false,
        workspace: "",
        profileId: "",
        bridgePort: nil,
        pairingPayload: nil,
        logPath: "",
        configPath: "",
        secretBackend: nil
    )
}

private struct SetupResult: Decodable {
    let workspace: String
    let profileId: String
    let bridgeUrl: String
    let bridgePort: UInt16
    let previewPort: UInt16
    let agentId: String
    let agentVersion: String
    let executable: String
    let configPath: String
    let secretBackend: String
}

private enum NetworkMode: String, CaseIterable, Identifiable {
    case tailscale
    case local

    var id: Self { self }
    var title: String { self == .tailscale ? "Tailscale" : "Local network" }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        ApplicationTermination.begin()
    }
}

@MainActor
private final class BridgeModel: ObservableObject {
    @Published var snapshot = BridgeSnapshot.loading
    @Published var bridges: [BridgeSnapshot] = []
    @Published var isBusy = false
    @Published var errorMessage: String?
    @Published var networkMode = NetworkMode.tailscale
    @Published var host = ""
    @Published var bridgePort = ""
    @Published var agentId = "opencode"
    @Published var agentDisplayName = "OpenCode"
    @Published var agentExecutable = ""
    @Published var agentArguments = "acp"
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled

    var workspace: String {
        get {
            UserDefaults.standard.string(forKey: "workspace")
                ?? FileManager.default.homeDirectoryForCurrentUser.path
        }
        set {
            UserDefaults.standard.set(newValue, forKey: "workspace")
            objectWillChange.send()
        }
    }

    var isConfigured: Bool {
        snapshot.state != "needsSetup" && snapshot.state != "error" || snapshot.managedProcess
    }

    var isRunning: Bool { snapshot.isRunning }

    var runningBridgeCount: Int {
        bridges.filter(\.isRunning).count
    }

    var secretBackendLabel: String {
        switch snapshot.secretBackend {
        case "keychain": return "Keychain"
        case "file": return "File — keychain unavailable"
        default: return "Not stored yet"
        }
    }

    var primaryTitle: String { isRunning || snapshot.managedProcess ? "Stop Bridge" : "Start Bridge" }

    init() {
        Task {
            await discoverDefaultAgent()
            await refresh()
            await autostartRememberedBridges()
            await poll()
        }
    }

    func refresh() async {
        do {
            snapshot = try await invoke("status", as: BridgeSnapshot.self)
            bridges = try await invoke(["list"], as: [BridgeSnapshot].self, includeWorkspace: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func perform(_ command: String, on bridge: BridgeSnapshot) async {
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await invoke(
                [command, "--workspace", bridge.workspace],
                as: BridgeSnapshot.self,
                includeWorkspace: false
            )
        } catch {
            errorMessage = error.localizedDescription
        }
        await refresh()
    }

    func revealConfig() {
        guard !snapshot.configPath.isEmpty else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: snapshot.configPath)])
    }

    func openLogs(for bridge: BridgeSnapshot) {
        guard !bridge.logPath.isEmpty else { return }
        let url = URL(fileURLWithPath: bridge.logPath)
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open(url)
        } else {
            NSWorkspace.shared.activateFileViewerSelecting([url.deletingLastPathComponent()])
        }
    }

    func performPrimaryAction() async {
        await perform(isRunning || snapshot.managedProcess ? "stop" : "start")
    }

    func restart() async {
        await perform("restart")
    }

    func setupAndStart() async {
        guard !agentExecutable.isEmpty else {
            errorMessage = "Choose an installed ACP agent executable."
            return
        }
        guard bridgePort.isEmpty || UInt16(bridgePort) != nil else {
            errorMessage = "Bridge port must be a valid TCP port."
            return
        }

        isBusy = true
        defer { isBusy = false }
        do {
            var arguments = [
                "setup",
                "--network", networkMode.rawValue,
                "--agent-id", agentId,
                "--display-name", agentDisplayName,
                "--agent-executable", agentExecutable,
                "--agent-args", agentArguments,
            ]
            // Without an explicit port the operator allocates a free pair, so several worktrees can
            // run their bridges at the same time.
            if !bridgePort.isEmpty {
                arguments += ["--port", bridgePort]
            }
            if !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                arguments += ["--host", host]
            }
            _ = try await invoke(arguments, as: SetupResult.self)
            snapshot = try await invoke("start", as: BridgeSnapshot.self)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose Workspace"
        panel.directoryURL = URL(fileURLWithPath: workspace)
        if panel.runModal() == .OK, let url = panel.url {
            workspace = url.path
            Task { await refresh() }
        }
    }

    func chooseAgentExecutable() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Agent"
        if !agentExecutable.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: agentExecutable).deletingLastPathComponent()
        }
        if panel.runModal() == .OK, let url = panel.url {
            agentExecutable = url.path
            if agentDisplayName.isEmpty {
                agentDisplayName = url.deletingPathExtension().lastPathComponent
            }
        }
    }

    func copyBridgeURL() {
        guard let value = snapshot.bridgeUrl else { return }
        copy(value)
    }

    func copyPairingPayload() {
        guard let value = snapshot.pairingPayload else { return }
        copy(value)
    }

    func openLogs() { openLogs(for: snapshot) }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            launchAtLogin = SMAppService.mainApp.status == .enabled
        } catch {
            launchAtLogin = SMAppService.mainApp.status == .enabled
            errorMessage = error.localizedDescription
        }
    }

    private func perform(_ command: String) async {
        isBusy = true
        defer { isBusy = false }
        do {
            snapshot = try await invoke(command, as: BridgeSnapshot.self)
        } catch {
            errorMessage = error.localizedDescription
            await refresh()
        }
    }

    private func poll() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            if !isBusy {
                await refresh()
            }
        }
    }

    private func autostartRememberedBridges() async {
        let rememberedBridges = bridges.filter {
            BridgeLaunchPolicy.shouldStart(
                autoStart: $0.autoStart,
                isRunning: $0.isRunning,
                state: $0.state
            )
        }
        guard !rememberedBridges.isEmpty else { return }

        isBusy = true
        defer { isBusy = false }
        for bridge in rememberedBridges {
            do {
                _ = try await invoke(
                    ["start", "--workspace", bridge.workspace],
                    as: BridgeSnapshot.self,
                    includeWorkspace: false
                )
            } catch {
                errorMessage = "Could not start \(bridge.workspaceName): \(error.localizedDescription)"
            }
        }
        await refresh()
    }

    private func discoverDefaultAgent() async {
        guard agentExecutable.isEmpty else { return }
        do {
            struct Discovery: Decodable { let agentId: String; let executable: String }
            let result = try await invoke(["discover-agent", "--agent-id", agentId], as: Discovery.self)
            agentExecutable = result.executable
        } catch {
            // Setup remains usable through the native file picker.
        }
    }

    private func invoke<Value: Decodable>(_ command: String, as type: Value.Type) async throws -> Value {
        try await invoke([command], as: type)
    }

    private func invoke<Value: Decodable>(
        _ arguments: [String],
        as type: Value.Type,
        includeWorkspace: Bool = true
    ) async throws -> Value {
        let workspace = workspace
        // Bridges exit on their own when this process does, even after a force quit.
        let ownerArguments = Self.ownsBridgeLifetime(arguments)
            ? ["--owner-pid", String(ProcessInfo.processInfo.processIdentifier)]
            : []
        let workspaceArguments = includeWorkspace ? ["--workspace", workspace] : []
        return try await Task.detached(priority: .userInitiated) {
            guard let operatorURL = Bundle.main.resourceURL?.appendingPathComponent("bin/dappercode"),
                  FileManager.default.isExecutableFile(atPath: operatorURL.path) else {
                throw OperatorError.unavailable
            }

            let process = Process()
            process.executableURL = operatorURL
            process.arguments = arguments + ownerArguments + workspaceArguments
            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr
            try OperatorProcessRegistry.shared.run(process)
            defer { OperatorProcessRegistry.shared.unregister(process) }
            process.waitUntilExit()

            let output = stdout.fileHandleForReading.readDataToEndOfFile()
            let errorOutput = stderr.fileHandleForReading.readDataToEndOfFile()
            let decoder = JSONDecoder()
            if process.terminationStatus != 0 {
                if let failure = try? decoder.decode(OperatorFailure.self, from: errorOutput) {
                    throw OperatorError.failed(failure.error)
                }
                throw OperatorError.failed(String(decoding: errorOutput, as: UTF8.self))
            }
            guard let envelope = try? decoder.decode(OperatorEnvelope<Value>.self, from: output), envelope.ok else {
                throw OperatorError.invalidResponse
            }
            return envelope.result
        }.value
    }

    private static func ownsBridgeLifetime(_ arguments: [String]) -> Bool {
        guard let command = arguments.first else { return false }
        return ["start", "restart", "list"].contains(command)
    }

    private func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}

private struct StatusLabel: View {
    let snapshot: BridgeSnapshot

    var body: some View {
        LabeledContent {
            Text(snapshot.headline)
        } label: {
            Label("Bridge", systemImage: symbol)
        }
    }

    private var symbol: String {
        switch snapshot.state {
        case "running": return "checkmark.circle.fill"
        case "degraded", "unhealthy", "inaccessible", "error": return "exclamationmark.triangle.fill"
        default: return "pause.circle"
        }
    }
}

private struct DashboardView: View {
    @ObservedObject var model: BridgeModel

    var body: some View {
        Form {
            Section {
                StatusLabel(snapshot: model.snapshot)
                Text(model.snapshot.detail)
                    .foregroundStyle(.secondary)
                LabeledContent("Connected devices", value: "\(model.snapshot.connectedClients)")
                LabeledContent("Agents ready", value: "\(model.snapshot.readyAgents) of \(model.snapshot.totalAgents)")
                if let uptime = model.snapshot.uptimeSec {
                    LabeledContent("Uptime", value: Duration.seconds(uptime).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated)))
                }
                if model.snapshot.recentErrorCount > 0 {
                    LabeledContent("Recent errors", value: "\(model.snapshot.recentErrorCount)")
                }
            }

            if let payload = model.snapshot.pairingPayload {
                Section("Pair Phone") {
                    HStack(alignment: .top, spacing: 20) {
                        if let image = QRCode.image(for: payload) {
                            Image(nsImage: image)
                                .interpolation(.none)
                                .resizable()
                                .frame(width: 180, height: 180)
                                .accessibilityLabel("Bridge pairing QR code")
                        }
                        VStack(alignment: .leading) {
                            Text(model.snapshot.bridgeUrl ?? "")
                                .textSelection(.enabled)
                            Spacer()
                            Button("Copy URL", systemImage: "link") { model.copyBridgeURL() }
                            Button("Copy Pairing Data", systemImage: "doc.on.doc") { model.copyPairingPayload() }
                        }
                    }
                }
            }

            if model.bridges.count > 1 {
                Section {
                    ForEach(model.bridges) { bridge in
                        BridgeRow(model: model, bridge: bridge)
                    }
                } header: {
                    Text("Bridges")
                } footer: {
                    Text("Each workspace gets its own port and token, so worktrees can run at the same time. Quitting DapperCode stops every bridge and restores bridges that were running when it closed.")
                }
            }

            Section {
                HStack {
                    Button("Open Logs", systemImage: "doc.text") { model.openLogs() }
                    Spacer()
                    Button("Restart", systemImage: "arrow.clockwise") {
                        Task { await model.restart() }
                    }
                    .disabled(!model.snapshot.managedProcess || model.isBusy)
                    Button(model.primaryTitle, systemImage: model.isRunning ? "stop.fill" : "play.fill") {
                        Task { await model.performPrimaryAction() }
                    }
                    .disabled(model.isBusy || (!model.snapshot.managedProcess && model.snapshot.state == "needsSetup"))
                }
            } footer: {
                HStack {
                    Text("Settings: \(model.secretBackendLabel)")
                    Spacer()
                    Button("Reveal Config in Finder", systemImage: "folder") { model.revealConfig() }
                        .buttonStyle(.link)
                }
            }
        }
        .formStyle(.grouped)
    }
}

private struct BridgeRow: View {
    @ObservedObject var model: BridgeModel
    let bridge: BridgeSnapshot

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(bridge.workspaceName)
                Text(portLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(bridge.isRunning ? "Stop" : "Start") {
                Task { await model.perform(bridge.isRunning ? "stop" : "start", on: bridge) }
            }
            .disabled(model.isBusy || bridge.state == "needsSetup")
            Button("Logs", systemImage: "doc.text") { model.openLogs(for: bridge) }
                .labelStyle(.iconOnly)
        }
        .accessibilityLabel("\(bridge.workspaceName): \(bridge.headline)")
    }

    private var portLabel: String {
        guard let port = bridge.bridgePort else { return bridge.headline }
        return "\(bridge.headline) · port \(port)"
    }
}

private struct SetupView: View {
    @ObservedObject var model: BridgeModel

    var body: some View {
        Form {
            Section("Workspace") {
                LabeledContent("Folder", value: model.workspace)
                Button("Choose Workspace", systemImage: "folder") { model.chooseWorkspace() }
            }

            Section("ACP Agent") {
                TextField("Agent ID", text: $model.agentId)
                TextField("Display Name", text: $model.agentDisplayName)
                LabeledContent("Executable", value: model.agentExecutable.isEmpty ? "Not selected" : model.agentExecutable)
                Button("Choose Installed Agent", systemImage: "terminal") { model.chooseAgentExecutable() }
                TextField("Arguments", text: $model.agentArguments)
            }

            Section("Phone Network") {
                Picker("Network", selection: $model.networkMode) {
                    ForEach(NetworkMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                TextField(model.networkMode == .tailscale ? "Tailscale IP (detected automatically)" : "LAN IP (detected automatically)", text: $model.host)
                TextField("Bridge Port (blank allocates a free port)", text: $model.bridgePort)
            }

            Section {
                Button("Set Up and Start", systemImage: "play.fill") {
                    Task { await model.setupAndStart() }
                }
                .disabled(model.isBusy || model.agentExecutable.isEmpty)
            } footer: {
                Text("Settings are stored by DapperCode, never in your repository, and the bridge token is kept in your keychain. The bridge is for authenticated private networks only; never expose it directly to the public internet.")
            }
        }
        .formStyle(.grouped)
    }
}

private struct MainView: View {
    @ObservedObject var model: BridgeModel

    var body: some View {
        Group {
            if model.isConfigured {
                DashboardView(model: model)
            } else {
                SetupView(model: model)
            }
        }
        .frame(width: 540)
        .disabled(model.isBusy)
        .alert("DapperCode", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await model.refresh() }
                }
                .disabled(model.isBusy)
            }
        }
    }
}

private struct TrayMenu: View {
    @ObservedObject var model: BridgeModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Open DapperCode", systemImage: "macwindow") {
            openWindow(id: "main")
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        Divider()
        Text(model.snapshot.headline)
        if model.runningBridgeCount > 1 {
            Text("\(model.runningBridgeCount) bridges running")
        }
        Button(model.primaryTitle, systemImage: model.isRunning ? "stop.fill" : "play.fill") {
            Task { await model.performPrimaryAction() }
        }
        .disabled(model.isBusy || (!model.snapshot.managedProcess && model.snapshot.state == "needsSetup"))
        Button("Restart", systemImage: "arrow.clockwise") {
            Task { await model.restart() }
        }
        .disabled(!model.snapshot.managedProcess || model.isBusy)
        Button("Open Logs", systemImage: "doc.text") { model.openLogs() }
        Divider()
        Toggle("Open at Login", isOn: Binding(
            get: { model.launchAtLogin },
            set: { model.setLaunchAtLogin($0) }
        ))
        Button("About DapperCode") { NSApplication.shared.orderFrontStandardAboutPanel(nil) }
        Divider()
        Button("Quit DapperCode") {
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}

private enum QRCode {
    static func image(for value: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else {
            return nil
        }
        let context = CIContext()
        guard let cgImage = context.createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
    }
}

private enum TrayIcon {
    private static let size = NSSize(width: 18, height: 18)
    private static let active = render(opacity: 1)
    private static let idle = render(opacity: 0.45)

    static func image(isRunning: Bool) -> NSImage { isRunning ? active : idle }

    private static func render(opacity: CGFloat) -> NSImage {
        guard let mark = NSImage(named: "MenuBarIcon") ?? fallbackMark() else { return NSImage(size: size) }
        let image = NSImage(size: size, flipped: false) { rect in
            mark.draw(in: rect, from: .zero, operation: .sourceOver, fraction: opacity)
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func fallbackMark() -> NSImage? {
        NSImage(
            systemSymbolName: "chevron.left.forwardslash.chevron.right",
            accessibilityDescription: "DapperCode"
        )
    }
}

@main
private struct DapperCodeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = BridgeModel()

    var body: some Scene {
        MenuBarExtra {
            TrayMenu(model: model)
        } label: {
            Image(nsImage: TrayIcon.image(isRunning: model.isRunning))
                .accessibilityLabel("DapperCode: \(model.snapshot.headline)")
        }
        .menuBarExtraStyle(.menu)

        Window("DapperCode", id: "main") {
            MainView(model: model)
        }
        .defaultPosition(.center)
        .windowResizability(.contentSize)
    }
}
