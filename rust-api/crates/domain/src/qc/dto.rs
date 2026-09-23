//! Data structures for claim-level document validation.
//!
//! Ports the information model of *"Document Validation: A Theoretical Framework
//! for Checking Statements Against Documentary Evidence"* (Cozzolino & Abbiati,
//! 2025). A [`Finding`] links a [`Claim`] to the [`Evidence`] used to judge it and
//! records one of the paper's four [`Outcome`]s (plus the `not_assessed`
//! technical-failure sentinel from §3.6). The judge's raw verdict vocabulary is
//! [`Status`] (Prompt 3), mapped onto [`Outcome`] by [`Status::to_outcome`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The four evidence-comparison outcomes (paper §4, Table 1) plus `not_assessed`
/// for technical failures (paper §3.6: "record not assessed instead of assigning
/// an evidence verdict"). Serialized snake_case for the response body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Supported,
    PartiallySupported,
    Contradicted,
    InsufficientEvidence,
    NotAssessed,
}

/// The judge's `STATUS` vocabulary (Prompt 3, paper §5.3). Serialized
/// SCREAMING_SNAKE_CASE to match the wire vocabulary the model emits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    Matching,
    PartiallyMatching,
    NotMatching,
    SourceNotFound,
}

impl Status {
    /// Parse the judge's `STATUS` token tolerantly (case-insensitive, surrounding
    /// whitespace trimmed). Returns `None` for an unknown token so the caller can
    /// record the claim as `not_assessed` rather than inventing a verdict.
    pub fn from_wire(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "MATCHING" => Some(Status::Matching),
            "PARTIALLY_MATCHING" => Some(Status::PartiallyMatching),
            "NOT_MATCHING" => Some(Status::NotMatching),
            "SOURCE_NOT_FOUND" => Some(Status::SourceNotFound),
            _ => None,
        }
    }

    /// Map the judge verdict onto the paper's four-outcome classification
    /// (§4, Table 1): MATCHING→supported, PARTIALLY_MATCHING→partially_supported,
    /// NOT_MATCHING→contradicted, SOURCE_NOT_FOUND→insufficient_evidence.
    pub fn to_outcome(self) -> Outcome {
        match self {
            Status::Matching => Outcome::Supported,
            Status::PartiallyMatching => Outcome::PartiallySupported,
            Status::NotMatching => Outcome::Contradicted,
            Status::SourceNotFound => Outcome::InsufficientEvidence,
        }
    }
}

/// One extracted atomic claim (Prompt 1 output). `claim_ref` carries any citation
/// marker and `source_page` any supplied page (kept as raw JSON because a page may
/// arrive as a number or a string); both are `None` when unavailable.
#[derive(Debug, Clone, PartialEq)]
pub struct Claim {
    pub claim_text: String,
    pub claim_ref: Option<String>,
    pub source_page: Option<Value>,
}

/// One passage located as evidence for a claim (Prompt 2 output).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub quote: String,
    pub source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

/// The judge's parsed verdict for one claim (Prompt 3 output).
#[derive(Debug, Clone, PartialEq)]
pub struct Judgment {
    pub status: Status,
    pub rationale: String,
    pub rag_quote: Option<String>,
    pub rag_location: Option<String>,
    pub contradiction_present: bool,
    pub insufficient_evidence: bool,
}

/// A single validation finding: the claim, the evidence considered, the outcome,
/// and the reasoning (paper Schema 1 / Schema 2). Provenance links (claim text,
/// citation ref, source page, evidence source ids) are retained so a reviewer can
/// return to the basis of the verdict.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Original statement wording (v1: equal to `claim_text`; a separate
    /// statement-grouping pass is a future refinement).
    pub statement: String,
    pub claim_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_page: Option<Value>,
    pub outcome: Outcome,
    /// The judge's raw verdict, when a judgment ran (`None` for `not_assessed`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    pub rationale: String,
    pub evidence: Vec<Evidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_quote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rag_location: Option<String>,
    pub contradiction_present: bool,
    pub insufficient_evidence: bool,
}

impl Finding {
    /// Build a finding from a completed judgment (the `else if`/judge branches of
    /// Algorithm 1).
    pub fn from_judgment(claim: Claim, evidence: Vec<Evidence>, judgment: Judgment) -> Self {
        Finding {
            statement: claim.claim_text.clone(),
            claim_text: claim.claim_text,
            claim_ref: claim.claim_ref,
            source_page: claim.source_page,
            outcome: judgment.status.to_outcome(),
            status: Some(judgment.status),
            rationale: judgment.rationale,
            evidence,
            rag_quote: judgment.rag_quote,
            rag_location: judgment.rag_location,
            contradiction_present: judgment.contradiction_present,
            insufficient_evidence: judgment.insufficient_evidence,
        }
    }

    /// Build an evidence-gap finding when retrieval located nothing comparable
    /// (Algorithm 1 line 7-8: `HasComparableEvidence` false → INSUFFICIENT_EVIDENCE,
    /// no judge call). "Missing support is not falsity" (Prompt 3 / §4).
    pub fn evidence_gap(claim: Claim, rationale: impl Into<String>) -> Self {
        Finding {
            statement: claim.claim_text.clone(),
            claim_text: claim.claim_text,
            claim_ref: claim.claim_ref,
            source_page: claim.source_page,
            outcome: Outcome::InsufficientEvidence,
            status: Some(Status::SourceNotFound),
            rationale: rationale.into(),
            evidence: Vec::new(),
            rag_quote: None,
            rag_location: None,
            contradiction_present: false,
            insufficient_evidence: true,
        }
    }

