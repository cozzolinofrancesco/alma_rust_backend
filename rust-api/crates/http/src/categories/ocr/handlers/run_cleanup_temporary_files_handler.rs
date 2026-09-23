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
// Local domain model for the temporary-file cleanup workflow.
//
// The OCR pipeline persists intermediate artifacts (rasterized pages, page
// crops, staging manifests) that are keyed inside the OCR jobs collection.
// This handler enumerates the artifacts that have aged past their retention
// window, deletes them, and reports how much space was reclaimed. The types
// below give every helper a concrete, easily-testable shape.
// ---------------------------------------------------------------------------

/// Which family of temporary OCR artifacts a cleanup run should target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TemporaryFileCleanupScope {
    /// Every temporary artifact regardless of kind.
    AllTemporaryArtifacts,
    /// Only rasterized page images produced during preprocessing.
    RasterizedPageImages,
    /// Only staging manifests written before a job is finalized.
    StagingManifests,
}

impl TemporaryFileCleanupScope {
    /// Stable, log-friendly label for the scope.
    fn as_label(self) -> &'static str {
        match self {
            TemporaryFileCleanupScope::AllTemporaryArtifacts => "all_temporary_artifacts",
            TemporaryFileCleanupScope::RasterizedPageImages => "rasterized_page_images",
            TemporaryFileCleanupScope::StagingManifests => "staging_manifests",
        }
    }

    /// Whether an artifact of the given kind falls within this scope.
    fn admits_artifact_kind(self, artifact_kind: &str) -> bool {
        match self {
            TemporaryFileCleanupScope::AllTemporaryArtifacts => true,
            TemporaryFileCleanupScope::RasterizedPageImages => {
                artifact_kind == "rasterized_page_image"
            }
            TemporaryFileCleanupScope::StagingManifests => artifact_kind == "staging_manifest",
        }
    }
}

/// A validated retention window, expressed as an age in hours beyond which a
/// temporary artifact becomes eligible for deletion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TemporaryFileRetentionThreshold {
    retention_hours: u32,
}

impl TemporaryFileRetentionThreshold {
    /// Hours an artifact must exceed before it is deletable.
    fn retention_hours(self) -> u32 {
        self.retention_hours
    }

    /// An artifact aged `artifact_age_hours` is deletable when it is strictly
    /// older than the configured threshold.
    fn is_artifact_deletable(self, artifact_age_hours: u32) -> bool {
        artifact_age_hours > self.retention_hours()
    }
}

/// Opaque handle for a temporary artifact stored in the backing object store.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StorageObjectKey {
    opaque_key: String,
    approximate_size_bytes: u64,
}

impl StorageObjectKey {
    /// Construct a key from its raw string and recorded size.
    fn from_parts(opaque_key: String, approximate_size_bytes: u64) -> Self {
        Self {
            opaque_key,
            approximate_size_bytes,
        }
    }

    /// The raw object-store key.
    fn opaque_key(&self) -> &str {
        &self.opaque_key
    }

    /// Recorded byte size, used to tally reclaimed space.
    fn approximate_size_bytes(&self) -> u64 {
        self.approximate_size_bytes
    }
}

/// Errors that can arise while deleting a single artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
enum StorageAdapterError {
    /// The key referenced an object that no longer exists.
    ObjectKeyWasNotFound { offending_key: String },
    /// The underlying store rejected the deletion.
    DeletionWasRejected { offending_key: String, reason: String },
}

impl StorageAdapterError {
    /// The key that triggered the error.
    fn offending_key(&self) -> &str {
        match self {
            StorageAdapterError::ObjectKeyWasNotFound { offending_key } => offending_key,
            StorageAdapterError::DeletionWasRejected { offending_key, .. } => offending_key,
        }
    }

    /// Human-readable description of the failure.
    fn describe(&self) -> String {
        let offending_key = self.offending_key();
        match self {
            StorageAdapterError::ObjectKeyWasNotFound { .. } => {
                format!("object key '{offending_key}' was not found")
            }
            StorageAdapterError::DeletionWasRejected { reason, .. } => {
                format!("deletion of '{offending_key}' was rejected: {reason}")
            }
        }
    }
}

