use crate::error::ApplicationError;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A single turn of the conversation forwarded to the retrieval provider as the
/// query. Mirrors the `{ role, text }` message shape that `queryFileSearchStore`
/// receives in `app/lib/rag/fileSearchStore.ts` (via `agentInputs.server.ts`,
/// which strips system turns before querying).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrievalQueryMessage {
    /// Speaker role, e.g. `"user"` or `"model"`.
    pub role: String,
    /// The message text.
    pub text: String,
}

/// A single passage returned by the retrieval provider.
///
/// This mirrors the subset of `DebugSourceChunk` (`app/lib/answerDebug.ts`) that
/// downstream prompt assembly consumes when it builds the `<corpus_evidence>`
/// block: `{ id, filename, title, page, text }`. Every field except `index` is
/// optional because Gemini grounding chunks populate them opportunistically; the
/// downstream serializer is responsible for omitting `None` keys.
///
/// `index` is the provider-order position (1-based). File Search grounding chunks
/// carry no relevance score, so ordering — not a score — is the sole signal, and
/// implementations MUST preserve the provider's chunk order (see
/// [`RetrievalPort::retrieve`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrievedEvidence {
    /// 1-based position in provider order; used as the `[n]` citation marker.
    pub index: usize,
    /// Human-readable document title, when the provider supplies one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Originating file name, when the provider supplies one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    /// Source URI, when the provider supplies one. Mirrors `DebugSourceChunk.uri`
    /// (`app/lib/answerDebug.ts`); step-QC's `sourceDoc` falls back to it when the
    /// title is absent (`step-qc/route.ts`), so the port must carry it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// Page number within the source document, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    /// The retrieved passage text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// The outcome of a retrieval call: the ordered passages plus the grounding flag.
///
/// `is_grounded` cannot be derived from `passages` alone — the offline lexical
/// Jaccard fallback returns a **non-empty** passage list that must nonetheless
/// report `is_grounded == false`, while File Search results with passages report
/// `true`. Both are non-empty `Vec`s, so the flag must be carried explicitly
/// (mirrors the reference surfacing `isGrounded`; the acceptance curl asserts
/// `isGrounded: true`, and the SPA shows it per step).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrievalResult {
    /// Evidence passages in provider order (`index` is the 1-based position).
    pub passages: Vec<RetrievedEvidence>,
    /// Whether the passages came from real corpus grounding (File Search) rather
    /// than the ungrounded offline fallback.
    pub is_grounded: bool,
}

/// Retrieval seam over a corpus provider (Gemini File Search in production, a
/// lexical fallback offline). Mirrors the query path of
/// `app/lib/rag/fileSearchStore.ts` reached through `agentInputs.server.ts`.
#[async_trait]
pub trait RetrievalPort: Send + Sync {
    /// Retrieve evidence passages for `query_messages` scoped to `corpus_identifiers`.
    ///
    /// - `corpus_identifiers` — the corpora / File Search stores to search across.
    /// - `query_messages` — the conversation turns used as the query (system turns
    ///   are expected to already be excluded by the caller).
    /// - `document_selections` — optional per-corpus document scoping (document
    ///   identifiers), corresponding to `StepCorpusInput.documentSelections`.
    /// - `metadata_filter` — optional raw metadata-filter expression,
    ///   corresponding to `StepCorpusInput.metadataFilter`.
    ///
    /// Returns a [`RetrievalResult`]: evidence in **provider order**
    /// (grounding-chunk order), with `index` assigned as the monotonic 1-based
    /// position, plus the `is_grounded` flag. Implementations MUST NOT re-sort by
    /// any synthetic relevance score, because that order drives both the citation
    /// `[n]` numbering and the step-QC `sourceDoc` mapping. The offline fallback
    /// returns non-empty passages with `is_grounded == false`; only real corpus
    /// grounding sets `is_grounded == true`.
    async fn retrieve(
        &self,
        corpus_identifiers: &[String],
        query_messages: &[RetrievalQueryMessage],
        document_selections: Option<&[String]>,
        metadata_filter: Option<&str>,
    ) -> Result<RetrievalResult, ApplicationError>;
}
