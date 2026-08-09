#[path = "unix/filesystem.rs"]
mod filesystem;
#[path = "unix/ports.rs"]
mod ports;
#[path = "unix/process.rs"]
mod process;

use std::{
    ffi::OsStr,
    fs::{File, Metadata},
    io,
    path::{Path, PathBuf},
};

use tokio::process::{Child, Command};

use super::{
    PlatformFuture, PreviewStrategy, PrivateStorageStrategy, ProcessStrategy,
    SecureFilesystemStrategy, SecureRoots,
};
use crate::BridgeError;

#[derive(Debug)]
pub(crate) struct CurrentPlatform;

impl SecureFilesystemStrategy for CurrentPlatform {
    type RootHandle = filesystem::RootHandle;
    type DirectoryHandle = filesystem::DirectoryHandle;

    fn validate_workdir(&self, root: &Path) -> Result<PathBuf, String> {
        filesystem::canonicalize_unix_workdir(root)
    }

    fn initialize_secure_roots(
        &self,
        root: &Path,
        attachments_root: Option<&Path>,
        default_attachments_name: &OsStr,
    ) -> Result<SecureRoots<Self::RootHandle>, String> {
        filesystem::initialize_unix_secure_roots(root, attachments_root, default_attachments_name)
    }

    fn path_component_is_valid(&self, _name: &OsStr) -> bool {
        true
    }

    fn relative_beneath(&self, path: &Path, root: &Path) -> Option<PathBuf> {
        path.strip_prefix(root).ok().map(Path::to_path_buf)
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
        filesystem::open_unix_regular_file_beneath(
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
        filesystem::create_unix_directory_beneath(base_handle, relative)
    }

    fn create_secure_file(
        &self,
        directory: &Self::DirectoryHandle,
        name: &str,
    ) -> Result<File, BridgeError> {
        filesystem::create_unix_secure_file(directory, name)
    }

    fn rename_secure_file(
        &self,
        source: &Self::DirectoryHandle,
        source_name: &str,
        target: &Self::DirectoryHandle,
        target_name: &str,
    ) -> Result<(), BridgeError> {
        filesystem::rename_unix_secure_file(source, source_name, target, target_name)
    }

    fn remove_secure_file(&self, directory: &Self::DirectoryHandle, name: &str) {
        filesystem::remove_unix_secure_file(directory, name);
    }

    fn tree_mode(&self, metadata: &Metadata) -> String {
        filesystem::unix_tree_mode(metadata)
    }

    fn file_has_multiple_links(&self, _path: &Path, metadata: &Metadata) -> io::Result<bool> {
        Ok(filesystem::unix_file_has_multiple_links(metadata))
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
        filesystem::atomic_write_private_unix(
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
        process::unix_process_is_alive(pid)
    }

    fn wait_for_owner_exit(&'static self, pid: u32) -> PlatformFuture<()> {
        process::wait_for_unix_owner_exit(pid)
    }

    fn wait_for_shutdown_signal(&'static self) -> PlatformFuture<&'static str> {
        process::wait_for_unix_shutdown_signal()
    }

    fn configure_git_command(&self, command: &mut Command) {
        process::configure_unix_git_command(command);
    }

    fn kill_git_process_group(&self, child: &Child) {
        process::kill_unix_git_process_group(child);
    }

    fn git_global_config_path(&self) -> &'static str {
        "/dev/null"
    }
}

impl PreviewStrategy for CurrentPlatform {
    fn discover_loopback_listening_ports(&'static self) -> PlatformFuture<Vec<u16>> {
        ports::discover_unix_loopback_ports()
    }
}
