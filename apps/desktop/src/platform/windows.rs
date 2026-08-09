use std::{
    fs::{File, OpenOptions},
    io, mem,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    process::Command,
    ptr,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_BUFFER_OVERFLOW, ERROR_NO_DATA, FILETIME, GENERIC_READ, GENERIC_WRITE,
        HANDLE, NO_ERROR, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    NetworkManagement::{
        IpHelper::{
            GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
            GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IF_TYPE_SOFTWARE_LOOPBACK,
            IF_TYPE_TUNNEL, IP_ADAPTER_ADDRESSES_LH, IP_ADAPTER_RECEIVE_ONLY,
        },
        Ndis::IfOperStatusUp,
    },
    Networking::WinSock::{IpDadStatePreferred, AF_INET, SOCKADDR_IN},
    Security::{
        AddAccessAllowedAceEx,
        Authorization::{SetSecurityInfo, SE_FILE_OBJECT},
        CreateWellKnownSid, EqualSid, GetLengthSid, GetTokenInformation, InitializeAcl, IsValidSid,
        TokenUser, WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, PSID,
        SECURITY_MAX_SID_SIZE, TOKEN_QUERY, TOKEN_USER, WELL_KNOWN_SID_TYPE,
    },
    Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, GetFileType, FILE_ALL_ACCESS,
        FILE_ATTRIBUTE_DEVICE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK,
        READ_CONTROL, WRITE_DAC,
    },
    System::{
        Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT},
        Threading::{
            GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, TerminateProcess,
            WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        },
    },
};

use super::{
    ensure_private_path_kind, resolve_manual_lan_host, valid_non_loopback_ipv4,
    windows_support::{
        select_local_ipv4, windows_runtime_candidates, windows_tailscale_install_candidates,
        LocalIpv4Candidate,
    },
    CredentialLayout, NetworkMode, PlatformStrategy, PrivateAccessPrincipal, PrivatePathKind,
    PrivatePathState, ProcessStopRequest, SetupPreflightError, PRIVATE_ACCESS_PRINCIPALS,
};

const CREATE_NO_WINDOW: u32 = 0x08000000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
const DETACHED_PROCESS: u32 = 0x00000008;
const ADAPTER_BUFFER_SIZE: u32 = 15 * 1024;
const ADAPTER_QUERY_FLAGS: u32 = GAA_FLAG_SKIP_ANYCAST
    | GAA_FLAG_SKIP_MULTICAST
    | GAA_FLAG_SKIP_DNS_SERVER
    | GAA_FLAG_INCLUDE_GATEWAYS;
const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
const FORCE_STOP_TIMEOUT_MS: u32 = 3_000;

pub(super) static STRATEGY: WindowsStrategy = WindowsStrategy;

pub(super) struct WindowsStrategy;

#[async_trait]
impl PlatformStrategy for WindowsStrategy {
    #[cfg(test)]
    fn kind(&self) -> super::PlatformKind {
        super::PlatformKind::Windows
    }

    fn data_dir(&self) -> Result<PathBuf> {
        match std::env::var_os("APPDATA") {
            Some(value) if !value.is_empty() => Ok(PathBuf::from(value).join("DapperCode")),
            _ => bail!("APPDATA is not set; cannot locate the DapperCode data directory"),
        }
    }

    fn runtime_candidates(&self, executable: &Path) -> Vec<PathBuf> {
        windows_runtime_candidates(executable)
    }

