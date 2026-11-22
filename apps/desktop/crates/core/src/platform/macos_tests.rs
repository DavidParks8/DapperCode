use super::{
    command_path, resolve_lan_host, resolve_lan_host_with_probe, tailscale_ipv4_from_output,
    CredentialLayout, Path, PathBuf, PlatformStrategy, SetupPreflightError, STRATEGY,
};

#[test]
fn models_runtime_and_agent_paths() {
    assert_eq!(
        STRATEGY.runtime_candidates(Path::new(
            "/Applications/DapperCode.app/Contents/Resources/bin/dappercode"
        )),
        vec![PathBuf::from(
            "/Applications/DapperCode.app/Contents/Resources"
        )],
    );
    assert!(STRATEGY.runtime_candidates(Path::new("/")).is_empty());
    assert_eq!(STRATEGY.agent_executable_name("opencode"), "opencode");
    assert_eq!(STRATEGY.credential_layout(), CredentialLayout::SharedVault);
}

#[test]
fn validates_manual_lan_addresses_without_probing_interfaces() {
    assert_eq!(
        resolve_lan_host(Some(" 192.168.1.20 ")).unwrap(),
        "192.168.1.20",
    );
    assert!(matches!(
        resolve_lan_host(Some("127.0.0.1")),
        Err(SetupPreflightError::InvalidLanHost(_))
    ));
}

#[test]
fn parses_connected_tailscale_output() {
    assert_eq!(
        tailscale_ipv4_from_output(b"\n127.0.0.1\n 100.100.10.20 \n").unwrap(),
        "100.100.10.20",
    );
    assert!(matches!(
        tailscale_ipv4_from_output(b"127.0.0.1\n0.0.0.0\n"),
        Err(SetupPreflightError::TailscaleDisconnected)
    ));
}

#[test]
fn command_lookup_handles_known_and_missing_commands() {
    assert!(command_path("sh").is_some());
    assert!(command_path("definitely-not-a-dappercode-command").is_none());
    let _ = command_path("tailscale");
}

#[test]
fn automatic_lan_probe_uses_the_first_valid_interface_address() {
    let mut probed = Vec::new();
    let host = resolve_lan_host_with_probe(None, |interface| {
        probed.push(interface.to_string());
        match interface {
            "en0" => Some((true, b"127.0.0.1\n".to_vec())),
            "en1" => Some((true, b" 192.168.1.42 \n".to_vec())),
            _ => None,
        }
    })
    .unwrap();
    assert_eq!(host, "192.168.1.42");
    assert_eq!(probed, ["en0", "en1"]);
}

#[test]
fn automatic_lan_probe_rejects_failures_and_invalid_addresses() {
    assert!(matches!(
        resolve_lan_host_with_probe(None, |interface| match interface {
            "en0" => None,
            "en1" => Some((false, b"192.168.1.42\n".to_vec())),
            _ => unreachable!(),
        }),
        Err(SetupPreflightError::LanHostRequired)
    ));
    assert!(matches!(
        resolve_lan_host_with_probe(None, |_| Some((true, b"not-an-address\n".to_vec()))),
        Err(SetupPreflightError::LanHostRequired)
    ));
}

#[test]
fn manual_lan_host_bypasses_interface_probes() {
    let host = resolve_lan_host_with_probe(Some(" 10.0.0.8 "), |_| {
        panic!("manual addresses must not probe interfaces")
    })
    .unwrap();
    assert_eq!(host, "10.0.0.8");
}
