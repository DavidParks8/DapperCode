import Darwin
import Foundation

private struct PatchHunk {
  let oldStart: Int
  let newStart: Int
  var old: [Data]
  var new: [Data]
}

private struct PatchFile {
  let path: String
  var destination: String?
  let action: String
  var added = Data()
  var hunks: [PatchHunk] = []
}

private func invalidPatch(_ detail: String) -> WorkspaceError {
  WorkspaceError(.patchInvalid, detail)
}

private enum WorkspacePatchParser {
  static func parse(_ patch: String, token: String) throws -> [PatchFile] {
    guard patch.utf8.count <= WorkspaceStore.maximumFileBytes else {
      throw invalidPatch("Patch input exceeds 4 MiB.")
    }
    guard patch.utf8.lazy.filter({ $0 == 10 }).prefix(100_001).count <= 100_000 else {
      throw invalidPatch("Patch input exceeds 100000 lines.")
    }
    var lines = patch.components(separatedBy: "\n")
    if lines.last?.isEmpty == true { lines.removeLast() }
    guard lines.first == "*** Begin Patch", lines.last == "*** End Patch" else {
      throw invalidPatch("Expected *** Begin Patch and *** End Patch markers.")
    }
    let header = try NSRegularExpression(
      pattern: #"^@@ -([0-9]{1,7})(?:,([0-9]{1,7}))? \+([0-9]{1,7})(?:,([0-9]{1,7}))? @@(?: .*)?$"#)
    var files: [PatchFile] = []
    var index = 1
    while index < lines.count - 1 {
      guard files.count < 32 else {
        throw invalidPatch("A patch may contain at most 32 operations.")
      }
      try WorkspaceOperation.shared.check(token)
      files.append(try parseFile(lines, index: &index, header: header, token: token))
    }
    guard !files.isEmpty else { throw invalidPatch("The patch has no operations.") }
    return files
  }

  private static func parseFile(
    _ lines: [String], index: inout Int, header: NSRegularExpression, token: String
  ) throws -> PatchFile {
    let marker = lines[index]
    let action: String
    let path: String
    if marker.hasPrefix("*** Add File: ") {
      action = "add"
      path = String(marker.dropFirst(14))
    } else if marker.hasPrefix("*** Update File: ") {
      action = "update"
      path = String(marker.dropFirst(17))
    } else if marker.hasPrefix("*** Delete File: ") {
      action = "delete"
      path = String(marker.dropFirst(17))
    } else {
      throw invalidPatch("Expected an Add, Update, or Delete File marker.")
    }
    var file = PatchFile(path: path, action: action)
    index += 1
    if action == "update", index < lines.count - 1, lines[index].hasPrefix("*** Move to: ") {
      file.destination = String(lines[index].dropFirst(13))
      index += 1
    }
    if action == "add" {
      while index < lines.count - 1, !lines[index].hasPrefix("*** ") {
        if index.isMultiple(of: 128) { try WorkspaceOperation.shared.check(token) }
        if lines[index] == "\\ No newline at end of file", file.added.last == 10 {
          file.added.removeLast()
        } else {
          guard lines[index].hasPrefix("+") else {
            throw invalidPatch("Added lines must start with +.")
          }
          file.added.append(contentsOf: lines[index].dropFirst().utf8)
          file.added.append(10)
        }
        index += 1
      }
    } else if action == "update" {
      while index < lines.count - 1, !lines[index].hasPrefix("*** ") {
        guard file.hunks.count < 4096 else { throw invalidPatch("An update exceeds 4096 hunks.") }
        file.hunks.append(try parseHunk(lines, index: &index, header: header, token: token))
      }
      guard !file.hunks.isEmpty || file.destination != nil else {
        throw invalidPatch("An update requires hunks or a move destination.")
      }
    }
    return file
  }

  private static func parseHunk(
    _ lines: [String], index: inout Int, header: NSRegularExpression, token: String
  ) throws -> PatchHunk {
    let line = lines[index]
    guard
      let match = header.firstMatch(in: line, range: NSRange(line.startIndex..., in: line))
    else { throw invalidPatch("Use numbered unified hunks: @@ -old,count +new,count @@.") }
    func number(_ group: Int, fallback: Int) -> Int {
      guard let range = Range(match.range(at: group), in: line) else { return fallback }
      return Int(line[range]) ?? fallback
    }
    let oldCount = number(2, fallback: 1)
    let newCount = number(4, fallback: 1)
    var hunk = PatchHunk(
      oldStart: number(1, fallback: 0), newStart: number(3, fallback: 0), old: [], new: [])
    index += 1
    var previous: Character?
    while index < lines.count - 1, !lines[index].hasPrefix("*** "),
      !lines[index].hasPrefix("@@")
    {
      if index.isMultiple(of: 128) { try WorkspaceOperation.shared.check(token) }
      let body = lines[index]
      if body == "\\ No newline at end of file" {
        guard let previous else {
          throw invalidPatch("No-newline marker must follow a hunk line.")
        }
        if previous != "+", hunk.old.last?.last == 10 {
          hunk.old[hunk.old.count - 1].removeLast()
        }
        if previous != "-", hunk.new.last?.last == 10 {
          hunk.new[hunk.new.count - 1].removeLast()
        }
      } else {
        guard let prefix = body.first, [" ", "+", "-"].contains(prefix) else {
          throw invalidPatch("Hunk lines must start with space, + or -.")
        }
        let data = Data((String(body.dropFirst()) + "\n").utf8)
        if prefix != "+" { hunk.old.append(data) }
        if prefix != "-" { hunk.new.append(data) }
        previous = prefix
      }
      index += 1
    }
    guard hunk.old.count == oldCount, hunk.new.count == newCount else {
      throw invalidPatch("Hunk line counts do not match their header.")
    }
    return hunk
  }

  static func apply(_ hunks: [PatchHunk], to data: Data, token: String) throws -> Data {
    guard let content = String(data: data, encoding: .utf8) else {
      throw WorkspaceError(.fileNotText, "Patches require UTF-8 files.")
    }
    guard data.lazy.filter({ $0 == 10 }).prefix(100_001).count <= 100_000 else {
      throw invalidPatch("A patched source exceeds 100000 lines.")
    }
    var lines = content.components(separatedBy: "\n").map { Data(($0 + "\n").utf8) }
    if data.last == 10 { lines.removeLast() } else { lines[lines.count - 1].removeLast() }
    if data.isEmpty { lines = [] }
    var result = Data()
    var cursor = 0
    var outputLines = 0
    for hunk in hunks {
      try WorkspaceOperation.shared.check(token)
      let start = hunk.old.isEmpty ? hunk.oldStart : hunk.oldStart - 1
      let newStart = hunk.new.isEmpty ? hunk.newStart : hunk.newStart - 1
      guard start >= cursor, start <= lines.count, start + hunk.old.count <= lines.count,
        newStart == outputLines + start - cursor,
        Array(lines[start..<(start + hunk.old.count)]) == hunk.old
      else {
        throw invalidPatch("Hunk location or exact context does not match the observed file.")
      }
      for line in lines[cursor..<start] { result.append(line) }
      for line in hunk.new { result.append(line) }
      outputLines += start - cursor + hunk.new.count
      cursor = start + hunk.old.count
      guard result.count <= WorkspaceStore.maximumFileBytes else {
        throw WorkspaceError(.fileTooLarge, "A patched file exceeds 4 MiB.")
      }
    }
    for line in lines[cursor...] { result.append(line) }
    guard result.count <= WorkspaceStore.maximumFileBytes else {
      throw WorkspaceError(.fileTooLarge, "A patched file exceeds 4 MiB.")
    }
    return result
  }
}

private struct PreparedPatchFile {
  let path: String
  let destination: String?
  let old: Data?
  let new: Data?
  let mode: mode_t
}

private struct ClaimedPatchFile {
  let path: String
  let parent: WorkspaceDirectory
  let name: String
  let backup: String
  let old: Data
}

private struct PublishedPatchFile {
  let path: String
  let stageName: String
  let parent: WorkspaceDirectory
  let name: String
  let data: Data
}

private struct PatchPublication {
  let root: WorkspaceDirectory
  let staging: WorkspaceDirectory
  var claimed: [ClaimedPatchFile] = []
  var published: [PublishedPatchFile] = []
  var created: [(WorkspaceDirectory, String)] = []

