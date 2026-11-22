#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use super::terminal::pinned_git_config_keys;
use super::TerminalService;
use crate::{
    normalize_path, GitBranchSummary, GitBranchesResponse, GitCloneResponse, GitCommitResponse,
    GitDiffResponse, GitHistoryCommit, GitHistoryResponse, GitPushResponse, GitStageAllResponse,
    GitStageResponse, GitStatusEntry, GitStatusResponse, GitSwitchResponse, GitUnstageAllResponse,
    GitUnstageResponse,
};
use dappercode_bridge_core::resource_limits::{
    truncate_utf8_bytes, GIT_DIFF_MAX_BYTES, GIT_STATUS_MAX_BYTES, GIT_STATUS_MAX_FILES,
};
use dappercode_bridge_core::BridgeError;
use dappercode_bridge_path_policy::PathPolicy;
use dappercode_bridge_platform::git_global_config_path;
use reqwest::Url;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

type EnvironmentProbe = Arc<dyn Fn(&str) -> bool + Send + Sync>;

#[derive(Clone)]
pub(crate) struct GitService {
    terminal: Arc<TerminalService>,
    path_policy: Arc<PathPolicy>,
    environment_probe: EnvironmentProbe,
}

impl GitService {
    pub(crate) fn new(terminal: Arc<TerminalService>, path_policy: Arc<PathPolicy>) -> Self {
        Self {
            terminal,
            path_policy,
            environment_probe: Arc::new(|name| std::env::var_os(name).is_some()),
        }
    }

    #[cfg(test)]
    fn with_environment_probe(mut self, probe: EnvironmentProbe) -> Self {
        self.environment_probe = probe;
        self
    }

    fn resolve_repo_path(&self, raw_cwd: Option<&str>) -> Result<PathBuf, BridgeError> {
        self.path_policy.resolve_cwd(raw_cwd)
    }

