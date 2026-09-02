#![cfg_attr(all(test, coverage_nightly), feature(coverage_attribute))]

//! Native filesystem, process, and port-discovery services selected at compile time.

mod platform;

pub use platform::{
    atomic_write_private_blocking, configure_git_command, create_secure_file,
    discover_loopback_listening_ports, file_has_multiple_links, git_global_config_path,
    initialize_secure_roots, kill_git_process_group, open_regular_file_beneath,
    path_component_is_valid, poll_while_owner_is_alive, process_is_alive, relative_beneath,
    remove_secure_file, rename_secure_file, secure_directory_beneath, tree_mode, validate_workdir,
    wait_for_owner_exit, wait_for_shutdown_signal, SecureDirectoryHandle, SecureRootHandle,
    SecureRoots,
};

#[cfg(all(windows, any(test, feature = "test-support")))]
pub use platform::{
    test_observed_process_creation_time, test_process_creation_time,
    test_wait_for_owner_exit_with_identity,
};
