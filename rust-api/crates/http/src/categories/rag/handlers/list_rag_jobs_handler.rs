use crate::categories::rag::collections::RAG_JOBS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::Email;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

/// The default number of jobs returned when the caller does not request a
/// specific pagination limit.
const DEFAULT_JOBS_PAGINATION_LIMIT: usize = 25;

/// The largest number of jobs we are willing to return in a single response,
/// regardless of what the caller requests.
const MAXIMUM_JOBS_PAGINATION_LIMIT: usize = 200;

/// The lifecycle a retrieval-augmented-generation ingestion job can be in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RagJobLifecycleStatus {
    Queued,
    Processing,
    Completed,
    Failed,
    Cancelled,
}

impl RagJobLifecycleStatus {
    /// Parses a lifecycle status from a free-form string. Recognised spellings
    /// are matched case-insensitively; anything unrecognised yields `None`.
    fn from_wire_representation(candidate: &str) -> Option<Self> {
        match candidate.trim().to_ascii_lowercase().as_str() {
            "queued" | "pending" => Some(Self::Queued),
            "processing" | "running" | "in_progress" => Some(Self::Processing),
            "completed" | "complete" | "done" | "succeeded" => Some(Self::Completed),
            "failed" | "error" | "errored" => Some(Self::Failed),
            "cancelled" | "canceled" | "aborted" => Some(Self::Cancelled),
            _ => None,
        }
    }

    /// The canonical wire spelling of this lifecycle status.
    fn as_wire_representation(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Processing => "processing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// A count of jobs grouped by lifecycle status, used to render a summary badge
/// alongside the returned list.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RagJobLifecycleTally {
    pub queued: usize,
    pub processing: usize,
    pub completed: usize,
    pub failed: usize,
    pub cancelled: usize,
}

impl RagJobLifecycleTally {
    /// The total number of jobs represented by this tally.
    fn total(&self) -> usize {
        self.queued + self.processing + self.completed + self.failed + self.cancelled
    }

    /// Records one job in the appropriate bucket.
    fn record(&mut self, status: RagJobLifecycleStatus) {
        match status {
            RagJobLifecycleStatus::Queued => self.queued += 1,
            RagJobLifecycleStatus::Processing => self.processing += 1,
            RagJobLifecycleStatus::Completed => self.completed += 1,
            RagJobLifecycleStatus::Failed => self.failed += 1,
            RagJobLifecycleStatus::Cancelled => self.cancelled += 1,
        }
    }
}

/// A flattened, presentation-ready view of a stored ingestion job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagJobSummaryView {
    pub job_identifier: String,
    pub display_name: String,
    pub lifecycle_status: RagJobLifecycleStatus,
    pub parent_corpus_identifier: Option<String>,
    pub owning_account: Option<String>,
    pub total_files: usize,
    pub processed_files: usize,
    pub created_timestamp: Option<String>,
    pub updated_timestamp: Option<String>,
}

// ---------------------------------------------------------------------------
// (1) query parsing helpers
// ---------------------------------------------------------------------------

/// Extracts an optional lifecycle-status filter from the query parameters.
/// Unrecognised values are ignored (treated as "no filter") rather than
/// producing an error, so a stale bookmark never breaks the listing.
fn parse_optional_lifecycle_status_filter(
    query_parameters: &HashMap<String, String>,
) -> Option<RagJobLifecycleStatus> {
    query_parameters
        .get("status")
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .and_then(RagJobLifecycleStatus::from_wire_representation)
}

/// Extracts an optional parent-corpus filter from the query parameters.
fn parse_optional_corpus_identifier_filter(
    query_parameters: &HashMap<String, String>,
) -> Option<String> {
    query_parameters
        .get("corpusId")
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .map(|raw| raw.to_string())
}

