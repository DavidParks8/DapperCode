import DapperGit
import Foundation

struct NativeGitPullResult: Sendable {
  let outcome: String
  let from: String?
  let to: String

  var payload: [String: Any] {
    ["outcome": outcome, "from": from.map { $0 as Any } ?? NSNull(), "to": to]
  }
}

struct NativeGitRemoteInfo: Sendable {
  let origin: String?
  let upstream: String?
  let ahead: Int?
  let behind: Int?
  let detached: Bool
  let unborn: Bool

  var payload: [String: Any] {
    [
      "hasOrigin": origin != nil, "origin": origin.map { $0 as Any } ?? NSNull(),
      "upstream": upstream.map { $0 as Any } ?? NSNull(),
      "ahead": ahead.map { $0 as Any } ?? NSNull(), "behind": behind.map { $0 as Any } ?? NSNull(),
      "detached": detached, "unborn": unborn,
    ]
  }
}

extension NativeGit {
  static func fetch(repository: URL, credential: StoredGitCredential?) throws {
    try withRepository(repository) { repository in
      let remote = try lookupOrigin(repository)
      defer { git_remote_free(remote) }
      _ = try remoteURL(try originURL(remote), credential: credential)
      try withCredentials(credential) { callbacks in
        var options = git_fetch_options()
        try requireSuccess(
          git_fetch_options_init(&options, UInt32(GIT_FETCH_OPTIONS_VERSION)), "Initialize fetch")
        options.callbacks = callbacks
        options.follow_redirects = GIT_REMOTE_REDIRECT_NONE
        try requireRemoteSuccess(git_remote_fetch(remote, nil, &options, "fetch"), "Fetch origin")
      }
    }
  }

  /// Fetches origin, then fast-forwards the current branch to its upstream. Diverged histories and
  /// local changes that the update would overwrite are rejected before anything changes.
  static func pull(repository: URL, credential: StoredGitCredential?) throws -> NativeGitPullResult {
    try fetch(repository: repository, credential: credential)
    return try fastForward(repository: repository)
  }

  static func fastForward(repository: URL) throws -> NativeGitPullResult {
    try withRepository(repository) { repository in
      var head: OpaquePointer?
      let headResult = git_repository_head(&head, repository)
      defer { git_reference_free(head) }
      if headResult == GIT_EUNBORNBRANCH.rawValue || headResult == GIT_ENOTFOUND.rawValue {
        return try fastForwardUnborn(repository)
      }
      try requireSuccess(headResult, "Read HEAD")
      guard git_repository_head_detached(repository) == 0, let head else {
        throw GitOperationError(.gitDetachedHead, "Select a local branch before pulling.")
      }
      var upstream: OpaquePointer?
      let found = git_branch_upstream(&upstream, head)
      defer { git_reference_free(upstream) }
      if found == GIT_ENOTFOUND.rawValue {
        throw GitOperationError(
          .gitNoUpstream, "This branch has no upstream branch on origin. Push it first.")
      }
      try requireSuccess(found, "Read upstream branch")
      guard let local = git_reference_target(head), let target = git_reference_target(upstream)
      else {
        throw GitOperationError(.gitFailure, "The branch or its upstream has no commit.")
      }
      let from = try objectID(local)
      let to = try objectID(target)
      if git_oid_equal(local, target) == 1 {
        return NativeGitPullResult(outcome: "up-to-date", from: from, to: from)
      }
      let ahead = git_graph_descendant_of(repository, local, target)
      try requireSuccess(ahead, "Compare branches")
      if ahead == 1 {
        return NativeGitPullResult(outcome: "up-to-date", from: from, to: from)
      }
      let behind = git_graph_descendant_of(repository, target, local)
      try requireSuccess(behind, "Compare branches")
      guard behind == 1 else {
        throw GitOperationError(
          .gitNonFastForward,
          "This branch and its upstream have diverged. Pull only fast-forwards; nothing was changed.")
      }
      try checkoutCommit(repository, target)
      var updated: OpaquePointer?
      try requireSuccess(
        git_reference_set_target(&updated, head, target, "pull: fast-forward"), "Advance branch")
      git_reference_free(updated)
      return NativeGitPullResult(outcome: "fast-forwarded", from: from, to: to)
    }
  }

