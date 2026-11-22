use super::{
    included_config_was_inspected, normalize_git_branch_target, parse_git_branches,
    parse_git_history, parse_porcelain_status_entries, parse_status_branch,
    parse_status_has_upstream, resolve_clone_directory_name, resolve_repo_relative_path,
    resolve_switch_target, select_default_remote_name, validate_credential_environment_with,
    validate_effective_git_config, validate_remote_name, validate_remote_url,
    validate_transport_config_output, GitSwitchTarget,
};
use crate::GitBranchSummary;
use dappercode_bridge_core::resource_limits::GIT_STATUS_MAX_FILES;
use dappercode_bridge_path_policy::PathPolicy;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use uuid::Uuid;

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("dappercode-git-{label}-{}", Uuid::new_v4()));
        fs::create_dir(&path).expect("create test directory");
        Self(path)
    }

    fn git(&self, args: &[&str]) -> String {
        let mut command = Command::new("git");
        command.arg("-C").arg(&self.0).args(args);
        for name in super::UNSAFE_GIT_ENVIRONMENT
            .iter()
            .chain(["GIT_CONFIG_PARAMETERS"].iter())
        {
            command.env_remove(name);
        }
        let output = command.output().expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr),
        );
        String::from_utf8(output.stdout).expect("utf-8 git output")
    }

    fn init(&self) {
        self.git(&["init", "-b", "main"]);
        self.git(&["config", "user.email", "tests@example.com"]);
        self.git(&["config", "user.name", "DapperCode Tests"]);
        self.git(&["config", "commit.gpgSign", "false"]);
    }

    fn service(&self) -> super::GitService {
        let policy = Arc::new(PathPolicy::new(self.0.clone(), false).expect("create policy"));
        let terminal = Arc::new(super::TerminalService::new(policy.clone()));
        super::GitService::new(terminal, policy).with_environment_probe(Arc::new(|_| false))
    }

    fn service_with_home(&self, home: &Path) -> super::GitService {
        let policy = Arc::new(PathPolicy::new(self.0.clone(), false).expect("create policy"));
        let terminal =
            Arc::new(super::TerminalService::new(policy.clone()).with_test_home(home.into()));
        super::GitService::new(terminal, policy).with_environment_probe(Arc::new(|_| false))
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A hostile operator global gitconfig must not disable the Git screen.
///
/// Every bridge `git` invocation runs with `GIT_CONFIG_NOSYSTEM=1` and
/// `GIT_CONFIG_GLOBAL=/dev/null`, so `~/.gitconfig` can never execute a helper. Validating it
/// anyway rejected every Git RPC on an ordinary developer machine, because credential helpers
/// and `!shell` aliases in `~/.gitconfig` are the norm, and the screen showed nothing but an
/// `unsafe_git_configuration` error.
#[tokio::test]
async fn operator_global_git_config_does_not_disable_repository_operations() {
    let home = TestDir::new("operator-home");
    fs::write(
        home.0.join(".gitconfig"),
        concat!(
            "[credential \"https://github.com\"]\n",
            "\thelper = !/opt/homebrew/bin/gh auth git-credential\n",
            "[core]\n",
            "\teditor = /usr/bin/hostile-editor\n",
            "\tfsmonitor = true\n",
            "\tsshCommand = /usr/bin/hostile-ssh\n",
            "[alias]\n",
            "\tprune-branches = !f() { echo pruned; }; f\n",
            "[filter \"lfs\"]\n",
            "\tclean = git-lfs clean -- %f\n",
            "[http]\n",
            "\tsslVerify = false\n",
        ),
    )
    .expect("write operator global config");

    let repo = TestDir::new("operator-home-repo");
    repo.init();
    fs::write(repo.0.join("tracked.txt"), "one\n").expect("write tracked file");
    repo.git(&["add", "tracked.txt"]);
    repo.git(&["commit", "-m", "initial"]);
    fs::write(repo.0.join("tracked.txt"), "two\n").expect("update tracked file");
    fs::write(repo.0.join("untracked.txt"), "new\n").expect("write untracked file");

    let service = repo.service_with_home(&home.0);

    let status = service.get_status(None).await.expect("status succeeds");
    assert_eq!(status.branch, "main");
    assert!(!status.clean);
    assert_eq!(status.files.len(), 2);

    let diff = service.get_diff(None).await.expect("diff succeeds");
    assert!(diff.diff.contains("tracked.txt"));
    assert!(diff.diff.contains("untracked.txt"));

    let history = service
        .get_history(None, None)
        .await
        .expect("history succeeds");
    assert_eq!(history.commits.len(), 1);

    let branches = service.get_branches(None).await.expect("branches succeed");
    assert_eq!(branches.current.as_deref(), Some("main"));

    assert!(
        service
            .stage_file("tracked.txt", None)
            .await
            .expect("stage succeeds")
            .staged,
    );
    assert!(
        service
            .unstage_file("tracked.txt", None)
            .await
            .expect("unstage succeeds")
            .unstaged,
    );
    assert!(
        service
            .stage_all(None)
            .await
            .expect("stage all succeeds")
            .staged,
    );
    assert!(
        service
            .commit("chore: checkpoint".to_string(), None)
            .await
            .expect("commit succeeds")
            .committed,
    );
    assert!(
        service
            .unstage_all(None)
            .await
            .expect("unstage all succeeds")
            .unstaged,
    );

    // Repository-owned configuration is still the real threat and still rejected.
    repo.git(&["config", "core.sshCommand", "/tmp/hostile-ssh"]);
    assert_eq!(
        repo.service()
            .get_status(None)
            .await
            .expect_err("reject repository hooks path")
            .data
            .unwrap()["error"],
        "unsafe_git_configuration",
    );
}

#[cfg(unix)]
#[test]
fn git_cwd_policy_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let temp = std::env::temp_dir().join(format!("dappercode-git-path-{}", Uuid::new_v4()));
    let root = temp.join("root");
    let outside = temp.join("outside");
    fs::create_dir_all(&root).expect("create root");
    fs::create_dir_all(&outside).expect("create outside");
    symlink(&outside, root.join("escape")).expect("create escape symlink");
    let policy = Arc::new(PathPolicy::new(root, false).expect("create policy"));
    let terminal = Arc::new(super::TerminalService::new(policy.clone()));
    let git = super::GitService::new(terminal, policy);

    let error = git
        .resolve_repo_path(Some("escape"))
        .expect_err("reject git symlink escape");
    assert_eq!(error.code, -32602);
    let _ = fs::remove_dir_all(temp);
}

