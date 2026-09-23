use crate::categories::ocr::collections::OCR_JOBS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Local domain model for the preprocessing streaming description endpoint.
//
// The OCR pipeline pushes intermediate preprocessing progress into the shared
// document collection under `OCR_JOBS_COLLECTION_NAME`. Each stored document's
// `document_body` carries a `preprocessing` object shaped roughly like:
//
//   {
//     "preprocessing": {
//       "job_identifier": "…",
//       "pages_total": 12,
//       "pages_deskewed": 12,
//       "pages_denoised": 9,
//       "pages_binarized": 4,
//       "pages_segmented": 0,
//       "warnings": ["low contrast on page 3"]
//     }
//   }
//
// This handler reads the most recently observed preprocessing document, derives
// a stage-by-stage progress snapshot, and reports it back to the caller so a
// UI can render a streaming-style progress description.
// ---------------------------------------------------------------------------

/// Ordered stages a page bundle moves through during preprocessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreprocessingStreamJobStage {
    Deskew,
    Denoise,
    Binarize,
    Segment,
    Completed,
}

impl PreprocessingStreamJobStage {
    /// Stable machine-readable identifier for serialization.
    fn stage_slug(self) -> &'static str {
        match self {
            PreprocessingStreamJobStage::Deskew => "deskew",
            PreprocessingStreamJobStage::Denoise => "denoise",
            PreprocessingStreamJobStage::Binarize => "binarize",
            PreprocessingStreamJobStage::Segment => "segment",
            PreprocessingStreamJobStage::Completed => "completed",
        }
    }

    /// The four processing stages in execution order (excludes `Completed`).
    fn processing_stages_in_order() -> [PreprocessingStreamJobStage; 4] {
        [
            PreprocessingStreamJobStage::Deskew,
            PreprocessingStreamJobStage::Denoise,
            PreprocessingStreamJobStage::Binarize,
            PreprocessingStreamJobStage::Segment,
        ]
    }
}

/// Validated identifier of a persisted preprocessing job.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PersistedPreprocessingJobIdentifier {
    raw_value: String,
}

impl PersistedPreprocessingJobIdentifier {
    fn as_str(&self) -> &str {
        &self.raw_value
    }
}

/// A preprocessing job document as materialized from the document collection.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PersistedPreprocessingJobRecord {
    job_identifier: String,
    owning_account: Option<String>,
    document_body: Value,
}

/// Per-stage page counters queried for a running preprocessing job.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PreprocessingStreamJobProgressSnapshot {
    pages_total: u32,
    pages_deskewed: u32,
    pages_denoised: u32,
    pages_binarized: u32,
    pages_segmented: u32,
    stage_warnings: Vec<String>,
}

/// A single stage's descriptor for the response payload.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PreprocessingStreamJobStageDescriptor {
    stage_slug: String,
    pages_completed: u32,
    pages_total: u32,
    is_finished: bool,
}

/// The fully assembled response describing a preprocessing stream.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DescribePreprocessingStreamResponsePayload {
    job_identifier: String,
    owning_account: Option<String>,
    current_stage_slug: String,
    stage_completion_percentage: u8,
    stage_descriptors: Vec<PreprocessingStreamJobStageDescriptor>,
}

impl DescribePreprocessingStreamResponsePayload {
    fn into_json(self) -> Value {
        let serialized_descriptors: Vec<Value> = self
            .stage_descriptors
            .into_iter()
            .map(|descriptor| {
                json!({
                    "stage": descriptor.stage_slug,
                    "pages_completed": descriptor.pages_completed,
                    "pages_total": descriptor.pages_total,
                    "is_finished": descriptor.is_finished,
                })
            })
            .collect();

        json!({
            "streaming_available": true,
            "transport": "server sent events",
            "resource": "preprocessing",
            "job_identifier": self.job_identifier,
            "owning_account": self.owning_account,
            "current_stage": self.current_stage_slug,
            "stage_completion_percentage": self.stage_completion_percentage,
            "stages": serialized_descriptors,
        })
    }
}

