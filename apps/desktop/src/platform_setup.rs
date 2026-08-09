pub use crate::platform::{NetworkMode, SetupPreflightError};

pub fn resolve_bridge_host(
    mode: NetworkMode,
    manual_lan_host: Option<&str>,
) -> Result<String, SetupPreflightError> {
    crate::platform::resolve_bridge_host(mode, manual_lan_host)
}
