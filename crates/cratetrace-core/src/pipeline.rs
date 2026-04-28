use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{CratetraceError, Result};
use crate::git;
use crate::graph;
use crate::model::{CommitArtifact, RollupArtifact, TraceReport};

#[derive(Debug, Clone)]
pub struct TraceOptions {
    pub repo_root: PathBuf,
    pub revision_range: String,
    pub output_dir: PathBuf,
    pub render_svg: bool,
}

pub fn trace_history(options: &TraceOptions) -> Result<TraceReport> {
    fs::create_dir_all(&options.output_dir)?;
    let commit_dir = options.output_dir.join("commits");
    fs::create_dir_all(&commit_dir)?;

    let commits = git::collect_commits(&options.repo_root, &options.revision_range)?;
    let first_commit = commits
        .first()
        .ok_or_else(|| CratetraceError::new("no commits matched the requested range"))?;
    let last_commit = commits
        .last()
        .ok_or_else(|| CratetraceError::new("no commits matched the requested range"))?;
    let baseline_paths = match &first_commit.parent_sha {
        Some(parent_sha) => git::list_paths_at_commit(&options.repo_root, parent_sha)?,
        None => Vec::new(),
    };
    let final_paths = git::list_paths_at_commit(&options.repo_root, &last_commit.sha)?;
    let baseline_rust_paths = baseline_paths
        .iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .cloned()
        .collect::<Vec<PathBuf>>();
    let final_rust_paths = final_paths
        .iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .cloned()
        .collect::<Vec<PathBuf>>();
    let baseline_files = match &first_commit.parent_sha {
        Some(parent_sha) => {
            git::read_files_at_commit(&options.repo_root, parent_sha, &baseline_rust_paths)?
        }
        None => Vec::new(),
    };
    let final_files =
        git::read_files_at_commit(&options.repo_root, &last_commit.sha, &final_rust_paths)?;
    let rollup_render = graph::render_range_rollup_graph(
        &options.revision_range,
        &commits,
        &final_paths,
        &baseline_paths,
        &final_files,
        &baseline_files,
    );
    let rollup_dot_path = options.output_dir.join("rollup.dot");
    fs::write(&rollup_dot_path, rollup_render.dot)?;
    let rollup_mermaid_path = options.output_dir.join("rollup.mmd");
    fs::write(&rollup_mermaid_path, rollup_render.mermaid)?;
    let rollup_svg_path = if options.render_svg {
        render_svg(&rollup_dot_path)?
    } else {
        None
    };
    let rollup = RollupArtifact {
        revision_range: options.revision_range.clone(),
        commit_count: commits.len(),
        dot_path: rollup_dot_path,
        svg_path: rollup_svg_path,
        mermaid_path: rollup_mermaid_path,
        total_modules: rollup_render.total_modules,
        added_modules: rollup_render.added_modules,
        modified_modules: rollup_render.modified_modules,
        removed_modules: rollup_render.removed_modules,
        total_dependency_edges: rollup_render.total_dependency_edges,
        added_dependency_edges: rollup_render.added_dependency_edges,
        removed_dependency_edges: rollup_render.removed_dependency_edges,
        changed_dependency_edges: rollup_render.changed_dependency_edges,
    };
    let mut artifacts = Vec::new();

    for commit in commits {
        let current_paths = git::list_paths_at_commit(&options.repo_root, &commit.sha)?;
        let previous_paths = match &commit.parent_sha {
            Some(parent_sha) => git::list_paths_at_commit(&options.repo_root, parent_sha)?,
            None => Vec::new(),
        };
        let current_rust_paths = current_paths
            .iter()
            .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
            .cloned()
            .collect::<Vec<PathBuf>>();
        let previous_rust_paths = previous_paths
            .iter()
            .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
            .cloned()
            .collect::<Vec<PathBuf>>();
        let current_files =
            git::read_files_at_commit(&options.repo_root, &commit.sha, &current_rust_paths)?;
        let previous_files = match &commit.parent_sha {
            Some(parent_sha) => {
                git::read_files_at_commit(&options.repo_root, parent_sha, &previous_rust_paths)?
            }
            None => Vec::new(),
        };
        let rendered = graph::render_commit_graph(
            &commit,
            &current_paths,
            &previous_paths,
            &current_files,
            &previous_files,
        );
        let dot_path = commit_dir.join(format!("{}.dot", commit.short_sha));
        fs::write(&dot_path, rendered.dot)?;
        let mermaid_path = commit_dir.join(format!("{}.mmd", commit.short_sha));
        fs::write(&mermaid_path, rendered.mermaid)?;

        let svg_path = if options.render_svg {
            render_svg(&dot_path)?
        } else {
            None
        };

        artifacts.push(CommitArtifact {
            commit,
            dot_path,
            svg_path,
            mermaid_path,
            total_modules: rendered.total_modules,
            added_modules: rendered.added_modules,
            modified_modules: rendered.modified_modules,
            removed_modules: rendered.removed_modules,
            total_dependency_edges: rendered.total_dependency_edges,
            added_dependency_edges: rendered.added_dependency_edges,
            removed_dependency_edges: rendered.removed_dependency_edges,
            changed_dependency_edges: rendered.changed_dependency_edges,
        });
    }

    let report = TraceReport {
        artifact_root: options.output_dir.clone(),
        rollup,
        commits: artifacts,
    };

    fs::write(
        options.output_dir.join("index.md"),
        render_index(&report, &options.output_dir),
    )?;
    fs::write(
        options.output_dir.join("timeline.tsv"),
        render_timeline(&report, &options.output_dir),
    )?;

    Ok(report)
}