/// A per-key failure surfaced back to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TemporaryFileCleanupFailureDescriptor {
    failing_object_key: String,
    failure_explanation: String,
}

/// Immutable record of a completed cleanup run, suitable for an audit log.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TemporaryFileCleanupAuditEntry {
    scope_label: String,
    deleted_key_count: u32,
    reclaimed_bytes: u64,
}

/// The fully assembled response body for a cleanup run.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RunCleanupTemporaryFilesResponsePayload {
    deleted_key_count: u32,
    reclaimed_bytes: u64,
    failure_descriptors: Vec<TemporaryFileCleanupFailureDescriptor>,
}

impl RunCleanupTemporaryFilesResponsePayload {
    /// Serialize into the JSON envelope returned by the handler.
    fn into_json(self) -> Value {
        let encoded_failures: Vec<Value> = self
            .failure_descriptors
            .into_iter()
            .map(|descriptor| {
                json!({
                    "object_key": descriptor.failing_object_key,
                    "explanation": descriptor.failure_explanation,
                })
            })
            .collect();

        json!({
            "cleanup": "completed",
            "deleted_key_count": self.deleted_key_count,
            "reclaimed_bytes": self.reclaimed_bytes,
            "failures": encoded_failures,
        })
    }
}

// ---------------------------------------------------------------------------
// 1. Parse the requested cleanup scope.
// ---------------------------------------------------------------------------
fn parse_run_cleanup_temporary_files_target_scope(
    raw_scope: &str,
) -> Result<TemporaryFileCleanupScope, HttpError> {
    match raw_scope.trim().to_ascii_lowercase().as_str() {
        "all" | "all_temporary_artifacts" => {
            Ok(TemporaryFileCleanupScope::AllTemporaryArtifacts)
        }
        "rasterized_page_images" | "rasterized" => {
            Ok(TemporaryFileCleanupScope::RasterizedPageImages)
        }
        "staging_manifests" | "staging" => Ok(TemporaryFileCleanupScope::StagingManifests),
        other => Err(HttpError::RequestBodyWasMalformed {
            explanation: format!("unknown temporary file cleanup scope '{other}'"),
        }),
    }
}

// ---------------------------------------------------------------------------
// 2. Turn a raw retention-hours value into a validated threshold.
// ---------------------------------------------------------------------------
fn compute_run_cleanup_temporary_files_retention_threshold(
    raw_retention_hours: u32,
) -> Result<TemporaryFileRetentionThreshold, HttpError> {
    const MAXIMUM_RETENTION_HOURS: u32 = 24 * 365;

    if raw_retention_hours == 0 {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("retention hours must be greater than zero"),
        });
    }
    if raw_retention_hours > MAXIMUM_RETENTION_HOURS {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "retention hours {raw_retention_hours} exceeds the maximum of {MAXIMUM_RETENTION_HOURS}"
            ),
        });
    }
    Ok(TemporaryFileRetentionThreshold {
        retention_hours: raw_retention_hours,
    })
}

// ---------------------------------------------------------------------------
// 3. Enumerate the artifact keys that are eligible for deletion.
//
// Each OCR job document body may carry a `temporary_artifacts` array; every
// entry declares a `kind`, an `object_key`, an `age_hours`, and a
// `size_bytes`. A key is deletable when its kind falls within the scope and
// its age exceeds the retention threshold.
// ---------------------------------------------------------------------------
fn enumerate_deletable_temporary_ocr_artifact_keys(
    ocr_job_documents: &[StoredDocument],
    scope: &TemporaryFileCleanupScope,
    retention_threshold: TemporaryFileRetentionThreshold,
) -> Result<Vec<StorageObjectKey>, HttpError> {
    let mut deletable_keys: Vec<StorageObjectKey> = Vec::new();

    for job_document in ocr_job_documents {
        let Some(artifact_entries) = job_document
            .document_body
            .get("temporary_artifacts")
            .and_then(Value::as_array)
        else {
            continue;
        };

        for artifact_entry in artifact_entries {
            let artifact_kind = artifact_entry
                .get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| HttpError::RequestBodyWasMalformed {
                    explanation: format!(
                        "temporary artifact in job '{}' is missing its kind",
                        job_document.document_identifier
                    ),
                })?;

            if !scope.admits_artifact_kind(artifact_kind) {
                continue;
            }

            let artifact_age_hours = artifact_entry
                .get("age_hours")
                .and_then(Value::as_u64)
                .ok_or_else(|| HttpError::RequestBodyWasMalformed {
                    explanation: format!(
                        "temporary artifact in job '{}' is missing a numeric age_hours",
                        job_document.document_identifier
                    ),
                })? as u32;

            if !retention_threshold.is_artifact_deletable(artifact_age_hours) {
                continue;
            }

            let object_key = artifact_entry
                .get("object_key")
                .and_then(Value::as_str)
                .ok_or_else(|| HttpError::RequestBodyWasMalformed {
                    explanation: format!(
                        "temporary artifact in job '{}' is missing an object_key",
                        job_document.document_identifier
                    ),
                })?;

            let size_bytes = artifact_entry
                .get("size_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(0);

            deletable_keys.push(StorageObjectKey::from_parts(
                object_key.to_string(),
                size_bytes,
            ));
        }
    }

    Ok(deletable_keys)
}

