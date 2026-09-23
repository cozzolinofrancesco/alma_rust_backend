use crate::categories::projects_files::collections::PROJECT_FILES_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};

#[route(
    method = "GET",
    path = "/api/projects/:project_identifier/folders/folder_id/:folder_identifier/contents"
)]
pub async fn list_folder_contents_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(path_parameters): Path<(String, String)>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let (raw_project_identifier, raw_folder_identifier) =
        destructure_folder_contents_path_parameters(path_parameters);

    let _validated_project_identifier =
        validate_folder_contents_project_identifier(raw_project_identifier)?;
    let validated_folder_identifier =
        validate_folder_contents_folder_identifier(raw_folder_identifier)?;

    // Canonical, always-present top level folders for a project.
    let canonical_folder_names = build_canonical_top_level_folder_names();
    let folder_entries = build_canonical_folder_directory_entries(&canonical_folder_names);

    // File documents that live inside the requested folder.
    let all_stored_documents = list_project_file_documents_for_folder(&application_state).await?;
    let documents_in_folder = filter_documents_to_requested_folder(
        all_stored_documents,
        validated_folder_identifier.as_str(),
    );
    let file_entries: Vec<Value> = documents_in_folder
        .iter()
        .map(render_stored_document_as_file_directory_entry)
        .collect();

    let mut merged_entries = merge_folder_entries_and_file_entries(folder_entries, file_entries);
    sort_directory_entries_folders_before_files(&mut merged_entries);

    let payload = build_folder_contents_payload(merged_entries);
    Ok(Json(payload))
}

/// (1) Destructure the tuple of raw path parameters into named parts.
fn destructure_folder_contents_path_parameters(
    path_parameters: (String, String),
) -> (String, String) {
    let (raw_project_identifier, raw_folder_identifier) = path_parameters;
    (raw_project_identifier, raw_folder_identifier)
}

/// (2) Validate the project identifier path parameter as non-empty text.
fn validate_folder_contents_project_identifier(
    raw_project_identifier: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_project_identifier).map_err(|parse_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the project identifier path parameter was invalid: {parse_error}"
            ),
        }
    })
}

/// (3) Validate the folder identifier path parameter as non-empty text.
fn validate_folder_contents_folder_identifier(
    raw_folder_identifier: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_folder_identifier).map_err(|parse_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the folder identifier path parameter was invalid: {parse_error}"
            ),
        }
    })
}

/// (4) The fixed set of top level folder names that every project exposes.
fn build_canonical_top_level_folder_names() -> Vec<&'static str> {
    vec![
        "Config",
        "Workflows",
        "Chats",
        "Images",
        "Created-images",
        "PDFs",
        "Audio",
        "Video",
        "Code",
        "Docs",
        "AF",
        "report_creation_corpus",
        "Extracts",
        "LatexFullDocs",
        "Collections",
        "Analysis",
        "Analysis-output",
        "Scripts",
        "Scripts-output",
        "Reports-output",
        "Incseqdiag-output",
        "Incgraph-output",
        "Agents",
        "Agents-output",
        "Prompts",
        "RAG-Knowledge",
        "Others",
        "Logs",
        "Orders",
        "stl",
        "json3dprojects",
    ]
}

/// (5) Render one canonical folder name as a directory entry Value.
fn render_canonical_folder_name_as_directory_entry(
    entry_index: usize,
    folder_name: &str,
) -> Value {
    json!({
        "id": format!("folder-{entry_index}"),
        "name": folder_name,
        "type": "Folder",
        "mimeType": "application/vnd.google-apps.folder",
        "createdTime": "2026-01-12T09:24:00.000Z",
        "modifiedTime": "2026-06-30T15:10:00.000Z"
    })
}

/// (6) Render all canonical folder names as directory entries.
fn build_canonical_folder_directory_entries(folder_names: &[&str]) -> Vec<Value> {
    folder_names
        .iter()
        .enumerate()
        .map(|(entry_index, folder_name)| {
            render_canonical_folder_name_as_directory_entry(entry_index, folder_name)
        })
        .collect()
}

