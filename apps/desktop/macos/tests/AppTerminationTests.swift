import Foundation

private struct TestFailure: Error, CustomStringConvertible {
    let description: String
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw TestFailure(description: message) }
}

private func sleepingProcess() -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sleep")
    process.arguments = ["5"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    return process
}

@MainActor
private final class FakeAboutPanelApplication: AboutPanelApplication {
    private(set) var events: [String] = []

    func activate(ignoringOtherApps flag: Bool) {
        events.append("activate:\(flag)")
    }

    func orderFrontStandardAboutPanel(_ sender: Any?) {
        events.append(sender == nil ? "showAboutPanel" : "showAboutPanelWithSender")
    }
}

@MainActor
private final class FakeBridgeStatusConnection: BridgeStatusConnection {
    private let onHealth: (BridgeObservedHealth) -> Void
    private let onDisconnect: () -> Void
    private(set) var startCount = 0
    private(set) var cancelCount = 0

    init(
        onHealth: @escaping (BridgeObservedHealth) -> Void,
        onDisconnect: @escaping () -> Void
    ) {
        self.onHealth = onHealth
        self.onDisconnect = onDisconnect
    }

    func start() {
        startCount += 1
    }

    func cancel() {
        cancelCount += 1
    }

    func sendHealth() {
        onHealth(BridgeObservedHealth(
            status: "ok",
            uptimeSec: 12,
            connectedClients: 1,
            agents: [.init(lifecycle: "ready")],
            configuredWorkspaces: 3,
            runningWorkers: 1,
            busyWorkers: 1,
            operational: .init(recentErrors: [])
        ))
    }

    func disconnect() {
        onDisconnect()
    }
}

@main
private struct AppTerminationTests {
    @MainActor
    static func main() async throws {
        let aboutApplication = FakeAboutPanelApplication()
        AboutPanelPresenter.present(application: aboutApplication)
        try require(
            aboutApplication.events == ["activate:true", "showAboutPanel"],
            "the About action should activate the menu bar app before showing its panel"
        )

        let registry = OperatorProcessRegistry()
        let inFlight = sleepingProcess()
        try registry.run(inFlight)

        var cleanup: Process?
        defer {
            if inFlight.isRunning {
                inFlight.terminate()
                inFlight.waitUntilExit()
            }
            if let cleanup, cleanup.isRunning {
                cleanup.terminate()
                cleanup.waitUntilExit()
            }
        }

        let startedAt = Date()
        cleanup = ApplicationTermination.begin(
            registry: registry,
            operatorURL: URL(fileURLWithPath: "/bin/sleep"),
            cleanupArguments: ["5"]
        )
        let handoffDuration = Date().timeIntervalSince(startedAt)

        try require(cleanup?.isRunning == true, "cleanup should still be running after the handoff")
        try require(
            handoffDuration < 1,
            "application termination blocked for \(handoffDuration) seconds"
        )

        let cancellationStartedAt = Date()
        inFlight.waitUntilExit()
        let cancellationDuration = Date().timeIntervalSince(cancellationStartedAt)
        try require(
            cancellationDuration < 1,
            "an in-flight operator process delayed termination for \(cancellationDuration) seconds"
        )
        registry.unregister(inFlight)

        let rejected = sleepingProcess()
        do {
            try registry.run(rejected)
            if rejected.isRunning {
                rejected.terminate()
                rejected.waitUntilExit()
            }
            throw TestFailure(description: "the registry accepted work after termination began")
        } catch OperatorError.failed(let message) {
            try require(message == "DapperCode is quitting.", "unexpected rejection: \(message)")
        }

        try require(
            BridgeLaunchPolicy.shouldStart(
                isRunning: false,
                state: "stopped"
            ),
            "a configured stopped bridge should be started"
        )
        try require(
            !BridgeLaunchPolicy.shouldStart(
                isRunning: true,
                state: "running"
            ),
            "a running bridge should not be started twice"
        )
        try require(
            !BridgeLaunchPolicy.shouldStart(
                isRunning: false,
                state: "needsSetup"
            ),
            "an unconfigured bridge should not be autostarted"
        )
        try require(
            !BridgeLaunchPolicy.shouldStart(
                isRunning: false,
                state: "error"
            ),
            "a stale workspace profile should not be autostarted"
        )

        let noisy = Process()
        noisy.executableURL = URL(fileURLWithPath: "/bin/sh")
        noisy.arguments = [
            "-c",
            "head -c 200000 /dev/zero; head -c 200000 /dev/zero >&2",
        ]
        let noisyStdout = Pipe()
        let noisyStderr = Pipe()
        noisy.standardOutput = noisyStdout
        noisy.standardError = noisyStderr
        try noisy.run()
        let captured = await OperatorProcessOutput.collect(
            from: noisy,
            stdout: noisyStdout,
            stderr: noisyStderr
        )
        try require(captured.stdout.count == 200_000, "large stdout should drain without deadlock")
        try require(captured.stderr.count == 200_000, "large stderr should drain without deadlock")

        var connections: [FakeBridgeStatusConnection] = []
        var observedHealth: [(String, BridgeObservedHealth)] = []
        var disconnectedProfiles: [String] = []
        let observer = BridgeStatusObserver(
            connectionFactory: { _, onHealth, onDisconnect in
                let connection = FakeBridgeStatusConnection(
                    onHealth: onHealth,
                    onDisconnect: onDisconnect
                )
                connections.append(connection)
                return connection
            },
            onHealth: { observedHealth.append(($0, $1)) },
            onDisconnect: { disconnectedProfiles.append($0) }
        )
        let target = BridgeObservationTarget(
            profileId: "profile",
            pairingPayload: #"{"type":"dappercode-bridge-pair","bridgeUrl":"http://127.0.0.1:8787","bridgeToken":"token","workspaceId":"profile"}"#
        )

        observer.synchronize([target])
        observer.synchronize([target])
        try require(connections.count == 1, "a healthy bridge should have one persistent observer")
        try require(connections[0].startCount == 1, "the observer connection should start once")

        connections[0].sendHealth()
        try require(observedHealth.count == 1, "health events should update the bridge snapshot")
        connections[0].disconnect()
        try require(
            disconnectedProfiles == ["profile"],
            "an externally closed bridge connection should trigger reconciliation"
        )

        let changedTarget = BridgeObservationTarget(
            profileId: "profile",
            pairingPayload: #"{"type":"dappercode-bridge-pair","bridgeUrl":"http://127.0.0.1:9797","bridgeToken":"new-token"}"#
        )
        observer.synchronize([changedTarget])
        try require(
            connections.count == 2 && connections[1].startCount == 1,
            "a changed bridge target should replace a pending reconnect immediately"
        )

        observer.synchronize([])
        try require(
            connections[0].cancelCount == 1 && connections[1].cancelCount == 1,
            "stopping a bridge should cancel its persistent observer"
        )
    }
}
