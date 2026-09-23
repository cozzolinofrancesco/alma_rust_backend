//! `authoring` category — the canvas-272 ("Authoring") compute endpoints ported
//! from the Next.js reference: `.docx` export and the per-agent sidecar store.
//! Pure Google-service pass-throughs (Gmail share, Google-Doc create, Drive
//! agent-file reads) intentionally remain on the Next.js side.

pub mod collections;
pub mod handlers;
pub mod routes;

pub use routes::build_authoring_router;
