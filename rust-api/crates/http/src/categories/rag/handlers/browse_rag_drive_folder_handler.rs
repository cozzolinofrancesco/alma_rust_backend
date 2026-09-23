//! `GET /api/rag/drive/folder/:folder_identifier` — list the CALLER'S Drive folder.
//!
//! Authenticated with the caller's `Authorization: Bearer <token>` and forwarded
//! to Drive v3 via [`GoogleDriveObjectPort`]. Optional `?pageSize=&cursor=` query
//! drives real Drive pagination (`cursor` is Drive's `nextPageToken`). Entries are
//! flagged `alreadyIngested` against the account's ingested corpus knowledge.

use crate::categories::rag::collections::RAG_KNOWLEDGE_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::google_access_token::GoogleAccessToken;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::DocumentCollectionPort;
use alma_application::ports::google_drive::DriveFile;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, Query, State};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// The default number of entries returned in a single browse page when the
/// caller does not request a specific page size.
const DEFAULT_DRIVE_FOLDER_PAGE_SIZE: usize = 25;

/// The largest page size we are willing to honour, guarding against a caller
/// asking for an unbounded listing.
const MAXIMUM_DRIVE_FOLDER_PAGE_SIZE: usize = 200;

/// The classification of a drive entry based on its declared MIME type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveEntryKind {
    Folder,
    PdfDocument,
    JsonCorpus,
    PlainText,
    Spreadsheet,
    Unknown,
}

impl DriveEntryKind {
    /// Stable string tag used both in the JSON response and in tests.
    fn as_tag(self) -> &'static str {
        match self {
            DriveEntryKind::Folder => "folder",
            DriveEntryKind::PdfDocument => "pdf",
            DriveEntryKind::JsonCorpus => "json_corpus",
            DriveEntryKind::PlainText => "plain_text",
            DriveEntryKind::Spreadsheet => "spreadsheet",
            DriveEntryKind::Unknown => "unknown",
        }
    }
}

/// A single normalized entry inside a browsed drive folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveFolderEntry {
    pub entry_identifier: String,
    pub display_name: String,
    pub mime_type: String,
    pub entry_kind: DriveEntryKind,
    pub byte_size: u64,
    pub already_ingested: bool,
}

#[route(method = "GET", path = "/api/rag/drive/folder/:folder_identifier")]
pub async fn browse_rag_drive_folder_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    google_access_token: GoogleAccessToken,
    Path(folder_identifier): Path<String>,
    Query(query_parameters): Query<HashMap<String, String>>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requested_folder = extract_requested_drive_folder_identifier(folder_identifier)?;
    let page_cursor = parse_optional_pagination_cursor_from_query(&query_parameters);
    let page_size = parse_requested_page_size_or_default(&query_parameters);

    // Real Drive folder listing with the caller's token.
    let listing = application_state
        .google_drive_adapter
        .list_folder(
            google_access_token.as_str(),
            requested_folder.as_str(),
            page_size,
            page_cursor.as_deref(),
        )
        .await
        .map_err(HttpError::from)?;

    let parsed_entries = map_drive_files_to_folder_entries(listing.files);
    let limited_entries = apply_requested_page_size_limit_to_entries(parsed_entries, page_size);

    let ingested_names = collect_ingested_document_names_for_folder(
        &application_state.document_collection,
        &requested_folder,
    )
    .await?;
    let ingested_total = count_previously_ingested_documents_for_folder(
        &application_state.document_collection,
        &requested_folder,
    )
    .await?;

    let annotated_entries = mark_entries_already_ingested(limited_entries, &ingested_names);
    // Drive supplies the authoritative next-page cursor.
    let next_cursor = listing.next_page_token;

    let mut response =
        assemble_drive_folder_browse_response(&requested_folder, &annotated_entries, &next_cursor);
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "previouslyIngestedCount".to_string(),
            json!(ingested_total),
        );
    }

    Ok(Json(response))
}

/// (1) Validate the raw path parameter and turn it into a `NonEmptyText`.
fn extract_requested_drive_folder_identifier(
    supplied_path_parameter: String,
) -> Result<NonEmptyText, HttpError> {
    let trimmed = supplied_path_parameter.trim().to_string();
    NonEmptyText::parse(trimmed).map_err(|error| HttpError::RequestedResourceWasNotFound {
        explanation: format!("A drive folder identifier is required: {error}"),
    })
}

