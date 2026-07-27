import Foundation
import Network

enum PinnedTlsNetworkTransition {
  static func wait(timeout: TimeInterval) async throws {
    try await withCheckedThrowingContinuation { continuation in
      let observer = Observer(continuation: continuation)
      observer.start(timeout: timeout)
    }
  }

  private final class Observer: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.dappercode.pinned-tls-proof.network")
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var initialSignature: String?
    private var sawTransition = false
    private var completed = false

    init(continuation: CheckedContinuation<Void, Error>) {
      self.continuation = continuation
    }

    func start(timeout: TimeInterval) {
      monitor.pathUpdateHandler = { path in
        self.observe(path)
      }
      monitor.start(queue: queue)
      queue.asyncAfter(deadline: .now() + timeout) {
        self.finish(
          .failure(PinnedTlsProofError.transport("timed out waiting for a real network transition"))
        )
      }
    }

    private func observe(_ path: NWPath) {
      let interfaces = path.availableInterfaces.map(\.name).sorted().joined(separator: ",")
      let signature = "\(path.status):\(interfaces)"
      lock.lock()
      if initialSignature == nil {
        initialSignature = signature
        lock.unlock()
        return
      }
      if signature != initialSignature {
        sawTransition = true
      }
      let shouldFinish = sawTransition && path.status == .satisfied
      lock.unlock()
      if shouldFinish {
        finish(.success(()))
      }
    }

    private func finish(_ result: Result<Void, Error>) {
      lock.lock()
      guard !completed else {
        lock.unlock()
        return
      }
      completed = true
      let continuation = continuation
      self.continuation = nil
      lock.unlock()
      monitor.cancel()
      monitor.pathUpdateHandler = nil
      continuation?.resume(with: result)
    }
  }
}