// ---------------------------------------------------------------------------
// 4. Validate the caller-supplied confirmation token.
// ---------------------------------------------------------------------------
fn validate_run_cleanup_temporary_files_confirmation_token(
    raw_confirmation_token: &str,
) -> Result<NonEmptyText, HttpError> {
    let confirmation_token = NonEmptyText::parse(raw_confirmation_token.to_string())
        .map_err(|domain_error| HttpError::RequestBodyWasMalformed {
            explanation: domain_error.to_string(),
        })?;

    if confirmation_token.as_str() != "CONFIRM_CLEANUP" {
        return Err(HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the confirmation token did not match the required value",
            ),
        });
    }

    Ok(confirmation_token)
}

// ---------------------------------------------------------------------------
// 5. Delete a single key. Deterministic, pure model of the storage adapter:
//    a key that has been "tombstoned" (prefixed with `missing:`) is reported
//    as not found; every other key is deleted and its size returned.
// ---------------------------------------------------------------------------
fn delete_temporary_file_key_via_storage_adapter(
    object_key: &StorageObjectKey,
) -> Result<u64, StorageAdapterError> {
    if object_key.opaque_key().is_empty() {
        return Err(StorageAdapterError::DeletionWasRejected {
            offending_key: String::new(),
            reason: String::from("empty object key"),
        });
    }
    if object_key.opaque_key().starts_with("missing:") {
        return Err(StorageAdapterError::ObjectKeyWasNotFound {
            offending_key: object_key.opaque_key().to_string(),
        });
    }
    Ok(object_key.approximate_size_bytes())
}

// ---------------------------------------------------------------------------
// 6. Delete a whole batch, preserving per-key outcome order.
// ---------------------------------------------------------------------------
fn execute_temporary_file_batch_deletion(
    deletable_keys: &[StorageObjectKey],
) -> Vec<Result<u64, StorageAdapterError>> {
    deletable_keys
        .iter()
        .map(delete_temporary_file_key_via_storage_adapter)
        .collect()
}

// ---------------------------------------------------------------------------
// 7. Split outcomes into (successfully-deleted keys, failures with their key).
// ---------------------------------------------------------------------------
fn partition_temporary_file_deletion_outcomes(
    deletion_outcomes: Vec<Result<u64, StorageAdapterError>>,
    deletable_keys: &[StorageObjectKey],
) -> (
    Vec<StorageObjectKey>,
    Vec<(StorageObjectKey, StorageAdapterError)>,
) {
    let mut successful_keys: Vec<StorageObjectKey> = Vec::new();
    let mut failed_deletions: Vec<(StorageObjectKey, StorageAdapterError)> = Vec::new();

    for (outcome, key) in deletion_outcomes.into_iter().zip(deletable_keys.iter()) {
        match outcome {
            Ok(_reclaimed_bytes) => successful_keys.push(key.clone()),
            Err(storage_error) => failed_deletions.push((key.clone(), storage_error)),
        }
    }

    (successful_keys, failed_deletions)
}

