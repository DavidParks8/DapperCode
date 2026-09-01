use std::{
    ffi::{c_void, OsStr, OsString},
    fs::File,
    io::{self, Write},
    mem::{offset_of, size_of},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, RawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr::{null, null_mut},
    sync::Arc,
};

use uuid::Uuid;
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
        },
    },
    Win32::{
        Foundation::{
            LocalFree, RtlNtStatusToDosError, HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE,
            OBJ_DONT_REPARSE,
        },
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SetSecurityInfo,
                SDDL_REVISION_1, SE_FILE_OBJECT,
            },
            GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_DESCRIPTOR,
        },
        Storage::FileSystem::{
            CreateFileW, FileAttributeTagInfo, FileDispositionInfo, FileRenameInfo,
            FlushFileBuffers, GetFileInformationByHandle, GetFileInformationByHandleEx,
            GetFinalPathNameByHandleW, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
            FILE_DELETE_CHILD, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
            FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_EA, FILE_RENAME_INFO,
            FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_EA,
            OPEN_EXISTING, READ_CONTROL, SYNCHRONIZE, WRITE_DAC,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

use dappercode_bridge_core::BridgeError;

use crate::platform::PlatformSecureRoots;

const SAFE_SHARING: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;
const DIRECTORY_READ_ACCESS: u32 =
    FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const DIRECTORY_PRIVATE_ACCESS: u32 = FILE_LIST_DIRECTORY
    | FILE_TRAVERSE
    | FILE_ADD_FILE
    | FILE_ADD_SUBDIRECTORY
    | FILE_DELETE_CHILD
    | FILE_READ_ATTRIBUTES
    | FILE_READ_EA
    | FILE_WRITE_ATTRIBUTES
    | FILE_WRITE_EA
    | READ_CONTROL
    | SYNCHRONIZE
    | WRITE_DAC;
const PRIVATE_DACL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)";
const FILE_RENAME_REPLACE_IF_EXISTS: u32 = 1;

#[derive(Debug, Clone)]
pub(crate) struct RootHandle(Arc<File>);

#[derive(Debug)]
pub(crate) struct DirectoryHandle(Vec<File>);

impl DirectoryHandle {
    fn final_handle(&self) -> &File {
        self.0
            .last()
            .expect("secure directories retain at least one handle")
    }
}

pub(super) fn canonicalize_windows_workdir(root: &Path) -> Result<PathBuf, String> {
    let root_handle = open_existing_absolute_directory(root)
        .map_err(|error| format!("failed to retain BRIDGE_WORKDIR handle: {error}"))?;
    final_path(&root_handle)
        .map_err(|error| format!("failed to resolve BRIDGE_WORKDIR from its handle: {error}"))
}

pub(super) fn initialize_windows_secure_roots(
    root: &Path,
    attachments_root: Option<&Path>,
    default_attachments_name: &OsStr,
) -> Result<PlatformSecureRoots<RootHandle>, String> {
    let root_handle = open_existing_absolute_directory(root)
        .map_err(|error| format!("failed to retain BRIDGE_WORKDIR handle: {error}"))?;
    let root = final_path(&root_handle)
        .map_err(|error| format!("failed to resolve BRIDGE_WORKDIR from its handle: {error}"))?;
    let (attachments_root, attachments_handle) = match attachments_root {
        Some(path) => create_private_absolute_directory(path).map_err(|error| {
            format!(
                "BRIDGE_ATTACHMENTS_DIR could not be securely created ({}): {error}",
                path.to_string_lossy()
            )
        })?,
        None => {
            let handle = create_private_child_directory(&root_handle, default_attachments_name)
                .map_err(|error| {
                    format!("BRIDGE_ATTACHMENTS_DIR could not be securely created: {error}")
                })?;
            let path = final_path(&handle).map_err(|error| {
                format!("failed to resolve BRIDGE_ATTACHMENTS_DIR from its handle: {error}")
            })?;
            (path, handle)
        }
    };
    Ok(PlatformSecureRoots {
        root,
        attachments_root,
        root_handle: RootHandle(Arc::new(root_handle)),
        attachments_handle: RootHandle(Arc::new(attachments_handle)),
    })
}

