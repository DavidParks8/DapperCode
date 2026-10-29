import DapperGit
import Foundation

private struct GateError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

private func check(_ condition: Bool, _ name: String) throws {
  guard condition else { throw GateError(name) }
  print("PASS: \(name)")
}

private func rejected(_ name: String, containing: String, _ action: () throws -> Void) throws {
  do {
    try action()
  } catch {
    try check(error.localizedDescription.contains(containing), name)
    return
  }
  throw GateError("\(name): operation unexpectedly succeeded.")
}

private func checkSeparateDiffs(repository: URL) throws {
  let original = "ORIGINAL\n"
  let staged = "STAGED_VERSION\n"
  let file = repository.appendingPathComponent("hello.txt")
  let clean = try NativeGit.diff(repository: repository)
  try check(clean.diff.isEmpty && clean.originalBytes == 0, "clean repositories have no diff sections")
  try staged.write(to: file, atomically: true, encoding: .utf8)
  try NativeGit.stage(repository: repository, path: "hello.txt")
  let stagedOnly = try NativeGit.diff(repository: repository)
  try check(
    stagedOnly.diff.contains("-ORIGINAL") && stagedOnly.diff.contains("+STAGED_VERSION") &&
      !stagedOnly.diff.contains("Unstaged changes (index -> working tree)"),
    "staged-only diffs show the content that will be committed")

  try original.write(to: file, atomically: true, encoding: .utf8)
  let status = try NativeGit.status(repository: repository)
  try check(
    status.files.contains { $0.path == "hello.txt" && $0.indexStatus == "M" && $0.worktreeStatus == "M" },
    "reverting only the working file leaves both staged and unstaged changes")
  let patch = try NativeGit.diff(repository: repository)
  try check(
    !patch.diff.isEmpty,
    "staged content remains visible after reverting only the working file")
  let sections = patch.diff.components(separatedBy: "Unstaged changes (index -> working tree)\n")
  try check(
    sections.count == 2 && sections[0].contains("Staged changes (HEAD -> index)") &&
      sections[0].contains("-ORIGINAL") && sections[0].contains("+STAGED_VERSION") &&
      sections[1].contains("-STAGED_VERSION") && sections[1].contains("+ORIGINAL"),
    "opposing index and working-tree patches remain independently visible")
  let limited = try NativeGit.diff(repository: repository, maximumBytes: 96)
  try check(
    limited.originalBytes == patch.diff.utf8.count && limited.returnedBytes <= 96 &&
      limited.returnedBytes == limited.diff.utf8.count && limited.originalBytes > limited.returnedBytes,
    "both diff sections and their labels share one output byte budget")

  _ = try NativeGit.commit(
    repository: repository, message: "test: preserve staged content",
    authorName: "Native Fixture", authorEmail: "fixture@example.invalid")
  let committed = try NativeGit.withRepository(repository) { repository -> String? in
    var blob: OpaquePointer?
    try NativeGit.requireSuccess(git_revparse_single(&blob, repository, "HEAD:hello.txt"), "Read committed fixture")
    defer { git_object_free(blob) }
    guard let bytes = git_blob_rawcontent(blob) else { throw GateError("The committed file is missing.") }
    return String(data: Data(bytes: bytes, count: Int(git_blob_rawsize(blob))), encoding: .utf8)
  }
  try check(
    committed == staged && (try String(contentsOf: file, encoding: .utf8)) == original,
    "commit records the displayed index content without replacing the working file")
  let unstagedOnly = try NativeGit.diff(repository: repository)
  try check(
    !unstagedOnly.diff.contains("Staged changes (HEAD -> index)") &&
      unstagedOnly.diff.contains("Unstaged changes (index -> working tree)") &&
      unstagedOnly.diff.contains("-STAGED_VERSION") && unstagedOnly.diff.contains("+ORIGINAL"),
    "committing clears only the staged diff and retains the unstaged patch")
  try "UNTRACKED_CONTENT\n".write(
    to: repository.appendingPathComponent("untracked.txt"), atomically: true, encoding: .utf8)
  try check(
    try NativeGit.diff(repository: repository).diff.contains("+UNTRACKED_CONTENT"),
    "unstaged diffs retain untracked file content")
}