/// (7) Fetch every stored project-file document from the document collection.
fn list_project_file_documents_for_folder<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
) -> impl std::future::Future<Output = Result<Vec<StoredDocument>, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .list_documents(PROJECT_FILES_COLLECTION_NAME)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (8) Decide whether a stored document belongs to the requested folder.
fn document_belongs_to_requested_folder(
    candidate_document: &StoredDocument,
    folder_identifier: &str,
) -> bool {
    let body = &candidate_document.document_body;
    // Accept either an explicit folder identifier or a folder name match.
    let matches_identifier = body
        .get("folderId")
        .and_then(Value::as_str)
        .map(|value| value == folder_identifier)
        .unwrap_or(false);
    let matches_folder_field = body
        .get("folder")
        .and_then(Value::as_str)
        .map(|value| value == folder_identifier)
        .unwrap_or(false);
    let matches_folder_name = body
        .get("folderName")
        .and_then(Value::as_str)
        .map(|value| value == folder_identifier)
        .unwrap_or(false);
    matches_identifier || matches_folder_field || matches_folder_name
}

/// (9) Keep only documents that belong to the requested folder.
fn filter_documents_to_requested_folder(
    all_documents: Vec<StoredDocument>,
    folder_identifier: &str,
) -> Vec<StoredDocument> {
    all_documents
        .into_iter()
        .filter(|candidate_document| {
            document_belongs_to_requested_folder(candidate_document, folder_identifier)
        })
        .collect()
}

/// (10) Render a stored document as a file directory entry Value.
fn render_stored_document_as_file_directory_entry(stored_document: &StoredDocument) -> Value {
    let body = &stored_document.document_body;
    let display_name = body
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| body.get("fileName").and_then(Value::as_str))
        .unwrap_or(stored_document.document_identifier.as_str());
    let mime_type = body
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    let created_time = body
        .get("createdTime")
        .and_then(Value::as_str)
        .unwrap_or("2026-01-01T00:00:00.000Z");
    let modified_time = body
        .get("modifiedTime")
        .and_then(Value::as_str)
        .unwrap_or(created_time);
    let size = body.get("size").and_then(Value::as_u64).unwrap_or(0);
    let web_view_link = body.get("webViewLink").and_then(Value::as_str).map(str::to_string);

    let mut entry = json!({
        "id": stored_document.document_identifier,
        "name": display_name,
        "type": "File",
        "mimeType": mime_type,
        "createdTime": created_time,
        "modifiedTime": modified_time,
        "size": size,
    });
    if let Some(owning_account) = &stored_document.owning_account {
        entry["owner"] = json!(owning_account);
    }
    if let Some(link) = web_view_link {
        entry["webViewLink"] = json!(link);
    }
    entry
}

/// (11) Merge folder entries and file entries into a single list.
fn merge_folder_entries_and_file_entries(
    folder_entries: Vec<Value>,
    file_entries: Vec<Value>,
) -> Vec<Value> {
    let mut merged = Vec::with_capacity(folder_entries.len() + file_entries.len());
    merged.extend(folder_entries);
    merged.extend(file_entries);
    merged
}

/// (12) Stable-sort so folders come before files, each group ordered by name.
fn sort_directory_entries_folders_before_files(directory_entries: &mut Vec<Value>) {
    directory_entries.sort_by(|left, right| {
        let left_is_folder = entry_is_folder(left);
        let right_is_folder = entry_is_folder(right);
        match (left_is_folder, right_is_folder) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => entry_name(left).cmp(entry_name(right)),
        }
    });
}

/// Internal helper: is a directory entry a folder?
fn entry_is_folder(entry: &Value) -> bool {
    entry.get("type").and_then(Value::as_str) == Some("Folder")
}

/// Internal helper: read a directory entry's name for ordering.
fn entry_name(entry: &Value) -> &str {
    entry.get("name").and_then(Value::as_str).unwrap_or("")
}

