#![cfg_attr(all(test, coverage_nightly), feature(coverage_attribute))]

//! Stable configuration, storage, platform, and lifecycle services for the desktop operator.

mod broker_supervisor;
mod config;
mod platform;
mod platform_setup;
mod secrets;
mod setup;
mod store;
mod supervisor;

pub use broker_supervisor::{BrokerLifecycleAction, BrokerSupervisor};
pub use config::{
    runtime_executable_available, validate_workspace, BridgeRuntimeConfig, RuntimePaths,
};
pub use platform::{
    process_start_identity, stop_child, wait_for_shutdown_signal, NetworkMode, SetupPreflightError,
};
pub use platform_setup::resolve_bridge_host;
pub use secrets::{BridgeSecret, SecretBackend, SecretStore};
pub use setup::{
    discover_agent_executable, refresh_registered_agent, setup_profile, AgentRefresh, SetupRequest,
    SetupResult,
};
pub use store::{
    profile_id_for, AppConfig, AppPaths, BrokerEndpoint, BrokerSettings, FileLease, Profile,
    ProfileAgent,
};
pub use supervisor::{BridgeSnapshot, BridgeState, BridgeSupervisor};