fn render_svg(dot_path: &Path) -> Result<Option<PathBuf>> {
    let svg_path = dot_path.with_extension("svg");
    let output = Command::new("dot")
        .arg("-Tsvg")
        .arg(dot_path)
        .arg("-o")
        .arg(&svg_path)
        .output();

    match output {
        Ok(output) if output.status.success() => Ok(Some(svg_path)),
        Ok(output) => Err(CratetraceError::new(format!(
            "dot failed for {}: {}",
            dot_path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn render_index(report: &TraceReport, output_dir: &Path) -> String {
    let mut out = String::new();
    out.push_str("# cratetrace artifacts\n\n");
    out.push_str(&format!(
        "Generated {} whole-project commit UML snapshots under `{}`.\n\n",
        report.commits.len(),
        output_dir.display()
    ));
    out.push_str("## Range Roll-Up\n\n");
    out.push_str(&format!(
        "- Revision range: `{}`\n",
        report.rollup.revision_range
    ));
    out.push_str(&format!(
        "- Commits covered: `{}`\n",
        report.rollup.commit_count
    ));
    out.push_str(&format!(
        "- Module snapshot: total=`{}` added=`{}` modified=`{}` removed=`{}`\n",
        report.rollup.total_modules,
        report.rollup.added_modules,
        report.rollup.modified_modules,
        report.rollup.removed_modules
    ));
    out.push_str(&format!(
        "- Dependency edges: total=`{}` added=`{}` removed=`{}` changed=`{}`\n",
        report.rollup.total_dependency_edges,
        report.rollup.added_dependency_edges,
        report.rollup.removed_dependency_edges,
        report.rollup.changed_dependency_edges
    ));
    out.push_str(&format!(
        "- DOT: `{}`\n",
        relative_display(&report.rollup.dot_path, output_dir)
    ));
    out.push_str(&format!(
        "- Mermaid: `{}`\n",
        relative_display(&report.rollup.mermaid_path, output_dir)
    ));
    match &report.rollup.svg_path {
        Some(svg_path) => out.push_str(&format!(
            "- SVG: `{}`\n\n",
            relative_display(svg_path, output_dir)
        )),
        None => out.push_str("- SVG: not rendered\n\n"),
    }

    for artifact in &report.commits {
        out.push_str(&format!(
            "## {} {}\n\n",
            artifact.commit.short_sha, artifact.commit.subject
        ));
        out.push_str(&format!("- Commit: `{}`\n", artifact.commit.sha));
        out.push_str(&format!(
            "- Timestamp: `{}`\n",
            artifact.commit.committed_at
        ));
        out.push_str(&format!(
            "- Module snapshot: total=`{}` added=`{}` modified=`{}` removed=`{}`\n",
            artifact.total_modules,
            artifact.added_modules,
            artifact.modified_modules,
            artifact.removed_modules
        ));
        out.push_str(&format!(
            "- Dependency edges: total=`{}` added=`{}` removed=`{}` changed=`{}`\n",
            artifact.total_dependency_edges,
            artifact.added_dependency_edges,
            artifact.removed_dependency_edges,
            artifact.changed_dependency_edges
        ));
        out.push_str(&format!(
            "- DOT: `{}`\n",
            relative_display(&artifact.dot_path, output_dir)
        ));
        out.push_str(&format!(
            "- Mermaid: `{}`\n",
            relative_display(&artifact.mermaid_path, output_dir)
        ));
        match &artifact.svg_path {
            Some(svg_path) => out.push_str(&format!(
                "- SVG: `{}`\n",
                relative_display(svg_path, output_dir)
            )),
            None => out.push_str("- SVG: not rendered\n"),
        }
        out.push_str(&format!(
            "- Changed paths: {}\n\n",
            artifact.commit.changed_paths.len()
        ));
    }

    out
}

fn render_timeline(report: &TraceReport, output_dir: &Path) -> String {
    let mut out = String::from("kind\tdot_rel_path\tsvg_rel_path\tmermaid_rel_path\tlabel\n");
    out.push_str(&format!(
        "rollup\t{}\t{}\t{}\t{}\n",
        relative_display(&report.rollup.dot_path, output_dir),
        optional_relative_display(&report.rollup.svg_path, output_dir),
        relative_display(&report.rollup.mermaid_path, output_dir),
        sanitize_manifest_field(&format!("Range roll-up {}", report.rollup.revision_range))
    ));

    for artifact in &report.commits {
        out.push_str(&format!(
            "commit\t{}\t{}\t{}\t{}\n",
            relative_display(&artifact.dot_path, output_dir),
            optional_relative_display(&artifact.svg_path, output_dir),
            relative_display(&artifact.mermaid_path, output_dir),
            sanitize_manifest_field(&format!(
                "{} {}",
                artifact.commit.short_sha, artifact.commit.subject
            ))
        ));
    }

    out
}

fn relative_display(path: &Path, base: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .display()
        .to_string()
}

fn optional_relative_display(path: &Option<PathBuf>, base: &Path) -> String {
    match path {
        Some(path) => relative_display(path, base),
        None => String::new(),
    }
}

fn sanitize_manifest_field(value: &str) -> String {
    value.replace('\t', " ").replace('\n', " ")
}
