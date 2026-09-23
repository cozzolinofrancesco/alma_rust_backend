use crate::categories::rag::collections::{
    RAG_CORPORA_COLLECTION_NAME, RAG_KNOWLEDGE_COLLECTION_NAME,
};
use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::ai::{ArtificialIntelligencePort, GeneratedCompletion};
use alma_application::ports::document_collection::{DocumentCollectionPort, StoredDocument};
use alma_application::ports::retrieval::{
    RetrievalPort, RetrievalQueryMessage, RetrievedEvidence,
};
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

/// A single turn in the conversation history supplied alongside the question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagConversationMessage {
    pub speaker_role: String,
    pub message_content: String,
}

/// A knowledge passage selected as relevant to the current question.
#[derive(Debug, Clone, PartialEq)]
pub struct RetrievedPassage {
    pub source_document_identifier: String,
    pub source_corpus_identifier: Option<String>,
    pub passage_text: String,
    pub relevance_score: f64,
}

/// A citation reference derived from a retrieved passage, ready for serialization.
#[derive(Debug, Clone, PartialEq)]
pub struct RagCitationReference {
    pub document_identifier: String,
    pub corpus_identifier: Option<String>,
    pub excerpt: String,
    pub relevance_score: f64,
}

#[route(method = "POST", path = "/api/rag/query")]
pub async fn query_rag_handler<TransactionalUnitOfWork>(
    State(application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
    Json(submitted_body): Json<Value>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    let user_question = extract_user_question_from_body(&submitted_body)?;
    let conversation_history = extract_conversation_history_messages(&submitted_body);
    let corpus_identifiers = extract_target_corpus_identifiers(&submitted_body);

    // Validate the requested corpora actually exist / are readable before retrieval.
    let _target_corpora =
        load_target_corpus_documents(&application_state.document_collection, &corpus_identifiers)
            .await?;

    // Keep the knowledge entries loaded: they back the offline lexical Jaccard
    // fallback used when real retrieval is unavailable or returns nothing.
    let knowledge_documents = load_knowledge_entries_for_corpora(
        &application_state.document_collection,
        &corpus_identifiers,
    )
    .await?;

    let requested_document_selections = extract_requested_document_selections(&submitted_body);
    let requested_metadata_filter = extract_requested_metadata_filter(&submitted_body);

    let (retrieved_passages, answer_is_grounded) = retrieve_relevant_knowledge_passages(
        &application_state.retrieval_adapter,
        &knowledge_documents,
        &user_question,
        &conversation_history,
        &corpus_identifiers,
        if requested_document_selections.is_empty() {
            None
        } else {
            Some(requested_document_selections.as_slice())
        },
        requested_metadata_filter.as_deref(),
        5,
    )
    .await;

    let augmented_prompt = assemble_retrieval_augmented_prompt(
        &user_question,
        &conversation_history,
        &retrieved_passages,
    )?;

    let generated_completion = generate_grounded_answer_completion(
        &application_state.artificial_intelligence_adapter,
        &augmented_prompt,
    )
    .await?;

    let citation_references = build_citation_references_from_passages(&retrieved_passages);

    record_query_interaction_document(
        &application_state.document_collection,
        authorized_request.authorized_principal(),
        &user_question,
        &generated_completion.produced_text,
    )
    .await?;

    let response_payload =
        assemble_query_response(&generated_completion, &citation_references, answer_is_grounded);
    Ok(Json(response_payload))
}

/// 1. Extract the user's question from either a `question` field or the last chat message.
fn extract_user_question_from_body(submitted_body: &Value) -> Result<NonEmptyText, HttpError> {
    let candidate_question = submitted_body
        .get("question")
        .and_then(|question_value| question_value.as_str())
        .map(|question_value| question_value.to_string())
        .or_else(|| {
            submitted_body
                .get("messages")
                .and_then(|messages_value| messages_value.as_array())
                .and_then(|messages_array| messages_array.last())
                .and_then(|last_message| last_message.get("content"))
                .and_then(|content_value| content_value.as_str())
                .map(|content_value| content_value.to_string())
        })
        .map(|candidate| candidate.trim().to_string())
        .filter(|candidate| !candidate.is_empty());

    match candidate_question {
        Some(question_text) => {
            NonEmptyText::parse(question_text).map_err(|parse_error| {
                HttpError::RequestBodyWasMalformed {
                    explanation: parse_error.to_string(),
                }
            })
        }
        None => Err(HttpError::RequestBodyWasMalformed {
            explanation: String::from("A non-empty 'question' or chat message is required."),
        }),
    }
}

/// 2. Extract the ordered conversation history preceding the current question.
fn extract_conversation_history_messages(submitted_body: &Value) -> Vec<RagConversationMessage> {
    let messages_array = match submitted_body
        .get("messages")
        .and_then(|messages_value| messages_value.as_array())
    {
        Some(messages_array) => messages_array,
        None => return Vec::new(),
    };

    let mut parsed_messages = Vec::new();
    for raw_message in messages_array {
        if let Some(conversation_message) = parse_single_conversation_message(raw_message) {
            parsed_messages.push(conversation_message);
        }
    }
    parsed_messages
}

/// 3. Parse a single raw message object into a structured conversation message.
fn parse_single_conversation_message(raw_message: &Value) -> Option<RagConversationMessage> {
    let message_content = raw_message
        .get("content")
        .and_then(|content_value| content_value.as_str())
        .map(|content_value| content_value.trim().to_string())
        .filter(|content_value| !content_value.is_empty())?;

    let speaker_role = raw_message
        .get("role")
        .and_then(|role_value| role_value.as_str())
        .map(|role_value| role_value.trim().to_lowercase())
        .filter(|role_value| !role_value.is_empty())
        .unwrap_or_else(|| String::from("user"));

    Some(RagConversationMessage {
        speaker_role,
        message_content,
    })
}

/// 4. Extract the identifiers of the corpora the query should be scoped to.
fn extract_target_corpus_identifiers(submitted_body: &Value) -> Vec<String> {
    let mut identifiers = Vec::new();

    if let Some(array_value) = submitted_body
        .get("corpus_identifiers")
        .and_then(|value| value.as_array())
    {
        for element in array_value {
            if let Some(identifier) = element
                .as_str()
                .map(|raw| raw.trim().to_string())
                .filter(|raw| !raw.is_empty())
            {
                identifiers.push(identifier);
            }
        }
    }

    if let Some(single_identifier) = submitted_body
        .get("corpus_identifier")
        .and_then(|value| value.as_str())
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
    {
        identifiers.push(single_identifier);
    }

    identifiers.sort();
    identifiers.dedup();
    identifiers
}

/// 5. Load the corpus documents matching the requested identifiers.
async fn load_target_corpus_documents(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifiers: &[String],
) -> Result<Vec<StoredDocument>, HttpError> {
    if corpus_identifiers.is_empty() {
        return Ok(Vec::new());
    }

    let mut matched_corpora = Vec::new();
    for corpus_identifier in corpus_identifiers {
        if let Some(corpus_document) = document_collection
            .fetch_document(RAG_CORPORA_COLLECTION_NAME, corpus_identifier)
            .await?
        {
            matched_corpora.push(corpus_document);
        }
    }
    Ok(matched_corpora)
}

/// 6. Load the knowledge entries belonging to the requested corpora (or all when unscoped).
async fn load_knowledge_entries_for_corpora(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    corpus_identifiers: &[String],
) -> Result<Vec<StoredDocument>, HttpError> {
    let all_knowledge = document_collection
        .list_documents(RAG_KNOWLEDGE_COLLECTION_NAME)
        .await?;

    if corpus_identifiers.is_empty() {
        return Ok(all_knowledge);
    }

    let scoped_knowledge = all_knowledge
        .into_iter()
        .filter(|knowledge_document| {
            knowledge_document
                .document_body
                .get("corpus_identifier")
                .and_then(|value| value.as_str())
                .map(|corpus_identifier| {
                    corpus_identifiers
                        .iter()
                        .any(|requested| requested == corpus_identifier)
                })
                .unwrap_or(false)
        })
        .collect();
    Ok(scoped_knowledge)
}

/// 7. Read the textual body of a knowledge entry from its stored document.
fn read_knowledge_entry_body_text(knowledge_document: &StoredDocument) -> Option<String> {
    for candidate_key in ["text", "content", "body", "passage"] {
        if let Some(text_value) = knowledge_document
            .document_body
            .get(candidate_key)
            .and_then(|value| value.as_str())
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty())
        {
            return Some(text_value);
        }
    }
    None
}