    /// Build a `not_assessed` finding for a technical failure (extraction/retrieval/
    /// judgment or its parse failed for this claim). Recorded, never silently
    /// dropped (paper §3.6).
    pub fn not_assessed(claim: Claim, evidence: Vec<Evidence>, rationale: impl Into<String>) -> Self {
        Finding {
            statement: claim.claim_text.clone(),
            claim_text: claim.claim_text,
            claim_ref: claim.claim_ref,
            source_page: claim.source_page,
            outcome: Outcome::NotAssessed,
            status: None,
            rationale: rationale.into(),
            evidence,
            rag_quote: None,
            rag_location: None,
            contradiction_present: false,
            insufficient_evidence: false,
        }
    }
}

/// Aggregate counts over the findings, grouped by outcome (paper §4: "the report
/// groups findings by their relationship to the available evidence").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationSummary {
    pub total: usize,
    pub supported: usize,
    pub partially_supported: usize,
    pub contradicted: usize,
    pub insufficient_evidence: usize,
    pub not_assessed: usize,
}

impl ValidationSummary {
    pub fn from_findings(findings: &[Finding]) -> Self {
        let mut summary = ValidationSummary {
            total: findings.len(),
            supported: 0,
            partially_supported: 0,
            contradicted: 0,
            insufficient_evidence: 0,
            not_assessed: 0,
        };
        for finding in findings {
            match finding.outcome {
                Outcome::Supported => summary.supported += 1,
                Outcome::PartiallySupported => summary.partially_supported += 1,
                Outcome::Contradicted => summary.contradicted += 1,
                Outcome::InsufficientEvidence => summary.insufficient_evidence += 1,
                Outcome::NotAssessed => summary.not_assessed += 1,
            }
        }
        summary
    }
}

/// The full validation report returned to the caller: the ordered findings plus
/// the outcome summary (Algorithm 1 output `findings`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub schema_version: u32,
    pub findings: Vec<Finding>,
    pub summary: ValidationSummary,
}

impl ValidationReport {
    /// Assemble a report (schema version 1) from findings, computing the summary.
    pub fn new(findings: Vec<Finding>) -> Self {
        let summary = ValidationSummary::from_findings(&findings);
        ValidationReport {
            schema_version: 1,
            findings,
            summary,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_parses_case_insensitively_and_rejects_unknown() {
        assert_eq!(Status::from_wire("matching"), Some(Status::Matching));
        assert_eq!(Status::from_wire("  NOT_MATCHING "), Some(Status::NotMatching));
        assert_eq!(
            Status::from_wire("PARTIALLY_MATCHING"),
            Some(Status::PartiallyMatching)
        );
        assert_eq!(Status::from_wire("source_not_found"), Some(Status::SourceNotFound));
        assert_eq!(Status::from_wire("BANANA"), None);
    }

    #[test]
    fn status_maps_to_the_four_outcomes() {
        assert_eq!(Status::Matching.to_outcome(), Outcome::Supported);
        assert_eq!(
            Status::PartiallyMatching.to_outcome(),
            Outcome::PartiallySupported
        );
        assert_eq!(Status::NotMatching.to_outcome(), Outcome::Contradicted);
        assert_eq!(
            Status::SourceNotFound.to_outcome(),
            Outcome::InsufficientEvidence
        );
    }

    #[test]
    fn status_serializes_screaming_snake() {
        assert_eq!(
            serde_json::to_value(Status::PartiallyMatching).unwrap(),
            serde_json::json!("PARTIALLY_MATCHING")
        );
    }

    #[test]
    fn outcome_serializes_snake_case() {
        assert_eq!(
            serde_json::to_value(Outcome::InsufficientEvidence).unwrap(),
            serde_json::json!("insufficient_evidence")
        );
    }

    fn claim(text: &str) -> Claim {
        Claim {
            claim_text: text.to_string(),
            claim_ref: None,
            source_page: None,
        }
    }

    #[test]
    fn summary_counts_each_outcome() {
        let findings = vec![
            Finding::from_judgment(
                claim("a"),
                vec![],
                Judgment {
                    status: Status::Matching,
                    rationale: "ok".into(),
                    rag_quote: None,
                    rag_location: None,
                    contradiction_present: false,
                    insufficient_evidence: false,
                },
            ),
            Finding::evidence_gap(claim("b"), "no evidence"),
            Finding::not_assessed(claim("c"), vec![], "failed"),
        ];
        let summary = ValidationSummary::from_findings(&findings);
        assert_eq!(summary.total, 3);
        assert_eq!(summary.supported, 1);
        assert_eq!(summary.insufficient_evidence, 1);
        assert_eq!(summary.not_assessed, 1);
        assert_eq!(summary.contradicted, 0);
    }

    #[test]
    fn evidence_gap_finding_is_insufficient_and_skips_the_judge() {
        let finding = Finding::evidence_gap(claim("x"), "nothing located");
        assert_eq!(finding.outcome, Outcome::InsufficientEvidence);
        assert_eq!(finding.status, Some(Status::SourceNotFound));
        assert!(finding.insufficient_evidence);
        assert!(finding.evidence.is_empty());
    }

    #[test]
    fn report_serializes_camel_case_with_summary() {
        let report = ValidationReport::new(vec![Finding::evidence_gap(claim("x"), "gap")]);
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["schemaVersion"], serde_json::json!(1));
        assert_eq!(value["summary"]["insufficientEvidence"], serde_json::json!(1));
        assert_eq!(value["findings"][0]["outcome"], serde_json::json!("insufficient_evidence"));
        assert_eq!(value["findings"][0]["claimText"], serde_json::json!("x"));
    }
}
