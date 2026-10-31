import DapperGit
import Foundation

enum NativeGit {
  static func clone(remote: String, destination: URL, credential: StoredGitCredential?) throws {
    let url = try remoteURL(remote, credential: credential)
    try withLibrary {
      try withCredentials(credential) { callbacks in
        var options = git_clone_options()
        try requireSuccess(
          git_clone_options_init(&options, UInt32(GIT_CLONE_OPTIONS_VERSION)), "Initialize clone")
        options.fetch_opts.callbacks = callbacks
        options.fetch_opts.follow_redirects = GIT_REMOTE_REDIRECT_NONE
        var repository: OpaquePointer?
        defer { git_repository_free(repository) }
        try requireRemoteSuccess(
          git_clone(&repository, url.absoluteString, destination.path, &options), "Clone repository"
        )
      }
    }
  }

  static func stage(repository: URL, path: String) throws {
    try validateGitPath(path)
    try withRepository(repository) { repository in
      var index: OpaquePointer?
      try requireSuccess(git_repository_index(&index, repository), "Open index")
      defer { git_index_free(index) }
      try withStringArray(path) { paths in
        var matched: Int32 = 0
        try withUnsafeMutablePointer(to: &matched) { pointer in
          try requireSuccess(
            git_index_add_all(
              index, &paths,
              GIT_INDEX_ADD_DISABLE_PATHSPEC_MATCH.rawValue | GIT_INDEX_ADD_CHECK_PATHSPEC.rawValue,
              { _, _, payload in
                guard let payload else { return GIT_EUSER.rawValue }
                payload.assumingMemoryBound(to: Int32.self).pointee = 1
                return 0
              },
              pointer
            ),
            "Stage file"
          )
        }
        guard matched != 0 else {
          throw GitOperationError(.pathNotFound, "The requested Git path does not exist and is not tracked.")
        }
      }
      try requireSuccess(git_index_write(index), "Write index")
    }
  }

  static func validateGitPath(_ path: String) throws {
    guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\0"), !path.contains("\\"),
      !path.split(separator: "/").contains(where: {
        $0 == "." || $0 == ".." || $0.lowercased() == ".git"
      })
    else {
      throw GitOperationError(.pathOutsideWorkspace, "Git requires a workspace-relative path outside Git metadata.")
    }
  }

  static func isClean(repository: URL) throws -> Bool {
    try withRepository(repository) { repository in
      var options = git_status_options()
      try requireSuccess(
        git_status_options_init(&options, UInt32(GIT_STATUS_OPTIONS_VERSION)), "Initialize status")
      options.flags =
        GIT_STATUS_OPT_INCLUDE_UNTRACKED.rawValue | GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS.rawValue
      var status: OpaquePointer?
      try requireSuccess(git_status_list_new(&status, repository, &options), "Read status")
      defer { git_status_list_free(status) }
      return git_status_list_entrycount(status) == 0
    }
  }

  static func commit(repository: URL, message: String, authorName: String, authorEmail: String)
    throws -> String
  {
    guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      !message.contains("\0"), message.utf8.count <= 64 * 1024,
      !authorName.isEmpty, !authorEmail.isEmpty,
      !authorName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
      !authorEmail.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    else {
      throw GitOperationError(.invalidArgument, "A commit message and author identity are required.")
    }
    return try withRepository(repository) { repository in
      var index: OpaquePointer?
      try requireSuccess(git_repository_index(&index, repository), "Open index")
      defer { git_index_free(index) }
      var treeID = git_oid()
      try requireSuccess(git_index_write_tree(&treeID, index), "Write tree")
      var tree: OpaquePointer?
      try requireSuccess(git_tree_lookup(&tree, repository, &treeID), "Read tree")
      defer { git_tree_free(tree) }
      var signature: UnsafeMutablePointer<git_signature>?
      try requireSuccess(git_signature_now(&signature, authorName, authorEmail), "Create author")
      defer { git_signature_free(signature) }
      var parentID = git_oid()
      let parentResult = git_reference_name_to_id(&parentID, repository, "HEAD")
      var parent: OpaquePointer?
      if parentResult != GIT_ENOTFOUND.rawValue && parentResult != GIT_EUNBORNBRANCH.rawValue {
        try requireSuccess(parentResult, "Read HEAD")
        try requireSuccess(git_commit_lookup(&parent, repository, &parentID), "Read parent commit")
      }
      defer { git_commit_free(parent) }
      if let parent, let parentTree = git_commit_tree_id(parent) {
        guard git_oid_equal(parentTree, &treeID) == 0 else {
          throw GitOperationError(.gitNothingToCommit, "There are no staged changes to commit.")
        }
      } else if git_index_entrycount(index) == 0 {
        throw GitOperationError(.gitNothingToCommit, "There are no staged changes to commit.")
      }
      var parents: [OpaquePointer?] = parent.map { [$0] } ?? []
      var commitID = git_oid()
      try parents.withUnsafeMutableBufferPointer { buffer in
        try requireSuccess(
          git_commit_create(
            &commitID, repository, "HEAD", signature, signature, nil, message, tree, buffer.count,
            buffer.baseAddress),
          "Create commit"
        )
      }
      return try objectID(&commitID)
    }
  }

