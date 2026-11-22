#![cfg_attr(all(test, coverage_nightly), feature(coverage_attribute))]
#![cfg_attr(dylint_lib = "perfectionist", feature(register_tool))]
#![cfg_attr(dylint_lib = "perfectionist", register_tool(perfectionist))]
#![forbid(unsafe_code)]

//! Shared protocol primitives that must not depend on bridge runtime services.

pub mod protocol_constants;
pub mod resource_limits;

pub use bridge_error::BridgeError;

mod bridge_error;
