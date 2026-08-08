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
    static func main() throws {
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
            BridgeLaunchPolicy.shouldRestore(
                autoStart: true,
                isRunning: false,
                state: "stopped"
            ),
            "a remembered stopped bridge should be restored"
        )
        try require(
            !BridgeLaunchPolicy.shouldRestore(
                autoStart: false,
                isRunning: false,
                state: "stopped"
            ),
            "an unremembered bridge should stay stopped"
        )
        try require(
            !BridgeLaunchPolicy.shouldRestore(
                autoStart: true,
                isRunning: true,
                state: "running"
            ),
            "a running bridge should not be started twice"
        )
        try require(
            !BridgeLaunchPolicy.shouldRestore(
                autoStart: true,
                isRunning: false,
                state: "needsSetup"
            ),
            "an unconfigured bridge should not be autostarted"
        )
        try require(
            !BridgeLaunchPolicy.shouldRestore(
                autoStart: true,
                isRunning: false,
                state: "error"
            ),
            "a stale workspace profile should not be autostarted"
        )

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
            pairingPayload: #"{"type":"dappercode-bridge-pair","bridgeUrl":"http://127.0.0.1:8787","bridgeToken":"token"}"#
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
