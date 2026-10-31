import CryptoKit
import Foundation

struct NativeFileRead: Sendable {
  let path: String
  let content: String
  let revision: String
  let nextOffset: Int?
  let totalBytes: Int

  var payload: [String: Any] {
    [
      "path": path, "content": content, "revision": revision,
      "nextOffset": nextOffset.map { $0 as Any } ?? NSNull(), "totalBytes": totalBytes,
    ]
  }
}

struct NativeFileEntry: Sendable {
  let name: String
  let kind: WorkspacePathKind
  let bytes: Int64

  var payload: [String: Any] {
    ["name": name, "kind": kind.rawValue, "bytes": bytes]
  }
}

struct NativeDirectoryListing: Sendable {
  let entries: [NativeFileEntry]
  let truncated: Bool

  var payload: [String: Any] {
    ["entries": entries.map(\.payload), "truncated": truncated]
  }
}

struct NativeSearchMatch: Sendable {
  let path: String
  let line: Int
  let content: String

  var payload: [String: Any] {
    ["path": path, "line": line, "content": content]
  }
}

struct NativeSearchResult: Sendable {
  let matches: [NativeSearchMatch]
  let truncated: Bool
  let skippedFiles: Int
  let visitedEntries: Int
  let searchedBytes: Int

  var payload: [String: Any] {
    [
      "matches": matches.map(\.payload), "truncated": truncated, "skippedFiles": skippedFiles,
      "visitedEntries": visitedEntries, "searchedBytes": searchedBytes,
    ]
  }
}

extension WorkspaceStore {
  func listFiles(_ id: String, path: String, limit: Int) throws -> NativeDirectoryListing {
    guard (1...1000).contains(limit) else {
      throw WorkspaceError(.invalidArgument, "Directory limits must be between 1 and 1000.")
    }
    let directory = try resolve(id, path: path, allowRoot: true)
    guard try kind(directory) == .directory else {
      throw WorkspaceError(.pathNotDirectory, "Choose a directory to list.")
    }
    var enumerationError: Error?
    guard
      let enumerator = fileManager.enumerator(
        at: directory, includingPropertiesForKeys: nil, options: [.skipsSubdirectoryDescendants],
        errorHandler: { _, error in
          enumerationError = error
          return false
        }
      )
    else {
      throw WorkspaceError(.storageFailure, "The workspace directory could not be enumerated.")
    }
    var selected: [NativeFileEntry] = []
    var truncated = false
    while let value = enumerator.nextObject() {
      guard let item = value as? URL, item.path.hasPrefix(directory.path + "/") else {
        throw WorkspaceError(.storageFailure, "Directory enumeration returned an invalid workspace path.")
      }
      if item.lastPathComponent.lowercased() == ".git" { continue }
      if selected.count == limit {
        truncated = true
        break
      }
      guard let type = try kind(item), let info = try fileStatus(item) else {
        throw WorkspaceError(.storageFailure, "The directory changed while it was being listed. Retry the tool.")
      }
      selected.append(
        NativeFileEntry(name: item.lastPathComponent, kind: type, bytes: info.st_size))
    }
    if let enumerationError { throw enumerationError }
    return NativeDirectoryListing(
      entries: selected.sorted { $0.name < $1.name }, truncated: truncated
    )
  }

  func readFile(_ id: String, path: String, offset: Int, limit: Int) throws -> NativeFileRead {
    guard offset >= 0, (1...65_536).contains(limit) else {
      throw WorkspaceError(
        .invalidArgument,
        "Read offsets must be non-negative and limits must be between 1 and 65536 bytes.")
    }
    let url = try resolve(id, path: path)
    let data = try readData(url)
    guard String(data: data, encoding: .utf8) != nil else {
      throw WorkspaceError(.fileNotText, "Workspace tools only read UTF-8 text files.")
    }
    guard offset <= data.count else {
      throw WorkspaceError(.invalidArgument, "The read offset is beyond the end of the file.")
    }
    guard offset == data.count || data[offset] & 0xC0 != 0x80 else {
      throw WorkspaceError(.invalidArgument, "The read offset must fall on a UTF-8 character boundary.")
    }
    var end = min(data.count, offset + limit)
    while end > offset && end < data.count && data[end] & 0xC0 == 0x80 {
      end -= 1
    }
    guard end > offset || offset == data.count,
      let content = String(data: data.subdata(in: offset..<end), encoding: .utf8)
    else {
      throw WorkspaceError(.invalidArgument, "The read limit is too small for the next UTF-8 character.")
    }
    return NativeFileRead(
      path: path, content: content, revision: digest(data),
      nextOffset: end < data.count ? end : nil, totalBytes: data.count
    )
  }

