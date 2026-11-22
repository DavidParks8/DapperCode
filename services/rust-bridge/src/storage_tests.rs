use super::{atomic_write_private, atomic_write_private_with};
use std::fs;
use std::path::Path;
use tokio::fs as async_fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

fn private_open_options(create_new: bool) -> async_fs::OpenOptions {
    let mut options = async_fs::OpenOptions::new();
    options.write(true).create(true).create_new(create_new);
    if !create_new {
        options.truncate(true);
    }
    #[cfg(unix)]
    options.mode(0o600);
    options
}

async fn write_private_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = private_open_options(true).open(path).await?;
    file.write_all(bytes).await?;
    file.sync_all().await
}

#[tokio::test]
async fn private_new_is_collision_safe_and_atomic_write_replaces() {
    let dir = std::env::temp_dir().join(format!("dappercode-storage-{}", Uuid::new_v4()));
    fs::create_dir(&dir).expect("create test directory");
    let path = dir.join("state.json");
    write_private_new(&path, b"one")
        .await
        .expect("initial write");
    assert!(write_private_new(&path, b"collision").await.is_err());
    atomic_write_private(&path, b"two")
        .await
        .expect("atomic replace");
    assert_eq!(fs::read(&path).expect("read state"), b"two");
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&path).unwrap().permissions())
            & 0o777,
        0o600,
    );
    let _ = fs::remove_dir_all(dir);
}

#[tokio::test]
async fn truncate_mode_replaces_contents_and_failed_atomic_write_cleans_up() {
    let dir = std::env::temp_dir().join(format!("dappercode-storage-errors-{}", Uuid::new_v4()));
    fs::create_dir(&dir).expect("create test directory");
    let path = dir.join("state");
    fs::write(&path, b"long contents").expect("seed file");
    let mut file = private_open_options(false)
        .open(&path)
        .await
        .expect("open truncate mode");
    use tokio::io::AsyncWriteExt;
    file.write_all(b"x").await.expect("write replacement");
    file.sync_all().await.expect("sync replacement");
    drop(file);
    assert_eq!(fs::read(&path).unwrap(), b"x");

    let missing_parent = dir.join("missing").join("state");
    assert!(atomic_write_private(&missing_parent, b"value")
        .await
        .is_err());
    atomic_write_private_with(
        &path,
        b"unpublished",
        |_| Err(std::io::Error::other("injected pre-publish failure")),
        |_| Ok(()),
    )
    .await
    .expect_err("pre-publish failure is definitive");
    assert_eq!(fs::read(&path).unwrap(), b"x");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    let _ = fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[tokio::test]
async fn atomic_write_secures_before_publish_and_treats_rename_as_commit() {
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!("dappercode-storage-durable-{}", Uuid::new_v4()));
    fs::create_dir(&dir).expect("create test directory");
    let path = dir.join("state.json");
    fs::write(&path, b"old").expect("seed state");
    atomic_write_private_with(
        &path,
        b"new",
        |temporary| {
            assert_eq!(fs::metadata(temporary)?.permissions().mode() & 0o777, 0o600);
            Ok(())
        },
        |_| Err(std::io::Error::other("injected parent sync failure")),
    )
    .await
    .expect("post-rename parent sync failure does not roll back the committed write");
    assert_eq!(fs::read(&path).expect("reopen replacement"), b"new");
    assert_eq!(
        fs::read_dir(&dir)
            .expect("list storage directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count(),
        0,
    );
    let _ = fs::remove_dir_all(dir);
}