pub(super) fn windows_path_component_is_valid(name: &OsStr) -> bool {
    let units = name.encode_wide().collect::<Vec<_>>();
    if units.is_empty()
        || units
            .iter()
            .any(|unit| *unit == 0 || *unit == u16::from(b':'))
        || units
            .last()
            .is_some_and(|unit| *unit == u16::from(b'.') || *unit == u16::from(b' '))
    {
        return false;
    }

    let lossy = name.to_string_lossy();
    let stem = lossy
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !(stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

pub(super) fn windows_relative_beneath(path: &Path, root: &Path) -> Option<PathBuf> {
    fn os_eq(left: &OsStr, right: &OsStr) -> bool {
        fn fold(unit: u16) -> u16 {
            match unit {
                0x41..=0x5a => unit + 0x20,
                _ => unit,
            }
        }

        left.encode_wide()
            .map(fold)
            .eq(right.encode_wide().map(fold))
    }

    fn prefixes_eq(left: Prefix<'_>, right: Prefix<'_>) -> bool {
        match (left, right) {
            (Prefix::Disk(left), Prefix::Disk(right))
            | (Prefix::Disk(left), Prefix::VerbatimDisk(right))
            | (Prefix::VerbatimDisk(left), Prefix::Disk(right))
            | (Prefix::VerbatimDisk(left), Prefix::VerbatimDisk(right)) => {
                left.eq_ignore_ascii_case(&right)
            }
            (Prefix::UNC(left_server, left_share), Prefix::UNC(right_server, right_share))
            | (
                Prefix::UNC(left_server, left_share),
                Prefix::VerbatimUNC(right_server, right_share),
            )
            | (
                Prefix::VerbatimUNC(left_server, left_share),
                Prefix::UNC(right_server, right_share),
            )
            | (
                Prefix::VerbatimUNC(left_server, left_share),
                Prefix::VerbatimUNC(right_server, right_share),
            ) => os_eq(left_server, right_server) && os_eq(left_share, right_share),
            (Prefix::DeviceNS(left), Prefix::DeviceNS(right))
            | (Prefix::Verbatim(left), Prefix::Verbatim(right)) => os_eq(left, right),
            _ => false,
        }
    }

    fn components_eq(left: Component<'_>, right: Component<'_>) -> bool {
        match (left, right) {
            (Component::Prefix(left), Component::Prefix(right)) => {
                prefixes_eq(left.kind(), right.kind())
            }
            (Component::RootDir, Component::RootDir) | (Component::CurDir, Component::CurDir) => {
                true
            }
            (Component::ParentDir, Component::ParentDir) => true,
            (Component::Normal(left), Component::Normal(right)) => os_eq(left, right),
            _ => false,
        }
    }

    let mut requested = path.components();
    for root_component in root.components() {
        if !components_eq(requested.next()?, root_component) {
            return None;
        }
    }
    let mut relative = PathBuf::new();
    for component in requested {
        let Component::Normal(name) = component else {
            return None;
        };
        relative.push(name);
    }
    Some(relative)
}

pub(super) fn open_windows_regular_file_beneath<BeforeFinalOpen>(
    base_root: &Path,
    base_handle: &RootHandle,
    relative: &Path,
    before_final_open: BeforeFinalOpen,
) -> Result<(File, PathBuf), BridgeError>
where
    BeforeFinalOpen: FnOnce(),
{
    let mut handles = vec![base_handle.0.try_clone().map_err(|error| {
        BridgeError::server(&format!("failed to duplicate root handle: {error}"))
    })?];
    let mut components = relative.components().peekable();
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
        let directory = open_existing_directory(
            handles
                .last()
                .expect("the retained root handle starts the directory chain"),
            name,
        )
        .map_err(|error| {
            BridgeError::invalid_params(&format!(
                "path component is unsafe or inaccessible: {error}"
            ))
        })?;
        handles.push(directory);
    }
    let final_name =
        final_name.ok_or_else(|| BridgeError::invalid_params("path must point to a file"))?;
    before_final_open();
    let file = open_regular_file(
        handles
            .last()
            .expect("the retained root handle starts the directory chain"),
        &final_name,
    )
    .map_err(|error| {
        BridgeError::invalid_params(&format!("file is unsafe or inaccessible: {error}"))
    })?;
    Ok((file, base_root.join(relative)))
}

pub(super) fn create_windows_directory_beneath(
    base_handle: &RootHandle,
    relative: &Path,
) -> Result<DirectoryHandle, BridgeError> {
    let mut handles = vec![base_handle.0.try_clone().map_err(|error| {
        BridgeError::server(&format!("failed to duplicate root handle: {error}"))
    })?];
    for component in relative.components() {
        let Component::Normal(name) = component else {
            unreachable!("relative paths are validated before secure traversal")
        };
        let directory = create_private_child_directory(
            handles
                .last()
                .expect("the retained root handle starts the directory chain"),
            name,
        )
        .map_err(|error| {
            BridgeError::invalid_params(&format!(
                "directory component is unsafe or inaccessible: {error}"
            ))
        })?;
        handles.push(directory);
    }
    Ok(DirectoryHandle(handles))
}

pub(super) fn create_windows_secure_file(
    directory: &DirectoryHandle,
    name: &str,
) -> Result<File, BridgeError> {
    create_file(directory.final_handle(), name)
        .map_err(|error| BridgeError::server(&format!("failed to create secure file: {error}")))
}

pub(super) fn rename_windows_secure_file(
    source: &DirectoryHandle,
    source_name: &str,
    target: &DirectoryHandle,
    target_name: &str,
) -> Result<(), BridgeError> {
    rename_file(
        source.final_handle(),
        source_name,
        target.final_handle(),
        target_name,
        false,
    )
    .map_err(|error| BridgeError::server(&format!("failed to finalize secure file: {error}")))
}

pub(super) fn remove_windows_secure_file(directory: &DirectoryHandle, name: &str) {
    let _ = remove_file(directory.final_handle(), name);
}

pub(super) fn windows_file_has_multiple_links(path: &Path) -> io::Result<bool> {
    let file = File::open(path)?;
    Ok(inspect_handle_information(&file)?.nNumberOfLinks != 1)
}

pub(super) fn atomic_write_private_windows<BeforePublish, BeforeParentSync>(
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
    if !windows_path_component_is_valid(file_name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "storage file name is not a safe Windows component",
        ));
    }
    let parent_handle = open_existing_absolute_directory(parent)?;
    let temporary_name = format!(".{}.{}.tmp", file_name.to_string_lossy(), Uuid::new_v4());
    let temporary_path = parent.join(&temporary_name);
    let result = (|| {
        let mut temporary_file = create_file(&parent_handle, &temporary_name)?;
        temporary_file.write_all(bytes)?;
        before_publish(&temporary_path)?;
        temporary_file.sync_all()?;
        rename_file_handle(&temporary_file, &parent_handle, file_name, true)?;
        if let Err(error) = before_parent_sync(parent).and_then(|_| flush_directory(&parent_handle))
        {
            eprintln!(
                "warning: {} was replaced, but its directory metadata could not be synced: {error}",
                parent.join(file_name).display()
            );
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = remove_file(&parent_handle, &temporary_name);
    }
    result
}

fn open_absolute_directory(path: &Path) -> io::Result<File> {
    let path = nul_terminated(path.as_os_str())?;
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            DIRECTORY_READ_ACCESS,
            SAFE_SHARING,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle as RawHandle) };
    inspect_handle(&file, ExpectedKind::Directory)?;
    Ok(file)
}

