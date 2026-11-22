use std::time::Duration;

use tokio::process::{Child, Command};

use crate::platform::{poll_while_owner_is_alive, PlatformFuture};

const OWNER_POLL_INTERVAL: Duration = Duration::from_secs(2);

pub(super) fn unix_process_is_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid == 0 {
        return false;
    }
    // SAFETY: signal zero only probes the checked PID and does not access Rust memory.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub(super) fn wait_for_unix_owner_exit(pid: u32) -> PlatformFuture<()> {
    Box::pin(async move {
        if try_kqueue_owner_watch(pid).await {
            return;
        }
        poll_while_owner_is_alive(|| unix_process_is_alive(pid), OWNER_POLL_INTERVAL).await;
    })
}

pub(super) fn wait_for_unix_shutdown_signal() -> PlatformFuture<&'static str> {
    Box::pin(async {
        let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
            .expect("failed to install SIGINT handler");
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler");
        tokio::select! {
            _ = sigint.recv() => "SIGINT",
            _ = sigterm.recv() => "SIGTERM",
        }
    })
}

pub(super) fn configure_unix_git_command(command: &mut Command) {
    command.process_group(0);
}

pub(super) fn kill_unix_git_process_group(child: &Child) {
    let Some(pid) = child.id() else {
        return;
    };
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        eprintln!("warning: Git process id {pid} is out of range");
        return;
    };
    // SAFETY: getpgid only reads the integer process identifier.
    if unsafe { libc::getpgid(pid) } == pid {
        // SAFETY: the checked child PID is its process-group ID; kill takes no pointers.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}

async fn try_kqueue_owner_watch(pid: u32) -> bool {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        tokio::task::spawn_blocking(move || block_on_owner_exit(pid))
            .await
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = pid;
        false
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WatchStep {
    OwnerExited,
    Retry,
    Unavailable,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn classify_kevent(received: libc::c_int, error_kind: std::io::ErrorKind) -> WatchStep {
    if received > 0 {
        return WatchStep::OwnerExited;
    }
    if received == 0 || error_kind == std::io::ErrorKind::Interrupted {
        return WatchStep::Retry;
    }
    WatchStep::Unavailable
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn block_on_owner_exit(owner_pid: u32) -> bool {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    // SAFETY: kqueue takes no arguments and returns a new descriptor or an error.
    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        return false;
    }
    // SAFETY: kqueue returned a valid newly owned descriptor, transferred exactly once.
    let queue = unsafe { OwnedFd::from_raw_fd(queue) };
    let queue_fd = queue.as_raw_fd();

    let mut change = libc::kevent {
        ident: owner_pid as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    // SAFETY: queue_fd stays open, change is initialized, and no output buffer is requested.
    let registered = unsafe {
        libc::kevent(
            queue_fd,
            &raw const change,
            1,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    };
    if registered < 0 {
        return false;
    }

    loop {
        // SAFETY: queue_fd stays open and change provides writable storage for one event.
        let received = unsafe {
            libc::kevent(
                queue_fd,
                std::ptr::null(),
                0,
                &raw mut change,
                1,
                std::ptr::null(),
            )
        };
        match classify_kevent(received, std::io::Error::last_os_error().kind()) {
            WatchStep::OwnerExited => return true,
            WatchStep::Unavailable => return false,
            WatchStep::Retry => {}
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "process_tests.rs"]
mod tests;
