import DapperGit
import Foundation

extension WorkspaceStore {
  func gitStatus(_ id: String) throws -> NativeGitStatus {
    try NativeGit.status(repository: resolve(id, path: "", allowRoot: true))
  }

  func gitDiff(_ id: String, maximumBytes: Int) throws -> NativeGitDiff {
    try NativeGit.diff(repository: resolve(id, path: "", allowRoot: true), maximumBytes: maximumBytes)
  }

  func gitHistory(_ id: String) throws -> [NativeGitCommit] {
    try NativeGit.history(repository: resolve(id, path: "", allowRoot: true))
  }

  func gitBranches(_ id: String) throws -> [NativeGitBranch] {
    try NativeGit.branches(repository: resolve(id, path: "", allowRoot: true))
  }

  func gitStage(_ id: String, path: String?) throws {
    let root = try resolve(id, path: "", allowRoot: true)
    if let path {
      _ = try resolve(id, path: path, allowMissing: true)
      try NativeGit.stage(repository: root, path: path)
    } else {
      try NativeGit.stageAll(repository: root)
    }
  }

  func gitUnstage(_ id: String, path: String?) throws {
    let root = try resolve(id, path: "", allowRoot: true)
    if let path { _ = try resolve(id, path: path, allowMissing: true) }
    try NativeGit.unstage(repository: root, path: path)
  }

  func gitCommit(_ id: String, message: String, name: String, email: String) throws -> String {
    try NativeGit.commit(
      repository: resolve(id, path: "", allowRoot: true),
      message: message, authorName: name, authorEmail: email
    )
  }

  func gitSwitch(_ id: String, branch: String) throws {
    try NativeGit.switchBranch(repository: resolve(id, path: "", allowRoot: true), branch: branch)
  }

  func gitOrigin(_ id: String) throws -> String {
    try NativeGit.origin(repository: resolve(id, path: "", allowRoot: true))
  }

  func gitPush(_ id: String, credentialRef: String?) throws {
    let root = try resolve(id, path: "", allowRoot: true)
    let origin = try NativeGit.origin(repository: root)
    guard let host = URL(string: origin)?.host else { throw GitOperationError("The Git origin URL is invalid.") }
    let credential = try credentialRef.map { try GitCredentialStore.read($0, host: host) }
    try NativeGit.push(repository: root, credential: credential)
  }
}

extension NativeGit {
  static func origin(repository: URL) throws -> String {
    try withRepository(repository) { repository in
      var remote: OpaquePointer?
      try requireSuccess(git_remote_lookup(&remote, repository, "origin"), "Read origin")
      defer { git_remote_free(remote) }
      guard let raw = git_remote_url(remote), let url = String(validatingCString: raw) else {
        throw GitOperationError("The Git origin URL is invalid.")
      }
      return url
    }
  }
}
