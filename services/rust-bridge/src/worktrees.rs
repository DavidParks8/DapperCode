//! App-owned Git worktrees. The durable intent is written before Git runs so a retry after a
//! disconnect or process restart addresses the same checkout rather than creating another one.
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{services::GitService, storage::atomic_write_private, BridgeError};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChatWorkspace {
    pub mode: ChatWorkspaceMode,
    pub branch: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChatWorkspaceMode {
    Local,
    Worktree,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedWorktree {
    pub id: String,
    pub repository: String,
    pub path: String,
    pub branch: String,
    pub base_ref: String,
    pub base_commit: String,
    pub status: WorktreeStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorktreeStatus {
    Creating,
    Ready,
    Removed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateWorktree {
    pub cwd: Option<String>,
    pub id: String,
    pub branch: String,
    pub base_ref: String,
}

pub(crate) struct WorktreeService {
    git: Arc<GitService>,
    root: PathBuf,
    registry: PathBuf,
    records: Mutex<Vec<ManagedWorktree>>,
}

impl WorktreeService {
    pub(crate) async fn prepare_chat(
        &self,
        submission_id: &str,
        cwd: Option<&str>,
        workspace: &ChatWorkspace,
    ) -> Result<String, BridgeError> {
        validate_ref(&workspace.branch)?;
        match workspace.mode {
            ChatWorkspaceMode::Local => {
                if workspace.branch == "HEAD" {
                    return Ok(self
                        .git
                        .resolve_workspace(cwd)?
                        .to_string_lossy()
                        .into_owned());
                }
                let result = self
                    .git
                    .switch_branch(workspace.branch.clone(), cwd)
                    .await?;
                if !result.switched {
                    return Err(BridgeError::server(&result.stderr));
                }
                Ok(result.cwd)
            }
            ChatWorkspaceMode::Worktree => {
                // The existing thread submission ID owns both checkout and chat across retries.
                let digest = Sha256::digest(submission_id.as_bytes());
                let mut bytes = [0u8; 16];
                bytes.copy_from_slice(&digest[..16]);
                let id = Uuid::from_bytes(bytes).to_string();
                let worktree = self
                    .create(CreateWorktree {
                        branch: format!("dappercode/{id}"),
                        id,
                        cwd: cwd.map(str::to_string),
                        base_ref: workspace.branch.clone(),
                    })
                    .await?;
                Ok(worktree.path)
            }
        }
    }
    pub(crate) async fn load(git: Arc<GitService>, state_dir: &Path) -> Result<Self, BridgeError> {
        let root = state_dir.join("worktrees");
        tokio::fs::create_dir_all(&root).await.map_err(io_error)?;
        let root = root.canonicalize().map_err(io_error)?;
        let registry = state_dir.join("managed-worktrees.json");
        let records: Vec<ManagedWorktree> = match tokio::fs::read(&registry).await {
            Ok(bytes) if bytes.len() <= 4 * 1024 * 1024 => serde_json::from_slice(&bytes)
                .map_err(|e| BridgeError::server(&format!("Invalid worktree registry: {e}")))?,
            Ok(_) => {
                return Err(BridgeError::server(
                    "Worktree registry exceeds its size limit",
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(io_error(e)),
        };
        for record in &records {
            validate_id(&record.id)?;
            if Path::new(&record.path) != root.join(&record.id) {
                return Err(BridgeError::server(
                    "Worktree registry contains an invalid checkout path",
                ));
            }
        }
        Ok(Self {
            git,
            root,
            registry,
            records: Mutex::new(records),
        })
    }

    async fn save(&self, records: &[ManagedWorktree]) -> Result<(), BridgeError> {
        let bytes = serde_json::to_vec(records).map_err(|e| BridgeError::server(&e.to_string()))?;
        atomic_write_private(&self.registry, &bytes)
            .await
            .map_err(io_error)
    }

    pub(crate) async fn list(&self) -> Vec<ManagedWorktree> {
        self.records
            .lock()
            .await
            .iter()
            .filter(|r| r.status != WorktreeStatus::Removed)
            .cloned()
            .collect()
    }

    pub(crate) async fn create(
        &self,
        request: CreateWorktree,
    ) -> Result<ManagedWorktree, BridgeError> {
        validate_id(&request.id)?;
        validate_ref(&request.branch)?;
        validate_ref(&request.base_ref)?;
        let cwd = self
            .git
            .resolve_and_validate_git_path(request.cwd.as_deref(), true)
            .await?;
        let repository = self
            .git
            .run_git_stdout(
                &cwd,
                &["rev-parse", "--show-toplevel"],
                "Cannot resolve repository",
            )
            .await?;
        let repository = repository.trim();
        // Do not nest a managed checkout's ownership under another managed checkout.
        let mut records = self.records.lock().await;
        let repository = records
            .iter()
            .find(|r| r.path == repository)
            .map(|r| r.repository.clone())
            .unwrap_or_else(|| repository.to_string());
        if self.root.starts_with(&repository) {
            return Err(BridgeError::invalid_params("Managed worktrees require BRIDGE_STATE_DIR outside the repository. Use the desktop app's central data directory."));
        }
        let existing = records.iter().position(|r| r.id == request.id);
        let index = if let Some(index) = existing {
            let record = &records[index];
            if record.repository != repository
                || record.branch != request.branch
                || record.base_ref != request.base_ref
            {
                return Err(BridgeError::invalid_params(
                    "Worktree request ID was already used with different parameters",
                ));
            }
            if record.status == WorktreeStatus::Removed {
                return Err(BridgeError::invalid_params(
                    "This worktree was removed; start a new creation request",
                ));
            }
            index
        } else {
            if records.len() >= 4096 {
                return Err(BridgeError::server("Managed worktree registry is full"));
            }
            let repo = Path::new(&repository);
            self.git
                .run_git_stdout(
                    repo,
                    &["check-ref-format", "--branch", &request.branch],
                    "Invalid branch name",
                )
                .await?;
            let existing_branch = self
                .git
                .run_git_stdout(
                    repo,
                    &[
                        "for-each-ref",
                        "--format=%(refname)",
                        &format!("refs/heads/{}", request.branch),
                    ],
                    "Cannot inspect branches",
                )
                .await?;
            if existing_branch
                .lines()
                .any(|line| line == format!("refs/heads/{}", request.branch))
            {
                return Err(BridgeError::invalid_params(
                    "Branch already exists. Choose a new branch name.",
                ));
            }
            let base = format!("{}^{{commit}}", request.base_ref);
            let commit = self
                .git
                .run_git_stdout(
                    &cwd,
                    &["rev-parse", "--verify", "--end-of-options", &base],
                    "Base branch must resolve to a commit",
                )
                .await?;
            let record = ManagedWorktree {
                id: request.id.clone(),
                repository,
                path: self.root.join(&request.id).to_string_lossy().into_owned(),
                branch: request.branch,
                base_ref: request.base_ref,
                base_commit: commit.trim().into(),
                status: WorktreeStatus::Creating,
            };
            let mut next = records.clone();
            next.push(record);
            self.save(&next).await?;
            *records = next;
            records.len() - 1
        };
        let record = &records[index];
        let repo = Path::new(&record.repository);
        if !self.registered(record).await? {
            if record.status == WorktreeStatus::Ready {
                return Err(BridgeError::server(
                    "Managed checkout is missing; remove its entry before creating a new one",
                ));
            }
            let reference = format!("refs/heads/{}", record.branch);
            let branch_commit = self
                .git
                .run_git_stdout(
                    repo,
                    &["for-each-ref", "--format=%(objectname)", &reference],
                    "Cannot inspect pending branch",
                )
                .await?;
            if branch_commit.trim() == record.base_commit {
                self.git
                    .run_git_stdout(
                        repo,
                        &["worktree", "add", &record.path, &record.branch],
                        "Cannot recover pending worktree",
                    )
                    .await?;
            } else {
                self.git
                    .run_git_stdout(
                        repo,
                        &[
                            "worktree",
                            "add",
                            "-b",
                            &record.branch,
                            &record.path,
                            &record.base_commit,
                        ],
                        "Cannot create worktree",
                    )
                    .await?;
            }
        }
        if Path::new(&record.path).canonicalize().map_err(io_error)? != self.root.join(&record.id) {
            return Err(BridgeError::invalid_params(
                "Managed checkout path was replaced",
            ));
        }
        let mut next = records.clone();
        next[index].status = WorktreeStatus::Ready;
        self.save(&next).await?;
        *records = next;
        Ok(records[index].clone())
    }

    async fn registered(&self, record: &ManagedWorktree) -> Result<bool, BridgeError> {
        let raw = self
            .git
            .run_git_stdout(
                Path::new(&record.repository),
                &["worktree", "list", "--porcelain", "-z"],
                "Cannot list worktrees",
            )
            .await?;
        Ok(raw
            .split('\0')
            .any(|field| field.strip_prefix("worktree ") == Some(record.path.as_str())))
    }

    pub(crate) async fn path(&self, id: &str) -> Result<PathBuf, BridgeError> {
        validate_id(id)?;
        self.records
            .lock()
            .await
            .iter()
            .find(|r| r.id == id)
            .map(|r| PathBuf::from(&r.path))
            .ok_or_else(|| BridgeError::invalid_params("Unknown managed worktree"))
    }

    /// Caller holds the agent workspace lifecycle write lock and has excluded referencing chats.
    pub(crate) async fn remove(&self, id: &str) -> Result<(), BridgeError> {
        let mut records = self.records.lock().await;
        let index = records
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(|| BridgeError::invalid_params("Unknown managed worktree"))?;
        let record = &records[index];
        if record.status == WorktreeStatus::Removed {
            return Ok(());
        }
        let repo = self
            .git
            .resolve_and_validate_git_path(Some(&record.repository), true)
            .await?;
        if Path::new(&record.path).exists() {
            let canonical = self
                .git
                .resolve_and_validate_git_path(Some(&record.path), true)
                .await?;
            if canonical != self.root.join(id) || !self.registered(record).await? {
                return Err(BridgeError::invalid_params(
                    "Checkout is not the registered managed worktree",
                ));
            }
            // Ignored files count too: never silently delete build output, local env files, or uploads.
            let status = self
                .git
                .run_git_stdout(
                    &canonical,
                    &[
                        "status",
                        "--porcelain",
                        "--untracked-files=all",
                        "--ignored",
                    ],
                    "Cannot inspect worktree",
                )
                .await?;
            if !status.is_empty() {
                return Err(BridgeError::invalid_params("Worktree contains modified, untracked, or ignored files. Preserve or remove them before removing the checkout."));
            }
            self.git
                .run_git_stdout(
                    &repo,
                    &["worktree", "remove", &record.path],
                    "Cannot remove worktree",
                )
                .await?;
        } else if self.registered(record).await? {
            self.git
                .run_git_stdout(
                    &repo,
                    &["worktree", "remove", &record.path],
                    "Cannot remove missing worktree registration",
                )
                .await?;
        }
        let mut next = records.clone();
        next[index].status = WorktreeStatus::Removed;
        self.save(&next).await?;
        *records = next;
        Ok(())
    }
}

fn validate_id(id: &str) -> Result<(), BridgeError> {
    if Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        Ok(())
    } else {
        Err(BridgeError::invalid_params(
            "Worktree id must be a canonical UUID",
        ))
    }
}

fn validate_ref(value: &str) -> Result<(), BridgeError> {
    if value.is_empty()
        || value.len() > 240
        || value.starts_with('-')
        || value.starts_with('@')
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        Err(BridgeError::invalid_params(
            "Choose a valid branch or base reference",
        ))
    } else {
        Ok(())
    }
}

fn io_error(error: std::io::Error) -> BridgeError {
    BridgeError::server(&format!("Managed worktree storage failed: {error}"))
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::services::TerminalService;
    use dappercode_bridge_path_policy::{PathKind, PathPolicy};
    use std::{fs, process::Command};

    struct Fixture {
        root: PathBuf,
        repo: PathBuf,
        state: PathBuf,
        policy: Arc<PathPolicy>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("managed-worktrees-{}", Uuid::new_v4()));
            let repo = root.join("repo");
            let state = root.join("data");
            fs::create_dir_all(&repo).unwrap();
            fs::create_dir_all(&state).unwrap();
            let policy = Arc::new(
                PathPolicy::with_attachments_root(
                    repo.clone(),
                    false,
                    Some(state.join("attachments")),
                )
                .unwrap()
                .with_managed_worktrees(state.join("worktrees"))
                .unwrap(),
            );
            let fixture = Self {
                root,
                repo,
                state,
                policy,
            };
            fixture.git(&fixture.repo, &["init", "-b", "main"]);
            fs::write(fixture.repo.join("tracked.txt"), "original\n").unwrap();
            fs::write(fixture.repo.join(".gitignore"), "ignored\n").unwrap();
            fixture.git(&fixture.repo, &["add", "."]);
            fixture.git(
                &fixture.repo,
                &[
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "commit.gpgSign=false",
                    "commit",
                    "-m",
                    "Initial",
                ],
            );
            fixture
        }
        fn git(&self, cwd: &Path, args: &[&str]) -> String {
            let output = Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
        }
        async fn service(&self) -> WorktreeService {
            let terminal = Arc::new(TerminalService::new(self.policy.clone()));
            WorktreeService::load(
                Arc::new(GitService::new(terminal, self.policy.clone())),
                &self.state,
            )
            .await
            .unwrap()
        }
        fn request(&self, id: &str) -> CreateWorktree {
            CreateWorktree {
                id: id.into(),
                cwd: Some(self.repo.to_string_lossy().into_owned()),
                branch: "feature/test".into(),
                base_ref: "main".into(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn create_retry_reload_isolate_and_remove_preserves_branch() {
        let fixture = Fixture::new();
        fs::write(fixture.repo.join("tracked.txt"), "source dirty\n").unwrap();
        let service = fixture.service().await;
        let id = Uuid::new_v4().to_string();
        let worktree = service.create(fixture.request(&id)).await.unwrap();
        assert_eq!(worktree.status, WorktreeStatus::Ready);
        assert_eq!(
            fs::read_to_string(Path::new(&worktree.path).join("tracked.txt")).unwrap(),
            "original\n"
        );
        assert_eq!(
            service.create(fixture.request(&id)).await.unwrap().path,
            worktree.path
        );
        assert_eq!(service.list().await.len(), 1);
        let service = fixture.service().await;
        assert_eq!(service.list().await[0].path, worktree.path);
        assert!(fixture.policy.resolve_cwd(Some(&worktree.path)).is_ok());
        let file = Path::new(&worktree.path).join("tracked.txt");
        assert!(fixture
            .policy
            .open_regular_file_beneath(file.to_str().unwrap())
            .is_ok());
        assert!(fixture
            .policy
            .resolve_existing(fixture.state.to_str().unwrap(), PathKind::Directory)
            .is_err());
        assert!(fixture
            .policy
            .parent_for_browsing(Path::new(&worktree.path))
            .is_none());
        for name in ["tracked.txt", "untracked", "ignored"] {
            let path = Path::new(&worktree.path).join(name);
            fs::write(&path, "keep me").unwrap();
            assert!(service
                .remove(&id)
                .await
                .unwrap_err()
                .message
                .contains("files"));
            assert_eq!(fs::read_to_string(&path).unwrap(), "keep me");
            if name == "tracked.txt" {
                fixture.git(Path::new(&worktree.path), &["restore", "tracked.txt"]);
            } else {
                fs::remove_file(path).unwrap();
            }
        }
        fixture.git(&fixture.repo, &["worktree", "lock", &worktree.path]);
        assert!(service.remove(&id).await.is_err());
        fixture.git(&fixture.repo, &["worktree", "unlock", &worktree.path]);
        service.remove(&id).await.unwrap();
        service.remove(&id).await.unwrap();
        assert!(!Path::new(&worktree.path).exists());
        assert!(service.list().await.is_empty());
        assert!(fixture
            .git(&fixture.repo, &["branch", "--list", "feature/test"])
            .contains("feature/test"));
        assert_eq!(
            fs::read_to_string(fixture.repo.join("tracked.txt")).unwrap(),
            "source dirty\n"
        );
        assert!(service.create(fixture.request(&id)).await.is_err());
    }

    #[tokio::test]
    async fn automatic_chat_workspace_retries_and_local_mode_preserve_the_source() {
        let fixture = Fixture::new();
        fixture.git(&fixture.repo, &["branch", "selected"]);
        let service = fixture.service().await;
        let workspace = ChatWorkspace {
            mode: ChatWorkspaceMode::Worktree,
            branch: "selected".into(),
        };
        let cwd = fixture.repo.to_str();
        let path = service
            .prepare_chat("submission-one", cwd, &workspace)
            .await
            .unwrap();
        assert_ne!(Path::new(&path), fixture.repo);
        assert_eq!(
            fixture
                .git(&fixture.repo, &["branch", "--show-current"])
                .trim(),
            "main"
        );
        let service = fixture.service().await;
        assert_eq!(
            service
                .prepare_chat("submission-one", cwd, &workspace)
                .await
                .unwrap(),
            path
        );
        assert_eq!(service.list().await.len(), 1);
        assert_eq!(service.list().await[0].base_ref, "selected");
        let second = service
            .prepare_chat("submission-two", cwd, &workspace)
            .await
            .unwrap();
        assert_ne!(path, second);
        let local = ChatWorkspace {
            mode: ChatWorkspaceMode::Local,
            branch: "selected".into(),
        };
        assert_eq!(
            Path::new(&service.prepare_chat("local", cwd, &local).await.unwrap()),
            fixture.repo.canonicalize().unwrap()
        );
        assert_eq!(
            fixture
                .git(&fixture.repo, &["branch", "--show-current"])
                .trim(),
            "selected"
        );
        assert_eq!(service.list().await.len(), 2);
    }

    #[tokio::test]
    async fn recovers_interrupted_creation_and_rejects_changed_request_and_invalid_refs() {
        let fixture = Fixture::new();
        let service = fixture.service().await;
        let id = Uuid::new_v4().to_string();
        service.create(fixture.request(&id)).await.unwrap();
        let mut records = service.records.lock().await;
        records[0].status = WorktreeStatus::Creating;
        service.save(&records).await.unwrap();
        drop(records);
        // Git may have created the branch before the process died, leaving no checkout yet.
        let checkout = service.path(&id).await.unwrap();
        fixture.git(
            &fixture.repo,
            &["worktree", "remove", checkout.to_str().unwrap()],
        );
        let service = fixture.service().await;
        assert_eq!(
            service.create(fixture.request(&id)).await.unwrap().status,
            WorktreeStatus::Ready
        );
        let mut changed = fixture.request(&id);
        changed.base_ref = "HEAD".into();
        assert!(service
            .create(changed)
            .await
            .unwrap_err()
            .message
            .contains("different parameters"));
        for invalid in ["--detach", "@{-1}", "bad name", ""] {
            let mut request = fixture.request(&Uuid::new_v4().to_string());
            request.branch = invalid.into();
            assert!(service.create(request).await.is_err());
        }
        let mut traversal = fixture.request("../outside");
        traversal.branch = "feature/other".into();
        assert!(service.create(traversal).await.is_err());
        assert_eq!(service.list().await.len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_symlink_replacement_without_deleting_target() {
        let fixture = Fixture::new();
        let service = fixture.service().await;
        let id = Uuid::new_v4().to_string();
        let worktree = service.create(fixture.request(&id)).await.unwrap();
        let moved = fixture.root.join("moved");
        fs::rename(&worktree.path, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &worktree.path).unwrap();
        assert!(service.remove(&id).await.is_err());
        assert!(moved.join("tracked.txt").is_file());
        assert!(fixture.policy.resolve_cwd(Some(&worktree.path)).is_err());
    }
}