  static func push(repository: URL, credential: StoredGitCredential?) throws {
    try withRepository(repository) { repository in
      let remote = try lookupOrigin(repository)
      defer { git_remote_free(remote) }
      _ = try remoteURL(try originURL(remote), credential: credential)
      var head: OpaquePointer?
      try requireSuccess(git_repository_head(&head, repository), "Read HEAD")
      defer { git_reference_free(head) }
      guard git_repository_head_detached(repository) == 0,
        let rawName = git_reference_name(head), let name = String(validatingCString: rawName),
        name.hasPrefix("refs/heads/")
      else {
        throw GitOperationError(.gitDetachedHead, "Select a local branch before pushing.")
      }
      try withCredentials(credential) { callbacks in
        var options = git_push_options()
        try requireSuccess(
          git_push_options_init(&options, UInt32(GIT_PUSH_OPTIONS_VERSION)), "Initialize push")
        options.callbacks = callbacks
        options.follow_redirects = GIT_REMOTE_REDIRECT_NONE
        options.pb_parallelism = 1
        try withStringArray("\(name):\(name)") { specs in
          try requireRemoteSuccess(git_remote_push(remote, &specs, &options), "Push branch")
        }
      }
      trackPushedBranch(repository, head: head, branch: String(name.dropFirst(11)))
    }
  }

  /// A first push of a new local branch records `origin/<branch>` as its upstream, so later status
  /// reads can report ahead/behind counts and pulls know what to fast-forward to.
  private static func trackPushedBranch(_ repository: OpaquePointer, head: OpaquePointer?, branch: String) {
    var upstream: OpaquePointer?
    let existing = git_branch_upstream(&upstream, head)
    git_reference_free(upstream)
    guard existing == GIT_ENOTFOUND.rawValue else { return }
    var tracking: OpaquePointer?
    guard git_branch_lookup(&tracking, repository, "origin/\(branch)", GIT_BRANCH_REMOTE) == 0 else { return }
    git_reference_free(tracking)
    // The push already succeeded; failing to record tracking must not report it as failed.
    _ = git_branch_set_upstream(head, "origin/\(branch)")
  }

  static func lookupOrigin(_ repository: OpaquePointer) throws -> OpaquePointer {
    var remote: OpaquePointer?
    let found = git_remote_lookup(&remote, repository, "origin")
    if found == GIT_ENOTFOUND.rawValue {
      throw GitOperationError(.gitNoOrigin, "This repository has no origin remote.")
    }
    try requireSuccess(found, "Read origin")
    guard let remote else { throw GitOperationError(.gitNoOrigin, "This repository has no origin remote.") }
    return remote
  }

  static func originURL(_ remote: OpaquePointer) throws -> String {
    guard let raw = git_remote_url(remote), let url = String(validatingCString: raw) else {
      throw GitOperationError(.gitInsecureRemote, "Origin does not have a valid UTF-8 URL.")
    }
    return url
  }

  static func remoteURL(_ raw: String, credential: StoredGitCredential?) throws -> URL {
    guard let url = URL(string: raw), url.scheme == "https", let host = url.host,
      !host.isEmpty, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
    else {
      throw GitOperationError(.gitInsecureRemote, "Only HTTPS Git URLs without embedded credentials are supported.")
    }
    if let credential {
      guard credential.host == host, credential.port == (url.port ?? 443) else {
        throw GitOperationError(.gitCredentialOrigin, "Git credentials cannot be sent to this origin.")
      }
    }
    return url
  }

  static func withLibrary<T>(_ action: () throws -> T) throws -> T {
    try requireSuccess(git_libgit2_init(), "Initialize Git")
    defer { _ = git_libgit2_shutdown() }
    try requireSuccess(DapperGitConfigureNetworkTimeouts(), "Configure Git network timeouts")
    return try action()
  }

  static func withRepository<T>(_ url: URL, _ action: (OpaquePointer) throws -> T) throws
    -> T
  {
    try withLibrary {
      var repository: OpaquePointer?
      let opened = git_repository_open(&repository, url.path)
      if opened == GIT_ENOTFOUND.rawValue {
        throw GitOperationError(
          .gitNotRepository, "This workspace is not a Git repository. Initialize Git to track changes.")
      }
      try requireSuccess(opened, "Open repository")
      guard let repository else { throw GitOperationError(.gitFailure, "Git did not return a repository.") }
      defer { git_repository_free(repository) }
      return try action(repository)
    }
  }