  private static func fastForwardUnborn(_ repository: OpaquePointer) throws -> NativeGitPullResult {
    var head: OpaquePointer?
    try requireSuccess(git_reference_lookup(&head, repository, "HEAD"), "Read initial branch")
    defer { git_reference_free(head) }
    guard let raw = git_reference_symbolic_target(head), let name = String(validatingCString: raw),
      name.hasPrefix("refs/heads/")
    else {
      throw GitOperationError(.gitDetachedHead, "Select a local branch before pulling.")
    }
    let branch = String(name.dropFirst(11))
    var tracking: OpaquePointer?
    let found = git_branch_lookup(&tracking, repository, "origin/\(branch)", GIT_BRANCH_REMOTE)
    defer { git_reference_free(tracking) }
    if found == GIT_ENOTFOUND.rawValue {
      throw GitOperationError(.gitNoUpstream, "Origin has no \(branch) branch yet.")
    }
    try requireSuccess(found, "Read upstream branch")
    guard let target = git_reference_target(tracking) else {
      throw GitOperationError(.gitFailure, "The upstream branch has no commit.")
    }
    try checkoutCommit(repository, target)
    var created: OpaquePointer?
    try requireSuccess(
      git_reference_create(&created, repository, name, target, 0, "pull: initial"), "Create branch")
    defer { git_reference_free(created) }
    _ = git_branch_set_upstream(created, "origin/\(branch)")
    return NativeGitPullResult(outcome: "fast-forwarded", from: nil, to: try objectID(target))
  }

  private static func checkoutCommit(_ repository: OpaquePointer, _ id: UnsafePointer<git_oid>)
    throws
  {
    var commit: OpaquePointer?
    try requireSuccess(git_commit_lookup(&commit, repository, id), "Read upstream commit")
    defer { git_commit_free(commit) }
    var options = git_checkout_options()
    try requireSuccess(
      git_checkout_options_init(&options, UInt32(GIT_CHECKOUT_OPTIONS_VERSION)),
      "Initialize checkout")
    options.checkout_strategy = GIT_CHECKOUT_SAFE.rawValue
    let result = git_checkout_tree(repository, commit, &options)
    if result == GIT_ECONFLICT.rawValue {
      throw GitOperationError(
        .gitConflict,
        "Local changes would be overwritten by the pull. Commit or discard them first; nothing was changed."
      )
    }
    try requireSuccess(result, "Update working tree")
  }

  static func initialize(repository: URL, initialBranch: String, origin: String?) throws {
    try validateBranchName(initialBranch)
    if let origin { _ = try remoteURL(origin, credential: nil) }
    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(
      atPath: repository.appendingPathComponent(".git").path, isDirectory: &isDirectory)
    {
      throw GitOperationError(.gitAlreadyRepository, "This workspace is already a Git repository.")
    }
    try withLibrary {
      var options = git_repository_init_options()
      try requireSuccess(
        git_repository_init_options_init(&options, UInt32(GIT_REPOSITORY_INIT_OPTIONS_VERSION)),
        "Initialize repository options")
      options.flags = GIT_REPOSITORY_INIT_NO_REINIT.rawValue
      var created: OpaquePointer?
      let result = initialBranch.withCString { head in
        options.initial_head = head
        return git_repository_init_ext(&created, repository.path, &options)
      }
      defer { git_repository_free(created) }
      if result == GIT_EEXISTS.rawValue {
        throw GitOperationError(.gitAlreadyRepository, "This workspace is already a Git repository.")
      }
      try requireSuccess(result, "Initialize repository")
      if let origin {
        var remote: OpaquePointer?
        try requireSuccess(git_remote_create(&remote, created, "origin", origin), "Add origin")
        git_remote_free(remote)
      }
    }
  }

  static func validateBranchName(_ name: String) throws {
    guard !name.isEmpty, name.utf8.count <= 255, !name.contains("\0") else {
      throw GitOperationError(.gitBranchInvalid, "Enter a valid Git branch name.")
    }
    let valid = try withLibrary { () -> Int32 in
      var valid: Int32 = 0
      try requireSuccess(git_branch_name_is_valid(&valid, name), "Validate branch name")
      return valid
    }
    guard valid == 1 else {
      throw GitOperationError(.gitBranchInvalid, "\"\(name)\" is not a valid Git branch name.")
    }
  }

