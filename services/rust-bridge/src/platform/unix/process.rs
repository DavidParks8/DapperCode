use std::time::Duration;

use tokio::process::{Child, Command};

use crate::platform::{poll_while_owner_is_alive, PlatformFuture};

const OWNER_POLL_INTERVAL: Duration = Duration::from_secs(2);

pub(super) fn unix_process_is_alive(pid: u32) -> bool {
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
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
    let pid = pid as libc::pid_t;
    if unsafe { libc::getpgid(pid) } == pid {
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

    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        return false;
    }
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

#[cfg(all(test, any(target_os = "macos", target_os = "ios")))]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    const LONG_LIVED_CHILD: &str = "__watchdog_long_lived_child";

    fn spawn_fixture() -> std::process::Child {
        std::process::Command::new(std::env::current_exe().expect("test executable"))
            .arg(LONG_LIVED_CHILD)
            .spawn()
            .expect("spawn watchdog fixture")
    }

    #[test]
    fn kqueue_reports_failure_for_a_process_that_cannot_be_registered() {
        assert!(!block_on_owner_exit(u32::MAX - 1));
    }

    #[test]
    fn process_probe_distinguishes_live_and_missing_processes() {
        assert!(unix_process_is_alive(std::process::id()));
        assert!(!unix_process_is_alive(u32::MAX - 1));
    }

    #[tokio::test]
    async fn git_process_group_cleanup_handles_grouped_ungrouped_and_settled_children() {
        let mut grouped_command = Command::new("/bin/sh");
        grouped_command.args(["-c", "sleep 30"]);
        configure_unix_git_command(&mut grouped_command);
        let mut grouped = grouped_command.spawn().expect("spawn grouped child");
        kill_unix_git_process_group(&grouped);
        tokio::time::timeout(Duration::from_secs(5), grouped.wait())
            .await
            .expect("grouped child should exit")
            .expect("wait for grouped child");

        let mut ungrouped = Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn ungrouped child");
        kill_unix_git_process_group(&ungrouped);
        assert!(ungrouped
            .try_wait()
            .expect("inspect ungrouped child")
            .is_none());
        ungrouped.kill().await.expect("kill ungrouped child");
        ungrouped.wait().await.expect("wait for ungrouped child");
        kill_unix_git_process_group(&ungrouped);
    }

    #[test]
    fn every_kevent_outcome_maps_to_the_right_next_step() {
        use std::io::ErrorKind;

        assert_eq!(classify_kevent(1, ErrorKind::Other), WatchStep::OwnerExited);
        assert_eq!(
            classify_kevent(2, ErrorKind::Interrupted),
            WatchStep::OwnerExited
        );
        assert_eq!(classify_kevent(0, ErrorKind::Other), WatchStep::Retry);
        assert_eq!(
            classify_kevent(-1, ErrorKind::Interrupted),
            WatchStep::Retry
        );
        assert_eq!(
            classify_kevent(-1, ErrorKind::PermissionDenied),
            WatchStep::Unavailable
        );
        assert_eq!(
            classify_kevent(-1, ErrorKind::Other),
            WatchStep::Unavailable
        );
    }

    #[tokio::test]
    async fn kqueue_resolves_when_the_owner_exits() {
        let mut child = spawn_fixture();
        let pid = child.id();

        let watch = tokio::spawn(async move { try_kqueue_owner_watch(pid).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        child.kill().expect("kill owner");
        child.wait().expect("reap owner");

        assert!(tokio::time::timeout(Duration::from_secs(10), watch)
            .await
            .expect("kqueue watch should resolve")
            .expect("watch task should not panic"));
    }
}