/// 8. Retrieve the most relevant knowledge passages for the question via the
///    `RetrievalPort` (Gemini File Search in production), preserving provider
///    (grounding-chunk) order for citation numbering. Falls back to the offline
///    lexical Jaccard scan over the loaded knowledge documents when retrieval is
///    unavailable (adapter error) or returns no passages.
async fn retrieve_relevant_knowledge_passages(
    retrieval_adapter: &Arc<dyn RetrievalPort>,
    knowledge_documents: &[StoredDocument],
    user_question: &NonEmptyText,
    conversation_history: &[RagConversationMessage],
    corpus_identifiers: &[String],
    document_selections: Option<&[String]>,
    metadata_filter: Option<&str>,
    maximum_fallback_passages: usize,
) -> (Vec<RetrievedPassage>, bool) {
    let query_messages = build_retrieval_query_messages(user_question, conversation_history);

    match retrieval_adapter
        .retrieve(
            corpus_identifiers,
            &query_messages,
            document_selections,
            metadata_filter,
        )
        .await
    {
        // Real retrieval succeeded with evidence: use provider order verbatim and
        // surface the provider's grounding flag (plan C6 — `isGrounded`). The
        // lexical fallback below is never grounded even though it returns
        // non-empty passages, so the flag is carried explicitly here.
        Ok(retrieval_result) if !retrieval_result.passages.is_empty() => (
            map_retrieved_evidence_to_passages(&retrieval_result.passages),
            retrieval_result.is_grounded,
        ),
        // Retrieval unavailable (adapter error) or empty: offline lexical fallback
        // is ungrounded by definition.
        _ => (
            select_relevant_knowledge_passages(
                knowledge_documents,
                user_question,
                maximum_fallback_passages,
            ),
            false,
        ),
    }
}