#[test]
fn resolves_repo_relative_path_and_rejects_escape() {
    let repo = Path::new("/bridge/root/repo");
    let normalized = resolve_repo_relative_path("src/../src/main.rs", repo)
        .expect("resolve normalized relative path");
    assert_eq!(normalized, "src/main.rs");

    let error = resolve_repo_relative_path("../outside.txt", repo).expect_err("reject escape path");
    assert_eq!(error.code, -32602);
}

#[test]
fn resolves_clone_directory_name_from_single_segment() {
    let resolved = resolve_clone_directory_name("my-repo").expect("resolve single directory name");
    assert_eq!(resolved, "my-repo");
}

#[test]
fn rejects_nested_clone_directory_name() {
    let error = resolve_clone_directory_name("nested/repo")
        .expect_err("reject nested clone directory name");
    assert_eq!(error.code, -32602);
}

#[test]
fn parses_porcelain_entries_for_rename_and_untracked() {
    let raw = "## main...origin/main\0R  new/path.ts\0old/path.ts\0?? fresh/file.ts\0";
    let entries = parse_porcelain_status_entries(raw).expect("parse status entries");
    assert_eq!(entries.len(), 2);

    let renamed = &entries[0];
    assert_eq!(renamed.path, "new/path.ts");
    assert_eq!(renamed.original_path.as_deref(), Some("old/path.ts"));
    assert_eq!(renamed.index_status, "R");
    assert_eq!(renamed.worktree_status, " ");
    assert!(renamed.staged);
    assert!(!renamed.unstaged);
    assert!(!renamed.untracked);

    let untracked = &entries[1];
    assert_eq!(untracked.path, "fresh/file.ts");
    assert_eq!(untracked.index_status, "?");
    assert_eq!(untracked.worktree_status, "?");
    assert!(!untracked.staged);
    assert!(untracked.unstaged);
    assert!(untracked.untracked);
}

#[test]
fn detects_when_branch_has_upstream_tracking() {
    assert!(parse_status_has_upstream(
        "## main...origin/main [ahead 1]\n"
    ));
    assert!(!parse_status_has_upstream("## feature/local-only\n"));
    assert!(!parse_status_has_upstream("not a status header\n"));
    assert!(!parse_status_has_upstream(""));
}

#[test]
fn parses_normal_unborn_and_missing_status_branches() {
    assert_eq!(
        parse_status_branch("## main...origin/main [ahead 1]").as_deref(),
        Some("main"),
    );
    assert_eq!(
        parse_status_branch("## No commits yet on trunk").as_deref(),
        Some("trunk"),
    );
    assert_eq!(
        parse_status_branch("## Initial commit on legacy").as_deref(),
        Some("legacy"),
    );
    assert_eq!(parse_status_branch("## "), None);
    assert_eq!(parse_status_branch(" M file.txt"), None);
}

#[test]
fn prefers_origin_as_default_remote() {
    assert_eq!(
        select_default_remote_name("upstream\norigin\n"),
        Some("origin".to_string()),
    );
    assert_eq!(
        select_default_remote_name("backup\n"),
        Some("backup".to_string()),
    );
    assert_eq!(select_default_remote_name(""), None);
}

#[test]
fn accepts_only_https_remotes_without_credentials() {
    assert_eq!(
        validate_remote_url("https://github.com/example/repo.git").unwrap(),
        "https://github.com/example/repo.git",
    );
    for remote in [
        "",
        "not a url",
        "https://",
        "git@github.com:example/repo.git",
        "ssh://git@github.com/example/repo.git",
        "file:///tmp/repo",
        "ext::sh -c id",
        "https://token@github.com/example/repo.git",
        "https://user:password@github.com/example/repo.git",
        "https://github.com/example/repo.git#branch",
    ] {
        assert!(validate_remote_url(remote).is_err(), "accepted {remote}");
    }
    assert!(validate_remote_url("https://:secret@github.com/example/repo.git").is_err());
    assert_eq!(
        validate_remote_url(" https://github.com/example/repo.git ").unwrap(),
        "https://github.com/example/repo.git",
    );
}

#[test]
fn rejects_option_like_or_control_remote_names() {
    assert!(validate_remote_name("origin").is_ok());
    assert!(validate_remote_name("team/upstream-1").is_ok());
    for name in ["--exec", "bad remote", "bad\nremote", "bad:remote", ""] {
        assert!(validate_remote_name(name).is_err(), "accepted {name:?}");
    }
}

