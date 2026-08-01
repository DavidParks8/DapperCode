import Foundation

enum OperatorError: LocalizedError {
    case unavailable
    case failed(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "The bundled DapperCode operator is unavailable. Reinstall the app."
        case .failed(let message):
            return message
        case .invalidResponse:
            return "The DapperCode operator returned an invalid response."
        }
    }
}

final class OperatorProcessRegistry: @unchecked Sendable {
    static let shared = OperatorProcessRegistry()

    private let lock = NSLock()
    private var processes: [ObjectIdentifier: Process] = [:]
    private var isTerminating = false

    func run(_ process: Process) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !isTerminating else {
            throw OperatorError.failed("DapperCode is quitting.")
        }
        try process.run()
        processes[ObjectIdentifier(process)] = process
    }

    func unregister(_ process: Process) {
        lock.lock()
        processes.removeValue(forKey: ObjectIdentifier(process))
        lock.unlock()
    }

    func cancelForApplicationTermination() {
        lock.lock()
        isTerminating = true
        let running = Array(processes.values)
        lock.unlock()

        for process in running where process.isRunning {
            process.terminate()
        }
    }
}

enum ApplicationTermination {
    @discardableResult
    static func begin(
        registry: OperatorProcessRegistry = .shared,
        operatorURL: URL? = Bundle.main.resourceURL?.appendingPathComponent("bin/dappercode"),
        cleanupArguments: [String] = ["stop", "--all"]
    ) -> Process? {
        registry.cancelForApplicationTermination()

        guard let operatorURL,
              FileManager.default.isExecutableFile(atPath: operatorURL.path) else {
            NSLog("DapperCode could not start bridge cleanup because the operator is unavailable.")
            return nil
        }

        let cleanup = Process()
        cleanup.executableURL = operatorURL
        cleanup.arguments = cleanupArguments
        cleanup.standardOutput = FileHandle.nullDevice
        cleanup.standardError = FileHandle.nullDevice
        do {
            // AppKit calls this path on its main thread. Spawn cleanup, but let the app exit
            // immediately; bridge owner watchdogs remain the fallback if cleanup cannot finish.
            try cleanup.run()
            return cleanup
        } catch {
            NSLog("DapperCode could not start bridge cleanup: %@", error.localizedDescription)
            return nil
        }
    }
}

enum BridgeLaunchPolicy {
    static func shouldStart(autoStart: Bool, isRunning: Bool, state: String) -> Bool {
        autoStart && !isRunning && state != "needsSetup"
    }
}
