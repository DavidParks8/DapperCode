use std::{
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
        CloseHandle, ERROR_BUFFER_OVERFLOW, ERROR_NO_DATA, FILETIME, HANDLE, NO_ERROR,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
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
    Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_USER},
    System::{
        Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT},
        Threading::{
            GetCurrentProcess, GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        },
    },
};

use super::{
    resolve_manual_lan_host, valid_non_loopback_ipv4,
    windows_support::{
        select_local_ipv4, windows_runtime_candidates, windows_tailscale_install_candidates,
        LocalIpv4Candidate,
    },
    CredentialLayout, NetworkMode, PlatformStrategy, ProcessStopRequest, SetupPreflightError,
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
    fn open_token(process: HANDLE) -> Result<WindowsHandle> {
        use windows_sys::Win32::{Security::TOKEN_QUERY, System::Threading::OpenProcessToken};

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

    let target_token = open_token(process)
        .with_context(|| format!("failed to verify the user for bridge process {pid}"))?;
    let current_token =
        open_token(unsafe { GetCurrentProcess() }).context("failed to read current user token")?;
    let target_user = token_user_buffer(target_token.0)?;
    let current_user = token_user_buffer(current_token.0)?;
    let target = unsafe { &*target_user.as_ptr().cast::<TOKEN_USER>() };
    let current = unsafe { &*current_user.as_ptr().cast::<TOKEN_USER>() };
    if unsafe { EqualSid(target.User.Sid, current.User.Sid) } == 0 {
        bail!(
            "refusing to stop bridge process {pid} because it belongs to a different Windows user"
        );
    }
    Ok(())
}