#[test]
fn rejects_unsafe_transport_configuration_entries() {
    assert!(validate_transport_config_output("file:.git/config\0http.sslVerify\ntrue\0").is_ok());
    assert!(validate_transport_config_output(
        "command line:\0credential.helper\n!controlled-helper\0"
    )
    .is_ok());
    let insecure_proxy = format!(
        "file:.git/config\0http.https://example.com.proxy\n{}\0",
        ["http", "://proxy.invalid"].concat(),
    );
    let insecure_rewrite = format!(
        "file:.git/config\0url.{}/.insteadOf\nhttps://example.com/\0",
        ["http", "://example.com"].concat(),
    );
    for entry in [
        "file:.git/config\0http.https://example.com.sslVerify\nfalse\0".to_string(),
        insecure_proxy,
        "file:.git/config\0http.sslCAInfo\n/tmp/ca.pem\0".to_string(),
        "file:.git/config\0remote.origin.proxy\ncommand\0".to_string(),
        "file:.git/config\0credential.helper\n!command\0".to_string(),
        insecure_rewrite,
    ] {
        assert!(
            validate_transport_config_output(&entry).is_err(),
            "accepted {entry:?}",
        );
    }
    assert!(validate_transport_config_output("file:.git/config\0").is_err());
    // Keys the bridge pins on the command line cannot be honored from a file.
    for pinned in [
        "file:.git/config\0http.sslVerify\nfalse\0",
        "file:.git/config\0http.proxy\nhttp://proxy.invalid\0",
        "file:.git/config\0core.gitProxy\ncommand\0",
    ] {
        assert!(
            validate_transport_config_output(pinned).is_ok(),
            "rejected pinned {pinned:?}",
        );
    }
}

#[test]
fn parses_effective_git_configuration_fail_closed() {
    assert!(validate_effective_git_config(
        "local\0file:.git/config\0user.name\nDapperCode Tests\0"
    )
    .is_ok());
    for key_value in [
        "filter.secret.clean\n/tmp/helper",
        "filter.secret.smudge\n/tmp/helper",
        "filter.secret.process\n/tmp/helper",
        "diff.secret.command\n/tmp/helper",
        "diff.secret.textconv\n/tmp/helper",
        "merge.secret.driver\n/tmp/helper %O %A %B",
        "core.editor\n/tmp/helper",
        "core.sshCommand\n/tmp/helper",
        "credential.helper\nosxkeychain",
        "credential.example.helper\nosxkeychain",
        "sequence.editor\n/tmp/helper",
        "alias.deploy\n!/tmp/helper",
        "https.example.proxy\nhttp://proxy.invalid",
        "remote.origin.proxy\nhttp://proxy.invalid",
        "remote.origin.vcs\ncustom",
        "url.ssh://git@example/.insteadof\nhttps://example/",
        "protocol.ftp.allow\nalways",
    ] {
        let raw = format!("local\0file:.git/config\0{key_value}\0");
        assert!(
            validate_effective_git_config(&raw).is_err(),
            "accepted {key_value:?}",
        );
    }
    assert!(validate_effective_git_config("local\0file:.git/config\0user.name\0").is_err());
    assert!(validate_effective_git_config("local\0file:.git/config\0").is_err());
    assert!(
        validate_effective_git_config("local\0file:.git/config\0http.sslVerify\ntrue\0").is_ok(),
    );
    // `core.fsmonitor=true` ships with VS Code and `feature.manyfiles`, and the bridge pins
    // `core.fsmonitor=false` on the command line, so it must never block an operation.
    for pinned in [
        "core.fsmonitor\ntrue",
        "core.fsmonitor\n/tmp/helper",
        "core.hooksPath\n/tmp/hooks",
        "protocol.file.allow\nalways",
    ] {
        let raw = format!("local\0file:.git/config\0{pinned}\0");
        assert!(
            validate_effective_git_config(&raw).is_ok(),
            "rejected pinned {pinned:?}",
        );
    }
}

#[test]
fn included_configuration_requires_a_file_origin_and_an_observed_target() {
    let directory = TestDir::new("included-config-validation");
    let source = directory.0.join("config");
    let included = directory.0.join("included");
    fs::write(&source, b"").unwrap();
    fs::write(&included, b"").unwrap();
    let source_origin = format!("file:{}", source.display());
    let included_origin = format!("file:{}", included.display());
    let records = ["local", included_origin.as_str(), "user.name\nDapperCode"];

    assert!(!included_config_was_inspected(
        "command line:",
        included.to_str().unwrap(),
        &records
    ));
    assert!(!included_config_was_inspected(
        &source_origin,
        "missing",
        &records
    ));
    assert!(included_config_was_inspected(
        &source_origin,
        included.to_str().unwrap(),
        &records
    ));
    assert!(included_config_was_inspected(
        &source_origin,
        "included",
        &records
    ));
}

#[test]
fn rejects_credentialed_git_environment_overrides() {
    assert!(validate_credential_environment_with(|_| false).is_ok());
    for variable in [
        "GIT_SSL_NO_VERIFY",
        "GIT_CONFIG_COUNT",
        "GIT_PROXY_COMMAND",
        "CURL_CA_BUNDLE",
        "HTTPS_PROXY",
        "http_proxy",
    ] {
        assert!(
            validate_credential_environment_with(|name| name == variable).is_err(),
            "accepted {variable}",
        );
    }
    assert!(validate_credential_environment_with(|name| { name == "GIT_CONFIG_SYSTEM" }).is_err());
}

