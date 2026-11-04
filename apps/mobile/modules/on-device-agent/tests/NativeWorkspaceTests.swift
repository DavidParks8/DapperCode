import Foundation

private struct GateError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

private func check(_ condition: Bool, _ name: String) throws {
  guard condition else { throw GateError(name) }
  print("PASS: \(name)")
}

private func rejected(_ name: String, containing: String, _ action: () async throws -> Void)
  async throws
{
  do {
    try await action()
  } catch {
    try check(error.localizedDescription.contains(containing), name)
    return
  }
  throw GateError("\(name): operation unexpectedly succeeded.")
}

private func rejected(
  _ name: String, code: NativeErrorCode, _ action: () async throws -> Void
) async throws {
  do {
    try await action()
  } catch let error as NativeCodedError {
    try check(
      error.code == code && error.localizedDescription.hasPrefix("[ondevice:\(code.rawValue)] "),
      name)
    return
  } catch {
    throw GateError("\(name): expected \(code.rawValue), got \(error.localizedDescription)")
  }
  throw GateError("\(name): operation unexpectedly succeeded.")
}

private func attemptWrite(_ store: WorkspaceStore, id: String, content: String, revision: String)
  async -> Result<String, Error>
{
  do {
    return .success(
      try await store.writeFile(id, path: "race.txt", content: content, expectedRevision: revision))
  } catch {
    return .failure(error)
  }
}

