//! 272 report-creation subtree: compiles the 272 wizard input into a runnable
//! agent bundle. Ported from `frontend_v3/app/lib/reportCreation/*` +
//! `reportCreationLayerRefs.ts` + `sect1MetaSteps.ts`. Pure (no I/O).

pub mod agent_builder;
pub mod compile;
pub mod layer_refs;
pub mod meta_steps;
pub mod sanitize;
pub mod source_summary;
