import Darwin
import Foundation

struct NativeWorkspace: Codable, Sendable {
  let id: String
  let name: String

  var payload: [String: String] { ["id": id, "name": name] }
}

enum WorkspacePathKind: String, Sendable {
  case file, directory, symlink, other
}

struct WorkspaceError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

actor WorkspaceStore {
  let fileManager = FileManager.default
  static let maximumFileBytes = 4 * 1024 * 1024

  func listWorkspaces() throws -> [NativeWorkspace] {
    let root = try storageRoot()
    let containers = try fileManager.contentsOfDirectory(
      at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
    )
    return try containers.map { container in
      guard let id = UUID(uuidString: container.lastPathComponent) else {
        throw WorkspaceError("The local workspace store contains an unexpected entry.")
      }
      return try workspace(id.uuidString)
    }.sorted { $0.name < $1.name }
  }

  func createWorkspace(name: String) throws -> NativeWorkspace {
    try publishWorkspace(name: name) { repository in
      try fileManager.createDirectory(at: repository, withIntermediateDirectories: true)
    }
  }

  func cloneWorkspace(name: String, remote: String, credentialRef: String?) throws
    -> NativeWorkspace
  {
    guard let url = URL(string: remote), let host = url.host else {
      throw WorkspaceError("Enter a valid HTTPS Git URL.")
    }
    let credential = try credentialRef.map { try GitCredentialStore.read($0, host: host) }
    return try publishWorkspace(name: name) { repository in
      try NativeGit.clone(remote: remote, destination: repository, credential: credential)
    }
  }

  func workspace(_ rawID: String) throws -> NativeWorkspace {
    let container = try containerURL(rawID)
    let descriptor = try JSONDecoder().decode(
      NativeWorkspace.self,
      from: Data(contentsOf: container.appendingPathComponent("workspace.json"))
    )
    guard descriptor.id == container.lastPathComponent else {
      throw WorkspaceError("The local workspace metadata does not match its identity.")
    }
    return descriptor
  }

  func resolve(_ rawID: String, path: String, allowMissing: Bool = false, allowRoot: Bool = false)
    throws -> URL
  {
    let container = try containerURL(rawID)
    _ = try workspace(rawID)
    let repository = container.appendingPathComponent("repository", isDirectory: true)
    guard try kind(repository) == .directory else {
      throw WorkspaceError("The selected local workspace is not a directory.")
    }
    if path.isEmpty {
      guard allowRoot else { throw WorkspaceError("A workspace-relative file path is required.") }
      return repository
    }
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.contains("\0"), !path.contains("\\"),
      components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.lowercased() != ".git" })
    else {
      throw WorkspaceError("Paths must stay inside the workspace and outside Git metadata.")
    }
    var current = repository
    var missingParent = false
    for (index, component) in components.enumerated() {
      current.appendPathComponent(String(component))
      if missingParent { continue }
      guard let entry = try kind(current) else {
        guard allowMissing else {
          throw WorkspaceError("The workspace path does not exist: \(path)")
        }
        missingParent = true
        continue
      }
      guard entry != .symlink else {
        throw WorkspaceError("Symbolic links cannot be followed by workspace tools.")
      }
      if entry == .file, let info = try fileStatus(current), info.st_nlink > 1 {
        throw WorkspaceError("Hard-linked files cannot be accessed by workspace tools.")
      }
      if index < components.count - 1 && entry != .directory {
        throw WorkspaceError("A parent in the workspace path is not a directory: \(path)")
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
      throw WorkspaceError("Could not inspect a workspace path (POSIX error \(code)).")
    }
    return info
  }

  private func storageRoot() throws -> URL {
    guard
      let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    else {
      throw WorkspaceError("The application support directory is unavailable.")
    }
    let root = support.appendingPathComponent("OnDeviceAgent/workspaces", isDirectory: true)
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func containerURL(_ rawID: String) throws -> URL {
    guard let id = UUID(uuidString: rawID) else {
      throw WorkspaceError("Invalid local workspace identity.")
    }
    let container = try storageRoot().appendingPathComponent(id.uuidString, isDirectory: true)
    guard try kind(container) == .directory else {
      throw WorkspaceError("The local workspace is unavailable.")
    }
    return container
  }

  private func publishWorkspace(name: String, populate: (URL) throws -> Void) throws
    -> NativeWorkspace
  {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.count <= 120, name.utf8.count <= 480,
      !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    else {
      throw WorkspaceError(
        "Use a workspace name of 1-120 characters and at most 480 UTF-8 bytes without control characters."
      )
    }
    let root = try storageRoot()
    let descriptor = NativeWorkspace(id: UUID().uuidString, name: name)
    let staging = root.appendingPathComponent(".staging-\(descriptor.id)", isDirectory: true)
    try fileManager.createDirectory(at: staging, withIntermediateDirectories: false)
    do {
      try populate(staging.appendingPathComponent("repository", isDirectory: true))
      try JSONEncoder().encode(descriptor).write(
        to: staging.appendingPathComponent("workspace.json"), options: .atomic)
      try fileManager.moveItem(
        at: staging, to: root.appendingPathComponent(descriptor.id, isDirectory: true))
    } catch let error as CocoaError {
      try fileManager.removeItem(at: staging)
      throw error
    } catch let error as GitOperationError {
      try fileManager.removeItem(at: staging)
      throw error
    } catch let error as EncodingError {
      try fileManager.removeItem(at: staging)
      throw error
    }
    return descriptor
  }
}
