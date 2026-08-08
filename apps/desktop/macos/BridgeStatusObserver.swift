import Foundation

struct BridgeObservationTarget: Equatable {
    let profileId: String
    let pairingPayload: String
}

struct BridgeObservedHealth: Decodable, Equatable {
    struct Agent: Decodable, Equatable {
        let lifecycle: String
    }

    struct Operational: Decodable, Equatable {
        let recentErrors: [RecentError]
    }

    struct RecentError: Decodable, Equatable {}

    let status: String
    let uptimeSec: UInt64
    let connectedClients: Int
    let agents: [Agent]
    let configuredWorkspaces: Int
    let runningWorkers: Int
    let busyWorkers: Int
    let operational: Operational
}

@MainActor
protocol BridgeStatusConnection: AnyObject {
    func start()
    func cancel()
}

@MainActor
final class BridgeStatusObserver {
    typealias ConnectionFactory = @MainActor (
        BridgeObservationTarget,
        @escaping (BridgeObservedHealth) -> Void,
        @escaping () -> Void
    ) -> BridgeStatusConnection?

    private struct Entry {
        let target: BridgeObservationTarget
        let connection: BridgeStatusConnection
    }

    private let connectionFactory: ConnectionFactory
    private let onHealth: (String, BridgeObservedHealth) -> Void
    private let onDisconnect: (String) -> Void
    private var desired: [String: BridgeObservationTarget] = [:]
    private var entries: [String: Entry] = [:]
    private var failureCounts: [String: Int] = [:]
    private var retryTasks: [String: Task<Void, Never>] = [:]

    init(
        connectionFactory: @escaping ConnectionFactory = URLSessionBridgeStatusConnection.make,
        onHealth: @escaping (String, BridgeObservedHealth) -> Void,
        onDisconnect: @escaping (String) -> Void
    ) {
        self.connectionFactory = connectionFactory
        self.onHealth = onHealth
        self.onDisconnect = onDisconnect
    }

    func synchronize(_ targets: [BridgeObservationTarget]) {
        let next = Dictionary(uniqueKeysWithValues: targets.map { ($0.profileId, $0) })
        for profileId in desired.keys where next[profileId] == nil {
            entries.removeValue(forKey: profileId)?.connection.cancel()
            retryTasks.removeValue(forKey: profileId)?.cancel()
            failureCounts.removeValue(forKey: profileId)
        }
        for target in targets where desired[target.profileId] != nil && desired[target.profileId] != target {
            entries.removeValue(forKey: target.profileId)?.connection.cancel()
            retryTasks.removeValue(forKey: target.profileId)?.cancel()
            failureCounts.removeValue(forKey: target.profileId)
        }
        desired = next

        for target in targets {
            if entries[target.profileId] == nil && retryTasks[target.profileId] == nil {
                connect(target)
            }
        }
    }

    func stop() {
        desired.removeAll()
        for entry in entries.values {
            entry.connection.cancel()
        }
        for task in retryTasks.values {
            task.cancel()
        }
        entries.removeAll()
        retryTasks.removeAll()
        failureCounts.removeAll()
    }

    private func connect(_ target: BridgeObservationTarget) {
        guard desired[target.profileId] == target else { return }
        guard let connection = connectionFactory(
            target,
            { [weak self] health in
                guard let self else { return }
                self.failureCounts[target.profileId] = 0
                self.onHealth(target.profileId, health)
            },
            { [weak self] in
                self?.connectionDidClose(target)
            }
        ) else {
            connectionDidClose(target)
            return
        }
        entries[target.profileId] = Entry(target: target, connection: connection)
        connection.start()
    }

    private func connectionDidClose(_ target: BridgeObservationTarget) {
        entries.removeValue(forKey: target.profileId)?.connection.cancel()
        guard desired[target.profileId] == target else { return }

        let failures = min((failureCounts[target.profileId] ?? 0) + 1, 6)
        failureCounts[target.profileId] = failures
        onDisconnect(target.profileId)

        let delay = min(1 << (failures - 1), 30)
        retryTasks[target.profileId]?.cancel()
        retryTasks[target.profileId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.retryTasks.removeValue(forKey: target.profileId)
            self.connect(target)
        }
    }
}

@MainActor
private final class URLSessionBridgeStatusConnection: BridgeStatusConnection {
    private struct PairingPayload: Decodable {
        let type: String
        let bridgeUrl: String
        let bridgeToken: String
        let workspaceId: String?
    }

    private struct HealthEnvelope: Decodable {
        let id: String?
        let result: BridgeObservedHealth?
    }

    private static let heartbeatInterval = Duration.seconds(60)
    private static let responseTimeout = Duration.seconds(10)
    private static let eventRefreshInterval: TimeInterval = 5

    private let request: URLRequest
    private let onHealth: (BridgeObservedHealth) -> Void
    private let onDisconnect: () -> Void
    private var socket: URLSessionWebSocketTask?
    private var worker: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var eventRefresh: Task<Void, Never>?
    private var responseTimeouts: [Int: Task<Void, Never>] = [:]
    private var requestId = 0
    private var lastHealthRequestAt = Date.distantPast
    private var isCancelled = false
    private var didReportDisconnect = false

