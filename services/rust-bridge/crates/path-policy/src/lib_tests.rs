#[cfg(windows)]
use super::DEFAULT_ATTACHMENTS_DIR_NAME;
use super::{PathKind, PathPolicy};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("dappercode-path-policy-{}", Uuid::new_v4()));
        fs::create_dir(&path).expect("create test directory");
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(windows)]
fn create_directory_reparse(target: &std::path::Path, link: &std::path::Path) {
    if std::os::windows::fs::symlink_dir(target, link).is_ok() {
        return;
    }
    let status = std::process::Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .expect("run mklink");
    assert!(
        status.success(),
        "failed to create a directory reparse point",
    );
}

#[test]
fn canonicalizes_relative_and_absolute_existing_paths() {
    let temp = TestDir::new();
    let root = temp.0.join("root");
    let nested = root.join("nested");
    fs::create_dir_all(&nested).expect("create nested directory");
    let policy = PathPolicy::new(root.clone(), false).expect("create policy");

    assert_eq!(
        policy
            .resolve_existing("nested/.", PathKind::Directory)
            .expect("resolve relative path"),
        fs::canonicalize(&nested).expect("canonical nested path"),
    );
    assert_eq!(
        policy
            .resolve_existing(nested.to_str().expect("utf-8 path"), PathKind::Directory)
            .expect("resolve absolute path"),
        fs::canonicalize(&nested).expect("canonical nested path"),
    );
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escape_when_outside_root_is_disabled() {
    use std::os::unix::fs::symlink;

    let temp = TestDir::new();
    let root = temp.0.join("root");
    let outside = temp.0.join("outside");
    fs::create_dir_all(&root).expect("create root");
    fs::create_dir_all(&outside).expect("create outside");
    symlink(&outside, root.join("escape")).expect("create escape symlink");
    let policy = PathPolicy::new(root, false).expect("create policy");

    let error = policy
        .resolve_cwd(Some("escape"))
        .expect_err("reject symlink escape");
    assert_eq!(error.code, -32602);
    assert!(error.message.contains("BRIDGE_WORKDIR"));
}

#[cfg(unix)]
#[test]
fn allows_canonical_outside_path_only_when_configured() {
    use std::os::unix::fs::symlink;

    let temp = TestDir::new();
    let root = temp.0.join("root");
    let outside = temp.0.join("outside");
    fs::create_dir_all(&root).expect("create root");
    fs::create_dir_all(&outside).expect("create outside");
    symlink(&outside, root.join("escape")).expect("create escape symlink");
    let policy = PathPolicy::new(root, true).expect("create policy");

    assert_eq!(
        policy.resolve_cwd(Some("escape")).expect("allow outside"),
        fs::canonicalize(outside).expect("canonical outside"),
    );
}

#[cfg(unix)]
#[test]
fn root_owned_storage_rejects_symlink_even_when_outside_is_allowed() {
    use std::os::unix::fs::symlink;

    let temp = TestDir::new();
    let root = temp.0.join("root");
    let outside = temp.0.join("outside");
    fs::create_dir_all(&root).expect("create root");
    fs::create_dir_all(&outside).expect("create outside");
    symlink(&outside, root.join("attachments")).expect("create escape symlink");
    let policy = PathPolicy::new(root, true).expect("create policy");

    let error = policy
        .resolve_root_owned_directory(PathBuf::from("attachments/thread").as_path())
        .expect_err("reject root-owned symlink escape");
    assert_eq!(error.code, -32602);

    let attachment_error = policy
        .secure_attachments_directory(PathBuf::from("../escaped").as_path())
        .expect_err("reject traversal out of the attachments root");
    assert_eq!(attachment_error.code, -32602);
}

#[cfg(any(unix, windows))]
#[test]
fn descriptor_open_rejects_unsafe_final_component_swap() {
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    let temp = TestDir::new();
    let root = temp.0.join("root");
    let outside = temp.0.join("outside.txt");
    fs::create_dir_all(root.join("images")).expect("create image directory");
    fs::write(root.join("images/image.png"), b"inside").expect("write inside image");
    fs::write(&outside, b"outside-secret").expect("write outside file");
    let policy = PathPolicy::new(root.clone(), false).expect("create policy");

    let error = policy
        .open_regular_file_beneath_with("images/image.png", || {
            fs::remove_file(root.join("images/image.png")).expect("remove inside image");
            #[cfg(unix)]
            symlink(&outside, root.join("images/image.png")).expect("swap image to symlink");
            #[cfg(windows)]
            fs::hard_link(&outside, root.join("images/image.png"))
                .expect("swap image to a hard link");
        })
        .expect_err("reject swapped unsafe file");

    assert_eq!(error.code, -32602);
}

#[cfg(any(unix, windows))]
#[test]
fn retained_directories_prevent_attachment_rename_escape() {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    let temp = TestDir::new();
    let root = temp.0.join("root");
    let outside = temp.0.join("outside");
    fs::create_dir(&root).expect("create root");
    fs::create_dir(&outside).expect("create outside");
    let policy = PathPolicy::new(root.clone(), false).expect("create policy");
    let staging = policy
        .secure_attachments_directory(PathBuf::from(".tmp").as_path())
        .expect("open staging directory");
    policy
        .secure_attachments_directory(PathBuf::from("thread").as_path())
        .expect("open target directory");
    staging
        .create_file("upload.tmp")
        .expect("create staged file")
        .write_all(b"inside")
        .expect("write staged file");

    let detached = outside.join("detached-thread");
    let attachments_root = policy.attachments_root().to_path_buf();
    let error = policy
        .rename_attachment_file_with(
            &staging,
            "upload.tmp",
            PathBuf::from("thread").as_path(),
            "saved.txt",
            || {
                fs::rename(attachments_root.join("thread"), &detached)
                    .expect("move target outside root");
                #[cfg(unix)]
                symlink(&outside, attachments_root.join("thread")).expect("swap target to symlink");
                #[cfg(windows)]
                create_directory_reparse(&outside, &attachments_root.join("thread"));
            },
        )
        .expect_err("reject swapped target directory");

    assert_eq!(error.code, -32602);
    assert!(!outside.join("saved.txt").exists());
    assert!(!detached.join("saved.txt").exists());
    #[cfg(windows)]
    fs::remove_dir(attachments_root.join("thread")).expect("remove test junction");
}

#[cfg(any(unix, windows))]
#[test]
fn a_central_attachments_root_is_readable_but_only_that_directory() {
    use std::io::Write;

    let temp = TestDir::new();
    let root = temp.0.join("root");
    let central = temp.0.join("central/attachments");
    let outside = temp.0.join("outside");
    fs::create_dir_all(&root).expect("create root");
    fs::create_dir_all(&outside).expect("create outside");
    fs::write(outside.join("secret.txt"), b"secret").expect("write outside file");

    let policy = PathPolicy::with_attachments_root(root.clone(), false, Some(central.clone()))
        .expect("create policy with a central attachments root");
    let central = central.canonicalize().expect("canonical attachments root");
    assert_eq!(policy.attachments_root(), central);
    assert!(!central.starts_with(policy.root()));

    // An upload lands in the central root and stays readable by absolute path.
    let staging = policy
        .secure_attachments_directory(&PathBuf::from(".tmp"))
        .expect("open staging");
    staging
        .create_file("upload.tmp")
        .expect("create staged file")
        .write_all(b"payload")
        .expect("write staged file");
    let saved = policy
        .rename_attachment_file(
            &staging,
            "upload.tmp",
            &PathBuf::from("threads"),
            "saved.txt",
        )
        .expect("finalize upload");
    assert!(saved.starts_with(&central));

    let (mut file, resolved) = policy
        .open_regular_file_beneath(saved.to_str().expect("utf-8 path"))
        .expect("read the attachment back");
    let mut contents = String::new();
    std::io::Read::read_to_string(&mut file, &mut contents).expect("read attachment");
    assert_eq!(contents, "payload");
    assert_eq!(resolved, saved);

    // Widening access to the attachments root must not widen it to anything else.
    let escape = outside.join("secret.txt");
    assert!(policy
        .open_regular_file_beneath(escape.to_str().expect("utf-8 path"))
        .is_err());
    assert!(policy
        .resolve_existing(escape.to_str().expect("utf-8 path"), PathKind::File)
        .is_err());
    assert!(policy.resolve_existing("", PathKind::Any).is_err());
}

#[test]
fn a_relative_attachments_root_is_rejected() {
    let temp = TestDir::new();
    let root = temp.0.join("root");
    fs::create_dir_all(&root).expect("create root");

    let error =
        PathPolicy::with_attachments_root(root, false, Some(PathBuf::from("relative/uploads")))
            .expect_err("relative attachments roots must be rejected");
    assert!(error.contains("must be an absolute path"), "{error}");
}

#[cfg(any(unix, windows))]
#[test]
fn a_non_regular_or_hardlinked_attachment_is_refused() {
    let temp = TestDir::new();
    let root = temp.0.join("root");
    fs::create_dir_all(root.join("images")).expect("create image directory");
    fs::write(root.join("images/image.png"), b"image").expect("write image");
    let policy = PathPolicy::new(root.clone(), false).expect("create policy");

    // A directory is not a regular file.
    assert!(policy.open_regular_file_beneath("images").is_err());
    // Traversal cannot be laundered through an absolute workspace path.
    let traversal = root.join("images/../../escape");
    assert!(policy
        .open_regular_file_beneath(traversal.to_str().expect("utf-8 path"))
        .is_err());
}

#[cfg(any(unix, windows))]
#[test]
fn descriptor_api_covers_valid_invalid_and_cleanup_paths() {
    use std::io::{Read, Write};

    let temp = TestDir::new();
    let root = temp.0.join("root");
    fs::create_dir_all(root.join("images")).expect("create image directory");
    fs::write(root.join("images/image.png"), b"image").expect("write image");
    let policy = PathPolicy::new(root.clone(), false).expect("create policy");

    for requested in [
        "images/image.png".to_string(),
        policy
            .root()
            .join("images/image.png")
            .to_string_lossy()
            .to_string(),
    ] {
        let (mut file, path) = policy
            .open_regular_file_beneath(&requested)
            .expect("open secure image");
        let mut contents = Vec::new();
        file.read_to_end(&mut contents).expect("read secure image");
        assert_eq!(contents, b"image");
        assert_eq!(path, policy.root().join("images/image.png"));
    }

    for requested in ["", ".", "../outside", "/tmp/outside", "images"] {
        assert!(
            policy.open_regular_file_beneath(requested).is_err(),
            "accepted {requested:?}",
        );
    }

    fs::hard_link(
        root.join("images/image.png"),
        root.join("images/image-hardlink.png"),
    )
    .expect("create hardlink");
    assert!(policy
        .open_regular_file_beneath("images/image-hardlink.png")
        .is_err());

    for invalid in [PathBuf::new(), PathBuf::from("../bad"), root.clone()] {
        assert!(policy.secure_attachments_directory(&invalid).is_err());
    }
    fs::write(policy.attachments_root().join("blocked"), b"file").expect("write blocking file");
    assert!(policy
        .secure_attachments_directory(PathBuf::from("blocked/child").as_path())
        .is_err());

    let staging = policy
        .secure_attachments_directory(PathBuf::from("storage/.tmp").as_path())
        .expect("create staging");
    policy
        .secure_attachments_directory(PathBuf::from("storage/.tmp").as_path())
        .expect("reopen existing staging");
    for name in ["", "../bad", "nested/bad"] {
        assert!(staging.create_file(name).is_err(), "accepted {name:?}");
    }
    #[cfg(windows)]
    for name in ["stream.txt:data", "trailing.", "CON"] {
        assert!(staging.create_file(name).is_err(), "accepted {name:?}");
    }
    let mut staged = staging.create_file("upload.tmp").expect("create upload");
    staged.write_all(b"payload").expect("write upload");
    staged.sync_all().expect("sync upload");
    drop(staged);
    assert!(staging.create_file("upload.tmp").is_err());
    staging.remove_file("../ignored");

    let final_directory = policy
        .secure_attachments_directory(PathBuf::from("storage/final").as_path())
        .expect("create final directory");
    assert!(staging
        .rename_to("../bad", &final_directory, "saved.txt")
        .is_err());
    assert!(staging
        .rename_to("upload.tmp", &final_directory, "nested/bad")
        .is_err());

    let saved = policy
        .rename_attachment_file(
            &staging,
            "upload.tmp",
            PathBuf::from("storage/final").as_path(),
            "saved.txt",
        )
        .expect("finalize upload");
    assert_eq!(fs::read(saved).expect("read finalized upload"), b"payload");
    assert!(policy
        .rename_attachment_file(
            &staging,
            "missing.tmp",
            PathBuf::from("storage/final").as_path(),
            "missing.txt",
        )
        .is_err());
    let cleanup = staging.create_file("cleanup.tmp").expect("create cleanup");
    drop(cleanup);
    staging.remove_file("cleanup.tmp");
    assert!(!policy
        .attachments_root()
        .join("storage/.tmp/cleanup.tmp")
        .exists());
}

#[cfg(windows)]
#[test]
fn windows_rejects_reparse_roots_and_reparse_traversal() {
    let temp = TestDir::new();
    let root = temp.0.join("root");
    let outside = temp.0.join("outside");
    fs::create_dir(&root).expect("create root");
    fs::create_dir(&outside).expect("create outside");
    fs::write(outside.join("secret.txt"), b"secret").expect("write outside file");

    let workspace_link = temp.0.join("workspace-link");
    create_directory_reparse(&root, &workspace_link);
    assert!(PathPolicy::new(workspace_link.clone(), false).is_err());
    fs::remove_dir(workspace_link).expect("remove workspace junction");

    let attachment_link = root.join(DEFAULT_ATTACHMENTS_DIR_NAME);
    create_directory_reparse(&outside, &attachment_link);
    let error = PathPolicy::new(root.clone(), false)
        .expect_err("reject a reparse point as the attachments root");
    assert!(!error.is_empty());
    fs::remove_dir(&attachment_link).expect("remove attachments junction");

    let policy = PathPolicy::new(root, false).expect("create policy");
    let traversal_link = policy.attachments_root().join("escape");
    create_directory_reparse(&outside, &traversal_link);
    assert!(policy
        .secure_attachments_directory(PathBuf::from("escape/child").as_path())
        .is_err());
    assert!(policy
        .open_regular_file_beneath(
            traversal_link
                .join("secret.txt")
                .to_str()
                .expect("utf-8 test path"),
        )
        .is_err());
    fs::remove_dir(traversal_link).expect("remove traversal junction");
}

#[cfg(windows)]
#[test]
fn windows_handles_block_directory_swaps_and_hardlinked_finalization() {
    use std::io::Write;

    let temp = TestDir::new();
    let root = temp.0.join("root");
    let outside = temp.0.join("outside");
    fs::create_dir(&root).expect("create root");
    fs::create_dir(&outside).expect("create outside");
    let policy = PathPolicy::new(root, false).expect("create policy");

    let retained = policy
        .secure_attachments_directory(PathBuf::from("retained").as_path())
        .expect("retain directory handles");
    let retained_path = policy.attachments_root().join("retained");
    let moved_path = outside.join("moved");
    fs::rename(&retained_path, &moved_path)
        .expect_err("an open no-delete-share handle must block a path swap");
    drop(retained);
    fs::rename(&retained_path, &moved_path)
        .expect("directory can move after its retained handle closes");
    fs::rename(&moved_path, &retained_path).expect("restore directory");

    let staging = policy
        .secure_attachments_directory(PathBuf::from(".tmp").as_path())
        .expect("open staging directory");
    let mut staged = staging
        .create_file("hardlinked.upload")
        .expect("create staged file");
    staged.write_all(b"payload").expect("write staged file");
    staged.sync_all().expect("sync staged file");
    drop(staged);
    let staged_path = policy.attachments_root().join(".tmp/hardlinked.upload");
    let outside_link = outside.join("hardlinked.upload");
    fs::hard_link(&staged_path, &outside_link).expect("create hostile hard link");

    assert!(policy
        .rename_attachment_file(
            &staging,
            "hardlinked.upload",
            PathBuf::from("final").as_path(),
            "saved.txt",
        )
        .is_err());
    assert!(!policy.attachments_root().join("final/saved.txt").exists());
    fs::remove_file(outside_link).expect("remove hostile hard link");
    staging.remove_file("hardlinked.upload");
}

#[test]
fn constructor_rejects_relative_missing_and_file_roots() {
    let temp = TestDir::new();
    assert!(PathPolicy::new(PathBuf::from("relative"), false).is_err());
    assert!(PathPolicy::new(temp.0.join("missing"), false).is_err());

    let file = temp.0.join("file");
    fs::write(&file, b"contents").expect("write root file");
    assert!(PathPolicy::new(file, false).is_err());
}

#[test]
fn resolves_default_cwd_and_checks_all_path_kinds() {
    let temp = TestDir::new();
    let root = temp.0.join("root");
    fs::create_dir(&root).expect("create root");
    let file = root.join("file.txt");
    fs::write(&file, b"contents").expect("write file");
    let policy = PathPolicy::new(root.clone(), false).expect("create policy");

    assert_eq!(
        policy.resolve_cwd(None).unwrap(),
        fs::canonicalize(&root).unwrap(),
    );
    assert_eq!(
        policy.resolve_cwd(Some("  ")).unwrap(),
        fs::canonicalize(&root).unwrap(),
    );
    assert_eq!(
        policy.resolve_existing("file.txt", PathKind::Any).unwrap(),
        fs::canonicalize(&file).unwrap(),
    );
    assert!(policy.resolve_existing("file.txt", PathKind::File).is_ok());
    assert!(policy
        .resolve_existing("file.txt", PathKind::Directory)
        .is_err());
    assert!(policy.resolve_existing(".", PathKind::File).is_err());
    assert!(policy.resolve_existing(" ", PathKind::Any).is_err());
    assert!(policy.resolve_existing("missing", PathKind::Any).is_err());
}

#[test]
fn root_owned_targets_and_browsing_enforce_boundaries() {
    let temp = TestDir::new();
    let root = temp.0.join("root");
    fs::create_dir(&root).expect("create root");
    let policy = PathPolicy::new(root.clone(), false).expect("create policy");

    assert!(policy.resolve_root_owned_target(&root).is_err());
    assert!(policy
        .resolve_root_owned_target(PathBuf::from("a/../b").as_path())
        .is_err());
    assert_eq!(
        policy
            .resolve_root_owned_target(PathBuf::from("a/b").as_path())
            .unwrap(),
        fs::canonicalize(&root).unwrap().join("a/b"),
    );

    let file = root.join("owned-file");
    fs::write(&file, b"contents").expect("write owned file");
    assert!(policy
        .resolve_root_owned_directory(PathBuf::from("owned-file").as_path())
        .is_err());
    assert_eq!(policy.parent_for_browsing(policy.root()), None);
    assert_eq!(
        policy.parent_for_browsing(&policy.root().join("child")),
        Some(policy.root().to_path_buf()),
    );

    let outside_policy = PathPolicy::new(root, true).expect("create outside policy");
    assert_eq!(
        outside_policy.parent_for_browsing(outside_policy.root()),
        outside_policy.root().parent().map(PathBuf::from),
    );
}