private func runGitGate() throws {
  let environment = ProcessInfo.processInfo.environment
  guard let remote = environment["NATIVE_GIT_URL"], let url = URL(string: remote),
    let host = url.host, let password = environment["NATIVE_GIT_PASSWORD"],
    let username = environment["NATIVE_GIT_USER"]
  else {
    throw GateError("Missing native Git fixture configuration.")
  }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("native-git-gate")
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let credential = StoredGitCredential(
    host: host, port: url.port ?? 443, accountId: "native-gate", username: username, token: password
  )
  try rejected("non-HTTPS remotes are rejected", containing: "Only HTTPS") {
    try NativeGit.clone(
      remote: "http://127.0.0.1/remote.git", destination: root.appendingPathComponent("insecure"),
      credential: nil)
  }
  let otherOrigin = StoredGitCredential(
    host: "different.invalid", port: credential.port, accountId: "native-gate", username: username,
    token: password
  )
  try rejected("credentials are bound to the authorized origin", containing: "origin") {
    try NativeGit.clone(
      remote: remote, destination: root.appendingPathComponent("other-origin"),
      credential: otherOrigin)
  }
  let incorrect = StoredGitCredential(
    host: host, port: credential.port, accountId: "native-gate", username: username,
    token: "incorrect-test-password"
  )
  try rejected("incorrect HTTPS credentials fail explicitly", containing: "Authentication failed") {
    try NativeGit.clone(
      remote: remote, destination: root.appendingPathComponent("incorrect"), credential: incorrect)
  }
  let repository = root.appendingPathComponent("checkout")
  let stalled = url.deletingLastPathComponent().appendingPathComponent("stalled.git").absoluteString
  DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
    GitNetworkOperation.shared.cancel()
  }
  let started = Date()
  try rejected("cancelled stalled transfers fail explicitly", containing: "interrupted") {
    try NativeGit.clone(remote: stalled, destination: root.appendingPathComponent("cancelled"), credential: credential)
  }
  try check(Date().timeIntervalSince(started) < 25, "unresponsive Git transports have a bounded timeout")
  try check(GitNetworkOperation.shared.snapshot()["active"] as? Bool == false, "cancelled Git transfers release native ownership")
  try NativeGit.clone(remote: remote, destination: repository, credential: credential)
  try check(try NativeGit.isClean(repository: repository), "authenticated HTTPS clone is clean")
  let initialStatus = try NativeGit.status(repository: repository)
  try check(initialStatus.branch == "main" && initialStatus.files.isEmpty, "structured Git status reports the active branch")
  let initialHistory = try NativeGit.history(repository: repository)
  try check(initialHistory.count == 1 && initialHistory[0].subject == "seed" && initialHistory[0].isHead, "native history reports the current commit")
  let diffRepository = root.appendingPathComponent("diff-checkout")
  try NativeGit.clone(remote: remote, destination: diffRepository, credential: credential)
  try checkSeparateDiffs(repository: diffRepository)
  try rejected(
    "Git metadata cannot be staged through the file API", containing: "workspace-relative"
  ) {
    try NativeGit.stage(repository: repository, path: ".git/config")
  }
  try rejected("path traversal is rejected", containing: "workspace-relative") {
    try NativeGit.stage(repository: repository, path: "../outside.txt")
  }
  try rejected("nonexistent Git paths are not reported as staged", containing: "does not exist") {
    try NativeGit.stage(repository: repository, path: "missing.txt")
  }
  let localHook = repository.appendingPathComponent(".git/hooks/pre-commit")
  try "#!/bin/sh\nexit 99\n".write(to: localHook, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: localHook.path)
  try "NATIVE_GIT_CHANGED\n".write(
    to: repository.appendingPathComponent("hello.txt"), atomically: true, encoding: .utf8)
  try check(
    !(try NativeGit.isClean(repository: repository)), "native status reports an edited file")
  let changed = try NativeGit.status(repository: repository)
  try check(changed.files.contains { $0.path == "hello.txt" && $0.worktreeStatus == "M" && $0.indexStatus == " " }, "status distinguishes unstaged changes")
  let patch = try NativeGit.diff(repository: repository)
  try check(patch.diff.contains("-ORIGINAL") && patch.diff.contains("+NATIVE_GIT_CHANGED"), "native diffs contain actual old and new file text")
  try rejected("dirty branch switches preserve workspace changes", containing: "Commit or remove") {
    try NativeGit.switchBranch(repository: repository, branch: "origin/feature")
  }
  try NativeGit.stage(repository: repository, path: "hello.txt")
  try NativeGit.unstage(repository: repository, path: "hello.txt")
  let unstaged = try NativeGit.status(repository: repository)
  try check(unstaged.files.contains { $0.path == "hello.txt" && $0.indexStatus == " " && $0.worktreeStatus == "M" }, "unstaging preserves the working-tree edit")
  try NativeGit.stageAll(repository: repository)
  _ = try NativeGit.commit(
    repository: repository, message: "test: native file edit", authorName: "Native Fixture",
    authorEmail: "fixture@example.invalid")
  try check(
    try NativeGit.isClean(repository: repository),
    "native commit settles status without executing client hooks")
  try rejected("empty commits are not silently created", containing: "no staged changes") {
    _ = try NativeGit.commit(
      repository: repository, message: "empty", authorName: "Native Fixture",
      authorEmail: "fixture@example.invalid")
  }
  try FileManager.default.removeItem(at: repository.appendingPathComponent("delete.txt"))
  try NativeGit.stage(repository: repository, path: "delete.txt")
  _ = try NativeGit.commit(
    repository: repository, message: "test: native deletion", authorName: "Native Fixture",
    authorEmail: "fixture@example.invalid")
  try check(
    try NativeGit.isClean(repository: repository), "native staging includes tracked deletions")
  try "LITERAL\n".write(
    to: repository.appendingPathComponent("[literal].txt"), atomically: true, encoding: .utf8)
  try "DO_NOT_STAGE\n".write(
    to: repository.appendingPathComponent("other.txt"), atomically: true, encoding: .utf8)
  try NativeGit.stage(repository: repository, path: "[literal].txt")
  try NativeGit.unstage(repository: repository, path: "[literal].txt")
  try check(try NativeGit.status(repository: repository).files.contains { $0.path == "[literal].txt" && $0.untracked }, "unstaging treats bracketed paths literally")
  try NativeGit.stage(repository: repository, path: "[literal].txt")
  _ = try NativeGit.commit(
    repository: repository, message: "test: literal path", authorName: "Native Fixture",
    authorEmail: "fixture@example.invalid")
  try check(
    !(try NativeGit.isClean(repository: repository)),
    "staging a literal path leaves other files untracked")
  try FileManager.default.removeItem(at: repository.appendingPathComponent("other.txt"))
  let branches = try NativeGit.branches(repository: repository)
  try check(branches.contains { $0.name == "main" && $0.current } && branches.contains { $0.name == "origin/feature" && $0.remote }, "native branch lists distinguish local and remote branches")
  try NativeGit.switchBranch(repository: repository, branch: "origin/feature")
  try check(try NativeGit.status(repository: repository).branch == "feature", "remote branch selection creates a safe tracking branch")
  try NativeGit.switchBranch(repository: repository, branch: "main")
  try check(try String(contentsOf: repository.appendingPathComponent("hello.txt"), encoding: .utf8) == "NATIVE_GIT_CHANGED\n", "switching back restores the correct committed tree")
  try rejected(
    "remote branch rejection is not reported as push success", containing: "remote rejected"
  ) {
    do {
      try NativeGit.push(repository: repository, credential: credential)
    } catch {
      try check(
        !error.localizedDescription.contains(password),
        "remote failures do not expose the credential")
      throw error
    }
  }
  try NativeGit.push(repository: repository, credential: credential)
  try check(
    try NativeGit.isClean(repository: repository),
    "authenticated push succeeds without changing the working tree")
  try String(repeating: "\u{1f642}", count: 100_000).write(to: repository.appendingPathComponent("hello.txt"), atomically: true, encoding: .utf8)
  let bounded = try NativeGit.diff(repository: repository)
  try check(bounded.returnedBytes <= 128 * 1024 && bounded.originalBytes > bounded.returnedBytes && bounded.diff.utf8.count == bounded.returnedBytes, "diff byte limits preserve valid UTF-8 and report omitted output")
  print("NATIVE_GIT_PASS")
}

func runNativeGate() async throws {
  try runGitGate()
}
