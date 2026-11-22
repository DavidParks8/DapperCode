use crate::platform::{
    owner_identity_matches, poll_while_owner_is_alive, zero_timeout_wait_means_alive,
    PlatformFuture,
};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command as StdCommand, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::process::{Child, Command};
use windows_sys::Win32::Foundation::{FILETIME, WAIT_TIMEOUT};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW,
    PROCESS_QUERY_LIMITED_INFORMATION,
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
            "taskkill exited with status {status}",
        )))
    }
}

fn windows_system_directory() -> io::Result<PathBuf> {
    let mut buffer = vec![0_u16; 260];
    loop {
        let capacity = u32::try_from(buffer.len())
            .map_err(|_| io::Error::other("Windows system directory path is too long"))?;
        // SAFETY: buffer has capacity initialized UTF-16 units and remains live for the call.
        let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), capacity) };
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

#[cfg(any(test, feature = "test-support"))]
pub(super) fn windows_process_creation_time_for_pid(pid: u32) -> io::Result<u64> {
    ProcessHandle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?.creation_time()
}

struct ProcessHandle(OwnedHandle);

impl ProcessHandle {
    fn open(pid: u32, access: u32) -> io::Result<Self> {
        // SAFETY: OpenProcess takes only integer parameters and returns an owned handle.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcess returned a new, non-null handle owned by this process.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle) }))
    }

    fn is_alive(&self) -> bool {
        // SAFETY: OwnedHandle keeps the process handle valid throughout this zero-timeout wait.
        zero_timeout_wait_means_alive(
            unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) },
            WAIT_TIMEOUT,
        )
    }

    fn creation_time(&self) -> io::Result<u64> {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: the owned process handle is live and all output pointers refer to FILETIMEs.
        if unsafe {
            GetProcessTimes(
                self.0.as_raw_handle(),
                &raw mut creation,
                &raw mut exit,
                &raw mut kernel,
                &raw mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "process_tests.rs"]
mod tests;
