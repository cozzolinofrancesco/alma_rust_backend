use crate::categories::projects_files::collections::SAVED_PROJECTS_COLLECTION_NAME;
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::error::ApplicationError;
use alma_application::ports::document_collection::StoredDocument;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::ProjectName;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use uuid::Uuid;

#[route(method = "POST", path = "/api/canvas/save-project")]
pub async fn canvas_save_project_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Identify the principal that will own the persisted canvas project.
    let owning_account = extract_owning_account_from_authorized_request(&authorized_request);

    // Validate the human-facing project name supplied in the request body.
    let raw_project_name = extract_canvas_project_name_field(&submitted_body).ok_or_else(|| {
        HttpError::RequestBodyWasMalformed {
            explanation: "the request body must contain a non-empty `project_name` string".to_string(),
        }
    })?;
    let validated_name = validate_canvas_project_name(raw_project_name)?;

    // Extract the graph structure (nodes are mandatory, edges are optional).
    let canvas_nodes = extract_canvas_nodes_array(&submitted_body)?;
    reject_empty_canvas_graph(&canvas_nodes)?;
    let canvas_edges = extract_canvas_edges_array(&submitted_body);

    let node_count = count_canvas_nodes(&canvas_nodes);

    // Assemble the document body that will be persisted.
    let document_body = assemble_canvas_document_body(&validated_name, canvas_nodes, canvas_edges);

    // Generate a fresh identifier and build the stored document.
    let generated_identifier = generate_canvas_project_identifier();
    let document_to_insert = build_canvas_stored_document(
        generated_identifier.clone(),
        owning_account,
        document_body,
    );

    // Persist the document, mapping any collection failure to an HTTP error.
    persist_canvas_project_document(&application_state, document_to_insert).await?;

    Ok(Json(build_canvas_save_acknowledgement_payload(
        &generated_identifier,
        node_count,
    )))
}

/// (1) Resolve the owning account for the request from the authorized principal.
fn extract_owning_account_from_authorized_request(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request
        .authorized_principal()
        .as_str()
        .to_string()
}

/// (2) Pull the `project_name` field from the body as a raw string, if present.
fn extract_canvas_project_name_field(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("project_name")
        .and_then(Value::as_str)
        .map(|candidate| candidate.to_string())
}

/// (3) Validate the raw project name through the domain value object.
fn validate_canvas_project_name(raw_project_name: String) -> Result<ProjectName, HttpError> {
    ProjectName::parse(raw_project_name).map_err(|domain_error| {
        HttpError::RequestBodyWasMalformed {
            explanation: domain_error.to_string(),
        }
    })
}

/// (4) Extract the `nodes` array from the body; a missing/non-array value is malformed.
fn extract_canvas_nodes_array(submitted_body: &Value) -> Result<Vec<Value>, HttpError> {
    match submitted_body.get("nodes") {
        Some(Value::Array(node_values)) => Ok(node_values.clone()),
        Some(_) => Err(HttpError::RequestBodyWasMalformed {
            explanation: "the `nodes` field must be a JSON array".to_string(),
        }),
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: "the request body must contain a `nodes` array".to_string(),
        }),
    }
}

/// (5) Extract the optional `edges` array; anything missing/invalid becomes an empty graph.
fn extract_canvas_edges_array(submitted_body: &Value) -> Vec<Value> {
    match submitted_body.get("edges") {
        Some(Value::Array(edge_values)) => edge_values.clone(),
        _ => Vec::new(),
    }
}

/// (6) Count the number of nodes in the canvas graph.
fn count_canvas_nodes(canvas_nodes: &[Value]) -> usize {
    canvas_nodes.len()
}

/// (7) Reject a canvas graph that contains no nodes.
fn reject_empty_canvas_graph(canvas_nodes: &[Value]) -> Result<(), HttpError> {
    if canvas_nodes.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "a canvas project must contain at least one node".to_string(),
        });
    }
    Ok(())
}

/// (8) Generate a fresh, unique canvas project identifier.
fn generate_canvas_project_identifier() -> String {
    Uuid::new_v4().to_string()
}

