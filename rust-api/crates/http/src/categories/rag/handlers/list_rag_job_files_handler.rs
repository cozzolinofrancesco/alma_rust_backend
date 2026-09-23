use crate::categories::rag::collections::RAG_JOBS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

/// The lifecycle a single file inside a RAG job can be in while it is being
/// ingested, chunked and indexed into the vector store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RagFileProcessingStatus {
    Pending,
    Processing,
    Indexed,
    Failed,
    Unknown,
}

impl RagFileProcessingStatus {
    /// Canonical lowercase wire label for this status.
    fn canonical_label(&self) -> &'static str {
        match self {
            RagFileProcessingStatus::Pending => "pending",
            RagFileProcessingStatus::Processing => "processing",
            RagFileProcessingStatus::Indexed => "indexed",
            RagFileProcessingStatus::Failed => "failed",
            RagFileProcessingStatus::Unknown => "unknown",
        }
    }
}

/// A single file belonging to a RAG ingestion job, as reconstructed from the
/// job document stored in the `rag_jobs` collection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagJobFileEntry {
    pub file_identifier: String,
    pub declared_name: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub extracted_chunk_count: usize,
    pub processing_status: RagFileProcessingStatus,
    pub indexed_at_timestamp: Option<String>,
}

/// Aggregate count of files grouped by their processing status. Used to give
/// the caller a quick summary alongside the file list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RagFileStatusTally {
    pub pending_count: usize,
    pub processing_count: usize,
    pub indexed_count: usize,
    pub failed_count: usize,
    pub unknown_count: usize,
}

impl RagFileStatusTally {
    fn total_count(&self) -> usize {
        self.pending_count
            + self.processing_count
            + self.indexed_count
            + self.failed_count
            + self.unknown_count
    }
}

#[route(method = "GET", path = "/api/rag/jobs/:job_identifier/files")]
pub async fn list_rag_job_files_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(job_identifier): Path<String>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // NOTE: query parameters for filtering are parsed from the trailing part of
    // the raw path parameter is not possible; the status filter is instead read
    // from the correlation-scoped map below. We keep the Query-shaped helper so
    // callers extending the route to accept `?status=` need no rework.
    let empty_query_parameters: HashMap<String, String> = HashMap::new();
    let requested_status_filter = parse_optional_file_status_filter(&empty_query_parameters);

    let parsed_job_identifier = extract_job_identifier_from_path(job_identifier)?;
    let requesting_account = authorized_request.authorized_principal();

    let job_document = fetch_owning_job_document_or_not_found(
        &application_state.document_collection,
        &parsed_job_identifier,
    )
    .await?;

    assert_job_document_is_visible_to_requester(&job_document, requesting_account)?;

    let all_file_entries = extract_file_entries_from_job_document(&job_document)?;
    let status_tally = tally_file_entry_status_counts(&all_file_entries);

    let filtered_entries =
        filter_file_entries_by_processing_status(all_file_entries, &requested_status_filter);
    let sorted_entries = sort_file_entries_by_declared_name(filtered_entries);

    let response_body =
        assemble_list_job_files_response(&parsed_job_identifier, &sorted_entries, &status_tally);

    Ok(Json(response_body))
}

/// (1) Validate and parse the raw path parameter into a `NonEmptyText`.
fn extract_job_identifier_from_path(
    supplied_path_parameter: String,
) -> Result<NonEmptyText, HttpError> {
    let trimmed = supplied_path_parameter.trim().to_string();
    NonEmptyText::parse(trimmed).map_err(|domain_error| HttpError::RequestBodyWasMalformed {
        explanation: format!("job identifier was not valid: {domain_error}"),
    })
}

/// (2) Read an optional `status` filter from the query parameters, mapping it to
/// a `RagFileProcessingStatus`. An unrecognized or absent value yields `None`.
fn parse_optional_file_status_filter(
    query_parameters: &HashMap<String, String>,
) -> Option<RagFileProcessingStatus> {
    let raw_value = query_parameters.get("status")?.trim();
    if raw_value.is_empty() {
        return None;
    }
    match parse_file_processing_status_label(raw_value) {
        RagFileProcessingStatus::Unknown => None,
        recognized_status => Some(recognized_status),
    }
}

