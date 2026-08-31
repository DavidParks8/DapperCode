use std::path::Component;
use std::path::{Path, PathBuf};

use crate::{
    platform::{self, SecureDirectoryHandle, SecureRootHandle},
    BridgeError,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PathKind {
    Any,
    Directory,
    File,
}

#[derive(Debug, Clone)]
pub(crate) struct PathPolicy {
    root: PathBuf,
    /// Second allowed root holding mobile uploads.
    ///
    /// Attachments live in the central DapperCode data directory so that nothing app-owned is
    /// written into a user's repository, but agents and the mobile client still need to read them
    /// back by path. Only this directory is granted the extra access.
    attachments_root: PathBuf,
    allow_outside_root: bool,
    root_handle: SecureRootHandle,
    attachments_handle: SecureRootHandle,
}

#[derive(Debug)]
pub(crate) struct SecureDirectory {
    handle: SecureDirectoryHandle,
}

impl SecureDirectory {
    pub(crate) fn create_file(&self, name: &str) -> Result<std::fs::File, BridgeError> {
        validate_child_name(name)?;
        platform::create_secure_file(&self.handle, name)
    }

    fn rename_to(
        &self,
        source_name: &str,
        target: &Self,
        target_name: &str,
    ) -> Result<(), BridgeError> {
        validate_child_name(source_name)?;
        validate_child_name(target_name)?;
        platform::rename_secure_file(&self.handle, source_name, &target.handle, target_name)
    }

    pub(crate) fn remove_file(&self, name: &str) {
        if validate_child_name(name).is_ok() {
            platform::remove_secure_file(&self.handle, name);
        }
    }
}

impl PathPolicy {
    pub(crate) fn validate_workdir(root: PathBuf) -> Result<PathBuf, String> {
        if !root.is_absolute() {
            return Err(format!(
                "BRIDGE_WORKDIR must be an absolute path (got: {})",
                root.to_string_lossy()
            ));
        }
        platform::validate_workdir(&root)
    }

    #[cfg(test)]
    pub(crate) fn new(root: PathBuf, allow_outside_root: bool) -> Result<Self, String> {
        Self::with_attachments_root(root, allow_outside_root, None)
    }

    pub(crate) fn with_attachments_root(
        root: PathBuf,
        allow_outside_root: bool,
        attachments_root: Option<PathBuf>,
    ) -> Result<Self, String> {
        if !root.is_absolute() {
            return Err(format!(
                "BRIDGE_WORKDIR must be an absolute path (got: {})",
                root.to_string_lossy()
            ));
        }
        if let Some(path) = attachments_root.as_deref() {
            if !path.is_absolute() {
                return Err(format!(
                    "BRIDGE_ATTACHMENTS_DIR must be an absolute path (got: {})",
                    path.to_string_lossy()
                ));
            }
        }
        let roots = platform::initialize_secure_roots(
            &root,
            attachments_root.as_deref(),
            std::ffi::OsStr::new(crate::attachments::DEFAULT_ATTACHMENTS_DIR_NAME),
        )?;
        Ok(Self {
            root: roots.root,
            attachments_root: roots.attachments_root,
            allow_outside_root,
            root_handle: roots.root_handle,
            attachments_handle: roots.attachments_handle,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    #[cfg(test)]
    pub(crate) fn attachments_root(&self) -> &Path {
        &self.attachments_root
    }

    pub(crate) fn resolve_cwd(&self, raw: Option<&str>) -> Result<PathBuf, BridgeError> {
        let raw = raw.map(str::trim).filter(|value| !value.is_empty());
        self.resolve_existing_from(self.root(), raw.unwrap_or("."), PathKind::Directory)
    }

    pub(crate) fn resolve_existing(
        &self,
        raw: &str,
        kind: PathKind,
    ) -> Result<PathBuf, BridgeError> {
        self.resolve_existing_from(self.root(), raw, kind)
    }

    pub(crate) fn resolve_existing_from(
        &self,
        base: &Path,
        raw: &str,
        kind: PathKind,
    ) -> Result<PathBuf, BridgeError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(BridgeError::invalid_params("path must not be empty"));
        }
        let requested = PathBuf::from(trimmed);
        let candidate = if requested.is_absolute() {
            requested
        } else {
            base.join(requested)
        };
        let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
            BridgeError::invalid_params(&format!(
                "path is invalid or inaccessible ({}): {error}",
                candidate.to_string_lossy()
            ))
        })?;
        self.enforce_scope(&canonical, false)?;

        let metadata = std::fs::metadata(&canonical).map_err(|error| {
            BridgeError::invalid_params(&format!(
                "failed to inspect path ({}): {error}",
                canonical.to_string_lossy()
            ))
        })?;
        let valid_kind = match kind {
            PathKind::Any => true,
            PathKind::Directory => metadata.is_dir(),
            PathKind::File => metadata.is_file(),
        };
        if !valid_kind {
            let expected = match kind {
                PathKind::Any => unreachable!("existing paths satisfy PathKind::Any"),
                PathKind::Directory => "a directory",
                PathKind::File => "a file",
            };
            return Err(BridgeError::invalid_params(&format!(
                "path must point to {expected}"
            )));
        }
        Ok(canonical)
    }

    #[cfg(test)]
    pub(crate) fn resolve_root_owned_directory(
        &self,
        relative: &Path,
    ) -> Result<PathBuf, BridgeError> {
        let target = self.resolve_root_owned_target(relative)?;
        std::fs::create_dir_all(&target).map_err(|error| {
            BridgeError::server(&format!("failed to create root-owned directory: {error}"))
        })?;
        let canonical = std::fs::canonicalize(&target).map_err(|error| {
            BridgeError::server(&format!("failed to resolve root-owned directory: {error}"))
        })?;
        self.enforce_scope(&canonical, true)?;
        if !canonical.is_dir() {
            return Err(BridgeError::invalid_params(
                "root-owned path must point to a directory",
            ));
        }
        Ok(canonical)
    }

    #[cfg(test)]
    pub(crate) fn resolve_root_owned_target(
        &self,
        relative: &Path,
    ) -> Result<PathBuf, BridgeError> {
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(BridgeError::invalid_params(
                "root-owned path must be a relative child path",
            ));
        }

        let target = self.root.join(relative);
        let mut ancestor = target.as_path();
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or_else(|| {
                BridgeError::invalid_params("root-owned path has no existing ancestor")
            })?;
        }
        let canonical_ancestor = std::fs::canonicalize(ancestor).map_err(|error| {
            BridgeError::invalid_params(&format!(
                "root-owned path is invalid or inaccessible: {error}"
            ))
        })?;
        self.enforce_scope(&canonical_ancestor, true)?;
        let suffix = target
            .strip_prefix(ancestor)
            .map_err(|_| BridgeError::invalid_params("failed to resolve root-owned path suffix"))?;
        Ok(canonical_ancestor.join(suffix))
    }

    pub(crate) fn open_regular_file_beneath(
        &self,
        raw: &str,
    ) -> Result<(std::fs::File, PathBuf), BridgeError> {
        self.open_regular_file_beneath_with(raw, || {})
    }

    fn open_regular_file_beneath_with(
        &self,
        raw: &str,
        before_final_open: impl FnOnce(),
    ) -> Result<(std::fs::File, PathBuf), BridgeError> {
        let (base_root, base_handle, relative) = self.secure_relative_path(raw)?;
        platform::open_regular_file_beneath(base_root, base_handle, &relative, before_final_open)
    }

    /// Creates (or opens) a directory beneath the attachments root.
    pub(crate) fn secure_attachments_directory(
        &self,
        relative: &Path,
    ) -> Result<SecureDirectory, BridgeError> {
        validate_relative_components(relative)?;
        Ok(SecureDirectory {
            handle: platform::secure_directory_beneath(&self.attachments_handle, relative)?,
        })
    }

    pub(crate) fn rename_attachment_file(
        &self,
        source: &SecureDirectory,
        source_name: &str,
        target_relative: &Path,
        target_name: &str,
    ) -> Result<PathBuf, BridgeError> {
        self.rename_attachment_file_with(source, source_name, target_relative, target_name, || {})
    }

    fn rename_attachment_file_with(
        &self,
        source: &SecureDirectory,
        source_name: &str,
        target_relative: &Path,
        target_name: &str,
        before_target_open: impl FnOnce(),
    ) -> Result<PathBuf, BridgeError> {
        before_target_open();
        let target = self.secure_attachments_directory(target_relative)?;
        source.rename_to(source_name, &target, target_name)?;
        Ok(self
            .attachments_root
            .join(target_relative)
            .join(target_name))
    }

    /// Resolves a caller-supplied path to the allowed root that owns it.
    ///
    /// Absolute paths may name either the workspace root or the attachments root; relative paths are
    /// always interpreted against the workspace root.
    fn secure_relative_path(
        &self,
        raw: &str,
    ) -> Result<(&Path, &SecureRootHandle, PathBuf), BridgeError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(BridgeError::invalid_params("path must not be empty"));
        }
        let requested = Path::new(trimmed);
        let (base_root, base_handle, relative) = if requested.is_absolute() {
            if let Some(relative) = platform::relative_beneath(requested, &self.attachments_root) {
                (
                    self.attachments_root.as_path(),
                    &self.attachments_handle,
                    relative,
                )
            } else {
                let relative =
                    platform::relative_beneath(requested, &self.root).ok_or_else(|| {
                        BridgeError::invalid_params("path must stay beneath BRIDGE_WORKDIR")
                    })?;
                (self.root.as_path(), &self.root_handle, relative)
            }
        } else {
            (
                self.root.as_path(),
                &self.root_handle,
                requested.to_path_buf(),
            )
        };
        validate_relative_components(&relative)?;
        Ok((base_root, base_handle, relative))
    }

    pub(crate) fn parent_for_browsing(&self, path: &Path) -> Option<PathBuf> {
        if !self.allow_outside_root && path == self.root {
            return None;
        }
        path.parent().map(Path::to_path_buf)
    }

    fn enforce_scope(&self, canonical: &Path, root_owned: bool) -> Result<(), BridgeError> {
        if !(root_owned || !self.allow_outside_root) {
            return Ok(());
        }
        if canonical.starts_with(&self.root) || canonical.starts_with(&self.attachments_root) {
            return Ok(());
        }
        Err(BridgeError::invalid_params(
            "path must stay within BRIDGE_WORKDIR",
        ))
    }
}

