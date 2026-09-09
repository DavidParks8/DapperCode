import Foundation

@MainActor
enum BridgeRecoveryTests {
    private struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw Failure(description: message) }
    }

    private static func waitFor(_ message: String, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition() {
            guard ContinuousClock.now < deadline else { throw Failure(description: message) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    static func settings(workspace: String) -> UserDefaults {
        let suite = "dev.dappercode.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.register(defaults: ["workspace": workspace])
        return defaults
    }

    static func run() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("dappercode-recovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        func write(_ name: String, _ contents: String) throws {
            try contents.write(to: root.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }

        func snapshot(_ state: String) throws -> String {
            let value: [String: Any] = [
                "state": state, "headline": "Broker \(state)", "detail": "Fixture broker",
                "connectedClients": 0, "readyAgents": 0, "totalAgents": 0,
                "recentErrorCount": 0, "managedProcess": state == "running",
                "workspace": root.path, "profileId": "profile",
                "logPath": root.appendingPathComponent("broker.log").path,
                "configPath": root.appendingPathComponent("config.json").path,
            ]
            return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
        }

        func setState(_ state: String, listed: Bool = true) throws {
            let value = try snapshot(state)
            try write("status.json", #"{"ok":true,"result":\#(value)}"#)
            try write("list.json", #"{"ok":true,"result":[\#(listed ? value : "")]}"#)
        }

        func startCount() -> Int {
            guard let log = try? String(contentsOf: root.appendingPathComponent("starts"), encoding: .utf8) else {
                return 0
            }
            return log.split(separator: "\n").count
        }

        let running = try snapshot("running")
        try write("running.json", #"{"ok":true,"result":\#(running)}"#)
        try write("running-list.json", #"{"ok":true,"result":[\#(running)]}"#)
        try write("operator", """
        #!/bin/sh
        cd "$(dirname "$0")" || exit 1
        case "$1" in
          discover-agent) printf '{"ok":true,"result":{"agentId":"fixture","executable":"/usr/bin/true"}}' ;;
          status) cat status.json ;;
          list) cat list.json ;;
          start)
            printf '%s\\n' "$*" >> starts
            if [ ! -f available ]; then
              printf '{"ok":false,"error":"broker exited before becoming healthy"}' >&2
              exit 1
            fi
            cp running.json status.json
            cp running-list.json list.json
            cat status.json
            ;;
          *) exit 2 ;;
        esac
        """)
        let operatorURL = root.appendingPathComponent("operator")
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: operatorURL.path)
        try setState("stopped")
        let model = BridgeModel(
            operatorURL: operatorURL,
            defaults: settings(workspace: root.path),
            brokerRetryDelay: .milliseconds(100)
        )
        try require(model.workspace == root.path, "the model must use the isolated workspace")
        try await waitFor("initial startup failure was not surfaced") {
            model.errorMessage != nil && !model.isBusy
        }
        try require(model.isConfigured && !model.isRunning, "failed startup must remain configured and stopped")
        try require(model.snapshot.state == "stopped", "failed startup must refresh the stopped snapshot")
        try require(model.bridges.count == 1, "failed startup must preserve the workspace")
        let firstError = model.errorMessage
        try await waitFor("a stopped broker never retried without a health connection") {
            startCount() >= 2 && !model.isBusy
        }
        try require(model.errorMessage == firstError, "failed retries must keep the startup error visible")
        try write("available", "")
        try await waitFor("broker did not recover after the network became available") {
            model.isRunning && !model.isBusy
        }
        try require(model.snapshot.managedProcess, "recovered broker must be app-owned")
        try require(model.bridges.allSatisfy(\.isRunning), "workspace rows must recover with the broker")
        try require(model.errorMessage == nil, "recovery must not leave a stale startup error")
        let recoveredStarts = startCount()
        for _ in 0..<3 {
            await model.refresh()
        }
        try await Task.sleep(for: .milliseconds(300))
        try require(startCount() == recoveredStarts, "healthy refreshes must not start duplicate brokers")

        try FileManager.default.removeItem(at: root.appendingPathComponent("available"))
        try setState("stopped")
        await model.refresh()
        try await waitFor("a later stopped transition did not re-arm recovery") {
            startCount() > recoveredStarts && !model.isBusy && model.errorMessage != nil
        }
        try require(model.errorMessage == firstError, "a new outage must report its startup failure")
        model.errorMessage = nil
        let failedStarts = startCount()
        try await waitFor("retries stopped when the startup error was dismissed") {
            startCount() > failedStarts && !model.isBusy
        }
        try require(model.errorMessage == nil, "automatic retries must not reopen a dismissed error")
        model.errorMessage = "Unrelated settings error"
        try write("available", "")
        try await waitFor("second recovery did not settle") { model.isRunning && !model.isBusy }
        try require(model.errorMessage == "Unrelated settings error", "recovery must preserve unrelated errors")

        let busyStarts = startCount()
        model.isBusy = true
        try setState("stopped")
        await model.refresh()
        try await Task.sleep(for: .milliseconds(300))
        try require(startCount() == busyStarts, "retries must not overlap another lifecycle operation")
        model.isBusy = false
        try await waitFor("recovery did not resume after the lifecycle operation settled") {
            model.isRunning && !model.isBusy
        }
        try require(startCount() == busyStarts + 1, "queued refreshes must start the broker only once")

        let finalStarts = startCount()
        try setState("stopped")
        await model.refresh()
        for state in ["needsSetup", "error"] {
            try setState(state)
            await model.refresh()
            try await Task.sleep(for: .milliseconds(200))
            try require(startCount() == finalStarts, "\(state) must not be automatically started")
        }
        try setState("needsSetup", listed: false)
        await model.refresh()
        try require(model.bridges.isEmpty && !model.isConfigured, "removed setup must clear configured state")
        try await Task.sleep(for: .milliseconds(200))
        try require(startCount() == finalStarts, "an empty profile list must not be automatically started")

        try FileManager.default.removeItem(at: root.appendingPathComponent("available"))
        try setState("stopped")
        var closingModel: BridgeModel? = BridgeModel(
            operatorURL: operatorURL,
            defaults: settings(workspace: root.path),
            brokerRetryDelay: .milliseconds(300)
        )
        try await waitFor("closing model did not finish its first attempt") {
            closingModel?.errorMessage != nil && closingModel?.isBusy == false
        }
        let wasReleased = { [weak closingModel] in closingModel == nil }
        closingModel = nil
        try require(wasReleased(), "a pending retry must not keep the tray model alive")
        let closingStarts = startCount()
        try await Task.sleep(for: .milliseconds(400))
        try require(startCount() == closingStarts, "releasing the tray model must cancel pending retries")
    }
}