/// Determines how many jobs the caller wants returned, clamped to a sane range.
/// A missing, empty, non-numeric, or zero value falls back to the default; any
/// value above the ceiling is clamped down to the ceiling.
fn parse_requested_jobs_pagination_limit(query_parameters: &HashMap<String, String>) -> usize {
    let requested = query_parameters
        .get("limit")
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|parsed| *parsed > 0)
        .unwrap_or(DEFAULT_JOBS_PAGINATION_LIMIT);
    requested.min(MAXIMUM_JOBS_PAGINATION_LIMIT)
}

// ---------------------------------------------------------------------------
// (4) persistence access
// ---------------------------------------------------------------------------

/// Loads every ingestion job owned by the requesting account from the jobs
/// collection. Takes the concrete port (not the whole application state) so it
/// does not need to be generic over the unit-of-work type.
async fn load_jobs_owned_by_requester(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    owning_account: &Email,
) -> Result<Vec<StoredDocument>, HttpError> {
    let stored_documents = document_collection
        .list_documents_owned_by(RAG_JOBS_COLLECTION_NAME, owning_account.as_str())
        .await?;
    Ok(stored_documents)
}

// ---------------------------------------------------------------------------
// (5,6,9) field readers
// ---------------------------------------------------------------------------

/// Reads the lifecycle status recorded on a stored job document. A missing or
/// unrecognised status is interpreted as `Queued`, the safest default for a job
/// whose progress we cannot determine.
fn read_job_lifecycle_status(job_document: &StoredDocument) -> RagJobLifecycleStatus {
    job_document
        .document_body
        .get("status")
        .and_then(Value::as_str)
        .and_then(RagJobLifecycleStatus::from_wire_representation)
        .unwrap_or(RagJobLifecycleStatus::Queued)
}

/// Reads the identifier of the corpus this job feeds into, if one is recorded.
fn read_job_parent_corpus_identifier(job_document: &StoredDocument) -> Option<String> {
    job_document
        .document_body
        .get("corpusId")
        .and_then(Value::as_str)
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .map(|raw| raw.to_string())
}

/// Reads the ISO-8601 creation timestamp recorded on a job document, if any.
fn read_job_created_timestamp(job_document: &StoredDocument) -> Option<String> {
    job_document
        .document_body
        .get("createdAt")
        .and_then(Value::as_str)
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .map(|raw| raw.to_string())
}

/// Reads the ISO-8601 last-update timestamp recorded on a job document, if any.
fn read_job_updated_timestamp(job_document: &StoredDocument) -> Option<String> {
    job_document
        .document_body
        .get("updatedAt")
        .and_then(Value::as_str)
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .map(|raw| raw.to_string())
}

/// Reads a non-negative integer count from the given field, defaulting to zero.
fn read_job_file_count(job_document: &StoredDocument, field_name: &str) -> usize {
    job_document
        .document_body
        .get(field_name)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(0)
}

/// Reads a human-friendly display name, falling back to the job identifier when
/// none is recorded.
fn read_job_display_name(job_document: &StoredDocument) -> String {
    job_document
        .document_body
        .get("displayName")
        .and_then(Value::as_str)
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .map(|raw| raw.to_string())
        .unwrap_or_else(|| job_document.document_identifier.clone())
}

// ---------------------------------------------------------------------------
// (7,8) filtering
// ---------------------------------------------------------------------------

/// Retains only the jobs whose lifecycle status matches the supplied filter.
/// When no filter is supplied the input is returned untouched.
fn filter_jobs_by_lifecycle_status(
    job_documents: Vec<StoredDocument>,
    status_filter: &Option<RagJobLifecycleStatus>,
) -> Vec<StoredDocument> {
    match status_filter {
        None => job_documents,
        Some(desired_status) => job_documents
            .into_iter()
            .filter(|document| read_job_lifecycle_status(document) == *desired_status)
            .collect(),
    }
}

