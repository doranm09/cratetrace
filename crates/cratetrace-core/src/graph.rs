use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::model::CommitRecord;

#[derive(Debug, Clone)]
pub struct GraphRender {
    pub dot: String,
    pub total_modules: usize,
    pub added_modules: usize,
    pub modified_modules: usize,
    pub removed_modules: usize,
}

pub fn render_commit_dot(
    commit: &CommitRecord,
    current_paths: &[PathBuf],
    previous_paths: &[PathBuf],
) -> GraphRender {
    let current_modules = module_labels_from_paths(current_paths);
    let previous_modules = module_labels_from_paths(previous_paths);
    let touched_modules = module_labels_from_paths(&commit.changed_paths);
    let modified_modules = touched_modules
        .intersection(&current_modules)
        .filter(|module| previous_modules.contains(*module))
        .cloned()
        .collect::<BTreeSet<String>>();
    let non_rust_changed_files = non_rust_changed_files(&commit.changed_paths);

    render_project_diff_graph(
        &[
            format!("commit {}", commit.short_sha),
            commit.subject.clone(),
            commit.committed_at.clone(),
        ],
        &current_modules,
        &previous_modules,
        &modified_modules,
        &non_rust_changed_files,
    )
}

pub fn render_range_rollup_dot(
    revision_range: &str,
    commits: &[CommitRecord],
    final_paths: &[PathBuf],
    baseline_paths: &[PathBuf],
) -> GraphRender {
    let current_modules = module_labels_from_paths(final_paths);
    let previous_modules = module_labels_from_paths(baseline_paths);
    let touched_paths = commits
        .iter()
        .flat_map(|commit| commit.changed_paths.iter().cloned())
        .collect::<Vec<PathBuf>>();
    let touched_modules = module_labels_from_paths(&touched_paths);
    let modified_modules = touched_modules
        .intersection(&current_modules)
        .filter(|module| previous_modules.contains(*module))
        .cloned()
        .collect::<BTreeSet<String>>();
    let non_rust_changed_files = non_rust_changed_files(&touched_paths);

    let first_commit = commits.first();
    let last_commit = commits.last();
    let mut header_lines = vec![
        format!("range {}", revision_range),
        format!("commits {}", commits.len()),
    ];
    if let Some(first_commit) = first_commit {
        header_lines.push(format!(
            "from {} {}",
            first_commit.short_sha, first_commit.subject
        ));
    }
    if let Some(last_commit) = last_commit {
        header_lines.push(format!(
            "to {} {}",
            last_commit.short_sha, last_commit.subject
        ));
    }

    render_project_diff_graph(
        &header_lines,
        &current_modules,
        &previous_modules,
        &modified_modules,
        &non_rust_changed_files,
    )
}

