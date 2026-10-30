import DapperGit
import Foundation

struct NativeGitFile: Sendable {
  let path: String
  let originalPath: String?
  let indexStatus: String
  let worktreeStatus: String
  let untracked: Bool

  var payload: [String: Any] {
    [
      "path": path, "originalPath": originalPath.map { $0 as Any } ?? NSNull(),
      "indexStatus": indexStatus, "worktreeStatus": worktreeStatus,
      "staged": indexStatus != " " && !untracked,
      "unstaged": worktreeStatus != " " && !untracked, "untracked": untracked,
    ]
  }
}

struct NativeGitStatus: Sendable {
  let branch: String
  let files: [NativeGitFile]
  let totalFiles: Int
  let stagedFiles: Int
  let remote: NativeGitRemoteInfo

  var payload: [String: Any] {
    let base: [String: Any] = [
      "branch": branch, "files": files.map(\.payload), "clean": totalFiles == 0,
      "raw": files.map { "\($0.indexStatus)\($0.worktreeStatus) \($0.path)" }.joined(separator: "\n"),
      "truncated": totalFiles > files.count, "totalFiles": totalFiles,
      "omittedFiles": totalFiles - files.count, "maxFiles": 500, "maxBytes": 512 * 1024,
      "stagedFiles": stagedFiles,
    ]
    return base.merging(remote.payload) { current, _ in current }
  }
}

struct NativeGitDiff: Sendable {
  let diff: String
  let originalBytes: Int
  let returnedBytes: Int
  let maxBytes: Int

  var payload: [String: Any] {
    [
      "diff": diff, "originalBytes": originalBytes, "returnedBytes": returnedBytes,
      "maxBytes": maxBytes, "truncated": returnedBytes < originalBytes,
    ]
  }
}

struct NativeGitCommit: Sendable {
  let hash: String
  let subject: String
  let authorName: String
  let authoredAt: String
  let isHead: Bool

  var payload: [String: Any] {
    [
      "hash": hash, "shortHash": String(hash.prefix(7)), "subject": subject,
      "authorName": authorName, "authoredAt": authoredAt, "isHead": isHead,
      "refNames": isHead ? ["HEAD"] : [],
    ]
  }
}

extension NativeGit {
  static func status(repository: URL) throws -> NativeGitStatus {
    try withRepository(repository) { repository in
      var options = git_status_options()
      try requireSuccess(git_status_options_init(&options, UInt32(GIT_STATUS_OPTIONS_VERSION)), "Initialize status")
      options.flags = GIT_STATUS_OPT_INCLUDE_UNTRACKED.rawValue | GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS.rawValue
      var list: OpaquePointer?
      try requireSuccess(git_status_list_new(&list, repository, &options), "Read status")
      defer { git_status_list_free(list) }
      let count = git_status_list_entrycount(list)
      var files: [NativeGitFile] = []
      var rawBytes = 0
      for index in 0..<min(count, 500) {
        guard let entry = git_status_byindex(list, index) else { throw GitOperationError(.gitFailure, "Git returned an invalid status entry.") }
        let status = entry.pointee.status.rawValue
        let delta = entry.pointee.index_to_workdir ?? entry.pointee.head_to_index
        guard let delta, let raw = delta.pointee.new_file.path ?? delta.pointee.old_file.path,
          let path = String(validatingCString: raw) else {
          throw GitOperationError(.gitFailure, "Git file names must be valid UTF-8.")
        }
        let untracked = status & GIT_STATUS_WT_NEW.rawValue != 0
        let old = delta.pointee.old_file.path.flatMap { String(validatingCString: $0) }
        let file = NativeGitFile(
          path: path, originalPath: old != path ? old : nil,
          indexStatus: untracked ? "?" : statusCharacter(status, index: true),
          worktreeStatus: untracked ? "?" : statusCharacter(status, index: false),
          untracked: untracked
        )
        let bytes = path.utf8.count + 4
        if rawBytes + bytes > 512 * 1024 { break }
        rawBytes += bytes
        files.append(file)
      }
      let stagedMask =
        GIT_STATUS_INDEX_NEW.rawValue | GIT_STATUS_INDEX_MODIFIED.rawValue
        | GIT_STATUS_INDEX_DELETED.rawValue | GIT_STATUS_INDEX_RENAMED.rawValue
        | GIT_STATUS_INDEX_TYPECHANGE.rawValue
      var staged = 0
      for index in 0..<count {
        if let entry = git_status_byindex(list, index), entry.pointee.status.rawValue & stagedMask != 0 {
          staged += 1
        }
      }
      return NativeGitStatus(
        branch: try currentBranch(repository), files: files, totalFiles: count,
        stagedFiles: staged, remote: try remoteInfo(repository))
    }
  }

