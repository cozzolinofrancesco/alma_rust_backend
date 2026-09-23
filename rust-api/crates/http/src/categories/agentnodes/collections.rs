//! Document-collection names for the portable `agentnodes` category.
//!
//! `DocumentCollectionPort` is schemaless (`document_body: serde_json::Value`), so
//! these consts are the only "schema" the category needs: agent graphs, runs
//! (plan + checkpoint, keyed by `runId`), and compiled/assembled reports each live
//! in their own collection.

/// Saved agent-graph definitions (inline agents, keyed by agent id).
pub const AGENT_NODES_COLLECTION_NAME: &str = "agent_nodes";

/// Durable run records (`{ runId, createdAt, revision, plan, checkpoint }`),
/// written by `runs/plan` and revision-checked by `runs/advance`.
pub const AGENT_RUNS_COLLECTION_NAME: &str = "agent_runs";

/// Compiled / assembled report artifacts produced along the 272 / IB money-path.
pub const AGENT_REPORTS_COLLECTION_NAME: &str = "agent_reports";