/// (9) Assemble the persisted document body from the validated name and graph.
fn assemble_canvas_document_body(
    validated_name: &ProjectName,
    canvas_nodes: Vec<Value>,
    canvas_edges: Vec<Value>,
) -> Value {
    let node_type_histogram = compute_canvas_node_type_histogram(&canvas_nodes);
    let node_type_histogram_value: serde_json::Map<String, Value> = node_type_histogram
        .into_iter()
        .map(|(node_type, occurrences)| (node_type, json!(occurrences)))
        .collect();

    json!({
        "project_name": validated_name.as_str(),
        "node_count": canvas_nodes.len(),
        "edge_count": canvas_edges.len(),
        "nodes": canvas_nodes,
        "edges": canvas_edges,
        "node_type_histogram": Value::Object(node_type_histogram_value),
        "saved_at": stamp_canvas_saved_timestamp(),
    })
}

/// (10) Wrap the document body into a stored document ready for persistence.
fn build_canvas_stored_document(
    generated_identifier: String,
    owning_account: String,
    document_body: Value,
) -> StoredDocument {
    StoredDocument {
        document_identifier: generated_identifier,
        owning_account: Some(owning_account),
        document_body,
    }
}

/// (11) Persist the canvas document, translating collection failures to HTTP errors.
fn persist_canvas_project_document<'a, TransactionalUnitOfWork: UnitOfWork>(
    application_state: &'a ApplicationState<TransactionalUnitOfWork>,
    document_to_insert: StoredDocument,
) -> impl std::future::Future<Output = Result<(), HttpError>> + 'a {
    async move {
        application_state
            .document_collection
            .insert_document(SAVED_PROJECTS_COLLECTION_NAME, document_to_insert)
            .await
            .map_err(map_document_collection_failure_to_http_error)
    }
}

/// (12) Produce a best-effort timestamp string for when the project was saved.
fn stamp_canvas_saved_timestamp() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed_since_epoch) => elapsed_since_epoch.as_secs().to_string(),
        Err(_) => "0".to_string(),
    }
}

/// (13) Compute how many nodes of each `type` exist in the canvas graph.
fn compute_canvas_node_type_histogram(canvas_nodes: &[Value]) -> std::collections::HashMap<String, usize> {
    let mut histogram: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for node_value in canvas_nodes {
        let node_type = node_value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unspecified")
            .to_string();
        *histogram.entry(node_type).or_insert(0) += 1;
    }
    histogram
}

/// (14) Build the acknowledgement payload returned to the caller on success.
fn build_canvas_save_acknowledgement_payload(generated_identifier: &str, node_count: usize) -> Value {
    json!({
        "document_identifier": generated_identifier,
        "node_count": node_count,
        "acknowledgement": "canvas project saved",
    })
}

