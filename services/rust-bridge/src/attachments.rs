use axum::extract::Multipart;
use dappercode_bridge_core::resource_limits::ATTACHMENT_MAX_BYTES;
use dappercode_bridge_core::BridgeError;
use dappercode_bridge_path_policy::PathPolicy;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub(crate) const ATTACHMENT_MULTIPART_MAX_BYTES: usize = ATTACHMENT_MAX_BYTES + 64 * 1024;
const ATTACHMENT_METADATA_MAX_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentUploadResponse {
    pub(crate) path: String,
    pub(crate) file_name: String,
    pub(crate) mime_type: Option<String>,
    pub(crate) size_bytes: usize,
    pub(crate) kind: String,
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
pub(crate) async fn save_multipart_attachment(
    mut multipart: Multipart,
    path_policy: &PathPolicy,
) -> Result<AttachmentUploadResponse, BridgeError> {
    let temporary_dir = path_policy.secure_attachments_directory(Path::new(".tmp"))?;
    let temporary_name = format!("{}.upload", Uuid::new_v4());
    let mut temporary_file: Option<fs::File> = None;
    let mut uploaded_size = 0usize;
    let mut field_file_name = None;
    let mut file_name = None;
    let mut mime_type = None;
    let mut thread_id = None;
    let mut kind = None;

    let result = async {
        while let Some(mut field) = multipart.next_field().await.map_err(|error| {
            BridgeError::invalid_params(format!("invalid multipart upload: {error}"))
        })? {
            let name = field.name().unwrap_or_default().to_string();
            if name == "file" {
                if temporary_file.is_some() {
                    return Err(BridgeError::invalid_params(
                        "exactly one file field is required",
                    ));
                }
                field_file_name = field.file_name().map(str::to_string);
                mime_type = field.content_type().map(str::to_string);
                let mut file = fs::File::from_std(temporary_dir.create_file(&temporary_name)?);
                while let Some(chunk) = field.chunk().await.map_err(|error| {
                    BridgeError::invalid_params(format!("invalid file field: {error}"))
                })? {
                    append_bounded_chunk(&mut file, &mut uploaded_size, &chunk).await?;
                }
                temporary_file = Some(file);
                continue;
            }

            let value = read_bounded_text_field(&mut field).await?;
            match name.as_str() {
                "fileName" => file_name = non_empty(value),
                "mimeType" => mime_type = non_empty(value),
                "threadId" => thread_id = non_empty(value),
                "kind" => kind = non_empty(value),
                _ => return Err(BridgeError::invalid_params("unsupported multipart field")),
            }
        }

        let file = temporary_file
            .take()
            .ok_or_else(|| BridgeError::invalid_params("file field is required"))?;
        if uploaded_size == 0 {
            return Err(BridgeError::invalid_params("attachment payload is empty"));
        }
        file.sync_all()
            .await
            .map_err(|error| BridgeError::server(format!("failed to sync attachment: {error}")))?;
        drop(file);

        let normalized_kind = normalize_attachment_kind(kind.as_deref(), mime_type.as_deref());
        let final_file_name = build_attachment_file_name(
            file_name.as_deref().or(field_file_name.as_deref()),
            mime_type.as_deref(),
            normalized_kind,
        );
        let mut attachment_relative = PathBuf::from("threads");
        if let Some(thread_id) = thread_id.as_deref() {
            let normalized_thread = sanitize_path_segment(thread_id);
            if !normalized_thread.is_empty() {
                attachment_relative = attachment_relative.join(normalized_thread);
            }
        }
        path_policy.secure_attachments_directory(&attachment_relative)?;
        let target_name = format!("{}-{final_file_name}", Uuid::new_v4());
        let target_path = path_policy.rename_attachment_file(
            &temporary_dir,
            &temporary_name,
            &attachment_relative,
            &target_name,
        )?;

        Ok(AttachmentUploadResponse {
            path: target_path.to_string_lossy().to_string(),
            file_name: final_file_name,
            mime_type,
            size_bytes: uploaded_size,
            kind: normalized_kind.to_string(),
        })
    }
    .await;

    if result.is_err() {
        drop(temporary_file);
        temporary_dir.remove_file(&temporary_name);
    }
    result
}

async fn append_bounded_chunk(
    file: &mut fs::File,
    uploaded_size: &mut usize,
    chunk: &[u8],
) -> Result<(), BridgeError> {
    let next_size = uploaded_size.saturating_add(chunk.len());
    if next_size > ATTACHMENT_MAX_BYTES {
        return Err(BridgeError::resource_limit(
            "attachment_bytes",
            ATTACHMENT_MAX_BYTES,
            next_size,
        ));
    }
    file.write_all(chunk)
        .await
        .map_err(|error| BridgeError::server(format!("failed to stage attachment: {error}")))?;
    *uploaded_size = next_size;
    Ok(())
}

async fn read_bounded_text_field(
    field: &mut axum::extract::multipart::Field<'_>,
) -> Result<String, BridgeError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|error| BridgeError::invalid_params(format!("invalid multipart field: {error}")))?
    {
        if bytes.len().saturating_add(chunk.len()) > ATTACHMENT_METADATA_MAX_BYTES {
            return Err(BridgeError::resource_limit(
                "attachment_metadata_bytes",
                ATTACHMENT_METADATA_MAX_BYTES,
                bytes.len().saturating_add(chunk.len()),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
        .map_err(|_| BridgeError::invalid_params("multipart metadata must be UTF-8"))
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn normalize_attachment_kind(
    kind: Option<&str>,
    mime_type: Option<&str>,
) -> &'static str {
    let normalized = kind
        .map(str::trim)
        .map(str::to_lowercase)
        .unwrap_or_default();
    if normalized == "image" {
        return "image";
    }
    if normalized == "file" {
        return "file";
    }
    if mime_type
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .is_some_and(|mime| mime.starts_with("image/"))
    {
        return "image";
    }
    "file"
}

pub(crate) fn build_attachment_file_name(
    raw_name: Option<&str>,
    raw_mime_type: Option<&str>,
    kind: &str,
) -> String {
    let requested_name = raw_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if kind == "image" {
                "image".to_string()
            } else {
                "attachment".to_string()
            }
        });
    let mut sanitized = sanitize_filename(&requested_name);
    if !sanitized.contains('.') {
        if let Some(extension) = infer_extension_from_mime(raw_mime_type) {
            sanitized.push('.');
            sanitized.push_str(extension);
        }
    }
    sanitized
}

pub(crate) fn sanitize_filename(value: &str) -> String {
    let basename = value
        .split(['/', '\\'])
        .rfind(|segment| !segment.trim().is_empty())
        .unwrap_or("attachment");
    let mut cleaned = basename
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '.' | '-' | '_') {
                char
            } else {
                '_'
            }
        })
        .collect::<String>();
    cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        return "attachment".to_string();
    }
    if cleaned.len() > 96 {
        cleaned.truncate(96);
    }
    cleaned
}

pub(crate) fn sanitize_path_segment(value: &str) -> String {
    let mut cleaned = value
        .trim()
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '-' | '_') {
                char
            } else {
                '_'
            }
        })
        .collect::<String>();
    cleaned = cleaned.trim_matches('_').to_string();
    if cleaned.len() > 64 {
        cleaned.truncate(64);
    }
    cleaned
}

pub(crate) fn infer_extension_from_mime(raw_mime_type: Option<&str>) -> Option<&'static str> {
    let mime = raw_mime_type?.trim().to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "text/plain" => Some("txt"),
        "application/json" => Some("json"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

pub(crate) fn infer_image_content_type_from_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.trim().to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        _ => None,
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "attachments_tests.rs"]
mod tests;
