use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
    process::Command,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use sysinfo::{Pid, ProcessesToUpdate, Signal, System};

use super::{ensure_private_path_kind, PrivatePathKind, PrivatePathState, ProcessStopRequest};

pub(super) fn process_start_identity(_pid: u32, sysinfo_start_time: u64) -> Result<u64> {
    Ok(sysinfo_start_time)
}

pub(super) fn request_process_stop(
    pid: u32,
    expected_start_time: u64,
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
    if process_start_identity(pid, process.start_time())? != expected_start_time {
        bail!("refusing to signal bridge process {pid} because its start identity changed");
    }
    match process.kill_with(signal) {
        Some(true) => Ok(true),
        Some(false) => bail!("operating system refused to signal bridge process {pid}"),
        None => bail!("requested process signal is not supported on this platform"),
    }
}

pub(super) fn configure_private_file_options(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
}

pub(super) fn secure_private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .with_context(|| format!("failed to open private directory {}", path.display()))?;
    let metadata = directory
        .metadata()
        .with_context(|| format!("failed to inspect private directory {}", path.display()))?;
    ensure_private_path_kind(
        path,
        PrivatePathKind::Directory,
        PrivatePathState {
            is_directory: metadata.is_dir(),
            is_file: metadata.is_file(),
            is_reparse_point: metadata.file_type().is_symlink(),
        },
    )?;
    let mut permissions = metadata.permissions();
    if permissions.mode() & 0o777 != 0o700 {
        permissions.set_mode(0o700);
        directory
            .set_permissions(permissions)
            .with_context(|| format!("failed to restrict {}", path.display()))?;
    }
    Ok(())
}

pub(super) fn secure_private_file(path: &Path, file: &File) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = file
        .metadata()
        .with_context(|| format!("failed to inspect private file {}", path.display()))?;
    ensure_private_path_kind(
        path,
        PrivatePathKind::File,
        PrivatePathState {
            is_directory: metadata.is_dir(),
            is_file: metadata.is_file(),
            is_reparse_point: metadata.file_type().is_symlink(),
        },
    )?;
    let mut permissions = metadata.permissions();
    if permissions.mode() & 0o777 != 0o600 {
        permissions.set_mode(0o600);
        file.set_permissions(permissions)
            .with_context(|| format!("failed to restrict {}", path.display()))?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    #[test]
    fn process_stop_rejects_a_stale_start_identity_before_signalling() {
        let pid = std::process::id();
        let mut system = System::new();
        let sysinfo_pid = Pid::from_u32(pid);
        system.refresh_processes(ProcessesToUpdate::Some(&[sysinfo_pid]), true);
        let start_time = system.process(sysinfo_pid).unwrap().start_time();

        let error =
            request_process_stop(pid, start_time.saturating_add(1), ProcessStopRequest::Force)
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
            Some("READY")
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
            Some("TERM_ACK")
        );
        assert!(child.try_wait().unwrap().expect("fixture exited").success());
    }
}
