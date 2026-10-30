import ExpoModulesCore
import Foundation

public class OnDeviceAgentModule: Module {
  private let workspaces = WorkspaceStore()
  private let models = ModelFileStore()
  private let documents = RuntimeDocumentStore()

  public func definition() -> ModuleDefinition {
    Name("OnDeviceAgent")

    Function("getAPIVersion") { 7 }

    Function("cancelGitTransfer") { GitNetworkOperation.shared.cancel() }
    Function("getGitTransferProgress") { GitNetworkOperation.shared.snapshot() }

    Function("getMemoryInfo") { try NativeMemory.snapshot() }

    AsyncFunction("storeGitCredential") {
      (host: String, accountId: String, username: String, token: String) -> String in
      try GitCredentialStore.save(
        host: host, accountId: accountId, username: username, token: token)
    }

    AsyncFunction("removeGitCredential") { (reference: String) in
      try GitCredentialStore.remove(reference)
    }

    AsyncFunction("listWorkspaces") {
      let result = try await self.workspaces.listWorkspaces()
      return result.map(\.payload)
    }

    AsyncFunction("createWorkspace") { (name: String) in
      let result = try await self.workspaces.createWorkspace(name: name)
      return result.payload
    }

    AsyncFunction("cloneWorkspace") { (name: String, remote: String, credentialRef: String?) in
      let result = try await self.workspaces.cloneWorkspace(
        name: name, remote: remote, credentialRef: credentialRef)
      return result.payload
    }

    AsyncFunction("listWorkspaceFiles") { (id: String, path: String, limit: Int) in
      let result = try await self.workspaces.listFiles(id, path: path, limit: limit)
      return result.payload
    }

    AsyncFunction("readWorkspaceFile") { (id: String, path: String, offset: Int, limit: Int) in
      let result = try await self.workspaces.readFile(id, path: path, offset: offset, limit: limit)
      return result.payload
    }

    AsyncFunction("writeWorkspaceFile") {
      (id: String, path: String, content: String, revision: String?) in
      try await self.workspaces.writeFile(
        id, path: path, content: content, expectedRevision: revision)
    }

    AsyncFunction("editWorkspaceFile") {
      (id: String, path: String, oldText: String, newText: String, revision: String) in
      try await self.workspaces.editFile(
        id, path: path, oldText: oldText, newText: newText, expectedRevision: revision)
    }

    AsyncFunction("renameWorkspacePath") {
      (id: String, path: String, destination: String, revision: String?) in
      try await self.workspaces.renamePath(
        id, path: path, destination: destination, expectedRevision: revision)
    }

    AsyncFunction("removeWorkspacePath") { (id: String, path: String, revision: String?) in
      try await self.workspaces.removePath(id, path: path, expectedRevision: revision)
    }

    AsyncFunction("searchWorkspaceFiles") { (id: String, query: String) in
      let result = try await self.workspaces.searchFiles(id, query: query)
      return result.payload
    }

    AsyncFunction("getModelFilePaths") { (id: String) in
      let result = try await self.models.paths(id)
      return result.payload
    }

    AsyncFunction("getDownloadedModelFile") { (id: String) -> [String: Any]? in
      guard let result = try await self.models.downloaded(id) else { return nil }
      return result.0.payload(uri: result.1)
    }

    AsyncFunction("finalizeModelDownload") { (id: String, sha256: String, expectedBytes: Int64) in
      let result = try await self.models.finalize(id, sha256: sha256, expectedBytes: expectedBytes)
      return result.0.payload(uri: result.1)
    }

    AsyncFunction("removeModelFile") { (id: String) in
      try await ModelDownloadSession.shared.cancel(id)
      try await self.models.remove(id)
    }

    // Background model transfers, verification progress, and storage overview (API 7).
    AsyncFunction("attachModelDownloads") {
      await ModelDownloadSession.shared.attach().map(\.payload)
    }

    AsyncFunction("startModelDownload") { (id: String, url: String, expectedBytes: Int64) in
      try ModelDownloadSession.shared.start(id, url: url, expectedBytes: expectedBytes).payload
    }

    AsyncFunction("pauseModelDownload") { (id: String) in
      try await ModelDownloadSession.shared.pause(id).payload
    }

    AsyncFunction("cancelModelDownload") { (id: String) in
      try await ModelDownloadSession.shared.cancel(id)
    }

    Function("getModelDownload") { (id: String) in
      try ModelDownloadSession.shared.snapshot(id).payload
    }

    Function("getModelVerificationProgress") { (id: String) in
      ModelVerificationProgress.shared.snapshot(id)
    }

    Function("cancelModelVerification") { (id: String) in
      ModelVerificationProgress.shared.cancel(id)
    }

    AsyncFunction("getModelStorageInfo") {
      try await self.models.storage().payload
    }

    AsyncFunction("readRuntimeDocument") { (name: String) in
      try await self.documents.read(name)
    }

    AsyncFunction("writeRuntimeDocument") { (name: String, content: String) in
      try await self.documents.write(name, content: content)
    }

    AsyncFunction("listRuntimeDocuments") { (prefix: String) in
      try await self.documents.names(prefix: prefix)
    }

    AsyncFunction("removeRuntimeDocument") { (name: String) in
      try await self.documents.remove(name)
    }

    AsyncFunction("getWorkspaceGitStatus") { (id: String) in
      let result = try await self.workspaces.gitStatus(id)
      return result.payload
    }

    AsyncFunction("getWorkspaceGitDiff") { (id: String, maximumBytes: Int?) in
      let result = try await self.workspaces.gitDiff(id, maximumBytes: maximumBytes ?? 128 * 1024)
      return result.payload
    }

    AsyncFunction("getWorkspaceGitHistory") { (id: String) in
      let result = try await self.workspaces.gitHistory(id)
      return ["commits": result.map(\.payload)]
    }

    AsyncFunction("getWorkspaceGitBranches") { (id: String) in
      let result = try await self.workspaces.gitBranches(id)
      let status = try await self.workspaces.gitStatus(id)
      return ["branches": result.map(\.payload), "current": status.branch] as [String: Any]
    }

    AsyncFunction("stageWorkspaceGit") { (id: String, path: String?) in
      try await self.workspaces.gitStage(id, path: path)
    }

    AsyncFunction("unstageWorkspaceGit") { (id: String, path: String?) in
      try await self.workspaces.gitUnstage(id, path: path)
    }

    AsyncFunction("commitWorkspaceGit") { (id: String, message: String, name: String, email: String) in
      try await self.workspaces.gitCommit(id, message: message, name: name, email: email)
    }

    AsyncFunction("switchWorkspaceGitBranch") { (id: String, branch: String) in
      try await self.workspaces.gitSwitch(id, branch: branch)
    }

    AsyncFunction("getWorkspaceGitOrigin") { (id: String) in
      try await self.workspaces.gitOrigin(id)
    }

    AsyncFunction("pushWorkspaceGit") { (id: String, credentialRef: String?) in
      try await self.workspaces.gitPush(id, credentialRef: credentialRef)
    }
  }
}
