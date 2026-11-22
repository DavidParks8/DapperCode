#[cfg(unix)]
use super::read_command_stdout;
use super::{
    collect_ports_from_lsof, owner_identity_matches, parse_listening_socket_port,
    zero_timeout_wait_means_alive, CurrentPlatform, PlatformStrategy,
};
use std::collections::HashSet;

#[test]
fn platform_strategy_is_complete() {
    fn assert_strategy<Strategy: PlatformStrategy>() {}
    assert_strategy::<CurrentPlatform>();
}

#[test]
fn socket_parser_rejects_non_loopback_and_malformed_addresses() {
    for (value, expected) in [
        ("*:3000", Some(3000)),
        ("127.0.0.1:5173", Some(5173)),
        ("0.0.0.0:8080", Some(8080)),
        ("localhost:4200", Some(4200)),
        ("[::1]:4321", Some(4321)),
        ("[::]:8000", Some(8000)),
        ("10.0.0.1:3000", None),
        ("[2001:db8::1]:3000", None),
        ("[::1]3000", None),
        ("localhost:not-a-port", None),
        ("missing-port", None),
    ] {
        assert_eq!(parse_listening_socket_port(value), expected, "{value}");
    }
}

#[test]
fn lsof_parser_collects_only_loopback_listeners() {
    let mut ports = HashSet::new();
    collect_ports_from_lsof(
        "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n\
         node 1 user 1u IPv4 0 0t0 TCP 127.0.0.1:3000 (LISTEN)\n\
         node 2 user 1u IPv4 0 0t0 UDP 127.0.0.1:4000\n\
         node 3 user 1u IPv4 0 0t0 TCP 10.0.0.1:5000 (LISTEN)\n\
         malformed TCP missing (LISTEN)",
        &mut ports,
    );
    assert_eq!(ports, HashSet::from([3000]));
}

#[cfg(unix)]
#[tokio::test]
async fn command_reader_distinguishes_success_failure_and_missing_program() {
    assert_eq!(
        read_command_stdout("/bin/sh", &["-c", "printf success"])
            .await
            .as_deref(),
        Some("success"),
    );
    assert!(read_command_stdout("/bin/sh", &["-c", "exit 1"])
        .await
        .is_none());
    assert!(read_command_stdout("/definitely/missing/program", &[])
        .await
        .is_none());
}

#[test]
fn process_identity_and_bounded_wait_results_fail_closed() {
    assert!(owner_identity_matches(Some(42), 42));
    assert!(!owner_identity_matches(Some(41), 42));
    assert!(!owner_identity_matches(None, 42));

    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    const WAIT_FAILED: u32 = u32::MAX;
    assert!(zero_timeout_wait_means_alive(WAIT_TIMEOUT, WAIT_TIMEOUT));
    assert!(!zero_timeout_wait_means_alive(WAIT_OBJECT_0, WAIT_TIMEOUT));
    assert!(!zero_timeout_wait_means_alive(WAIT_FAILED, WAIT_TIMEOUT));
}
