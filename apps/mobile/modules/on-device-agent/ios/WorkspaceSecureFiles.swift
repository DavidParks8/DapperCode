import Darwin
import Foundation

/// Descriptor-relative access keeps parent replacement and link races inside the workspace.
final class WorkspaceDirectory {
  let descriptor: Int32

  init(root: URL) throws {
    descriptor = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      throw WorkspaceError(.pathUnsupported, "Cannot securely open the workspace directory.")
    }
  }

  init(parent: WorkspaceDirectory, name: String) throws {
    descriptor = openat(parent.descriptor, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      throw WorkspaceError(.pathUnsupported, "A parent directory changed or is a symbolic link.")
    }
  }

  deinit { close(descriptor) }

  func status(_ name: String) throws -> stat? {
    var info = stat()
    if fstatat(descriptor, name, &info, AT_SYMLINK_NOFOLLOW) == 0 { return info }
    if errno == ENOENT { return nil }
    throw WorkspaceError(.storageFailure, "Cannot inspect a workspace file.")
  }

  func read(_ name: String, maximum: Int = WorkspaceStore.maximumFileBytes) throws -> Data {
    let file = openat(descriptor, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard file >= 0 else {
      throw WorkspaceError(.pathUnsupported, "Cannot securely open the workspace file.")
    }
    defer { close(file) }
    var info = stat()
    guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      info.st_nlink == 1, info.st_size <= maximum
    else {
      throw WorkspaceError(
        .pathUnsupported, "Expected a single-link regular file within the byte limit.")
    }
    let handle = FileHandle(fileDescriptor: file, closeOnDealloc: false)
    var data = Data()
    while data.count <= maximum {
      guard let chunk = try handle.read(upToCount: min(65_536, maximum + 1 - data.count)),
        !chunk.isEmpty
      else { break }
      data.append(chunk)
    }
    guard data.count <= maximum else {
      throw WorkspaceError(.fileTooLarge, "The file grew beyond the byte limit.")
    }
    return data
  }

  func same(as other: WorkspaceDirectory) -> Bool {
    var left = stat()
    var right = stat()
    return fstat(descriptor, &left) == 0 && fstat(other.descriptor, &right) == 0
      && left.st_dev == right.st_dev && left.st_ino == right.st_ino
  }

  func parent(of path: String) throws -> WorkspaceDirectory {
    var directory = self
    for component in path.split(separator: "/").dropLast() {
      directory = try WorkspaceDirectory(parent: directory, name: String(component))
    }
    return directory
  }
}
