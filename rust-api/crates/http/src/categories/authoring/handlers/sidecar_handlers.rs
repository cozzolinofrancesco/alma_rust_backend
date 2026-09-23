//! `GET`/`PUT /api/canvas-272/sidecar/:agent_identifier?projectId=…` — per-agent
//! canvas-272 sidecar (the user's edits to an agent's step outputs).
//!
//! Ports `frontend_v3/app/api/canvas-272/sidecar/[agentId]/route.ts`. The
//! reference stores `{agentId}.canvas272.json` in the project's Google Drive `AF`
//! folder; here the sidecar lives in the durable document store instead
//! ([`CANVAS_272_SIDECAR_COLLECTION_NAME`]), keyed by `"{projectId}:{agentId}"`
//! and owner-scoped to the authorized principal. The wire contract is unchanged:
//! GET → `{ sidecar }` (404 when absent), PUT `{ sidecar }` → `{ ok, fileId }`.
//!
//! The sidecar payload (`Canvas272SidecarV1 = { version:1, agentId, agentName,
//! updatedAt, outputs }`) is stored opaquely as the document body after
//! validating `version === 1 && agentId === :agent_identifier`.

use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_macros::route;
use axum::Json;
use axum::extract::{Path, Query, State};
use serde_json::{Value, json};
use std::collections::HashMap;

use crate::categories::authoring::collections::CANVAS_272_SIDECAR_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;

/// The per-(project, agent) document identifier used in the sidecar collection.
fn sidecar_document_identifier(project_identifier: &str, agent_identifier: &str) -> String {
    format!("{project_identifier}:{agent_identifier}")
}

/// Extract the required `projectId` query parameter.
fn required_project_identifier(
    query_parameters: &HashMap<String, String>,
) -> Result<String, HttpError> {
    query_parameters
        .get("projectId")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(HttpError::RequestBodyWasMalformed {
            explanation: String::from("the 'projectId' query parameter is required"),
        })
}

/// `GET /api/canvas-272/sidecar/:agent_identifier?projectId=…`.
#[route(method = "GET", path = "/api/canvas-272/sidecar/:agent_identifier")]
pub async fn get_canvas_272_sidecar_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(agent_identifier): Path<String>,
    Query(query_parameters): Query<HashMap<String, String>>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let project_identifier = required_project_identifier(&query_parameters)?;
    let principal = authorized_request.authorized_principal().as_str().to_string();
    let identifier = sidecar_document_identifier(&project_identifier, &agent_identifier);

    let stored = application_state
        .document_collection
        .fetch_document(CANVAS_272_SIDECAR_COLLECTION_NAME, &identifier)
        .await?;

    // Owner-scope: a document owned by someone else is treated as absent.
    match stored {
        Some(document) if document.owning_account.as_deref() == Some(principal.as_str()) => {
            Ok(Json(json!({ "sidecar": document.document_body })))
        }
        _ => Err(HttpError::RequestedResourceWasNotFound {
            explanation: String::from("no sidecar for this agent in this project"),
        }),
    }
}

/// `PUT /api/canvas-272/sidecar/:agent_identifier?projectId=…`.
#[route(method = "PUT", path = "/api/canvas-272/sidecar/:agent_identifier")]
pub async fn put_canvas_272_sidecar_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Path(agent_identifier): Path<String>,
    Query(query_parameters): Query<HashMap<String, String>>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let project_identifier = required_project_identifier(&query_parameters)?;
    let principal = authorized_request.authorized_principal().as_str().to_string();

    let sidecar = validate_sidecar_payload(&submitted_body, &agent_identifier)?;
    let identifier = sidecar_document_identifier(&project_identifier, &agent_identifier);

    let document = StoredDocument {
        document_identifier: identifier.clone(),
        owning_account: Some(principal),
        document_body: sidecar,
    };

    // Upsert: replace_document returns whether a document already existed; when it
    // did not, insert instead.
    let replaced = application_state
        .document_collection
        .replace_document(CANVAS_272_SIDECAR_COLLECTION_NAME, document.clone())
        .await?;
    if !replaced {
        application_state
            .document_collection
            .insert_document(CANVAS_272_SIDECAR_COLLECTION_NAME, document)
            .await?;
    }

    Ok(Json(json!({ "ok": true, "fileId": identifier })))
}

