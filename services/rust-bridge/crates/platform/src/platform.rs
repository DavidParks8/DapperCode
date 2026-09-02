//! Compile-time-selected operating-system services.
//!
//! Production modules use this facade instead of branching on an operating system. The selected
//! strategy owns native handles, syscalls, process semantics, and platform-specific discovery.

use std::{
    ffi::OsStr,
    fmt::Debug,
    fs::{File, Metadata},
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    time::Duration,
};

use tokio::process::{Child, Command};

use dappercode_bridge_core::BridgeError;

#[cfg(unix)]
#[path = "platform/unix.rs"]
mod current;
#[cfg(windows)]
#[path = "platform/windows.rs"]
mod current;
#[cfg(not(any(unix, windows)))]
#[path = "platform/unsupported.rs"]
mod current;

pub(crate) use current::CurrentPlatform;

pub(crate) type PlatformFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Debug)]
pub(crate) struct PlatformSecureRoots<Handle> {
    pub(crate) root: PathBuf,
    pub(crate) attachments_root: PathBuf,
    pub(crate) root_handle: Handle,
    pub(crate) attachments_handle: Handle,
}

#[derive(Debug)]
pub struct SecureRoots {
    pub root: PathBuf,
    pub attachments_root: PathBuf,
    pub root_handle: SecureRootHandle,
    pub attachments_handle: SecureRootHandle,
}

pub(crate) trait SecureFilesystemStrategy {
    type RootHandle: Clone + Debug + Send + Sync + 'static;
    type DirectoryHandle: Debug + Send + Sync + 'static;

    fn validate_workdir(&self, root: &Path) -> Result<PathBuf, String>;

    fn initialize_secure_roots(
        &self,
        root: &Path,
        attachments_root: Option<&Path>,
        default_attachments_name: &OsStr,
    ) -> Result<PlatformSecureRoots<Self::RootHandle>, String>;

    fn path_component_is_valid(&self, name: &OsStr) -> bool;

    fn relative_beneath(&self, path: &Path, root: &Path) -> Option<PathBuf>;

    fn open_regular_file_beneath<BeforeFinalOpen>(
        &self,
        base_root: &Path,
        base_handle: &Self::RootHandle,
        relative: &Path,
        before_final_open: BeforeFinalOpen,
    ) -> Result<(File, PathBuf), BridgeError>
    where
        BeforeFinalOpen: FnOnce();

    fn secure_directory_beneath(
        &self,
        base_handle: &Self::RootHandle,
        relative: &Path,
    ) -> Result<Self::DirectoryHandle, BridgeError>;

    fn create_secure_file(
        &self,
        directory: &Self::DirectoryHandle,
        name: &str,
    ) -> Result<File, BridgeError>;

    fn rename_secure_file(
        &self,
        source: &Self::DirectoryHandle,
        source_name: &str,
        target: &Self::DirectoryHandle,
        target_name: &str,
    ) -> Result<(), BridgeError>;

    fn remove_secure_file(&self, directory: &Self::DirectoryHandle, name: &str);

    fn tree_mode(&self, metadata: &Metadata) -> String;

    fn file_has_multiple_links(&self, path: &Path, metadata: &Metadata) -> io::Result<bool>;
}

pub(crate) trait PrivateStorageStrategy {
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
        BeforeParentSync: FnOnce(&Path) -> io::Result<()>;
}

pub(crate) trait ProcessStrategy {
    fn process_is_alive(&self, pid: u32) -> bool;

