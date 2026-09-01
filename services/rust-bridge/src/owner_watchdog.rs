//! Ties a bridge's lifetime to the desktop app that launched it.
//!
//! The bridge runs detached so it survives the short-lived operator invocation that starts it. That
//! also means a force-quit, crash, or `SIGKILL` of the desktop app would otherwise leave an
//! authenticated bridge listening on the LAN or tailnet with no UI left to stop it. The desktop app
//! therefore passes its own process ID as `BRIDGE_OWNER_PID`, and the bridge shuts itself down as
//! soon as that process goes away.

#[cfg(test)]
use std::time::Duration;

#[cfg(test)]
use dappercode_bridge_platform::poll_while_owner_is_alive as poll_platform_owner;
use dappercode_bridge_platform::{
    process_is_alive as platform_process_is_alive,
    wait_for_owner_exit as wait_for_platform_owner_exit,
};

#[cfg(test)]
const OWNER_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Reads and validates `BRIDGE_OWNER_PID`.
///
/// Returns `Ok(None)` when unset, so the development flow (`pnpm run bridge`) keeps running without
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
    wait_for_platform_owner_exit(owner_pid).await;
}

pub(crate) fn process_is_alive(pid: u32) -> bool {
    platform_process_is_alive(pid)
}

#[cfg(test)]
async fn poll_until_owner_exits(owner_pid: u32) {
    poll_while_owner_is_alive(|| process_is_alive(owner_pid), OWNER_POLL_INTERVAL).await;
}

