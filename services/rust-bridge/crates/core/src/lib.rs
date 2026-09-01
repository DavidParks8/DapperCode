#![cfg_attr(all(test, coverage_nightly), feature(coverage_attribute))]

//! Shared protocol primitives that must not depend on bridge runtime services.

mod bridge_error;
pub mod protocol_constants;
pub mod resource_limits;

pub use bridge_error::BridgeError;
