//! Claim-level document validation (quality control).
//!
//! A pure port of *"Document Validation: A Theoretical Framework for Checking
//! Statements Against Documentary Evidence"* (Cozzolino & Abbiati, 2025). The
//! workflow (paper Algorithm 1) is: extract atomic claims from the text under
//! review ([`prompts::build_extraction_prompt`]), locate evidence for each claim
//! in a supplied source document ([`prompts::build_evidence_prompt`]), compare
//! claim against evidence ([`prompts::build_judgment_prompt`]), and record a
//! [`dto::Finding`] with one of the four [`dto::Outcome`]s.
//!
//! This module is pure (prompt building, tolerant response parsing, verdict →
//! outcome mapping, summary aggregation); the async orchestration that calls the
//! `ArtificialIntelligencePort` between these steps lives in the http crate's
//! `claim_validation` handler.

pub mod dto;
pub mod parse;
pub mod prompts;

pub use dto::{
    Claim, Evidence, Finding, Judgment, Outcome, Status, ValidationReport, ValidationSummary,
};
