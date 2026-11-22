use super::windows_support::{self, windows_runtime_candidates};
use super::{
    agent_executable_name, agent_search_roots, bridge_binary_name, credential_layout, current,
    ensure_private_path_kind, resolve_manual_lan_host, valid_non_loopback_ipv4, CredentialLayout,
    PrivateAccessPrincipal, PrivatePathKind, PrivatePathState, SetupPreflightError,
    PRIVATE_ACCESS_PRINCIPALS,
};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlatformKind {
    #[cfg(target_os = "macos")]
    MacOs,
    #[cfg(target_os = "windows")]
    Windows,
    #[cfg(all(unix, not(target_os = "macos")))]
    Unix,
}

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
        Some(Ok("192.168.1.20".to_string())),
    );
    assert_eq!(
        resolve_manual_lan_host(Some("127.0.0.1")),
        Some(Err(SetupPreflightError::InvalidLanHost(
            "127.0.0.1".to_string()
        ))),
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
        Some("10.0.0.20".parse().unwrap()),
    );
    assert_eq!(
        select_local_ipv4([
            candidate("127.0.0.1".parse().unwrap(), 1, 1),
            candidate("0.0.0.0".parse().unwrap(), 2, 2),
            candidate("224.0.0.1".parse().unwrap(), 3, 3),
            candidate("255.255.255.255".parse().unwrap(), 4, 4),
        ]),
        None,
    );
    assert_eq!(
        windows_tailscale_install_candidates([PathBuf::from("ProgramFilesRoot")]),
        vec![PathBuf::from("ProgramFilesRoot")
            .join("Tailscale")
            .join("tailscale.exe")],
    );
    assert_eq!(
        windows_runtime_candidates(Path::new("package/bin/dappercode.exe"))[0],
        PathBuf::from("package"),
    );
    assert!(windows_runtime_candidates(Path::new("/")).is_empty());
    assert_eq!(
        windows_runtime_candidates(Path::new("package/dappercode.exe")),
        vec![PathBuf::from("package/runtime")],
    );
}

#[test]
fn private_access_policy_names_only_the_user_and_local_system() {
    assert_eq!(
        PRIVATE_ACCESS_PRINCIPALS,
        [
            PrivateAccessPrincipal::CurrentUser,
            PrivateAccessPrincipal::LocalSystem,
        ],
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