/// (2) Extract an optional pagination cursor (Drive `nextPageToken`) from the query.
fn parse_optional_pagination_cursor_from_query(
    query_parameters: &HashMap<String, String>,
) -> Option<String> {
    query_parameters
        .get("cursor")
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// (3) Determine the requested page size, clamping to a sane range.
fn parse_requested_page_size_or_default(query_parameters: &HashMap<String, String>) -> usize {
    let requested = query_parameters
        .get("pageSize")
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_DRIVE_FOLDER_PAGE_SIZE);
    requested.min(MAXIMUM_DRIVE_FOLDER_PAGE_SIZE)
}

/// (4) Map port-level [`DriveFile`]s into normalized folder entries.
fn map_drive_files_to_folder_entries(drive_files: Vec<DriveFile>) -> Vec<DriveFolderEntry> {
    drive_files
        .into_iter()
        .map(|drive_file| {
            let mime_type = drive_file
                .mime_type
                .map(|mime| mime.trim().to_string())
                .filter(|mime| !mime.is_empty())
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let entry_kind = classify_drive_entry_kind_from_mime_type(&mime_type);
            DriveFolderEntry {
                entry_identifier: drive_file.id,
                display_name: normalize_drive_folder_entry_display_name(&drive_file.name),
                mime_type,
                entry_kind,
                byte_size: drive_file.size.unwrap_or(0),
                already_ingested: false,
            }
        })
        .collect()
}

/// (5) Classify a drive entry from its declared MIME type.
fn classify_drive_entry_kind_from_mime_type(raw_mime_type: &str) -> DriveEntryKind {
    let normalized = raw_mime_type.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "application/vnd.google-apps.folder" => DriveEntryKind::Folder,
        "application/pdf" => DriveEntryKind::PdfDocument,
        "application/json" | "application/vnd.google-apps.document+json" => {
            DriveEntryKind::JsonCorpus
        }
        "text/plain" | "text/markdown" => DriveEntryKind::PlainText,
        "text/csv"
        | "application/vnd.ms-excel"
        | "application/vnd.google-apps.spreadsheet"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => {
            DriveEntryKind::Spreadsheet
        }
        other if other.starts_with("text/") => DriveEntryKind::PlainText,
        _ => DriveEntryKind::Unknown,
    }
}

/// (6) Normalize a raw declared file name: collapse whitespace and provide a
/// stable fallback for empty names.
fn normalize_drive_folder_entry_display_name(raw_declared_name: &str) -> String {
    let collapsed = raw_declared_name.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        "Untitled".to_string()
    } else {
        collapsed
    }
}

/// (7) Truncate the entry list to at most `page_size` items.
fn apply_requested_page_size_limit_to_entries(
    mut entries: Vec<DriveFolderEntry>,
    page_size: usize,
) -> Vec<DriveFolderEntry> {
    if entries.len() > page_size {
        entries.truncate(page_size);
    }
    entries
}

/// (8) Count how many documents have already been ingested for this folder.
async fn count_previously_ingested_documents_for_folder(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    folder_identifier: &NonEmptyText,
) -> Result<usize, HttpError> {
    let stored = document_collection
        .list_documents(RAG_KNOWLEDGE_COLLECTION_NAME)
        .await
        .map_err(HttpError::from)?;
    let matching = stored
        .iter()
        .filter(|document| stored_document_belongs_to_folder(document, folder_identifier))
        .count();
    Ok(matching)
}

/// Helper: decide whether a stored knowledge document originated from the given
/// drive folder by inspecting its `document_body`.
fn stored_document_belongs_to_folder(
    document: &alma_application::ports::document_collection::StoredDocument,
    folder_identifier: &NonEmptyText,
) -> bool {
    document
        .document_body
        .get("sourceFolderIdentifier")
        .and_then(Value::as_str)
        .map(|value| value == folder_identifier.as_str())
        .unwrap_or(false)
}

/// (9) Flip `already_ingested` on any entry whose display name matches one of
/// the previously ingested document names.
fn mark_entries_already_ingested(
    entries: Vec<DriveFolderEntry>,
    ingested_document_names: &HashSet<String>,
) -> Vec<DriveFolderEntry> {
    entries
        .into_iter()
        .map(|mut entry| {
            if ingested_document_names.contains(&entry.display_name) {
                entry.already_ingested = true;
            }
            entry
        })
        .collect()
}