    fn bridge_binary_name(&self) -> &'static str {
        "dappercode-bridge.exe"
    }

    fn agent_executable_name(&self, agent_id: &str) -> String {
        format!("{agent_id}.exe")
    }

    fn agent_search_roots(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    fn credential_layout(&self) -> CredentialLayout {
        CredentialLayout::WindowsPerProfile
    }

    fn resolve_bridge_host(
        &self,
        mode: NetworkMode,
        manual_lan_host: Option<&str>,
    ) -> Result<String, SetupPreflightError> {
        match mode {
            NetworkMode::Tailscale => resolve_tailscale_host(),
            NetworkMode::Local => resolve_lan_host(manual_lan_host),
        }
    }

    fn process_start_identity(&self, pid: u32, _sysinfo_start_time: u64) -> Result<u64> {
        let process = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        process_creation_time(process.0)
    }

    fn request_process_stop(
        &self,
        pid: u32,
        expected_start_time: u64,
        request: ProcessStopRequest,
    ) -> Result<bool> {
        let process = open_process(
            pid,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE_ACCESS,
        )?;
        if process_creation_time(process.0)? != expected_start_time {
            bail!("refusing to stop PID {pid} because its process identity changed");
        }
        ensure_process_has_current_user(process.0, pid)?;

        let state = unsafe { WaitForSingleObject(process.0, 0) };
        if state == WAIT_OBJECT_0 {
            return Ok(true);
        }
        if state != WAIT_TIMEOUT {
            return Err(io::Error::last_os_error())
                .with_context(|| format!("failed to inspect bridge process {pid}"));
        }

        match request {
            ProcessStopRequest::Graceful => {
                // CTRL+BREAK is the only targeted graceful stop Windows exposes for a console
                // process group. Detached/no-console processes use the forced fallback.
                Ok(unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) } != 0)
            }
            ProcessStopRequest::Force => {
                if unsafe { TerminateProcess(process.0, 1) } == 0 {
                    return Err(io::Error::last_os_error())
                        .with_context(|| format!("failed to terminate bridge process {pid}"));
                }
                let state = unsafe { WaitForSingleObject(process.0, FORCE_STOP_TIMEOUT_MS) };
                if state != WAIT_OBJECT_0 {
                    if state == WAIT_TIMEOUT {
                        bail!("bridge process {pid} did not stop after forced termination");
                    }
                    return Err(io::Error::last_os_error()).with_context(|| {
                        format!("failed waiting for bridge process {pid} to stop")
                    });
                }
                Ok(true)
            }
        }
    }

    fn configure_private_file_options(&self, options: &mut OpenOptions) {
        use std::os::windows::fs::OpenOptionsExt;

        options
            .access_mode(
                GENERIC_READ | GENERIC_WRITE | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC,
            )
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }

    fn secure_private_directory(&self, path: &Path) -> Result<()> {
        let directory = open_private_directory(path)?;
        apply_private_acl(path, &directory, PrivatePathKind::Directory)
    }

    fn secure_private_file(&self, path: &Path, file: &File) -> Result<()> {
        ensure_private_handle_kind(path, file, PrivatePathKind::File)?;
        apply_private_acl(path, file, PrivatePathKind::File)
    }

    fn detach_process(&self, command: &mut Command) {
        use std::os::windows::process::CommandExt;

        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }

    fn sync_parent_directory(&self, _path: &Path) -> std::io::Result<()> {
        Ok(())
    }

    async fn stop_child(
        &self,
        child: &mut tokio::process::Child,
        _graceful_timeout: Duration,
    ) -> Result<()> {
        child.kill().await.context("failed to kill worker")?;
        let _ = child.wait().await;
        Ok(())
    }

    async fn wait_for_shutdown_signal(&self) {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn file_handle(file: &File) -> HANDLE {
    use std::os::windows::io::AsRawHandle;

    file.as_raw_handle()
}

fn private_path_state(file: &File) -> Result<PrivatePathState> {
    let mut information = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            file_handle(file),
            FileAttributeTagInfo,
            ptr::addr_of_mut!(information).cast(),
            mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error()).context("failed to inspect private path");
    }
    let attributes = information.FileAttributes;
    let is_directory = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    Ok(PrivatePathState {
        is_directory,
        is_file: !is_directory
            && attributes & FILE_ATTRIBUTE_DEVICE == 0
            && unsafe { GetFileType(file_handle(file)) } == FILE_TYPE_DISK,
        is_reparse_point: attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
    })
}

fn ensure_private_handle_kind(path: &Path, file: &File, expected: PrivatePathKind) -> Result<()> {
    let state = private_path_state(file)
        .with_context(|| format!("failed to inspect private path {}", path.display()))?;
    ensure_private_path_kind(path, expected, state)
}

fn open_private_directory(path: &Path) -> Result<File> {
    use std::os::windows::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .access_mode(FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let directory = options
        .open(path)
        .with_context(|| format!("failed to open private directory {}", path.display()))?;
    ensure_private_handle_kind(path, &directory, PrivatePathKind::Directory)?;
    Ok(directory)
}

struct SidBuffer {
    words: Vec<usize>,
}

impl SidBuffer {
    fn copy_from(sid: PSID) -> Result<Self> {
        if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
            bail!("Windows returned an invalid user SID");
        }
        let byte_len = unsafe { GetLengthSid(sid) } as usize;
        if byte_len == 0 {
            bail!("Windows returned an empty user SID");
        }
        let mut words = vec![0_usize; byte_len.div_ceil(mem::size_of::<usize>())];
        unsafe {
            ptr::copy_nonoverlapping(sid.cast::<u8>(), words.as_mut_ptr().cast::<u8>(), byte_len);
        }
        Ok(Self { words })
    }

    fn as_ptr(&self) -> PSID {
        self.words.as_ptr().cast_mut().cast()
    }

    fn byte_len(&self) -> usize {
        unsafe { GetLengthSid(self.as_ptr()) as usize }
    }
}

