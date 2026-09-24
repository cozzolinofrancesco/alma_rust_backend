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

/// The canonical set of folder names a project may organize its files under.
/// Requests for a folder outside this set are rejected as not found so that
/// arbitrary path segments cannot be probed against the backing collection.
const CANONICAL_PROJECT_FOLDER_NAMES: [&str; 5] = [
    "documents",
    "reports",
    "agents",
    "literature",
    "uploads",
];

#[route(
    method = "GET",
    path = "/api/projects/:project_identifier/folders/:folder_name/files"
)]
pub async fn list_folder_files_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(path_parameters): Path<(String, String)>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requesting_account = authorized_request.authorized_principal();

    // 1. Destructure and validate the two path parameters.
    let (raw_project_identifier, raw_folder_name) =
        destructure_folder_files_path_parameters(path_parameters);
    let validated_project_identifier =
        validate_folder_files_project_identifier(raw_project_identifier)?;
    let validated_folder_name = validate_folder_files_folder_name(raw_folder_name)?;

    // 2. Reject folder names that are not part of the canonical folder set.
    assert_folder_name_is_within_canonical_folder_set(validated_folder_name.as_str())?;

    // 3. Load the caller's own file documents (RUST-IDOR-001/-002: scope the
    //    listing to the requester instead of every tenant) and keep only those
    //    belonging to the requested project and folder.
    let all_project_file_documents =
        list_project_file_documents_owned_by(&application_state, requesting_account.as_str()).await?;
    let matching_documents = filter_documents_to_folder_files(
        all_project_file_documents,
        validated_project_identifier.as_str(),
        validated_folder_name.as_str(),
    );

    // 4. Render each matching document into a file-listing entry and order the
    //    entries so the most recently modified file appears first.
    let mut file_entries: Vec<Value> = matching_documents
        .iter()
        .map(render_stored_document_as_file_listing_entry)
        .collect();
    sort_file_entries_by_modified_time_descending(&mut file_entries);

    // 5. Assemble the response payload.
    let response_payload = build_folder_files_listing_payload(file_entries);
    Ok(Json(response_payload))
}

/// (1) Splits the axum-provided tuple of path parameters into its two named
/// components without any additional processing.
fn destructure_folder_files_path_parameters(
    path_parameters: (String, String),
) -> (String, String) {
    let (project_identifier, folder_name) = path_parameters;
    (project_identifier, folder_name)
}

/// (2) Parses the raw project identifier into a `NonEmptyText`, mapping a domain
/// failure onto a malformed-request error.
fn validate_folder_files_project_identifier(
    raw_project_identifier: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_project_identifier).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the project identifier was not valid: {domain_error}"),
        }
    })
}

/// (3) Parses the raw folder name into a `NonEmptyText`, mapping a domain
/// failure onto a malformed-request error.
fn validate_folder_files_folder_name(raw_folder_name: String) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(raw_folder_name).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the folder name was not valid: {domain_error}"),
        }
    })
}

/// (4) Confirms the requested folder name (compared case-insensitively) is one
/// of the canonical folders. Anything else is reported as not found.
fn assert_folder_name_is_within_canonical_folder_set(
    candidate_folder_name: &str,
) -> Result<(), HttpError> {
    let normalized_candidate = candidate_folder_name.trim().to_ascii_lowercase();
    let is_canonical = CANONICAL_PROJECT_FOLDER_NAMES
        .iter()
        .any(|canonical_name| *canonical_name == normalized_candidate);
    if is_canonical {
        Ok(())
    } else {
        Err(HttpError::RequestedResourceWasNotFound {
            explanation: format!(
                "the folder '{candidate_folder_name}' is not a recognized project folder"
            ),
        })
    }
}

