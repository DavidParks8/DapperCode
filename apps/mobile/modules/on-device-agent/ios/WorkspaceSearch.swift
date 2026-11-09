import DapperGit
import Foundation

struct WorkspaceSearchOptions: Sendable {
  var path = ""
  var include = "**/*"
  var fileType = ""
  var regex = false
  var caseSensitive = true
  var offset = 0
  var limit = 20

  init() { /* Default model search controls. */  }

  init(_ values: [String: Any]) throws {
    guard
      Set(values.keys)
        == Set(["path", "include", "fileType", "regex", "caseSensitive", "offset", "limit"]),
      let path = values["path"] as? String, let include = values["include"] as? String,
      let fileType = values["fileType"] as? String, let regex = values["regex"] as? Bool,
      let caseSensitive = values["caseSensitive"] as? Bool,
      let offset = values["offset"] as? Int, let limit = values["limit"] as? Int
    else { throw WorkspaceError(.invalidArgument, "Invalid workspace search options.") }
    self.path = path
    self.include = include
    self.fileType = fileType
    self.regex = regex
    self.caseSensitive = caseSensitive
    self.offset = offset
    self.limit = limit
  }
}

struct WorkspaceQueryResult: Sendable {
  var matches: [NativeSearchMatch] = []
  var files: [String] = []
  var skippedFiles = 0
  var excludedEntries = 0
  var visitedEntries = 0
  var searchedBytes = 0
  var reason = "complete"
  var nextOffset: Int?

  var payload: [String: Any] {
    [
      "matches": matches.map(\.payload), "files": files, "skippedFiles": skippedFiles,
      "excludedEntries": excludedEntries, "visitedEntries": visitedEntries,
      "searchedBytes": searchedBytes, "truncated": reason != "complete", "reason": reason,
      "nextOffset": nextOffset.map { $0 as Any } ?? NSNull(),
      "budgets": [
        "entries": 2000, "bytes": 16 * 1024 * 1024, "fileBytes": 1024 * 1024,
        "milliseconds": 2000, "patternMilliseconds": 25, "previewBytes": 512,
      ],
    ]
  }
}

private func boundedWorkspaceMatch(
  _ expression: NSRegularExpression, _ text: String, token: String
) throws -> Bool {
  var found = false
  var failure: Error?
  let deadline = ProcessInfo.processInfo.systemUptime + 0.025
  expression.enumerateMatches(
    in: text, options: [.reportProgress], range: NSRange(text.startIndex..., in: text)
  ) {
    match, _, stop in
    do {
      try WorkspaceOperation.shared.check(token)
      if ProcessInfo.processInfo.systemUptime > deadline {
        throw WorkspaceError(
          .searchPatternTimeout, "Pattern exceeded its 25 ms per-line/path budget.")
      }
      if match != nil {
        found = true
        stop.pointee = true
      }
    } catch {
      failure = error
      stop.pointee = true
    }
  }
  if let failure { throw failure }
  return found
}

private enum WorkspaceContentQuery {
  case literal(String)
  case regex(NSRegularExpression)
}

private final class WorkspaceSearch {
  let root: URL
  let secureRoot: WorkspaceDirectory
  let options: WorkspaceSearchOptions
  let token: String
  let glob: NSRegularExpression
  let query: WorkspaceContentQuery?
  let started = ProcessInfo.processInfo.systemUptime
  var result = WorkspaceQueryResult()
  var matched = 0
  var pageFinished = false

  init(
    root: URL,
    options: WorkspaceSearchOptions,
    token: String,
    glob: NSRegularExpression,
    query: WorkspaceContentQuery?
  ) throws {
    self.root = root
    self.secureRoot = try WorkspaceDirectory(root: root)
    self.options = options
    self.token = token
    self.glob = glob
    self.query = query
  }

  func timeAvailable() throws -> Bool {
    try WorkspaceOperation.shared.check(token)
    if ProcessInfo.processInfo.systemUptime - started > 2 {
      result.reason = "time"
      return false
    }
    return true
  }