/// (15) Translate an application-layer error into the appropriate HTTP error.
fn map_document_collection_failure_to_http_error(originating_error: ApplicationError) -> HttpError {
    match originating_error {
        ApplicationError::AuthorizationWasDenied => HttpError::AuthorizationWasDenied {
            explanation: "the principal is not authorized to persist this canvas project".to_string(),
        },
        ApplicationError::RequestedProjectCouldNotBeLocated
        | ApplicationError::RequestedResourceCouldNotBeLocated => {
            HttpError::RequestedResourceWasNotFound {
                explanation: "the referenced canvas project could not be located".to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_canvas_project_name_field_returns_value_when_present() {
        let body = json!({ "project_name": "My Canvas" });
        assert_eq!(
            extract_canvas_project_name_field(&body),
            Some("My Canvas".to_string())
        );
    }

    #[test]
    fn extract_canvas_project_name_field_returns_none_when_absent_or_wrong_type() {
        let missing = json!({ "other": "value" });
        assert_eq!(extract_canvas_project_name_field(&missing), None);
        let wrong_type = json!({ "project_name": 42 });
        assert_eq!(extract_canvas_project_name_field(&wrong_type), None);
    }

    #[test]
    fn validate_canvas_project_name_accepts_reasonable_name() {
        let validated = validate_canvas_project_name("Research Board".to_string())
            .expect("a reasonable project name should validate");
        assert_eq!(validated.as_str(), "Research Board");
    }

    #[test]
    fn validate_canvas_project_name_rejects_blank_name() {
        let outcome = validate_canvas_project_name("   ".to_string());
        assert!(matches!(
            outcome,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_canvas_nodes_array_returns_nodes_when_array_present() {
        let body = json!({ "nodes": [ { "id": "a" }, { "id": "b" } ] });
        let nodes = extract_canvas_nodes_array(&body).expect("nodes array should extract");
        assert_eq!(nodes.len(), 2);
    }

    #[test]
    fn extract_canvas_nodes_array_rejects_missing_or_non_array() {
        let missing = json!({ "edges": [] });
        assert!(matches!(
            extract_canvas_nodes_array(&missing),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
        let non_array = json!({ "nodes": "not-an-array" });
        assert!(matches!(
            extract_canvas_nodes_array(&non_array),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn extract_canvas_edges_array_returns_edges_or_empty() {
        let with_edges = json!({ "edges": [ { "from": "a", "to": "b" } ] });
        assert_eq!(extract_canvas_edges_array(&with_edges).len(), 1);
        let without_edges = json!({ "nodes": [] });
        assert!(extract_canvas_edges_array(&without_edges).is_empty());
    }

    #[test]
    fn count_canvas_nodes_counts_elements() {
        let nodes = vec![json!({ "id": "a" }), json!({ "id": "b" }), json!({ "id": "c" })];
        assert_eq!(count_canvas_nodes(&nodes), 3);
        let empty: Vec<Value> = Vec::new();
        assert_eq!(count_canvas_nodes(&empty), 0);
    }

    #[test]
    fn reject_empty_canvas_graph_allows_non_empty() {
        let nodes = vec![json!({ "id": "a" })];
        assert!(reject_empty_canvas_graph(&nodes).is_ok());
    }

    #[test]
    fn reject_empty_canvas_graph_rejects_empty() {
        let empty: Vec<Value> = Vec::new();
        assert!(matches!(
            reject_empty_canvas_graph(&empty),
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn generate_canvas_project_identifier_produces_unique_values() {
        let first = generate_canvas_project_identifier();
        let second = generate_canvas_project_identifier();
        assert_ne!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn assemble_canvas_document_body_includes_expected_fields() {
        let validated_name = ProjectName::parse("Board".to_string()).expect("valid name");
        let nodes = vec![json!({ "type": "note" }), json!({ "type": "note" })];
        let edges = vec![json!({ "from": "a", "to": "b" })];
        let body = assemble_canvas_document_body(&validated_name, nodes, edges);
        assert_eq!(body["project_name"], json!("Board"));
        assert_eq!(body["node_count"], json!(2));
        assert_eq!(body["edge_count"], json!(1));
        assert_eq!(body["node_type_histogram"]["note"], json!(2));
    }

    #[test]
    fn build_canvas_stored_document_sets_fields() {
        let document = build_canvas_stored_document(
            "id-123".to_string(),
            "owner@example.com".to_string(),
            json!({ "hello": "world" }),
        );
        assert_eq!(document.document_identifier, "id-123");
        assert_eq!(document.owning_account, Some("owner@example.com".to_string()));
        assert_eq!(document.document_body["hello"], json!("world"));
    }

    #[test]
    fn stamp_canvas_saved_timestamp_returns_parseable_value() {
        let stamp = stamp_canvas_saved_timestamp();
        assert!(stamp.parse::<u64>().is_ok());
    }

    #[test]
    fn compute_canvas_node_type_histogram_counts_by_type() {
        let nodes = vec![
            json!({ "type": "note" }),
            json!({ "type": "note" }),
            json!({ "type": "image" }),
            json!({ "id": "no-type" }),
        ];
        let histogram = compute_canvas_node_type_histogram(&nodes);
        assert_eq!(histogram.get("note"), Some(&2));
        assert_eq!(histogram.get("image"), Some(&1));
        assert_eq!(histogram.get("unspecified"), Some(&1));
    }

    #[test]
    fn build_canvas_save_acknowledgement_payload_reports_identifier_and_count() {
        let payload = build_canvas_save_acknowledgement_payload("id-999", 5);
        assert_eq!(payload["document_identifier"], json!("id-999"));
        assert_eq!(payload["node_count"], json!(5));
        assert_eq!(payload["acknowledgement"], json!("canvas project saved"));
    }

    #[test]
    fn map_document_collection_failure_maps_authorization_denied() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::AuthorizationWasDenied,
        );
        assert!(matches!(mapped, HttpError::AuthorizationWasDenied { .. }));
    }

    #[test]
    fn map_document_collection_failure_maps_not_found() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::RequestedProjectCouldNotBeLocated,
        );
        assert!(matches!(mapped, HttpError::RequestedResourceWasNotFound { .. }));
    }

    #[test]
    fn map_document_collection_failure_maps_generic_to_upstream() {
        let mapped = map_document_collection_failure_to_http_error(
            ApplicationError::DocumentCollectionFailure {
                failure_description: "boom".to_string(),
            },
        );
        assert!(matches!(mapped, HttpError::UpstreamApplicationFailure { .. }));
    }
}
