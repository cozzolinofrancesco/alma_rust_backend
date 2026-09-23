//! canvas-272 export subtree: builds the structured document and renders it to
//! markdown. Ported from `frontend_v3/app/canvas-272/lib/*`. Pure (no I/O),
//! shared by the `documents/assemble` + `exports` handlers and the IB flow.

pub mod diagram;
pub mod display_name;
pub mod docx;
pub mod layer_output;
pub mod markdown;
pub mod sanitize;
pub mod section_tags;
pub mod structured_doc;

#[cfg(test)]
mod tests_export;
