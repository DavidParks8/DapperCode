use std::{io, process::Command, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use sysinfo::{Pid, ProcessesToUpdate, Signal, System};

use super::ProcessStopRequest;

pub(super) fn process_start_identity(_pid: u32, sysinfo_start_time: u64) -> Result<u64> {
    Ok(sysinfo_start_time)
}

pub(super) fn request_process_stop(
    pid: u32,
    _expected_start_time: u64,
    request: ProcessStopRequest,
) -> Result<bool> {
    let signal = match request {
        ProcessStopRequest::Graceful => Signal::Term,
        ProcessStopRequest::Force => Signal::Kill,
    };
    let mut system = System::new();
    let sysinfo_pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[sysinfo_pid]), true);
    let process = system
        .process(sysinfo_pid)
        .ok_or_else(|| anyhow!("bridge process {pid} no longer exists"))?;
    match process.kill_with(signal) {
        Some(true) => Ok(true),
        Some(false) => bail!("operating system refused to signal bridge process {pid}"),
        None => bail!("requested process signal is not supported on this platform"),
    }
}

pub(super) fn detach_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

pub(super) fn sync_parent_directory(path: &std::path::Path) -> io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}

pub(super) async fn stop_child(
    child: &mut tokio::process::Child,
    graceful_timeout: Duration,
) -> Result<()> {
    let pid = child.id().context("worker process id is unavailable")?;
    let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    if result != 0 {
        return Err(io::Error::last_os_error()).context("failed to stop worker");
    }
    if tokio::time::timeout(graceful_timeout, child.wait())
        .await
        .is_ok()
    {
        return Ok(());
    }
    child.kill().await.context("failed to kill worker")?;
    let _ = child.wait().await;
    Ok(())
}

pub(super) async fn wait_for_shutdown_signal() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}
