use std::{
    ffi::OsStr,
    fs::{File, Metadata},
    io::{self, Write},
    os::{
        fd::OwnedFd,
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use rustix::fs::{self as unix_fs, AtFlags, Mode, OFlags};
use uuid::Uuid;

use dappercode_bridge_core::BridgeError;

use crate::platform::PlatformSecureRoots;

#[derive(Debug, Clone)]
pub(crate) struct RootHandle(Arc<OwnedFd>);

#[derive(Debug)]
pub(crate) struct DirectoryHandle(OwnedFd);

pub(super) fn canonicalize_unix_workdir(root: &Path) -> Result<PathBuf, String> {
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

pub(super) fn initialize_unix_secure_roots(
    root: &Path,
    attachments_root: Option<&Path>,
    default_attachments_name: &OsStr,
) -> Result<PlatformSecureRoots<RootHandle>, String> {
    let root = canonicalize_unix_workdir(root)?;
    let attachments_root = attachments_root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join(default_attachments_name));
    create_private_unix_directory(&attachments_root)?;
    let attachments_root = std::fs::canonicalize(&attachments_root).map_err(|error| {
        format!(
            "BRIDGE_ATTACHMENTS_DIR is invalid or inaccessible ({}): {error}",
            attachments_root.to_string_lossy()
        )
    })?;
    let root_fd = unix_fs::open(
        &root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| format!("failed to retain BRIDGE_WORKDIR descriptor: {error}"))?;
    let attachments_fd = unix_fs::open(
        &attachments_root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| format!("failed to retain BRIDGE_ATTACHMENTS_DIR descriptor: {error}"))?;
    Ok(PlatformSecureRoots {
        root,
        attachments_root,
        root_handle: RootHandle(Arc::new(root_fd)),
        attachments_handle: RootHandle(Arc::new(attachments_fd)),
    })
}

pub(super) fn open_unix_regular_file_beneath<BeforeFinalOpen>(
    base_root: &Path,
    base_handle: &RootHandle,
    relative: &Path,
    before_final_open: BeforeFinalOpen,
) -> Result<(File, PathBuf), BridgeError>
where
    BeforeFinalOpen: FnOnce(),
{
    let mut components = relative.components().peekable();
    let mut directory = rustix::io::dup(&*base_handle.0).map_err(|error| {
        BridgeError::server(&format!("failed to duplicate root descriptor: {error}"))
    })?;
    let mut final_name = None;
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(BridgeError::invalid_params(
                "path must stay beneath BRIDGE_WORKDIR",
            ));
        };
        if components.peek().is_none() {
            final_name = Some(name.to_os_string());
            break;
        }
        directory = unix_fs::openat(
            &directory,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| {
            BridgeError::invalid_params(&format!(
                "path component is unsafe or inaccessible: {error}"
            ))
        })?;
    }
    let final_name =
        final_name.ok_or_else(|| BridgeError::invalid_params("path must point to a file"))?;
    before_final_open();
    let fd = unix_fs::openat(
        &directory,
        &final_name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| {
        BridgeError::invalid_params(&format!("file is unsafe or inaccessible: {error}"))
    })?;
    let file: File = fd.into();
    let metadata = file.metadata().map_err(|error| {
        BridgeError::invalid_params(&format!("failed to inspect opened file: {error}"))
    })?;
    if !metadata.is_file() {
        return Err(BridgeError::invalid_params(
            "path must point to a regular file",
        ));
    }
    if metadata.nlink() != 1 {
        return Err(BridgeError::invalid_params(
            "hard-linked files are not permitted",
        ));
    }
    Ok((file, base_root.join(relative)))
}