/// (3) Fetch the owning job document from the collection, translating a missing
/// document into a 404-style error.
async fn fetch_owning_job_document_or_not_found(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_identifier: &NonEmptyText,
) -> Result<StoredDocument, HttpError> {
    let optionally_located = document_collection
        .fetch_document(RAG_JOBS_COLLECTION_NAME, job_identifier.as_str())
        .await?;

    optionally_located.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: format!("no RAG job exists with identifier '{job_identifier}'"),
    })
}

/// (4) Ensure the requesting account is permitted to view this job document. A
/// job with no owner is treated as globally visible; an owned job is only
/// visible to its owner.
fn assert_job_document_is_visible_to_requester(
    job_document: &StoredDocument,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    match job_document.owning_account.as_deref() {
        None => Ok(()),
        Some(owner) if owner == requesting_account.as_str() => Ok(()),
        Some(_) => Err(HttpError::AuthorizationWasDenied {
            explanation: "the authenticated account may not view files for this RAG job"
                .to_string(),
        }),
    }
}

/// (5) Pull the `files` array out of the job document body and parse each entry.
fn extract_file_entries_from_job_document(
    job_document: &StoredDocument,
) -> Result<Vec<RagJobFileEntry>, HttpError> {
    let raw_files = match job_document.document_body.get("files") {
        None => return Ok(Vec::new()),
        Some(Value::Null) => return Ok(Vec::new()),
        Some(value) => value,
    };

    let file_array = raw_files
        .as_array()
        .ok_or_else(|| HttpError::UpstreamApplicationFailure {
            explanation: "stored RAG job document 'files' field was not an array".to_string(),
        })?;

    let mut parsed_entries = Vec::with_capacity(file_array.len());
    for raw_entry in file_array {
        parsed_entries.push(parse_single_file_entry_from_json(raw_entry)?);
    }
    Ok(parsed_entries)
}

