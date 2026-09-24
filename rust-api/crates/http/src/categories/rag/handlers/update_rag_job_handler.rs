use crate::categories::rag::collections::{RAG_CORPORA_COLLECTION_NAME, RAG_JOBS_COLLECTION_NAME};
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};
use std::sync::Arc;

/// The lifecycle a RAG ingestion job can be in. A job is created in the
/// `Queued` state, moves through `Running`, and settles into one of the two
/// terminal states `Completed` or `Failed`. `Cancelled` is a terminal state
/// reached by explicit caller request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RagJobLifecycleStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}

impl RagJobLifecycleStatus {
    /// Canonical lowercase wire label used inside the stored job document.
    fn canonical_label(self) -> &'static str {
        match self {
            RagJobLifecycleStatus::Queued => "queued",
            RagJobLifecycleStatus::Running => "running",
            RagJobLifecycleStatus::Completed => "completed",
            RagJobLifecycleStatus::Failed => "failed",
            RagJobLifecycleStatus::Cancelled => "cancelled",
            RagJobLifecycleStatus::Unknown => "unknown",
        }
    }

    /// Parse a wire label (case-insensitive) into a lifecycle status. Any
    /// unrecognised label maps to `Unknown` so callers can decide how strict to
    /// be rather than the parser panicking.
    fn from_wire_label(candidate_label: &str) -> RagJobLifecycleStatus {
        match candidate_label.trim().to_ascii_lowercase().as_str() {
            "queued" => RagJobLifecycleStatus::Queued,
            "running" => RagJobLifecycleStatus::Running,
            "completed" => RagJobLifecycleStatus::Completed,
            "failed" => RagJobLifecycleStatus::Failed,
            "cancelled" | "canceled" => RagJobLifecycleStatus::Cancelled,
            _ => RagJobLifecycleStatus::Unknown,
        }
    }

    /// A terminal status is one from which no further transition is legal.
    fn is_terminal(self) -> bool {
        matches!(
            self,
            RagJobLifecycleStatus::Completed
                | RagJobLifecycleStatus::Failed
                | RagJobLifecycleStatus::Cancelled
        )
    }
}

/// The parsed shape of a caller-supplied PATCH body. Every field is optional:
/// the caller may update any subset of the mutable job attributes in one call.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RagJobUpdatePatch {
    pub requested_status_label: Option<String>,
    pub processed_file_count: Option<usize>,
    pub failure_reason: Option<String>,
    pub failure_reason_was_cleared: bool,
}

impl RagJobUpdatePatch {
    /// True when the patch carries no meaningful change at all. Used to reject
    /// empty PATCH requests as malformed rather than performing a no-op write.
    fn is_empty(&self) -> bool {
        self.requested_status_label.is_none()
            && self.processed_file_count.is_none()
            && self.failure_reason.is_none()
            && !self.failure_reason_was_cleared
    }
}

#[route(method = "PATCH", path = "/api/rag/jobs/:job_identifier")]
pub async fn update_rag_job_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(job_identifier): Path<String>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let requesting_account = authorized_request.authorized_principal().clone();
    let validated_job_identifier = extract_job_identifier_from_path(job_identifier)?;
    let update_patch = extract_job_update_patch_from_body(submitted_body)?;

    let document_collection = &application_state.document_collection;

    let mut job_document =
        fetch_job_document_or_not_found(document_collection, &validated_job_identifier).await?;

    assert_job_document_is_owned_by_requester(&job_document, &requesting_account)?;

    let current_status = read_job_lifecycle_status(&job_document);

    if let Some(requested_status) = parse_requested_lifecycle_status_transition(&update_patch) {
        assert_lifecycle_status_transition_is_legal(current_status, requested_status)?;
        apply_lifecycle_status_transition_to_job_body(&mut job_document, requested_status);
    }

    if let Some(new_processed_count) = update_patch.processed_file_count {
        apply_processed_file_count_change_to_job_body(&mut job_document, new_processed_count);
    }

    if update_patch.failure_reason.is_some() || update_patch.failure_reason_was_cleared {
        apply_failure_reason_change_to_job_body(&mut job_document, &update_patch.failure_reason);
    }

    stamp_job_last_updated_timestamp(&mut job_document, current_wall_clock_timestamp());

    persist_updated_job_document(document_collection, job_document.clone()).await?;

    propagate_terminal_status_to_parent_corpus(document_collection, &job_document).await?;

    Ok(Json(assemble_update_job_response(&job_document)))
}