fn open_process_token(process: HANDLE) -> Result<WindowsHandle> {
    let mut token: HANDLE = ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error()).context("failed to open process token");
    }
    Ok(WindowsHandle(token))
}

fn token_user_buffer(token: HANDLE) -> Result<Vec<usize>> {
    let mut required = 0_u32;
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut required);
    }
    if required < mem::size_of::<TOKEN_USER>() as u32 {
        return Err(io::Error::last_os_error()).context("failed to size process user token");
    }
    let words = (required as usize).div_ceil(mem::size_of::<usize>());
    let mut buffer = vec![0_usize; words];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * mem::size_of::<usize>()) as u32,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error()).context("failed to read process user token");
    }
    Ok(buffer)
}

fn process_user_sid(process: HANDLE) -> Result<SidBuffer> {
    let token = open_process_token(process)?;
    let user_buffer = token_user_buffer(token.0)?;
    let user = unsafe { &*user_buffer.as_ptr().cast::<TOKEN_USER>() };
    SidBuffer::copy_from(user.User.Sid)
}

fn current_user_sid() -> Result<SidBuffer> {
    process_user_sid(unsafe { GetCurrentProcess() }).context("failed to read current user SID")
}

fn well_known_sid(kind: WELL_KNOWN_SID_TYPE) -> Result<SidBuffer> {
    let byte_len = SECURITY_MAX_SID_SIZE as usize;
    let mut words = vec![0_usize; byte_len.div_ceil(mem::size_of::<usize>())];
    let mut written = SECURITY_MAX_SID_SIZE;
    if unsafe {
        CreateWellKnownSid(
            kind,
            ptr::null_mut(),
            words.as_mut_ptr().cast(),
            &mut written,
        )
    } == 0
    {
        return Err(io::Error::last_os_error()).context("failed to create a well-known SID");
    }
    words.truncate((written as usize).div_ceil(mem::size_of::<usize>()));
    let sid = SidBuffer { words };
    if unsafe { IsValidSid(sid.as_ptr()) } == 0 {
        bail!("Windows returned an invalid well-known SID");
    }
    Ok(sid)
}

fn local_system_sid() -> Result<SidBuffer> {
    well_known_sid(WinLocalSystemSid).context("failed to create the Local System SID")
}

struct AclBuffer {
    words: Vec<u32>,
}

impl AclBuffer {
    fn as_ptr(&self) -> *const ACL {
        self.words.as_ptr().cast()
    }
}

fn private_acl(kind: PrivatePathKind, user: &SidBuffer, system: &SidBuffer) -> Result<AclBuffer> {
    let mut trustees = Vec::with_capacity(PRIVATE_ACCESS_PRINCIPALS.len());
    for principal in PRIVATE_ACCESS_PRINCIPALS {
        let sid = match principal {
            PrivateAccessPrincipal::CurrentUser => user,
            PrivateAccessPrincipal::LocalSystem => system,
        };
        if trustees
            .iter()
            .all(|existing: &&SidBuffer| unsafe { EqualSid(existing.as_ptr(), sid.as_ptr()) } == 0)
        {
            trustees.push(sid);
        }
    }

    let acl_bytes = mem::size_of::<ACL>()
        + trustees
            .iter()
            .map(|sid| {
                mem::size_of::<ACCESS_ALLOWED_ACE>() - mem::size_of::<u32>() + sid.byte_len()
            })
            .sum::<usize>();
    let acl_len = u32::try_from(acl_bytes).context("private ACL is too large")?;
    let mut acl = AclBuffer {
        words: vec![0_u32; acl_bytes.div_ceil(mem::size_of::<u32>())],
    };
    let acl_ptr = acl.words.as_mut_ptr().cast::<ACL>();
    if unsafe { InitializeAcl(acl_ptr, acl_len, ACL_REVISION) } == 0 {
        return Err(io::Error::last_os_error()).context("failed to initialize private ACL");
    }
    let flags = match kind {
        PrivatePathKind::Directory => CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
        PrivatePathKind::File => 0,
    };
    for sid in trustees {
        if unsafe {
            AddAccessAllowedAceEx(acl_ptr, ACL_REVISION, flags, FILE_ALL_ACCESS, sid.as_ptr())
        } == 0
        {
            return Err(io::Error::last_os_error())
                .context("failed to add a trustee to the private ACL");
        }
    }
    Ok(acl)
}