  func run(scope: URL, repository: OpaquePointer?) throws -> WorkspaceQueryResult {
    let candidates = try discover(scope: scope, repository: repository)
    for path in candidates.sorted() {
      guard try timeAvailable() else { break }
      if let query {
        if let content = try readContent(path) {
          try searchLines(content, path: path, query: query)
        }
      } else {
        if matched >= options.offset {
          if result.files.count == options.limit {
            finishPage()
            break
          }
          result.files.append(path)
        }
        matched += 1
      }
      if pageFinished || result.reason == "bytes" || result.reason == "time" { break }
    }
    return result
  }

  func finishPage() {
    pageFinished = true
    if result.reason == "complete" {
      result.reason = "results"
      result.nextOffset = matched
    }
  }

  func discover(scope: URL, repository: OpaquePointer?) throws -> [String] {
    var candidates: [String] = []
    var enumerationError: Error?
    guard
      let enumerator = FileManager.default.enumerator(
        at: scope, includingPropertiesForKeys: nil, options: [],
        errorHandler: { _, error in
          enumerationError = error
          return false
        })
    else { throw WorkspaceError(.storageFailure, "Cannot enumerate workspace search paths.") }
    while let child = enumerator.nextObject() as? URL {
      guard try timeAvailable() else { break }
      if result.visitedEntries == 2000 {
        result.reason = "entries"
        break
      }
      result.visitedEntries += 1
      guard child.path.hasPrefix(root.path + "/") else {
        throw WorkspaceError(.pathOutsideWorkspace, "Search enumeration escaped its workspace.")
      }
      let path = String(child.path.dropFirst(root.path.count + 1))
      let parent = try secureRoot.parent(of: path)
      guard let info = try parent.status(child.lastPathComponent) else {
        throw WorkspaceError(.storageFailure, "A search path disappeared. Retry the tool.")
      }
      if try excluded(path, repository: repository) {
        if info.st_mode & S_IFMT == S_IFDIR { enumerator.skipDescendants() }
        result.excludedEntries += 1
        continue
      }
      if info.st_mode & S_IFMT == S_IFDIR { continue }
      guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else {
        result.skippedFiles += 1
        continue
      }
      if try boundedWorkspaceMatch(glob, path, token: token),
        options.fileType.isEmpty
          || child.pathExtension.lowercased() == options.fileType.lowercased()
      {
        candidates.append(path)
      } else {
        result.excludedEntries += 1
      }
    }
    if let enumerationError { throw enumerationError }
    return candidates
  }

  func excluded(_ path: String, repository: OpaquePointer?) throws -> Bool {
    if path.split(separator: "/").contains(where: { $0.lowercased() == ".git" }) { return true }
    guard let repository else { return false }
    var ignored: Int32 = 0
    try NativeGit.requireSuccess(
      git_ignore_path_is_ignored(&ignored, repository, path), "Check ignored path")
    return ignored != 0
  }

  func readContent(_ path: String) throws -> String? {
    let parent = try secureRoot.parent(of: path)
    let name = URL(fileURLWithPath: path).lastPathComponent
    guard let info = try parent.status(name), info.st_size <= 1024 * 1024 else {
      result.skippedFiles += 1
      return nil
    }
    if result.searchedBytes + Int(info.st_size) > 16 * 1024 * 1024 {
      result.reason = "bytes"
      return nil
    }
    let data = try parent.read(
      name, maximum: min(1024 * 1024, 16 * 1024 * 1024 - result.searchedBytes))
    result.searchedBytes += data.count
    guard let content = String(data: data, encoding: .utf8), !data.contains(0) else {
      result.skippedFiles += 1
      return nil
    }
    return content
  }

  func matchesLine(_ line: String, query: WorkspaceContentQuery) throws -> Bool {
    switch query {
    case .literal(let text):
      return line.range(
        of: text, options: options.caseSensitive ? [.literal] : [.literal, .caseInsensitive]) != nil
    case .regex(let expression):
      return try boundedWorkspaceMatch(expression, line, token: token)
    }
  }

