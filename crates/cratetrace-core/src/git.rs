use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{CratetraceError, Result};
use crate::model::CommitRecord;

const FIELD_SEPARATOR: char = '\u{001f}';

pub fn collect_commits(repo_root: &Path, range: &str) -> Result<Vec<CommitRecord>> {
    let output = git(
        repo_root,
        &[
            "log",
            "--reverse",
            "--format=%H%x1f%h%x1f%P%x1f%s%x1f%cI",
            range,
        ],
    )?;

    let mut commits = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let parts: Vec<&str> = line.split(FIELD_SEPARATOR).collect();
        if parts.len() != 5 {
            return Err(CratetraceError::new(format!(
                "unexpected git log output while parsing `{line}`"
            )));
        }

        commits.push(CommitRecord {
            sha: parts[0].to_string(),
            short_sha: parts[1].to_string(),
            parent_sha: parts[2]
                .split_whitespace()
                .next()
                .filter(|parent| !parent.is_empty())
                .map(str::to_string),
            subject: parts[3].to_string(),
            committed_at: parts[4].to_string(),
            changed_paths: changed_paths(repo_root, parts[0])?,
        });
    }

    if commits.is_empty() {
        return Err(CratetraceError::new(format!(
            "no commits matched revision range `{range}`"
        )));
    }

    Ok(commits)
}

pub fn list_paths_at_commit(repo_root: &Path, sha: &str) -> Result<Vec<PathBuf>> {
    let output = git(repo_root, &["ls-tree", "-r", "--name-only", sha])?;

    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(PathBuf::from)
        .collect())
}

pub fn read_files_at_commit(
    repo_root: &Path,
    sha: &str,
    paths: &[PathBuf],
) -> Result<Vec<(PathBuf, String)>> {
    let mut files = Vec::new();
    for path in paths {
        let spec = format!("{sha}:{}", path.display());
        let output = git_bytes(repo_root, &["show", &spec])?;
        let content = String::from_utf8(output).map_err(|err| {
            CratetraceError::new(format!(
                "git show emitted non-utf8 for {} at {}: {err}",
                path.display(),
                sha
            ))
        })?;
        files.push((path.clone(), content));
    }
    Ok(files)
}

fn changed_paths(repo_root: &Path, sha: &str) -> Result<Vec<PathBuf>> {
    let output = git(
        repo_root,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            sha,
        ],
    )?;

    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(PathBuf::from)
        .collect())
}

fn git(repo_root: &Path, args: &[&str]) -> Result<String> {
    let output = git_bytes(repo_root, args)?;

    String::from_utf8(output)
        .map_err(|err| CratetraceError::new(format!("git emitted non-utf8 output: {err}")))
}

fn git_bytes(repo_root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CratetraceError::new(format!(
            "git {} failed: {}",
            args.join(" "),
            stderr.trim()
        )));
    }

    Ok(output.stdout)
}
