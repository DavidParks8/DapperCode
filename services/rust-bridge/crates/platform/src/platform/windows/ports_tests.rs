use super::collect_ports_from_netstat;
use std::collections::HashSet;

#[test]
fn netstat_parser_collects_only_listening_tcp_ports() {
    let mut ports = HashSet::new();
    collect_ports_from_netstat(
        "TCP 127.0.0.1:3000 0.0.0.0:0 LISTENING 42\n\
         TCP 10.0.0.1:4000 0.0.0.0:0 LISTENING 43\n\
         UDP 127.0.0.1:5000 *:* 44",
        &mut ports,
    );
    assert_eq!(ports, HashSet::from([3000]));
}
