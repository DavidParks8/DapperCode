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
  print("NATIVE_WORKSPACE_PASS")
}
