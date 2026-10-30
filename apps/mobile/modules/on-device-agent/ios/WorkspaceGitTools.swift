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
    markChanged(id)
  }

  func gitUnstage(_ id: String, path: String?) throws {
    let root = try resolve(id, path: "", allowRoot: true)
    if let path { _ = try resolve(id, path: path, allowMissing: true) }
    try NativeGit.unstage(repository: root, path: path)
    markChanged(id)
  }

  func gitCommit(_ id: String, message: String, name: String, email: String) throws -> String {
    let commit = try NativeGit.commit(
      repository: resolve(id, path: "", allowRoot: true),
      message: message, authorName: name, authorEmail: email
    )
    markChanged(id)
    return commit
  }

  func gitSwitch(_ id: String, branch: String) throws {
    try NativeGit.switchBranch(repository: resolve(id, path: "", allowRoot: true), branch: branch)
    markChanged(id)
  }

  func gitCreateBranch(_ id: String, name: String, checkout: Bool) throws {
    try NativeGit.createBranch(
      repository: resolve(id, path: "", allowRoot: true), name: name, checkout: checkout)
    markChanged(id)
  }

  /// Discards working-tree changes for one file (removing it when untracked), or for every tracked
  /// file. Staged content is preserved.
  func gitDiscard(_ id: String, path: String?, removeUntracked: Bool) throws {
    let root = try resolve(id, path: "", allowRoot: true)
    if let path {
      let url = try resolve(id, path: path, allowMissing: true)
      if try kind(url) == .directory {
        throw WorkspaceError(.invalidArgument, "Discard changes for individual files.")
      }
      if try NativeGit.isUntracked(repository: root, path: path) {
        try fileManager.removeItem(at: url)
      } else {
        try NativeGit.discard(repository: root, path: path, removeUntracked: false)
      }
    } else {
      try NativeGit.discard(repository: root, path: nil, removeUntracked: removeUntracked)
    }
    markChanged(id)
  }

  func gitInit(_ id: String, initialBranch: String, origin: String?) throws -> NativeWorkspaceSummary {
    try NativeGit.initialize(
      repository: resolve(id, path: "", allowRoot: true), initialBranch: initialBranch,
      origin: origin)
    markChanged(id)
    return try summary(id)
  }

  func gitOrigin(_ id: String) throws -> String {
    try NativeGit.origin(repository: resolve(id, path: "", allowRoot: true))
  }

  func gitPush(_ id: String, credentialRef: String?) throws {
    let root = try resolve(id, path: "", allowRoot: true)
    try NativeGit.push(repository: root, credential: originCredential(root, credentialRef))
    markChanged(id)
  }

  func gitFetch(_ id: String, credentialRef: String?) throws {
    let root = try resolve(id, path: "", allowRoot: true)
    try NativeGit.fetch(repository: root, credential: originCredential(root, credentialRef))
    markChanged(id)
  }

  func gitPull(_ id: String, credentialRef: String?) throws -> NativeGitPullResult {
    let root = try resolve(id, path: "", allowRoot: true)
    defer { markChanged(id) }
    return try NativeGit.pull(repository: root, credential: originCredential(root, credentialRef))
  }

  /// Network operations share one rule: a stored credential is only ever read for origin's host.
  private func originCredential(_ root: URL, _ reference: String?) throws -> StoredGitCredential? {
    let origin = try NativeGit.origin(repository: root)
    guard let host = URL(string: origin)?.host else {
      throw GitOperationError(.gitInsecureRemote, "The Git origin URL is invalid.")
    }
    return try reference.map { try GitCredentialStore.read($0, host: host) }
  }
}

extension NativeGit {
  static func origin(repository: URL) throws -> String {
    try withRepository(repository) { repository in
      let remote = try lookupOrigin(repository)
      defer { git_remote_free(remote) }
      return try originURL(remote)
    }
  }
}