func runNativeGate() async throws {
  let store = WorkspaceStore()
  let primary = try await store.createWorkspace(name: "Primary")
  let secondary = try await store.createWorkspace(name: "Secondary")
  let root = try await store.resolve(primary.id, path: "", allowRoot: true)
  let listed = try await store.listFiles(primary.id, path: "", limit: 10)
  try check(listed.entries.isEmpty, "app-owned metadata stays outside the repository")
  let restored = try await WorkspaceStore().listWorkspaces()
  try check(
    restored.map(\.id).contains(primary.id), "workspace identities survive a new store instance")
  let initial = try await store.writeFile(
    primary.id, path: "src/main.txt", content: "alpha\nbeta\n", expectedRevision: nil)
  let read = try await store.readFile(primary.id, path: "src/main.txt", offset: 0, limit: 64)
  try check(
    read.content == "alpha\nbeta\n" && read.revision == initial && read.nextOffset == nil,
    "native file reads return exact content and revision")
  _ = try await store.writeFile(
    secondary.id, path: "src/main.txt", content: "OTHER", expectedRevision: nil)
  try check(
    try await store.readFile(primary.id, path: "src/main.txt", offset: 0, limit: 64).content
      == read.content, "workspaces do not share paths or contents")
  for path in [
    "/etc/passwd", "../workspace.json", "src/../main.txt", ".git/config", "src//main.txt",
    "src\\main.txt", "bad\0name",
  ] {
    try await rejected(
      "unsafe path is rejected: \(path.debugDescription)", containing: "Paths must stay"
    ) {
      _ = try await store.readFile(primary.id, path: path, offset: 0, limit: 64)
    }
  }
  try await rejected("workspace IDs cannot contain paths", containing: "Invalid local workspace") {
    _ = try await store.listFiles("../outside", path: "", limit: 10)
  }
  try await rejected("existing files cannot be blindly overwritten", containing: "was not read") {
    _ = try await store.writeFile(
      primary.id, path: "src/main.txt", content: "lost", expectedRevision: nil)
  }
  let edited = try await store.editFile(
    primary.id, path: "src/main.txt", oldText: "alpha", newText: "gamma", expectedRevision: initial)
  try await rejected("stale edits fail after a prior edit", containing: "file changed") {
    _ = try await store.writeFile(
      primary.id, path: "src/main.txt", content: "stale", expectedRevision: initial)
  }
  let afterStale = try await store.readFile(primary.id, path: "src/main.txt", offset: 0, limit: 64)
  try check(
    afterStale.content == "gamma\nbeta\n" && afterStale.revision == edited,
    "stale edit rejection preserves the settled file")
  let repeated = try await store.writeFile(
    primary.id, path: "src/main.txt", content: "aaa", expectedRevision: edited)
  try await rejected("overlapping edit matches are ambiguous", containing: "exactly one") {
    _ = try await store.editFile(
      primary.id, path: "src/main.txt", oldText: "aa", newText: "x", expectedRevision: repeated)
  }
  let unicodeRevision = try await store.writeFile(
    primary.id, path: "unicode.txt", content: "\u{e9}", expectedRevision: nil)
  try await rejected("edits match exact Unicode bytes", containing: "exactly one") {
    _ = try await store.editFile(
      primary.id, path: "unicode.txt", oldText: "e\u{301}", newText: "x",
      expectedRevision: unicodeRevision)
  }
  let executable = root.appendingPathComponent("src/main.txt")
  try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
  _ = try await store.writeFile(
    primary.id, path: "src/main.txt", content: "executable", expectedRevision: repeated)
  let permissions =
    try FileManager.default.attributesOfItem(atPath: executable.path)[.posixPermissions]
    as? NSNumber
  try check(permissions?.intValue == 0o755, "atomic replacement preserves executable permissions")
  let unicode = String(repeating: "a", count: 63) + "\u{1f642}e\u{301}\n"
  _ = try await store.writeFile(
    primary.id, path: "chunks.txt", content: unicode, expectedRevision: nil)
  let first = try await store.readFile(primary.id, path: "chunks.txt", offset: 0, limit: 64)
  let second = try await store.readFile(primary.id, path: "chunks.txt", offset: 63, limit: 4)
  try check(
    first.content.utf8.count == 63 && first.nextOffset == 63 && second.content == "\u{1f642}",
    "read chunks never split UTF-8 scalars")
  try await rejected("unaligned read offsets fail explicitly", containing: "character boundary") {
    _ = try await store.readFile(primary.id, path: "chunks.txt", offset: 64, limit: 10)
  }
  try await rejected("invalid read limits fail explicitly", containing: "limits must") {
    _ = try await store.readFile(primary.id, path: "chunks.txt", offset: 0, limit: 0)
  }
  let combined = "e" + String(repeating: "\u{301}", count: 1000)
  _ = try await store.writeFile(
    primary.id, path: "combined.txt", content: combined, expectedRevision: nil)
  let combinedChunk = try await store.readFile(
    primary.id, path: "combined.txt", offset: 0, limit: 64)
  try check(
    combinedChunk.content.utf8.count == 63 && combinedChunk.nextOffset == 63,
    "byte limits also bound large combining-character clusters")
  let outside = FileManager.default.temporaryDirectory.appendingPathComponent("outside.txt")
  try "OUTSIDE_SECRET".write(to: outside, atomically: true, encoding: .utf8)
  try FileManager.default.createSymbolicLink(
    at: root.appendingPathComponent("escape"), withDestinationURL: outside)
  try FileManager.default.createSymbolicLink(
    at: root.appendingPathComponent("dangling"),
    withDestinationURL: outside.deletingLastPathComponent().appendingPathComponent("not-created"))
  try FileManager.default.linkItem(at: outside, to: root.appendingPathComponent("hardlink"))
  try await rejected("symlink reads cannot escape the workspace", containing: "Symbolic links") {
    _ = try await store.readFile(primary.id, path: "escape", offset: 0, limit: 64)
  }
  try await rejected(
    "dangling symlink parents cannot escape on creation", containing: "Symbolic links"
  ) {
    _ = try await store.writeFile(
      primary.id, path: "dangling/new.txt", content: "escape", expectedRevision: nil)
  }
  try await rejected("hard links cannot expose another workspace path", containing: "Hard-linked") {
    _ = try await store.readFile(primary.id, path: "hardlink", offset: 0, limit: 64)
  }
  try check(
    try String(contentsOf: outside, encoding: .utf8) == "OUTSIDE_SECRET",
    "outside file contents remain untouched")
  try FileManager.default.createDirectory(
    at: root.appendingPathComponent(".git"), withIntermediateDirectories: false)
  try "needle\n".write(
    to: root.appendingPathComponent(".git/config"), atomically: true, encoding: .utf8)
  _ = try await store.writeFile(
    primary.id, path: "crlf.txt", content: "first\r\nneedle\r\nlast\n", expectedRevision: nil)
  try Data([0xff, 0xfe]).write(to: root.appendingPathComponent("binary.dat"))
  let maximum = String(repeating: "x", count: WorkspaceStore.maximumFileBytes)
  _ = try await store.writeFile(
    primary.id, path: "maximum.txt", content: maximum, expectedRevision: nil)
  try await rejected(
    "file size limits are enforced before publication", containing: "larger than 4 MiB"
  ) {
    _ = try await store.writeFile(
      primary.id, path: "too-large.txt", content: maximum + "x", expectedRevision: nil)
  }
  let search = try await store.searchFiles(primary.id, query: "needle")
  try check(
    search.matches.count == 1 && search.matches[0].path == "crlf.txt"
      && search.matches[0].line == 2, "search line numbers handle CRLF and exclude Git metadata")
  try check(
    !search.truncated && search.skippedFiles == 5,
    "search reports binary, large, symlink, and hard-link exclusions")
  try check(
    try await store.searchFiles(primary.id, query: "OUTSIDE_SECRET").matches.isEmpty,
    "search never follows outside links")
  let limited = try await store.listFiles(primary.id, path: "", limit: 1)
  try check(
    limited.entries.count == 1 && limited.truncated
      && !limited.entries.contains(where: { $0.name == ".git" }),
    "directory output limits are explicit")
  _ = try await store.writeFile(
    primary.id, path: "many.txt", content: String(repeating: "needle\n", count: 25),
    expectedRevision: nil)
  let many = try await store.searchFiles(primary.id, query: "needle")
  try check(
    many.matches.count == 20 && many.truncated
      && many.matches.allSatisfy { $0.content.utf8.count <= 512 },
    "search match and snippet limits are enforced")
  let beforeRace = try await store.writeFile(
    primary.id, path: "race.txt", content: "before", expectedRevision: nil)
  async let raceA = attemptWrite(store, id: primary.id, content: "first", revision: beforeRace)
  async let raceB = attemptWrite(store, id: primary.id, content: "second", revision: beforeRace)
  let race = await [raceA, raceB]
  var successes = 0
  var failures = 0
  for result in race {
    switch result {
    case .success: successes += 1
    case .failure(let error):
      try check(
        error.localizedDescription.contains("file changed"),
        "concurrent losing edits report a stale revision")
      failures += 1
    }
  }
  try check(
    successes == 1 && failures == 1, "concurrent writes cannot both replace the same revision")
  let current = try await store.readFile(primary.id, path: "src/main.txt", offset: 0, limit: 64)
  try await store.renamePath(
    primary.id, path: "src/main.txt", destination: "renamed.txt", expectedRevision: current.revision
  )
  try check(
    try await store.readFile(primary.id, path: "renamed.txt", offset: 0, limit: 64).content
      == "executable", "renaming preserves file contents")
  try await store.removePath(primary.id, path: "renamed.txt", expectedRevision: current.revision)
  try await rejected("removed files cannot be silently read", containing: "does not exist") {
    _ = try await store.readFile(primary.id, path: "renamed.txt", offset: 0, limit: 64)
  }
  try await rejected("repository roots cannot be deleted", containing: "file path is required") {
    try await store.removePath(primary.id, path: "", expectedRevision: nil)
  }
  try await rejected("Git metadata cannot be deleted", containing: "Paths must stay") {
    try await store.removePath(primary.id, path: ".git", expectedRevision: nil)
  }
  try await rejected("failed clones are not published", containing: "Only HTTPS") {
    _ = try await store.cloneWorkspace(
      name: "Failed", remote: "http://127.0.0.1/repo.git", credentialRef: nil)
  }
  let storeRoot = root.deletingLastPathComponent().deletingLastPathComponent()
  let leftovers = try FileManager.default.contentsOfDirectory(atPath: storeRoot.path)
  try check(
    !leftovers.contains(where: { $0.hasPrefix(".staging-") }), "failed clone staging is cleaned up")
  let budget = try await store.createWorkspace(name: "Budget")
  let budgetRoot = try await store.resolve(budget.id, path: "", allowRoot: true)
  for index in 0..<17 {
    try Data(repeating: 0x78, count: 1024 * 1024).write(
      to: budgetRoot.appendingPathComponent("\(index).txt"))
  }
  let bounded = try await store.searchFiles(budget.id, query: "not-present")
  try check(
    bounded.truncated && bounded.searchedBytes == 16 * 1024 * 1024,
    "search does not exceed its exact byte budget")
  let directories = try await store.createWorkspace(name: "Directories")
  let directoriesRoot = try await store.resolve(directories.id, path: "", allowRoot: true)
  for index in 0..<2001 {
    try FileManager.default.createDirectory(
      at: directoriesRoot.appendingPathComponent("dir-\(index)"), withIntermediateDirectories: false
    )
  }
  let boundedDirectories = try await store.searchFiles(directories.id, query: "not-present")
  try check(
    boundedDirectories.truncated && boundedDirectories.visitedEntries == 2000,
    "empty directory trees cannot bypass search limits")
  try await runSizeGate(store)
  try await runLifecycleGate(store)
  print("NATIVE_WORKSPACE_PASS")
}

