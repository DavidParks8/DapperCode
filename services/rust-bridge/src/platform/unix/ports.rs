use std::collections::HashSet;

use crate::platform::{collect_ports_from_lsof, read_command_stdout, PlatformFuture};

pub(super) fn discover_unix_loopback_ports() -> PlatformFuture<Vec<u16>> {
    Box::pin(async {
        let mut ports = HashSet::new();
        if let Some(output) = read_command_stdout("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]).await {
            collect_ports_from_lsof(&output, &mut ports);
        }
        collect_linux_proc_ports(&mut ports).await;
        let mut result = ports.into_iter().collect::<Vec<_>>();
        result.sort_unstable();
        result.dedup();
        result
    })
}

async fn collect_linux_proc_ports(ports: &mut HashSet<u16>) {
    #[cfg(target_os = "linux")]
    {
        if let Ok(contents) = tokio::fs::read_to_string("/proc/net/tcp").await {
            collect_ports_from_linux_proc_net(&contents, false, ports);
        }
        if let Ok(contents) = tokio::fs::read_to_string("/proc/net/tcp6").await {
            collect_ports_from_linux_proc_net(&contents, true, ports);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = ports;
}

#[cfg(target_os = "linux")]
fn collect_ports_from_linux_proc_net(output: &str, is_ipv6: bool, ports: &mut HashSet<u16>) {
    for line in output.lines().skip(1) {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() < 4 || columns[3] != "0A" {
            continue;
        }
        let Some((address_hex, port_hex)) = columns[1].split_once(':') else {
            continue;
        };
        if linux_proc_address_is_loopback_or_any(address_hex, is_ipv6) {
            if let Ok(port) = u16::from_str_radix(port_hex, 16) {
                ports.insert(port);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_proc_address_is_loopback_or_any(value: &str, is_ipv6: bool) -> bool {
    if !is_ipv6 {
        return matches!(value, "00000000" | "0100007F");
    }
    matches!(
        value,
        "00000000000000000000000000000000"
            | "00000000000000000000000000000001"
            | "00000000000000000000000001000000"
    )
}