  mutating func claim(_ file: PreparedPatchFile, index: Int) throws {
    guard let old = file.old else { return }
    let parent = try root.parent(of: file.path)
    let name = URL(fileURLWithPath: file.path).lastPathComponent
    let backup = "old-\(index)"
    guard
      renameatx_np(parent.descriptor, name, staging.descriptor, backup, UInt32(RENAME_EXCL)) == 0
    else {
      throw WorkspaceError(.fileRevisionConflict, "A patch source changed before publication.")
    }
    claimed.append(
      ClaimedPatchFile(path: file.path, parent: parent, name: name, backup: backup, old: old))
    guard try staging.read(backup) == old else {
      throw WorkspaceError(.fileRevisionConflict, "A patch source changed while it was claimed.")
    }
  }

  mutating func publish(_ file: PreparedPatchFile, index: Int) throws {
    guard let data = file.new else { return }
    let path = file.destination ?? file.path
    var parent = root
    for component in path.split(separator: "/").dropLast() {
      let name = String(component)
      if try parent.status(name) == nil {
        guard mkdirat(parent.descriptor, name, 0o755) == 0 else {
          throw WorkspaceError(.fileRevisionConflict, "A patch parent changed.")
        }
        created.append((parent, name))
      }
      parent = try WorkspaceDirectory(parent: parent, name: name)
    }
    let name = URL(fileURLWithPath: path).lastPathComponent
    guard
      renameatx_np(staging.descriptor, "new-\(index)", parent.descriptor, name, UInt32(RENAME_EXCL))
        == 0
    else {
      throw WorkspaceError(
        .fileRevisionConflict, "A patch destination appeared before publication.")
    }
    published.append(PublishedPatchFile(
      path: path, stageName: "new-\(index)", parent: parent, name: name, data: data))
  }

