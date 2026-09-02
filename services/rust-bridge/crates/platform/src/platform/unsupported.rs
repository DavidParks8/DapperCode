use std::{
    ffi::OsStr,
    fs::{File, Metadata},
    io::{self, Write},
    path::{Path, PathBuf},
};

use tokio::process::{Child, Command};
use uuid::Uuid;

use super::{
    PlatformFuture, PlatformSecureRoots, PreviewStrategy, PrivateStorageStrategy, ProcessStrategy,
    SecureFilesystemStrategy,
};
use dappercode_bridge_core::BridgeError;

#[derive(Debug)]
pub(crate) struct CurrentPlatform;

impl SecureFilesystemStrategy for CurrentPlatform {
    type RootHandle = ();
    type DirectoryHandle = ();

    fn validate_workdir(&self, root: &Path) -> Result<PathBuf, String> {
        let canonical = std::fs::canonicalize(root).map_err(|error| {
            format!(
                "BRIDGE_WORKDIR is invalid or inaccessible ({}): {error}",
                root.to_string_lossy()
            )
        })?;
        if !canonical.is_dir() {
            return Err(format!(
                "BRIDGE_WORKDIR must point to a directory (got: {})",
                canonical.to_string_lossy()
            ));
        }
        Ok(canonical)
    }

    fn initialize_secure_roots(
        &self,
        root: &Path,
        attachments_root: Option<&Path>,
        default_attachments_name: &OsStr,
    ) -> Result<PlatformSecureRoots<Self::RootHandle>, String> {
        let root = self.validate_workdir(root)?;
        let attachments_root = attachments_root
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root.join(default_attachments_name));
        if std::fs::symlink_metadata(&attachments_root)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(format!(
                "BRIDGE_ATTACHMENTS_DIR must not be a symlink ({})",
                attachments_root.to_string_lossy()
            ));
        }
        std::fs::create_dir_all(&attachments_root).map_err(|error| {
            format!(
                "BRIDGE_ATTACHMENTS_DIR could not be created ({}): {error}",
                attachments_root.to_string_lossy()
            )
        })?;
        let attachments_root = std::fs::canonicalize(&attachments_root).map_err(|error| {
            format!(
                "BRIDGE_ATTACHMENTS_DIR is invalid or inaccessible ({}): {error}",
                attachments_root.to_string_lossy()
            )
        })?;
        Ok(PlatformSecureRoots {
            root,
            attachments_root,
            root_handle: (),
            attachments_handle: (),
        })
    }

    fn path_component_is_valid(&self, _name: &OsStr) -> bool {
        true
    }

    fn relative_beneath(&self, path: &Path, root: &Path) -> Option<PathBuf> {
        path.strip_prefix(root).ok().map(Path::to_path_buf)
    }

    fn open_regular_file_beneath<BeforeFinalOpen>(
        &self,
        _base_root: &Path,
        _base_handle: &Self::RootHandle,
        _relative: &Path,
        _before_final_open: BeforeFinalOpen,
    ) -> Result<(File, PathBuf), BridgeError>
    where
        BeforeFinalOpen: FnOnce(),
    {
        Err(BridgeError::server(
            "secure local file access is unavailable on this platform",
        ))
    }

    fn secure_directory_beneath(
        &self,
        _base_handle: &Self::RootHandle,
        _relative: &Path,
    ) -> Result<Self::DirectoryHandle, BridgeError> {
        Err(BridgeError::server(
            "secure attachment storage is unavailable on this platform",
        ))
    }

    fn create_secure_file(
        &self,
        _directory: &Self::DirectoryHandle,
        _name: &str,
    ) -> Result<File, BridgeError> {
        Err(BridgeError::server(
            "secure attachment storage is unavailable on this platform",
        ))
    }

    fn rename_secure_file(
        &self,
        _source: &Self::DirectoryHandle,
        _source_name: &str,
        _target: &Self::DirectoryHandle,
        _target_name: &str,
    ) -> Result<(), BridgeError> {
        Err(BridgeError::server(
            "secure attachment storage is unavailable on this platform",
        ))
    }

    fn remove_secure_file(&self, _directory: &Self::DirectoryHandle, _name: &str) {}

    fn tree_mode(&self, _metadata: &Metadata) -> String {
        "0000".to_string()
    }

    fn file_has_multiple_links(&self, _path: &Path, _metadata: &Metadata) -> io::Result<bool> {
        Ok(true)
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
        let temporary = parent.join(format!(
            ".{}.{}.tmp",
            file_name.to_string_lossy(),
            Uuid::new_v4()
        ));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(bytes)?;
            before_publish(&temporary)?;
            file.sync_all()?;
            std::fs::rename(&temporary, parent.join(file_name))?;
            if let Err(error) =
                before_parent_sync(parent).and_then(|_| File::open(parent)?.sync_all())
            {
                eprintln!(
                    "warning: {} was replaced, but its directory metadata could not be synced: {error}",
                    parent.join(file_name).display()
                );
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

impl ProcessStrategy for CurrentPlatform {
    fn process_is_alive(&self, _pid: u32) -> bool {
        false
    }

    fn wait_for_owner_exit(&'static self, _pid: u32) -> PlatformFuture<()> {
        Box::pin(async {})
    }

    fn wait_for_shutdown_signal(&'static self) -> PlatformFuture<&'static str> {
        Box::pin(async {
            let _ = tokio::signal::ctrl_c().await;
            "Ctrl+C"
        })
    }

    fn configure_git_command(&self, _command: &mut Command) {}

    fn kill_git_process_group(&self, _child: &Child) {}

    fn git_global_config_path(&self) -> &'static str {
        "/dev/null"
    }
}

impl PreviewStrategy for CurrentPlatform {
    fn discover_loopback_listening_ports(&'static self) -> PlatformFuture<Vec<u16>> {
        Box::pin(async {
            let mut ports = std::collections::HashSet::new();
            if let Some(output) =
                super::read_command_stdout("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]).await
            {
                super::collect_ports_from_lsof(&output, &mut ports);
            }
            let mut ports = ports.into_iter().collect::<Vec<_>>();
            ports.sort_unstable();
            ports
        })
    }
}
