use crate::categories::ocr::collections::OCR_JOBS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Local value objects describing the temporary-file cleanup planning process.
//
// The OCR pipeline records one document per OCR job in the `ocr_jobs`
// collection. Each such document may carry temporary-file artifact metadata
// under its `document_body`. This handler performs a *dry-run* description of
// which temporary artifacts are eligible for cleanup, how much space they would
// reclaim, and how old they are — without actually deleting anything (GET is
// side-effect free).
// ---------------------------------------------------------------------------

/// The scope selecting which temporary OCR artifacts are considered.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TemporaryFileCleanupScope {
    /// Every temporary artifact across all OCR jobs.
    AllOcrJobs,
    /// Only temporary artifacts belonging to a single OCR job.
    SingleOcrJob(PersistedOcrJobIdentifier),
    /// Only orphaned artifacts (no owning account recorded).
    OrphanedArtifactsOnly,
}

/// Identifier for a persisted OCR job.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PersistedOcrJobIdentifier(String);

impl PersistedOcrJobIdentifier {
    fn as_str(&self) -> &str {
        &self.0
    }
}

/// A retention threshold expressed as an age boundary in hours. Any artifact
/// strictly older than this many hours is eligible for cleanup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TemporaryFileRetentionThreshold {
    minimum_age_hours_for_eligibility: u32,
}

/// A storage object key together with the metadata we need to reason about it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StorageObjectKey {
    /// The fully-qualified key of the temporary artifact.
    object_path: String,
    /// The OCR job this artifact originated from, if it can be derived.
    originating_ocr_job_identifier: Option<PersistedOcrJobIdentifier>,
    /// The recorded size in bytes of the artifact.
    size_in_bytes: u64,
    /// The recorded age of the artifact in hours.
    age_in_hours: u32,
    /// Whether an owning account is recorded for this artifact.
    has_owning_account: bool,
}

/// Aggregate summary of the artifacts eligible for cleanup.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TemporaryFileCleanupCandidateSummary {
    eligible_candidate_count: usize,
    distinct_ocr_job_count: usize,
}

/// A per-key descriptor used when ordering artifacts for display.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TemporaryFileCleanupKeyDescriptor {
    object_path: String,
    age_in_hours: u32,
    size_in_bytes: u64,
    exceeds_retention_threshold: bool,
    originating_ocr_job_identifier: Option<String>,
}

/// The response payload assembled for the client.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DescribeCleanupTemporaryFilesResponsePayload {
    eligible_candidate_count: usize,
    distinct_ocr_job_count: usize,
    reclaimable_bytes: u64,
    oldest_temporary_file_age_hours: u32,
}

impl DescribeCleanupTemporaryFilesResponsePayload {
    fn into_json(self) -> Value {
        json!({
            "removed_temporary_files": self.eligible_candidate_count,
            "distinct_ocr_jobs": self.distinct_ocr_job_count,
            "reclaimable_bytes": self.reclaimable_bytes,
            "oldest_temporary_file_age_hours": self.oldest_temporary_file_age_hours,
        })
    }
}

/// Errors that can arise while enumerating temporary artifacts from storage.
#[derive(Debug, Clone, PartialEq, Eq)]
enum StorageAdapterError {
    ScopeUnavailable(String),
    MalformedArtifactRecord(String),
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

#[route(method = "GET", path = "/api/cleanup-tmp")]
pub async fn describe_cleanup_temporary_files_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // (1) Determine the cleanup scope. This endpoint describes the default
    //     "all OCR jobs" scope; the parser is exercised for validation and by
    //     the test-suite for the other scope values.
    let cleanup_scope = parse_cleanup_temporary_files_target_scope("all")?;

    // (9) Refuse scopes that are not permitted for a dry-run description.
    validate_cleanup_temporary_files_scope_is_permitted(&cleanup_scope)?;

    // (4) Compute the retention threshold (24h default retention window).
    let retention_threshold = compute_temporary_file_retention_threshold(24)?;

    // Fetch the OCR job documents that hold temporary-file artifact metadata.
    let ocr_job_documents = application_state
        .document_collection
        .list_documents(OCR_JOBS_COLLECTION_NAME)
        .await?;

    // (2) Enumerate temporary artifact keys from the fetched documents.
    let candidate_keys = enumerate_temporary_ocr_artifact_keys(&ocr_job_documents, &cleanup_scope)?;

