import Foundation

private final class PinnedTlsSessionDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate,
  URLSessionWebSocketDelegate
{
  enum Transport {
    case https
    case webSocket
  }

  private let evaluator: PinnedTlsTrustEvaluator
  private let identity: SecIdentity
  private let transport: Transport
  private let lock = NSLock()
  private var httpsEmptyCAHint = false
  private var wssEmptyCAHint = false
  private var httpsIdentityPresented = false
  private var wssIdentityPresented = false
  private var serverTrustRejected = false

  init(evaluator: PinnedTlsTrustEvaluator, identity: SecIdentity, transport: Transport) {
    self.evaluator = evaluator
    self.identity = identity
    self.transport = transport
  }

  func challengeReport() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return [
      "httpsEmptyCAHint": httpsEmptyCAHint,
      "wssEmptyCAHint": wssEmptyCAHint,
      "httpsIdentityPresented": httpsIdentityPresented,
      "wssIdentityPresented": wssIdentityPresented,
      "serverTrustRejected": serverTrustRejected,
    ]
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    handle(challenge, completionHandler: completionHandler)
  }

  func urlSession(
    _ session: URLSession,
    task _: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    handle(challenge, completionHandler: completionHandler)
  }

  private func handle(
    _ challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    switch challenge.protectionSpace.authenticationMethod {
    case NSURLAuthenticationMethodServerTrust:
      guard let trust = challenge.protectionSpace.serverTrust else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
      do {
        try evaluator.evaluate(trust)
        completionHandler(.useCredential, URLCredential(trust: trust))
      } catch {
        lock.lock()
        serverTrustRejected = true
        lock.unlock()
        NSLog("Pinned TLS server trust rejected: %@", error.localizedDescription)
        completionHandler(.cancelAuthenticationChallenge, nil)
      }
    case NSURLAuthenticationMethodClientCertificate:
      let emptyHints = challenge.protectionSpace.distinguishedNames?.isEmpty ?? true
      lock.lock()
      if transport == .webSocket {
        wssEmptyCAHint = emptyHints
        wssIdentityPresented = true
      } else {
        httpsEmptyCAHint = emptyHints
        httpsIdentityPresented = true
      }
      lock.unlock()
      completionHandler(
        .useCredential,
        URLCredential(identity: identity, certificates: nil, persistence: .forSession)
      )
    default:
      completionHandler(.performDefaultHandling, nil)
    }
  }
}

struct PinnedTlsRoundTrip {
  let httpsPassed: Bool
  let wssPassed: Bool
  let challenges: [String: Any]
}

enum PinnedTlsTransport {
  static func run(
    httpsURL: URL,
    wssURL: URL,
    hostname: String,
    serverSPKIPin: String,
    identity: PinnedTlsIdentityEvidence
  ) async throws -> PinnedTlsRoundTrip {
    let evaluator = PinnedTlsTrustEvaluator(
      expectedHostname: hostname,
      expectedSPKIPin: serverSPKIPin
    )
    let httpsDelegate = PinnedTlsSessionDelegate(
      evaluator: evaluator,
      identity: identity.identity,
      transport: .https
    )
    let httpsSession = makeSession(delegate: httpsDelegate)
    let echo = Data("dappercode-pinned-tls-https".utf8)
    var request = URLRequest(url: httpsURL)
    request.httpMethod = "POST"
    request.httpBody = echo
    let (responseData, response) = try await httpsSession.data(for: request)
    httpsSession.finishTasksAndInvalidate()
    guard let httpResponse = response as? HTTPURLResponse,
      httpResponse.statusCode == 200,
      responseData == echo
    else {
      throw PinnedTlsProofError.transport("HTTPS echo did not round-trip")
    }

    let wssDelegate = PinnedTlsSessionDelegate(
      evaluator: PinnedTlsTrustEvaluator(
        expectedHostname: hostname,
        expectedSPKIPin: serverSPKIPin
      ),
      identity: identity.identity,
      transport: .webSocket
    )
    let wssSession = makeSession(delegate: wssDelegate)
    let webSocket = wssSession.webSocketTask(with: wssURL)
    webSocket.resume()
    let websocketEcho = "dappercode-pinned-tls-wss"
    try await webSocket.send(.string(websocketEcho))
    let message = try await webSocket.receive()
    webSocket.cancel(with: .normalClosure, reason: nil)
    wssSession.finishTasksAndInvalidate()
    guard case .string(let echoed) = message, echoed == websocketEcho else {
      throw PinnedTlsProofError.transport("WSS echo did not round-trip")
    }

    var challenges = httpsDelegate.challengeReport()
    challenges.merge(wssDelegate.challengeReport()) { old, new in
      (old as? Bool == true) || (new as? Bool == true)
    }
    return PinnedTlsRoundTrip(
      httpsPassed: true,
      wssPassed: true,
      challenges: challenges
    )
  }

  private static func makeSession(delegate: URLSessionDelegate) -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
  }

  static func expectServerTrustRejection(
    httpsURL: URL,
    hostname: String,
    serverSPKIPin: String,
    identity: PinnedTlsIdentityEvidence
  ) async -> Bool {
    let delegate = PinnedTlsSessionDelegate(
      evaluator: PinnedTlsTrustEvaluator(
        expectedHostname: hostname,
        expectedSPKIPin: serverSPKIPin
      ),
      identity: identity.identity,
      transport: .https
    )
    let session = makeSession(delegate: delegate)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: httpsURL)
    request.httpMethod = "POST"
    request.httpBody = Data("dappercode-pinned-tls-negative".utf8)
    do {
      _ = try await session.data(for: request)
      return false
    } catch {
      return delegate.challengeReport()["serverTrustRejected"] as? Bool == true
    }
  }
}
