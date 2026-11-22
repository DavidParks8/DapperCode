use super::{
    bail, current_user_sid, ensure_private_handle_kind, file_handle, io, ipv4_from_socket_address,
    local_system_sid, mem, open_private_directory, private_acl, ptr, set_protected_dacl,
    well_known_sid, Context, EqualSid, File, GetLengthSid, Ipv4Addr, IsValidSid, OpenOptions, Path,
    PathBuf, PlatformStrategy, PrivatePathKind, Result, SidBuffer, ACCESS_ALLOWED_ACE, ACL,
    AF_INET, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, FILE_ALL_ACCESS, NO_ERROR,
    OBJECT_INHERIT_ACE, SE_FILE_OBJECT, SOCKADDR_IN, STRATEGY,
};
use std::fs;
use std::ptr::NonNull;
use tempfile::tempdir;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::GetSecurityInfo;
use windows_sys::Win32::Security::{
    AclSizeInformation, GetAce, GetAclInformation, GetSecurityDescriptorControl, WinWorldSid,
    ACE_HEADER, ACL_SIZE_INFORMATION, INHERITED_ACE, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
};

const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);

impl Drop for LocalSecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: GetSecurityInfo allocated this descriptor and this wrapper frees it once.
        unsafe {
            LocalFree(self.0);
        }
    }
}

struct InspectedAce {
    sid: SidBuffer,
    mask: u32,
    flags: u8,
    ace_type: u8,
}

struct InspectedAcl {
    protected: bool,
    aces: Vec<InspectedAce>,
}

fn checked_access_allowed_ace(
    dacl: *const ACL,
    acl_bytes: u32,
    raw_ace: *mut core::ffi::c_void,
) -> Result<(NonNull<u8>, ACCESS_ALLOWED_ACE)> {
    let raw_ace =
        NonNull::new(raw_ace.cast::<u8>()).context("Windows returned a null ACL entry")?;
    let acl_start = dacl as usize;
    let acl_end = acl_start
        .checked_add(acl_bytes as usize)
        .context("Windows returned an overflowing ACL size")?;
    let ace_start = raw_ace.as_ptr() as usize;
    let header_end = ace_start
        .checked_add(mem::size_of::<ACE_HEADER>())
        .context("Windows returned an overflowing ACL entry address")?;
    if ace_start < acl_start || header_end > acl_end {
        bail!("Windows returned an ACL entry outside the ACL buffer");
    }

    // SAFETY: the header range was checked within the live ACL; unaligned reads are allowed.
    let header = unsafe { raw_ace.cast::<ACE_HEADER>().as_ptr().read_unaligned() };
    let ace_bytes = usize::from(header.AceSize);
    let ace_end = ace_start
        .checked_add(ace_bytes)
        .context("Windows returned an overflowing ACL entry size")?;
    if ace_bytes < mem::size_of::<ACCESS_ALLOWED_ACE>() || ace_end > acl_end {
        bail!("Windows returned a truncated ACL entry");
    }
    if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
        bail!("Windows returned an unsupported ACL entry type");
    }

    // SAFETY: the full ACE range was checked within the live ACL; alignment is not assumed.
    let ace = unsafe {
        raw_ace
            .cast::<ACCESS_ALLOWED_ACE>()
            .as_ptr()
            .read_unaligned()
    };
    Ok((raw_ace, ace))
}

