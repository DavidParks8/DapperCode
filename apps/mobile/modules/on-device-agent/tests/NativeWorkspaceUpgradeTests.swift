import Foundation

private struct UpgradeReceipt: Codable {
  let id: String
  let name: String
  let commit: String
  let revisions: [String: String]
}

private struct UpgradeFailure: LocalizedError {
  let errorDescription: String?
}

private func check(_ condition: Bool, _ name: String) throws {
  guard condition else { throw UpgradeFailure(errorDescription: name) }
  print("PASS: \(name)")
}

func runNativeGate() async throws {
  let store = WorkspaceStore()
  let documents = try FileManager.default.url(
    for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
  let receiptFile = documents.appendingPathComponent("workspace-upgrade.json")
  let contents = [
    "README.md": "RETAINED_ROOT\n",
    "src/child.txt": "RETAINED_CHILD\n",
    "~/literal.txt": "RETAINED_TILDE\n",
  ]
  if CommandLine.arguments.contains("--seed") {
    let workspace = try await store.createWorkspace(name: "Prior build retained workspace")
    var revisions: [String: String] = [:]
    for (path, content) in contents {
      revisions[path] = try await store.writeFile(
        workspace.id, path: path, content: content, expectedRevision: nil)
    }
    _ = try await store.gitInit(workspace.id, initialBranch: "main", origin: nil)
    try await store.gitStage(workspace.id, path: nil)
    let commit = try await store.gitCommit(
      workspace.id, message: "Prior build fixture",
      name: "Upgrade fixture", email: "upgrade@example.invalid")
    let receipt = UpgradeReceipt(
      id: workspace.id, name: workspace.name, commit: commit, revisions: revisions)
    try JSONEncoder().encode(receipt).write(to: receiptFile, options: .atomic)
    try check(
      try await store.gitStatus(workspace.id).totalFiles == 0,
      "prior production build writes a clean committed workspace")
    print("NATIVE_WORKSPACE_UPGRADE_SEED_PASS")
    return
  }
  let receipt = try JSONDecoder().decode(UpgradeReceipt.self, from: Data(contentsOf: receiptFile))
  let workspaces = try await store.listWorkspaces()
  try check(
    workspaces.count == 1 && workspaces[0].id == receipt.id
      && workspaces[0].name == receipt.name && workspaces[0].isRepository,
    "upgraded app reopens the prior production workspace without replacement or reset")
  for path in ["", "."] {
    let entries = try await store.listFiles(receipt.id, path: path, limit: 20)
    try check(
      Set(entries.entries.map(\.name)).isSuperset(of: ["README.md", "src", "~"])
        && !entries.truncated,
      "prior workspace root remains enumerable at \(path.debugDescription)")
  }
  for (path, content) in contents {
    let read = try await store.readFile(receipt.id, path: path, offset: 0, limit: 100)
    try check(
      read.content == content && read.revision == receipt.revisions[path],
      "upgrade preserves exact file bytes and revisions for \(path)")
  }
  for (path, expected) in ["src": "child.txt", "~": "literal.txt"] {
    let entries = try await store.listFiles(receipt.id, path: path, limit: 20)
    try check(
      entries.entries.map(\.name) == [expected],
      "retained nested directory is workspace-relative: \(path)")
  }
  let matches = try await store.searchFiles(receipt.id, query: "RETAINED_")
  try check(
    Set(matches.matches.map(\.path)) == Set(contents.keys),
    "retained search returns exact relative paths including a literal tilde directory")
  let size = try await store.workspaceSize(receipt.id)
  try check(
    size.files > contents.count
      && size.bytes > contents.values.reduce(0, { $0 + $1.utf8.count }) && !size.truncated,
    "retained size includes files and Git data without truncation")
  let history = try await store.gitHistory(receipt.id)
  let status = try await store.gitStatus(receipt.id)
  try check(
    history.count == 1 && history[0].hash == receipt.commit
      && status.totalFiles == 0 && status.branch == "main",
    "upgrade preserves the existing Git commit and clean worktree")
  do {
    _ = try await store.listFiles(receipt.id, path: "../", limit: 10)
    throw UpgradeFailure(errorDescription: "Upgrade allowed workspace traversal.")
  } catch let error as NativeCodedError {
    try check(error.code == .pathOutsideWorkspace, "upgraded workspace still rejects traversal")
  }
  print("NATIVE_WORKSPACE_UPGRADE_PASS")
}
