# Cratetrace VS Code Extension

This extension is a thin command surface over the `cratetrace-cli` binary.

The CLI currently generates whole-project UML-style module graphs for each commit in a revision range and highlights added, modified, and removed modules.
The VS Code extension renders Mermaid graphs in a built-in webview by default and can also open SVG or DOT artifacts.

## Commands

- `Cratetrace: Generate History Graphs`
- `Cratetrace: Open Artifacts Index`
- `Cratetrace: Open Roll-Up Graph`
- `Cratetrace: Pick Commit Graph`
- `Cratetrace: Next Commit Graph`
- `Cratetrace: Previous Commit Graph`

The usual flow is:

1. Run `Cratetrace: Generate History Graphs`
2. Choose either a recent commit picker or a manual Git revision range
3. Open the roll-up graph
4. Step through the commit snapshots with `Next Commit Graph` and `Previous Commit Graph`
5. Jump directly to a specific commit snapshot with `Pick Commit Graph`

When you use the recent commit picker, select:

- one commit to compare it against its parent
- two commits to compare the span between them

## CLI resolution

The extension resolves the CLI in this order:

1. `cratetrace.cliPath`
2. bundled `bin/cratetrace-cli` or `bin/cratetrace-cli.exe`
3. `cratetrace-cli` on `PATH`

Published builds should bundle the CLI inside the extension under `bin/`.

## Publishing

For a platform-specific Marketplace release:

1. Build `cratetrace-cli` for the target platform
2. Copy it into `extensions/vscode/bin/` as `cratetrace-cli` or `cratetrace-cli.exe`
3. Package or publish the extension with `vsce --target <platform>`

VS Code will install the matching platform package when you publish platform-specific VSIX artifacts.

## Development settings

During local development, set the CLI path in VS Code settings:

```json
{
  "cratetrace.cliPath": "/home/michaeldoran/git/cratetrace/target/debug/cratetrace-cli"
}
```

Relative `cratetrace.cliPath` values are resolved from the workspace root.

The preview format is controlled by:

```json
{
  "cratetrace.previewFormat": "mermaid"
}
```

Available values are `mermaid`, `svg`, `dot`, and `auto`.

The recent commit picker size is controlled by:

```json
{
  "cratetrace.recentCommitLimit": 50
}
```

## Graphviz

Mermaid previews are always generated and rendered inside the extension webview.
If Graphviz `dot` is installed, `cratetrace` also renders SVG files.
If `dot` is missing and the preferred preview format is `svg`, the extension falls back to Mermaid or DOT.

The extension intentionally keeps all repository analysis in the standalone CLI so the same workflow can run from terminals and CI.
