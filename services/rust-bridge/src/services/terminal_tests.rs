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
        "partial\n[output truncated]",
    );
    assert_eq!(finalize_output(Vec::new(), true), "[output truncated]");
    assert_eq!(
        finalize_output(b" complete \n".to_vec(), false),
        " complete",
    );
}

#[tokio::test]
async fn bounded_stream_reads_report_exact_truncation_state() {
    assert_eq!(read_stream_limited(&b""[..], 3).await, (vec![], false));
    assert_eq!(
        read_stream_limited(&b"abc"[..], 3).await,
        (b"abc".to_vec(), false),
    );
    assert_eq!(
        read_stream_limited(&b"abcdef"[..], 3).await,
        (b"abc".to_vec(), true),
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
