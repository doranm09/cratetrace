# cratetrace

`cratetrace` is a commit-oriented Rust repository visualization workspace.

The project is split into three layers:

- `crates/cratetrace-core`: shared Git/history/graph generation logic
- `crates/cratetrace-cli`: a standalone CLI that generates per-commit whole-project DOT, SVG, and Mermaid artifacts
- `extensions/vscode`: a thin VS Code extension that shells out to the CLI and previews the generated artifacts

## Current scope

The current implementation focuses on a stable commit-to-artifact pipeline:

1. walk a Git revision range
2. inspect the files changed in each commit
3. enumerate the Rust project snapshot at each commit
4. infer module/package labels from repository paths
5. render the full project module graph for each commit
6. highlight added, modified, and removed modules inside that full graph
7. emit Mermaid graph artifacts for webview rendering inside VS Code
8. optionally render SVG with `dot`
9. generate a top-level range roll-up graph
10. build an `index.md` artifact catalog and `timeline.tsv` navigation manifest

This is still intentionally narrower than a full semantic dependency engine. The next phase is to replace path-based module inference with Rust-aware dependency extraction and real inter-module dependency edges.

## Quick start

Build the workspace:

```bash
cargo build
```

Generate artifacts for a repository:

```bash
cargo run -p cratetrace-cli -- trace \
  --repo /path/to/repo \
  --range HEAD~9..HEAD \
  --out /tmp/cratetrace-artifacts
```

If Graphviz is installed, `cratetrace` will also render SVG alongside each DOT file.

The DOT/SVG/Mermaid output is currently UML-style package/module structure rather than full class UML. Each commit artifact shows the entire project snapshot and colors the delta for that commit.

The artifact root contains:

- `rollup.dot`, `rollup.svg`, and `rollup.mmd`: aggregate view across the selected revision range
- `commits/*.dot`, `commits/*.svg`, and `commits/*.mmd`: one whole-project graph per commit
- `index.md`: human-readable summary
- `timeline.tsv`: extension-friendly navigation manifest

## VS Code extension

The extension is in `extensions/vscode` and is intentionally dependency-light.

It exposes these commands:

- `Cratetrace: Generate History Graphs`
- `Cratetrace: Open Artifacts Index`
- `Cratetrace: Open Roll-Up Graph`
- `Cratetrace: Pick Commit Graph`
- `Cratetrace: Next Commit Graph`
- `Cratetrace: Previous Commit Graph`

`Cratetrace: Generate History Graphs` now supports either:

- picking one or two commits from a recent history list in VS Code
- entering a manual Git revision range

The extension renders Mermaid by default in a built-in webview, and can also open SVG or DOT artifacts via the `cratetrace.previewFormat` setting.

The extension resolves the CLI in this order:

- `cratetrace.cliPath`
- bundled `bin/cratetrace-cli` or `bin/cratetrace-cli.exe`
- `cratetrace-cli` on `PATH`

For published builds, bundle the CLI inside the extension under `bin/`.

During development, point the extension at the local CLI binary using the `cratetrace.cliPath` setting. That will usually be:

- `/home/michaeldoran/git/cratetrace/target/debug/cratetrace-cli`

Mermaid previews do not require Graphviz. If you switch the preferred preview format to `svg`, the extension will fall back to Mermaid or DOT when `dot` output is unavailable.

## Planned next steps

- parse Rust modules and `use` relationships instead of relying on path inference alone
- add real dependency edges between modules, not just package containment
- add a VS Code tree view for commit snapshots
- support caching keyed by repo SHA and command options