/// Retains only the jobs whose parent corpus matches the supplied filter.
/// When no filter is supplied the input is returned untouched.
fn filter_jobs_by_parent_corpus(
    job_documents: Vec<StoredDocument>,
    corpus_filter: &Option<String>,
) -> Vec<StoredDocument> {
    match corpus_filter {
        None => job_documents,
        Some(desired_corpus) => job_documents
            .into_iter()
            .filter(|document| {
                read_job_parent_corpus_identifier(document).as_deref() == Some(desired_corpus)
            })
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// (10,11) ordering and pagination
// ---------------------------------------------------------------------------

/// Sorts jobs so the most recently created appear first. Jobs without a
/// creation timestamp sort last (their timestamp is treated as an empty string,
/// which orders below any real ISO-8601 value). Sorting is stable, so jobs that
/// share a timestamp preserve their incoming order.
fn sort_jobs_by_created_timestamp_descending(
    mut job_documents: Vec<StoredDocument>,
) -> Vec<StoredDocument> {
    job_documents.sort_by(|left, right| {
        let left_timestamp = read_job_created_timestamp(left).unwrap_or_default();
        let right_timestamp = read_job_created_timestamp(right).unwrap_or_default();
        right_timestamp.cmp(&left_timestamp)
    });
    job_documents
}

/// Truncates the job list to at most `limit` entries.
fn apply_jobs_pagination_limit(
    mut job_documents: Vec<StoredDocument>,
    limit: usize,
) -> Vec<StoredDocument> {
    job_documents.truncate(limit);
    job_documents
}

// ---------------------------------------------------------------------------
// (12) aggregation
// ---------------------------------------------------------------------------

/// Counts how many jobs fall into each lifecycle bucket.
fn tally_jobs_by_lifecycle_status(job_documents: &[StoredDocument]) -> RagJobLifecycleTally {
    let mut tally = RagJobLifecycleTally::default();
    for document in job_documents {
        tally.record(read_job_lifecycle_status(document));
    }
    tally
}

// ---------------------------------------------------------------------------
// (13,14) view construction and serialization
// ---------------------------------------------------------------------------

/// Flattens a stored job document into a presentation-ready summary view.
fn build_job_summary_view(job_document: &StoredDocument) -> RagJobSummaryView {
    RagJobSummaryView {
        job_identifier: job_document.document_identifier.clone(),
        display_name: read_job_display_name(job_document),
        lifecycle_status: read_job_lifecycle_status(job_document),
        parent_corpus_identifier: read_job_parent_corpus_identifier(job_document),
        owning_account: job_document.owning_account.clone(),
        total_files: read_job_file_count(job_document, "totalFiles"),
        processed_files: read_job_file_count(job_document, "processedFiles"),
        created_timestamp: read_job_created_timestamp(job_document),
        updated_timestamp: read_job_updated_timestamp(job_document),
    }
}

/// Renders a single summary view as a JSON object.
fn serialize_job_summary_view_to_json(summary_view: &RagJobSummaryView) -> Value {
    json!({
        "jobId": summary_view.job_identifier,
        "displayName": summary_view.display_name,
        "status": summary_view.lifecycle_status.as_wire_representation(),
        "corpusId": summary_view.parent_corpus_identifier,
        "owningAccount": summary_view.owning_account,
        "totalFiles": summary_view.total_files,
        "processedFiles": summary_view.processed_files,
        "createdAt": summary_view.created_timestamp,
        "updatedAt": summary_view.updated_timestamp,
    })
}

// ---------------------------------------------------------------------------
// (15) response assembly
// ---------------------------------------------------------------------------

/// Assembles the final response envelope from the rendered summary views and
/// the lifecycle tally.
fn assemble_list_jobs_response(
    summary_views: &[RagJobSummaryView],
    lifecycle_tally: &RagJobLifecycleTally,
) -> Value {
    let serialized_jobs: Vec<Value> = summary_views
        .iter()
        .map(serialize_job_summary_view_to_json)
        .collect();
    json!({
        "jobs": serialized_jobs,
        "returnedCount": serialized_jobs.len(),
        "statusTally": {
            "queued": lifecycle_tally.queued,
            "processing": lifecycle_tally.processing,
            "completed": lifecycle_tally.completed,
            "failed": lifecycle_tally.failed,
            "cancelled": lifecycle_tally.cancelled,
            "total": lifecycle_tally.total(),
        }
    })
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

#[route(method = "GET", path = "/api/rag/jobs")]
pub async fn list_rag_jobs_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // The route carries no query extractor, so filters default to "none";
    // parsing still runs so the same code path handles a future query string.
    let query_parameters: HashMap<String, String> = HashMap::new();
    let lifecycle_status_filter = parse_optional_lifecycle_status_filter(&query_parameters);
    let parent_corpus_filter = parse_optional_corpus_identifier_filter(&query_parameters);
    let pagination_limit = parse_requested_jobs_pagination_limit(&query_parameters);

    let owning_account = authorized_request.authorized_principal();
    let stored_jobs =
        load_jobs_owned_by_requester(&application_state.document_collection, owning_account).await?;

    let filtered_by_status = filter_jobs_by_lifecycle_status(stored_jobs, &lifecycle_status_filter);
    let filtered_by_corpus =
        filter_jobs_by_parent_corpus(filtered_by_status, &parent_corpus_filter);

    // The tally reflects everything matching the filters, before pagination, so
    // the badge counts do not shrink as the caller pages through results.
    let lifecycle_tally = tally_jobs_by_lifecycle_status(&filtered_by_corpus);

    let ordered_jobs = sort_jobs_by_created_timestamp_descending(filtered_by_corpus);
    let paginated_jobs = apply_jobs_pagination_limit(ordered_jobs, pagination_limit);

    let summary_views: Vec<RagJobSummaryView> =
        paginated_jobs.iter().map(build_job_summary_view).collect();

    Ok(Json(assemble_list_jobs_response(
        &summary_views,
        &lifecycle_tally,
    )))
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_job(
        identifier: &str,
        owner: Option<&str>,
        body: Value,
    ) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(|value| value.to_string()),
            document_body: body,
        }
    }

    #[test]
    fn parse_lifecycle_filter_reads_known_values_case_insensitively() {
        let mut parameters = HashMap::new();
        parameters.insert("status".to_string(), "  Processing ".to_string());
        assert_eq!(
            parse_optional_lifecycle_status_filter(&parameters),
            Some(RagJobLifecycleStatus::Processing)
        );
    }

    #[test]
    fn parse_lifecycle_filter_ignores_missing_and_unknown_values() {
        assert_eq!(
            parse_optional_lifecycle_status_filter(&HashMap::new()),
            None
        );
        let mut parameters = HashMap::new();
        parameters.insert("status".to_string(), "nonsense".to_string());
        assert_eq!(parse_optional_lifecycle_status_filter(&parameters), None);
    }

    #[test]
    fn parse_corpus_filter_trims_and_rejects_empty() {
        let mut parameters = HashMap::new();
        parameters.insert("corpusId".to_string(), "  corpus-1 ".to_string());
        assert_eq!(
            parse_optional_corpus_identifier_filter(&parameters),
            Some("corpus-1".to_string())
        );
        parameters.insert("corpusId".to_string(), "   ".to_string());
        assert_eq!(parse_optional_corpus_identifier_filter(&parameters), None);
    }

    #[test]
    fn parse_pagination_limit_applies_default_and_clamp() {
        assert_eq!(
            parse_requested_jobs_pagination_limit(&HashMap::new()),
            DEFAULT_JOBS_PAGINATION_LIMIT
        );
        let mut parameters = HashMap::new();
        parameters.insert("limit".to_string(), "5".to_string());
        assert_eq!(parse_requested_jobs_pagination_limit(&parameters), 5);
        parameters.insert("limit".to_string(), "99999".to_string());
        assert_eq!(
            parse_requested_jobs_pagination_limit(&parameters),
            MAXIMUM_JOBS_PAGINATION_LIMIT
        );
        parameters.insert("limit".to_string(), "0".to_string());
        assert_eq!(
            parse_requested_jobs_pagination_limit(&parameters),
            DEFAULT_JOBS_PAGINATION_LIMIT
        );
        parameters.insert("limit".to_string(), "abc".to_string());
        assert_eq!(
            parse_requested_jobs_pagination_limit(&parameters),
            DEFAULT_JOBS_PAGINATION_LIMIT
        );
    }

    #[test]
    fn read_lifecycle_status_defaults_to_queued() {
        let missing = make_job("j", None, json!({}));
        assert_eq!(
            read_job_lifecycle_status(&missing),
            RagJobLifecycleStatus::Queued
        );
        let completed = make_job("j", None, json!({ "status": "done" }));
        assert_eq!(
            read_job_lifecycle_status(&completed),
            RagJobLifecycleStatus::Completed
        );
    }

    #[test]
    fn read_parent_corpus_identifier_handles_presence_and_absence() {
        let with_corpus = make_job("j", None, json!({ "corpusId": " c-1 " }));
        assert_eq!(
            read_job_parent_corpus_identifier(&with_corpus),
            Some("c-1".to_string())
        );
        let without = make_job("j", None, json!({}));
        assert_eq!(read_job_parent_corpus_identifier(&without), None);
    }

    #[test]
    fn filter_by_lifecycle_status_matches_only_requested_status() {
        let jobs = vec![
            make_job("a", None, json!({ "status": "completed" })),
            make_job("b", None, json!({ "status": "processing" })),
            make_job("c", None, json!({ "status": "completed" })),
        ];
        let filtered = filter_jobs_by_lifecycle_status(
            jobs.clone(),
            &Some(RagJobLifecycleStatus::Completed),
        );
        assert_eq!(filtered.len(), 2);
        // No filter returns everything.
        assert_eq!(filter_jobs_by_lifecycle_status(jobs, &None).len(), 3);
    }

    #[test]
    fn filter_by_parent_corpus_matches_only_requested_corpus() {
        let jobs = vec![
            make_job("a", None, json!({ "corpusId": "c-1" })),
            make_job("b", None, json!({ "corpusId": "c-2" })),
        ];
        let filtered = filter_jobs_by_parent_corpus(jobs.clone(), &Some("c-1".to_string()));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].document_identifier, "a");
        assert_eq!(filter_jobs_by_parent_corpus(jobs, &None).len(), 2);
    }

    #[test]
    fn read_created_timestamp_handles_presence_and_absence() {
        let with_ts = make_job("j", None, json!({ "createdAt": "2026-01-01T00:00:00Z" }));
        assert_eq!(
            read_job_created_timestamp(&with_ts),
            Some("2026-01-01T00:00:00Z".to_string())
        );
        assert_eq!(read_job_created_timestamp(&make_job("j", None, json!({}))), None);
    }

    #[test]
    fn sort_by_created_timestamp_places_newest_first() {
        let jobs = vec![
            make_job("old", None, json!({ "createdAt": "2026-01-01T00:00:00Z" })),
            make_job("new", None, json!({ "createdAt": "2026-06-01T00:00:00Z" })),
            make_job("none", None, json!({})),
        ];
        let sorted = sort_jobs_by_created_timestamp_descending(jobs);
        assert_eq!(sorted[0].document_identifier, "new");
        assert_eq!(sorted[1].document_identifier, "old");
        assert_eq!(sorted[2].document_identifier, "none");
    }

    #[test]
    fn apply_pagination_limit_truncates() {
        let jobs = vec![
            make_job("a", None, json!({})),
            make_job("b", None, json!({})),
            make_job("c", None, json!({})),
        ];
        assert_eq!(apply_jobs_pagination_limit(jobs.clone(), 2).len(), 2);
        assert_eq!(apply_jobs_pagination_limit(jobs, 10).len(), 3);
    }

    #[test]
    fn tally_counts_each_lifecycle_bucket() {
        let jobs = vec![
            make_job("a", None, json!({ "status": "completed" })),
            make_job("b", None, json!({ "status": "completed" })),
            make_job("c", None, json!({ "status": "processing" })),
            make_job("d", None, json!({ "status": "failed" })),
        ];
        let tally = tally_jobs_by_lifecycle_status(&jobs);
        assert_eq!(tally.completed, 2);
        assert_eq!(tally.processing, 1);
        assert_eq!(tally.failed, 1);
        assert_eq!(tally.total(), 4);
    }

    #[test]
    fn build_summary_view_flattens_document_fields() {
        let job = make_job(
            "job-1",
            Some("owner@example.com"),
            json!({
                "displayName": "My Job",
                "status": "processing",
                "corpusId": "c-9",
                "totalFiles": 3,
                "processedFiles": 1,
                "createdAt": "2026-02-02T00:00:00Z",
                "updatedAt": "2026-02-03T00:00:00Z",
            }),
        );
        let view = build_job_summary_view(&job);
        assert_eq!(view.job_identifier, "job-1");
        assert_eq!(view.display_name, "My Job");
        assert_eq!(view.lifecycle_status, RagJobLifecycleStatus::Processing);
        assert_eq!(view.parent_corpus_identifier, Some("c-9".to_string()));
        assert_eq!(view.owning_account, Some("owner@example.com".to_string()));
        assert_eq!(view.total_files, 3);
        assert_eq!(view.processed_files, 1);
    }

    #[test]
    fn build_summary_view_falls_back_to_identifier_for_name() {
        let job = make_job("job-fallback", None, json!({}));
        let view = build_job_summary_view(&job);
        assert_eq!(view.display_name, "job-fallback");
        assert_eq!(view.lifecycle_status, RagJobLifecycleStatus::Queued);
        assert_eq!(view.total_files, 0);
    }

    #[test]
    fn serialize_summary_view_renders_expected_shape() {
        let view = RagJobSummaryView {
            job_identifier: "job-1".to_string(),
            display_name: "My Job".to_string(),
            lifecycle_status: RagJobLifecycleStatus::Completed,
            parent_corpus_identifier: Some("c-1".to_string()),
            owning_account: Some("owner@example.com".to_string()),
            total_files: 2,
            processed_files: 2,
            created_timestamp: Some("2026-01-01T00:00:00Z".to_string()),
            updated_timestamp: Some("2026-01-02T00:00:00Z".to_string()),
        };
        let rendered = serialize_job_summary_view_to_json(&view);
        assert_eq!(rendered["jobId"], json!("job-1"));
        assert_eq!(rendered["status"], json!("completed"));
        assert_eq!(rendered["totalFiles"], json!(2));
        assert_eq!(rendered["corpusId"], json!("c-1"));
    }

    #[test]
    fn assemble_response_includes_jobs_and_tally() {
        let views = vec![RagJobSummaryView {
            job_identifier: "job-1".to_string(),
            display_name: "My Job".to_string(),
            lifecycle_status: RagJobLifecycleStatus::Completed,
            parent_corpus_identifier: None,
            owning_account: None,
            total_files: 1,
            processed_files: 1,
            created_timestamp: None,
            updated_timestamp: None,
        }];
        let mut tally = RagJobLifecycleTally::default();
        tally.record(RagJobLifecycleStatus::Completed);
        let response = assemble_list_jobs_response(&views, &tally);
        assert_eq!(response["returnedCount"], json!(1));
        assert_eq!(response["jobs"].as_array().unwrap().len(), 1);
        assert_eq!(response["statusTally"]["completed"], json!(1));
        assert_eq!(response["statusTally"]["total"], json!(1));
    }
}