fn validate_relative_components(path: &Path) -> Result<(), BridgeError> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(BridgeError::invalid_params(
            "path must be a relative child beneath BRIDGE_WORKDIR",
        ));
    }
    if path.components().any(|component| {
        let Component::Normal(name) = component else {
            return true;
        };
        !platform::path_component_is_valid(name)
    }) {
        return Err(BridgeError::invalid_params(
            "path contains a platform-unsafe component",
        ));
    }
    Ok(())
}

fn validate_child_name(name: &str) -> Result<(), BridgeError> {
    validate_relative_components(Path::new(name))?;
    if Path::new(name).components().count() != 1 {
        return Err(BridgeError::invalid_params(
            "file name must be one path component",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::{PathKind, PathPolicy};
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("dappercode-path-policy-{}", Uuid::new_v4()));
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
            "failed to create a directory reparse point"
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
            fs::canonicalize(&nested).expect("canonical nested path")
        );
        assert_eq!(
            policy
                .resolve_existing(nested.to_str().expect("utf-8 path"), PathKind::Directory)
                .expect("resolve absolute path"),
            fs::canonicalize(&nested).expect("canonical nested path")
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
            fs::canonicalize(outside).expect("canonical outside")
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
                    symlink(&outside, attachments_root.join("thread"))
                        .expect("swap target to symlink");
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
                "accepted {requested:?}"
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

        let attachment_link = root.join(crate::attachments::DEFAULT_ATTACHMENTS_DIR_NAME);
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
            fs::canonicalize(&root).unwrap()
        );
        assert_eq!(
            policy.resolve_cwd(Some("  ")).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
        assert_eq!(
            policy.resolve_existing("file.txt", PathKind::Any).unwrap(),
            fs::canonicalize(&file).unwrap()
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
            fs::canonicalize(&root).unwrap().join("a/b")
        );

        let file = root.join("owned-file");
        fs::write(&file, b"contents").expect("write owned file");
        assert!(policy
            .resolve_root_owned_directory(PathBuf::from("owned-file").as_path())
            .is_err());
        assert_eq!(policy.parent_for_browsing(policy.root()), None);
        assert_eq!(
            policy.parent_for_browsing(&policy.root().join("child")),
            Some(policy.root().to_path_buf())
        );

        let outside_policy = PathPolicy::new(root, true).expect("create outside policy");
        assert_eq!(
            outside_policy.parent_for_browsing(outside_policy.root()),
            outside_policy.root().parent().map(PathBuf::from)
        );
    }
}