fn create_private_absolute_directory(path: &Path) -> io::Result<(PathBuf, File)> {
    let (anchor, names) = split_absolute(path)?;
    if names.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the attachments root must not be a volume or share root",
        ));
    }

    let mut handles = vec![open_absolute_directory(&anchor)?];
    for (index, name) in names.iter().enumerate() {
        let last = index + 1 == names.len();
        let parent = handles
            .last()
            .expect("the absolute anchor starts the directory chain");
        let child = if last {
            create_private_child_directory(parent, name)?
        } else {
            match open_existing_directory(parent, name) {
                Ok(directory) => directory,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    create_private_child_directory(parent, name)?
                }
                Err(error) => return Err(error),
            }
        };
        handles.push(child);
    }

    let handle = handles
        .pop()
        .expect("an absolute attachments root has at least one child component");
    let path = final_path(&handle)?;
    Ok((path, handle))
}

fn open_existing_absolute_directory(path: &Path) -> io::Result<File> {
    let (anchor, names) = split_absolute(path)?;
    let mut handles = vec![open_absolute_directory(&anchor)?];
    for name in names {
        let directory = open_existing_directory(
            handles
                .last()
                .expect("the absolute anchor starts the directory chain"),
            &name,
        )?;
        handles.push(directory);
    }
    handles
        .pop()
        .ok_or_else(|| io::Error::other("absolute directory traversal retained no handle"))
}