#[test]
fn parses_git_history_records() {
    let raw = concat!(
        "abc123\x1fabc123\x1fDavid\x1f2026-04-05T10:00:00+05:30\x1fHEAD -> feat/test, origin/feat/test\x1fAdd history card\x1e",
        "def456\x1fdef456\x1fDavid\x1f2026-04-04T09:00:00+05:30\x1forigin/main\x1fPrevious commit\x1e",
    );

    let commits = parse_git_history(raw);
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].hash, "abc123");
    assert_eq!(commits[0].subject, "Add history card");
    assert!(commits[0].is_head);
    assert_eq!(
        commits[0].ref_names,
        vec![
            "HEAD -> feat/test".to_string(),
            "origin/feat/test".to_string()
        ],
    );
    assert_eq!(commits[1].subject, "Previous commit");
    assert!(!commits[1].is_head);
    assert!(parse_git_history("\x1e\n\x1e").is_empty());
    assert!(parse_git_history("hash-only\x1e").is_empty());
    assert!(parse_git_history("\x1fshort\x1fauthor\x1fdate\x1frefs\x1fsubject\x1e").is_empty());
    assert!(parse_git_history("hash\x1fshort\x1fauthor\x1fdate\x1frefs\x1f\x1e").is_empty());
    assert!(parse_git_history("hash\x1f\x1fauthor\x1fdate\x1frefs\x1fsubject\x1e").is_empty());
    assert!(parse_git_history("hash\x1fshort\x1fauthor\x1fdate\x1fHEAD\x1fsubject\x1e")[0].is_head);
}

#[test]
fn parses_local_and_remote_git_branches() {
    let raw = concat!(
        "*\x1frefs/heads/feature/local\x1ffeature/local\n",
        " \x1frefs/heads/main\x1fmain\n",
        " \x1frefs/remotes/origin/HEAD\x1forigin/HEAD\n",
        " \x1frefs/remotes/origin/feature/remote\x1forigin/feature/remote\n",
        " \x1frefs/remotes/origin/main\x1forigin/main\n",
    );

    let branches = parse_git_branches(raw);
    assert_eq!(branches[0].name, "feature/local");
    assert!(branches[0].current);
    assert!(!branches[0].remote);
    assert!(branches
        .iter()
        .any(|branch| branch.name == "origin/main" && branch.remote));
    assert!(!branches.iter().any(|branch| branch.name == "origin/HEAD"));

    let edge_cases = parse_git_branches(concat!(
        "malformed\n",
        " \x1frefs/heads/empty\x1f\n",
        " \x1frefs/remotes/origin/main\x1fremotes/origin/main\n",
        " \x1frefs/remotes/origin/main\x1forigin/main\n",
        " \x1frefs/remotes/origin/HEAD\x1fHEAD\n",
        " \x1frefs/remotes/origin/alias\x1forigin/HEAD -> origin/main\n",
    ));
    assert_eq!(edge_cases.len(), 1);
    assert_eq!(edge_cases[0].name, "origin/main");
    assert!(edge_cases[0].remote);
}

#[test]
fn resolves_remote_branch_switch_targets() {
    let branches = vec![
        GitBranchSummary {
            name: "main".to_string(),
            remote: false,
            current: true,
        },
        GitBranchSummary {
            name: "origin/main".to_string(),
            remote: true,
            current: false,
        },
        GitBranchSummary {
            name: "origin/feature/remote".to_string(),
            remote: true,
            current: false,
        },
    ];

    assert_eq!(
        resolve_switch_target("main", &branches),
        GitSwitchTarget {
            name: "main".to_string(),
            track_remote: false,
        },
    );
    assert_eq!(
        resolve_switch_target("feature/remote", &branches),
        GitSwitchTarget {
            name: "origin/feature/remote".to_string(),
            track_remote: true,
        },
    );
    assert_eq!(
        resolve_switch_target("origin/main", &branches),
        GitSwitchTarget {
            name: "main".to_string(),
            track_remote: false,
        },
    );
    assert_eq!(
        resolve_switch_target("missing", &branches),
        GitSwitchTarget {
            name: "missing".to_string(),
            track_remote: false,
        },
    );
    assert_eq!(
        super::branch_remote_name("origin/feature/x"),
        Some("feature/x"),
    );
    assert_eq!(super::branch_remote_name("origin/"), None);
    assert_eq!(super::branch_remote_name("/main"), None);
    assert_eq!(super::branch_remote_name("main"), None);
    assert_eq!(
        resolve_switch_target(
            "remote-only",
            &[GitBranchSummary {
                name: "remote-only".to_string(),
                remote: true,
                current: false,
            }],
        ),
        GitSwitchTarget {
            name: "remote-only".to_string(),
            track_remote: true,
        },
    );
}

#[test]
fn rejects_git_switch_option_like_branch_names() {
    assert!(normalize_git_branch_target("feature/test").is_ok());
    let error = normalize_git_branch_target("--detach").expect_err("reject option-like name");
    assert_eq!(error.code, -32602);
    for branch in ["", "  ", "bad\0name", "bad\nname", "bad\rname"] {
        assert!(
            normalize_git_branch_target(branch).is_err(),
            "accepted {branch:?}",
        );
    }
}