  static func diff(repository: URL, maximumBytes: Int = 128 * 1024) throws -> NativeGitDiff {
    guard (1...(128 * 1024)).contains(maximumBytes) else {
      throw GitOperationError(.invalidArgument, "Git diff limits must be between 1 and 131072 bytes.")
    }
    return try withRepository(repository) { repository in
      var tree: OpaquePointer?
      var head: OpaquePointer?
      let result = git_revparse_single(&head, repository, "HEAD^{tree}")
      if result != GIT_ENOTFOUND.rawValue && result != GIT_EUNBORNBRANCH.rawValue {
        try requireSuccess(result, "Read HEAD tree")
        tree = head
      }
      defer { git_object_free(head) }
      var options = git_diff_options()
      try requireSuccess(git_diff_options_init(&options, UInt32(GIT_DIFF_OPTIONS_VERSION)), "Initialize diff")
      options.flags = GIT_DIFF_INCLUDE_UNTRACKED.rawValue | GIT_DIFF_RECURSE_UNTRACKED_DIRS.rawValue | GIT_DIFF_SHOW_UNTRACKED_CONTENT.rawValue
      var staged: OpaquePointer?
      try requireSuccess(git_diff_tree_to_index(&staged, repository, tree, nil, &options), "Read staged diff")
      defer { git_diff_free(staged) }
      var unstaged: OpaquePointer?
      try requireSuccess(git_diff_index_to_workdir(&unstaged, repository, nil, &options), "Read unstaged diff")
      defer { git_diff_free(unstaged) }
      let collector = Unmanaged.passRetained(GitDiffCollector(limit: maximumBytes))
      defer { collector.release() }
      for (label, diff) in [
        ("Staged changes (HEAD -> index)", staged),
        ("Unstaged changes (index -> working tree)", unstaged),
      ] where git_diff_num_deltas(diff) > 0 {
        collector.takeUnretainedValue().append(Data("\(label)\n".utf8))
        try requireSuccess(git_diff_print(diff, GIT_DIFF_FORMAT_PATCH, { _, _, line, payload in
          guard let line, let payload else { return GIT_EUSER.rawValue }
          let collector = Unmanaged<GitDiffCollector>.fromOpaque(payload).takeUnretainedValue()
          let origin = line.pointee.origin
          if origin == 43 || origin == 45 || origin == 32 {
            collector.append(Data([UInt8(bitPattern: origin)]))
          }
          if let content = line.pointee.content {
            collector.append(content, count: line.pointee.content_len)
          }
          return 0
        }, collector.toOpaque()), "Format diff")
        collector.takeUnretainedValue().append(Data("\n".utf8))
      }
      return try collector.takeUnretainedValue().result()
    }
  }

