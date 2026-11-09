import Foundation

private struct TestFailure: LocalizedError {
  let errorDescription: String?
  init(_ name: String) { errorDescription = name }
}

private func check(_ condition: Bool, _ name: String) throws {
  guard condition else { throw TestFailure(name) }
  print("PASS: \(name)")
}

private func rejects(
  _ code: NativeErrorCode, _ name: String, _ action: () async throws -> Void
) async throws {
  do { try await action() } catch let error as NativeCodedError {
    try check(error.code == code, name)
    return
  }
  throw TestFailure("\(name) unexpectedly succeeded")
}

func runNativeGate() async throws {
  guard let index = CommandLine.arguments.firstIndex(of: "--path-alias-root") else {
    throw TestFailure("owned root argument missing")
  }
  let store = WorkspaceStore(rootDirectory: URL(fileURLWithPath: CommandLine.arguments[index + 1]))
  let workspace = try await store.createWorkspace(name: "Tools")
  let id = workspace.id
  let root = try await store.resolve(id, path: "", allowRoot: true)
  let token = "native-tools"
  try WorkspaceOperation.shared.begin(token)
  defer { WorkspaceOperation.shared.finish(token) }
  func put(_ path: String, _ content: String) async throws -> String {
    try await store.writeFile(id, path: path, content: content, expectedRevision: nil)
  }
  _ = try await put("src/a.ts", "start\r\ncafé42\r\nCAFÉ77\n🙂 end\n")
  _ = try await put("src/b.ts", "café99\n")
  _ = try await put("src/c.txt", "café21\n")
  _ = try await put("other.ts", "café00\n")
  _ = try await put(".gitignore", "ignored/\n*.secret\n!keep.secret\n")
  _ = try await put("ignored/file.ts", "café11\n")
  _ = try await put("hidden.secret", "café11\n")
  _ = try await put("keep.secret", "café11\n")
  _ = try await store.gitInit(id, initialBranch: "main", origin: nil)
  var options = WorkspaceSearchOptions()
  options.path = "src"
  options.include = "src/**/*.t?"
  options.fileType = "ts"
  options.regex = true
  options.caseSensitive = false
  options.limit = 1
  let first = try await store.queryFiles(id, query: "^café[0-9]+$", options: options, token: token)
  try check(
    first.matches.count == 1 && first.matches[0].line == 2
      && first.matches[0].content == "café42" && first.nextOffset == 1,
    "regex, directory, glob, extension and case controls return UTF-8 CRLF line previews")
  options.offset = first.nextOffset!
  let second = try await store.queryFiles(id, query: "^café[0-9]+$", options: options, token: token)
  try check(
    second.matches[0].line == 3 && second.nextOffset == 2, "paging resumes after a matching line")
  options.offset = 2
  let third = try await store.queryFiles(id, query: "^café[0-9]+$", options: options, token: token)
  try check(
    third.matches[0].path == "src/b.ts" && third.nextOffset == nil,
    "final page is not falsely truncated")
  options = WorkspaceSearchOptions()
  let discovery = try await store.queryFiles(id, query: nil, options: options, token: token)
  try check(
    discovery.files.contains("keep.secret") && !discovery.files.contains("hidden.secret")
      && !discovery.files.contains("ignored/file.ts") && discovery.excludedEntries >= 3,
    "file discovery honors Git ignore negation and excludes Git metadata")
  options.include = "src/?[.]ts"
  let literalGlob = try await store.queryFiles(id, query: nil, options: options, token: token)
  try check(
    literalGlob.files.isEmpty, "glob brackets are literal, not silently interpreted as regex")
  options.include = "src/*.ts"
  options.limit = 1
  let globPage = try await store.queryFiles(id, query: nil, options: options, token: token)
  guard let nextFileOffset = globPage.nextOffset else {
    throw TestFailure("File paging: \(globPage.payload)")
  }
  options.offset = nextFileOffset
  let globLast = try await store.queryFiles(id, query: nil, options: options, token: token)
  try check(
    globPage.files == ["src/a.ts"] && globLast.files == ["src/b.ts"]
      && globLast.nextOffset == nil, "file discovery pages deterministically by sorted path")
  _ = try await put("preview.txt", String(repeating: "🙂", count: 200) + ".literal*\n")
  options = WorkspaceSearchOptions()
  options.include = "preview.txt"
  let preview = try await store.queryFiles(id, query: ".literal*", options: options, token: token)
  try check(
    preview.matches[0].content.utf8.count == 512 && preview.matches[0].previewTruncated,
    "literal metacharacters and UTF-8 preview truncation are explicit")
  let legacyPreview = try await store.searchFiles(id, query: ".literal*")
  try check(
    legacyPreview.matches.count == 1 && legacyPreview.matches[0].previewTruncated,
    "legacy searches also report clipped previews honestly")
  options = WorkspaceSearchOptions()
  options.regex = true
  try await rejects(.searchPatternInvalid, "invalid regex fails explicitly") {
    _ = try await store.queryFiles(id, query: "[", options: options, token: token)
  }
  _ = try await put("pathological.txt", String(repeating: "a", count: 100_000) + "!")
  options.include = "pathological.txt"
  try await rejects(
    .searchPatternTimeout, "pathological regex is stopped by native progress callback"
  ) {
    _ = try await store.queryFiles(id, query: "^(a+)+$", options: options, token: token)
  }
  options = WorkspaceSearchOptions()
  options.path = "../"
  try await rejects(.pathOutsideWorkspace, "search scope cannot escape root") {
    _ = try await store.queryFiles(id, query: nil, options: options, token: token)
  }
  let a = try await put("a.txt", "one\ntwo\n")
  let b = try await put("b.txt", "remove\n")
  let c = try await put("c.txt", "move\n")
  let patch = """
    *** Begin Patch
    *** Update File: a.txt
    @@ -1,2 +1,2 @@
     one
    -two
    +three
    *** Add File: nested/new.txt
    +new🙂
    *** Delete File: b.txt
    *** Update File: c.txt
    *** Move to: moved.txt
    @@ -1 +1 @@
    -move
    +moved
    *** End Patch
    """
  let result = try await store.applyPatch(
    id, patch: patch, revisions: ["a.txt": a, "b.txt": b, "c.txt": c], token: token)
  try check(
    try String(contentsOf: root.appendingPathComponent("a.txt"), encoding: .utf8) == "one\nthree\n"
      && String(contentsOf: root.appendingPathComponent("nested/new.txt"), encoding: .utf8)
        == "new🙂\n"
      && String(contentsOf: root.appendingPathComponent("moved.txt"), encoding: .utf8) == "moved\n"
      && !FileManager.default.fileExists(atPath: root.appendingPathComponent("b.txt").path)
      && !FileManager.default.fileExists(atPath: root.appendingPathComponent("c.txt").path)
      && result.count == 5,
    "native coordinated patch adds, edits, deletes, moves and returns every revision")
  let current = try await store.readFile(id, path: "a.txt", offset: 0, limit: 64)
  let lateFailure = """
    *** Begin Patch
    *** Add File: should-not-exist.txt
    +never
    *** Update File: a.txt
    @@ -1,2 +1,2 @@
     one
    -absent
    +lost
    *** End Patch
    """
  try await rejects(.patchInvalid, "late hunk failure rejects the entire patch") {
    _ = try await store.applyPatch(
      id, patch: lateFailure, revisions: ["a.txt": current.revision], token: token)
  }
  try check(
    !FileManager.default.fileExists(
      atPath: root.appendingPathComponent("should-not-exist.txt").path)
      && (try Data(contentsOf: root.appendingPathComponent("a.txt"))) == Data("one\nthree\n".utf8),
    "late failure leaves all file contents and paths unchanged")
  let deletion = "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch"
  try await rejects(.fileRevisionConflict, "patch cannot invent an observed revision") {
    _ = try await store.applyPatch(id, patch: deletion, revisions: [:], token: token)
  }
  try await rejects(.fileRevisionConflict, "external revision race does not overwrite new bytes") {
    _ = try await store.applyPatch(
      id, patch: deletion, revisions: ["a.txt": current.revision], token: token,
      checkpoint: { phase in
        guard phase == "validated" else { return }
        try Data("external\n".utf8).write(to: root.appendingPathComponent("a.txt"))
      })
  }
  try check(
    try Data(contentsOf: root.appendingPathComponent("a.txt")) == Data("external\n".utf8),
    "claimed revision conflict rolls back the externally changed original")
  let externalRead = try await store.readFile(id, path: "a.txt", offset: 0, limit: 64)
  let publicationConflict = """
    *** Begin Patch
    *** Add File: first-new
    +new
    *** Add File: later-new
    +new
    *** Delete File: a.txt
    *** End Patch
    """
  try await rejects(.fileRevisionConflict, "late publication race rolls back earlier publications")
  {
    _ = try await store.applyPatch(
      id, patch: publicationConflict, revisions: ["a.txt": externalRead.revision], token: token,
      checkpoint: { phase in
        guard phase == "validated" else { return }
        try Data("external destination\n".utf8).write(to: root.appendingPathComponent("later-new"))
      })
  }
  try check(
    !FileManager.default.fileExists(atPath: root.appendingPathComponent("first-new").path)
      && (try Data(contentsOf: root.appendingPathComponent("a.txt"))) == Data("external\n".utf8)
      && (try Data(contentsOf: root.appendingPathComponent("later-new")))
        == Data("external destination\n".utf8),
    "publication rollback restores originals and never overwrites an external destination")
  let recoveryPatch = """
    *** Begin Patch
    *** Add File: recovery-first
    +new
    *** Add File: recovery-late
    +new
    *** Delete File: a.txt
    *** End Patch
    """
  try await rejects(
    .patchRecoveryRequired, "rollback cannot overwrite unseen external source changes"
  ) {
    _ = try await store.applyPatch(
      id, patch: recoveryPatch, revisions: ["a.txt": externalRead.revision], token: token,
      checkpoint: { phase in
        guard phase == "published:recovery-first" else { return }
        try Data("new external source\n".utf8).write(to: root.appendingPathComponent("a.txt"))
        try Data("new external destination\n".utf8).write(
          to: root.appendingPathComponent("recovery-late"))
      })
  }
  let recoveryDirectories = try FileManager.default.contentsOfDirectory(
    at: root.deletingLastPathComponent(), includingPropertiesForKeys: nil
  ).filter { $0.lastPathComponent.hasPrefix(".patch-") }
  try check(
    recoveryDirectories.count == 1
      && (try Data(contentsOf: recoveryDirectories[0].appendingPathComponent("old-2")))
        == Data("external\n".utf8)
      && FileManager.default.fileExists(
        atPath: recoveryDirectories[0].appendingPathComponent("manifest.json").path)
      && (try Data(contentsOf: root.appendingPathComponent("a.txt")))
        == Data("new external source\n".utf8)
      && !FileManager.default.fileExists(
        atPath: root.appendingPathComponent("recovery-first").path),
    "unsafe rollback retains originals and manifest outside the repo, preserving external bytes")
  let publicationToken = "native-publication-cancel"
  try WorkspaceOperation.shared.begin(publicationToken)
  defer { WorkspaceOperation.shared.finish(publicationToken) }
  let settled = try await store.applyPatch(
    id,
    patch: """
      *** Begin Patch
      *** Add File: cancel-first
      +first
      *** Add File: cancel-second
      +second
      *** End Patch
      """, revisions: [:], token: publicationToken,
    checkpoint: { phase in
      if phase == "published:cancel-first" { WorkspaceOperation.shared.cancel(publicationToken) }
    })
  try check(
    settled.count == 2
      && FileManager.default.fileExists(atPath: root.appendingPathComponent("cancel-first").path)
      && FileManager.default.fileExists(atPath: root.appendingPathComponent("cancel-second").path),
    "cancellation after publication starts settles every file instead of abandoning half a patch")
  let noNewline = try await put("no-newline", "last")
  _ = try await store.applyPatch(
    id,
    patch: """
      *** Begin Patch
      *** Update File: no-newline
      @@ -1 +1 @@
      -last
      \\ No newline at end of file
      +next
      \\ No newline at end of file
      *** End Patch
      """, revisions: ["no-newline": noNewline], token: token)
  try check(
    try Data(contentsOf: root.appendingPathComponent("no-newline")) == Data("next".utf8),
    "unified no-newline markers preserve exact file endings")
  for path in ["../outside", ".git/config", "", "a.txt/child", "nested", "nested/new.txt/child"] {
    let bad = "*** Begin Patch\n*** Add File: \(path)\n+x\n*** End Patch"
    do { _ = try await store.applyPatch(id, patch: bad, revisions: [:], token: token) } catch {
      print("PASS: unsafe patch target rejected: \(path)")
      continue
    }
    throw TestFailure("unsafe patch succeeded: \(path)")
  }
  let duplicate = "*** Begin Patch\n*** Add File: dup\n+a\n*** Add File: dup\n+b\n*** End Patch"
  try await rejects(.patchInvalid, "duplicate paths reject before mutation") {
    _ = try await store.applyPatch(id, patch: duplicate, revisions: [:], token: token)
  }
  let ancestor = "*** Begin Patch\n*** Add File: dir\n+a\n*** Add File: dir/file\n+b\n*** End Patch"
  try await rejects(.patchInvalid, "ancestor collisions reject before mutation") {
    _ = try await store.applyPatch(id, patch: ancestor, revisions: [:], token: token)
  }
  try FileManager.default.createSymbolicLink(
    at: root.appendingPathComponent("link"), withDestinationURL: root.appendingPathComponent("src"))
  try FileManager.default.linkItem(
    at: root.appendingPathComponent("a.txt"), to: root.appendingPathComponent("hard"))
  for path in ["link/new.txt", "hard"] {
    let bad = "*** Begin Patch\n*** Add File: \(path)\n+x\n*** End Patch"
    try await rejects(.pathUnsupported, "patch rejects symbolic/hard links: \(path)") {
      _ = try await store.applyPatch(id, patch: bad, revisions: [:], token: token)
    }
  }
  let securitySearch = try await store.queryFiles(
    id, query: nil, options: WorkspaceSearchOptions(), token: token)
  try check(
    !securitySearch.files.contains("hard") && !securitySearch.files.contains("link")
      && securitySearch.skippedFiles >= 3, "discovery never follows hard or symbolic links")
  _ = try await put("parent/source", "source\n")
  let source = try await store.readFile(id, path: "parent/source", offset: 0, limit: 64)
  try await rejects(.pathUnsupported, "parent directory replacement is never followed during patch")
  {
    _ = try await store.applyPatch(
      id, patch: "*** Begin Patch\n*** Delete File: parent/source\n*** End Patch",
      revisions: ["parent/source": source.revision], token: token,
      checkpoint: { phase in
        guard phase == "validated" else { return }
        try FileManager.default.moveItem(
          at: root.appendingPathComponent("parent"),
          to: root.appendingPathComponent("original-parent"))
        try FileManager.default.createSymbolicLink(
          at: root.appendingPathComponent("parent"),
          withDestinationURL: root.appendingPathComponent("src"))
      })
  }
  try check(
    FileManager.default.fileExists(
      atPath: root.appendingPathComponent("original-parent/source").path),
    "parent race leaves the original source intact")
  let budgetWorkspace = try await store.createWorkspace(name: "Search budgets")
  let budgetRoot = try await store.resolve(budgetWorkspace.id, path: "", allowRoot: true)
  for index in 0..<17 {
    try Data(repeating: 120, count: 1024 * 1024).write(
      to: budgetRoot.appendingPathComponent("\(index).txt"))
  }
  let byteBound = try await store.queryFiles(
    budgetWorkspace.id, query: "absent",
    options: WorkspaceSearchOptions(), token: token)
  try check(
    byteBound.reason == "bytes" && byteBound.searchedBytes == 16 * 1024 * 1024
      && byteBound.nextOffset == nil, "byte exhaustion reports non-pageable incomplete results")
  let entriesWorkspace = try await store.createWorkspace(name: "Entry budgets")
  let entriesRoot = try await store.resolve(entriesWorkspace.id, path: "", allowRoot: true)
  for index in 0..<2001 {
    try FileManager.default.createDirectory(
      at: entriesRoot.appendingPathComponent("d\(index)"),
      withIntermediateDirectories: false)
  }
  let entryBound = try await store.queryFiles(
    entriesWorkspace.id, query: nil,
    options: WorkspaceSearchOptions(), token: token)
  try check(
    entryBound.reason == "entries" && entryBound.visitedEntries == 2000
      && entryBound.nextOffset == nil, "directory-only scans cannot bypass entry budgets")
  let cancelledToken = "native-cancel-in-flight"
  try WorkspaceOperation.shared.begin(cancelledToken)
  defer { WorkspaceOperation.shared.finish(cancelledToken) }
  var cancelOptions = WorkspaceSearchOptions()
  cancelOptions.include = "pathological.txt"
  cancelOptions.regex = true
  DispatchQueue.global().asyncAfter(deadline: .now() + 0.001) {
    WorkspaceOperation.shared.cancel(cancelledToken)
  }
  try await rejects(
    .operationCancelled, "native cancellation interrupts an admitted pathological match"
  ) {
    _ = try await store.queryFiles(
      id, query: "^(a+)+$", options: cancelOptions, token: cancelledToken)
  }
  WorkspaceOperation.shared.cancel(token)
  try await rejects(.operationCancelled, "cancelled native search performs no scan") {
    _ = try await store.queryFiles(id, query: nil, options: WorkspaceSearchOptions(), token: token)
  }
  try await rejects(.operationCancelled, "cancelled native patch performs no writes") {
    _ = try await store.applyPatch(
      id, patch: "*** Begin Patch\n*** Add File: cancelled\n+x\n*** End Patch", revisions: [:],
      token: token)
  }
  print("NATIVE_WORKSPACE_TOOLS_PASS")
}