/// (1) Validate the path parameter into a `NonEmptyText`. An empty or
/// whitespace-only identifier can never match a stored job, so it is rejected
/// as a malformed request rather than surfacing later as a not-found.
fn extract_job_identifier_from_path(
    supplied_path_parameter: String,
) -> Result<NonEmptyText, HttpError> {
    NonEmptyText::parse(supplied_path_parameter).map_err(|parse_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the job identifier was invalid: {parse_error}"),
        }
    })
}

/// (2) Interpret the raw JSON body as a structured update patch. The body must
/// be a JSON object; recognised keys are read defensively and unrecognised keys
/// are ignored. An entirely empty patch is rejected.
fn extract_job_update_patch_from_body(
    submitted_body: Value,
) -> Result<RagJobUpdatePatch, HttpError> {
    let body_object = submitted_body.as_object().ok_or_else(|| {
        HttpError::RequestBodyWasMalformed {
            explanation: String::from("the request body must be a JSON object"),
        }
    })?;

    let requested_status_label = match body_object.get("status") {
        None | Some(Value::Null) => None,
        Some(Value::String(status_text)) => {
            let trimmed = status_text.trim();
            if trimmed.is_empty() {
                return Err(HttpError::RequestBodyWasMalformed {
                    explanation: String::from("the status field must not be empty"),
                });
            }
            Some(trimmed.to_string())
        }
        Some(_) => {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: String::from("the status field must be a string"),
            });
        }
    };

    let processed_file_count = match body_object.get("processed_file_count") {
        None | Some(Value::Null) => None,
        Some(count_value) => Some(read_non_negative_count_field(
            count_value,
            "processed_file_count",
        )?),
    };

    // Distinguish "reason omitted" (leave untouched) from "reason set to null"
    // (explicitly clear) from "reason set to string" (update).
    let (failure_reason, failure_reason_was_cleared) = match body_object.get("failure_reason") {
        None => (None, false),
        Some(Value::Null) => (None, true),
        Some(Value::String(reason_text)) => {
            let trimmed = reason_text.trim();
            if trimmed.is_empty() {
                (None, true)
            } else {
                (Some(trimmed.to_string()), false)
            }
        }
        Some(_) => {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: String::from("the failure_reason field must be a string or null"),
            });
        }
    };

    let assembled_patch = RagJobUpdatePatch {
        requested_status_label,
        processed_file_count,
        failure_reason,
        failure_reason_was_cleared,
    };

    if assembled_patch.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the request body did not contain any updatable fields"),
        });
    }

    Ok(assembled_patch)
}

/// Helper for (2): read a JSON number as a non-negative `usize`, rejecting
/// floats, negatives and non-numbers.
fn read_non_negative_count_field(
    count_value: &Value,
    field_name: &str,
) -> Result<usize, HttpError> {
    let raw_unsigned = count_value.as_u64().ok_or_else(|| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!("the {field_name} field must be a non-negative integer"),
        }
    })?;
    Ok(raw_unsigned as usize)
}

/// (3) Extract the requested lifecycle transition from the patch, if the caller
/// asked for one. An unrecognised status label yields `Unknown` which the
/// legality check will later reject with a clear error.
fn parse_requested_lifecycle_status_transition(
    patch: &RagJobUpdatePatch,
) -> Option<RagJobLifecycleStatus> {
    patch
        .requested_status_label
        .as_deref()
        .map(RagJobLifecycleStatus::from_wire_label)
}

/// (4) Fetch the job document, mapping absence to a not-found HTTP error and
/// any port failure to the appropriate HTTP error.
async fn fetch_job_document_or_not_found(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_identifier: &NonEmptyText,
) -> Result<StoredDocument, HttpError> {
    let optionally_located_document = document_collection
        .fetch_document(RAG_JOBS_COLLECTION_NAME, job_identifier.as_str())
        .await
        .map_err(map_application_error_to_job_update_http_error)?;

    optionally_located_document.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: String::from("no rag job exists under the supplied identifier"),
    })
}