#[test]
fn validates_repo_relative_paths_and_clone_names() {
    let repo = Path::new("/bridge/root/repo");
    for path in ["", "  ", "/absolute", ".", "src/../../outside"] {
        assert!(
            resolve_repo_relative_path(path, repo).is_err(),
            "accepted {path:?}",
        );
    }
    for name in ["", "  ", "/absolute", ".", "..", "nested/repo"] {
        assert!(
            resolve_clone_directory_name(name).is_err(),
            "accepted {name:?}",
        );
    }
    assert_eq!(resolve_clone_directory_name(" repo ").unwrap(), "repo");
}

#[test]
fn parses_porcelain_edge_cases() {
    let entries = parse_porcelain_status_entries(
        "## main\0\0 X short\0C  copied\0original\0 M changed\0?? untracked\0",
    )
    .expect("parse edge cases");
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0].path, "short");
    assert!(!entries[0].staged);
    assert!(entries[0].unstaged);
    assert_eq!(entries[1].original_path.as_deref(), Some("original"));
    assert!(entries[1].staged);
    assert!(entries[2].unstaged);
    assert!(entries[3].untracked);

    let missing_rename_source =
        parse_porcelain_status_entries("R  renamed\0").expect("parse rename without source");
    assert_eq!(missing_rename_source[0].original_path, None);
    assert!(parse_porcelain_status_entries("X\0").unwrap().is_empty());
}

#[test]
fn selects_git_failure_message_in_priority_order() {
    assert_eq!(
        super::git_failure_message("stderr", "stdout", "fallback"),
        "stderr",
    );
    assert_eq!(
        super::git_failure_message("", "stdout", "fallback"),
        "stdout",
    );
    assert_eq!(super::git_failure_message("", "", "fallback"), "fallback");
}

#[tokio::test]
async fn exercises_git_workflow_against_real_repository() {
    let repo = TestDir::new("workflow");
    repo.init();
    let service = repo.service();

    let unborn = service.get_status(None).await.expect("unborn status");
    assert_eq!(unborn.branch, "main");
    assert!(unborn.clean);
    assert_eq!(service.get_branches(None).await.unwrap().current, None);

    fs::write(repo.0.join("tracked.txt"), "first\n").expect("write tracked file");
    let staged = service
        .stage_file("tracked.txt", None)
        .await
        .expect("stage file");
    assert!(staged.staged);
    let initial_diff = service.get_diff(None).await.expect("initial diff");
    assert!(initial_diff.diff.contains("first"));
    let committed = service
        .commit("initial commit".to_string(), None)
        .await
        .expect("commit");
    assert!(committed.committed);

    fs::write(repo.0.join("tracked.txt"), "first\nsecond\n").expect("modify tracked file");
    fs::write(repo.0.join("new file.txt"), "untracked\n").expect("write untracked file");
    let diff_args = [
        "diff",
        "--no-ext-diff",
        "--exit-code",
        "HEAD",
        "--",
        "tracked.txt",
    ];
    let diff_with_exit_code_one = service
        .run_git_diff_command(&repo.0, &diff_args, true, "git diff --exit-code failed")
        .await
        .expect("allow git diff exit code one");
    let strict_error = service
        .run_git_stdout(&repo.0, &diff_args, "git diff --exit-code failed")
        .await
        .expect_err("stdout executor rejects exit code one");
    assert_eq!(strict_error.code, -32000);
    assert_eq!(strict_error.message, diff_with_exit_code_one);
    let quiet_error = service
        .run_git_stdout(
            &repo.0,
            &["diff", "--quiet", "HEAD"],
            "git quiet diff failed",
        )
        .await
        .expect_err("quiet diff exits with one");
    assert_eq!(quiet_error.code, -32000);
    assert_eq!(quiet_error.message, "git quiet diff failed");
    let dirty = service.get_status(None).await.expect("dirty status");
    assert!(!dirty.clean);
    assert_eq!(dirty.total_files, 2);
    assert!(dirty.files.iter().any(|entry| entry.untracked));
    let diff = service.get_diff(None).await.expect("working tree diff");
    assert!(diff.diff.contains("second"));
    assert!(diff.diff.contains("untracked"));
    assert!(!diff.truncated);

    assert!(service.stage_all(None).await.expect("stage all").staged);
    assert!(
        service
            .unstage_file("tracked.txt", None)
            .await
            .expect("unstage file")
            .unstaged,
    );
    assert!(
        service
            .unstage_all(None)
            .await
            .expect("unstage all")
            .unstaged,
    );
    assert!(service.stage_all(None).await.expect("restage all").staged);
    assert!(
        service
            .commit("second commit".to_string(), None)
            .await
            .expect("second commit")
            .committed,
    );

    let history = service.get_history(None, Some(99)).await.expect("history");
    assert_eq!(history.commits.len(), 2);
    assert_eq!(history.commits[0].subject, "second commit");
    assert!(history.commits[0].is_head);
    assert_eq!(
        service
            .get_history(None, Some(0))
            .await
            .unwrap()
            .commits
            .len(),
        1,
    );

    repo.git(&["branch", "feature/local"]);
    let branches = service.get_branches(None).await.expect("branches");
    assert_eq!(branches.current.as_deref(), Some("main"));
    assert!(branches
        .branches
        .iter()
        .any(|branch| branch.name == "feature/local"));
    let switched = service
        .switch_branch("feature/local".to_string(), None)
        .await
        .expect("switch branch");
    assert!(switched.switched);
    assert_eq!(
        service.get_status(None).await.unwrap().branch,
        "feature/local",
    );

    assert!(
        !service
            .commit("nothing to commit".to_string(), None)
            .await
            .expect("empty commit result")
            .committed,
    );
    assert!(
        !service
            .switch_branch("missing".to_string(), None)
            .await
            .expect("missing branch result")
            .switched,
    );
}