/// Build the ordered `{ role, text }` query turns handed to the retrieval
/// provider: system turns are stripped and the current question is guaranteed to
/// be the final user turn (mirrors how `agentInputs.server.ts` strips system
/// turns before querying `queryFileSearchStore`).
fn build_retrieval_query_messages(
    user_question: &NonEmptyText,
    conversation_history: &[RagConversationMessage],
) -> Vec<RetrievalQueryMessage> {
    let mut query_messages: Vec<RetrievalQueryMessage> = conversation_history
        .iter()
        .filter(|message| message.speaker_role != "system")
        .map(|message| RetrievalQueryMessage {
            role: message.speaker_role.clone(),
            text: message.message_content.clone(),
        })
        .collect();

    let question_is_already_final_turn = query_messages
        .last()
        .map(|message| message.text == user_question.as_str())
        .unwrap_or(false);
    if !question_is_already_final_turn {
        query_messages.push(RetrievalQueryMessage {
            role: String::from("user"),
            text: user_question.as_str().to_string(),
        });
    }

    query_messages
}

/// Map provider evidence to citation-ready passages, **preserving provider order
/// verbatim** (no relevance / doc-id re-sort). Grounding chunks carry no score,
/// so a monotonic-decreasing synthetic score is assigned by position — provider
/// order alone drives the `[n]` citation numbering and the step-QC `sourceDoc`.
fn map_retrieved_evidence_to_passages(
    retrieved_evidence: &[RetrievedEvidence],
) -> Vec<RetrievedPassage> {
    retrieved_evidence
        .iter()
        .map(|evidence| {
            let source_document_identifier = evidence
                .title
                .clone()
                .or_else(|| evidence.file_name.clone())
                .or_else(|| evidence.uri.clone())
                .unwrap_or_else(|| format!("source-{}", evidence.index));
            RetrievedPassage {
                source_document_identifier,
                source_corpus_identifier: None,
                passage_text: evidence.text.clone().unwrap_or_default(),
                relevance_score: 1.0 / (evidence.index.max(1) as f64),
            }
        })
        .collect()
}

/// Extract optional per-corpus document scoping identifiers
/// (`documentSelections`) from the request body, if supplied.
fn extract_requested_document_selections(submitted_body: &Value) -> Vec<String> {
    let mut selections = Vec::new();
    if let Some(array_value) = submitted_body
        .get("document_selections")
        .and_then(|value| value.as_array())
    {
        for element in array_value {
            if let Some(selection) = element
                .as_str()
                .map(|raw| raw.trim().to_string())
                .filter(|raw| !raw.is_empty())
            {
                selections.push(selection);
            }
        }
    }
    selections
}