/// (5) Enforce that the requester owns the job.
///
/// RUST-IDOR-003: documents with no owner are NOT world-writable — an ownerless
/// job is default-denied, matching the sibling `delete_rag_corpus_handler`.
fn assert_job_document_is_owned_by_requester(
    job_document: &StoredDocument,
    requesting_account: &Email,
) -> Result<(), HttpError> {
    match job_document.owning_account.as_deref() {
        Some(owner) if owner.eq_ignore_ascii_case(requesting_account.as_str()) => Ok(()),
        Some(_) => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from(
                "the authenticated principal does not own this rag job",
            ),
        }),
        None => Err(HttpError::AuthorizationWasDenied {
            explanation: String::from("the requested rag job has no recorded owner"),
        }),
    }
}

/// (6) Read the current lifecycle status from the stored job body. A missing or
/// malformed status field is reported as `Unknown`.
fn read_job_lifecycle_status(job_document: &StoredDocument) -> RagJobLifecycleStatus {
    job_document
        .document_body
        .get("status")
        .and_then(Value::as_str)
        .map(RagJobLifecycleStatus::from_wire_label)
        .unwrap_or(RagJobLifecycleStatus::Unknown)
}

/// (7) Enforce the legal transition graph. A job may only advance forward; it
/// may not leave a terminal state, and it may not transition into `Unknown`.
fn assert_lifecycle_status_transition_is_legal(
    current_status: RagJobLifecycleStatus,
    requested_status: RagJobLifecycleStatus,
) -> Result<(), HttpError> {
    if requested_status == RagJobLifecycleStatus::Unknown {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the requested status is not a recognised job status"),
        });
    }

    // A no-op transition (same status) is always permitted and idempotent.
    if current_status == requested_status {
        return Ok(());
    }

    if current_status.is_terminal() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "the job is already in terminal status '{}' and cannot transition to '{}'",
                current_status.canonical_label(),
                requested_status.canonical_label()
            ),
        });
    }

    let transition_is_allowed = match (current_status, requested_status) {
        // From an unknown/uninitialised state any concrete status is allowed so
        // that malformed legacy documents can be repaired.
        (RagJobLifecycleStatus::Unknown, _) => true,
        (RagJobLifecycleStatus::Queued, RagJobLifecycleStatus::Running)
        | (RagJobLifecycleStatus::Queued, RagJobLifecycleStatus::Cancelled)
        | (RagJobLifecycleStatus::Queued, RagJobLifecycleStatus::Failed) => true,
        (RagJobLifecycleStatus::Running, RagJobLifecycleStatus::Completed)
        | (RagJobLifecycleStatus::Running, RagJobLifecycleStatus::Failed)
        | (RagJobLifecycleStatus::Running, RagJobLifecycleStatus::Cancelled) => true,
        _ => false,
    };

    if transition_is_allowed {
        Ok(())
    } else {
        Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "transition from '{}' to '{}' is not permitted",
                current_status.canonical_label(),
                requested_status.canonical_label()
            ),
        })
    }
}

/// (8) Write the new lifecycle status into the job body.
fn apply_lifecycle_status_transition_to_job_body(
    job_document: &mut StoredDocument,
    new_status: RagJobLifecycleStatus,
) {
    set_job_body_field(
        job_document,
        "status",
        Value::String(new_status.canonical_label().to_string()),
    );
}

/// (9) Write the processed-file counter into the job body.
fn apply_processed_file_count_change_to_job_body(
    job_document: &mut StoredDocument,
    new_processed_count: usize,
) {
    set_job_body_field(
        job_document,
        "processed_file_count",
        json!(new_processed_count as u64),
    );
}

/// (10) Set or clear the failure reason on the job body. A `None` reason clears
/// the field entirely so a recovering job does not retain a stale reason.
fn apply_failure_reason_change_to_job_body(
    job_document: &mut StoredDocument,
    new_failure_reason: &Option<String>,
) {
    match new_failure_reason {
        Some(reason_text) => set_job_body_field(
            job_document,
            "failure_reason",
            Value::String(reason_text.clone()),
        ),
        None => remove_job_body_field(job_document, "failure_reason"),
    }
}

/// (11) Stamp the "last updated" timestamp onto the job body. The timestamp is
/// supplied by the caller (the handler reads the wall clock) so this function
/// remains pure and testable.
fn stamp_job_last_updated_timestamp(job_document: &mut StoredDocument, updated_instant: String) {
    set_job_body_field(
        job_document,
        "last_updated_at",
        Value::String(updated_instant),
    );
}

