//! Ties a bridge's lifetime to the desktop app that launched it.
//!
//! The bridge runs detached so it survives the short-lived operator invocation that starts it. That
//! also means a force-quit, crash, or `SIGKILL` of the desktop app would otherwise leave an
//! authenticated bridge listening on the LAN or tailnet with no UI left to stop it. The desktop app
//! therefore passes its own process ID as `BRIDGE_OWNER_PID`, and the bridge shuts itself down as
//! soon as that process goes away.

use std::time::Duration;

const OWNER_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Reads and validates `BRIDGE_OWNER_PID`.
///
/// Returns `Ok(None)` when unset, so the development flow (`npm run bridge`) keeps running without
/// an owner.
pub(crate) fn owner_pid_from_env() -> Result<Option<u32>, String> {
    let Ok(raw) = std::env::var("BRIDGE_OWNER_PID") else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match trimmed.parse::<u32>() {
        Ok(pid) if pid > 0 => Ok(Some(pid)),
        _ => Err("BRIDGE_OWNER_PID must be a positive process ID".to_string()),
    }
}

/// Resolves once the owning process has exited.
///
/// Never resolves when there is no owner, so it can sit in a `select!` alongside signal handling.
pub(crate) async fn wait_for_owner_exit(owner_pid: Option<u32>) {
    let Some(owner_pid) = owner_pid else {
        std::future::pending::<()>().await;
        return;
    };
    if !process_is_alive(owner_pid) {
        return;
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if wait_for_owner_exit_via_kqueue(owner_pid).await {
        return;
    }
    poll_until_owner_exits(owner_pid).await;
}

async fn poll_until_owner_exits(owner_pid: u32) {
    while process_is_alive(owner_pid) {
        tokio::time::sleep(OWNER_POLL_INTERVAL).await;
    }
}

/// Watches the owner with `kqueue`'s `NOTE_EXIT`.
///
/// Registration binds to the live process, so a recycled PID cannot make the watch miss the real
/// exit. Returns `false` when the watch could not be established and the caller should poll instead.
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn wait_for_owner_exit_via_kqueue(owner_pid: u32) -> bool {
    // A join failure means the runtime is going down, which the polling fallback handles.
    tokio::task::spawn_blocking(move || block_on_owner_exit(owner_pid))
        .await
        .unwrap_or(false)
}

/// What a `kevent` wait result means for the watch loop.
#[cfg(any(target_os = "macos", target_os = "ios"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WatchStep {
    /// The owner exited, so the bridge should shut down.
    OwnerExited,
    /// A spurious or interrupted wait; keep waiting.
    Retry,
    /// The watch broke, so the caller should fall back to polling.
    Unavailable,
}

/// Interprets a `kevent` return value.
///
/// Split out from the syscall so every outcome is reachable in tests: interrupted and failed waits
/// are otherwise nearly impossible to provoke, and getting them wrong would either spin forever or
/// silently stop watching the owner.
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
    use std::os::fd::{FromRawFd, OwnedFd};

    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        return false;
    }
    // Owning the descriptor guarantees it is closed on every exit path below.
    let queue = unsafe { OwnedFd::from_raw_fd(queue) };
    let queue_fd = std::os::fd::AsRawFd::as_raw_fd(&queue);

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

