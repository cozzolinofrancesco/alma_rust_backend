use crate::categories::rag::collections::{
    RAG_CORPORA_COLLECTION_NAME, RAG_JOBS_COLLECTION_NAME, RAG_KNOWLEDGE_COLLECTION_NAME,
};
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::ai::{ArtificialIntelligencePort, GeneratedCompletion};
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::NonEmptyText;
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::sync::Arc;

/// Maximum number of characters of concatenated knowledge text that we are
/// willing to hand to the AI adapter in a single summarization prompt. Anything
/// beyond this budget is truncated so that we never build an unbounded prompt.
const CORPUS_SUMMARY_PROMPT_CHARACTER_BUDGET: usize = 12_000;

/// Preference for how long the produced corpus summary should be. This drives
/// the instruction we embed in the summarization prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummaryLengthPreference {
    Concise,
    Standard,
    Detailed,
}

impl SummaryLengthPreference {
    /// Human-readable instruction fragment describing the desired length.
    fn prompt_instruction_fragment(self) -> &'static str {
        match self {
            SummaryLengthPreference::Concise => {
                "Produce a concise summary of at most three sentences."
            }
            SummaryLengthPreference::Standard => {
                "Produce a balanced summary of one short paragraph."
            }
            SummaryLengthPreference::Detailed => {
                "Produce a detailed summary of several paragraphs covering all major themes."
            }
        }
    }

    /// Stable machine-readable label emitted in the JSON response.
    fn machine_label(self) -> &'static str {
        match self {
            SummaryLengthPreference::Concise => "concise",
            SummaryLengthPreference::Standard => "standard",
            SummaryLengthPreference::Detailed => "detailed",
        }
    }
}

/// A single corpus summary produced by the handler. Owned data only, so it is
/// trivial to construct in tests and serialize deterministically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagCorpusSummary {
    pub corpus_identifier: String,
    pub corpus_display_name: String,
    pub summary_text: String,
    pub length_preference_label: String,
}

#[route(method = "POST", path = "/api/rag/corpora/summaries")]
pub async fn summarize_rag_corpora_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    _authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Load every corpus currently registered. We derive the "requested"
    // identifiers from what actually exists so that callers without a body
    // still get a full summarization pass.
    let all_corpus_documents = application_state
        .document_collection
        .list_documents(RAG_CORPORA_COLLECTION_NAME)
        .await?;

    let requested_body = build_requested_identifiers_value(&all_corpus_documents);
    let requested_identifiers = extract_corpus_identifiers_to_summarize(&requested_body)?;
    let length_preference = parse_requested_summary_length(&requested_body);

    let located_documents = load_corpus_documents_for_summary(
        &application_state.document_collection,
        &requested_identifiers,
    )
    .await?;

    assert_all_requested_corpora_were_located(&requested_identifiers, &located_documents)?;

    let corpus_summaries = summarize_all_requested_corpora(
        &application_state,
        &located_documents,
        length_preference,
    )
    .await?;

    for corpus_summary in &corpus_summaries {
        persist_corpus_summary_cache_entry(
            &application_state.document_collection,
            corpus_summary,
        )
        .await?;
    }

    Ok(Json(assemble_summarize_corpora_response(&corpus_summaries)))
}

/// Build a synthetic request body describing which corpora to summarize based on
/// the corpora that currently exist in the collection. This keeps the pure
/// extraction helper exercised even though the route accepts no request body.
fn build_requested_identifiers_value(all_corpus_documents: &[StoredDocument]) -> Value {
    let corpus_identifiers: Vec<Value> = all_corpus_documents
        .iter()
        .map(|document| Value::String(document.document_identifier.clone()))
        .collect();
    json!({
        "corpusIdentifiers": corpus_identifiers,
        "summaryLength": "standard",
    })
}

