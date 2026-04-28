const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const OPEN_SETTINGS_ACTION = "Open Settings";
const FIELD_SEPARATOR = "\u001f";
const PREVIEW_FORMATS = new Set(["auto", "dot", "mermaid", "svg"]);

const navigationState = {
  artifactRoot: null,
  items: [],
  commitItems: [],
  currentCommitIndex: -1,
  currentKind: null
};
let extensionContext = null;
let mermaidPreviewPanel = null;

function activate(context) {
  extensionContext = context;
  const output = vscode.window.createOutputChannel("Cratetrace");

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("cratetrace.generateHistoryGraphs", async () => {
      const folder = pickWorkspaceFolder();
      if (!folder) {
        return;
      }

      const config = vscode.workspace.getConfiguration("cratetrace", folder.uri);
      const cli = resolveCliExecutable(folder, config, context.extensionPath);
      const artifactRoot = artifactRootForFolder(folder, config);
      const traceSelection = await promptTraceSelection(folder, config);
      if (!traceSelection) {
        return;
      }

      const repoRoot = folder.uri.fsPath;
      output.show(true);
      output.appendLine(`Using ${describeCliSource(cli.source)} CLI: ${cli.command}`);
      output.appendLine(`Selected history: ${traceSelection.summary}`);
      output.appendLine(`Running ${cli.command} for ${repoRoot}`);

      try {
        await runCratetrace(
          cli.command,
          [
            "trace",
            "--repo",
            repoRoot,
            "--range",
            traceSelection.revisionRange,
            "--out",
            artifactRoot
          ],
          repoRoot,
          output
        );

        loadTimelineState(artifactRoot);
        const openedRollup = await openRollupFromState();
        if (!openedRollup) {
          await openIfExists(path.join(artifactRoot, "index.md"));
        }
        if (preferredPreviewFormat(folder) === "svg" && !hasSvgArtifacts(navigationState)) {
          vscode.window.showWarningMessage(
            "Graphviz `dot` was not found. Cratetrace generated Mermaid and DOT artifacts, but not SVG graphs."
          );
        }
        vscode.window.showInformationMessage(
          `Cratetrace artifacts generated in ${artifactRoot}`
        );
      } catch (error) {
        const details = describeRunError(error, cli);
        output.appendLine(details.outputMessage);
        const action = await vscode.window.showErrorMessage(
          details.userMessage,
          ...(details.showSettingsAction ? [OPEN_SETTINGS_ACTION] : [])
        );
        if (action === OPEN_SETTINGS_ACTION) {
          await openCliPathSetting();
        }
      }
    }),
    vscode.commands.registerCommand("cratetrace.openArtifactsIndex", async () => {
      const folder = pickWorkspaceFolder();
      if (!folder) {
        return;
      }

      const config = vscode.workspace.getConfiguration("cratetrace", folder.uri);
      const artifactRoot = artifactRootForFolder(folder, config);
      const opened = await openIfExists(path.join(artifactRoot, "index.md"));
      if (!opened) {
        vscode.window.showWarningMessage(
          `No Cratetrace index found at ${artifactRoot}`
        );
      }
    }),
    vscode.commands.registerCommand("cratetrace.openRollupGraph", async () => {
      const state = await ensureTimelineState();
      if (!state) {
        return;
      }

      const rollupItem = state.items.find((item) => item.kind === "rollup");
      if (!rollupItem) {
        vscode.window.showWarningMessage("No Cratetrace roll-up graph found.");
        return;
      }

      await openArtifactItem(rollupItem);
    }),
    vscode.commands.registerCommand("cratetrace.nextCommitGraph", async () => {
      const state = await ensureTimelineState();
      if (!state) {
        return;
      }

      if (state.commitItems.length === 0) {
        vscode.window.showWarningMessage("No Cratetrace commit graphs found.");
        return;
      }

      const nextIndex =
        state.currentKind === "commit" ? state.currentCommitIndex + 1 : 0;
      if (nextIndex >= state.commitItems.length) {
        vscode.window.showInformationMessage("Already at the last commit graph.");
        return;
      }

      await openCommitAtIndex(nextIndex);
    }),
    vscode.commands.registerCommand("cratetrace.pickCommitGraph", async () => {
      const state = await ensureTimelineState();
      if (!state) {
        return;
      }

      if (state.commitItems.length === 0) {
        vscode.window.showWarningMessage("No Cratetrace commit graphs found.");
        return;
      }

      const selection = await vscode.window.showQuickPick(
        state.commitItems.map((item, index) => ({
          label: item.label,
          description: `Commit ${index + 1} of ${state.commitItems.length}`,
          index
        })),
        {
          title: "Select a Cratetrace commit graph",
          matchOnDescription: true
        }
      );

      if (!selection) {
        return;
      }

      await openCommitAtIndex(selection.index);
    }),
    vscode.commands.registerCommand("cratetrace.previousCommitGraph", async () => {
      const state = await ensureTimelineState();
      if (!state) {
        return;
      }

      if (state.commitItems.length === 0) {
        vscode.window.showWarningMessage("No Cratetrace commit graphs found.");
        return;
      }

      if (state.currentKind !== "commit") {
        vscode.window.showInformationMessage(
          "Open a commit graph first or use Next Commit Graph."
        );
        return;
      }

      const previousIndex = state.currentCommitIndex - 1;
      if (previousIndex < 0) {
        vscode.window.showInformationMessage("Already at the first commit graph.");
        return;
      }

      await openCommitAtIndex(previousIndex);
    })
  );
}

