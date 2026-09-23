//! Per-user Google Drive access seam.
//!
//! Unlike the Gemini seams (which authenticate with the server's `?key=` API
//! key), Drive operations act on the **caller's** Drive: every method takes the
//! caller's OAuth 2.0 access token (the `Authorization: Bearer <token>` the HTTP
//! layer extracts) and forwards it to Drive. The production adapter
//! (`alma_infrastructure::google_drive::GoogleDriveClient`) calls the Drive v3
//! REST API; there is no server-held Drive credential.

use crate::error::ApplicationError;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A single Drive file/folder as surfaced to the RAG drive endpoints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// First parent folder id, when Drive reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Size in bytes as reported by Drive (absent for folders / Google-native docs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// A page of folder contents plus the opaque cursor for the next page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveFolderListing {
    pub files: Vec<DriveFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_page_token: Option<String>,
}

/// The bytes + metadata of a downloaded Drive file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveFileContent {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// Seam over a per-user Google Drive account. All methods take the caller's
/// OAuth access token; a rejected/expired token surfaces as
/// [`ApplicationError::AuthorizationWasDenied`].
#[async_trait]
pub trait GoogleDriveObjectPort: Send + Sync {
    /// Full-text search the caller's Drive. `mime_type`, when set, restricts the
    /// results to that MIME type. `limit` bounds the returned count.
    async fn search_files(
        &self,
        access_token: &str,
        query: &str,
        mime_type: Option<&str>,
        limit: usize,
    ) -> Result<Vec<DriveFile>, ApplicationError>;

    /// List the direct children of `folder_id` in the caller's Drive, one page at
    /// a time (`page_token` is the opaque cursor from a prior call).
    async fn list_folder(
        &self,
        access_token: &str,
        folder_id: &str,
        page_size: usize,
        page_token: Option<&str>,
    ) -> Result<DriveFolderListing, ApplicationError>;

    /// Download a binary file's bytes + metadata from the caller's Drive.
    async fn download_file(
        &self,
        access_token: &str,
        file_id: &str,
    ) -> Result<DriveFileContent, ApplicationError>;
}
