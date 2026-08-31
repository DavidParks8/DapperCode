use std::{
    net::Ipv4Addr,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LocalIpv4Candidate {
    pub(crate) address: Ipv4Addr,
    pub(crate) metric: u32,
    pub(crate) interface_index: u32,
}

fn suitable_automatic_ipv4(address: Ipv4Addr) -> bool {
    !address.is_loopback()
        && !address.is_unspecified()
        && !address.is_link_local()
        && !address.is_multicast()
        && !address.is_broadcast()
}

pub(crate) fn select_local_ipv4(
    candidates: impl IntoIterator<Item = LocalIpv4Candidate>,
) -> Option<Ipv4Addr> {
    candidates
        .into_iter()
        .filter(|candidate| suitable_automatic_ipv4(candidate.address))
        .min_by_key(|candidate| {
            (
                candidate.metric,
                candidate.interface_index,
                candidate.address.octets(),
            )
        })
        .map(|candidate| candidate.address)
}

pub(crate) fn windows_tailscale_install_candidates(
    roots: impl IntoIterator<Item = PathBuf>,
) -> Vec<PathBuf> {
    roots
        .into_iter()
        .map(|root| root.join("Tailscale").join("tailscale.exe"))
        .collect()
}

pub(crate) fn windows_runtime_candidates(executable: &Path) -> Vec<PathBuf> {
    let Some(directory) = executable.parent() else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    if directory.file_name().is_some_and(|name| name == "bin") {
        if let Some(package_root) = directory.parent() {
            candidates.push(package_root.to_path_buf());
        }
    }
    candidates.push(directory.join("runtime"));
    candidates
}