function deactivate() {}

function pickWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage(
      "Open a workspace folder before running Cratetrace."
    );
    return null;
  }
  return folders[0];
}

function artifactRootForFolder(folder, config) {
  const outputDirectory = config.get("outputDirectory", ".cratetrace");
  return path.isAbsolute(outputDirectory)
    ? outputDirectory
    : path.join(folder.uri.fsPath, outputDirectory);
}

async function promptTraceSelection(folder, config) {
  const defaultRange = config.get("defaultRange", "HEAD~9..HEAD");
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: "Select Comparison Commits",
        description: "Pick one or two commits from recent history",
        mode: "recent"
      },
      {
        label: "Enter Revision Range",
        description: `Use Git syntax such as ${defaultRange}`,
        mode: "range"
      }
    ],
    {
      title: "Choose Cratetrace history source",
      ignoreFocusOut: true
    }
  );

  if (!mode) {
    return null;
  }

  if (mode.mode === "recent") {
    return promptRecentCommitRange(folder, config);
  }

  const revisionRange = await vscode.window.showInputBox({
    prompt: "Git revision range",
    value: defaultRange,
    ignoreFocusOut: true
  });
  if (!revisionRange) {
    return null;
  }

  return {
    revisionRange,
    summary: `range ${revisionRange}`
  };
}