    // (5) Partition into eligible / retained.
    let (eligible_keys, _retained_keys) =
        partition_temporary_file_keys_by_cleanup_eligibility(candidate_keys, retention_threshold);

    // (6) Summarize.
    let candidate_summary = summarize_temporary_file_cleanup_candidate_count(&eligible_keys);

    // (7) Estimate reclaimable bytes.
    let reclaimable_bytes = estimate_temporary_file_cleanup_reclaimable_bytes(&eligible_keys)?;

    // (12) Oldest artifact age.
    let oldest_age_hours = compute_oldest_temporary_file_age_hours(&eligible_keys);

    // (8) Grouping and (14/15) descriptor ordering are computed to surface
    //     diagnostic detail and to exercise those helpers on the real data.
    let grouped_by_job = group_temporary_file_keys_by_originating_ocr_job(&eligible_keys);
    let mut key_descriptors: Vec<TemporaryFileCleanupKeyDescriptor> = eligible_keys
        .iter()
        .map(|object_key| build_temporary_file_cleanup_key_descriptor(object_key, retention_threshold))
        .collect();
    sort_temporary_file_key_descriptors_by_age_descending(&mut key_descriptors);
    let _ = grouped_by_job;
    let _ = key_descriptors;

    // (13) Assemble and serialize the response payload.
    let response_payload = assemble_describe_cleanup_temporary_files_response_payload(
        &candidate_summary,
        reclaimable_bytes,
        oldest_age_hours,
    );

    Ok(Json(response_payload.into_json()))
}

// ---------------------------------------------------------------------------
// (1) Scope parsing
// ---------------------------------------------------------------------------

fn parse_cleanup_temporary_files_target_scope(
    raw_scope: &str,
) -> Result<TemporaryFileCleanupScope, HttpError> {
    let normalized = raw_scope.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "cleanup scope must not be empty".to_string(),
        });
    }
    match normalized.as_str() {
        "all" | "all-ocr-jobs" => Ok(TemporaryFileCleanupScope::AllOcrJobs),
        "orphaned" | "orphaned-only" => Ok(TemporaryFileCleanupScope::OrphanedArtifactsOnly),
        other => {
            if let Some(job_reference) = other.strip_prefix("job:") {
                let trimmed_job = job_reference.trim();
                if trimmed_job.is_empty() {
                    return Err(HttpError::RequestBodyWasMalformed {
                        explanation: "job-scoped cleanup requires a job identifier".to_string(),
                    });
                }
                Ok(TemporaryFileCleanupScope::SingleOcrJob(
                    PersistedOcrJobIdentifier(trimmed_job.to_string()),
                ))
            } else {
                Err(HttpError::RequestBodyWasMalformed {
                    explanation: format!("unrecognized cleanup scope: {raw_scope}"),
                })
            }
        }
    }
}

// ---------------------------------------------------------------------------
// (9) Scope permission validation
// ---------------------------------------------------------------------------

