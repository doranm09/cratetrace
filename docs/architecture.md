# Architecture

## Goal

Generate commit-scoped visual artifacts that let a reviewer answer two questions quickly:

- which Rust modules changed in this commit?
- how do those changes evolve across a revision range?

## First-cut design

The current implementation keeps the system stable and cheap to iterate on.

### Data flow

1. CLI receives `repo`, `range`, and `out`.
2. `cratetrace-core` calls Git to enumerate commits in chronological order.
3. For each commit, `cratetrace-core` collects the changed paths and lists the repository snapshot at that commit.
4. Rust paths are mapped to approximate module labels for both the current commit and its parent.
5. A whole-project UML-style module graph is emitted for the commit.
6. Added, modified, and removed modules are highlighted inside that full graph.
7. A range-level roll-up graph is emitted from the baseline and final snapshots.
8. If `dot` is available, SVG files are rendered from the DOT files.
9. An index file and a simple timeline manifest are written to the artifact root.

### Why path-based first

A path-based project graph does not require unstable compiler internals or third-party parser dependencies. It gives immediate value while preserving a clean seam for later replacement with a real Rust dependency engine.

### Current graph semantics

The current graph is closer to a UML package diagram than a UML class diagram:

- nodes represent inferred Rust modules or package containers
- edges represent containment within the project hierarchy
- node colors represent commit delta state

This is enough to answer whole-project structural questions per commit, but it does not yet model true `use` dependencies or type-level relationships.

### Extension boundary

The VS Code extension should stay thin:

- prompt for a revision range
- launch the CLI
- show progress and command output
- open the generated artifact index

All repository analysis stays in the standalone CLI so the same workflow can run in CI, from the terminal, or in another editor.