  static func withCredentials<T>(
    _ credential: StoredGitCredential?,
    _ action: (git_remote_callbacks) throws -> T
  ) throws -> T {
    let operation = GitNetworkOperation.shared
    try operation.begin()
    defer { operation.finish() }
    var callbacks = git_remote_callbacks()
    try requireSuccess(
      git_remote_init_callbacks(&callbacks, UInt32(GIT_REMOTE_CALLBACKS_VERSION)),
      "Initialize remote callbacks")
    callbacks.push_update_reference = { _, status, _ in
      guard status != nil else { return 0 }
      return GIT_EUSER.rawValue
    }
    callbacks.transfer_progress = { statistics, _ in
      GitNetworkOperation.shared.progress(
        completed: statistics.map { Int($0.pointee.received_objects) },
        total: statistics.map { Int($0.pointee.total_objects) })
    }
    callbacks.push_transfer_progress = { completed, total, _, _ in
      GitNetworkOperation.shared.progress(completed: Int(completed), total: Int(total))
    }
    callbacks.sideband_progress = { _, _, _ in GitNetworkOperation.shared.progress() }
    let payload = Unmanaged.passRetained(GitCredentialPayload(credential))
    defer { payload.release() }
    callbacks.payload = payload.toOpaque()
    callbacks.credentials = { output, rawURL, _, allowed, payload in
      guard let output, let rawURL, let payload,
        let urlString = String(validatingCString: rawURL),
        let url = URL(string: urlString), url.scheme == "https"
      else {
        return GIT_EUSER.rawValue
      }
      let context = Unmanaged<GitCredentialPayload>.fromOpaque(payload).takeUnretainedValue()
      guard GitNetworkOperation.shared.progress() == 0 else { return GIT_EUSER.rawValue }
      guard let credential = context.credential else { return GIT_PASSTHROUGH.rawValue }
      guard credential.host == url.host, credential.port == (url.port ?? 443),
        url.user == nil, url.password == nil
      else {
        return GIT_EUSER.rawValue
      }
      guard allowed & GIT_CREDENTIAL_USERPASS_PLAINTEXT.rawValue != 0 else {
        if allowed & GIT_CREDENTIAL_USERNAME.rawValue != 0 {
          return git_credential_username_new(output, credential.username)
        }
        return GIT_PASSTHROUGH.rawValue
      }
      guard !context.suppliedPassword else { return GIT_EAUTH.rawValue }
      context.suppliedPassword = true
      return git_credential_userpass_plaintext_new(output, credential.username, credential.token)
    }
    return try action(callbacks)
  }

  static func objectID(_ id: UnsafePointer<git_oid>) throws -> String {
    guard let string = git_oid_tostr_s(id), let result = String(validatingCString: string) else {
      throw GitOperationError(.gitFailure, "Git returned an invalid object ID.")
    }
    return result
  }

  static func withStringArray(
    _ value: String, _ action: (inout git_strarray) throws -> Void
  ) throws {
    guard let string = strdup(value) else {
      throw GitOperationError(.gitFailure, "Could not allocate a Git path.")
    }
    defer { free(string) }
    var strings: [UnsafeMutablePointer<CChar>?] = [string]
    try strings.withUnsafeMutableBufferPointer { buffer in
      var array = git_strarray(strings: buffer.baseAddress, count: buffer.count)
      try action(&array)
    }
  }

  static func requireRemoteSuccess(_ code: Int32, _ operation: String) throws {
    if GitNetworkOperation.shared.progress() != 0 {
      throw GitOperationError(
        .gitTransferInterrupted,
        "Git transfer was interrupted. A remote update may already have completed; inspect the repository before retrying."
      )
    }
    guard code < 0 else { return }
    let detail: String
    let category: NativeErrorCode
    switch code {
    case GIT_EAUTH.rawValue:
      category = .gitAuthFailed
      detail = "Authentication failed. Sign in again and check repository access."
    case GIT_ECERTIFICATE.rawValue:
      category = .gitCertificate
      detail = "TLS certificate verification failed."
    case GIT_ENONFASTFORWARD.rawValue:
      category = .gitNonFastForward
      detail =
        "The remote contains changes that are not in this branch. Pull, then try again. No force-push was attempted."
    case GIT_EUSER.rawValue:
      category = .gitRemoteRejected
      detail = "The remote rejected the update or credential use was not permitted."
    default:
      category = .gitNetwork
      detail =
        "Check the connection, canonical HTTPS URL, permissions, and remote branch rules. Redirects are not followed."
    }
    throw GitOperationError(category, "\(operation) failed (\(code)): \(detail)")
  }

  static func requireSuccess(_ code: Int32, _ operation: String) throws {
    guard code >= 0 else {
      let message = git_error_last().flatMap { $0.pointee.message }.flatMap {
        String(validatingCString: $0)
      }
      let category: NativeErrorCode
      switch code {
      case GIT_ECONFLICT.rawValue, GIT_EMERGECONFLICT.rawValue:
        category = .gitConflict
      case GIT_ELOCKED.rawValue:
        category = .gitLocked
      default:
        category = .gitFailure
      }
      throw GitOperationError(
        category,
        "\(operation) failed (\(code)): \(message ?? "No Git error detail was provided.")")
    }
  }
}

private final class GitCredentialPayload {
  let credential: StoredGitCredential?
  var suppliedPassword = false
  init(_ credential: StoredGitCredential?) { self.credential = credential }
}