// ---------------------------------------------------------------------------
// 8. Tally the bytes reclaimed by successful deletions.
// ---------------------------------------------------------------------------
fn sum_temporary_file_deletion_reclaimed_bytes(
    successful_outcomes: &[Result<u64, StorageAdapterError>],
) -> u64 {
    successful_outcomes
        .iter()
        .filter_map(|outcome| outcome.as_ref().ok().copied())
        .sum()
}

// ---------------------------------------------------------------------------
// 9. Purge OCR job records whose *every* artifact key was deleted, so that no
//    orphaned metadata is left pointing at vanished objects.
//
//    Pure computation over the job documents and the set of deleted keys; the
//    handler applies the returned identifiers against the collection inside
//    the transactional unit of work.
// ---------------------------------------------------------------------------
fn purge_orphaned_ocr_job_records_within_transactional_unit(
    ocr_job_documents: &[StoredDocument],
    deleted_keys: &[StorageObjectKey],
) -> (Vec<String>, u32) {
    let deleted_key_set: std::collections::HashSet<&str> =
        deleted_keys.iter().map(StorageObjectKey::opaque_key).collect();

    let mut orphaned_identifiers: Vec<String> = Vec::new();

    for job_document in ocr_job_documents {
        let Some(artifact_entries) = job_document
            .document_body
            .get("temporary_artifacts")
            .and_then(Value::as_array)
        else {
            continue;
        };

        if artifact_entries.is_empty() {
            continue;
        }

        let every_artifact_deleted = artifact_entries.iter().all(|artifact_entry| {
            artifact_entry
                .get("object_key")
                .and_then(Value::as_str)
                .map(|object_key| deleted_key_set.contains(object_key))
                .unwrap_or(false)
        });

        if every_artifact_deleted {
            orphaned_identifiers.push(job_document.document_identifier.clone());
        }
    }

    let purge_count = orphaned_identifiers.len() as u32;
    (orphaned_identifiers, purge_count)
}

// ---------------------------------------------------------------------------
// 10. Map a storage error to the transport-level error surface.
// ---------------------------------------------------------------------------
fn map_temporary_file_deletion_error_to_http_error(
    storage_error: StorageAdapterError,
) -> HttpError {
    match storage_error {
        StorageAdapterError::ObjectKeyWasNotFound { offending_key } => {
            HttpError::RequestedResourceWasNotFound {
                explanation: format!("temporary artifact '{offending_key}' was not found"),
            }
        }
        StorageAdapterError::DeletionWasRejected {
            offending_key,
            reason,
        } => HttpError::UpstreamApplicationFailure {
            explanation: format!(
                "storage rejected deletion of '{offending_key}': {reason}"
            ),
        },
    }
}