/// (1) Extract and validate the list of corpus identifiers to summarize from a
/// request body. Accepts either `corpusIdentifiers` or `corpusIds` arrays.
fn extract_corpus_identifiers_to_summarize(
    submitted_body: &Value,
) -> Result<Vec<NonEmptyText>, HttpError> {
    let raw_identifiers = submitted_body
        .get("corpusIdentifiers")
        .or_else(|| submitted_body.get("corpusIds"))
        .and_then(Value::as_array)
        .ok_or_else(|| HttpError::RequestBodyWasMalformed {
            explanation: "Expected an array field 'corpusIdentifiers'.".to_string(),
        })?;

    if raw_identifiers.is_empty() {
        return Err(HttpError::RequestBodyWasMalformed {
            explanation: "At least one corpus identifier must be supplied.".to_string(),
        });
    }

    let mut parsed_identifiers = Vec::with_capacity(raw_identifiers.len());
    for raw_identifier in raw_identifiers {
        let identifier_text = raw_identifier.as_str().ok_or_else(|| {
            HttpError::RequestBodyWasMalformed {
                explanation: "Each corpus identifier must be a string.".to_string(),
            }
        })?;
        let parsed = NonEmptyText::parse(identifier_text.to_string())
            .map_err(|error| HttpError::RequestBodyWasMalformed {
                explanation: error.to_string(),
            })?;
        parsed_identifiers.push(parsed);
    }

    Ok(parsed_identifiers)
}

/// (2) Parse the requested summary length preference, defaulting to `Standard`
/// when the field is missing or unrecognized.
fn parse_requested_summary_length(submitted_body: &Value) -> SummaryLengthPreference {
    match submitted_body
        .get("summaryLength")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("concise") | Some("short") | Some("brief") => SummaryLengthPreference::Concise,
        Some("detailed") | Some("long") | Some("full") => SummaryLengthPreference::Detailed,
        _ => SummaryLengthPreference::Standard,
    }
}

/// (3) Load the corpus registry documents for the requested identifiers.
async fn load_corpus_documents_for_summary(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifiers: &[NonEmptyText],
) -> Result<Vec<StoredDocument>, HttpError> {
    let mut located_documents = Vec::with_capacity(corpus_identifiers.len());
    for corpus_identifier in corpus_identifiers {
        if let Some(document) = document_collection
            .fetch_document(RAG_CORPORA_COLLECTION_NAME, corpus_identifier.as_str())
            .await?
        {
            located_documents.push(document);
        }
    }
    Ok(located_documents)
}

/// (4) Ensure every requested corpus identifier was actually located; otherwise
/// report the first missing one as a not-found error.
fn assert_all_requested_corpora_were_located(
    requested_identifiers: &[NonEmptyText],
    located_documents: &[StoredDocument],
) -> Result<(), HttpError> {
    for requested_identifier in requested_identifiers {
        let was_located = located_documents
            .iter()
            .any(|document| document.document_identifier == requested_identifier.as_str());
        if !was_located {
            return Err(HttpError::RequestedResourceWasNotFound {
                explanation: format!(
                    "Corpus '{}' could not be located.",
                    requested_identifier.as_str()
                ),
            });
        }
    }
    Ok(())
}

/// (5) Load the knowledge entries belonging to a single corpus. Knowledge
/// documents record their owning corpus via the `owning_account` field.
async fn load_knowledge_entries_for_corpus(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifier: &NonEmptyText,
) -> Result<Vec<StoredDocument>, HttpError> {
    let knowledge_entries = document_collection
        .list_documents_owned_by(RAG_KNOWLEDGE_COLLECTION_NAME, corpus_identifier.as_str())
        .await?;
    Ok(knowledge_entries)
}

/// (6) Concatenate the textual bodies of the supplied knowledge documents into a
/// single blob, separating entries with blank lines.
fn concatenate_knowledge_entry_bodies(knowledge_documents: &[StoredDocument]) -> String {
    let mut concatenated = String::new();
    for knowledge_document in knowledge_documents {
        let entry_text = extract_knowledge_entry_text(knowledge_document);
        if entry_text.is_empty() {
            continue;
        }
        if !concatenated.is_empty() {
            concatenated.push_str("\n\n");
        }
        concatenated.push_str(&entry_text);
    }
    concatenated
}