#[tokio::test]
async fn validates_repository_safety_and_push_paths() {
    let repo = TestDir::new("push");
    repo.init();
    fs::write(repo.0.join("file.txt"), "content\n").expect("write file");
    repo.git(&["add", "file.txt"]);
    repo.git(&["commit", "-m", "initial"]);
    let service = repo.service();

    let no_remote = service.push(None).await.expect("no remote response");
    assert!(!no_remote.pushed);
    assert!(no_remote.stderr.contains("No git remote"));

    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://127.0.0.1:1/example/repo.git",
    ]);
    let failed_push = service
        .push(None)
        .await
        .expect("failed network push response");
    assert!(!failed_push.pushed);
    assert_ne!(failed_push.code, Some(0));
    assert!(
        !failed_push.stderr.trim().is_empty(),
        "failed push must return a diagnostic",
    );

    repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    repo.git(&["config", "branch.main.remote", "origin"]);
    repo.git(&["config", "branch.main.merge", "refs/heads/main"]);
    let upstream_push = service.push(None).await.expect("upstream push response");
    assert!(!upstream_push.pushed);

    repo.git(&["config", "http.sslCAInfo", "/tmp/untrusted-ca.pem"]);
    let unsafe_local = service
        .push(None)
        .await
        .expect_err("reject local transport override");
    assert_eq!(
        unsafe_local.data.unwrap()["error"],
        "unsafe_git_configuration",
    );
    repo.git(&["config", "--unset", "http.sslCAInfo"]);

    // `http.sslVerify` is pinned to `true` on the command line, so a repository cannot
    // disable it and must not be blocked for trying.
    repo.git(&["config", "http.sslVerify", "false"]);
    assert!(
        !service
            .push(None)
            .await
            .expect("pinned key is inert")
            .pushed,
    );
    repo.git(&["config", "--unset", "http.sslVerify"]);

    let included_config = repo.0.join("unsafe-transport.config");
    fs::write(
        &included_config,
        "[http]\n\tsslCAInfo = /tmp/untrusted-ca.pem\n",
    )
    .expect("write included config");
    repo.git(&[
        "config",
        "include.path",
        included_config.to_str().expect("utf-8 include path"),
    ]);
    let unsafe_include = service
        .push(None)
        .await
        .expect_err("reject included transport override");
    assert_eq!(unsafe_include.code, -32003);
    repo.git(&["config", "--unset", "include.path"]);

    let malformed_repo = TestDir::new("malformed-repository-config");
    malformed_repo.init();
    fs::write(
        malformed_repo.0.join(".git/config"),
        "[http\nsslVerify = false\n",
    )
    .expect("write malformed repository config");
    assert_eq!(
        malformed_repo
            .service()
            .push(None)
            .await
            .expect_err("reject malformed repository config")
            .code,
        -32000,
    );

    repo.git(&["remote", "set-url", "origin", "file:///tmp/unsafe"]);
    let unsafe_remote = service.push(None).await.expect_err("reject unsafe remote");
    assert_eq!(unsafe_remote.code, -32003);

    repo.git(&["remote", "remove", "origin"]);
    repo.git(&["config", "core.sshCommand", "/tmp/hostile-ssh"]);
    let unsafe_config = service
        .stage_all(None)
        .await
        .expect_err("reject helper config");
    assert_eq!(unsafe_config.code, -32003);
}

#[tokio::test]
async fn rejects_credentialed_operations_when_the_bridge_environment_is_unsafe() {
    let repo = TestDir::new("unsafe-env");
    repo.init();
    fs::write(repo.0.join("file.txt"), "content\n").expect("write file");
    repo.git(&["add", "file.txt"]);
    repo.git(&["commit", "-m", "initial"]);
    let service = repo
        .service()
        .with_environment_probe(Arc::new(|name| name == "HTTPS_PROXY"));

    let error = service
        .push(None)
        .await
        .expect_err("reject proxied bridge environment");
    assert_eq!(error.code, -32003);
    assert_eq!(error.data.unwrap()["error"], "unsafe_git_environment");
}

#[tokio::test]
async fn reports_non_repository_failures_and_clone_validation() {
    let root = TestDir::new("errors");
    let service = root.service();
    assert_eq!(service.get_status(None).await.unwrap_err().code, -32000);
    assert_eq!(
        service.get_history(None, None).await.unwrap_err().code,
        -32000,
    );
    assert_eq!(service.get_branches(None).await.unwrap_err().code, -32000);
    assert_eq!(service.stage_all(None).await.unwrap_err().code, -32000);

    assert_eq!(
        service
            .clone_repo("ssh://example.com/repo", None, "repo")
            .await
            .unwrap_err()
            .code,
        -32003,
    );
    fs::create_dir(root.0.join("existing")).expect("create existing destination");
    assert_eq!(
        service
            .clone_repo("https://example.com/repo.git", None, "existing")
            .await
            .unwrap_err()
            .code,
        -32602,
    );
    let clone = service
        .clone_repo("https://127.0.0.1:1/repo.git", None, "new-repo")
        .await
        .expect("failed clone response");
    assert!(!clone.cloned);
}