/// (12) Persist the mutated job document back into the collection, mapping port
/// failures to HTTP errors. A `false` result means the document vanished
/// between fetch and write, which we surface as not-found.
async fn persist_updated_job_document(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_document: StoredDocument,
) -> Result<(), HttpError> {
    let replacement_succeeded = document_collection
        .replace_document(RAG_JOBS_COLLECTION_NAME, job_document)
        .await
        .map_err(map_application_error_to_job_update_http_error)?;

    if replacement_succeeded {
        Ok(())
    } else {
        Err(HttpError::RequestedResourceWasNotFound {
            explanation: String::from(
                "the rag job could not be updated because it no longer exists",
            ),
        })
    }
}

/// (13) When a job reaches a terminal status, reflect that on its parent corpus
/// document so corpus-level consumers can observe job completion without
/// scanning every job. Silently returns when the job has no parent corpus or
/// the corpus cannot be located.
async fn propagate_terminal_status_to_parent_corpus(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_document: &StoredDocument,
) -> Result<(), HttpError> {
    let job_status = read_job_lifecycle_status(job_document);
    if !job_status.is_terminal() {
        return Ok(());
    }

    let parent_corpus_identifier = match read_parent_corpus_identifier(job_document) {
        Some(identifier) => identifier,
        None => return Ok(()),
    };

    let optionally_located_corpus = document_collection
        .fetch_document(RAG_CORPORA_COLLECTION_NAME, &parent_corpus_identifier)
        .await
        .map_err(map_application_error_to_job_update_http_error)?;

    let mut corpus_document = match optionally_located_corpus {
        Some(document) => document,
        None => return Ok(()),
    };

    set_document_body_field(
        &mut corpus_document,
        "latest_terminal_job_status",
        Value::String(job_status.canonical_label().to_string()),
    );
    set_document_body_field(
        &mut corpus_document,
        "latest_terminal_job_identifier",
        Value::String(job_document.document_identifier.clone()),
    );

    // Best-effort: if the corpus disappeared concurrently we do not fail the
    // job update, since the job itself was persisted successfully.
    document_collection
        .replace_document(RAG_CORPORA_COLLECTION_NAME, corpus_document)
        .await
        .map_err(map_application_error_to_job_update_http_error)?;

    Ok(())
}

/// (14) Map an `ApplicationError` from a port call onto the closest HTTP error.
fn map_application_error_to_job_update_http_error(
    application_error: ApplicationError,
) -> HttpError {
    match application_error {
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: String::from("access to the rag job was denied"),
        },
        ApplicationError::RequestedResourceCouldNotBeLocated
        | ApplicationError::RequestedProjectCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: String::from("the requested rag job could not be located"),
            }
        }
        ApplicationError::DomainInvariantViolated(domain_error) => {
            HttpError::RequestBodyWasMalformed {
                explanation: domain_error.to_string(),
            }
        }
        other_failure => HttpError::UpstreamApplicationFailure {
            explanation: other_failure.to_string(),
        },
    }
}

/// (15) Build the JSON response body returned to the caller after a successful
/// update. Echoes the identifier, owner and the full updated body.
fn assemble_update_job_response(updated_job_document: &StoredDocument) -> Value {
    json!({
        "job_identifier": updated_job_document.document_identifier,
        "owning_account": updated_job_document.owning_account,
        "status": read_job_lifecycle_status(updated_job_document).canonical_label(),
        "job": updated_job_document.document_body,
    })
}

// --- small internal helpers (not part of the 15; pure and reused) ----------