  func verify() throws {
    for file in published {
      guard (try root.parent(of: file.path)).same(as: file.parent),
        try file.parent.read(file.name) == file.data
      else {
        throw WorkspaceError(.fileRevisionConflict, "A published file or its parent changed.")
      }
    }
    for file in claimed {
      guard (try root.parent(of: file.path)).same(as: file.parent),
        try staging.read(file.backup) == file.old
      else {
        throw WorkspaceError(
          .fileRevisionConflict, "An original or its parent changed during publication.")
      }
      if !published.contains(where: { $0.path == file.path }),
        try file.parent.status(file.name) != nil
      {
        throw WorkspaceError(.fileRevisionConflict, "An external writer recreated a patch source.")
      }
    }
  }

  func rollback() -> Bool {
    var restored = true
    for file in published.reversed() {
      let held = "rollback-\(file.stageName)"
      do {
        // Claim rather than check-then-unlink: a replacement between these operations must
        // remain recoverable, not be deleted on the strength of the old inode's bytes.
        guard
          renameatx_np(
            file.parent.descriptor, file.name, staging.descriptor, held, UInt32(RENAME_EXCL)) == 0
        else {
          restored = false
          continue
        }
        if try staging.read(held) != file.data {
          _ = renameatx_np(
            staging.descriptor, held, file.parent.descriptor, file.name, UInt32(RENAME_EXCL))
          restored = false
        }
      } catch { restored = false }
    }
    for file in claimed.reversed()
    where renameatx_np(
      staging.descriptor, file.backup, file.parent.descriptor, file.name, UInt32(RENAME_EXCL)) != 0
    {
      restored = false
    }
    for (parent, name) in created.reversed() { _ = unlinkat(parent.descriptor, name, AT_REMOVEDIR) }
    return restored
  }
}

extension WorkspaceStore {
  func applyPatch(
    _ id: String,
    patch: String,
    revisions: [String: String],
    token: String,
    checkpoint: ((String) throws -> Void)? = nil
  ) throws -> [[String: Any]] {
    try WorkspaceOperation.shared.check(token)
    let files = try WorkspacePatchParser.parse(patch, token: token)
    var paths: [String] = []
    var prepared: [PreparedPatchFile] = []
    let rootURL = try resolve(id, path: "", allowRoot: true)
    let root = try WorkspaceDirectory(root: rootURL)
    var bytes = 0
    for file in files {
      try WorkspaceOperation.shared.check(token)
      for path in [file.path] + (file.destination.map { [$0] } ?? []) {
        guard path.utf8.count <= 4096 else {
          throw invalidPatch("Patch paths must not exceed 4096 UTF-8 bytes.")
        }
        _ = try resolve(id, path: path, allowMissing: true)
        let folded = path.lowercased()
        guard
          !paths.contains(where: {
            $0 == folded || $0.hasPrefix(folded + "/") || folded.hasPrefix($0 + "/")
          })
        else {
          throw invalidPatch("Duplicate, case-colliding, or ancestor patch paths are not allowed.")
        }
        paths.append(folded)
      }
      let url = try resolve(id, path: file.path, allowMissing: file.action == "add")
      let info = try fileStatus(url)
      var old: Data?
      var new: Data?
      if file.action == "add" {
        guard info == nil, revisions[file.path] == nil else {
          throw WorkspaceError(
            .fileRevisionConflict, "An added path already exists or was previously observed.")
        }
        new = file.added
      } else {
        let parent = try root.parent(of: file.path)
        let contents = try parent.read(url.lastPathComponent)
        old = contents
        guard let revision = revisions[file.path], digest(contents) == revision else {
          throw WorkspaceError(
            .fileRevisionConflict, "A patch source changed or was not read in this turn.")
        }
        if file.action == "update" {
          new = try WorkspacePatchParser.apply(file.hunks, to: contents, token: token)
        }
      }
      if let destination = file.destination {
        guard try kind(resolve(id, path: destination, allowMissing: true)) == nil,
          revisions[destination] == nil
        else {
          throw WorkspaceError(
            .pathExists, "A move destination must not exist or have an observed version.")
        }
      }
      bytes += (old?.count ?? 0) + (new?.count ?? 0)
      guard bytes <= 16 * 1024 * 1024 else {
        throw invalidPatch("Patch old/new data exceeds the 16 MiB transaction budget.")
      }
      prepared.append(
        PreparedPatchFile(
          path: file.path, destination: file.destination, old: old, new: new,
          mode: (info?.st_mode ?? 0o644) & 0o777))
    }
    return try publishPatch(
      id, prepared: prepared, root: root, token: token,
      checkpoint: checkpoint)
  }

