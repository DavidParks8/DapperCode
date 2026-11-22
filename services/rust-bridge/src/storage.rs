use std::path::Path;

use dappercode_bridge_platform::atomic_write_private_blocking;

pub(crate) async fn atomic_write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    atomic_write_private_with(path, bytes, |_| Ok(()), |_| Ok(())).await
}

async fn atomic_write_private_with<BeforePublish, BeforeParentSync>(
    path: &Path,
    bytes: &[u8],
    before_publish: BeforePublish,
    before_parent_sync: BeforeParentSync,
) -> std::io::Result<()>
where
    BeforePublish: FnOnce(&Path) -> std::io::Result<()> + Send + 'static,
    BeforeParentSync: FnOnce(&Path) -> std::io::Result<()> + Send + 'static,
{
    let parent = path
        .parent()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "storage path has no parent",
            )
        })?
        .to_path_buf();
    let file_name = path
        .file_name()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "storage path has no file name",
            )
        })?
        .to_os_string();
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || {
        atomic_write_private_blocking(
            &parent,
            &file_name,
            &bytes,
            before_publish,
            before_parent_sync,
        )
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "storage_tests.rs"]
mod tests;