fn create_private_child_directory(parent: &File, name: &OsStr) -> io::Result<File> {
    let descriptor = PrivateSecurityDescriptor::new()?;
    let (directory, _) = nt_create_relative(
        parent,
        name,
        DIRECTORY_PRIVATE_ACCESS,
        FILE_OPEN_IF,
        FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_ATTRIBUTE_NORMAL,
        SAFE_SHARING,
        Some(&descriptor),
    )?;
    inspect_handle(&directory, ExpectedKind::Directory)?;
    descriptor.apply_to(&directory)?;
    Ok(directory)
}

fn open_existing_directory(parent: &File, name: &OsStr) -> io::Result<File> {
    let (directory, _) = nt_create_relative(
        parent,
        name,
        DIRECTORY_READ_ACCESS,
        FILE_OPEN,
        FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_ATTRIBUTE_NORMAL,
        SAFE_SHARING,
        None,
    )?;
    inspect_handle(&directory, ExpectedKind::Directory)?;
    Ok(directory)
}

fn create_file(parent: &File, name: &str) -> io::Result<File> {
    let descriptor = PrivateSecurityDescriptor::new()?;
    let (file, _) = nt_create_relative(
        parent,
        OsStr::new(name),
        FILE_GENERIC_WRITE | FILE_READ_ATTRIBUTES | SYNCHRONIZE | DELETE | READ_CONTROL | WRITE_DAC,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_ATTRIBUTE_NORMAL,
        FILE_SHARE_READ,
        Some(&descriptor),
    )?;
    if let Err(error) =
        inspect_handle(&file, ExpectedKind::RegularFile).and_then(|_| descriptor.apply_to(&file))
    {
        let _ = mark_delete(&file);
        return Err(error);
    }
    Ok(file)
}

fn open_regular_file(parent: &File, name: &OsStr) -> io::Result<File> {
    let (file, _) = nt_create_relative(
        parent,
        name,
        FILE_GENERIC_READ,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_ATTRIBUTE_NORMAL,
        FILE_SHARE_READ,
        None,
    )?;
    inspect_handle(&file, ExpectedKind::RegularFile)?;
    Ok(file)
}

fn remove_file(parent: &File, name: &str) -> io::Result<()> {
    let file = open_mutable_file(parent, OsStr::new(name))?;
    inspect_handle(&file, ExpectedKind::RegularFile)?;
    mark_delete(&file)
}

fn rename_file(
    source_parent: &File,
    source_name: &str,
    target_parent: &File,
    target_name: &str,
    replace_existing: bool,
) -> io::Result<()> {
    let source = open_mutable_file(source_parent, OsStr::new(source_name))?;
    let source_info = inspect_handle(&source, ExpectedKind::RegularFile)?;
    let target_info = inspect_handle(target_parent, ExpectedKind::Directory)?;
    if source_info.volume_serial != target_info.volume_serial {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "secure finalization must stay on one volume",
        ));
    }

    if unsafe { FlushFileBuffers(raw_handle(&source)) } == 0 {
        return Err(io::Error::last_os_error());
    }
    rename_file_handle(
        &source,
        target_parent,
        OsStr::new(target_name),
        replace_existing,
    )?;
    if let Err(error) = inspect_handle(&source, ExpectedKind::RegularFile) {
        let _ = mark_delete(&source);
        return Err(error);
    }
    Ok(())
}