  /// Creates a local branch at HEAD. Checking it out keeps working-tree changes, like
  /// `git switch -c`. On an unborn repository, checkout renames the initial branch.
  static func createBranch(repository: URL, name: String, checkout: Bool) throws {
    try validateBranchName(name)
    try withRepository(repository) { repository in
      var existing: OpaquePointer?
      let lookup = git_branch_lookup(&existing, repository, name, GIT_BRANCH_LOCAL)
      git_reference_free(existing)
      if lookup == 0 {
        throw GitOperationError(.gitBranchExists, "A local branch named \(name) already exists.")
      }
      if lookup != GIT_ENOTFOUND.rawValue { try requireSuccess(lookup, "Read branches") }
      var head: OpaquePointer?
      let headResult = git_repository_head(&head, repository)
      defer { git_reference_free(head) }
      if headResult == GIT_EUNBORNBRANCH.rawValue || headResult == GIT_ENOTFOUND.rawValue {
        guard checkout else {
          throw GitOperationError(.gitNoCommits, "Commit once before creating another branch.")
        }
        try requireSuccess(
          git_repository_set_head(repository, "refs/heads/\(name)"), "Select branch")
        return
      }
      try requireSuccess(headResult, "Read HEAD")
      var commit: OpaquePointer?
      try requireSuccess(git_reference_peel(&commit, head, GIT_OBJECT_COMMIT), "Read HEAD commit")
      defer { git_object_free(commit) }
      var created: OpaquePointer?
      try requireSuccess(
        git_branch_create(&created, repository, name, commit, 0), "Create branch")
      defer { git_reference_free(created) }
      if checkout, let reference = git_reference_name(created) {
        try requireSuccess(git_repository_set_head(repository, reference), "Select branch")
      }
    }
  }

  /// Whether the path exists only in the working tree (neither indexed nor committed).
  static func isUntracked(repository: URL, path: String) throws -> Bool {
    try validateGitPath(path)
    return try withRepository(repository) { repository in
      var flags: UInt32 = 0
      let result = git_status_file(&flags, repository, path)
      if result == GIT_ENOTFOUND.rawValue {
        throw GitOperationError(.pathNotFound, "The requested Git path does not exist.")
      }
      try requireSuccess(result, "Read file status")
      return flags & GIT_STATUS_WT_NEW.rawValue != 0
    }
  }

  /// Restores tracked working-tree files from the index. Staged changes are kept; unstage first to
  /// discard them too. Untracked files are removed only when `removeUntracked` is set.
  static func discard(repository: URL, path: String?, removeUntracked: Bool) throws {
    if let path { try validateGitPath(path) }
    try withRepository(repository) { repository in
      var options = git_checkout_options()
      try requireSuccess(
        git_checkout_options_init(&options, UInt32(GIT_CHECKOUT_OPTIONS_VERSION)),
        "Initialize checkout")
      options.checkout_strategy =
        GIT_CHECKOUT_FORCE.rawValue | GIT_CHECKOUT_DISABLE_PATHSPEC_MATCH.rawValue
        | (removeUntracked ? GIT_CHECKOUT_REMOVE_UNTRACKED.rawValue : 0)
      if let path {
        try withStringArray(path) { paths in
          options.paths = paths
          try requireSuccess(git_checkout_index(repository, nil, &options), "Discard changes")
        }
      } else {
        try requireSuccess(git_checkout_index(repository, nil, &options), "Discard changes")
      }
    }
  }

  static func remoteInfo(_ repository: OpaquePointer) throws -> NativeGitRemoteInfo {
    var origin: String?
    var remote: OpaquePointer?
    let remoteResult = git_remote_lookup(&remote, repository, "origin")
    if remoteResult != GIT_ENOTFOUND.rawValue {
      try requireSuccess(remoteResult, "Read origin")
      defer { git_remote_free(remote) }
      if let remote { origin = try originURL(remote) }
    }
    var head: OpaquePointer?
    let headResult = git_repository_head(&head, repository)
    defer { git_reference_free(head) }
    if headResult == GIT_EUNBORNBRANCH.rawValue || headResult == GIT_ENOTFOUND.rawValue {
      return NativeGitRemoteInfo(
        origin: origin, upstream: nil, ahead: nil, behind: nil, detached: false, unborn: true)
    }
    try requireSuccess(headResult, "Read HEAD")
    guard git_repository_head_detached(repository) == 0, let head else {
      return NativeGitRemoteInfo(
        origin: origin, upstream: nil, ahead: nil, behind: nil, detached: true, unborn: false)
    }
    var upstream: OpaquePointer?
    let upstreamResult = git_branch_upstream(&upstream, head)
    defer { git_reference_free(upstream) }
    guard upstreamResult == 0, let upstream, let local = git_reference_target(head),
      let target = git_reference_target(upstream)
    else {
      if upstreamResult != GIT_ENOTFOUND.rawValue { try requireSuccess(upstreamResult, "Read upstream") }
      return NativeGitRemoteInfo(
        origin: origin, upstream: nil, ahead: nil, behind: nil, detached: false, unborn: false)
    }
    var rawName: UnsafePointer<CChar>?
    try requireSuccess(git_branch_name(&rawName, upstream), "Read upstream name")
    let name = rawName.flatMap { String(validatingCString: $0) }
    var ahead = 0
    var behind = 0
    try requireSuccess(
      git_graph_ahead_behind(&ahead, &behind, repository, local, target), "Count commits")
    return NativeGitRemoteInfo(
      origin: origin, upstream: name, ahead: ahead, behind: behind, detached: false, unborn: false)
  }
}