#[cfg(test)]
async fn poll_while_owner_is_alive(mut owner_is_alive: impl FnMut() -> bool, interval: Duration) {
    poll_platform_owner(&mut owner_is_alive, interval).await;
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    const SHORT_LIVED_CHILD: &str = "__watchdog_short_lived_child";
    const LONG_LIVED_CHILD: &str = "__watchdog_long_lived_child";

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

    fn spawn_fixture(marker: &str) -> std::process::Child {
        std::process::Command::new(std::env::current_exe().expect("test executable"))
            .arg(marker)
            .spawn()
            .expect("spawn watchdog fixture")
    }

    #[test]
    fn __watchdog_short_lived_child() {}

    #[test]
    fn __watchdog_long_lived_child() {
        if std::env::args().any(|argument| argument == LONG_LIVED_CHILD) {
            std::thread::sleep(Duration::from_secs(30));
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
        #[cfg(unix)]
        assert!(process_is_alive(1), "init is owned by another user");

        let mut child = spawn_fixture(SHORT_LIVED_CHILD);
        let pid = child.id();
        child.wait().expect("reap child");
        // The reaped PID is free, so nothing with that identity is running for us to watch.
        assert!(!process_is_alive(pid) || pid == std::process::id());
    }

    #[tokio::test]
    async fn returns_immediately_when_the_owner_is_already_gone() {
        let mut child = spawn_fixture(SHORT_LIVED_CHILD);
        let pid = child.id();
        child.wait().expect("reap child");

        tokio::time::timeout(Duration::from_secs(5), wait_for_owner_exit(Some(pid)))
            .await
            .expect("owner watchdog should resolve for a dead owner");
    }

    #[tokio::test]
    async fn resolves_when_a_live_owner_exits() {
        let mut child = spawn_fixture(LONG_LIVED_CHILD);
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

    #[tokio::test]
    async fn bounded_polling_waits_for_a_live_owner_then_resolves() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };

        let owner_is_alive = Arc::new(AtomicBool::new(true));
        let first_poll = Arc::new(tokio::sync::Notify::new());
        let watchdog = tokio::spawn(poll_while_owner_is_alive(
            {
                let owner_is_alive = Arc::clone(&owner_is_alive);
                let first_poll = Arc::clone(&first_poll);
                move || {
                    first_poll.notify_one();
                    owner_is_alive.load(Ordering::SeqCst)
                }
            },
            Duration::from_millis(10),
        ));

        tokio::time::timeout(Duration::from_secs(1), first_poll.notified())
            .await
            .expect("polling should start");
        assert!(
            !watchdog.is_finished(),
            "a live owner must keep the watch open"
        );

        owner_is_alive.store(false, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(1), watchdog)
            .await
            .expect("watchdog should observe the owner exit")
            .expect("watchdog task should not panic");
    }

    #[tokio::test]
    async fn cancelling_bounded_polling_drops_all_work() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };

        struct DropSignal(Arc<AtomicBool>);

        impl Drop for DropSignal {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let dropped = Arc::new(AtomicBool::new(false));
        let first_poll = Arc::new(tokio::sync::Notify::new());
        let watchdog = tokio::spawn(poll_while_owner_is_alive(
            {
                let drop_signal = DropSignal(Arc::clone(&dropped));
                let first_poll = Arc::clone(&first_poll);
                move || {
                    let _keep_until_cancelled = &drop_signal;
                    first_poll.notify_one();
                    true
                }
            },
            Duration::from_secs(30),
        ));

        tokio::time::timeout(Duration::from_secs(1), first_poll.notified())
            .await
            .expect("polling should start");
        watchdog.abort();
        let cancellation = tokio::time::timeout(Duration::from_secs(1), watchdog)
            .await
            .expect("cancellation should be prompt")
            .expect_err("the watchdog should be cancelled");
        assert!(cancellation.is_cancelled());
        assert!(
            dropped.load(Ordering::SeqCst),
            "cancellation must drop the polling closure"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[tokio::test]
    async fn falls_back_to_polling_when_the_kqueue_watch_cannot_be_established() {
        // The owner is alive, so `wait_for_owner_exit` gets past its early return, but a PID that
        // cannot be registered forces the polling path to take over.
        let mut child = spawn_fixture(LONG_LIVED_CHILD);
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
        let mut child = spawn_fixture(LONG_LIVED_CHILD);
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
        let mut child = spawn_fixture(SHORT_LIVED_CHILD);
        let pid = child.id();
        child.wait().expect("reap child");

        // The loop must not sleep once before noticing an owner that is already gone.
        tokio::time::timeout(Duration::from_secs(1), poll_until_owner_exits(pid))
            .await
            .expect("a dead owner should resolve without waiting a poll interval");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_watch_rejects_a_reused_pid_creation_identity() {
        let mut child = spawn_fixture(LONG_LIVED_CHILD);
        let pid = child.id();
        assert!(process_is_alive(pid));
        let creation_time = dappercode_bridge_platform::test_observed_process_creation_time(pid)
            .expect("captured creation time");
        assert_eq!(
            dappercode_bridge_platform::test_process_creation_time(pid).unwrap(),
            creation_time
        );

        tokio::time::timeout(
            Duration::from_secs(1),
            dappercode_bridge_platform::test_wait_for_owner_exit_with_identity(
                pid,
                Some(creation_time.wrapping_add(1)),
            ),
        )
        .await
        .expect("a reused PID identity must be rejected immediately");
        assert!(child.try_wait().unwrap().is_none());

        child.kill().expect("kill owner");
        child.wait().expect("reap owner");
    }

    #[cfg(windows)]
    #[test]
    fn cancelling_windows_watch_does_not_delay_runtime_shutdown() {
        let mut child = spawn_fixture(LONG_LIVED_CHILD);
        let pid = child.id();
        assert!(process_is_alive(pid));
        let creation_time = dappercode_bridge_platform::test_observed_process_creation_time(pid)
            .expect("captured creation time");

        let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel();
        let runtime_thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .expect("watchdog test runtime");
            runtime.block_on(async move {
                let watchdog = tokio::spawn(
                    dappercode_bridge_platform::test_wait_for_owner_exit_with_identity(
                        pid,
                        Some(creation_time),
                    ),
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
                assert!(
                    !watchdog.is_finished(),
                    "the watch must remain pending for a live owner"
                );

                watchdog.abort();
                let cancellation = tokio::time::timeout(Duration::from_secs(1), watchdog)
                    .await
                    .expect("watch cancellation should be prompt")
                    .expect_err("watchdog should be cancelled");
                assert!(cancellation.is_cancelled());
            });
            drop(runtime);
            shutdown_tx
                .send(())
                .expect("report prompt runtime shutdown");
        });

        let shutdown_was_prompt = shutdown_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let owner_was_still_alive = child.try_wait().expect("query owner").is_none();
        if owner_was_still_alive {
            child.kill().expect("kill owner");
        }
        child.wait().expect("reap owner");
        runtime_thread.join().expect("watchdog runtime thread");

        assert!(
            owner_was_still_alive,
            "cancelling the watch must not terminate the owner"
        );
        assert!(
            shutdown_was_prompt,
            "cancelled owner watches must not leave runtime-blocking work"
        );
    }
}
