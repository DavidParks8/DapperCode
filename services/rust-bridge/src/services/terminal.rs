use std::{collections::HashSet, path::PathBuf, process::Stdio, sync::Arc, time::Duration};

use dappercode_bridge_core::{resource_limits::GIT_COMMAND_MAX_OUTPUT_BYTES, BridgeError};
use dappercode_bridge_path_policy::{PathKind, PathPolicy};
use dappercode_bridge_platform::{
    configure_git_command, git_global_config_path, kill_git_process_group,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Semaphore,
    time::timeout,
};

use crate::GitCommandOutput;

const MAX_CONCURRENT_GIT_COMMANDS: usize = 4;
const OUTPUT_READ_CHUNK_SIZE: usize = 8 * 1024;

fn hardened_git_args(args: &[String]) -> Vec<String> {
    let mut hardened_args = vec![
        "--no-pager".to_string(),
        "-c".to_string(),
        format!("core.hooksPath={}", git_global_config_path()),
        "-c".to_string(),
        "core.fsmonitor=false".to_string(),
        "-c".to_string(),
        "commit.gpgSign=false".to_string(),
        "-c".to_string(),
        "diff.external=".to_string(),
        "-c".to_string(),
        "http.sslVerify=true".to_string(),
        "-c".to_string(),
        "http.proxy=".to_string(),
        "-c".to_string(),
        "https.proxy=".to_string(),
        "-c".to_string(),
        "core.gitProxy=".to_string(),
        "-c".to_string(),
        "protocol.allow=never".to_string(),
        "-c".to_string(),
        "protocol.https.allow=always".to_string(),
        "-c".to_string(),
        "protocol.ext.allow=never".to_string(),
        "-c".to_string(),
        "protocol.file.allow=never".to_string(),
        "-c".to_string(),
        "credential.helper=".to_string(),
        "-c".to_string(),
        "credential.useHttpPath=true".to_string(),
    ];
    hardened_args.extend_from_slice(args);
    hardened_args
}

/// Config keys pinned on every bridge-run Git command.
pub(crate) fn pinned_git_config_keys() -> HashSet<String> {
    let mut keys = HashSet::new();
    let mut arguments = hardened_git_args(&[]).into_iter();
    while let Some(argument) = arguments.next() {
        if argument != "-c" {
            continue;
        }
        let Some(setting) = arguments.next() else {
            break;
        };
        let Some((key, _)) = setting.split_once('=') else {
            continue;
        };
        let key = key.to_ascii_lowercase();
        if key != "credential.helper" {
            keys.insert(key);
        }
    }
    keys
}

#[derive(Clone)]
pub(crate) struct TerminalService {
    path_policy: Arc<PathPolicy>,
    concurrency_limiter: Arc<Semaphore>,
}

impl TerminalService {
    pub(crate) fn new(path_policy: Arc<PathPolicy>) -> Self {
        Self {
            path_policy,
            concurrency_limiter: Arc::new(Semaphore::new(MAX_CONCURRENT_GIT_COMMANDS)),
        }
    }

    pub(crate) async fn execute_git(
        &self,
        args: &[String],
        cwd: PathBuf,
        timeout_ms: Option<u64>,
    ) -> Result<GitCommandOutput, BridgeError> {
        let cwd = self
            .path_policy
            .resolve_existing(cwd.to_string_lossy().as_ref(), PathKind::Directory)?;
        let hardened_args = hardened_git_args(args);
        let _permit = self
            .concurrency_limiter
            .acquire()
            .await
            .map_err(|_| BridgeError::server("git concurrency limiter is closed"))?;
        let timeout_ms = timeout_ms.unwrap_or(30_000).clamp(100, 120_000);

        let mut command = Command::new("git");
        command
            .args(&hardened_args)
            .current_dir(&cwd)
            .env_clear()
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", git_global_config_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_git_command(&mut command);
        for name in ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }

        let mut child = command
            .spawn()
            .map_err(|error| BridgeError::server(&format!("failed to spawn git: {error}")))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::server("failed to capture git stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| BridgeError::server("failed to capture git stderr"))?;
        let stdout_task =
            tokio::spawn(
                async move { read_stream_limited(stdout, GIT_COMMAND_MAX_OUTPUT_BYTES).await },
            );
        let stderr_task =
            tokio::spawn(
                async move { read_stream_limited(stderr, GIT_COMMAND_MAX_OUTPUT_BYTES).await },
            );

        let code = match timeout(Duration::from_millis(timeout_ms), child.wait()).await {
            Ok(Ok(status)) => status.code(),
            Ok(Err(error)) => {
                let _ = child.kill().await;
                return Err(BridgeError::server(&format!(
                    "failed to wait for git: {error}"
                )));
            }
            Err(_) => {
                kill_git_process_group(&child);
                let _ = child.kill().await;
                let _ = child.wait().await;
                None
            }
        };

        let (stdout_bytes, stdout_truncated) = stdout_task.await.unwrap_or_default();
        let (stderr_bytes, stderr_truncated) = stderr_task.await.unwrap_or_default();
        Ok(GitCommandOutput {
            code,
            stdout: finalize_output(stdout_bytes, stdout_truncated),
            stderr: finalize_output(stderr_bytes, stderr_truncated),
        })
    }
}

async fn read_stream_limited<R>(mut reader: R, max_bytes: usize) -> (Vec<u8>, bool)
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; OUTPUT_READ_CHUNK_SIZE];
    let mut truncated = false;
    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        if bytes.len() < max_bytes {
            let remaining = max_bytes - bytes.len();
            let to_take = remaining.min(read);
            bytes.extend_from_slice(&buffer[..to_take]);
            truncated |= to_take < read;
        } else {
            truncated = true;
        }
    }
    (bytes, truncated)
}

fn finalize_output(bytes: Vec<u8>, truncated: bool) -> String {
    let mut output = String::from_utf8_lossy(&bytes).trim_end().to_string();
    if truncated {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str("[output truncated]");
    }
    output
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::{
        finalize_output, hardened_git_args, pinned_git_config_keys, read_stream_limited,
        TerminalService,
    };
    use dappercode_bridge_path_policy::PathPolicy;
    use std::sync::Arc;

    #[test]
    fn hardens_git_without_installing_a_credential_helper() {
        let args = hardened_git_args(&["status".to_string()]);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-c", "credential.helper="]));
        assert_eq!(args.last().map(String::as_str), Some("status"));
        assert!(pinned_git_config_keys().contains("core.hookspath"));
    }

    #[test]
    fn marks_truncated_output() {
        assert_eq!(
            finalize_output(b"partial\n".to_vec(), true),
            "partial\n[output truncated]"
        );
        assert_eq!(finalize_output(Vec::new(), true), "[output truncated]");
        assert_eq!(
            finalize_output(b" complete \n".to_vec(), false),
            " complete"
        );
    }

    #[tokio::test]
    async fn bounded_stream_reads_report_exact_truncation_state() {
        assert_eq!(read_stream_limited(&b""[..], 3).await, (vec![], false));
        assert_eq!(
            read_stream_limited(&b"abc"[..], 3).await,
            (b"abc".to_vec(), false)
        );
        assert_eq!(
            read_stream_limited(&b"abcdef"[..], 3).await,
            (b"abc".to_vec(), true)
        );
    }

    #[tokio::test]
    async fn executes_git_inside_the_allowed_root() {
        let root = std::env::temp_dir().join(format!("dappercode-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).expect("create temp dir");
        let policy = Arc::new(PathPolicy::new(root.clone(), false).expect("policy"));
        let service = TerminalService::new(policy);
        let result = service
            .execute_git(
                &["rev-parse".to_string(), "--is-inside-work-tree".to_string()],
                root.clone(),
                Some(5_000),
            )
            .await
            .expect("git execution");
        assert_ne!(result.code, Some(0));
        std::fs::remove_dir_all(&root).expect("remove temp dir");
    }
}