/// (5) Fetches the caller's own documents from the project-files collection
/// (RUST-IDOR-002: owner-scoped so no other tenant's files are enumerated),
/// translating any document-collection failure into an appropriate HTTP error.
fn list_project_file_documents_owned_by<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    owning_account: &'a str,
) -> impl std::future::Future<Output = Result<Vec<StoredDocument>, HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .list_documents_owned_by(PROJECT_FILES_COLLECTION_NAME, owning_account)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (6) Decides whether a stored document represents a file living inside the
/// requested project and folder. Matching is done on the document body's
/// `projectId`/`folderName` fields (with a couple of legacy aliases) and, when
/// present, the `type` field must denote a file rather than a folder.
fn document_is_file_within_folder(
    candidate_document: &StoredDocument,
    project_identifier: &str,
    folder_name: &str,
) -> bool {
    let document_body = &candidate_document.document_body;

    let document_project = read_first_string_field(document_body, &["projectId", "project_identifier"]);
    let document_folder = read_first_string_field(document_body, &["folderName", "folder_name", "folder"]);

    let project_matches = document_project
        .map(|value| value == project_identifier)
        .unwrap_or(false);
    let folder_matches = document_folder
        .map(|value| value.eq_ignore_ascii_case(folder_name))
        .unwrap_or(false);

    // If the document declares a type, it must be a file; if it declares no
    // type we optimistically treat it as a file.
    let is_file_kind = match read_first_string_field(document_body, &["type", "kind"]) {
        Some(declared_kind) => declared_kind.eq_ignore_ascii_case("file"),
        None => true,
    };

    project_matches && folder_matches && is_file_kind
}

/// (7) Retains only the documents that belong to the requested project folder.
fn filter_documents_to_folder_files(
    all_documents: Vec<StoredDocument>,
    project_identifier: &str,
    folder_name: &str,
) -> Vec<StoredDocument> {
    all_documents
        .into_iter()
        .filter(|candidate_document| {
            document_is_file_within_folder(candidate_document, project_identifier, folder_name)
        })
        .collect()
}

/// (8) Derives a human-readable file name from the document body, falling back
/// to the document identifier when no name field is present.
fn extract_file_display_name_from_document(stored_document: &StoredDocument) -> String {
    read_first_string_field(&stored_document.document_body, &["name", "fileName", "displayName"])
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| stored_document.document_identifier.clone())
}

/// (9) Infers a MIME type from the file's extension, defaulting to a generic
/// binary stream for unknown or extension-less names.
fn infer_file_mime_type_from_display_name(display_name: &str) -> String {
    let lowercased = display_name.to_ascii_lowercase();
    let extension = lowercased.rsplit_once('.').map(|(_, suffix)| suffix);
    let mime_type = match extension {
        Some("json") => "application/json",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain",
        Some("md") => "text/markdown",
        Some("csv") => "text/csv",
        Some("html") | Some("htm") => "text/html",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("docx") => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
        Some("xlsx") => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    };
    mime_type.to_string()
}

/// (10) Reads the recorded file size in bytes from the document body, treating a
/// missing or non-numeric value as zero.
fn extract_file_size_bytes_from_document(stored_document: &StoredDocument) -> usize {
    let document_body = &stored_document.document_body;
    for field_name in ["size", "sizeBytes", "byteSize"] {
        if let Some(field_value) = document_body.get(field_name) {
            if let Some(numeric_value) = field_value.as_u64() {
                return numeric_value as usize;
            }
            if let Some(string_value) = field_value.as_str() {
                if let Ok(parsed_value) = string_value.trim().parse::<usize>() {
                    return parsed_value;
                }
            }
        }
    }
    0
}

/// (11) Projects a stored document into the file-listing entry shape expected by
/// the client (id, name, mimeType, timestamps, size, and view link).
fn render_stored_document_as_file_listing_entry(stored_document: &StoredDocument) -> Value {
    let display_name = extract_file_display_name_from_document(stored_document);
    let mime_type = infer_file_mime_type_from_display_name(&display_name);
    let size_bytes = extract_file_size_bytes_from_document(stored_document);
    let document_body = &stored_document.document_body;

    let created_time = read_first_string_field(document_body, &["createdTime", "created_at"])
        .unwrap_or_default();
    let modified_time = read_first_string_field(document_body, &["modifiedTime", "modified_at", "updatedTime"])
        .unwrap_or_else(|| created_time.clone());
    let web_view_link = read_first_string_field(document_body, &["webViewLink", "viewLink", "url"])
        .unwrap_or_else(|| format!("https://drive.example.com/file/{}", stored_document.document_identifier));

    json!({
        "id": stored_document.document_identifier,
        "name": display_name,
        "mimeType": mime_type,
        "type": "File",
        "createdTime": created_time,
        "modifiedTime": modified_time,
        "webViewLink": web_view_link,
        "size": size_bytes,
    })
}

/// (12) Sorts file entries in place so that the most recently modified file is
/// listed first. Entries are compared by their `modifiedTime` string, which is
/// assumed to be an ISO-8601 timestamp (lexicographically ordered).
fn sort_file_entries_by_modified_time_descending(file_entries: &mut Vec<Value>) {
    file_entries.sort_by(|left_entry, right_entry| {
        let left_modified = left_entry
            .get("modifiedTime")
            .and_then(Value::as_str)
            .unwrap_or("");
        let right_modified = right_entry
            .get("modifiedTime")
            .and_then(Value::as_str)
            .unwrap_or("");
        right_modified.cmp(left_modified)
    });
}