  private func publishPatch(
    _ id: String,
    prepared: [PreparedPatchFile],
    root: WorkspaceDirectory,
    token: String,
    checkpoint: ((String) throws -> Void)?
  ) throws -> [[String: Any]] {
    let rootURL = try resolve(id, path: "", allowRoot: true)
    // Staging and retained recovery data live beside repository, never inside the user's tree.
    let stagingURL = rootURL.deletingLastPathComponent().appendingPathComponent(
      ".patch-\(UUID().uuidString)")
    try fileManager.createDirectory(at: stagingURL, withIntermediateDirectories: false)
    let staging = try WorkspaceDirectory(root: stagingURL)
    var retainRecovery = false
    defer { if !retainRecovery { try? fileManager.removeItem(at: stagingURL) } }
    let manifest = prepared.enumerated().map { index, file -> [String: Any] in
      [
        "path": file.path, "destination": file.destination.map { $0 as Any } ?? NSNull(),
        "backup": file.old == nil ? NSNull() : "old-\(index)" as Any,
        "rollback": file.new == nil ? NSNull() : "rollback-new-\(index)" as Any,
        "revision": file.old.map(digest) as Any? ?? NSNull(),
      ]
    }
    try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys]).write(
      to: stagingURL.appendingPathComponent("manifest.json"), options: .atomic)
    for (index, file) in prepared.enumerated() {
      if let data = file.new {
        let url = stagingURL.appendingPathComponent("new-\(index)")
        try data.write(to: url, options: .withoutOverwriting)
        try fileManager.setAttributes(
          [.posixPermissions: NSNumber(value: file.mode)], ofItemAtPath: url.path)
      }
    }
    var publication = PatchPublication(root: root, staging: staging)
    do {
      try checkpoint?("validated")
      try WorkspaceOperation.shared.check(token)
      // Claim all originals with exclusive renames, then verify the bytes actually claimed.
      // No new contents publish until every source and hunk has passed validation.
      for (index, file) in prepared.enumerated() {
        _ = try resolve(id, path: file.path, allowMissing: file.old == nil)
        try publication.claim(file, index: index)
      }
      try WorkspaceOperation.shared.check(token)
      for (index, file) in prepared.enumerated() {
        _ = try resolve(id, path: file.destination ?? file.path, allowMissing: true)
        try publication.publish(file, index: index)
        if file.new != nil { try checkpoint?("published:\(file.destination ?? file.path)") }
      }
      // Detect a detached/replaced parent without ever following it for writes.
      guard (try WorkspaceDirectory(root: rootURL)).same(as: root) else {
        throw WorkspaceError(
          .fileRevisionConflict, "The repository root changed during publication.")
      }
      try publication.verify()
    } catch {
      // Never clobber a non-cooperating writer during rollback. Keep originals for recovery if
      // an external writer occupies a claimed path or changes a newly published file.
      retainRecovery = !publication.rollback()
      if retainRecovery {
        markChanged(id)
        throw WorkspaceError(
          .patchRecoveryRequired,
          "External changes prevented safe rollback. Originals retained outside the repository at \(stagingURL.path)."
        )
      }
      throw error
    }
    markChanged(id)
    return prepared.flatMap { file -> [[String: Any]] in
      var result: [[String: Any]] = []
      if file.destination != nil || file.new == nil {
        result.append(["path": file.path, "revision": NSNull()])
      }
      if let data = file.new {
        result.append(["path": file.destination ?? file.path, "revision": digest(data)])
      }
      return result
    }
  }
}
