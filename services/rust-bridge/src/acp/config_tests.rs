#[cfg(unix)]
use super::IsolatedAcpAgent;
use super::{
    executable_sha256, installation_tree_sha256, normalize_contained_path, normalized_tree_path,
    BTreeMap, Path, PathBuf, ResolvedAgentManifest, ResolvedEnvironment, RuntimeIntegrity,
    RuntimeManifestError, Sha256, TreeEntry, MAX_AGENT_ID_LEN, MAX_ARGS, MAX_ARG_BYTES, MAX_ENV,
    MAX_ENV_VALUE_BYTES, MAX_TREE_BYTES, MAX_TREE_PATH_BYTES,
};
use sha2::Digest;

pub(super) struct DiagnosticReader<Reader> {
    pub(super) inner: Reader,
    pub(super) poll_count: Option<std::sync::Arc<std::sync::atomic::AtomicUsize>>,
}

impl<Reader: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for DiagnosticReader<Reader> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if let Some(poll_count) = &self.poll_count {
            poll_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        std::pin::Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}

pub(crate) fn test_executable_root(executable: &Path) -> PathBuf {
    executable
        .canonicalize()
        .expect("resolve test executable")
        .parent()
        .expect("test executable parent")
        .to_path_buf()
}

use serde::Deserialize;
#[cfg(unix)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use std::sync::Arc;

