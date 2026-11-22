use super::{
    configure_windows_git_command, kill_windows_git_process_group, terminate_windows_process_tree,
    windows_process_is_alive,
};
use std::io::Write;
use std::process::{Command as FixtureCommand, Stdio};
use std::thread;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::time::timeout;

const FIXTURE_FILTER: &str = "windows_git_inherited_pipe_fixture";
const FIXTURE_ROLE: &str = "DAPPERCODE_WINDOWS_GIT_TREE_FIXTURE";
const GRANDCHILD_PID: &str = "DAPPERCODE_GRANDCHILD_PID=";
const GRANDCHILD_STDOUT_READY: &str = "DAPPERCODE_GRANDCHILD_STDOUT_READY";
const GRANDCHILD_STDERR_READY: &str = "DAPPERCODE_GRANDCHILD_STDERR_READY";
const FIXTURE_TIMEOUT: Duration = Duration::from_secs(10);

struct ProcessTreeCleanup(Vec<u32>);

impl Drop for ProcessTreeCleanup {
    fn drop(&mut self) {
        for pid in self.0.drain(..) {
            let _ = terminate_windows_process_tree(pid);
        }
    }
}

fn fixture_command(role: &str) -> FixtureCommand {
    let mut command = FixtureCommand::new(std::env::current_exe().expect("test executable"));
    command
        .args([
            "--ignored",
            "--nocapture",
            "--test-threads=1",
            FIXTURE_FILTER,
        ])
        .env(FIXTURE_ROLE, role)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command
}

#[test]
#[ignore = "subprocess fixture for the Windows process-tree regression test"]
fn windows_git_inherited_pipe_fixture() {
    match std::env::var(FIXTURE_ROLE).as_deref() {
        Ok("child") => {
            let mut grandchild = fixture_command("grandchild")
                .spawn()
                .expect("spawn fixture grandchild");
            println!("{GRANDCHILD_PID}{}", grandchild.id());
            std::io::stdout().flush().expect("flush grandchild pid");
            let _ = grandchild.wait();
        }
        Ok("grandchild") => {
            println!("{GRANDCHILD_STDOUT_READY}");
            eprintln!("{GRANDCHILD_STDERR_READY}");
            std::io::stdout().flush().expect("flush fixture stdout");
            std::io::stderr().flush().expect("flush fixture stderr");
            loop {
                thread::sleep(Duration::from_secs(60));
            }
        }
        _ => {}
    }
}

#[tokio::test]
async fn timeout_terminates_descendants_and_closes_inherited_pipes() {
    let mut command = Command::new(std::env::current_exe().expect("test executable"));
    command
        .args([
            "--ignored",
            "--nocapture",
            "--test-threads=1",
            FIXTURE_FILTER,
        ])
        .env(FIXTURE_ROLE, "child")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_windows_git_command(&mut command);

    let mut child = command.spawn().expect("spawn fixture child");
    let child_pid = child.id().expect("fixture child pid");
    let mut cleanup = ProcessTreeCleanup(vec![child_pid]);
    let stdout = child.stdout.take().expect("fixture stdout");
    let stderr = child.stderr.take().expect("fixture stderr");

    let (pid_tx, pid_rx) = oneshot::channel();
    let (stdout_ready_tx, stdout_ready_rx) = oneshot::channel();
    let stdout_task = tokio::spawn(async move {
        let mut pid_tx = Some(pid_tx);
        let mut stdout_ready_tx = Some(stdout_ready_tx);
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(raw_pid) = line.split_once(GRANDCHILD_PID).map(|(_, value)| value) {
                if let (Ok(pid), Some(sender)) = (raw_pid.trim().parse::<u32>(), pid_tx.take()) {
                    let _ = sender.send(pid);
                }
            }
            if line.contains(GRANDCHILD_STDOUT_READY) {
                if let Some(sender) = stdout_ready_tx.take() {
                    let _ = sender.send(());
                }
            }
        }
    });

    let (stderr_ready_tx, stderr_ready_rx) = oneshot::channel();
    let stderr_task = tokio::spawn(async move {
        let mut stderr_ready_tx = Some(stderr_ready_tx);
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.contains(GRANDCHILD_STDERR_READY) {
                if let Some(sender) = stderr_ready_tx.take() {
                    let _ = sender.send(());
                }
            }
        }
    });

    let grandchild_pid = timeout(FIXTURE_TIMEOUT, async {
        let pid = pid_rx
            .await
            .expect("fixture child must report grandchild pid");
        stdout_ready_rx
            .await
            .expect("grandchild must inherit and write stdout");
        stderr_ready_rx
            .await
            .expect("grandchild must inherit and write stderr");
        pid
    })
    .await
    .expect("fixture process tree must become ready");
    cleanup.0.push(grandchild_pid);

    kill_windows_git_process_group(&child);
    let _ = child.kill().await;
    timeout(FIXTURE_TIMEOUT, async {
        let _ = child.wait().await;
        stdout_task.await.expect("stdout reader task");
        stderr_task.await.expect("stderr reader task");
    })
    .await
    .expect("tree termination must close inherited stdout and stderr pipes");

    assert!(!windows_process_is_alive(child_pid));
    assert!(!windows_process_is_alive(grandchild_pid));
    cleanup.0.clear();
}
