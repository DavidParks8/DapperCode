#[path = "windows/filesystem.rs"]
mod filesystem;
#[path = "windows/ports.rs"]
mod ports;
#[path = "windows/process.rs"]
mod process;

use std::{
    ffi::OsStr,
    fs::{File, Metadata},
    io,
    path::{Path, PathBuf},
};

use tokio::process::{Child, Command};

use super::{
    PlatformFuture, PlatformSecureRoots, PreviewStrategy, PrivateStorageStrategy, ProcessStrategy,
    SecureFilesystemStrategy,
};
use dappercode_bridge_core::BridgeError;

#[derive(Debug)]
pub(crate) struct CurrentPlatform;

impl SecureFilesystemStrategy for CurrentPlatform {
    type RootHandle = filesystem::RootHandle;
    type DirectoryHandle = filesystem::DirectoryHandle;

    fn validate_workdir(&self, root: &Path) -> Result<PathBuf, String> {
        filesystem::canonicalize_windows_workdir(root)
    }

    fn initialize_secure_roots(
        &self,
        root: &Path,
        attachments_root: Option<&Path>,
        default_attachments_name: &OsStr,
    ) -> Result<PlatformSecureRoots<Self::RootHandle>, String> {
        filesystem::initialize_windows_secure_roots(
            root,
            attachments_root,
            default_attachments_name,
        )
    }

    fn path_component_is_valid(&self, name: &OsStr) -> bool {
        filesystem::windows_path_component_is_valid(name)
    }

    fn relative_beneath(&self, path: &Path, root: &Path) -> Option<PathBuf> {
        filesystem::windows_relative_beneath(path, root)
    }

    fn open_regular_file_beneath<BeforeFinalOpen>(
        &self,
        base_root: &Path,
        base_handle: &Self::RootHandle,
        relative: &Path,
        before_final_open: BeforeFinalOpen,
    ) -> Result<(File, PathBuf), BridgeError>
    where
        BeforeFinalOpen: FnOnce(),
    {
        filesystem::open_windows_regular_file_beneath(
            base_root,
            base_handle,
            relative,
            before_final_open,
        )
    }

    fn secure_directory_beneath(
        &self,
        base_handle: &Self::RootHandle,
        relative: &Path,
    ) -> Result<Self::DirectoryHandle, BridgeError> {
        filesystem::create_windows_directory_beneath(base_handle, relative)
    }

    fn create_secure_file(
        &self,
        directory: &Self::DirectoryHandle,
        name: &str,
    ) -> Result<File, BridgeError> {
        filesystem::create_windows_secure_file(directory, name)
    }

    fn rename_secure_file(
        &self,
        source: &Self::DirectoryHandle,
        source_name: &str,
        target: &Self::DirectoryHandle,
        target_name: &str,
    ) -> Result<(), BridgeError> {
        filesystem::rename_windows_secure_file(source, source_name, target, target_name)
    }

    fn remove_secure_file(&self, directory: &Self::DirectoryHandle, name: &str) {
        filesystem::remove_windows_secure_file(directory, name);
    }

    fn tree_mode(&self, _metadata: &Metadata) -> String {
        "0000".to_string()
    }

    fn file_has_multiple_links(&self, path: &Path, _metadata: &Metadata) -> io::Result<bool> {
        filesystem::windows_file_has_multiple_links(path)
    }
}

impl PrivateStorageStrategy for CurrentPlatform {
    fn atomic_write_private_blocking<BeforePublish, BeforeParentSync>(
        &self,
        parent: &Path,
        file_name: &OsStr,
        bytes: &[u8],
        before_publish: BeforePublish,
        before_parent_sync: BeforeParentSync,
    ) -> io::Result<()>
    where
        BeforePublish: FnOnce(&Path) -> io::Result<()>,
        BeforeParentSync: FnOnce(&Path) -> io::Result<()>,
    {
        filesystem::atomic_write_private_windows(
            parent,
            file_name,
            bytes,
            before_publish,
            before_parent_sync,
        )
    }
}

impl ProcessStrategy for CurrentPlatform {
    fn process_is_alive(&self, pid: u32) -> bool {
        process::windows_process_is_alive(pid)
    }

    fn wait_for_owner_exit(&'static self, pid: u32) -> PlatformFuture<()> {
        process::wait_for_windows_owner_exit(pid)
    }

    fn wait_for_shutdown_signal(&'static self) -> PlatformFuture<&'static str> {
        process::wait_for_windows_shutdown_signal()
    }

    fn configure_git_command(&self, command: &mut Command) {
        process::configure_windows_git_command(command);
    }

    fn kill_git_process_group(&self, child: &Child) {
        process::kill_windows_git_process_group(child);
    }

    fn git_global_config_path(&self) -> &'static str {
        "NUL"
    }
}

impl PreviewStrategy for CurrentPlatform {
    fn discover_loopback_listening_ports(&'static self) -> PlatformFuture<Vec<u16>> {
        ports::discover_windows_loopback_ports()
    }
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) fn observed_creation_time(pid: u32) -> Option<u64> {
    process::observed_windows_creation_time(pid)
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) fn process_creation_time(pid: u32) -> io::Result<u64> {
    process::windows_process_creation_time_for_pid(pid)
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) fn wait_for_owner_exit_with_identity(
    pid: u32,
    expected_creation_time: Option<u64>,
) -> PlatformFuture<()> {
    process::wait_for_windows_owner_exit_with_identity(pid, expected_creation_time)
}
