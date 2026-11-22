//! Ties a bridge's lifetime to the desktop app that launched it.
//!
//! The bridge runs detached so it survives the short-lived operator invocation that starts it. That
//! also means a force-quit, crash, or `SIGKILL` of the desktop app would otherwise leave an
//! authenticated bridge listening on the LAN or tailnet with no UI left to stop it. The desktop app
//! therefore passes its own process ID as `BRIDGE_OWNER_PID`, and the bridge shuts itself down as
//! soon as that process goes away.

use dappercode_bridge_platform::{
    process_is_alive, wait_for_owner_exit as wait_for_platform_owner_exit,
};

/// Reads and validates `BRIDGE_OWNER_PID`.
///
/// Returns `Ok(None)` when unset, so the development flow (`pnpm run bridge`) keeps running without
/// an owner.
pub(crate) fn owner_pid_from_env() -> Result<Option<u32>, String> {
    let raw = std::env::var("BRIDGE_OWNER_PID").ok();
    parse_owner_pid(raw.as_deref())
}

fn parse_owner_pid(raw: Option<&str>) -> Result<Option<u32>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match trimmed.parse::<u32>() {
        Ok(pid) if pid > 0 => Ok(Some(pid)),
        _ => Err("BRIDGE_OWNER_PID must be a positive process ID".to_string()),
    }
}

/// Resolves once the owning process has exited.
///
/// Never resolves when there is no owner, so it can sit in a `select!` alongside signal handling.
pub(crate) async fn wait_for_owner_exit(owner_pid: Option<u32>) {
    let Some(owner_pid) = owner_pid else {
        std::future::pending::<()>().await;
        return;
    };
    if !process_is_alive(owner_pid) {
        return;
    }
    wait_for_platform_owner_exit(owner_pid).await;
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "owner_watchdog_tests.rs"]
mod tests;
