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

@main
private struct AppTerminationTests {
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
                state: "stopped",
                isSelected: true
            ),
            "the selected remembered bridge should be restored"
        )
        try require(
            !BridgeLaunchPolicy.shouldRestore(
                autoStart: true,
                isRunning: false,
                state: "stopped",
                isSelected: false
            ),
            "an unselected remembered bridge should stay stopped"
        )
        try require(
            !BridgeLaunchPolicy.shouldRestore(
                autoStart: false,
                isRunning: false,
                state: "stopped",
                isSelected: true
            ),
            "an unremembered bridge should stay stopped"
        )
        try require(
            !BridgeLaunchPolicy.shouldRestore(
                autoStart: true,
                isRunning: true,
                state: "running",
                isSelected: true
            ),
            "a running bridge should not be started twice"
        )
        try require(
            !BridgeLaunchPolicy.shouldRestore(
                autoStart: true,
                isRunning: false,
                state: "needsSetup",
                isSelected: true
            ),
            "an unconfigured bridge should not be autostarted"
        )
        try require(
            !BridgeLaunchPolicy.shouldRestore(
                autoStart: true,
                isRunning: false,
                state: "error",
                isSelected: true
            ),
            "a stale workspace profile should not be autostarted"
        )

        let idleArguments = (
            isSelected: false,
            isRunning: true,
            managedProcess: true,
            connectedClients: 0
        )
        try require(
            !BridgeLaunchPolicy.shouldSuspend(
                isSelected: idleArguments.isSelected,
                isRunning: idleArguments.isRunning,
                managedProcess: idleArguments.managedProcess,
                connectedClients: idleArguments.connectedClients,
                idleFor: 299,
                gracePeriod: 300
            ),
            "an inactive bridge should receive the full grace period"
        )
        try require(
            BridgeLaunchPolicy.shouldSuspend(
                isSelected: idleArguments.isSelected,
                isRunning: idleArguments.isRunning,
                managedProcess: idleArguments.managedProcess,
                connectedClients: idleArguments.connectedClients,
                idleFor: 300,
                gracePeriod: 300
            ),
            "an inactive bridge should suspend after the grace period"
        )
        try require(
            !BridgeLaunchPolicy.shouldSuspend(
                isSelected: true,
                isRunning: true,
                managedProcess: true,
                connectedClients: 0,
                idleFor: 300,
                gracePeriod: 300
            ),
            "the selected workspace should remain available"
        )
        try require(
            !BridgeLaunchPolicy.shouldSuspend(
                isSelected: false,
                isRunning: true,
                managedProcess: true,
                connectedClients: 1,
                idleFor: 300,
                gracePeriod: 300
            ),
            "a connected bridge should remain available"
        )
        try require(
            !BridgeLaunchPolicy.shouldSuspend(
                isSelected: false,
                isRunning: true,
                managedProcess: false,
                connectedClients: 0,
                idleFor: 300,
                gracePeriod: 300
            ),
            "the app should not stop a bridge it does not own"
        )
    }
}
