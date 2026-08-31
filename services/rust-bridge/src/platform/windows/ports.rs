use std::collections::HashSet;

use crate::platform::{
    collect_ports_from_lsof, parse_listening_socket_port, read_command_stdout, PlatformFuture,
};

pub(super) fn discover_windows_loopback_ports() -> PlatformFuture<Vec<u16>> {
    Box::pin(async {
        let mut ports = HashSet::new();
        if let Some(output) = read_command_stdout("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]).await {
            collect_ports_from_lsof(&output, &mut ports);
        }
        if let Some(output) = read_command_stdout("netstat", &["-ano", "-p", "tcp"]).await {
            collect_ports_from_netstat(&output, &mut ports);
        }
        let mut result = ports.into_iter().collect::<Vec<_>>();
        result.sort_unstable();
        result.dedup();
        result
    })
}

fn collect_ports_from_netstat(output: &str, ports: &mut HashSet<u16>) {
    for line in output.lines() {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() >= 4 && columns[0] == "TCP" && columns[3] == "LISTENING" {
            if let Some(port) = parse_listening_socket_port(columns[1]) {
                ports.insert(port);
            }
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

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
}
