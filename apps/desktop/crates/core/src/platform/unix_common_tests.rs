use super::{
    request_process_stop, stop_child, Duration, Pid, ProcessStopRequest, ProcessesToUpdate, System,
};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

#[test]
fn process_stop_rejects_a_stale_start_identity_before_signalling() {
    let pid = std::process::id();
    let mut system = System::new().unwrap();
    let sysinfo_pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[sysinfo_pid]), true);
    let start_time = system.process(sysinfo_pid).unwrap().start_time();

    let error = request_process_stop(pid, start_time.saturating_add(1), ProcessStopRequest::Force)
        .unwrap_err();

    assert!(error.to_string().contains("start identity changed"));
}

#[tokio::test]
async fn stop_child_terminates_an_owned_running_process_gracefully() {
    let mut child = tokio::process::Command::new("/bin/sh")
        .args([
            "-c",
            "trap 'echo TERM_ACK; exit 0' TERM; echo READY; while :; do :; done",
        ])
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn owned fixture");
    let mut stdout = BufReader::new(child.stdout.take().expect("fixture stdout")).lines();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), stdout.next_line())
            .await
            .expect("fixture announces readiness")
            .expect("read fixture readiness")
            .as_deref(),
        Some("READY"),
    );

    stop_child(&mut child, Duration::from_secs(2))
        .await
        .expect("graceful process stop");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), stdout.next_line())
            .await
            .expect("fixture acknowledges SIGTERM")
            .expect("read fixture acknowledgement")
            .as_deref(),
        Some("TERM_ACK"),
    );
    assert!(child.try_wait().unwrap().expect("fixture exited").success());
}