    static func make(
        target: BridgeObservationTarget,
        onHealth: @escaping (BridgeObservedHealth) -> Void,
        onDisconnect: @escaping () -> Void
    ) -> BridgeStatusConnection? {
        guard let payloadData = target.pairingPayload.data(using: .utf8),
              let payload = try? JSONDecoder().decode(PairingPayload.self, from: payloadData),
              ["dappercode-broker-pair", "dappercode-bridge-pair"].contains(payload.type),
              var components = URLComponents(string: payload.bridgeUrl) else {
            return nil
        }
        switch components.scheme?.lowercased() {
        case "http": components.scheme = "ws"
        case "https": components.scheme = "wss"
        default: return nil
        }
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/\(components.path.isEmpty ? "" : "\(components.path)/")broker/rpc"
        var queryItems = [
            URLQueryItem(name: "clientType", value: "desktop-monitor"),
            URLQueryItem(name: "clientName", value: "DapperCode"),
        ]
        if let workspaceId = payload.workspaceId {
            queryItems.append(URLQueryItem(name: "workspace", value: workspaceId))
        }
        components.queryItems = queryItems
        guard let url = components.url else { return nil }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(payload.bridgeToken)", forHTTPHeaderField: "Authorization")
        return URLSessionBridgeStatusConnection(
            request: request,
            onHealth: onHealth,
            onDisconnect: onDisconnect
        )
    }

    private init(
        request: URLRequest,
        onHealth: @escaping (BridgeObservedHealth) -> Void,
        onDisconnect: @escaping () -> Void
    ) {
        self.request = request
        self.onHealth = onHealth
        self.onDisconnect = onDisconnect
    }

    func start() {
        guard socket == nil, !isCancelled else { return }
        let socket = URLSession.shared.webSocketTask(with: request)
        self.socket = socket
        socket.resume()
        worker = Task { [weak self] in
            await self?.run(socket)
        }
    }

    func cancel() {
        isCancelled = true
        worker?.cancel()
        heartbeat?.cancel()
        eventRefresh?.cancel()
        for timeout in responseTimeouts.values {
            timeout.cancel()
        }
        socket?.cancel(with: .goingAway, reason: nil)
        worker = nil
        heartbeat = nil
        eventRefresh = nil
        responseTimeouts.removeAll()
        socket = nil
    }

    private func run(_ socket: URLSessionWebSocketTask) async {
        do {
            try await requestHealth(on: socket)
            heartbeat = Task { [weak self, weak socket] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: Self.heartbeatInterval)
                    guard !Task.isCancelled, let self, let socket else { return }
                    do {
                        try await self.requestHealth(on: socket)
                    } catch {
                        self.reportDisconnect()
                        return
                    }
                }
            }

            while !Task.isCancelled {
                let message = try await socket.receive()
                handle(message)
            }
        } catch is CancellationError {
            return
        } catch {
            reportDisconnect()
        }
    }

    private func requestHealth(on socket: URLSessionWebSocketTask) async throws {
        requestId += 1
        let id = requestId
        lastHealthRequestAt = Date()
        let payload = """
        {"id":"desktop-health-\(id)","method":"bridge/health/read","params":{}}
        """
        try await socket.send(.string(payload))
        responseTimeouts[id]?.cancel()
        responseTimeouts[id] = Task { [weak self] in
            try? await Task.sleep(for: Self.responseTimeout)
            guard !Task.isCancelled, let self, self.responseTimeouts[id] != nil else { return }
            self.reportDisconnect()
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text):
            guard let value = text.data(using: .utf8) else { return }
            data = value
        case .data(let value):
            data = value
        @unknown default:
            return
        }
        guard let envelope = try? JSONDecoder().decode(HealthEnvelope.self, from: data) else {
            return
        }
        guard let health = envelope.result else {
            scheduleEventRefresh()
            return
        }
        if let id = envelope.id.flatMap(Self.healthRequestId) {
            let completedIds = responseTimeouts.keys.filter { $0 <= id }
            for completedId in completedIds {
                responseTimeouts.removeValue(forKey: completedId)?.cancel()
            }
        }
        onHealth(health)
    }

    private func scheduleEventRefresh() {
        guard eventRefresh == nil, let socket else { return }
        let delay = max(
            0,
            Self.eventRefreshInterval - Date().timeIntervalSince(lastHealthRequestAt)
        )
        eventRefresh = Task { [weak self, weak socket] in
            if delay > 0 {
                try? await Task.sleep(for: .seconds(delay))
            }
            guard !Task.isCancelled, let self, let socket else { return }
            self.eventRefresh = nil
            do {
                try await self.requestHealth(on: socket)
            } catch {
                self.reportDisconnect()
            }
        }
    }

    private static func healthRequestId(_ value: String) -> Int? {
        let prefix = "desktop-health-"
        guard value.hasPrefix(prefix) else { return nil }
        return Int(value.dropFirst(prefix.count))
    }

    private func reportDisconnect() {
        guard !isCancelled, !didReportDisconnect else { return }
        didReportDisconnect = true
        heartbeat?.cancel()
        eventRefresh?.cancel()
        for timeout in responseTimeouts.values {
            timeout.cancel()
        }
        responseTimeouts.removeAll()
        socket?.cancel(with: .goingAway, reason: nil)
        onDisconnect()
    }
}
