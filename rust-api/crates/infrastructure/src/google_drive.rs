//! Per-user Google Drive v3 client.
//!
//! Implements [`GoogleDriveObjectPort`] against the Drive REST API, following the
//! same reqwest shape as [`crate::ai::GeminiAiAdapter`] — except authentication is
//! the **caller's** OAuth token via `Authorization: Bearer <token>` (reqwest's
//! `.bearer_auth`) rather than the server's `?key=`. There is no server-held Drive
//! credential; every method forwards the token it is given.

use alma_application::error::ApplicationError;
use alma_application::ports::google_drive::{
    DriveFile, DriveFileContent, DriveFolderListing, GoogleDriveObjectPort,
};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::Value;

/// Default Drive API host. Override via bootstrap (env `GOOGLE_DRIVE_BASE_URL`) to
/// point tests at a local mock.
pub const DEFAULT_GOOGLE_DRIVE_BASE_URL: &str = "https://www.googleapis.com";

/// Upper bound on a single Drive download held in memory (RUST-SSRF-003). Guards
/// against a large (or lying-`Content-Length`) file exhausting server memory.
const MAX_DRIVE_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;

/// The `fields` mask requested for file listings (search + folder browse).
const FILE_LIST_FIELDS: &str = "nextPageToken, files(id, name, mimeType, parents, size)";
/// The `fields` mask requested for single-file metadata.
const FILE_METADATA_FIELDS: &str = "id, name, mimeType, size";

pub struct GoogleDriveClient {
    http_client: reqwest::Client,
    base_url: String,
}

impl GoogleDriveClient {
    /// Construct with a caller-provided `reqwest::Client` (shared-client wiring).
    /// Any trailing slash on `base_url` is trimmed so endpoint assembly is canonical.
    pub fn construct(http_client: reqwest::Client, base_url: String) -> Self {
        Self {
            http_client,
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Construct with a fresh `reqwest::Client`.
    pub fn construct_with_default_client(base_url: String) -> Self {
        Self::construct(reqwest::Client::new(), base_url)
    }
}

/// Escape a literal for embedding inside a Drive `q` string (single-quoted). Drive
/// requires `\` and `'` to be backslash-escaped.
fn escape_drive_query_literal(literal: &str) -> String {
    literal.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Percent-encode a Drive object id for safe interpolation into a URL **path**
/// segment (RUST-SSRF-003). Real Drive ids are `[A-Za-z0-9_-]`; anything else
/// (`/`, `?`, `#`, `.`, whitespace, control bytes) is escaped so a crafted id
/// cannot traverse or alter the request path or inject query/fragment parts.
fn percent_encode_path_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// Build the `q` expression for a full-text search, optionally constrained by MIME.
fn build_search_query(query: &str, mime_type: Option<&str>) -> String {
    let mut expression = format!(
        "fullText contains '{}' and trashed = false",
        escape_drive_query_literal(query)
    );
    if let Some(mime_type) = mime_type.map(str::trim).filter(|value| !value.is_empty()) {
        expression.push_str(&format!(
            " and mimeType = '{}'",
            escape_drive_query_literal(mime_type)
        ));
    }
    expression
}

/// Build the `q` expression listing the direct children of a folder.
fn build_folder_query(folder_id: &str) -> String {
    format!(
        "'{}' in parents and trashed = false",
        escape_drive_query_literal(folder_id)
    )
}

/// Parse one Drive `files` entry into a [`DriveFile`]. Drive returns `size` as a
/// string; `parents` is an array whose first element is the containing folder.
fn parse_drive_file(entry: &Value) -> Option<DriveFile> {
    let id = entry.get("id").and_then(Value::as_str)?.to_string();
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mime_type = entry
        .get("mimeType")
        .and_then(Value::as_str)
        .map(str::to_string);
    let parent_id = entry
        .get("parents")
        .and_then(Value::as_array)
        .and_then(|parents| parents.first())
        .and_then(Value::as_str)
        .map(str::to_string);
    let size = entry
        .get("size")
        .and_then(|size| size.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| size.as_u64()));
    Some(DriveFile {
        id,
        name,
        mime_type,
        parent_id,
        size,
    })
}

/// Parse a Drive file-list response body into a [`DriveFolderListing`].
fn parse_file_listing(body: &Value) -> DriveFolderListing {
    let files = body
        .get("files")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(parse_drive_file).collect())
        .unwrap_or_default();
    let next_page_token = body
        .get("nextPageToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    DriveFolderListing {
        files,
        next_page_token,
    }
}

/// Map a non-success Drive HTTP status to the right [`ApplicationError`]: a
/// rejected/expired token is an authorization denial (403), a missing file is a
/// not-found (404), anything else is a generic Drive failure (500).
fn map_drive_status_to_error(status: u16, context: &str, body: &str) -> ApplicationError {
    match status {
        401 | 403 => ApplicationError::AuthorizationWasDenied,
        404 => ApplicationError::RequestedResourceCouldNotBeLocated,
        _ => ApplicationError::GoogleDriveAdapterFailure {
            failure_description: format!("{context}: Drive returned HTTP {status}: {body}"),
        },
    }
}

fn transport_error(context: &str, error: reqwest::Error) -> ApplicationError {
    ApplicationError::GoogleDriveAdapterFailure {
        failure_description: format!("{context}: {error}"),
    }
}

#[async_trait]
impl GoogleDriveObjectPort for GoogleDriveClient {
    async fn search_files(
        &self,
        access_token: &str,
        query: &str,
        mime_type: Option<&str>,
        limit: usize,
    ) -> Result<Vec<DriveFile>, ApplicationError> {
        let endpoint = format!("{}/drive/v3/files", self.base_url);
        let page_size = limit.clamp(1, 1000).to_string();
        let response = self
            .http_client
            .get(&endpoint)
            .bearer_auth(access_token)
            .query(&[
                ("q", build_search_query(query, mime_type).as_str()),
                ("fields", FILE_LIST_FIELDS),
                ("pageSize", page_size.as_str()),
                ("spaces", "drive"),
                ("supportsAllDrives", "true"),
                ("includeItemsFromAllDrives", "true"),
            ])
            .send()
            .await
            .map_err(|error| transport_error("drive search", error))?;

        let status = response.status().as_u16();
        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(map_drive_status_to_error(status, "drive search", &body));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|error| transport_error("drive search decode", error))?;
        let mut files = parse_file_listing(&body).files;
        files.truncate(limit);
        Ok(files)
    }

