use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::Result;
use async_trait::async_trait;

use super::{
    home_dir, resolve_manual_lan_host, unix_common, valid_non_loopback_ipv4, CredentialLayout,
    NetworkMode, PlatformStrategy, ProcessStopRequest, SetupPreflightError,
};

pub(super) static STRATEGY: MacOsStrategy = MacOsStrategy;

pub(super) struct MacOsStrategy;

#[async_trait]
impl PlatformStrategy for MacOsStrategy {
    #[cfg(test)]
    fn kind(&self) -> super::PlatformKind {
        super::PlatformKind::MacOs
    }

    fn data_dir(&self) -> Result<PathBuf> {
        Ok(home_dir()?
            .join("Library/Application Support")
            .join("dev.dappercode.desktop"))
    }

    fn runtime_candidates(&self, executable: &Path) -> Vec<PathBuf> {
        executable
            .parent()
            .and_then(Path::parent)
            .map(|resources| vec![resources.to_path_buf()])
            .unwrap_or_default()
    }

    fn bridge_binary_name(&self) -> &'static str {
        "dappercode-bridge"
    }

    fn agent_executable_name(&self, agent_id: &str) -> String {
        agent_id.to_string()
    }

    fn agent_search_roots(&self) -> Vec<PathBuf> {
        vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]
    }

    fn credential_layout(&self) -> CredentialLayout {
        CredentialLayout::SharedVault
    }

    fn resolve_bridge_host(
        &self,
        mode: NetworkMode,
        manual_lan_host: Option<&str>,
    ) -> Result<String, SetupPreflightError> {
        match mode {
            NetworkMode::Tailscale => resolve_tailscale_host(),
            NetworkMode::Local => resolve_lan_host(manual_lan_host),
        }
    }

    fn process_start_identity(&self, pid: u32, sysinfo_start_time: u64) -> Result<u64> {
        unix_common::process_start_identity(pid, sysinfo_start_time)
    }

    fn request_process_stop(
        &self,
        pid: u32,
        expected_start_time: u64,
        request: ProcessStopRequest,
    ) -> Result<bool> {
        unix_common::request_process_stop(pid, expected_start_time, request)
    }

    fn configure_private_file_options(&self, options: &mut OpenOptions) {
        unix_common::configure_private_file_options(options);
    }

    fn secure_private_directory(&self, path: &Path) -> Result<()> {
        unix_common::secure_private_directory(path)
    }

    fn secure_private_file(&self, path: &Path, file: &File) -> Result<()> {
        unix_common::secure_private_file(path, file)
    }

    fn detach_process(&self, command: &mut Command) {
        unix_common::detach_process(command);
    }

    fn sync_parent_directory(&self, path: &Path) -> std::io::Result<()> {
        unix_common::sync_parent_directory(path)
    }

    async fn stop_child(
        &self,
        child: &mut tokio::process::Child,
        graceful_timeout: Duration,
    ) -> Result<()> {
        unix_common::stop_child(child, graceful_timeout).await
    }

    async fn wait_for_shutdown_signal(&self) {
        unix_common::wait_for_shutdown_signal().await;
    }
}

fn resolve_tailscale_host() -> Result<String, SetupPreflightError> {
    let tailscale = command_path("tailscale").ok_or(SetupPreflightError::MissingTailscale)?;
    let output = Command::new(tailscale)
        .args(["ip", "-4"])
        .output()
        .map_err(|error| SetupPreflightError::ProbeFailed(error.to_string()))?;
    if !output.status.success() {
        return Err(SetupPreflightError::TailscaleDisconnected);
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|value| valid_non_loopback_ipv4(value))
        .map(str::to_string)
        .ok_or(SetupPreflightError::TailscaleDisconnected)
}

fn resolve_lan_host(manual_lan_host: Option<&str>) -> Result<String, SetupPreflightError> {
    if let Some(result) = resolve_manual_lan_host(manual_lan_host) {
        return result;
    }

    for interface in ["en0", "en1"] {
        let output = Command::new("/usr/sbin/ipconfig")
            .args(["getifaddr", interface])
            .output();
        let Ok(output) = output else { continue };
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && valid_non_loopback_ipv4(&value) {
            return Ok(value);
        }
    }
    Err(SetupPreflightError::LanHostRequired)
}

fn command_path(command: &str) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path));
    }
    candidates.extend([
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
    ]);
    if command == "tailscale" {
        candidates.push("/Applications/Tailscale.app/Contents/MacOS".into());
    }
    candidates
        .into_iter()
        .map(|directory| directory.join(command))
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.display().to_string())
}