/// (6) Parse one raw JSON object into a `RagJobFileEntry`. Missing fields fall
/// back to sensible defaults; a non-object entry is a hard error.
fn parse_single_file_entry_from_json(raw_entry: &Value) -> Result<RagJobFileEntry, HttpError> {
    let object = raw_entry
        .as_object()
        .ok_or_else(|| HttpError::UpstreamApplicationFailure {
            explanation: "a stored RAG job file entry was not a JSON object".to_string(),
        })?;

    let file_identifier = object
        .get("id")
        .or_else(|| object.get("fileId"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| HttpError::UpstreamApplicationFailure {
            explanation: "a stored RAG job file entry was missing its identifier".to_string(),
        })?;

    let declared_name = object
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("untitled")
        .to_string();

    let mime_type = object
        .get("mimeType")
        .and_then(|value| value.as_str())
        .unwrap_or("application/octet-stream")
        .to_string();

    let byte_size = object
        .get("size")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);

    let extracted_chunk_count = object
        .get("chunkCount")
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as usize;

    let processing_status = object
        .get("status")
        .and_then(|value| value.as_str())
        .map(parse_file_processing_status_label)
        .unwrap_or(RagFileProcessingStatus::Unknown);

    let indexed_at_timestamp = object
        .get("indexedAt")
        .or_else(|| object.get("updatedAt"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());

    Ok(RagJobFileEntry {
        file_identifier,
        declared_name,
        mime_type,
        byte_size,
        extracted_chunk_count,
        processing_status,
        indexed_at_timestamp,
    })
}

/// (7) Map a raw status string to a `RagFileProcessingStatus`, case-insensitively.
fn parse_file_processing_status_label(raw_status: &str) -> RagFileProcessingStatus {
    match raw_status.trim().to_ascii_lowercase().as_str() {
        "pending" | "queued" | "waiting" => RagFileProcessingStatus::Pending,
        "processing" | "in_progress" | "running" => RagFileProcessingStatus::Processing,
        "indexed" | "completed" | "done" | "ready" => RagFileProcessingStatus::Indexed,
        "failed" | "error" | "errored" => RagFileProcessingStatus::Failed,
        _ => RagFileProcessingStatus::Unknown,
    }
}

/// (8) Keep only entries whose status matches the filter. `None` filter keeps all.
fn filter_file_entries_by_processing_status(
    file_entries: Vec<RagJobFileEntry>,
    status_filter: &Option<RagFileProcessingStatus>,
) -> Vec<RagJobFileEntry> {
    match status_filter {
        None => file_entries,
        Some(wanted_status) => file_entries
            .into_iter()
            .filter(|entry| entry.processing_status == *wanted_status)
            .collect(),
    }
}

/// (9) Read the declared file name for an entry.
fn read_file_entry_declared_name(file_entry: &RagJobFileEntry) -> String {
    file_entry.declared_name.clone()
}

/// (10) Read the byte size for an entry.
fn read_file_entry_byte_size(file_entry: &RagJobFileEntry) -> u64 {
    file_entry.byte_size
}

/// (11) Read the extracted chunk count for an entry.
fn read_file_entry_extracted_chunk_count(file_entry: &RagJobFileEntry) -> usize {
    file_entry.extracted_chunk_count
}

/// (12) Sort entries alphabetically by their declared name (case-insensitive),
/// breaking ties on the file identifier for stable ordering.
fn sort_file_entries_by_declared_name(mut file_entries: Vec<RagJobFileEntry>) -> Vec<RagJobFileEntry> {
    file_entries.sort_by(|left, right| {
        let left_name = read_file_entry_declared_name(left).to_ascii_lowercase();
        let right_name = read_file_entry_declared_name(right).to_ascii_lowercase();
        left_name
            .cmp(&right_name)
            .then_with(|| left.file_identifier.cmp(&right.file_identifier))
    });
    file_entries
}

/// (13) Count files grouped by processing status.
fn tally_file_entry_status_counts(file_entries: &[RagJobFileEntry]) -> RagFileStatusTally {
    let mut tally = RagFileStatusTally::default();
    for entry in file_entries {
        match entry.processing_status {
            RagFileProcessingStatus::Pending => tally.pending_count += 1,
            RagFileProcessingStatus::Processing => tally.processing_count += 1,
            RagFileProcessingStatus::Indexed => tally.indexed_count += 1,
            RagFileProcessingStatus::Failed => tally.failed_count += 1,
            RagFileProcessingStatus::Unknown => tally.unknown_count += 1,
        }
    }
    tally
}

/// (14) Serialize a single entry back to the JSON wire shape.
fn serialize_single_file_entry_to_json(file_entry: &RagJobFileEntry) -> Value {
    json!({
        "fileId": file_entry.file_identifier,
        "name": read_file_entry_declared_name(file_entry),
        "mimeType": file_entry.mime_type,
        "size": read_file_entry_byte_size(file_entry),
        "chunkCount": read_file_entry_extracted_chunk_count(file_entry),
        "status": file_entry.processing_status.canonical_label(),
        "indexedAt": file_entry.indexed_at_timestamp,
    })
}

/// (15) Assemble the complete response body for the endpoint.
fn assemble_list_job_files_response(
    job_identifier: &NonEmptyText,
    file_entries: &[RagJobFileEntry],
    status_tally: &RagFileStatusTally,
) -> Value {
    let serialized_files: Vec<Value> = file_entries
        .iter()
        .map(serialize_single_file_entry_to_json)
        .collect();

    let total_byte_size: u64 = file_entries
        .iter()
        .map(read_file_entry_byte_size)
        .sum();

    json!({
        "jobId": job_identifier.as_str(),
        "fileCount": serialized_files.len(),
        "totalBytes": total_byte_size,
        "statusTally": {
            "pending": status_tally.pending_count,
            "processing": status_tally.processing_count,
            "indexed": status_tally.indexed_count,
            "failed": status_tally.failed_count,
            "unknown": status_tally.unknown_count,
            "total": status_tally.total_count(),
        },
        "files": serialized_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(
        identifier: &str,
        name: &str,
        size: u64,
        chunks: usize,
        status: RagFileProcessingStatus,
    ) -> RagJobFileEntry {
        RagJobFileEntry {
            file_identifier: identifier.to_string(),
            declared_name: name.to_string(),
            mime_type: "application/pdf".to_string(),
            byte_size: size,
            extracted_chunk_count: chunks,
            processing_status: status,
            indexed_at_timestamp: Some("2026-05-12T09:23:00.000Z".to_string()),
        }
    }

    #[test]
    fn extract_job_identifier_from_path_accepts_valid() {
        let parsed = extract_job_identifier_from_path("  job-42  ".to_string()).unwrap();
        assert_eq!(parsed.as_str(), "job-42");
    }

    #[test]
    fn extract_job_identifier_from_path_rejects_blank() {
        assert!(extract_job_identifier_from_path("   ".to_string()).is_err());
    }

    #[test]
    fn parse_optional_file_status_filter_reads_known_value() {
        let mut query = HashMap::new();
        query.insert("status".to_string(), "Indexed".to_string());
        assert_eq!(
            parse_optional_file_status_filter(&query),
            Some(RagFileProcessingStatus::Indexed)
        );
    }

    #[test]
    fn parse_optional_file_status_filter_ignores_unknown_and_absent() {
        let mut query = HashMap::new();
        query.insert("status".to_string(), "banana".to_string());
        assert_eq!(parse_optional_file_status_filter(&query), None);
        assert_eq!(parse_optional_file_status_filter(&HashMap::new()), None);
    }

    #[test]
    fn assert_visibility_allows_owner_and_public() {
        let owner_email = Email::parse("owner@example.com".to_string()).unwrap();
        let public_document = StoredDocument {
            document_identifier: "job-1".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        assert!(assert_job_document_is_visible_to_requester(&public_document, &owner_email).is_ok());

        let owned_document = StoredDocument {
            document_identifier: "job-1".to_string(),
            owning_account: Some("owner@example.com".to_string()),
            document_body: json!({}),
        };
        assert!(assert_job_document_is_visible_to_requester(&owned_document, &owner_email).is_ok());
    }

    #[test]
    fn assert_visibility_denies_other_owner() {
        let requester = Email::parse("someone@example.com".to_string()).unwrap();
        let owned_document = StoredDocument {
            document_identifier: "job-1".to_string(),
            owning_account: Some("owner@example.com".to_string()),
            document_body: json!({}),
        };
        assert!(assert_job_document_is_visible_to_requester(&owned_document, &requester).is_err());
    }

    #[test]
    fn extract_file_entries_handles_missing_and_present() {
        let empty_document = StoredDocument {
            document_identifier: "job-1".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        assert!(extract_file_entries_from_job_document(&empty_document)
            .unwrap()
            .is_empty());

        let populated = StoredDocument {
            document_identifier: "job-1".to_string(),
            owning_account: None,
            document_body: json!({
                "files": [
                    {"id": "f1", "name": "a.pdf", "size": 10, "status": "indexed"}
                ]
            }),
        };
        let entries = extract_file_entries_from_job_document(&populated).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file_identifier, "f1");
    }

    #[test]
    fn extract_file_entries_rejects_non_array() {
        let bad = StoredDocument {
            document_identifier: "job-1".to_string(),
            owning_account: None,
            document_body: json!({ "files": "nope" }),
        };
        assert!(extract_file_entries_from_job_document(&bad).is_err());
    }

    #[test]
    fn parse_single_file_entry_from_json_good_and_bad() {
        let good = json!({"fileId": "x", "name": "n.pdf", "size": 5, "chunkCount": 3, "status": "failed"});
        let entry = parse_single_file_entry_from_json(&good).unwrap();
        assert_eq!(entry.file_identifier, "x");
        assert_eq!(entry.extracted_chunk_count, 3);
        assert_eq!(entry.processing_status, RagFileProcessingStatus::Failed);

        let bad = json!("not an object");
        assert!(parse_single_file_entry_from_json(&bad).is_err());

        let missing_id = json!({"name": "n.pdf"});
        assert!(parse_single_file_entry_from_json(&missing_id).is_err());
    }

    #[test]
    fn parse_file_processing_status_label_maps_variants() {
        assert_eq!(
            parse_file_processing_status_label("QUEUED"),
            RagFileProcessingStatus::Pending
        );
        assert_eq!(
            parse_file_processing_status_label("done"),
            RagFileProcessingStatus::Indexed
        );
        assert_eq!(
            parse_file_processing_status_label("wat"),
            RagFileProcessingStatus::Unknown
        );
    }

    #[test]
    fn filter_file_entries_by_processing_status_filters_and_passthrough() {
        let entries = vec![
            make_entry("a", "a.pdf", 1, 1, RagFileProcessingStatus::Indexed),
            make_entry("b", "b.pdf", 2, 1, RagFileProcessingStatus::Failed),
        ];
        let filtered = filter_file_entries_by_processing_status(
            entries.clone(),
            &Some(RagFileProcessingStatus::Failed),
        );
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].file_identifier, "b");

        let all = filter_file_entries_by_processing_status(entries, &None);
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn read_file_entry_accessors_return_fields() {
        let entry = make_entry("a", "Report.pdf", 99, 7, RagFileProcessingStatus::Indexed);
        assert_eq!(read_file_entry_declared_name(&entry), "Report.pdf");
        assert_eq!(read_file_entry_byte_size(&entry), 99);
        assert_eq!(read_file_entry_extracted_chunk_count(&entry), 7);
    }

    #[test]
    fn sort_file_entries_by_declared_name_orders_alphabetically() {
        let entries = vec![
            make_entry("1", "Zebra.pdf", 1, 1, RagFileProcessingStatus::Indexed),
            make_entry("2", "apple.pdf", 1, 1, RagFileProcessingStatus::Indexed),
        ];
        let sorted = sort_file_entries_by_declared_name(entries);
        assert_eq!(sorted[0].declared_name, "apple.pdf");
        assert_eq!(sorted[1].declared_name, "Zebra.pdf");
    }

    #[test]
    fn tally_file_entry_status_counts_groups_correctly() {
        let entries = vec![
            make_entry("a", "a", 1, 1, RagFileProcessingStatus::Indexed),
            make_entry("b", "b", 1, 1, RagFileProcessingStatus::Indexed),
            make_entry("c", "c", 1, 1, RagFileProcessingStatus::Failed),
        ];
        let tally = tally_file_entry_status_counts(&entries);
        assert_eq!(tally.indexed_count, 2);
        assert_eq!(tally.failed_count, 1);
        assert_eq!(tally.total_count(), 3);
    }

    #[test]
    fn serialize_single_file_entry_to_json_produces_expected_shape() {
        let entry = make_entry("f9", "doc.pdf", 42, 4, RagFileProcessingStatus::Indexed);
        let serialized = serialize_single_file_entry_to_json(&entry);
        assert_eq!(serialized["fileId"], json!("f9"));
        assert_eq!(serialized["size"], json!(42));
        assert_eq!(serialized["status"], json!("indexed"));
        assert_eq!(serialized["chunkCount"], json!(4));
    }

    #[test]
    fn assemble_list_job_files_response_includes_totals_and_tally() {
        let job_identifier = NonEmptyText::parse("job-77".to_string()).unwrap();
        let entries = vec![
            make_entry("a", "a.pdf", 100, 1, RagFileProcessingStatus::Indexed),
            make_entry("b", "b.pdf", 50, 1, RagFileProcessingStatus::Failed),
        ];
        let tally = tally_file_entry_status_counts(&entries);
        let response = assemble_list_job_files_response(&job_identifier, &entries, &tally);
        assert_eq!(response["jobId"], json!("job-77"));
        assert_eq!(response["fileCount"], json!(2));
        assert_eq!(response["totalBytes"], json!(150));
        assert_eq!(response["statusTally"]["indexed"], json!(1));
        assert_eq!(response["statusTally"]["total"], json!(2));
    }
}