/// Read the parent corpus identifier from a job body, if present.
fn read_parent_corpus_identifier(job_document: &StoredDocument) -> Option<String> {
    job_document
        .document_body
        .get("corpus_identifier")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Set a top-level field on the job body, initialising the body to an object if
/// it was previously a non-object value.
fn set_job_body_field(job_document: &mut StoredDocument, field_name: &str, field_value: Value) {
    set_document_body_field(job_document, field_name, field_value);
}

/// Remove a top-level field from the job body if the body is an object.
fn remove_job_body_field(job_document: &mut StoredDocument, field_name: &str) {
    if let Some(body_object) = job_document.document_body.as_object_mut() {
        body_object.remove(field_name);
    }
}

/// Set a top-level field on any stored document body, promoting the body to an
/// object first when necessary.
fn set_document_body_field(document: &mut StoredDocument, field_name: &str, field_value: Value) {
    if !document.document_body.is_object() {
        document.document_body = Value::Object(serde_json::Map::new());
    }
    if let Some(body_object) = document.document_body.as_object_mut() {
        body_object.insert(field_name.to_string(), field_value);
    }
}

/// Produce a coarse wall-clock timestamp as seconds since the Unix epoch,
/// formatted as a string. The `time` crate is not a dependency of this crate,
/// so we rely on `std::time` and record an epoch-seconds string.
fn current_wall_clock_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => format!("{}", elapsed.as_secs()),
        Err(_) => String::from("0"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_job_document(status: &str, owner: Option<&str>) -> StoredDocument {
        StoredDocument {
            document_identifier: "job-123".to_string(),
            owning_account: owner.map(str::to_string),
            document_body: json!({
                "status": status,
                "processed_file_count": 1,
                "corpus_identifier": "corpus-9",
            }),
        }
    }

    #[test]
    fn extract_job_identifier_accepts_non_empty() {
        let parsed = extract_job_identifier_from_path("job-123".to_string()).unwrap();
        assert_eq!(parsed.as_str(), "job-123");
    }

    #[test]
    fn extract_job_identifier_rejects_blank() {
        let outcome = extract_job_identifier_from_path("   ".to_string());
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_patch_reads_all_fields() {
        let body = json!({
            "status": "running",
            "processed_file_count": 4,
            "failure_reason": "disk full",
        });
        let patch = extract_job_update_patch_from_body(body).unwrap();
        assert_eq!(patch.requested_status_label.as_deref(), Some("running"));
        assert_eq!(patch.processed_file_count, Some(4));
        assert_eq!(patch.failure_reason.as_deref(), Some("disk full"));
        assert!(!patch.failure_reason_was_cleared);
    }

    #[test]
    fn extract_patch_treats_null_reason_as_cleared() {
        let body = json!({ "failure_reason": Value::Null, "status": "running" });
        let patch = extract_job_update_patch_from_body(body).unwrap();
        assert!(patch.failure_reason_was_cleared);
        assert!(patch.failure_reason.is_none());
    }

    #[test]
    fn extract_patch_rejects_non_object() {
        let outcome = extract_job_update_patch_from_body(json!("not an object"));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_patch_rejects_empty_object() {
        let outcome = extract_job_update_patch_from_body(json!({}));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_patch_rejects_negative_count() {
        let outcome = extract_job_update_patch_from_body(json!({ "processed_file_count": -3 }));
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn parse_transition_returns_none_when_absent() {
        let patch = RagJobUpdatePatch::default();
        assert!(parse_requested_lifecycle_status_transition(&patch).is_none());
    }

    #[test]
    fn parse_transition_returns_status_when_present() {
        let patch = RagJobUpdatePatch {
            requested_status_label: Some("completed".to_string()),
            ..RagJobUpdatePatch::default()
        };
        assert_eq!(
            parse_requested_lifecycle_status_transition(&patch),
            Some(RagJobLifecycleStatus::Completed)
        );
    }

    #[test]
    fn owner_check_allows_matching_owner() {
        let document = sample_job_document("running", Some("owner@example.com"));
        let requester = Email::parse("Owner@Example.com".to_string()).unwrap();
        assert!(assert_job_document_is_owned_by_requester(&document, &requester).is_ok());
    }

    #[test]
    fn owner_check_denies_unowned_document() {
        // RUST-IDOR-003: ownerless jobs are default-denied, not world-writable.
        let document = sample_job_document("running", None);
        let requester = Email::parse("someone@example.com".to_string()).unwrap();
        assert!(matches!(
            assert_job_document_is_owned_by_requester(&document, &requester),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn owner_check_denies_foreign_owner() {
        let document = sample_job_document("running", Some("owner@example.com"));
        let requester = Email::parse("intruder@example.com".to_string()).unwrap();
        assert!(matches!(
            assert_job_document_is_owned_by_requester(&document, &requester),
            Err(HttpError::AuthorizationWasDenied { .. })
        ));
    }

    #[test]
    fn read_status_parses_known_and_defaults_unknown() {
        let known = sample_job_document("completed", None);
        assert_eq!(
            read_job_lifecycle_status(&known),
            RagJobLifecycleStatus::Completed
        );
        let missing = StoredDocument {
            document_identifier: "x".to_string(),
            owning_account: None,
            document_body: json!({}),
        };
        assert_eq!(
            read_job_lifecycle_status(&missing),
            RagJobLifecycleStatus::Unknown
        );
    }

    #[test]
    fn transition_allows_valid_forward_move() {
        assert!(assert_lifecycle_status_transition_is_legal(
            RagJobLifecycleStatus::Running,
            RagJobLifecycleStatus::Completed
        )
        .is_ok());
    }

    #[test]
    fn transition_allows_idempotent_same_status() {
        assert!(assert_lifecycle_status_transition_is_legal(
            RagJobLifecycleStatus::Running,
            RagJobLifecycleStatus::Running
        )
        .is_ok());
    }

    #[test]
    fn transition_rejects_leaving_terminal() {
        assert!(matches!(
            assert_lifecycle_status_transition_is_legal(
                RagJobLifecycleStatus::Completed,
                RagJobLifecycleStatus::Running
            ),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn transition_rejects_unknown_target() {
        assert!(matches!(
            assert_lifecycle_status_transition_is_legal(
                RagJobLifecycleStatus::Running,
                RagJobLifecycleStatus::Unknown
            ),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn transition_rejects_illegal_forward_move() {
        assert!(matches!(
            assert_lifecycle_status_transition_is_legal(
                RagJobLifecycleStatus::Queued,
                RagJobLifecycleStatus::Completed
            ),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn apply_status_writes_label() {
        let mut document = sample_job_document("queued", None);
        apply_lifecycle_status_transition_to_job_body(&mut document, RagJobLifecycleStatus::Running);
        assert_eq!(
            document.document_body.get("status").and_then(Value::as_str),
            Some("running")
        );
    }

    #[test]
    fn apply_processed_count_writes_number() {
        let mut document = sample_job_document("running", None);
        apply_processed_file_count_change_to_job_body(&mut document, 7);
        assert_eq!(
            document
                .document_body
                .get("processed_file_count")
                .and_then(Value::as_u64),
            Some(7)
        );
    }

    #[test]
    fn apply_failure_reason_sets_and_clears() {
        let mut document = sample_job_document("failed", None);
        apply_failure_reason_change_to_job_body(&mut document, &Some("boom".to_string()));
        assert_eq!(
            document
                .document_body
                .get("failure_reason")
                .and_then(Value::as_str),
            Some("boom")
        );
        apply_failure_reason_change_to_job_body(&mut document, &None);
        assert!(document.document_body.get("failure_reason").is_none());
    }

    #[test]
    fn stamp_timestamp_writes_field() {
        let mut document = sample_job_document("running", None);
        stamp_job_last_updated_timestamp(&mut document, "1700000000".to_string());
        assert_eq!(
            document
                .document_body
                .get("last_updated_at")
                .and_then(Value::as_str),
            Some("1700000000")
        );
    }

    #[test]
    fn map_error_maps_denied_and_not_found() {
        assert!(matches!(
            map_application_error_to_job_update_http_error(
                ApplicationError::AuthorizationWasDenied
            ),
            HttpError::AuthorizationWasDenied { .. }
        ));
        assert!(matches!(
            map_application_error_to_job_update_http_error(
                ApplicationError::RequestedResourceCouldNotBeLocated
            ),
            HttpError::RequestedResourceWasNotFound { .. }
        ));
        assert!(matches!(
            map_application_error_to_job_update_http_error(
                ApplicationError::StorageAdapterFailure {
                    failure_description: "x".to_string()
                }
            ),
            HttpError::UpstreamApplicationFailure { .. }
        ));
    }

    #[test]
    fn assemble_response_includes_identifier_and_status() {
        let document = sample_job_document("completed", Some("owner@example.com"));
        let response = assemble_update_job_response(&document);
        assert_eq!(
            response.get("job_identifier").and_then(Value::as_str),
            Some("job-123")
        );
        assert_eq!(
            response.get("status").and_then(Value::as_str),
            Some("completed")
        );
    }

    #[test]
    fn read_parent_corpus_identifier_reads_field() {
        let document = sample_job_document("running", None);
        assert_eq!(
            read_parent_corpus_identifier(&document),
            Some("corpus-9".to_string())
        );
    }

    #[test]
    fn set_body_field_promotes_non_object_body() {
        let mut document = StoredDocument {
            document_identifier: "x".to_string(),
            owning_account: None,
            document_body: Value::String("scalar".to_string()),
        };
        set_document_body_field(&mut document, "status", json!("queued"));
        assert_eq!(
            document.document_body.get("status").and_then(Value::as_str),
            Some("queued")
        );
    }
}