    fn wait_for_owner_exit(&'static self, pid: u32) -> PlatformFuture<()>;

    fn wait_for_shutdown_signal(&'static self) -> PlatformFuture<&'static str>;

    /// Applies lifecycle behavior before a Git child is spawned.
    fn configure_git_command(&self, command: &mut Command);

    /// Synchronously terminates the Git child and its descendants.
    ///
    /// This must not return while a descendant can still retain the command's stdout or stderr
    /// pipe handles. Callers join their pipe readers after this hook and hold a semaphore permit
    /// until those readers reach EOF.
    fn kill_git_process_group(&self, child: &Child);

    fn git_global_config_path(&self) -> &'static str;
}

pub(crate) trait PreviewStrategy {
    fn discover_loopback_listening_ports(&'static self) -> PlatformFuture<Vec<u16>>;
}

pub(crate) trait PlatformStrategy:
    SecureFilesystemStrategy + PrivateStorageStrategy + ProcessStrategy + PreviewStrategy
{
}

impl<T> PlatformStrategy for T where
    T: SecureFilesystemStrategy + PrivateStorageStrategy + ProcessStrategy + PreviewStrategy
{
}

#[derive(Clone, Debug)]
pub struct SecureRootHandle(<CurrentPlatform as SecureFilesystemStrategy>::RootHandle);

#[derive(Debug)]
pub struct SecureDirectoryHandle(<CurrentPlatform as SecureFilesystemStrategy>::DirectoryHandle);

static PLATFORM: CurrentPlatform = CurrentPlatform;

fn current_platform() -> &'static CurrentPlatform {
    fn require_complete_strategy<T: PlatformStrategy>(strategy: &T) -> &T {
        strategy
    }
    require_complete_strategy(&PLATFORM)
}

pub fn validate_workdir(root: &Path) -> Result<PathBuf, String> {
    current_platform().validate_workdir(root)
}

pub fn initialize_secure_roots(
    root: &Path,
    attachments_root: Option<&Path>,
    default_attachments_name: &OsStr,
) -> Result<SecureRoots, String> {
    let roots = current_platform().initialize_secure_roots(
        root,
        attachments_root,
        default_attachments_name,
    )?;
    Ok(SecureRoots {
        root: roots.root,
        attachments_root: roots.attachments_root,
        root_handle: SecureRootHandle(roots.root_handle),
        attachments_handle: SecureRootHandle(roots.attachments_handle),
    })
}

pub fn path_component_is_valid(name: &OsStr) -> bool {
    current_platform().path_component_is_valid(name)
}

pub fn relative_beneath(path: &Path, root: &Path) -> Option<PathBuf> {
    current_platform().relative_beneath(path, root)
}

pub fn open_regular_file_beneath<BeforeFinalOpen>(
    base_root: &Path,
    base_handle: &SecureRootHandle,
    relative: &Path,
    before_final_open: BeforeFinalOpen,
) -> Result<(File, PathBuf), BridgeError>
where
    BeforeFinalOpen: FnOnce(),
{
    current_platform().open_regular_file_beneath(
        base_root,
        &base_handle.0,
        relative,
        before_final_open,
    )
}

pub fn secure_directory_beneath(
    base_handle: &SecureRootHandle,
    relative: &Path,
) -> Result<SecureDirectoryHandle, BridgeError> {
    current_platform()
        .secure_directory_beneath(&base_handle.0, relative)
        .map(SecureDirectoryHandle)
}

pub fn create_secure_file(
    directory: &SecureDirectoryHandle,
    name: &str,
) -> Result<File, BridgeError> {
    current_platform().create_secure_file(&directory.0, name)
}

pub fn rename_secure_file(
    source: &SecureDirectoryHandle,
    source_name: &str,
    target: &SecureDirectoryHandle,
    target_name: &str,
) -> Result<(), BridgeError> {
    current_platform().rename_secure_file(&source.0, source_name, &target.0, target_name)
}

pub fn remove_secure_file(directory: &SecureDirectoryHandle, name: &str) {
    current_platform().remove_secure_file(&directory.0, name);
}

pub fn tree_mode(metadata: &Metadata) -> String {
    current_platform().tree_mode(metadata)
}

pub fn file_has_multiple_links(path: &Path, metadata: &Metadata) -> io::Result<bool> {
    current_platform().file_has_multiple_links(path, metadata)
}

pub fn atomic_write_private_blocking<BeforePublish, BeforeParentSync>(
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
    current_platform().atomic_write_private_blocking(
        parent,
        file_name,
        bytes,
        before_publish,
        before_parent_sync,
    )
}

pub fn process_is_alive(pid: u32) -> bool {
    current_platform().process_is_alive(pid)
}

pub async fn wait_for_owner_exit(pid: u32) {
    current_platform().wait_for_owner_exit(pid).await;
}

pub async fn wait_for_shutdown_signal() -> &'static str {
    current_platform().wait_for_shutdown_signal().await
}

pub fn configure_git_command(command: &mut Command) {
    current_platform().configure_git_command(command);
}

pub fn kill_git_process_group(child: &Child) {
    current_platform().kill_git_process_group(child);
}

pub fn git_global_config_path() -> &'static str {
    current_platform().git_global_config_path()
}

pub async fn discover_loopback_listening_ports() -> Vec<u16> {
    current_platform().discover_loopback_listening_ports().await
}

pub async fn poll_while_owner_is_alive(
    mut owner_is_alive: impl FnMut() -> bool,
    interval: Duration,
) {
    while owner_is_alive() {
        tokio::time::sleep(interval).await;
    }
}

#[cfg(any(windows, test))]
pub(crate) fn owner_identity_matches(
    expected_creation_time: Option<u64>,
    creation_time: u64,
) -> bool {
    expected_creation_time == Some(creation_time)
}