fn apply_private_acl(path: &Path, file: &File, kind: PrivatePathKind) -> Result<()> {
    let user = current_user_sid()?;
    let system = local_system_sid()?;
    let acl = private_acl(kind, &user, &system)?;
    set_protected_dacl(path, file, &acl)
}

fn set_protected_dacl(path: &Path, file: &File, acl: &AclBuffer) -> Result<()> {
    let result = unsafe {
        SetSecurityInfo(
            file_handle(file),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            acl.as_ptr(),
            ptr::null(),
        )
    };
    if result != NO_ERROR {
        return Err(io::Error::from_raw_os_error(result as i32))
            .with_context(|| format!("failed to apply private ACL to {}", path.display()));
    }
    Ok(())
}

fn resolve_tailscale_host() -> Result<String, SetupPreflightError> {
    use std::os::windows::process::CommandExt;

    let tailscale = tailscale_path().ok_or(SetupPreflightError::MissingTailscale)?;
    let output = Command::new(tailscale)
        .args(["ip", "-4"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| SetupPreflightError::ProbeFailed(error.to_string()))?;
    if !output.status.success() {
        return Err(SetupPreflightError::TailscaleDisconnected);
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|value| valid_non_loopback_ipv4(value))
        .map(str::to_string)
        .ok_or(SetupPreflightError::TailscaleDisconnected)
}

fn tailscale_path() -> Option<PathBuf> {
    let mut candidates = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|directory| directory.join("tailscale.exe"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    candidates.extend(windows_tailscale_install_candidates(
        [
            "ProgramW6432",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "LOCALAPPDATA",
        ]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from),
    ));
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn resolve_lan_host(manual_lan_host: Option<&str>) -> Result<String, SetupPreflightError> {
    if let Some(result) = resolve_manual_lan_host(manual_lan_host) {
        return result;
    }
    discover_local_ipv4()?
        .map(|address| address.to_string())
        .ok_or(SetupPreflightError::LanHostRequired)
}

fn discover_local_ipv4() -> Result<Option<Ipv4Addr>, SetupPreflightError> {
    let mut byte_count = ADAPTER_BUFFER_SIZE;
    for _ in 0..3 {
        let word_count = (byte_count as usize).div_ceil(mem::size_of::<usize>());
        let mut storage = vec![0usize; word_count];
        let adapters = storage.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        let result = unsafe {
            GetAdaptersAddresses(
                AF_INET.into(),
                ADAPTER_QUERY_FLAGS,
                ptr::null(),
                adapters,
                &mut byte_count,
            )
        };
        if result == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if result == ERROR_NO_DATA {
            return Ok(None);
        }
        if result != NO_ERROR {
            return Err(SetupPreflightError::ProbeFailed(format!(
                "GetAdaptersAddresses failed with Windows error {result}"
            )));
        }
        return Ok(select_local_ipv4(unsafe {
            collect_adapter_candidates(adapters)
        }));
    }
    Err(SetupPreflightError::ProbeFailed(
        "Windows adapter data changed repeatedly during discovery".to_string(),
    ))
}

unsafe fn collect_adapter_candidates(
    mut adapter: *mut IP_ADAPTER_ADDRESSES_LH,
) -> Vec<LocalIpv4Candidate> {
    let mut candidates = Vec::new();
    while let Some(current) = unsafe { adapter.as_ref() } {
        let flags = unsafe { current.Anonymous2.Flags };
        if current.OperStatus == IfOperStatusUp
            && current.IfType != IF_TYPE_SOFTWARE_LOOPBACK
            && current.IfType != IF_TYPE_TUNNEL
            && flags & IP_ADAPTER_RECEIVE_ONLY == 0
            && current.PhysicalAddressLength > 0
            && (current.TransmitLinkSpeed > 0 || current.ReceiveLinkSpeed > 0)
            && !current.FirstGatewayAddress.is_null()
        {
            let interface_index = unsafe { current.Anonymous1.Anonymous.IfIndex };
            let mut unicast = current.FirstUnicastAddress;
            while let Some(address) = unsafe { unicast.as_ref() } {
                if address.DadState == IpDadStatePreferred {
                    if let Some(address) = unsafe { ipv4_from_socket_address(address.Address) } {
                        candidates.push(LocalIpv4Candidate {
                            address,
                            metric: current.Ipv4Metric,
                            interface_index,
                        });
                    }
                }
                unicast = address.Next;
            }
        }
        adapter = current.Next;
    }
    candidates
}

unsafe fn ipv4_from_socket_address(
    socket_address: windows_sys::Win32::Networking::WinSock::SOCKET_ADDRESS,
) -> Option<Ipv4Addr> {
    if socket_address.lpSockaddr.is_null()
        || socket_address.iSockaddrLength < mem::size_of::<SOCKADDR_IN>() as i32
        || unsafe { (*socket_address.lpSockaddr).sa_family } != AF_INET
    {
        return None;
    }
    let address = unsafe { &*socket_address.lpSockaddr.cast::<SOCKADDR_IN>() };
    let octets = unsafe {
        ptr::read_unaligned(
            ptr::addr_of!(address.sin_addr)
                .cast::<u8>()
                .cast::<[u8; 4]>(),
        )
    };
    Some(Ipv4Addr::from(octets))
}

struct WindowsHandle(HANDLE);

impl Drop for WindowsHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn open_process(pid: u32, access: u32) -> Result<WindowsHandle> {
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        return Err(io::Error::last_os_error())
            .with_context(|| format!("failed to open bridge process {pid}"));
    }
    Ok(WindowsHandle(handle))
}

fn process_creation_time(process: HANDLE) -> Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error()).context("failed to read process creation time");
    }
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