fn copy_ace_sid(raw_ace: NonNull<u8>, ace_bytes: usize) -> Result<SidBuffer> {
    let sid_offset = mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
    let sid_bytes = ace_bytes
        .checked_sub(sid_offset)
        .context("Windows returned an ACL entry without a SID")?;
    let mut words = vec![0_usize; sid_bytes.div_ceil(mem::size_of::<usize>())];
    let source = raw_ace.as_ptr().wrapping_add(sid_offset);
    // SAFETY: the caller checked the ACE range and words has at least sid_bytes of capacity.
    unsafe {
        ptr::copy_nonoverlapping(source, words.as_mut_ptr().cast::<u8>(), sid_bytes);
    }
    let mut sid = SidBuffer { words };
    // SAFETY: the SID bytes were copied from the ACL returned and validated by Windows.
    if unsafe { IsValidSid(sid.as_ptr()) } == 0 {
        bail!("Windows returned an invalid ACL entry SID");
    }
    // SAFETY: IsValidSid accepted the SID in the live buffer.
    let byte_len = unsafe { GetLengthSid(sid.as_ptr()) } as usize;
    if byte_len == 0 || byte_len > sid_bytes {
        bail!("Windows returned an ACL entry SID outside the entry");
    }
    sid.words
        .truncate(byte_len.div_ceil(mem::size_of::<usize>()));
    Ok(sid)
}

fn open_test_path(path: &Path, kind: PrivatePathKind) -> Result<File> {
    match kind {
        PrivatePathKind::Directory => open_private_directory(path),
        PrivatePathKind::File => {
            let mut options = OpenOptions::new();
            options.read(true);
            STRATEGY.configure_private_file_options(&mut options);
            let file = options.open(path)?;
            ensure_private_handle_kind(path, &file, PrivatePathKind::File)?;
            Ok(file)
        }
    }
}

fn inspect_acl(path: &Path, kind: PrivatePathKind) -> Result<InspectedAcl> {
    let file = open_test_path(path, kind)?;
    let mut dacl = ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: file owns a live handle and both requested output pointers are writable.
    let result = unsafe {
        GetSecurityInfo(
            file_handle(&file),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &raw mut dacl,
            ptr::null_mut(),
            &raw mut descriptor,
        )
    };
    if result != NO_ERROR {
        return Err(io::Error::from_raw_os_error(result.cast_signed()))
            .context("failed to inspect test ACL");
    }
    if descriptor.is_null() || dacl.is_null() {
        bail!("test path has no DACL");
    }
    let _descriptor = LocalSecurityDescriptor(descriptor);

    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: _descriptor keeps the returned descriptor alive and both outputs are writable.
    if unsafe { GetSecurityDescriptorControl(descriptor, &raw mut control, &raw mut revision) } == 0
    {
        return Err(io::Error::last_os_error())
            .context("failed to inspect test security descriptor control");
    }
    let mut size = ACL_SIZE_INFORMATION::default();
    // SAFETY: the live descriptor owns dacl and size has the advertised writable layout.
    if unsafe {
        GetAclInformation(
            dacl,
            ptr::addr_of_mut!(size).cast(),
            u32::try_from(mem::size_of::<ACL_SIZE_INFORMATION>())
                .expect("Windows ACL information structure fits in u32"),
            AclSizeInformation,
        )
    } == 0
    {
        return Err(io::Error::last_os_error()).context("failed to inspect test ACL size");
    }

    let mut aces = Vec::with_capacity(size.AceCount as usize);
    for index in 0..size.AceCount {
        let mut raw_ace = ptr::null_mut();
        // SAFETY: dacl remains live and raw_ace is writable output storage.
        if unsafe { GetAce(dacl, index, &raw mut raw_ace) } == 0 {
            return Err(io::Error::last_os_error()).context("failed to inspect test ACL entry");
        }
        let (raw_ace, ace) = checked_access_allowed_ace(dacl, size.AclBytesInUse, raw_ace)?;
        aces.push(InspectedAce {
            sid: copy_ace_sid(raw_ace, usize::from(ace.Header.AceSize))?,
            mask: ace.Mask,
            flags: ace.Header.AceFlags,
            ace_type: ace.Header.AceType,
        });
    }
    Ok(InspectedAcl {
        protected: control & SE_DACL_PROTECTED != 0,
        aces,
    })
}

fn make_permissive(path: &Path, kind: PrivatePathKind) -> Result<()> {
    let file = open_test_path(path, kind)?;
    let world = well_known_sid(WinWorldSid)?;
    let acl = private_acl(kind, &world, &world)?;
    set_protected_dacl(path, &file, &acl)
}

