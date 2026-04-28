pub mod error;
pub mod git;
pub mod graph;
pub mod model;
pub mod pipeline;

pub use error::{CratetraceError, Result};
pub use model::{CommitArtifact, CommitRecord, RollupArtifact, TraceReport};
pub use pipeline::{TraceOptions, trace_history};