  func searchLines(_ content: String, path: String, query: WorkspaceContentQuery) throws {
    var lineNumber = 0
    var failure: Error?
    content.enumerateLines { [self] line, stop in
      lineNumber += 1
      do {
        guard try timeAvailable() else {
          stop = true
          return
        }
        if try matchesLine(line, query: query) {
          if matched >= options.offset {
            if result.matches.count == options.limit {
              finishPage()
              stop = true
              return
            }
            result.matches.append(
              NativeSearchMatch(
                path: path, line: lineNumber, content: WorkspaceStore.clippedLine(line),
                previewTruncated: line.utf8.count > 512))
          }
          matched += 1
        }
      } catch {
        failure = error
        stop = true
      }
    }
    if let failure { throw failure }
  }
}

extension WorkspaceStore {
  func queryFiles(
    _ id: String, query: String?, options: WorkspaceSearchOptions, token: String
  ) throws -> WorkspaceQueryResult {
    try WorkspaceOperation.shared.check(token)
    guard (1...100).contains(options.limit), (0...10_000).contains(options.offset),
      options.fileType.utf8.count <= 32,
      options.fileType.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" })
    else { throw WorkspaceError(.invalidArgument, "Invalid search paging or file extension.") }
    if let query {
      guard !query.isEmpty, query.utf8.count <= 1024,
        !query.unicodeScalars.contains(where: { CharacterSet.newlines.contains($0) })
      else {
        throw WorkspaceError(.invalidArgument, "Search requires 1-1024 single-line UTF-8 bytes.")
      }
    }
    let glob = try Self.fileGlob(options.include)
    let expression: WorkspaceContentQuery?
    do {
      expression = try query.map {
        if !options.regex { return .literal($0) }
        return .regex(
          try NSRegularExpression(
            pattern: $0, options: options.caseSensitive ? [] : [.caseInsensitive]))
      }
    } catch { throw WorkspaceError(.searchPatternInvalid, "Invalid ICU regular expression.") }
    let root = try Self.enumerationDirectory(resolve(id, path: "", allowRoot: true))
    let scope = try Self.enumerationDirectory(resolve(id, path: options.path, allowRoot: true))
    guard try kind(scope) == .directory else {
      throw WorkspaceError(.pathNotDirectory, "Search path must be a directory.")
    }
    let search = try WorkspaceSearch(
      root: root,
      options: options, token: token, glob: glob, query: expression)
    // libgit2 owns Git's nested ignore, negation, and info/exclude conventions.
    if try kind(root.appendingPathComponent(".git")) == .directory {
      return try NativeGit.withRepository(root) { try search.run(scope: scope, repository: $0) }
    }
    return try search.run(scope: scope, repository: nil)
  }

  private static func fileGlob(_ pattern: String) throws -> NSRegularExpression {
    guard !pattern.isEmpty, pattern.utf8.count <= 1024, !pattern.hasPrefix("/"),
      !pattern.contains("\\"), !pattern.contains("\0"),
      !pattern.split(separator: "/").contains("..")
    else {
      throw WorkspaceError(.searchPatternInvalid, "Use a workspace-relative glob of 1-1024 bytes.")
    }
    let characters = Array(pattern)
    var index = 0
    var expression = "^"
    while index < characters.count {
      switch characters[index] {
      case "*":
        if index + 1 < characters.count, characters[index + 1] == "*" {
          index += 1
          if index + 1 < characters.count, characters[index + 1] == "/" {
            index += 1
            expression += "(?:.*/)?"
          } else {
            expression += ".*"
          }
        } else {
          expression += "[^/]*"
        }
      case "?": expression += "[^/]"
      default: expression += NSRegularExpression.escapedPattern(for: String(characters[index]))
      }
      index += 1
    }
    return try NSRegularExpression(pattern: expression + "$")
  }
}