private func runSizeGate(_ store: WorkspaceStore) async throws {
  let sized = try await store.createWorkspace(name: "Sized")
  let id = sized.workspace.id
  let root = try await store.resolve(id, path: "", allowRoot: true)
  _ = try await store.writeFile(id, path: "README.md", content: "hello\n", expectedRevision: nil)
  _ = try await store.writeFile(
    id, path: "src/app.txt", content: String(repeating: "a", count: 10_000), expectedRevision: nil)
  let objects = root.appendingPathComponent(".git/objects", isDirectory: true)
  try FileManager.default.createDirectory(at: objects, withIntermediateDirectories: true)
  try Data(count: 20_000).write(to: objects.appendingPathComponent("pack"))
  let outside = FileManager.default.temporaryDirectory.appendingPathComponent(
    "size-outside-\(id)", isDirectory: true)
  try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
  try Data(count: 4 * 1024 * 1024).write(to: outside.appendingPathComponent("large.bin"))
  try FileManager.default.createSymbolicLink(
    at: root.appendingPathComponent("linked-folder"), withDestinationURL: outside)
  try FileManager.default.createSymbolicLink(
    at: root.appendingPathComponent("linked-file"),
    withDestinationURL: outside.appendingPathComponent("large.bin"))

  let size = try await store.workspaceSize(id)
  try check(
    size.files == 3 && !size.truncated,
    "workspace size counts regular files, Git metadata included, and never follows symlinks")
  try check(
    size.bytes >= 30_006 && size.bytes < 1024 * 1024,
    "workspace size reports allocated bytes without the symlinked files outside the workspace")
  try check(
    size.payload["bytes"] as? Int64 == size.bytes && size.payload["truncated"] as? Bool == false,
    "workspace size payload carries bytes, files, and truncation")
  let byEntries = try WorkspaceStore.measure(root, entryLimit: 2, timeBudget: 60)
  try check(
    byEntries.truncated && byEntries.files <= 2, "workspace size stops at its entry bound")
  let byTime = try WorkspaceStore.measure(root, entryLimit: 1000, timeBudget: 0)
  try check(
    byTime.truncated && byTime.files == 0 && byTime.bytes == 0,
    "workspace size stops at its time budget")
  try await rejected("workspace size rejects malformed IDs", code: .workspaceInvalidID) {
    _ = try await store.workspaceSize("not-a-workspace")
  }
  try await rejected("workspace size rejects missing IDs", code: .workspaceRequired) {
    _ = try await store.workspaceSize("")
  }
  try await store.deleteWorkspace(id)
  try await rejected("workspace size rejects deleted workspaces", code: .workspaceNotFound) {
    _ = try await store.workspaceSize(id)
  }
  try FileManager.default.removeItem(at: outside)
}