fn render_project_diff_graph(
    header_lines: &[String],
    current_modules: &BTreeSet<String>,
    previous_modules: &BTreeSet<String>,
    modified_modules: &BTreeSet<String>,
    non_rust_changed_files: &[String],
) -> GraphRender {
    let added_modules = current_modules
        .difference(previous_modules)
        .cloned()
        .collect::<BTreeSet<String>>();
    let removed_modules = previous_modules
        .difference(current_modules)
        .cloned()
        .collect::<BTreeSet<String>>();
    let modified_modules = modified_modules
        .difference(&added_modules)
        .filter(|module| !removed_modules.contains(*module))
        .cloned()
        .collect::<BTreeSet<String>>();
    let displayed_modules = expand_with_ancestors(
        &current_modules
            .union(&removed_modules)
            .cloned()
            .collect::<BTreeSet<String>>(),
    );

    let mut out = String::new();
    out.push_str("digraph cratetrace {\n");
    out.push_str(
        "  graph [rankdir=TB, labelloc=t, fontname=\"Helvetica\", labeljust=l, newrank=true, ranksep=0.55, nodesep=0.35, label=<",
    );
    out.push_str(&render_graph_label(
        header_lines,
        current_modules.len(),
        added_modules.len(),
        modified_modules.len(),
        removed_modules.len(),
        non_rust_changed_files.len(),
    ));
    out.push_str(">];\n");
    out.push_str(
        "  node [fontname=\"Helvetica\", shape=box, style=\"rounded,filled\", fillcolor=aliceblue, color=gray40];\n",
    );
    out.push_str("  edge [fontname=\"Helvetica\", color=gray55, arrowhead=none];\n");
    out.push_str(
        "  workspace [fillcolor=gray97, style=\"rounded,filled,bold\", label=\"workspace\"];\n",
    );

    for module in &displayed_modules {
        out.push_str(&render_module_node(
            module,
            current_modules,
            &added_modules,
            &modified_modules,
            &removed_modules,
        ));
    }

    for module in &displayed_modules {
        if let Some(parent) = parent_module(module) {
            if displayed_modules.contains(&parent) {
                out.push_str(&format!(
                    "  {} -> {} [label=\"contains\"];\n",
                    node_id(&parent),
                    node_id(module)
                ));
            }
        } else {
            out.push_str(&format!(
                "  workspace -> {} [label=\"contains\"];\n",
                node_id(module)
            ));
        }
    }

    if !non_rust_changed_files.is_empty() {
        out.push_str(&format!(
            "  non_rust [shape=note, fillcolor=gray95, label=\"{}\"];\n",
            escape_dot_label(&non_rust_note(non_rust_changed_files))
        ));
        out.push_str(
            "  workspace -> non_rust [style=dashed, color=gray45, label=\"non-rust diff\"];\n",
        );
    }

    out.push_str("}\n");

    GraphRender {
        dot: out,
        total_modules: current_modules.len(),
        added_modules: added_modules.len(),
        modified_modules: modified_modules.len(),
        removed_modules: removed_modules.len(),
    }
}

fn render_module_node(
    module: &str,
    current_modules: &BTreeSet<String>,
    added_modules: &BTreeSet<String>,
    modified_modules: &BTreeSet<String>,
    removed_modules: &BTreeSet<String>,
) -> String {
    let node_id = node_id(module);
    let label = escape_dot_label(module);

    if removed_modules.contains(module) {
        return format!(
            "  {node_id} [fillcolor=mistyrose, style=\"rounded,filled,dashed\", label=\"{label}\"];\n"
        );
    }

    if added_modules.contains(module) {
        return format!("  {node_id} [fillcolor=palegreen, label=\"{label}\"];\n");
    }

    if modified_modules.contains(module) {
        return format!("  {node_id} [fillcolor=khaki1, label=\"{label}\"];\n");
    }

    if current_modules.contains(module) {
        return format!("  {node_id} [fillcolor=aliceblue, label=\"{label}\"];\n");
    }

    format!(
        "  {node_id} [fillcolor=white, style=\"rounded,dashed\", label=\"{label}\"];\n"
    )
}

fn render_graph_label(
    header_lines: &[String],
    total_modules: usize,
    added_modules: usize,
    modified_modules: usize,
    removed_modules: usize,
    non_rust_changes: usize,
) -> String {
    let summary = format!(
        "modules={} added={} modified={} removed={} non_rust_changes={}",
        total_modules, added_modules, modified_modules, removed_modules, non_rust_changes
    );
    let mut detail_html = String::new();
    for line in header_lines {
        if !detail_html.is_empty() {
            detail_html.push_str("<BR ALIGN=\"LEFT\"/>");
        }
        detail_html.push_str(&escape_html(line));
    }
    if !detail_html.is_empty() {
        detail_html.push_str("<BR ALIGN=\"LEFT\"/>");
    }
    detail_html.push_str(&escape_html(&summary));

    format!(
        "<TABLE BORDER=\"0\" CELLBORDER=\"1\" CELLSPACING=\"0\" CELLPADDING=\"6\">\
<TR><TD COLSPAN=\"4\" BGCOLOR=\"gray95\" ALIGN=\"LEFT\"><B>cratetrace UML-style project diff</B></TD></TR>\
<TR><TD COLSPAN=\"4\" ALIGN=\"LEFT\">{detail_html}</TD></TR>\
<TR>\
<TD BGCOLOR=\"palegreen\" ALIGN=\"CENTER\">added</TD>\
<TD BGCOLOR=\"khaki1\" ALIGN=\"CENTER\">modified</TD>\
<TD BGCOLOR=\"mistyrose\" ALIGN=\"CENTER\">removed</TD>\
<TD BGCOLOR=\"aliceblue\" ALIGN=\"CENTER\">unchanged</TD>\
</TR>\
</TABLE>"
    )
}

