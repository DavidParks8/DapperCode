#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "config_tests.rs"]
pub(crate) mod tests;

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use agent_client_protocol::{Client, ConnectTo, Lines};
use dappercode_bridge_platform::{file_has_multiple_links, tree_mode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio_util::task::AbortOnDropHandle;

const MAX_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 16 * 1024;
const MAX_ENV: usize = 32;
const MAX_ENV_VALUE_BYTES: usize = 16 * 1024;
const MAX_AGENT_ID_LEN: usize = 128;
const MAX_TREE_ENTRIES: usize = 100_000;
const MAX_TREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TREE_PATH_BYTES: usize = 4_096;
const MAX_TREE_RECEIPT_BYTES: usize = 32 * 1024 * 1024;
const HOST_ENV_ALLOWLIST: &[&str] = &["CODEX_PATH", "HOME", "PATH", "XDG_CONFIG_HOME"];
const SAFE_BASELINE_ENV: &[&str] = &["PATH", "HOME", "TMPDIR", "LANG"];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RuntimeManifestError {
    #[error("agent ID is invalid")]
    InvalidAgentId,
    #[error("resolved executable path is invalid")]
    InvalidExecutable,
    #[error("resolved executable is outside an approved root")]
    ExecutableOutsideRoot,
    #[error("executable digest is invalid")]
    InvalidExecutableDigest,
    #[error("executable digest does not match the manifest")]
    ExecutableDigestMismatch,
    #[error("runtime integrity root is invalid")]
    InvalidIntegrityRoot,
    #[error("runtime installation tree digest is invalid")]
    InvalidTreeDigest,
    #[error("runtime installation tree does not match the manifest")]
    TreeDigestMismatch,
    #[error("argument {index} is invalid")]
    InvalidArgument { index: usize },
    #[error("environment entry {name} is invalid")]
    InvalidEnvironment { name: String },
    #[error("environment entry {name} is denied by the agent secret policy")]
    SecretEnvironment { name: String },
    #[error("environment reference {name} is not allowed")]
    DisallowedEnvironmentReference { name: String },
    #[error("environment reference {name} was not supplied")]
    MissingEnvironmentReference { name: String },
    #[error("bridge launch environment entry {name} conflicts with isolated agent configuration")]
    LaunchEnvironmentConflict { name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAgentManifest {
    pub agent_id: String,
    pub executable: PathBuf,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, ResolvedEnvironment>,
    pub resolved_version: String,
    pub provenance: String,
    pub verified_digest: String,
    pub integrity: RuntimeIntegrity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RuntimeIntegrity {
    Executable,
    Tree { root: PathBuf, tree_sha256: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResolvedEnvironment {
    Literal { value: String },
    HostReference { name: String },
}

impl ResolvedAgentManifest {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub fn validate(&self, approved_roots: &[PathBuf]) -> Result<(), RuntimeManifestError> {
        validate_agent_id(&self.agent_id)?;
        validate_text(&self.resolved_version)
            .map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        validate_text(&self.provenance).map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        if !is_sha256_digest(&self.verified_digest) {
            return Err(RuntimeManifestError::InvalidExecutableDigest);
        }
        let executable = self
            .executable
            .canonicalize()
            .map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        if let RuntimeIntegrity::Tree { root, tree_sha256 } = &self.integrity {
            if !is_sha256_digest(tree_sha256) {
                return Err(RuntimeManifestError::InvalidTreeDigest);
            }
            let canonical_root = root
                .canonicalize()
                .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
            if !canonical_root.is_dir()
                || !executable.starts_with(&canonical_root)
                || !approved_roots.iter().any(|approved| {
                    approved
                        .canonicalize()
                        .map(|approved| canonical_root.starts_with(approved))
                        .unwrap_or(false)
                })
            {
                return Err(RuntimeManifestError::InvalidIntegrityRoot);
            }
        }
        if self.argv.len() > MAX_ARGS {
            return Err(RuntimeManifestError::InvalidArgument { index: MAX_ARGS });
        }
        for (index, argument) in self.argv.iter().enumerate() {
            if validate_text(argument).is_err() || argument.len() > MAX_ARG_BYTES {
                return Err(RuntimeManifestError::InvalidArgument { index });
            }
        }
        if self.environment.len() > MAX_ENV {
            return Err(RuntimeManifestError::InvalidEnvironment {
                name: "too many entries".to_string(),
            });
        }
        for (name, value) in &self.environment {
            validate_env_name(name)?;
            validate_non_secret_env_name(name)?;
            match value {
                ResolvedEnvironment::Literal { value } if validate_value(value).is_ok() => {}
                ResolvedEnvironment::Literal { .. } => {
                    return Err(RuntimeManifestError::InvalidEnvironment { name: name.clone() });
                }
                ResolvedEnvironment::HostReference { name: reference }
                    if HOST_ENV_ALLOWLIST.contains(&reference.as_str()) =>
                {
                    validate_non_secret_env_name(reference)?;
                }
                ResolvedEnvironment::HostReference { name: reference } => {
                    return Err(RuntimeManifestError::DisallowedEnvironmentReference {
                        name: reference.clone(),
                    });
                }
            }
        }

        if !executable.is_file() {
            return Err(RuntimeManifestError::InvalidExecutable);
        }
        if !approved_roots.iter().any(|root| {
            root.canonicalize()
                .map(|root| executable.starts_with(root))
                .unwrap_or(false)
        }) {
            return Err(RuntimeManifestError::ExecutableOutsideRoot);
        }
        Ok(())
    }

    /// Builds the isolated agent, appending bridge-supplied launch values to the manifest's own.
    ///
    /// The extra arguments and environment are generated by a verified bridge harness rather than
    /// configured, so they are not part of the manifest and never change its digest.
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub fn acp_agent_with_args(
        &self,
        approved_roots: &[PathBuf],
        host_environment: &BTreeMap<String, String>,
        extra_argv: &[String],
        extra_environment: &BTreeMap<String, String>,
    ) -> Result<IsolatedAcpAgent, RuntimeManifestError> {
        self.validate(approved_roots)?;
        let executable = self
            .executable
            .canonicalize()
            .map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        if executable_sha256(&executable)? != self.verified_digest {
            return Err(RuntimeManifestError::ExecutableDigestMismatch);
        }
        if let RuntimeIntegrity::Tree { root, tree_sha256 } = &self.integrity {
            if installation_tree_sha256(root)? != *tree_sha256 {
                return Err(RuntimeManifestError::TreeDigestMismatch);
            }
        }
        let mut environment = SAFE_BASELINE_ENV
            .iter()
            .filter_map(|name| {
                host_environment
                    .get(*name)
                    .map(|value| ((*name).to_string(), value.clone()))
            })
            .collect::<BTreeMap<_, _>>();
        for (name, value) in &self.environment {
            let value = match value {
                ResolvedEnvironment::Literal { value } => value.clone(),
                ResolvedEnvironment::HostReference { name: reference } => host_environment
                    .get(reference)
                    .cloned()
                    .ok_or_else(|| RuntimeManifestError::MissingEnvironmentReference {
                        name: reference.clone(),
                    })?,
            };
            environment.insert(name.clone(), value);
        }
        if self
            .environment
            .len()
            .saturating_add(extra_environment.len())
            > MAX_ENV
        {
            return Err(RuntimeManifestError::InvalidEnvironment {
                name: "too many bridge launch entries".to_string(),
            });
        }
        for (name, value) in extra_environment {
            validate_env_name(name)?;
            validate_non_secret_env_name(name)?;
            validate_value(value)
                .map_err(|_| RuntimeManifestError::InvalidEnvironment { name: name.clone() })?;
            if environment.contains_key(name) {
                return Err(RuntimeManifestError::LaunchEnvironmentConflict { name: name.clone() });
            }
            environment.insert(name.clone(), value.clone());
        }
        Ok(IsolatedAcpAgent {
            executable,
            argv: self.argv.iter().chain(extra_argv.iter()).cloned().collect(),
            environment,
            #[cfg(test)]
            stdout_poll_count: None,
        })
    }
}

pub struct IsolatedAcpAgent {
    executable: PathBuf,
    argv: Vec<String>,
    environment: BTreeMap<String, String>,
    #[cfg(test)]
    stdout_poll_count: Option<std::sync::Arc<std::sync::atomic::AtomicUsize>>,
}

impl IsolatedAcpAgent {
    fn spawn_process(&self) -> std::io::Result<tokio::process::Child> {
        let mut command = tokio::process::Command::new(&self.executable);
        command
            .args(&self.argv)
            .env_clear()
            .envs(&self.environment)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
    }
}

impl ConnectTo<Client> for IsolatedAcpAgent {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn connect_to(
        self,
        client: impl ConnectTo<agent_client_protocol::Agent>,
    ) -> Result<(), agent_client_protocol::Error> {
        let mut child = self
            .spawn_process()
            .map_err(agent_client_protocol::Error::into_internal_error)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            agent_client_protocol::Error::internal_error().data("failed to open ACP stdin")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            agent_client_protocol::Error::internal_error().data("failed to open ACP stdout")
        })?;
        #[cfg(test)]
        let stdout = tests::DiagnosticReader {
            inner: stdout,
            poll_count: self.stdout_poll_count,
        };
        let incoming = futures_util::stream::try_unfold(
            tokio::io::BufReader::new(stdout).lines(),
            |mut lines| async move {
                let line = lines.next_line().await?;
                Ok::<_, std::io::Error>(line.map(|line| (line, lines)))
            },
        );
        let outgoing = futures_util::sink::unfold(stdin, async move |mut writer, line: String| {
            writer.write_all(line.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            Ok::<_, std::io::Error>(writer)
        });
        let protocol = agent_client_protocol::ConnectTo::<Client>::connect_to(
            Lines::new(outgoing, incoming),
            client,
        );
        futures_util::pin_mut!(protocol);
        let (status_tx, status_rx) = tokio::sync::oneshot::channel();
        let status_task = AbortOnDropHandle::new(tokio::spawn(async move {
            let _ = status_tx.send(child.wait().await);
        }));
        match futures_util::future::select(protocol, status_rx).await {
            futures_util::future::Either::Left((result, _)) => {
                status_task.abort();
                let _ = status_task.await;
                result
            }
            futures_util::future::Either::Right((status, _)) => {
                if let Err(error) = status_task.await {
                    return Err(agent_client_protocol::Error::internal_error()
                        .data(format!("ACP process wait task failed: {error}")));
                }
                match status {
                    Ok(Ok(status)) if status.success() => Ok(()),
                    Ok(Ok(status)) => Err(agent_client_protocol::Error::internal_error()
                        .data(format!("ACP process exited with {status}"))),
                    Ok(Err(error)) => Err(agent_client_protocol::Error::internal_error()
                        .data(format!("failed to wait for ACP process: {error}"))),
                    Err(error) => Err(agent_client_protocol::Error::internal_error().data(
                        format!("ACP process wait task ended without status: {error}"),
                    )),
                }
            }
        }
    }
}

fn validate_non_secret_env_name(name: &str) -> Result<(), RuntimeManifestError> {
    let upper = name.to_ascii_uppercase();
    let sensitive_segment = upper.split('_').any(|segment| {
        matches!(
            segment,
            "TOKEN"
                | "TOKENS"
                | "KEY"
                | "KEYS"
                | "SECRET"
                | "SECRETS"
                | "PASSWORD"
                | "PASSWORDS"
                | "PASSWD",
        )
    });
    let denied =
        matches!(upper.as_str(), "BRIDGE_AUTH_TOKEN" | "EXPO_ACCESS_TOKEN") || sensitive_segment;
    if denied {
        return Err(RuntimeManifestError::SecretEnvironment {
            name: name.to_string(),
        });
    }
    Ok(())
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn executable_sha256(path: &Path) -> Result<String, RuntimeManifestError> {
    let mut file = File::open(path).map_err(|_| RuntimeManifestError::InvalidExecutable)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let bytes = file
            .read(&mut buffer)
            .map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        if bytes == 0 {
            break;
        }
        digest.update(&buffer[..bytes]);
    }
    Ok(format!("sha256:{}", hex::encode(digest.finalize())))
}

enum TreeEntry {
    Directory {
        path: String,
        mode: String,
    },
    File {
        path: String,
        mode: String,
        size: u64,
        sha256: String,
    },
    Symlink {
        path: String,
        target: String,
    },
}

impl TreeEntry {
    fn path(&self) -> &str {
        match self {
            Self::Directory { path, .. } | Self::File { path, .. } | Self::Symlink { path, .. } => {
                path
            }
        }
    }

    fn write_canonical(&self, output: &mut Vec<u8>) -> Result<(), RuntimeManifestError> {
        let quote = |value: &str| {
            serde_json::to_string(value).map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)
        };
        let line = match self {
            Self::Directory { path, mode } => format!(
                "{{\"path\":{},\"type\":\"directory\",\"mode\":{}}}\n",
                quote(path)?,
                quote(mode)?,
            ),
            Self::File {
                path,
                mode,
                size,
                sha256,
            } => format!(
                "{{\"path\":{},\"type\":\"file\",\"mode\":{},\"size\":{size},\"sha256\":{}}}\n",
                quote(path)?,
                quote(mode)?,
                quote(sha256)?,
            ),
            Self::Symlink { path, target } => format!(
                "{{\"path\":{},\"type\":\"symlink\",\"target\":{}}}\n",
                quote(path)?,
                quote(target)?,
            ),
        };
        output.extend_from_slice(line.as_bytes());
        Ok(())
    }
}

fn normalized_tree_path(root: &Path, candidate: &Path) -> Result<String, RuntimeManifestError> {
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
    let value = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => value
                .to_str()
                .ok_or(RuntimeManifestError::InvalidIntegrityRoot),
            _ => Err(RuntimeManifestError::InvalidIntegrityRoot),
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    if value.is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || value.len() > MAX_TREE_PATH_BYTES
    {
        return Err(RuntimeManifestError::InvalidIntegrityRoot);
    }
    Ok(value)
}

fn normalize_contained_path(
    root: &Path,
    candidate: &Path,
) -> Result<PathBuf, RuntimeManifestError> {
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::Normal(value) => normalized.push(value),
            std::path::Component::ParentDir => {
                if !normalized.pop() || !normalized.starts_with(root) {
                    return Err(RuntimeManifestError::InvalidIntegrityRoot);
                }
            }
        }
    }
    if !normalized.starts_with(root) {
        return Err(RuntimeManifestError::InvalidIntegrityRoot);
    }
    Ok(normalized)
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn collect_tree_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<TreeEntry>,
    total_bytes: &mut u64,
) -> Result<(), RuntimeManifestError> {
    let mut children = fs::read_dir(directory)
        .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
    children.sort_by(|left, right| {
        left.file_name()
            .as_encoded_bytes()
            .cmp(right.file_name().as_encoded_bytes())
    });
    for child in children {
        let path = child.path();
        let relative = normalized_tree_path(root, &path)?;
        if relative == ".dappercode-install.json" {
            continue;
        }
        if entries.len() >= MAX_TREE_ENTRIES {
            return Err(RuntimeManifestError::InvalidIntegrityRoot);
        }
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
        if metadata.is_dir() {
            entries.push(TreeEntry::Directory {
                path: relative,
                mode: tree_mode(&metadata),
            });
            collect_tree_entries(root, &path, entries, total_bytes)?;
        } else if metadata.file_type().is_symlink() {
            let raw_target =
                fs::read_link(&path).map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
            if raw_target.is_absolute() {
                return Err(RuntimeManifestError::InvalidIntegrityRoot);
            }
            let target_path =
                normalize_contained_path(root, &path.parent().unwrap_or(root).join(raw_target))?;
            let target = normalized_tree_path(root, &target_path)?;
            let canonical_target = path
                .canonicalize()
                .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
            if !canonical_target.starts_with(root) {
                return Err(RuntimeManifestError::InvalidIntegrityRoot);
            }
            entries.push(TreeEntry::Symlink {
                path: relative,
                target,
            });
        } else if metadata.is_file() {
            if file_has_multiple_links(&path, &metadata)
                .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?
            {
                return Err(RuntimeManifestError::InvalidIntegrityRoot);
            }
            *total_bytes = total_bytes
                .checked_add(metadata.len())
                .filter(|total| *total <= MAX_TREE_BYTES)
                .ok_or(RuntimeManifestError::InvalidIntegrityRoot)?;
            entries.push(TreeEntry::File {
                path: relative,
                mode: tree_mode(&metadata),
                size: metadata.len(),
                sha256: executable_sha256(&path)?[7..].to_string(),
            });
        } else {
            return Err(RuntimeManifestError::InvalidIntegrityRoot);
        }
    }
    Ok(())
}

fn installation_tree_sha256(root: &Path) -> Result<String, RuntimeManifestError> {
    let canonical_root = root
        .canonicalize()
        .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
    if !canonical_root.is_dir() {
        return Err(RuntimeManifestError::InvalidIntegrityRoot);
    }
    let mut entries = Vec::new();
    let mut total_bytes = 0;
    collect_tree_entries(
        &canonical_root,
        &canonical_root,
        &mut entries,
        &mut total_bytes,
    )?;
    entries.sort_by(|left, right| left.path().as_bytes().cmp(right.path().as_bytes()));
    let mut receipt = Vec::new();
    for entry in entries {
        entry.write_canonical(&mut receipt)?;
        if receipt.len() > MAX_TREE_RECEIPT_BYTES {
            return Err(RuntimeManifestError::InvalidIntegrityRoot);
        }
    }
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(receipt))))
}

fn validate_agent_id(agent_id: &str) -> Result<(), RuntimeManifestError> {
    if matches!(agent_id, "." | "..")
        || agent_id.is_empty()
        || agent_id.len() > MAX_AGENT_ID_LEN
        || !agent_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(RuntimeManifestError::InvalidAgentId);
    }
    Ok(())
}

fn validate_text(value: &str) -> Result<(), ()> {
    if value.is_empty() || value.contains('\0') {
        return Err(());
    }
    Ok(())
}

fn validate_value(value: &str) -> Result<(), ()> {
    if value.len() > MAX_ENV_VALUE_BYTES {
        return Err(());
    }
    validate_text(value)
}

fn validate_env_name(name: &str) -> Result<(), RuntimeManifestError> {
    if name.is_empty()
        || !name.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
        })
    {
        return Err(RuntimeManifestError::InvalidEnvironment {
            name: name.to_string(),
        });
    }
    Ok(())
}
