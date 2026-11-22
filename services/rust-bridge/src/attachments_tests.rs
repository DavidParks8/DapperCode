use super::{
    append_bounded_chunk, build_attachment_file_name, infer_extension_from_mime,
    infer_image_content_type_from_path, non_empty, normalize_attachment_kind, sanitize_filename,
    sanitize_path_segment, save_multipart_attachment,
};
use dappercode_bridge_core::BridgeError;
use std::path::Path;
use tokio::fs as async_fs;

async fn private_new_file(path: &Path) -> Result<async_fs::File, BridgeError> {
    let mut options = async_fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).await.map_err(|error| {
        BridgeError::server(format!("failed to create attachment staging file: {error}"))
    })
}

async fn secure_directory(path: &Path) -> Result<(), BridgeError> {
    #[cfg(unix)]
    async_fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
        .await
        .map_err(|error| {
            BridgeError::server(format!(
                "failed to secure attachment staging directory: {error}",
            ))
        })?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
use axum::body::Body;
use axum::extract::{FromRequest, Multipart};
use axum::http::header::CONTENT_TYPE;
use axum::http::Request;
#[cfg(any(unix, windows))]
use dappercode_bridge_core::protocol_constants::DEFAULT_ATTACHMENTS_DIR_NAME;
use dappercode_bridge_core::resource_limits::ATTACHMENT_MAX_BYTES;
use dappercode_bridge_path_policy::PathPolicy;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

type MultipartPart<'a> = (&'a str, Option<&'a str>, Option<&'a str>, &'a [u8]);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("dappercode-attachments-{}", Uuid::new_v4()));
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

async fn multipart(body: Vec<u8>, boundary: &str) -> Multipart {
    let request = Request::builder()
        .header(
            CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap();
    Multipart::from_request(request, &()).await.unwrap()
}

fn multipart_body(boundary: &str, parts: &[MultipartPart<'_>]) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, file_name, content_type, value) in parts {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"").as_bytes(),
        );
        if let Some(file_name) = file_name {
            body.extend_from_slice(format!(r#"; filename="{file_name}""#).as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        if let Some(content_type) = content_type {
            body.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(value);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

#[test]
fn metadata_normalization_is_safe() {
    assert_eq!(normalize_attachment_kind(Some("image"), None), "image");
    assert_eq!(normalize_attachment_kind(None, Some("text/plain")), "file");
    assert_eq!(
        build_attachment_file_name(Some("../unsafe name"), Some("image/jpeg"), "image"),
        "unsafe_name.jpg",
    );
}

#[test]
fn metadata_helpers_cover_defaults_limits_and_supported_types() {
    assert_eq!(non_empty("  value  ".into()), Some("value".into()));
    assert_eq!(non_empty("   ".into()), None);
    assert_eq!(
        normalize_attachment_kind(Some(" FILE "), Some("image/png")),
        "file",
    );
    assert_eq!(
        normalize_attachment_kind(Some("other"), Some(" IMAGE/PNG ")),
        "image",
    );
    assert_eq!(normalize_attachment_kind(None, None), "file");
    assert_eq!(
        build_attachment_file_name(None, Some("image/png"), "image"),
        "image.png",
    );
    assert_eq!(build_attachment_file_name(None, None, "file"), "attachment");
    assert_eq!(
        build_attachment_file_name(Some("report.txt"), Some("application/pdf"), "file"),
        "report.txt",
    );
    assert_eq!(sanitize_filename("///...///"), "attachment");
    assert_eq!(sanitize_filename(&"a".repeat(100)).len(), 96);
    assert_eq!(sanitize_path_segment(" __a/b__ "), "a_b");
    assert_eq!(sanitize_path_segment(&"a".repeat(70)).len(), 64);

    for (mime, extension) in [
        ("image/jpeg", Some("jpg")),
        ("image/jpg", Some("jpg")),
        ("image/png", Some("png")),
        ("image/webp", Some("webp")),
        ("image/gif", Some("gif")),
        ("image/heic", Some("heic")),
        ("image/heif", Some("heif")),
        ("text/plain", Some("txt")),
        ("application/json", Some("json")),
        ("application/pdf", Some("pdf")),
        ("unknown", None),
    ] {
        assert_eq!(infer_extension_from_mime(Some(mime)), extension);
    }
    assert_eq!(infer_extension_from_mime(None), None);

    for (path, mime) in [
        ("image.PNG", Some("image/png")),
        ("image.jpg", Some("image/jpeg")),
        ("image.jpeg", Some("image/jpeg")),
        ("image.gif", Some("image/gif")),
        ("image.webp", Some("image/webp")),
        ("image.heic", Some("image/heic")),
        ("image.heif", Some("image/heif")),
        ("image.txt", None),
        ("image", None),
    ] {
        assert_eq!(
            infer_image_content_type_from_path(PathBuf::from(path).as_path()),
            mime,
        );
    }
}

#[tokio::test]
async fn multipart_upload_saves_normalized_file_in_thread_directory() {
    let temp = TestDir::new();
    let root = temp.0.join("root");
    fs::create_dir(&root).unwrap();
    let policy = PathPolicy::new(root.clone(), false).unwrap();
    let boundary = "upload-boundary";
    let body = multipart_body(
        boundary,
        &[
            ("threadId", None, None, b"codex:thread/one"),
            ("kind", None, None, b"image"),
            ("fileName", None, None, b"../safe name"),
            (
                "file",
                Some("ignored.bin"),
                Some("application/octet-stream"),
                b"abc",
            ),
            ("mimeType", None, None, b"image/png"),
        ],
    );
    let uploaded = save_multipart_attachment(multipart(body, boundary).await, &policy)
        .await
        .unwrap();
    assert_eq!(uploaded.file_name, "safe_name.png");
    assert_eq!(uploaded.mime_type.as_deref(), Some("image/png"));
    assert_eq!(uploaded.size_bytes, 3);
    assert_eq!(uploaded.kind, "image");
    assert!(PathBuf::from(&uploaded.path).is_file());
    assert!(uploaded.path.contains("thread_one"));

    let body = multipart_body(
        boundary,
        &[
            ("threadId", None, None, b"___"),
            ("file", None, None, b"plain"),
        ],
    );
    let uploaded = save_multipart_attachment(multipart(body, boundary).await, &policy)
        .await
        .expect("save attachment without optional metadata");
    assert_eq!(uploaded.file_name, "attachment");
    assert_eq!(uploaded.mime_type, None);
    assert_eq!(uploaded.kind, "file");
    assert_eq!(
        PathBuf::from(uploaded.path).parent(),
        Some(policy.attachments_root().join("threads").as_path()),
    );
}

#[tokio::test]
async fn multipart_upload_rejects_missing_empty_duplicate_and_unsupported_fields() {
    let temp = TestDir::new();
    let root = temp.0.join("root");
    fs::create_dir(&root).unwrap();
    let policy = PathPolicy::new(root.clone(), false).unwrap();
    let boundary = "reject-boundary";

    let cases = [
        multipart_body(boundary, &[("kind", None, None, b"file")]),
        multipart_body(boundary, &[("file", Some("empty"), None, b"")]),
        multipart_body(
            boundary,
            &[
                ("file", Some("one"), None, b"one"),
                ("file", Some("two"), None, b"two"),
            ],
        ),
        multipart_body(
            boundary,
            &[
                ("unsupported", None, None, b"value"),
                ("file", Some("one"), None, b"one"),
            ],
        ),
    ];
    for body in cases {
        assert!(
            save_multipart_attachment(multipart(body, boundary).await, &policy)
                .await
                .is_err(),
        );
    }

    let temporary_dir = policy.attachments_root().join(".tmp");
    assert!(fs::read_dir(temporary_dir).unwrap().next().is_none());
}

#[tokio::test]
async fn multipart_upload_bounds_and_validates_metadata() {
    let temp = TestDir::new();
    let root = temp.0.join("root");
    fs::create_dir(&root).unwrap();
    let policy = PathPolicy::new(root, false).unwrap();
    let boundary = "metadata-boundary";

    let too_large = vec![b'a'; 4 * 1024 + 1];
    for value in [too_large, vec![0xff]] {
        let body = multipart_body(
            boundary,
            &[
                ("fileName", None, None, value.as_slice()),
                ("file", Some("one"), None, b"one"),
            ],
        );
        assert!(
            save_multipart_attachment(multipart(body, boundary).await, &policy)
                .await
                .is_err(),
        );
    }
}

#[tokio::test]
async fn staging_is_private_bounded_and_atomically_finalized() {
    let temp = TestDir::new();
    let staging_dir = temp.0.join("staging");
    fs::create_dir(&staging_dir).expect("create staging directory");
    secure_directory(&staging_dir)
        .await
        .expect("secure staging");
    let temporary_path = staging_dir.join("attachment.upload");
    let final_path = staging_dir.join("attachment.txt");
    let mut file = private_new_file(&temporary_path)
        .await
        .expect("create private file");
    let mut size = 0;
    append_bounded_chunk(&mut file, &mut size, &vec![0; ATTACHMENT_MAX_BYTES])
        .await
        .expect("accept exact limit");
    let error = append_bounded_chunk(&mut file, &mut size, &[1])
        .await
        .expect_err("reject over limit");
    assert_eq!(error.code, -32602);
    assert_eq!(size, ATTACHMENT_MAX_BYTES);
    file.sync_all().await.expect("sync staging file");
    drop(file);
    tokio::fs::rename(&temporary_path, &final_path)
        .await
        .expect("atomic finalization");
    assert!(!temporary_path.exists());
    assert_eq!(
        fs::metadata(&final_path).unwrap().len(),
        ATTACHMENT_MAX_BYTES as u64,
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&staging_dir).unwrap().permissions().mode() & 0o777,
            0o700,
        );
        assert_eq!(
            fs::metadata(&final_path).unwrap().permissions().mode() & 0o777,
            0o600,
        );
    }
}

#[cfg(any(unix, windows))]
#[test]
fn attachments_root_rejects_link_escape() {
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    let temp = TestDir::new();
    let root = temp.0.join("root");
    let outside = temp.0.join("outside");
    fs::create_dir(&root).expect("create root");
    fs::create_dir(&outside).expect("create outside");
    let attachment_link = root.join(DEFAULT_ATTACHMENTS_DIR_NAME);
    #[cfg(unix)]
    symlink(&outside, &attachment_link).expect("create attachment symlink");
    #[cfg(windows)]
    create_directory_reparse(&outside, &attachment_link);

    let error = PathPolicy::new(root, true).expect_err("reject attachment link escape");
    #[cfg(unix)]
    assert!(error.contains("must not be a symlink"), "{error}");
    #[cfg(windows)]
    assert!(!error.is_empty());
    assert!(fs::read_dir(outside)
        .expect("read outside")
        .next()
        .is_none());
}
