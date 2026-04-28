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

Use the release helper scripts in `extensions/vscode/package.json` to build, validate, and package platform-targeted VSIX artifacts.

### Expected bundled CLI names

The extension only recognizes these bundled filenames under `extensions/vscode/bin/`:

- non-Windows targets: `cratetrace-cli`
- Windows targets: `cratetrace-cli.exe`

If the expected binary is missing for the selected target, packaging must fail.

### Release workflow

Run from `extensions/vscode/`:

1. Build and copy the target CLI into `bin/`:
   - `npm run bundle:cli -- --target <target>`
2. Validate the target bundle exists and is non-empty:
   - `npm run validate:cli -- --target <target>`
3. Package with `vsce --target`:
   - `npm run package:target -- --target <target>`

Or run the full sequence in one command:

- `npm run release:target -- --target <target>`

Supported `<target>` values are:

- `linux-x64`, `linux-arm64`, `linux-armhf`
- `alpine-x64`, `alpine-arm64`
- `darwin-x64`, `darwin-arm64`
- `win32-x64`, `win32-arm64`

### VSIX artifact naming convention

`package:target` writes artifacts to `extensions/vscode/dist/` with this exact naming format:

- `cratetrace-<extension-version>-<target>.vsix`

Example:

- `cratetrace-0.0.1-linux-x64.vsix`

VS Code Marketplace can consume these platform-targeted VSIX outputs when publishing by target.

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
