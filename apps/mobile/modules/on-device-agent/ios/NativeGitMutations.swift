import DapperGit
import Foundation

struct NativeGitBranch: Sendable {
  let name: String
  let remote: Bool
  let current: Bool

  var payload: [String: Any] {
    ["name": name, "remote": remote, "current": current]
  }
}

extension NativeGit {
  static func stageAll(repository: URL) throws {
    try withRepository(repository) { repository in
      var index: OpaquePointer?
      try requireSuccess(git_repository_index(&index, repository), "Open index")
      defer { git_index_free(index) }
      try requireSuccess(git_index_add_all(index, nil, GIT_INDEX_ADD_DEFAULT.rawValue, nil, nil), "Stage workspace")
      try requireSuccess(git_index_write(index), "Write index")
    }
  }

  static func unstage(repository: URL, path: String?) throws {
    if let path { try validateGitPath(path) }
    try withRepository(repository) { repository in
      var index: OpaquePointer?
      try requireSuccess(git_repository_index(&index, repository), "Open index")
      defer { git_index_free(index) }
      var object: OpaquePointer?
      let head = git_revparse_single(&object, repository, "HEAD^{tree}")
      if head != GIT_ENOTFOUND.rawValue && head != GIT_EUNBORNBRANCH.rawValue {
        try requireSuccess(head, "Read HEAD tree")
      }
      defer { git_object_free(object) }
      if let path {
        try restoreIndexPath(index, tree: object, path: path)
      } else if let object {
        try requireSuccess(git_index_read_tree(index, object), "Reset index")
      } else {
        try requireSuccess(git_index_clear(index), "Clear initial index")
      }
      try requireSuccess(git_index_write(index), "Write index")
    }
  }

  static func branches(repository: URL) throws -> [NativeGitBranch] {
    try withRepository(repository) { repository in
      var iterator: OpaquePointer?
      try requireSuccess(git_branch_iterator_new(&iterator, repository, GIT_BRANCH_ALL), "Read branches")
      defer { git_branch_iterator_free(iterator) }
      var branches: [NativeGitBranch] = []
      while true {
        var reference: OpaquePointer?
        var type = GIT_BRANCH_LOCAL
        let next = git_branch_next(&reference, &type, iterator)
        if next == GIT_ITEROVER.rawValue { break }
        try requireSuccess(next, "Read branch")
        defer { git_reference_free(reference) }
        guard branches.count < 500 else {
          throw GitOperationError("This repository has more than 500 branches. Use the desktop for its full branch list.")
        }
        guard let raw = git_reference_shorthand(reference), let name = String(validatingCString: raw) else {
          throw GitOperationError("Git branch names must be UTF-8.")
        }
        branches.append(NativeGitBranch(
          name: name, remote: type == GIT_BRANCH_REMOTE, current: git_branch_is_head(reference) == 1
        ))
      }
      return branches.sorted { $0.name < $1.name }
    }
  }

  static func switchBranch(repository: URL, branch: String) throws {
    guard !branch.isEmpty, !branch.contains("\0"), branch.utf8.count <= 1024 else {
      throw GitOperationError("Enter a valid Git branch name.")
    }
    guard try isClean(repository: repository) else {
      throw GitOperationError("Commit or remove workspace changes before switching branches.")
    }
    try withRepository(repository) { repository in
      var reference: OpaquePointer?
      let local = git_branch_lookup(&reference, repository, branch, GIT_BRANCH_LOCAL)
      if local == GIT_ENOTFOUND.rawValue {
        reference = try trackingBranch(repository, remoteName: branch)
      } else {
        try requireSuccess(local, "Read local branch")
      }
      defer { git_reference_free(reference) }
      guard let reference, let target = git_reference_target(reference),
        let name = git_reference_name(reference) else {
        throw GitOperationError("The selected branch has no commit.")
      }
      var commit: OpaquePointer?
      try requireSuccess(git_commit_lookup(&commit, repository, target), "Read branch commit")
      defer { git_commit_free(commit) }
      var options = git_checkout_options()
      try requireSuccess(git_checkout_options_init(&options, UInt32(GIT_CHECKOUT_OPTIONS_VERSION)), "Initialize checkout")
      options.checkout_strategy = GIT_CHECKOUT_SAFE.rawValue
      try requireSuccess(git_checkout_tree(repository, commit, &options), "Check out branch")
      try requireSuccess(git_repository_set_head(repository, name), "Select branch")
    }
  }

  private static func restoreIndexPath(_ index: OpaquePointer?, tree: OpaquePointer?, path: String) throws {
    var entry: OpaquePointer?
    let found = tree.map { git_tree_entry_bypath(&entry, $0, path) } ?? GIT_ENOTFOUND.rawValue
    defer { git_tree_entry_free(entry) }
    if found == GIT_ENOTFOUND.rawValue {
      let removed = git_index_remove_bypath(index, path)
      if removed != GIT_ENOTFOUND.rawValue { try requireSuccess(removed, "Unstage new file") }
      return
    }
    try requireSuccess(found, "Read indexed HEAD path")
    guard let entry, let oid = git_tree_entry_id(entry) else {
      throw GitOperationError("The original Git index entry is unavailable.")
    }
    var restored = git_index_entry()
    restored.id = oid.pointee
    restored.mode = git_tree_entry_filemode(entry).rawValue
    try path.withCString { name in
      restored.path = name
      try requireSuccess(git_index_add(index, &restored), "Restore index path")
    }
  }

  private static func trackingBranch(_ repository: OpaquePointer, remoteName: String) throws -> OpaquePointer {
    var remote: OpaquePointer?
    try requireSuccess(git_branch_lookup(&remote, repository, remoteName, GIT_BRANCH_REMOTE), "Read remote branch")
    defer { git_reference_free(remote) }
    guard let target = git_reference_target(remote), let slash = remoteName.firstIndex(of: "/") else {
      throw GitOperationError("Choose an existing local or remote branch.")
    }
    let localName = String(remoteName[remoteName.index(after: slash)...])
    var commit: OpaquePointer?
    try requireSuccess(git_commit_lookup(&commit, repository, target), "Read tracking commit")
    defer { git_commit_free(commit) }
    var created: OpaquePointer?
    try requireSuccess(git_branch_create(&created, repository, localName, commit, 0), "Create tracking branch")
    guard let created else { throw GitOperationError("Git did not return the tracking branch.") }
    do {
      try requireSuccess(git_branch_set_upstream(created, remoteName), "Set tracking branch")
    } catch let error as GitOperationError {
      git_reference_free(created)
      throw error
    }
    return created
  }
}