/// (10) Collect the set of ingested document names associated with this folder.
async fn collect_ingested_document_names_for_folder(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    folder_identifier: &NonEmptyText,
) -> Result<HashSet<String>, HttpError> {
    let stored = document_collection
        .list_documents(RAG_KNOWLEDGE_COLLECTION_NAME)
        .await
        .map_err(HttpError::from)?;

    let mut names = HashSet::new();
    for document in stored {
        if !stored_document_belongs_to_folder(&document, folder_identifier) {
            continue;
        }
        if let Some(name) = document
            .document_body
            .get("displayName")
            .and_then(Value::as_str)
        {
            let normalized = normalize_drive_folder_entry_display_name(name);
            names.insert(normalized);
        }
    }
    Ok(names)
}

/// (11) Serialize a single entry into its JSON representation.
fn serialize_single_drive_folder_entry_to_json(entry: &DriveFolderEntry) -> Value {
    json!({
        "id": entry.entry_identifier,
        "name": entry.display_name,
        "mimeType": entry.mime_type,
        "kind": entry.entry_kind.as_tag(),
        "size": entry.byte_size,
        "alreadyIngested": entry.already_ingested,
    })
}

/// (12) Assemble the full browse response envelope.
fn assemble_drive_folder_browse_response(
    folder_identifier: &NonEmptyText,
    entries: &[DriveFolderEntry],
    next_cursor: &Option<String>,
) -> Value {
    let serialized_entries: Vec<Value> = entries
        .iter()
        .map(serialize_single_drive_folder_entry_to_json)
        .collect();

    json!({
        "folder": {
            "id": folder_identifier.as_str(),
        },
        "files": serialized_entries,
        "returnedCount": serialized_entries.len(),
        "nextCursor": next_cursor,
        "hasMore": next_cursor.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str, name: &str) -> DriveFolderEntry {
        DriveFolderEntry {
            entry_identifier: id.to_string(),
            display_name: name.to_string(),
            mime_type: "application/pdf".to_string(),
            entry_kind: DriveEntryKind::PdfDocument,
            byte_size: 100,
            already_ingested: false,
        }
    }

    #[test]
    fn extract_requested_drive_folder_identifier_accepts_valid() {
        let parsed = extract_requested_drive_folder_identifier("  folder-42  ".to_string());
        assert_eq!(parsed.unwrap().as_str(), "folder-42");
    }

    #[test]
    fn extract_requested_drive_folder_identifier_rejects_blank() {
        assert!(extract_requested_drive_folder_identifier("   ".to_string()).is_err());
    }

    #[test]
    fn parse_optional_pagination_cursor_from_query_handles_presence_and_absence() {
        let mut with_cursor = HashMap::new();
        with_cursor.insert("cursor".to_string(), "abc".to_string());
        assert_eq!(
            parse_optional_pagination_cursor_from_query(&with_cursor),
            Some("abc".to_string())
        );

        let mut blank_cursor = HashMap::new();
        blank_cursor.insert("cursor".to_string(), "   ".to_string());
        assert_eq!(parse_optional_pagination_cursor_from_query(&blank_cursor), None);

        assert_eq!(
            parse_optional_pagination_cursor_from_query(&HashMap::new()),
            None
        );
    }

    #[test]
    fn parse_requested_page_size_or_default_clamps_and_defaults() {
        assert_eq!(
            parse_requested_page_size_or_default(&HashMap::new()),
            DEFAULT_DRIVE_FOLDER_PAGE_SIZE
        );

        let mut oversize = HashMap::new();
        oversize.insert("pageSize".to_string(), "9999".to_string());
        assert_eq!(
            parse_requested_page_size_or_default(&oversize),
            MAXIMUM_DRIVE_FOLDER_PAGE_SIZE
        );

        let mut valid = HashMap::new();
        valid.insert("pageSize".to_string(), "10".to_string());
        assert_eq!(parse_requested_page_size_or_default(&valid), 10);

        let mut zero = HashMap::new();
        zero.insert("pageSize".to_string(), "0".to_string());
        assert_eq!(
            parse_requested_page_size_or_default(&zero),
            DEFAULT_DRIVE_FOLDER_PAGE_SIZE
        );
    }

    #[test]
    fn map_drive_files_classifies_and_defaults() {
        let files = vec![
            DriveFile {
                id: "a1".to_string(),
                name: "One.pdf".to_string(),
                mime_type: Some("application/pdf".to_string()),
                parent_id: None,
                size: Some(12),
            },
            DriveFile {
                id: "b2".to_string(),
                name: "  ".to_string(),
                mime_type: None,
                parent_id: None,
                size: None,
            },
        ];
        let entries = map_drive_files_to_folder_entries(files);
        assert_eq!(entries[0].entry_identifier, "a1");
        assert_eq!(entries[0].entry_kind, DriveEntryKind::PdfDocument);
        assert_eq!(entries[0].byte_size, 12);
        assert_eq!(entries[1].display_name, "Untitled");
        assert_eq!(entries[1].mime_type, "application/octet-stream");
        assert_eq!(entries[1].entry_kind, DriveEntryKind::Unknown);
    }

    #[test]
    fn classify_drive_entry_kind_from_mime_type_covers_known_and_unknown() {
        assert_eq!(
            classify_drive_entry_kind_from_mime_type("application/pdf"),
            DriveEntryKind::PdfDocument
        );
        assert_eq!(
            classify_drive_entry_kind_from_mime_type("APPLICATION/JSON"),
            DriveEntryKind::JsonCorpus
        );
        assert_eq!(
            classify_drive_entry_kind_from_mime_type("application/vnd.google-apps.folder"),
            DriveEntryKind::Folder
        );
        assert_eq!(
            classify_drive_entry_kind_from_mime_type("text/x-rust"),
            DriveEntryKind::PlainText
        );
        assert_eq!(
            classify_drive_entry_kind_from_mime_type("image/png"),
            DriveEntryKind::Unknown
        );
    }

    #[test]
    fn normalize_drive_folder_entry_display_name_collapses_and_falls_back() {
        assert_eq!(
            normalize_drive_folder_entry_display_name("  a   b  "),
            "a b"
        );
        assert_eq!(normalize_drive_folder_entry_display_name("   "), "Untitled");
    }

    #[test]
    fn apply_requested_page_size_limit_to_entries_truncates() {
        let entries = vec![
            sample_entry("1", "a"),
            sample_entry("2", "b"),
            sample_entry("3", "c"),
        ];
        let limited = apply_requested_page_size_limit_to_entries(entries, 2);
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[1].entry_identifier, "2");
    }

    #[test]
    fn apply_requested_page_size_limit_to_entries_keeps_shorter() {
        let entries = vec![sample_entry("1", "a")];
        let limited = apply_requested_page_size_limit_to_entries(entries, 5);
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn mark_entries_already_ingested_flags_matches() {
        let entries = vec![sample_entry("1", "known"), sample_entry("2", "new")];
        let mut ingested = HashSet::new();
        ingested.insert("known".to_string());
        let marked = mark_entries_already_ingested(entries, &ingested);
        assert!(marked[0].already_ingested);
        assert!(!marked[1].already_ingested);
    }

    #[test]
    fn serialize_single_drive_folder_entry_to_json_shapes_fields() {
        let mut entry = sample_entry("id-1", "Report.pdf");
        entry.already_ingested = true;
        let value = serialize_single_drive_folder_entry_to_json(&entry);
        assert_eq!(value["id"], json!("id-1"));
        assert_eq!(value["kind"], json!("pdf"));
        assert_eq!(value["alreadyIngested"], json!(true));
    }

    #[test]
    fn assemble_drive_folder_browse_response_builds_envelope() {
        let folder = NonEmptyText::parse("folder-x".to_string()).unwrap();
        let entries = vec![sample_entry("1", "a"), sample_entry("2", "b")];
        let response = assemble_drive_folder_browse_response(
            &folder,
            &entries,
            &Some("CURSOR2".to_string()),
        );
        assert_eq!(response["folder"]["id"], json!("folder-x"));
        assert_eq!(response["returnedCount"], json!(2));
        assert_eq!(response["hasMore"], json!(true));
        assert_eq!(response["nextCursor"], json!("CURSOR2"));
        assert_eq!(response["files"].as_array().unwrap().len(), 2);
    }
}