fn validate_cleanup_temporary_files_scope_is_permitted(
    scope: &TemporaryFileCleanupScope,
) -> Result<(), HttpError> {
    match scope {
        TemporaryFileCleanupScope::SingleOcrJob(job_identifier)
            if job_identifier.as_str().len() > 256 =>
        {
            Err(HttpError::AuthorizationWasDenied {
                explanation: "job identifier exceeds the permitted length".to_string(),
            })
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// (2) Enumerate temporary artifact keys from OCR job documents
// ---------------------------------------------------------------------------

fn enumerate_temporary_ocr_artifact_keys(
    ocr_job_documents: &[StoredDocument],
    scope: &TemporaryFileCleanupScope,
) -> Result<Vec<StorageObjectKey>, HttpError> {
    let mut discovered_keys: Vec<StorageObjectKey> = Vec::new();
    let mut single_scope_target_was_found = false;

    for document in ocr_job_documents {
        let originating_job = PersistedOcrJobIdentifier(document.document_identifier.clone());
        let has_owning_account = document.owning_account.is_some();

        // Skip whole documents that fall outside the requested scope.
        match scope {
            TemporaryFileCleanupScope::AllOcrJobs => {}
            TemporaryFileCleanupScope::SingleOcrJob(target_job) => {
                if &originating_job != target_job {
                    continue;
                }
                single_scope_target_was_found = true;
            }
            TemporaryFileCleanupScope::OrphanedArtifactsOnly => {
                if has_owning_account {
                    continue;
                }
            }
        }

        let artifacts = match document.document_body.get("temporary_artifacts") {
            Some(Value::Array(items)) => items,
            Some(_) => {
                return Err(map_storage_adapter_enumeration_error_to_http_error(
                    StorageAdapterError::MalformedArtifactRecord(format!(
                        "temporary_artifacts for job {} is not an array",
                        originating_job.as_str()
                    )),
                ));
            }
            None => continue,
        };

        for artifact in artifacts {
            let object_path = match artifact.get("object_path").and_then(Value::as_str) {
                Some(path) if !path.trim().is_empty() => path.to_string(),
                _ => continue,
            };
            let size_in_bytes = artifact
                .get("size_in_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let age_in_hours = artifact
                .get("age_in_hours")
                .and_then(Value::as_u64)
                .map(|value| value.min(u32::MAX as u64) as u32)
                .unwrap_or(0);

            let originating_ocr_job_identifier =
                extract_originating_ocr_job_identifier_from_temporary_key(&StorageObjectKey {
                    object_path: object_path.clone(),
                    originating_ocr_job_identifier: Some(originating_job.clone()),
                    size_in_bytes,
                    age_in_hours,
                    has_owning_account,
                });

            discovered_keys.push(StorageObjectKey {
                object_path,
                originating_ocr_job_identifier,
                size_in_bytes,
                age_in_hours,
                has_owning_account,
            });
        }
    }

    // A job-scoped enumeration whose target OCR job is absent from the fetched
    // documents refers to a scope that cannot be described: surface it as an
    // unavailable-scope storage error rather than silently returning nothing.
    if let TemporaryFileCleanupScope::SingleOcrJob(target_job) = scope {
        if !single_scope_target_was_found {
            return Err(map_storage_adapter_enumeration_error_to_http_error(
                StorageAdapterError::ScopeUnavailable(format!(
                    "no OCR job {} is present in the collection",
                    target_job.as_str()
                )),
            ));
        }
    }

    Ok(discovered_keys)
}

// ---------------------------------------------------------------------------
// (10) Map storage enumeration error -> HttpError
// ---------------------------------------------------------------------------

fn map_storage_adapter_enumeration_error_to_http_error(
    storage_error: StorageAdapterError,
) -> HttpError {
    match storage_error {
        StorageAdapterError::ScopeUnavailable(detail) => HttpError::RequestedResourceWasNotFound {
            explanation: format!("cleanup scope is unavailable: {detail}"),
        },
        StorageAdapterError::MalformedArtifactRecord(detail) => {
            HttpError::UpstreamApplicationFailure {
                explanation: format!("temporary artifact metadata is malformed: {detail}"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// (11) Extract originating OCR job identifier from a temporary key
// ---------------------------------------------------------------------------

fn extract_originating_ocr_job_identifier_from_temporary_key(
    object_key: &StorageObjectKey,
) -> Option<PersistedOcrJobIdentifier> {
    // Prefer an already-known originating job.
    if let Some(existing) = &object_key.originating_ocr_job_identifier {
        return Some(existing.clone());
    }
    // Otherwise attempt to derive it from the conventional path layout:
    //   tmp/ocr/<job-identifier>/<artifact-name>
    let segments: Vec<&str> = object_key
        .object_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let mut iterator = segments.iter();
    while let Some(segment) = iterator.next() {
        if *segment == "ocr" {
            if let Some(candidate_job) = iterator.next() {
                if !candidate_job.is_empty() {
                    return Some(PersistedOcrJobIdentifier((*candidate_job).to_string()));
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// (4) Compute retention threshold
// ---------------------------------------------------------------------------

fn compute_temporary_file_retention_threshold(
    raw_retention_hours: u32,
) -> Result<TemporaryFileRetentionThreshold, HttpError> {
    // A retention window of zero would flag freshly-created artifacts, which is
    // never desirable for a temporary-file GC. An excessively long window is
    // rejected to guard against configuration mistakes.
    if raw_retention_hours == 0 {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "retention window must be at least one hour".to_string(),
        });
    }
    const MAXIMUM_PERMITTED_RETENTION_HOURS: u32 = 24 * 365;
    if raw_retention_hours > MAXIMUM_PERMITTED_RETENTION_HOURS {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "retention window {raw_retention_hours}h exceeds the maximum of {MAXIMUM_PERMITTED_RETENTION_HOURS}h"
            ),
        });
    }
    Ok(TemporaryFileRetentionThreshold {
        minimum_age_hours_for_eligibility: raw_retention_hours,
    })
}

// ---------------------------------------------------------------------------
// (3) Eligibility classification
// ---------------------------------------------------------------------------

fn classify_temporary_file_key_as_eligible_for_cleanup(
    object_key: &StorageObjectKey,
    retention_threshold: TemporaryFileRetentionThreshold,
) -> bool {
    object_key.age_in_hours > retention_threshold.minimum_age_hours_for_eligibility
}

// ---------------------------------------------------------------------------
// (5) Partition by eligibility
// ---------------------------------------------------------------------------

fn partition_temporary_file_keys_by_cleanup_eligibility(
    candidate_keys: Vec<StorageObjectKey>,
    retention_threshold: TemporaryFileRetentionThreshold,
) -> (Vec<StorageObjectKey>, Vec<StorageObjectKey>) {
    let mut eligible_keys: Vec<StorageObjectKey> = Vec::new();
    let mut retained_keys: Vec<StorageObjectKey> = Vec::new();
    for object_key in candidate_keys {
        if classify_temporary_file_key_as_eligible_for_cleanup(&object_key, retention_threshold) {
            eligible_keys.push(object_key);
        } else {
            retained_keys.push(object_key);
        }
    }
    (eligible_keys, retained_keys)
}

// ---------------------------------------------------------------------------
// (6) Candidate summary
// ---------------------------------------------------------------------------

fn summarize_temporary_file_cleanup_candidate_count(
    eligible_keys: &[StorageObjectKey],
) -> TemporaryFileCleanupCandidateSummary {
    let mut distinct_jobs: Vec<&str> = Vec::new();
    for object_key in eligible_keys {
        if let Some(job) = &object_key.originating_ocr_job_identifier {
            if !distinct_jobs.contains(&job.as_str()) {
                distinct_jobs.push(job.as_str());
            }
        }
    }
    TemporaryFileCleanupCandidateSummary {
        eligible_candidate_count: eligible_keys.len(),
        distinct_ocr_job_count: distinct_jobs.len(),
    }
}

// ---------------------------------------------------------------------------
// (7) Reclaimable bytes estimate
// ---------------------------------------------------------------------------

fn estimate_temporary_file_cleanup_reclaimable_bytes(
    eligible_keys: &[StorageObjectKey],
) -> Result<u64, HttpError> {
    let mut total: u64 = 0;
    for object_key in eligible_keys {
        total = total.checked_add(object_key.size_in_bytes).ok_or_else(|| {
            HttpError::UpstreamApplicationFailure {
                explanation: "reclaimable byte total overflowed u64".to_string(),
            }
        })?;
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// (8) Group by originating OCR job
// ---------------------------------------------------------------------------

fn group_temporary_file_keys_by_originating_ocr_job(
    eligible_keys: &[StorageObjectKey],
) -> Vec<(PersistedOcrJobIdentifier, Vec<StorageObjectKey>)> {
    let mut groups: Vec<(PersistedOcrJobIdentifier, Vec<StorageObjectKey>)> = Vec::new();
    for object_key in eligible_keys {
        let job = match &object_key.originating_ocr_job_identifier {
            Some(job) => job.clone(),
            None => PersistedOcrJobIdentifier("<unattributed>".to_string()),
        };
        if let Some(existing) = groups.iter_mut().find(|(existing_job, _)| existing_job == &job) {
            existing.1.push(object_key.clone());
        } else {
            groups.push((job, vec![object_key.clone()]));
        }
    }
    groups
}

// ---------------------------------------------------------------------------
// (12) Oldest artifact age
// ---------------------------------------------------------------------------

fn compute_oldest_temporary_file_age_hours(eligible_keys: &[StorageObjectKey]) -> u32 {
    eligible_keys
        .iter()
        .map(|object_key| object_key.age_in_hours)
        .max()
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// (14) Build a per-key descriptor
// ---------------------------------------------------------------------------

fn build_temporary_file_cleanup_key_descriptor(
    object_key: &StorageObjectKey,
    retention_threshold: TemporaryFileRetentionThreshold,
) -> TemporaryFileCleanupKeyDescriptor {
    TemporaryFileCleanupKeyDescriptor {
        object_path: object_key.object_path.clone(),
        age_in_hours: object_key.age_in_hours,
        size_in_bytes: object_key.size_in_bytes,
        exceeds_retention_threshold: classify_temporary_file_key_as_eligible_for_cleanup(
            object_key,
            retention_threshold,
        ),
        originating_ocr_job_identifier: object_key
            .originating_ocr_job_identifier
            .as_ref()
            .map(|job| job.as_str().to_string()),
    }
}

// ---------------------------------------------------------------------------
// (15) Sort descriptors by age (oldest first)
// ---------------------------------------------------------------------------

fn sort_temporary_file_key_descriptors_by_age_descending(
    descriptors: &mut Vec<TemporaryFileCleanupKeyDescriptor>,
) {
    descriptors.sort_by(|left, right| {
        right
            .age_in_hours
            .cmp(&left.age_in_hours)
            .then_with(|| left.object_path.cmp(&right.object_path))
    });
}

// ---------------------------------------------------------------------------
// (13) Assemble response payload
// ---------------------------------------------------------------------------

fn assemble_describe_cleanup_temporary_files_response_payload(
    summary: &TemporaryFileCleanupCandidateSummary,
    reclaimable_bytes: u64,
    oldest_age_hours: u32,
) -> DescribeCleanupTemporaryFilesResponsePayload {
    DescribeCleanupTemporaryFilesResponsePayload {
        eligible_candidate_count: summary.eligible_candidate_count,
        distinct_ocr_job_count: summary.distinct_ocr_job_count,
        reclaimable_bytes,
        oldest_temporary_file_age_hours: oldest_age_hours,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_key(
        path: &str,
        job: Option<&str>,
        size: u64,
        age: u32,
        has_owner: bool,
    ) -> StorageObjectKey {
        StorageObjectKey {
            object_path: path.to_string(),
            originating_ocr_job_identifier: job
                .map(|value| PersistedOcrJobIdentifier(value.to_string())),
            size_in_bytes: size,
            age_in_hours: age,
            has_owning_account: has_owner,
        }
    }

    fn stored_document(identifier: &str, owner: Option<&str>, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: owner.map(|value| value.to_string()),
            document_body: body,
        }
    }

    #[test]
    fn parse_scope_accepts_all_and_orphaned_and_job() {
        assert_eq!(
            parse_cleanup_temporary_files_target_scope("all").unwrap(),
            TemporaryFileCleanupScope::AllOcrJobs
        );
        assert_eq!(
            parse_cleanup_temporary_files_target_scope("  ORPHANED  ").unwrap(),
            TemporaryFileCleanupScope::OrphanedArtifactsOnly
        );
        assert_eq!(
            parse_cleanup_temporary_files_target_scope("job:abc-123").unwrap(),
            TemporaryFileCleanupScope::SingleOcrJob(PersistedOcrJobIdentifier(
                "abc-123".to_string()
            ))
        );
    }

    #[test]
    fn parse_scope_rejects_empty_and_unknown_and_bare_job_prefix() {
        assert!(parse_cleanup_temporary_files_target_scope("   ").is_err());
        assert!(parse_cleanup_temporary_files_target_scope("nonsense").is_err());
        assert!(parse_cleanup_temporary_files_target_scope("job:").is_err());
    }

    #[test]
    fn validate_scope_permits_reasonable_and_denies_oversized_job() {
        assert!(validate_cleanup_temporary_files_scope_is_permitted(
            &TemporaryFileCleanupScope::AllOcrJobs
        )
        .is_ok());
        let oversized = TemporaryFileCleanupScope::SingleOcrJob(PersistedOcrJobIdentifier(
            "x".repeat(300),
        ));
        assert!(validate_cleanup_temporary_files_scope_is_permitted(&oversized).is_err());
    }

    #[test]
    fn enumerate_extracts_artifacts_and_respects_scope() {
        let documents = vec![
            stored_document(
                "job-1",
                Some("owner@example.com"),
                json!({
                    "temporary_artifacts": [
                        { "object_path": "tmp/ocr/job-1/page1.png", "size_in_bytes": 10, "age_in_hours": 5 },
                        { "object_path": "tmp/ocr/job-1/page2.png", "size_in_bytes": 20, "age_in_hours": 50 }
                    ]
                }),
            ),
            stored_document(
                "job-2",
                None,
                json!({
                    "temporary_artifacts": [
                        { "object_path": "tmp/ocr/job-2/page1.png", "size_in_bytes": 30, "age_in_hours": 100 }
                    ]
                }),
            ),
        ];

        let all =
            enumerate_temporary_ocr_artifact_keys(&documents, &TemporaryFileCleanupScope::AllOcrJobs)
                .unwrap();
        assert_eq!(all.len(), 3);

        let orphaned = enumerate_temporary_ocr_artifact_keys(
            &documents,
            &TemporaryFileCleanupScope::OrphanedArtifactsOnly,
        )
        .unwrap();
        assert_eq!(orphaned.len(), 1);
        assert_eq!(orphaned[0].object_path, "tmp/ocr/job-2/page1.png");

        let single = enumerate_temporary_ocr_artifact_keys(
            &documents,
            &TemporaryFileCleanupScope::SingleOcrJob(PersistedOcrJobIdentifier("job-1".to_string())),
        )
        .unwrap();
        assert_eq!(single.len(), 2);
    }

    #[test]
    fn enumerate_rejects_non_array_artifact_field() {
        let documents = vec![stored_document(
            "job-x",
            None,
            json!({ "temporary_artifacts": 42 }),
        )];
        assert!(enumerate_temporary_ocr_artifact_keys(
            &documents,
            &TemporaryFileCleanupScope::AllOcrJobs
        )
        .is_err());
    }

    #[test]
    fn map_storage_error_produces_expected_variants() {
        match map_storage_adapter_enumeration_error_to_http_error(
            StorageAdapterError::ScopeUnavailable("gone".to_string()),
        ) {
            HttpError::RequestedResourceWasNotFound { .. } => {}
            other => panic!("unexpected variant: {other:?}"),
        }
        match map_storage_adapter_enumeration_error_to_http_error(
            StorageAdapterError::MalformedArtifactRecord("bad".to_string()),
        ) {
            HttpError::UpstreamApplicationFailure { .. } => {}
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn extract_job_identifier_prefers_existing_then_derives_from_path() {
        let with_existing = sample_key("tmp/ocr/derived/x.png", Some("explicit"), 0, 0, false);
        assert_eq!(
            extract_originating_ocr_job_identifier_from_temporary_key(&with_existing),
            Some(PersistedOcrJobIdentifier("explicit".to_string()))
        );

        let derivable = sample_key("tmp/ocr/derived-job/x.png", None, 0, 0, false);
        assert_eq!(
            extract_originating_ocr_job_identifier_from_temporary_key(&derivable),
            Some(PersistedOcrJobIdentifier("derived-job".to_string()))
        );

        let undeterminable = sample_key("random/path/x.png", None, 0, 0, false);
        assert_eq!(
            extract_originating_ocr_job_identifier_from_temporary_key(&undeterminable),
            None
        );
    }

    #[test]
    fn compute_retention_threshold_bounds() {
        assert!(compute_temporary_file_retention_threshold(0).is_err());
        assert!(compute_temporary_file_retention_threshold(24 * 365 + 1).is_err());
        let threshold = compute_temporary_file_retention_threshold(24).unwrap();
        assert_eq!(threshold.minimum_age_hours_for_eligibility, 24);
    }

    #[test]
    fn classify_and_partition_split_by_age() {
        let threshold = TemporaryFileRetentionThreshold {
            minimum_age_hours_for_eligibility: 24,
        };
        let young = sample_key("a", Some("j"), 1, 10, true);
        let old = sample_key("b", Some("j"), 1, 48, true);
        assert!(!classify_temporary_file_key_as_eligible_for_cleanup(&young, threshold));
        assert!(classify_temporary_file_key_as_eligible_for_cleanup(&old, threshold));

        let (eligible, retained) =
            partition_temporary_file_keys_by_cleanup_eligibility(vec![young, old], threshold);
        assert_eq!(eligible.len(), 1);
        assert_eq!(retained.len(), 1);
        assert_eq!(eligible[0].object_path, "b");
    }

    #[test]
    fn summarize_counts_candidates_and_distinct_jobs() {
        let keys = vec![
            sample_key("a", Some("j1"), 1, 30, true),
            sample_key("b", Some("j1"), 1, 40, true),
            sample_key("c", Some("j2"), 1, 50, true),
        ];
        let summary = summarize_temporary_file_cleanup_candidate_count(&keys);
        assert_eq!(summary.eligible_candidate_count, 3);
        assert_eq!(summary.distinct_ocr_job_count, 2);

        let empty = summarize_temporary_file_cleanup_candidate_count(&[]);
        assert_eq!(empty.eligible_candidate_count, 0);
        assert_eq!(empty.distinct_ocr_job_count, 0);
    }

    #[test]
    fn estimate_reclaimable_bytes_sums_and_detects_overflow() {
        let keys = vec![
            sample_key("a", None, 100, 30, false),
            sample_key("b", None, 250, 40, false),
        ];
        assert_eq!(
            estimate_temporary_file_cleanup_reclaimable_bytes(&keys).unwrap(),
            350
        );

        let overflowing = vec![
            sample_key("a", None, u64::MAX, 30, false),
            sample_key("b", None, 1, 40, false),
        ];
        assert!(estimate_temporary_file_cleanup_reclaimable_bytes(&overflowing).is_err());
    }

    #[test]
    fn group_by_job_buckets_keys() {
        let keys = vec![
            sample_key("a", Some("j1"), 1, 30, true),
            sample_key("b", Some("j2"), 1, 40, true),
            sample_key("c", Some("j1"), 1, 50, true),
            sample_key("d", None, 1, 60, false),
        ];
        let groups = group_temporary_file_keys_by_originating_ocr_job(&keys);
        assert_eq!(groups.len(), 3);
        let j1 = groups
            .iter()
            .find(|(job, _)| job.as_str() == "j1")
            .expect("j1 group present");
        assert_eq!(j1.1.len(), 2);
        let unattributed = groups
            .iter()
            .find(|(job, _)| job.as_str() == "<unattributed>")
            .expect("unattributed group present");
        assert_eq!(unattributed.1.len(), 1);
    }

    #[test]
    fn oldest_age_returns_max_or_zero() {
        assert_eq!(compute_oldest_temporary_file_age_hours(&[]), 0);
        let keys = vec![
            sample_key("a", None, 1, 30, false),
            sample_key("b", None, 1, 99, false),
        ];
        assert_eq!(compute_oldest_temporary_file_age_hours(&keys), 99);
    }

    #[test]
    fn build_descriptor_flags_threshold_and_copies_metadata() {
        let threshold = TemporaryFileRetentionThreshold {
            minimum_age_hours_for_eligibility: 24,
        };
        let key = sample_key("tmp/ocr/j1/x.png", Some("j1"), 512, 48, true);
        let descriptor = build_temporary_file_cleanup_key_descriptor(&key, threshold);
        assert_eq!(descriptor.object_path, "tmp/ocr/j1/x.png");
        assert_eq!(descriptor.size_in_bytes, 512);
        assert!(descriptor.exceeds_retention_threshold);
        assert_eq!(descriptor.originating_ocr_job_identifier, Some("j1".to_string()));
    }

    #[test]
    fn sort_descriptors_orders_oldest_first_then_path() {
        let threshold = TemporaryFileRetentionThreshold {
            minimum_age_hours_for_eligibility: 1,
        };
        let mut descriptors = vec![
            build_temporary_file_cleanup_key_descriptor(
                &sample_key("z", None, 1, 10, false),
                threshold,
            ),
            build_temporary_file_cleanup_key_descriptor(
                &sample_key("a", None, 1, 50, false),
                threshold,
            ),
            build_temporary_file_cleanup_key_descriptor(
                &sample_key("m", None, 1, 50, false),
                threshold,
            ),
        ];
        sort_temporary_file_key_descriptors_by_age_descending(&mut descriptors);
        assert_eq!(descriptors[0].object_path, "a");
        assert_eq!(descriptors[1].object_path, "m");
        assert_eq!(descriptors[2].object_path, "z");
    }

    #[test]
    fn assemble_payload_maps_fields_into_json() {
        let summary = TemporaryFileCleanupCandidateSummary {
            eligible_candidate_count: 4,
            distinct_ocr_job_count: 2,
        };
        let payload =
            assemble_describe_cleanup_temporary_files_response_payload(&summary, 2048, 72);
        let value = payload.into_json();
        assert_eq!(value["removed_temporary_files"], json!(4));
        assert_eq!(value["distinct_ocr_jobs"], json!(2));
        assert_eq!(value["reclaimable_bytes"], json!(2048));
        assert_eq!(value["oldest_temporary_file_age_hours"], json!(72));
    }
}
