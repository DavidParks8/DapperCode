#![cfg_attr(all(test, coverage_nightly), feature(coverage_attribute))]
#![cfg_attr(dylint_lib = "perfectionist", feature(register_tool))]
#![cfg_attr(dylint_lib = "perfectionist", register_tool(perfectionist))]
#![forbid(unsafe_code)]

//! Secure workspace and attachment path resolution over opaque native handles.

use dappercode_bridge_core::protocol_constants::DEFAULT_ATTACHMENTS_DIR_NAME;
use dappercode_bridge_core::BridgeError;
use dappercode_bridge_platform::{self as platform, SecureDirectoryHandle, SecureRootHandle};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    Any,
    Directory,
    File,
}

#[derive(Debug, Clone)]
pub struct PathPolicy {
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
pub struct SecureDirectory {
    handle: SecureDirectoryHandle,
}

impl SecureDirectory {
    pub fn create_file(&self, name: &str) -> Result<std::fs::File, BridgeError> {
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

    pub fn remove_file(&self, name: &str) {
        if validate_child_name(name).is_ok() {
            platform::remove_secure_file(&self.handle, name);
        }
    }
}

impl PathPolicy {
    pub fn validate_workdir(root: PathBuf) -> Result<PathBuf, String> {
        if !root.is_absolute() {
            return Err(format!(
                "BRIDGE_WORKDIR must be an absolute path (got: {})",
                root.to_string_lossy(),
            ));
        }
        platform::validate_workdir(&root)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn new(root: PathBuf, allow_outside_root: bool) -> Result<Self, String> {
        Self::with_attachments_root(root, allow_outside_root, None)
    }

    pub fn with_attachments_root(
        root: PathBuf,
        allow_outside_root: bool,
        attachments_root: Option<PathBuf>,
    ) -> Result<Self, String> {
        if !root.is_absolute() {
            return Err(format!(
                "BRIDGE_WORKDIR must be an absolute path (got: {})",
                root.to_string_lossy(),
            ));
        }
        if let Some(path) = attachments_root.as_deref() {
            if !path.is_absolute() {
                return Err(format!(
                    "BRIDGE_ATTACHMENTS_DIR must be an absolute path (got: {})",
                    path.to_string_lossy(),
                ));
            }
        }
        let roots = platform::initialize_secure_roots(
            &root,
            attachments_root.as_deref(),
            std::ffi::OsStr::new(DEFAULT_ATTACHMENTS_DIR_NAME),
        )?;
        Ok(Self {
            root: roots.root,
            attachments_root: roots.attachments_root,
            allow_outside_root,
            root_handle: roots.root_handle,
            attachments_handle: roots.attachments_handle,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn attachments_root(&self) -> &Path {
        &self.attachments_root
    }

    pub fn resolve_cwd(&self, raw: Option<&str>) -> Result<PathBuf, BridgeError> {
        let raw = raw.map(str::trim).filter(|value| !value.is_empty());
        self.resolve_existing_from(self.root(), raw.unwrap_or("."), PathKind::Directory)
    }

    pub fn resolve_existing(&self, raw: &str, kind: PathKind) -> Result<PathBuf, BridgeError> {
        self.resolve_existing_from(self.root(), raw, kind)
    }

    pub fn resolve_existing_from(
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
            BridgeError::invalid_params(format!(
                "path is invalid or inaccessible ({}): {error}",
                candidate.to_string_lossy(),
            ))
        })?;
        self.enforce_scope(&canonical, false)?;

        let metadata = std::fs::metadata(&canonical).map_err(|error| {
            BridgeError::invalid_params(format!(
                "failed to inspect path ({}): {error}",
                canonical.to_string_lossy(),
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
            return Err(BridgeError::invalid_params(format!(
                "path must point to {expected}",
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
            BridgeError::server(format!("failed to create root-owned directory: {error}"))
        })?;
        let canonical = std::fs::canonicalize(&target).map_err(|error| {
            BridgeError::server(format!("failed to resolve root-owned directory: {error}"))
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
            BridgeError::invalid_params(format!(
                "root-owned path is invalid or inaccessible: {error}",
            ))
        })?;
        self.enforce_scope(&canonical_ancestor, true)?;
        let suffix = target
            .strip_prefix(ancestor)
            .map_err(|_| BridgeError::invalid_params("failed to resolve root-owned path suffix"))?;
        Ok(canonical_ancestor.join(suffix))
    }

    pub fn open_regular_file_beneath(
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
    pub fn secure_attachments_directory(
        &self,
        relative: &Path,
    ) -> Result<SecureDirectory, BridgeError> {
        validate_relative_components(relative)?;
        Ok(SecureDirectory {
            handle: platform::secure_directory_beneath(&self.attachments_handle, relative)?,
        })
    }

    pub fn rename_attachment_file(
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

    pub fn parent_for_browsing(&self, path: &Path) -> Option<PathBuf> {
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
#[path = "lib_tests.rs"]
mod tests;