fn final_path(directory: &File) -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                raw_handle(directory),
                buffer.as_mut_ptr(),
                u32::try_from(buffer.len()).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "path buffer is too large")
                })?,
                0,
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        let length = usize::try_from(length).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "path length does not fit in memory",
            )
        })?;
        if length < buffer.len() {
            return Ok(PathBuf::from(OsString::from_wide(&buffer[..length])));
        }
        buffer.resize(length.saturating_add(1), 0);
    }
}

fn open_mutable_file(parent: &File, name: &OsStr) -> io::Result<File> {
    let (file, _) = nt_create_relative(
        parent,
        name,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | SYNCHRONIZE,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_ATTRIBUTE_NORMAL,
        SAFE_SHARING,
        None,
    )?;
    Ok(file)
}

#[allow(clippy::too_many_arguments)]
fn nt_create_relative(
    parent: &File,
    name: &OsStr,
    desired_access: u32,
    disposition: u32,
    options: u32,
    attributes: u32,
    sharing: u32,
    security: Option<&PrivateSecurityDescriptor>,
) -> io::Result<(File, usize)> {
    let mut name = name.encode_wide().collect::<Vec<_>>();
    if name.is_empty() || name.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid empty or NUL-containing child name",
        ));
    }
    let byte_length = name
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "child name is too long"))?;
    let unicode_name = windows_sys::Win32::Foundation::UNICODE_STRING {
        Length: byte_length,
        MaximumLength: byte_length,
        Buffer: name.as_mut_ptr(),
    };
    let object_attributes = OBJECT_ATTRIBUTES {
        Length: u32::try_from(size_of::<OBJECT_ATTRIBUTES>())
            .expect("OBJECT_ATTRIBUTES fits in a u32"),
        RootDirectory: raw_handle(parent),
        ObjectName: &unicode_name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: security
            .map_or(null(), PrivateSecurityDescriptor::as_security_descriptor),
        SecurityQualityOfService: null(),
    };
    let mut io_status = IO_STATUS_BLOCK::default();
    let mut handle: HANDLE = INVALID_HANDLE_VALUE;
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &object_attributes,
            &mut io_status,
            null(),
            attributes,
            sharing,
            disposition,
            options,
            null(),
            0,
        )
    };
    if status < 0 {
        return Err(ntstatus_error(status));
    }
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(io::Error::other(
            "NtCreateFile succeeded without returning a handle",
        ));
    }
    let file = unsafe { File::from_raw_handle(handle as RawHandle) };
    Ok((file, io_status.Information))
}

fn inspect_handle(file: &File, expected: ExpectedKind) -> io::Result<HandleInfo> {
    let information = inspect_handle_information(file)?;
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            raw_handle(file),
            FileAttributeTagInfo,
            (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast::<c_void>(),
            u32::try_from(size_of::<FILE_ATTRIBUTE_TAG_INFO>())
                .expect("FILE_ATTRIBUTE_TAG_INFO fits in a u32"),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }

    let attributes = information.dwFileAttributes | tag.FileAttributes;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || tag.ReparseTag != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "reparse points are not permitted",
        ));
    }
    let is_directory = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    match expected {
        ExpectedKind::Directory if !is_directory => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "path component is not a directory",
            ));
        }
        ExpectedKind::RegularFile if is_directory => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "path does not point to a regular file",
            ));
        }
        ExpectedKind::RegularFile if information.nNumberOfLinks != 1 => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "hard-linked files are not permitted",
            ));
        }
        _ => {}
    }
    Ok(HandleInfo {
        volume_serial: information.dwVolumeSerialNumber,
    })
}

