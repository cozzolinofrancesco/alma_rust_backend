use crate::categories::rag::collections::{RAG_CORPORA_COLLECTION_NAME, RAG_JOBS_COLLECTION_NAME};
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::ai::{ArtificialIntelligencePort, GeneratedCompletion};
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::storage::{StorageBlob, StorageObjectIdentifier, StoragePort};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

/// Upper bound (in bytes) that a single inline-uploaded file may carry.
/// Keeps a start-file request from smuggling an unbounded blob through JSON.
const MAXIMUM_INLINE_FILE_BYTE_SIZE: u64 = 25 * 1024 * 1024;

/// Folder under which every RAG-ingested file blob is persisted in storage.
const RAG_INGESTION_STORAGE_FOLDER: &str = "rag-ingestion";

/// A single file the caller wants ingested into a corpus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagFileDescriptor {
    pub declared_file_name: String,
    pub declared_content_type: String,
    pub declared_byte_size: u64,
    pub base64_inline_bytes: String,
}

/// One entry in the persisted job document describing an accepted file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagJobFileEntry {
    pub file_name: String,
    pub content_type: String,
    pub byte_size: u64,
    pub storage_reference: String,
}

#[route(method = "POST", path = "/api/rag/jobs/start-file")]
pub async fn start_rag_file_job_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let target_corpus_identifier = extract_target_corpus_identifier_from_body(&submitted_body)?;
    let requested_file_descriptors = extract_requested_file_descriptors_from_body(&submitted_body)?;

    verify_target_corpus_exists(
        &application_state.document_collection,
        &target_corpus_identifier,
    )
    .await?;

    let mut stored_object_identifiers: Vec<StorageObjectIdentifier> =
        Vec::with_capacity(requested_file_descriptors.len());
    for file_descriptor in &requested_file_descriptors {
        validate_file_descriptor_byte_size(file_descriptor)?;
        let decoded_bytes = decode_file_descriptor_inline_bytes(file_descriptor)?;
        let blob_to_persist = map_file_descriptor_to_storage_blob(file_descriptor, decoded_bytes);
        let stored_identifier =
            persist_file_blob_to_storage(&application_state.storage_adapter, blob_to_persist).await?;
        stored_object_identifiers.push(stored_identifier);
    }

    let job_identifier = generate_new_job_identifier();
    let file_entries =
        build_initial_job_file_entries(&requested_file_descriptors, &stored_object_identifiers);
    let owning_account = authorized_request.authorized_principal();

    let job_document = assemble_initial_job_document(
        &job_identifier,
        &target_corpus_identifier,
        owning_account,
        &file_entries,
    );
    persist_initial_job_document(&application_state.document_collection, job_document).await?;

    let kickoff_prompt = build_ingestion_kickoff_prompt(&job_identifier, &file_entries)?;
    dispatch_ingestion_kickoff_completion(
        &application_state.artificial_intelligence_adapter,
        &kickoff_prompt,
    )
    .await?;

    let response_body = assemble_start_file_job_response(&job_identifier, file_entries.len());
    Ok(Json(response_body))
}

/// (1) Pull the required `corpusId` string out of the request body.
fn extract_target_corpus_identifier_from_body(
    submitted_body: &Value,
) -> Result<NonEmptyText, HttpError> {
    let raw_value = submitted_body
        .get("corpusId")
        .and_then(Value::as_str)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "field 'corpusId' is required and must be a string".to_string(),
        })?;
    NonEmptyText::parse(raw_value.to_string()).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: domain_error.to_string(),
        }
    })
}

/// (2) Pull and parse the non-empty `files` array from the request body.
fn extract_requested_file_descriptors_from_body(
    submitted_body: &Value,
) -> Result<Vec<RagFileDescriptor>, HttpError> {
    let raw_files = submitted_body
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "field 'files' is required and must be an array".to_string(),
        })?;

    if raw_files.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "field 'files' must contain at least one file descriptor".to_string(),
        });
    }

    let mut parsed_descriptors = Vec::with_capacity(raw_files.len());
    for raw_descriptor in raw_files {
        parsed_descriptors.push(parse_single_file_descriptor(raw_descriptor)?);
    }
    Ok(parsed_descriptors)
}