fn assert_inherits_world(path: &Path, kind: PrivatePathKind) {
    let world = well_known_sid(WinWorldSid).unwrap();
    let acl = inspect_acl(path, kind).unwrap();
    assert!(!acl.protected);
    assert!(acl.aces.iter().any(|ace| {
        // SAFETY: both SID buffers are validated and remain live for the comparison.
        (unsafe { EqualSid(ace.sid.as_ptr(), world.as_ptr()) }) != 0
            && u32::from(ace.flags) & INHERITED_ACE != 0
    }));
}

fn assert_private_acl(path: &Path, kind: PrivatePathKind) {
    let user = current_user_sid().unwrap();
    let system = local_system_sid().unwrap();
    let acl = inspect_acl(path, kind).unwrap();
    assert!(acl.protected, "{} DACL must be protected", path.display());
    // SAFETY: both SID buffers are validated and remain live for the comparison.
    let expected_len = if unsafe { EqualSid(user.as_ptr(), system.as_ptr()) } != 0 {
        1
    } else {
        2
    };
    assert_eq!(acl.aces.len(), expected_len);
    let expected_flags = match kind {
        PrivatePathKind::Directory => CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
        PrivatePathKind::File => 0,
    };
    let mut found_user = false;
    let mut found_system = false;
    for ace in &acl.aces {
        assert_eq!(ace.ace_type, ACCESS_ALLOWED_ACE_TYPE);
        assert_eq!(ace.mask, FILE_ALL_ACCESS);
        assert_eq!(u32::from(ace.flags), expected_flags);
        // SAFETY: both SID buffers are validated and remain live for the comparison.
        let is_user = unsafe { EqualSid(ace.sid.as_ptr(), user.as_ptr()) } != 0;
        // SAFETY: both SID buffers are validated and remain live for the comparison.
        let is_system = unsafe { EqualSid(ace.sid.as_ptr(), system.as_ptr()) } != 0;
        assert!(
            is_user || is_system,
            "{} DACL contains an unexpected trustee",
            path.display(),
        );
        found_user |= is_user;
        found_system |= is_system;
    }
    assert!(found_user);
    assert!(found_system);
}

fn permissive_parent(root: &Path) -> PathBuf {
    let parent = root.join("permissive");
    fs::create_dir(&parent).unwrap();
    make_permissive(&parent, PrivatePathKind::Directory).unwrap();
    parent
}

#[test]
fn reads_ipv4_from_sockaddr_with_weaker_alignment() {
    let mut storage = [0_u32; 8];
    // SAFETY: advancing one u16 stays within the live eight-u32 test buffer.
    let base = unsafe { storage.as_mut_ptr().cast::<u16>().add(1) };
    assert_eq!(base as usize % mem::align_of::<SOCKADDR_IN>(), 2);
    // SAFETY: the remaining test buffer is larger than SOCKADDR_IN and byte-aligned.
    let bytes =
        unsafe { std::slice::from_raw_parts_mut(base.cast::<u8>(), mem::size_of::<SOCKADDR_IN>()) };
    bytes[..2].copy_from_slice(&AF_INET.to_ne_bytes());
    let offset = mem::offset_of!(SOCKADDR_IN, sin_addr);
    bytes[offset..offset + 4].copy_from_slice(&[192, 168, 1, 25]);
    let socket_address = windows_sys::Win32::Networking::WinSock::SOCKET_ADDRESS {
        lpSockaddr: base.cast(),
        iSockaddrLength: i32::try_from(mem::size_of::<SOCKADDR_IN>())
            .expect("Windows socket address structure fits in i32"),
    };

    // SAFETY: socket_address points to the initialized test buffer of the stated length.
    let parsed = unsafe { ipv4_from_socket_address(socket_address) };
    assert_eq!(parsed, Some(Ipv4Addr::new(192, 168, 1, 25)));
    for length in [-1, 0, socket_address.iSockaddrLength - 1] {
        let invalid = windows_sys::Win32::Networking::WinSock::SOCKET_ADDRESS {
            iSockaddrLength: length,
            ..socket_address
        };
        // SAFETY: invalid points into the live test buffer; its shorter length is intentional.
        assert_eq!(unsafe { ipv4_from_socket_address(invalid) }, None);
    }
    let null = windows_sys::Win32::Networking::WinSock::SOCKET_ADDRESS {
        lpSockaddr: ptr::null_mut(),
        ..socket_address
    };
    // SAFETY: a null pointer is explicitly accepted and rejected before dereferencing.
    assert_eq!(unsafe { ipv4_from_socket_address(null) }, None);
}