  func writeFile(_ id: String, path: String, content: String, expectedRevision: String?) throws
    -> String
  {
    guard content.utf8.count <= Self.maximumFileBytes else {
      throw WorkspaceError(.fileTooLarge, "Files larger than 4 MiB cannot be written by local tools.")
    }
    let data = Data(content.utf8)
    let url = try resolve(id, path: path, allowMissing: true)
    let previous = try fileStatus(url)
    if previous != nil {
      guard try kind(url) == .file, let expectedRevision,
        digest(try readData(url)) == expectedRevision
      else {
        throw WorkspaceError(.fileRevisionConflict, "The file changed or was not read. Read it again before replacing it.")
      }
    } else if expectedRevision != nil {
      throw WorkspaceError(.fileRevisionConflict, "The file was removed. Read the workspace again before replacing it.")
    }
    try fileManager.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
    if let previous {
      try fileManager.setAttributes(
        [.posixPermissions: NSNumber(value: Int(previous.st_mode & 0o777))], ofItemAtPath: url.path)
    }
    markChanged(id)
    return digest(data)
  }

  func editFile(
    _ id: String, path: String, oldText: String, newText: String, expectedRevision: String
  ) throws -> String {
    guard !oldText.isEmpty, oldText.utf8.count <= Self.maximumFileBytes,
      newText.utf8.count <= Self.maximumFileBytes
    else {
      throw WorkspaceError(
        .invalidArgument,
        "An edit requires non-empty old text and text sizes no larger than 4 MiB.")
    }
    let url = try resolve(id, path: path)
    let data = try readData(url)
    guard digest(data) == expectedRevision, String(data: data, encoding: .utf8) != nil else {
      throw WorkspaceError(.fileRevisionConflict, "The file changed or is not UTF-8 text. Read it again before editing.")
    }
    let oldData = Data(oldText.utf8)
    guard let range = data.range(of: oldData),
      data.range(of: oldData, in: (range.lowerBound + 1)..<data.endIndex) == nil
    else {
      throw WorkspaceError(.editNoUniqueMatch, "The edit must match exactly one location in the file.")
    }
    guard data.count - oldData.count + newText.utf8.count <= Self.maximumFileBytes else {
      throw WorkspaceError(.fileTooLarge, "The edited file would exceed 4 MiB.")
    }
    var updated = data
    updated.replaceSubrange(range, with: newText.utf8)
    guard let content = String(data: updated, encoding: .utf8) else {
      throw WorkspaceError(.fileNotText, "The edit did not produce valid UTF-8 text.")
    }
    return try writeFile(id, path: path, content: content, expectedRevision: expectedRevision)
  }

  func renamePath(_ id: String, path: String, destination: String, expectedRevision: String?) throws
  {
    let source = try resolve(id, path: path)
    try verifyRevision(source, expectedRevision)
    try move(id, source: source, destination: destination)
  }