/// (3) Parse one JSON file descriptor object into a typed `RagFileDescriptor`.
fn parse_single_file_descriptor(raw_descriptor: &Value) -> Result<RagFileDescriptor, HttpError> {
    let descriptor_object =
        raw_descriptor
            .as_object()
            .ok_or_else(|| HttpError::RequestBodyWasMalformed {
                explanation: "each file descriptor must be a JSON object".to_string(),
            })?;

    let declared_file_name = descriptor_object
        .get("fileName")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.trim().is_empty())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "file descriptor requires a non-empty 'fileName'".to_string(),
        })?
        .to_string();

    let declared_content_type = descriptor_object
        .get("contentType")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.trim().is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();

    let declared_byte_size = descriptor_object
        .get("byteSize")
        .and_then(Value::as_u64)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "file descriptor requires a numeric 'byteSize'".to_string(),
        })?;

    let base64_inline_bytes = descriptor_object
        .get("inlineBytes")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.is_empty())
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "file descriptor requires non-empty base64 'inlineBytes'".to_string(),
        })?
        .to_string();

    Ok(RagFileDescriptor {
        declared_file_name,
        declared_content_type,
        declared_byte_size,
        base64_inline_bytes,
    })
}

/// (4) Reject descriptors that claim a byte size above the inline ceiling or of zero.
fn validate_file_descriptor_byte_size(
    file_descriptor: &RagFileDescriptor,
) -> Result<(), HttpError> {
    if file_descriptor.declared_byte_size == 0 {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "file '{}' declares a byte size of zero",
                file_descriptor.declared_file_name
            ),
        });
    }
    if file_descriptor.declared_byte_size > MAXIMUM_INLINE_FILE_BYTE_SIZE {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "file '{}' declares {} bytes which exceeds the {} byte inline limit",
                file_descriptor.declared_file_name,
                file_descriptor.declared_byte_size,
                MAXIMUM_INLINE_FILE_BYTE_SIZE
            ),
        });
    }
    Ok(())
}

/// (5) Decode the base64 inline payload of a descriptor into raw bytes.
///
/// A small, dependency-free standard-base64 decoder (no padding-tolerant
/// URL-safe variant) is used so we do not need an external crate.
fn decode_file_descriptor_inline_bytes(
    file_descriptor: &RagFileDescriptor,
) -> Result<Vec<u8>, HttpError> {
    decode_standard_base64(&file_descriptor.base64_inline_bytes).map_err(|reason| {
        HttpError::RequestBodyWasMalformed {
            explanation: format!(
                "file '{}' has invalid base64 inline bytes: {}",
                file_descriptor.declared_file_name, reason
            ),
        }
    })
}

/// (6) Confirm the target corpus document exists before accepting file work.
async fn verify_target_corpus_exists(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifier: &NonEmptyText,
) -> Result<StoredDocument, HttpError> {
    let located_corpus = document_collection
        .fetch_document(RAG_CORPORA_COLLECTION_NAME, corpus_identifier.as_str())
        .await?;
    located_corpus.ok_or_else(|| HttpError::RequestedResourceWasNotFound {
        explanation: format!(
            "no RAG corpus exists with identifier '{}'",
            corpus_identifier.as_str()
        ),
    })
}

/// (7) Turn a descriptor plus its decoded bytes into a storage blob.
fn map_file_descriptor_to_storage_blob(
    file_descriptor: &RagFileDescriptor,
    decoded_bytes: Vec<u8>,
) -> StorageBlob {
    StorageBlob {
        containing_folder: RAG_INGESTION_STORAGE_FOLDER.to_string(),
        declared_name: file_descriptor.declared_file_name.clone(),
        raw_bytes: decoded_bytes,
    }
}

/// (8) Persist a single blob and return its opaque storage reference.
async fn persist_file_blob_to_storage(
    storage_adapter: &Arc<dyn StoragePort>,
    blob_to_persist: StorageBlob,
) -> Result<StorageObjectIdentifier, HttpError> {
    let stored_identifier = storage_adapter.persist_blob(blob_to_persist).await?;
    Ok(stored_identifier)
}