fn ensure_process_has_current_user(process: HANDLE, pid: u32) -> Result<()> {
    let target = process_user_sid(process)
        .with_context(|| format!("failed to verify the user for bridge process {pid}"))?;
    let current = current_user_sid()?;
    if unsafe { EqualSid(target.as_ptr(), current.as_ptr()) } == 0 {
        bail!(
            "refusing to stop bridge process {pid} because it belongs to a different Windows user"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            AclSizeInformation, Authorization::GetSecurityInfo, GetAce, GetAclInformation,
            GetSecurityDescriptorControl, WinWorldSid, ACL_SIZE_INFORMATION, INHERITED_ACE,
            PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
        },
    };

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);

    impl Drop for LocalSecurityDescriptor {
        fn drop(&mut self) {
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
        let result = unsafe {
            GetSecurityInfo(
                file_handle(&file),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if result != NO_ERROR {
            return Err(io::Error::from_raw_os_error(result as i32))
                .context("failed to inspect test ACL");
        }
        if descriptor.is_null() || dacl.is_null() {
            bail!("test path has no DACL");
        }
        let _descriptor = LocalSecurityDescriptor(descriptor);

        let mut control = 0_u16;
        let mut revision = 0_u32;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            return Err(io::Error::last_os_error())
                .context("failed to inspect test security descriptor control");
        }
        let mut size = ACL_SIZE_INFORMATION::default();
        if unsafe {
            GetAclInformation(
                dacl,
                ptr::addr_of_mut!(size).cast(),
                mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err(io::Error::last_os_error()).context("failed to inspect test ACL size");
        }

        let mut aces = Vec::with_capacity(size.AceCount as usize);
        for index in 0..size.AceCount {
            let mut raw_ace = ptr::null_mut();
            if unsafe { GetAce(dacl, index, &mut raw_ace) } == 0 {
                return Err(io::Error::last_os_error()).context("failed to inspect test ACL entry");
            }
            let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
            aces.push(InspectedAce {
                sid: SidBuffer::copy_from(ptr::addr_of!(ace.SidStart).cast_mut().cast())?,
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
            (unsafe { EqualSid(ace.sid.as_ptr(), world.as_ptr()) }) != 0
                && u32::from(ace.flags) & INHERITED_ACE != 0
        }));
    }

    fn assert_private_acl(path: &Path, kind: PrivatePathKind) {
        let user = current_user_sid().unwrap();
        let system = local_system_sid().unwrap();
        let acl = inspect_acl(path, kind).unwrap();
        assert!(acl.protected, "{} DACL must be protected", path.display());
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
            let is_user = unsafe { EqualSid(ace.sid.as_ptr(), user.as_ptr()) } != 0;
            let is_system = unsafe { EqualSid(ace.sid.as_ptr(), system.as_ptr()) } != 0;
            assert!(
                is_user || is_system,
                "{} DACL contains an unexpected trustee",
                path.display()
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
            .set(&paths, "alpha-000000000001", "replacement-token")
            .unwrap();
        assert_private_acl(&vault, PrivatePathKind::File);
    }
}
