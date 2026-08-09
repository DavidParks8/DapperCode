use std::{
    collections::HashMap,
    io,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use tokio::process::{Child, Command};
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_TIMEOUT},
    System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
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

pub(super) fn configure_windows_git_command(_command: &mut Command) {}

pub(super) fn kill_windows_git_process_group(_child: &Child) {}

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
