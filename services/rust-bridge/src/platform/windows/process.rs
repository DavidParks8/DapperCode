use std::{
    collections::HashMap,
    ffi::OsString,
    io,
    os::windows::{ffi::OsStringExt, process::CommandExt},
    path::PathBuf,
    process::{Command as StdCommand, Stdio},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use tokio::process::{Child, Command};
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_TIMEOUT},
    System::{
        SystemInformation::GetSystemDirectoryW,
        Threading::{
            GetProcessTimes, OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

use crate::platform::{
    owner_identity_matches, poll_while_owner_is_alive, zero_timeout_wait_means_alive,
    PlatformFuture,
};

const OWNER_POLL_INTERVAL: Duration = Duration::from_secs(2);
const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

pub(super) fn windows_process_is_alive(pid: u32) -> bool {
    let Ok(process) =
        ProcessHandle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE_ACCESS)
    else {
        return false;
    };
    if !process.is_alive() {
        return false;
    }
    let Ok(creation_time) = process.creation_time() else {
        return false;
    };
    remember_creation_time(pid, creation_time);
    true
}

pub(super) fn wait_for_windows_owner_exit(pid: u32) -> PlatformFuture<()> {
    wait_for_windows_owner_exit_with_identity(pid, observed_windows_creation_time(pid))
}

pub(super) fn wait_for_windows_owner_exit_with_identity(
    pid: u32,
    expected_creation_time: Option<u64>,
) -> PlatformFuture<()> {
    Box::pin(async move {
        let Ok(process) =
            ProcessHandle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE_ACCESS)
        else {
            return;
        };
        let Ok(creation_time) = process.creation_time() else {
            return;
        };
        if !owner_identity_matches(expected_creation_time, creation_time) {
            return;
        }

        poll_while_owner_is_alive(move || process.is_alive(), OWNER_POLL_INTERVAL).await;
    })
}

pub(super) fn wait_for_windows_shutdown_signal() -> PlatformFuture<&'static str> {
    Box::pin(async {
        let _ = tokio::signal::ctrl_c().await;
        "Ctrl+C"
    })
}

pub(super) fn configure_windows_git_command(command: &mut Command) {
    command.kill_on_drop(true);
}

pub(super) fn kill_windows_git_process_group(child: &Child) {
    let Some(pid) = child.id() else {
        return;
    };
    if let Err(error) = terminate_windows_process_tree(pid) {
        eprintln!("warning: failed to terminate Git process tree {pid}: {error}");
    }
}

/// `std`/Tokio do not expose `PROC_THREAD_ATTRIBUTE_JOB_LIST`, so assigning a Job Object after
/// `spawn` would let a fast descendant escape before assignment. `taskkill /T /F` is Windows'
/// recursive process-tree terminator. Waiting for it synchronously ensures descendants have been
/// ended before the caller waits for inherited stdout and stderr handles to close.
fn terminate_windows_process_tree(pid: u32) -> io::Result<()> {
    let pid = pid.to_string();
    let status = StdCommand::new(windows_system_directory()?.join("taskkill.exe"))
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "taskkill exited with status {status}"
        )))
    }
}

fn windows_system_directory() -> io::Result<PathBuf> {
    let mut buffer = vec![0_u16; 260];
    loop {
        let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        let length = length as usize;
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        buffer.resize(length.saturating_add(1), 0);
    }
}

fn observed_processes() -> &'static Mutex<HashMap<u32, u64>> {
    static OBSERVED: OnceLock<Mutex<HashMap<u32, u64>>> = OnceLock::new();
    OBSERVED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_creation_time(pid: u32, creation_time: u64) {
    if let Ok(mut observed) = observed_processes().lock() {
        observed.entry(pid).or_insert(creation_time);
    }
}

pub(super) fn observed_windows_creation_time(pid: u32) -> Option<u64> {
    observed_processes()
        .lock()
        .ok()
        .and_then(|observed| observed.get(&pid).copied())
}

#[cfg(test)]
pub(super) fn windows_process_creation_time_for_pid(pid: u32) -> io::Result<u64> {
    ProcessHandle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?.creation_time()
}

struct ProcessHandle(HANDLE);

unsafe impl Send for ProcessHandle {}

impl ProcessHandle {
    fn open(pid: u32, access: u32) -> io::Result<Self> {
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }

    fn is_alive(&self) -> bool {
        zero_timeout_wait_means_alive(unsafe { WaitForSingleObject(self.0, 0) }, WAIT_TIMEOUT)
    }

    fn creation_time(&self) -> io::Result<u64> {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(self.0, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command as FixtureCommand, Stdio},
        thread,
    };
    use tokio::{
        io::{AsyncBufReadExt, BufReader},
        sync::oneshot,
        time::timeout,
    };

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
                    if let (Ok(pid), Some(sender)) = (raw_pid.trim().parse::<u32>(), pid_tx.take())
                    {
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
}