static TEST_TREE_ID: AtomicU64 = AtomicU64::new(0);

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unrelated_child_exits_do_not_poll_idle_acp_stdout() {
    use crate::acp::runtime::AcpConnection;

    const IDLE_AGENT: &str = r#"
IFS= read -r request || exit 1
id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":"([^"]+)".*/\1/')
printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentCapabilities":{}}}\n' "$id"
while IFS= read -r _; do :; done
"#;

    let poll_count = Arc::new(AtomicUsize::new(0));
    let agent = IsolatedAcpAgent {
        executable: PathBuf::from("/bin/sh"),
        argv: vec!["-c".to_string(), IDLE_AGENT.to_string()],
        environment: BTreeMap::new(),
        stdout_poll_count: Some(Arc::clone(&poll_count)),
    };

    let (connection, _) = AcpConnection::start_transport(
        "idle-agent".to_string(),
        agent,
        std::time::Duration::from_secs(2),
    )
    .await
    .expect("idle ACP agent starts");
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    poll_count.store(0, Ordering::Relaxed);
    tokio::task::spawn_blocking(|| {
        for _ in 0..32 {
            assert!(std::process::Command::new("/usr/bin/true")
                .status()
                .expect("spawn unrelated child")
                .success());
        }
    })
    .await
    .expect("unrelated child task");
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    let idle_polls = poll_count.load(Ordering::Relaxed);
    connection.shutdown().await.expect("idle ACP agent stops");

    assert_eq!(
        idle_polls, 0,
        "unrelated child exits polled idle ACP stdout",
    );
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_delivers_pending_permission_response_to_the_agent_process() {
    use crate::acp::runtime::AcpConnection;
    use agent_client_protocol::v1::schema::{
        NewSessionRequest, PermissionOption, PermissionOptionKind, PromptRequest,
        RequestPermissionRequest, ToolCallUpdate, ToolCallUpdateFields,
    };
    use std::time::Duration;

    const AGENT: &str = r#"
IFS= read -r request || exit 1
id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":"([^"]+)".*/\1/')
printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentCapabilities":{}}}\n' "$id"
IFS= read -r request || exit 2
id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":"([^"]+)".*/\1/')
printf '{"jsonrpc":"2.0","id":"%s","result":{"sessionId":"fixture-session"}}\n' "$id"
IFS= read -r request || exit 3
printf '%s\n' "$PERMISSION_REQUEST"
IFS= read -r response || exit 4
printf '%s' "$response" > "$MARKER_PATH"
while [ ! -f "$RELEASE_PATH" ]; do :; done
printf 'processed' > "$COMPLETED_PATH"
while IFS= read -r _; do :; done
"#;

    let directory = tempfile::tempdir().expect("create isolated agent directory");
    let marker = directory.path().join("permission-response.json");
    let release = directory.path().join("release");
    let completed = directory.path().join("processed");
    let request = RequestPermissionRequest::new(
        "fixture-session",
        ToolCallUpdate::new("fixture-tool", ToolCallUpdateFields::new().title("Approve")),
        vec![PermissionOption::new(
            "allow-once",
            "Allow",
            PermissionOptionKind::AllowOnce,
        )],
    );
    let agent = IsolatedAcpAgent {
        executable: PathBuf::from("/bin/sh"),
        argv: vec!["-c".to_string(), AGENT.to_string()],
        environment: BTreeMap::from([
            (
                "PERMISSION_REQUEST".to_string(),
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": "fixture-permission",
                    "method": "session/request_permission",
                    "params": request,
                })
                .to_string(),
            ),
            (
                "MARKER_PATH".to_string(),
                marker.to_str().expect("UTF-8 marker path").to_string(),
            ),
            (
                "RELEASE_PATH".to_string(),
                release.to_str().expect("UTF-8 release path").to_string(),
            ),
            (
                "COMPLETED_PATH".to_string(),
                completed
                    .to_str()
                    .expect("UTF-8 completion path")
                    .to_string(),
            ),
        ]),
        stdout_poll_count: None,
    };
    let (connection, _) =
        AcpConnection::start_transport("fixture".to_string(), agent, Duration::from_secs(2))
            .await
            .expect("agent starts");
    let session = connection
        .new_session(NewSessionRequest::new("/tmp"))
        .await
        .expect("session starts");
    connection
        .prompt(
            PromptRequest::new(session.session_id, vec!["test".into()]),
            "run".to_string(),
            "turn".to_string(),
        )
        .await
        .expect("prompt is admitted");
    tokio::time::timeout(Duration::from_secs(2), async {
        while connection.pending_permissions().await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("permission request arrives");
    let stopping = tokio::spawn(async move { connection.shutdown().await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !marker.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("agent received response before shutdown");
    assert!(!stopping.is_finished(), "shutdown must wait for the agent");
    std::fs::write(release, b"release").expect("release agent");
    stopping.await.expect("shutdown task").expect("agent stops");
    assert!(completed.exists(), "agent processed the response");
    let response: serde_json::Value =
        serde_json::from_slice(&std::fs::read(marker).expect("agent received response"))
            .expect("valid response");
    assert_eq!(response["id"], "fixture-permission");
    assert_eq!(response["result"]["outcome"]["outcome"], "cancelled");
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_timeout_does_not_leave_the_agent_process_running() {
    use crate::acp::runtime::AcpConnection;
    use std::time::Duration;

    const AGENT: &str = r#"
printf '%s' "$$" > "$PID_PATH"
IFS= read -r request || exit 1
id=$(printf '%s\n' "$request" | /usr/bin/sed -E 's/.*"id":"([^"]+)".*/\1/')
printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentCapabilities":{}}}\n' "$id"
while IFS= read -r _; do :; done
exec /bin/sleep 5
"#;

    let directory = tempfile::tempdir().expect("create isolated agent directory");
    let pid_path = directory.path().join("pid");
    let agent = IsolatedAcpAgent {
        executable: PathBuf::from("/bin/sh"),
        argv: vec!["-c".to_string(), AGENT.to_string()],
        environment: BTreeMap::from([(
            "PID_PATH".to_string(),
            pid_path.to_str().expect("UTF-8 PID path").to_string(),
        )]),
        stdout_poll_count: None,
    };
    let (connection, _) =
        AcpConnection::start_transport("fixture".to_string(), agent, Duration::from_secs(2))
            .await
            .expect("agent starts");
    let pid: u32 = std::fs::read_to_string(pid_path)
        .expect("agent records PID")
        .parse()
        .expect("valid PID");
    let error = connection
        .shutdown()
        .await
        .expect_err("shutdown must time out");
    assert!(error.to_string().contains("ACP transport drain timed out"));
    let stopped = tokio::time::timeout(Duration::from_millis(500), async {
        while dappercode_bridge_platform::process_is_alive(pid) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    if !stopped {
        tokio::time::timeout(Duration::from_secs(3), async {
            while dappercode_bridge_platform::process_is_alive(pid) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fixture exits naturally");
    }
    assert!(stopped, "shutdown left the agent process running");
}

#[test]
fn bridge_does_not_directly_depend_on_async_process() {
    assert!(
        !include_str!("../../Cargo.toml")
            .lines()
            .map(str::trim_start)
            .any(|line| line.starts_with("async-process =")),
        "async-process wakes idle ACP transports in optimized bridge builds",
    );
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum FixtureTreeEntry {
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

impl From<FixtureTreeEntry> for TreeEntry {
    fn from(value: FixtureTreeEntry) -> Self {
        match value {
            FixtureTreeEntry::Directory { path, mode } => Self::Directory { path, mode },
            FixtureTreeEntry::File {
                path,
                mode,
                size,
                sha256,
            } => Self::File {
                path,
                mode,
                size,
                sha256,
            },
            FixtureTreeEntry::Symlink { path, target } => Self::Symlink { path, target },
        }
    }
}

#[derive(Deserialize)]
struct TreeFixture {
    algorithm: String,
    exclusions: Vec<String>,
    entries: Vec<FixtureTreeEntry>,
    receipt: String,
    sha256: String,
}

fn echo_digest() -> String {
    executable_sha256(&PathBuf::from("/bin/echo")).expect("hash /bin/echo")
}

fn manifest() -> ResolvedAgentManifest {
    ResolvedAgentManifest {
        agent_id: "test-agent".to_string(),
        executable: PathBuf::from("/bin/echo"),
        argv: vec![],
        environment: BTreeMap::new(),
        resolved_version: "1.0.0".to_string(),
        provenance: "local test".to_string(),
        verified_digest: echo_digest(),
        integrity: RuntimeIntegrity::Executable,
    }
}

fn test_tree(name: &str) -> PathBuf {
    let id = TEST_TREE_ID.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("dappercode-{name}-{}-{id}", std::process::id()));
    std::fs::create_dir_all(&root).expect("create test tree");
    root
}

fn tree_manifest(root: &Path, executable: &Path) -> ResolvedAgentManifest {
    let mut candidate = manifest();
    candidate.executable = executable.to_path_buf();
    candidate.verified_digest = executable_sha256(executable).expect("hash executable");
    candidate.integrity = RuntimeIntegrity::Tree {
        root: root.to_path_buf(),
        tree_sha256: installation_tree_sha256(root).expect("hash installation tree"),
    };
    candidate
}

#[test]
fn manifest_rejects_disallowed_environment_reference() {
    let mut manifest = manifest();
    let roots = [test_executable_root(&manifest.executable)];
    manifest.environment = BTreeMap::from([(
        "SAFE_NAME".to_string(),
        ResolvedEnvironment::HostReference {
            name: "AWS_SECRET_ACCESS_KEY".to_string(),
        },
    )]);
    assert!(matches!(
        manifest.validate(&roots),
        Err(RuntimeManifestError::DisallowedEnvironmentReference { .. })
    ));
}

#[test]
fn manifest_rejects_secret_shaped_literal_and_reference_names() {
    let roots = [test_executable_root(&manifest().executable)];
    for name in [
        "BRIDGE_AUTH_TOKEN",
        "EXPO_ACCESS_TOKEN",
        "GITHUB_TOKEN",
        "SERVICE_SECRET",
        "DATABASE_PASSWORD",
        "SERVICE_API_KEY",
        "SIGNING_KEY",
        "TOKEN_VALUE",
    ] {
        let mut candidate = manifest();
        candidate.environment.insert(
            name.to_string(),
            ResolvedEnvironment::Literal {
                value: "not-a-real-secret".to_string(),
            },
        );
        assert!(matches!(
            candidate.validate(&roots),
            Err(RuntimeManifestError::SecretEnvironment { name: denied }) if denied == name
        ));
    }

    let mut candidate = manifest();
    candidate.environment.insert(
        "SAFE_NAME".to_string(),
        ResolvedEnvironment::HostReference {
            name: "BRIDGE_AUTH_TOKEN".to_string(),
        },
    );
    assert!(matches!(
        candidate.validate(&roots),
        Err(RuntimeManifestError::DisallowedEnvironmentReference { .. })
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn isolated_agent_process_receives_only_approved_launch_environment() {
    use tokio::io::AsyncReadExt;

    let root = test_tree("isolated-environment");
    let executable = root.join("report-environment.sh");
    std::fs::write(&executable, b"#!/bin/sh\nenv | LC_ALL=C sort\n")
        .expect("write environment fixture");
    std::fs::set_permissions(
        &executable,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .expect("make fixture executable");
    let mut candidate = tree_manifest(&root, &executable);
    candidate.environment.insert(
        "AGENT_MODE".to_string(),
        ResolvedEnvironment::Literal {
            value: "fixture".to_string(),
        },
    );
    let host_environment = BTreeMap::from([
        ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ("HOME".to_string(), "/tmp/fixture-home".to_string()),
        ("TMPDIR".to_string(), "/tmp/fixture-tmp".to_string()),
        ("LANG".to_string(), "C".to_string()),
        ("BRIDGE_AUTH_TOKEN".to_string(), "bridge-secret".to_string()),
        ("EXPO_ACCESS_TOKEN".to_string(), "expo-secret".to_string()),
    ]);
    let excessive_harness_environment = (0..MAX_ENV)
        .map(|index| (format!("HARNESS_{index}"), "value".to_string()))
        .collect();
    assert!(matches!(
        candidate.acp_agent_with_args(
            std::slice::from_ref(&root),
            &host_environment,
            &[],
            &excessive_harness_environment,
        ),
        Err(RuntimeManifestError::InvalidEnvironment { name })
            if name == "too many bridge launch entries"
    ));
    assert!(matches!(
        candidate.acp_agent_with_args(
            std::slice::from_ref(&root),
            &host_environment,
            &[],
            &BTreeMap::from([("PATH".to_string(), "/unsafe".to_string())]),
        ),
        Err(RuntimeManifestError::LaunchEnvironmentConflict { name }) if name == "PATH"
    ));
    let agent = candidate
        .acp_agent_with_args(
            std::slice::from_ref(&root),
            &host_environment,
            &[],
            &BTreeMap::from([("HARNESS_MODE".to_string(), "background".to_string())]),
        )
        .expect("build isolated agent");
    let mut child = agent.spawn_process().expect("spawn environment fixture");
    drop(child.stdin.take());
    let mut output = String::new();
    child
        .stdout
        .take()
        .expect("fixture stdout")
        .read_to_string(&mut output)
        .await
        .expect("read fixture environment");
    assert!(child.wait().await.expect("wait for fixture").success());
    assert!(output.contains("AGENT_MODE=fixture\n"));
    assert!(output.contains("HOME=/tmp/fixture-home\n"));
    assert!(output.contains("HARNESS_MODE=background\n"));
    assert!(output.contains("LANG=C\n"));
    assert!(output.contains("PATH=/usr/bin:/bin\n"));
    assert!(output.contains("TMPDIR=/tmp/fixture-tmp\n"));
    assert!(!output.contains("BRIDGE_AUTH_TOKEN"));
    assert!(!output.contains("EXPO_ACCESS_TOKEN"));
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn manifest_requires_explicit_host_environment_values() {
    let mut manifest = manifest();
    let roots = [test_executable_root(&manifest.executable)];
    manifest.argv = vec!["hello".to_string()];
    manifest.environment = BTreeMap::from([(
        "PATH".to_string(),
        ResolvedEnvironment::HostReference {
            name: "PATH".to_string(),
        },
    )]);
    assert!(matches!(
        manifest.acp_agent_with_args(&roots, &BTreeMap::new(), &[], &BTreeMap::new(),),
        Err(RuntimeManifestError::MissingEnvironmentReference { .. })
    ));
}

#[test]
fn manifest_validates_identity_metadata_arguments_and_environment_limits() {
    let roots = [test_executable_root(&manifest().executable)];
    for agent_id in ["", ".", "..", &"a".repeat(MAX_AGENT_ID_LEN + 1), "bad/id"] {
        let mut candidate = manifest();
        candidate.agent_id = agent_id.to_string();
        assert_eq!(
            candidate.validate(&roots),
            Err(RuntimeManifestError::InvalidAgentId),
        );
    }

    for (version, provenance) in [("", "source"), ("1", ""), ("1\0", "source")] {
        let mut candidate = manifest();
        candidate.resolved_version = version.to_string();
        candidate.provenance = provenance.to_string();
        assert_eq!(
            candidate.validate(&roots),
            Err(RuntimeManifestError::InvalidExecutable),
        );
    }

    let mut too_many_args = manifest();
    too_many_args.argv = vec!["arg".to_string(); MAX_ARGS + 1];
    assert_eq!(
        too_many_args.validate(&roots),
        Err(RuntimeManifestError::InvalidArgument { index: MAX_ARGS }),
    );
    for argument in [
        String::new(),
        "bad\0arg".to_string(),
        "x".repeat(MAX_ARG_BYTES + 1),
    ] {
        let mut candidate = manifest();
        candidate.argv = vec!["ok".to_string(), argument];
        assert_eq!(
            candidate.validate(&roots),
            Err(RuntimeManifestError::InvalidArgument { index: 1 }),
        );
    }

    let mut too_many_environment_entries = manifest();
    too_many_environment_entries.environment = (0..=MAX_ENV)
        .map(|index| {
            (
                format!("VALUE_{index}"),
                ResolvedEnvironment::Literal {
                    value: "ok".to_string(),
                },
            )
        })
        .collect();
    assert!(matches!(
        too_many_environment_entries.validate(&roots),
        Err(RuntimeManifestError::InvalidEnvironment { name }) if name == "too many entries"
    ));

    for name in ["", "1BAD", "BAD-NAME"] {
        let mut candidate = manifest();
        candidate.environment.insert(
            name.to_string(),
            ResolvedEnvironment::Literal {
                value: "ok".to_string(),
            },
        );
        assert!(matches!(
            candidate.validate(&roots),
            Err(RuntimeManifestError::InvalidEnvironment { name: invalid }) if invalid == name
        ));
    }
    for value in [
        String::new(),
        "bad\0value".to_string(),
        "x".repeat(MAX_ENV_VALUE_BYTES + 1),
    ] {
        let mut candidate = manifest();
        candidate.environment.insert(
            "VALUE_1".to_string(),
            ResolvedEnvironment::Literal { value },
        );
        assert!(matches!(
            candidate.validate(&roots),
            Err(RuntimeManifestError::InvalidEnvironment { name }) if name == "VALUE_1"
        ));
    }
}

#[test]
fn manifest_validates_executable_roots_and_builds_typed_agent() {
    let roots = [test_executable_root(&manifest().executable)];
    let mut candidate = manifest();
    candidate.executable = PathBuf::from("/does/not/exist");
    assert_eq!(
        candidate.validate(&roots),
        Err(RuntimeManifestError::InvalidExecutable),
    );

    let mut candidate = manifest();
    candidate.executable = PathBuf::from("/bin");
    assert_eq!(
        candidate.validate(&roots),
        Err(RuntimeManifestError::InvalidExecutable),
    );

    let candidate = manifest();
    assert_eq!(
        candidate.validate(&[PathBuf::from("/tmp")]),
        Err(RuntimeManifestError::ExecutableOutsideRoot),
    );

    let mut candidate = manifest();
    candidate.environment = BTreeMap::from([
        (
            "LITERAL".to_string(),
            ResolvedEnvironment::Literal {
                value: "value".to_string(),
            },
        ),
        (
            "PATH_COPY".to_string(),
            ResolvedEnvironment::HostReference {
                name: "PATH".to_string(),
            },
        ),
    ]);
    assert!(candidate
        .acp_agent_with_args(
            &roots,
            &BTreeMap::from([("PATH".to_string(), "/bin".to_string())]),
            &[],
            &BTreeMap::new(),
        )
        .is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn manifest_launch_and_set_validation_follow_symlinked_executable_roots() {
    use crate::acp::manager::{LocalAgentManifest, LocalAgentManifestSet};

    let root = test_tree("merged-usr-executable");
    let bin = root.join("usr/bin");
    let runtime = root.join("usr/libexec/coreutils");
    std::fs::create_dir_all(&bin).expect("create command directory");
    std::fs::create_dir_all(&runtime).expect("create runtime directory");
    let target = runtime.join("echo");
    std::fs::write(&target, b"#!/bin/sh\nprintf '%s\\n' \"$*\"\n").expect("write executable");
    std::fs::set_permissions(&target, std::os::unix::fs::PermissionsExt::from_mode(0o700))
        .expect("make fixture executable");
    std::os::unix::fs::symlink("../libexec/coreutils/echo", bin.join("echo"))
        .expect("link command to runtime");
    std::os::unix::fs::symlink("usr/bin", root.join("bin")).expect("link merged bin");

    let mut candidate = manifest();
    candidate.executable = root.join("bin/echo");
    candidate.verified_digest =
        executable_sha256(&candidate.executable).expect("hash linked executable");
    candidate.argv = vec!["hello".to_string()];
    candidate.environment.insert(
        "PATH_COPY".to_string(),
        ResolvedEnvironment::HostReference {
            name: "PATH".to_string(),
        },
    );
    assert_eq!(
        candidate.validate(&[root.join("bin")]),
        Err(RuntimeManifestError::ExecutableOutsideRoot),
    );

    let roots = [test_executable_root(&candidate.executable)];
    assert!(matches!(
        candidate.acp_agent_with_args(&roots, &BTreeMap::new(), &[], &BTreeMap::new()),
        Err(RuntimeManifestError::MissingEnvironmentReference { name }) if name == "PATH"
    ));
    let agent = candidate
        .acp_agent_with_args(
            &roots,
            &BTreeMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]),
            &["from-root".to_string()],
            &BTreeMap::new(),
        )
        .expect("build isolated agent using canonical runtime root");
    assert_eq!(roots[0], runtime.canonicalize().unwrap());
    assert_eq!(agent.executable, target.canonicalize().unwrap());
    assert_eq!(agent.argv, ["hello", "from-root"]);
    assert_eq!(agent.environment["PATH_COPY"], "/usr/bin:/bin");
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        agent
            .spawn_process()
            .expect("spawn linked executable")
            .wait_with_output(),
    )
    .await
    .expect("executable exits within deadline")
    .expect("wait for executable");
    assert!(
        output.status.success(),
        "fixture exit status: {}",
        output.status,
    );
    assert_eq!(output.stdout, b"hello from-root\n");

    let enabled = LocalAgentManifest {
        enabled: true,
        display_name: "Test Agent".to_string(),
        icon: None,
        resolved: candidate.clone(),
    };
    let mut disabled = enabled.clone();
    disabled.enabled = false;
    disabled.resolved.agent_id = "disabled".to_string();
    disabled.resolved.executable = root.join("does-not-exist");
    let encoded = serde_json::to_string(&LocalAgentManifestSet {
        preferred_agent_id: candidate.agent_id.clone(),
        agents: vec![enabled, disabled],
    })
    .expect("encode manifest set");
    let parsed = LocalAgentManifestSet::parse(&encoded, &roots)
        .expect("enabled executable is approved; disabled invalid executable is ignored");
    assert_eq!(parsed.agents.len(), 2);
    assert!(parsed.agents[0].enabled);
    assert!(!parsed.agents[1].enabled);
    assert!(LocalAgentManifestSet::parse(&encoded, &[root.join("bin")]).is_err());

    std::fs::write(&target, b"tampered").expect("replace symlink target contents");
    assert!(matches!(
        candidate.acp_agent_with_args(&roots, &BTreeMap::new(), &[], &BTreeMap::new()),
        Err(RuntimeManifestError::ExecutableDigestMismatch)
    ));
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn manifest_rejects_invalid_missing_and_changed_executable_digests() {
    let roots = [test_executable_root(&manifest().executable)];
    let mut invalid = manifest();
    invalid.verified_digest = "sha256:ABC".to_string();
    assert_eq!(
        invalid.validate(&roots),
        Err(RuntimeManifestError::InvalidExecutableDigest),
    );

    let root = std::env::temp_dir().join(format!("dappercode-digest-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("create test root");
    let executable = root.join("agent");
    std::fs::write(&executable, b"original").expect("write executable");
    let mut changed = manifest();
    changed.executable = executable.clone();
    changed.verified_digest = executable_sha256(&executable).expect("hash executable");
    changed
        .validate(std::slice::from_ref(&root))
        .expect("valid before mutation");
    std::fs::write(&executable, b"tampered").expect("tamper executable");
    assert!(matches!(
        changed.acp_agent_with_args(
            std::slice::from_ref(&root),
            &BTreeMap::new(),
            &[],
            &BTreeMap::new(),
        ),
        Err(RuntimeManifestError::ExecutableDigestMismatch)
    ));
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn canonical_tree_encoding_matches_node_fixture() {
    let fixture: TreeFixture = serde_json::from_str(include_str!(
        "../../../../scripts/__tests__/fixtures/tree-receipt-v1.json"
    ))
    .expect("parse shared tree fixture");
    assert_eq!(fixture.algorithm, "dappercode-tree-v1");
    assert_eq!(fixture.exclusions, [".dappercode-install.json"]);
    let mut receipt = Vec::new();
    for entry in fixture.entries.into_iter().map(TreeEntry::from) {
        entry.write_canonical(&mut receipt).expect("encode entry");
    }
    assert_eq!(receipt, fixture.receipt.as_bytes());
    assert_eq!(hex::encode(Sha256::digest(receipt)), fixture.sha256);
}

#[test]
fn tree_is_recomputed_immediately_before_agent_construction() {
    let root = test_tree("tree-runtime");
    let module_root = root.join("node_modules/fixture");
    std::fs::create_dir_all(&module_root).expect("create installation tree");
    let executable = module_root.join("cli.js");
    let dependency = module_root.join("dependency.js");
    std::fs::write(&executable, b"#!/usr/bin/env node\n").expect("write executable");
    std::fs::write(&dependency, b"module.exports = true;\n").expect("write dependency");
    let candidate = tree_manifest(&root, &executable);
    candidate
        .acp_agent_with_args(
            std::slice::from_ref(&root),
            &BTreeMap::new(),
            &[],
            &BTreeMap::new(),
        )
        .expect("valid installation tree");
    std::fs::write(&dependency, b"module.exports = false;\n").expect("tamper dependency");
    assert!(matches!(
        candidate.acp_agent_with_args(
            std::slice::from_ref(&root),
            &BTreeMap::new(),
            &[],
            &BTreeMap::new(),
        ),
        Err(RuntimeManifestError::TreeDigestMismatch)
    ));
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn tree_detects_added_deleted_and_transitive_files() {
    let root = test_tree("tree-mutations");
    let module_root = root.join("node_modules/fixture");
    let transitive_root = root.join("node_modules/transitive");
    std::fs::create_dir_all(&module_root).expect("create module");
    std::fs::create_dir_all(&transitive_root).expect("create transitive module");
    let executable = module_root.join("cli.js");
    let dependency = transitive_root.join("index.js");
    std::fs::write(&executable, b"#!/usr/bin/env node\n").expect("write executable");
    std::fs::write(&dependency, b"module.exports = 1;\n").expect("write dependency");
    let expected = installation_tree_sha256(&root).expect("hash original tree");

    let added = module_root.join("added.js");
    std::fs::write(&added, b"added\n").expect("add file");
    assert_ne!(installation_tree_sha256(&root).unwrap(), expected);
    std::fs::remove_file(&added).expect("remove added file");
    assert_eq!(installation_tree_sha256(&root).unwrap(), expected);

    std::fs::remove_file(&dependency).expect("delete dependency");
    assert_ne!(installation_tree_sha256(&root).unwrap(), expected);
    std::fs::write(&dependency, b"module.exports = 2;\n").expect("tamper dependency");
    assert_ne!(installation_tree_sha256(&root).unwrap(), expected);
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn tree_validates_typed_integrity_fields_and_root_shape() {
    let root = test_tree("tree-manifest");
    let executable = root.join("agent");
    std::fs::write(&executable, b"agent").expect("write executable");
    let mut candidate = tree_manifest(&root, &executable);

    candidate.integrity = RuntimeIntegrity::Tree {
        root: root.clone(),
        tree_sha256: "sha256:not-a-digest".to_string(),
    };
    assert_eq!(
        candidate.validate(std::slice::from_ref(&root)),
        Err(RuntimeManifestError::InvalidTreeDigest),
    );
    candidate.integrity = RuntimeIntegrity::Tree {
        root: root.clone(),
        tree_sha256: format!("invalid{:064x}", 0),
    };
    assert_eq!(
        candidate.validate(std::slice::from_ref(&root)),
        Err(RuntimeManifestError::InvalidTreeDigest),
    );

    candidate = tree_manifest(&root, &executable);
    assert_eq!(
        candidate.validate(&[root.join("missing-approved-root")]),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );

    let file_root = root.join("not-a-directory");
    std::fs::write(&file_root, b"file").expect("write invalid root");
    candidate.integrity = RuntimeIntegrity::Tree {
        root: file_root,
        tree_sha256: format!("sha256:{:064x}", 0),
    };
    assert_eq!(
        candidate.validate(std::slice::from_ref(&root)),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );

    candidate.integrity = RuntimeIntegrity::Tree {
        root: root.join("missing"),
        tree_sha256: format!("sha256:{:064x}", 0),
    };
    assert_eq!(
        candidate.validate(std::slice::from_ref(&root)),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn tree_path_helpers_reject_invalid_and_oversized_paths() {
    let root = PathBuf::from("/approved/root");
    assert_eq!(
        normalized_tree_path(&root, &root),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    assert_eq!(
        normalized_tree_path(&root, Path::new("/other/file")),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    let oversized = root.join("x".repeat(MAX_TREE_PATH_BYTES + 1));
    assert_eq!(
        normalized_tree_path(&root, &oversized),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    for invalid in [root.join("nul\0path"), root.join(r"backslash\path")] {
        assert_eq!(
            normalized_tree_path(&root, &invalid),
            Err(RuntimeManifestError::InvalidIntegrityRoot),
        );
    }
    assert_eq!(
        normalize_contained_path(&root, Path::new("/approved/root/a/../b")).unwrap(),
        PathBuf::from("/approved/root/b"),
    );
    assert_eq!(
        normalize_contained_path(&root, Path::new("/approved/root/../../escape")),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    assert_eq!(
        normalize_contained_path(&root, Path::new("relative/path")),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    assert_eq!(
        normalize_contained_path(&root, Path::new("/../escape")),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
}

#[test]
fn tree_excludes_receipt_and_rejects_file_root() {
    let root = test_tree("tree-receipt");
    let file = root.join("agent");
    std::fs::write(&file, b"agent").expect("write agent");
    let expected = installation_tree_sha256(&root).expect("hash tree");
    std::fs::write(root.join(".dappercode-install.json"), b"changed receipt")
        .expect("write excluded receipt");
    assert_eq!(installation_tree_sha256(&root).unwrap(), expected);
    assert_eq!(
        installation_tree_sha256(&file),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn tree_rejects_total_file_bytes_over_limit() {
    let root = test_tree("tree-byte-limit");
    let oversized = root.join("oversized");
    let file = std::fs::File::create(&oversized).expect("create sparse file");
    file.set_len(MAX_TREE_BYTES + 1)
        .expect("set sparse file length");
    assert_eq!(
        installation_tree_sha256(&root),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[cfg(unix)]
#[test]
fn tree_rejects_escaping_symlink_and_manifest_root_mismatch() {
    use std::os::unix::fs::symlink;

    let root = std::env::temp_dir().join(format!("dappercode-tree-link-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("create tree");
    symlink("../../outside", root.join("escape")).expect("create escaping symlink");
    assert_eq!(
        installation_tree_sha256(&root),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_file(root.join("escape")).expect("remove symlink");
    let executable = root.join("agent");
    std::fs::write(&executable, b"agent").expect("write executable");
    let other = root.join("other");
    std::fs::create_dir(&other).expect("create other root");
    let mut candidate = manifest();
    candidate.executable = executable.clone();
    candidate.verified_digest = executable_sha256(&executable).expect("hash executable");
    candidate.integrity = RuntimeIntegrity::Tree {
        root: other,
        tree_sha256: format!("sha256:{:064x}", 0),
    };
    assert_eq!(
        candidate.validate(std::slice::from_ref(&root)),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[cfg(unix)]
#[test]
fn tree_accepts_contained_symlinks_and_rejects_broken_links() {
    use std::os::unix::fs::symlink;

    let root = test_tree("tree-contained-link");
    let target = root.join("target.js");
    std::fs::write(&target, b"target\n").expect("write target");
    symlink("target.js", root.join("link.js")).expect("create contained symlink");
    assert!(installation_tree_sha256(&root).is_ok());

    std::fs::remove_file(&target).expect("break symlink");
    assert_eq!(
        installation_tree_sha256(&root),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[cfg(unix)]
#[test]
fn tree_rejects_absolute_and_indirect_escaping_symlinks() {
    use std::os::unix::fs::symlink;

    let root = test_tree("tree-link-shapes");
    let outside = root.parent().expect("temporary parent").join(format!(
        "outside-{}",
        TEST_TREE_ID.fetch_add(1, Ordering::Relaxed),
    ));
    std::fs::write(&outside, b"outside").expect("write outside target");

    symlink(&outside, root.join("absolute-link")).expect("create absolute symlink");
    assert_eq!(
        installation_tree_sha256(&root),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_file(root.join("absolute-link")).expect("remove absolute symlink");

    symlink("../outside-indirect", root.join("z-contained-name"))
        .expect("create escaping intermediate symlink");
    std::fs::rename(&outside, root.parent().unwrap().join("outside-indirect"))
        .expect("rename outside target");
    symlink("z-contained-name", root.join("indirect-link")).expect("create indirect symlink");
    assert_eq!(
        installation_tree_sha256(&root),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_dir_all(&root).expect("remove test root");
    std::fs::remove_file(root.parent().unwrap().join("outside-indirect"))
        .expect("remove outside target");
}

#[cfg(unix)]
#[test]
fn tree_hashes_modes_and_rejects_hardlinks_and_special_files() {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let root = test_tree("tree-metadata");
    let file = root.join("agent");
    std::fs::write(&file, b"agent").expect("write file");
    let original = installation_tree_sha256(&root).expect("hash original mode");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
        .expect("make executable");
    assert_ne!(installation_tree_sha256(&root).unwrap(), original);

    let hardlink = root.join("agent-hardlink");
    std::fs::hard_link(&file, &hardlink).expect("create hardlink");
    assert_eq!(
        installation_tree_sha256(&root),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_file(&hardlink).expect("remove hardlink");

    let socket = root.join("socket");
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("create socket");
    assert_eq!(
        installation_tree_sha256(&root),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    drop(listener);
    std::fs::remove_file(&socket).expect("remove socket");

    symlink("agent", root.join("agent-link")).expect("create final symlink");
    assert!(installation_tree_sha256(&root).is_ok());
    std::fs::remove_dir_all(root).expect("remove test root");
}

#[cfg(windows)]
#[test]
fn tree_rejects_windows_hardlinks() {
    let root = test_tree("tree-windows-hardlink");
    let file = root.join("agent.exe");
    std::fs::write(&file, b"agent").expect("write file");
    std::fs::hard_link(&file, root.join("agent-hardlink.exe")).expect("create hardlink");

    assert_eq!(
        installation_tree_sha256(&root),
        Err(RuntimeManifestError::InvalidIntegrityRoot),
    );
    std::fs::remove_dir_all(root).expect("remove test root");
}