fn inspect_handle_information(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(raw_handle(file), &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(information)
}

fn rename_file_handle(
    source: &File,
    target_parent: &File,
    name: &OsStr,
    replace_existing: bool,
) -> io::Result<()> {
    let name = name.encode_wide().collect::<Vec<_>>();
    if name.is_empty() || name.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid empty or NUL-containing target name",
        ));
    }
    let name_bytes = name
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target name is too long"))?;
    let information_size = offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(usize::try_from(name_bytes).expect("u32 fits in usize"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "rename information is too large",
            )
        })?;
    let word_count = information_size.saturating_add(size_of::<usize>() - 1) / size_of::<usize>();
    let mut storage = vec![0usize; word_count];
    let information = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*information).Anonymous.Flags = if replace_existing {
            FILE_RENAME_REPLACE_IF_EXISTS
        } else {
            0
        };
        (*information).RootDirectory = raw_handle(target_parent);
        (*information).FileNameLength = name_bytes;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*information).FileName).cast::<u16>(),
            name.len(),
        );
    }
    if unsafe {
        SetFileInformationByHandle(
            raw_handle(source),
            FileRenameInfo,
            information.cast::<c_void>(),
            u32::try_from(information_size).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "rename buffer is too large")
            })?,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn mark_delete(file: &File) -> io::Result<()> {
    let information = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            raw_handle(file),
            FileDispositionInfo,
            (&information as *const FILE_DISPOSITION_INFO).cast::<c_void>(),
            u32::try_from(size_of::<FILE_DISPOSITION_INFO>())
                .expect("FILE_DISPOSITION_INFO fits in a u32"),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn flush_directory(directory: &File) -> io::Result<()> {
    if unsafe { FlushFileBuffers(raw_handle(directory)) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn split_absolute(path: &Path) -> io::Result<(PathBuf, Vec<OsString>)> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must be absolute",
        ));
    }
    let mut anchor = PathBuf::new();
    let mut names = Vec::new();
    let mut saw_root = false;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) if names.is_empty() && !saw_root => {
                anchor.push(prefix.as_os_str());
            }
            Component::RootDir if names.is_empty() && !saw_root => {
                anchor.push(component.as_os_str());
                saw_root = true;
            }
            Component::Normal(name) if saw_root && windows_path_component_is_valid(name) => {
                names.push(name.to_os_string());
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "path contains an unsafe Windows component",
                ));
            }
        }
    }
    if anchor.as_os_str().is_empty() || !saw_root {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path has no absolute Windows anchor",
        ));
    }
    Ok((anchor, names))
}

fn nul_terminated(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut encoded = value.encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains a NUL character",
        ));
    }
    encoded.push(0);
    Ok(encoded)
}

fn raw_handle(file: &File) -> HANDLE {
    file.as_raw_handle() as HANDLE
}

fn ntstatus_error(status: i32) -> io::Error {
    let error = unsafe { RtlNtStatusToDosError(status) };
    io::Error::from_raw_os_error(i32::try_from(error).unwrap_or(i32::MAX))
}

#[derive(Clone, Copy)]
enum ExpectedKind {
    Directory,
    RegularFile,
}

struct HandleInfo {
    volume_serial: u32,
}

struct PrivateSecurityDescriptor {
    pointer: PSECURITY_DESCRIPTOR,
}

impl PrivateSecurityDescriptor {
    fn new() -> io::Result<Self> {
        let descriptor = nul_terminated(OsStr::new(PRIVATE_DACL))?;
        let mut pointer: PSECURITY_DESCRIPTOR = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                descriptor.as_ptr(),
                SDDL_REVISION_1,
                &mut pointer,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if pointer.is_null() {
            return Err(io::Error::other(
                "security descriptor conversion returned a null pointer",
            ));
        }
        Ok(Self { pointer })
    }

    fn as_security_descriptor(&self) -> *const SECURITY_DESCRIPTOR {
        self.pointer.cast::<SECURITY_DESCRIPTOR>()
    }

    fn apply_to(&self, file: &File) -> io::Result<()> {
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl: *mut ACL = null_mut();
        if unsafe {
            GetSecurityDescriptorDacl(self.pointer, &mut present, &mut dacl, &mut defaulted)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if present == 0 || dacl.is_null() {
            return Err(io::Error::other("private security descriptor has no DACL"));
        }
        let error = unsafe {
            SetSecurityInfo(
                raw_handle(file),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            )
        };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(
                i32::try_from(error).unwrap_or(i32::MAX),
            ));
        }
        Ok(())
    }
}

impl Drop for PrivateSecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(self.pointer);
        }
    }
}