/// (13) Count how many entries are folders and how many are files.
fn count_directory_entries_by_kind(directory_entries: &[Value]) -> (usize, usize) {
    let mut folder_count = 0usize;
    let mut file_count = 0usize;
    for entry in directory_entries {
        if entry_is_folder(entry) {
            folder_count += 1;
        } else {
            file_count += 1;
        }
    }
    (folder_count, file_count)
}

/// (14) Wrap directory entries into the response payload with counts.
fn build_folder_contents_payload(directory_entries: Vec<Value>) -> Value {
    let (folder_count, file_count) = count_directory_entries_by_kind(&directory_entries);
    json!({
        "files": directory_entries,
        "folderCount": folder_count,
        "fileCount": file_count,
        "totalCount": folder_count + file_count,
    })
}

/// (15) Map a document collection application failure into an HTTP error.
fn map_document_collection_failure_to_http_error(
    originating_error: ApplicationError,
) -> HttpError {
    match originating_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the requested folder could not be located".to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "the principal is not authorized to view this folder".to_string(),
        },
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "the document collection could not be read: {other_failure}"
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document_with_body(identifier: &str, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: Some("scientist@alma.test".to_string()),
            document_body: body,
        }
    }

    #[test]
    fn destructure_splits_tuple_into_named_parts() {
        let (project, folder) = destructure_folder_contents_path_parameters((
            "project-1".to_string(),
            "folder-9".to_string(),
        ));
        assert_eq!(project, "project-1");
        assert_eq!(folder, "folder-9");
    }

    #[test]
    fn validate_project_identifier_accepts_good_and_rejects_empty() {
        assert!(validate_folder_contents_project_identifier("proj-42".to_string()).is_ok());
        assert!(validate_folder_contents_project_identifier(String::new()).is_err());
    }

    #[test]
    fn validate_folder_identifier_accepts_good_and_rejects_empty() {
        assert!(validate_folder_contents_folder_identifier("folder-3".to_string()).is_ok());
        assert!(validate_folder_contents_folder_identifier("   ".to_string()).is_err());
    }

    #[test]
    fn canonical_folder_names_are_non_empty_and_unique() {
        let names = build_canonical_top_level_folder_names();
        assert!(!names.is_empty());
        let mut deduplicated = names.clone();
        deduplicated.sort_unstable();
        deduplicated.dedup();
        assert_eq!(deduplicated.len(), names.len(), "folder names must be unique");
    }

    #[test]
    fn render_canonical_folder_entry_has_folder_shape() {
        let entry = render_canonical_folder_name_as_directory_entry(2, "Docs");
        assert_eq!(entry["id"], json!("folder-2"));
        assert_eq!(entry["name"], json!("Docs"));
        assert_eq!(entry["type"], json!("Folder"));
        assert!(entry_is_folder(&entry));
    }

    #[test]
    fn build_canonical_entries_matches_input_length() {
        let names = build_canonical_top_level_folder_names();
        let entries = build_canonical_folder_directory_entries(&names);
        assert_eq!(entries.len(), names.len());
        assert!(entries.iter().all(entry_is_folder));
    }

    #[test]
    fn document_belongs_matches_folder_id_field() {
        let document =
            stored_document_with_body("doc-1", json!({ "folderId": "folder-7", "name": "a.pdf" }));
        assert!(document_belongs_to_requested_folder(&document, "folder-7"));
        assert!(!document_belongs_to_requested_folder(&document, "folder-8"));
    }

    #[test]
    fn document_belongs_matches_alternate_fields() {
        let by_folder =
            stored_document_with_body("doc-2", json!({ "folder": "folder-3" }));
        let by_name =
            stored_document_with_body("doc-3", json!({ "folderName": "folder-3" }));
        let no_folder = stored_document_with_body("doc-4", json!({ "name": "orphan.txt" }));
        assert!(document_belongs_to_requested_folder(&by_folder, "folder-3"));
        assert!(document_belongs_to_requested_folder(&by_name, "folder-3"));
        assert!(!document_belongs_to_requested_folder(&no_folder, "folder-3"));
    }

    #[test]
    fn filter_documents_keeps_only_matching_folder() {
        let documents = vec![
            stored_document_with_body("doc-a", json!({ "folderId": "f1", "name": "a" })),
            stored_document_with_body("doc-b", json!({ "folderId": "f2", "name": "b" })),
            stored_document_with_body("doc-c", json!({ "folderId": "f1", "name": "c" })),
        ];
        let filtered = filter_documents_to_requested_folder(documents, "f1");
        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().all(|doc| doc.document_body["folderId"] == json!("f1")));
    }

    #[test]
    fn render_document_as_file_entry_uses_body_fields() {
        let document = stored_document_with_body(
            "doc-9",
            json!({
                "name": "paper.pdf",
                "mimeType": "application/pdf",
                "createdTime": "2026-05-01T00:00:00.000Z",
                "modifiedTime": "2026-05-02T00:00:00.000Z",
                "size": 2048,
                "webViewLink": "https://drive.example.com/doc-9"
            }),
        );
        let entry = render_stored_document_as_file_directory_entry(&document);
        assert_eq!(entry["id"], json!("doc-9"));
        assert_eq!(entry["name"], json!("paper.pdf"));
        assert_eq!(entry["type"], json!("File"));
        assert_eq!(entry["mimeType"], json!("application/pdf"));
        assert_eq!(entry["size"], json!(2048));
        assert_eq!(entry["webViewLink"], json!("https://drive.example.com/doc-9"));
        assert_eq!(entry["owner"], json!("scientist@alma.test"));
    }

    #[test]
    fn render_document_as_file_entry_falls_back_to_defaults() {
        let document = StoredDocument {
            document_identifier: "bare-doc".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        let entry = render_stored_document_as_file_directory_entry(&document);
        assert_eq!(entry["name"], json!("bare-doc"));
        assert_eq!(entry["mimeType"], json!("application/octet-stream"));
        assert_eq!(entry["size"], json!(0));
        assert!(entry.get("owner").is_none());
        assert!(entry.get("webViewLink").is_none());
    }

    #[test]
    fn merge_concatenates_folders_then_files() {
        let folders = vec![json!({ "type": "Folder", "name": "A" })];
        let files = vec![json!({ "type": "File", "name": "b" })];
        let merged = merge_folder_entries_and_file_entries(folders, files);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0]["type"], json!("Folder"));
        assert_eq!(merged[1]["type"], json!("File"));
    }

    #[test]
    fn sort_puts_folders_first_then_alphabetical() {
        let mut entries = vec![
            json!({ "type": "File", "name": "zeta.txt" }),
            json!({ "type": "Folder", "name": "Zeta" }),
            json!({ "type": "File", "name": "alpha.txt" }),
            json!({ "type": "Folder", "name": "Alpha" }),
        ];
        sort_directory_entries_folders_before_files(&mut entries);
        assert_eq!(entries[0]["name"], json!("Alpha"));
        assert_eq!(entries[1]["name"], json!("Zeta"));
        assert_eq!(entries[2]["name"], json!("alpha.txt"));
        assert_eq!(entries[3]["name"], json!("zeta.txt"));
    }

    #[test]
    fn count_by_kind_reports_folders_and_files() {
        let entries = vec![
            json!({ "type": "Folder", "name": "A" }),
            json!({ "type": "Folder", "name": "B" }),
            json!({ "type": "File", "name": "c" }),
        ];
        let (folders, files) = count_directory_entries_by_kind(&entries);
        assert_eq!(folders, 2);
        assert_eq!(files, 1);
    }

    #[test]
    fn build_payload_wraps_entries_with_counts() {
        let entries = vec![
            json!({ "type": "Folder", "name": "A" }),
            json!({ "type": "File", "name": "b" }),
        ];
        let payload = build_folder_contents_payload(entries);
        assert_eq!(payload["folderCount"], json!(1));
        assert_eq!(payload["fileCount"], json!(1));
        assert_eq!(payload["totalCount"], json!(2));
        assert_eq!(payload["files"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn map_failure_translates_variants() {
        let not_found = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(not_found, HttpError::RequestedResourceWasNotFound { .. }));

        let denied = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let upstream = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(upstream, HttpError::UpstreamApplicationFailure { .. }));
    }
}
