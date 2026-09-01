use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::{bail, Result};
use async_trait::async_trait;

use crate::{
    secrets::{BridgeSecret, SecretBackend, SecretStore},
    store::AppPaths,
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(unix, not(target_os = "macos")))]
mod unix;
#[cfg(unix)]
mod unix_common;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(any(target_os = "windows", test))]
pub(crate) mod windows_credentials;
#[cfg(any(target_os = "windows", test))]
mod windows_support;

#[cfg(target_os = "macos")]
use macos::STRATEGY;
#[cfg(all(unix, not(target_os = "macos")))]
use unix::STRATEGY;
#[cfg(target_os = "windows")]
use windows::STRATEGY;

#[cfg(not(any(unix, target_os = "windows")))]
compile_error!("DapperCode desktop supports macOS, Windows, and Unix platforms");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CredentialLayout {
    SharedVault,
    #[cfg(any(target_os = "windows", test))]
    WindowsPerProfile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessStopRequest {
    Graceful,
    Force,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PrivatePathKind {
    Directory,
    File,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PrivatePathState {
    pub(crate) is_directory: bool,
    pub(crate) is_file: bool,
    pub(crate) is_reparse_point: bool,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PrivateAccessPrincipal {
    CurrentUser,
    LocalSystem,
}

#[cfg(any(target_os = "windows", test))]
pub(crate) const PRIVATE_ACCESS_PRINCIPALS: [PrivateAccessPrincipal; 2] = [
    PrivateAccessPrincipal::CurrentUser,
    PrivateAccessPrincipal::LocalSystem,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NetworkMode {
    Tailscale,
    Local,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SetupPreflightError {
    MissingTailscale,
    TailscaleDisconnected,
    LanHostRequired,
    InvalidLanHost(String),
    #[allow(dead_code)]
    UnsupportedPlatform(&'static str),
    ProbeFailed(String),
}

impl std::fmt::Display for SetupPreflightError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingTailscale => write!(formatter, "Tailscale is not installed"),
            Self::TailscaleDisconnected => {
                write!(formatter, "Tailscale is installed but not connected")
            }
            Self::LanHostRequired => write!(formatter, "A local network IPv4 address is required"),
            Self::InvalidLanHost(value) => write!(formatter, "Invalid local IPv4 address: {value}"),
            Self::UnsupportedPlatform(platform) => {
                write!(
                    formatter,
                    "Graphical bridge setup is not yet available on {platform}"
                )
            }
            Self::ProbeFailed(message) => write!(formatter, "Network preflight failed: {message}"),
        }
    }
}

impl std::error::Error for SetupPreflightError {}

#[cfg(test)]
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlatformKind {
    MacOs,
    Windows,
    Unix,
}

#[async_trait]
pub(crate) trait PlatformStrategy: Sync {
    #[cfg(test)]
    fn kind(&self) -> PlatformKind;

    fn data_dir(&self) -> Result<PathBuf>;
    fn runtime_candidates(&self, executable: &Path) -> Vec<PathBuf>;
    fn bridge_binary_name(&self) -> &'static str;
    fn agent_executable_name(&self, agent_id: &str) -> String;
    fn agent_search_roots(&self) -> Vec<PathBuf>;
    fn credential_layout(&self) -> CredentialLayout;
    fn resolve_bridge_host(
        &self,
        mode: NetworkMode,
        manual_lan_host: Option<&str>,
    ) -> Result<String, SetupPreflightError>;
    fn process_start_identity(&self, pid: u32, sysinfo_start_time: u64) -> Result<u64>;
    fn request_process_stop(
        &self,
        pid: u32,
        expected_start_time: u64,
        request: ProcessStopRequest,
    ) -> Result<bool>;
    fn configure_private_file_options(&self, options: &mut OpenOptions);
    fn secure_private_directory(&self, path: &Path) -> Result<()>;
    fn secure_private_file(&self, path: &Path, file: &File) -> Result<()>;
    fn detach_process(&self, command: &mut Command);
    fn sync_parent_directory(&self, path: &Path) -> std::io::Result<()>;
    async fn stop_child(
        &self,
        child: &mut tokio::process::Child,
        graceful_timeout: Duration,
    ) -> Result<()>;
    async fn wait_for_shutdown_signal(&self);
}

pub(crate) fn current() -> &'static dyn PlatformStrategy {
    &STRATEGY
}

pub(crate) fn data_dir() -> Result<PathBuf> {
    current().data_dir()
}

pub(crate) fn runtime_candidates(executable: &Path) -> Vec<PathBuf> {
    current().runtime_candidates(executable)
}

pub(crate) fn bridge_binary_name() -> &'static str {
    current().bridge_binary_name()
}

pub(crate) fn agent_executable_name(agent_id: &str) -> String {
    current().agent_executable_name(agent_id)
}

pub(crate) fn agent_search_roots() -> Vec<PathBuf> {
    current().agent_search_roots()
}

pub(crate) fn credential_layout() -> CredentialLayout {
    current().credential_layout()
}

pub(crate) fn resolve_bridge_host(
    mode: NetworkMode,
    manual_lan_host: Option<&str>,
) -> Result<String, SetupPreflightError> {
    current().resolve_bridge_host(mode, manual_lan_host)
}

pub fn process_start_identity(pid: u32, sysinfo_start_time: u64) -> Result<u64> {
    current().process_start_identity(pid, sysinfo_start_time)
}

pub(crate) fn request_process_stop(
    pid: u32,
    expected_start_time: u64,
    request: ProcessStopRequest,
) -> Result<bool> {
    current().request_process_stop(pid, expected_start_time, request)
}

pub(crate) fn configure_private_file_options(options: &mut OpenOptions) {
    current().configure_private_file_options(options);
}

pub(crate) fn secure_private_directory(path: &Path) -> Result<()> {
    current().secure_private_directory(path)
}

pub(crate) fn secure_private_file(path: &Path, file: &File) -> Result<()> {
    current().secure_private_file(path, file)
}

pub(crate) fn detach_process(command: &mut Command) {
    current().detach_process(command);
}

pub(crate) fn sync_parent_directory(path: &Path) -> std::io::Result<()> {
    current().sync_parent_directory(path)
}

pub async fn stop_child(
    child: &mut tokio::process::Child,
    graceful_timeout: Duration,
) -> Result<()> {
    current().stop_child(child, graceful_timeout).await
}

pub async fn wait_for_shutdown_signal() {
    current().wait_for_shutdown_signal().await;
}

pub(crate) fn valid_non_loopback_ipv4(value: &str) -> bool {
    value
        .parse::<std::net::Ipv4Addr>()
        .is_ok_and(|address| !address.is_loopback() && !address.is_unspecified())
}

pub(crate) fn resolve_manual_lan_host(
    manual_lan_host: Option<&str>,
) -> Option<Result<String, SetupPreflightError>> {
    manual_lan_host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|manual| {
            if valid_non_loopback_ipv4(manual) {
                Ok(manual.to_string())
            } else {
                Err(SetupPreflightError::InvalidLanHost(manual.to_string()))
            }
        })
}

pub(crate) fn ensure_private_path_kind(
    path: &Path,
    expected: PrivatePathKind,
    state: PrivatePathState,
) -> Result<()> {
    let matches_kind = match expected {
        PrivatePathKind::Directory => state.is_directory && !state.is_file,
        PrivatePathKind::File => state.is_file && !state.is_directory,
    };
    if state.is_reparse_point || !matches_kind {
        bail!(
            "refusing unsafe private {} path {}",
            match expected {
                PrivatePathKind::Directory => "directory",
                PrivatePathKind::File => "file",
            },
            path.display()
        );
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn home_dir() -> Result<PathBuf> {
    match std::env::var_os("HOME") {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => anyhow::bail!("HOME is not set; cannot locate the DapperCode data directory"),
    }
}

pub(crate) fn secret_get_vault(
    layout: CredentialLayout,
    store: &SecretStore,
    paths: &AppPaths,
    profile_id: &str,
) -> Result<Option<BridgeSecret>> {
    match layout {
        CredentialLayout::SharedVault => store.get_shared_vault(paths, profile_id),
        #[cfg(any(target_os = "windows", test))]
        CredentialLayout::WindowsPerProfile => windows_credentials::get(store, paths, profile_id),
    }
}

pub(crate) fn secret_get_or_create(
    layout: CredentialLayout,
    store: &SecretStore,
    paths: &AppPaths,
    profile_id: &str,
) -> Result<(BridgeSecret, bool)> {
    match layout {
        CredentialLayout::SharedVault => store.get_or_create_shared(paths, profile_id),
        #[cfg(any(target_os = "windows", test))]
        CredentialLayout::WindowsPerProfile => {
            windows_credentials::get_or_create(store, paths, profile_id)
        }
    }
}

pub(crate) fn secret_ensure_profiles(
    layout: CredentialLayout,
    store: &SecretStore,
    paths: &AppPaths,
    profile_ids: &[String],
) -> Result<Option<SecretBackend>> {
    match layout {
        CredentialLayout::SharedVault => store.ensure_shared_profiles(paths, profile_ids),
        #[cfg(any(target_os = "windows", test))]
        CredentialLayout::WindowsPerProfile => {
            windows_credentials::ensure_profiles(store, paths, profile_ids)
        }
    }
}

pub(crate) fn secret_refresh(
    layout: CredentialLayout,
    store: &SecretStore,
    paths: &AppPaths,
) -> Result<()> {
    match layout {
        CredentialLayout::SharedVault => store.refresh_shared(paths),
        #[cfg(any(target_os = "windows", test))]
        CredentialLayout::WindowsPerProfile => windows_credentials::refresh(store, paths),
    }
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) fn secret_set(
    layout: CredentialLayout,
    store: &SecretStore,
    paths: &AppPaths,
    profile_id: &str,
    token: &str,
) -> Result<BridgeSecret> {
    match layout {
        CredentialLayout::SharedVault => store.set_shared(paths, profile_id, token),
        #[cfg(any(target_os = "windows", test))]
        CredentialLayout::WindowsPerProfile => {
            windows_credentials::set(store, paths, profile_id, token)
        }
    }
}

pub(crate) fn secret_delete(
    layout: CredentialLayout,
    store: &SecretStore,
    paths: &AppPaths,
    profile_id: &str,
) -> Result<()> {
    match layout {
        CredentialLayout::SharedVault => store.delete_shared(paths, profile_id),
        #[cfg(any(target_os = "windows", test))]
        CredentialLayout::WindowsPerProfile => {
            windows_credentials::delete(store, paths, profile_id)
        }
    }
}

#[cfg(test)]
pub(crate) use windows_support::windows_runtime_candidates;

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn selects_the_macos_strategy_and_conventions() {
        assert_eq!(current().kind(), PlatformKind::MacOs);
        assert_eq!(bridge_binary_name(), "dappercode-bridge");
        assert_eq!(agent_executable_name("copilot"), "copilot");
        assert_eq!(credential_layout(), CredentialLayout::SharedVault);
        assert!(agent_search_roots().contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn selects_the_windows_strategy_and_conventions() {
        assert_eq!(current().kind(), PlatformKind::Windows);
        assert_eq!(bridge_binary_name(), "dappercode-bridge.exe");
        assert_eq!(agent_executable_name("copilot"), "copilot.exe");
        assert_eq!(credential_layout(), CredentialLayout::WindowsPerProfile);
        assert!(agent_search_roots().is_empty());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn selects_the_unix_strategy_and_conventions() {
        assert_eq!(current().kind(), PlatformKind::Unix);
        assert_eq!(bridge_binary_name(), "dappercode-bridge");
        assert_eq!(agent_executable_name("copilot"), "copilot");
        assert_eq!(credential_layout(), CredentialLayout::SharedVault);
        assert!(agent_search_roots().is_empty());
    }

    #[test]
    fn validates_and_trims_manual_lan_addresses() {
        assert!(valid_non_loopback_ipv4("192.168.1.20"));
        assert!(!valid_non_loopback_ipv4("127.0.0.1"));
        assert_eq!(
            resolve_manual_lan_host(Some(" 192.168.1.20 ")),
            Some(Ok("192.168.1.20".to_string()))
        );
        assert_eq!(
            resolve_manual_lan_host(Some("127.0.0.1")),
            Some(Err(SetupPreflightError::InvalidLanHost(
                "127.0.0.1".to_string()
            )))
        );
    }

    #[test]
    fn models_windows_paths_and_address_selection_without_win32_calls() {
        use windows_support::{
            select_local_ipv4, windows_tailscale_install_candidates, LocalIpv4Candidate,
        };

        let candidate = |address, metric, interface_index| LocalIpv4Candidate {
            address,
            metric,
            interface_index,
        };
        assert_eq!(
            select_local_ipv4([
                candidate("169.254.10.2".parse().unwrap(), 1, 1),
                candidate("192.168.1.50".parse().unwrap(), 25, 12),
                candidate("10.0.0.20".parse().unwrap(), 10, 10),
            ]),
            Some("10.0.0.20".parse().unwrap())
        );
        assert_eq!(
            select_local_ipv4([
                candidate("127.0.0.1".parse().unwrap(), 1, 1),
                candidate("0.0.0.0".parse().unwrap(), 2, 2),
                candidate("224.0.0.1".parse().unwrap(), 3, 3),
                candidate("255.255.255.255".parse().unwrap(), 4, 4),
            ]),
            None
        );
        assert_eq!(
            windows_tailscale_install_candidates([PathBuf::from("ProgramFilesRoot")]),
            vec![PathBuf::from("ProgramFilesRoot")
                .join("Tailscale")
                .join("tailscale.exe")]
        );
        assert_eq!(
            windows_runtime_candidates(Path::new("package/bin/dappercode.exe"))[0],
            PathBuf::from("package")
        );
        assert!(windows_runtime_candidates(Path::new("/")).is_empty());
        assert_eq!(
            windows_runtime_candidates(Path::new("package/dappercode.exe")),
            vec![PathBuf::from("package/runtime")]
        );
    }

    #[test]
    fn private_access_policy_names_only_the_user_and_local_system() {
        assert_eq!(
            PRIVATE_ACCESS_PRINCIPALS,
            [
                PrivateAccessPrincipal::CurrentUser,
                PrivateAccessPrincipal::LocalSystem,
            ]
        );
    }

    #[test]
    fn private_path_policy_rejects_reparse_points_and_wrong_object_kinds() {
        let path = Path::new("private-target");
        assert!(ensure_private_path_kind(
            path,
            PrivatePathKind::Directory,
            PrivatePathState {
                is_directory: true,
                is_file: false,
                is_reparse_point: false,
            },
        )
        .is_ok());
        assert!(ensure_private_path_kind(
            path,
            PrivatePathKind::File,
            PrivatePathState {
                is_directory: false,
                is_file: true,
                is_reparse_point: false,
            },
        )
        .is_ok());

        for (kind, state) in [
            (
                PrivatePathKind::Directory,
                PrivatePathState {
                    is_directory: true,
                    is_file: false,
                    is_reparse_point: true,
                },
            ),
            (
                PrivatePathKind::Directory,
                PrivatePathState {
                    is_directory: false,
                    is_file: true,
                    is_reparse_point: false,
                },
            ),
            (
                PrivatePathKind::File,
                PrivatePathState {
                    is_directory: true,
                    is_file: false,
                    is_reparse_point: false,
                },
            ),
        ] {
            assert!(ensure_private_path_kind(path, kind, state).is_err());
        }
    }
}
