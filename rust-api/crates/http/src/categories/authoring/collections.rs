//! Document-store collection names owned by the `authoring` category.

/// Collection holding per-agent canvas-272 **sidecars** — the user's edits to an
/// agent's step outputs. One document per (project, agent): the
/// `document_identifier` is `"{projectId}:{agentId}"` and `owning_account` is the
/// authorized principal, so reads are naturally owner+project scoped. Ported from
/// `frontend_v3/app/api/canvas-272/sidecar/[agentId]/route.ts` (which stores the
/// same JSON as `{agentId}.canvas272.json` in the project's Drive `AF` folder);
/// here it lives in the durable document store instead of Google Drive.
pub const CANVAS_272_SIDECAR_COLLECTION_NAME: &str = "canvas_272_sidecars";