fn module_labels_from_paths(paths: &[PathBuf]) -> BTreeSet<String> {
    paths.iter()
        .filter_map(|path| rust_module_label(path))
        .collect::<BTreeSet<String>>()
}

fn non_rust_changed_files(paths: &[PathBuf]) -> Vec<String> {
    paths.iter()
        .filter(|path| rust_module_label(path).is_none())
        .map(|path| path.display().to_string())
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect()
}

fn expand_with_ancestors(modules: &BTreeSet<String>) -> BTreeSet<String> {
    let mut expanded = BTreeSet::new();

    for module in modules {
        expanded.insert(module.clone());
        let mut cursor = module.clone();
        while let Some(parent) = parent_module(&cursor) {
            if !expanded.insert(parent.clone()) {
                break;
            }
            cursor = parent;
        }
    }

    expanded
}

fn parent_module(module: &str) -> Option<String> {
    module.rfind("::").map(|index| module[..index].to_string())
}

fn rust_module_label(path: &Path) -> Option<String> {
    let path_text = path.to_string_lossy();
    if !path_text.ends_with(".rs") {
        return None;
    }

    let mut parts: Vec<String> = path
        .iter()
        .map(|component| component.to_string_lossy().to_string())
        .collect();

    let prefix = parts.first()?.clone();
    match prefix.as_str() {
        "src" => {
            parts.remove(0);
            normalize_module_parts("crate", parts)
        }
        "tests" => {
            parts.remove(0);
            normalize_module_parts("tests", parts)
        }
        "examples" => {
            parts.remove(0);
            normalize_module_parts("examples", parts)
        }
        "benches" => {
            parts.remove(0);
            normalize_module_parts("benches", parts)
        }
        _ => None,
    }
}

fn normalize_module_parts(root: &str, mut parts: Vec<String>) -> Option<String> {
    if let Some(last) = parts.last_mut() {
        match last.as_str() {
            "lib.rs" | "main.rs" | "mod.rs" => {
                parts.pop();
            }
            _ if last.ends_with(".rs") => {
                *last = last.trim_end_matches(".rs").to_string();
            }
            _ => {}
        }
    }

    if parts.is_empty() {
        return Some(root.to_string());
    }

    Some(format!("{root}::{}", parts.join("::")))
}

fn non_rust_note(files: &[String]) -> String {
    let mut note = String::from("non-rust changed files");
    for file in files.iter().take(8) {
        note.push('\n');
        note.push_str("- ");
        note.push_str(file);
    }
    if files.len() > 8 {
        note.push('\n');
        note.push_str("- ...");
    }
    note
}

fn node_id(module: &str) -> String {
    let mut id = String::from("module");
    for ch in module.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch);
        } else {
            id.push('_');
        }
    }
    id
}

fn escape_dot_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::{expand_with_ancestors, normalize_module_parts, parent_module};
    use std::collections::BTreeSet;

    #[test]
    fn normalizes_root_files() {
        assert_eq!(
            normalize_module_parts("crate", vec!["lib.rs".to_string()]),
            Some("crate".to_string())
        );
        assert_eq!(
            normalize_module_parts("crate", vec!["core".to_string(), "mod.rs".to_string()]),
            Some("crate::core".to_string())
        );
    }

    #[test]
    fn finds_parent_modules() {
        assert_eq!(parent_module("crate"), None);
        assert_eq!(parent_module("crate::core"), Some("crate".to_string()));
        assert_eq!(
            parent_module("crate::core::item"),
            Some("crate::core".to_string())
        );
    }

    #[test]
    fn expands_ancestors() {
        let modules = BTreeSet::from(["crate::core::item".to_string()]);
        let expanded = expand_with_ancestors(&modules);
        assert!(expanded.contains("crate"));
        assert!(expanded.contains("crate::core"));
        assert!(expanded.contains("crate::core::item"));
    }
}
