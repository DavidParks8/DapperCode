use super::unix_process_is_alive;

#[test]
fn process_probe_rejects_invalid_process_ids() {
    assert!(!unix_process_is_alive(u32::MAX));
    assert!(!unix_process_is_alive(i32::MAX as u32 + 1));
    assert!(!unix_process_is_alive(0));
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[cfg_attr(coverage_nightly, coverage(off))]
mod macos_tests {
    use super::super::{
        block_on_owner_exit, classify_kevent, configure_unix_git_command,
        kill_unix_git_process_group, try_kqueue_owner_watch, unix_process_is_alive, Command,
        Duration, WatchStep,
    };

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
            WatchStep::OwnerExited,
        );
        assert_eq!(classify_kevent(0, ErrorKind::Other), WatchStep::Retry);
        assert_eq!(
            classify_kevent(-1, ErrorKind::Interrupted),
            WatchStep::Retry,
        );
        assert_eq!(
            classify_kevent(-1, ErrorKind::PermissionDenied),
            WatchStep::Unavailable,
        );
        assert_eq!(
            classify_kevent(-1, ErrorKind::Other),
            WatchStep::Unavailable,
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