    async fn list_folder(
        &self,
        access_token: &str,
        folder_id: &str,
        page_size: usize,
        page_token: Option<&str>,
    ) -> Result<DriveFolderListing, ApplicationError> {
        let endpoint = format!("{}/drive/v3/files", self.base_url);
        let clamped_page_size = page_size.clamp(1, 1000).to_string();
        let mut query_parameters: Vec<(&str, String)> = vec![
            ("q", build_folder_query(folder_id)),
            ("fields", FILE_LIST_FIELDS.to_string()),
            ("pageSize", clamped_page_size),
            ("spaces", "drive".to_string()),
            ("supportsAllDrives", "true".to_string()),
            ("includeItemsFromAllDrives", "true".to_string()),
        ];
        if let Some(token) = page_token.filter(|token| !token.is_empty()) {
            query_parameters.push(("pageToken", token.to_string()));
        }

        let response = self
            .http_client
            .get(&endpoint)
            .bearer_auth(access_token)
            .query(&query_parameters)
            .send()
            .await
            .map_err(|error| transport_error("drive folder list", error))?;

        let status = response.status().as_u16();
        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(map_drive_status_to_error(status, "drive folder list", &body));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|error| transport_error("drive folder list decode", error))?;
        Ok(parse_file_listing(&body))
    }

    async fn download_file(
        &self,
        access_token: &str,
        file_id: &str,
    ) -> Result<DriveFileContent, ApplicationError> {
        // 1. Metadata (name + mime).
        // RUST-SSRF-003: percent-encode the caller-supplied id so it cannot break out
        // of its path segment (traversal / query / fragment injection).
        let encoded_file_id = percent_encode_path_segment(file_id);
        let metadata_endpoint = format!("{}/drive/v3/files/{}", self.base_url, encoded_file_id);
        let metadata_response = self
            .http_client
            .get(&metadata_endpoint)
            .bearer_auth(access_token)
            .query(&[
                ("fields", FILE_METADATA_FIELDS),
                ("supportsAllDrives", "true"),
            ])
            .send()
            .await
            .map_err(|error| transport_error("drive metadata", error))?;
        let metadata_status = metadata_response.status().as_u16();
        if !metadata_response.status().is_success() {
            let body = metadata_response.text().await.unwrap_or_default();
            return Err(map_drive_status_to_error(metadata_status, "drive metadata", &body));
        }
        let metadata: Value = metadata_response
            .json()
            .await
            .map_err(|error| transport_error("drive metadata decode", error))?;
        let name = metadata
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(file_id)
            .to_string();
        let mime_type = metadata
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream")
            .to_string();

        // 2. Bytes (binary media). Google-native docs (application/vnd.google-apps.*)
        //    require :export instead of alt=media — out of scope for v1; Drive
        //    returns an error which surfaces as a Drive failure.
        let media_endpoint = format!("{}/drive/v3/files/{}", self.base_url, encoded_file_id);
        let media_response = self
            .http_client
            .get(&media_endpoint)
            .bearer_auth(access_token)
            .query(&[("alt", "media"), ("supportsAllDrives", "true")])
            .send()
            .await
            .map_err(|error| transport_error("drive download", error))?;
        let media_status = media_response.status().as_u16();
        if !media_response.status().is_success() {
            let body = media_response.text().await.unwrap_or_default();
            return Err(map_drive_status_to_error(media_status, "drive download", &body));
        }
        // RUST-SSRF-003: bound the download instead of an unbounded `.bytes()`. Reject
        // early when Drive advertises an oversize body, then stream with a hard cap in
        // case the header is absent or understated.
        if media_response
            .content_length()
            .is_some_and(|length| length > MAX_DRIVE_DOWNLOAD_BYTES as u64)
        {
            return Err(ApplicationError::GoogleDriveAdapterFailure {
                failure_description: format!(
                    "drive download: file exceeds maximum allowed size of {MAX_DRIVE_DOWNLOAD_BYTES} bytes"
                ),
            });
        }
        let mut bytes: Vec<u8> = Vec::new();
        let mut byte_stream = media_response.bytes_stream();
        while let Some(chunk) = byte_stream.next().await {
            let chunk = chunk.map_err(|error| transport_error("drive download body", error))?;
            if bytes.len() + chunk.len() > MAX_DRIVE_DOWNLOAD_BYTES {
                return Err(ApplicationError::GoogleDriveAdapterFailure {
                    failure_description: format!(
                        "drive download: file exceeds maximum allowed size of {MAX_DRIVE_DOWNLOAD_BYTES} bytes"
                    ),
                });
            }
            bytes.extend_from_slice(&chunk);
        }

        Ok(DriveFileContent {
            id: file_id.to_string(),
            name,
            mime_type,
            bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn escape_literal_escapes_backslash_and_quote() {
        assert_eq!(escape_drive_query_literal("it's a \\test"), "it\\'s a \\\\test");
    }

    #[test]
    fn path_segment_encoding_neutralizes_traversal_and_injection() {
        // Legitimate Drive ids pass through untouched.
        assert_eq!(percent_encode_path_segment("1AbC_def-GHI"), "1AbC_def-GHI");
        // Path/query/fragment and traversal metacharacters are escaped (dots too,
        // so a `..` segment cannot traverse).
        assert_eq!(
            percent_encode_path_segment("../../etc"),
            "%2E%2E%2F%2E%2E%2Fetc"
        );
        assert_eq!(
            percent_encode_path_segment("id?alt=media#x"),
            "id%3Falt%3Dmedia%23x"
        );
        assert_eq!(percent_encode_path_segment("a b"), "a%20b");
    }

    #[test]
    fn search_query_includes_fulltext_and_optional_mime() {
        assert_eq!(
            build_search_query("cancer", None),
            "fullText contains 'cancer' and trashed = false"
        );
        assert_eq!(
            build_search_query("cancer", Some("application/pdf")),
            "fullText contains 'cancer' and trashed = false and mimeType = 'application/pdf'"
        );
        // Blank mime is ignored.
        assert_eq!(
            build_search_query("x", Some("  ")),
            "fullText contains 'x' and trashed = false"
        );
    }

    #[test]
    fn folder_query_scopes_to_parent() {
        assert_eq!(
            build_folder_query("folder-123"),
            "'folder-123' in parents and trashed = false"
        );
    }

    #[test]
    fn parse_file_reads_fields_and_first_parent_and_string_size() {
        let entry = json!({
            "id": "f1", "name": "report.pdf", "mimeType": "application/pdf",
            "parents": ["folder-9", "folder-8"], "size": "2048"
        });
        let file = parse_drive_file(&entry).unwrap();
        assert_eq!(file.id, "f1");
        assert_eq!(file.name, "report.pdf");
        assert_eq!(file.mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(file.parent_id.as_deref(), Some("folder-9"));
        assert_eq!(file.size, Some(2048));
    }

    #[test]
    fn parse_file_requires_id_tolerates_missing_optionals() {
        assert!(parse_drive_file(&json!({ "name": "no id" })).is_none());
        let file = parse_drive_file(&json!({ "id": "f2", "name": "folder", "mimeType": "application/vnd.google-apps.folder" })).unwrap();
        assert_eq!(file.parent_id, None);
        assert_eq!(file.size, None);
    }

    #[test]
    fn parse_listing_reads_files_and_next_page_token() {
        let body = json!({
            "nextPageToken": "CURSOR",
            "files": [
                { "id": "a", "name": "A" },
                { "name": "skipped-no-id" },
                { "id": "b", "name": "B", "size": "10" }
            ]
        });
        let listing = parse_file_listing(&body);
        assert_eq!(listing.files.len(), 2);
        assert_eq!(listing.files[0].id, "a");
        assert_eq!(listing.files[1].size, Some(10));
        assert_eq!(listing.next_page_token.as_deref(), Some("CURSOR"));
    }

    #[test]
    fn parse_listing_empty_token_becomes_none() {
        let listing = parse_file_listing(&json!({ "files": [], "nextPageToken": "" }));
        assert!(listing.files.is_empty());
        assert_eq!(listing.next_page_token, None);
    }

    #[test]
    fn status_mapping_distinguishes_auth_notfound_generic() {
        assert!(matches!(
            map_drive_status_to_error(401, "x", "b"),
            ApplicationError::AuthorizationWasDenied
        ));
        assert!(matches!(
            map_drive_status_to_error(403, "x", "b"),
            ApplicationError::AuthorizationWasDenied
        ));
        assert!(matches!(
            map_drive_status_to_error(404, "x", "b"),
            ApplicationError::RequestedResourceCouldNotBeLocated
        ));
        assert!(matches!(
            map_drive_status_to_error(500, "x", "b"),
            ApplicationError::GoogleDriveAdapterFailure { .. }
        ));
    }
}