pub(super) fn create_unix_directory_beneath(
    base_handle: &RootHandle,
    relative: &Path,
) -> Result<DirectoryHandle, BridgeError> {
    let mut directory = rustix::io::dup(&*base_handle.0).map_err(|error| {
        BridgeError::server(&format!("failed to duplicate root descriptor: {error}"))
    })?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            unreachable!("relative paths are validated before secure traversal")
        };
        match unix_fs::mkdirat(&directory, name, Mode::from_raw_mode(0o700)) {
            Ok(()) => unix_fs::fsync(&directory).map_err(|error| {
                BridgeError::server(&format!("failed to sync secure parent directory: {error}"))
            })?,
            Err(rustix::io::Errno::EXIST) => {}
            Err(error) => {
                return Err(BridgeError::server(&format!(
                    "failed to create secure directory: {error}"
                )))
            }
        }
        directory = unix_fs::openat(
            &directory,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| {
            BridgeError::invalid_params(&format!("directory component is unsafe: {error}"))
        })?;
        unix_fs::fchmod(&directory, Mode::from_raw_mode(0o700)).map_err(|error| {
            BridgeError::server(&format!("failed to secure directory permissions: {error}"))
        })?;
    }
    Ok(DirectoryHandle(directory))
}

pub(super) fn create_unix_secure_file(
    directory: &DirectoryHandle,
    name: &str,
) -> Result<File, BridgeError> {
    let fd = unix_fs::openat(
        &directory.0,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map_err(|error| BridgeError::server(&format!("failed to create secure file: {error}")))?;
    Ok(fd.into())
}

pub(super) fn rename_unix_secure_file(
    source: &DirectoryHandle,
    source_name: &str,
    target: &DirectoryHandle,
    target_name: &str,
) -> Result<(), BridgeError> {
    unix_fs::renameat(&source.0, source_name, &target.0, target_name).map_err(|error| {
        BridgeError::server(&format!("failed to finalize secure file: {error}"))
    })?;
    unix_fs::fsync(&source.0).map_err(|error| {
        BridgeError::server(&format!("failed to sync staging directory: {error}"))
    })?;
    unix_fs::fsync(&target.0).map_err(|error| {
        BridgeError::server(&format!("failed to sync secure directory: {error}"))
    })?;
    Ok(())
}

pub(super) fn remove_unix_secure_file(directory: &DirectoryHandle, name: &str) {
    let _ = unix_fs::unlinkat(&directory.0, name, AtFlags::empty());
}

pub(super) fn unix_tree_mode(metadata: &Metadata) -> String {
    format!("0{:03o}", metadata.permissions().mode() & 0o777)
}

pub(super) fn unix_file_has_multiple_links(metadata: &Metadata) -> bool {
    metadata.nlink() != 1
}

pub(super) fn atomic_write_private_unix<BeforePublish, BeforeParentSync>(
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
    let parent_fd = unix_fs::open(
        parent,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    let parent_file = File::from(parent_fd);
    let temporary_name = format!(".{}.{}.tmp", file_name.to_string_lossy(), Uuid::new_v4());
    let temporary_path = parent.join(&temporary_name);
    let result = (|| {
        let temporary_fd = unix_fs::openat(
            &parent_file,
            &temporary_name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )?;
        let mut temporary_file = File::from(temporary_fd);
        temporary_file.write_all(bytes)?;
        temporary_file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        before_publish(&temporary_path)?;
        temporary_file.sync_all()?;
        unix_fs::renameat(&parent_file, &temporary_name, &parent_file, file_name)?;
        if let Err(error) = before_parent_sync(parent).and_then(|_| parent_file.sync_all()) {
            eprintln!(
                "warning: {} was replaced, but its directory metadata could not be synced: {error}",
                parent.join(file_name).display()
            );
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = unix_fs::unlinkat(&parent_file, &temporary_name, AtFlags::empty());
    }
    result
}

fn create_private_unix_directory(path: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(format!(
            "BRIDGE_ATTACHMENTS_DIR must not be a symlink ({})",
            path.to_string_lossy()
        ));
    }
    std::fs::create_dir_all(path).map_err(|error| {
        format!(
            "BRIDGE_ATTACHMENTS_DIR could not be created ({}): {error}",
            path.to_string_lossy()
        )
    })?;
    let mut permissions = std::fs::metadata(path)
        .map_err(|error| format!("BRIDGE_ATTACHMENTS_DIR is inaccessible: {error}"))?
        .permissions();
    if permissions.mode() & 0o077 != 0 {
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)
            .map_err(|error| format!("BRIDGE_ATTACHMENTS_DIR could not be secured: {error}"))?;
    }
    Ok(())
}