/// Extract an optional raw metadata-filter expression from the request body.
fn extract_requested_metadata_filter(submitted_body: &Value) -> Option<String> {
    submitted_body
        .get("metadata_filter")
        .and_then(|value| value.as_str())
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

/// 9. Offline lexical fallback: select the most relevant knowledge passages for
///    the question via token overlap, capped at `maximum_passages`. Used only
///    when the `RetrievalPort` is unavailable or returns nothing.
fn select_relevant_knowledge_passages(
    knowledge_documents: &[StoredDocument],
    user_question: &NonEmptyText,
    maximum_passages: usize,
) -> Vec<RetrievedPassage> {
    let mut scored_passages: Vec<RetrievedPassage> = knowledge_documents
        .iter()
        .filter_map(|knowledge_document| {
            let passage_text = read_knowledge_entry_body_text(knowledge_document)?;
            let relevance_score =
                score_passage_relevance_against_question(&passage_text, user_question);
            if relevance_score <= 0.0 {
                return None;
            }
            let source_corpus_identifier = knowledge_document
                .document_body
                .get("corpus_identifier")
                .and_then(|value| value.as_str())
                .map(|raw| raw.to_string());
            Some(RetrievedPassage {
                source_document_identifier: knowledge_document.document_identifier.clone(),
                source_corpus_identifier,
                passage_text,
                relevance_score,
            })
        })
        .collect();

    scored_passages.sort_by(|left, right| {
        right
            .relevance_score
            .partial_cmp(&left.relevance_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.source_document_identifier
                    .cmp(&right.source_document_identifier)
            })
    });

    if maximum_passages > 0 {
        scored_passages.truncate(maximum_passages);
    }
    scored_passages
}

/// Helper: score how relevant a passage is to the question via token overlap (Jaccard-like).
fn score_passage_relevance_against_question(passage_text: &str, user_question: &NonEmptyText) -> f64 {
    let question_tokens = tokenize_lowercase_words(user_question.as_str());
    if question_tokens.is_empty() {
        return 0.0;
    }
    let passage_tokens = tokenize_lowercase_words(passage_text);
    if passage_tokens.is_empty() {
        return 0.0;
    }

    let mut overlap_count = 0usize;
    for question_token in &question_tokens {
        if passage_tokens.iter().any(|token| token == question_token) {
            overlap_count += 1;
        }
    }

    overlap_count as f64 / question_tokens.len() as f64
}

/// Helper: split text into lowercase alphanumeric word tokens, dropping trivial stop-length tokens.
fn tokenize_lowercase_words(input_text: &str) -> Vec<String> {
    input_text
        .split(|character: char| !character.is_alphanumeric())
        .filter(|fragment| fragment.len() > 2)
        .map(|fragment| fragment.to_lowercase())
        .collect()
}

/// 10. Assemble the retrieval-augmented prompt combining context, history and the question.
fn assemble_retrieval_augmented_prompt(
    user_question: &NonEmptyText,
    conversation_history: &[RagConversationMessage],
    retrieved_passages: &[RetrievedPassage],
) -> Result<NonEmptyText, HttpError> {
    let mut prompt_builder = String::new();
    prompt_builder.push_str(
        "You are a retrieval-augmented assistant. Answer using only the provided context. \
         If the context is insufficient, say so explicitly.\n\n",
    );

    prompt_builder.push_str("### Context passages\n");
    if retrieved_passages.is_empty() {
        prompt_builder.push_str("(no relevant context passages were retrieved)\n");
    } else {
        for (passage_index, passage) in retrieved_passages.iter().enumerate() {
            prompt_builder.push_str(&format!(
                "[{}] (source: {}) {}\n",
                passage_index + 1,
                passage.source_document_identifier,
                passage.passage_text
            ));
        }
    }
    prompt_builder.push('\n');

    if !conversation_history.is_empty() {
        prompt_builder.push_str("### Conversation history\n");
        for message in conversation_history {
            prompt_builder.push_str(&format!(
                "{}: {}\n",
                message.speaker_role, message.message_content
            ));
        }
        prompt_builder.push('\n');
    }

    prompt_builder.push_str("### Question\n");
    prompt_builder.push_str(user_question.as_str());
    prompt_builder.push_str("\n\n### Answer\n");

    NonEmptyText::parse(prompt_builder).map_err(|parse_error| HttpError::UpstreamApplicationFailure {
        explanation: parse_error.to_string(),
    })
}

/// 11. Generate the grounded answer completion from the AI adapter.
async fn generate_grounded_answer_completion(
    artificial_intelligence_adapter: &Arc<dyn ArtificialIntelligencePort>,
    augmented_prompt: &NonEmptyText,
) -> Result<GeneratedCompletion, HttpError> {
    let generated_completion = artificial_intelligence_adapter
        .generate_completion(augmented_prompt)
        .await?;
    Ok(generated_completion)
}

/// 12. Build citation references from the retrieved passages.
fn build_citation_references_from_passages(
    retrieved_passages: &[RetrievedPassage],
) -> Vec<RagCitationReference> {
    retrieved_passages
        .iter()
        .map(|passage| RagCitationReference {
            document_identifier: passage.source_document_identifier.clone(),
            corpus_identifier: passage.source_corpus_identifier.clone(),
            excerpt: truncate_excerpt(&passage.passage_text, 240),
            relevance_score: passage.relevance_score,
        })
        .collect()
}

