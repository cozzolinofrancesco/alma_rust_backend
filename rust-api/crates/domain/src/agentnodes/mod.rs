//! Pure agent-execution engine ported from `frontend_v3/app/lib/agentExecution/*`.
//!
//! This subtree is the hexagonal *domain* core of the `agentnodes` category: it
//! holds only pure logic (serde DTOs, semantic validators, canonical-JSON
//! hashing, and the portable error contract) with no I/O. The thin HTTP
//! orchestration and the AI / retrieval adapters live in the `http` and
//! `infrastructure` crates respectively.
//!
//! Build order (see the port plan, Phase 2): `error` → `dto` → `hash` →
//! `validation`, then the planner / step / export units land alongside.

pub mod dto;
pub mod error;
pub mod export;
pub mod hash;
pub mod output_history;
pub mod planner;
pub mod report_creation;
pub mod step_prompt;
pub mod validation;

#[cfg(test)]
mod tests_engine;
