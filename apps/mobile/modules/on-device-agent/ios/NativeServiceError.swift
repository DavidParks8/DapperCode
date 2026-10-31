import Foundation

/// Stable, JavaScript-visible failure codes. JavaScript parses the `[ondevice:CODE]` tag from the
/// error description, so these raw values are part of the native ABI and must not be renamed.
enum NativeErrorCode: String, Sendable {
  case invalidArgument = "INVALID_ARGUMENT"
  case workspaceRequired = "WORKSPACE_REQUIRED"
  case workspaceInvalidID = "WORKSPACE_INVALID_ID"
  case workspaceNotFound = "WORKSPACE_NOT_FOUND"
  case workspaceNameInvalid = "WORKSPACE_NAME_INVALID"
  case workspaceCorrupt = "WORKSPACE_CORRUPT"
  case pathOutsideWorkspace = "PATH_OUTSIDE_WORKSPACE"
  case pathNotFound = "PATH_NOT_FOUND"
  case pathExists = "PATH_EXISTS"
  case pathNotDirectory = "PATH_NOT_DIRECTORY"
  case pathUnsupported = "PATH_UNSUPPORTED"
  case fileRevisionConflict = "FILE_REVISION_CONFLICT"
  case fileNotText = "FILE_NOT_TEXT"
  case fileTooLarge = "FILE_TOO_LARGE"
  case editNoUniqueMatch = "EDIT_NO_UNIQUE_MATCH"
  case storageFailure = "STORAGE_FAILURE"
  case credentialInvalid = "CREDENTIAL_INVALID"
  case credentialUnavailable = "CREDENTIAL_UNAVAILABLE"
  case gitNotRepository = "GIT_NOT_REPOSITORY"
  case gitAlreadyRepository = "GIT_ALREADY_REPOSITORY"
  case gitNoOrigin = "GIT_NO_ORIGIN"
  case gitNoUpstream = "GIT_NO_UPSTREAM"
  case gitNoCommits = "GIT_NO_COMMITS"
  case gitDetachedHead = "GIT_DETACHED_HEAD"
  case gitNothingToCommit = "GIT_NOTHING_TO_COMMIT"
  case gitDirtyWorktree = "GIT_DIRTY_WORKTREE"
  case gitBranchInvalid = "GIT_BRANCH_INVALID"
  case gitBranchExists = "GIT_BRANCH_EXISTS"
  case gitBranchNotFound = "GIT_BRANCH_NOT_FOUND"
  case gitNonFastForward = "GIT_NON_FAST_FORWARD"
  case gitConflict = "GIT_CONFLICT"
  case gitLocked = "GIT_LOCKED"
  case gitInsecureRemote = "GIT_INSECURE_REMOTE"
  case gitCredentialOrigin = "GIT_CREDENTIAL_ORIGIN"
  case gitAuthFailed = "GIT_AUTH_FAILED"
  case gitCertificate = "GIT_CERTIFICATE"
  case gitRemoteRejected = "GIT_REMOTE_REJECTED"
  case gitNetwork = "GIT_NETWORK"
  case gitTransferBusy = "GIT_TRANSFER_BUSY"
  case gitTransferInterrupted = "GIT_TRANSFER_INTERRUPTED"
  case gitFailure = "GIT_FAILURE"
}

protocol NativeCodedError: LocalizedError {
  var code: NativeErrorCode { get }
  var message: String { get }
}

extension NativeCodedError {
  var errorDescription: String? { "[ondevice:\(code.rawValue)] \(message)" }
}

struct WorkspaceError: NativeCodedError {
  let code: NativeErrorCode
  let message: String
  init(_ code: NativeErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }
}

struct GitOperationError: NativeCodedError {
  let code: NativeErrorCode
  let message: String
  init(_ code: NativeErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }
}