async function promptRecentCommitRange(folder, config) {
  const repoRoot = folder.uri.fsPath;
  const recentCommitLimit = Math.max(
    1,
    Math.floor(Number(config.get("recentCommitLimit", 50)) || 50)
  );

  let commits;
  try {
    commits = await listRecentCommits(repoRoot, recentCommitLimit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Unable to list recent commits: ${message}`);
    return null;
  }

  if (commits.length === 0) {
    vscode.window.showWarningMessage("No recent commits were found.");
    return null;
  }

  while (true) {
    const selections = await vscode.window.showQuickPick(
      commits.map((commit, index) => toCommitQuickPick(commit, index, commits.length)),
      {
        canPickMany: true,
        title: "Select one commit or two commits to compare",
        placeHolder:
          "Pick one commit to compare against its parent, or two commits to compare a span.",
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
      }
    );

    if (!selections || selections.length === 0) {
      return null;
    }

    if (selections.length > 2) {
      vscode.window.showWarningMessage("Select at most two commits.");
      continue;
    }

    const sortedSelections = [...selections].sort((left, right) => left.index - right.index);
    if (sortedSelections.length === 1) {
      const commit = sortedSelections[0].commit;
      return {
        revisionRange: revisionRangeForCommits(commit, commit),
        summary: `commit ${commit.shortSha} against its parent`
      };
    }

    const newestCommit = sortedSelections[0].commit;
    const oldestCommit = sortedSelections[1].commit;
    return {
      revisionRange: revisionRangeForCommits(oldestCommit, newestCommit),
      summary: `compare ${oldestCommit.shortSha}..${newestCommit.shortSha}`
    };
  }
}

function toCommitQuickPick(commit, index, total) {
  return {
    label: `${commit.shortSha} ${commit.subject}`,
    description: commit.committedAt,
    detail: `Commit ${index + 1} of ${total}: ${commit.sha}`,
    index,
    commit
  };
}

function revisionRangeForCommits(oldestCommit, newestCommit) {
  if (oldestCommit.sha === newestCommit.sha) {
    return oldestCommit.parentSha
      ? `${oldestCommit.parentSha}..${oldestCommit.sha}`
      : oldestCommit.sha;
  }

  return oldestCommit.parentSha
    ? `${oldestCommit.parentSha}..${newestCommit.sha}`
    : newestCommit.sha;
}

function resolveCliExecutable(folder, config, extensionPath) {
  const configuredPath = String(config.get("cliPath", "")).trim();
  if (configuredPath.length > 0) {
    return {
      command: resolveConfiguredPath(configuredPath, folder),
      source: "configured"
    };
  }

  const bundledPath = bundledCliPath(extensionPath);
  if (bundledPath) {
    return {
      command: bundledPath,
      source: "bundled"
    };
  }

  return {
    command: "cratetrace-cli",
    source: "path"
  };
}

function resolveConfiguredPath(configuredPath, folder) {
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(folder.uri.fsPath, configuredPath);
}

function bundledCliPath(extensionPath) {
  const executableName =
    process.platform === "win32" ? "cratetrace-cli.exe" : "cratetrace-cli";
  const candidate = path.join(extensionPath, "bin", executableName);
  return fs.existsSync(candidate) ? candidate : null;
}

function describeCliSource(source) {
  switch (source) {
    case "configured":
      return "configured";
    case "bundled":
      return "bundled";
    default:
      return "PATH";
  }
}

function resolveArtifactPath(artifactRoot, relativePath) {
  return relativePath && relativePath.length > 0
    ? path.join(artifactRoot, relativePath)
    : null;
}

function preferredPreviewFormat(folder) {
  const config = vscode.workspace.getConfiguration("cratetrace", folder.uri);
  const configuredFormat = String(config.get("previewFormat", "mermaid")).trim();
  return PREVIEW_FORMATS.has(configuredFormat) ? configuredFormat : "mermaid";
}

function preferredArtifactPath(item, previewFormat) {
  const candidatesByFormat = {
    auto: [item.mermaidPath, item.svgPath, item.dotPath],
    dot: [item.dotPath, item.mermaidPath, item.svgPath],
    mermaid: [item.mermaidPath, item.svgPath, item.dotPath],
    svg: [item.svgPath, item.mermaidPath, item.dotPath]
  };

  const candidates = candidatesByFormat[previewFormat] || candidatesByFormat.mermaid;
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

async function listRecentCommits(repoRoot, limit) {
  const output = await captureProcessOutput(
    "git",
    [
      "log",
      "-n",
      String(limit),
      "--format=%H%x1f%h%x1f%P%x1f%s%x1f%cI"
    ],
    repoRoot
  );

  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split(FIELD_SEPARATOR);
      if (parts.length !== 5) {
        throw new Error(`Unexpected git log output while parsing: ${line}`);
      }

      return {
        sha: parts[0],
        shortSha: parts[1],
        parentSha: parts[2].split(/\s+/).find((parent) => parent.length > 0) || null,
        subject: parts[3],
        committedAt: parts[4]
      };
    });
}

async function ensureTimelineState() {
  if (navigationState.items.length > 0 && navigationState.artifactRoot) {
    return navigationState;
  }

  const folder = pickWorkspaceFolder();
  if (!folder) {
    return null;
  }

  const config = vscode.workspace.getConfiguration("cratetrace", folder.uri);
  const artifactRoot = artifactRootForFolder(folder, config);

  try {
    loadTimelineState(artifactRoot);
    return navigationState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(`Unable to load Cratetrace timeline: ${message}`);
    return null;
  }
}

function loadTimelineState(artifactRoot) {
  const timelinePath = path.join(artifactRoot, "timeline.tsv");
  if (!fs.existsSync(timelinePath)) {
    throw new Error(`timeline manifest not found at ${timelinePath}`);
  }

  const rows = fs
    .readFileSync(timelinePath, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length === 5) {
        const [kind, dotRelPath, svgRelPath, mermaidRelPath, label] = parts;
        return {
          kind,
          label,
          dotPath: resolveArtifactPath(artifactRoot, dotRelPath),
          svgPath: resolveArtifactPath(artifactRoot, svgRelPath),
          mermaidPath: resolveArtifactPath(artifactRoot, mermaidRelPath)
        };
      }

      if (parts.length === 3) {
        const [kind, relPath, label] = parts;
        const filePath = resolveArtifactPath(artifactRoot, relPath);
        return {
          kind,
          label,
          dotPath: filePath && path.extname(filePath).toLowerCase() === ".dot" ? filePath : null,
          svgPath: filePath && path.extname(filePath).toLowerCase() === ".svg" ? filePath : null,
          mermaidPath:
            filePath && path.extname(filePath).toLowerCase() === ".mmd" ? filePath : null
        };
      }

      throw new Error(`unexpected timeline row: ${line}`);
    });

  navigationState.artifactRoot = artifactRoot;
  navigationState.items = rows;
  navigationState.commitItems = rows.filter((item) => item.kind === "commit");
  navigationState.currentCommitIndex = -1;
  navigationState.currentKind = null;
}

function hasSvgArtifacts(state) {
  return state.items.some((item) => item.svgPath && fs.existsSync(item.svgPath));
}

async function openRollupFromState() {
  const rollupItem = navigationState.items.find((item) => item.kind === "rollup");
  if (!rollupItem) {
    return false;
  }

  await openArtifactItem(rollupItem);
  return true;
}

async function openCommitAtIndex(index) {
  const item = navigationState.commitItems[index];
  if (!item) {
    return false;
  }

  await openArtifactItem(item);
  navigationState.currentCommitIndex = index;
  navigationState.currentKind = "commit";
  return true;
}

async function openArtifactItem(item) {
  const folder = pickWorkspaceFolder();
  if (!folder) {
    return false;
  }

  const previewFormat = preferredPreviewFormat(folder);
  const artifactPath = preferredArtifactPath(item, previewFormat);
  if (!artifactPath) {
    vscode.window.showWarningMessage(
      `No Cratetrace artifact is available for ${item.label}.`
    );
    return false;
  }

  if (path.extname(artifactPath).toLowerCase() === ".mmd") {
    await showMermaidArtifact(item, artifactPath);
  } else {
    const uri = vscode.Uri.file(artifactPath);
    await vscode.commands.executeCommand("vscode.open", uri);
  }

  if (item.kind === "commit") {
    navigationState.currentCommitIndex = navigationState.commitItems.findIndex(
      (candidate) => candidate === item
    );
  } else {
    navigationState.currentCommitIndex = -1;
  }
  navigationState.currentKind = item.kind;
}

async function showMermaidArtifact(item, filePath) {
  if (!extensionContext) {
    throw new Error("extension context is unavailable");
  }

  const mermaidScriptPath = vscode.Uri.joinPath(
    extensionContext.extensionUri,
    "media",
    "mermaid.min.js"
  );
  if (!fs.existsSync(mermaidScriptPath.fsPath)) {
    throw new Error(
      "Mermaid renderer is missing from the extension package. Reinstall the extension."
    );
  }

  const mermaidSource = fs.readFileSync(filePath, "utf8");
  const panel =
    mermaidPreviewPanel ||
    vscode.window.createWebviewPanel(
      "cratetraceMermaid",
      item.label,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionContext.extensionUri, "media")],
        retainContextWhenHidden: true
      }
    );

  if (!mermaidPreviewPanel) {
    mermaidPreviewPanel = panel;
    panel.onDidDispose(() => {
      if (mermaidPreviewPanel === panel) {
        mermaidPreviewPanel = null;
      }
    });
  }

  panel.title = item.label;
  panel.webview.html = renderMermaidWebview(
    panel.webview,
    panel.title,
    filePath,
    mermaidSource,
    mermaidScriptPath
  );
  panel.reveal(vscode.ViewColumn.Active, false);
}

function renderMermaidWebview(webview, title, filePath, mermaidSource, mermaidScriptPath) {
  const nonce = createNonce();
  const mermaidScriptUri = webview.asWebviewUri(mermaidScriptPath);
  const escapedTitle = escapeHtml(title);
  const escapedPath = escapeHtml(filePath);
  const escapedSource = escapeHtml(mermaidSource);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapedTitle}</title>
    <style nonce="${nonce}">
      :root {
        color-scheme: light dark;
      }

      body {
        margin: 0;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(14, 116, 144, 0.18), transparent 32%),
          radial-gradient(circle at bottom right, rgba(217, 119, 6, 0.16), transparent 28%),
          var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family);
      }

      .frame {
        display: grid;
        gap: 16px;
      }

      .header {
        display: grid;
        gap: 8px;
        padding: 16px 18px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 16px;
        background: color-mix(in srgb, var(--vscode-editor-background) 82%, white 18%);
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.12);
      }

      .title {
        font-size: 1.1rem;
        font-weight: 700;
      }

      .meta {
        font-size: 0.9rem;
        opacity: 0.82;
        word-break: break-all;
      }

      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .chip {
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid transparent;
        font-size: 0.82rem;
        letter-spacing: 0.01em;
      }

      .chip.added {
        background: rgba(34, 197, 94, 0.16);
        border-color: rgba(21, 128, 61, 0.45);
      }

      .chip.modified {
        background: rgba(245, 158, 11, 0.18);
        border-color: rgba(180, 83, 9, 0.45);
      }

      .chip.removed {
        background: rgba(239, 68, 68, 0.14);
        border-color: rgba(185, 28, 28, 0.38);
      }

      .chip.unchanged {
        background: rgba(59, 130, 246, 0.12);
        border-color: rgba(71, 85, 105, 0.35);
      }

      .panel {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 20px;
        padding: 14px;
        background: color-mix(in srgb, var(--vscode-editor-background) 86%, white 14%);
        overflow: auto;
      }

      .diagram-shell {
        min-height: 320px;
      }

      .error {
        display: none;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid rgba(185, 28, 28, 0.45);
        background: rgba(127, 29, 29, 0.14);
        color: var(--vscode-errorForeground);
        white-space: pre-wrap;
      }

      details {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 14px;
        padding: 12px 14px;
        background: color-mix(in srgb, var(--vscode-editor-background) 92%, white 8%);
      }

      summary {
        cursor: pointer;
        font-weight: 600;
      }

      pre.source {
        margin: 12px 0 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
      }
    </style>
  </head>
  <body>
    <div class="frame">
      <section class="header">
        <div class="title">${escapedTitle}</div>
        <div class="meta">${escapedPath}</div>
        <div class="legend">
          <span class="chip added">Added</span>
          <span class="chip modified">Modified</span>
          <span class="chip removed">Removed</span>
          <span class="chip unchanged">Unchanged</span>
        </div>
      </section>
      <section class="panel">
        <div id="render-error" class="error"></div>
        <div class="diagram-shell">
          <pre class="mermaid">${escapedSource}</pre>
        </div>
      </section>
      <details>
        <summary>Mermaid Source</summary>
        <pre class="source">${escapedSource}</pre>
      </details>
    </div>
    <script nonce="${nonce}" src="${mermaidScriptUri}"></script>
    <script nonce="${nonce}">
      const errorNode = document.getElementById("render-error");
      const mermaidTheme = document.body.classList.contains("vscode-dark") ? "dark" : "default";

      mermaid.initialize({
        startOnLoad: false,
        theme: mermaidTheme,
        securityLevel: "loose",
        flowchart: {
          htmlLabels: true,
          useMaxWidth: true,
          curve: "basis"
        }
      });

      mermaid
        .run({
          nodes: Array.from(document.querySelectorAll(".mermaid"))
        })
        .catch((error) => {
          errorNode.style.display = "block";
          errorNode.textContent = String(error);
        });
    </script>
  </body>
</html>`;
}

function createNonce() {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function runCratetrace(command, args, cwd, output) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, shell: false });

    child.stdout.on("data", (chunk) => output.append(chunk.toString()));
    child.stderr.on("data", (chunk) => output.append(chunk.toString()));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`process exited with status ${code}`));
    });
  });
}