#[test]
fn rejects_invalid_acl_entry_pointers_before_reading_them() {
    let mut words = [0_u32; 8];
    let dacl = words.as_mut_ptr().cast::<ACL>();
    let acl_bytes = u32::try_from(mem::size_of_val(&words)).expect("test buffer fits in u32");

    assert!(checked_access_allowed_ace(dacl, acl_bytes, ptr::null_mut()).is_err());

    // SAFETY: end is the permitted one-past pointer to the live test buffer.
    let end = unsafe { words.as_mut_ptr().cast::<u8>().add(acl_bytes as usize) };
    assert!(checked_access_allowed_ace(dacl, acl_bytes, end.cast()).is_err());

    // SAFETY: the ACL header size is smaller than the live test buffer.
    let ace = unsafe { words.as_mut_ptr().cast::<u8>().add(mem::size_of::<ACL>()) };
    // SAFETY: the remaining buffer fits an ACE_HEADER; unaligned writes are allowed.
    unsafe {
        ace.cast::<ACE_HEADER>().write_unaligned(ACE_HEADER {
            AceType: ACCESS_ALLOWED_ACE_TYPE,
            AceFlags: 0,
            AceSize: u16::try_from(mem::size_of::<ACCESS_ALLOWED_ACE>())
                .expect("test ACE size fits in u16"),
        });
    }
    let truncated_bytes = u32::try_from(mem::size_of::<ACL>() + mem::size_of::<ACE_HEADER>())
        .expect("test ACL size fits in u32");
    assert!(checked_access_allowed_ace(dacl, truncated_bytes, ace.cast()).is_err());
}

#[test]
fn hardens_an_existing_directory_in_a_permissive_parent() {
    let temp = tempdir().unwrap();
    let parent = permissive_parent(temp.path());
    let data = parent.join("data");
    fs::create_dir(&data).unwrap();
    assert_inherits_world(&data, PrivatePathKind::Directory);

    crate::store::create_private_dir(&data).unwrap();
    assert_private_acl(&data, PrivatePathKind::Directory);

    crate::store::create_private_dir(&data).unwrap();
    assert_private_acl(&data, PrivatePathKind::Directory);
}

#[test]
fn fallback_vault_parent_and_file_get_private_acls() {
    let temp = tempdir().unwrap();
    let parent = permissive_parent(temp.path());
    let data = parent.join("data");
    fs::create_dir(&data).unwrap();
    assert_inherits_world(&data, PrivatePathKind::Directory);
    crate::store::create_private_dir(&data).unwrap();

    let paths = crate::store::AppPaths::for_tests(data);
    let store = crate::secrets::SecretStore::file_backend_for_tests();
    store.get_or_create(&paths, "alpha-000000000001").unwrap();

    let secrets = paths
        .secret_vault_file_path()
        .parent()
        .unwrap()
        .to_path_buf();
    let vault = paths.secret_vault_file_path();
    assert_private_acl(paths.base_dir(), PrivatePathKind::Directory);
    assert_private_acl(&secrets, PrivatePathKind::Directory);
    assert_private_acl(&vault, PrivatePathKind::File);

    make_permissive(&vault, PrivatePathKind::File).unwrap();
    store
        .set_for_tests(&paths, "alpha-000000000001", "replacement-token")
        .unwrap();
    assert_private_acl(&vault, PrivatePathKind::File);
}