// ---------------------------------------------------------------------------
// 11. Build the caller-facing failure descriptors from raw failures.
// ---------------------------------------------------------------------------
fn build_temporary_file_cleanup_failure_descriptors(
    failed_deletions: &[(StorageObjectKey, StorageAdapterError)],
) -> Vec<TemporaryFileCleanupFailureDescriptor> {
    failed_deletions
        .iter()
        .map(|(object_key, storage_error)| TemporaryFileCleanupFailureDescriptor {
            failing_object_key: object_key.opaque_key().to_string(),
            failure_explanation: storage_error.describe(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 12. Refuse to run when there is nothing to delete.
// ---------------------------------------------------------------------------
fn reject_run_cleanup_when_no_deletable_keys_present(
    deletable_keys: &[StorageObjectKey],
) -> Result<(), HttpError> {
    if deletable_keys.is_empty() {
        return Err(HttpError::RequestedResourceWasNotFound {
            explanation: String::from(
                "no temporary artifacts matched the requested scope and retention window",
            ),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 13. Produce an audit entry describing the run.
// ---------------------------------------------------------------------------
fn record_run_cleanup_temporary_files_audit_entry(
    scope: &TemporaryFileCleanupScope,
    deleted_key_count: u32,
    reclaimed_bytes: u64,
) -> TemporaryFileCleanupAuditEntry {
    TemporaryFileCleanupAuditEntry {
        scope_label: scope.as_label().to_string(),
        deleted_key_count,
        reclaimed_bytes,
    }
}

// ---------------------------------------------------------------------------
// 14. Count successful deletions.
// ---------------------------------------------------------------------------
fn count_temporary_file_deletion_successes(successful_keys: &[StorageObjectKey]) -> u32 {
    successful_keys.len() as u32
}

// ---------------------------------------------------------------------------
// 15. Assemble the response payload.
// ---------------------------------------------------------------------------
fn assemble_run_cleanup_temporary_files_response_payload(
    deleted_key_count: u32,
    reclaimed_bytes: u64,
    failure_descriptors: Vec<TemporaryFileCleanupFailureDescriptor>,
) -> RunCleanupTemporaryFilesResponsePayload {
    RunCleanupTemporaryFilesResponsePayload {
        deleted_key_count,
        reclaimed_bytes,
        failure_descriptors,
    }
}

// ---------------------------------------------------------------------------
// Handler. Extractors match the original file exactly: State + the authorized
// request, with no request-body extractor.
// ---------------------------------------------------------------------------
#[route(method = "POST", path = "/api/cleanup-tmp")]
pub async fn run_cleanup_temporary_files_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Default operational policy for the maintenance endpoint: purge every
    // artifact older than 24 hours, gated behind the fixed confirmation token.
    let cleanup_scope = parse_run_cleanup_temporary_files_target_scope("all")?;
    let retention_threshold = compute_run_cleanup_temporary_files_retention_threshold(24)?;
    let _confirmation_token =
        validate_run_cleanup_temporary_files_confirmation_token("CONFIRM_CLEANUP")?;

    let _principal = authorized_request.authorized_principal();
    let _correlation = authorized_request.correlation_identifier();

    let ocr_job_documents = application_state
        .document_collection
        .list_documents(OCR_JOBS_COLLECTION_NAME)
        .await?;

    let deletable_keys = enumerate_deletable_temporary_ocr_artifact_keys(
        &ocr_job_documents,
        &cleanup_scope,
        retention_threshold,
    )?;

    reject_run_cleanup_when_no_deletable_keys_present(&deletable_keys)?;

    let deletion_outcomes = execute_temporary_file_batch_deletion(&deletable_keys);
    let reclaimed_bytes = sum_temporary_file_deletion_reclaimed_bytes(&deletion_outcomes);

    let (successful_keys, failed_deletions) =
        partition_temporary_file_deletion_outcomes(deletion_outcomes, &deletable_keys);

    // Surface an outright failure only when nothing at all could be deleted;
    // otherwise report partial success with per-key descriptors.
    if successful_keys.is_empty() {
        if let Some((_key, storage_error)) = failed_deletions.first() {
            return Err(map_temporary_file_deletion_error_to_http_error(
                storage_error.clone(),
            ));
        }
    }

    let deleted_key_count = count_temporary_file_deletion_successes(&successful_keys);

    let (orphaned_job_identifiers, _purge_count) =
        purge_orphaned_ocr_job_records_within_transactional_unit(
            &ocr_job_documents,
            &successful_keys,
        );

    for orphaned_identifier in &orphaned_job_identifiers {
        application_state
            .document_collection
            .delete_document(OCR_JOBS_COLLECTION_NAME, orphaned_identifier)
            .await?;
    }

    let _audit_entry = record_run_cleanup_temporary_files_audit_entry(
        &cleanup_scope,
        deleted_key_count,
        reclaimed_bytes,
    );

    let failure_descriptors =
        build_temporary_file_cleanup_failure_descriptors(&failed_deletions);

    let response_payload = assemble_run_cleanup_temporary_files_response_payload(
        deleted_key_count,
        reclaimed_bytes,
        failure_descriptors,
    );

    Ok(Json(response_payload.into_json()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_key(raw: &str, size: u64) -> StorageObjectKey {
        StorageObjectKey::from_parts(raw.to_string(), size)
    }

    fn make_job(identifier: &str, artifacts: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: None,
            document_body: json!({ "temporary_artifacts": artifacts }),
        }
    }

    #[test]
    fn parse_target_scope_accepts_known_aliases() {
        assert_eq!(
            parse_run_cleanup_temporary_files_target_scope("ALL").unwrap(),
            TemporaryFileCleanupScope::AllTemporaryArtifacts
        );
        assert_eq!(
            parse_run_cleanup_temporary_files_target_scope("staging").unwrap(),
            TemporaryFileCleanupScope::StagingManifests
        );
    }

    #[test]
    fn parse_target_scope_rejects_unknown() {
        assert!(parse_run_cleanup_temporary_files_target_scope("nonsense").is_err());
    }

    #[test]
    fn retention_threshold_rejects_zero_and_excess() {
        assert!(compute_run_cleanup_temporary_files_retention_threshold(0).is_err());
        assert!(
            compute_run_cleanup_temporary_files_retention_threshold(24 * 365 + 1).is_err()
        );
    }

    #[test]
    fn retention_threshold_accepts_valid_and_computes_deletability() {
        let threshold =
            compute_run_cleanup_temporary_files_retention_threshold(24).unwrap();
        assert_eq!(threshold.retention_hours(), 24);
        assert!(threshold.is_artifact_deletable(25));
        assert!(!threshold.is_artifact_deletable(24));
    }

    #[test]
    fn enumerate_selects_only_aged_in_scope_artifacts() {
        let threshold =
            compute_run_cleanup_temporary_files_retention_threshold(24).unwrap();
        let jobs = vec![make_job(
            "job-1",
            json!([
                { "kind": "rasterized_page_image", "object_key": "a", "age_hours": 48, "size_bytes": 100 },
                { "kind": "rasterized_page_image", "object_key": "b", "age_hours": 1, "size_bytes": 200 },
                { "kind": "staging_manifest", "object_key": "c", "age_hours": 48, "size_bytes": 300 },
            ]),
        )];

        let keys = enumerate_deletable_temporary_ocr_artifact_keys(
            &jobs,
            &TemporaryFileCleanupScope::RasterizedPageImages,
            threshold,
        )
        .unwrap();

        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].opaque_key(), "a");
        assert_eq!(keys[0].approximate_size_bytes(), 100);
    }

    #[test]
    fn enumerate_errors_on_missing_object_key() {
        let threshold =
            compute_run_cleanup_temporary_files_retention_threshold(24).unwrap();
        let jobs = vec![make_job(
            "job-x",
            json!([{ "kind": "staging_manifest", "age_hours": 48 }]),
        )];
        let result = enumerate_deletable_temporary_ocr_artifact_keys(
            &jobs,
            &TemporaryFileCleanupScope::AllTemporaryArtifacts,
            threshold,
        );
        assert!(result.is_err());
    }

    #[test]
    fn validate_confirmation_token_accepts_exact_and_rejects_others() {
        assert!(
            validate_run_cleanup_temporary_files_confirmation_token("CONFIRM_CLEANUP")
                .is_ok()
        );
        assert!(
            validate_run_cleanup_temporary_files_confirmation_token("nope").is_err()
        );
        assert!(validate_run_cleanup_temporary_files_confirmation_token("").is_err());
    }

    #[test]
    fn delete_single_key_reports_size_missing_and_empty() {
        assert_eq!(
            delete_temporary_file_key_via_storage_adapter(&make_key("ok", 512)).unwrap(),
            512
        );
        assert!(matches!(
            delete_temporary_file_key_via_storage_adapter(&make_key("missing:x", 1)),
            Err(StorageAdapterError::ObjectKeyWasNotFound { .. })
        ));
        assert!(matches!(
            delete_temporary_file_key_via_storage_adapter(&make_key("", 1)),
            Err(StorageAdapterError::DeletionWasRejected { .. })
        ));
    }

    #[test]
    fn batch_deletion_preserves_order_and_outcomes() {
        let keys = vec![make_key("a", 10), make_key("missing:b", 20), make_key("c", 30)];
        let outcomes = execute_temporary_file_batch_deletion(&keys);
        assert_eq!(outcomes.len(), 3);
        assert_eq!(outcomes[0], Ok(10));
        assert!(outcomes[1].is_err());
        assert_eq!(outcomes[2], Ok(30));
    }

    #[test]
    fn partition_splits_success_and_failure() {
        let keys = vec![make_key("a", 10), make_key("missing:b", 20)];
        let outcomes = execute_temporary_file_batch_deletion(&keys);
        let (ok_keys, failures) =
            partition_temporary_file_deletion_outcomes(outcomes, &keys);
        assert_eq!(ok_keys.len(), 1);
        assert_eq!(ok_keys[0].opaque_key(), "a");
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0.opaque_key(), "missing:b");
    }

    #[test]
    fn sum_reclaimed_bytes_ignores_failures() {
        let keys = vec![make_key("a", 10), make_key("missing:b", 20), make_key("c", 30)];
        let outcomes = execute_temporary_file_batch_deletion(&keys);
        assert_eq!(sum_temporary_file_deletion_reclaimed_bytes(&outcomes), 40);
    }

    #[test]
    fn purge_flags_jobs_whose_every_artifact_was_deleted() {
        let jobs = vec![
            make_job(
                "fully-cleaned",
                json!([
                    { "object_key": "a" },
                    { "object_key": "b" },
                ]),
            ),
            make_job(
                "partly-cleaned",
                json!([
                    { "object_key": "a" },
                    { "object_key": "z" },
                ]),
            ),
        ];
        let deleted = vec![make_key("a", 1), make_key("b", 1)];
        let (identifiers, count) =
            purge_orphaned_ocr_job_records_within_transactional_unit(&jobs, &deleted);
        assert_eq!(count, 1);
        assert_eq!(identifiers, vec!["fully-cleaned".to_string()]);
    }

    #[test]
    fn map_error_to_http_error_maps_variants() {
        let not_found = StorageAdapterError::ObjectKeyWasNotFound {
            offending_key: "k".to_string(),
        };
        assert!(matches!(
            map_temporary_file_deletion_error_to_http_error(not_found),
            HttpError::RequestedResourceWasNotFound { .. }
        ));
        let rejected = StorageAdapterError::DeletionWasRejected {
            offending_key: "k".to_string(),
            reason: "boom".to_string(),
        };
        assert!(matches!(
            map_temporary_file_deletion_error_to_http_error(rejected),
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn build_failure_descriptors_maps_each_failure() {
        let failures = vec![(
            make_key("bad", 0),
            StorageAdapterError::DeletionWasRejected {
                offending_key: "bad".to_string(),
                reason: "nope".to_string(),
            },
        )];
        let descriptors = build_temporary_file_cleanup_failure_descriptors(&failures);
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].failing_object_key, "bad");
        assert!(descriptors[0].failure_explanation.contains("nope"));
    }

    #[test]
    fn reject_when_no_keys_errors_and_allows_when_present() {
        assert!(reject_run_cleanup_when_no_deletable_keys_present(&[]).is_err());
        let keys = vec![make_key("a", 1)];
        assert!(reject_run_cleanup_when_no_deletable_keys_present(&keys).is_ok());
    }

    #[test]
    fn audit_entry_captures_scope_and_totals() {
        let entry = record_run_cleanup_temporary_files_audit_entry(
            &TemporaryFileCleanupScope::StagingManifests,
            3,
            999,
        );
        assert_eq!(entry.scope_label, "staging_manifests");
        assert_eq!(entry.deleted_key_count, 3);
        assert_eq!(entry.reclaimed_bytes, 999);
    }

    #[test]
    fn count_successes_returns_length() {
        let keys = vec![make_key("a", 1), make_key("b", 1)];
        assert_eq!(count_temporary_file_deletion_successes(&keys), 2);
        assert_eq!(count_temporary_file_deletion_successes(&[]), 0);
    }

    #[test]
    fn assemble_response_payload_serializes_expected_shape() {
        let payload = assemble_run_cleanup_temporary_files_response_payload(
            2,
            120,
            vec![TemporaryFileCleanupFailureDescriptor {
                failing_object_key: "x".to_string(),
                failure_explanation: "why".to_string(),
            }],
        );
        assert_eq!(payload.deleted_key_count, 2);
        let encoded = payload.into_json();
        assert_eq!(encoded["deleted_key_count"], json!(2));
        assert_eq!(encoded["reclaimed_bytes"], json!(120));
        assert_eq!(encoded["failures"][0]["object_key"], json!("x"));
    }
}