  private func move(_ id: String, source: URL, destination: String) throws {
    let target = try resolve(id, path: destination, allowMissing: true)
    guard try kind(target) == nil else {
      throw WorkspaceError(.pathExists, "The rename destination already exists.")
    }
    try fileManager.createDirectory(
      at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fileManager.moveItem(at: source, to: target)
    markChanged(id)
  }

  func removePath(_ id: String, path: String, expectedRevision: String?) throws {
    let url = try resolve(id, path: path)
    try verifyRevision(url, expectedRevision)
    try fileManager.removeItem(at: url)
    markChanged(id)
  }

  /// User-initiated rename from the Files UI. Containment rules match the agent tools, but the
  /// user acts on the current listing, so no file revision is required (large/binary files too).
  func renameEntry(_ id: String, path: String, destination: String) throws {
    try move(id, source: try resolve(id, path: path), destination: destination)
  }

  /// User-initiated removal from the Files UI; see `renameEntry`.
  func removeEntry(_ id: String, path: String) throws {
    try fileManager.removeItem(at: try resolve(id, path: path))
    markChanged(id)
  }

  func searchFiles(_ id: String, query: String) throws -> NativeSearchResult {
    guard !query.isEmpty, query.utf8.count <= 1024,
      !query.unicodeScalars.contains(where: { CharacterSet.newlines.contains($0) })
    else {
      throw WorkspaceError(.invalidArgument, "Search text must be a single line of 1-1024 UTF-8 bytes.")
    }
    let root = try resolve(id, path: "", allowRoot: true)
    var matches: [NativeSearchMatch] = []
    var skipped = 0
    var scanned = 0
    var bytes = 0
    var enumerationError: Error?
    guard
      let enumerator = fileManager.enumerator(
        at: root, includingPropertiesForKeys: nil, options: [],
        errorHandler: { _, error in
          enumerationError = error
          return false
        }
      )
    else {
      throw WorkspaceError(.storageFailure, "The workspace could not be enumerated for search.")
    }
    while let value = enumerator.nextObject() {
      guard let child = value as? URL, child.path.hasPrefix(root.path + "/") else {
        throw WorkspaceError(.storageFailure, "Search enumeration returned an invalid workspace path.")
      }
      if child.lastPathComponent.lowercased() == ".git" {
        enumerator.skipDescendants()
        continue
      }
      if scanned == 2000 {
        return NativeSearchResult(
          matches: matches, truncated: true, skippedFiles: skipped, visitedEntries: scanned,
          searchedBytes: bytes)
      }
      scanned += 1
      let relative = String(child.path.dropFirst(root.path.count + 1))
      guard let type = try kind(child), let info = try fileStatus(child) else {
        throw WorkspaceError(.storageFailure, "The workspace changed during search. Retry the tool.")
      }
      if type == .directory {
        continue
      }
      guard type == .file, info.st_nlink == 1, info.st_size <= 1024 * 1024 else {
        enumerator.skipDescendants()
        skipped += 1
        continue
      }
      if bytes + Int(info.st_size) > 16 * 1024 * 1024 {
        return NativeSearchResult(
          matches: matches, truncated: true, skippedFiles: skipped, visitedEntries: scanned,
          searchedBytes: bytes)
      }
      let data = try readData(child)
      bytes += data.count
      guard let content = String(data: data, encoding: .utf8) else {
        skipped += 1
        continue
      }
      var lineNumber = 0
      var reachedLimit = false
      content.enumerateLines { line, stop in
        lineNumber += 1
        if line.range(of: query, options: .literal) != nil {
          matches.append(
            NativeSearchMatch(path: relative, line: lineNumber, content: Self.clippedLine(line)))
          if matches.count == 20 {
            reachedLimit = true
            stop = true
          }
        }
      }
      if reachedLimit {
        return NativeSearchResult(
          matches: matches, truncated: true, skippedFiles: skipped, visitedEntries: scanned,
          searchedBytes: bytes)
      }
    }
    if let enumerationError { throw enumerationError }
    return NativeSearchResult(
      matches: matches, truncated: false, skippedFiles: skipped, visitedEntries: scanned,
      searchedBytes: bytes)
  }

  private func verifyRevision(_ url: URL, _ expected: String?) throws {
    if try kind(url) == .file {
      guard let expected, digest(try readData(url)) == expected else {
        throw WorkspaceError(.fileRevisionConflict, "The file changed or was not read. Read it again before changing it.")
      }
    } else if expected != nil {
      throw WorkspaceError(.invalidArgument, "File revisions cannot be used for directories.")
    }
  }

  private func readData(_ url: URL) throws -> Data {
    guard try kind(url) == .file, let info = try fileStatus(url), info.st_nlink == 1,
      info.st_size <= Self.maximumFileBytes
    else {
      throw WorkspaceError(.pathUnsupported, "Workspace tools require a regular file no larger than 4 MiB.")
    }
    return try Data(contentsOf: url)
  }

  private func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func clippedLine(_ line: String) -> String {
    var bytes = Array(line.utf8.prefix(512))
    while String(bytes: bytes, encoding: .utf8) == nil && !bytes.isEmpty {
      bytes.removeLast()
    }
    return String(decoding: bytes, as: UTF8.self)
  }
}