/// Helper: truncate a passage into a short excerpt with an ellipsis when trimmed.
fn truncate_excerpt(passage_text: &str, maximum_characters: usize) -> String {
    let trimmed_text = passage_text.trim();
    if trimmed_text.chars().count() <= maximum_characters {
        return trimmed_text.to_string();
    }
    let truncated: String = trimmed_text.chars().take(maximum_characters).collect();
    format!("{truncated}...")
}

/// 13. Serialize a single citation reference into a JSON value.
fn serialize_single_citation_reference_to_json(citation_reference: &RagCitationReference) -> Value {
    json!({
        "document_identifier": citation_reference.document_identifier,
        "corpus_identifier": citation_reference.corpus_identifier,
        "excerpt": citation_reference.excerpt,
        "relevance_score": citation_reference.relevance_score,
    })
}

/// 14. Persist a record of this query interaction for auditing / history.
async fn record_query_interaction_document(
    document_collection: &Arc<dyn DocumentCollectionPort>,
    requesting_account: &Email,
    user_question: &NonEmptyText,
    produced_answer: &str,
) -> Result<(), HttpError> {
    let interaction_identifier = Uuid::new_v4().to_string();
    let interaction_document = StoredDocument {
        document_identifier: interaction_identifier,
        owning_account: Some(requesting_account.as_str().to_string()),
        document_body: json!({
            "kind": "rag_query_interaction",
            "question": user_question.as_str(),
            "answer": produced_answer,
            "requested_by": requesting_account.as_str(),
        }),
    };
    document_collection
        .insert_document(RAG_KNOWLEDGE_COLLECTION_NAME, interaction_document)
        .await?;
    Ok(())
}