#[tokio::test]
async fn tracks_remote_branch_from_real_repository_refs() {
    let repo = TestDir::new("remote-branch");
    repo.init();
    fs::write(repo.0.join("file.txt"), "content\n").expect("write file");
    repo.git(&["add", "file.txt"]);
    repo.git(&["commit", "-m", "initial"]);
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://example.com/example/repo.git",
    ]);
    repo.git(&["update-ref", "refs/remotes/origin/feature/remote", "HEAD"]);

    let service = repo.service();
    let branches = service.get_branches(None).await.expect("remote branches");
    assert!(branches
        .branches
        .iter()
        .any(|branch| branch.name == "origin/feature/remote" && branch.remote));
    let switched = service
        .switch_branch("feature/remote".to_string(), None)
        .await
        .expect("track remote branch");
    assert!(switched.switched);
    assert_eq!(switched.branch, "feature/remote");
}

#[tokio::test]
async fn diff_covers_staged_only_new_repo_and_stderr_error_fallback() {
    let repo = TestDir::new("diff-staged");
    repo.init();
    let service = repo.service();

    // A file staged before any HEAD commit: diff falls back to --cached.
    fs::write(repo.0.join("staged.txt"), "staged content\n").expect("write staged file");
    repo.git(&["add", "staged.txt"]);
    let diff = service.get_diff(None).await.expect("staged-only diff");
    assert!(diff.diff.contains("staged content") || diff.diff.contains("staged.txt"));
    assert!(!diff.truncated);

    // Also exercise an unstaged change in the same repo.
    repo.git(&["commit", "-m", "first"]);
    fs::write(repo.0.join("staged.txt"), "changed content\n").expect("modify staged file");
    let working_diff = service.get_diff(None).await.expect("working diff");
    assert!(working_diff.diff.contains("changed"));
}

#[tokio::test]
async fn validates_repository_helpers_rejects_unsafe_config_with_stderr() {
    let repo = TestDir::new("unsafe-config");
    repo.init();
    fs::write(repo.0.join("file.txt"), "x\n").expect("write file");
    repo.git(&["add", "file.txt"]);
    repo.git(&["commit", "-m", "initial"]);
    repo.git(&["config", "core.sshCommand", "/tmp/evil-ssh"]);
    let service = repo.service();

    let error = service
        .get_diff(None)
        .await
        .expect_err("reject unsafe git configuration");
    assert_eq!(error.code, -32003);
    assert!(error.data.as_ref().unwrap()["error"] == "unsafe_git_configuration");

    let malformed = TestDir::new("malformed-config");
    malformed.init();
    fs::write(
        malformed.0.join(".git/config"),
        "[core\nhooksPath = /tmp/evil\n",
    )
    .expect("write malformed local config");
    let error = malformed
        .service()
        .get_diff(None)
        .await
        .expect_err("report malformed local config");
    assert_eq!(error.code, -32000);
    assert_eq!(
        error.message,
        "git repository configuration inspection failed",
    );
}

#[cfg(unix)]
#[tokio::test]
async fn included_filter_is_rejected_before_git_add_executes_it() {
    use std::os::unix::fs::PermissionsExt;

    let repo = TestDir::new("included-filter");
    repo.init();
    let sentinel = repo.0.join("filter-ran");
    let helper = repo.0.join("filter-helper.sh");
    fs::write(
        &helper,
        format!("#!/bin/sh\ntouch '{}'\ncat\n", sentinel.display()),
    )
    .expect("write filter helper");
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700))
        .expect("make filter helper executable");
    let included = repo.0.join("included.gitconfig");
    fs::write(
        &included,
        format!("[filter \"sentinel\"]\n\tclean = {}\n", helper.display()),
    )
    .expect("write included config");
    repo.git(&[
        "config",
        "include.path",
        included.to_str().expect("utf-8 include path"),
    ]);
    fs::write(repo.0.join(".gitattributes"), "*.secret filter=sentinel\n")
        .expect("write attributes");
    fs::write(repo.0.join("payload.secret"), "secret\n").expect("write payload");

    let error = repo
        .service()
        .stage_all(None)
        .await
        .expect_err("reject included clean filter");
    assert_eq!(error.data.unwrap()["error"], "unsafe_git_configuration");
    assert!(!sentinel.exists(), "validation executed the clean filter");
}

#[tokio::test]
async fn effective_config_inspects_include_if_global_includes_and_benign_entries() {
    let include_if_repo = TestDir::new("include-if-filter");
    include_if_repo.init();
    let include_if_config = include_if_repo.0.join("conditional.gitconfig");
    fs::write(
        &include_if_config,
        "[filter \"conditional\"]\n\tprocess = /tmp/conditional-filter\n",
    )
    .expect("write conditional config");
    include_if_repo.git(&[
        "config",
        &format!("includeIf.gitdir:{}/.path", include_if_repo.0.display()),
        include_if_config.to_str().expect("utf-8 include path"),
    ]);
    assert_eq!(
        include_if_repo
            .service()
            .stage_all(None)
            .await
            .expect_err("reject active includeIf filter")
            .data
            .unwrap()["error"],
        "unsafe_git_configuration",
    );

    let benign_repo = TestDir::new("benign-config");
    benign_repo.init();
    let benign_included = benign_repo.0.join("benign-included.gitconfig");
    fs::write(&benign_included, "[color]\n\tui = auto\n").expect("write benign include");
    benign_repo.git(&[
        "config",
        "include.path",
        benign_included.to_str().expect("utf-8 include path"),
    ]);
    benign_repo
        .service()
        .stage_all(None)
        .await
        .expect("accept benign effective config");
}