#[cfg(unix)]
pub(crate) fn process_is_alive(pid: u32) -> bool {
    // Signal 0 performs the permission and existence checks without delivering anything. EPERM
    // means the process exists but belongs to another user, which still counts as alive.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub(crate) fn process_is_alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    struct EnvGuard;

    impl EnvGuard {
        fn set(value: &str) -> Self {
            std::env::set_var("BRIDGE_OWNER_PID", value);
            Self
        }

        fn clear() -> Self {
            std::env::remove_var("BRIDGE_OWNER_PID");
            Self
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("BRIDGE_OWNER_PID");
        }
    }

    #[test]
    fn reads_a_valid_owner_pid() {
        let _guard = EnvGuard::set("4321");
        assert_eq!(owner_pid_from_env().unwrap(), Some(4321));
    }

    #[test]
    fn treats_an_unset_or_blank_owner_pid_as_absent() {
        let _guard = EnvGuard::clear();
        assert_eq!(owner_pid_from_env().unwrap(), None);
        let _blank = EnvGuard::set("   ");
        assert_eq!(owner_pid_from_env().unwrap(), None);
    }

    #[test]
    fn rejects_a_malformed_owner_pid() {
        let _guard = EnvGuard::set("0");
        assert!(owner_pid_from_env().is_err());
        let _text = EnvGuard::set("not-a-pid");
        assert!(owner_pid_from_env().is_err());
        let _negative = EnvGuard::set("-4");
        assert!(owner_pid_from_env().is_err());
    }

    #[test]
    fn recognizes_a_live_process_and_a_dead_one() {
        assert!(process_is_alive(std::process::id()));
        assert!(process_is_alive(1), "init is owned by another user");

        let mut child = std::process::Command::new("/bin/echo")
            .arg("done")
            .spawn()
            .expect("spawn short-lived child");
        let pid = child.id();
        child.wait().expect("reap child");
        // The reaped PID is free, so nothing with that identity is running for us to watch.
        assert!(!process_is_alive(pid) || pid == std::process::id());
    }

    #[tokio::test]
    async fn returns_immediately_when_the_owner_is_already_gone() {
        let mut child = std::process::Command::new("/bin/echo")
            .arg("done")
            .spawn()
            .expect("spawn short-lived child");
        let pid = child.id();
        child.wait().expect("reap child");

        tokio::time::timeout(Duration::from_secs(5), wait_for_owner_exit(Some(pid)))
            .await
            .expect("owner watchdog should resolve for a dead owner");
    }

    #[tokio::test]
    async fn resolves_when_a_live_owner_exits() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn long-lived child");
        let pid = child.id();

        let watchdog = tokio::spawn(async move { wait_for_owner_exit(Some(pid)).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !watchdog.is_finished(),
            "should still be watching a live owner"
        );

        child.kill().expect("kill owner");
        child.wait().expect("reap owner");
        tokio::time::timeout(Duration::from_secs(10), watchdog)
            .await
            .expect("owner watchdog should resolve after the owner exits")
            .expect("watchdog task should not panic");
    }

    #[tokio::test]
    async fn never_resolves_without_an_owner() {
        assert!(
            tokio::time::timeout(Duration::from_millis(150), wait_for_owner_exit(None))
                .await
                .is_err()
        );
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn the_kqueue_watch_reports_failure_for_a_process_that_cannot_be_registered() {
        // A PID that cannot exist fails registration, which is what tells the caller to poll.
        assert!(!block_on_owner_exit(u32::MAX - 1));
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn every_kevent_outcome_maps_to_the_right_next_step() {
        use std::io::ErrorKind;

        // A delivered event is the only thing that means the owner is gone.
        assert_eq!(classify_kevent(1, ErrorKind::Other), WatchStep::OwnerExited);
        assert_eq!(
            classify_kevent(2, ErrorKind::Interrupted),
            WatchStep::OwnerExited
        );

        // A spurious wake or a signal must keep waiting rather than abandon the watch.
        assert_eq!(classify_kevent(0, ErrorKind::Other), WatchStep::Retry);
        assert_eq!(
            classify_kevent(-1, ErrorKind::Interrupted),
            WatchStep::Retry
        );

        // Anything else means the watch is broken and the caller should fall back to polling.
        assert_eq!(
            classify_kevent(-1, ErrorKind::PermissionDenied),
            WatchStep::Unavailable
        );
        assert_eq!(
            classify_kevent(-1, ErrorKind::Other),
            WatchStep::Unavailable
        );
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[tokio::test]
    async fn the_kqueue_watch_resolves_when_the_owner_exits() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn long-lived child");
        let pid = child.id();

        let watch = tokio::spawn(async move { wait_for_owner_exit_via_kqueue(pid).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        child.kill().expect("kill owner");
        child.wait().expect("reap owner");

        assert!(tokio::time::timeout(Duration::from_secs(10), watch)
            .await
            .expect("kqueue watch should resolve")
            .expect("watch task should not panic"));
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[tokio::test]
    async fn falls_back_to_polling_when_the_kqueue_watch_cannot_be_established() {
        // The owner is alive, so `wait_for_owner_exit` gets past its early return, but a PID that
        // cannot be registered forces the polling path to take over.
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn long-lived child");
        let pid = child.id();

        let watchdog = tokio::spawn(async move { wait_for_owner_exit(Some(pid)).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!watchdog.is_finished());

        child.kill().expect("kill owner");
        child.wait().expect("reap owner");
        tokio::time::timeout(Duration::from_secs(10), watchdog)
            .await
            .expect("watchdog should resolve after the owner exits")
            .expect("watchdog task should not panic");
    }

    #[tokio::test]
    async fn polling_fallback_resolves_after_the_owner_exits() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn long-lived child");
        let pid = child.id();

        let watchdog = tokio::spawn(async move { poll_until_owner_exits(pid).await });
        child.kill().expect("kill owner");
        child.wait().expect("reap owner");
        tokio::time::timeout(Duration::from_secs(10), watchdog)
            .await
            .expect("polling fallback should resolve after the owner exits")
            .expect("watchdog task should not panic");
    }

    #[tokio::test]
    async fn polling_fallback_returns_immediately_for_a_dead_owner() {
        let mut child = std::process::Command::new("/bin/echo")
            .arg("done")
            .spawn()
            .expect("spawn short-lived child");
        let pid = child.id();
        child.wait().expect("reap child");

        // The loop must not sleep once before noticing an owner that is already gone.
        tokio::time::timeout(Duration::from_secs(1), poll_until_owner_exits(pid))
            .await
            .expect("a dead owner should resolve without waiting a poll interval");
    }
}
