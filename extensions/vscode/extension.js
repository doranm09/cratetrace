const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const OPEN_SETTINGS_ACTION = "Open Settings";
const FIELD_SEPARATOR = "\u001f";

const navigationState = {
  artifactRoot: null,
  items: [],
  commitItems: [],
  currentCommitIndex: -1,
  currentKind: null
};

function activate(context) {
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
        if (!hasSvgArtifacts(navigationState)) {
          vscode.window.showWarningMessage(
            "Graphviz `dot` was not found. Cratetrace generated DOT files but not SVG graphs. Install Graphviz for graphical previews."
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
        label: "Select Recent Commits",
        description: "Pick commits from a recent history list",
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

  const newestSelection = await vscode.window.showQuickPick(
    commits.map((commit, index) => toCommitQuickPick(commit, index, commits.length)),
    {
      title: "Select newest commit to include",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    }
  );
  if (!newestSelection) {
    return null;
  }

  const oldestSelection = await vscode.window.showQuickPick(
    commits
      .slice(newestSelection.index)
      .map((commit, offset) =>
        toCommitQuickPick(commit, newestSelection.index + offset, commits.length)
      ),
    {
      title: "Select oldest commit to include",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    }
  );
  if (!oldestSelection) {
    return null;
  }

  return {
    revisionRange: revisionRangeForCommits(
      oldestSelection.commit,
      newestSelection.commit
    ),
    summary: `recent commits ${oldestSelection.commit.shortSha}..${newestSelection.commit.shortSha}`
  };
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
      const [kind, relPath, label] = line.split("\t");
      return {
        kind,
        label,
        filePath: path.join(artifactRoot, relPath)
      };
    });

  navigationState.artifactRoot = artifactRoot;
  navigationState.items = rows;
  navigationState.commitItems = rows.filter((item) => item.kind === "commit");
  navigationState.currentCommitIndex = -1;
  navigationState.currentKind = null;
}

function hasSvgArtifacts(state) {
  return state.items.some((item) => path.extname(item.filePath).toLowerCase() === ".svg");
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
  const uri = vscode.Uri.file(item.filePath);
  await vscode.commands.executeCommand("vscode.open", uri);
  if (item.kind === "commit") {
    navigationState.currentCommitIndex = navigationState.commitItems.findIndex(
      (candidate) => candidate.filePath === item.filePath
    );
  } else {
    navigationState.currentCommitIndex = -1;
  }
  navigationState.currentKind = item.kind;
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
