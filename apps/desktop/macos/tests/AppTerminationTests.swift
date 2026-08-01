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
            BridgeLaunchPolicy.shouldStart(autoStart: true, isRunning: false, state: "stopped"),
            "a remembered stopped bridge should start"
        )
        try require(
            !BridgeLaunchPolicy.shouldStart(autoStart: false, isRunning: false, state: "stopped"),
            "an unremembered bridge should stay stopped"
        )
        try require(
            !BridgeLaunchPolicy.shouldStart(autoStart: true, isRunning: true, state: "running"),
            "a running bridge should not be started twice"
        )
        try require(
            !BridgeLaunchPolicy.shouldStart(autoStart: true, isRunning: false, state: "needsSetup"),
            "an unconfigured bridge should not be autostarted"
        )
    }
}