function captureProcessOutput(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      const message = stderr.trim().length > 0 ? stderr.trim() : `exit status ${code}`;
      reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
    });
  });
}

function describeRunError(error, cli) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error ? error.code : undefined;

  if (code === "ENOENT") {
    if (cli.source === "configured") {
      return {
        outputMessage: `Configured Cratetrace CLI was not found at ${cli.command}.`,
        userMessage:
          "The configured Cratetrace CLI path does not exist. Update `cratetrace.cliPath` or reinstall the extension.",
        showSettingsAction: true
      };
    }

    if (cli.source === "bundled") {
      return {
        outputMessage: `Bundled Cratetrace CLI was not found at ${cli.command}.`,
        userMessage:
          "The bundled Cratetrace CLI is missing from this extension install. Reinstall the extension or set `cratetrace.cliPath`.",
        showSettingsAction: true
      };
    }

    return {
      outputMessage: "Cratetrace CLI was not found on PATH.",
      userMessage:
        "Cratetrace CLI was not found. Install a packaged extension that bundles it, or set `cratetrace.cliPath` to a local binary.",
      showSettingsAction: true
    };
  }

  if (code === "EACCES") {
    return {
      outputMessage: `Cratetrace CLI is not executable: ${cli.command}`,
      userMessage:
        "Cratetrace found a CLI binary, but it is not executable. Fix the file permissions or set `cratetrace.cliPath` to a working binary.",
      showSettingsAction: true
    };
  }

  return {
    outputMessage: message,
    userMessage: `Cratetrace failed: ${message}`,
    showSettingsAction: false
  };
}

async function openCliPathSetting() {
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "cratetrace.cliPath"
  );
}

async function openIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
  return true;
}

module.exports = {
  activate,
  deactivate
};