/// 15. Assemble the final HTTP response payload.
///
/// `isGrounded` (camelCase, matching the reference `app/api/rag/query/route.ts`
/// shape and the Phase 1 acceptance curl) reports whether the answer was backed
/// by real corpus grounding (File Search) rather than the ungrounded lexical
/// fallback (plan C6 / Parity requirements).
fn assemble_query_response(
    generated_completion: &GeneratedCompletion,
    citation_references: &[RagCitationReference],
    answer_is_grounded: bool,
) -> Value {
    let serialized_citations: Vec<Value> = citation_references
        .iter()
        .map(serialize_single_citation_reference_to_json)
        .collect();

    json!({
        "response": generated_completion.produced_text,
        "citations": serialized_citations,
        "citation_count": citation_references.len(),
        "isGrounded": answer_is_grounded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_knowledge(identifier: &str, corpus: &str, text: &str) -> StoredDocument {
        StoredDocument {
            document_identifier: identifier.to_string(),
            owning_account: None,
            document_body: json!({ "corpus_identifier": corpus, "text": text }),
        }
    }

    #[test]
    fn extract_user_question_reads_direct_field() {
        let body = json!({ "question": "  What is RAG?  " });
        let question = extract_user_question_from_body(&body).expect("should parse");
        assert_eq!(question.as_str(), "What is RAG?");
    }

    #[test]
    fn extract_user_question_falls_back_to_last_message() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "hi" },
                { "role": "user", "content": "explain embeddings" }
            ]
        });
        let question = extract_user_question_from_body(&body).expect("should parse");
        assert_eq!(question.as_str(), "explain embeddings");
    }

    #[test]
    fn extract_user_question_rejects_empty() {
        let body = json!({ "question": "   " });
        assert!(extract_user_question_from_body(&body).is_err());
    }

    #[test]
    fn extract_conversation_history_parses_valid_and_skips_empty() {
        let body = json!({
            "messages": [
                { "role": "User", "content": "first" },
                { "content": "" },
                { "content": "second" }
            ]
        });
        let history = extract_conversation_history_messages(&body);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].speaker_role, "user");
        assert_eq!(history[1].message_content, "second");
    }

    #[test]
    fn extract_conversation_history_empty_when_absent() {
        let body = json!({ "question": "x" });
        assert!(extract_conversation_history_messages(&body).is_empty());
    }

    #[test]
    fn parse_single_conversation_message_defaults_role() {
        let raw = json!({ "content": "hello" });
        let parsed = parse_single_conversation_message(&raw).expect("valid");
        assert_eq!(parsed.speaker_role, "user");
        assert_eq!(parsed.message_content, "hello");
    }

    #[test]
    fn parse_single_conversation_message_rejects_blank_content() {
        let raw = json!({ "role": "assistant", "content": "   " });
        assert!(parse_single_conversation_message(&raw).is_none());
    }

    #[test]
    fn extract_target_corpus_identifiers_merges_and_dedups() {
        let body = json!({
            "corpus_identifiers": ["b", "a", "a"],
            "corpus_identifier": "c"
        });
        let identifiers = extract_target_corpus_identifiers(&body);
        assert_eq!(identifiers, vec!["a", "b", "c"]);
    }

    #[test]
    fn extract_target_corpus_identifiers_empty_when_missing() {
        let body = json!({ "question": "x" });
        assert!(extract_target_corpus_identifiers(&body).is_empty());
    }

    #[test]
    fn read_knowledge_entry_body_text_prefers_text_key() {
        let doc = stored_knowledge("d1", "c1", "some body");
        assert_eq!(read_knowledge_entry_body_text(&doc), Some("some body".to_string()));
    }

    #[test]
    fn read_knowledge_entry_body_text_none_when_empty() {
        let doc = StoredDocument {
            document_identifier: "d1".to_string(),
            owning_account: None,
            document_body: json!({ "corpus_identifier": "c1", "text": "  " }),
        };
        assert!(read_knowledge_entry_body_text(&doc).is_none());
    }

    #[test]
    fn score_passage_relevance_counts_overlap() {
        let question = NonEmptyText::parse("machine learning models".to_string()).unwrap();
        let high = score_passage_relevance_against_question(
            "machine learning models are trained on data",
            &question,
        );
        let low = score_passage_relevance_against_question("bananas are yellow fruits", &question);
        assert!(high > low);
        assert!(high > 0.0);
        assert_eq!(low, 0.0);
    }

    #[test]
    fn score_passage_relevance_zero_for_empty_passage() {
        let question = NonEmptyText::parse("anything here".to_string()).unwrap();
        assert_eq!(score_passage_relevance_against_question("", &question), 0.0);
    }

    #[test]
    fn select_relevant_knowledge_passages_ranks_and_caps() {
        let question = NonEmptyText::parse("neural network training".to_string()).unwrap();
        let docs = vec![
            stored_knowledge("d1", "c1", "neural network training explained in detail"),
            stored_knowledge("d2", "c1", "network training tips"),
            stored_knowledge("d3", "c1", "completely unrelated cooking recipe"),
        ];
        let selected = select_relevant_knowledge_passages(&docs, &question, 2);
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].source_document_identifier, "d1");
        assert!(selected[0].relevance_score >= selected[1].relevance_score);
    }

    #[test]
    fn select_relevant_knowledge_passages_empty_when_no_overlap() {
        let question = NonEmptyText::parse("quantum physics".to_string()).unwrap();
        let docs = vec![stored_knowledge("d1", "c1", "gardening and flowers")];
        assert!(select_relevant_knowledge_passages(&docs, &question, 5).is_empty());
    }

    #[test]
    fn assemble_retrieval_augmented_prompt_includes_question_and_context() {
        let question = NonEmptyText::parse("what is x".to_string()).unwrap();
        let history = vec![RagConversationMessage {
            speaker_role: "user".to_string(),
            message_content: "prior".to_string(),
        }];
        let passages = vec![RetrievedPassage {
            source_document_identifier: "d1".to_string(),
            source_corpus_identifier: Some("c1".to_string()),
            passage_text: "context body".to_string(),
            relevance_score: 0.5,
        }];
        let prompt = assemble_retrieval_augmented_prompt(&question, &history, &passages).unwrap();
        assert!(prompt.as_str().contains("what is x"));
        assert!(prompt.as_str().contains("context body"));
        assert!(prompt.as_str().contains("prior"));
    }

    #[test]
    fn assemble_retrieval_augmented_prompt_handles_no_passages() {
        let question = NonEmptyText::parse("q".to_string()).unwrap();
        let prompt = assemble_retrieval_augmented_prompt(&question, &[], &[]).unwrap();
        assert!(prompt.as_str().contains("no relevant context"));
    }

    #[test]
    fn build_citation_references_maps_fields() {
        let passages = vec![RetrievedPassage {
            source_document_identifier: "d1".to_string(),
            source_corpus_identifier: Some("c1".to_string()),
            passage_text: "excerpt text".to_string(),
            relevance_score: 0.75,
        }];
        let citations = build_citation_references_from_passages(&passages);
        assert_eq!(citations.len(), 1);
        assert_eq!(citations[0].document_identifier, "d1");
        assert_eq!(citations[0].relevance_score, 0.75);
    }

    #[test]
    fn truncate_excerpt_appends_ellipsis_when_long() {
        let long_text = "a".repeat(300);
        let excerpt = truncate_excerpt(&long_text, 10);
        assert!(excerpt.ends_with("..."));
        assert_eq!(excerpt.chars().count(), 13);
    }

    #[test]
    fn truncate_excerpt_keeps_short_text() {
        assert_eq!(truncate_excerpt("  short  ", 100), "short");
    }

    #[test]
    fn serialize_single_citation_reference_to_json_shape() {
        let citation = RagCitationReference {
            document_identifier: "d1".to_string(),
            corpus_identifier: Some("c1".to_string()),
            excerpt: "ex".to_string(),
            relevance_score: 0.5,
        };
        let value = serialize_single_citation_reference_to_json(&citation);
        assert_eq!(value.get("document_identifier").unwrap(), "d1");
        assert_eq!(value.get("corpus_identifier").unwrap(), "c1");
    }

    #[test]
    fn assemble_query_response_includes_citations_count() {
        let completion = GeneratedCompletion {
            produced_text: "the answer".to_string(),
        };
        let citations = vec![RagCitationReference {
            document_identifier: "d1".to_string(),
            corpus_identifier: None,
            excerpt: "ex".to_string(),
            relevance_score: 0.5,
        }];
        let response = assemble_query_response(&completion, &citations, true);
        assert_eq!(response.get("response").unwrap(), "the answer");
        assert_eq!(response.get("citation_count").unwrap(), 1);
        assert_eq!(response.get("citations").unwrap().as_array().unwrap().len(), 1);
        assert_eq!(response.get("isGrounded").unwrap(), &json!(true));
    }

    #[test]
    fn assemble_query_response_surfaces_ungrounded_flag() {
        let completion = GeneratedCompletion {
            produced_text: "fallback answer".to_string(),
        };
        let response = assemble_query_response(&completion, &[], false);
        assert_eq!(response.get("isGrounded").unwrap(), &json!(false));
        assert_eq!(response.get("citation_count").unwrap(), 0);
    }

    // Minimal RetrievalPort stubs exercising the grounded vs. lexical-fallback
    // branches of `retrieve_relevant_knowledge_passages` (plan C6 — `isGrounded`).
    struct GroundedRetrievalStub;

    #[async_trait::async_trait]
    impl RetrievalPort for GroundedRetrievalStub {
        async fn retrieve(
            &self,
            _corpus_identifiers: &[String],
            _query_messages: &[RetrievalQueryMessage],
            _document_selections: Option<&[String]>,
            _metadata_filter: Option<&str>,
        ) -> Result<
            alma_application::ports::retrieval::RetrievalResult,
            alma_application::error::ApplicationError,
        > {
            Ok(alma_application::ports::retrieval::RetrievalResult {
                passages: vec![RetrievedEvidence {
                    index: 1,
                    title: Some("Grounded Doc".to_string()),
                    file_name: None,
                    uri: None,
                    page: None,
                    text: Some("grounded passage".to_string()),
                }],
                is_grounded: true,
            })
        }
    }

    struct FailingRetrievalStub;

    #[async_trait::async_trait]
    impl RetrievalPort for FailingRetrievalStub {
        async fn retrieve(
            &self,
            _corpus_identifiers: &[String],
            _query_messages: &[RetrievalQueryMessage],
            _document_selections: Option<&[String]>,
            _metadata_filter: Option<&str>,
        ) -> Result<
            alma_application::ports::retrieval::RetrievalResult,
            alma_application::error::ApplicationError,
        > {
            Err(
                alma_application::error::ApplicationError::ArtificialIntelligenceAdapterFailure {
                    failure_description: "retrieval offline".to_string(),
                },
            )
        }
    }

    #[tokio::test]
    async fn retrieve_reports_grounded_true_on_provider_evidence() {
        let adapter: Arc<dyn RetrievalPort> = Arc::new(GroundedRetrievalStub);
        let question = NonEmptyText::parse("what dose".to_string()).unwrap();
        let (passages, is_grounded) = retrieve_relevant_knowledge_passages(
            &adapter,
            &[],
            &question,
            &[],
            &["corpus-a".to_string()],
            None,
            None,
            5,
        )
        .await;
        assert!(is_grounded);
        assert_eq!(passages.len(), 1);
        assert_eq!(passages[0].source_document_identifier, "Grounded Doc");
    }

    #[tokio::test]
    async fn retrieve_reports_grounded_false_on_lexical_fallback() {
        let adapter: Arc<dyn RetrievalPort> = Arc::new(FailingRetrievalStub);
        let question = NonEmptyText::parse("neural network training".to_string()).unwrap();
        let docs = vec![stored_knowledge(
            "d1",
            "corpus-a",
            "neural network training explained",
        )];
        let (passages, is_grounded) = retrieve_relevant_knowledge_passages(
            &adapter,
            &docs,
            &question,
            &[],
            &["corpus-a".to_string()],
            None,
            None,
            5,
        )
        .await;
        assert!(!is_grounded);
        assert!(!passages.is_empty());
    }

    fn provider_evidence(
        index: usize,
        title: Option<&str>,
        file_name: Option<&str>,
        uri: Option<&str>,
        text: Option<&str>,
    ) -> RetrievedEvidence {
        RetrievedEvidence {
            index,
            title: title.map(str::to_string),
            file_name: file_name.map(str::to_string),
            uri: uri.map(str::to_string),
            page: None,
            text: text.map(str::to_string),
        }
    }

    #[test]
    fn build_retrieval_query_messages_strips_system_and_appends_question() {
        let question = NonEmptyText::parse("what dose was used".to_string()).unwrap();
        let history = vec![
            RagConversationMessage {
                speaker_role: "system".to_string(),
                message_content: "you are helpful".to_string(),
            },
            RagConversationMessage {
                speaker_role: "user".to_string(),
                message_content: "earlier turn".to_string(),
            },
        ];
        let messages = build_retrieval_query_messages(&question, &history);
        // System turn dropped; earlier turn kept; question appended as final user turn.
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "earlier turn");
        assert_eq!(messages[1].role, "user");
        assert_eq!(messages[1].text, "what dose was used");
    }

    #[test]
    fn build_retrieval_query_messages_does_not_duplicate_trailing_question() {
        let question = NonEmptyText::parse("explain embeddings".to_string()).unwrap();
        let history = vec![RagConversationMessage {
            speaker_role: "user".to_string(),
            message_content: "explain embeddings".to_string(),
        }];
        let messages = build_retrieval_query_messages(&question, &history);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "explain embeddings");
    }

    #[test]
    fn build_retrieval_query_messages_from_empty_history() {
        let question = NonEmptyText::parse("standalone question".to_string()).unwrap();
        let messages = build_retrieval_query_messages(&question, &[]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "standalone question");
    }

    #[test]
    fn map_retrieved_evidence_preserves_provider_order() {
        let evidence = vec![
            provider_evidence(1, Some("Doc A"), None, None, Some("first")),
            provider_evidence(2, Some("Doc B"), None, None, Some("second")),
            provider_evidence(3, Some("Doc C"), None, None, Some("third")),
        ];
        let passages = map_retrieved_evidence_to_passages(&evidence);
        // Order is the provider order verbatim — no relevance / doc-id re-sort.
        assert_eq!(passages[0].source_document_identifier, "Doc A");
        assert_eq!(passages[1].source_document_identifier, "Doc B");
        assert_eq!(passages[2].source_document_identifier, "Doc C");
        // Synthetic scores are strictly monotonic-decreasing by position.
        assert!(passages[0].relevance_score > passages[1].relevance_score);
        assert!(passages[1].relevance_score > passages[2].relevance_score);
        assert_eq!(passages[0].passage_text, "first");
    }

    #[test]
    fn map_retrieved_evidence_identifier_falls_back_across_fields() {
        let evidence = vec![
            provider_evidence(1, None, Some("file.pdf"), None, Some("a")),
            provider_evidence(2, None, None, Some("gs://bucket/x"), Some("b")),
            provider_evidence(3, None, None, None, Some("c")),
        ];
        let passages = map_retrieved_evidence_to_passages(&evidence);
        assert_eq!(passages[0].source_document_identifier, "file.pdf");
        assert_eq!(passages[1].source_document_identifier, "gs://bucket/x");
        assert_eq!(passages[2].source_document_identifier, "source-3");
    }

    #[test]
    fn extract_requested_document_selections_reads_and_trims() {
        let body = json!({ "document_selections": ["  d1 ", "", "d2"] });
        assert_eq!(
            extract_requested_document_selections(&body),
            vec!["d1".to_string(), "d2".to_string()]
        );
    }

    #[test]
    fn extract_requested_metadata_filter_reads_and_trims() {
        let body = json!({ "metadata_filter": "  study = '272' " });
        assert_eq!(
            extract_requested_metadata_filter(&body),
            Some("study = '272'".to_string())
        );
        assert!(extract_requested_metadata_filter(&json!({})).is_none());
    }
}