  static func history(repository: URL) throws -> [NativeGitCommit] {
    try withRepository(repository) { repository in
      var walk: OpaquePointer?
      try requireSuccess(git_revwalk_new(&walk, repository), "Initialize history")
      defer { git_revwalk_free(walk) }
      git_revwalk_sorting(walk, GIT_SORT_TOPOLOGICAL.rawValue | GIT_SORT_TIME.rawValue)
      let headResult = git_revwalk_push_head(walk)
      if headResult == GIT_ENOTFOUND.rawValue || headResult == GIT_EUNBORNBRANCH.rawValue { return [] }
      try requireSuccess(headResult, "Read history")
      let formatter = ISO8601DateFormatter()
      var commits: [NativeGitCommit] = []
      var oid = git_oid()
      while commits.count < 40 {
        let next = git_revwalk_next(&oid, walk)
        if next == GIT_ITEROVER.rawValue { break }
        try requireSuccess(next, "Read next commit")
        var commit: OpaquePointer?
        try requireSuccess(git_commit_lookup(&commit, repository, &oid), "Read commit")
        defer { git_commit_free(commit) }
        guard let rawSubject = git_commit_summary(commit), let subject = String(validatingCString: rawSubject),
          let author = git_commit_author(commit), let rawName = author.pointee.name,
          let name = String(validatingCString: rawName) else {
          throw GitOperationError(.gitFailure, "Git commit metadata must be valid UTF-8.")
        }
        commits.append(NativeGitCommit(
          hash: try objectID(&oid), subject: subject, authorName: name,
          authoredAt: formatter.string(from: Date(timeIntervalSince1970: TimeInterval(git_commit_time(commit)))),
          isHead: commits.isEmpty
        ))
      }
      return commits
    }
  }

  static func currentBranch(_ repository: OpaquePointer) throws -> String {
    var head: OpaquePointer?
    let result = git_repository_head(&head, repository)
    defer { git_reference_free(head) }
    if result == GIT_ENOTFOUND.rawValue || result == GIT_EUNBORNBRANCH.rawValue {
      try requireSuccess(git_reference_lookup(&head, repository, "HEAD"), "Read initial branch")
      guard let target = git_reference_symbolic_target(head), let name = String(validatingCString: target) else {
        throw GitOperationError(.gitFailure, "The initial Git branch is invalid.")
      }
      return name.hasPrefix("refs/heads/") ? String(name.dropFirst(11)) : name
    }
    try requireSuccess(result, "Read branch")
    guard let raw = git_reference_shorthand(head), let name = String(validatingCString: raw) else {
      throw GitOperationError(.gitFailure, "The Git branch name is invalid.")
    }
    return name
  }

  private static func statusCharacter(_ status: UInt32, index: Bool) -> String {
    if status & GIT_STATUS_CONFLICTED.rawValue != 0 { return "U" }
    let options: [(UInt32, String)] = index
      ? [(GIT_STATUS_INDEX_NEW.rawValue, "A"), (GIT_STATUS_INDEX_DELETED.rawValue, "D"), (GIT_STATUS_INDEX_RENAMED.rawValue, "R"), (GIT_STATUS_INDEX_TYPECHANGE.rawValue, "T"), (GIT_STATUS_INDEX_MODIFIED.rawValue, "M")]
      : [(GIT_STATUS_WT_DELETED.rawValue, "D"), (GIT_STATUS_WT_RENAMED.rawValue, "R"), (GIT_STATUS_WT_TYPECHANGE.rawValue, "T"), (GIT_STATUS_WT_MODIFIED.rawValue, "M")]
    return options.first(where: { status & $0.0 != 0 })?.1 ?? " "
  }
}

private final class GitDiffCollector {
  private let limit: Int
  private var data = Data()
  private var total = 0

  init(limit: Int) { self.limit = limit }

  func append(_ bytes: Data) {
    total += bytes.count
    if data.count < limit { data.append(bytes.prefix(limit - data.count)) }
  }

  func append(_ bytes: UnsafePointer<CChar>, count: Int) {
    total += count
    let remaining = limit - data.count
    if remaining > 0 {
      let pointer = UnsafeRawPointer(bytes).assumingMemoryBound(to: UInt8.self)
      data.append(pointer, count: min(remaining, count))
    }
  }

  func result() throws -> NativeGitDiff {
    if let text = String(data: data, encoding: .utf8) {
      return NativeGitDiff(diff: text, originalBytes: total, returnedBytes: data.count, maxBytes: limit)
    }
    guard total > limit else { throw GitOperationError(.gitFailure, "The Git diff is not valid UTF-8 text.") }
    for _ in 0..<3 where !data.isEmpty {
      data.removeLast()
      if let text = String(data: data, encoding: .utf8) {
        return NativeGitDiff(diff: text, originalBytes: total, returnedBytes: data.count, maxBytes: limit)
      }
    }
    throw GitOperationError(.gitFailure, "The truncated Git diff is not valid UTF-8 text.")
  }
}
