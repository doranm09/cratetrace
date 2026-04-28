use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct CommitRecord {
    pub sha: String,
    pub short_sha: String,
    pub parent_sha: Option<String>,
    pub subject: String,
    pub committed_at: String,
    pub changed_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct CommitArtifact {
    pub commit: CommitRecord,
    pub dot_path: PathBuf,
    pub svg_path: Option<PathBuf>,
    pub mermaid_path: PathBuf,
    pub total_modules: usize,
    pub added_modules: usize,
    pub modified_modules: usize,
    pub removed_modules: usize,
}

#[derive(Debug, Clone)]
pub struct RollupArtifact {
    pub revision_range: String,
    pub commit_count: usize,
    pub dot_path: PathBuf,
    pub svg_path: Option<PathBuf>,
    pub mermaid_path: PathBuf,
    pub total_modules: usize,
    pub added_modules: usize,
    pub modified_modules: usize,
    pub removed_modules: usize,
}

#[derive(Debug, Clone)]
pub struct TraceReport {
    pub artifact_root: PathBuf,
    pub rollup: RollupArtifact,
    pub commits: Vec<CommitArtifact>,
}