private func runLifecycleGate(_ store: WorkspaceStore) async throws {
  let workspace = try await store.createWorkspace(name: "Lifecycle")
  let id = workspace.workspace.id
  try check(!workspace.isRepository, "new empty workspaces report no Git repository")
  _ = try await store.writeFile(id, path: "README.md", content: "root\n", expectedRevision: nil)
  _ = try await store.writeFile(id, path: "src/app.txt", content: "app\n", expectedRevision: nil)
  let root = try await store.listFiles(id, path: "", limit: 10)
  try check(
    root.entries.map(\.name) == ["README.md", "src"],
    "the workspace root lists with the empty path the Files browser uses")
  let alias = try await store.listFiles(id, path: ".", limit: 10)
  try check(alias.entries.map(\.name) == ["README.md", "src"], "\".\" is accepted as a root alias")
  try await rejected("dot paths still cannot name files", code: .pathOutsideWorkspace) {
    _ = try await store.readFile(id, path: ".", offset: 0, limit: 64)
  }
  try await rejected("traversal reports a typed containment error", code: .pathOutsideWorkspace) {
    _ = try await store.listFiles(id, path: "../", limit: 10)
  }
  try await rejected("missing workspace IDs report a typed error", code: .workspaceRequired) {
    _ = try await store.listFiles("", path: "", limit: 10)
  }
  try await rejected("malformed workspace IDs report a typed error", code: .workspaceInvalidID) {
    _ = try await store.listFiles("not-a-workspace", path: "", limit: 10)
  }
  try await rejected("missing paths report a typed error", code: .pathNotFound) {
    _ = try await store.readFile(id, path: "missing.txt", offset: 0, limit: 64)
  }
  try await rejected("unread overwrites report a revision conflict", code: .fileRevisionConflict) {
    _ = try await store.writeFile(id, path: "README.md", content: "x", expectedRevision: nil)
  }

  let large = String(repeating: "z", count: 70_000)
  _ = try await store.writeFile(id, path: "large.txt", content: large, expectedRevision: nil)
  let preview = try await store.readFile(id, path: "large.txt", offset: 0, limit: 65_536)
  try check(
    preview.totalBytes == 70_000 && preview.nextOffset == 65_536,
    "bounded reads report the total file size")

  let before = try await store.changeToken(id)
  _ = try await store.readFile(id, path: "README.md", offset: 0, limit: 64)
  try check(try await store.changeToken(id) == before, "reads do not change the workspace token")
  _ = try await store.writeFile(id, path: "notes.txt", content: "", expectedRevision: nil)
  let afterWrite = try await store.changeToken(id)
  try check(afterWrite != before, "tool writes change the workspace token")

  try await store.renameEntry(id, path: "large.txt", destination: "docs/large.txt")
  try check(
    try await store.readFile(id, path: "docs/large.txt", offset: 0, limit: 8).totalBytes == 70_000,
    "UI renames move files without a revision")
  try await store.removeEntry(id, path: "docs/large.txt")
  try await rejected("UI deletes remove the file", code: .pathNotFound) {
    _ = try await store.readFile(id, path: "docs/large.txt", offset: 0, limit: 8)
  }
  try await rejected("UI deletes cannot remove the root", code: .invalidArgument) {
    try await store.removeEntry(id, path: "")
  }
  try await rejected("UI deletes cannot touch Git metadata", code: .pathOutsideWorkspace) {
    try await store.removeEntry(id, path: ".git")
  }
  try check(try await store.changeToken(id) != afterWrite, "UI file changes move the token")

  try await rejected("Git status reports a typed non-repository state", code: .gitNotRepository) {
    _ = try await store.gitStatus(id)
  }
  try await rejected("insecure init origins are rejected", code: .gitInsecureRemote) {
    _ = try await store.gitInit(id, initialBranch: "main", origin: "http://example.invalid/r.git")
  }
  try await rejected("invalid initial branches are rejected", code: .gitBranchInvalid) {
    _ = try await store.gitInit(id, initialBranch: "bad..name", origin: nil)
  }
  try await rejected("rejected inits leave no repository", code: .gitNotRepository) {
    _ = try await store.gitStatus(id)
  }
  let initialized = try await store.gitInit(id, initialBranch: "trunk", origin: nil)
  try check(initialized.isRepository, "git init marks the workspace as a repository")
  try check(
    try await store.listWorkspaces().first { $0.workspace.id == id }?.isRepository == true,
    "workspace listings report initialized repositories")
  try await rejected("repositories cannot be initialized twice", code: .gitAlreadyRepository) {
    _ = try await store.gitInit(id, initialBranch: "main", origin: nil)
  }
  let unborn = try await store.gitStatus(id)
  try check(
    unborn.branch == "trunk" && unborn.remote.unborn && unborn.remote.origin == nil
      && unborn.stagedFiles == 0 && unborn.payload["hasOrigin"] as? Bool == false,
    "initialized repositories report the initial branch, no commits, and no origin")
  try await rejected("empty commits are rejected with a typed error", code: .gitNothingToCommit) {
    _ = try await store.gitCommit(id, message: "empty", name: "Fixture", email: "f@example.invalid")
  }
  try await rejected("fetch without an origin is rejected", code: .gitNoOrigin) {
    try await store.gitFetch(id, credentialRef: nil)
  }
  try await rejected("pull without an origin is rejected", code: .gitNoOrigin) {
    _ = try await store.gitPull(id, credentialRef: nil)
  }
  try await rejected("push without an origin is rejected", code: .gitNoOrigin) {
    try await store.gitPush(id, credentialRef: nil)
  }
  try await rejected("branches need a commit unless checked out", code: .gitNoCommits) {
    try await store.gitCreateBranch(id, name: "feature", checkout: false)
  }
  try await store.gitCreateBranch(id, name: "main", checkout: true)
  try check(try await store.gitStatus(id).branch == "main", "unborn branch checkout renames it")
  try await store.gitStage(id, path: nil)
  let staged = try await store.gitStatus(id)
  try check(staged.stagedFiles == 3, "status counts staged files")
  _ = try await store.gitCommit(id, message: "initial", name: "Fixture", email: "f@example.invalid")
  try await store.gitCreateBranch(id, name: "topic", checkout: true)
  try check(try await store.gitStatus(id).branch == "topic", "new branches can be checked out")
  try await rejected("duplicate branches are rejected", code: .gitBranchExists) {
    try await store.gitCreateBranch(id, name: "topic", checkout: false)
  }
  try await rejected("invalid branch names are rejected", code: .gitBranchInvalid) {
    try await store.gitCreateBranch(id, name: "-bad", checkout: false)
  }

  let readme = try await store.readFile(id, path: "README.md", offset: 0, limit: 64)
  _ = try await store.writeFile(
    id, path: "README.md", content: "changed\n", expectedRevision: readme.revision)
  _ = try await store.writeFile(id, path: "scratch.txt", content: "new\n", expectedRevision: nil)
  try await store.gitDiscard(id, path: "README.md", removeUntracked: false)
  try check(
    try await store.readFile(id, path: "README.md", offset: 0, limit: 64).content == "root\n",
    "per-file discard restores the committed content")
  try await store.gitDiscard(id, path: "scratch.txt", removeUntracked: false)
  try await rejected("per-file discard deletes an untracked file", code: .pathNotFound) {
    _ = try await store.readFile(id, path: "scratch.txt", offset: 0, limit: 64)
  }
  let repository = try await store.resolve(id, path: "", allowRoot: true)
  let info = repository.appendingPathComponent(".git/info", isDirectory: true)
  try FileManager.default.createDirectory(at: info, withIntermediateDirectories: true)
  try "*.env\n".write(to: info.appendingPathComponent("exclude"), atomically: true, encoding: .utf8)
  let app = try await store.readFile(id, path: "src/app.txt", offset: 0, limit: 64)
  _ = try await store.writeFile(id, path: "src/app.txt", content: "edit\n", expectedRevision: app.revision)
  for path in ["keep.txt", "untracked/deep/remove.txt", "untracked/deep/secret.env", "gone/only.txt"] {
    _ = try await store.writeFile(id, path: path, content: "\(path)\n", expectedRevision: nil)
  }
  try await store.removeEntry(id, path: "notes.txt")
  try await store.gitStage(id, path: "notes.txt")
  _ = try await store.writeFile(id, path: "notes.txt", content: "RECREATED\n", expectedRevision: nil)
  try await store.gitDiscard(id, path: nil, removeUntracked: false)
  let restoredApp = try await store.readFile(id, path: "src/app.txt", offset: 0, limit: 64)
  let kept = try await store.readFile(id, path: "keep.txt", offset: 0, limit: 64)
  try check(
    restoredApp.content == "app\n" && kept.content == "keep.txt\n",
    "discard-all restores tracked files and keeps untracked files by default")
  try check(
    try await store.readFile(id, path: "notes.txt", offset: 0, limit: 64).content == "RECREATED\n",
    "discard-all keeps a staged-for-deletion file that is still on disk")
  try await rejected("per-file discard refuses staged deletions", code: .invalidArgument) {
    try await store.gitDiscard(id, path: "notes.txt", removeUntracked: false)
  }
  try await store.gitDiscard(id, path: nil, removeUntracked: true)
  for path in ["keep.txt", "untracked/deep/remove.txt", "gone/only.txt"] {
    try await rejected("removeUntracked removes \(path)", code: .pathNotFound) {
      _ = try await store.readFile(id, path: path, offset: 0, limit: 64)
    }
  }
  try check(
    !FileManager.default.fileExists(atPath: repository.appendingPathComponent("gone").path),
    "removeUntracked prunes folders it emptied")
  try check(
    try await store.readFile(id, path: "untracked/deep/secret.env", offset: 0, limit: 64).content
      == "untracked/deep/secret.env\n",
    "removeUntracked keeps ignored files inside untracked folders")
  try check(
    try await store.readFile(id, path: "notes.txt", offset: 0, limit: 64).content == "RECREATED\n",
    "removeUntracked keeps a staged-for-deletion file that is still on disk")
  try await store.gitUnstage(id, path: "notes.txt")
  try await store.gitDiscard(id, path: "notes.txt", removeUntracked: false)
  try await store.removeEntry(id, path: "untracked")
  let restoredNotes = try await store.readFile(id, path: "notes.txt", offset: 0, limit: 64)
  let settled = try await store.gitStatus(id)
  try check(
    restoredNotes.content == "" && settled.payload["clean"] as? Bool == true,
    "unstaging then discarding restores a staged deletion and leaves a clean tree")
  try await rejected("directories are not discarded wholesale", code: .invalidArgument) {
    try await store.gitDiscard(id, path: "src", removeUntracked: false)
  }

  let renamed = try await store.renameWorkspace(id, name: "  Renamed lifecycle  ")
  try check(renamed.workspace.name == "Renamed lifecycle", "workspace rename trims and persists the name")
  try check(
    try await WorkspaceStore().listWorkspaces().contains {
      $0.workspace.id == id && $0.workspace.name == "Renamed lifecycle"
    }, "renamed workspaces survive a new store instance")
  try await rejected("invalid workspace names are rejected", code: .workspaceNameInvalid) {
    _ = try await store.renameWorkspace(id, name: "   ")
  }
  try await store.deleteWorkspace(id)
  try check(
    !(try await store.listWorkspaces().contains { $0.workspace.id == id }),
    "deleted workspaces disappear from listings")
  try await rejected("deleted workspaces cannot be resolved", code: .workspaceNotFound) {
    _ = try await store.listFiles(id, path: "", limit: 10)
  }
  try await rejected("deleted workspaces cannot be deleted again", code: .workspaceNotFound) {
    try await store.deleteWorkspace(id)
  }
  let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  let leftovers = try FileManager.default.contentsOfDirectory(
    atPath: support.appendingPathComponent("OnDeviceAgent/workspaces").path)
  try check(
    !leftovers.contains { $0.hasPrefix(".trash-") || $0 == id }, "deletion leaves no workspace data")
}