/// (13) Counts the number of rendered file entries.
fn count_folder_files(file_entries: &[Value]) -> usize {
    file_entries.len()
}

/// (14) Wraps the rendered file entries in the final response envelope,
/// including a convenience count.
fn build_folder_files_listing_payload(file_entries: Vec<Value>) -> Value {
    let total_file_count = count_folder_files(&file_entries);
    json!({
        "files": file_entries,
        "count": total_file_count,
    })
}

/// (15) Translates a document-collection `ApplicationError` into the most fitting
/// HTTP error variant.
fn map_document_collection_failure_to_http_error(
    originating_error: ApplicationError,
) -> HttpError {
    match originating_error {
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: originating_error.to_string(),
            }
        }
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: originating_error.to_string(),
        },
        other_error => HttpError::UpstreamApplicationFailure {
            explanation: other_error.to_string(),
        },
    }
}

/// Shared helper: returns the first field (from `candidate_field_names`) present
/// on the JSON object as an owned string, if any.
fn read_first_string_field(document_body: &Value, candidate_field_names: &[&str]) -> Option<String> {
    for field_name in candidate_field_names {
        if let Some(field_value) = document_body.get(field_name) {
            if let Some(string_value) = field_value.as_str() {
                return Some(string_value.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document_with_body(identifier: &str, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: None,
            document_body: body,
        }
    }

    #[test]
    fn destructures_path_parameters_unchanged() {
        let (project, folder) = destructure_folder_files_path_parameters((
            "proj-1".to_string(),
            "documents".to_string(),
        ));
        assert_eq!(project, "proj-1");
        assert_eq!(folder, "documents");
    }

    #[test]
    fn validates_project_identifier_good_and_bad() {
        let good = validate_folder_files_project_identifier("proj-42".to_string());
        assert!(good.is_ok());
        assert_eq!(good.unwrap().as_str(), "proj-42");

        let bad = validate_folder_files_project_identifier("   ".to_string());
        assert!(matches!(bad, Err(HttpError::RequestBodyWasMalformed { .. })));
    }

    #[test]
    fn validates_folder_name_good_and_bad() {
        let good = validate_folder_files_folder_name("reports".to_string());
        assert!(good.is_ok());

        let bad = validate_folder_files_folder_name(String::new());
        assert!(matches!(bad, Err(HttpError::RequestBodyWasMalformed { .. })));
    }

    #[test]
    fn asserts_canonical_folder_membership() {
        assert!(assert_folder_name_is_within_canonical_folder_set("documents").is_ok());
        assert!(assert_folder_name_is_within_canonical_folder_set("REPORTS").is_ok());
        let rejected = assert_folder_name_is_within_canonical_folder_set("secret");
        assert!(matches!(
            rejected,
            Err(HttpError::RequestedResourceWasNotFound { .. })
        ));
    }

    #[test]
    fn matches_document_within_project_and_folder() {
        let document = document_with_body(
            "file-1",
            json!({ "projectId": "proj-1", "folderName": "documents", "type": "File" }),
        );
        assert!(document_is_file_within_folder(&document, "proj-1", "documents"));
        assert!(document_is_file_within_folder(&document, "proj-1", "DOCUMENTS"));
        assert!(!document_is_file_within_folder(&document, "proj-2", "documents"));
        assert!(!document_is_file_within_folder(&document, "proj-1", "reports"));
    }

    #[test]
    fn rejects_folder_typed_documents() {
        let folder_document = document_with_body(
            "folder-1",
            json!({ "projectId": "proj-1", "folderName": "documents", "type": "Folder" }),
        );
        assert!(!document_is_file_within_folder(&folder_document, "proj-1", "documents"));
    }

    #[test]
    fn filters_documents_to_matching_folder_only() {
        let documents = vec![
            document_with_body(
                "a",
                json!({ "projectId": "p", "folderName": "documents", "type": "File" }),
            ),
            document_with_body(
                "b",
                json!({ "projectId": "p", "folderName": "reports", "type": "File" }),
            ),
            document_with_body(
                "c",
                json!({ "projectId": "other", "folderName": "documents", "type": "File" }),
            ),
        ];
        let filtered = filter_documents_to_folder_files(documents, "p", "documents");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "a");
    }

    #[test]
    fn extracts_display_name_with_fallback() {
        let named = document_with_body("id-1", json!({ "name": "report.pdf" }));
        assert_eq!(extract_file_display_name_from_document(&named), "report.pdf");

        let unnamed = document_with_body("id-2", json!({ "other": true }));
        assert_eq!(extract_file_display_name_from_document(&unnamed), "id-2");

        let blank = document_with_body("id-3", json!({ "name": "  " }));
        assert_eq!(extract_file_display_name_from_document(&blank), "id-3");
    }

    #[test]
    fn infers_mime_type_from_extension() {
        assert_eq!(infer_file_mime_type_from_display_name("a.json"), "application/json");
        assert_eq!(infer_file_mime_type_from_display_name("REPORT.PDF"), "application/pdf");
        assert_eq!(
            infer_file_mime_type_from_display_name("no_extension"),
            "application/octet-stream"
        );
        assert_eq!(infer_file_mime_type_from_display_name("pic.jpeg"), "image/jpeg");
    }

    #[test]
    fn extracts_file_size_from_various_shapes() {
        let numeric = document_with_body("id", json!({ "size": 2048 }));
        assert_eq!(extract_file_size_bytes_from_document(&numeric), 2048);

        let stringy = document_with_body("id", json!({ "sizeBytes": "512" }));
        assert_eq!(extract_file_size_bytes_from_document(&stringy), 512);

        let missing = document_with_body("id", json!({ "unrelated": 1 }));
        assert_eq!(extract_file_size_bytes_from_document(&missing), 0);
    }

    #[test]
    fn renders_document_into_file_entry() {
        let document = document_with_body(
            "file-9",
            json!({
                "name": "notes.md",
                "size": 100,
                "createdTime": "2026-01-01T00:00:00.000Z",
                "modifiedTime": "2026-02-01T00:00:00.000Z"
            }),
        );
        let entry = render_stored_document_as_file_listing_entry(&document);
        assert_eq!(entry["id"], "file-9");
        assert_eq!(entry["name"], "notes.md");
        assert_eq!(entry["mimeType"], "text/markdown");
        assert_eq!(entry["type"], "File");
        assert_eq!(entry["size"], 100);
        assert_eq!(entry["modifiedTime"], "2026-02-01T00:00:00.000Z");
    }

    #[test]
    fn renders_entry_with_default_view_link_when_absent() {
        let document = document_with_body("file-x", json!({ "name": "x.txt" }));
        let entry = render_stored_document_as_file_listing_entry(&document);
        assert_eq!(
            entry["webViewLink"],
            "https://drive.example.com/file/file-x"
        );
    }

    #[test]
    fn sorts_entries_by_modified_time_descending() {
        let mut entries = vec![
            json!({ "id": "old", "modifiedTime": "2026-01-01T00:00:00.000Z" }),
            json!({ "id": "new", "modifiedTime": "2026-06-01T00:00:00.000Z" }),
            json!({ "id": "mid", "modifiedTime": "2026-03-01T00:00:00.000Z" }),
        ];
        sort_file_entries_by_modified_time_descending(&mut entries);
        assert_eq!(entries[0]["id"], "new");
        assert_eq!(entries[1]["id"], "mid");
        assert_eq!(entries[2]["id"], "old");
    }

    #[test]
    fn counts_folder_files() {
        let entries = vec![json!({}), json!({})];
        assert_eq!(count_folder_files(&entries), 2);
        assert_eq!(count_folder_files(&[]), 0);
    }

    #[test]
    fn builds_listing_payload_with_count() {
        let entries = vec![json!({ "id": "a" })];
        let payload = build_folder_files_listing_payload(entries);
        assert_eq!(payload["count"], 1);
        assert!(payload["files"].is_array());
        assert_eq!(payload["files"][0]["id"], "a");
    }

    #[test]
    fn maps_document_collection_failures() {
        let not_found = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedResourceCouldNotBeLocated,
        );
        assert!(matches!(
            not_found,
            HttpError::RequestedResourceWasNotFound { .. }
        ));

        let denied = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(denied, HttpError::AuthorizationWasDenied { .. }));

        let upstream = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(
            upstream,
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn reads_first_present_string_field() {
        let body = json!({ "folder": "documents" });
        assert_eq!(
            read_first_string_field(&body, &["folderName", "folder"]),
            Some("documents".to_string())
        );
        assert_eq!(read_first_string_field(&body, &["missing"]), None);
    }
}