#[cfg(unix)]
#[tokio::test]
async fn read_operations_validate_all_effective_config_sources_without_running_helpers() {
    use std::os::unix::fs::PermissionsExt;

    async fn assert_reads_reject(service: &super::GitService, sentinel: &Path) {
        for error in [
            service.get_status(None).await.expect_err("reject status"),
            service
                .get_history(None, None)
                .await
                .expect_err("reject history"),
            service
                .get_branches(None)
                .await
                .expect_err("reject branches"),
            service.get_diff(None).await.expect_err("reject diff"),
        ] {
            assert_eq!(error.code, -32003);
            assert_eq!(
                error.data.as_ref().and_then(|data| data["error"].as_str()),
                Some("unsafe_git_configuration"),
            );
            assert!(!error
                .message
                .contains(&sentinel.to_string_lossy().to_string()));
        }
        assert!(!sentinel.exists(), "validation executed an unsafe helper");
    }

    fn executable_filter(repo: &TestDir, name: &str) -> (PathBuf, PathBuf) {
        let sentinel = repo.0.join(format!("{name}-ran"));
        let helper = repo.0.join(format!("{name}.sh"));
        fs::write(
            &helper,
            format!("#!/bin/sh\ntouch '{}'\ncat\n", sentinel.display()),
        )
        .expect("write helper");
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700))
            .expect("make helper executable");
        (sentinel, helper)
    }

    for source in ["local", "included", "include-if", "worktree"] {
        let repo = TestDir::new(&format!("read-{source}"));
        repo.init();
        fs::write(repo.0.join("file.txt"), "content\n").expect("write file");
        repo.git(&["add", "file.txt"]);
        repo.git(&["commit", "-m", "initial"]);
        let (sentinel, helper) = executable_filter(&repo, source);
        match source {
            "local" => {
                repo.git(&[
                    "config",
                    "filter.local.clean",
                    helper.to_str().expect("utf-8 helper path"),
                ]);
            }
            "included" | "include-if" => {
                let included = repo.0.join(format!("{source}.gitconfig"));
                fs::write(
                    &included,
                    format!("[filter \"{source}\"]\n\tclean = {}\n", helper.display()),
                )
                .expect("write included config");
                let key = if source == "included" {
                    "include.path".to_string()
                } else {
                    format!("includeIf.gitdir:{}/.path", repo.0.display())
                };
                repo.git(&["config", &key, included.to_str().expect("utf-8 path")]);
            }
            "worktree" => {
                repo.git(&["config", "extensions.worktreeConfig", "true"]);
                repo.git(&[
                    "config",
                    "--worktree",
                    "filter.worktree.clean",
                    helper.to_str().expect("utf-8 helper path"),
                ]);
            }
            _ => unreachable!(),
        }
        assert_reads_reject(&repo.service(), &sentinel).await;
    }

    // The operator's own global config is neutralized by `GIT_CONFIG_GLOBAL=/dev/null`, so it
    // can neither run nor block anything.
    let global_repo = TestDir::new("read-global");
    global_repo.init();
    fs::write(global_repo.0.join("file.txt"), "content\n").expect("write file");
    global_repo.git(&["add", "file.txt"]);
    global_repo.git(&["commit", "-m", "initial"]);
    let (sentinel, helper) = executable_filter(&global_repo, "global");
    let home = TestDir::new("read-global-home");
    fs::write(
        home.0.join(".gitconfig"),
        format!("[filter \"global\"]\n\tclean = {}\n", helper.display()),
    )
    .expect("write global config");
    {
        let global_service = global_repo.service_with_home(&home.0);
        global_service
            .get_status(None)
            .await
            .expect("status ignores global filter");
        global_service
            .get_diff(None)
            .await
            .expect("diff ignores global filter");
    }
    assert!(!sentinel.exists(), "global filter must never run");

    let benign_repo = TestDir::new("read-benign");
    benign_repo.init();
    fs::write(benign_repo.0.join("file.txt"), "content\n").expect("write file");
    benign_repo.git(&["add", "file.txt"]);
    benign_repo.git(&["commit", "-m", "initial"]);
    let benign_service = benign_repo.service();
    benign_service
        .get_status(None)
        .await
        .expect("benign status");
    benign_service
        .get_history(None, None)
        .await
        .expect("benign history");
    benign_service
        .get_branches(None)
        .await
        .expect("benign branches");
    benign_service.get_diff(None).await.expect("benign diff");
}

#[tokio::test]
async fn truncates_status_after_maximum_file_count() {
    let repo = TestDir::new("status-limit");
    repo.init();
    for index in 0..=GIT_STATUS_MAX_FILES {
        fs::write(repo.0.join(format!("file-{index:04}.txt")), "").expect("write untracked file");
    }
    let status = repo
        .service()
        .get_status(None)
        .await
        .expect("limited status");
    assert!(status.truncated);
    assert_eq!(status.total_files, GIT_STATUS_MAX_FILES + 1);
    assert_eq!(status.files.len(), GIT_STATUS_MAX_FILES);
    assert_eq!(status.omitted_files, 1);
}
