import Darwin
import Foundation

struct NativeWorkspace: Codable, Sendable {
  let id: String
  let name: String
}

struct NativeWorkspaceSummary: Sendable {
  let workspace: NativeWorkspace
  let isRepository: Bool
  var id: String { workspace.id }
  var name: String { workspace.name }

  var payload: [String: Any] {
    ["id": workspace.id, "name": workspace.name, "isRepository": isRepository]
  }
}

enum WorkspacePathKind: String, Sendable {
  case file, directory, symlink, other
}

actor WorkspaceStore {
  let fileManager = FileManager.default
  static let maximumFileBytes = 4 * 1024 * 1024
  private let session = UUID().uuidString.prefix(8)
  private var changes: [String: Int] = [:]

  func listWorkspaces() throws -> [NativeWorkspaceSummary] {
    let root = try storageRoot()
    let containers = try fileManager.contentsOfDirectory(
      at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
    )
    return try containers.map { container in
      guard let id = UUID(uuidString: container.lastPathComponent) else {
        throw WorkspaceError(
          .workspaceCorrupt, "The local workspace store contains an unexpected entry.")
      }
      return try summary(id.uuidString)
    }.sorted { $0.workspace.name < $1.workspace.name }
  }

  func createWorkspace(name: String) throws -> NativeWorkspaceSummary {
    let workspace = try publishWorkspace(name: name) { repository in
      try fileManager.createDirectory(at: repository, withIntermediateDirectories: true)
    }
    return try summary(workspace.id)
  }

  func cloneWorkspace(name: String, remote: String, credentialRef: String?) throws
    -> NativeWorkspaceSummary
  {
    guard let url = URL(string: remote), let host = url.host else {
      throw WorkspaceError(.gitInsecureRemote, "Enter a valid HTTPS Git URL.")
    }
    let credential = try credentialRef.map { try GitCredentialStore.read($0, host: host) }
    let workspace = try publishWorkspace(name: name) { repository in
      try NativeGit.clone(remote: remote, destination: repository, credential: credential)
    }
    return try summary(workspace.id)
  }

  func renameWorkspace(_ rawID: String, name: String) throws -> NativeWorkspaceSummary {
    let container = try containerURL(rawID)
    let current = try workspace(rawID)
    let renamed = NativeWorkspace(id: current.id, name: try Self.validatedName(name))
    try JSONEncoder().encode(renamed).write(
      to: container.appendingPathComponent("workspace.json"), options: .atomic)
    markChanged(current.id)
    return try summary(current.id)
  }

  /// Atomically unpublishes the workspace before removing its contents, so a partial removal can
  /// never appear as a damaged workspace in later listings.
  func deleteWorkspace(_ rawID: String) throws {
    let container = try containerURL(rawID)
    let id = try workspace(rawID).id
    let trash = try storageRoot().appendingPathComponent(".trash-\(id)", isDirectory: true)
    if try kind(trash) != nil {
      try fileManager.removeItem(at: trash)
    }
    try fileManager.moveItem(at: container, to: trash)
    markChanged(id)
    try fileManager.removeItem(at: trash)
  }

  /// A cheap token that changes after every app-initiated mutation of the workspace's files,
  /// index, branches, or metadata. It is not durable across launches.
  func changeToken(_ rawID: String) throws -> String {
    let id = try workspace(rawID).id
    return "\(session)-\(changes[id] ?? 0)"
  }

  func markChanged(_ rawID: String) {
    guard let id = UUID(uuidString: rawID)?.uuidString else { return }
    changes[id, default: 0] += 1
  }

  func summary(_ rawID: String) throws -> NativeWorkspaceSummary {
    let descriptor = try workspace(rawID)
    let repository = try containerURL(rawID).appendingPathComponent("repository", isDirectory: true)
    let metadata = repository.appendingPathComponent(".git", isDirectory: true)
    return NativeWorkspaceSummary(
      workspace: descriptor, isRepository: try kind(metadata) == .directory)
  }

  func workspace(_ rawID: String) throws -> NativeWorkspace {
    let container = try containerURL(rawID)
    let descriptor: NativeWorkspace
    do {
      descriptor = try JSONDecoder().decode(
        NativeWorkspace.self,
        from: Data(contentsOf: container.appendingPathComponent("workspace.json"))
      )
    } catch {
      throw WorkspaceError(.workspaceCorrupt, "The local workspace metadata is unreadable.")
    }
    guard descriptor.id == container.lastPathComponent else {
      throw WorkspaceError(
        .workspaceCorrupt, "The local workspace metadata does not match its identity.")
    }
    return descriptor
  }

  /// Resolves a workspace-relative path. The workspace root is the empty string; `"."` is
  /// accepted as an alias for the root only where the root is allowed.
  func resolve(_ rawID: String, path: String, allowMissing: Bool = false, allowRoot: Bool = false)
    throws -> URL
  {
    let container = try containerURL(rawID)
    _ = try workspace(rawID)
    let repository = container.appendingPathComponent("repository", isDirectory: true)
    guard try kind(repository) == .directory else {
      throw WorkspaceError(.workspaceCorrupt, "The selected local workspace is not a directory.")
    }
    if path.isEmpty || (allowRoot && path == ".") {
      guard allowRoot else {
        throw WorkspaceError(.invalidArgument, "A workspace-relative file path is required.")
      }
      return repository
    }
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.contains("\0"), !path.contains("\\"),
      components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.lowercased() != ".git" })
    else {
      throw WorkspaceError(
        .pathOutsideWorkspace, "Paths must stay inside the workspace and outside Git metadata.")
    }
    var current = repository
    var missingParent = false
    for (index, component) in components.enumerated() {
      current.appendPathComponent(String(component))
      if missingParent { continue }
      guard let entry = try kind(current) else {
        guard allowMissing else {
          throw WorkspaceError(.pathNotFound, "The workspace path does not exist: \(path)")
        }
        missingParent = true
        continue
      }
      guard entry != .symlink else {
        throw WorkspaceError(
          .pathUnsupported, "Symbolic links cannot be followed by workspace tools.")
      }
      if entry == .file, let info = try fileStatus(current), info.st_nlink > 1 {
        throw WorkspaceError(
          .pathUnsupported, "Hard-linked files cannot be accessed by workspace tools.")
      }
      if index < components.count - 1 && entry != .directory {
        throw WorkspaceError(
          .pathNotDirectory, "A parent in the workspace path is not a directory: \(path)")
      }
    }
    return current
  }

  func kind(_ url: URL) throws -> WorkspacePathKind? {
    guard let info = try fileStatus(url) else { return nil }
    switch info.st_mode & mode_t(S_IFMT) {
    case mode_t(S_IFREG): return .file
    case mode_t(S_IFDIR): return .directory
    case mode_t(S_IFLNK): return .symlink
    default: return .other
    }
  }

  func fileStatus(_ url: URL) throws -> stat? {
    var info = stat()
    guard lstat(url.path, &info) == 0 else {
      let code = errno
      if code == ENOENT { return nil }
      throw WorkspaceError(
        .storageFailure, "Could not inspect a workspace path (POSIX error \(code)).")
    }
    return info
  }

  private func storageRoot() throws -> URL {
    guard
      let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    else {
      throw WorkspaceError(.storageFailure, "The application support directory is unavailable.")
    }
    let root = support.appendingPathComponent("OnDeviceAgent/workspaces", isDirectory: true)
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func containerURL(_ rawID: String) throws -> URL {
    guard !rawID.isEmpty else {
      throw WorkspaceError(.workspaceRequired, "Choose a local workspace first.")
    }
    guard let id = UUID(uuidString: rawID) else {
      throw WorkspaceError(.workspaceInvalidID, "Invalid local workspace identity.")
    }
    let container = try storageRoot().appendingPathComponent(id.uuidString, isDirectory: true)
    guard try kind(container) == .directory else {
      throw WorkspaceError(.workspaceNotFound, "The local workspace is unavailable.")
    }
    return container
  }

  private static func validatedName(_ raw: String) throws -> String {
    let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.count <= 120, name.utf8.count <= 480,
      !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    else {
      throw WorkspaceError(
        .workspaceNameInvalid,
        "Use a workspace name of 1-120 characters and at most 480 UTF-8 bytes without control characters."
      )
    }
    return name
  }

  private func publishWorkspace(name: String, populate: (URL) throws -> Void) throws
    -> NativeWorkspace
  {
    let root = try storageRoot()
    let descriptor = NativeWorkspace(id: UUID().uuidString, name: try Self.validatedName(name))
    let staging = root.appendingPathComponent(".staging-\(descriptor.id)", isDirectory: true)
    try fileManager.createDirectory(at: staging, withIntermediateDirectories: false)
    do {
      try populate(staging.appendingPathComponent("repository", isDirectory: true))
      try JSONEncoder().encode(descriptor).write(
        to: staging.appendingPathComponent("workspace.json"), options: .atomic)
      try fileManager.moveItem(
        at: staging, to: root.appendingPathComponent(descriptor.id, isDirectory: true))
    } catch {
      try? fileManager.removeItem(at: staging)
      throw error
    }
    return descriptor
  }
}