/// Validate the `{ sidecar }` envelope: `sidecar.version === 1` and
/// `sidecar.agentId === :agent_identifier`. Returns the sidecar object to store.
fn validate_sidecar_payload(
    submitted_body: &Value,
    agent_identifier: &str,
) -> Result<Value, HttpError> {
    let sidecar = submitted_body.get("sidecar").ok_or(HttpError::RequestBodyWasMalformed {
        explanation: String::from("body must be { sidecar: Canvas272SidecarV1 }"),
    })?;

    if sidecar.get("version").and_then(Value::as_i64) != Some(1) {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("sidecar.version must be 1"),
        });
    }
    if sidecar.get("agentId").and_then(Value::as_str) != Some(agent_identifier) {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("sidecar.agentId must match the path :agent_identifier"),
        });
    }

    Ok(sidecar.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alma_application::error::ApplicationError;
    use alma_application::ports::document_collection::DocumentCollectionPort;
    use async_trait::async_trait;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[test]
    fn identifier_is_project_scoped() {
        assert_eq!(sidecar_document_identifier("proj-1", "agent-9"), "proj-1:agent-9");
    }

    #[test]
    fn missing_project_id_is_rejected() {
        let error = required_project_identifier(&HashMap::new()).unwrap_err();
        assert!(matches!(error, HttpError::RequestBodyWasMalformed { .. }));
    }

    #[test]
    fn sidecar_validation_enforces_version_and_agent_id() {
        let ok = json!({ "sidecar": { "version": 1, "agentId": "a1", "agentName": "N", "updatedAt": "t", "outputs": {} } });
        assert!(validate_sidecar_payload(&ok, "a1").is_ok());

        let wrong_version = json!({ "sidecar": { "version": 2, "agentId": "a1" } });
        assert!(validate_sidecar_payload(&wrong_version, "a1").is_err());

        let wrong_agent = json!({ "sidecar": { "version": 1, "agentId": "other" } });
        assert!(validate_sidecar_payload(&wrong_agent, "a1").is_err());

        let no_envelope = json!({ "version": 1, "agentId": "a1" });
        assert!(validate_sidecar_payload(&no_envelope, "a1").is_err());
    }

    /// Minimal in-memory `DocumentCollectionPort` stub for the round-trip test.
    struct InMemoryDocumentStore(Mutex<HashMap<String, StoredDocument>>);

    #[async_trait]
    impl DocumentCollectionPort for InMemoryDocumentStore {
        async fn insert_document(&self, _c: &str, d: StoredDocument) -> Result<(), ApplicationError> {
            self.0.lock().await.insert(d.document_identifier.clone(), d);
            Ok(())
        }
        async fn fetch_document(&self, _c: &str, id: &str) -> Result<Option<StoredDocument>, ApplicationError> {
            Ok(self.0.lock().await.get(id).cloned())
        }
        async fn list_documents(&self, _c: &str) -> Result<Vec<StoredDocument>, ApplicationError> {
            Ok(self.0.lock().await.values().cloned().collect())
        }
        async fn list_documents_owned_by(&self, _c: &str, owner: &str) -> Result<Vec<StoredDocument>, ApplicationError> {
            Ok(self
                .0
                .lock()
                .await
                .values()
                .filter(|d| d.owning_account.as_deref() == Some(owner))
                .cloned()
                .collect())
        }
        async fn replace_document(&self, _c: &str, d: StoredDocument) -> Result<bool, ApplicationError> {
            let mut map = self.0.lock().await;
            let existed = map.contains_key(&d.document_identifier);
            if existed {
                map.insert(d.document_identifier.clone(), d);
            }
            Ok(existed)
        }
        async fn delete_document(&self, _c: &str, id: &str) -> Result<bool, ApplicationError> {
            Ok(self.0.lock().await.remove(id).is_some())
        }
        async fn count_documents(&self, _c: &str) -> Result<usize, ApplicationError> {
            Ok(self.0.lock().await.len())
        }
    }

    #[tokio::test]
    async fn put_then_fetch_round_trips_owner_scoped() {
        let store: Arc<dyn DocumentCollectionPort> =
            Arc::new(InMemoryDocumentStore(Mutex::new(HashMap::new())));
        let identifier = sidecar_document_identifier("proj-1", "a1");
        let sidecar = json!({ "version": 1, "agentId": "a1", "agentName": "N", "updatedAt": "t", "outputs": { "s1": "edited" } });

        // Upsert (insert path).
        let existed = store
            .replace_document(
                CANVAS_272_SIDECAR_COLLECTION_NAME,
                StoredDocument {
                    document_identifier: identifier.clone(),
                    owning_account: Some("owner@example.com".to_string()),
                    document_body: sidecar.clone(),
                },
            )
            .await
            .unwrap();
        assert!(!existed, "first write is an insert");
        store
            .insert_document(
                CANVAS_272_SIDECAR_COLLECTION_NAME,
                StoredDocument {
                    document_identifier: identifier.clone(),
                    owning_account: Some("owner@example.com".to_string()),
                    document_body: sidecar.clone(),
                },
            )
            .await
            .unwrap();

        let fetched = store
            .fetch_document(CANVAS_272_SIDECAR_COLLECTION_NAME, &identifier)
            .await
            .unwrap()
            .expect("present");
        assert_eq!(fetched.owning_account.as_deref(), Some("owner@example.com"));
        assert_eq!(fetched.document_body["outputs"]["s1"], json!("edited"));
    }
}