/// (9) Mint a fresh unique identifier for the job.
fn generate_new_job_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// (10) Zip descriptors with their stored references into job file entries.
fn build_initial_job_file_entries(
    file_descriptors: &[RagFileDescriptor],
    stored_object_identifiers: &[StorageObjectIdentifier],
) -> Vec<RagJobFileEntry> {
    file_descriptors
        .iter()
        .zip(stored_object_identifiers.iter())
        .map(|(descriptor, stored_identifier)| RagJobFileEntry {
            file_name: descriptor.declared_file_name.clone(),
            content_type: descriptor.declared_content_type.clone(),
            byte_size: descriptor.declared_byte_size,
            storage_reference: stored_identifier.opaque_reference.clone(),
        })
        .collect()
}

/// (11) Build the initial persisted job document (status = "started").
fn assemble_initial_job_document(
    job_identifier: &str,
    corpus_identifier: &NonEmptyText,
    owning_account: &Email,
    file_entries: &[RagJobFileEntry],
) -> StoredDocument {
    let serialized_files: Vec<Value> = file_entries
        .iter()
        .map(|entry| {
            json!({
                "fileName": entry.file_name,
                "contentType": entry.content_type,
                "byteSize": entry.byte_size,
                "storageReference": entry.storage_reference,
                "status": "pending",
            })
        })
        .collect();

    StoredDocument {
        document_identifier: job_identifier.to_string(),
        owning_account: Some(owning_account.as_str().to_string()),
        document_body: json!({
            "status": "started",
            "corpusId": corpus_identifier.as_str(),
            "fileCount": file_entries.len(),
            "files": serialized_files,
        }),
    }
}

/// (12) Insert the assembled job document into the jobs collection.
async fn persist_initial_job_document(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    job_document: StoredDocument,
) -> Result<(), HttpError> {
    document_collection
        .insert_document(RAG_JOBS_COLLECTION_NAME, job_document)
        .await?;
    Ok(())
}