// ---------------------------------------------------------------------------
// Function 1: parse the raw job identifier into a validated value object.
// ---------------------------------------------------------------------------
fn parse_describe_preprocessing_stream_job_identifier(
    raw_job_identifier: &str,
) -> Result<PersistedPreprocessingJobIdentifier, HttpError> {
    let trimmed_identifier = raw_job_identifier.trim();
    if trimmed_identifier.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "a preprocessing job identifier is required".to_string(),
        });
    }

    let identifier_is_well_formed = trimmed_identifier
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if !identifier_is_well_formed {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "the preprocessing job identifier contains invalid characters".to_string(),
        });
    }

    Ok(PersistedPreprocessingJobIdentifier {
        raw_value: trimmed_identifier.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Function 2: load a job record from an already-fetched slice of stored
// documents. Concrete data is passed in so the helper stays non-generic and
// trivially testable.
// ---------------------------------------------------------------------------
fn load_preprocessing_stream_job_record_within_transactional_unit(
    stored_documents: &[StoredDocument],
    job_identifier: &PersistedPreprocessingJobIdentifier,
) -> Result<PersistedPreprocessingJobRecord, HttpError> {
    let matching_document = stored_documents
        .iter()
        .find(|document| document.document_identifier == job_identifier.as_str());

    match matching_document {
        Some(document) => Ok(PersistedPreprocessingJobRecord {
            job_identifier: document.document_identifier.clone(),
            owning_account: document.owning_account.clone(),
            document_body: document.document_body.clone(),
        }),
        None => Err(map_preprocessing_stream_job_not_found_error_to_http_error(
            job_identifier,
        )),
    }
}

// ---------------------------------------------------------------------------
// Function 3: query the current progress snapshot from a job record body.
// ---------------------------------------------------------------------------
fn query_preprocessing_stream_job_current_progress(
    record: &PersistedPreprocessingJobRecord,
) -> Result<PreprocessingStreamJobProgressSnapshot, HttpError> {
    let preprocessing_section = record.document_body.get("preprocessing").ok_or_else(|| {
        map_preprocessing_stream_progress_query_error_to_http_error(
            "the job record does not contain a preprocessing section".to_string(),
        )
    })?;

    let read_page_counter = |field_name: &str| -> u32 {
        preprocessing_section
            .get(field_name)
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32
    };

    let stage_warnings = preprocessing_section
        .get("warnings")
        .and_then(Value::as_array)
        .map(|warnings| {
            warnings
                .iter()
                .filter_map(|warning| warning.as_str().map(str::to_string))
                .filter(|warning| !warning.trim().is_empty())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    Ok(PreprocessingStreamJobProgressSnapshot {
        pages_total: read_page_counter("pages_total"),
        pages_deskewed: read_page_counter("pages_deskewed"),
        pages_denoised: read_page_counter("pages_denoised"),
        pages_binarized: read_page_counter("pages_binarized"),
        pages_segmented: read_page_counter("pages_segmented"),
        stage_warnings,
    })
}

// ---------------------------------------------------------------------------
// Function 4: derive the stage the job is currently executing.
// ---------------------------------------------------------------------------
fn derive_preprocessing_stream_job_current_stage(
    progress: &PreprocessingStreamJobProgressSnapshot,
) -> PreprocessingStreamJobStage {
    let target = progress.pages_total;
    if target == 0 {
        return PreprocessingStreamJobStage::Deskew;
    }

    if progress.pages_deskewed < target {
        PreprocessingStreamJobStage::Deskew
    } else if progress.pages_denoised < target {
        PreprocessingStreamJobStage::Denoise
    } else if progress.pages_binarized < target {
        PreprocessingStreamJobStage::Binarize
    } else if progress.pages_segmented < target {
        PreprocessingStreamJobStage::Segment
    } else {
        PreprocessingStreamJobStage::Completed
    }
}

// ---------------------------------------------------------------------------
// Function 5: compute how far along the current stage is, as a percentage.
// ---------------------------------------------------------------------------
fn compute_preprocessing_stream_job_stage_completion_percentage(
    progress: &PreprocessingStreamJobProgressSnapshot,
) -> u8 {
    let target = progress.pages_total;
    if target == 0 {
        return 0;
    }

    let current_stage = derive_preprocessing_stream_job_current_stage(progress);
    let pages_completed_for_current_stage = match current_stage {
        PreprocessingStreamJobStage::Deskew => progress.pages_deskewed,
        PreprocessingStreamJobStage::Denoise => progress.pages_denoised,
        PreprocessingStreamJobStage::Binarize => progress.pages_binarized,
        PreprocessingStreamJobStage::Segment => progress.pages_segmented,
        PreprocessingStreamJobStage::Completed => target,
    };

    let clamped_completed = pages_completed_for_current_stage.min(target);
    let percentage = (u64::from(clamped_completed) * 100) / u64::from(target);
    percentage.min(100) as u8
}

// ---------------------------------------------------------------------------
// Function 6: list the stages that are fully finished.
// ---------------------------------------------------------------------------
fn list_preprocessing_stream_job_completed_stages(
    progress: &PreprocessingStreamJobProgressSnapshot,
) -> Vec<PreprocessingStreamJobStage> {
    let target = progress.pages_total;
    let mut completed_stages = Vec::new();
    if target == 0 {
        return completed_stages;
    }

    if progress.pages_deskewed >= target {
        completed_stages.push(PreprocessingStreamJobStage::Deskew);
    }
    if progress.pages_denoised >= target {
        completed_stages.push(PreprocessingStreamJobStage::Denoise);
    }
    if progress.pages_binarized >= target {
        completed_stages.push(PreprocessingStreamJobStage::Binarize);
    }
    if progress.pages_segmented >= target {
        completed_stages.push(PreprocessingStreamJobStage::Segment);
    }

    completed_stages
}

// ---------------------------------------------------------------------------
// Function 7: count deskewed pages (clamped to the page total).
// ---------------------------------------------------------------------------
fn count_preprocessing_stream_job_pages_deskewed(
    progress: &PreprocessingStreamJobProgressSnapshot,
) -> u32 {
    if progress.pages_total == 0 {
        return progress.pages_deskewed;
    }
    progress.pages_deskewed.min(progress.pages_total)
}

// ---------------------------------------------------------------------------
// Function 8: count denoised pages (clamped to the page total).
// ---------------------------------------------------------------------------
fn count_preprocessing_stream_job_pages_denoised(
    progress: &PreprocessingStreamJobProgressSnapshot,
) -> u32 {
    if progress.pages_total == 0 {
        return progress.pages_denoised;
    }
    progress.pages_denoised.min(progress.pages_total)
}

// ---------------------------------------------------------------------------
// Function 9: collect stage warnings as validated non-empty text values.
// ---------------------------------------------------------------------------
fn collect_preprocessing_stream_job_stage_warnings(
    progress: &PreprocessingStreamJobProgressSnapshot,
) -> Vec<NonEmptyText> {
    progress
        .stage_warnings
        .iter()
        .filter_map(|warning| NonEmptyText::parse(warning.clone()).ok())
        .collect()
}

// ---------------------------------------------------------------------------
// Function 10: build the not-found error for a missing job.
// ---------------------------------------------------------------------------
fn map_preprocessing_stream_job_not_found_error_to_http_error(
    job_identifier: &PersistedPreprocessingJobIdentifier,
) -> HttpError {
    HttpError::RequestedResourceWasNotFound {
        explanation: format!(
            "no preprocessing job could be located for identifier '{}'",
            job_identifier.as_str()
        ),
    }
}

// ---------------------------------------------------------------------------
// Function 11: map a progress-query failure into an HTTP error.
// ---------------------------------------------------------------------------
fn map_preprocessing_stream_progress_query_error_to_http_error(
    adapter_error: String,
) -> HttpError {
    HttpError::UpstreamApplicationFailure {
        explanation: format!(
            "the preprocessing progress query failed: {}",
            adapter_error
        ),
    }
}

// ---------------------------------------------------------------------------
// Function 12: build the per-stage descriptors for the response.
// ---------------------------------------------------------------------------
fn build_preprocessing_stream_job_stage_descriptors(
    progress: &PreprocessingStreamJobProgressSnapshot,
) -> Vec<PreprocessingStreamJobStageDescriptor> {
    let target = progress.pages_total;
    PreprocessingStreamJobStage::processing_stages_in_order()
        .into_iter()
        .map(|stage| {
            let pages_completed = match stage {
                PreprocessingStreamJobStage::Deskew => progress.pages_deskewed,
                PreprocessingStreamJobStage::Denoise => progress.pages_denoised,
                PreprocessingStreamJobStage::Binarize => progress.pages_binarized,
                PreprocessingStreamJobStage::Segment => progress.pages_segmented,
                PreprocessingStreamJobStage::Completed => target,
            };
            let clamped_completed = if target == 0 {
                pages_completed
            } else {
                pages_completed.min(target)
            };
            PreprocessingStreamJobStageDescriptor {
                stage_slug: stage.stage_slug().to_string(),
                pages_completed: clamped_completed,
                pages_total: target,
                is_finished: target > 0 && clamped_completed >= target,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Function 13: determine whether the job has finished preprocessing and is
// ready to be handed off to OCR.
// ---------------------------------------------------------------------------
fn determine_preprocessing_stream_job_is_ready_for_ocr(
    progress: &PreprocessingStreamJobProgressSnapshot,
) -> bool {
    derive_preprocessing_stream_job_current_stage(progress)
        == PreprocessingStreamJobStage::Completed
}

// ---------------------------------------------------------------------------
// Function 14: assemble the final response payload.
// ---------------------------------------------------------------------------
fn assemble_describe_preprocessing_stream_response_payload(
    record: &PersistedPreprocessingJobRecord,
    current_stage: PreprocessingStreamJobStage,
    stage_completion_percentage: u8,
    stage_descriptors: Vec<PreprocessingStreamJobStageDescriptor>,
) -> DescribePreprocessingStreamResponsePayload {
    DescribePreprocessingStreamResponsePayload {
        job_identifier: record.job_identifier.clone(),
        owning_account: record.owning_account.clone(),
        current_stage_slug: current_stage.stage_slug().to_string(),
        stage_completion_percentage,
        stage_descriptors,
    }
}

// ---------------------------------------------------------------------------
// Function 15: estimate how many processing stages remain.
// ---------------------------------------------------------------------------
fn estimate_preprocessing_stream_job_remaining_stage_count(
    progress: &PreprocessingStreamJobProgressSnapshot,
) -> u32 {
    let total_processing_stages =
        PreprocessingStreamJobStage::processing_stages_in_order().len() as u32;
    let completed_stage_count = list_preprocessing_stream_job_completed_stages(progress).len() as u32;
    total_processing_stages.saturating_sub(completed_stage_count)
}

/// Select the preprocessing job document to describe.
///
/// Prefers the most-recently-observed job owned by the authenticated principal,
/// falling back to the most-recently-observed job overall. "Most recent" is
/// approximated by the highest `preprocessing.pages_total` progress; ties break
/// on identifier ordering so the choice is deterministic.
fn select_preprocessing_stream_job_identifier(
    stored_documents: &[StoredDocument],
    authenticated_account: &str,
) -> Option<PersistedPreprocessingJobIdentifier> {
    fn preprocessing_pages_total(document: &StoredDocument) -> u64 {
        document
            .document_body
            .get("preprocessing")
            .and_then(|section| section.get("pages_total"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    }

    // Prefer the authenticated principal's own jobs; only fall back to the whole
    // set when the principal owns none. Within the chosen pool, take the job with
    // the most pages (ties broken by identifier for determinism).
    let owner_documents: Vec<&StoredDocument> = stored_documents
        .iter()
        .filter(|document| document.owning_account.as_deref() == Some(authenticated_account))
        .collect();
    let selection_pool: Vec<&StoredDocument> = if owner_documents.is_empty() {
        stored_documents.iter().collect()
    } else {
        owner_documents
    };
    let candidate = selection_pool.into_iter().max_by(|left, right| {
        preprocessing_pages_total(left)
            .cmp(&preprocessing_pages_total(right))
            .then_with(|| left.document_identifier.cmp(&right.document_identifier))
    })?;

    parse_describe_preprocessing_stream_job_identifier(&candidate.document_identifier).ok()
}

#[route(method = "GET", path = "/api/preprocessing-stream")]
pub async fn describe_preprocessing_stream_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let authenticated_account = authorized_request.authorized_principal().as_str().to_string();

    let stored_documents = application_state
        .document_collection
        .list_documents(OCR_JOBS_COLLECTION_NAME)
        .await?;

    let job_identifier = match select_preprocessing_stream_job_identifier(
        &stored_documents,
        &authenticated_account,
    ) {
        Some(identifier) => identifier,
        None => {
            return Ok(Json(json!({
                "streaming_available": true,
                "transport": "server sent events",
                "resource": "preprocessing",
                "job_identifier": Value::Null,
                "current_stage": Value::Null,
                "stage_completion_percentage": 0,
                "stages": Vec::<Value>::new(),
                "message": "no preprocessing job is currently in progress",
            })));
        }
    };

    let job_record = load_preprocessing_stream_job_record_within_transactional_unit(
        &stored_documents,
        &job_identifier,
    )?;

    let progress_snapshot = query_preprocessing_stream_job_current_progress(&job_record)?;

    let current_stage = derive_preprocessing_stream_job_current_stage(&progress_snapshot);
    let stage_completion_percentage =
        compute_preprocessing_stream_job_stage_completion_percentage(&progress_snapshot);
    let stage_descriptors =
        build_preprocessing_stream_job_stage_descriptors(&progress_snapshot);

    let pages_deskewed = count_preprocessing_stream_job_pages_deskewed(&progress_snapshot);
    let pages_denoised = count_preprocessing_stream_job_pages_denoised(&progress_snapshot);
    let completed_stages = list_preprocessing_stream_job_completed_stages(&progress_snapshot);
    let stage_warnings = collect_preprocessing_stream_job_stage_warnings(&progress_snapshot);
    let remaining_stage_count =
        estimate_preprocessing_stream_job_remaining_stage_count(&progress_snapshot);
    let is_ready_for_ocr = determine_preprocessing_stream_job_is_ready_for_ocr(&progress_snapshot);

    let response_payload = assemble_describe_preprocessing_stream_response_payload(
        &job_record,
        current_stage,
        stage_completion_percentage,
        stage_descriptors,
    );

    let mut response_json = response_payload.into_json();
    if let Value::Object(ref mut response_object) = response_json {
        response_object.insert("pages_deskewed".to_string(), json!(pages_deskewed));
        response_object.insert("pages_denoised".to_string(), json!(pages_denoised));
        response_object.insert(
            "completed_stages".to_string(),
            json!(
                completed_stages
                    .iter()
                    .map(|stage| stage.stage_slug())
                    .collect::<Vec<&str>>()
            ),
        );
        response_object.insert(
            "warnings".to_string(),
            json!(
                stage_warnings
                    .iter()
                    .map(|warning| warning.as_str())
                    .collect::<Vec<&str>>()
            ),
        );
        response_object.insert(
            "remaining_stage_count".to_string(),
            json!(remaining_stage_count),
        );
        response_object.insert("is_ready_for_ocr".to_string(), json!(is_ready_for_ocr));
        response_object.insert(
            "correlation_identifier".to_string(),
            json!(authorized_request.correlation_identifier()),
        );
    }

    Ok(Json(response_json))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(
        pages_total: u32,
        pages_deskewed: u32,
        pages_denoised: u32,
        pages_binarized: u32,
        pages_segmented: u32,
    ) -> PreprocessingStreamJobProgressSnapshot {
        PreprocessingStreamJobProgressSnapshot {
            pages_total,
            pages_deskewed,
            pages_denoised,
            pages_binarized,
            pages_segmented,
            stage_warnings: Vec::new(),
        }
    }

    fn stored_document(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(str::to_string),
            document_body: body,
        }
    }

    #[test]
    fn parse_job_identifier_accepts_valid_and_trims() {
        let parsed = parse_describe_preprocessing_stream_job_identifier("  job-42_a  ").unwrap();
        assert_eq!(parsed.as_str(), "job-42_a");
    }

    #[test]
    fn parse_job_identifier_rejects_empty_and_invalid() {
        assert!(parse_describe_preprocessing_stream_job_identifier("   ").is_err());
        assert!(parse_describe_preprocessing_stream_job_identifier("bad id!").is_err());
    }

    #[test]
    fn load_job_record_finds_match_and_reports_missing() {
        let documents = vec![stored_document(
            "job-1",
            Some("alice@example.com"),
            json!({ "preprocessing": { "pages_total": 3 } }),
        )];
        let identifier = PersistedPreprocessingJobIdentifier {
            raw_value: "job-1".to_string(),
        };
        let record =
            load_preprocessing_stream_job_record_within_transactional_unit(&documents, &identifier)
                .unwrap();
        assert_eq!(record.job_identifier, "job-1");
        assert_eq!(record.owning_account.as_deref(), Some("alice@example.com"));

        let missing = PersistedPreprocessingJobIdentifier {
            raw_value: "job-9".to_string(),
        };
        assert!(matches!(
            load_preprocessing_stream_job_record_within_transactional_unit(&documents, &missing),
            Err(HttpError::RequestedResourceWasNotFound { .. })
        ));
    }

    #[test]
    fn query_progress_reads_counters_and_warnings() {
        let record = PersistedPreprocessingJobRecord {
            job_identifier: "job-1".to_string(),
            owning_account: None,
            document_body: json!({
                "preprocessing": {
                    "pages_total": 10,
                    "pages_deskewed": 10,
                    "pages_denoised": 7,
                    "warnings": ["low contrast", "  ", "skew high"]
                }
            }),
        };
        let progress = query_preprocessing_stream_job_current_progress(&record).unwrap();
        assert_eq!(progress.pages_total, 10);
        assert_eq!(progress.pages_deskewed, 10);
        assert_eq!(progress.pages_denoised, 7);
        assert_eq!(progress.pages_binarized, 0);
        assert_eq!(progress.stage_warnings, vec!["low contrast", "skew high"]);
    }

    #[test]
    fn query_progress_errors_without_section() {
        let record = PersistedPreprocessingJobRecord {
            job_identifier: "job-1".to_string(),
            owning_account: None,
            document_body: json!({ "unrelated": true }),
        };
        assert!(matches!(
            query_preprocessing_stream_job_current_progress(&record),
            Err(HttpError::UpstreamApplicationFailure { .. })
        ));
    }

    #[test]
    fn derive_current_stage_walks_the_pipeline() {
        assert_eq!(
            derive_preprocessing_stream_job_current_stage(&snapshot(10, 3, 0, 0, 0)),
            PreprocessingStreamJobStage::Deskew
        );
        assert_eq!(
            derive_preprocessing_stream_job_current_stage(&snapshot(10, 10, 4, 0, 0)),
            PreprocessingStreamJobStage::Denoise
        );
        assert_eq!(
            derive_preprocessing_stream_job_current_stage(&snapshot(10, 10, 10, 5, 0)),
            PreprocessingStreamJobStage::Binarize
        );
        assert_eq!(
            derive_preprocessing_stream_job_current_stage(&snapshot(10, 10, 10, 10, 2)),
            PreprocessingStreamJobStage::Segment
        );
        assert_eq!(
            derive_preprocessing_stream_job_current_stage(&snapshot(10, 10, 10, 10, 10)),
            PreprocessingStreamJobStage::Completed
        );
        assert_eq!(
            derive_preprocessing_stream_job_current_stage(&snapshot(0, 0, 0, 0, 0)),
            PreprocessingStreamJobStage::Deskew
        );
    }

    #[test]
    fn compute_stage_completion_percentage_is_clamped() {
        assert_eq!(
            compute_preprocessing_stream_job_stage_completion_percentage(&snapshot(10, 5, 0, 0, 0)),
            50
        );
        assert_eq!(
            compute_preprocessing_stream_job_stage_completion_percentage(&snapshot(
                10, 10, 10, 10, 10
            )),
            100
        );
        assert_eq!(
            compute_preprocessing_stream_job_stage_completion_percentage(&snapshot(0, 0, 0, 0, 0)),
            0
        );
    }

    #[test]
    fn list_completed_stages_reports_finished_stages() {
        let completed = list_preprocessing_stream_job_completed_stages(&snapshot(10, 10, 10, 3, 0));
        assert_eq!(
            completed,
            vec![
                PreprocessingStreamJobStage::Deskew,
                PreprocessingStreamJobStage::Denoise
            ]
        );
        assert!(list_preprocessing_stream_job_completed_stages(&snapshot(0, 0, 0, 0, 0)).is_empty());
    }

    #[test]
    fn count_pages_deskewed_and_denoised_are_clamped() {
        assert_eq!(
            count_preprocessing_stream_job_pages_deskewed(&snapshot(10, 15, 0, 0, 0)),
            10
        );
        assert_eq!(
            count_preprocessing_stream_job_pages_deskewed(&snapshot(0, 4, 0, 0, 0)),
            4
        );
        assert_eq!(
            count_preprocessing_stream_job_pages_denoised(&snapshot(10, 10, 12, 0, 0)),
            10
        );
        assert_eq!(
            count_preprocessing_stream_job_pages_denoised(&snapshot(0, 0, 6, 0, 0)),
            6
        );
    }

    #[test]
    fn collect_stage_warnings_produces_non_empty_text() {
        let mut progress = snapshot(10, 0, 0, 0, 0);
        progress.stage_warnings = vec!["low contrast".to_string(), String::new()];
        let warnings = collect_preprocessing_stream_job_stage_warnings(&progress);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].as_str(), "low contrast");
    }

    #[test]
    fn map_not_found_error_includes_identifier() {
        let identifier = PersistedPreprocessingJobIdentifier {
            raw_value: "job-7".to_string(),
        };
        match map_preprocessing_stream_job_not_found_error_to_http_error(&identifier) {
            HttpError::RequestedResourceWasNotFound { explanation } => {
                assert!(explanation.contains("job-7"));
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    #[test]
    fn map_progress_query_error_wraps_message() {
        match map_preprocessing_stream_progress_query_error_to_http_error("boom".to_string()) {
            HttpError::UpstreamApplicationFailure { explanation } => {
                assert!(explanation.contains("boom"));
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    #[test]
    fn build_stage_descriptors_marks_finished_stages() {
        let descriptors =
            build_preprocessing_stream_job_stage_descriptors(&snapshot(10, 10, 5, 0, 0));
        assert_eq!(descriptors.len(), 4);
        assert!(descriptors[0].is_finished);
        assert_eq!(descriptors[0].pages_completed, 10);
        assert!(!descriptors[1].is_finished);
        assert_eq!(descriptors[1].pages_completed, 5);
        assert_eq!(descriptors[1].pages_total, 10);
    }

    #[test]
    fn determine_ready_for_ocr_only_when_completed() {
        assert!(determine_preprocessing_stream_job_is_ready_for_ocr(&snapshot(
            10, 10, 10, 10, 10
        )));
        assert!(!determine_preprocessing_stream_job_is_ready_for_ocr(
            &snapshot(10, 10, 10, 10, 9)
        ));
    }

    #[test]
    fn assemble_response_payload_carries_fields() {
        let record = PersistedPreprocessingJobRecord {
            job_identifier: "job-1".to_string(),
            owning_account: Some("alice@example.com".to_string()),
            document_body: json!({}),
        };
        let descriptors =
            build_preprocessing_stream_job_stage_descriptors(&snapshot(10, 10, 5, 0, 0));
        let payload = assemble_describe_preprocessing_stream_response_payload(
            &record,
            PreprocessingStreamJobStage::Denoise,
            50,
            descriptors,
        );
        assert_eq!(payload.job_identifier, "job-1");
        assert_eq!(payload.current_stage_slug, "denoise");
        assert_eq!(payload.stage_completion_percentage, 50);
        assert_eq!(payload.stage_descriptors.len(), 4);
    }

    #[test]
    fn estimate_remaining_stage_count_counts_down() {
        assert_eq!(
            estimate_preprocessing_stream_job_remaining_stage_count(&snapshot(10, 0, 0, 0, 0)),
            4
        );
        assert_eq!(
            estimate_preprocessing_stream_job_remaining_stage_count(&snapshot(10, 10, 10, 0, 0)),
            2
        );
        assert_eq!(
            estimate_preprocessing_stream_job_remaining_stage_count(&snapshot(10, 10, 10, 10, 10)),
            0
        );
    }

    #[test]
    fn select_job_identifier_prefers_owner_then_largest() {
        let documents = vec![
            stored_document(
                "job-a",
                Some("bob@example.com"),
                json!({ "preprocessing": { "pages_total": 50 } }),
            ),
            stored_document(
                "job-b",
                Some("alice@example.com"),
                json!({ "preprocessing": { "pages_total": 5 } }),
            ),
        ];
        let selected =
            select_preprocessing_stream_job_identifier(&documents, "alice@example.com").unwrap();
        assert_eq!(selected.as_str(), "job-b");

        assert!(select_preprocessing_stream_job_identifier(&[], "alice@example.com").is_none());
    }
}