#[cfg(any(windows, test))]
pub(crate) fn zero_timeout_wait_means_alive(wait_result: u32, wait_timeout: u32) -> bool {
    wait_result == wait_timeout
}

#[cfg(all(windows, any(test, feature = "test-support")))]
pub fn test_observed_process_creation_time(pid: u32) -> Option<u64> {
    current::observed_creation_time(pid)
}

#[cfg(all(windows, any(test, feature = "test-support")))]
pub fn test_process_creation_time(pid: u32) -> io::Result<u64> {
    current::process_creation_time(pid)
}

#[cfg(all(windows, any(test, feature = "test-support")))]
pub async fn test_wait_for_owner_exit_with_identity(pid: u32, expected_creation_time: Option<u64>) {
    current::wait_for_owner_exit_with_identity(pid, expected_creation_time).await;
}

pub(crate) async fn read_command_stdout(program: &str, args: &[&str]) -> Option<String> {
    use std::process::Stdio;

    let output = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(crate) fn collect_ports_from_lsof(output: &str, ports: &mut std::collections::HashSet<u16>) {
    for line in output.lines().filter(|line| line.contains("(LISTEN)")) {
        if let Some(port) = line
            .split(" TCP ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(parse_listening_socket_port)
        {
            ports.insert(port);
        }
    }
}

pub(crate) fn parse_listening_socket_port(value: &str) -> Option<u16> {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix('[') {
        let (host, remainder) = rest.split_once(']')?;
        return is_loopback_listen_host(host)
            .then_some(remainder.strip_prefix(':')?.parse::<u16>().ok())?;
    }
    let (host, port) = value.rsplit_once(':')?;
    is_loopback_listen_host(host).then_some(port.parse::<u16>().ok())?
}

fn is_loopback_listen_host(host: &str) -> bool {
    matches!(
        host,
        "*" | "127.0.0.1" | "0.0.0.0" | "::1" | "::" | "localhost"
    )
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn platform_strategy_is_complete() {
        fn assert_strategy<T: PlatformStrategy>() {}
        assert_strategy::<CurrentPlatform>();
    }

    #[test]
    fn socket_parser_rejects_non_loopback_and_malformed_addresses() {
        for (value, expected) in [
            ("*:3000", Some(3000)),
            ("127.0.0.1:5173", Some(5173)),
            ("0.0.0.0:8080", Some(8080)),
            ("localhost:4200", Some(4200)),
            ("[::1]:4321", Some(4321)),
            ("[::]:8000", Some(8000)),
            ("10.0.0.1:3000", None),
            ("[2001:db8::1]:3000", None),
            ("[::1]3000", None),
            ("localhost:not-a-port", None),
            ("missing-port", None),
        ] {
            assert_eq!(parse_listening_socket_port(value), expected, "{value}");
        }
    }

    #[test]
    fn lsof_parser_collects_only_loopback_listeners() {
        let mut ports = HashSet::new();
        collect_ports_from_lsof(
            "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n\
             node 1 user 1u IPv4 0 0t0 TCP 127.0.0.1:3000 (LISTEN)\n\
             node 2 user 1u IPv4 0 0t0 UDP 127.0.0.1:4000\n\
             node 3 user 1u IPv4 0 0t0 TCP 10.0.0.1:5000 (LISTEN)\n\
             malformed TCP missing (LISTEN)",
            &mut ports,
        );
        assert_eq!(ports, HashSet::from([3000]));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_reader_distinguishes_success_failure_and_missing_program() {
        assert_eq!(
            read_command_stdout("/bin/sh", &["-c", "printf success"])
                .await
                .as_deref(),
            Some("success")
        );
        assert!(read_command_stdout("/bin/sh", &["-c", "exit 1"])
            .await
            .is_none());
        assert!(read_command_stdout("/definitely/missing/program", &[])
            .await
            .is_none());
    }

    #[test]
    fn process_identity_and_bounded_wait_results_fail_closed() {
        assert!(owner_identity_matches(Some(42), 42));
        assert!(!owner_identity_matches(Some(41), 42));
        assert!(!owner_identity_matches(None, 42));

        const WAIT_OBJECT_0: u32 = 0;
        const WAIT_TIMEOUT: u32 = 258;
        const WAIT_FAILED: u32 = u32::MAX;
        assert!(zero_timeout_wait_means_alive(WAIT_TIMEOUT, WAIT_TIMEOUT));
        assert!(!zero_timeout_wait_means_alive(WAIT_OBJECT_0, WAIT_TIMEOUT));
        assert!(!zero_timeout_wait_means_alive(WAIT_FAILED, WAIT_TIMEOUT));
    }
}