/// (13) Compose the prompt that kicks off downstream ingestion planning.
fn build_ingestion_kickoff_prompt(
    job_identifier: &str,
    file_entries: &[RagJobFileEntry],
) -> Result<NonEmptyText, HttpError> {
    if file_entries.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "cannot build an ingestion prompt with no files".to_string(),
        });
    }

    let file_manifest = file_entries
        .iter()
        .map(|entry| {
            format!(
                "- {} ({} bytes, {})",
                entry.file_name, entry.byte_size, entry.content_type
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let prompt_text = format!(
        "Plan the ingestion of the following files for RAG job {}:\n{}",
        job_identifier, file_manifest
    );

    NonEmptyText::parse(prompt_text).map_err(|domain_error| HttpError::UpstreamApplicationFailure {
        explanation: domain_error.to_string(),
    })
}

/// (14) Send the kickoff prompt to the AI adapter.
async fn dispatch_ingestion_kickoff_completion(
    artificial_intelligence_adapter: &Arc<dyn ArtificialIntelligencePort>,
    kickoff_prompt: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    let generated = artificial_intelligence_adapter
        .generate_completion(kickoff_prompt)
        .await?;
    Ok(generated)
}

/// (15) Assemble the JSON response returned to the caller.
fn assemble_start_file_job_response(job_identifier: &str, accepted_file_count: usize) -> Value {
    json!({
        "jobId": job_identifier,
        "status": "started",
        "acceptedFileCount": accepted_file_count,
    })
}

/// Minimal standard-alphabet base64 decoder used by (5).
/// Accepts `=`/`==` padding, rejects any other non-alphabet character.
fn decode_standard_base64(encoded_input: &str) -> Result<Vec<u8>, String> {
    fn symbol_to_sextet(symbol: u8) -> Option<u8> {
        match symbol {
            b'A'..=b'Z' => Some(symbol - b'A'),
            b'a'..=b'z' => Some(symbol - b'a' + 26),
            b'0'..=b'9' => Some(symbol - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let significant_bytes: Vec<u8> = encoded_input.bytes().filter(|b| *b != b'=').collect();
    let padding_count = encoded_input.bytes().filter(|b| *b == b'=').count();

    if padding_count > 2 {
        return Err("too much padding".to_string());
    }
    if (significant_bytes.len() + padding_count) % 4 != 0 {
        return Err("length is not a multiple of four".to_string());
    }

    let mut decoded_output = Vec::with_capacity(significant_bytes.len() / 4 * 3 + 3);
    let mut accumulator: u32 = 0;
    let mut collected_sextets: u32 = 0;

    for symbol in significant_bytes {
        let sextet = symbol_to_sextet(symbol)
            .ok_or_else(|| format!("invalid base64 character: {}", symbol as char))?;
        accumulator = (accumulator << 6) | u32::from(sextet);
        collected_sextets += 1;
        if collected_sextets == 4 {
            decoded_output.push((accumulator >> 16) as u8);
            decoded_output.push((accumulator >> 8) as u8);
            decoded_output.push(accumulator as u8);
            accumulator = 0;
            collected_sextets = 0;
        }
    }

    match collected_sextets {
        0 => {}
        2 => {
            decoded_output.push((accumulator >> 4) as u8);
        }
        3 => {
            decoded_output.push((accumulator >> 10) as u8);
            decoded_output.push((accumulator >> 2) as u8);
        }
        _ => return Err("invalid trailing base64 group".to_string()),
    }

    Ok(decoded_output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_descriptor() -> RagFileDescriptor {
        RagFileDescriptor {
            declared_file_name: "notes.txt".to_string(),
            declared_content_type: "text/plain".to_string(),
            declared_byte_size: 5,
            // base64 of "hello"
            base64_inline_bytes: "aGVsbG8=".to_string(),
        }
    }

    #[test]
    fn extract_corpus_identifier_accepts_valid_string() {
        let body = json!({ "corpusId": "corpus-42" });
        let parsed = extract_target_corpus_identifier_from_body(&body).unwrap();
        assert_eq!(parsed.as_str(), "corpus-42");
    }

    #[test]
    fn extract_corpus_identifier_rejects_missing_field() {
        let body = json!({ "files": [] });
        assert!(extract_target_corpus_identifier_from_body(&body).is_err());
    }

    #[test]
    fn extract_file_descriptors_parses_array() {
        let body = json!({
            "files": [
                { "fileName": "a.txt", "contentType": "text/plain", "byteSize": 5, "inlineBytes": "aGVsbG8=" }
            ]
        });
        let parsed = extract_requested_file_descriptors_from_body(&body).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].declared_file_name, "a.txt");
    }

    #[test]
    fn extract_file_descriptors_rejects_empty_array() {
        let body = json!({ "files": [] });
        assert!(extract_requested_file_descriptors_from_body(&body).is_err());
    }

    #[test]
    fn parse_single_descriptor_defaults_content_type() {
        let raw = json!({ "fileName": "x.bin", "byteSize": 3, "inlineBytes": "YWJj" });
        let parsed = parse_single_file_descriptor(&raw).unwrap();
        assert_eq!(parsed.declared_content_type, "application/octet-stream");
    }

    #[test]
    fn parse_single_descriptor_rejects_missing_name() {
        let raw = json!({ "byteSize": 3, "inlineBytes": "YWJj" });
        assert!(parse_single_file_descriptor(&raw).is_err());
    }

    #[test]
    fn validate_byte_size_accepts_within_limit() {
        assert!(validate_file_descriptor_byte_size(&sample_descriptor()).is_ok());
    }

    #[test]
    fn validate_byte_size_rejects_zero_and_oversize() {
        let mut zero = sample_descriptor();
        zero.declared_byte_size = 0;
        assert!(validate_file_descriptor_byte_size(&zero).is_err());

        let mut oversize = sample_descriptor();
        oversize.declared_byte_size = MAXIMUM_INLINE_FILE_BYTE_SIZE + 1;
        assert!(validate_file_descriptor_byte_size(&oversize).is_err());
    }

    #[test]
    fn decode_inline_bytes_round_trips_hello() {
        let decoded = decode_file_descriptor_inline_bytes(&sample_descriptor()).unwrap();
        assert_eq!(decoded, b"hello");
    }

    #[test]
    fn decode_inline_bytes_rejects_garbage() {
        let mut bad = sample_descriptor();
        bad.base64_inline_bytes = "not*valid*b64".to_string();
        assert!(decode_file_descriptor_inline_bytes(&bad).is_err());
    }

    #[test]
    fn map_descriptor_to_blob_sets_folder_and_name() {
        let blob = map_file_descriptor_to_storage_blob(&sample_descriptor(), b"hello".to_vec());
        assert_eq!(blob.containing_folder, RAG_INGESTION_STORAGE_FOLDER);
        assert_eq!(blob.declared_name, "notes.txt");
        assert_eq!(blob.raw_bytes, b"hello");
    }

    #[test]
    fn generate_job_identifier_is_unique() {
        let first = generate_new_job_identifier();
        let second = generate_new_job_identifier();
        assert_ne!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn build_file_entries_zips_descriptors_with_identifiers() {
        let descriptors = vec![sample_descriptor()];
        let identifiers = vec![StorageObjectIdentifier {
            opaque_reference: "ref-1".to_string(),
        }];
        let entries = build_initial_job_file_entries(&descriptors, &identifiers);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].storage_reference, "ref-1");
        assert_eq!(entries[0].file_name, "notes.txt");
    }

    #[test]
    fn build_file_entries_ignores_extra_identifiers() {
        let descriptors = vec![sample_descriptor()];
        let identifiers = vec![
            StorageObjectIdentifier {
                opaque_reference: "ref-1".to_string(),
            },
            StorageObjectIdentifier {
                opaque_reference: "ref-2".to_string(),
            },
        ];
        let entries = build_initial_job_file_entries(&descriptors, &identifiers);
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn assemble_job_document_carries_owner_and_files() {
        let corpus = NonEmptyText::parse("corpus-9".to_string()).unwrap();
        let owner = Email::parse("scholar@example.com".to_string()).unwrap();
        let entries = vec![RagJobFileEntry {
            file_name: "a.txt".to_string(),
            content_type: "text/plain".to_string(),
            byte_size: 5,
            storage_reference: "ref-1".to_string(),
        }];
        let document = assemble_initial_job_document("job-1", &corpus, &owner, &entries);
        assert_eq!(document.document_identifier, "job-1");
        assert_eq!(
            document.owning_account.as_deref(),
            Some("scholar@example.com")
        );
        assert_eq!(document.document_body["fileCount"], 1);
        assert_eq!(document.document_body["corpusId"], "corpus-9");
    }

    #[test]
    fn build_kickoff_prompt_lists_files() {
        let entries = vec![RagJobFileEntry {
            file_name: "a.txt".to_string(),
            content_type: "text/plain".to_string(),
            byte_size: 5,
            storage_reference: "ref-1".to_string(),
        }];
        let prompt = build_ingestion_kickoff_prompt("job-1", &entries).unwrap();
        assert!(prompt.as_str().contains("a.txt"));
        assert!(prompt.as_str().contains("job-1"));
    }

    #[test]
    fn build_kickoff_prompt_rejects_empty_entries() {
        assert!(build_ingestion_kickoff_prompt("job-1", &[]).is_err());
    }

    #[test]
    fn assemble_response_reports_counts() {
        let response = assemble_start_file_job_response("job-7", 3);
        assert_eq!(response["jobId"], "job-7");
        assert_eq!(response["acceptedFileCount"], 3);
        assert_eq!(response["status"], "started");
    }

    #[test]
    fn decode_standard_base64_handles_padding_variants() {
        assert_eq!(decode_standard_base64("YWJj").unwrap(), b"abc");
        assert_eq!(decode_standard_base64("YWI=").unwrap(), b"ab");
        assert_eq!(decode_standard_base64("YQ==").unwrap(), b"a");
    }
}