    async fn resolve_and_validate_git_path(
        &self,
        raw_cwd: Option<&str>,
        require_repository: bool,
    ) -> Result<PathBuf, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        self.validate_repository_helpers(&repo_path).await?;
        if require_repository {
            self.run_git_stdout(
                &repo_path,
                &["rev-parse", "--git-dir"],
                "git repository configuration inspection failed",
            )
            .await?;
        }
        Ok(repo_path)
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) async fn get_status(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitStatusResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let output = self
            .run_git_stdout(
                &repo_path,
                &["status", "--short", "--branch", "-uall"],
                "git status failed",
            )
            .await?;

        let lines = output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>();

        let porcelain_entries = self.get_porcelain_status_entries(&repo_path).await?;

        let branch = lines
            .iter()
            .find_map(|line| parse_status_branch(line))
            .unwrap_or_else(|| "unknown".to_string());

        let clean = porcelain_entries.is_empty();
        let total_files = porcelain_entries.len();
        let mut files = porcelain_entries;
        let mut used_bytes = 0usize;
        let mut returned_files = Vec::new();
        for entry in files.drain(..).take(GIT_STATUS_MAX_FILES) {
            let entry_bytes = serde_json::to_vec(&entry)
                .expect("GitStatusEntry serialization must succeed")
                .len();
            if used_bytes.saturating_add(entry_bytes) > GIT_STATUS_MAX_BYTES {
                break;
            }
            used_bytes += entry_bytes;
            returned_files.push(entry);
        }
        let (raw, raw_truncated) = truncate_utf8_bytes(&output, GIT_STATUS_MAX_BYTES);
        let truncated = raw_truncated || returned_files.len() < total_files;
        let returned_file_count = returned_files.len();

        Ok(GitStatusResponse {
            branch,
            clean,
            raw,
            files: returned_files,
            cwd: repo_path.to_string_lossy().to_string(),
            truncated,
            total_files,
            omitted_files: total_files.saturating_sub(returned_file_count),
            max_files: GIT_STATUS_MAX_FILES,
            max_bytes: GIT_STATUS_MAX_BYTES,
        })
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub(crate) async fn get_diff(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitDiffResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let entries = self.get_porcelain_status_entries(&repo_path).await?;
        let total_entries = entries.len();
        let mut sections = Vec::new();
        let mut stopped_early = false;

        for (entry_index, entry) in entries.into_iter().enumerate() {
            if entry.untracked {
                let untracked_patch = self
                    .run_git_diff_command(
                        &repo_path,
                        &[
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            "--no-index",
                            "--",
                            git_global_config_path(),
                            entry.path.as_str(),
                        ],
                        true,
                        "git diff for untracked file failed",
                    )
                    .await?;
                if !untracked_patch.trim().is_empty() {
                    sections.push(untracked_patch);
                }
                if sections.iter().map(String::len).sum::<usize>() >= GIT_DIFF_MAX_BYTES {
                    stopped_early = entry_index + 1 < total_entries;
                    break;
                }
                continue;
            }

            let tracked_patch = self
                .run_git_diff_command(
                    &repo_path,
                    &[
                        "diff",
                        "--no-color",
                        "--no-ext-diff",
                        "--patch",
                        "HEAD",
                        "--",
                        entry.path.as_str(),
                    ],
                    false,
                    "git diff HEAD for file failed",
                )
                .await;
            match tracked_patch {
                Ok(output) => {
                    if !output.trim().is_empty() {
                        sections.push(output);
                    }
                }
                Err(_) => {
                    // Repositories without HEAD (e.g. first commit) need per-file fallback.
                    let staged_patch = self
                        .run_git_diff_command(
                            &repo_path,
                            &[
                                "diff",
                                "--no-color",
                                "--no-ext-diff",
                                "--patch",
                                "--cached",
                                "--",
                                entry.path.as_str(),
                            ],
                            false,
                            "git diff --cached for file failed",
                        )
                        .await?;
                    if !staged_patch.trim().is_empty() {
                        sections.push(staged_patch);
                    }

                    let unstaged_patch = self
                        .run_git_diff_command(
                            &repo_path,
                            &[
                                "diff",
                                "--no-color",
                                "--no-ext-diff",
                                "--patch",
                                "--",
                                entry.path.as_str(),
                            ],
                            false,
                            "git diff for file failed",
                        )
                        .await?;
                    if !unstaged_patch.trim().is_empty() {
                        sections.push(unstaged_patch);
                    }
                }
            }
            if sections.iter().map(String::len).sum::<usize>() >= GIT_DIFF_MAX_BYTES {
                stopped_early = entry_index + 1 < total_entries;
                break;
            }
        }

        let diff_output = sections
            .into_iter()
            .filter(|section| !section.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");

        let measured_bytes = diff_output.len();
        let (diff, text_truncated) = truncate_utf8_bytes(&diff_output, GIT_DIFF_MAX_BYTES);
        let truncated = text_truncated || stopped_early;
        let original_bytes = if stopped_early {
            measured_bytes.max(GIT_DIFF_MAX_BYTES + 1)
        } else {
            measured_bytes
        };
        let returned_bytes = diff.len();
        Ok(GitDiffResponse {
            diff,
            cwd: repo_path.to_string_lossy().to_string(),
            truncated,
            original_bytes,
            returned_bytes,
            max_bytes: GIT_DIFF_MAX_BYTES,
        })
    }

    pub(crate) async fn get_history(
        &self,
        raw_cwd: Option<&str>,
        limit: Option<usize>,
    ) -> Result<GitHistoryResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let history_limit = limit.unwrap_or(12).clamp(1, 30);
        let output = self
            .run_git_stdout(
                &repo_path,
                &[
                    "log",
                    "--first-parent",
                    "--decorate=short",
                    "--date=iso-strict",
                    &format!("--max-count={history_limit}"),
                    "--pretty=format:%H\x1f%h\x1f%an\x1f%aI\x1f%D\x1f%s\x1e",
                    "HEAD",
                ],
                "git log failed",
            )
            .await?;

        Ok(GitHistoryResponse {
            commits: parse_git_history(&output),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn get_branches(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitBranchesResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        self.get_branches_at_path(&repo_path).await
    }

    async fn get_branches_at_path(
        &self,
        repo_path: &Path,
    ) -> Result<GitBranchesResponse, BridgeError> {
        let output = self
            .run_git_stdout(
                repo_path,
                &[
                    "branch",
                    "--all",
                    "--format=%(HEAD)\x1f%(refname)\x1f%(refname:short)",
                ],
                "git branch failed",
            )
            .await?;
        let branches = parse_git_branches(&output);
        let current = branches
            .iter()
            .find(|branch| branch.current)
            .map(|branch| branch.name.clone());

        Ok(GitBranchesResponse {
            branches,
            current,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn switch_branch(
        &self,
        branch: String,
        raw_cwd: Option<&str>,
    ) -> Result<GitSwitchResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let target = normalize_git_branch_target(&branch)?;
        let known_branches = self.get_branches_at_path(&repo_path).await?.branches;
        let switch_target = resolve_switch_target(&target, &known_branches);
        let mut args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "switch".to_string(),
        ];
        if switch_target.track_remote {
            args.push("--track".to_string());
        }
        args.push(switch_target.name);

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitSwitchResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            switched: result.code == Some(0),
            branch: target,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn clone_repo(
        &self,
        repository_url: &str,
        raw_parent_path: Option<&str>,
        directory_name: &str,
    ) -> Result<GitCloneResponse, BridgeError> {
        let parent_path = self
            .resolve_and_validate_git_path(raw_parent_path, false)
            .await?;
        self.validate_credentialed_transport(&parent_path).await?;
        let repository_url = validate_remote_url(repository_url)?;
        let normalized_directory_name = resolve_clone_directory_name(directory_name)?;
        let destination_path = normalize_path(&parent_path.join(&normalized_directory_name));
        if destination_path.exists() {
            return Err(BridgeError::invalid_params(
                "destination path already exists",
            ));
        }

        let args = vec![
            "clone".to_string(),
            "--".to_string(),
            repository_url.clone(),
            normalized_directory_name,
        ];

        let result = self
            .terminal
            .execute_git(&args, parent_path.clone(), None)
            .await?;

        Ok(GitCloneResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            cloned: result.code == Some(0),
            cwd: destination_path.to_string_lossy().to_string(),
            url: repository_url,
        })
    }

    pub(crate) async fn stage_file(
        &self,
        path: &str,
        raw_cwd: Option<&str>,
    ) -> Result<GitStageResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let relative_path = resolve_repo_relative_path(path, &repo_path)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "add".to_string(),
            "--".to_string(),
            relative_path.clone(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitStageResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            staged: result.code == Some(0),
            path: relative_path,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn stage_all(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitStageAllResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "add".to_string(),
            "-A".to_string(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitStageAllResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            staged: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn unstage_file(
        &self,
        path: &str,
        raw_cwd: Option<&str>,
    ) -> Result<GitUnstageResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let relative_path = resolve_repo_relative_path(path, &repo_path)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "reset".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            relative_path.clone(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitUnstageResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            unstaged: result.code == Some(0),
            path: relative_path,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn unstage_all(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitUnstageAllResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "reset".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            ".".to_string(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitUnstageAllResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            unstaged: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn commit(
        &self,
        message: String,
        raw_cwd: Option<&str>,
    ) -> Result<GitCommitResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "commit".to_string(),
            "-m".to_string(),
            message,
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitCommitResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            committed: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn push(&self, raw_cwd: Option<&str>) -> Result<GitPushResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        self.validate_credentialed_transport(&repo_path).await?;
        self.validate_repository_remotes(&repo_path).await?;
        let status_output = self
            .run_git_stdout(
                &repo_path,
                &["status", "--short", "--branch", "--untracked-files=no"],
                "git status failed",
            )
            .await?;
        let has_upstream = parse_status_has_upstream(&status_output);

        let mut args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "push".to_string(),
        ];
        if !has_upstream {
            let Some(remote_name) = self.resolve_default_remote_name(&repo_path).await? else {
                return Ok(GitPushResponse {
                    code: Some(1),
                    stdout: String::new(),
                    stderr: "No git remote configured for publishing this branch.".to_string(),
                    pushed: false,
                    cwd: repo_path.to_string_lossy().to_string(),
                });
            };
            validate_remote_name(&remote_name)?;
            args.push("--set-upstream".to_string());
            args.push("--".to_string());
            args.push(remote_name);
            args.push("HEAD".to_string());
        }

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitPushResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            pushed: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    async fn get_porcelain_status_entries(
        &self,
        repo_path: &Path,
    ) -> Result<Vec<GitStatusEntry>, BridgeError> {
        let output = self
            .run_git_stdout(
                repo_path,
                &["status", "--porcelain=v1", "--branch", "-uall", "-z"],
                "git status --porcelain failed",
            )
            .await?;

        parse_porcelain_status_entries(&output)
    }

    async fn run_git_diff_command(
        &self,
        repo_path: &Path,
        command: &[&str],
        allow_exit_code_one: bool,
        fallback_message: &str,
    ) -> Result<String, BridgeError> {
        let mut args = vec!["-C".to_string(), repo_path.to_string_lossy().to_string()];
        args.extend(command.iter().map(|segment| (*segment).to_string()));

        let result = self
            .terminal
            .execute_git(&args, repo_path.to_path_buf(), None)
            .await?;

        let code = result.code.unwrap_or(-1);
        let is_allowed = code == 0 || (allow_exit_code_one && code == 1);
        if !is_allowed {
            return Err(BridgeError::server(git_failure_message(
                &result.stderr,
                &result.stdout,
                fallback_message,
            )));
        }

        Ok(result.stdout)
    }

    async fn run_git_stdout(
        &self,
        repo_path: &Path,
        command: &[&str],
        fallback_message: &str,
    ) -> Result<String, BridgeError> {
        self.run_git_diff_command(repo_path, command, false, fallback_message)
            .await
    }

    async fn resolve_default_remote_name(
        &self,
        repo_path: &Path,
    ) -> Result<Option<String>, BridgeError> {
        let output = self
            .run_git_stdout(repo_path, &["remote"], "git remote failed")
            .await?;
        Ok(select_default_remote_name(&output))
    }

    async fn validate_repository_remotes(&self, repo_path: &Path) -> Result<(), BridgeError> {
        let remote_names = self
            .run_git_stdout(repo_path, &["remote"], "git remote inspection failed")
            .await?;
        for name in remote_names
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            validate_remote_name(name)?;
            let remotes = self
                .run_git_stdout(
                    repo_path,
                    &["remote", "get-url", "--all", "--push", name],
                    "git remote inspection failed",
                )
                .await?;
            for remote in remotes
                .lines()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                validate_remote_url(remote)?;
            }
        }

        Ok(())
    }

    /// Rejects repository configuration that could make a bridge-run `git` command execute
    /// something the operator never approved.
    ///
    /// Only the repository's own config (and its includes) is inspected, because
    /// [`TerminalService`] runs every command with `GIT_CONFIG_NOSYSTEM=1` and
    /// `GIT_CONFIG_GLOBAL=/dev/null`. The operator's system and global config is inert, so
    /// validating it would reject ordinary machines - credential helpers and `!shell` aliases in
    /// `~/.gitconfig` are the norm - without removing any capability from a hostile repository.
    async fn validate_repository_helpers(&self, repo_path: &Path) -> Result<(), BridgeError> {
        self.validate_repository_config_source(repo_path).await
    }

    async fn validate_repository_config_source(&self, repo_path: &Path) -> Result<(), BridgeError> {
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "config".to_string(),
            "--includes".to_string(),
            "--show-origin".to_string(),
            "--show-scope".to_string(),
            "--null".to_string(),
            "--list".to_string(),
        ];
        let result = self
            .terminal
            .execute_git(&args, repo_path.to_path_buf(), None)
            .await?;
        match result.code {
            Some(0) => validate_effective_git_config(&result.stdout),
            _ => Err(BridgeError::server(
                "git repository configuration inspection failed",
            )),
        }
    }

    async fn validate_credentialed_transport(&self, repo_path: &Path) -> Result<(), BridgeError> {
        validate_credential_environment_with(|name| (self.environment_probe)(name))?;
        self.validate_transport_config_source(repo_path).await
    }

    async fn validate_transport_config_source(&self, repo_path: &Path) -> Result<(), BridgeError> {
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "config".to_string(),
            "--includes".to_string(),
            "--show-origin".to_string(),
            "--null".to_string(),
            "--get-regexp".to_string(),
            r"^(http\..*|https\..*|remote\..*\.proxy|core\.gitproxy|credential\..*helper|url\..*\.insteadof)$".to_string(),
        ];
        let result = self
            .terminal
            .execute_git(&args, repo_path.to_path_buf(), None)
            .await?;
        match result.code {
            Some(0) => validate_transport_config_output(&result.stdout),
            Some(1) => Ok(()),
            _ => Err(BridgeError::server(
                "git transport configuration inspection failed",
            )),
        }
    }
}

const UNSAFE_GIT_ENVIRONMENT: &[&str] = &[
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_VALUE_0",
    "GIT_HTTP_PROXY_AUTHMETHOD",
    "GIT_PROXY_COMMAND",
    "GIT_SSL_CAINFO",
    "GIT_SSL_CAPATH",
    "GIT_SSL_CERT",
    "GIT_SSL_CIPHER_LIST",
    "GIT_SSL_KEY",
    "GIT_SSL_NO_VERIFY",
    "CURL_CA_BUNDLE",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "ALL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "all_proxy",
    "https_proxy",
    "http_proxy",
    "no_proxy",
];

fn validate_credential_environment_with(is_set: impl Fn(&str) -> bool) -> Result<(), BridgeError> {
    if UNSAFE_GIT_ENVIRONMENT.iter().any(|name| is_set(name)) {
        return Err(BridgeError::forbidden(
            "unsafe_git_environment",
            "Credentialed Git operations do not permit process-level proxy or TLS overrides.",
        ));
    }
    Ok(())
}

fn validate_transport_config_output(raw: &str) -> Result<(), BridgeError> {
    let pinned = pinned_git_config_keys();
    let mut fields = raw.split('\0').filter(|entry| !entry.is_empty());
    while let Some(origin) = fields.next() {
        let setting = fields.next().ok_or_else(|| {
            BridgeError::server("git transport configuration output was malformed")
        })?;
        if origin.trim() == "command line:" {
            continue;
        }
        let (key, value) = setting
            .split_once('\n')
            .or_else(|| setting.split_once(' '))
            .unwrap_or((setting, ""));
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        let allowed = pinned.contains(&key)
            || (key == "http.sslverify" && value.eq_ignore_ascii_case("true"));
        if !allowed {
            return Err(BridgeError::forbidden(
                "unsafe_git_configuration",
                "Credentialed Git operations reject proxy, TLS, credential-helper, and URL-rewrite overrides.",
            ));
        }
    }
    Ok(())
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn validate_effective_git_config(raw: &str) -> Result<(), BridgeError> {
    let pinned = pinned_git_config_keys();
    let fields = raw.split('\0').collect::<Vec<_>>();
    let records = fields.strip_suffix(&[""]).unwrap_or(&fields);
    if records.len() % 3 != 0 {
        return Err(BridgeError::server(
            "git repository configuration output was malformed",
        ));
    }

    for record in records.chunks_exact(3) {
        let origin = record[1].trim();
        let (key, value) = record[2].split_once('\n').ok_or_else(|| {
            BridgeError::server("git repository configuration output was malformed")
        })?;
        if origin == "command line:" {
            continue;
        }

        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        if pinned.contains(&key) {
            continue;
        }
        let executable = key == "core.hookspath"
            || key == "core.fsmonitor"
            || key == "core.sshcommand"
            || key == "core.editor"
            || key == "sequence.editor"
            || (key.starts_with("credential.") && key.ends_with("helper"))
            || (key.starts_with("filter.")
                && [".clean", ".smudge", ".process"]
                    .iter()
                    .any(|suffix| key.ends_with(suffix)))
            || (key.starts_with("diff.")
                && [".command", ".textconv"]
                    .iter()
                    .any(|suffix| key.ends_with(suffix)))
            || (key.starts_with("merge.") && key.ends_with(".driver"))
            || (key.starts_with("alias.") && value.starts_with('!'));
        let unsafe_transport = (key.starts_with("http.")
            && !(key == "http.sslverify" && value.eq_ignore_ascii_case("true")))
            || key.starts_with("https.")
            || key == "core.gitproxy"
            || key.starts_with("protocol.")
            || (key.starts_with("remote.") && (key.ends_with(".proxy") || key.ends_with(".vcs")))
            || (key.starts_with("url.") && key.ends_with(".insteadof"));
        let unsafe_include = (key == "include.path" || key.starts_with("includeif."))
            && !included_config_was_inspected(origin, value, records);
        if executable || unsafe_transport || unsafe_include {
            return Err(BridgeError::forbidden(
                "unsafe_git_configuration",
                "Git configuration contains executable helpers, unsafe includes, or transport overrides.",
            ));
        }
    }
    Ok(())
}

fn included_config_was_inspected(origin: &str, value: &str, records: &[&str]) -> bool {
    let Some(origin_path) = origin.strip_prefix("file:") else {
        return false;
    };
    let include_path = Path::new(value);
    let resolved = if include_path.is_absolute() {
        include_path.to_path_buf()
    } else {
        Path::new(origin_path)
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(include_path)
    };
    let Ok(canonical) = resolved.canonicalize() else {
        return false;
    };
    records.chunks_exact(3).any(|record| {
        record[1]
            .strip_prefix("file:")
            .map(Path::new)
            .map(Path::canonicalize)
            .and_then(Result::ok)
            .is_some_and(|inspected| inspected == canonical)
    })
}

fn validate_remote_url(raw: &str) -> Result<String, BridgeError> {
    let trimmed = raw.trim();
    let parsed = Url::parse(trimmed)
        .map_err(|_| BridgeError::invalid_params("Git remotes must use an explicit HTTPS URL"))?;
    let invalid_scheme_or_host =
        parsed.scheme() != "https" || parsed.host_str().map(str::is_empty).unwrap_or(true);
    let has_userinfo_or_fragment =
        !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some();
    if invalid_scheme_or_host || has_userinfo_or_fragment {
        return Err(BridgeError::forbidden(
            "unsafe_git_remote",
            "Git remotes must use HTTPS without embedded credentials or fragments.",
        ));
    }
    Ok(trimmed.to_string())
}

fn git_failure_message(stderr: &str, stdout: &str, fallback: &str) -> String {
    if !stderr.is_empty() {
        stderr.to_string()
    } else if !stdout.is_empty() {
        stdout.to_string()
    } else {
        fallback.to_string()
    }
}

fn validate_remote_name(raw: &str) -> Result<(), BridgeError> {
    if raw.is_empty()
        || raw.starts_with('-')
        || !raw
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-' | '/'))
    {
        return Err(BridgeError::forbidden(
            "unsafe_git_remote",
            "Git remote names must not contain option or control syntax.",
        ));
    }
    Ok(())
}

fn parse_porcelain_status_entries(raw: &str) -> Result<Vec<GitStatusEntry>, BridgeError> {
    let tokens = raw
        .split('\0')
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let mut index = 0usize;
    let mut entries = Vec::new();

    while index < tokens.len() {
        let token = tokens[index];
        index += 1;

        if token.starts_with("## ") {
            continue;
        }

        let mut chars = token.chars();
        let index_status = chars.next().unwrap_or(' ');
        let worktree_status = chars.next().unwrap_or(' ');
        let path = token.chars().skip(3).collect::<String>();
        if path.is_empty() {
            continue;
        }

        let mut original_path = None;
        if matches!(index_status, 'R' | 'C') && index < tokens.len() {
            let original = tokens[index].to_string();
            index += 1;
            original_path = Some(original);
        }

        let untracked = index_status == '?' && worktree_status == '?';
        let staged = !matches!(index_status, ' ' | '?');
        let unstaged = untracked || worktree_status != ' ';

        entries.push(GitStatusEntry {
            path,
            original_path,
            index_status: index_status.to_string(),
            worktree_status: worktree_status.to_string(),
            staged,
            unstaged,
            untracked,
        });
    }

    Ok(entries)
}

fn parse_status_has_upstream(raw: &str) -> bool {
    raw.lines()
        .map(str::trim)
        .find(|line| line.starts_with("## "))
        .map(|line| line.contains("..."))
        .unwrap_or(false)
}

fn parse_status_branch(line: &str) -> Option<String> {
    let status = line.strip_prefix("## ")?;
    let branch = status
        .strip_prefix("No commits yet on ")
        .or_else(|| status.strip_prefix("Initial commit on "))
        .unwrap_or(status)
        .split("...")
        .next()
        .expect("split always yields a first segment")
        .trim();
    (!branch.is_empty()).then(|| branch.to_string())
}

fn parse_git_history(raw: &str) -> Vec<GitHistoryCommit> {
    raw.split('\x1e')
        .filter_map(|record| {
            let trimmed = record.trim();
            if trimmed.is_empty() {
                return None;
            }

            let mut parts = trimmed.split('\x1f');
            let hash = parts.next()?.trim().to_string();
            let short_hash = parts.next().unwrap_or_default().trim().to_string();
            let author_name = parts.next().unwrap_or_default().trim().to_string();
            let authored_at = parts.next().unwrap_or_default().trim().to_string();
            let refs_raw = parts.next().unwrap_or_default().trim().to_string();
            let subject = parts.next().unwrap_or_default().trim().to_string();

            if hash.is_empty() || short_hash.is_empty() || subject.is_empty() {
                return None;
            }

            let ref_names = refs_raw
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            let is_head = ref_names
                .iter()
                .any(|entry| entry == "HEAD" || entry.starts_with("HEAD ->"));

            Some(GitHistoryCommit {
                hash,
                short_hash,
                subject,
                author_name,
                authored_at,
                ref_names,
                is_head,
            })
        })
        .collect()
}

fn parse_git_branches(raw: &str) -> Vec<GitBranchSummary> {
    let mut seen = HashSet::new();
    let mut branches = Vec::new();

    for line in raw.lines() {
        let mut parts = line.splitn(3, '\x1f');
        let head_marker = parts.next().unwrap_or_default().trim();
        let full_ref = parts.next().unwrap_or_default().trim();
        let Some(raw_name) = parts.next() else {
            continue;
        };
        let mut name = raw_name.trim().to_string();
        if name.is_empty() || name == "HEAD" || name.contains("HEAD ->") {
            continue;
        }
        if let Some(stripped) = name.strip_prefix("remotes/") {
            name = stripped.to_string();
        }
        let remote = full_ref.starts_with("refs/remotes/");
        if name.ends_with("/HEAD") || !seen.insert(name.clone()) {
            continue;
        }

        branches.push(GitBranchSummary {
            remote,
            current: head_marker == "*",
            name,
        });
    }

    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| left.remote.cmp(&right.remote))
            .then_with(|| left.name.cmp(&right.name))
    });
    branches
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitSwitchTarget {
    name: String,
    track_remote: bool,
}

fn resolve_switch_target(target: &str, branches: &[GitBranchSummary]) -> GitSwitchTarget {
    let local_match = branches
        .iter()
        .filter(|branch| !branch.remote)
        .find(|branch| branch.name == target);
    if let Some(branch) = local_match {
        return GitSwitchTarget {
            name: branch.name.clone(),
            track_remote: false,
        };
    }

    let remote_match = branches.iter().find(|branch| {
        branch.remote
            && (branch.name == target
                || branch_remote_name(&branch.name)
                    .map(|local_name| local_name == target)
                    .unwrap_or(false))
    });

    if let Some(remote_branch) = remote_match {
        if let Some(local_name) = branch_remote_name(&remote_branch.name) {
            if branches
                .iter()
                .any(|branch| !branch.remote && branch.name == local_name)
            {
                return GitSwitchTarget {
                    name: local_name.to_string(),
                    track_remote: false,
                };
            }
        }

        return GitSwitchTarget {
            name: remote_branch.name.clone(),
            track_remote: true,
        };
    }

    GitSwitchTarget {
        name: target.to_string(),
        track_remote: false,
    }
}

fn branch_remote_name(name: &str) -> Option<&str> {
    let (remote, local_name) = name.split_once('/')?;
    if remote.is_empty() || local_name.is_empty() {
        return None;
    }
    Some(local_name)
}

fn normalize_git_branch_target(raw_branch: &str) -> Result<String, BridgeError> {
    let target = raw_branch.trim();
    if target.is_empty() {
        return Err(BridgeError::invalid_params("branch must not be empty"));
    }
    if target.starts_with('-') {
        return Err(BridgeError::invalid_params(
            "branch must not start with a dash",
        ));
    }
    if target.contains('\0') || target.contains('\n') || target.contains('\r') {
        return Err(BridgeError::invalid_params(
            "branch contains invalid characters",
        ));
    }

    Ok(target.to_string())
}

fn select_default_remote_name(raw: &str) -> Option<String> {
    let remotes = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if remotes.is_empty() {
        return None;
    }

    remotes
        .iter()
        .find(|remote| remote.eq_ignore_ascii_case("origin"))
        .copied()
        .or_else(|| remotes.first().copied())
        .map(str::to_string)
}

fn resolve_repo_relative_path(raw_path: &str, repo_path: &Path) -> Result<String, BridgeError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params("path must not be empty"));
    }

    let requested = PathBuf::from(trimmed);
    if requested.is_absolute() {
        return Err(BridgeError::invalid_params(
            "path must be relative to repository",
        ));
    }

    let normalized_repo = normalize_path(repo_path);
    let normalized_target = normalize_path(&repo_path.join(&requested));
    if !normalized_target.starts_with(&normalized_repo) {
        return Err(BridgeError::invalid_params(
            "path must stay within repository root",
        ));
    }

    let relative = normalized_target
        .strip_prefix(&normalized_repo)
        .map_err(|_| BridgeError::invalid_params("path must stay within repository root"))?;
    if relative.as_os_str().is_empty() {
        return Err(BridgeError::invalid_params("path must point to a file"));
    }

    Ok(relative.to_string_lossy().to_string())
}

fn resolve_clone_directory_name(raw_name: &str) -> Result<String, BridgeError> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params(
            "directoryName must not be empty",
        ));
    }

    let requested = PathBuf::from(trimmed);
    if requested.is_absolute() {
        return Err(BridgeError::invalid_params(
            "directoryName must be a folder name, not a path",
        ));
    }

    let mut components = requested.components();
    let component = components
        .next()
        .expect("a non-empty path has at least one component");
    if components.next().is_some() {
        return Err(BridgeError::invalid_params(
            "directoryName must be a single folder name",
        ));
    }
    if !matches!(component, std::path::Component::Normal(_)) {
        return Err(BridgeError::invalid_params(
            "directoryName must be a valid folder name",
        ));
    }

    Ok(trimmed.to_string())
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "git_tests.rs"]
mod tests;