/// Best-effort extraction of the human-readable text from a knowledge document,
/// checking common field names before falling back to the raw JSON string.
fn extract_knowledge_entry_text(knowledge_document: &StoredDocument) -> String {
    for field_name in ["content", "text", "body", "passage"] {
        if let Some(text) = knowledge_document
            .document_body
            .get(field_name)
            .and_then(Value::as_str)
        {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

/// (7) Truncate the concatenated corpus text so it fits inside the prompt
/// budget, appending an ellipsis marker when truncation occurs. Truncation
/// respects character boundaries.
fn truncate_concatenated_corpus_text_to_prompt_budget(
    concatenated_text: String,
    maximum_character_budget: usize,
) -> String {
    if maximum_character_budget == 0 {
        return String::new();
    }
    if concatenated_text.chars().count() <= maximum_character_budget {
        return concatenated_text;
    }
    let mut truncated: String = concatenated_text
        .chars()
        .take(maximum_character_budget)
        .collect();
    truncated.push_str("…");
    truncated
}

/// (8) Build the AI summarization prompt for a single corpus.
fn build_corpus_summarization_prompt(
    corpus_display_name: &str,
    concatenated_text: &str,
    length_preference: SummaryLengthPreference,
) -> Result<NonEmptyText, HttpError> {
    let effective_body = if concatenated_text.trim().is_empty() {
        "(This corpus currently has no indexed knowledge entries.)"
    } else {
        concatenated_text
    };

    let prompt_text = format!(
        "You are summarizing a knowledge corpus for a research assistant.\n\
         Corpus name: {corpus_display_name}\n\
         {length_instruction}\n\
         Base your summary strictly on the corpus content below.\n\n\
         --- CORPUS CONTENT START ---\n{body}\n--- CORPUS CONTENT END ---",
        corpus_display_name = corpus_display_name,
        length_instruction = length_preference.prompt_instruction_fragment(),
        body = effective_body,
    );

    NonEmptyText::parse(prompt_text).map_err(|error| HttpError::RequestBodyWasMalformed {
        explanation: error.to_string(),
    })
}

/// (9) Invoke the AI adapter to produce a completion for the given prompt.
async fn generate_summary_completion_for_corpus(
    artificial_intelligence_adapter: &Arc<dyn ArtificialIntelligencePort>,
    summarization_prompt: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    let generated_completion = artificial_intelligence_adapter
        .generate_completion(summarization_prompt)
        .await?;
    Ok(generated_completion)
}

/// (10) Read the human-facing display name from a corpus registry document,
/// falling back to the corpus identifier when no name is present.
fn read_corpus_display_name(corpus_document: &StoredDocument) -> String {
    for field_name in ["displayName", "name", "title"] {
        if let Some(name) = corpus_document
            .document_body
            .get(field_name)
            .and_then(Value::as_str)
        {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    corpus_document.document_identifier.clone()
}

/// (11) Assemble a single corpus summary from its registry document and the
/// completion produced by the AI adapter.
fn build_single_corpus_summary(
    corpus_document: &StoredDocument,
    generated_completion: &GeneratedCompletion,
) -> RagCorpusSummary {
    RagCorpusSummary {
        corpus_identifier: corpus_document.document_identifier.clone(),
        corpus_display_name: read_corpus_display_name(corpus_document),
        summary_text: generated_completion.produced_text.trim().to_string(),
        length_preference_label: SummaryLengthPreference::Standard.machine_label().to_string(),
    }
}

/// (12) Summarize every requested corpus, loading its knowledge, building a
/// prompt, and calling the AI adapter for each.
async fn summarize_all_requested_corpora<TransactionalUnitOfWork>(
    application_state: &ApplicationState<TransactionalUnitOfWork>,
    corpus_documents: &[StoredDocument],
    length_preference: SummaryLengthPreference,
) -> Result<Vec<RagCorpusSummary>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork,
{
    let mut corpus_summaries = Vec::with_capacity(corpus_documents.len());
    for corpus_document in corpus_documents {
        let corpus_identifier = NonEmptyText::parse(corpus_document.document_identifier.clone())
            .map_err(|error| HttpError::UpstreamApplicationFailure {
                explanation: error.to_string(),
            })?;

        let knowledge_entries = load_knowledge_entries_for_corpus(
            &application_state.document_collection,
            &corpus_identifier,
        )
        .await?;

        let concatenated_text = concatenate_knowledge_entry_bodies(&knowledge_entries);
        let budgeted_text = truncate_concatenated_corpus_text_to_prompt_budget(
            concatenated_text,
            CORPUS_SUMMARY_PROMPT_CHARACTER_BUDGET,
        );

        let display_name = read_corpus_display_name(corpus_document);
        let summarization_prompt =
            build_corpus_summarization_prompt(&display_name, &budgeted_text, length_preference)?;

        let generated_completion = generate_summary_completion_for_corpus(
            &application_state.artificial_intelligence_adapter,
            &summarization_prompt,
        )
        .await?;

        let mut corpus_summary = build_single_corpus_summary(corpus_document, &generated_completion);
        corpus_summary.length_preference_label = length_preference.machine_label().to_string();
        corpus_summaries.push(corpus_summary);
    }
    Ok(corpus_summaries)
}

/// (13) Persist a cache entry for a produced corpus summary so subsequent reads
/// can serve it without re-running the AI adapter.
async fn persist_corpus_summary_cache_entry(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_summary: &RagCorpusSummary,
) -> Result<(), HttpError> {
    let cache_document = StoredDocument {
        document_identifier: build_summary_cache_identifier(&corpus_summary.corpus_identifier),
        owning_account: Some(corpus_summary.corpus_identifier.clone()),
        document_body: serialize_single_corpus_summary_to_json(corpus_summary),
    };

    let was_replaced = document_collection
        .replace_document(RAG_JOBS_COLLECTION_NAME, cache_document.clone())
        .await?;
    if !was_replaced {
        document_collection
            .insert_document(RAG_JOBS_COLLECTION_NAME, cache_document)
            .await?;
    }
    Ok(())
}

/// Build the deterministic cache document identifier for a corpus summary.
fn build_summary_cache_identifier(corpus_identifier: &str) -> String {
    format!("summary::{corpus_identifier}")
}

/// (14) Serialize a single corpus summary into its JSON representation.
fn serialize_single_corpus_summary_to_json(corpus_summary: &RagCorpusSummary) -> Value {
    json!({
        "corpusIdentifier": corpus_summary.corpus_identifier,
        "corpusDisplayName": corpus_summary.corpus_display_name,
        "summaryText": corpus_summary.summary_text,
        "lengthPreference": corpus_summary.length_preference_label,
    })
}

/// (15) Assemble the top-level handler response from all produced summaries.
fn assemble_summarize_corpora_response(corpus_summaries: &[RagCorpusSummary]) -> Value {
    let serialized_summaries: Vec<Value> = corpus_summaries
        .iter()
        .map(serialize_single_corpus_summary_to_json)
        .collect();
    json!({
        "summarizedCorpusCount": corpus_summaries.len(),
        "summaries": serialized_summaries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_document(identifier: &str, body: Value) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: None,
            document_body: body,
        }
    }

    #[test]
    fn extract_corpus_identifiers_accepts_valid_array() {
        let body = json!({ "corpusIdentifiers": ["oncology", "cardiology"] });
        let identifiers = extract_corpus_identifiers_to_summarize(&body).unwrap();
        assert_eq!(identifiers.len(), 2);
        assert_eq!(identifiers[0].as_str(), "oncology");
        assert_eq!(identifiers[1].as_str(), "cardiology");
    }

    #[test]
    fn extract_corpus_identifiers_accepts_alias_field() {
        let body = json!({ "corpusIds": ["neurology"] });
        let identifiers = extract_corpus_identifiers_to_summarize(&body).unwrap();
        assert_eq!(identifiers.len(), 1);
        assert_eq!(identifiers[0].as_str(), "neurology");
    }

    #[test]
    fn extract_corpus_identifiers_rejects_missing_field() {
        let body = json!({ "somethingElse": true });
        assert!(extract_corpus_identifiers_to_summarize(&body).is_err());
    }

    #[test]
    fn extract_corpus_identifiers_rejects_empty_array() {
        let body = json!({ "corpusIdentifiers": [] });
        assert!(extract_corpus_identifiers_to_summarize(&body).is_err());
    }

    #[test]
    fn extract_corpus_identifiers_rejects_non_string_entry() {
        let body = json!({ "corpusIdentifiers": [42] });
        assert!(extract_corpus_identifiers_to_summarize(&body).is_err());
    }

    #[test]
    fn parse_requested_summary_length_maps_known_values() {
        assert_eq!(
            parse_requested_summary_length(&json!({ "summaryLength": "concise" })),
            SummaryLengthPreference::Concise
        );
        assert_eq!(
            parse_requested_summary_length(&json!({ "summaryLength": "Detailed" })),
            SummaryLengthPreference::Detailed
        );
        assert_eq!(
            parse_requested_summary_length(&json!({ "summaryLength": "brief" })),
            SummaryLengthPreference::Concise
        );
    }

    #[test]
    fn parse_requested_summary_length_defaults_to_standard() {
        assert_eq!(
            parse_requested_summary_length(&json!({})),
            SummaryLengthPreference::Standard
        );
        assert_eq!(
            parse_requested_summary_length(&json!({ "summaryLength": "weird" })),
            SummaryLengthPreference::Standard
        );
    }

    #[test]
    fn assert_all_requested_corpora_were_located_passes_when_present() {
        let requested = vec![
            NonEmptyText::parse("a".to_string()).unwrap(),
            NonEmptyText::parse("b".to_string()).unwrap(),
        ];
        let located = vec![
            stored_document("a", json!({})),
            stored_document("b", json!({})),
        ];
        assert!(assert_all_requested_corpora_were_located(&requested, &located).is_ok());
    }

    #[test]
    fn assert_all_requested_corpora_were_located_fails_when_missing() {
        let requested = vec![
            NonEmptyText::parse("a".to_string()).unwrap(),
            NonEmptyText::parse("missing".to_string()).unwrap(),
        ];
        let located = vec![stored_document("a", json!({}))];
        assert!(assert_all_requested_corpora_were_located(&requested, &located).is_err());
    }

    #[test]
    fn concatenate_knowledge_entry_bodies_joins_non_empty_entries() {
        let documents = vec![
            stored_document("one", json!({ "content": "first passage" })),
            stored_document("two", json!({ "text": "second passage" })),
            stored_document("three", json!({ "irrelevant": "x" })),
        ];
        let concatenated = concatenate_knowledge_entry_bodies(&documents);
        assert_eq!(concatenated, "first passage\n\nsecond passage");
    }

    #[test]
    fn concatenate_knowledge_entry_bodies_handles_empty_slice() {
        let concatenated = concatenate_knowledge_entry_bodies(&[]);
        assert!(concatenated.is_empty());
    }

    #[test]
    fn truncate_returns_input_when_within_budget() {
        let text = "short".to_string();
        assert_eq!(
            truncate_concatenated_corpus_text_to_prompt_budget(text.clone(), 100),
            text
        );
    }

    #[test]
    fn truncate_shortens_and_marks_overflow() {
        let text = "abcdefghij".to_string();
        let truncated = truncate_concatenated_corpus_text_to_prompt_budget(text, 5);
        assert_eq!(truncated, "abcde…");
    }

    #[test]
    fn truncate_zero_budget_yields_empty() {
        let truncated =
            truncate_concatenated_corpus_text_to_prompt_budget("anything".to_string(), 0);
        assert!(truncated.is_empty());
    }

    #[test]
    fn build_corpus_summarization_prompt_includes_name_and_content() {
        let prompt = build_corpus_summarization_prompt(
            "Oncology Notes",
            "some body text",
            SummaryLengthPreference::Concise,
        )
        .unwrap();
        assert!(prompt.as_str().contains("Oncology Notes"));
        assert!(prompt.as_str().contains("some body text"));
        assert!(prompt.as_str().contains("concise"));
    }

    #[test]
    fn build_corpus_summarization_prompt_handles_empty_body() {
        let prompt = build_corpus_summarization_prompt(
            "Empty Corpus",
            "   ",
            SummaryLengthPreference::Detailed,
        )
        .unwrap();
        assert!(prompt.as_str().contains("no indexed knowledge entries"));
    }

    #[test]
    fn read_corpus_display_name_prefers_display_name() {
        let document = stored_document("corpus-1", json!({ "displayName": "Cardiology" }));
        assert_eq!(read_corpus_display_name(&document), "Cardiology");
    }

    #[test]
    fn read_corpus_display_name_falls_back_to_identifier() {
        let document = stored_document("corpus-2", json!({ "other": "value" }));
        assert_eq!(read_corpus_display_name(&document), "corpus-2");
    }

    #[test]
    fn build_single_corpus_summary_trims_completion_text() {
        let document = stored_document("corpus-3", json!({ "name": "Neuro" }));
        let completion = GeneratedCompletion {
            produced_text: "  a summary  ".to_string(),
        };
        let summary = build_single_corpus_summary(&document, &completion);
        assert_eq!(summary.corpus_identifier, "corpus-3");
        assert_eq!(summary.corpus_display_name, "Neuro");
        assert_eq!(summary.summary_text, "a summary");
    }

    #[test]
    fn serialize_single_corpus_summary_to_json_shapes_fields() {
        let summary = RagCorpusSummary {
            corpus_identifier: "corpus-4".to_string(),
            corpus_display_name: "Display".to_string(),
            summary_text: "text".to_string(),
            length_preference_label: "standard".to_string(),
        };
        let serialized = serialize_single_corpus_summary_to_json(&summary);
        assert_eq!(serialized["corpusIdentifier"], json!("corpus-4"));
        assert_eq!(serialized["corpusDisplayName"], json!("Display"));
        assert_eq!(serialized["summaryText"], json!("text"));
        assert_eq!(serialized["lengthPreference"], json!("standard"));
    }

    #[test]
    fn assemble_response_reports_count_and_summaries() {
        let summaries = vec![
            RagCorpusSummary {
                corpus_identifier: "a".to_string(),
                corpus_display_name: "A".to_string(),
                summary_text: "sa".to_string(),
                length_preference_label: "concise".to_string(),
            },
            RagCorpusSummary {
                corpus_identifier: "b".to_string(),
                corpus_display_name: "B".to_string(),
                summary_text: "sb".to_string(),
                length_preference_label: "detailed".to_string(),
            },
        ];
        let response = assemble_summarize_corpora_response(&summaries);
        assert_eq!(response["summarizedCorpusCount"], json!(2));
        assert_eq!(response["summaries"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn build_summary_cache_identifier_is_deterministic() {
        assert_eq!(build_summary_cache_identifier("onc"), "summary::onc");
    }

    #[test]
    fn build_requested_identifiers_value_lists_all_corpora() {
        let documents = vec![
            stored_document("c1", json!({})),
            stored_document("c2", json!({})),
        ];
        let body = build_requested_identifiers_value(&documents);
        let identifiers = extract_corpus_identifiers_to_summarize(&body).unwrap();
        assert_eq!(identifiers.len(), 2);
        assert_eq!(identifiers[0].as_str(), "c1");
    }
}
