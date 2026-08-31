use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::Result;
use async_trait::async_trait;

use super::{
    home_dir, unix_common, CredentialLayout, NetworkMode, PlatformStrategy, ProcessStopRequest,
    SetupPreflightError,
};

pub(super) static STRATEGY: UnixStrategy = UnixStrategy;

pub(super) struct UnixStrategy;

#[async_trait]
impl PlatformStrategy for UnixStrategy {
    #[cfg(test)]
    fn kind(&self) -> super::PlatformKind {
        super::PlatformKind::Unix
    }

    fn data_dir(&self) -> Result<PathBuf> {
        match std::env::var_os("XDG_DATA_HOME") {
            Some(value) if !value.is_empty() => Ok(PathBuf::from(value).join("dappercode")),
            _ => Ok(home_dir()?.join(".local/share/dappercode")),
        }
    }

    fn runtime_candidates(&self, executable: &Path) -> Vec<PathBuf> {
        executable
            .parent()
            .map(|directory| {
                vec![
                    directory.join("../share/dappercode/runtime"),
                    directory.join("runtime"),
                ]
            })
            .unwrap_or_default()
    }

    fn bridge_binary_name(&self) -> &'static str {
        "dappercode-bridge"
    }

    fn agent_executable_name(&self, agent_id: &str) -> String {
        agent_id.to_string()
    }

    fn agent_search_roots(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    fn credential_layout(&self) -> CredentialLayout {
        CredentialLayout::SharedVault
    }

    fn resolve_bridge_host(
        &self,
        _mode: NetworkMode,
        _manual_lan_host: Option<&str>,
    ) -> Result<String, SetupPreflightError> {
        Err(SetupPreflightError::UnsupportedPlatform("Linux"))
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
